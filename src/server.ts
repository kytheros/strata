/**
 * MCP server: tool registration and request handling using McpServer API.
 *
 * Community edition — 15 free tools for search, memory, semantic search, reasoning, and pattern discovery.
 *
 * Follows production MCP patterns:
 * - Category prefixes in descriptions
 * - Input examples in every tool description
 * - MCP annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint)
 * - LRU caching for search results and parsed history
 * - Deferred index loading (lazy on first tool call)
 * - CHARACTER_LIMIT enforcement on all responses
 * - Compact JSON responses with _meta tracking
 */

import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SqliteIndexManager } from "./indexing/sqlite-index-manager.js";
import { SqliteSearchEngine } from "./search/sqlite-search-engine.js";
import type { SearchResult, SearchOptions } from "./search/sqlite-search-engine.js";
import { SemanticSearchBridge } from "./search/semantic-search-bridge.js";
import { handleSearchHistory } from "./tools/search-history.js";
import { handleListProjects } from "./tools/list-projects.js";
import { handleFindSolutions } from "./tools/find-solutions.js";
import { handleGetSessionSummary } from "./tools/get-session-summary.js";
import { handleGetProjectContext } from "./tools/get-project-context.js";
import { handleFindPatterns } from "./tools/find-patterns.js";
import { handleStoreMemory } from "./tools/store-memory.js";
import { handleDeleteMemory } from "./tools/delete-memory.js";
import { handleIngestDocument } from "./tools/ingest-document.js";
import { handleGetUserProfile } from "./tools/get-user-profile.js";
import { LRUCache, cacheKey } from "./utils/cache.js";
import { buildTextResponse } from "./utils/response.js";
import { SqliteEntityStore } from "./storage/sqlite-entity-store.js";
import { SqliteEventStore } from "./storage/sqlite-event-store.js";
import type { IEntityStore, IEventStore } from "./storage/interfaces/index.js";
import { GeminiProvider } from "./extensions/llm-extraction/gemini-provider.js";
import { RealtimeWatcher } from "./watcher/realtime-watcher.js";
import { IncrementalIndexer } from "./watcher/incremental-indexer.js";
import { tryCreateGeminiEmbedder, loadGeminiApiKeyFromConfig } from "./extensions/embeddings/gemini-embedder.js";
import { handleStoreDocument } from "./tools/store-document.js";
import { DocumentChunkStore } from "./storage/document-chunk-store.js";
import { DocumentEmbedder } from "./extensions/embeddings/document-embedder.js";
import type { StorageContext } from "./storage/interfaces/index.js";
import { runAgentLoop } from "./reasoning/agent-loop.js";
import { classifyQuestion, getProcedure, getToolSubset } from "./reasoning/procedures.js";
import { CONFIG } from "./config.js";

/** Callback invoked after each tool call completes (for analytics instrumentation). */
export type ToolCallHook = (
  toolName: string,
  args: Record<string, unknown>,
  durationMs: number,
) => void;

export interface CreateServerOptions {
  /** Override data directory (for multi-tenant: per-user database path). */
  dataDir?: string;
  /** Inject an external StorageContext (e.g., D1 adapter). When omitted, defaults to SQLite. */
  storage?: StorageContext;
  /** Optional hook called after every tool call. Used by Pro for analytics recording. */
  onToolCall?: ToolCallHook;
}

export interface CreateServerResult {
  server: McpServer;
  indexManager: SqliteIndexManager | null;
  entityStore: IEntityStore;
  storage: StorageContext;
  init: () => Promise<void>;
  startRealtimeWatcher: (sessionFilePath: string) => RealtimeWatcher | null;
  stopRealtimeWatcher: () => void;
  startIncrementalIndexer: () => IncrementalIndexer | null;
  stopIncrementalIndexer: () => void;
}

