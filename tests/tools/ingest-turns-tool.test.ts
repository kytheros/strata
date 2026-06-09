import { describe, it, expect } from "vitest";
import { createServer } from "../../src/server.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mkTmp() {
  return mkdtempSync(join(tmpdir(), "strata-ingest-tool-"));
}

describe("ingest_turns MCP tool", () => {
  it("is registered with a strict schema and writes a session", async () => {
    const srv = createServer({ dataDir: mkTmp() });
    const tool = (srv.server as any)._registeredTools["ingest_turns"];
    expect(tool).toBeDefined();
    // strict schema rejects unknown keys
    expect(tool.inputSchema.safeParse({ sessionId: "s", messages: [{ speaker: "user", content: "hi" }], bogus: 1 }).success).toBe(false);
    // valid payload accepted
    expect(tool.inputSchema.safeParse({ sessionId: "s", messages: [{ speaker: "user", content: "hi" }] }).success).toBe(true);

    const res = await srv.ingestTurns({ sessionId: "s", userId: "default", messages: [
      { speaker: "user", content: "remember my db is postgres on rds" },
      { speaker: "assistant", content: "noted: postgres on rds" },
    ]});
    expect(res.turnsWritten).toBe(2);
    expect(res.chunksWritten).toBeGreaterThanOrEqual(1);
  });

  it("writes turns even when called immediately after createServer (no manual initEmbedder)", async () => {
    const srv = createServer({ dataDir: mkTmp() });
    const res = await srv.ingestTurns({ sessionId: "race", userId: "default",
      messages: [{ speaker: "assistant", content: "the cache ttl is 5 minutes" }] });
    expect(res.turnsWritten).toBe(1); // would be 0 if denseTurnStore were read before initEmbedder resolved
  });
});
