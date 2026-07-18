// The 'normalizing' stage for lab_report documents: reads the cached
// raw_extractions('extracting') payload, maps every as-reported analyte name
// onto the biomarkers catalog, and persists results via the biomarker-results
// repo (insertResults owns canonical-unit conversion and dedup).
//
// Mapping order (per name): exact alias match → fuzzy match → LLM fallback.
// Only LLM mappings are CONFIRMED write-backs: each mapped raw name is
// appended to biomarkers.aliases (lowercased, dedup-guarded), so each lab's
// phrasing is mapped once and deterministic thereafter. Names the LLM maps to
// null stay unmapped — recorded in the payload, never guessed into a row.
//
// The LLM fallback validates its reply and retries once with the error
// appended; a second validation failure THROWS (transient model garble), so
// pg-boss retries the job instead of quietly dropping analytes.
//
// Runs under plain node type stripping in the worker container: every
// relative import carries an explicit .ts extension; catalog access is raw
// postgres.js SQL, persistence goes through the drizzle repo.

import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

import {
  insertResults,
  type InsertResultsOutcome,
  type NewResultInput,
} from "../src/db/repos/biomarker-results.ts";
import * as schema from "../src/db/schema.ts";
import {
  matchBiomarker,
  type CatalogEntry,
} from "../src/lib/ingest/mapping.ts";
import {
  BIOMARKER_MAPPING_JSON_SCHEMA,
  labExtractionSchema,
  measuredOnOf,
  parseBiomarkerMapping,
  type BiomarkerMapping,
  type ExtractedBiomarker,
} from "../src/lib/ingest/schemas.ts";
import {
  chatStructured,
  KIMI_MODELS,
  type ChatStructuredParams,
} from "../src/lib/kimi/client.ts";
import type { StageRunner } from "./ingestion.ts";

/** Prompt version recorded in every raw_extractions('normalizing') payload. */
export const NORMALIZE_PROMPT_V1 = "lab-normalize-v1";

const MAPPING_SYSTEM_PROMPT = `You map as-reported laboratory analyte names onto a fixed biomarker catalog for a personal health dashboard. Names may be English or Lithuanian.

For each input name answer with the catalog slug of the SAME measurand — use the printed unit to disambiguate (a name reported in 10^9/L is a cell count, not a concentration; "%" differentials are not ratios). Answer null when no catalog entry is the same measurand — never guess.`;

export type InsertResultsFn = (
  rows: NewResultInput[],
) => Promise<InsertResultsOutcome>;

export interface NormalizeStageDeps {
  sql: postgres.Sql;
  /** Defaults to the real chatStructured (Kimi). */
  chatStructured?: (params: ChatStructuredParams) => Promise<string>;
  /** Defaults to KIMI_MODELS.chat. */
  model?: string;
  /** Defaults to the biomarker-results repo over a drizzle handle on sql. */
  insertResults?: InsertResultsFn;
}

interface CatalogRow {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
}

// drizzle's postgres-js driver MUTATES the pool it wraps: construct()
// replaces the pool's parsers/serializers for date/time OIDs and — fatally
// for us — the json/jsonb serializers (114/3802) with identity functions
// (drizzle encodes those types itself). On a shared pool that silently breaks
// every later sql.json() bind — including this executor's own
// raw_extractions insert right after the normalize stage. Snapshot the
// affected entries before wrapping and restore them immediately after; the
// repo queries we run (biomarker_results/biomarkers: text, numeric, uuid,
// date-as-string) map identically under the postgres.js defaults.
const DRIZZLE_HIJACKED_OIDS = [
  "1184",
  "1082",
  "1083",
  "1114",
  "1182",
  "1185",
  "1115",
  "1231",
  "114",
  "3802",
] as const;

interface PoolOptions {
  parsers: Record<string, ((value: never) => unknown) | undefined>;
  serializers: Record<string, ((value: never) => unknown) | undefined>;
}

export function drizzleWithoutHijack(sql: postgres.Sql) {
  const options = (sql as unknown as { options: PoolOptions }).options;
  const savedParsers = new Map(
    DRIZZLE_HIJACKED_OIDS.map((oid) => [oid, options.parsers[oid]] as const),
  );
  const savedSerializers = new Map(
    DRIZZLE_HIJACKED_OIDS.map(
      (oid) => [oid, options.serializers[oid]] as const,
    ),
  );
  const db = drizzle(sql, { schema });
  for (const oid of DRIZZLE_HIJACKED_OIDS) {
    const parser = savedParsers.get(oid);
    const serializer = savedSerializers.get(oid);
    if (parser === undefined) delete options.parsers[oid];
    else options.parsers[oid] = parser;
    if (serializer === undefined) delete options.serializers[oid];
    else options.serializers[oid] = serializer;
  }
  return db;
}

interface MatchedAnalyte {
  biomarker: ExtractedBiomarker;
  entry: CatalogEntry;
  via: "exact" | "fuzzy" | "llm";
}

/**
 * LLM mapping fallback: one chatStructured call for all unmatched names,
 * validated + one retry with the error appended. Throws after the second
 * validation failure (the job retries; a document is never failed into
 * needs_review over mapping garble).
 */
