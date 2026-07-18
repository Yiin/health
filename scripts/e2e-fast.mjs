// Host-run fast e2e: runs the UNCHANGED scripts/e2e-pipeline.mjs against
// host-spawned web (next dev), worker, and kimi-mock processes, with only the
// dev compose db and minio as dependencies. Zero image builds — this is the
// code-change inner loop; `npm run e2e:image` (docker) stays the deploy
// validation path.
//
//   npm run e2e:fast
//
// Isolation from a running dev stack: a dedicated `health_e2e` database on
// the same dev Postgres and a dedicated `health-e2e` MinIO bucket, so the dev
// `health` database and `health` bucket are never touched. Ports are
// non-default (web 3105, kimi-mock 9701) so a dev server on 3000 keeps
// working during a run.
//
// Run with --experimental-strip-types (the npm script does): this file
// imports src/lib/storage.ts for ensureBucket().

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Mirror drizzle-kit's convenience: pick up compose ports/credentials from
// .env when the shell did not provide them (precedent:
// scripts/seed-biomarkers.mjs). Existing env vars win.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  // no .env file — fine, the values may come from the environment
}

const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? "postgres";
const DB_PORT = process.env.DB_PORT ?? "5433";
const MINIO_PORT = process.env.MINIO_PORT ?? "9000";
const MINIO_ROOT_USER = process.env.MINIO_ROOT_USER;
const MINIO_ROOT_PASSWORD = process.env.MINIO_ROOT_PASSWORD;

const WEB_PORT = 3105;
const KIMI_PORT = 9701;
const FIXTURES_DIR = path.join(ROOT, "fixtures", "health-docs");

const E2E_DB_URL = `postgres://postgres:${encodeURIComponent(
  POSTGRES_PASSWORD,
)}@localhost:${DB_PORT}/health_e2e`;

function fail(message) {
  console.error(`[e2e:fast] ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await probe()) return;
    } catch {
      // keep waiting
    }
    if (Date.now() > deadline) {
      throw new Error(`[e2e:fast] timed out waiting for ${label}`);
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Preflight — every failure is actionable, not a mid-run assertion mystery
// ---------------------------------------------------------------------------

for (const pkg of ["pg-boss", "postgres"]) {
  if (!existsSync(path.join(ROOT, "node_modules", pkg))) {
    fail(`node_modules/${pkg} is missing — run npm ci first`);
  }
}

for (const binary of ["pdfinfo", "pdftoppm"]) {
  if (spawnSync(binary, ["-v"]).error?.code === "ENOENT") {
    fail(
      `${binary} not found on PATH — poppler-utils is required for the ` +
        "vision-path fixtures (worker/vision.ts rasterizes scanned PDFs)",
    );
  }
}

if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
  fail(
    "MINIO_ROOT_USER / MINIO_ROOT_PASSWORD are not set — copy .env.example " +
      "to .env and fill them in (the dev compose minio needs them)",
  );
}

console.log("[e2e:fast] bringing up dev compose db + minio");
const composeUp = spawnSync("docker", ["compose", "up", "-d", "db", "minio"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (composeUp.status !== 0) {
  fail("docker compose up -d db minio failed (is the docker daemon running?)");
}

// node_modules preflight passed, so this import is safe now.
const { default: postgres } = await import("postgres");

const adminUrl = `postgres://postgres:${encodeURIComponent(
  POSTGRES_PASSWORD,
)}@localhost:${DB_PORT}/postgres`;

await waitFor(
  `postgres on localhost:${DB_PORT}`,
  async () => {
    const admin = postgres(adminUrl, { max: 1, connect_timeout: 2 });
    try {
      await admin`select 1`;
      return true;
    } finally {
      await admin.end();
    }
  },
  30_000,
);

await waitFor(
  `minio on 127.0.0.1:${MINIO_PORT}`,
  async () => {
    const response = await fetch(
      `http://127.0.0.1:${MINIO_PORT}/minio/health/live`,
    );
    return response.ok;
  },
  30_000,
);

// ---------------------------------------------------------------------------
// Isolation: dedicated health_e2e database + health-e2e bucket
// ---------------------------------------------------------------------------

// Replicates src/db/test-utils.ts createDatabaseIfMissing + quoteIdentifier.
{
  const admin = postgres(adminUrl, { max: 1 });
  try {
    const rows =
      await admin`select 1 from pg_database where datname = 'health_e2e'`;
    if (rows.length === 0) {
      await admin.unsafe(`create database "health_e2e"`);
      console.log("[e2e:fast] created database health_e2e");
    }
  } finally {
    await admin.end();
  }
}

