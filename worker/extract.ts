// The 'extracting' stage: dispatches on documents.document_type. v1 handles
// apple_health_export here (SAX-streamed onto daily_metrics/workouts — see
// worker/apple-health/); every other type passes through with a stub payload
// until its own extraction lands (lab reports: health-etv.16, which extends
// this dispatcher).
//
// Document-shaped outcomes map onto the stage executor's vocabulary: a
// permanent input problem comes back as a `halt` payload (needs_review), a
// successful parse as a plain payload cached in raw_extractions('extracting'),
// and transient failures (S3 drop, DB error) are thrown so the executor's
// retry machinery re-runs the stage — safe because the Apple Health writer is
// fully idempotent (upserts / insert-or-skip).
//
// Like worker/classify.ts this runs under plain node type stripping: relative
// imports carry explicit .ts extensions and DB access is raw postgres.js.

import type { Readable } from "node:stream";

import type postgres from "postgres";

import { getOriginalStream } from "../src/lib/storage.ts";
import { ingestAppleHealthExport } from "./apple-health/index.ts";
import type { StageRunner } from "./ingestion.ts";

export const EXTRACT_PARSER_VERSION = "extract-v1";

export type OpenOriginal = (s3Key: string) => Promise<Readable | null>;

export interface ExtractStageDeps {
  sql: postgres.Sql;
  /** Storage stream opener; injectable so tests never touch MinIO. */
  openOriginal?: OpenOriginal;
}

const defaultOpenOriginal: OpenOriginal = async (s3Key) => {
  const object = await getOriginalStream(s3Key);
  return object?.body ?? null;
};

interface DocumentTypeRow {
  document_type: string;
  s3_key: string;
}

/**
 * Builds the extracting stage runner. The runner reads the document's type
 * and storage key itself (StageContext carries neither), so it stays a drop-in
 * StageRunner for the executor.
 */
export function createExtractStage(deps: ExtractStageDeps): StageRunner {
  const openOriginal = deps.openOriginal ?? defaultOpenOriginal;
  return async (ctx) => {
    const rows = await deps.sql<DocumentTypeRow[]>`
      select document_type, s3_key from documents where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) throw new Error(`document ${ctx.documentId} not found`);

    if (document.document_type !== "apple_health_export") {
      // Not this dispatcher's type yet (lab_report lands with health-etv.16):
      // cache a stub payload so the stage completes and later stages proceed.
      return { stub: true, documentType: document.document_type };
    }

    const outcome = await ingestAppleHealthExport(
      deps.sql,
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
  };
}
