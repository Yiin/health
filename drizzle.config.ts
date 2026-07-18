import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Host-side URL for `db:migrate` / `db:studio` (drizzle-kit auto-loads
    // .env; .env.example points DATABASE_URL at the compose db's loopback
    // port). Containers never use this — they run scripts/migrate.mjs.
    url:
      process.env.DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5433/health",
  },
});
