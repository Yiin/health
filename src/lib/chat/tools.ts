// Tool definitions + dispatch for the /chat assistant. The model (Kimi
// tool calling) invokes these against the user's own data; every tool result
// is a JSON string, and tools that touch documents also record citations —
// the quoted passages the answer was built from (rendered as cards linking
// to /documents/[id]).

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getDocument, searchDocuments } from "../../db/repos/documents";
import type { ChatCitation } from "../../db/schema";
import type * as schema from "../../db/schema";

type Db = PostgresJsDatabase<typeof schema>;

export const CHAT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Full-text search over the user's health documents (lab reports, medical documents, wearable exports). Returns matching documents with highlighted snippets. Use it whenever the question concerns document content.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Plain-language search query" },
          limit: {
            type: "integer",
            description: "Max results (default 5, max 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_biomarker_trend",
      description:
        "Time series of lab results for one biomarker, by slug (e.g. ferritin), optionally limited to a date range. Use it for 'how has X changed' questions.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Biomarker slug" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_daily_metrics",
      description:
        "Daily wearable metric values (steps, hrv_ms, resting_hr, sleep_total_min, sleep_deep_min, sleep_rem_min, sleep_light_min, weight_kg) for a date range.",
      parameters: {
        type: "object",
        properties: {
          metric: { type: "string", description: "Metric name" },
          from: { type: "string", description: "Start date YYYY-MM-DD" },
          to: { type: "string", description: "End date YYYY-MM-DD" },
          source: {
            type: "string",
            description: "Optional source filter (e.g. google-fit, oura)",
          },
        },
        required: ["metric"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document",
      description:
        "Fetch one document's metadata, AI summary, and a text excerpt by id. Use it to quote a source in depth after finding it via search_documents.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document id (uuid)" },
        },
        required: ["id"],
      },
    },
  },
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TREND_POINTS = 400;
const MAX_METRIC_POINTS = 400;
const DOCUMENT_EXCERPT_CHARS = 3000;
const QUOTE_CHARS = 300;
const MAX_CITATIONS = 20;

function addCitation(citations: ChatCitation[], citation: ChatCitation): void {
  if (citations.length >= MAX_CITATIONS) return;
  const exists = citations.some(
    (c) => c.documentId === citation.documentId && c.quote === citation.quote,
  );
  if (!exists) citations.push(citation);
}

/** ts_headline highlights matches with <b></b>; quotes are plain text. */
function stripHighlight(snippet: string): string {
  return snippet.replace(/<\/?b>/g, "");
}

