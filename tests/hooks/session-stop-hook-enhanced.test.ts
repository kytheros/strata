/**
 * Tests for SessionStop hook — enhanced extraction.
 *
 * Validates:
 * - Exit 0 when no transcript is provided (baseline)
 * - Exit 0 when GEMINI_API_KEY is set but no transcript
 * - Never crashes regardless of environment
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";

const projectRoot = join(import.meta.dirname, "../..").replace(/\\/g, "/");
const hookScript = join(projectRoot, "src/hooks/session-stop-hook.ts").replace(/\\/g, "/");

describe("SessionStop hook — enhanced extraction", () => {
  it("still exits 0 when no transcript is provided", () => {
    const result = spawnSync("npx", ["tsx", hookScript], {
      input: JSON.stringify({}),
      env: { ...process.env },
      timeout: 15000,
      encoding: "utf-8",
      shell: true,
    });
    expect(result.status).toBe(0);
  });

  it("still exits 0 when GEMINI_API_KEY is set but no transcript", () => {
    const result = spawnSync("npx", ["tsx", hookScript], {
      input: JSON.stringify({}),
      env: { ...process.env, GEMINI_API_KEY: "fake-key-for-test" },
      timeout: 15000,
      encoding: "utf-8",
      shell: true,
    });
    expect(result.status).toBe(0);
  });
});
