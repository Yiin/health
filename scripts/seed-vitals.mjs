// Demo vitals/workouts seed runner (`npm run db:seed:vitals`).
//
// Fills daily_metrics + workouts with deterministic synthetic data (~2.5
// years, two sources for steps and resting HR) so the /vitals page has
// something to render before real wearable exports are ingested. Anchored on
// today at run time so the recent 90-day window is always populated.
// Idempotent: daily_metrics upserts on its (metric_on, metric, source) PK,
// workouts skip on the (started_at, type, source) unique index.
//
// Plain .mjs (like scripts/migrate.mjs) so tsc/Next ignore it.

import postgres from "postgres";

// Mirror drizzle-kit's convenience: pick up DATABASE_URL from .env when the
// shell did not provide one. Existing env vars win (loadEnvFile does not
// override).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, DATABASE_URL may come from the environment
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[seed-vitals] DATABASE_URL environment variable is not set");
  process.exit(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 912; // ~2.5 years

// Deterministic PRNG (mulberry32) — re-seeding produces identical values.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260718);
const between = (lo, hi) => lo + rand() * (hi - lo);

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

const metricRows = [];
const metric = (metricOn, name, source, value, unit) =>
  metricRows.push({
    metric_on: metricOn,
    metric: name,
    source,
    value: Math.round(value * 10) / 10,
    unit,
  });

const workoutRows = [];
const WORKOUT_TYPES = ["run", "ride", "strength", "swim"];

const today = new Date();
today.setUTCHours(0, 0, 0, 0);

for (let age = DAYS; age >= 1; age--) {
  const date = new Date(today.getTime() - age * DAY_MS);
  const day = isoDay(date);

  metric(day, "steps", "google_fit", between(4500, 12500), "count");
  if (age <= 400) {
    // A second, slightly divergent source for the selector demo.
    metric(day, "steps", "garmin", between(4800, 13000), "count");
    metric(day, "resting_hr", "garmin", between(53, 61), "bpm");
  }
  metric(day, "hrv_ms", "oura", between(38, 78), "ms");
  metric(day, "resting_hr", "oura", between(50, 58), "bpm");

  const total = between(360, 540);
  const deep = total * between(0.14, 0.22);
  const rem = total * between(0.18, 0.25);
  const light = total - deep - rem;
  metric(day, "sleep_total_min", "oura", total, "min");
  metric(day, "sleep_deep_min", "oura", deep, "min");
  metric(day, "sleep_rem_min", "oura", rem, "min");
  metric(day, "sleep_light_min", "oura", light, "min");

  if (age % 3 === 0) {
    const type = WORKOUT_TYPES[(age / 3) % WORKOUT_TYPES.length];
    const startedAt = new Date(date.getTime() + 17 * 60 * 60 * 1000);
    const durationS = Math.round(between(1800, 5400));
    workoutRows.push({
      started_at: startedAt,
      ended_at: new Date(startedAt.getTime() + durationS * 1000),
      type,
      duration_s: durationS,
      distance_m:
        type === "strength"
          ? null
          : Math.round(between(4, type === "ride" ? 40 : 12) * 1000),
      calories: Math.round(between(250, 800)),
      avg_hr: Math.round(between(115, 155)),
      max_hr: Math.round(between(160, 185)),
      source: "garmin",
      raw: null,
    });
  }
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  // Chunked multi-row inserts stay well under the 65535-parameter limit.
  const CHUNK = 2000;
  for (let i = 0; i < metricRows.length; i += CHUNK) {
    const chunk = metricRows.slice(i, i + CHUNK);
    await sql`
      insert into daily_metrics ${sql(chunk)}
      on conflict (metric_on, metric, source) do update set
        value = excluded.value,
        unit = excluded.unit
    `;
  }
  for (let i = 0; i < workoutRows.length; i += CHUNK) {
    const chunk = workoutRows.slice(i, i + CHUNK);
    await sql`
      insert into workouts ${sql(chunk)}
      on conflict (started_at, type, source) do nothing
    `;
  }
  console.log(
    `[seed-vitals] upserted ${metricRows.length} metric rows, inserted ${workoutRows.length} workouts (${isoDay(new Date(today.getTime() - DAYS * DAY_MS))} → ${isoDay(today)})`,
  );
} catch (error) {
  console.error("[seed-vitals] failed:", error);
  process.exitCode = 1;
} finally {
  await sql.end();
}
