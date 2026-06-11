/**
 * Heuristic knowledge extractor tests.
 *
 * The fragment-title regressions come straight from the founder corpus
 * audit (2026-06-11): 36% of knowledge summaries were mid-sentence
 * punctuation fragments. Two regex defects caused them:
 *   1. No word boundaries — "toFixed(2)" matched the SOLUTION keyword
 *      "fixed" and produced summaries like "(2), 372 med: (6 / sp".
 *   2. Unanchored capture start — "resolved, per scope discipline)"
 *      produced the summary ", per scope discipline)".
 */

import { describe, it, expect } from "vitest";
import { extractKnowledge } from "../../src/knowledge/knowledge-extractor.js";
import type { ParsedSession, SessionMessage } from "../../src/parsers/session-parser.js";

function msg(role: "user" | "assistant", text: string): SessionMessage {
  return {
    role,
    text,
    toolNames: [],
    toolInputSnippets: [],
    hasCode: text.includes("```"),
    timestamp: "2026-06-12T09:00:00Z",
    uuid: `uuid-${Math.random()}`,
  };
}

function session(messages: SessionMessage[]): ParsedSession {
  return {
    sessionId: "sess-test",
    project: "test-project",
    startTime: Date.UTC(2026, 5, 12, 9, 0, 0),
    endTime: Date.UTC(2026, 5, 12, 10, 0, 0),
    messages,
  } as ParsedSession;
}

describe("extractKnowledge — solution extraction", () => {
  it("extracts a clean solution summary", () => {
    const entries = extractKnowledge(
      session([
        msg("assistant", "Fixed: the connection pool leak was caused by unclosed sockets in the retry path."),
      ])
    );
    const solutions = entries.filter((e) => e.type === "solution");
    expect(solutions).toHaveLength(1);
    expect(solutions[0].summary).toBe(
      "the connection pool leak was caused by unclosed sockets in the retry path"
    );
  });

  it("does NOT match keywords inside identifiers (toFixed is not 'fixed')", () => {
    const entries = extractKnowledge(
      session([
        msg("assistant", "Rendered with x.toFixed(2), 372 med: (6 / sp values per row in the table."),
      ])
    );
    expect(entries.filter((e) => e.type === "solution")).toHaveLength(0);
  });

  it("does not start a summary at punctuation after the keyword", () => {
    // "resolved, per scope discipline)" produced summary ", per scope discipline)"
    const entries = extractKnowledge(
      session([msg("assistant", "All ten items resolved, per scope discipline)")])
    );
    for (const e of entries) {
      expect(e.summary).toMatch(/^[A-Za-z0-9`"'$@/\\~_-]/);
    }
  });
});

describe("extractKnowledge — error_fix extraction", () => {
  it("extracts a clean error → fix pair", () => {
    const entries = extractKnowledge(
      session([
        msg("user", "Error: ECONNREFUSED when the worker calls the license endpoint on port 3100."),
        msg("assistant", "Fixed: the worker needed STRATA_TOKEN_SECRET set before it can call the endpoint."),
      ])
    );
    const fixes = entries.filter((e) => e.type === "error_fix");
    expect(fixes).toHaveLength(1);
    expect(fixes[0].summary).toMatch(/^ECONNREFUSED|^when the worker/i);
    expect(fixes[0].summary).toContain("→");
  });

  it("does not extract error_fix from ANSI-colored test-runner output", () => {
    const ansi = "[32m✓[39m [2m148 passed[22m [31m2 failed[39m tests in the suite";
    const entries = extractKnowledge(
      session([msg("user", ansi), msg("assistant", "[32mfixed[39m [2m90 passed[22m output")])
    );
    for (const e of entries) {
      // No raw ANSI escapes may survive into summaries.
      expect(e.summary).not.toMatch(/\[/);
    }
  });
});

describe("extractKnowledge — decisions still work", () => {
  it("extracts a decision with a clean capture", () => {
    const entries = extractKnowledge(
      session([msg("user", "We decided to use WAL mode for all SQLite databases in the storage layer.")])
    );
    const decisions = entries.filter((e) => e.type === "decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].summary).toMatch(/^use WAL mode/);
  });
});
