import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

describe("run-eval orchestrator skeleton", () => {
  test("exits cleanly when fixtures dir is empty", () => {
    const env = {
      ...process.env,
      STRATA_EXTRACTION_PROVIDER: "gemini",
      // Harness requires this env var to be set; when there are no fixtures,
      // the Gemini API is never actually called.
      GEMINI_API_KEY: "no-fixtures-no-api-call",
    };
    const result = spawnSync(
      "npx",
      ["tsx", "evals/distillation-e2e/run-eval.ts", "--fixtures-dir", "evals/distillation-e2e/fixtures"],
      { env, encoding: "utf8", cwd: process.cwd(), shell: true }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/loaded 0 fixtures/i);
  });

  test("exits non-zero without STRATA_EXTRACTION_PROVIDER", () => {
    const env = { ...process.env };
    delete env.STRATA_EXTRACTION_PROVIDER;
    const result = spawnSync(
      "npx",
      ["tsx", "evals/distillation-e2e/run-eval.ts"],
      { env, encoding: "utf8", cwd: process.cwd(), shell: true }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/STRATA_EXTRACTION_PROVIDER/);
  });
});
