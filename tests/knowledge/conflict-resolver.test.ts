import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import type { KnowledgeEntry } from "../../src/knowledge/knowledge-store.js";
import type { LlmProvider } from "../../src/extensions/llm-extraction/llm-provider.js";
import { LlmError } from "../../src/extensions/llm-extraction/llm-provider.js";
import {
  resolveConflicts,
  executeResolution,
  parseResponse,
} from "../../src/knowledge/conflict-resolver.js";
import type { ConflictResolution } from "../../src/knowledge/conflict-resolver.js";

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    type: "decision",
    project: "test-project",
    sessionId: "session-1",
    timestamp: Date.now(),
    summary: "Project uses Yarn for package management",
    details: "Yarn was chosen for speed and workspaces support",
    tags: ["tooling"],
    relatedFiles: [],
    ...overrides,
  };
}

function makeProvider(response: string): LlmProvider {
  return {
    name: "test",
    complete: vi.fn().mockResolvedValue(response),
  };
}

/**
 * Provider that captures options passed to complete() so tests can assert
 * what the caller requested.
 */
function makeCapturingProvider(response: string): {
  provider: LlmProvider;
  capturedOptions: Array<Record<string, unknown>>;
} {
  const capturedOptions: Array<Record<string, unknown>> = [];
  const provider: LlmProvider = {
    name: "test",
    complete: vi.fn(async (_prompt: string, options?: Record<string, unknown>) => {
      capturedOptions.push(options || {});
      return response;
    }),
  };
  return { provider, capturedOptions };
}

function makeFailingProvider(): LlmProvider {
  return {
    name: "test",
    complete: vi.fn().mockRejectedValue(new LlmError("timeout", "test")),
  };
}

