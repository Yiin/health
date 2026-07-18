// Repository for ai_insights: newest-first feed queries. Pure functions
// taking the db handle as their first argument — no module-level state, so
// they work with both the app singleton (src/db/index.ts) and test databases.
// Insights are written by the worker's summarizing stage (worker/summarize.ts)
// and by listInsightsForBiomarker's siblings in repos/biomarker-results.ts.

import { desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { aiInsights, type AiInsight } from "../schema";
import type * as schema from "../schema";

type Db = PostgresJsDatabase<typeof schema>;

/**
 * The insights feed, newest first. `id` breaks created_at ties so pagination
 * is stable (not chronological within one timestamp — uuids are random).
 * /insights pages through it; the overview takes the first few.
 */
export async function listInsights(
  db: Db,
  options: { limit?: number; offset?: number } = {},
): Promise<AiInsight[]> {
  return db
    .select()
    .from(aiInsights)
    .orderBy(desc(aiInsights.createdAt), desc(aiInsights.id))
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);
}
