// The 'classifying' stage: decides documents.document_type in two layers.
//
// Layer 1 is deterministic (NO LLM): magic-byte sniffing via the file-type
// package, the filename extension, zip central-directory markers (Google
// Takeout layout, apple_health_export/export.xml, Garmin DI_CONNECT) and
// wearable CSV header shapes. A definitive hit maps straight onto
// document_type and Kimi is never called.
//
// Layer 2 is the Kimi fallback, used ONLY when layer 1 finds the file
// ambiguous — a real document container whose subtype needs content
// understanding (PDF, text/CSV/XML without deterministic markers). It calls
// chatStructured with a JSON schema {docType, language, confidence, summary};
// the system prompt handles English AND Lithuanian documents and judges only
// the document's own content. CSVs are passed as their first ~200 lines; PDFs
// go through the files module extract, falling back to filename + first 4 KB.
//
// Outcomes: confidence < 0.6 → needs_review (human picks via "Process as…");
// docType 'unknown' (either layer) → ignored — terminal, stored and
// searchable, never blocking the queue. Both are delivered to the stage
// executor as a `halt` marker on the cached raw_extractions('classify')
// payload (see worker/ingestion.ts).
//
// Like worker/ingestion.ts this runs under plain node type stripping in the
// worker container: every relative import carries an explicit .ts extension
// and DB access is raw postgres.js SQL.

import { fileTypeFromBuffer } from "file-type";
import type postgres from "postgres";

import { DOCUMENT_TYPES, type DocumentType } from "../src/db/schema.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
  type JsonSchemaDefinition,
} from "../src/lib/kimi/client.ts";
import {
  deleteFile,
  getExtractedText,
  uploadForExtract,
} from "../src/lib/kimi/files.ts";
import {
  getOriginalRange,
  type OriginalRange,
} from "../src/lib/storage.ts";
import type { StageHalt, StageRunner } from "./ingestion.ts";

/** Prompt version recorded in every raw_extractions('classify') payload. */
export const CLASSIFY_PROMPT_V1 = "classify-v1";

/** Kimi verdicts below this confidence land the document in needs_review. */
export const CLASSIFY_CONFIDENCE_THRESHOLD = 0.6;

/** Magic bytes + text probes read from the head of the file. */
const HEAD_BYTES = 64 * 1024;
/** Tail window scanned for the zip end-of-central-directory record. */
const ZIP_TAIL_BYTES = 128 * 1024;
/** Sanity caps against hostile/corrupt zip directories. */
const ZIP_CD_MAX_BYTES = 32 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 200_000;
/** Whole-file reads for the files-extract path are capped at this size. */
const EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
/** Text sample passed to Kimi: first ~200 lines, hard-capped in chars. */
const KIMI_SAMPLE_LINES = 200;
const KIMI_SAMPLE_MAX_CHARS = 12_000;
/** Raw head sample used when file-extract is unavailable (PDF fallback). */
const KIMI_RAW_HEAD_BYTES = 4 * 1024;

export type ReadOriginalRange = (
  s3Key: string,
  start: number,
  end?: number,
) => Promise<OriginalRange | null>;

// ---------------------------------------------------------------------------
// Layer 1: deterministic sniffing
// ---------------------------------------------------------------------------

export type AmbiguousKind = "pdf" | "csv" | "text";

export type SniffVerdict =
  | { kind: "classified"; docType: DocumentType; detail: string }
  | { kind: "ambiguous"; inputKind: AmbiguousKind }
  | { kind: "unknown"; detail: string };

