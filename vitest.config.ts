import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" -> "./src/*" so tests can import app modules.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // DB-backed test files (src/db/**) all share one test database and
    // truncate every table in an afterEach hook (see src/db/test-utils.ts).
    // Running files in parallel would interleave those truncations with other
    // files' assertions, so serialize test files.
    fileParallelism: false,
  },
});
