import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

/**
 * S3/MinIO object storage for original document bytes.
 *
 * Objects are content-addressed under `originals/<yyyy>/<mm>/<sha256[:2]>/<sha256>`,
 * so dedup is structural: `putOriginal` HEADs the key first and skips the PUT
 * when the object already exists. (The HEAD/PUT pair is not atomic — two
 * concurrent uploads of the same content may both PUT — but writing identical
 * bytes to the same key is idempotent, so the race is harmless.)
 *
 * v1 decision: NO browser-presigned URLs. MinIO sits on a Docker-internal
 * hostname unreachable from a tailnet browser, so all uploads and downloads
 * proxy through Next.js route handlers with streaming — never buffer a whole
 * file in memory. Per-file cap is 2 GB (enforced by the upload route); Google
 * Takeout exports must be split into <=2 GB parts at export time.
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function getStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): StorageConfig {
  const missing: string[] = [];
  if (!env.S3_ENDPOINT) missing.push("S3_ENDPOINT");
  if (!env.S3_BUCKET) missing.push("S3_BUCKET");
  if (!env.S3_ACCESS_KEY_ID) missing.push("S3_ACCESS_KEY_ID");
  if (!env.S3_SECRET_ACCESS_KEY) missing.push("S3_SECRET_ACCESS_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing required S3 environment variables: ${missing.join(", ")}. ` +
        "Set them in .env (see .env.example).",
    );
  }
  return {
    endpoint: env.S3_ENDPOINT as string,
    region: env.S3_REGION ?? "us-east-1",
    bucket: env.S3_BUCKET as string,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
  };
}

let cached: { client: S3Client; config: StorageConfig } | undefined;

function getClient(): { client: S3Client; config: StorageConfig } {
  if (!cached) {
    const config = getStorageConfig();
    cached = {
      config,
      client: new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // MinIO requires path-style addressing (<endpoint>/<bucket>/<key>).
        forcePathStyle: true,
        // Default WHEN_SUPPORTED adds a CRC32 trailer that requires a known
        // content length, which breaks unknown-length streaming uploads
        // (uploads are streamed, never buffered). WHEN_REQUIRED restores
        // plain aws-chunked transfer encoding.
        requestChecksumCalculation: "WHEN_REQUIRED",
      }),
    };
  }
  return cached;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: string }).name;
  if (name === "NotFound" || name === "NoSuchKey" || name === "NoSuchBucket") {
    return true;
  }
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
  return status === 404;
}

/** Key layout: originals/<yyyy>/<mm>/<sha256[:2]>/<sha256> (UTC date fanout). */
export function originalKeyFor(
  sha256: string,
  date: Date = new Date(),
): string {
  const sha = sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error(`Invalid SHA-256 hex digest: ${JSON.stringify(sha256)}`);
  }
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `originals/${yyyy}/${mm}/${sha.slice(0, 2)}/${sha}`;
}

/** Idempotently create the configured bucket (setup/tests; bucket-init owns prod). */
export async function ensureBucket(): Promise<void> {
  const { client, config } = getClient();
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: config.bucket,
        // us-east-1 is the default region and must not be passed as a constraint.
        ...(config.region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: config.region as BucketLocationConstraint,
              },
            }),
      }),
    );
  } catch (err) {
    // A concurrent ensureBucket (e.g. parallel test suites) may win the
    // HeadBucket/CreateBucket race — the bucket exists and is ours, done.
    if ((err as { name?: string }).name !== "BucketAlreadyOwnedByYou") {
      throw err;
    }
  }
}

export async function objectExists(s3Key: string): Promise<boolean> {
  const { client, config } = getClient();
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: config.bucket, Key: s3Key }),
    );
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/**
 * Store an original at its content-addressed key and return the key.
 * If the object already exists (same sha256), the upload is skipped and the
 * existing key is returned — structural dedup.
 *
 * Bodies may be unknown-length streams (uploads are piped, never buffered):
 * lib-storage Upload reads them in bounded part-size chunks, falling back to
 * a single PutObject when the whole body fits in one part.
 */
export async function putOriginal(
  body: Readable | Buffer | Uint8Array,
  sha256: string,
  opts: { contentType?: string; date?: Date } = {},
): Promise<string> {
  const key = originalKeyFor(sha256, opts.date);
  if (await objectExists(key)) return key;
  const { client, config } = getClient();
  await new Upload({
    client,
    params: {
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ...(opts.contentType ? { ContentType: opts.contentType } : {}),
    },
  }).done();
  return key;
}

export interface OriginalObject {
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
}

export interface OriginalRange {
  bytes: Uint8Array;
  /** Total object size, parsed from the Content-Range response header. */
  totalSize: number | null;
}

function parseContentRangeTotal(contentRange: string | undefined): number | null {
  const match = /\/(\d+)$/.exec(contentRange ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * Read a byte range of an original: `start` inclusive, `end` exclusive (open
 * when omitted); a NEGATIVE `start` reads the last |start| bytes (S3 suffix
 * range). The range is fully buffered, so callers must keep ranges small
 * (magic-byte probes, zip central directories). Returns null when the key
 * does not exist or the range is unsatisfiable (e.g. an empty object).
 */
export async function getOriginalRange(
  s3Key: string,
  start: number,
  end?: number,
): Promise<OriginalRange | null> {
  const range =
    start < 0 ? `bytes=${start}` : `bytes=${start}-${end === undefined ? "" : end - 1}`;
  const { client, config } = getClient();
  try {
    const out = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: s3Key, Range: range }),
    );
    if (!out.Body) return null;
    const bytes = await (
      out.Body as unknown as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    return { bytes, totalSize: parseContentRangeTotal(out.ContentRange) };
  } catch (err) {
    if (isNotFound(err) || (err as { name?: string }).name === "InvalidRange") {
      return null;
    }
    throw err;
  }
}

/** Stream an original, or null when the key does not exist. Never buffers. */
export async function getOriginalStream(
  s3Key: string,
): Promise<OriginalObject | null> {
  const { client, config } = getClient();
  try {
    const out = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: s3Key }),
    );
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType,
      contentLength: out.ContentLength,
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * Buffer a whole original into memory, or null when the key does not exist.
 * Only for objects the caller has already size-checked (pipeline stages read
 * documents.size_bytes first); `maxBytes` is the backstop — an object larger
 * than the cap makes this throw rather than buffer unboundedly.
 */
export async function getOriginalBytes(
  s3Key: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const object = await getOriginalStream(s3Key);
  if (!object) return null;
  if (object.contentLength !== undefined && object.contentLength > maxBytes) {
    object.body.destroy();
    throw new Error(
      `original ${s3Key} is ${object.contentLength} bytes, above the ${maxBytes}-byte cap`,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of object.body) {
    const bytes = chunk as Uint8Array;
    total += bytes.length;
    if (total > maxBytes) {
      object.body.destroy();
      throw new Error(
        `original ${s3Key} exceeds the ${maxBytes}-byte cap while buffering`,
      );
    }
    chunks.push(bytes);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
