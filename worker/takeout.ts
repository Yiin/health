// Google Takeout archive fan-out (the 'extracting' stage for
// takeout_archive documents) and the parent barrier (the 'normalizing'
// stage).
//
// Fan-out: the zip is streamed from S3 to a per-run scratch directory (the
// whole archive is NEVER buffered in RAM), then walked via unzipper's
// central-directory reader, which pulls each entry from the scratch file on
// demand. Relevant inner files become child documents (parent_document_id
// set, deduped by the content hash of the inner bytes), are uploaded to S3
// at their content-addressed key, and get one 'ingest' job each. Takeout
// structure varies by export era, so relevance is decided by folder name +
// CSV header signature, never by filename alone: CSVs under a known health
// folder are in, CSVs under a known noise folder (Photos etc.) are out, and
// CSVs anywhere else must match a wearable parser plugin's header
// signature. .json sidecars are skipped — no plugin consumes them.
//
// Everything the fan-out writes is idempotent, because a stage retry
// re-runs it from scratch (the payload is only cached on success):
// putOriginal dedups content-addressed, the documents insert is
// on-conflict-do-nothing, and the enqueue's singletonKey suppresses
// duplicate jobs.
//
// Barrier: parks the parent (StagePendingError — see worker/ingestion.ts)
// until every child is terminal; a failed child does NOT fail the parent.
// Children finishing re-drive the barrier via completeParentIfChildrenTerminal.
//
// Like worker/ingestion.ts this runs under plain node type stripping in the
// worker container: every relative import carries an explicit .ts extension
// and DB access is raw postgres.js SQL.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type postgres from "postgres";
import * as unzipper from "unzipper";

import { enqueueIngest } from "../src/lib/queue.ts";
import {
  getOriginalStream,
  putOriginal as putOriginalDefault,
} from "../src/lib/storage.ts";
import { StagePendingError, type StageRunner } from "./ingestion.ts";
import { sniffCsvHeaders } from "./wearable/csv.ts";
import { detectWearablePlugin } from "./wearable/index.ts";
import type { WearablePlugin } from "./wearable/plugins.ts";

// Terminal statuses; mirrors TERMINAL_STATUSES in worker/ingestion.ts (that
// set is module-private and the worker graph stays free of the drizzle
// repos, so the literal list is repeated here).
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "needs_review",
  "ignored",
]);

/**
 * Takeout product folders that never hold health data (any path segment,
 * case-insensitive). Deliberately short: a folder absent from BOTH lists
 * falls through to the header-signature check, which is the era-proof path.
 */
export const TAKEOUT_NOISE_FOLDERS: ReadonlySet<string> = new Set([
  "photos",
  "youtube",
  "drive",
  "mail",
  "gmail",
  "keep",
  "calendar",
  "chrome",
  "maps",
  "location history",
  "timeline",
  "hangouts",
  "contacts",
]);

/** Folders whose CSVs are health data regardless of header shape. */
export const TAKEOUT_HEALTH_FOLDERS: ReadonlySet<string> = new Set([
  "fit",
  "google fit",
]);

export type TakeoutEntryVerdict =
  | { kind: "relevant"; via: "health_folder" | "header_signature" }
  | { kind: "skipped"; reason: string }
  // CSV outside any known folder — only the header row can decide.
  | { kind: "undecided" };

function folderSegments(entryPath: string): string[] {
  return entryPath
    .split("/")
    .slice(0, -1)
    .map((segment) => segment.trim().toLowerCase());
}

