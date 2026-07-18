// Google Takeout fan-out + parent barrier tests.
//
// The fixture Takeout zip is BUILT here (no binary fixture committed): a
// minimal spec-conformant zip — deflate via node:zlib, CRC32 by table — so
// the walk exercises real decompression. Storage and the queue are injected
// fakes (an in-memory object map and a call recorder); the database is real
// (compose Postgres), because the child rows, the sha256 dedup and the
// parent-completion barrier are all SQL semantics.
//
// DB plumbing mirrors worker/ingestion.test.ts: setupTestDb() migrates and
// truncates, and the suites use their own postgres.js client.

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTestDb, TEST_DATABASE_URL } from "../src/db/test-utils";
import { originalKeyFor } from "../src/lib/storage";

import {
  MAX_ATTEMPTS,
  runIngestion,
  stubStages,
  type IngestionStage,
  type StageRunner,
} from "./ingestion";
import {
  classifyTakeoutEntry,
  createTakeoutBarrierStage,
  createTakeoutExtractStage,
} from "./takeout";

setupTestDb();

let sql: postgres.Sql;
beforeAll(async () => {
  sql = postgres(TEST_DATABASE_URL, { max: 2 });
});
afterAll(async () => {
  await sql.end();
});

const FIXTURES = fileURLToPath(new URL("./wearable/fixtures", import.meta.url));

// ---------------------------------------------------------------------------
// Minimal zip writer (store for directories, deflate for files)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntryInput {
  name: string;
  /** Uncompressed content; empty for directories. */
  data: Buffer;
  directory?: boolean;
  /**
   * Replaces the deflated payload verbatim (with a bogus CRC) to model a
   * zip member whose compressed stream is corrupt.
   */
  rawCompressed?: Buffer;
}

function buildZip(entries: ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const path =
      entry.directory && !entry.name.endsWith("/")
        ? `${entry.name}/`
        : entry.name;
    const nameBytes = Buffer.from(path, "utf8");
    const method = entry.directory ? 0 : 8;
    const compressed = entry.directory
      ? Buffer.alloc(0)
      : (entry.rawCompressed ?? deflateRawSync(entry.data));
    const crc = entry.rawCompressed ? 0 : crc32(entry.data);
    const size = entry.directory ? 0 : entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // central directory header
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42); // local header offset
    central.push(record, nameBytes);

    offset += 30 + nameBytes.length + compressed.length;
  }

  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, eocd]);
}

// ---------------------------------------------------------------------------
// Fixture Takeout archive
// ---------------------------------------------------------------------------

const GOOGLE_FIT_CSV = readFileSync(
  join(FIXTURES, "google-fit-daily-activity-metrics.csv"),
);
const OURA_CSV = readFileSync(join(FIXTURES, "oura-sleep.csv"));
// Content-level garbage (valid zip member): becomes a child and fails its
// own pipeline later.
const CORRUPT_CSV = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xde, 0xad, 0xbe,
  0xef, 0x00, 0x01,
]);
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

const FIT_ENTRY =
  "Takeout/Fit/Daily activity metrics/Daily activity metrics.csv";
const CORRUPT_ENTRY = "Takeout/Fit/corrupt.csv";
const TRUNCATED_ENTRY = "Takeout/Fit/truncated.csv";
const JSON_ENTRY = "Takeout/Fit/Daily activity metrics/data.json";
const PHOTO_ENTRY = "Takeout/Photos/IMG_0001.jpg";
const PHOTOS_CSV_ENTRY = "Takeout/Photos/measurements.csv";
const OURA_ENTRY = "Takeout/Wellness/oura-export.csv";

/** Fit folder + Photos noise + one corrupt CSV + era-variance wrinkles. */
function buildFixtureTakeoutZip(): Buffer {
  return buildZip([
    { name: "Takeout", data: Buffer.alloc(0), directory: true },
    { name: "Takeout/Fit", data: Buffer.alloc(0), directory: true },
    {
      name: "Takeout/Fit/Daily activity metrics",
      data: Buffer.alloc(0),
      directory: true,
    },
    { name: FIT_ENTRY, data: GOOGLE_FIT_CSV },
    { name: CORRUPT_ENTRY, data: CORRUPT_CSV },
    // A zip member whose compressed stream is broken: skipped, never fatal.
    {
      name: TRUNCATED_ENTRY,
      data: Buffer.from("Date,Steps\n2026-07-01,1000\n"),
      rawCompressed: Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]),
    },
    { name: JSON_ENTRY, data: Buffer.from('{"steps": 1000}\n') },
    { name: "Takeout/Photos", data: Buffer.alloc(0), directory: true },
    { name: PHOTO_ENTRY, data: FAKE_JPEG },
    // Wearable-shaped headers under a noise folder: the folder wins.
    { name: PHOTOS_CSV_ENTRY, data: GOOGLE_FIT_CSV },
    // Unknown folder (era variance): only the header signature claims it.
    { name: OURA_ENTRY, data: OURA_CSV },
  ]);
}

