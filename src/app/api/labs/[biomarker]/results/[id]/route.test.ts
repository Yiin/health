import { describe, expect, it } from "vitest";

import { biomarkers } from "@/db/schema";
import {
  getResultById,
  getTrend,
  insertResults,
} from "@/db/repos/biomarker-results";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";

import { PATCH } from "./route";

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

/** Seeds one glucose draw (6.1 mmol/L, flagged high vs 3.9–5.5). */
async function seedResult(): Promise<string> {
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
      labName: "UAB Hila",
      flag: "high",
    },
  ]);
  const [point] = await getTrend(db, "glucose");
  return point.id;
}

function patch(biomarker: string, id: string, body: string) {
  return PATCH(
    new Request(`http://localhost/api/labs/${biomarker}/results/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ biomarker, id }) },
  );
}

describe("PATCH /api/labs/[biomarker]/results/[id]", () => {
  it("saves the edit as overrides, recomputes the flag, keeps raw columns", async () => {
    const id = await seedResult();

    const response = await patch("glucose", id, JSON.stringify({ value: 5.0 }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        id: string;
        value: number;
        unit: string;
        measuredOn: string;
        flag: string | null;
        edited: boolean;
        valueCanonical: number | null;
      };
    };
    expect(body.result).toMatchObject({
      id,
      value: 5.0,
      unit: "mmol/L",
      measuredOn: "2026-02-10",
      flag: "normal",
      edited: true,
      valueCanonical: 5.0,
    });

    // The extracted row is untouched; only user_overrides changed.
    const stored = await getResultById(getDb(), id);
    expect(stored?.value).toBe(6.1);
    expect(stored?.unit).toBe("mmol/L");
    expect(stored?.flag).toBe("high");
    expect(stored?.userOverrides).toEqual({ value: 5.0 });
  });

  it("recomputes the canonical value when the unit is edited", async () => {
    const id = await seedResult();
    const response = await patch(
      "glucose",
      id,
      JSON.stringify({ value: 100, unit: "mg/dL" }),
    );
    const body = (await response.json()) as {
      result: { valueCanonical: number | null; flag: string | null };
    };
    expect(body.result.valueCanonical).toBeCloseTo(5.55, 2);
    expect(body.result.flag).toBe("high");
  });

  it("rejects invalid bodies", async () => {
    const id = await seedResult();
    expect((await patch("glucose", id, "not json")).status).toBe(400);
    expect((await patch("glucose", id, "{}")).status).toBe(400);
    expect(
      (await patch("glucose", id, JSON.stringify({ value: "high" }))).status,
    ).toBe(400);
    expect(
      (await patch("glucose", id, JSON.stringify({ measuredOn: "2026-13-01" })))
        .status,
    ).toBe(400);
  });

  it("returns 404 for an unknown biomarker or result", async () => {
    const id = await seedResult();
    expect(
      (await patch("no-such", id, JSON.stringify({ value: 1 }))).status,
    ).toBe(404);
    expect(
      (
        await patch(
          "glucose",
          "00000000-0000-0000-0000-000000000000",
          JSON.stringify({ value: 1 }),
        )
      ).status,
    ).toBe(404);
  });

  it("returns 404 when the result belongs to a different biomarker", async () => {
    const id = await seedResult();
    await insertBiomarker({
      slug: "ferritin",
      name: "Ferritin",
      category: "vitamins",
      canonicalUnit: "ug/L",
      molarMassGMol: null,
    });
    expect(
      (await patch("ferritin", id, JSON.stringify({ value: 1 }))).status,
    ).toBe(404);
    // And nothing was written.
    expect((await getResultById(getDb(), id))?.userOverrides).toBeNull();
  });
});
