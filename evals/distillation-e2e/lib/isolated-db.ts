import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer, type CreateServerResult } from "../../../src/server.js";
import { SqliteKnowledgeTurnStore } from "../../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteSearchEngine } from "../../../src/search/sqlite-search-engine.js";

export interface IsolatedHandle {
  dataDir: string;
  runId: string;
  server: CreateServerResult;
  /**
   * Turn-level store wired against the same SQLite db the server opened.
   * Populated by drivePipeline (T9.5) so retrieval can match raw turn text
   * rather than relying on summarized knowledge_entries.
   */
  knowledgeTurn: SqliteKnowledgeTurnStore;
  /**
   * Search engine wired against the same document store as the server,
   * with the turn store injected via setKnowledgeTurnStore. Allows
   * retrieval strategies to call engine.searchTurns() (A6 spec
   * 2026-05-25-unified-turn-lane-surface §3.2) so the boost pipeline
   * is exercised through the same path as production.
   */
  searchEngine: SqliteSearchEngine;
}

export async function withIsolatedStrata<T>(
  fn: (handle: IsolatedHandle) => Promise<T>
): Promise<T> {
  const runId = randomUUID();
  const dataDir = mkdtempSync(join(tmpdir(), `strata-e2e-${runId}-`));
  const server = createServer({ dataDir });
  if (!server.indexManager) {
    throw new Error("withIsolatedStrata: server.indexManager is null — D1 path not supported by the harness");
  }
  const knowledgeTurn = new SqliteKnowledgeTurnStore(server.indexManager.db);
  // A6: build a search engine using the server's document store and wire the
  // turn store in so retrieval-strategies can call engine.searchTurns().
  const searchEngine = new SqliteSearchEngine(server.storage.documents);
  searchEngine.setKnowledgeTurnStore(knowledgeTurn);
  try {
    return await fn({ dataDir, runId, server, knowledgeTurn, searchEngine });
  } finally {
    try { await server.storage.close(); } catch { /* swallow — teardown */ }
    rmSync(dataDir, { recursive: true, force: true });
  }
}