// ---------------------------------------------------------------------------
// Fakes + helpers
// ---------------------------------------------------------------------------

function createFakeStorage() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    openStream: async (s3Key: string): Promise<Readable | null> => {
      const bytes = objects.get(s3Key);
      return bytes ? Readable.from([bytes]) : null;
    },
    putOriginal: async (body: Readable, sha256: string): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(chunk as Buffer);
      }
      const key = originalKeyFor(sha256, new Date("2026-07-18T00:00:00Z"));
      objects.set(key, Buffer.concat(chunks));
      return key;
    },
  };
}

interface EnqueueCall {
  id: string;
  sha256: string;
}

function createFakeEnqueue() {
  const calls: EnqueueCall[] = [];
  return {
    calls,
    enqueue: async (document: EnqueueCall): Promise<string> => {
      calls.push(document);
      return `job-${calls.length}`;
    },
  };
}

interface ChildRow {
  id: string;
  sha256: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  s3_key: string;
  parent_document_id: string;
  document_type: string;
  status: string;
}

async function insertParentDocument(
  zip: Buffer,
  s3Key: string,
): Promise<string> {
  const sha256 = createHash("sha256").update(zip).digest("hex");
  const rows = await sql<{ id: string }[]>`
    insert into documents
      (sha256, original_filename, content_type, size_bytes, s3_key,
       document_type, status)
    values (
      ${sha256}, 'takeout-2026-07-18.zip', 'application/zip', ${zip.length},
      ${s3Key}, 'takeout_archive', 'uploaded'
    )
    returning id
  `;
  return rows[0].id;
}

async function documentStatus(id: string): Promise<string> {
  const rows = await sql<{ status: string }[]>`
    select status from documents where id = ${id}
  `;
  return rows[0].status;
}

async function parentExtractionStages(id: string): Promise<string[]> {
  const rows = await sql<{ stage: string }[]>`
    select stage from raw_extractions where document_id = ${id} order by stage
  `;
  return rows.map((row) => row.stage);
}

function takeoutStages(
  storage: ReturnType<typeof createFakeStorage>,
  enqueue: ReturnType<typeof createFakeEnqueue>["enqueue"],
  scratchRoot: string,
): Record<IngestionStage, StageRunner> {
  return {
    classifying: async () => ({ docType: "takeout_archive", source: "test" }),
    extracting: createTakeoutExtractStage({
      sql,
      openStream: storage.openStream,
      putOriginal: storage.putOriginal,
      enqueue,
      scratchRoot,
    }),
    normalizing: createTakeoutBarrierStage({ sql }),
  };
}

// ---------------------------------------------------------------------------
// Acceptance: fixture zip → children → independent ingestion → parent done
// ---------------------------------------------------------------------------

