// The 'summarizing' stage — the final pipeline stage, for EVERY document
// that was not halted earlier:
//
//   1. ai_summary: one Kimi call writes 2-4 sentences (document language or
//      English) into documents.ai_summary, overwriting the classifier's
//      provisional 1-2 sentence guess. The summary is part of the generated
//      extracted_tsv column, so this is what makes documents full-text
//      searchable by content. Documents without a text layer (Apple Health
//      exports, wearable CSVs, archives) are summarized from a digest of
//      their pipeline payloads instead.
//   2. Post-ingestion insight (lab_report only; wearable/activity documents
//      are skipped in v1): one Kimi call compares the newly persisted
//      biomarker_results against history (biomarker-results repo getTrend)
//      and writes ONE ai_insights row (kind 'post_ingestion') whose
//      source_refs point at the document and the result rows it discusses.
//      Bounded to max one insight per document: an existing insight for the
//      document makes the insert a no-op, so a retried stage never doubles.
//
// Both calls validate the model's JSON and retry once with the error
// appended; a second validation failure THROWS (transient model garble — the
// executor retries the job), mirroring worker/normalize.ts.
//
// Runs under plain node type stripping in the worker container: every
// relative import carries an explicit .ts extension; DB access is raw
// postgres.js SQL except getTrend, which needs the drizzle repo (wrapped via
// drizzleWithoutHijack so the shared pool's serializers survive).

import type postgres from "postgres";

import { getTrend } from "../src/db/repos/biomarker-results.ts";
import type { InsightSourceRef } from "../src/db/schema.ts";
import {
  DOCUMENT_SUMMARY_JSON_SCHEMA,
  POST_INGESTION_INSIGHT_JSON_SCHEMA,
  parseDocumentSummary,
  parsePostIngestionInsight,
  type DocumentSummary,
  type PostIngestionInsight,
} from "../src/lib/ingest/schemas.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
  type JsonSchemaDefinition,
} from "../src/lib/kimi/client.ts";
import type { StageRunner } from "./ingestion.ts";
import { drizzleWithoutHijack } from "./normalize.ts";

/** Prompt version recorded in every raw_extractions('summarizing') payload. */
export const SUMMARY_PROMPT_V1 = "doc-summary-v1";

/** Prompt version recorded on the ai_insights row this stage writes. */
export const INSIGHT_PROMPT_V1 = "post-ingestion-insight-v1";

/** Extracted text fed to the summary call is capped at this many characters. */
export const SUMMARY_TEXT_CAP = 16_000;

/** History points per biomarker fed to the insight call (most recent). */
export const TREND_POINTS_PER_BIOMARKER = 25;

const SUMMARY_SYSTEM_PROMPT = `You summarize health documents for a personal health dashboard. Documents may be in English or Lithuanian.

Write 2-4 sentences in the document's own language (English when unsure): what the document is, the provider and date when known, and the key content or findings. Judge ONLY from the provided input — never invent values, providers, or dates.`;

const INSIGHT_SYSTEM_PROMPT = `You are the insight engine of a personal health dashboard. You receive the biomarker results from ONE newly filed lab report plus the patient's result history for those biomarkers (canonical units).

Write ONE insight about the most notable change or finding: direction and magnitude versus history (percent or absolute), and reference-range context (entered range, left range, still out of range). If the report is unremarkable, say so plainly in one sentence. Use plain language, no diagnosis, no advice. Judge ONLY from the provided numbers — never invent values.`;

type Chat = (params: ChatStructuredParams) => Promise<string>;

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * One chatStructured call, validated; on validation failure one retry with
 * the error appended (a fresh single-turn call — thinking models reject
 * multi-turn histories without reasoning_content). Throws after the second
 * validation failure so the job is retried instead of caching garble.
 */
async function chatValidated<T>(
  chat: Chat,
  jsonSchema: JsonSchemaDefinition,
  model: string,
  systemPrompt: string,
  userMessage: string,
  parse: (raw: string) => ParseResult<T>,
): Promise<T> {
  const paramsFor = (message: string): ChatStructuredParams => ({
    schema: jsonSchema,
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: message },
    ],
  });

  const first = parse(await chat(paramsFor(userMessage)));
  if (first.ok) return first.value;
  const retryMessage =
    `${userMessage}\n\n` +
    `Your previous reply failed validation: ${first.error}. ` +
    "Reply with corrected JSON only.";
  const second = parse(await chat(paramsFor(retryMessage)));
  if (!second.ok) {
    throw new Error(
      `${jsonSchema.name} failed validation twice (${first.error}; ${second.error})`,
    );
  }
  return second.value;
}

