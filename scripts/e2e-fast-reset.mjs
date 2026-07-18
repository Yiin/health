// Surgical reset for the fast e2e path: drops the dedicated `health_e2e`
// database and removes the `health-e2e` MinIO bucket so the next
// `npm run e2e:fast` recreates both from scratch (its create-if-missing +
// migrate + ensureBucket steps). Use it when scripts/migrate.mjs — which is
// append-only — can no longer bring health_e2e forward, e.g. after a
// migration file was edited in place during development. The dev `health`
// database and `health` bucket are never touched: the two names below are
// hardcoded to the e2e-suffixed resources on purpose — never parameterize
// them.
//
//   npm run e2e:fast:reset

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Same .env pickup as scripts/e2e-fast.mjs: compose ports/credentials come
// from .env when the shell did not provide them. Existing env vars win.
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

const E2E_DATABASE = "health_e2e";
const E2E_BUCKET = "health-e2e";

function fail(message) {
  console.error(`[e2e:fast:reset] ${message}`);
  process.exit(1);
}

if (!MINIO_ROOT_USER || !MINIO_ROOT_PASSWORD) {
  fail(
    "MINIO_ROOT_USER / MINIO_ROOT_PASSWORD are not set — copy .env.example " +
      "to .env and fill them in (the dev compose minio needs them)",
  );
}

// ---------------------------------------------------------------------------
// Database: drop health_e2e (force terminates lingering worker/web sessions)
// ---------------------------------------------------------------------------

const { default: postgres } = await import("postgres");

const adminUrl = `postgres://postgres:${encodeURIComponent(
  POSTGRES_PASSWORD,
)}@localhost:${DB_PORT}/postgres`;

{
  // onnotice silences the "does not exist, skipping" NOTICE on repeat runs.
  const admin = postgres(adminUrl, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {},
  });
  try {
    const rows =
      await admin`select 1 from pg_database where datname = ${E2E_DATABASE}`;
    // `with (force)` needs Postgres 13+; the compose db is postgres:16.
    await admin.unsafe(
      `drop database if exists "${E2E_DATABASE}" with (force)`,
    );
    console.log(
      rows.length > 0
        ? `[e2e:fast:reset] dropped database ${E2E_DATABASE}`
        : `[e2e:fast:reset] database ${E2E_DATABASE} absent — nothing to drop`,
    );
  } catch (error) {
    fail(
      `could not drop ${E2E_DATABASE} on localhost:${DB_PORT} — is the dev ` +
        `compose db up? (docker compose up -d db)\n${error}`,
    );
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// MinIO: empty and remove the health-e2e bucket
// ---------------------------------------------------------------------------

const {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = await import("@aws-sdk/client-s3");

const s3 = new S3Client({
  endpoint: `http://127.0.0.1:${MINIO_PORT}`,
  region: "us-east-1",
  credentials: {
    accessKeyId: MINIO_ROOT_USER,
    secretAccessKey: MINIO_ROOT_PASSWORD,
  },
  // MinIO requires path-style addressing (<endpoint>/<bucket>/<key>).
  forcePathStyle: true,
});

try {
  let removed = 0;
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: E2E_BUCKET,
        ContinuationToken: token,
      }),
    );
    const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: E2E_BUCKET,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      removed += objects.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await s3.send(new DeleteBucketCommand({ Bucket: E2E_BUCKET }));
  console.log(
    `[e2e:fast:reset] removed bucket ${E2E_BUCKET} (${removed} object${
      removed === 1 ? "" : "s"
    })`,
  );
} catch (error) {
  if (error?.name === "NoSuchBucket") {
    console.log(
      `[e2e:fast:reset] bucket ${E2E_BUCKET} absent — nothing to remove`,
    );
  } else {
    fail(
      `could not remove bucket ${E2E_BUCKET} on 127.0.0.1:${MINIO_PORT} — ` +
        `is the dev compose minio up? (docker compose up -d minio)\n${error}`,
    );
  }
} finally {
  s3.destroy();
}

console.log(
  "[e2e:fast:reset] done — the next `npm run e2e:fast` recreates both",
);
