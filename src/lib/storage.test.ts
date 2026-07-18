import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { beforeAll, describe, expect, it } from "vitest";

import { setupMinioTestEnv } from "./minio-test-utils";
import {
  ensureBucket,
  getOriginalStream,
  getStorageConfig,
  objectExists,
  originalKeyFor,
  putOriginal,
} from "./storage";

describe("getStorageConfig", () => {
  it("throws a clear error naming every missing var", () => {
    expect(() => getStorageConfig({})).toThrow(
      "Missing required S3 environment variables: S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY",
    );
  });

  it("names only the missing vars", () => {
    expect(() =>
      getStorageConfig({ S3_ENDPOINT: "http://x", S3_BUCKET: "b" }),
    ).toThrow("S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  });

  it("defaults the region to us-east-1", () => {
    const config = getStorageConfig({
      S3_ENDPOINT: "http://127.0.0.1:9000",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(config.region).toBe("us-east-1");
  });
});

describe("originalKeyFor", () => {
  const sha = "ab".repeat(32);

  it("builds the content-addressed key with a UTC date fanout", () => {
    expect(originalKeyFor(sha, new Date("2026-07-18T12:00:00Z"))).toBe(
      `originals/2026/07/ab/${sha}`,
    );
  });

  it("lowercases the digest", () => {
    expect(
      originalKeyFor(sha.toUpperCase(), new Date("2026-01-05T00:00:00Z")),
    ).toBe(`originals/2026/01/ab/${sha}`);
  });

  it("rejects non-SHA-256 digests", () => {
    expect(() => originalKeyFor("deadbeef")).toThrow("Invalid SHA-256");
  });
});

const env = setupMinioTestEnv();

describe.skipIf(!env)("storage against compose MinIO", () => {
  beforeAll(async () => {
    await ensureBucket();
    // Idempotent: a second call must not throw.
    await ensureBucket();
  }, 30_000);

  async function readAll(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  // Buffer.equals (memcmp) — vitest's toEqual deep-compares Buffers per byte,
  // which takes seconds on MiB-sized payloads.
  async function expectRoundTrip(
    s3Key: string,
    payload: Buffer,
  ): Promise<void> {
    const object = await getOriginalStream(s3Key);
    expect(object).not.toBeNull();
    const bytes = await readAll(object!.body);
    expect(bytes.equals(payload)).toBe(true);
  }

  it("round-trips bytes: put -> exists -> stream", async () => {
    const payload = randomBytes(256 * 1024);
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const key = await putOriginal(
      Readable.from([payload.subarray(0, 100_000), payload.subarray(100_000)]),
      sha256,
      {
        contentType: "application/pdf",
      },
    );
    expect(key).toMatch(
      new RegExp(`^originals/\\d{4}/\\d{2}/${sha256.slice(0, 2)}/${sha256}$`),
    );

    await expect(objectExists(key)).resolves.toBe(true);
    await expect(
      objectExists(`originals/1999/01/zz/${"0".repeat(64)}`),
    ).resolves.toBe(false);

    const object = await getOriginalStream(key);
    expect(object).not.toBeNull();
    expect(object!.contentType).toBe("application/pdf");
    expect(object!.contentLength).toBe(payload.length);
    await expectRoundTrip(key, payload);
  });

  it("returns null when streaming a missing key", async () => {
    await expect(
      getOriginalStream(`originals/1999/01/00/${"f".repeat(64)}`),
    ).resolves.toBeNull();
  });

  it("duplicate put returns the same key without error and keeps the first bytes", async () => {
    const payload = Buffer.from("duplicate me");
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const first = await putOriginal(payload, sha256);
    const again = await putOriginal(
      Buffer.from("different bytes, same claimed sha"),
      sha256,
    );
    expect(again).toBe(first);

    await expectRoundTrip(first, payload);
  });

  it("accepts plain Buffers", async () => {
    const payload = Buffer.from("buffer upload");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const key = await putOriginal(payload, sha256);
    await expectRoundTrip(key, payload);
  });

  it("multipart-uploads streams larger than one part (5 MiB)", async () => {
    const chunk = randomBytes(1024 * 1024);
    const chunks = Array.from({ length: 6 }, () => chunk);
    const payload = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(payload).digest("hex");

    const key = await putOriginal(Readable.from(chunks), sha256);
    const object = await getOriginalStream(key);
    expect(object!.contentLength).toBe(payload.length);
    await expectRoundTrip(key, payload);
  });
});
