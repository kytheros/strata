/**
 * Integration test: strata store-memory → strata search round-trip (CLI layer).
 *
 * Regression class caught: runSearch() queried only the FTS5 document index
 * (indexManager.documents) and never consulted indexManager.knowledge, so
 * memories stored via store-memory were invisible to CLI search.
 *
 * TDD — Written RED first (before fix), GREEN after fix is applied.
 * Follows the in-process mock pattern of tests/integration/rebuild-turns-cli.test.ts.
 */

// ── Module mock (must come before imports) ────────────────────────────────────
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

// Shared in-memory DB for both runStoreMemory and runSearch within one test.
// Using a module-level variable; the mock factory captures it via closure.
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteSummaryStore } from "../../src/storage/sqlite-summary-store.js";
import { SqliteMetaStore } from "../../src/storage/sqlite-meta-store.js";
import { ParserRegistry } from "../../src/parsers/parser-registry.js";

let sharedDb: Database.Database;

vi.mock("../../src/indexing/sqlite-index-manager.js", () => {
  return {
    SqliteIndexManager: vi.fn().mockImplementation(() => {
      // Each call gets the SAME shared in-memory DB so store then search see the same data.
      const db = sharedDb;
      const documents = new SqliteDocumentStore(db);
      const knowledge = new SqliteKnowledgeStore(db);
      const summaries = new SqliteSummaryStore(db);
      const meta = new SqliteMetaStore(db);
      const registry = new ParserRegistry();

      return {
        db,
        documents,
        knowledge,
        summaries,
        meta,
        registry,
        getStats: vi.fn(() => ({ documents: 0, sessions: 0, knowledge: 0 })),
        buildFullIndex: vi.fn(),
        incrementalUpdate: vi.fn(),
        close: vi.fn(),
      };
    }),
  };
});

// ── Imports (after mock registration) ────────────────────────────────────────

import { runSearch, runStoreMemory } from "../../src/cli.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Capture console.log output during an async callback.
 * Also stubs process.exit so it does not terminate the test process.
 * Returns an object with the captured output and the exit code (if any).
 */
async function captureRun(fn: () => Promise<void>): Promise<{
  output: string;
  exitCode: number | null;
}> {
  const lines: string[] = [];
  let exitCode: number | null = null;

  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };

  // Prevent process.exit from killing the test process; capture the code.
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: number | string | null | undefined) => {
      exitCode = typeof code === "number" ? code : 0;
      // throw so any code after process.exit is not executed
      throw new ProcessExitError(exitCode);
    });

  try {
    await fn();
  } catch (err) {
    if (!(err instanceof ProcessExitError)) {
      throw err;
    }
    // ProcessExitError is expected when runSearch finds no results
  } finally {
    console.log = origLog;
    exitSpy.mockRestore();
  }

  return { output: lines.join("\n"), exitCode };
}

/** Sentinel error class used to abort execution when process.exit is called. */
class ProcessExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitError";
  }
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("store-memory → search CLI round-trip", () => {
  beforeAll(() => {
    sharedDb = openDatabase(":memory:");
  });

  afterAll(() => {
    try {
      sharedDb.close();
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a stored memory in CLI search results (the regression)", async () => {
    // Step 1: Store a memory via the CLI runStoreMemory path.
    await captureRun(async () => {
      await runStoreMemory(
        "Use bcrypt with cost factor 12 for password hashing",
        { type: "decision", project: "test-cli-knowledge" }
      );
    });

    // Step 2: Search for the stored memory via the CLI runSearch path.
    //
    // Before the fix, runSearch queries only indexManager.documents (FTS5
    // conversation index) and never indexManager.knowledge, so "bcrypt" is
    // not found → output is "No results found." and exitCode is 1.
    //
    // After the fix, knowledge entries are merged in → "bcrypt" appears →
    // the search succeeds and the output contains the stored summary.
    const { output, exitCode } = await captureRun(async () => {
      await runSearch("bcrypt", {
        project: "test-cli-knowledge",
        "no-color": true,
      });
    });

    // The bug: before the fix this assertion fails because "bcrypt" is absent
    // and exitCode is 1.
    expect(output).toContain("bcrypt");
    expect(exitCode).toBeNull(); // null means process.exit was NOT called
  });

  it("still returns No results found for a non-matching query", async () => {
    // The query has no matching knowledge entries and no indexed conversations.
    const { output, exitCode } = await captureRun(async () => {
      await runSearch("completely-nonexistent-xyzzyx-term", {
        project: "test-cli-knowledge",
        "no-color": true,
      });
    });

    expect(output).toContain("No results found");
    expect(exitCode).toBe(1);
  });
});
