import { homedir } from "os";
import { join } from "path";

export const CONFIG = {
  claudeDir: join(homedir(), ".claude"),
  get historyFile() {
    return join(this.claudeDir, "history.jsonl");
  },
  get projectsDir() {
    return join(this.claudeDir, "projects");
  },
  get settingsFile() {
    return join(this.claudeDir, "settings.json");
  },

  dataDir: join(homedir(), ".strata"),
  get indexFile() {
    return join(this.dataDir, "index.msgpack");
  },
  get knowledgeFile() {
    return join(this.dataDir, "knowledge.json");
  },
  get summariesDir() {
    return join(this.dataDir, "summaries");
  },
  get metaFile() {
    return join(this.dataDir, "meta.json");
  },
  get recurringIssuesFile() {
    return join(this.dataDir, "recurring-issues.json");
  },

  // BM25 parameters
  bm25: {
    k1: 1.2,
    b: 0.75,
  },

  // TF-IDF parameters
  tfidf: {
    maxTerms: 10000,
  },

  // Search defaults
  search: {
    defaultLimit: 20,
    maxLimit: 100,
    contextLines: 3,
    // Recency boosts
    recencyBoost7d: 1.1,
    recencyBoost30d: 1.05,
    // Project match boost
    projectMatchBoost: 1.3,
    // RRF constant
    rrfK: 40,
    // Bonus multiplier for docs appearing in multiple ranked lists (0 = disabled)
    rrfDualListBonus: 0.3,
    // Cosine similarity tiebreaker: additive bonus proportional to actual
    // semantic similarity, restoring magnitude information that RRF discards.
    // 0 = disabled, 0.005 = subtle tiebreaker, 0.02 = significant reordering.
    vectorSimBonus: 0.005,
    // Memory decay (auto-indexed only; explicit memories exempt)
    decayPenalty90d: 0.85,
    decayPenalty180d: 0.7,
    // Confidence scoring
    confidenceHighThreshold: 0.6,
    confidenceMediumThreshold: 0.3,
    lowConfidenceThreshold: 1.5,
    // Quantized-domain search
    /** Candidate count for SDC pre-filter (0 = skip SDC, use ADC-only) */
    quantizedCandidateCount: 100,
    /** Auto-disable SDC pre-filter below this vector count (ADC is fast enough) */
    quantizedSdcThreshold: 500,
    // TIR+QDP community port feature flag (Phase 4 flip after dogfooding)
    useTirQdp: false,
    /**
     * Turn-lane recency boost (spec 2026-05-18-temporal-retrieval-intervention).
     * When enabled, the tirqdp path applies a recency-proportional score boost
     * to knowledge_turns FTS hits before fusion, for queries that match the
     * two-signal temporal-current-state classifier.
     *
     * Default false; flip to true only after AutoResearch frozen evals confirm
     * no regression (Phase 2 of the spec, separate session).
     */
    turnRecencyBoost: {
      enabled: true,
      // boostMax field removed 2026-05-19 — recency-dominant ranking has no
      // magnitude knob. Spec: 2026-05-19-recency-dominant-ranking-design.md.
    },
    /**
     * Within-session speaker-prefer ranking (spec 2026-05-23-within-session-speaker-prefer).
     * After turn-lane retrieval, reorder hits within each session so user turns
     * come before assistant turns, with turn-index DESC as the within-speaker
     * tiebreaker. Pure ordering pass — scores not modified.
     *
     * Default true; addresses 5 fixtures on autoresearch-turn-lane-ranking
     * (006/007/008/009/010) where assistant confirmation echoes outrank user
     * decision/correction turns in BM25.
     */
    turnSpeakerPrefer: {
      enabled: true,
    },
    /**
     * Per-session top-K cap (spec 2026-05-23-per-session-top5-cap-design).
     * After all upstream ranking (speaker-prefer, recency reorder), walks the
     * ranked list keeping a per-session counter. Hits whose session-count
     * exceeds MAX_HITS_PER_SESSION (3) are demoted to the end of the list,
     * preserving the rank order of all other hits.
     *
     * Recovers ranking-004 recall@5 regression introduced by speaker-prefer.
     * Default true.
     */
    turnPerSessionCap: {
      enabled: true,
    },

    /**
     * Dense turn-lane (spec 2026-06-03-dense-turn-lane-production-design). When enabled,
     * SqliteSearchEngine.searchTurns fuses an FTS5 turn lane with a vector
     * (cosine) turn lane via RRF, giving each turn its own dense signal.
     * Requires an embedder + VectorSearch on the engine; degrades to FTS5-only
     * when absent. Default ON when a provider is present; kill-switch via
     * STRATA_DENSE_TURN_LANE=off.
     *
     * Kill-switch scope (=off): no per-turn embeddings are written (the
     * multi-tenant cost lever) and the default search path stops fusing turn
     * hits. FTS turn persistence is NEVER gated — ingest_turns,
     * POST /ingest/turns, and batch indexing always write knowledge_turns, so
     * re-enabling the lane has data to read (backfill vectors via
     * `strata index --rebuild-turns`). Explicit retrieval strategies ("deep",
     * "tirqdp") still use the FTS-only turn lane while the switch is off.
     */
    denseTurnLane: {
      /** Default ON (unset or any value other than "off"). Kill-switch: STRATA_DENSE_TURN_LANE=off. */
      get enabled() { return process.env.STRATA_DENSE_TURN_LANE !== "off"; },
      queryTaskType: "RETRIEVAL_QUERY",
      docTaskType: "RETRIEVAL_DOCUMENT",
      /** Max turn results to include in read-side fusion (mirrors benchmark.denseTurnLane.maxTurnResults). */
      maxTurnResults: 10,
      /**
       * Process-global max concurrent embedBatch calls across all per-tenant turn stores.
       * Prevents a single large tenant's buildFullIndex from exhausting the shared
       * GEMINI_API_KEY quota and degrading all other tenants to FTS5-only.
       * Override via STRATA_DENSE_TURN_MAX_CONCURRENCY env var.
       */
      get maxConcurrentEmbedBatches() {
        const v = Number(process.env.STRATA_DENSE_TURN_MAX_CONCURRENCY);
        return (Number.isFinite(v) && v > 0) ? v : 5;
      },
    },
  },

  // Indexing
  indexing: {
    chunkSize: 1600, // tokens per chunk
    chunkOverlap: 50,
    maxChunksPerSession: 500,
    /**
     * Minimum details length (chars) at which store_memory ALSO indexes the
     * details text into DocumentChunkStore (chunked + embedded) for better
     * FTS5/vector retrieval of long multi-paragraph memories.
     * When details.length <= this value, only the atomic knowledge entry is written.
     */
    storeMemoryChunkThreshold: 800,
    /**
     * Maximum number of pages embedded per PDF on the text-only path
     * (>6-page PDFs). Pages beyond this cap are dropped with a WARN log.
     * Multimodal path (≤6 pages) is unaffected.
     * Override via STRATA_PDF_MAX_PAGES env var.
     */
    maxPdfPages: Number(process.env.STRATA_PDF_MAX_PAGES) || 100,
  },

  // File watcher
  watcher: {
    debounceMs: 5000,
    staleSessionMinutes: 5,
  },

  // Extra watch directories from env var (format: "path:extension,path:extension")
  get extraWatchDirs(): string[] {
    const raw = process.env.STRATA_EXTRA_WATCH_DIRS || "";
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
  },

  // Cloud sync
  cloud: {
    apiUrl: process.env.STRATA_API_URL || "",
    apiKey: process.env.STRATA_API_KEY || "",
    teamId: process.env.STRATA_TEAM_ID || "",
  },
  get syncStateFile() {
    return join(this.dataDir, "sync-state.json");
  },

  // Recall pipeline tuning (NPC TIR + QDP). Spec 2026-04-26-npc-recall-tir-qdp-design.md.
  recall: {
    qdp: {
      // Near-duplicate dedupe: drop the lower-ranked of any pair with character-trigram
      // Jaccard similarity at or above this threshold.
      dedupeJaccard: 0.85,
      // Filler filter: items shorter than this (after trimEnd) AND ending with '?' AND
      // tagged exactly ['dialogue'] are dropped.
      fillerMaxLen: 40,
      // Query-coverage floor: query tokens shorter than this are dropped from the
      // coverage check (avoids false positives on stop-words / fragments).
      minTokenLen: 4,
    },
    // Community QDP defaults (TIR+QDP community port). Spec 2026-05-01-tirqdp-community-port-plan.md.
    communityQdp: {
      // Near-duplicate dedupe threshold for knowledge_entries (character-trigram Jaccard).
      dedupeJaccard: 0.85,
      // Filler filter: entries shorter than this (chars) are candidates for filler pruning.
      fillerMaxLen: 40,
      // Query-coverage floor: query tokens shorter than this are ignored in coverage scoring.
      minTokenLen: 4,
    },
  },

  // Learning synthesis
  learning: {
    similarityThreshold: 0.6,  // Jaccard similarity for clustering
    promotionThreshold: 10,    // Minimum score to promote to learning
    maxLearningsPerProject: 10,
    maxLearningLength: 120,    // Max chars per learning summary
    memoryLineBudget: 200,     // Max lines in MEMORY.md
  },

  // Importance scoring (cognitive retrieval)
  importance: {
    // Signal weights (sum to 1.0)
    typeWeight: 0.35,
    languageWeight: 0.20,
    frequencyWeight: 0.35,
    explicitWeight: 0.10,
    // Max boost multiplier applied in search ranking (0 = disabled)
    boostMax: 1.0,
  },

  // Session-level scoring (Phase 1: feature-flagged, not default)
  session: {
    /** Candidate pool multiplier for session-level search. Fetch this many chunks before aggregation. */
    turnRetrievalK: 200,
    /** Number of sessions to return from session-level search */
    sessionTopK: 10,
    /** Whether session-level scoring is the default search mode */
    enableByDefault: false,
    /** Knowledge boost: multiplier for existing sessions with knowledge matches (0 = disabled) */
    knowledgeBoostExisting: 0.0,
    /** Knowledge boost: baseline score for sessions found ONLY via knowledge (not in FTS).
     *  Previously disabled (0.0) because LIKE search had near-zero precision.
     *  Re-enabled after FTS5 on knowledge table provides precise matching. */
    knowledgeBoostNew: 0.1,
    /** Entity boost: multiplier for existing sessions with entity matches */
    entityBoostExisting: 0.0,
    /** Max recency boost for knowledge-update queries (0 = disabled, 0.5 = 1.0x oldest to 1.5x newest) */
    recencyBoostMax: 0.5,
    /** #41 A3: max chunks per session admitted to the session-aggregation candidate
     *  pool (0 = disabled). Prevents one dominant session from starving the pool
     *  of distinct sessions. Gate-flipped via AutoResearch; do not change without
     *  re-running the MS-slice gate. */
    maxChunksPerSessionInPool: 0,
    /** CB lever (#37): total char budget for session notes in the deep-path final
     *  slice (0 = disabled). Soft guard — the note crossing the budget is kept.
     *  Targets the A0 200k-char context regressions; OFF-arm evidence says the
     *  affected questions answer correctly at <=118k chars. Gate-flipped via
     *  AutoResearch; do not change without re-running the MS-slice gate. */
    deepContextCharBudget: 130000,
  },

  // Cross-encoder reranking (Phase 2b)
  reranker: {
    /** Enable/disable reranking entirely. */
    enabled: true,
    /** Number of sessions to send to the reranker (top-N from DCG scoring). */
    candidateCount: 30,
    /** Minimum relevance score from reranker to keep a result (0–1). */
    minRelevanceScore: 0.01,
    /** Timeout for reranker inference in ms. */
    timeoutMs: 5000,
    /** Weight blending: final = alpha * rerankScore + (1 - alpha) * dcgScore.
     *  1.0 = pure reranker, 0.0 = pure DCG (reranker disabled). */
    alpha: 0.7,
    /** Log reranker latency and score distribution. */
    debug: false,
    /** Skip reranking for counting questions (benchmark: -6pp regression when enabled). */
    skipForCounting: true,
    /** Skip reranking for temporal reasoning questions (benchmark: -20pp regression when enabled). */
    skipForTemporal: true,
  },

  // Profile synthesis (structural reasoning)
  profile: {
    expertiseMinMentions: 10,
    expertiseMinTenureDays: 30,
    expertiseMinProjects: 2,
    preferenceMinEntries: 3,
    preferenceMinRatio: 3,       // for/against ratio to qualify as a preference
    stackMinCoOccurrence: 0.6,   // co-occurrence score threshold for stack claims
    gapMinOccurrences: 3,
    contradictionMinSimilarity: 0.7,
    maxClaimsPerCategory: 10,
  },

  // Evidence gap tracking
  gaps: {
    enabled: true,
    // Minimum Jaccard similarity for gap resolution
    resolutionThreshold: 0.4,
    // Max open gaps per project (oldest auto-pruned)
    maxPerProject: 100,
    // Auto-prune unresolved gaps older than this (days)
    pruneAfterDays: 90,
  },

  health: {
    /** Per-check threshold cutoffs (value above = the status). */
    thresholds: {
      embedding_coverage: { ok: 0.95, warn: 0.70 },
      summary_coverage:   { ok: 0.50, warn: 0.20 },
      extraction_success: { ok: 0.95, warn: 0.80 },
      entity_quality:     { ok: 0.85, warn: 0.60 },
      gap_close_rate:     { ok: 0.50, warn: 0.20 },
    },
  },

  // Spec 2026-04-28 — atomic-fact extraction conflict resolution.
  extraction: {
    /**
     * Subject-collision detection mode for the extraction worker.
     * - "exact":     compare normalized (subject_key, predicate_key) for equality (default)
     * - "off":       skip collision detection entirely (used during the spec's
     *                Step 1 baseline measurement; not recommended for prod)
     * - "embedding": (future, Option 4 from Spec 2026-04-28 brainstorm) — wired
     *                but currently delegates to "exact"; reserved for follow-up.
     */
    conflictDetection: "exact" as "exact" | "off" | "embedding",
    /** Cosine threshold for embedding mode. Ignored unless conflictDetection === "embedding". */
    embeddingThreshold: 0.85,
  },

  // SVO event extraction
  events: {
    /** Enable SVO event extraction at ingest time. Requires GEMINI_API_KEY. */
    enabled: true,
    /** Number of lexical aliases per event (more = better vocabulary bridging, more tokens) */
    aliasCount: 3,
  },

  // Model-aware retrieval routing
  modelRouting: {
    /** Enable model-aware retrieval parameter adjustment */
    enabled: false,
    /** Default profile when model is unknown */
    defaultProfile: "medium" as "large" | "medium" | "small",
    profiles: {
      /** Large context models (>500K): Gemini Flash/Pro, Claude with extended context */
      large: { sessionTopK: 20, useReranker: true },
      /** Medium context models (32K-500K): GPT-4o, Claude Sonnet/Opus, Gemini Nano */
      medium: { sessionTopK: 10, useReranker: true },
      /** Small context models (<32K): Distilled local models, older GPT variants */
      small: { sessionTopK: 5, useReranker: false },
    },
  },

  // Vector quantization (TurboQuant-inspired)
  quantization: {
    /** Default bit-width for vector quantization (1, 2, 4, or 8) */
    bitWidth: 4,
    /** Enable quantization for new embeddings */
    enabled: true,
    /** Padded dimension for Hadamard transform (must be power of 2 >= EMBEDDING_DIM) */
    paddedDim: 4096,
    /** Original embedding dimension */
    embeddingDim: 3072,
    /** BLOB header size in bytes */
    headerSize: 4,
    /** Migration batch size */
    migrationBatchSize: 100,
    /** Minimum cosine similarity for verify-before-overwrite during migration */
    migrationVerifyThreshold: 0.99,
  },

  // Benchmark-only fusion experiments. Default off everywhere — these
  // settings only matter when the LongMemEval benchmark / autoresearch
  // eval explicitly opts in. Production search paths never read them.
  benchmark: {
    /**
     * KU-gated turn-lane fusion (spec 2026-05-26-b2-ku-fusion-design).
     *
     *   "off"    — no fusion. Chunk-lane SearchResult[] returned as-is.
     *              Production-equivalent default.
     *   "append" — M1: turn-lane sessions not in chunk-lane top-20 get
     *              their chunks appended (up to `maxAppend` extras).
     *   "rrf"    — M2: RRF-fuse chunk-lane and turn-lane ranks; re-sort
     *              the combined SearchResult[]; keep top (20 + maxAppend).
     *
     * Override via STRATA_KU_FUSION_MODE env var for one-off eval runs.
     */
    kuFusion: {
      mode: (process.env.STRATA_KU_FUSION_MODE as "off" | "append" | "rrf") ?? "off",
      maxAppend: 5,
      widerNetLimit: 100,
      rrfK: 60,
    },

    /**
     * Dense turn-lane fusion into the answer context (spec 2026-06-02).
     *   "off" — turn hits not fused into chunk results (production-equivalent).
     *   "on"  — RRF-fuse the (hybrid) turn hits into the chunk SearchResult[]
     *           at result granularity, for ALL question types.
     * Reads the SAME env as CONFIG.search.denseTurnLane.enabled, so a single
     * STRATA_DENSE_TURN_LANE=on turns the whole lane on — both the engine-side
     * hybrid AND this fusion — eliminating the "FTS-only fusion" footgun (a
     * dense turn signal must exist before fusing it). Production never reads
     * benchmark.*.
     */
    denseTurnLane: {
      get mode(): "off" | "on" { return (process.env.STRATA_DENSE_TURN_LANE ?? "off") as "off" | "on"; },
      maxTurnResults: 10,
    },
  },

  // Embeddings model configuration
  embeddings: {
    /** Active embedding provider: "gemini" (default), "local", or "openai-compatible" */
    provider: (process.env.STRATA_EMBEDDING_PROVIDER as "gemini" | "local" | "openai-compatible") || "gemini",
    /** Model for text embeddings (conversation chunks, knowledge entries) */
    model: process.env.STRATA_EMBEDDING_MODEL || "gemini-embedding-001",
    /** Override the active model's dimension count */
    dimensions: process.env.STRATA_EMBEDDING_DIMENSIONS ? Number(process.env.STRATA_EMBEDDING_DIMENSIONS) : undefined,
    /** Base URL for openai-compatible provider */
    baseUrl: process.env.STRATA_EMBEDDING_BASE_URL || undefined,
    /** API key for openai-compatible provider */
    apiKey: process.env.STRATA_EMBEDDING_API_KEY || undefined,
    /** Model for document embeddings (PDFs, images via Gemini Embedding 2) */
    documentModel: process.env.STRATA_DOCUMENT_EMBEDDING_MODEL || "gemini-embedding-2-preview",
    /** Maximum document file size in bytes (default: 50MB) */
    maxDocumentSize: 50 * 1024 * 1024,
  },

  // Reasoning layer (agent loop over retrieval)
  reasoning: {
    /** Enable the reason_over_query MCP tool (requires an LLM API key) */
    enabled: true,
    /** Maximum agent loop iterations per query */
    maxIterations: 8,
    /** Maximum total tokens (prompt + completion) across all iterations */
    maxTokensPerQuery: 50000,
    /** Provider to use: "auto", "openai", "anthropic", or "gemini" */
    provider: process.env.STRATA_REASONING_PROVIDER || "auto",
    /** Model name override (provider-specific, e.g. "gpt-4o", "gemini-2.5-flash") */
    model: process.env.STRATA_REASONING_MODEL || "",
  },
} as const;
