// The 'extracting' stage: dispatches on documents.document_type.
// - lab_report: PDF bytes → text → Kimi structured extraction → validated
//   LabExtraction, cached as the raw_extractions('extracting') payload for
//   the normalizing stage (worker/normalize.ts).
// - image: single image → lab-vision extraction; images yielding no
//   biomarkers fall through to the medical-document vision extraction.
// - medical_doc: images and scanned PDFs → medical-document vision
//   extraction (provider, document date, English summary, key findings).
// - apple_health_export: SAX-streamed onto daily_metrics/workouts — see
//   worker/apple-health/.
// Every other type passes through with a stub payload until its own
// extraction lands.
//
// Lab extraction is text-first by design: text comes from unpdf (serverless
// pdfjs wrapper); when the text layer is implausibly thin the PDF is scanned
// and the stage rasterizes the pages (worker/vision.ts — poppler pdftoppm)
// and extracts from the page IMAGES with the SAME zod schema, validation,
// escalation, and persistence code as the text path (health-etv.11). Non-PDF
// text files are read directly.
//
// Model routing (user decision): the standard model (kimi-k2.6) runs first;
// on zod validation failure it retries ONCE with the error appended (a fresh
// single-turn call — thinking models reject multi-turn histories without
// reasoning_content); still failing, or yielding implausibly few analytes for
// the text volume, the extraction escalates to the expert model (kimi-k3).
// Only when the expert also fails validation does the document halt in
// needs_review with stage_error. An expert failure after a VALID standard
// result keeps the standard result.
//
// Document-shaped outcomes map onto the stage executor's vocabulary: a
// permanent input problem comes back as a `halt` payload (needs_review), a
// successful parse as a plain payload cached in raw_extractions('extracting'),
// and transient failures (S3 drop, DB error) are thrown so the executor's
// retry machinery re-runs the stage — safe because the writers are idempotent
// (Apple Health upserts / insert-or-skips, biomarker-result dedup).
//
// Runs under plain node type stripping in the worker container: every
// relative import carries an explicit .ts extension and DB access is raw
// postgres.js SQL.

import type { Readable } from "node:stream";

import type { ChatCompletionContentPart } from "openai/resources/chat/completions/completions";
import { extractText } from "unpdf";
import type postgres from "postgres";

import {
  LAB_EXTRACTION_JSON_SCHEMA,
  MEDICAL_DOC_EXTRACTION_JSON_SCHEMA,
  measuredOnOf,
  parseLabExtraction,
  parseMedicalDocExtraction,
  type LabExtraction,
  type MedicalDocExtraction,
} from "../src/lib/ingest/schemas.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
  type JsonSchemaDefinition,
} from "../src/lib/kimi/client.ts";
import { getOriginalBytes, getOriginalStream } from "../src/lib/storage.ts";
import { ingestAppleHealthExport } from "./apple-health/index.ts";
import { stageHaltOf, type StageHalt, type StageRunner } from "./ingestion.ts";
import {
  deleteVisionImage,
  isImageFilename,
  MAX_VISION_PAGES,
  rasterizePdfPages,
  uploadVisionImage,
  visionUserContent,
  type DeleteVisionImage,
  type RasterizePdf,
  type UploadVisionImage,
} from "./vision.ts";

/** Prompt version recorded in every raw_extractions('extracting') payload. */
export const EXTRACT_PROMPT_V1 = "lab-extract-v1";

/** Prompt version for the vision lab path (page images instead of text). */
export const EXTRACT_VISION_PROMPT_V1 = "lab-extract-vision-v1";

/** Prompt version for the medical-document vision extraction. */
export const MEDICAL_DOC_PROMPT_V1 = "medical-doc-extract-v1";

/** Parser version recorded on apple_health_export extraction payloads. */
export const EXTRACT_PARSER_VERSION = "extract-v1";

/** Whole-file read cap; lab PDFs and photos are a few MB at most. */
export const MAX_LAB_PDF_BYTES = 32 * 1024 * 1024;

/**
 * Below this many non-whitespace characters of extracted text the PDF is
 * treated as scanned (image-only) and re-read through the vision path
 * (worker/vision.ts) instead of the text layer.
 */
export const SCANNED_TEXT_MIN_CHARS = 100;

/**
 * Plausibility heuristic for the expert escalation: a report with at least
 * this much text that yields at most one analyte almost certainly lost its
 * table structure to extraction. A genuinely single-analyte report is short,
 * so it rarely trips this; when it does, the expert simply agrees.
 */
export const IMPLAUSIBLE_TEXT_CHARS = 500;
export const IMPLAUSIBLE_MAX_ANALYTES = 1;

