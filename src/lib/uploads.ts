// Upload ingestion service.
//
// Request bytes are streamed to a temp file while being hashed (bounded
// memory even for 2 GiB files — the whole file is never buffered), stored
// under the content-addressed S3 key, and registered as a document whose
// ingest job is enqueued in the SAME transaction, so a document can never
// exist without its job.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";

import { getSqlClient, type Db } from "@/db";
import {
  getDocument,
  registerUpload,
  updateStatus,
} from "@/db/repos/documents";
import * as schema from "@/db/schema";
import type { Document } from "@/db/schema";
import { enqueueIngest, type BossTx } from "@/lib/queue";
import { putOriginal } from "@/lib/storage";

export const UPLOAD_MAX_BYTES_DEFAULT = 2 * 1024 ** 3; // 2 GiB

// Read at request time so tests can override via process.env.
export function maxUploadBytes(): number {
  const override = Number(process.env.UPLOAD_MAX_BYTES);
  return Number.isFinite(override) && override > 0
    ? override
    : UPLOAD_MAX_BYTES_DEFAULT;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${bytes / 1024 ** 3} GB`;
  if (bytes >= 1024 ** 2) return `${Math.ceil(bytes / 1024 ** 2)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

// Allowlist keyed by extension (client-sent MIME types are untrustworthy):
// lab PDFs, wearable CSVs, Apple Health export.xml, Takeout/Fit zips, medical
// document images, plain text/json.
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".json": "application/json",
};

/** Canonical content type for an allowed filename, or null when rejected. */
export function contentTypeForFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return null;
  return ALLOWED_UPLOAD_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

/**
 * Runs `fn` inside one Postgres transaction on the app pool, exposing a
 * drizzle handle (for repo functions) and a pg-boss adapter (for boss.send's
 * db option) bound to the same transaction.
 */
export async function inTransaction<T>(
  fn: (db: Db, bossTx: BossTx) => Promise<T>,
): Promise<T> {
  // postgres.js types begin() as Promise<UnwrapPromiseArray<T>>, which does
  // not reduce back to T for an arbitrary generic — the runtime value is T.
  return getSqlClient().begin(async (tx) => {
    // postgres.js's TransactionSql carries no .options of its own, but
    // drizzle's constructor mutates client.options.parsers — lend it the
    // outer pool's options (the mutation drizzle applies is idempotent and
    // identical to the one the lazy singleton performs).
    (tx as typeof tx & { options?: postgres.Sql["options"] }).options ??=
      getSqlClient().options;
    const txDb = drizzle(tx as unknown as postgres.Sql, { schema });
    const bossTx: BossTx = {
      executeSql: async (text, values) => ({
        rows: await tx.unsafe(text, values as never[]),
      }),
    };
    return fn(txDb, bossTx);
  }) as Promise<T>;
}

/** Temp dir holding one request's staged files; pair with removeStagingDir. */
export async function makeStagingDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "health-upload-"));
}

export async function removeStagingDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface StagedFile {
  tmpPath: string;
  sha256: string;
  sizeBytes: number;
}

/** Streams `source` to a temp file while computing its SHA-256. */
export async function stageFile(
  source: Readable,
  stagingDir: string,
): Promise<StagedFile> {
  const tmpPath = join(stagingDir, randomUUID());
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await pipeline(
    source,
    async function* (chunks) {
      for await (const chunk of chunks) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        sizeBytes += buffer.length;
        yield buffer;
      }
    },
    createWriteStream(tmpPath),
  );
  return { tmpPath, sha256: hash.digest("hex"), sizeBytes };
}

export async function discardStaged(tmpPath: string): Promise<void> {
  await rm(tmpPath, { force: true });
}

export interface RegisteredUpload {
  document: Document;
  isDuplicate: boolean;
  jobId: string | null;
}

/**
 * Stores the staged bytes at their content-addressed key, then registers the
 * document and enqueues its ingest job in one transaction. A duplicate
 * sha256 short-circuits: the existing document comes back with
 * isDuplicate=true and NO new job is sent.
 *
 * Accepted race: the S3 PUT precedes the transaction, so a failed insert can
 * orphan the object. The object is content-addressed and unreferenced, and a
 * later identical upload reuses it — harmless.
 */
export async function registerStagedUpload(
  staged: StagedFile,
  meta: { filename: string; contentType: string },
): Promise<RegisteredUpload> {
  const s3Key = await putOriginal(
    createReadStream(staged.tmpPath),
    staged.sha256,
    { contentType: meta.contentType },
  );
  return inTransaction(async (txDb, bossTx) => {
    const { document, isDuplicate } = await registerUpload(txDb, {
      sha256: staged.sha256,
      filename: meta.filename,
      contentType: meta.contentType,
      sizeBytes: staged.sizeBytes,
      s3Key,
    });
    const jobId = isDuplicate
      ? null
      : await enqueueIngest(document, { db: bossTx });
    return { document, isDuplicate, jobId };
  });
}

export type RetryOutcome =
  | { kind: "not_found" }
  | { kind: "not_retryable"; document: Document }
  | { kind: "retried"; document: Document; jobId: string | null };

/**
 * Resets a failed/needs_review document to `uploaded` (clearing stage_error,
 * preserving attempts) and re-enqueues its ingest job — atomically, same as
 * the upload path. Any other status is not retryable.
 */
export async function resetDocumentForRetry(
  documentId: string,
): Promise<RetryOutcome> {
  return inTransaction(async (txDb, bossTx) => {
    const document = await getDocument(txDb, documentId);
    if (!document) return { kind: "not_found" };
    if (document.status !== "failed" && document.status !== "needs_review") {
      return { kind: "not_retryable", document };
    }
    const reset = await updateStatus(txDb, documentId, "uploaded", null);
    if (!reset) return { kind: "not_found" };
    const jobId = await enqueueIngest(reset, { db: bossTx });
    return { kind: "retried", document: reset, jobId };
  });
}
