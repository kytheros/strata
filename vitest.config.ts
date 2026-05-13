import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "evals/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Serialize test files to prevent concurrent Postgres tests from racing on
    // the shared database. Each pg-* test file does beforeEach(dropSchema +
    // createSchema), which requires exclusive access to avoid duplicate-key
    // errors from concurrent migrations on the shared PG_URL database.
    fileParallelism: false,
  },
});
