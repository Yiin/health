import { describe, expect, it } from "vitest";

import { insertWorkouts } from "@/db/repos/workouts";
import type { NewWorkout } from "@/db/schema";
import { setupTestDb, TEST_DATABASE_URL } from "@/db/test-utils";

import { GET } from "./route";

process.env.DATABASE_URL = TEST_DATABASE_URL;

const getDb = setupTestDb();

const row = (overrides: Partial<NewWorkout> = {}): NewWorkout => ({
  startedAt: new Date("2026-01-10T07:30:00Z"),
  endedAt: new Date("2026-01-10T08:15:00Z"),
  type: "run",
  durationS: 2700,
  distanceM: 8200,
  calories: 510,
  avgHr: 148,
  maxHr: 171,
  source: "garmin",
  raw: { private: "source payload not for the API" },
  ...overrides,
});

function getWorkouts(query = "") {
  return GET(new Request(`http://localhost/api/workouts${query}`));
}

interface WorkoutJson {
  id: string;
  startedAt: string;
  endedAt: string | null;
  type: string;
  durationS: number | null;
  distanceM: number | null;
  calories: number | null;
  avgHr: number | null;
  maxHr: number | null;
  source: string;
  raw?: unknown;
}

async function workoutsJson(query = "") {
  const response = await getWorkouts(query);
  return {
    status: response.status,
    body: (await response.json()) as {
      workouts?: WorkoutJson[];
      error?: string;
    },
  };
}

describe("GET /api/workouts", () => {
  it("lists workouts most recent first, without the raw payload", async () => {
    await insertWorkouts(getDb(), [
      row(),
      row({
        startedAt: new Date("2026-01-12T18:00:00Z"),
        type: "strength",
        distanceM: null,
        avgHr: 112,
      }),
      row({
        startedAt: new Date("2026-01-08T06:00:00Z"),
        type: "ride",
        distanceM: 31200,
      }),
    ]);

    const { status, body } = await workoutsJson();
    expect(status).toBe(200);
    expect(body.workouts!.map((w) => w.type)).toEqual([
      "strength",
      "run",
      "ride",
    ]);
    const run = body.workouts![1];
    expect(run).toMatchObject({
      startedAt: "2026-01-10T07:30:00.000Z",
      durationS: 2700,
      distanceM: 8200,
      avgHr: 148,
      maxHr: 171,
      source: "garmin",
    });
    expect(run.raw).toBeUndefined();
  });

  it("filters by from (inclusive) and to (exclusive)", async () => {
    await insertWorkouts(getDb(), [
      row({ startedAt: new Date("2026-01-01T07:00:00Z") }),
      row({ startedAt: new Date("2026-01-15T07:00:00Z") }),
      row({ startedAt: new Date("2026-02-01T07:00:00Z") }),
    ]);

    const { body } = await workoutsJson("?from=2026-01-01&to=2026-02-01");
    expect(body.workouts!.map((w) => w.startedAt.slice(0, 10))).toEqual([
      "2026-01-15",
      "2026-01-01",
    ]);
  });

  it("caps the list at limit", async () => {
    await insertWorkouts(getDb(), [
      row({ startedAt: new Date("2026-01-01T07:00:00Z") }),
      row({ startedAt: new Date("2026-01-02T07:00:00Z") }),
      row({ startedAt: new Date("2026-01-03T07:00:00Z") }),
    ]);

    const { body } = await workoutsJson("?limit=2");
    expect(body.workouts!).toHaveLength(2);
    expect(body.workouts![0].startedAt.slice(0, 10)).toBe("2026-01-03");
  });

  it("rejects malformed dates and limits", async () => {
    expect((await workoutsJson("?from=soon")).status).toBe(400);
    expect((await workoutsJson("?to=2026-13-01")).status).toBe(400);
    expect((await workoutsJson("?limit=0")).status).toBe(400);
    expect((await workoutsJson("?limit=1001")).status).toBe(400);
    expect((await workoutsJson("?limit=two")).status).toBe(400);
  });

  it("returns an empty list when nothing matches", async () => {
    const { status, body } = await workoutsJson();
    expect(status).toBe(200);
    expect(body.workouts).toEqual([]);
  });
});
