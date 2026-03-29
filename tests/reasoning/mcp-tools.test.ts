/**
 * Reasoning MCP tools smoke test.
 *
 * Verifies that createServer() succeeds with the two reasoning tools
 * (reason_over_query, get_search_procedure) registered without errors.
 * Does not invoke the tools — only checks that registration and server
 * construction complete successfully.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type CreateServerResult } from "../../src/server.js";

describe("reasoning MCP tools registration", () => {
  let result: CreateServerResult | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    // Close any opened database connections
    if (result) {
      await result.storage.close();
      result = undefined;
    }
    // Clean up temp directory
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("createServer succeeds with reasoning tools registered", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "strata-reasoning-test-"));
    result = createServer({ dataDir: tmpDir });

    expect(result.server).toBeDefined();
    expect(result.storage).toBeDefined();
    expect(result.indexManager).toBeDefined();
    expect(result.init).toBeTypeOf("function");
  });

  it("returns expected CreateServerResult shape", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "strata-reasoning-test-"));
    result = createServer({ dataDir: tmpDir });

    // Verify all expected properties exist on the result
    expect(result).toHaveProperty("server");
    expect(result).toHaveProperty("indexManager");
    expect(result).toHaveProperty("entityStore");
    expect(result).toHaveProperty("storage");
    expect(result).toHaveProperty("init");
    expect(result).toHaveProperty("startRealtimeWatcher");
    expect(result).toHaveProperty("stopRealtimeWatcher");
    expect(result).toHaveProperty("startIncrementalIndexer");
    expect(result).toHaveProperty("stopIncrementalIndexer");
  });
});
