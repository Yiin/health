// Repository for workouts: idempotent insert and range listing. Pure
// functions taking the drizzle db handle as their first argument — no
// module-level state, so they work with both the app singleton
// (src/db/index.ts) and test databases.

import { and, desc, gte, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { workouts, type NewWorkout, type Workout } from "../schema";
import type * as schema from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

export interface InsertWorkoutsOutcome {
  inserted: number;
  skipped: number;
}

/**
 * Persists workouts. Rows conflicting with the (started_at, type, source)
 * unique index are skipped, so re-importing the same export is a no-op.
 */
export async function insertWorkouts(
  db: Db,
  rows: NewWorkout[],
): Promise<InsertWorkoutsOutcome> {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const inserted = await db
    .insert(workouts)
    .values(rows)
    .onConflictDoNothing({
      target: [workouts.startedAt, workouts.type, workouts.source],
    })
    .returning({ id: workouts.id });
  return { inserted: inserted.length, skipped: rows.length - inserted.length };
}

/**
 * Workouts with `from <= started_at < to` (either bound optional), most
 * recent first.
 */
export async function listWorkouts(
  db: Db,
  range: { from?: Date; to?: Date } = {},
): Promise<Workout[]> {
  const conditions = [];
  if (range.from) conditions.push(gte(workouts.startedAt, range.from));
  if (range.to) conditions.push(lt(workouts.startedAt, range.to));

  return db
    .select()
    .from(workouts)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(workouts.startedAt));
}
