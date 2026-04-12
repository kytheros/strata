import { describe, it, expect } from "vitest";
import { createServer } from "../src/server.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("createServer — exported fields", () => {
  it("exposes semanticBridge on CreateServerResult", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "strata-server-exports-"));
    const result = createServer({ dataDir });
    expect(result.semanticBridge).toBeDefined();
    expect(typeof result.semanticBridge.search).toBe("function");
  });
});