const S3_ENV = {
  S3_ENDPOINT: `http://127.0.0.1:${MINIO_PORT}`,
  S3_BUCKET: "health-e2e",
  S3_ACCESS_KEY_ID: MINIO_ROOT_USER,
  S3_SECRET_ACCESS_KEY: MINIO_ROOT_PASSWORD,
};
Object.assign(process.env, S3_ENV);
const { ensureBucket } = await import("../src/lib/storage.ts");
await ensureBucket();
console.log("[e2e:fast] bucket health-e2e ready");

// Migrate once BEFORE spawning children — the advisory lock inside
// scripts/migrate.mjs makes this safe against any concurrent migrator.
{
  const migrate = spawnSync("node", ["scripts/migrate.mjs"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: E2E_DB_URL },
  });
  if (migrate.status !== 0) {
    fail(`migration failed with status ${migrate.status}`);
  }
}

// ---------------------------------------------------------------------------
// Children: kimi-mock, next dev, worker — then the assertion script
// ---------------------------------------------------------------------------

const MOONSHOT_ENV = {
  MOONSHOT_BASE_URL: `http://127.0.0.1:${KIMI_PORT}/v1`,
  MOONSHOT_API_KEY: "e2e-mock",
};

const children = [];
let tearingDown = false;

function prefix(stream, tag) {
  readline
    .createInterface({ input: stream })
    .on("line", (line) => console.log(`${tag} ${line}`));
}

/**
 * Spawns a long-lived service in its own process group (detached) so
 * teardown can kill the whole group — next dev forks a server process that
 * would otherwise survive the parent.
 */
function spawnService(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefix(child.stdout, `[${name}]`);
  prefix(child.stderr, `[${name}]`);
  child.exited = new Promise((resolve) => child.on("exit", resolve));
  child.on("exit", (code) => {
    if (!tearingDown) {
      console.error(`[e2e:fast] ${name} exited early with code ${code}`);
      teardown(1);
    }
  });
  children.push(child);
  return child;
}

async function teardown(exitCode) {
  if (tearingDown) return;
  tearingDown = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  // The worker shuts down gracefully on SIGTERM (worker/index.mjs); give the
  // group 10s, then force-kill whatever is left.
  await Promise.race([Promise.all(children.map((c) => c.exited)), sleep(10_000)]);
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => teardown(130));
process.on("SIGTERM", () => teardown(143));
process.on("uncaughtException", (error) => {
  console.error("[e2e:fast] fatal:", error);
  teardown(1);
});

spawnService("kimi-mock", "node", ["scripts/kimi-mock.mjs"], {
  PORT: String(KIMI_PORT),
  // Must be absolute: the mock does await import(`${FIXTURES_DIR}/content.mjs`).
  FIXTURES_DIR,
});

spawnService("web", "npx", ["next", "dev", "-p", String(WEB_PORT)], {
  DATABASE_URL: E2E_DB_URL,
  ...S3_ENV,
  ...MOONSHOT_ENV,
  // Retry options are set at SEND time by the web process (src/lib/queue.ts).
  INGEST_RETRY_DELAY_S: "1",
  BASIC_AUTH_USER: "",
  BASIC_AUTH_PASS: "",
});

spawnService(
  "worker",
  "node",
  ["--experimental-strip-types", "worker/index.mjs"],
  {
    DATABASE_URL: E2E_DB_URL,
    ...S3_ENV,
    ...MOONSHOT_ENV,
    INGEST_RETRY_DELAY_S: "1",
    // No-op until the polling-interval knob lands in worker main(); harmless.
    INGEST_POLL_INTERVAL_S: "0.5",
  },
);

// The pipeline script's own readiness waits absorb the next-dev cold compile,
// and its boot-time truncate makes re-runs deterministic — run it unchanged.
console.log("[e2e:fast] running scripts/e2e-pipeline.mjs");
const e2e = spawn("node", ["scripts/e2e-pipeline.mjs"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    WEB_URL: `http://127.0.0.1:${WEB_PORT}`,
    KIMI_MOCK_URL: `http://127.0.0.1:${KIMI_PORT}`,
    DATABASE_URL: E2E_DB_URL,
    FIXTURES_DIR,
  },
});
e2e.on("exit", (code, signal) => {
  console.log(`[e2e:fast] e2e finished with ${signal ?? `code ${code}`}`);
  teardown(code ?? 1);
});
