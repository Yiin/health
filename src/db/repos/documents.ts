// Repository for the documents table (ingestion state machine + FTS).
//
// Every function takes the db handle as its first argument instead of
// importing the singleton from src/db/index.ts: tests inject their own handle
// from src/db/test-utils.ts. The singleton's type is identical, so route
// handlers pass getDb() (or an in-transaction handle) directly.

import { desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "../schema";
import {
  documents,
  type Document,
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetches one document by id. A malformed (non-uuid) id yields undefined
 * rather than Postgres's "invalid input syntax for type uuid" error — the id
 * typically arrives as an arbitrary URL path param.
 */
export async function getDocument(
  db: Db,
  documentId: string,
): Promise<Document | undefined> {
  if (!UUID_PATTERN.test(documentId)) return undefined;
  const rows = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  return rows[0];
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

export interface DocumentSearchHit {
  id: string;
  filename: string;
  summary: string | null;
  snippet: string;
}

// The generated extracted_tsv column indexes exactly this text (see migration
// 0001_documents.sql); ts_headline must highlight over the same expression.
const SEARCHABLE_TEXT = sql`coalesce(${documents.extractedText}, '') || ' ' || coalesce(${documents.aiSummary}, '')`;

/**
 * Full-text search over extracted text + AI summaries, ranked by ts_rank.
 * The snippet is a ts_headline excerpt with matches wrapped in <b></b>.
 */
export async function searchDocuments(
  db: Db,
  query: string,
  limit = 20,
): Promise<DocumentSearchHit[]> {
  const tsQuery = sql`plainto_tsquery('english', ${query})`;
  const rows = await db
    .select({
      id: documents.id,
      filename: documents.originalFilename,
      summary: documents.aiSummary,
      snippet:
        sql<string>`ts_headline('english', ${SEARCHABLE_TEXT}, ${tsQuery})`.as(
          "snippet",
        ),
    })
    .from(documents)
    .where(sql`extracted_tsv @@ ${tsQuery}`)
    .orderBy(desc(sql`ts_rank(extracted_tsv, ${tsQuery})`))
    .limit(limit);
  return rows;
}