describe("resolveConflicts", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  it("requests at least 1024 maxTokens from the provider (headroom for multi-action JSON output)", async () => {
    // Regression guard: previously maxTokens was 256, which was enough for
    // Gemini's terse JSON ("{\"shouldAdd\":true,\"actions\":[]}") but
    // truncated Gemma 4's output under format:"json" mode because Gemma 4
    // emits fuller JSON with per-action mergedSummary/mergedDetails fields
    // and full UUIDs. Result: HybridProvider received mid-JSON truncated
    // output, validation failed, every conflict resolution call fell back
    // to frontier. See the 2026-04-09 canary DEBUG capture.
    //
    // Contract: resolveConflicts MUST request enough tokens to fit a
    // realistic multi-action response. 1024 is the current floor — it
    // comfortably fits 5-10 actions with full UUIDs and merged content.
    const existing = makeEntry({ id: "abc123", summary: "User uses yarn" });
    await store.addEntry(existing);

    const { provider, capturedOptions } = makeCapturingProvider(
      JSON.stringify({ shouldAdd: true, actions: [] })
    );
    const candidate = makeEntry({ summary: "User uses yarn workspaces" });
    await resolveConflicts(candidate, store, provider);

    expect(capturedOptions.length).toBe(1);
    const maxTokens = capturedOptions[0].maxTokens as number | undefined;
    expect(maxTokens).toBeGreaterThanOrEqual(1024);
  });

  it("returns shouldAdd:true with delete action when LLM says supersede", async () => {
    // LIKE search: candidate "package management" is a substring of existing summary
    const existing = makeEntry({ id: "abc123", summary: "Project uses Yarn for package management in monorepo" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "package management" });
    const provider = makeProvider(
      JSON.stringify({
        shouldAdd: true,
        actions: [{ id: "abc123", action: "delete" }],
      })
    );

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({ id: "abc123", action: "delete" });
  });

  it("returns shouldAdd:true with update action when LLM says merge", async () => {
    // LIKE search: candidate "Uses React" is a substring of existing
    const existing = makeEntry({ id: "def456", summary: "Uses React 17 for the frontend" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "Uses React" });
    const provider = makeProvider(
      JSON.stringify({
        shouldAdd: true,
        actions: [
          {
            id: "def456",
            action: "update",
            mergedSummary: "Uses React 18 with concurrent features (upgraded from 17)",
            mergedDetails: "Migrated to React 18 for concurrent rendering",
          },
        ],
      })
    );

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("update");
    expect(result.actions[0].mergedSummary).toContain("React 18");
  });

  it("returns shouldAdd:true with noop actions when no conflict", async () => {
    // Use summary substring overlap so SQLite LIKE search finds the existing entry
    const existing = makeEntry({ id: "ghi789", summary: "Uses ESLint for linting in the project" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "Uses ESLint for linting" });
    const provider = makeProvider(
      JSON.stringify({
        shouldAdd: true,
        actions: [{ id: "ghi789", action: "noop" }],
      })
    );

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("noop");
  });

  it("returns shouldAdd:false when LLM says full duplicate", async () => {
    // Use summary substring overlap so SQLite LIKE search finds the existing entry
    const existing = makeEntry({ id: "jkl012", summary: "Uses TypeScript strict mode for type safety" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "Uses TypeScript strict mode" });
    const provider = makeProvider(
      JSON.stringify({
        shouldAdd: false,
        actions: [{ id: "jkl012", action: "noop" }],
      })
    );

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(false);
  });

  it("falls back gracefully on LLM timeout", async () => {
    // Use substring overlap so search finds the entry and triggers LLM
    const existing = makeEntry({ id: "e1", summary: "Some knowledge about testing" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "Some knowledge" });
    const provider = makeFailingProvider();

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("falls back gracefully when provider is null", async () => {
    const candidate = makeEntry({ id: "new1" });

    const result = await resolveConflicts(candidate, store, null);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("falls back when provider is undefined", async () => {
    const candidate = makeEntry({ id: "new1" });

    const result = await resolveConflicts(candidate, store);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("bypasses LLM when search returns 0 results", async () => {
    const candidate = makeEntry({ id: "new1", summary: "Completely unique entry xyz123" });
    const provider = makeProvider("should not be called");

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("respects STRATA_CONFLICT_RESOLUTION=0 killswitch", async () => {
    vi.stubEnv("STRATA_CONFLICT_RESOLUTION", "0");

    const existing = makeEntry({ id: "e1", summary: "Some knowledge" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "Some knowledge" });
    const provider = makeProvider(
      JSON.stringify({ shouldAdd: false, actions: [] })
    );

    const result = await resolveConflicts(candidate, store, provider);

    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("truncates entries in prompt to 300 chars", async () => {
    const longSummary = "A".repeat(500);
    const existing = makeEntry({ id: "e1", summary: longSummary });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: longSummary });
    const provider = makeProvider(
      JSON.stringify({ shouldAdd: true, actions: [] })
    );

    await resolveConflicts(candidate, store, provider);

    const prompt = (provider.complete as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // The prompt should not contain the full 500-char string untruncated
    expect(prompt).not.toContain("A".repeat(400));
    expect(prompt).toContain("A".repeat(300));
  });
});

describe("parseResponse", () => {
  const similar = [makeEntry({ id: "e1" }), makeEntry({ id: "e2" })];

  it("strips markdown fences from LLM response", async () => {
    const raw = '```json\n{"shouldAdd": true, "actions": []}\n```';
    const result = parseResponse(raw, similar);
    expect(result.shouldAdd).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("coerces update action missing mergedSummary to noop", async () => {
    const raw = JSON.stringify({
      shouldAdd: true,
      actions: [{ id: "e1", action: "update" }],
    });
    const result = parseResponse(raw, similar);
    expect(result.actions[0].action).toBe("noop");
  });

  it("rejects unknown action types", async () => {
    const raw = JSON.stringify({
      shouldAdd: true,
      actions: [
        { id: "e1", action: "explode" },
        { id: "e2", action: "delete" },
      ],
    });
    const result = parseResponse(raw, similar);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe("delete");
  });

  it("handles malformed actions gracefully", async () => {
    const raw = JSON.stringify({
      shouldAdd: true,
      actions: [null, { action: "delete" }, { id: "e1" }],
    });
    const result = parseResponse(raw, similar);
    expect(result.actions).toEqual([]);
  });

  it("defaults shouldAdd to true if not boolean", async () => {
    const raw = JSON.stringify({
      shouldAdd: "yes",
      actions: [],
    });
    const result = parseResponse(raw, similar);
    expect(result.shouldAdd).toBe(true);
  });

  it("handles missing actions array", async () => {
    const raw = JSON.stringify({ shouldAdd: false });
    const result = parseResponse(raw, similar);
    expect(result.shouldAdd).toBe(false);
    expect(result.actions).toEqual([]);
  });

  it("throws on completely invalid JSON", async () => {
    expect(() => parseResponse("not json at all", similar)).toThrow();
  });
});

describe("resolveConflicts — training capture", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  it("saves a 'conflict' task_type training pair after successful LLM resolution", async () => {
    const existing = makeEntry({ id: "abc123", summary: "User uses yarn for packages" });
    await store.addEntry(existing);

    const provider = makeProvider(
      JSON.stringify({ shouldAdd: true, actions: [{ id: "abc123", action: "noop" }] })
    );
    const candidate = makeEntry({ summary: "User uses yarn" });

    await resolveConflicts(candidate, store, provider, db);

    const rows = db.prepare(
      "SELECT task_type FROM training_data WHERE task_type = 'conflict'"
    ).all() as { task_type: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].task_type).toBe("conflict");
  });

  it("does NOT save training pair when LLM is skipped (no similar entries)", async () => {
    const candidate = makeEntry({ summary: "Completely unique xyz987abc" });
    const provider = makeProvider(JSON.stringify({ shouldAdd: true, actions: [] }));

    await resolveConflicts(candidate, store, provider, db);

    const rows = db.prepare("SELECT 1 FROM training_data").all();
    expect(rows).toHaveLength(0);
  });

  it("does NOT save training pair when provider is null (fallback path)", async () => {
    await resolveConflicts(makeEntry(), store, null, db);
    const rows = db.prepare("SELECT 1 FROM training_data").all();
    expect(rows).toHaveLength(0);
  });

  it("does NOT save training pair when db is not provided (backward compat)", async () => {
    const existing = makeEntry({ id: "e1", summary: "User uses yarn workspaces" });
    await store.addEntry(existing);

    const provider = makeProvider(
      JSON.stringify({ shouldAdd: true, actions: [] })
    );
    // Call with only 3 args — should not throw and should not write training data
    const candidate = makeEntry({ summary: "User uses yarn" });
    const result = await resolveConflicts(candidate, store, provider);
    expect(result.shouldAdd).toBe(true);
    // No db provided — cannot check rows, but the call must not throw
  });
});

describe("executeResolution", () => {
  let db: Database.Database;
  let store: SqliteKnowledgeStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new SqliteKnowledgeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("calls deleteEntry for delete actions", async () => {
    const existing = makeEntry({ id: "del1", summary: "Old entry" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "New entry" });
    const resolution: ConflictResolution = {
      shouldAdd: true,
      actions: [{ id: "del1", action: "delete" }],
    };

    await executeResolution(resolution, candidate, store);

    expect(await store.getEntry("del1")).toBeUndefined();
    expect(await store.getEntry("new1")).toBeDefined();
  });

  it("calls updateEntry with merged fields for update actions", async () => {
    const existing = makeEntry({ id: "upd1", summary: "Old summary", details: "Old details" });
    await store.addEntry(existing);

    const candidate = makeEntry({ id: "new1", summary: "New entry" });
    const resolution: ConflictResolution = {
      shouldAdd: true,
      actions: [
        {
          id: "upd1",
          action: "update",
          mergedSummary: "Merged summary",
          mergedDetails: "Merged details",
        },
      ],
    };

    await executeResolution(resolution, candidate, store);

    const updated = await store.getEntry("upd1");
    expect(updated).toBeDefined();
    expect(updated!.summary).toBe("Merged summary");
    expect(updated!.details).toBe("Merged details");
    expect(await store.getEntry("new1")).toBeDefined();
  });

  it("calls addEntry only when shouldAdd is true", async () => {
    const candidate = makeEntry({ id: "new1", summary: "Should not be added" });
    const resolution: ConflictResolution = {
      shouldAdd: false,
      actions: [],
    };

    await executeResolution(resolution, candidate, store);

    expect(await store.getEntry("new1")).toBeUndefined();
  });

  it("applies deletes before updates before add", async () => {
    const toDelete = makeEntry({ id: "del1", summary: "To delete" });
    const toUpdate = makeEntry({ id: "upd1", summary: "To update" });
    await store.addEntry(toDelete);
    await store.addEntry(toUpdate);

    const deleteSpy = vi.spyOn(store, "deleteEntry");
    const updateSpy = vi.spyOn(store, "updateEntry");
    const addSpy = vi.spyOn(store, "addEntry");

    const candidate = makeEntry({ id: "new1", summary: "Brand new entry" });
    const resolution: ConflictResolution = {
      shouldAdd: true,
      actions: [
        { id: "upd1", action: "update", mergedSummary: "Updated" },
        { id: "del1", action: "delete" },
      ],
    };

    await executeResolution(resolution, candidate, store);

    // Verify ordering: delete called before update, update before add
    const deleteOrder = deleteSpy.mock.invocationCallOrder[0];
    const updateOrder = updateSpy.mock.invocationCallOrder[0];
    const addOrder = addSpy.mock.invocationCallOrder[0];

    expect(deleteOrder).toBeLessThan(updateOrder);
    expect(updateOrder).toBeLessThan(addOrder);
  });

  it("skips update gracefully if entry no longer exists", async () => {
    const candidate = makeEntry({ id: "new1", summary: "New entry" });
    const resolution: ConflictResolution = {
      shouldAdd: true,
      actions: [
        { id: "nonexistent", action: "update", mergedSummary: "Merged" },
      ],
    };

    // Should not throw
    await executeResolution(resolution, candidate, store);
    expect(await store.getEntry("new1")).toBeDefined();
  });

  it("handles all 5 similar entries getting deleted", async () => {
    for (let i = 0; i < 5; i++) {
      await store.addEntry(makeEntry({ id: `e${i}`, summary: `Entry ${i} about tooling` }));
    }

    const candidate = makeEntry({ id: "new1", summary: "New tooling decision" });
    const resolution: ConflictResolution = {
      shouldAdd: true,
      actions: [
        { id: "e0", action: "delete" },
        { id: "e1", action: "delete" },
        { id: "e2", action: "delete" },
        { id: "e3", action: "delete" },
        { id: "e4", action: "delete" },
      ],
    };

    await executeResolution(resolution, candidate, store);

    for (let i = 0; i < 5; i++) {
      expect(await store.getEntry(`e${i}`)).toBeUndefined();
    }
    expect(await store.getEntry("new1")).toBeDefined();
  });
});
