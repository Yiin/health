import { describe, expect, it } from "vitest";

import { biomarkers } from "../schema";
import { setupTestDb } from "../test-utils";
import {
  getTrend,
  insertResults,
  listBiomarkersWithLatest,
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
      { biomarkerId: glucoseId, measuredOn: "2026-01-01", value: 5, unit: "mmol/L" },
      { biomarkerId: glucoseId, measuredOn: "2026-02-01", value: 6, unit: "mmol/L" },
      { biomarkerId: glucoseId, measuredOn: "2026-03-01", value: 7, unit: "mmol/L" },
    ]);

    expect(
      (await getTrend(db, "glucose", { from: "2026-01-15" })).map((p) => p.measuredOn),
    ).toEqual(["2026-02-01", "2026-03-01"]);
    expect(
      (await getTrend(db, "glucose", { from: "2026-01-15", to: "2026-02-15" })).map(
        (p) => p.measuredOn,
      ),
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
      { biomarkerId: glucoseId, measuredOn: "2026-01-01", value: 5.1, unit: "mmol/L" },
      { biomarkerId: glucoseId, measuredOn: "2026-02-01", value: 5.9, unit: "mmol/L", flag: "high" },
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
