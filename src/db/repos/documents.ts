// Repository for the documents table (ingestion state machine + FTS).
//
// Every function takes the db handle as its first argument instead of
// importing the singleton from src/db/index.ts: the singleton throws at
// import time when DATABASE_URL is unset, and tests inject their own handle
// from src/db/test-utils.ts. The singleton's type is identical, so route
// handlers can pass `db` directly.

import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { effectiveMetadata } from "../../lib/document-metadata";
import * as schema from "../schema";
import {
  documents,
  type Document,
  type DocumentMetadataOverrides,
  type DocumentStatus,
  type DocumentStageError,
  type DocumentType,
} from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

export interface RegisterUploadInput {
  sha256: string;
  filename: string;
  contentType?: string;
  sizeBytes?: number;
  s3Key: string;
}

/**
 * Registers a freshly uploaded file. Content-addressed: when a document with
 * the same sha256 already exists, the existing row is returned with
 * `isDuplicate: true` and NO new row is created — callers must not enqueue a
 * new ingestion job (or re-upload to S3) for duplicates.
 */
export async function registerUpload(
  db: Db,
  input: RegisterUploadInput,
): Promise<{ document: Document; isDuplicate: boolean }> {
  const inserted = await db
    .insert(documents)
    .values({
      sha256: input.sha256,
      originalFilename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      s3Key: input.s3Key,
    })
    .onConflictDoNothing({ target: documents.sha256 })
    .returning();

  if (inserted[0]) {
    return { document: inserted[0], isDuplicate: false };
  }

  const existing = await db
    .select()
    .from(documents)
    .where(eq(documents.sha256, input.sha256))
    .limit(1);
  if (!existing[0]) {
    // Only reachable if the row was deleted between the two statements.
    throw new Error(
      `registerUpload: conflict on sha256 ${input.sha256} but no existing row`,
    );
  }
  return { document: existing[0], isDuplicate: true };
}

/**
 * Moves a document through the ingestion state machine. `stageError` is only
 * touched when explicitly passed (pass null to clear a previous error).
 */
export async function updateStatus(
  db: Db,
  documentId: string,
  status: DocumentStatus,
  stageError?: DocumentStageError | null,
): Promise<Document | undefined> {
  const updated = await db
    .update(documents)
    .set({
      status,
      ...(stageError !== undefined ? { stageError } : {}),
    })
    .where(eq(documents.id, documentId))
    .returning();
  return updated[0];
}

export interface UpdateExtractionInput {
  documentType?: DocumentType;
  provider?: string | null;
  documentDate?: string | null;
  aiSummary?: string | null;
  extractedText?: string | null;
  classificationConfidence?: number | null;
}

/** Persists the output of the classification/extraction stages. */
export async function updateExtraction(
  db: Db,
  documentId: string,
  input: UpdateExtractionInput,
): Promise<Document | undefined> {
  const updated = await db
    .update(documents)
    .set({
      ...(input.documentType !== undefined
        ? { documentType: input.documentType }
        : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.documentDate !== undefined
        ? { documentDate: input.documentDate }
        : {}),
      ...(input.aiSummary !== undefined ? { aiSummary: input.aiSummary } : {}),
      ...(input.extractedText !== undefined
        ? { extractedText: input.extractedText }
        : {}),
      ...(input.classificationConfidence !== undefined
        ? { classificationConfidence: input.classificationConfidence }
        : {}),
    })
    .where(eq(documents.id, documentId))
    .returning();
  return updated[0];
}

export interface DocumentListItem {
  id: string;
  filename: string;
  status: DocumentStatus;
  documentType: DocumentType;
  provider: string | null;
  documentDate: string | null;
  summary: string | null;
  uploadedAt: Date;
  edited: boolean;
}

function toListItem(document: Document): DocumentListItem {
  const metadata = effectiveMetadata(document);
  return {
    id: document.id,
    filename: document.originalFilename,
    status: document.status,
    documentType: metadata.documentType,
    provider: metadata.provider,
    documentDate: metadata.documentDate,
    summary: document.aiSummary,
    uploadedAt: document.uploadedAt,
    edited: metadata.edited,
  };
}

// Effective (override-aware) document_type. A null type override is not
// meaningful (the edit form always submits a concrete type), so plain
// coalesce is enough. NOTE: overrides are stored with their TypeScript
// (camelCase) key names, hence ->>'documentType'.
const EFFECTIVE_TYPE = sql`coalesce(${documents.metadataOverrides}->>'documentType', ${documents.documentType})`;
// Effective provider. The jsonb `?` operator checks key presence, so an
// explicit null override (the user cleared the provider) still wins over the
// extracted value.
const EFFECTIVE_PROVIDER = sql`case when ${documents.metadataOverrides} ? 'provider' then ${documents.metadataOverrides}->>'provider' else ${documents.provider} end`;

export interface DocumentListFilter {
  type?: DocumentType;
  provider?: string;
  limit?: number;
  offset?: number;
}

