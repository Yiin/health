import { createHash, randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { getSqlClient } from "@/db";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";
import { setupMinioTestEnv } from "@/lib/minio-test-utils";
import { getBoss, stopBoss } from "@/lib/queue";
import { ensureBucket, getOriginalStream, objectExists } from "@/lib/storage";

import { GET as getFile } from "../files/[documentId]/route";
import { POST } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const env = setupMinioTestEnv();

// A minimal but syntactically valid one-page PDF.
const PDF_BYTES = Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
`);

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uploadRequest(
  files: { name: string; bytes: Buffer; type?: string }[],
): Request {
  const form = new FormData();
  for (const file of files) {
    form.append(
      "files",
      new Blob([new Uint8Array(file.bytes)], { type: file.type }),
      file.name,
    );
  }
  return new Request("http://localhost/api/uploads", {
    method: "POST",
    body: form,
  });
}

interface FileResultJson {
  filename: string;
  ok: boolean;
  documentId?: string;
  sha256?: string;
  sizeBytes?: number;
  duplicate?: boolean;
  jobId?: string | null;
  error?: string;
}

interface DocumentRow {
  id: string;
  sha256: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: number | null;
  s3_key: string;
  status: string;
}

async function documentById(id: string): Promise<DocumentRow | undefined> {
  const rows = (await getSqlClient().unsafe(
    "select id, sha256, original_filename, content_type, size_bytes::float8 as size_bytes, s3_key, status from documents where id = $1",
    [id],
  )) as unknown as DocumentRow[];
  return rows[0];
}

async function ingestJobs(): Promise<
  {
    name: string;
    state: string;
    singleton_key: string;
    data: { documentId?: string };
  }[]
> {
  return (await getSqlClient().unsafe(
    "select name, state, singleton_key, data from pgboss.job where name = 'ingest' order by created_on",
  )) as never;
}

async function leftoverStagingDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith("health-upload-"));
}

describe.skipIf(!env)("POST /api/uploads", () => {
  const getDb = setupTestDb();

  beforeAll(async () => {
    await ensureBucket();
    await getBoss();
  }, 60_000);

  beforeEach(async () => {
    await getSqlClient().unsafe("delete from pgboss.job");
  });

  afterEach(async () => {
    delete process.env.UPLOAD_MAX_BYTES;
    expect(await leftoverStagingDirs()).toEqual([]);
  });

  afterAll(async () => {
    await stopBoss();
    await getSqlClient().end({ timeout: 1 });
  });

  it("accepts a PDF end-to-end: S3 object, documents row, enqueued job", async () => {
    const res = await POST(
      uploadRequest([
        { name: "labs-2026-07.pdf", bytes: PDF_BYTES, type: "application/pdf" },
      ]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: FileResultJson[] };
    const file = body.files[0];
    expect(file?.ok).toBe(true);
    expect(file?.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(file?.sha256).toBe(sha256Of(PDF_BYTES));
    expect(file?.sizeBytes).toBe(PDF_BYTES.length);
    expect(file?.duplicate).toBe(false);
    expect(file?.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await documentById(file!.documentId!);
    expect(row).toMatchObject({
      sha256: sha256Of(PDF_BYTES),
      original_filename: "labs-2026-07.pdf",
      content_type: "application/pdf",
      size_bytes: PDF_BYTES.length,
      status: "uploaded",
    });
    expect(row?.s3_key).toMatch(
      new RegExp(
        `^originals/\\d{4}/\\d{2}/${sha256Of(PDF_BYTES).slice(0, 2)}/${sha256Of(PDF_BYTES)}$`,
      ),
    );

    // The S3 object sits at the content-addressed key with the exact bytes.
    await expect(objectExists(row!.s3_key)).resolves.toBe(true);
    const object = await getOriginalStream(row!.s3_key);
    const chunks: Buffer[] = [];
    for await (const chunk of object!.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(PDF_BYTES)).toBe(true);

    // The ingest job is enqueued with the document id, keyed by content.
    const jobs = await ingestJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: "ingest",
      state: "created",
      singleton_key: sha256Of(PDF_BYTES),
    });
    expect(jobs[0]?.data.documentId).toBe(file?.documentId);
  });

  it("returns the same document for an identical re-upload and enqueues no second job", async () => {
    const first = await POST(
      uploadRequest([{ name: "labs.pdf", bytes: PDF_BYTES }]),
    );
    const firstBody = (await first.json()) as { files: FileResultJson[] };
    expect(firstBody.files[0]?.duplicate).toBe(false);

    const second = await POST(
      uploadRequest([{ name: "labs-renamed.pdf", bytes: PDF_BYTES }]),
    );

    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { files: FileResultJson[] };
    expect(secondBody.files[0]?.ok).toBe(true);
    expect(secondBody.files[0]?.duplicate).toBe(true);
    expect(secondBody.files[0]?.jobId).toBeNull();
    expect(secondBody.files[0]?.documentId).toBe(
      firstBody.files[0]?.documentId,
    );

    const count = await getDb().execute(
      sql`select count(*)::int as n from documents where sha256 = ${sha256Of(PDF_BYTES)}`,
    );
    expect((count as unknown as { n: number }[])[0]?.n).toBe(1);
    expect(await ingestJobs()).toHaveLength(1);
  });

  it("rejects an unsupported file type without touching S3, the DB, or the queue", async () => {
    const res = await POST(
      uploadRequest([{ name: "evil.exe", bytes: randomBytes(128) }]),
    );

    expect(res.status).toBe(415);
    const body = (await res.json()) as { files: FileResultJson[] };
    expect(body.files[0]?.ok).toBe(false);
    expect(body.files[0]?.error).toContain("unsupported file type");
    expect(body.files[0]?.error).toContain("pdf");

    const docs = await getDb().execute(
      sql`select count(*)::int as n from documents`,
    );
    expect((docs as unknown as { n: number }[])[0]?.n).toBe(0);
    expect(await ingestJobs()).toHaveLength(0);
  });

  it("rejects a file over the per-file limit with a clear error", async () => {
    process.env.UPLOAD_MAX_BYTES = "1024";

    const res = await POST(
      uploadRequest([
        {
          name: "huge.pdf",
          bytes: randomBytes(4 * 1024),
          type: "application/pdf",
        },
      ]),
    );

    expect(res.status).toBe(413);
    const body = (await res.json()) as { files: FileResultJson[] };
    expect(body.files[0]?.ok).toBe(false);
    expect(body.files[0]?.error).toContain("per-file limit");

    const docs = await getDb().execute(
      sql`select count(*)::int as n from documents`,
    );
    expect((docs as unknown as { n: number }[])[0]?.n).toBe(0);
    expect(await ingestJobs()).toHaveLength(0);
  });

  it("processes a mixed batch: good files land, bad ones are reported", async () => {
    const csv = Buffer.from("date,steps\n2026-07-18,8000\n");
    const res = await POST(
      uploadRequest([
        { name: "fit.csv", bytes: csv, type: "text/csv" },
        { name: "notes.exe", bytes: randomBytes(64) },
        { name: "labs.pdf", bytes: PDF_BYTES, type: "application/pdf" },
      ]),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: FileResultJson[] };
    const byName = new Map(body.files.map((file) => [file.filename, file]));

    expect(byName.get("fit.csv")?.ok).toBe(true);
    expect(byName.get("labs.pdf")?.ok).toBe(true);
    expect(byName.get("notes.exe")?.ok).toBe(false);
    expect(byName.get("notes.exe")?.error).toContain("unsupported file type");

    const docs = await getDb().execute(
      sql`select count(*)::int as n from documents`,
    );
    expect((docs as unknown as { n: number }[])[0]?.n).toBe(2);
    expect(await ingestJobs()).toHaveLength(2);
  });

  it("400s when the multipart payload contains no files", async () => {
    const form = new FormData();
    form.append("comment", "no files here");
    const res = await POST(
      new Request("http://localhost/api/uploads", {
        method: "POST",
        body: form,
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no files");
  });

  it("400s when the request is not multipart", async () => {
    const res = await POST(
      new Request("http://localhost/api/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: "nope" }),
      }),
    );

    expect(res.status).toBe(400);
  });

  it("enforces the basic-auth gate itself (the proxy skips this route)", async () => {
    process.env.BASIC_AUTH_USER = "yiin";
    process.env.BASIC_AUTH_PASS = "hunter2";
    try {
      const denied = await POST(
        uploadRequest([{ name: "labs.pdf", bytes: PDF_BYTES }]),
      );
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe(
        'Basic realm="health"',
      );

      const form = new FormData();
      form.append(
        "files",
        new Blob([new Uint8Array(PDF_BYTES)], { type: "application/pdf" }),
        "labs.pdf",
      );
      const allowed = await POST(
        new Request("http://localhost/api/uploads", {
          method: "POST",
          body: form,
          headers: { authorization: `Basic ${btoa("yiin:hunter2")}` },
        }),
      );
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.BASIC_AUTH_USER;
      delete process.env.BASIC_AUTH_PASS;
    }
  });

  it("serves the uploaded bytes back through GET /api/files/[documentId]", async () => {
    const upload = await POST(
      uploadRequest([{ name: "labs.pdf", bytes: PDF_BYTES }]),
    );
    const { files } = (await upload.json()) as { files: FileResultJson[] };
    const documentId = files[0]!.documentId!;

    const res = await getFile(
      new Request(`http://localhost/api/files/${documentId}`),
      { params: Promise.resolve({ documentId }) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("labs.pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
  });
});