export interface SniffInput {
  filename: string;
  contentType: string | null;
  head: Uint8Array;
  /** Called only when magic bytes/extension say zip; null = unreadable. */
  listZipEntries: () => Promise<string[] | null>;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** Zip listing markers → document_type (issue-specified). */
export function zipMarkers(
  entries: string[],
): { docType: DocumentType; detail: string } | null {
  for (const name of entries) {
    if (/(^|\/)Takeout\//.test(name)) {
      return {
        docType: "takeout_archive",
        detail: `zip entry '${name}' (Google Takeout layout)`,
      };
    }
  }
  for (const name of entries) {
    if (name.toLowerCase() === "apple_health_export/export.xml") {
      return {
        docType: "apple_health_export",
        detail: "zip entry 'apple_health_export/export.xml'",
      };
    }
  }
  for (const name of entries) {
    if (name.toUpperCase().includes("DI_CONNECT")) {
      return {
        docType: "wearable_export",
        detail: `zip entry '${name}' (Garmin DI_CONNECT)`,
      };
    }
  }
  return null;
}

const DATE_HEADER = /(date|time|day|timestamp)/;
const METRIC_HEADER =
  /(step|calorie|heart|hrv|sleep|distance|strain|recovery|stress|floor|active|energy|score|pace|cadence|power|speed|elevation|altitude|duration|resting|respir|oxygen|spo2|weight|temperature|readiness|workout)/;

/**
 * Wearable/daily-metrics CSV shape: a date-ish column plus at least one
 * metric-ish column (Garmin, Oura, Whoop, Google Fit daily CSVs all fit).
 */
export function isWearableCsvHeader(headerLine: string): boolean {
  const columns = headerLine
    .toLowerCase()
    .split(/[;,\t]/)
    .map((column) => column.trim().replace(/^"|"$/g, ""));
  const hasDate = columns.some((column) => DATE_HEADER.test(column));
  const hasMetric = columns.some((column) => METRIC_HEADER.test(column));
  return hasDate && hasMetric;
}

/**
 * Decodes the head as UTF-8 text, or returns null for binary content.
 * Replacement-char and control-char ratios keep random/corrupt bytes out.
 */
function decodeHeadText(head: Uint8Array): string | null {
  const text = new TextDecoder("utf-8").decode(head);
  if (text.length === 0) return null;
  let noisy = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // U+FFFD = invalid UTF-8; C0 controls other than tab/LF/CR = binary.
    if (code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 13)) {
      noisy += 1;
    }
  }
  return noisy / text.length > 0.01 ? null : text;
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return (end >= 0 ? text.slice(0, end) : text).replace(/\r$/, "");
}

function looksLikeCsvText(text: string): boolean {
  const line = firstLine(text);
  const separators = (line.match(/[;,\t]/g) ?? []).length;
  return separators >= 2;
}

/** Layer 1 in full; never calls an LLM. */
export async function sniffDeterministic(
  input: SniffInput,
): Promise<SniffVerdict> {
  const ext = extensionOf(input.filename);
  const detected = await fileTypeFromBuffer(input.head);

  // Zip container: the central directory decides (Takeout / Apple Health /
  // Garmin markers); Kimi cannot see inside an archive, so a markerless zip
  // is deterministically unknown rather than ambiguous.
  if (detected?.ext === "zip" || (ext === "zip" && !detected)) {
    const entries = await input.listZipEntries();
    if (!entries) {
      return { kind: "unknown", detail: "unreadable zip central directory" };
    }
    const marker = zipMarkers(entries);
    if (marker) {
      return { kind: "classified", docType: marker.docType, detail: marker.detail };
    }
    return {
      kind: "unknown",
      detail: `zip archive without health markers (${entries.length} entries)`,
    };
  }

  if (detected?.ext === "pdf") return { kind: "ambiguous", inputKind: "pdf" };
  if (detected?.mime.startsWith("image/")) {
    return {
      kind: "classified",
      docType: "image",
      detail: `magic bytes ${detected.mime}`,
    };
  }
  if (detected?.ext === "docx" || detected?.ext === "xlsx") {
    // Office documents need content understanding; the files-extract path
    // accepts both, so they take the PDF-shaped Kimi route.
    return { kind: "ambiguous", inputKind: "pdf" };
  }
  if (detected && detected.ext !== "xml") {
    return {
      kind: "unknown",
      detail: `unsupported binary type ${detected.mime}`,
    };
  }
  // XML is a text format: fall through to the text checks below (the Apple
  // Health <HealthData marker lives there).

  // No magic bytes — text formats and conflicts.
  if (ext === "pdf") {
    // The %PDF- signature may sit within the first 1024 bytes (binary prefix).
    const probe = new TextDecoder("latin1").decode(
      input.head.subarray(0, 1024),
    );
    if (probe.includes("%PDF-")) return { kind: "ambiguous", inputKind: "pdf" };
    return { kind: "unknown", detail: "'.pdf' extension but no PDF signature" };
  }

  const text = decodeHeadText(input.head);

  if (
    text &&
    (ext === "xml" || text.startsWith("<?xml") || text.slice(0, 4096).includes("<HealthData"))
  ) {
    if (text.includes("<HealthData")) {
      return {
        kind: "classified",
        docType: "apple_health_export",
        detail: "XML contains <HealthData (Apple Health export)",
      };
    }
    return { kind: "ambiguous", inputKind: "text" };
  }

  if (text && (ext === "csv" || input.contentType?.includes("csv") || looksLikeCsvText(text))) {
    const header = firstLine(text);
    if (isWearableCsvHeader(header)) {
      return {
        kind: "classified",
        docType: "wearable_export",
        detail: `wearable CSV header '${header.slice(0, 80)}'`,
      };
    }
    return { kind: "ambiguous", inputKind: "csv" };
  }

  if (text) return { kind: "ambiguous", inputKind: "text" };

  return { kind: "unknown", detail: "unrecognized binary content" };
}

