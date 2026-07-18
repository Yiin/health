import { randomBytes, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { registerUpload, updateStatus } from "@/db/repos/documents";
import {
  biomarkerResults,
  biomarkers,
  documents,
  type DocumentStatus,
} from "@/db/schema";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";

import { GET } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

function freshSha256(): string {
  return randomBytes(32).toString("hex");
}

async function insertDocument(
  status: DocumentStatus,
  opts: { uploadedAt?: Date; filename?: string } = {},
) {
  const sha256 = freshSha256();
  const { document } = await registerUpload(getDb(), {
    sha256,
    filename: opts.filename ?? "labs.pdf",
    sizeBytes: 2048,
    s3Key: `originals/2026/07/${sha256.slice(0, 2)}/${sha256}`,
  });
  if (opts.uploadedAt) {
    await getDb()
      .update(documents)
      .set({ uploadedAt: opts.uploadedAt })
      .where(eq(documents.id, document.id));
  }
  const updated = await updateStatus(getDb(), document.id, status, {
    stage: "extracting",
    message: "kimi timeout",
  });
  return updated!;
}

function getFeed(query = "?status=active") {
  return GET(new Request(`http://localhost/api/documents${query}`));
}

interface FeedJson {
  documents?: {
    id: string;
    status: string;
    stageError: { stage: string; message: string } | null;
    biomarkerCount: number;
    sizeBytes: number | null;
  }[];
  hasActive?: boolean;
  polledAt?: string;
  error?: string;
}

describe("GET /api/documents?status=active", () => {
  it("400s without the status=active query", async () => {
    const noParam = await getFeed("");
    expect(noParam.status).toBe(400);

    const wrongValue = await getFeed("?status=done");
    expect(wrongValue.status).toBe(400);
    expect(((await wrongValue.json()) as FeedJson).error).toContain(
      "status=active",
    );
  });

  it("returns non-terminal documents of any age and recent terminal ones", async () => {
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const stuckUploaded = await insertDocument("uploaded", {
      uploadedAt: old,
      filename: "stuck.pdf",
    });
    const recentDone = await insertDocument("done", { filename: "done.pdf" });
    const oldDone = await insertDocument("done", {
      uploadedAt: old,
      filename: "old-done.pdf",
    });

    const res = await getFeed();

    expect(res.status).toBe(200);
    const body = (await res.json()) as FeedJson;
    const ids = body.documents?.map((doc) => doc.id) ?? [];
    expect(ids).toContain(stuckUploaded.id);
    expect(ids).toContain(recentDone.id);
    expect(ids).not.toContain(oldDone.id);
  });

  it("reports hasActive only while a pipeline run is in flight", async () => {
    await insertDocument("done");
    const idle = (await (await getFeed()).json()) as FeedJson;
    expect(idle.hasActive).toBe(false);

    await insertDocument("extracting");
    const active = (await (await getFeed()).json()) as FeedJson;
    expect(active.hasActive).toBe(true);
  });

  it("includes stage_error and the linked-biomarker count", async () => {
    const doc = await insertDocument("needs_review");

    const [biomarker] = await getDb()
      .insert(biomarkers)
      .values({
        slug: `glucose-${randomUUID().slice(0, 8)}`,
        name: "Glucose",
        category: "metabolic",
        canonicalUnit: "mmol/L",
      })
      .returning();
    await getDb()
      .insert(biomarkerResults)
      .values([
        {
          biomarkerId: biomarker.id,
          measuredOn: "2026-01-30",
          value: 5.1,
          unit: "mmol/L",
          documentId: doc.id,
        },
        {
          biomarkerId: biomarker.id,
          measuredOn: "2026-01-31",
          value: 5.4,
          unit: "mmol/L",
          documentId: doc.id,
        },
      ]);

    const res = await getFeed();

    const body = (await res.json()) as FeedJson;
    const item = body.documents?.find((entry) => entry.id === doc.id);
    expect(item?.stageError?.message).toBe("kimi timeout");
    expect(item?.biomarkerCount).toBe(2);
    expect(item?.sizeBytes).toBe(2048);
  });

  it("orders newest upload first and stamps the poll time", async () => {
    const older = await insertDocument("uploaded", {
      uploadedAt: new Date(Date.now() - 60_000),
    });
    const newer = await insertDocument("uploaded");

    const body = (await (await getFeed()).json()) as FeedJson;

    expect(body.documents?.[0]?.id).toBe(newer.id);
    expect(body.documents?.[1]?.id).toBe(older.id);
    expect(body.polledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
