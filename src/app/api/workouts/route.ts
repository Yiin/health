import { db } from "@/db";
import { listWorkouts } from "@/db/repos/workouts";

/**
 * Workout history for the vitals dashboard, most recent first.
 *
 *   GET /api/workouts?from=2025-01-01&to=2026-01-01&limit=100
 *
 * `from` (inclusive) / `to` (exclusive) accept YYYY-MM-DD or full ISO
 * timestamps; `limit` caps the list (default 200, max 1000). The bulky `raw`
 * source payload stays in the DB — the table only needs the display fields.
 * Auth is enforced by the proxy matcher (same as the other /api routes).
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  const range: { from?: Date; to?: Date } = {};
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return Response.json(
        { error: `${key} must be a YYYY-MM-DD date or ISO timestamp` },
        { status: 400 },
      );
    }
    range[key] = date;
  }

  let limit = 200;
  const limitParam = params.get("limit");
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return Response.json(
        { error: "limit must be an integer between 1 and 1000" },
        { status: 400 },
      );
    }
  }

  const workouts = await listWorkouts(db, range);
  return Response.json({
    workouts: workouts.slice(0, limit).map((workout) => ({
      id: workout.id,
      startedAt: workout.startedAt,
      endedAt: workout.endedAt,
      type: workout.type,
      durationS: workout.durationS,
      distanceM: workout.distanceM,
      calories: workout.calories,
      avgHr: workout.avgHr,
      maxHr: workout.maxHr,
      source: workout.source,
    })),
  });
}
