/**
 * ingest-via-api-pg.ts
 *
 * Postgres variant of ingest-via-api.ts.
 *
 * Routes a LongMemEval question's haystack through the production ingestTurns
 * write-path using a shared Postgres pool instead of per-question in-memory
 * SQLite databases.
 *
 * Isolation strategy: TRUNCATION per question (not per-tenant scoping).
 * This keeps the variable count at exactly one (the backend) — all
 * other parameters (sessionIds, project, userId, embedder) match
 * ingest-via-api.ts byte-for-byte.
 *
 * PG_URL env var controls which Postgres to target.
 * Default: postgresql://postgres:test@localhost:15432/postgres
 * (strata-pg29 Docker container for ticket #29 validation)
 *
 * Used by prod-consumer-parity.ts --backend=pg --ingest=api.
 */

import { mkdirSync } from "fs";
import { dirname } from "path";
import pg from "pg";

import { SqliteSearchEngine } from "../../src/search/sqlite-search-engine.js";
import { PgDocumentStore } from "../../src/storage/pg/pg-document-store.js";
import { PgKnowledgeStore } from "../../src/storage/pg/pg-knowledge-store.js";
import { PgKnowledgeTurnStore } from "../../src/storage/pg/pg-knowledge-turn-store.js";
import { PgVectorSearch } from "../../src/storage/pg/pg-vector-search.js";
import { createSchema } from "../../src/storage/pg/schema.js";
import { GeminiEmbedder } from "../../src/extensions/embeddings/gemini-embedder.js";
import { CachedEmbedder, EmbeddingCacheStore } from "./embedding-cache.js";
import { CONFIG } from "../../src/config.js";
import { ingestTurns } from "../../src/ingest/ingest-turns.js";
import { parseSessionDate } from "./ingest.js";
import type { IngestedQuestion } from "./ingest.js";
import type { LongMemQuestion } from "./types.js";

// ── PG URL ────────────────────────────────────────────────────────────────────

const DEFAULT_PG_URL = "postgresql://postgres:test@localhost:15432/postgres";

/**
 * Get the Postgres connection string from env or fall back to the
 * dedicated strata-pg29 validation container default.
 */
function getPgUrl(): string {
  return process.env.PG_URL ?? DEFAULT_PG_URL;
}

// ── Module-level shared state ─────────────────────────────────────────────────
// These are initialized once per process (module-level is fine for a benchmark
// harness; this is NOT production code, so D2 multi-tenant isolation does not
// apply here).

let _pool: pg.Pool | null = null;
let _schemaInitialized = false;

let _embedderPg: GeminiEmbedder | CachedEmbedder | null | undefined;
let _cacheStorePg: EmbeddingCacheStore | null = null;

const CACHE_DB_PATH = "benchmarks/longmemeval/cache/embedding-cache.db";

/** Fixed userId for all PG benchmark writes/reads (row-level isolation field). */
const BENCH_USER_ID = "benchmark";

// ── Embedder ──────────────────────────────────────────────────────────────────

function getPgEmbedder(): GeminiEmbedder | CachedEmbedder | null {
  if (_embedderPg === undefined) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) { _embedderPg = null; return null; }
    const base = new GeminiEmbedder({ apiKey });
    if (!_cacheStorePg) {
      mkdirSync(dirname(CACHE_DB_PATH), { recursive: true });
      _cacheStorePg = new EmbeddingCacheStore(CACHE_DB_PATH);
    }
    _embedderPg = new CachedEmbedder(base, _cacheStorePg, CONFIG.embeddings.model);
  }
  return _embedderPg;
}

// ── Pool + schema ─────────────────────────────────────────────────────────────

async function getPool(): Promise<pg.Pool> {
  if (_pool) return _pool;
  const pgUrl = getPgUrl();
  _pool = new pg.Pool({
    connectionString: pgUrl,
    max: 5, // benchmark is single-threaded; a small pool avoids connection churn
    idleTimeoutMillis: 60_000,
  });
  return _pool;
}

async function ensureSchema(pool: pg.Pool): Promise<void> {
  if (_schemaInitialized) return;
  await createSchema(pool);
  _schemaInitialized = true;
}

// ── Tables to truncate between questions ─────────────────────────────────────
// Ordered to respect FK constraints: child tables before parents where needed.
// CASCADE handles child rows automatically (knowledge_turn_embeddings → knowledge_turns,
// knowledge_history → knowledge), but ordering avoids redundant cascade work.
//
// Note: schema_migrations is NOT truncated — it tracks applied migrations and
// must survive between questions.
const TRUNCATE_SQL = `
  TRUNCATE TABLE
    knowledge_turn_embeddings,
    knowledge_turns,
    embeddings,
    knowledge_history,
    knowledge,
    documents,
    summaries,
    entities,
    entity_relations,
    index_meta
  RESTART IDENTITY CASCADE
`;

