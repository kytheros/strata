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
  },

  // Indexing
  indexing: {
    chunkSize: 1600, // tokens per chunk
    chunkOverlap: 50,
    maxChunksPerSession: 500,
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

  // Embeddings model configuration
  embeddings: {
    /** Model for text embeddings (conversation chunks, knowledge entries) */
    model: process.env.STRATA_EMBEDDING_MODEL || "gemini-embedding-001",
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