export const EXTRACT_SYSTEM_PROMPT = `You are the lab-report extraction engine of a personal health dashboard. You receive the extracted text layer of ONE laboratory report and reply with JSON only.

Reports may be in ENGLISH or LITHUANIAN (providers such as Antėja, Medicina practica, SYNLAB Lietuva or Affidea). Read both equally well.

Rules:
- Extract EVERY measured analyte, including differential counts and calculated indices — never summarize, sample, or skip.
- name: the analyte name exactly as printed, kept in the report's language.
- value: a JSON number. Convert decimal commas (5,4 becomes 5.4). For bounded results like "< 0.5" use the bound (0.5).
- unit: exactly as printed ("mmol/l", "10^9/L", "mTV/L", ...).
- referenceLow / referenceHigh: the numeric bounds of the reference interval when printed as a plain range. referenceText: the raw reference string when it is not a plain interval ("< 5.2", "neigiamas", "negative").
- flag: the report's own abnormality marker for the result (H/↑/A = high, L/↓ = low, N = normal); null when absent.
- measuredAt: the specimen collection moment ("Mėginio data", "Mėginio paėmimo data", "Collected", "Sample date") as YYYY-MM-DD; when several dates are present prefer the collection date over print/validation dates.
- labName: the laboratory/provider name as printed; empty string when absent.
- Judge ONLY from the provided text — never invent names, values, or dates.`;

/**
 * The vision variant of the lab prompt: identical rules, but the input is
 * page IMAGES (scans/photos) instead of the text layer.
 */
export const EXTRACT_VISION_SYSTEM_PROMPT = `You are the lab-report extraction engine of a personal health dashboard. You receive PAGE IMAGES of ONE laboratory report (a scan or a photo) and reply with JSON only.

Reports may be in ENGLISH or LITHUANIAN (providers such as Antėja, Medicina practica, SYNLAB Lietuva or Affidea). Read both equally well. A table may span several pages and page headers/footers may repeat — extract each measured analyte exactly ONCE.

Rules:
- Extract EVERY measured analyte, including differential counts and calculated indices — never summarize, sample, or skip.
- name: the analyte name exactly as printed, kept in the report's language.
- value: a JSON number. Convert decimal commas (5,4 becomes 5.4). For bounded results like "< 0.5" use the bound (0.5).
- unit: exactly as printed ("mmol/l", "10^9/L", "mTV/L", ...).
- referenceLow / referenceHigh: the numeric bounds of the reference interval when printed as a plain range. referenceText: the raw reference string when it is not a plain interval ("< 5.2", "neigiamas", "negative").
- flag: the report's own abnormality marker for the result (H/↑/A = high, L/↓ = low, N = normal); null when absent.
- measuredAt: the specimen collection moment ("Mėginio data", "Mėginio paėmimo data", "Collected", "Sample date") as YYYY-MM-DD; when several dates are present prefer the collection date over print/validation dates.
- labName: the laboratory/provider name as printed; empty string when absent.
- Judge ONLY from the provided images — never invent names, values, or dates. When nothing on the images is a measured analyte, return an empty biomarkers array.`;

/**
 * The medical-document vision prompt: non-lab documents (discharge letters,
 * referrals, prescriptions, ...) yield metadata + an English summary instead
 * of biomarker rows.
 */
export const MEDICAL_VISION_SYSTEM_PROMPT = `You are the medical-document reader of a personal health dashboard. You receive PAGE IMAGES of ONE medical document that is NOT a laboratory report (a discharge letter, referral, imaging report, prescription, vaccination record, or doctor's note — a scan or a photo) and reply with JSON only.

Documents may be in ENGLISH or LITHUANIAN. Write the summary and keyFindings in ENGLISH.

Rules:
- provider: the clinic, hospital, or doctor name as printed; empty string when absent.
- documentDate: the document's own date as YYYY-MM-DD; null when not identifiable.
- summary: 2-3 sentences in English describing the document for the documents library.
- keyFindings: the clinically important points (diagnoses, recommendations, prescribed medications, follow-ups), one per entry, in English; an empty array when there are none.
- Judge ONLY from the provided images — never invent content that is not there.`;

interface DocumentForExtract {
  s3_key: string;
  document_type: string;
  size_bytes: number | null;
}

export type ReadOriginalBytes = (s3Key: string) => Promise<Uint8Array | null>;
export type OpenOriginal = (s3Key: string) => Promise<Readable | null>;

