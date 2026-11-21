// Unit tests (vitest): pure TypeScript only — models, stores, the file layer and
// the in-memory FileBackend. Run with `npm test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
