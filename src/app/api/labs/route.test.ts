import { describe, expect, it } from "vitest";

import { biomarkers } from "@/db/schema";
import {
  insertResults,
  listAllResults,
  updateResultOverrides,
} from "@/db/repos/biomarker-results";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";

import { GET } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

async function insertBiomarker(
  overrides: Partial<typeof biomarkers.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(biomarkers)
    .values({
      slug: "glucose",
      name: "Glucose",
      aliases: ["glucose"],
      category: "metabolic",
      canonicalUnit: "mmol/L",
      molarMassGMol: 180.156,
      ...overrides,
    })
    .returning({ id: biomarkers.id });
  return row.id;
}

interface LabsPayload {
  biomarkers: {
    slug: string;
    name: string;
    category: string;
    canonicalUnit: string;
    latest: {
      measuredOn: string;
      value: number;
      unit: string;
      valueCanonical: number | null;
      flag: string | null;
      edited: boolean;
      refText: string | null;
      labName: string | null;
    } | null;
    trend: {
      date: string;
      value: number | null;
      refLow: number | null;
      refHigh: number | null;
    }[];
  }[];
}

async function labsJson() {
  const response = await GET();
  return {
    status: response.status,
    body: (await response.json()) as LabsPayload,
  };
}

describe("GET /api/labs", () => {
  it("returns the catalog with null latest for never-measured biomarkers", async () => {
    await insertBiomarker();
    const { status, body } = await labsJson();
    expect(status).toBe(200);
    expect(body.biomarkers).toHaveLength(1);
    expect(body.biomarkers[0]).toMatchObject({
      slug: "glucose",
      name: "Glucose",
      category: "metabolic",
      canonicalUnit: "mmol/L",
      latest: null,
      trend: [],
    });
  });

  it("reports the latest result with a recomputed flag plus the trend", async () => {
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
        measuredOn: "2026-01-10",
        value: 100,
        unit: "mg/dL",
        refLow: 3.9,
        refHigh: 5.5,
        labName: "UAB Hila",
      },
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-10",
        value: 6.1,
        unit: "mmol/L",
        refLow: 3.9,
        refHigh: 5.5,
        labName: "UAB Hila",
      },
    ]);

    const { body } = await labsJson();
    const glucose = body.biomarkers.find((b) => b.slug === "glucose")!;
    expect(glucose.latest).toMatchObject({
      measuredOn: "2026-02-10",
      value: 6.1,
      unit: "mmol/L",
      flag: "high",
      edited: false,
      labName: "UAB Hila",
    });
    // Trend is ascending, canonical (the mg/dL draw lands near 5.55 mmol/L).
    expect(glucose.trend.map((p) => p.date)).toEqual([
      "2026-01-10",
      "2026-02-10",
    ]);
    expect(glucose.trend[0].value).toBeCloseTo(5.55, 2);
    expect(glucose.trend[0].refLow).toBe(3.9);

    const ferritin = body.biomarkers.find((b) => b.slug === "ferritin")!;
    expect(ferritin.latest).toBeNull();
  });

  it("applies user overrides to latest and trend", async () => {
    const db = getDb();
    const glucoseId = await insertBiomarker();
    await insertResults(db, [
      {
        biomarkerId: glucoseId,
        measuredOn: "2026-02-10",
        value: 6.1,
        unit: "mmol/L",
        refLow: 3.9,
        refHigh: 5.5,
      },
    ]);
    const [result] = await listAllResults(db);
    await updateResultOverrides(db, result.id, { value: 5.0 });

    const { body } = await labsJson();
    const glucose = body.biomarkers.find((b) => b.slug === "glucose")!;
    expect(glucose.latest).toMatchObject({
      value: 5.0,
      flag: "normal",
      edited: true,
    });
    expect(glucose.trend[0].value).toBe(5.0);
  });
});