// ---------------------------------------------------------------------------
// Zip central directory (ranged reads; the whole archive is never buffered)
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b06;
const CD_ENTRY_SIG = 0x02014b50;

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function u64(bytes: Uint8Array, offset: number): number {
  return u32(bytes, offset + 4) * 2 ** 32 + u32(bytes, offset);
}

interface CentralDirectoryRef {
  entries: number;
  cdOffset: number;
  cdSize: number;
}

/** Locates the end-of-central-directory record in the tail window. */
function findEocd(tail: Uint8Array): { ref: CentralDirectoryRef; at: number } | null {
  // EOCD is 22 bytes + up to 64 KiB of comment; scan backwards for the
  // signature and validate the record ends exactly at EOF.
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tail, i) !== EOCD_SIG) continue;
    if (i + 22 + u16(tail, i + 20) !== tail.length) continue;
    if (u16(tail, i + 4) !== 0 || u16(tail, i + 6) !== 0) return null; // multi-disk
    return {
      at: i,
      ref: {
        entries: u16(tail, i + 10),
        cdSize: u32(tail, i + 12),
        cdOffset: u32(tail, i + 16),
      },
    };
  }
  return null;
}

/** Reads the ZIP64 EOCD when the classic EOCD fields are saturated. */
async function readZip64Ref(
  readRange: ReadOriginalRange,
  s3Key: string,
  tail: Uint8Array,
  eocdAt: number,
  tailStart: number,
): Promise<CentralDirectoryRef | null> {
  if (eocdAt < 20 || u32(tail, eocdAt - 20) !== ZIP64_LOCATOR_SIG) return null;
  const zip64Offset = u64(tail, eocdAt - 20 + 8);
  if (zip64Offset >= tailStart + tail.length) return null;
  const range = await readRange(s3Key, zip64Offset, zip64Offset + 56);
  if (!range || range.bytes.length < 56) return null;
  const record = range.bytes;
  if (u32(record, 0) !== ZIP64_EOCD_SIG) return null;
  return {
    entries: u64(record, 32),
    cdSize: u64(record, 40),
    cdOffset: u64(record, 48),
  };
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  return new TextDecoder(utf8 ? "utf-8" : "latin1").decode(bytes);
}

/**
 * Lists the entry names of a zip stored at s3Key via ranged reads: tail →
 * EOCD → central directory. Returns null for unreadable/implausible
 * structures (the caller then classifies the archive as unknown).
 */
