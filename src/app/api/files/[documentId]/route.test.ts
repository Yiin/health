import { createHash, randomBytes, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

// The documents table does not exist yet (health-etv.12); the lookup seam is
// mocked so the route is exercised end-to-end against real MinIO storage.
vi.mock("@/lib/document-files", () => ({
  findDocumentFile: vi.fn(),
}));

import { findDocumentFile } from "@/lib/document-files";
import { setupMinioTestEnv } from "@/lib/minio-test-utils";
import { ensureBucket, getOriginalStream, putOriginal } from "@/lib/storage";

import { GET } from "./route";

const env = setupMinioTestEnv();

function request(documentId: string) {
  return GET(new Request(`http://localhost/api/files/${documentId}`), {
    params: Promise.resolve({ documentId }),
  });
}

describe.skipIf(!env)("GET /api/files/[documentId]", () => {
  beforeAll(async () => {
    await ensureBucket();
  }, 30_000);

  it("streams a stored original end-to-end with its content-type", async () => {
    const payload = randomBytes(128 * 1024);
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const s3Key = await putOriginal(payload, sha256, {
      contentType: "application/pdf",
    });
    vi.mocked(findDocumentFile).mockResolvedValue({
      s3Key,
      contentType: "application/pdf",
      filename: "laboratoire-2026.pdf",
    });

    const res = await request(randomUUID());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe(String(payload.length));
    expect(res.headers.get("content-disposition")).toContain(
      "laboratoire-2026.pdf",
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(payload)).toBe(true);
  });

  it("falls back to the S3 content-type when the document has none", async () => {
    const payload = Buffer.from("csv,bytes");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const s3Key = await putOriginal(payload, sha256, {
      contentType: "text/csv",
    });
    vi.mocked(findDocumentFile).mockResolvedValue({
      s3Key,
      contentType: null,
      filename: "fit.csv",
    });

    const res = await request(randomUUID());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
  });

  it("404s for unknown document ids", async () => {
    vi.mocked(findDocumentFile).mockResolvedValue(null);

    const res = await request(randomUUID());

    expect(res.status).toBe(404);
  });

  it("404s when the object is missing from storage", async () => {
    vi.mocked(findDocumentFile).mockResolvedValue({
      s3Key: `originals/1999/01/00/${"e".repeat(64)}`,
      contentType: "application/pdf",
      filename: "gone.pdf",
    });

    const res = await request(randomUUID());

    expect(res.status).toBe(404);
  });

  it("keeps a document row pointing at real bytes consistent", async () => {
    // Sanity guard on the seam contract: keys the lookup returns must be
    // resolvable through the storage module.
    const payload = Buffer.from("contract");
    const sha256 = createHash("sha256").update(payload).digest("hex");
    const s3Key = await putOriginal(payload, sha256);
    expect((await getOriginalStream(s3Key))?.contentLength).toBe(
      payload.length,
    );
  });
});
