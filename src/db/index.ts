import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

let cached: PostgresJsDatabase<typeof schema> | undefined;

function createDb(): PostgresJsDatabase<typeof schema> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }
  // postgres.js manages a connection pool internally; `cached` + Node module
  // caching make every use of `db` share it.
  return drizzle(postgres(databaseUrl), { schema });
}

// Lazily-initialized singleton. `next build` imports route/page modules to
// collect their config in an environment without DATABASE_URL (e.g. the
// Docker builder stage), so connecting at import time would fail the build —
// the first property access happens at request time instead.
export const db: PostgresJsDatabase<typeof schema> = new Proxy(
  {} as PostgresJsDatabase<typeof schema>,
  {
    get(_target, prop) {
      cached ??= createDb();
      const value = Reflect.get(cached, prop);
      return typeof value === "function" ? value.bind(cached) : value;
    },
  },
);
export type Db = typeof db;