export async function listZipEntries(
  readRange: ReadOriginalRange,
  s3Key: string,
  sizeBytes: number | null,
): Promise<string[] | null> {
  const tailRange =
    sizeBytes === null
      ? await readRange(s3Key, -ZIP_TAIL_BYTES)
      : await readRange(
          s3Key,
          Math.max(0, sizeBytes - Math.min(sizeBytes, ZIP_TAIL_BYTES)),
          sizeBytes,
        );
  if (!tailRange || tailRange.bytes.length < 22) return null;
  const totalSize = sizeBytes ?? tailRange.totalSize;
  if (totalSize === null) return null;
  const tail = tailRange.bytes;
  const tailStart = totalSize - tail.length;

  const eocd = findEocd(tail);
  if (!eocd) return null;

  let ref = eocd.ref;
  const saturated =
    ref.entries === 0xffff ||
    ref.cdSize === 0xffffffff ||
    ref.cdOffset === 0xffffffff;
  if (saturated) {
    const zip64 = await readZip64Ref(readRange, s3Key, tail, eocd.at, tailStart);
    if (!zip64) return null;
    ref = zip64;
  }

  if (ref.entries === 0) return [];
  if (ref.entries > ZIP_MAX_ENTRIES || ref.cdSize > ZIP_CD_MAX_BYTES) {
    return null;
  }
  const cdRange = await readRange(s3Key, ref.cdOffset, ref.cdOffset + ref.cdSize);
  if (!cdRange || cdRange.bytes.length < ref.cdSize) return null;
  const cd = cdRange.bytes;

  const names: string[] = [];
  let offset = 0;
  while (names.length < ref.entries && offset + 46 <= cd.length) {
    if (u32(cd, offset) !== CD_ENTRY_SIG) return null; // corrupt directory
    const nameLen = u16(cd, offset + 28);
    const extraLen = u16(cd, offset + 30);
    const commentLen = u16(cd, offset + 32);
    const utf8 = (u16(cd, offset + 8) & 0x0800) !== 0;
    names.push(
      decodeEntryName(cd.subarray(offset + 46, offset + 46 + nameLen), utf8),
    );
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ---------------------------------------------------------------------------
// Layer 2: Kimi fallback classifier (EN+LT)
// ---------------------------------------------------------------------------

export interface KimiClassification {
  docType: DocumentType;
  language: string;
  confidence: number;
  summary: string;
}

export const CLASSIFY_SCHEMA: JsonSchemaDefinition = {
  name: "health_document_classification",
  description:
    "Classification of one dropped file for a personal health dashboard.",
  strict: true,
  schema: {
    type: "object",
    properties: {
      docType: {
        type: "string",
        enum: [...DOCUMENT_TYPES],
        description: "The single best-fitting document type.",
      },
      language: {
        type: "string",
        description:
          "ISO-639-1 code of the document's dominant language ('en', 'lt', ...).",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description:
          "Self-reported confidence 0-1; below 0.6 the document is flagged for human review.",
      },
      summary: {
        type: "string",
        description:
          "1-2 sentence English summary shown in the documents library.",
      },
    },
    required: ["docType", "language", "confidence", "summary"],
    additionalProperties: false,
  },
};

export const CLASSIFY_SYSTEM_PROMPT = `You are the document classifier for a personal health dashboard. The owner drops arbitrary files — lab result PDFs, wearable data exports, medical letters, archive exports — and you decide what each file is.

Documents may be in ENGLISH or LITHUANIAN (lab reports from Lithuanian providers such as Antėja, Medicina practica, SYNLAB Lietuva or Affidea are common). Read both equally well and report the dominant language as an ISO-639-1 code.

Judge ONLY from the provided filename and content excerpt — never invent content that is not there.

Choose exactly one docType:
- lab_report — laboratory results: blood/urine panels with analytes, values, units, reference ranges.
- medical_doc — any other medical document: discharge letters, referrals, imaging reports, prescriptions, vaccination records, doctor's notes.
- wearable_export — structured exports from wearables or fitness apps (Garmin, Oura, Whoop): daily metrics, sleep, heart rate, workouts.
- fit_export — Google Fit data specifically (Google Takeout Fit CSV/JSON files).
- apple_health_export — Apple Health export.xml content.
- takeout_archive — Google Takeout archives.
- image — a photo or scan (the classification refers to the image file itself, not its contents).
- unknown — not a health document, unreadable, or pure noise.

If the excerpt is genuinely a health document but the type is unclear, pick the best type and reflect the uncertainty in confidence (below 0.6 the document goes to human review). If it is not a health document at all, answer unknown with high confidence.

summary: 1-2 sentences in English describing the document for the library, e.g. "Blood panel (32 analytes) from SYNLAB Lietuva, sampled 2026-03-14." For unknown files say what the file appears to be.`;

/** Validates the raw chatStructured JSON string (callers own validation). */
export function parseKimiClassification(
  raw: string,
): { ok: true; value: KimiClassification } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "reply is not a JSON object" };
  }
  const { docType, language, confidence, summary } = data as Record<
    string,
    unknown
  >;
  if (
    typeof docType !== "string" ||
    !(DOCUMENT_TYPES as readonly string[]).includes(docType)
  ) {
    return {
      ok: false,
      error: `docType must be one of: ${DOCUMENT_TYPES.join(", ")}`,
    };
  }
  if (typeof language !== "string" || !/^[a-z]{2}$/.test(language)) {
    return { ok: false, error: "language must be an ISO-639-1 code" };
  }
  if (
    typeof confidence !== "number" ||
    Number.isNaN(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    return { ok: false, error: "confidence must be a number between 0 and 1" };
  }
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, error: "summary must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      docType: docType as DocumentType,
      language,
      confidence,
      summary: summary.trim(),
    },
  };
}

function sampleLines(text: string): string {
  const lines = text.split("\n", KIMI_SAMPLE_LINES + 1);
  return lines.slice(0, KIMI_SAMPLE_LINES).join("\n").slice(0, KIMI_SAMPLE_MAX_CHARS);
}