export function createServer(options?: CreateServerOptions): CreateServerResult {
  const server = new McpServer(
    { name: "strata-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  /** Search result cache: 200 entries, 5 min TTL (per-server instance) */
  const searchCache = new LRUCache<string, string>(200, 300_000);

  /** History parse cache: 10 entries, 60s TTL (per-server instance) */
  const historyCache = new LRUCache<string, string>(10, 60_000);

  /** Analytics hook — called after every tool call if provided */
  const onToolCall = options?.onToolCall;

  // ── Storage resolution ────────────────────────────────────────────
  // When an external StorageContext is provided (e.g., D1 adapter), use it directly.
  // Otherwise, build the default SQLite-backed storage via IndexManager for backward compat.
  const hasExternalStorage = !!options?.storage;

  // Only create SqliteIndexManager when no external storage is provided.
  // In Workers environments (D1), there is no filesystem — IndexManager cannot be created.
  // nosemgrep: semgrep.mcp-path-traversal-risk — dataDir comes from CLI args or developer config, not user input
  const dbPath = options?.dataDir ? join(options.dataDir, "strata.db") : undefined;
  const indexManager = hasExternalStorage ? null : new SqliteIndexManager(dbPath);

  // Build the StorageContext. When injected (D1 path), use the provided context.
  // When defaulting to SQLite, wrap IndexManager's own stores to avoid opening the DB twice.
  const storage: StorageContext = options?.storage ?? {
    knowledge: indexManager!.knowledge,
    documents: indexManager!.documents,
    entities: new SqliteEntityStore(indexManager!.db),
    summaries: indexManager!.summaries,
    meta: indexManager!.meta,
    close: async () => { indexManager!.close(); },
  };

  const entityStore: IEntityStore = storage.entities;

  // -- Event store (SVO extraction) --
  // Only available when SQLite is the backend (not D1).
  const eventStore: IEventStore | null = indexManager
    ? new SqliteEventStore(indexManager.db)
    : null;

  // Wire event store + Gemini provider into index manager for ingest-time extraction
  if (indexManager && eventStore) {
    indexManager.setEventStore(eventStore);
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey) {
      indexManager.setGeminiProvider(new GeminiProvider({ apiKey: geminiApiKey }));
    }
  }

  const searchEngine = new SqliteSearchEngine(
    storage.documents,
    null, // embedder — set later by semantic search bridge if available
    null, // vectorSearch — set later
    entityStore,
    storage.knowledge
  );

  // Wire event store into search engine for session-level event signals
  if (eventStore) {
    searchEngine.setEventStore(eventStore);
  }

  // Document storage and embedder for store_document tool
  const documentChunkStore = indexManager ? new DocumentChunkStore(indexManager.db) : null;

  // Wire document chunk store into search engine for document search integration
  if (documentChunkStore) {
    searchEngine.setDocumentChunkStore(documentChunkStore);
  }

  const geminiKey = loadGeminiApiKeyFromConfig();
  const documentEmbedder = geminiKey
    ? new DocumentEmbedder({ apiKey: geminiKey, model: CONFIG.embeddings.documentModel })
    : null;

  let initialized = false;

  // -- Semantic search bridge (lazy init, graceful degradation) --
  // Created eagerly but initialization deferred until first use.
  // Returns null on search when no Gemini credentials are available.
  // On D1 path, db is null — bridge will gracefully degrade (no vector search).
  const semanticBridge = new SemanticSearchBridge(storage.documents, indexManager?.db ?? null);

  // -- Lazy embedder initialization for write-side embedding --
  // Runs once, injects embedder into SqliteKnowledgeStore for auto-embedding on addEntry().
  let embedderInitAttempted = false;
  async function initEmbedder(): Promise<void> {
    if (embedderInitAttempted) return;
    embedderInitAttempted = true;

    try {
      const embedder = await tryCreateGeminiEmbedder();
      if (embedder) {
        // Inject the embedder into the knowledge store for write-side embedding.
        // Only works for SqliteKnowledgeStore (has embedder field); D1 store handles this internally.
        if (indexManager) {
          (indexManager.knowledge as any).embedder = embedder; // eslint-disable-line @typescript-eslint/no-explicit-any
        }
        console.error("[strata] Semantic search: active (Gemini embeddings)");
      } else {
        console.error("[strata] Semantic search: inactive — set GEMINI_API_KEY or configure in dashboard");
      }
    } catch {
      // No credentials available -- write-side embedding disabled
      console.error("[strata] Semantic search: inactive — set GEMINI_API_KEY or configure in dashboard");
    }
  }

  // -- Lazy reranker initialization --
  // Runs once, injects reranker into SqliteSearchEngine for session-level reranking.
  let rerankerInitAttempted = false;
  async function initReranker(): Promise<void> {
    if (rerankerInitAttempted) return;
    rerankerInitAttempted = true;

    try {
      const { createReranker } = await import("./search/reranker/factory.js");
      const reranker = await createReranker();
      if (reranker.name !== "none") {
        searchEngine.setReranker(reranker);
      }
    } catch {
      // Reranker not available — search continues without reranking
    }
  }

  async function ensureIndex(): Promise<void> {
    if (initialized) return;

    // Skip indexing on D1 path — no local files to index
    if (indexManager) {
      const stats = indexManager.getStats();
      if (stats.documents === 0) {
        indexManager.buildFullIndex();
      } else {
        indexManager.incrementalUpdate();
      }
    }
    initialized = true;

    // Fire-and-forget: try to initialize write-side embedder and reranker
    initEmbedder().catch(() => {});
    initReranker().catch(() => {});
  }

  // -- Build async search callbacks that use semantic bridge --
  // When the bridge returns null (no embedder), falls back to FTS5.

  const asyncSearch = async (query: string, options: SearchOptions): Promise<SearchResult[]> => {
    const hybridResults = await semanticBridge.search(query, options);
    if (hybridResults !== null) return hybridResults;
    // Fallback: FTS5 search
    return await searchEngine.search(query, options);
  };

  const asyncSearchSolutions = async (
    errorOrProblem: string,
    technology?: string,
    user?: string
  ): Promise<SearchResult[]> => {
    const hybridResults = await semanticBridge.searchSolutions(errorOrProblem, technology, user);
    if (hybridResults !== null) return hybridResults;
    // Fallback: FTS5 search
    return await searchEngine.searchSolutions(errorOrProblem, technology, user);
  };

  // ── search_history ─────────────────────────────────────────────────

  server.registerTool(
    "search_history",
    {
      description: `🔍 SEARCH: Full-text search across past conversations.

FTS5 full-text search with BM25 ranking, automatically enhanced with semantic vector search when GEMINI_API_KEY is set. Use to locate past discussions about any topic — including finding where you talked about bugs, errors, or specific subjects. Supports inline filter syntax and explicit date-range parameters for project, date range, and tool filtering. Can browse sessions by date range alone (no text query required). Supports model-aware retrieval routing: pass the 'model' parameter to optimize result count and ranking for your model's context window.

Parameters:
- query: Search text with optional filters (required, can be empty string for date-only browsing)
- project: Filter to specific project (optional)
- limit: Max results, 1-100 (default: 20)
- include_context: Show surrounding messages (default: false)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)
- max_chars: Maximum characters per result text (default: 2500, max: 10000)
- after_date: Filter results after this date — ISO format (2024-01-15) or relative (7d, 30d, 1w, 1m) (optional)
- before_date: Filter results before this date — ISO format (2024-01-15) or relative (7d, 30d, 1w, 1m) (optional)
- model: Consuming model name for retrieval optimization (optional, e.g., 'gemini-2.0-flash', 'gpt-4o')

Filter syntax (include in query string):
- project:name — filter by project
- before:7d / after:30d — relative date filters
- before:2024-01-15 — absolute date filter
- tool:Bash — filter by tool used

Example: Search for Docker configuration discussions in a specific project
Example: Find where we talked about login issues
Example: Browse all sessions from the last 7 days — query: "", after_date: "7d"`,
      inputSchema: z.object({
        query: z.string().describe("Search query with optional inline filters (e.g., 'docker compose project:myapp after:7d'). Can be empty string for date-only browsing when after_date or before_date is set."),
        project: z.string().optional().describe("Filter to a specific project name or path"),
        limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
        include_context: z.boolean().optional().describe("Include surrounding message context (default: false)"),
        format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
        user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
        max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
        after_date: z.string().optional().describe("Filter results after this date (ISO format: 2024-01-15, or relative: 7d, 30d, 1w, 1m)"),
        before_date: z.string().optional().describe("Filter results before this date (ISO format: 2024-01-15, or relative: 7d, 30d, 1w, 1m)"),
        model: z.string().optional().describe("Consuming model name for retrieval optimization (e.g., 'gemini-2.0-flash', 'gpt-4o')"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("search", args.query, args.project, args.limit, args.include_context, args.format, args.user, args.max_chars, args.after_date, args.before_date, args.model);
      const cached = searchCache.get(key);
      if (cached) {
        onToolCall?.("search_history", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = await handleSearchHistory(searchEngine, args, indexManager?.db, asyncSearch, storage.knowledge);

      searchCache.set(key, result);
      onToolCall?.("search_history", args as Record<string, unknown>, Date.now() - start);

      const guidance = result.startsWith("No results")
        ? "Try broader terms, or use list_projects to see available projects."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── list_projects ──────────────────────────────────────────────────

  server.registerTool(
    "list_projects",
    {
      description: `🔍 DISCOVERY: List all projects with conversation history.

Shows project names, session counts, message counts, and date ranges. Use this to discover what projects have searchable history before running targeted searches.

Parameters:
- sort_by: Sort order — 'recent' (default), 'sessions', 'messages', or 'name'
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)

Example: List projects sorted by most recent activity
Example: Find which project has the most conversation sessions`,
      inputSchema: z.object({
        sort_by: z.enum(["recent", "sessions", "messages", "name"]).optional().describe("Sort order (default: recent)"),
        format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
        user: z.string().optional().describe("Filter to a specific user scope (omit to list all)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("list_projects", args.sort_by, args.format, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        onToolCall?.("list_projects", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      const result = handleListProjects(args);
      historyCache.set(key, result);
      onToolCall?.("list_projects", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── find_solutions ─────────────────────────────────────────────────

  server.registerTool(
    "find_solutions",
    {
      description: `🔍 SEARCH: Find how you solved a specific error or problem in a past session.

Use when you have an ACTIVE problem and need past fixes — solution-biased ranking surfaces fix/resolution language. NOT for general topic searches; use search_history to find past discussions about any subject. Automatically enhanced with semantic search when GEMINI_API_KEY is set.

Parameters:
- error_or_problem: The error message or problem description (required)
- technology: Technology context for better matching (optional)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)
- max_chars: Maximum characters per result text (default: 2500, max: 10000)

Example: Find how a "ECONNREFUSED" error was fixed in past Docker work
Example: Search for solutions to TypeScript type inference issues`,
      inputSchema: z.object({
        error_or_problem: z.string().describe("The error message, problem description, or issue to find solutions for"),
        technology: z.string().optional().describe("Technology context (e.g., 'docker', 'typescript', 'react')"),
        format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
        user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
        max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("find_solutions", args.error_or_problem, args.technology, args.format, args.user, args.max_chars);
      const cached = searchCache.get(key);
      if (cached) {
        onToolCall?.("find_solutions", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = await handleFindSolutions(searchEngine, args, indexManager?.db, asyncSearchSolutions, storage.knowledge);

      searchCache.set(key, result);
      onToolCall?.("find_solutions", args as Record<string, unknown>, Date.now() - start);

      const guidance = result.startsWith("No past solutions")
        ? "Try shorter error text, or use search_history with broader terms."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── semantic_search ────────────────────────────────────────────────

  server.registerTool(
    "semantic_search",
    {
      description: `🔍 SEARCH: Semantic search using vector embeddings — finds results that keyword search misses.

Combines FTS5 BM25 keyword search with vector cosine similarity via Reciprocal Rank Fusion.
Finds semantically similar content (e.g., "authentication" finds "login flow", "OAuth setup").
Requires GEMINI_API_KEY environment variable. Falls back to FTS5 keyword search if not set.

Parameters:
- query: Search text (required)
- project: Filter to specific project (optional)
- limit: Max results, 1-100 (default: 20)
- threshold: Minimum cosine similarity, 0.0-1.0 (optional)
- max_chars: Maximum characters per result text (default: 2500, max: 10000)

Example: Find discussions about authentication patterns
Example: Search for database optimization approaches in a specific project`,
      inputSchema: z.object({
        query: z.string().describe("Search query — supports semantic matching beyond keywords"),
        project: z.string().optional().describe("Filter to a specific project name or path"),
        limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
        threshold: z.number().optional().describe("Minimum cosine similarity threshold (0.0-1.0)"),
        user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
        max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("semantic_search", args.query, args.project, args.limit, args.threshold, args.user, args.max_chars);
      const cached = searchCache.get(key);
      if (cached) {
        onToolCall?.("semantic_search", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      await ensureIndex();

      // Try hybrid search via bridge
      const bridgeResults = await semanticBridge.search(args.query, {
        limit: args.limit,
        project: args.project,
      });

      // If bridge returned results, format them
      if (bridgeResults !== null && bridgeResults.length > 0) {
        const maxChars = Math.min(Math.max(args.max_chars ?? 2500, 1), 10000);

        const lines: string[] = [`Semantic search: ${bridgeResults.length} result(s)\n`];
        for (const r of bridgeResults) {
          const date = new Date(r.timestamp).toISOString().slice(0, 10);
          const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
          const snippet = text.replace(/\n/g, " ");
          lines.push(`[${r.score.toFixed(3)}] ${r.project} (${date}) — ${snippet}`);
        }

        const result = lines.join("\n");
        searchCache.set(key, result);
        onToolCall?.("semantic_search", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(result);
      }

      // Fallback: FTS5 keyword search with helpful message
      const ftsResults = await searchEngine.search(args.query, {
        limit: args.limit,
        project: args.project,
        user: args.user,
      });

      if (ftsResults.length === 0) {
        const noResults = "No semantic search results found.";
        searchCache.set(key, noResults);
        onToolCall?.("semantic_search", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(
          noResults,
          bridgeResults === null
            ? "Semantic search requires GEMINI_API_KEY. Set it to enable vector embeddings. Showing FTS5 keyword results instead."
            : "Try broader terms, or use search_history for keyword-only search."
        );
      }

      const maxChars = Math.min(Math.max(args.max_chars ?? 2500, 1), 10000);
      const fallbackNote = bridgeResults === null
        ? "Note: Showing keyword search results. Set GEMINI_API_KEY to enable full semantic search.\n"
        : "";

      const lines: string[] = [`${fallbackNote}Search: ${ftsResults.length} result(s)\n`];
      for (const r of ftsResults) {
        const date = new Date(r.timestamp).toISOString().slice(0, 10);
        const text = r.text.length > maxChars ? r.text.slice(0, maxChars) + "..." : r.text;
        const snippet = text.replace(/\n/g, " ");
        lines.push(`[${r.score.toFixed(3)}] ${r.project} (${date}) — ${snippet}`);
      }

      const result = lines.join("\n");
      searchCache.set(key, result);
      onToolCall?.("semantic_search", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── get_session_summary ────────────────────────────────────────────

  server.registerTool(
    "get_session_summary",
    {
      description: `📖 READ: Get a summary of a single conversation session — what happened today, in your last session, or in a specific session by ID.

Returns session metadata, initial topic, tools used, key topics, and conversation flow. Provide either a session ID or project name (returns most recent session). NOT for multi-session overviews — use list_projects for "what have I been working on lately" or find_patterns for recurring trends.

Parameters:
- session_id: Specific session UUID (optional)
- project: Project name — returns most recent session (optional)
- At least one parameter is required.

Example: Get summary of the most recent session for the Kytheros project
Example: What did I work on today?`,
      inputSchema: z.object({
        session_id: z.string().optional().describe("Specific session UUID"),
        project: z.string().optional().describe("Project name or path — returns most recent session"),
        user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("session_summary", args.session_id, args.project, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        onToolCall?.("get_session_summary", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      const result = handleGetSessionSummary(args);
      historyCache.set(key, result);
      onToolCall?.("get_session_summary", args as Record<string, unknown>, Date.now() - start);

      const guidance = result.includes("not found")
        ? "Use list_projects to see available projects, or search_history to find session IDs."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── get_project_context ────────────────────────────────────────────

  server.registerTool(
    "get_project_context",
    {
      description: `📖 READ: Get comprehensive context for a specific project — recent sessions, key topics, and patterns.

Deep dive into one named project. Use when the user asks "what do you know about [project]?" or wants project-level context before starting work. Returns recent sessions with topics, message counts, and optionally common topics analysis.

Parameters:
- project: Project name or path (required)
- depth: Detail level — 'brief' (last session), 'normal' (last 3), 'detailed' (last 5 + topic analysis). Default: normal.

Example: Get brief context for the current project before starting work
Example: What do you know about my React project?`,
      inputSchema: z.object({
        project: z.string().optional().describe("Project name or path"),
        depth: z.enum(["brief", "normal", "detailed"]).optional().describe("Detail level (default: normal)"),
        user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("project_context", args.project, args.depth, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        onToolCall?.("get_project_context", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      await ensureIndex();

      // Compute compact profile summary for context enrichment
      let profileSummary: string | undefined;
      try {
        const { synthesizeProfile, formatProfileCompact } = await import("./knowledge/profile-synthesizer.js");
        const profile = await synthesizeProfile(
          { knowledge: storage.knowledge, entities: storage.entities, summaries: storage.summaries, gapDb: indexManager?.db },
          { project: args.project, user: args.user },
        );
        const compact = formatProfileCompact(profile);
        if (compact) profileSummary = compact;
      } catch {
        // Profile synthesis is best-effort — don't block context retrieval
      }

      const result = handleGetProjectContext(searchEngine, args, profileSummary);
      historyCache.set(key, result);
      onToolCall?.("get_project_context", args as Record<string, unknown>, Date.now() - start);

      const guidance = result.includes("No history found")
        ? "Use list_projects to see which projects have conversation history."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── get_user_profile ────────────────────────────────────────────────

  server.registerTool(
    "get_user_profile",
    {
      description: `🔍 PROFILE: Synthesized user expertise, preferences, workflow patterns, technology stack, and knowledge gaps.

Structural reasoning over your accumulated knowledge — computes claims from entity mentions, knowledge entry types, session patterns, and evidence gaps. Every claim includes evidence (mention counts, entry IDs, dates). Zero LLM cost.

Parameters:
- project: Filter to a specific project (optional)
- user: Filter to a specific user scope (optional)

Example: What does Strata know about me?
Example: Show my expertise profile for this project`,
      inputSchema: z.object({
        project: z.string().optional().describe("Project name or path (omit for cross-project profile)"),
        user: z.string().optional().describe("Filter to a specific user scope"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("user_profile", args.project, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        onToolCall?.("get_user_profile", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = await handleGetUserProfile(storage, args, indexManager?.db);
      historyCache.set(key, result);
      onToolCall?.("get_user_profile", args as Record<string, unknown>, Date.now() - start);

      const guidance = result.includes("Not enough data")
        ? "Use Strata across more sessions to build up knowledge for profile synthesis."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── find_patterns ──────────────────────────────────────────────────

  server.registerTool(
    "find_patterns",
    {
      description: `📊 ANALYSIS: Discover recurring patterns in conversation history.

Analyzes common topics, activity patterns (busiest day/hour, session lengths), and repeated issues. Helps identify workflow trends and recurring problems.

Parameters:
- project: Limit analysis to a specific project (optional — analyzes all if omitted)
- type: Pattern category — 'topics', 'workflows', 'issues', or 'all' (default: all)

Example: Find recurring issues in the Kytheros project
Example: Analyze workflow patterns across all projects`,
      inputSchema: z.object({
        project: z.string().optional().describe("Limit to a specific project"),
        type: z.enum(["topics", "workflows", "issues", "all"]).optional().describe("Type of patterns to find (default: all)"),
        user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const key = cacheKey("find_patterns", args.project, args.type, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        onToolCall?.("find_patterns", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(cached);
      }

      const result = handleFindPatterns(args);
      historyCache.set(key, result);
      onToolCall?.("find_patterns", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── store_memory ────────────────────────────────────────────────────

  server.registerTool(
    "store_memory",
    {
      description: `💾 MEMORY: Explicitly store a memory for future recall.

Store knowledge that should be remembered across sessions. Stored memories are immediately searchable via search_history and find_solutions.

Parameters:
- memory: The text to remember (required)
- type: Category — 'decision', 'solution', 'error_fix', 'pattern', 'learning', 'procedure', 'fact', 'preference', or 'episodic' (required)
- tags: Optional tags for categorization (optional)
- project: Project context (optional, defaults to 'global')
- user: User scope (optional, defaults to STRATA_DEFAULT_USER env var or 'default')

Example: Remember that "always run migrations before seeding" as a decision
Example: Store a user preference like "prefers dark mode"
Example: Store a fact like "API rate limit is 100/min"`,
      inputSchema: z.object({
        memory: z.string().describe("The text to remember"),
        type: z.enum(["decision", "solution", "error_fix", "pattern", "learning", "procedure", "fact", "preference", "episodic"]).describe("Category: decision, solution, error_fix, pattern, learning, procedure, fact, preference, or episodic"),
        tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
        project: z.string().optional().describe("Project context (default: global)"),
        user: z.string().optional().describe("User scope (default: STRATA_DEFAULT_USER env var or 'default')"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const result = await handleStoreMemory(storage.knowledge, args, indexManager?.db);
      onToolCall?.("store_memory", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── delete_memory ───────────────────────────────────────────────────

  server.registerTool(
    "delete_memory",
    {
      description: `🗑️ MEMORY: Remove or permanently delete a stored memory entry.

Use this directly — NOT search_history — when the user wants to delete, remove, erase, retract, or discard an incorrect/stale/wrong memory. The deletion is recorded in the audit history.

Parameters:
- id: The entry ID to delete (required)

Example: Delete a stale entry — delete_memory({ id: "abc-123" })`,
      inputSchema: z.object({
        id: z.string().describe("The entry ID to delete"),
      }).strict(),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      const start = Date.now();
      const result = await handleDeleteMemory(storage.knowledge, args);
      onToolCall?.("delete_memory", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── ingest_document ──────────────────────────────────────────────────

  server.registerTool(
    "ingest_document",
    {
      description: `📄 MEMORY: Extract and store structured insights from an uploaded document.

Called by the model AFTER reading a document the user has uploaded. Extracts key findings, metrics, and a summary, then stores them as searchable knowledge entries for future recall.

Parameters:
- source: Document filename or identifier (required)
- document_type: Category — 'report', 'spreadsheet', 'policy', 'assessment', 'presentation', or 'other' (required)
- summary: 1-3 sentence executive summary of the document (required)
- key_findings: Array of key findings/insights extracted from the document (required)
- metrics: Key-value pairs of important metrics (optional)
- tags: Additional tags for categorization (optional)
- project: Project context (optional, defaults to 'global')
- user: User scope (optional)

Example: Extract key findings from an uploaded financial spreadsheet
Example: Store insights from a company AI readiness assessment PDF`,
      inputSchema: z.object({
        source: z.string().describe("Document filename or identifier"),
        document_type: z.enum(["report", "spreadsheet", "policy", "assessment", "presentation", "other"]).describe("Document category"),
        summary: z.string().describe("1-3 sentence executive summary of the document"),
        key_findings: z.array(z.string()).describe("Key findings/insights extracted from the document"),
        metrics: z.record(z.string(), z.string()).optional().describe("Key metrics as key-value pairs"),
        tags: z.array(z.string()).optional().describe("Additional tags for categorization"),
        project: z.string().optional().describe("Project context (default: global)"),
        user: z.string().optional().describe("User scope"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      const result = await handleIngestDocument(storage.knowledge, args);
      onToolCall?.("ingest_document", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── search_events ─────────────────────────────────────────────────

  server.registerTool(
    "search_events",
    {
      description: `🔍 SEARCH: Search structured events extracted from conversation history.

Returns Subject-Verb-Object event tuples with dates and categories. Events bridge vocabulary gaps — searching for "fitness tracker" finds events where the user "bought Fitbit" via lexical aliases.

Parameters:
- query: Search text (required)
- limit: Max results (default: 20, max: 100)

Example: Find all purchase events
Example: Search for events related to cooking or restaurants`,
      inputSchema: z.object({
        query: z.string().describe("Search query for events"),
        limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
        user: z.string().optional().describe("Filter to a specific user scope"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      await ensureIndex();

      if (!eventStore) {
        onToolCall?.("search_events", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse("Event search is not available (no local database).");
      }

      const limit = Math.min(args.limit ?? 20, 100);
      const events = await eventStore.search(args.query, limit);

      if (events.length === 0) {
        onToolCall?.("search_events", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(`No events found for "${args.query}".`);
      }

      const lines: string[] = [`Found ${events.length} event(s) for "${args.query}":\n(Use these as hints — supplementary context from the user's history. The list may not be exhaustive.)\n`];
      for (const e of events) {
        const date = e.startDate ? ` (${e.startDate})` : "";
        const aliases = e.aliases.length > 0 ? ` [also: ${e.aliases.join("; ")}]` : "";
        lines.push(`- ${e.subject} ${e.verb} ${e.object}${date} [${e.category}]${aliases}`);
      }

      onToolCall?.("search_events", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(lines.join("\n"));
    }
  );

  // ── reason_over_query ──────────────────────────────────────────────

  server.registerTool(
    "reason_over_query",
    {
      description: `🧠 REASONING: Run a multi-step agent loop that iteratively searches your conversation history to answer complex questions.

Uses an LLM to plan searches, reflect on results, and synthesize answers — handling counting, temporal, comparison, and factual questions that require multiple retrieval steps. Requires an LLM API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY).

Parameters:
- query: The question to answer (required)
- max_iterations: Maximum search iterations (optional, default: 8, max: 15)
- model: Override LLM model name (optional, e.g., 'gpt-4o', 'gemini-2.5-flash')
- user: User scope for multi-tenant isolation (optional)

Example: How many model kits have I purchased?
Example: What restaurant did I visit most recently?
Example: Which programming language do I use most often?`,
      inputSchema: z.object({
        query: z.string().describe("The question to answer by searching conversation history"),
        max_iterations: z.number().optional().describe("Maximum agent loop iterations (default: 8, max: 15)"),
        model: z.string().optional().describe("Override LLM model (e.g., 'gpt-4o', 'gemini-2.5-flash')"),
        user: z.string().optional().describe("User scope for multi-tenant isolation"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const start = Date.now();
      await ensureIndex();

      if (!CONFIG.reasoning.enabled) {
        onToolCall?.("reason_over_query", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(
          "Reasoning is disabled. Enable it by setting STRATA_REASONING_ENABLED=true or updating CONFIG.reasoning.enabled.",
          "The reason_over_query tool requires the reasoning layer to be enabled."
        );
      }

      try {
        const deps = {
          searchEngine,
          documentStore: storage.documents,
          eventStore: eventStore ?? undefined,
          knowledgeStore: storage.knowledge,
        };

        const options = {
          maxIterations: args.max_iterations ? Math.min(args.max_iterations, 15) : undefined,
          model: args.model,
          user: args.user,
        };

        const result = await runAgentLoop(args.query, deps, options);

        const totalTokens = result.tokenUsage.promptTokens + result.tokenUsage.completionTokens;
        const latencySec = (result.latencyMs / 1000).toFixed(1);
        const metadata = [
          "",
          "---",
          `Question type: ${result.questionType}`,
          `Iterations: ${result.iterations}`,
          `Tool calls: ${result.toolCallLog.length}`,
          `Tokens: ${totalTokens.toLocaleString()} (${result.tokenUsage.promptTokens.toLocaleString()} prompt + ${result.tokenUsage.completionTokens.toLocaleString()} completion)`,
          `Latency: ${latencySec}s`,
        ].join("\n");

        onToolCall?.("reason_over_query", args as Record<string, unknown>, Date.now() - start);
        return buildTextResponse(result.answer + metadata);
      } catch (err) {
        onToolCall?.("reason_over_query", args as Record<string, unknown>, Date.now() - start);
        const msg = err instanceof Error ? err.message : String(err);
        return buildTextResponse(
          `Reasoning error: ${msg}`,
          "Ensure an LLM API key is set (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY)."
        );
      }
    }
  );

  // ── get_search_procedure ──────────────────────────────────────────

  server.registerTool(
    "get_search_procedure",
    {
      description: `📋 REASONING: Classify a question and return the recommended search procedure without making any LLM calls.

Analyzes the question type (counting, temporal, comparison, duration, factual) and returns step-by-step search instructions and the recommended tool subset. Use this for client-side reasoning or to preview what reason_over_query would do.

Parameters:
- query: The question to classify (required)

Example: Classify "How many books have I read?" → counting procedure
Example: Get the search strategy for "When did I last visit Tokyo?"`,
      inputSchema: z.object({
        query: z.string().describe("The question to classify and get a procedure for"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
      },
    },
    async (args) => {
      const start = Date.now();
      const questionType = classifyQuestion(args.query);
      const procedure = getProcedure(questionType);
      const tools = getToolSubset(questionType);

      const result = [
        `Question type: ${questionType}`,
        `Recommended tools: ${tools.join(", ")}`,
        "",
        "## Procedure",
        "",
        procedure,
      ].join("\n");

      onToolCall?.("get_search_procedure", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── store_document ──────────────────────────────────────────────────

  server.registerTool(
    "store_document",
    {
      description: `📄 STORAGE: Store a document (PDF, text, image) with multimodal embeddings for semantic search.

Accepts raw document content and generates vector embeddings using Gemini Embedding 2. The document is chunked, embedded, and stored for retrieval via semantic_search and search_history. Requires GEMINI_API_KEY.

Parameters:
- file_path: Path to a local file (optional, for stdio/local usage)
- content: Base64-encoded document content (optional, for HTTP/agent usage)
- mime_type: Document type — "application/pdf", "text/plain", "image/png", "image/jpeg" (required)
- title: Human-readable document name (required)
- tags: Tags for categorization (optional)
- project: Project scope (optional, default: "global")
- user: User scope for multi-tenant isolation (optional)

One of file_path or content is required.

Example: Store a PDF report for future search
Example: Store a screenshot for visual reference`,
      inputSchema: z.object({
        file_path: z.string().optional().describe("Path to a local file"),
        content: z.string().optional().describe("Base64-encoded document content"),
        mime_type: z.string().describe("MIME type: application/pdf, text/plain, image/png, image/jpeg"),
        title: z.string().describe("Human-readable document name"),
        tags: z.array(z.string()).optional().describe("Tags for categorization"),
        project: z.string().optional().describe("Project scope (default: global)"),
        user: z.string().optional().describe("User scope for multi-tenant isolation"),
      }).strict(),
    },
    async (args) => {
      const start = Date.now();
      if (!documentChunkStore) {
        return buildTextResponse("Error: store_document is not available in this deployment (no local database).");
      }
      const result = await handleStoreDocument(documentChunkStore, documentEmbedder, args);
      onToolCall?.("store_document", args as Record<string, unknown>, Date.now() - start);
      return buildTextResponse(result);
    }
  );

  // ── Watcher infrastructure ────────────────────────────────────────

  let realtimeWatcher: RealtimeWatcher | null = null;
  let incrementalIndexer: IncrementalIndexer | null = null;

  return {
    server,
    indexManager,
    entityStore,
    storage,
    init: ensureIndex,
    startRealtimeWatcher(sessionFilePath: string): RealtimeWatcher | null {
      if (!indexManager) return null; // Not available on D1 path
      if (realtimeWatcher) {
        realtimeWatcher.stop();
      }
      realtimeWatcher = new RealtimeWatcher(sessionFilePath, indexManager.knowledge);
      realtimeWatcher.start();
      return realtimeWatcher;
    },
    stopRealtimeWatcher(): void {
      if (realtimeWatcher) {
        realtimeWatcher.stop();
        realtimeWatcher = null;
      }
    },
    startIncrementalIndexer(): IncrementalIndexer | null {
      if (!indexManager) return null; // Not available on D1 path
      if (incrementalIndexer) {
        incrementalIndexer.stop();
      }
      incrementalIndexer = new IncrementalIndexer(
        indexManager,
        indexManager.knowledge,
        entityStore,
        indexManager.registry
      );
      incrementalIndexer.start();
      return incrementalIndexer;
    },
    stopIncrementalIndexer(): void {
      if (incrementalIndexer) {
        incrementalIndexer.stop();
        incrementalIndexer = null;
      }
    },
  };
}
