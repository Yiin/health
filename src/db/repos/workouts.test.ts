import { describe, expect, it } from "vitest";

import { setupTestDb } from "../test-utils";
import { insertWorkouts, listWorkouts } from "./workouts";
import type { NewWorkout } from "../schema";

const getDb = setupTestDb();

const row = (overrides: Partial<NewWorkout> = {}): NewWorkout => ({
  startedAt: new Date("2026-01-10T07:30:00Z"),
  endedAt: new Date("2026-01-10T08:15:00Z"),
  type: "run",
  durationS: 2700,
  distanceM: 8200,
  calories: 520,
  avgHr: 148,
  maxHr: 171,
  source: "garmin",
  raw: { original: "record" },
  ...overrides,
});

describe("insertWorkouts", () => {
  it("inserts workouts with all fields", async () => {
    const db = getDb();
    expect(await insertWorkouts(db, [row()])).toEqual({
      inserted: 1,
      skipped: 0,
    });

    const [workout] = await listWorkouts(db);
    expect(workout).toMatchObject({
      startedAt: new Date("2026-01-10T07:30:00Z"),
      endedAt: new Date("2026-01-10T08:15:00Z"),
      type: "run",
      durationS: 2700,
      distanceM: 8200,
      calories: 520,
      avgHr: 148,
      maxHr: 171,
      source: "garmin",
      raw: { original: "record" },
    });
    expect(workout.id).toBeTruthy();
  });

  it("accepts minimal rows (nullable fields absent)", async () => {
    const db = getDb();
    await insertWorkouts(db, [
      {
        startedAt: new Date("2026-01-10T07:30:00Z"),
        type: "walk",
        source: "google_fit",
      },
    ]);

    const [workout] = await listWorkouts(db);
    expect(workout).toMatchObject({
      type: "walk",
      source: "google_fit",
      endedAt: null,
      durationS: null,
      distanceM: null,
      raw: null,
    });
  });

  it("skips duplicates on (started_at, type, source) — re-import is a no-op", async () => {
    const db = getDb();
    expect(await insertWorkouts(db, [row()])).toEqual({
      inserted: 1,
      skipped: 0,
    });
    expect(await insertWorkouts(db, [row()])).toEqual({
      inserted: 0,
      skipped: 1,
    });
    // ...including duplicates inside one batch.
    expect(await insertWorkouts(db, [row(), row()])).toEqual({
      inserted: 0,
      skipped: 2,
    });
    // Same start+type from another source is a different workout.
    expect(await insertWorkouts(db, [row({ source: "strava" })])).toEqual({
      inserted: 1,
      skipped: 0,
    });

    expect(await listWorkouts(db)).toHaveLength(2);
  });

  it("is a no-op on an empty batch", async () => {
    expect(await insertWorkouts(getDb(), [])).toEqual({
      inserted: 0,
      skipped: 0,
    });
  });
});

describe("listWorkouts", () => {
  it("lists most recent first", async () => {
    const db = getDb();
    await insertWorkouts(db, [
      row({ startedAt: new Date("2026-01-10T07:30:00Z") }),
      row({ startedAt: new Date("2026-01-12T07:30:00Z") }),
      row({ startedAt: new Date("2026-01-11T07:30:00Z") }),
    ]);

    const list = await listWorkouts(db);
    expect(list.map((w) => w.startedAt.toISOString())).toEqual([
      "2026-01-12T07:30:00.000Z",
      "2026-01-11T07:30:00.000Z",
      "2026-01-10T07:30:00.000Z",
    ]);
  });

  it("treats from as inclusive and to as exclusive", async () => {
    const db = getDb();
    await insertWorkouts(db, [
      row({ startedAt: new Date("2026-01-01T00:00:00Z") }),
      row({ startedAt: new Date("2026-01-15T00:00:00Z") }),
      row({ startedAt: new Date("2026-02-01T00:00:00Z") }),
    ]);

    const list = await listWorkouts(db, {
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2026-02-01T00:00:00Z"),
    });
    expect(list.map((w) => w.startedAt.toISOString())).toEqual([
      "2026-01-15T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });
});
