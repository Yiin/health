import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" -> "./src/*" so tests can import app modules.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