interface DocumentForSummarize {
  document_type: string;
  provider: string | null;
  document_date: string | null;
  extracted_text: string | null;
}

interface DocumentResultRow {
  id: string;
  slug: string;
  name: string;
  canonical_unit: string;
  measured_on: string;
  value: number;
  unit: string;
  ref_low: number | null;
  ref_high: number | null;
  flag: string | null;
}

/** Compact digest of earlier stage payloads, for documents without text. */
async function pipelineDigest(
  sql: postgres.Sql,
  documentId: string,
): Promise<string> {
  const rows = await sql<{ stage: string; payload: unknown }[]>`
    select stage, payload from raw_extractions
    where document_id = ${documentId}
  `;
  const digest: Record<string, unknown> = {};
  for (const { stage, payload } of rows) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      continue;
    }
    const p = payload as Record<string, unknown>;
    if (stage === "classifying") {
      digest.classifierNote = p.summary;
      digest.classificationConfidence = p.confidence;
    } else if (stage === "extracting") {
      digest.extraction =
        p.skipped === true
          ? { skipped: true }
          : {
              metrics: p.metrics,
              workouts: p.workouts,
              analytes: Array.isArray(p.extraction)
                ? undefined
                : (p.extraction as { biomarkers?: unknown[] } | undefined)
                    ?.biomarkers?.length,
            };
    } else if (stage === "normalizing") {
      digest.normalization = {
        analytes: p.total,
        persisted: p.inserted,
        unmapped: p.unmapped,
      };
    }
  }
  return JSON.stringify(digest);
}

function summaryUserMessage(
  ctx: Parameters<StageRunner>[0],
  document: DocumentForSummarize,
  digest: string | null,
): string {
  const header =
    `Filename: ${ctx.originalFilename}\n` +
    `Document type: ${document.document_type}\n` +
    `Provider: ${document.provider ?? "unknown"}\n` +
    `Document date: ${document.document_date ?? "unknown"}`;
  const text = document.extracted_text?.trim();
  if (text) {
    return `${header}\n\nExtracted text:\n\`\`\`\n${text.slice(0, SUMMARY_TEXT_CAP)}\n\`\`\``;
  }
  return `${header}\n\nNo text layer. Pipeline digest:\n\`\`\`\n${digest ?? "{}"}\n\`\`\``;
}

function refTextOf(row: DocumentResultRow): string {
  if (row.ref_low !== null && row.ref_high !== null) {
    return `reference ${row.ref_low}–${row.ref_high}`;
  }
  if (row.ref_high !== null) return `reference < ${row.ref_high}`;
  if (row.ref_low !== null) return `reference > ${row.ref_low}`;
  return "no reference range";
}

/** Renders the insight-call user message from new results + trend history. */
function insightUserMessage(
  filename: string,
  documentDate: string | null,
  provider: string | null,
  results: DocumentResultRow[],
  trendLines: string[],
): string {
  const newLines = results.map(
    (row) =>
      `- ${row.name} (${row.slug}): ${row.value} ${row.unit} ` +
      `(${refTextOf(row)}${row.flag ? `, flagged ${row.flag}` : ""})`,
  );
  const history =
    trendLines.length > 0
      ? trendLines.join("\n")
      : "No prior history for these biomarkers — this is the first record.";
  return (
    `New lab report "${filename}"` +
    ` (measured ${documentDate ?? "unknown date"}, ${provider ?? "unknown lab"}):\n` +
    `${newLines.join("\n")}\n\n` +
    `History (canonical units, ascending):\n${history}`
  );
}

export interface SummarizeStageDeps {
  sql: postgres.Sql;
  /** Defaults to the real chatStructured (Kimi). */
  chatStructured?: (params: ChatStructuredParams) => Promise<string>;
  /** Defaults to KIMI_MODELS.chat. */
  model?: string;
}

/**
 * Builds the summarizing stage runner. The injectable chatStructured seam
 * keeps tests free of Kimi; production defaults hit the real client.
 */