/** Best-effort text sample of a binary head (PDF fallback path). */
function rawHeadSample(head: Uint8Array): string {
  const latin1 = new TextDecoder("latin1").decode(
    head.subarray(0, KIMI_RAW_HEAD_BYTES),
  );
  // Strip runs of non-printable bytes so the prompt stays readable.
  return latin1.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]+/g, " ").trim();
}

interface KimiContent {
  /** Human label for the user prompt (how the sample was obtained). */
  sourceLabel: string;
  sample: string;
}

async function defaultExtractFileText(
  bytes: Uint8Array,
  filename: string,
): Promise<string | null> {
  const { fileId } = await uploadForExtract(bytes, filename);
  try {
    const result = await getExtractedText(fileId);
    return result.kind === "text" ? result.text : null;
  } finally {
    await deleteFile(fileId).catch(() => {
      // Best-effort cleanup; a leaked file never fails the stage.
    });
  }
}

export interface ClassifyStageDeps {
  sql: postgres.Sql;
  /** Defaults to src/lib/storage getOriginalRange. */
  readRange?: ReadOriginalRange;
  /** Defaults to the real chatStructured (Kimi). */
  chatStructured?: (params: ChatStructuredParams) => Promise<string>;
  /** Defaults to the Kimi files module (upload + content + delete). */
  extractFileText?: (
    bytes: Uint8Array,
    filename: string,
  ) => Promise<string | null>;
  /** Defaults to KIMI_MODELS.chat. */
  model?: string;
}

interface DocumentForClassify {
  s3_key: string;
  content_type: string | null;
  size_bytes: number | null;
  metadata_overrides: { documentType?: unknown } | null;
}

export interface Classification {
  docType: DocumentType;
  /** 1 for deterministic hits; the model's 0..1 verdict; null for unknowns. */
  confidence: number | null;
  language?: string;
  summary?: string;
  source: "deterministic" | "kimi" | "metadata_override";
  /** What decided the classification (marker, magic bytes) — breadcrumb. */
  detail?: string;
}

function classifyPayload(
  classification: Classification,
  model: string,
  halt?: StageHalt,
): postgres.JSONValue {
  const payload: { [key: string]: postgres.JSONValue } = {
    promptVersion: CLASSIFY_PROMPT_V1,
    source: classification.source,
    docType: classification.docType,
    confidence: classification.confidence,
  };
  if (classification.language) payload.language = classification.language;
  if (classification.summary) payload.summary = classification.summary;
  if (classification.detail) payload.detail = classification.detail;
  if (classification.source === "kimi") payload.model = model;
  if (halt) {
    payload.halt = halt.reason
      ? { status: halt.status, reason: halt.reason }
      : { status: halt.status };
  }
  return payload;
}

async function persistClassification(
  sql: postgres.Sql,
  documentId: string,
  classification: Classification,
): Promise<void> {
  await sql`
    update documents
    set document_type = ${classification.docType},
        classification_confidence = ${classification.confidence},
        ai_summary = ${classification.summary ?? null}
    where id = ${documentId}
  `;
}

/**
 * Builds the classifying stage runner. Injectable seams (readRange,
 * chatStructured, extractFileText) keep tests free of MinIO/Kimi; production
 * defaults hit MinIO and the real Kimi client.
 */
