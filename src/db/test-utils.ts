import { fileURLToPath } from "node:url";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll } from "vitest";

import * as schema from "./schema";

/**
 * Shared helper for DB-backed (repository) tests.
 *
 * Tests run against the docker compose Postgres (`docker compose up -d db`,
 * published on 127.0.0.1:${DB_PORT:-5433}) using a dedicated database so they
 * never touch dev data. Override TEST_DATABASE_URL when the local port or
 * password differ from the .env.example defaults.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5433/health_test";

// Session-level advisory lock serializing migrators. Mirrors the constant in
// scripts/migrate.mjs — parallel vitest files each run their own beforeAll.
const MIGRATION_LOCK_ID = 7282011;

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

function databaseName(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`TEST_DATABASE_URL has no database name: ${url}`);
  }
  return name;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function createDatabaseIfMissing(url: string): Promise<void> {
  const name = databaseName(url);
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${name}`;
    if (rows.length === 0) {
      await admin.unsafe(`create database ${quoteIdentifier(name)}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Registers the test-database lifecycle hooks for the calling test file:
 * creates the database if missing, applies all migrations in beforeAll,
 * truncates every public table in afterEach, and closes the pool in afterAll.
 * The drizzle migration journal lives in the `drizzle` schema and is
 * deliberately left untouched.
 *
 * Returns a getter for the migrated db handle (valid inside tests/hooks).
 */
export function setupTestDb(): () => PostgresJsDatabase<typeof schema> {
  let sql: postgres.Sql | undefined;
  let db: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    await createDatabaseIfMissing(TEST_DATABASE_URL);
    const setup = postgres(TEST_DATABASE_URL, { max: 1 });
    try {
      await setup.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
      await migrate(drizzle(setup), { migrationsFolder });
    } finally {
      // Closing the session releases the advisory lock.
      await setup.end();
    }
    sql = postgres(TEST_DATABASE_URL);
    db = drizzle(sql, { schema });
  }, 60_000);

  afterEach(async () => {
    if (!sql) return;
    const tables = await sql<{ tablename: string }[]>`
      select tablename from pg_tables where schemaname = 'public'
    `;
    if (tables.length === 0) return;
    const list = tables.map((t) => quoteIdentifier(t.tablename)).join(", ");
    await sql.unsafe(`truncate table ${list} restart identity cascade`);
  });

  afterAll(async () => {
    await sql?.end();
  });

  return () => db;
}
