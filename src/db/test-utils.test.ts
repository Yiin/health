import { sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { setupTestDb } from "./test-utils";

const getDb = setupTestDb();

describe("setupTestDb", () => {
  test("applies migrations: pgcrypto's gen_random_uuid() is usable", async () => {
    const rows = (await getDb().execute(
      sql`select gen_random_uuid()::text as id`,
    )) as unknown as { id: string }[];
    expect(rows[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("truncation hooks run cleanly across tests", async () => {
    const rows = (await getDb().execute(sql`select 1 as one`)) as unknown as {
      one: number;
    }[];
    expect(rows[0]?.one).toBe(1);
  });
});