export function createSummarizeStage(deps: SummarizeStageDeps): StageRunner {
  const chat = deps.chatStructured ?? chatStructured;
  const model = deps.model ?? KIMI_MODELS.chat;
  const { sql } = deps;

  return async (ctx) => {
    const rows = await sql<DocumentForSummarize[]>`
      select document_type, provider, document_date::text as document_date,
             extracted_text
      from documents
      where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) {
      throw new Error(`document ${ctx.documentId} vanished mid-summarize`);
    }

    // (1) ai_summary — every processed document.
    const digest = document.extracted_text?.trim()
      ? null
      : await pipelineDigest(sql, ctx.documentId);
    const { summary } = await chatValidated<DocumentSummary>(
      chat,
      DOCUMENT_SUMMARY_JSON_SCHEMA,
      model,
      SUMMARY_SYSTEM_PROMPT,
      summaryUserMessage(ctx, document, digest),
      parseDocumentSummary,
    );
    await sql`
      update documents set ai_summary = ${summary} where id = ${ctx.documentId}
    `;

    // (2) post-ingestion insight — lab_report only in v1.
    let insight: { id: string; title: string } | null = null;
    let insightSkipped: string | undefined;
    if (document.document_type !== "lab_report") {
      insightSkipped = `document type '${document.document_type}' gets no insight in v1`;
    } else {
      insight = await maybeCreateInsight(sql, chat, model, ctx, document);
      if (!insight) insightSkipped = "no persisted results";
    }

    return {
      promptVersion: SUMMARY_PROMPT_V1,
      model,
      summary,
      insight: insight
        ? { ...insight, promptVersion: INSIGHT_PROMPT_V1, model }
        : null,
      ...(insightSkipped ? { insightSkipped } : {}),
    };
  };
}

/**
 * The lab_report branch of the stage: compares the document's persisted
 * results against history and inserts ONE ai_insights row. Returns null when
 * the document has no persisted results (nothing to compare). An existing
 * post_ingestion insight for the document makes this a no-op returning the
 * existing row — max one insight per document, even across stage retries.
 */
async function maybeCreateInsight(
  sql: postgres.Sql,
  chat: Chat,
  model: string,
  ctx: Parameters<StageRunner>[0],
  document: DocumentForSummarize,
): Promise<{ id: string; title: string } | null> {
  const results = await sql<DocumentResultRow[]>`
    select r.id, b.slug, b.name, b.canonical_unit, r.measured_on::text as measured_on,
           r.value::float8 as value, r.unit,
           r.ref_low::float8 as ref_low, r.ref_high::float8 as ref_high, r.flag
    from biomarker_results r
    join biomarkers b on b.id = r.biomarker_id
    where r.document_id = ${ctx.documentId}
    order by b.name
  `;
  if (results.length === 0) return null;

  const documentRef: InsightSourceRef = {
    kind: "document",
    id: ctx.documentId,
    note: ctx.originalFilename,
  };
  const existing = await sql<{ id: string; title: string | null }[]>`
    select id, title from ai_insights
    where kind = 'post_ingestion'
      and source_refs @> ${sql.json([{ kind: "document", id: ctx.documentId }])}
    limit 1
  `;
  if (existing[0]) {
    return { id: existing[0].id, title: existing[0].title ?? "" };
  }

  // History per biomarker via the repo (drizzle handle on the shared pool,
  // serializers restored — see drizzleWithoutHijack in worker/normalize.ts).
  const db = drizzleWithoutHijack(sql);
  const trendLines: string[] = [];
  for (const slug of [...new Set(results.map((row) => row.slug))]) {
    const trend = await getTrend(db, slug);
    const points = trend
      .filter((point) => point.valueCanonical !== null)
      .slice(-TREND_POINTS_PER_BIOMARKER);
    if (points.length === 0) continue;
    const unit = results.find((row) => row.slug === slug)?.canonical_unit;
    trendLines.push(
      `- ${slug} (${unit}): ` +
        points
          .map((point) => `${point.measuredOn}=${point.valueCanonical}`)
          .join("; "),
    );
  }

  const insight = await chatValidated<PostIngestionInsight>(
    chat,
    POST_INGESTION_INSIGHT_JSON_SCHEMA,
    model,
    INSIGHT_SYSTEM_PROMPT,
    insightUserMessage(
      ctx.originalFilename,
      document.document_date,
      document.provider,
      results,
      trendLines,
    ),
    parsePostIngestionInsight,
  );

  const sourceRefs: InsightSourceRef[] = [
    documentRef,
    ...results.map((row) => ({
      kind: "biomarker_result",
      id: row.id,
      note: row.slug,
    })),
  ];
  const inserted = await sql<{ id: string }[]>`
    insert into ai_insights (kind, title, body_md, model, prompt_version, source_refs)
    values (
      'post_ingestion', ${insight.title}, ${insight.body}, ${model},
      ${INSIGHT_PROMPT_V1}, ${sql.json(sourceRefs as unknown as postgres.JSONValue)}
    )
    returning id
  `;
  return { id: inserted[0].id, title: insight.title };
}
