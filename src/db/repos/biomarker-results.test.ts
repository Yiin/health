import { describe, expect, it } from "vitest";

import { aiInsights, biomarkers, documents } from "../schema";
import { setupTestDb } from "../test-utils";
import {
  getBiomarkerBySlug,
  getResultById,
  getTrend,
  insertResults,
  listAllResults,
  listBiomarkersWithLatest,
  listInsightsForBiomarker,
  listResultsForBiomarker,
  updateResultOverrides,
} from "./biomarker-results";

const getDb = setupTestDb();

async function insertBiomarker(
  overrides: Partial<typeof biomarkers.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(biomarkers)
    .values({
      slug: "glucose",
      name: "Glucose",
      aliases: ["glucose", "gliukozė"],
      category: "metabolic",
      canonicalUnit: "mmol/L",
      molarMassGMol: 180.156,
      ...overrides,
    })
    .returning({ id: biomarkers.id });
  return row.id;
}

describe("insertResults", () => {
  it("stores the as-reported pair alongside the canonical value", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();

    const outcome = await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-10",
        value: 100,
        unit: "mg/dL",
        refLow: 3.9,
        refHigh: 5.5,
        labName: "UAB Hila",
        flag: "high",
      },
    ]);

    expect(outcome).toEqual({ inserted: 1, skipped: 0 });
    const trend = await getTrend(db, "glucose");
    expect(trend).toHaveLength(1);
    expect(trend[0].valueCanonical).toBeCloseTo(5.55, 2);

    const full = await listBiomarkersWithLatest(db);
    const glucose = full.find((b) => b.biomarker.slug === "glucose");
    expect(glucose?.latestResult?.value).toBe(100);
    expect(glucose?.latestResult?.unit).toBe("mg/dL");
    expect(glucose?.latestResult?.valueCanonical).toBeCloseTo(5.55, 2);
  });

  it("skips duplicates on (biomarker, measured_on, value_canonical)", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    const input = {
      biomarkerId: glucoseId,
      measuredOn: "2026-01-10",
      value: 5.5,
      unit: "mmol/L",
    };

    expect(await insertResults(db, [input])).toEqual({
      inserted: 1,
      skipped: 0,
    });
    // Re-ingesting the same report row is a no-op...
    expect(await insertResults(db, [input])).toEqual({
      inserted: 0,
      skipped: 1,
    });
    // ...including duplicates inside one batch.
    expect(await insertResults(db, [input, input])).toEqual({
      inserted: 0,
      skipped: 2,
    });
    expect(await getTrend(db, "glucose")).toHaveLength(1);
  });

  it("stores null canonical value instead of guessing unknown units", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();

    const outcome = await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-10",
        value: 42,
        unit: "banana",
      },
    ]);

    expect(outcome).toEqual({ inserted: 1, skipped: 0 });
    const [point] = await getTrend(db, "glucose");
    expect(point.valueCanonical).toBeNull();
  });

  it("rejects results referencing an unknown biomarker", async () => {
    await expect(
      insertResults(getDb(), [
        {
          biomarkerId: "00000000-0000-0000-0000-000000000000",
          measuredOn: "2026-01-10",
          value: 1,
          unit: "mmol/L",
        },
      ]),
    ).rejects.toThrow("unknown biomarker id");
  });
});

describe("getTrend", () => {
  it("returns points ascending by measured_on with refs and lab name", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-03-01",
        value: 6.1,
        unit: "mmol/L",
        refLow: 3.9,
        refHigh: 5.5,
        labName: "Lab C",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-15",
        value: 5.2,
        unit: "mmol/L",
        refLow: 3.9,
        refHigh: 5.5,
        labName: "Lab A",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-10",
        value: 99,
        unit: "mg/dL",
        refLow: 70,
        refHigh: 99,
        labName: "Lab B",
      },
    ]);

    const trend = await getTrend(db, "glucose");
    expect(trend.map((p) => p.measuredOn)).toEqual([
      "2026-01-15",
      "2026-02-10",
      "2026-03-01",
    ]);
    // The mg/dL point is normalized into the canonical mmol/L.
    expect(trend[1].valueCanonical).toBeCloseTo(5.495, 2);
    expect(trend[1].refLow).toBe(70);
    expect(trend[1].refHigh).toBe(99);
    expect(trend[1].labName).toBe("Lab B");
  });

  it("honors the from/to range", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-01",
        value: 5,
        unit: "mmol/L",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-01",
        value: 6,
        unit: "mmol/L",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-03-01",
        value: 7,
        unit: "mmol/L",
      },
    ]);

    expect(
      (await getTrend(db, "glucose", { from: "2026-01-15" })).map(
        (p) => p.measuredOn,
      ),
    ).toEqual(["2026-02-01", "2026-03-01"]);
    expect(
      (
        await getTrend(db, "glucose", { from: "2026-01-15", to: "2026-02-15" })
      ).map((p) => p.measuredOn),
    ).toEqual(["2026-02-01"]);
  });

  it("returns an empty array for an unknown slug", async () => {
    expect(await getTrend(getDb(), "no-such-biomarker")).toEqual([]);
  });
});