async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(TRUNCATE_SQL);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ingest a single question via the production ingestTurns write-path,
 * using shared PG stores instead of per-question in-memory SQLite.
 *
 * Truncates all content tables before ingesting to ensure question isolation.
 * Returns an IngestedQuestion-compatible shape for prod-consumer-parity arms.
 *
 * The `db` field is null (no better-sqlite3 handle). Consumers that pass
 * `ingested.db` to handleSearchHistory receive undefined (optional arg) which
 * is handled gracefully — knowledge search routes via knowledgeStore, and
 * SemanticSearchBridge degrades to FTS5 fallback when db=null.
 */
export async function ingestQuestionViaApiPg(question: LongMemQuestion): Promise<PgIngestedQuestion> {
  const pool = await getPool();
  await ensureSchema(pool);

  // Truncate all content tables → question isolation
  await truncateAll(pool);

  const embedder = getPgEmbedder();

  // Construct PG stores
  const docStore = new PgDocumentStore(pool, BENCH_USER_ID);
  const knowledgeStore = new PgKnowledgeStore(pool, BENCH_USER_ID, embedder);
  const pgTurnStore = new PgKnowledgeTurnStore(pool, embedder);
  const pgVectorSearch = new PgVectorSearch(pool, CONFIG.embeddings.model);

  // Wire SqliteSearchEngine with PG-backed stores (matches PG transport recipe).
  // VectorSearch for chunks (embeddings table) is null — the benchmark doesn't write
  // chunk embeddings via ingestTurns (only turns and FTS chunks); PgVectorSearch is
  // used for the dense turn-lane, not for the knowledge/chunk embedding table.
  const searchEngine = new SqliteSearchEngine(
    docStore,
    embedder,
    pgVectorSearch, // used for searchTurns dense lane via setKnowledgeTurnStore
    null,           // entityStore — PG entity store not wired in benchmark scope
    knowledgeStore,
  );
  searchEngine.setKnowledgeTurnStore(pgTurnStore);

  // Ingest all haystack sessions
  const sessions = question.haystack_sessions;
  const sessionIds = question.haystack_session_ids;
  const dates = question.haystack_dates;

  let turnCount = 0;
  for (let idx = 0; idx < sessions.length; idx++) {
    const sessionId = `longmemeval-${idx}`;
    const sessionMs = parseSessionDate(dates[idx]);
    const result = await ingestTurns(
      {
        turnStore: pgTurnStore,
        documents: docStore,
        knowledge: knowledgeStore,
        embedderPresent: embedder != null,
      },
      {
        sessionId,
        project: "longmemeval",
        userId: BENCH_USER_ID,
        messages: sessions[idx].map((t) => ({
          speaker: t.role as "user" | "assistant",
          content: t.content,
          created_at: sessionMs,
        })),
      }
    );
    turnCount += result.turnsWritten;
  }

  const chunkResult = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM documents WHERE user_scope = $1",
    [BENCH_USER_ID]
  );
  const chunkCount = parseInt(chunkResult.rows[0]?.count ?? "0", 10);

  return {
    db: null,
    docStore: docStore as unknown as import("../../src/storage/sqlite-document-store.js").SqliteDocumentStore,
    searchEngine,
    turnStore: pgTurnStore as unknown as import("../../src/storage/sqlite-knowledge-turn-store.js").SqliteKnowledgeTurnStore,
    knowledgeStore: knowledgeStore as unknown as import("../../src/storage/sqlite-knowledge-store.js").SqliteKnowledgeStore,
    questionId: question.question_id,
    indexToSessionId: sessionIds,
    sessionCount: sessions.length,
    chunkCount,
    turnCount,
    eventCount: 0,
    // PG-specific extras (not on IngestedQuestion — for cleanup use closeIngestedPg)
    _pgPool: pool,
    _pgUserId: BENCH_USER_ID,
  };
}

/**
 * Extended IngestedQuestion shape for PG variant.
 * The `db` field is null; PG pool is tracked separately for cleanup.
 */
export interface PgIngestedQuestion extends Omit<IngestedQuestion, "db"> {
  db: null;
  _pgPool: pg.Pool;
  _pgUserId: string;
}

/**
 * No-op close for PG-ingested questions.
 * The pool is module-level shared — do NOT call pool.end() between questions.
 * Call closeAllPg() once at the end of the run to drain the pool.
 */
export function closeIngestedPg(_ingested: PgIngestedQuestion): void {
  // Pool is shared across questions — no per-question teardown needed.
}

/**
 * Drain and close the shared PG pool. Call once after the run completes.
 */
export async function closeAllPg(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _schemaInitialized = false;
  }
}