function filterConditions(filter: DocumentListFilter) {
  return [
    filter.type ? sql`${EFFECTIVE_TYPE} = ${filter.type}` : undefined,
    filter.provider
      ? sql`${EFFECTIVE_PROVIDER} = ${filter.provider}`
      : undefined,
  ];
}

/**
 * Library listing for /documents, newest upload first. Type/provider filters
 * match the effective (override-aware) values the cards display.
 */
export async function listDocuments(
  db: Db,
  filter: DocumentListFilter = {},
): Promise<DocumentListItem[]> {
  const rows = await db
    .select()
    .from(documents)
    .where(and(...filterConditions(filter)))
    .orderBy(desc(documents.uploadedAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
  return rows.map(toListItem);
}

/** Full row for the detail page. */
export async function getDocument(
  db: Db,
  documentId: string,
): Promise<Document | undefined> {
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return rows[0];
}

/**
 * Merges user edits into metadata_overrides (jsonb `||`: only the keys
 * present in `overrides` are touched) and returns the updated row. Overrides
 * live apart from the extracted columns, so pipeline re-runs never clobber
 * manual edits.
 */
export async function updateMetadataOverrides(
  db: Db,
  documentId: string,
  overrides: DocumentMetadataOverrides,
): Promise<Document | undefined> {
  const updated = await db
    .update(documents)
    .set({
      metadataOverrides: sql`coalesce(${documents.metadataOverrides}, '{}'::jsonb) || ${JSON.stringify(overrides)}::jsonb`,
    })
    .where(eq(documents.id, documentId))
    .returning();
  return updated[0];
}

/** Distinct effective providers, for the filter dropdown. */
export async function listDocumentProviders(db: Db): Promise<string[]> {
  const rows = await db.execute(
    sql`select distinct ${EFFECTIVE_PROVIDER} as provider from documents
        where ${EFFECTIVE_PROVIDER} is not null order by 1`,
  );
  return rows.map((row) => row.provider as string);
}

export interface DocumentBiomarker {
  slug: string;
  name: string;
  canonicalUnit: string;
  measuredOn: string;
  value: number;
  unit: string;
  valueCanonical: number | null;
  flag: string | null;
}

function isUndefinedTable(error: unknown): boolean {
  const { code, cause } = (error ?? {}) as {
    code?: string;
    cause?: { code?: string };
  };
  // drizzle wraps driver errors, so the Postgres code may be on .cause.
  return code === "42P01" || cause?.code === "42P01";
}

/**
 * Biomarker results extracted from a document (detail page). The biomarkers /
 * biomarker_results tables are owned by the labs-domain issue and land
 * independently; until they exist this returns [] (42P01) so the page still
 * renders.
 */
export async function listDocumentBiomarkers(
  db: Db,
  documentId: string,
): Promise<DocumentBiomarker[]> {
  try {
    const rows = await db.execute(sql`
      select b.slug, b.name, b.canonical_unit, r.measured_on::text as measured_on,
             r.value::float8 as value, r.unit,
             r.value_canonical::float8 as value_canonical, r.flag
      from biomarker_results r
      join biomarkers b on b.id = r.biomarker_id
      where r.document_id = ${documentId}
      order by b.name`);
    return rows.map((row) => ({
      slug: row.slug as string,
      name: row.name as string,
      canonicalUnit: row.canonical_unit as string,
      measuredOn: row.measured_on as string,
      value: row.value as number,
      unit: row.unit as string,
      valueCanonical: row.value_canonical as number | null,
      flag: row.flag as string | null,
    }));
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}

// The generated extracted_tsv column indexes exactly this text (see migration
// 0001_documents.sql); ts_headline must highlight over the same expression.
const SEARCHABLE_TEXT = sql`coalesce(${documents.extractedText}, '') || ' ' || coalesce(${documents.aiSummary}, '')`;

export interface DocumentSearchHit extends DocumentListItem {
  snippet: string;
}

/**
 * Full-text search over extracted text + AI summaries, ranked by ts_rank.
 * The snippet is a ts_headline excerpt with matches wrapped in <b></b>.
 * Type/provider filters behave as in listDocuments.
 */
export async function searchDocuments(
  db: Db,
  query: string,
  options: DocumentListFilter = {},
): Promise<DocumentSearchHit[]> {
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const rows = await db
    .select({
      document: documents,
      snippet:
        sql<string>`ts_headline('english', ${SEARCHABLE_TEXT}, ${tsQuery})`.as(
          "snippet",
        ),
    })
    .from(documents)
    .where(and(sql`extracted_tsv @@ ${tsQuery}`, ...filterConditions(options)))
    .orderBy(desc(sql`ts_rank(extracted_tsv, ${tsQuery})`))
    .limit(options.limit ?? 20)
    .offset(options.offset ?? 0);
  return rows.map(({ document, snippet }) => ({
    ...toListItem(document),
    snippet,
  }));
}
