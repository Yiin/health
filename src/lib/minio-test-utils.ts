import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Shared setup for vitest integration tests that run against the compose
 * MinIO. Reads the repo-root .env (compose's own source of truth) for MinIO
 * credentials, points the storage module at the host-published port, and
 * uses a dedicated bucket so parallel workers never fight over objects.
 *
 * Returns null when no credentials are available (fresh clone, CI) — callers
 * should gate suites with `describe.skipIf(!env)` so `npm test` stays green
 * without compose services.
 */

// Suffixed per the worker collision rules: compose MinIO may be shared.
export const MINIO_TEST_BUCKET =
  process.env.MINIO_TEST_BUCKET ?? "health-test-w4";

export interface MinioTestEnv {
  endpoint: string;
  bucket: string;
}

function loadDotEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(".env", "utf8"));
  } catch {
    return {};
  }
}

export function setupMinioTestEnv(): MinioTestEnv | null {
  const file = loadDotEnv();
  const pick = (key: string): string | undefined =>
    process.env[key] ?? file[key];

  const accessKeyId = pick("S3_ACCESS_KEY_ID") ?? pick("MINIO_ROOT_USER");
  const secretAccessKey =
    pick("S3_SECRET_ACCESS_KEY") ?? pick("MINIO_ROOT_PASSWORD");
  if (!accessKeyId || !secretAccessKey) return null;

  // A real S3_ENDPOINT env var wins; the .env value (http://minio:9000) is a
  // Docker-internal hostname, so from the host we derive the loopback URL
  // from the published port instead.
  const endpoint =
    process.env.S3_ENDPOINT ??
    `http://127.0.0.1:${pick("MINIO_PORT") ?? "9000"}`;

  process.env.S3_ENDPOINT = endpoint;
  process.env.S3_BUCKET = MINIO_TEST_BUCKET;
  process.env.S3_ACCESS_KEY_ID = accessKeyId;
  process.env.S3_SECRET_ACCESS_KEY = secretAccessKey;

  return { endpoint, bucket: MINIO_TEST_BUCKET };
}
