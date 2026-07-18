import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { registerUpload, updateExtraction } from "../../db/repos/documents";
import { biomarkers } from "../../db/schema";
import { setupTestDb } from "../../db/test-utils";
import type { ChatCitation } from "../../db/schema";
import { dispatchTool } from "./tools";

const getDb = setupTestDb();

async function seedDocument(
  overrides: { filename?: string; text?: string; summary?: string } = {},
) {
  const db = getDb();
  const { document } = await registerUpload(db, {
    sha256: `sha-${Math.random().toString(36).slice(2)}`,
    filename: overrides.filename ?? "hila-lab-report.pdf",
    s3Key: "originals/ab/abcdef",
    contentType: "application/pdf",
  });
  await updateExtraction(db, document.id, {
    documentType: "lab_report",
    provider: "UAB Hila",
    documentDate: "2026-01-05",
    aiSummary: overrides.summary ?? "Lab report: ferritin 45 ng/mL, elevated.",
    extractedText:
      overrides.text ??
      "Ferritin 45 ng/mL reference 10-120. Hemoglobin 140 g/L. Vitamin D low.",
  });
  return document;
}

async function seedFerritin(documentId: string | null) {
  const db = getDb();
  const [biomarker] = await db
    .insert(biomarkers)
    .values({
      slug: "ferritin",
      name: "Ferritin",
      category: "iron",
      canonicalUnit: "ng/mL",
      aliases: ["feritinas"],
    })
    .returning();
  await db.execute(sql`
    insert into biomarker_results
      (biomarker_id, measured_on, value, unit, value_canonical, ref_text, lab_name, flag, document_id)
    values
      (${biomarker.id}, '2025-06-01', 30, 'ng/mL', 30, '10-120', 'UAB Hila', 'normal', ${documentId}),
      (${biomarker.id}, '2026-01-05', 45, 'ng/mL', 45, '10-120', 'UAB Hila', 'normal', ${documentId})`);
  return biomarker;
}

describe("dispatchTool: search_documents", () => {
  it("returns hits and records citations with the document id", async () => {
    const document = await seedDocument();
    const citations: ChatCitation[] = [];
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "search_documents",
        { query: "ferritin" },
        citations,
      ),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      documentId: document.id,
      filename: "hila-lab-report.pdf",
      provider: "UAB Hila",
    });
    expect(result.results[0].snippet).toContain("Ferritin");
    expect(result.results[0].snippet).not.toContain("<b>");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      documentId: document.id,
      filename: "hila-lab-report.pdf",
    });
    expect(citations[0].quote.length).toBeGreaterThan(0);
  });

  it("returns an empty result set when nothing matches", async () => {
    await seedDocument();
    const citations: ChatCitation[] = [];
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "search_documents",
        { query: "nonexistentanalyte" },
        citations,
      ),
    );
    expect(result.results).toEqual([]);
    expect(result.note).toBeTruthy();
    expect(citations).toEqual([]);
  });

  it("requires a query", async () => {
    const result = JSON.parse(
      await dispatchTool(getDb(), "search_documents", {}, []),
    );
    expect(result.error).toBeTruthy();
  });
});

describe("dispatchTool: get_biomarker_trend", () => {
  it("returns ascending points and cites the source document", async () => {
    const document = await seedDocument();
    await seedFerritin(document.id);
    const citations: ChatCitation[] = [];
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "get_biomarker_trend",
        { slug: "ferritin" },
        citations,
      ),
    );
    expect(result.biomarker).toMatchObject({
      slug: "ferritin",
      name: "Ferritin",
      canonicalUnit: "ng/mL",
    });
    expect(result.points.map((p: { value: number }) => p.value)).toEqual([
      30, 45,
    ]);
    expect(result.points[0]).toMatchObject({
      measuredOn: "2025-06-01",
      unit: "ng/mL",
      documentId: document.id,
    });
    // Both points come from the same document with distinct quotes.
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ documentId: document.id });
    expect(citations[0].quote).toContain("Ferritin: 30 ng/mL on 2025-06-01");
  });

  it("honors the date range", async () => {
    const document = await seedDocument();
    await seedFerritin(document.id);
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "get_biomarker_trend",
        { slug: "ferritin", from: "2026-01-01", to: "2026-12-31" },
        [],
      ),
    );
    expect(result.points).toHaveLength(1);
    expect(result.points[0].value).toBe(45);
  });

  it("reports unknown slugs with the valid list", async () => {
    await seedFerritin(null);
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "get_biomarker_trend",
        { slug: "not-a-biomarker" },
        [],
      ),
    );
    expect(result.error).toContain("not-a-biomarker");
    expect(result.validSlugs).toContain("ferritin");
  });
});