export function createClassifyStage(deps: ClassifyStageDeps): StageRunner {
  const readRange: ReadOriginalRange = deps.readRange ?? getOriginalRange;
  const chat = deps.chatStructured ?? chatStructured;
  const extractFileText = deps.extractFileText ?? defaultExtractFileText;
  const model = deps.model ?? KIMI_MODELS.chat;
  const { sql } = deps;

  return async (ctx) => {
    const rows = await sql<DocumentForClassify[]>`
      select s3_key, content_type, size_bytes::float8 as size_bytes, metadata_overrides
      from documents
      where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) {
      throw new Error(`document ${ctx.documentId} vanished mid-classify`);
    }

    // A "Process as…" hint (metadata override) beats sniffing and Kimi — the
    // user has already told us what this file is.
    const overrideType = document.metadata_overrides?.documentType;
    if (
      typeof overrideType === "string" &&
      (DOCUMENT_TYPES as readonly string[]).includes(overrideType)
    ) {
      const classification: Classification = {
        docType: overrideType as DocumentType,
        confidence: null,
        source: "metadata_override",
        detail: "user-supplied 'Process as…' hint",
      };
      await persistClassification(sql, ctx.documentId, classification);
      return classifyPayload(classification, model);
    }

    const headRange = await readRange(document.s3_key, 0, HEAD_BYTES);
    if (!headRange || headRange.bytes.length === 0) {
      throw new Error(`original ${document.s3_key} not found or empty`);
    }
    const head = headRange.bytes;

    const verdict = await sniffDeterministic({
      filename: ctx.originalFilename,
      contentType: document.content_type,
      head,
      listZipEntries: () =>
        listZipEntries(
          readRange,
          document.s3_key,
          document.size_bytes ?? headRange.totalSize,
        ),
    });

    if (verdict.kind === "unknown") {
      const classification: Classification = {
        docType: "unknown",
        confidence: null,
        source: "deterministic",
        detail: verdict.detail,
      };
      await persistClassification(sql, ctx.documentId, classification);
      return classifyPayload(classification, model, {
        status: "ignored",
        reason: verdict.detail,
      });
    }

    if (verdict.kind === "classified") {
      const classification: Classification = {
        docType: verdict.docType,
        confidence: 1,
        source: "deterministic",
        detail: verdict.detail,
      };
      await persistClassification(sql, ctx.documentId, classification);
      return classifyPayload(classification, model);
    }

    // Layer 2: ambiguous container → Kimi.
    const content = await kimiContent(
      verdict.inputKind,
      ctx.originalFilename,
      document,
      head,
      readRange,
      extractFileText,
    );
    const userMessage =
      `Filename: ${ctx.originalFilename}\n` +
      (document.content_type ? `Content-Type: ${document.content_type}\n` : "") +
      `${content.sourceLabel}:\n\`\`\`\n${content.sample}\n\`\`\``;

    const kimi = await classifyWithKimi(chat, model, userMessage);
    const classification: Classification = {
      docType: kimi.docType,
      confidence: kimi.confidence,
      language: kimi.language,
      summary: kimi.summary,
      source: "kimi",
    };
    await persistClassification(sql, ctx.documentId, classification);

    if (kimi.docType === "unknown") {
      return classifyPayload(classification, model, {
        status: "ignored",
        reason: "Kimi classified the document as unknown",
      });
    }
    if (kimi.confidence < CLASSIFY_CONFIDENCE_THRESHOLD) {
      return classifyPayload(classification, model, {
        status: "needs_review",
        reason: `classifier confidence ${kimi.confidence} below ${CLASSIFY_CONFIDENCE_THRESHOLD}`,
      });
    }
    return classifyPayload(classification, model);
  };
}

async function kimiContent(
  inputKind: AmbiguousKind,
  filename: string,
  document: DocumentForClassify,
  head: Uint8Array,
  readRange: ReadOriginalRange,
  extractFileText: (
    bytes: Uint8Array,
    filename: string,
  ) => Promise<string | null>,
): Promise<KimiContent> {
  if (inputKind === "pdf") {
    const size = document.size_bytes;
    if (size !== null && size > 0 && size <= EXTRACT_MAX_BYTES) {
      const whole = await readRange(document.s3_key, 0, size);
      if (whole && whole.bytes.length > 0) {
        const text = await extractFileText(whole.bytes, filename);
        if (text && text.trim().length > 0) {
          return {
            sourceLabel: "Extracted text (Kimi file-extract)",
            sample: text.slice(0, KIMI_SAMPLE_MAX_CHARS),
          };
        }
      }
    }
    // Scanned/oversized PDF or extract failure: filename + first 4 KB.
    return {
      sourceLabel: "First 4 KB of the file (raw, may include PDF operators)",
      sample: rawHeadSample(head),
    };
  }
  const text = decodeHeadText(head) ?? rawHeadSample(head);
  return {
    sourceLabel: `First ~${KIMI_SAMPLE_LINES} lines`,
    sample: sampleLines(text),
  };
}

/**
 * chatStructured + validation with ONE retry on an invalid reply. The retry
 * is a fresh single-turn call: Kimi thinking models reject multi-turn
 * histories that lack reasoning_content, and chatStructured returns content
 * only — so echoing the bad reply back is not an option here.
 */
async function classifyWithKimi(
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  userMessage: string,
): Promise<KimiClassification> {
  const params: ChatStructuredParams = {
    schema: CLASSIFY_SCHEMA,
    model,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  };
  const first = parseKimiClassification(await chat(params));
  if (first.ok) return first.value;
  const second = parseKimiClassification(await chat(params));
  if (!second.ok) {
    throw new Error(
      `Kimi classification failed validation twice (${first.error}; ${second.error})`,
    );
  }
  return second.value;
}