function extensionOf(entryPath: string): string {
  const name = entryPath.slice(entryPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Pure relevance decision for one zip entry. `headers` is the CSV header row
 * and only resolves the "undecided" case (CSV outside known folders);
 * callers pass null first and sniff headers lazily only when asked.
 */
export function classifyTakeoutEntry(
  entryPath: string,
  headers: string[] | null,
  plugins?: readonly WearablePlugin[],
): TakeoutEntryVerdict {
  const extension = extensionOf(entryPath);
  if (extension === "json") {
    return { kind: "skipped", reason: "json sidecar (no plugin consumes it)" };
  }
  if (extension !== "csv") {
    return {
      kind: "skipped",
      reason: `not a CSV entry (.${extension || "?"})`,
    };
  }

  const folders = folderSegments(entryPath);
  const noise = folders.find((segment) => TAKEOUT_NOISE_FOLDERS.has(segment));
  if (noise !== undefined) {
    return { kind: "skipped", reason: `noise folder '${noise}'` };
  }
  const health = folders.find((segment) => TAKEOUT_HEALTH_FOLDERS.has(segment));
  if (health !== undefined) {
    return { kind: "relevant", via: "health_folder" };
  }

  // Unknown folder: the era-proof path — a wearable plugin's header
  // signature must claim the file.
  if (headers === null) return { kind: "undecided" };
  const name = entryPath.slice(entryPath.lastIndexOf("/") + 1);
  if (detectWearablePlugin(name, headers, plugins)) {
    return { kind: "relevant", via: "header_signature" };
  }
  return { kind: "skipped", reason: "no wearable header signature match" };
}

interface TakeoutDocumentRow {
  s3_key: string;
}

export interface TakeoutStageDeps {
  sql: postgres.Sql;
  /** Defaults to src/lib/storage getOriginalStream (body only). */
  openStream?: (s3Key: string) => Promise<Readable | null>;
  /** Defaults to src/lib/storage putOriginal. */
  putOriginal?: (
    body: Readable,
    sha256: string,
    opts?: { contentType?: string },
  ) => Promise<string>;
  /** Defaults to src/lib/queue enqueueIngest. */
  enqueue?: (document: { id: string; sha256: string }) => Promise<unknown>;
  /** Parent directory for the per-run scratch dir; defaults to os.tmpdir(). */
  scratchRoot?: string;
  /** Wearable plugins for the header-signature path (tests may narrow). */
  plugins?: readonly WearablePlugin[];
}

// A type alias (not an interface) so records stay assignable to
// postgres.JSONValue's index-signature object shape.
type ChildRecord = {
  documentId: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  duplicate: boolean;
};

async function hashEntry(
  entry: unzipper.File,
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of entry.stream()) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

/**
 * The fan-out stage. Per-entry stream failures (a corrupt zip member) skip
 * just that entry; database errors propagate as transient failures the
 * ingestion executor retries — the re-run is idempotent.
 */
export function createTakeoutExtractStage(deps: TakeoutStageDeps): StageRunner {
  const { sql } = deps;
  const openStream =
    deps.openStream ??
    (async (s3Key: string) => (await getOriginalStream(s3Key))?.body ?? null);
  const put = deps.putOriginal ?? putOriginalDefault;
  const enqueue = deps.enqueue ?? enqueueIngest;
  const scratchRoot = deps.scratchRoot ?? tmpdir();

  return async (ctx) => {
    const rows = await sql<TakeoutDocumentRow[]>`
      select s3_key from documents where id = ${ctx.documentId}
    `;
    const document = rows[0];
    if (!document) {
      throw new Error(`document ${ctx.documentId} vanished mid-takeout`);
    }

    const scratch = await mkdtemp(join(scratchRoot, "health-takeout-"));
    try {
      const archivePath = join(scratch, "archive.zip");
      const source = await openStream(document.s3_key);
      if (!source) {
        throw new Error(`original ${document.s3_key} not found in storage`);
      }
      await pipeline(source, createWriteStream(archivePath));

      const directory = await unzipper.Open.file(archivePath);

      const summary = {
        files: 0,
        relevant: 0,
        childrenCreated: 0,
        duplicates: 0,
        skipped: 0,
      };
      const children: ChildRecord[] = [];
      const skipped: Array<{ path: string; reason: string }> = [];

      for (const entry of directory.files) {
        if (entry.type === "Directory") continue;
        summary.files += 1;

        // Header signatures are only needed for CSVs outside known folders;
        // sniff lazily so decided entries are never decompressed twice.
        let verdict = classifyTakeoutEntry(entry.path, null, deps.plugins);
        if (verdict.kind === "undecided") {
          let headers: string[];
          try {
            headers = await sniffCsvHeaders(entry.stream());
          } catch (error) {
            skipped.push({
              path: entry.path,
              reason: `header read failed: ${message(error)}`,
            });
            summary.skipped += 1;
            continue;
          }
          verdict = classifyTakeoutEntry(entry.path, headers, deps.plugins);
        }
        if (verdict.kind !== "relevant") {
          const reason =
            verdict.kind === "skipped" ? verdict.reason : "not relevant";
          skipped.push({ path: entry.path, reason });
          summary.skipped += 1;
          continue;
        }
        summary.relevant += 1;

        // Stream the entry twice (hash, then upload): unzipper reads both
        // passes from the scratch file, so memory stays bounded.
        let hashed: { sha256: string; sizeBytes: number };
        let s3Key: string;
        try {
          hashed = await hashEntry(entry);
          s3Key = await put(entry.stream(), hashed.sha256, {
            contentType: "text/csv",
          });
        } catch (error) {
          // A corrupt zip member fails the ENTRY, never the whole fan-out.
          skipped.push({
            path: entry.path,
            reason: `entry stream failed: ${message(error)}`,
          });
          summary.skipped += 1;
          continue;
        }

        const inserted = await sql<{ id: string }[]>`
          insert into documents
            (sha256, original_filename, content_type, size_bytes, s3_key,
             parent_document_id)
          values (
            ${hashed.sha256}, ${entry.path}, 'text/csv', ${hashed.sizeBytes},
            ${s3Key}, ${ctx.documentId}
          )
          on conflict (sha256) do nothing
          returning id
        `;
        if (inserted[0]) {
          await enqueue({ id: inserted[0].id, sha256: hashed.sha256 });
          children.push({
            documentId: inserted[0].id,
            path: entry.path,
            sha256: hashed.sha256,
            sizeBytes: hashed.sizeBytes,
            duplicate: false,
          });
          summary.childrenCreated += 1;
          continue;
        }

        // Content already registered: no duplicate row. If the existing row
        // is OUR child still waiting for its job (an earlier fan-out died
        // between insert and enqueue), re-enqueue — the singletonKey dedup
        // makes the repeat send harmless.
        const existing = await sql<
          { id: string; status: string; parent_document_id: string | null }[]
        >`
          select id, status, parent_document_id
          from documents where sha256 = ${hashed.sha256}
        `;
        const row = existing[0];
        if (
          row &&
          row.parent_document_id === ctx.documentId &&
          row.status === "uploaded"
        ) {
          await enqueue({ id: row.id, sha256: hashed.sha256 });
        }
        if (row) {
          children.push({
            documentId: row.id,
            path: entry.path,
            sha256: hashed.sha256,
            sizeBytes: hashed.sizeBytes,
            duplicate: true,
          });
        }
        summary.duplicates += 1;
      }

      return { archive: summary, children, skipped } as postgres.JSONValue;
    } finally {
      // Scratch cleanup is guaranteed even when the stage throws.
      await rm(scratch, { recursive: true, force: true });
    }
  };
}

/**
 * The barrier stage: parks the parent until every child is terminal, then
 * caches a small tally and lets the pipeline land the parent in done. A zip
 * with no relevant entries has zero children and passes immediately.
 */
export function createTakeoutBarrierStage(deps: {
  sql: postgres.Sql;
}): StageRunner {
  const { sql } = deps;
  return async (ctx) => {
    const children = await sql<{ id: string; status: string }[]>`
      select id, status from documents
      where parent_document_id = ${ctx.documentId}
    `;
    const pending = children.filter(
      (child) => !TERMINAL_STATUSES.has(child.status),
    );
    if (pending.length > 0) {
      throw new StagePendingError(
        `${pending.length} of ${children.length} child documents still ingesting`,
      );
    }
    const statuses: Record<string, number> = {};
    for (const child of children) {
      statuses[child.status] = (statuses[child.status] ?? 0) + 1;
    }
    return { children: children.length, statuses } as postgres.JSONValue;
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
