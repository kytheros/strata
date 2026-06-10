import { describe, it, expect } from "vitest";
import { chunkSession } from "../../src/indexing/chunk-session.js";
import type { ParsedSession } from "../../src/parsers/session-parser.js";

function session(messages: ParsedSession["messages"]): ParsedSession {
  return { sessionId: "s1", project: "p", cwd: "", gitBranch: "", messages, startTime: 0, endTime: 0 };
}

describe("chunkSession", () => {
  it("groups a user→assistant pair into a single 'mixed' chunk", () => {
    const chunks = chunkSession(session([
      { role: "user", text: "how do I deploy", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: "", uuid: "u1" },
      { role: "assistant", text: "run wrangler deploy", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: "", uuid: "a1" },
    ]));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].role).toBe("mixed");
    expect(chunks[0].text).toContain("wrangler deploy");
    expect(typeof chunks[0].messageIndex).toBe("number");
  });
});