describe("dispatchTool: get_daily_metrics", () => {
  beforeAll(async () => {
    // daily_metrics is owned by the activity-domain issue (health-etv.3) and
    // does not exist in this tree yet; create its contracted shape here to
    // test the happy path. The graceful 42P01 path is tested by dropping it.
    await getDb().execute(sql`
      create table if not exists daily_metrics (
        metric_on date not null,
        metric text not null,
        source text not null,
        value numeric not null,
        unit text not null,
        primary key (metric_on, metric, source)
      )`);
  });

  it("returns points for the metric and range", async () => {
    const db = getDb();
    await db.execute(sql`
      insert into daily_metrics (metric_on, metric, source, value, unit)
      values
        ('2026-07-01', 'steps', 'google-fit', 8000, 'count'),
        ('2026-07-02', 'steps', 'google-fit', 9500, 'count'),
        ('2026-07-02', 'resting_hr', 'oura', 55, 'bpm')`);
    const result = JSON.parse(
      await dispatchTool(
        db,
        "get_daily_metrics",
        { metric: "steps", from: "2026-07-01", to: "2026-07-31" },
        [],
      ),
    );
    expect(result.points).toEqual([
      { date: "2026-07-01", value: 8000, unit: "count", source: "google-fit" },
      { date: "2026-07-02", value: 9500, unit: "count", source: "google-fit" },
    ]);
  });

  it("answers gracefully when the daily_metrics table does not exist", async () => {
    const db = getDb();
    await db.execute(sql`drop table if exists daily_metrics`);
    const result = JSON.parse(
      await dispatchTool(db, "get_daily_metrics", { metric: "steps" }, []),
    );
    expect(result.points).toEqual([]);
    expect(result.note).toContain("No wearable data");
    // Restore for any later tests in this file.
    await db.execute(sql`
      create table if not exists daily_metrics (
        metric_on date not null,
        metric text not null,
        source text not null,
        value numeric not null,
        unit text not null,
        primary key (metric_on, metric, source)
      )`);
  });
});

describe("dispatchTool: get_document", () => {
  it("returns metadata + excerpt and cites the summary", async () => {
    const document = await seedDocument();
    const citations: ChatCitation[] = [];
    const result = JSON.parse(
      await dispatchTool(getDb(), "get_document", { id: document.id }, citations),
    );
    expect(result).toMatchObject({
      documentId: document.id,
      filename: "hila-lab-report.pdf",
      documentType: "lab_report",
      provider: "UAB Hila",
    });
    expect(result.excerpt).toContain("Ferritin 45 ng/mL");
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      documentId: document.id,
      quote: "Lab report: ferritin 45 ng/mL, elevated.",
    });
  });

  it("reports missing documents", async () => {
    const result = JSON.parse(
      await dispatchTool(
        getDb(),
        "get_document",
        { id: "00000000-0000-0000-0000-000000000000" },
        [],
      ),
    );
    expect(result.error).toBeTruthy();
  });
});

describe("dispatchTool: unknown tools", () => {
  it("returns an error result instead of throwing", async () => {
    const result = JSON.parse(
      await dispatchTool(getDb(), "delete_everything", {}, []),
    );
    expect(result.error).toContain("Unknown tool");
  });
});
