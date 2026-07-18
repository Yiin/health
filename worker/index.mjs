// Ingestion worker entrypoint: subscribes to the pg-boss `ingest` queue and
// walks each document through the pipeline (see worker/ingestion.ts for the
// stage executor and its resume semantics).
//
// Plain .mjs (like scripts/migrate.mjs) so tsc/Next ignore it; node loads the
// .ts executor via type stripping (compose runs
// `node --experimental-strip-types worker/index.mjs`; default-on from node
// 22.18). Tests import startWorker() below instead of spawning a process.

import { pathToFileURL } from "node:url";

import { PgBoss } from "pg-boss";
import postgres from "postgres";

import {
  INGESTION_STAGES,
  MAX_JOB_EXECUTIONS,
  runIngestion,
  stubStages,
} from "./ingestion.ts";
import { createClassifyStage } from "./classify.ts";
import { createExtractStage } from "./extract.ts";
import { createNormalizeStage } from "./normalize.ts";
import { createSummarizeStage } from "./summarize.ts";
import {
  createTakeoutBarrierStage,
  createTakeoutExtractStage,
} from "./takeout.ts";

// Same queue the web enqueue side uses (src/lib/queue.ts); duplicated here
// because node type stripping cannot resolve that module's import graph.
export const INGEST_QUEUE = "ingest";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 60_000;

// pg-boss rejects pollingIntervalSeconds below 0.5 (its attorney assertion
// throws), so env values under the floor clamp up instead of crashing boot.
const MIN_POLL_INTERVAL_S = 0.5;

/**
 * Test-only pickup knob: INGEST_POLL_INTERVAL_S tunes how often pg-boss
 * polls the ingest queue. Unset, non-numeric, or <= 0 → undefined, keeping
 * pg-boss's default (2s). Production compose never sets it.
 */
export function pollIntervalFromEnv(env = process.env) {
  const parsed = Number(env.INGEST_POLL_INTERVAL_S);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.max(parsed, MIN_POLL_INTERVAL_S);
}

/**
 * Test-only parallelism knob: INGEST_WORKER_CONCURRENCY spawns that many
 * independent pg-boss workers for the one work() subscription, each fetching
 * and processing one job at a time. Unset, non-integer, or < 2 → undefined,
 * keeping pg-boss's default single worker. Production compose never sets it.
 *
 * Concurrent execution is safe: runIngestion is per-document, and the only
 * cross-document coordination is the takeout parent barrier — an atomic
 * guarded UPDATE (completeParentIfChildrenTerminal, worker/ingestion.ts).
 * The exclusive queue policy dedups by sha256 at insert (src/lib/queue.ts),
 * so two workers never run the same content concurrently, and
 * boss.stop({ graceful: true }) waits for every active job, not just one.
 */
export function workerConcurrencyFromEnv(env = process.env) {
  const parsed = Number(env.INGEST_WORKER_CONCURRENCY);
  if (!Number.isInteger(parsed) || parsed < 2) return undefined;
  return parsed;
}

/**
 * Stage dispatch by document_type: the takeout_archive stages (fan-out and
 * parent barrier) only apply to that type; every other type falls through
 * to the fallback runner (which itself dispatches or stubs by type).
 */
function dispatchByType(sql, handlers, fallback) {
  return async (ctx) => {
    const rows = await sql`
      select document_type from documents where id = ${ctx.documentId}
    `;
    const handler = rows[0] ? handlers[rows[0].document_type] : undefined;
    return (handler ?? fallback)(ctx);
  };
}

/**
 * Production stage runners: the real classifying stage (deterministic
 * sniffing + Kimi fallback, worker/classify.ts), the Takeout fan-out +
 * parent barrier for takeout_archive documents (worker/takeout.ts), the
 * extracting dispatcher for every other type (worker/extract.ts —
 * lab_report and apple_health_export today, more types landing with their
 * own issues), the real normalizing stage for lab_report documents
 * (worker/normalize.ts — other types fall through to it and get its
 * skipped-stub), and the summarizing stage (ai_summary + post-ingestion
 * insight, worker/summarize.ts). Built per-worker because the stages close
 * over the sql pool.
 */
