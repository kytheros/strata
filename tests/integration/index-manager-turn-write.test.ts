/**
 * Integration test: turn-write on the live batch index path.
 *
 * Verifies that when a turnStore is set on SqliteIndexManager, the
 * indexFileWithParser() method writes turns. Uses a direct call to the
 * private method to avoid triggering real parser filesystem scans.
 *
 * Uses a fake EmbeddingProvider to avoid real API calls.
 * Spec: 2026-06-03-dense-turn-lane-production-design §3.3.
 */
import { describe, it, expect } from "vitest";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteIndexManager } from "../../src/indexing/sqlite-index-manager.js";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";
import type { ConversationParser } from "../../src/parsers/parser-interface.js";
import type { ParsedSession, SessionFileInfo } from "../../src/parsers/session-parser.js";

function fakeProvider(): EmbeddingProvider {
  const v = (dim: number) => { const a = new Float32Array(dim); a[0] = 1; return a; };
  return {
    dimensions: 768,
    modelName: "nomic-embed-text-v1.5",
    supportsQuantization: false,
    embed: async () => v(768),
    embedBatch: async (t: string[]) => t.map(() => v(768)),
  } as unknown as EmbeddingProvider;
}

describe("SqliteIndexManager turn-write on batch index path", () => {
  it("setTurnStore is callable (setter exists)", () => {
    const indexManager = new SqliteIndexManager(":memory:");
    const turnStore = new SqliteKnowledgeTurnStore(indexManager.db);
    expect(() => indexManager.setTurnStore(turnStore)).not.toThrow();
    indexManager.close();
  });

  it("writes knowledge_turns rows (and embeddings) via indexFileWithParser when turnStore is set", async () => {
    const indexManager = new SqliteIndexManager(":memory:");
    const provider = fakeProvider();
    const turnStore = new SqliteKnowledgeTurnStore(indexManager.db, provider);

    // Wire the turn store
    indexManager.setTurnStore(turnStore);

    const testSession: ParsedSession = {
      sessionId: "test-session-123",
      project: "test-project",
      cwd: "/tmp",
      gitBranch: "main",
      messages: [
        { role: "user", text: "what is the answer to everything", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: new Date().toISOString(), uuid: "u1" },
        { role: "assistant", text: "the answer is forty two", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: new Date().toISOString(), uuid: "u2" },
      ],
      startTime: Date.now(),
      endTime: Date.now() + 1000,
    };

    const fakeFileInfo: SessionFileInfo = {
      filePath: "/fake/session.jsonl",
      sessionId: testSession.sessionId,
      mtime: Date.now(),
    };

    const fakeParser: ConversationParser = {
      id: "test-parser",
      name: "Test Parser",
      detect(): boolean { return true; },
      discover(): SessionFileInfo[] { return [fakeFileInfo]; },
      parse(_file: SessionFileInfo): ParsedSession | null { return testSession; },
    };

    // Call the private indexFileWithParser directly via any-cast
    (indexManager as any).indexFileWithParser(fakeFileInfo, fakeParser);

    // Allow async turn embedding to complete (embedTurns is fire-and-forget)
    await new Promise(r => setTimeout(r, 200));

    const db = indexManager.db;
    const turnCount = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_turns").get() as { c: number }).c;
    const embCount = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_turn_embeddings").get() as { c: number }).c;

    indexManager.close();

    expect(turnCount).toBe(2); // 2 messages → 2 turns
    expect(embCount).toBe(2);  // 2 embeddings (provider present)
  });

  it("skips turn-write when turnStore is not set", () => {
    const indexManager = new SqliteIndexManager(":memory:");

    const testSession: ParsedSession = {
      sessionId: "test-session-456",
      project: "test-project",
      cwd: "/tmp",
      gitBranch: "main",
      messages: [
        { role: "user", text: "hello", toolNames: [], toolInputSnippets: [], hasCode: false, timestamp: new Date().toISOString(), uuid: "u1" },
      ],
      startTime: Date.now(),
      endTime: Date.now() + 1000,
    };

    const fakeFileInfo: SessionFileInfo = {
      filePath: "/fake/session.jsonl",
      sessionId: testSession.sessionId,
      mtime: Date.now(),
    };

    const fakeParser: ConversationParser = {
      id: "test-parser",
      name: "Test Parser",
      detect(): boolean { return true; },
      discover(): SessionFileInfo[] { return [fakeFileInfo]; },
      parse(_file: SessionFileInfo): ParsedSession | null { return testSession; },
    };

    (indexManager as any).indexFileWithParser(fakeFileInfo, fakeParser);

    const db = indexManager.db;
    const turnCount = (db.prepare("SELECT COUNT(*) AS c FROM knowledge_turns").get() as { c: number }).c;
    indexManager.close();

    expect(turnCount).toBe(0); // No turn store → no turns written
  });
});