describe("takeout fan-out + barrier (acceptance)", () => {
  let scratchRoot: string;
  beforeAll(async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), "health-takeout-test-"));
  });
  afterAll(async () => {
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("yields child documents only for health data, ingests each independently, and lands the parent done", async () => {
    const storage = createFakeStorage();
    const { calls: enqueued, enqueue } = createFakeEnqueue();
    const zip = buildFixtureTakeoutZip();
    const parentS3Key = "originals/2026/07/aa/takeout.zip";
    storage.objects.set(parentS3Key, zip);
    const parentId = await insertParentDocument(zip, parentS3Key);

    // --- Parent run: classifies, fans out, parks at the barrier. ---
    const parentOutcome = await runIngestion(sql, parentId, {
      stages: takeoutStages(storage, enqueue, scratchRoot),
    });
    expect(parentOutcome).toEqual({
      kind: "pending",
      stage: "normalizing",
      message: "3 of 3 child documents still ingesting",
    });
    expect(await documentStatus(parentId)).toBe("normalizing");

    // --- Child rows: exactly the three health-data CSVs. ---
    const children = await sql<ChildRow[]>`
      select id, sha256, original_filename, content_type,
             size_bytes::float8 as size_bytes, s3_key,
             parent_document_id, document_type, status
      from documents
      where parent_document_id = ${parentId}
      order by original_filename
    `;
    const childPaths = children.map((child) => child.original_filename);
    expect(childPaths).toEqual([CORRUPT_ENTRY, FIT_ENTRY, OURA_ENTRY].sort());
    for (const child of children) {
      expect(child.parent_document_id).toBe(parentId);
      expect(child.status).toBe("uploaded");
      expect(child.document_type).toBe("unknown"); // its own pipeline classifies
      expect(child.content_type).toBe("text/csv");
    }

    // Bytes landed in storage at the content-addressed key, hash-verified.
    const contentByPath = new Map<string, Buffer>([
      [FIT_ENTRY, GOOGLE_FIT_CSV],
      [CORRUPT_ENTRY, CORRUPT_CSV],
      [OURA_ENTRY, OURA_CSV],
    ]);
    for (const child of children) {
      const expected = contentByPath.get(child.original_filename);
      if (!expected) throw new Error("unexpected child");
      expect(child.sha256).toBe(
        createHash("sha256").update(expected).digest("hex"),
      );
      expect(child.size_bytes).toBe(expected.length);
      expect(storage.objects.get(child.s3_key)?.equals(expected)).toBe(true);
    }

    // One ingest job per child.
    expect(enqueued).toHaveLength(3);
    expect(new Set(enqueued.map((call) => call.id))).toEqual(
      new Set(children.map((child) => child.id)),
    );

    // Fan-out payload tells the whole story, skips included.
    const extracting = await sql<{ payload: postgres.JSONValue }[]>`
      select payload from raw_extractions
      where document_id = ${parentId} and stage = 'extracting'
    `;
    const payload = extracting[0].payload as {
      archive: Record<string, number>;
      skipped: Array<{ path: string; reason: string }>;
    };
    expect(payload.archive).toEqual({
      files: 7,
      // The stream-broken truncated.csv IS relevant (Fit folder) but lands
      // in skipped instead of becoming a child.
      relevant: 4,
      childrenCreated: 3,
      duplicates: 0,
      skipped: 4,
    });
    const skipReason = Object.fromEntries(
      payload.skipped.map((skip) => [skip.path, skip.reason]),
    );
    expect(skipReason[TRUNCATED_ENTRY]).toMatch("entry stream failed");
    expect(skipReason[JSON_ENTRY]).toMatch("json sidecar");
    expect(skipReason[PHOTO_ENTRY]).toMatch("not a CSV");
    expect(skipReason[PHOTOS_CSV_ENTRY]).toMatch("noise folder 'photos'");

    // --- No scratch files remain after the run. ---
    expect(await readdir(scratchRoot)).toEqual([]);

    // --- Each child is ingested independently; the corrupt one fails. ---
    const byPath = new Map(
      children.map((child) => [child.original_filename, child]),
    );
    const fitChild = byPath.get(FIT_ENTRY);
    const corruptChild = byPath.get(CORRUPT_ENTRY);
    const ouraChild = byPath.get(OURA_ENTRY);
    if (!fitChild || !corruptChild || !ouraChild) {
      throw new Error("missing child rows");
    }

    expect(
      await runIngestion(sql, fitChild.id, { stages: stubStages }),
    ).toEqual({
      kind: "done",
    });
    expect(await documentStatus(parentId)).toBe("normalizing");

    // The corrupt child burns its attempts and lands failed...
    const corruptStages: Record<IngestionStage, StageRunner> = {
      ...stubStages,
      classifying: async () => {
        throw new Error("not a readable CSV");
      },
    };
    expect(
      await runIngestion(sql, corruptChild.id, {
        stages: corruptStages,
        attempt: MAX_ATTEMPTS,
      }),
    ).toMatchObject({ kind: "failed", stage: "classifying" });
    // ...which does NOT fail (or complete) the parent.
    expect(await documentStatus(parentId)).toBe("normalizing");

    // The last child turning terminal completes the parent.
    expect(
      await runIngestion(sql, ouraChild.id, { stages: stubStages }),
    ).toEqual({
      kind: "done",
    });
    expect(await documentStatus(parentId)).toBe("done");
    expect(await parentExtractionStages(parentId)).toEqual([
      "classifying",
      "extracting",
      "normalizing",
    ]);
  });

  it("completes immediately when the archive has no relevant entries", async () => {
    const storage = createFakeStorage();
    const { calls: enqueued, enqueue } = createFakeEnqueue();
    const zip = buildZip([
      { name: "Takeout/Photos", data: Buffer.alloc(0), directory: true },
      { name: "Takeout/Photos/IMG_0001.jpg", data: FAKE_JPEG },
    ]);
    const parentS3Key = "originals/2026/07/bb/photos-only.zip";
    storage.objects.set(parentS3Key, zip);
    const parentId = await insertParentDocument(zip, parentS3Key);

    const outcome = await runIngestion(sql, parentId, {
      stages: takeoutStages(storage, enqueue, scratchRoot),
    });
    expect(outcome).toEqual({ kind: "done" });
    expect(await documentStatus(parentId)).toBe("done");
    expect(enqueued).toHaveLength(0);
    const children = await sql`
      select 1 as found from documents where parent_document_id = ${parentId}
    `;
    expect(children).toHaveLength(0);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("dedups identical inner files by content hash into one child", async () => {
    const storage = createFakeStorage();
    const { calls: enqueued, enqueue } = createFakeEnqueue();
    const zip = buildZip([
      { name: "Takeout/Fit/a.csv", data: GOOGLE_FIT_CSV },
      { name: "Takeout/Fit/archive/b.csv", data: GOOGLE_FIT_CSV },
    ]);
    const parentS3Key = "originals/2026/07/cc/dupes.zip";
    storage.objects.set(parentS3Key, zip);
    const parentId = await insertParentDocument(zip, parentS3Key);

    const outcome = await runIngestion(sql, parentId, {
      stages: takeoutStages(storage, enqueue, scratchRoot),
    });
    expect(outcome).toEqual({
      kind: "pending",
      stage: "normalizing",
      message: "1 of 1 child documents still ingesting",
    });

    const children = await sql<ChildRow[]>`
      select id from documents where parent_document_id = ${parentId}
    `;
    expect(children).toHaveLength(1);
    // The duplicate entry re-nudges the enqueue for the still-pending child;
    // pg-boss's singletonKey suppresses the actual duplicate job.
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0].id).toBe(children[0].id);
    expect(enqueued[1].id).toBe(children[0].id);

    const extracting = await sql<{ payload: postgres.JSONValue }[]>`
      select payload from raw_extractions
      where document_id = ${parentId} and stage = 'extracting'
    `;
    expect(
      (extracting[0].payload as { archive: Record<string, number> }).archive,
    ).toMatchObject({ childrenCreated: 1, duplicates: 1 });
  });

  it("fails the stage (not the worker) on an unreadable archive and still cleans scratch", async () => {
    const storage = createFakeStorage();
    const { enqueue } = createFakeEnqueue();
    const garbage = randomBytes(4096); // not a zip at all
    const parentS3Key = "originals/2026/07/dd/garbage.zip";
    storage.objects.set(parentS3Key, garbage);
    const parentId = await insertParentDocument(garbage, parentS3Key);

    await expect(
      runIngestion(sql, parentId, {
        stages: takeoutStages(storage, enqueue, scratchRoot),
      }),
    ).rejects.toThrow();

    const rows = await sql<
      { status: string; stage_error: { stage: string } | null }[]
    >`
      select status, stage_error from documents where id = ${parentId}
    `;
    expect(rows[0].status).toBe("extracting");
    expect(rows[0].stage_error?.stage).toBe("extracting");
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyTakeoutEntry (pure)
// ---------------------------------------------------------------------------

describe("classifyTakeoutEntry", () => {
  const ouraHeaders = ["day", "total_sleep_duration", "average_hrv", "steps"];

  it("accepts CSVs under a health folder without needing headers", () => {
    expect(classifyTakeoutEntry("Takeout/Fit/anything.csv", null)).toEqual({
      kind: "relevant",
      via: "health_folder",
    });
    expect(classifyTakeoutEntry("takeout/fit/nested/deep.csv", null)).toEqual({
      kind: "relevant",
      via: "health_folder",
    });
  });

  it("skips noise folders even when headers would match", () => {
    expect(
      classifyTakeoutEntry("Takeout/Photos/measurements.csv", ouraHeaders),
    ).toEqual({ kind: "skipped", reason: "noise folder 'photos'" });
  });

  it("skips json sidecars and non-CSV entries", () => {
    expect(classifyTakeoutEntry("Takeout/Fit/data.json", null).kind).toBe(
      "skipped",
    );
    expect(classifyTakeoutEntry("Takeout/Fit/data.json", null)).toMatchObject({
      reason: expect.stringMatching("json sidecar"),
    });
    expect(classifyTakeoutEntry("Takeout/Fit/ride.tcx", null)).toMatchObject({
      kind: "skipped",
      reason: "not a CSV entry (.tcx)",
    });
  });

  it("leaves unknown-folder CSVs undecided until headers arrive", () => {
    expect(classifyTakeoutEntry("Takeout/Wellness/export.csv", null)).toEqual({
      kind: "undecided",
    });
  });

  it("claims unknown-folder CSVs by header signature", () => {
    expect(
      classifyTakeoutEntry("Takeout/Wellness/export.csv", ouraHeaders),
    ).toEqual({ kind: "relevant", via: "header_signature" });
    expect(
      classifyTakeoutEntry("Takeout/Wellness/export.csv", ["foo", "bar"]),
    ).toEqual({
      kind: "skipped",
      reason: "no wearable header signature match",
    });
  });
});