export interface ExtractStageDeps {
  sql: postgres.Sql;
  /** Storage stream opener for the Apple Health path; injectable for tests. */
  openOriginal?: OpenOriginal;
  /** Defaults to src/lib/storage getOriginalBytes with MAX_LAB_PDF_BYTES. */
  readBytes?: ReadOriginalBytes;
  /** Defaults to unpdf extractText (merged pages). */
  extractPdfText?: (bytes: Uint8Array) => Promise<string>;
  /** Defaults to the real chatStructured (Kimi). */
  chatStructured?: (params: ChatStructuredParams) => Promise<string>;
  /** Defaults to KIMI_MODELS.chat. */
  model?: string;
  /** Defaults to KIMI_MODELS.expert. */
  expertModel?: string;
  /** Vision path: PDF rasterizer; defaults to poppler (worker/vision.ts). */
  rasterizePdf?: RasterizePdf;
  /** Vision path: page-image upload; defaults to the Kimi Files API. */
  uploadVisionImage?: UploadVisionImage;
  /** Vision path: uploaded-image cleanup; defaults to Kimi file delete. */
  deleteVisionImage?: DeleteVisionImage;
}

const defaultOpenOriginal: OpenOriginal = async (s3Key) => {
  const object = await getOriginalStream(s3Key);
  return object?.body ?? null;
};

/** Default PDF text extraction via unpdf (pdfjs), pages merged. */
async function defaultExtractPdfText(bytes: Uint8Array): Promise<string> {
  // pdfjs DETACHES the input's ArrayBuffer (it transfers the data into its
  // document worker); the stage still needs the bytes afterwards (the
  // vision path rasterizes the same original), so hand over a copy.
  const { text } = await extractText(new Uint8Array(bytes), {
    mergePages: true,
  });
  return text;
}

type TextForExtraction =
  | { kind: "text"; text: string }
  | { kind: "unreadable" | "unsupported"; detail: string };

