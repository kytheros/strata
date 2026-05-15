import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("run-eval orchestrator skeleton", () => {
  test("exits cleanly when fixtures dir is empty", () => {
    // Point at a guaranteed-empty tmpdir; the shared fixtures root is populated
    // by T15 and other fixture sets, so it cannot be used as "empty".
    const emptyDir = mkdtempSync(join(tmpdir(), "strata-eval-empty-"));
    try {
      const env = {
        ...process.env,
        STRATA_EXTRACTION_PROVIDER: "gemini",
        // Harness requires this env var to be set; when there are no fixtures,
        // the Gemini API is never actually called.
        GEMINI_API_KEY: "no-fixtures-no-api-call",
      };
      const result = spawnSync(
        "npx",
        ["tsx", "evals/distillation-e2e/run-eval.ts", "--fixtures-dir", emptyDir],
        { env, encoding: "utf8", cwd: process.cwd(), shell: true }
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/loaded 0 fixtures/i);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
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