function isUndefinedTable(error: unknown): boolean {
  const { code, cause } = (error ?? {}) as {
    code?: string;
    cause?: { code?: string };
  };
  // drizzle wraps driver errors, so the Postgres code may be on .cause.
  return code === "42P01" || cause?.code === "42P01";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asDate(value: unknown): string | undefined {
  const str = asString(value);
  return str && DATE_RE.test(str) ? str : undefined;
}

async function runSearchDocuments(
  db: Db,
  args: Record<string, unknown>,
  citations: ChatCitation[],
): Promise<string> {
  const query = asString(args.query);
  if (!query) return JSON.stringify({ error: "query is required" });
  const rawLimit = typeof args.limit === "number" ? args.limit : 5;
  const limit = Math.max(1, Math.min(10, Math.floor(rawLimit)));

  const hits = await searchDocuments(db, query, { limit });
  for (const hit of hits) {
    addCitation(citations, {
      documentId: hit.id,
      filename: hit.filename,
      quote: stripHighlight(hit.snippet).slice(0, QUOTE_CHARS),
    });
  }
  return JSON.stringify({
    results: hits.map((hit) => ({
      documentId: hit.id,
      filename: hit.filename,
      documentType: hit.documentType,
      provider: hit.provider,
      documentDate: hit.documentDate,
      snippet: stripHighlight(hit.snippet),
    })),
    ...(hits.length === 0 ? { note: "No documents matched the query." } : {}),
  });
}

async function runGetBiomarkerTrend(
  db: Db,
  args: Record<string, unknown>,
  citations: ChatCitation[],
): Promise<string> {
  const slug = asString(args.slug);
  if (!slug) return JSON.stringify({ error: "slug is required" });
  const from = asDate(args.from);
  const to = asDate(args.to);

  const known = await db.execute(
    sql`select slug, name, canonical_unit from biomarkers where slug = ${slug}`,
  );
  const biomarker = known[0] as
    | { slug: string; name: string; canonical_unit: string }
    | undefined;
  if (!biomarker) {
    const all = await db.execute(
      sql`select slug from biomarkers order by slug`,
    );
    return JSON.stringify({
      error: `Unknown biomarker slug "${slug}".`,
      validSlugs: all.map((row) => row.slug as string),
    });
  }

  const rows = await db.execute(sql`
    select r.measured_on::text as measured_on,
           r.value::float8 as value, r.unit,
           r.value_canonical::float8 as value_canonical,
           r.ref_text, r.lab_name, r.flag,
           r.document_id, d.original_filename
    from biomarker_results r
    left join documents d on d.id = r.document_id
    where r.biomarker_id = (select id from biomarkers where slug = ${slug})
    ${from ? sql`and r.measured_on >= ${from}` : sql``}
    ${to ? sql`and r.measured_on <= ${to}` : sql``}
    order by r.measured_on asc
    limit ${MAX_TREND_POINTS}`);

  const points = rows.map((row) => ({
    measuredOn: row.measured_on as string,
    value: row.value as number,
    unit: row.unit as string,
    valueCanonical: row.value_canonical as number | null,
    refText: row.ref_text as string | null,
    labName: row.lab_name as string | null,
    flag: row.flag as string | null,
    documentId: row.document_id as string | null,
  }));

  for (const row of rows) {
    if (typeof row.document_id === "string" && row.original_filename) {
      const ref = row.ref_text ? ` (ref ${row.ref_text})` : "";
      addCitation(citations, {
        documentId: row.document_id as string,
        filename: row.original_filename as string,
        quote:
          `${biomarker.name}: ${row.value} ${row.unit} on ${row.measured_on}${ref}`.slice(
            0,
            QUOTE_CHARS,
          ),
      });
    }
  }

  return JSON.stringify({
    biomarker: {
      slug: biomarker.slug,
      name: biomarker.name,
      canonicalUnit: biomarker.canonical_unit,
    },
    points,
    ...(points.length === 0
      ? { note: "No results recorded for this biomarker in the range." }
      : {}),
  });
}

async function runGetDailyMetrics(
  db: Db,
  args: Record<string, unknown>,
): Promise<string> {
  const metric = asString(args.metric);
  if (!metric) return JSON.stringify({ error: "metric is required" });
  const from = asDate(args.from);
  const to = asDate(args.to);
  const source = asString(args.source);

  try {
    // daily_metrics is owned by the activity-domain issue and lands
    // independently; until it exists (42P01) report "no data" gracefully.
    const rows = await db.execute(sql`
      select metric_on::text as date, value::float8 as value, unit, source
      from daily_metrics
      where metric = ${metric}
      ${from ? sql`and metric_on >= ${from}` : sql``}
      ${to ? sql`and metric_on <= ${to}` : sql``}
      ${source ? sql`and source = ${source}` : sql``}
      order by metric_on asc
      limit ${MAX_METRIC_POINTS}`);
    return JSON.stringify({
      metric,
      points: rows.map((row) => ({
        date: row.date as string,
        value: row.value as number,
        unit: row.unit as string,
        source: row.source as string,
      })),
      ...(rows.length === 0
        ? { note: "No values recorded for this metric in the range." }
        : {}),
    });
  } catch (error) {
    if (isUndefinedTable(error)) {
      return JSON.stringify({
        metric,
        points: [],
        note: "No wearable data has been ingested yet.",
      });
    }
    throw error;
  }
}

async function runGetDocument(
  db: Db,
  args: Record<string, unknown>,
  citations: ChatCitation[],
): Promise<string> {
  const id = asString(args.id);
  if (!id) return JSON.stringify({ error: "id is required" });

  const document = await getDocument(db, id);
  if (!document) {
    return JSON.stringify({ error: `No document with id "${id}".` });
  }
  const excerpt = (document.extractedText ?? "").slice(
    0,
    DOCUMENT_EXCERPT_CHARS,
  );
  const quote = (document.aiSummary ?? excerpt).slice(0, QUOTE_CHARS);
  if (quote) {
    addCitation(citations, {
      documentId: document.id,
      filename: document.originalFilename,
      quote,
    });
  }
  return JSON.stringify({
    documentId: document.id,
    filename: document.originalFilename,
    documentType: document.documentType,
    provider: document.provider,
    documentDate: document.documentDate,
    status: document.status,
    aiSummary: document.aiSummary,
    excerpt,
  });
}

/**
 * Executes one tool call and returns the JSON string handed back to the model.
 * Citations produced along the way are appended to `citations`. Errors are
 * returned as { error } results (so the model can recover) — dispatch never
 * throws on bad input.
 */
export async function dispatchTool(
  db: Db,
  name: string,
  args: Record<string, unknown>,
  citations: ChatCitation[],
): Promise<string> {
  switch (name) {
    case "search_documents":
      return runSearchDocuments(db, args, citations);
    case "get_biomarker_trend":
      return runGetBiomarkerTrend(db, args, citations);
    case "get_daily_metrics":
      return runGetDailyMetrics(db, args);
    case "get_document":
      return runGetDocument(db, args, citations);
    default:
      return JSON.stringify({ error: `Unknown tool "${name}".` });
  }
}
