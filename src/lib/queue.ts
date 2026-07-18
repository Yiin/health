import { PgBoss } from "pg-boss";

/**
 * Shared pg-boss instance: background jobs live on the app Postgres (no
 * Redis). The web process enqueues `ingest` jobs here; the worker container
 * (worker/index.mjs) consumes them through this same module.
 */

export const INGEST_JOB = "ingest";

export interface IngestJobData {
  documentId: string;
}

/**
 * The slice of pg-boss's IDatabase adapter used by boss.send's `db` option:
 * when provided, the job insert executes on the caller's connection, so the
 * enqueue can share the transaction that inserts the documents row.
 */
export interface BossTx {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

// Cached on globalThis so Next.js dev hot-reloads reuse the one instance
// (module graphs are discarded on rebuild; the boss pool must not multiply).
const globalForBoss = globalThis as unknown as {
  __healthBoss?: Promise<PgBoss>;
};

async function startBoss(): Promise<PgBoss> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  const boss = new PgBoss({ connectionString });
  await boss.start();
  // Queues must exist before send; createQueue is idempotent
  // (INSERT ... ON CONFLICT DO NOTHING). The exclusive policy enforces the
  // singletonKey at insert time: a second send for the same sha256 is
  // suppressed (returns null) while any job for that content is still
  // created/retry/active; completed or failed jobs do not block re-sends.
  await boss.createQueue(INGEST_JOB, { policy: "exclusive" });
  return boss;
}

/** Lazily started process-wide boss. */
export function getBoss(): Promise<PgBoss> {
  globalForBoss.__healthBoss ??= startBoss();
  return globalForBoss.__healthBoss;
}

/** Graceful shutdown (worker SIGTERM handler, tests). */
export async function stopBoss(): Promise<void> {
  const started = globalForBoss.__healthBoss;
  globalForBoss.__healthBoss = undefined;
  if (started) {
    await (await started).stop();
  }
}

/**
 * Enqueues ingestion for a document, deduplicated by content: the
 * singletonKey=sha256 on the exclusive-policy queue suppresses a second job
 * while one for the same bytes is still pending or running. Retry policy per
 * the epic: 3 attempts with backoff (30s, doubling).
 *
 * Pass `db` (a BossTx bound to an open transaction — see
 * src/lib/uploads.ts's inTransaction) to make the enqueue atomic with the
 * documents-row insert. Returns the job id, or null when the singletonKey
 * dedup suppressed the insert.
 */
export async function enqueueIngest(
  document: { id: string; sha256: string },
  opts: { db?: BossTx } = {},
): Promise<string | null> {
  const boss = await getBoss();
  const data: IngestJobData = { documentId: document.id };
  return boss.send(INGEST_JOB, data, {
    singletonKey: document.sha256,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
    // 15 min per attempt (also pg-boss's default; stated explicitly so the
    // contract survives a default change). Sized for multi-minute Kimi
    // extractions once real stages land.
    expireInSeconds: 900,
    ...(opts.db ? { db: opts.db } : {}),
  });
}
