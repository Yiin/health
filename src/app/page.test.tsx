import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverviewView } from "@/components/overview-view";
import { insertResults } from "@/db/repos/biomarker-results";
import { aiInsights, biomarkers, dailyMetrics, documents } from "@/db/schema";
import { setupTestDb } from "@/db/test-utils";
import { loadOverviewData } from "@/lib/overview";

// Renders the overview view with data loaded through the page's own loader
// (loadOverviewData) against the real test database — the page's async
// default export is a thin loadOverviewData(db) + <OverviewView> wrapper, and
// renderToString cannot render async components.
const getDb = setupTestDb();

async function seedAll() {
  const db = getDb();
  const [glucose] = await db
    .insert(biomarkers)
    .values({
      slug: "glucose",
      name: "Glucose",
      aliases: ["glucose"],
      category: "metabolic",
      canonicalUnit: "mmol/L",
      molarMassGMol: 180.156,
    })
    .returning({ id: biomarkers.id });
  await insertResults(db, [
    {
      biomarkerId: glucose.id,
      measuredOn: "2026-01-10",
      value: 5.0,
      unit: "mmol/L",
      refLow: 3.9,
      refHigh: 5.5,
    },
    {
      biomarkerId: glucose.id,
      measuredOn: "2026-02-10",
      value: 6.1,
      unit: "mmol/L",
      refLow: 3.9,
      refHigh: 5.5,
    },
  ]);

  const [failedDoc] = await db
    .insert(documents)
    .values({
      sha256: "a".repeat(64),
      originalFilename: "failed-scan.pdf",
      s3Key: "originals/aa/failed",
      status: "failed",
      documentType: "lab_report",
      uploadedAt: new Date("2026-02-11T10:00:00Z"),
    })
    .returning({ id: documents.id });
  await db.insert(documents).values({
    sha256: "b".repeat(64),
    originalFilename: "labs-jan.pdf",
    s3Key: "originals/bb/labs",
    status: "done",
    documentType: "lab_report",
    uploadedAt: new Date("2026-02-01T10:00:00Z"),
  });

  await db.insert(aiInsights).values({
    kind: "post_ingestion",
    title: "Glucose crept above range",
    bodyMd: "Glucose moved above its reference range in the latest draw.",
    sourceRefs: [
      { kind: "document", id: failedDoc.id, note: "failed-scan.pdf" },
    ],
    createdAt: new Date("2026-02-11T12:00:00Z"),
  });

  await db.insert(dailyMetrics).values({
    metricOn: "2026-02-11",
    metric: "steps",
    source: "oura",
    value: 8432,
    unit: "count",
  });

  return { failedDocId: failedDoc.id };
}

describe("overview page", () => {
  it("renders stat cards, needs attention, insights, and uploads from the DB", async () => {
    const { failedDocId } = await seedAll();

    const data = await loadOverviewData(getDb());
    const html = renderToString(React.createElement(OverviewView, { data }));

    // Stat cards: latest vitals + the labs in-range ratio.
    expect(html).toContain("Steps");
    expect(html).toContain("8,432");
    expect(html).toContain("on 2026-02-11");
    expect(html).toContain("Labs in range");
    expect(html).toContain("0 / 1");

    // Needs attention: flagged biomarker + the failed document.
    expect(html).toContain("Needs attention");
    expect(html).toContain("Glucose");
    expect(html).toContain("High 6.1");
    expect(html).toContain("failed-scan.pdf");
    expect(html).toContain("Failed");

    // Recent insights: the AI insight card with its source link.
    expect(html).toContain("Recent insights");
    expect(html).toContain("Glucose crept above range");
    expect(html).toContain(`href="/documents/${failedDocId}"`);

    // Recent uploads.
    expect(html).toContain("Recent uploads");
    expect(html).toContain("labs-jan.pdf");
  });

  it("renders empty states when the database is empty", async () => {
    const data = await loadOverviewData(getDb());
    const html = renderToString(React.createElement(OverviewView, { data }));

    expect(html).toContain("no data yet");
    expect(html).toContain("no lab results yet");
    expect(html).toContain("No insights yet");
    expect(html).toContain("No documents yet");
    expect(html).not.toContain("Needs attention");
  });
});
