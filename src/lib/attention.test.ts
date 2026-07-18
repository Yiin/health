import { describe, expect, it } from "vitest";

import {
  insertResults,
  listAllResults,
  updateResultOverrides,
} from "@/db/repos/biomarker-results";
import { biomarkers } from "@/db/schema";
import { setupTestDb } from "@/db/test-utils";

import { listFlaggedBiomarkers, summarizeInRange } from "./attention";

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

async function seedSeries() {
  const glucoseId = await insertBiomarker();
  const ferritinId = await insertBiomarker({
    slug: "ferritin",
    name: "Ferritin",
    category: "vitamins",
    canonicalUnit: "ug/L",
    molarMassGMol: null,
  });
  const hemoglobinId = await insertBiomarker({
    slug: "hemoglobin",
    name: "Hemoglobin",
    category: "cbc",
    canonicalUnit: "g/L",
    molarMassGMol: null,
  });
  const db = getDb();
  await insertResults(db, [
    // Glucose: latest draw above range (+22% vs previous — under the delta
    // threshold), so exactly one out_of_range flag.
    {
      biomarkerId: glucoseId,
      measuredOn: "2026-01-10",
      value: 5.0,
      unit: "mmol/L",
      refLow: 3.9,
      refHigh: 5.5,
    },
    {
      biomarkerId: glucoseId,
      measuredOn: "2026-02-10",
      value: 6.1,
      unit: "mmol/L",
      refLow: 3.9,
      refHigh: 5.5,
    },
    // Ferritin: single in-range draw — no flags.
    {
      biomarkerId: ferritinId,
      measuredOn: "2026-02-10",
      value: 80,
      unit: "ug/L",
      refLow: 30,
      refHigh: 400,
    },
    // Hemoglobin: no reference ranges, but a +30% jump on the latest draw.
    {
      biomarkerId: hemoglobinId,
      measuredOn: "2026-01-10",
      value: 100,
      unit: "g/L",
    },
    {
      biomarkerId: hemoglobinId,
      measuredOn: "2026-02-10",
      value: 130,
      unit: "g/L",
    },
  ]);
}

describe("listFlaggedBiomarkers", () => {
  it("flags only biomarkers whose latest draw is flagged, in catalog order", async () => {
    await seedSeries();

    const flagged = await listFlaggedBiomarkers(getDb());
    expect(flagged.map((entry) => entry.slug)).toEqual([
      "hemoglobin",
      "glucose",
    ]);
    expect(flagged[0].flags.map((flag) => flag.kind)).toEqual(["big_delta"]);
    expect(flagged[1].flags.map((flag) => flag.kind)).toEqual([
      "out_of_range",
    ]);
    expect(flagged[1].flags[0].message).toBe(
      "Above reference range: 6.1 (ref 3.9–5.5)",
    );
  });

  it("honors a user override that brings the latest draw back in range", async () => {
    await seedSeries();
    const db = getDb();
    const results = await listAllResults(db);
    const latest = results.find(
      (result) => result.measuredOn === "2026-02-10" && result.value === 6.1,
    )!;
    await updateResultOverrides(db, latest.id, { value: 5.0 });

    const flagged = await listFlaggedBiomarkers(db);
    expect(flagged.map((entry) => entry.slug)).toEqual(["hemoglobin"]);
  });

  it("returns an empty array when no biomarker is measured", async () => {
    await insertBiomarker();
    expect(await listFlaggedBiomarkers(getDb())).toEqual([]);
  });
});

describe("summarizeInRange", () => {
  it("counts the latest draw per biomarker by flag", async () => {
    await seedSeries();

    expect(await summarizeInRange(getDb())).toEqual({
      measured: 3,
      inRange: 1,
      outOfRange: 1,
      unknown: 1,
    });
  });

  it("returns zeros when nothing is measured", async () => {
    await insertBiomarker();
    expect(await summarizeInRange(getDb())).toEqual({
      measured: 0,
      inRange: 0,
      outOfRange: 0,
      unknown: 0,
    });
  });
});
