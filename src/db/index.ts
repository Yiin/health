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

// Same lazily-initialized singleton as a drop-in handle for modules that
// import `db` directly. The first property access happens at request time,
// so importing route/page modules at build time still never connects.
export const db: Db = new Proxy({} as Db, {
  get(_target, prop) {
    const database = getDb();
    const value = Reflect.get(database, prop);
    return typeof value === "function" ? value.bind(database) : value;
  },
});
