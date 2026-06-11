/**
 * Summary sanitation + validation gate.
 *
 * The 2026-06-11 audit found 36% of knowledge titles were malformed
 * (ANSI test output, punctuation fragments, markdown-table debris).
 * The extractor regex fixes stop manufacturing NEW fragments, but the
 * store boundary (SqliteKnowledgeStore.addEntry) is the only funnel
 * every writer passes through — heuristic extractors, both LLM
 * enhanced-extractors (which merge + fall back to heuristics), REST
 * transport, and store_memory — so malformed summaries are repaired or
 * rejected there.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sanitizeAndValidateSummary } from "../../src/knowledge/knowledge-evaluator.js";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";

describe("sanitizeAndValidateSummary", () => {
  it("accepts a normal summary unchanged", () => {
    const v = sanitizeAndValidateSummary("Use WAL mode for all SQLite databases");
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe("Use WAL mode for all SQLite databases");
  });

  it("strips ANSI escapes and collapses whitespace", () => {
    const v = sanitizeAndValidateSummary(
      "[32mEnable WAL[39m   mode to\n\nstop SQLITE_BUSY errors"
    );
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe("Enable WAL mode to stop SQLITE_BUSY errors");
  });

  it("repairs a leading-punctuation start when real content follows", () => {
    const v = sanitizeAndValidateSummary("...the fix was adding busy_timeout 5000");
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe("the fix was adding busy_timeout 5000");
  });

  it("rejects the audit's canonical fragment ', per scope discipline)'", () => {
    const v = sanitizeAndValidateSummary(", per scope discipline)");
    expect(v.ok).toBe(false);
  });

  it("rejects code shrapnel like '(2)} ${y.toFixed(2)}`); 3'", () => {
    const v = sanitizeAndValidateSummary("(2)} ${y.toFixed(2)}`); 3");
    expect(v.ok).toBe(false);
  });

  it("rejects markdown-table debris (3+ pipes)", () => {
    const v = sanitizeAndValidateSummary(
      "| | multi-session | 7 | 13 | 54% | was 76.7% |"
    );
    expect(v.ok).toBe(false);
  });

  it("rejects pure ANSI test-runner output", () => {
    const v = sanitizeAndValidateSummary("[32m✓[39m [2m148[22m [31m2[39m (152)");
    expect(v.ok).toBe(false);
  });

  it("keeps short-but-real user notes (no overzealous length gate)", () => {
    const v = sanitizeAndValidateSummary("Use Vite!");
    expect(v.ok).toBe(true);
  });

  it("accepts summaries starting with backtick-quoted code", () => {
    const v = sanitizeAndValidateSummary("`npm ci` then rebuild native deps");
    expect(v.ok).toBe(true);
    expect(v.repaired).toBe("`npm ci` then rebuild native deps");
  });

  it("does not count pipes inside backtick code spans as table debris", () => {
    const v = sanitizeAndValidateSummary(
      "Procedure: daemon lifecycle — `halcyon daemon start|stop|status|logs`."
    );
    expect(v.ok).toBe(true);
  });
});

describe("SqliteKnowledgeStore.addEntry — summary gate", () => {
  function entry(summary: string): KnowledgeEntry {
    return {
      id: randomUUID(),
      type: "solution",
      project: "p",
      sessionId: "s",
      timestamp: Date.now(),
      summary,
      details: "details long enough to pass nothing in particular",
      tags: [],
      relatedFiles: [],
    };
  }

  it("rejects fragment summaries at the store boundary", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeStore(db);

    await store.addEntry(entry(", per scope discipline)"));

    const count = db.prepare("SELECT COUNT(*) AS c FROM knowledge").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("repairs leading punctuation before persisting", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeStore(db);

    const e = entry("...enable WAL journal mode to stop SQLITE_BUSY");
    await store.addEntry(e);

    const row = db.prepare("SELECT summary FROM knowledge WHERE id = ?").get(e.id) as
      | { summary: string }
      | undefined;
    expect(row?.summary).toBe("enable WAL journal mode to stop SQLITE_BUSY");
  });

  it("still stores clean entries untouched", async () => {
    const db = openDatabase(":memory:");
    const store = new SqliteKnowledgeStore(db);

    const e = entry("Use WAL mode for all SQLite databases");
    await store.addEntry(e);

    const row = db.prepare("SELECT summary FROM knowledge WHERE id = ?").get(e.id) as
      | { summary: string }
      | undefined;
    expect(row?.summary).toBe("Use WAL mode for all SQLite databases");
  });
});