/** PDF via unpdf; other UTF-8 text files read directly; anything else bails. */
async function textForExtraction(
  bytes: Uint8Array,
  filename: string,
  extractPdfText: (bytes: Uint8Array) => Promise<string>,
): Promise<TextForExtraction> {
  // The %PDF- signature may sit within the first 1024 bytes (binary prefix).
  const probe = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const isPdf =
    filename.toLowerCase().endsWith(".pdf") || probe.includes("%PDF-");
  if (isPdf) {
    try {
      return { kind: "text", text: await extractPdfText(bytes) };
    } catch (error) {
      return {
        kind: "unreadable",
        detail: `PDF text extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: "unsupported", detail: "not a PDF and not UTF-8 text" };
  }
}

export interface KimiAttemptLog {
  model: string;
  ok: boolean;
  /** Validation error of a failed attempt. */
  error?: string;
  /** True for the same-model retry that carries the validation error. */
  retriedWithError?: boolean;
  /** True when the expert ran because the standard result was implausible. */
  escalatedForFew?: boolean;
}

export type KimiExtractionOutcome<T> =
  | {
      kind: "ok";
      extraction: T;
      /** The model whose reply was accepted. */
      model: string;
      /** The accepted raw model output (audit). */
      raw: string;
      attempts: KimiAttemptLog[];
    }
  | { kind: "failed-validation"; error: string; attempts: KimiAttemptLog[] };

function implausiblyFew(extraction: LabExtraction, textChars: number): boolean {
  return (
    textChars >= IMPLAUSIBLE_TEXT_CHARS &&
    extraction.biomarkers.length <= IMPLAUSIBLE_MAX_ANALYTES
  );
}

/** User-message content: plain text (text path) or text+images (vision). */
export type UserMessageContent = string | ChatCompletionContentPart[];

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface KimiExtractionSpec<T> {
  chat: (params: ChatStructuredParams) => Promise<string>;
  model: string;
  expertModel: string;
  schema: JsonSchemaDefinition;
  systemPrompt: string;
  userContent: UserMessageContent;
  parse: (raw: string) => ParseOutcome<T>;
  /**
   * Valid-but-suspect results escalate to the expert (the lab text path's
   * implausibly-few-analytes heuristic). Omit when there is no signal — page
   * images carry no text volume to judge against.
   */
  isImplausible?: (value: T) => boolean;
}

async function callExtraction<T>(
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  spec: KimiExtractionSpec<T>,
  userContent: UserMessageContent,
): Promise<{ raw: string; parsed: ParseOutcome<T> }> {
  const raw = await chat({
    schema: spec.schema,
    model,
    messages: [
      { role: "system", content: spec.systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return { raw, parsed: spec.parse(raw) };
}

function logOf<T>(
  model: string,
  parsed: ParseOutcome<T>,
  extra: Partial<KimiAttemptLog> = {},
): KimiAttemptLog {
  return {
    model,
    ok: parsed.ok,
    ...(parsed.ok ? {} : { error: parsed.error }),
    ...extra,
  };
}

function retryNote(error: string): string {
  return (
    `Your previous reply failed validation: ${error}. ` +
    "Reply with corrected JSON only."
  );
}

/** Appends the validation-error retry note to the original user content. */
function withRetryNote(
  userContent: UserMessageContent,
  note: string,
): UserMessageContent {
  if (typeof userContent === "string") return `${userContent}\n\n${note}`;
  return [...userContent, { type: "text", text: note }];
}

/**
 * Standard model → one retry with the zod error appended → expert model
 * (validation still failing, or a valid-but-implausible result). The expert
 * failing validation after a valid standard result keeps the standard result;
 * only a full sweep of failures is a failed-validation outcome. Shared by the
 * text path and every vision flow — schemas, prompts, and plausibility
 * heuristics come in through the spec.
 */
export async function extractWithKimi<T>(
  spec: KimiExtractionSpec<T>,
): Promise<KimiExtractionOutcome<T>> {
  const { chat, model, expertModel, userContent, isImplausible } = spec;
  const attempts: KimiAttemptLog[] = [];

  let result = await callExtraction(chat, model, spec, userContent);
  attempts.push(logOf(model, result.parsed));

  if (!result.parsed.ok) {
    result = await callExtraction(
      chat,
      model,
      spec,
      withRetryNote(userContent, retryNote(result.parsed.error)),
    );
    attempts.push(logOf(model, result.parsed, { retriedWithError: true }));
  }

  const standardValid = result.parsed.ok;
  const implausible =
    standardValid && isImplausible !== undefined
      ? isImplausible(result.parsed.value)
      : false;
  if (standardValid && !implausible) {
    return {
      kind: "ok",
      extraction: result.parsed.value,
      model,
      raw: result.raw,
      attempts,
    };
  }

  const expert = await callExtraction(chat, expertModel, spec, userContent);
  attempts.push(
    logOf(
      expertModel,
      expert.parsed,
      standardValid ? { escalatedForFew: true } : {},
    ),
  );
  if (expert.parsed.ok) {
    return {
      kind: "ok",
      extraction: expert.parsed.value,
      model: expertModel,
      raw: expert.raw,
      attempts,
    };
  }
  if (standardValid) {
    // The expert garbled a result the standard model had already produced —
    // keep the valid one (it may genuinely be a one-analyte report).
    return {
      kind: "ok",
      extraction: result.parsed.value,
      model,
      raw: result.raw,
      attempts,
    };
  }
  const lastError = expert.parsed.ok ? "" : expert.parsed.error;
  return {
    kind: "failed-validation",
    error:
      `extraction failed validation on ${model}, its retry, and ${expertModel}: ` +
      lastError,
    attempts,
  };
}

function haltPayload(
  fields: Record<string, postgres.JSONValue>,
  halt: StageHalt,
): postgres.JSONValue {
  return {
    promptVersion: EXTRACT_PROMPT_V1,
    ...fields,
    halt: {
      status: halt.status,
      ...(halt.reason ? { reason: halt.reason } : {}),
      ...(halt.error ? { error: halt.error } : {}),
    },
  };
}

/** The vision-path seams, resolved once per stage from the injectable deps. */
interface VisionDeps {
  rasterize: RasterizePdf;
  upload: UploadVisionImage;
  cleanup: DeleteVisionImage;
}

/** Uploads every page image and returns their vision URLs, in page order. */
async function uploadPages(
  vision: VisionDeps,
  pages: Uint8Array[],
  filenames: string[],
): Promise<string[]> {
  const urls: string[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    urls.push(await vision.upload(pages[i], filenames[i]));
  }
  return urls;
}

/** Best-effort cleanup of uploaded page images; never fails the stage. */
async function cleanupPages(vision: VisionDeps, urls: string[]): Promise<void> {
  for (const url of urls) {
    await vision.cleanup(url);
  }
}

/** Payload fields every successful vision extraction shares (audit). */
function visionPayloadBase<T>(
  pageCount: number,
  outcome: Extract<KimiExtractionOutcome<T>, { kind: "ok" }>,
): { [key: string]: postgres.JSONValue } {
  return {
    vision: true,
    pageCount,
    model: outcome.model,
    attempts: outcome.attempts as unknown as postgres.JSONValue,
    raw: outcome.raw,
  };
}

/**
 * The lab vision flow: page images → the SAME zod validation and
 * standard→retry→expert escalation as the text path (extractWithKimi with
 * LAB_EXTRACTION_JSON_SCHEMA) → on success persists document_date/provider
 * and returns the SAME extraction payload shape the normalizing stage
 * consumes. `onNoBiomarkers` decides what a valid-but-empty extraction means:
 * "halt" for documents already typed lab_report, "fall-through" for `image`
 * documents (they retry as medical documents).
 */
async function extractLabVision(
  sql: postgres.Sql,
  ctx: Parameters<StageRunner>[0],
  pages: Uint8Array[],
  filenames: string[],
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  vision: VisionDeps,
  onNoBiomarkers: "halt" | "fall-through",
): Promise<{ kind: "payload"; payload: postgres.JSONValue } | { kind: "no-biomarkers" }> {
  const urls = await uploadPages(vision, pages, filenames);
  try {
    const outcome = await extractWithKimi<LabExtraction>({
      chat,
      model,
      expertModel,
      schema: LAB_EXTRACTION_JSON_SCHEMA,
      systemPrompt: EXTRACT_VISION_SYSTEM_PROMPT,
      userContent: visionUserContent(
        `Filename: ${ctx.originalFilename}\n` +
          `Extract every biomarker from ${
            pages.length === 1
              ? "this page image"
              : `these ${pages.length} page images`
          }.`,
        urls,
      ),
      parse: parseLabExtraction,
    });
    if (outcome.kind === "failed-validation") {
      return {
        kind: "payload",
        payload: haltPayload(
          {
            vision: true,
            pageCount: pages.length,
            attempts: outcome.attempts as unknown as postgres.JSONValue,
          },
          {
            status: "needs_review",
            reason: "extraction validation failed",
            error: outcome.error,
          },
        ),
      };
    }
    if (outcome.extraction.biomarkers.length === 0) {
      if (onNoBiomarkers === "fall-through") return { kind: "no-biomarkers" };
      return {
        kind: "payload",
        payload: haltPayload(
          {
            vision: true,
            pageCount: pages.length,
            attempts: outcome.attempts as unknown as postgres.JSONValue,
          },
          {
            status: "needs_review",
            reason: "no biomarkers in scan",
            error:
              "vision extraction found no analytes in a document classified " +
              "as a lab report — rescan it or 'Process as…' a different type",
          },
        ),
      };
    }
    await sql`
      update documents
      set document_date = ${measuredOnOf(outcome.extraction)},
          provider = ${outcome.extraction.labName.trim() || null}
      where id = ${ctx.documentId}
    `;
    return {
      kind: "payload",
      payload: {
        promptVersion: EXTRACT_VISION_PROMPT_V1,
        ...visionPayloadBase(pages.length, outcome),
        extraction: outcome.extraction as unknown as postgres.JSONValue,
      },
    };
  } finally {
    await cleanupPages(vision, urls);
  }
}

/**
 * The medical-document vision flow: page images → provider, document date,
 * English summary and key findings (MEDICAL_DOC_EXTRACTION_JSON_SCHEMA) →
 * documents row update. Shares the extraction-attempt machinery with the lab
 * paths; there is nothing for the normalizing stage to do with the result.
 */
async function extractMedicalVision(
  sql: postgres.Sql,
  ctx: Parameters<StageRunner>[0],
  pages: Uint8Array[],
  filenames: string[],
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  vision: VisionDeps,
): Promise<postgres.JSONValue> {
  const urls = await uploadPages(vision, pages, filenames);
  try {
    const outcome = await extractWithKimi<MedicalDocExtraction>({
      chat,
      model,
      expertModel,
      schema: MEDICAL_DOC_EXTRACTION_JSON_SCHEMA,
      systemPrompt: MEDICAL_VISION_SYSTEM_PROMPT,
      userContent: visionUserContent(
        `Filename: ${ctx.originalFilename}\n` +
          "Read this medical document and extract its metadata.",
        urls,
      ),
      parse: parseMedicalDocExtraction,
    });
    if (outcome.kind === "failed-validation") {
      return haltPayload(
        {
          vision: true,
          pageCount: pages.length,
          attempts: outcome.attempts as unknown as postgres.JSONValue,
        },
        {
          status: "needs_review",
          reason: "extraction validation failed",
          error: outcome.error,
        },
      );
    }
    const doc = outcome.extraction;
    await sql`
      update documents
      set provider = ${doc.provider.trim() || null},
          document_date = ${doc.documentDate ? doc.documentDate.slice(0, 10) : null},
          ai_summary = ${doc.summary}
      where id = ${ctx.documentId}
    `;
    return {
      promptVersion: MEDICAL_DOC_PROMPT_V1,
      ...visionPayloadBase(pages.length, outcome),
      medicalDoc: doc as unknown as postgres.JSONValue,
    } as { [key: string]: postgres.JSONValue };
  } finally {
    await cleanupPages(vision, urls);
  }
}

/** Rasterize-or-halt shared by both scanned-PDF vision flows. */
async function rasterizeOrHalt(
  vision: VisionDeps,
  bytes: Uint8Array,
  filename: string,
): Promise<
  | { kind: "ok"; pages: Uint8Array[] }
  | { kind: "halt"; payload: postgres.JSONValue }
> {
  const raster = await vision.rasterize(bytes);
  if (raster.kind === "too-many-pages") {
    return {
      kind: "halt",
      payload: haltPayload(
        { vision: true, pageCount: raster.pageCount },
        {
          status: "needs_review",
          reason: "too many pages",
          error: `scanned PDF has ${raster.pageCount} pages, above the ${MAX_VISION_PAGES}-page vision cap`,
        },
      ),
    };
  }
  if (raster.kind === "failed") {
    return {
      kind: "halt",
      payload: haltPayload(
        { vision: true },
        {
          status: "needs_review",
          reason: "rasterization failed",
          error: `cannot rasterize '${filename}': ${raster.detail}`,
        },
      ),
    };
  }
  return { kind: "ok", pages: raster.pages };
}

/** Page-image upload filenames for a rasterized PDF: <name>.page-N.jpg. */
function pageFilenames(filename: string, pageCount: number): string[] {
  return Array.from(
    { length: pageCount },
    (_, i) => `${filename}.page-${i + 1}.jpg`,
  );
}

/**
 * The lab_report branch: original bytes → text layer → Kimi extraction →
 * validated LabExtraction. Image files and scanned PDFs (implausibly thin
 * text layer) go through the vision path with the same schema instead. On
 * success persists documents.extracted_text (search tsvector; text path
 * only), document_date and provider, and returns a payload carrying the
 * extraction, the winning raw model output (audit), and the attempt log.
 */
async function extractLabReport(
  sql: postgres.Sql,
  document: DocumentForExtract,
  ctx: Parameters<StageRunner>[0],
  readBytes: ReadOriginalBytes,
  extractPdfText: (bytes: Uint8Array) => Promise<string>,
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  vision: VisionDeps,
): Promise<postgres.JSONValue> {
  if (
    document.size_bytes !== null &&
    document.size_bytes > MAX_LAB_PDF_BYTES
  ) {
    return haltPayload(
      { sizeBytes: document.size_bytes },
      {
        status: "needs_review",
        reason: "oversized",
        error: `lab report is ${document.size_bytes} bytes, above the ${MAX_LAB_PDF_BYTES}-byte text-extraction cap`,
      },
    );
  }

  const bytes = await readBytes(document.s3_key);
  if (!bytes || bytes.length === 0) {
    throw new Error(`original ${document.s3_key} not found or empty`);
  }

  // A lab_report that IS an image (a photo Process-as'd to lab_report, or a
  // resume after an image document proved to be a lab report) skips the text
  // layer entirely.
  if (isImageFilename(ctx.originalFilename)) {
    const result = await extractLabVision(
      sql,
      ctx,
      [bytes],
      [ctx.originalFilename],
      chat,
      model,
      expertModel,
      vision,
      "halt",
    );
    if (result.kind === "no-biomarkers") {
      throw new Error("unreachable: 'halt' never falls through");
    }
    return result.payload;
  }

  const content = await textForExtraction(
    bytes,
    ctx.originalFilename,
    extractPdfText,
  );
  if (content.kind !== "text") {
    return haltPayload(
      {},
      {
        status: "needs_review",
        reason: content.kind,
        error: `cannot extract text from '${ctx.originalFilename}': ${content.detail}`,
      },
    );
  }

  const text = content.text;
  const textChars = text.trim().length;
  if (textChars < SCANNED_TEXT_MIN_CHARS) {
    // Scanned PDF: rasterize the pages and re-read them through vision with
    // the SAME biomarker schema/validation/persistence as the text path.
    const raster = await rasterizeOrHalt(vision, bytes, ctx.originalFilename);
    if (raster.kind === "halt") return raster.payload;
    const result = await extractLabVision(
      sql,
      ctx,
      raster.pages,
      pageFilenames(ctx.originalFilename, raster.pages.length),
      chat,
      model,
      expertModel,
      vision,
      "halt",
    );
    if (result.kind === "no-biomarkers") {
      throw new Error("unreachable: 'halt' never falls through");
    }
    return result.payload;
  }

  const userMessage =
    `Filename: ${ctx.originalFilename}\n` +
    `Extracted text:\n\`\`\`\n${text}\n\`\`\``;

  const outcome = await extractWithKimi<LabExtraction>({
    chat,
    model,
    expertModel,
    schema: LAB_EXTRACTION_JSON_SCHEMA,
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    userContent: userMessage,
    parse: parseLabExtraction,
    isImplausible: (extraction) => implausiblyFew(extraction, textChars),
  });
  if (outcome.kind === "failed-validation") {
    return haltPayload(
      {
        textChars,
        attempts: outcome.attempts as unknown as postgres.JSONValue,
      },
      {
        status: "needs_review",
        reason: "extraction validation failed",
        error: outcome.error,
      },
    );
  }

  await sql`
    update documents
    set extracted_text = ${text},
        document_date = ${measuredOnOf(outcome.extraction)},
        provider = ${outcome.extraction.labName.trim() || null}
    where id = ${ctx.documentId}
  `;

  return {
    promptVersion: EXTRACT_PROMPT_V1,
    model: outcome.model,
    textChars,
    attempts: outcome.attempts as unknown as postgres.JSONValue,
    extraction: outcome.extraction as unknown as postgres.JSONValue,
    raw: outcome.raw,
  } as { [key: string]: postgres.JSONValue };
}

/**
 * The image branch: the deterministic classifier types EVERY image file
 * 'image' without seeing its content, so the vision path decides what it
 * actually is. Lab extraction runs first; an image yielding biomarkers is
 * promoted to lab_report (the normalizing stage then persists its rows), an
 * image yielding none falls through to the medical-document extraction and is
 * typed medical_doc.
 */
async function extractImageDocument(
  sql: postgres.Sql,
  document: DocumentForExtract,
  ctx: Parameters<StageRunner>[0],
  readBytes: ReadOriginalBytes,
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  vision: VisionDeps,
): Promise<postgres.JSONValue> {
  if (
    document.size_bytes !== null &&
    document.size_bytes > MAX_LAB_PDF_BYTES
  ) {
    return haltPayload(
      { sizeBytes: document.size_bytes },
      {
        status: "needs_review",
        reason: "oversized",
        error: `image is ${document.size_bytes} bytes, above the ${MAX_LAB_PDF_BYTES}-byte vision cap`,
      },
    );
  }

  const bytes = await readBytes(document.s3_key);
  if (!bytes || bytes.length === 0) {
    throw new Error(`original ${document.s3_key} not found or empty`);
  }

  const labResult = await extractLabVision(
    sql,
    ctx,
    [bytes],
    [ctx.originalFilename],
    chat,
    model,
    expertModel,
    vision,
    "fall-through",
  );
  if (labResult.kind === "payload") {
    // Biomarkers found: this IS a lab report — promote the type so the
    // normalizing stage persists its rows.
    await sql`
      update documents set document_type = 'lab_report' where id = ${ctx.documentId}
    `;
    const payload = labResult.payload as { [key: string]: postgres.JSONValue };
    payload.promotedFrom = "image";
    return payload;
  }

  const medicalPayload = await extractMedicalVision(
    sql,
    ctx,
    [bytes],
    [ctx.originalFilename],
    chat,
    model,
    expertModel,
    vision,
  );
  if (stageHaltOf(medicalPayload)) return medicalPayload;
  await sql`
    update documents set document_type = 'medical_doc' where id = ${ctx.documentId}
  `;
  const payload = medicalPayload as { [key: string]: postgres.JSONValue };
  payload.promotedFrom = "image";
  return payload;
}

/**
 * The medical_doc branch: images and scanned (text-less) PDFs are read
 * through the medical vision flow. PDFs with a real text layer are left for
 * the text-based summarization path (out of scope here), as are office
 * documents.
 */
async function extractMedicalDoc(
  sql: postgres.Sql,
  document: DocumentForExtract,
  ctx: Parameters<StageRunner>[0],
  readBytes: ReadOriginalBytes,
  extractPdfText: (bytes: Uint8Array) => Promise<string>,
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  vision: VisionDeps,
): Promise<postgres.JSONValue> {
  if (
    document.size_bytes !== null &&
    document.size_bytes > MAX_LAB_PDF_BYTES
  ) {
    return haltPayload(
      { sizeBytes: document.size_bytes },
      {
        status: "needs_review",
        reason: "oversized",
        error: `medical document is ${document.size_bytes} bytes, above the ${MAX_LAB_PDF_BYTES}-byte vision cap`,
      },
    );
  }

  const filename = ctx.originalFilename;
  const isPdf = filename.toLowerCase().endsWith(".pdf");
  if (!isImageFilename(filename) && !isPdf) {
    return {
      skipped: true,
      documentType: "medical_doc",
      reason: "vision path handles image files and scanned PDFs only",
    };
  }

  const bytes = await readBytes(document.s3_key);
  if (!bytes || bytes.length === 0) {
    throw new Error(`original ${document.s3_key} not found or empty`);
  }

  if (isImageFilename(filename)) {
    return extractMedicalVision(
      sql,
      ctx,
      [bytes],
      [filename],
      chat,
      model,
      expertModel,
      vision,
    );
  }

  // PDF: vision only pays when the text layer is missing (scanned). A broken
  // text extraction counts as scanned — pdftoppm copes with PDFs unpdf cannot.
  let textChars = 0;
  try {
    textChars = (await extractPdfText(bytes)).trim().length;
  } catch {
    textChars = 0;
  }
  if (textChars >= SCANNED_TEXT_MIN_CHARS) {
    return {
      skipped: true,
      documentType: "medical_doc",
      reason: "text-readable medical documents are summarized post-ingestion, not re-read via vision",
    };
  }
  const raster = await rasterizeOrHalt(vision, bytes, filename);
  if (raster.kind === "halt") return raster.payload;
  return extractMedicalVision(
    sql,
    ctx,
    raster.pages,
    pageFilenames(filename, raster.pages.length),
    chat,
    model,
    expertModel,
    vision,
  );
}

/**
 * Builds the extracting stage runner. The runner reads the document's type
 * and storage key itself (StageContext carries neither), so it stays a
 * drop-in StageRunner for the executor. Injectable seams (openOriginal,
 * readBytes, extractPdfText, chatStructured, and the vision-path
 * rasterize/upload/cleanup trio) keep tests free of MinIO/Kimi/poppler;
 * production defaults hit MinIO, the real Kimi client, and pdftoppm.
 */
export function createExtractStage(deps: ExtractStageDeps): StageRunner {
  const openOriginal = deps.openOriginal ?? defaultOpenOriginal;
  const readBytes: ReadOriginalBytes =
    deps.readBytes ?? ((s3Key) => getOriginalBytes(s3Key, MAX_LAB_PDF_BYTES));
  const extractPdfText = deps.extractPdfText ?? defaultExtractPdfText;
  const chat = deps.chatStructured ?? chatStructured;
  const model = deps.model ?? KIMI_MODELS.chat;
  const expertModel = deps.expertModel ?? KIMI_MODELS.expert;
  const vision: VisionDeps = {
    rasterize: deps.rasterizePdf ?? rasterizePdfPages,
    upload: deps.uploadVisionImage ?? uploadVisionImage,
    cleanup: deps.deleteVisionImage ?? deleteVisionImage,
  };
  const { sql } = deps;

  return async (ctx) => {
    const rows = await sql<DocumentForExtract[]>`
      select s3_key, document_type, size_bytes::float8 as size_bytes
      from documents
      where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) throw new Error(`document ${ctx.documentId} not found`);

    if (document.document_type === "apple_health_export") {
      const outcome = await ingestAppleHealthExport(
        sql,
        {
          filename: ctx.originalFilename,
          openStream: async () => {
            const body = await openOriginal(document.s3_key);
            if (!body) {
              throw new Error(
                `original ${document.s3_key} missing from storage`,
              );
            }
            return body;
          },
        },
        { documentId: ctx.documentId, signal: ctx.signal },
      );

      if (outcome.kind === "needs_review") {
        return {
          documentType: document.document_type,
          parser: EXTRACT_PARSER_VERSION,
          halt: { status: "needs_review", reason: outcome.reason },
        } as postgres.JSONValue;
      }
      return {
        documentType: document.document_type,
        parser: EXTRACT_PARSER_VERSION,
        metrics: outcome.metrics,
        workouts: outcome.workouts,
        stats: { ...outcome.stats } as Record<string, unknown>,
      } as postgres.JSONValue;
    }

    if (document.document_type === "lab_report") {
      return extractLabReport(
        sql,
        document,
        ctx,
        readBytes,
        extractPdfText,
        chat,
        model,
        expertModel,
        vision,
      );
    }

    if (document.document_type === "image") {
      return extractImageDocument(
        sql,
        document,
        ctx,
        readBytes,
        chat,
        model,
        expertModel,
        vision,
      );
    }

    if (document.document_type === "medical_doc") {
      return extractMedicalDoc(
        sql,
        document,
        ctx,
        readBytes,
        extractPdfText,
        chat,
        model,
        expertModel,
        vision,
      );
    }

    // Not a type this dispatcher handles yet: cache a skip payload so the
    // stage completes and later stages proceed.
    return { skipped: true, documentType: document.document_type };
  };
}
