// The 'extracting' stage: dispatches on documents.document_type.
// - lab_report: PDF bytes → text → Kimi structured extraction → validated
//   LabExtraction, cached as the raw_extractions('extracting') payload for
//   the normalizing stage (worker/normalize.ts).
// - apple_health_export: SAX-streamed onto daily_metrics/workouts — see
//   worker/apple-health/.
// Every other type passes through with a stub payload until its own
// extraction lands.
//
// Lab extraction is text-first by design: text comes from unpdf (serverless
// pdfjs wrapper); when the text layer is implausibly thin the PDF is scanned
// and the document halts in needs_review with reason 'scanned' (the vision
// path is a follow-up issue). Non-PDF text files are read directly.
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

import { extractText } from "unpdf";
import type postgres from "postgres";

import {
  LAB_EXTRACTION_JSON_SCHEMA,
  measuredOnOf,
  parseLabExtraction,
  type LabExtraction,
} from "../src/lib/ingest/schemas.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
} from "../src/lib/kimi/client.ts";
import { getOriginalBytes, getOriginalStream } from "../src/lib/storage.ts";
import { ingestAppleHealthExport } from "./apple-health/index.ts";
import type { StageHalt, StageRunner } from "./ingestion.ts";

/** Prompt version recorded in every raw_extractions('extracting') payload. */
export const EXTRACT_PROMPT_V1 = "lab-extract-v1";

/** Parser version recorded on apple_health_export extraction payloads. */
export const EXTRACT_PARSER_VERSION = "extract-v1";

/** Whole-file read cap; lab PDFs are a few MB at most. */
export const MAX_LAB_PDF_BYTES = 32 * 1024 * 1024;

/**
 * Below this many non-whitespace characters of extracted text the PDF is
 * treated as scanned (image-only) and halted for the vision follow-up.
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
}

const defaultOpenOriginal: OpenOriginal = async (s3Key) => {
  const object = await getOriginalStream(s3Key);
  return object?.body ?? null;
};

/** Default PDF text extraction via unpdf (pdfjs), pages merged. */
async function defaultExtractPdfText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(bytes, { mergePages: true });
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

export type KimiExtractionOutcome =
  | {
      kind: "ok";
      extraction: LabExtraction;
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

async function callExtraction(
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  userMessage: string,
): Promise<{ raw: string; parsed: ReturnType<typeof parseLabExtraction> }> {
  const raw = await chat({
    schema: LAB_EXTRACTION_JSON_SCHEMA,
    model,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });
  return { raw, parsed: parseLabExtraction(raw) };
}

function logOf(
  model: string,
  parsed: ReturnType<typeof parseLabExtraction>,
  extra: Partial<KimiAttemptLog> = {},
): KimiAttemptLog {
  return {
    model,
    ok: parsed.ok,
    ...(parsed.ok ? {} : { error: parsed.error }),
    ...extra,
  };
}

/**
 * Standard model → one retry with the zod error appended → expert model
 * (validation still failing, or a valid-but-implausibly-small result). The
 * expert failing validation after a valid standard result keeps the standard
 * result; only a full sweep of failures is a failed-validation outcome.
 */
export async function extractWithKimi(
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  expertModel: string,
  userMessage: string,
  textChars: number,
): Promise<KimiExtractionOutcome> {
  const attempts: KimiAttemptLog[] = [];

  let result = await callExtraction(chat, model, userMessage);
  attempts.push(logOf(model, result.parsed));

  if (!result.parsed.ok) {
    const retryMessage =
      `${userMessage}\n\n` +
      `Your previous reply failed validation: ${result.parsed.error}. ` +
      "Reply with corrected JSON only.";
    result = await callExtraction(chat, model, retryMessage);
    attempts.push(logOf(model, result.parsed, { retriedWithError: true }));
  }

  const standardValid = result.parsed.ok;
  const tooFew =
    standardValid && implausiblyFew(result.parsed.value, textChars);
  if (standardValid && !tooFew) {
    return {
      kind: "ok",
      extraction: result.parsed.value,
      model,
      raw: result.raw,
      attempts,
    };
  }

  const expert = await callExtraction(chat, expertModel, userMessage);
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

/**
 * The lab_report branch: original bytes → text layer → Kimi extraction →
 * validated LabExtraction. On success persists documents.extracted_text
 * (search tsvector), document_date and provider, and returns a payload
 * carrying the extraction, the winning raw model output (audit), and the
 * attempt log.
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
    return haltPayload(
      { textChars },
      {
        status: "needs_review",
        reason: "scanned",
        error: `scanned PDF: only ${textChars} characters of extractable text — the vision path is a follow-up`,
      },
    );
  }

  const userMessage =
    `Filename: ${ctx.originalFilename}\n` +
    `Extracted text:\n\`\`\`\n${text}\n\`\`\``;

  const outcome = await extractWithKimi(
    chat,
    model,
    expertModel,
    userMessage,
    textChars,
  );
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
 * Builds the extracting stage runner. The runner reads the document's type
 * and storage key itself (StageContext carries neither), so it stays a
 * drop-in StageRunner for the executor. Injectable seams (openOriginal,
 * readBytes, extractPdfText, chatStructured) keep tests free of MinIO/Kimi;
 * production defaults hit MinIO and the real Kimi client.
 */
export function createExtractStage(deps: ExtractStageDeps): StageRunner {
  const openOriginal = deps.openOriginal ?? defaultOpenOriginal;
  const readBytes: ReadOriginalBytes =
    deps.readBytes ?? ((s3Key) => getOriginalBytes(s3Key, MAX_LAB_PDF_BYTES));
  const extractPdfText = deps.extractPdfText ?? defaultExtractPdfText;
  const chat = deps.chatStructured ?? chatStructured;
  const model = deps.model ?? KIMI_MODELS.chat;
  const expertModel = deps.expertModel ?? KIMI_MODELS.expert;
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
      );
    }

    // Not a type this dispatcher handles yet: cache a skip payload so the
    // stage completes and later stages proceed.
    return { skipped: true, documentType: document.document_type };
  };
}
