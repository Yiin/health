import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

// Lazy singletons. `next build` imports route modules (and therefore this
// one) without a DATABASE_URL in the environment, so neither reading the env
// var nor constructing the client may happen at import time. postgres.js
// manages a connection pool internally and connects lazily on first query;
// Node module caching makes every importer share the one pool.
let client: postgres.Sql | undefined;

export function getSqlClient(): postgres.Sql {
  if (!client) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    client = postgres(databaseUrl);
  }
  return client;
}

export type Db = PostgresJsDatabase<typeof schema>;

let database: Db | undefined;

export function getDb(): Db {
  if (!database) {
    database = drizzle(getSqlClient(), { schema });
  }
  return database;
}

// `db` is the same lazily-initialized singleton behind a proxy, for call
// sites that import it as a value instead of calling getDb().
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const cached = getDb();
    const value = Reflect.get(cached, prop);
    return typeof value === "function" ? value.bind(cached) : value;
  },
});
