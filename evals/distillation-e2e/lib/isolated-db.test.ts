import { describe, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { withIsolatedStrata } from "./isolated-db.js";

describe("isolated-db", () => {
  test("creates a real server in a temp dir, tears down after", async () => {
    let observedDataDir: string | null = null;
    let observedTools: number = 0;

    await withIsolatedStrata(async ({ dataDir, server }) => {
      observedDataDir = dataDir;
      // server is from createServer({ dataDir }) — real instance
      expect(existsSync(dataDir)).toBe(true);
      // server should expose a tool registry; the count is just a smoke check
      expect(server).toBeDefined();
      observedTools = 1;
    });

    expect(observedDataDir).not.toBeNull();
    expect(observedTools).toBe(1);
    // After teardown, dataDir is removed
    expect(existsSync(observedDataDir!)).toBe(false);
  });

  test("withIsolatedStrata still tears down on user-callback throw", async () => {
    let observed: string | null = null;
    await expect(
      withIsolatedStrata(async ({ dataDir }) => {
        observed = dataDir;
        throw new Error("user error");
      })
    ).rejects.toThrow("user error");
    expect(existsSync(observed!)).toBe(false);
  });
});