describe("listBiomarkersWithLatest", () => {
  it("joins each biomarker with its most recent result", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertBiomarker({
      slug: "ferritin",
      name: "Ferritin",
      category: "vitamins",
      canonicalUnit: "ug/L",
      molarMassGMol: null,
    });
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-01",
        value: 5.1,
        unit: "mmol/L",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-01",
        value: 5.9,
        unit: "mmol/L",
        flag: "high",
      },
    ]);

    const list = await listBiomarkersWithLatest(db);
    expect(list).toHaveLength(2);
    // Ordered by category, then name: metabolic/glucose before vitamins/ferritin.
    expect(list.map((b) => b.biomarker.slug)).toEqual(["glucose", "ferritin"]);
    expect(list[0].latestResult?.measuredOn).toBe("2026-02-01");
    expect(list[0].latestResult?.valueCanonical).toBeCloseTo(5.9, 6);
    expect(list[0].latestResult?.flag).toBe("high");
    expect(list[1].latestResult).toBeNull();
  });
});

describe("getBiomarkerBySlug / getResultById", () => {
  it("looks up rows by slug and id, returning null for misses", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-10",
        value: 5.5,
        unit: "mmol/L",
      },
    ]);
    const [trendPoint] = await getTrend(db, "glucose");

    expect((await getBiomarkerBySlug(db, "glucose"))?.id).toBe(glucoseId);
    expect(await getBiomarkerBySlug(db, "no-such")).toBeNull();
    expect((await getResultById(db, trendPoint.id))?.biomarkerId).toBe(
      glucoseId,
    );
    expect(
      await getResultById(db, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });
});

describe("listAllResults", () => {
  it("returns every result ascending by measured_on", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    const ferritinId = await insertBiomarker({
      slug: "ferritin",
      name: "Ferritin",
      category: "vitamins",
      canonicalUnit: "ug/L",
      molarMassGMol: null,
    });
    await insertResults(db, [
      {
        biomarkerId: ferritinId,
        measuredOn: "2026-02-01",
        value: 80,
        unit: "ug/L",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-03-01",
        value: 5.5,
        unit: "mmol/L",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-01",
        value: 5.1,
        unit: "mmol/L",
      },
    ]);

    const all = await listAllResults(db);
    expect(all.map((r) => r.measuredOn)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });
});

describe("listResultsForBiomarker", () => {
  it("returns draws most-recent-first with the source document filename", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    const [doc] = await getDb()
      .insert(documents)
      .values({
        sha256: "a".repeat(64),
        originalFilename: "blood-panel.pdf",
        s3Key: "originals/aa/report.pdf",
      })
      .returning({ id: documents.id });
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-10",
        value: 5.1,
        unit: "mmol/L",
        documentId: doc.id,
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-10",
        value: 5.9,
        unit: "mmol/L",
      },
    ]);

    const results = await listResultsForBiomarker(db, "glucose");
    expect(results.map((r) => r.measuredOn)).toEqual([
      "2026-02-10",
      "2026-01-10",
    ]);
    expect(results[0].documentFilename).toBeNull();
    expect(results[1].documentFilename).toBe("blood-panel.pdf");
  });
});

describe("updateResultOverrides", () => {
  it("merges overrides and never touches the extracted columns", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-01-10",
        value: 100,
        unit: "mg/dL",
      },
    ]);
    const [point] = await getTrend(db, "glucose");

    const first = await updateResultOverrides(db, point.id, { value: 5.6 });
    expect(first?.userOverrides).toEqual({ value: 5.6 });

    // A later patch merges: the first key survives, the row columns don't move.
    const second = await updateResultOverrides(db, point.id, {
      unit: "mmol/L",
    });
    expect(second?.userOverrides).toEqual({ value: 5.6, unit: "mmol/L" });
    expect(second?.value).toBe(100);
    expect(second?.unit).toBe("mg/dL");
    expect(second?.measuredOn).toBe("2026-01-10");

    expect(
      await updateResultOverrides(db, "00000000-0000-0000-0000-000000000000", {
        value: 1,
      }),
    ).toBeNull();
  });
});

describe("listInsightsForBiomarker", () => {
  it("matches insights whose source_refs pin the biomarker slug", async () => {
    const db = getDb();
    await insertBiomarker();
    await getDb()
      .insert(aiInsights)
      .values([
        {
          kind: "biomarker_trend",
          title: "Glucose creeping up",
          bodyMd: "Up over three draws.",
          sourceRefs: [{ kind: "biomarker", id: "glucose" }],
        },
        {
          kind: "post_ingestion",
          title: "New report processed",
          bodyMd: "Unrelated.",
          sourceRefs: [{ kind: "document", id: "some-uuid" }],
        },
        {
          kind: "anomaly",
          title: "Multi-source insight",
          bodyMd: "Mentions glucose among others.",
          sourceRefs: [
            { kind: "document", id: "another-uuid" },
            { kind: "biomarker", id: "glucose" },
          ],
        },
      ]);

    const insights = await listInsightsForBiomarker(db, "glucose");
    expect(insights.map((i) => i.title).sort()).toEqual([
      "Glucose creeping up",
      "Multi-source insight",
    ]);
    expect(await listInsightsForBiomarker(db, "ferritin")).toEqual([]);
  });
});
