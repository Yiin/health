import { describe, expect, it } from "vitest";

import { aiInsights } from "../schema";
import { setupTestDb } from "../test-utils";

import { listInsights } from "./insights";

const getDb = setupTestDb();

async function insertInsight(
  overrides: Partial<typeof aiInsights.$inferInsert> = {},
) {
  const rows = await getDb()
    .insert(aiInsights)
    .values({
      kind: "post_ingestion",
      title: "Ferritin is rising",
      bodyMd: "Ferritin rose 40% versus the previous draw.",
      sourceRefs: [{ kind: "biomarker", id: "ferritin" }],
      ...overrides,
    })
    .returning();
  return rows[0]!;
}

describe("listInsights", () => {
  it("returns insights newest first with their source refs", async () => {
    const older = await insertInsight({
      title: "Older",
      createdAt: new Date("2026-01-01T10:00:00Z"),
    });
    const newer = await insertInsight({
      title: "Newer",
      kind: "anomaly",
      createdAt: new Date("2026-02-01T10:00:00Z"),
    });

    const rows = await listInsights(getDb());
    expect(rows.map((row) => row.id)).toEqual([newer.id, older.id]);
    expect(rows[0]).toMatchObject({
      kind: "anomaly",
      title: "Newer",
      sourceRefs: [{ kind: "biomarker", id: "ferritin" }],
    });
  });

  it("paginates with limit and offset", async () => {
    await insertInsight({ createdAt: new Date("2026-01-01T10:00:00Z") });
    await insertInsight({ createdAt: new Date("2026-02-01T10:00:00Z") });
    await insertInsight({ createdAt: new Date("2026-03-01T10:00:00Z") });

    const page1 = await listInsights(getDb(), { limit: 2 });
    const page2 = await listInsights(getDb(), { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    expect(page2[0].createdAt.toISOString()).toBe("2026-01-01T10:00:00.000Z");
  });

  it("returns an empty array when there are no insights", async () => {
    expect(await listInsights(getDb())).toEqual([]);
  });
});
