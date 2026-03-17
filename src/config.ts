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
    recencyBoost7d: 1.2,
    recencyBoost30d: 1.1,
    // Project match boost
    projectMatchBoost: 1.3,
    // RRF constant
    rrfK: 60,
    // Memory decay (auto-indexed only; explicit memories exempt)
    decayPenalty90d: 0.85,
    decayPenalty180d: 0.7,
    // Confidence scoring
    confidenceHighThreshold: 0.6,
    confidenceMediumThreshold: 0.3,
    lowConfidenceThreshold: 1.5,
  },

  // Indexing
  indexing: {
    chunkSize: 500, // tokens per chunk
    chunkOverlap: 50,
    maxChunksPerSession: 200,
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
    boostMax: 0.5,
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
} as const;
