import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InsightsView } from "@/components/insights-view";
import { insertResults } from "@/db/repos/biomarker-results";
import { aiInsights, biomarkers, documents } from "@/db/schema";
import { setupTestDb } from "@/db/test-utils";
import { loadInsightsData } from "@/lib/insights";

// Renders the insights view with data loaded through the page's own loader
// (loadInsightsData) against the real test database — the page's async
// default export is a thin loadInsightsData(db) + <InsightsView> wrapper, and
// renderToString cannot render async components.
const getDb = setupTestDb();

describe("/insights page", () => {
  it("renders deterministic flag cards and the AI feed from the DB", async () => {
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
        value: 7.6,
        unit: "mmol/L",
        refLow: 3.9,
        refHigh: 5.5,
      },
    ]);
    const [doc] = await db
      .insert(documents)
      .values({
        sha256: "c".repeat(64),
        originalFilename: "labs-feb.pdf",
        s3Key: "originals/cc/labs",
        status: "done",
      })
      .returning({ id: documents.id });
    await db.insert(aiInsights).values({
      kind: "post_ingestion",
      title: "Glucose jumped sharply",
      bodyMd: "Glucose rose **52%** versus the previous draw.",
      sourceRefs: [
        { kind: "document", id: doc.id, note: "labs-feb.pdf" },
        { kind: "biomarker", id: "glucose", note: "Glucose" },
      ],
      createdAt: new Date("2026-02-10T12:00:00Z"),
    });

    const data = await loadInsightsData(db);
    const html = renderToString(React.createElement(InsightsView, { data }));

    // Flag cards: out-of-range + big delta on the latest draw, linking to the
    // biomarker trend page.
    expect(html).toContain("Flags (2)");
    expect(html).toContain("Out of range");
    expect(html).toContain("Above reference range: 7.6 (ref 3.9–5.5)");
    expect(html).toContain("Big change");
    expect(html).toContain("+52% vs previous draw (5 → 7.6)");
    expect(html).toContain('href="/labs/glucose"');

    // AI feed: kind badge, title, markdown body, resolved source links.
    expect(html).toContain("AI insights (1)");
    expect(html).toContain("Post-ingestion");
    expect(html).toContain("Glucose jumped sharply");
    expect(html).toContain("<strong>52%</strong>");
    expect(html).toContain(`href="/documents/${doc.id}"`);
    expect(html).toContain("labs-feb.pdf");
  });

  it("renders the empty state when there is nothing to show", async () => {
    const data = await loadInsightsData(getDb());
    const html = renderToString(React.createElement(InsightsView, { data }));

    expect(html).toContain("No insights yet");
    expect(html).not.toContain("Flags (");
  });
});