export function defaultStages(sql) {
  return {
    ...stubStages,
    classifying: createClassifyStage({ sql }),
    extracting: dispatchByType(
      sql,
      { takeout_archive: createTakeoutExtractStage({ sql }) },
      createExtractStage({ sql }),
    ),
    normalizing: dispatchByType(
      sql,
      { takeout_archive: createTakeoutBarrierStage({ sql }) },
      createNormalizeStage({ sql }),
    ),
    summarizing: createSummarizeStage({ sql }),
  };
}

/**
 * Boots pg-boss + a postgres.js pool and subscribes to the ingest queue.
 * Returns handles plus stop(): graceful shutdown — stop fetching, let the
 * active job finish (pg-boss waits up to shutdownTimeoutMs, then fails the
 * still-active job so it retries elsewhere and aborts its signal).
 */
export async function startWorker(options = {}) {
  const {
    databaseUrl = process.env.DATABASE_URL,
    stages,
    pollingIntervalSeconds = pollIntervalFromEnv(),
    localConcurrency = workerConcurrencyFromEnv(),
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    log = console,
  } = options;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const boss = new PgBoss({ connectionString: databaseUrl });
  boss.on("error", (error) => log.error("[worker] pg-boss error:", error));
  await boss.start();
  // Idempotent (INSERT ... ON CONFLICT DO NOTHING) and mirrors the web side:
  // the exclusive policy enforces singletonKey (sha256) dedup at insert time.
  await boss.createQueue(INGEST_QUEUE, { policy: "exclusive" });

  const sql = postgres(databaseUrl);
  const stageRunners = stages ?? defaultStages(sql);

  await boss.work(
    INGEST_QUEUE,
    {
      // includeMetadata so the handler sees retryCount for attempt counting.
      includeMetadata: true,
      // Retry jobs are only ever discovered by polling, and notify polling
      // idles at 30s once a queue has NOTIFY enabled — both knobs must move
      // together or retries lag behind fresh jobs.
      ...(pollingIntervalSeconds
        ? {
            pollingIntervalSeconds,
            notifyPollingIntervalSeconds: pollingIntervalSeconds,
          }
        : {}),
      ...(localConcurrency ? { localConcurrency } : {}),
    },
    // pg-boss v12 always hands the handler an array (batchSize 1 → one job).
    async (jobs) => {
      for (const job of jobs) {
        const attempt = job.retryCount + 1;
        const documentId = job.data?.documentId;
        if (!documentId) {
          throw new Error(`ingest job ${job.id} has no documentId in its data`);
        }
        log.log(
          `[worker] ingest ${documentId} — execution ${attempt}/${MAX_JOB_EXECUTIONS} (job ${job.id})`,
        );
        const outcome = await runIngestion(sql, documentId, {
          stages: stageRunners,
          attempt,
          signal: job.signal,
        });
        switch (outcome.kind) {
          case "done":
            log.log(`[worker] ${documentId} done`);
            break;
          case "failed":
            log.error(
              `[worker] ${documentId} failed at stage "${outcome.stage}" on execution ${attempt}: ${outcome.message}`,
            );
            break;
          case "halted":
            log.log(
              `[worker] ${documentId} halted at stage "${outcome.stage}" → status "${outcome.status}"`,
            );
            break;
          case "pending":
            log.log(
              `[worker] ${documentId} parked at stage "${outcome.stage}": ${outcome.message}`,
            );
            break;
          case "skipped":
            log.log(
              `[worker] ${documentId} skipped — status "${outcome.status}" is terminal`,
            );
            break;
          case "missing":
            log.error(`[worker] ${documentId} not found — deleted mid-flight?`);
            break;
        }
      }
    },
  );

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await boss.stop({ graceful: true, timeout: shutdownTimeoutMs });
    await sql.end();
  }

  return { boss, sql, stop };
}

async function main() {
  const worker = await startWorker();
  console.log(
    `[worker] subscribed to '${INGEST_QUEUE}' — stages: ${INGESTION_STAGES.join(" → ")}`,
  );

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) {
      process.exit(1); // second signal: don't wait for the graceful path
    }
    shuttingDown = true;
    console.log(
      `[worker] ${signal} received — stop fetching, finish the current job`,
    );
    worker.stop().then(
      () => {
        console.log("[worker] shutdown complete");
        process.exit(0);
      },
      (error) => {
        console.error("[worker] shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error("[worker] fatal:", error);
    process.exit(1);
  });
}
