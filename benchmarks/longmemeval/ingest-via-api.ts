/**
 * ingest-via-api.ts
 *
 * Routes a LongMemEval question's haystack through the production ingestTurns
 * write-path, returning the IngestedQuestion shape so prod-consumer-parity arms
 * consume it unchanged. Keeps sessionIds as `longmemeval-{idx}` (recall@20 invariant).
 *
 * Used by prod-consumer-parity.ts --ingest=api to validate the new write-path
 * reproduces the published ~81% LongMemEval-S number.
 */

import type Database from "better-sqlite3";
import { openDatabase } from "../../src/storage/database.js";
import { SqliteDocumentStore } from "../../src/storage/sqlite-document-store.js";
import { SqliteKnowledgeStore } from "../../src/storage/sqlite-knowledge-store.js";
import { SqliteKnowledgeTurnStore } from "../../src/storage/sqlite-knowledge-turn-store.js";
import { SqliteEntityStore } from "../../src/storage/sqlite-entity-store.js";
import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { VectorSearch } from "../../src/extensions/embeddings/vector-search.js";
import { GeminiEmbedder } from "../../src/extensions/embeddings/gemini-embedder.js";
import { CachedEmbedder, EmbeddingCacheStore } from "./embedding-cache.js";
import { CONFIG } from "../../src/config.js";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { ingestTurns } from "../../src/ingest/ingest-turns.js";
import { parseSessionDate } from "./ingest.js";
import type { IngestedQuestion } from "./ingest.js";
import type { LongMemQuestion } from "./types.js";

// Module-level embedder shared across questions (same pattern as ingest.ts getEmbedder).
let _embedderApi: GeminiEmbedder | CachedEmbedder | null | undefined;
let _cacheStoreApi: EmbeddingCacheStore | null = null;
const CACHE_DB_PATH = "benchmarks/longmemeval/cache/embedding-cache.db";

function getApiEmbedder(): GeminiEmbedder | CachedEmbedder | null {
  if (_embedderApi === undefined) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { _embedderApi = null; return null; }
    const base = new GeminiEmbedder({ apiKey });
    // Reuse the same persistent embedding cache as ingest.ts
    if (!_cacheStoreApi) {
      mkdirSync(dirname(CACHE_DB_PATH), { recursive: true });
      _cacheStoreApi = new EmbeddingCacheStore(CACHE_DB_PATH);
    }
    _embedderApi = new CachedEmbedder(base, _cacheStoreApi, CONFIG.embeddings.model);
  }
  return _embedderApi;
}

/**
 * Ingest a single question via the production ingestTurns write-path.
 * Returns the same IngestedQuestion shape as ingestQuestion() so the
 * prod-consumer-parity arms can consume it unchanged.
 */
export async function ingestQuestionViaApi(question: LongMemQuestion): Promise<IngestedQuestion> {
  const db = openDatabase(":memory:");
  const embedder = getApiEmbedder();
  const vectorSearch = embedder ? new VectorSearch(db) : null;

  const docStore = new SqliteDocumentStore(db);
  const knowledgeStore = new SqliteKnowledgeStore(db, embedder);
  const turnStore = new SqliteKnowledgeTurnStore(db, embedder);
  const entityStore = new SqliteEntityStore(db);
  const searchEngine = new SqliteSearchEngine(docStore, embedder, vectorSearch, entityStore, knowledgeStore);
  searchEngine.setKnowledgeTurnStore(turnStore);

  const sessions = question.haystack_sessions;
  const sessionIds = question.haystack_session_ids;
  const dates = question.haystack_dates;

  let turnCount = 0;
  for (let idx = 0; idx < sessions.length; idx++) {
    const sessionId = `longmemeval-${idx}`;
    // Stamp every turn/chunk with the REAL session date (parity with ingestQuestion).
    // A production ingest payload carries created_at; without it the corpus is stamped
    // "today" and temporal/recency reasoning breaks (headers show the wrong year).
    const sessionMs = parseSessionDate(dates[idx]);
    const result = await ingestTurns(
      { turnStore, documents: docStore, knowledge: knowledgeStore, embedderPresent: embedder != null },
      {
        sessionId,
        project: "longmemeval",
        userId: undefined,
        messages: sessions[idx].map((t) => ({ speaker: t.role as "user" | "assistant", content: t.content, created_at: sessionMs })),
      }
    );
    turnCount += result.turnsWritten;
  }

  const chunkCount = await docStore.getDocumentCount();

  return {
    db,
    docStore,
    searchEngine,
    turnStore,
    knowledgeStore,
    questionId: question.question_id,
    indexToSessionId: sessionIds,
    sessionCount: sessions.length,
    chunkCount,
    turnCount,
    eventCount: 0, // SVO events are out of scope per spec §2
  };
}
