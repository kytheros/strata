/**
 * Persistent content-addressed embedding cache for the LongMemEval benchmark.
 *
 * The benchmark rebuilds a fresh in-memory DB per question per run and embeds
 * the (immutable) corpus from scratch every time. This memoizes embeddings by
 * sha256(model + taskType + text) so the corpus is embedded once and reused.
 *
 * The cache returns BYTE-IDENTICAL vectors to the underlying embedder, so it
 * changes only cost/latency — never retrieval results or eval scores.
 *
 * Spec: specs/2026-05-31-benchmark-embedding-cache-design.md
 */
import Database from "better-sqlite3";
import { createHash } from "crypto";
import type { EmbeddingProvider } from "../../src/extensions/vector-search/embedding-provider.js";
import { resolveActiveEmbeddingModel } from "../../src/extensions/embeddings/active-model.js";

/** Minimal embedder shape both GeminiEmbedder and CachedEmbedder satisfy. */
export interface TextEmbedder {
  readonly dimensions: number;
  embed(text: string, taskType?: string): Promise<Float32Array>;
  embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]>;
}

/** Stable cache key. NUL separators avoid delimiter collisions. */
export function cacheKey(model: string, taskType: string | undefined, text: string): string {
  return createHash("sha256")
    .update(`${model}\x00${taskType ?? ""}\x00${text}`)
    .digest("hex");
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export class EmbeddingCacheStore {
  private db: Database.Database;
  private getStmt: Database.Statement;
  private putStmt: Database.Statement;
  private _hits = 0;
  private _misses = 0;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS embedding_cache (
         key   TEXT PRIMARY KEY,
         model TEXT NOT NULL,
         dims  INTEGER NOT NULL,
         vec   BLOB NOT NULL
       );`
    );
    this.getStmt = this.db.prepare("SELECT dims, vec FROM embedding_cache WHERE key = ?");
    this.putStmt = this.db.prepare(
      "INSERT OR REPLACE INTO embedding_cache (key, model, dims, vec) VALUES (?, ?, ?, ?)"
    );
  }

  get(key: string): Float32Array | null {
    const row = this.getStmt.get(key) as { dims: number; vec: Buffer } | undefined;
    if (!row) {
      this._misses++;
      return null;
    }
    const f32 = new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4);
    if (f32.length !== row.dims) {
      // Corrupt/mismatched row — treat as a miss so the caller re-embeds.
      this._misses++;
      return null;
    }
    this._hits++;
    // Copy out so callers can't mutate the backing buffer.
    return Float32Array.from(f32);
  }

  getMany(keys: string[]): (Float32Array | null)[] {
    return keys.map((k) => this.get(k));
  }

  put(key: string, model: string, vec: Float32Array): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.putStmt.run(key, model, vec.length, buf);
  }

  putMany(entries: Array<{ key: string; model: string; vec: Float32Array }>): void {
    const tx = this.db.transaction((rows: typeof entries) => {
      for (const r of rows) this.put(r.key, r.model, r.vec);
    });
    tx(entries);
  }

  stats(): CacheStats {
    return { hits: this._hits, misses: this._misses };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Transparent caching wrapper around any TextEmbedder.
 *
 * Implements the full EmbeddingProvider contract (not just TextEmbedder) so it
 * can drive the dense turn-lane: SqliteKnowledgeTurnStore.embedTurns reads
 * `embedder.modelName` / `embedder.supportsQuantization` to stamp the NOT-NULL
 * knowledge_turn_embeddings.model column and choose the vector encoding. Without
 * these getters, dense-turn embeds throw `NOT NULL constraint failed: ...model`
 * and silently degrade to FTS-only — which broke dense-turn writes on BOTH
 * --ingest=direct (ingestQuestion) and --ingest=api (ingestQuestionViaApi).
 */
export class CachedEmbedder implements TextEmbedder, EmbeddingProvider {
  constructor(
    private inner: TextEmbedder,
    private store: EmbeddingCacheStore,
    private model: string
  ) {}

  get dimensions(): number {
    return this.inner.dimensions;
  }

  /**
   * Satisfies EmbeddingProvider.modelName — required by SqliteKnowledgeTurnStore
   * to stamp the model column on knowledge_turn_embeddings rows (NOT NULL).
   * Must match the model string the read path filters on
   * (resolveActiveEmbeddingModel().model), which is what this.model already holds
   * (set from CONFIG.embeddings.model in ingest.ts).
   */
  get modelName(): string {
    return this.model;
  }

  /**
   * Satisfies EmbeddingProvider.supportsQuantization — required by
   * SqliteKnowledgeTurnStore to drive encodeEmbeddingFor() (TurboQuant gate).
   * For Gemini (the active provider in benchmarks) this is true; for any other
   * provider it is false. We resolve at call time (not cached) so test overrides
   * via process.env work correctly, matching the same logic used by
   * GeminiEmbeddingProvider (which hardcodes true) and OpenAiCompatibleProvider
   * (which hardcodes false).
   */
  get supportsQuantization(): boolean {
    return resolveActiveEmbeddingModel().provider === "gemini";
  }

  async embed(text: string, taskType?: string): Promise<Float32Array> {
    const [v] = await this.embedBatch([text], taskType);
    return v;
  }

  async embedBatch(texts: string[], taskType?: string): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const keys = texts.map((t) => cacheKey(this.model, taskType, t));
    const cached = this.store.getMany(keys);

    // Collect misses (preserving original indices).
    const missIdx: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (cached[i] === null) {
        missIdx.push(i);
        missTexts.push(texts[i]);
      }
    }

    let fresh: Float32Array[] = [];
    if (missTexts.length > 0) {
      fresh = await this.inner.embedBatch(missTexts, taskType);
      this.store.putMany(
        fresh.map((vec, j) => ({ key: keys[missIdx[j]], model: this.model, vec }))
      );
    }

    // Reassemble in original order.
    const out: Float32Array[] = new Array(texts.length);
    let f = 0;
    for (let i = 0; i < texts.length; i++) {
      out[i] = cached[i] !== null ? (cached[i] as Float32Array) : fresh[f++];
    }
    return out;
  }
}