export async function mapWithKimi(
  chat: (params: ChatStructuredParams) => Promise<string>,
  model: string,
  unmatched: ExtractedBiomarker[],
  catalog: CatalogRow[],
): Promise<BiomarkerMapping> {
  const catalogLines = catalog
    .map((entry) => `- ${entry.slug}: ${entry.name}`)
    .join("\n");
  const namesList = unmatched
    .map((b) => `- "${b.name}" (unit: ${b.unit})`)
    .join("\n");
  const userMessage =
    `Catalog:\n${catalogLines}\n\n` +
    `Map these as-reported analyte names (answer every one, in the request's order):\n${namesList}`;

  const paramsFor = (message: string): ChatStructuredParams => ({
    schema: BIOMARKER_MAPPING_JSON_SCHEMA,
    model,
    messages: [
      { role: "system", content: MAPPING_SYSTEM_PROMPT },
      { role: "user", content: message },
    ],
  });

  const first = parseBiomarkerMapping(await chat(paramsFor(userMessage)));
  if (first.ok) return first.value;
  const retryMessage =
    `${userMessage}\n\n` +
    `Your previous reply failed validation: ${first.error}. ` +
    "Reply with corrected JSON only.";
  const second = parseBiomarkerMapping(await chat(paramsFor(retryMessage)));
  if (!second.ok) {
    throw new Error(
      `biomarker mapping failed validation twice (${first.error}; ${second.error})`,
    );
  }
  return second.value;
}

/** Lowercase alias for write-back; the catalog stores aliases lowercased. */
function aliasForWriteBack(rawName: string): string {
  return rawName.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Builds the normalizing stage runner. Injectable seams (chatStructured,
 * insertResults) keep unit tests free of Kimi; DB tests use the real repo.
 */
export function createNormalizeStage(deps: NormalizeStageDeps): StageRunner {
  const chat = deps.chatStructured ?? chatStructured;
  const model = deps.model ?? KIMI_MODELS.chat;
  const insert =
    deps.insertResults ??
    (() => {
      const db = drizzleWithoutHijack(deps.sql);
      return (rows: NewResultInput[]) => insertResults(db, rows);
    })();
  const { sql } = deps;

  return async (ctx) => {
    const rows = await sql<{ document_type: string }[]>`
      select document_type from documents where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) {
      throw new Error(`document ${ctx.documentId} vanished mid-normalize`);
    }

    if (document.document_type !== "lab_report") {
      return {
        skipped: true,
        documentType: document.document_type,
        reason: "normalize stage handles lab_report documents only",
      };
    }

    const cached = await sql<{ payload: { extraction?: unknown } | null }[]>`
      select payload from raw_extractions
      where document_id = ${ctx.documentId} and stage = 'extracting'
    `;
    const parsedExtraction = labExtractionSchema.safeParse(
      cached[0]?.payload?.extraction,
    );
    if (!parsedExtraction.success) {
      throw new Error(
        `document ${ctx.documentId}: raw_extractions('extracting') payload ` +
          "missing or invalid — the pipeline ran out of order?",
      );
    }
    const extraction = parsedExtraction.data;

    if (extraction.biomarkers.length === 0) {
      return {
        promptVersion: NORMALIZE_PROMPT_V1,
        total: 0,
        mappedExact: 0,
        mappedFuzzy: 0,
        mappedLlm: 0,
        unmapped: [],
        aliasWritebacks: [],
        inserted: 0,
        skipped: 0,
      };
    }

    const catalog = await sql<CatalogRow[]>`
      select id, slug, name, aliases from biomarkers
    `;
    const catalogBySlug = new Map(catalog.map((row) => [row.slug, row]));

    const matched: MatchedAnalyte[] = [];
    const unmatched: ExtractedBiomarker[] = [];
    for (const biomarker of extraction.biomarkers) {
      const match = matchBiomarker(biomarker.name, catalog);
      if (match) {
        matched.push({
          biomarker,
          entry: match.entry,
          via: match.via,
        });
      } else {
        unmatched.push(biomarker);
      }
    }

    const unmapped: string[] = [];
    const aliasWritebacks: { name: string; slug: string }[] = [];
    if (unmatched.length > 0) {
      const mapping = await mapWithKimi(chat, model, unmatched, catalog);
      const slugByName = new Map(mapping.mappings.map((m) => [m.name, m.slug]));
      for (const biomarker of unmatched) {
        const slug = slugByName.get(biomarker.name) ?? null;
        const entry = slug ? catalogBySlug.get(slug) : undefined;
        if (entry) {
          matched.push({ biomarker, entry, via: "llm" });
          aliasWritebacks.push({ name: biomarker.name, slug: entry.slug });
        } else {
          unmapped.push(biomarker.name);
        }
      }
    }

    // Confirmed LLM mappings are written back so each lab's phrasing is
    // mapped once and deterministic thereafter. Lowercased to match the
    // catalog convention; the WHERE guard keeps concurrent runs idempotent.
    for (const { name, slug } of aliasWritebacks) {
      const alias = aliasForWriteBack(name);
      await sql`
        update biomarkers
        set aliases = array_append(aliases, ${alias})
        where slug = ${slug} and not (${alias} = any(aliases))
      `;
    }

    const measuredOn = measuredOnOf(extraction);
    const labName = extraction.labName.trim() || null;
    const outcome = await insert(
      matched.map(({ biomarker, entry }) => ({
        biomarkerId: entry.id,
        measuredOn,
        value: biomarker.value,
        unit: biomarker.unit,
        refLow: biomarker.referenceLow ?? null,
        refHigh: biomarker.referenceHigh ?? null,
        refText: biomarker.referenceText ?? null,
        labName,
        flag: biomarker.flag ?? null,
        documentId: ctx.documentId,
      })),
    );

    return {
      promptVersion: NORMALIZE_PROMPT_V1,
      total: extraction.biomarkers.length,
      mappedExact: matched.filter((m) => m.via === "exact").length,
      mappedFuzzy: matched.filter((m) => m.via === "fuzzy").length,
      mappedLlm: matched.filter((m) => m.via === "llm").length,
      unmapped,
      aliasWritebacks,
      inserted: outcome.inserted,
      skipped: outcome.skipped,
    };
  };
}
