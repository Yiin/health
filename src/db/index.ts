import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL environment variable is not set");
}

// Singleton query client: postgres.js manages a connection pool internally,
// and Node module caching makes every import of this module share it.
const client = postgres(databaseUrl);

export const db = drizzle(client, { schema });
export type Db = typeof db;
