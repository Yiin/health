// Migration entrypoint. Containers run this at start (see the web/worker
// commands in docker-compose.yml); it applies the ./drizzle migrations to
// DATABASE_URL and exits non-zero on failure so a container never boots
// against an unmigrated database.
//
// Uses drizzle-orm's migrator instead of drizzle-kit so the production image
// needs no dev dependencies. drizzle-orm and postgres are zero-dependency
// packages and are copied into the runner image explicitly (see Dockerfile).

import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Session-level advisory lock serializing migrators: web and worker start
// together and must not apply migrations concurrently. Mirrors the constant
// in src/db/test-utils.ts.
const MIGRATION_LOCK_ID = 7282011;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[migrate] DATABASE_URL environment variable is not set");
  process.exit(1);
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_ID})`);
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("[migrate] migrations applied");
} catch (error) {
  console.error("[migrate] failed:", error);
  process.exitCode = 1;
} finally {
  // Closing the session releases the advisory lock.
  await sql.end();
}
