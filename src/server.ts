/**
 * MCP server: tool registration and request handling using McpServer API.
 *
 * Community edition — 9 free tools for search, memory, semantic search, and pattern discovery.
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
import { LRUCache, cacheKey } from "./utils/cache.js";
import { buildTextResponse } from "./utils/response.js";
import { SqliteEntityStore } from "./storage/sqlite-entity-store.js";
import type { IEntityStore } from "./storage/interfaces/index.js";
import { RealtimeWatcher } from "./watcher/realtime-watcher.js";
import { IncrementalIndexer } from "./watcher/incremental-indexer.js";
import { tryCreateGeminiEmbedder } from "./extensions/embeddings/gemini-embedder.js";
import type { StorageContext } from "./storage/interfaces/index.js";

export interface CreateServerOptions {
  /** Override data directory (for multi-tenant: per-user database path). */
  dataDir?: string;
  /** Inject an external StorageContext (e.g., D1 adapter). When omitted, defaults to SQLite. */
  storage?: StorageContext;
}

export interface CreateServerResult {
  server: McpServer;
  indexManager: SqliteIndexManager;
  entityStore: IEntityStore;
  storage: StorageContext;
  init: () => Promise<void>;
  startRealtimeWatcher: (sessionFilePath: string) => RealtimeWatcher | null;
  stopRealtimeWatcher: () => void;
  startIncrementalIndexer: () => IncrementalIndexer;
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

  // ── Storage resolution ────────────────────────────────────────────
  // When an external StorageContext is provided (e.g., D1 adapter), use it directly.
  // Otherwise, build the default SQLite-backed storage via IndexManager for backward compat.
  const dbPath = options?.dataDir ? join(options.dataDir, "strata.db") : undefined;
  const indexManager = new SqliteIndexManager(dbPath);

  // Build the StorageContext. When injected (D1 path), use the provided context.
  // When defaulting to SQLite, wrap IndexManager's own stores to avoid opening the DB twice.
  const storage: StorageContext = options?.storage ?? {
    knowledge: indexManager.knowledge,
    documents: indexManager.documents,
    entities: new SqliteEntityStore(indexManager.db),
    summaries: indexManager.summaries,
    meta: indexManager.meta,
    close: async () => { indexManager.close(); },
  };

  const searchEngine = new SqliteSearchEngine(indexManager.documents);
  const entityStore: IEntityStore = storage.entities;
  let initialized = false;

  // -- Semantic search bridge (lazy init, graceful degradation) --
  // Created eagerly but initialization deferred until first use.
  // Returns null on search when no Gemini credentials are available.
  const semanticBridge = new SemanticSearchBridge(indexManager.documents, indexManager.db);

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
        // The store accepts an embedder set post-construction via the private field.
        (indexManager.knowledge as any).embedder = embedder; // eslint-disable-line @typescript-eslint/no-explicit-any
        console.error("[strata] Semantic search: active (Gemini embeddings)");
      } else {
        console.error("[strata] Semantic search: inactive — set GEMINI_API_KEY or configure in dashboard");
      }
    } catch {
      // No credentials available -- write-side embedding disabled
      console.error("[strata] Semantic search: inactive — set GEMINI_API_KEY or configure in dashboard");
    }
  }

  async function ensureIndex(): Promise<void> {
    if (initialized) return;

    const stats = indexManager.getStats();
    if (stats.documents === 0) {
      indexManager.buildFullIndex();
    } else {
      indexManager.incrementalUpdate();
    }
    initialized = true;

    // Fire-and-forget: try to initialize write-side embedder
    initEmbedder().catch(() => {});
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

  server.tool(
    "search_history",
    `🔍 SEARCH: Full-text search across past conversations.

FTS5 full-text search with BM25 ranking, automatically enhanced with semantic vector search when GEMINI_API_KEY is set. Use to locate past discussions about any topic — including finding where you talked about bugs, errors, or specific subjects. Supports inline filter syntax for project, date range, and tool filtering.

Parameters:
- query: Search text with optional filters (required)
- project: Filter to specific project (optional)
- limit: Max results, 1-100 (default: 20)
- include_context: Show surrounding messages (default: false)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)
- max_chars: Maximum characters per result text (default: 2500, max: 10000)

Filter syntax (include in query string):
- project:name — filter by project
- before:7d / after:30d — relative date filters
- before:2024-01-15 — absolute date filter
- tool:Bash — filter by tool used

Example: Search for Docker configuration discussions in a specific project
Example: Find where we talked about login issues`,
    {
      query: z.string().describe("Search query with optional inline filters (e.g., 'docker compose project:myapp after:7d')"),
      project: z.string().optional().describe("Filter to a specific project name or path"),
      limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
      include_context: z.boolean().optional().describe("Include surrounding message context (default: false)"),
      format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
      user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
      max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
    },
    async (args) => {
      const key = cacheKey("search", args.query, args.project, args.limit, args.include_context, args.format, args.user, args.max_chars);
      const cached = searchCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = await handleSearchHistory(searchEngine, args, indexManager.db, asyncSearch);

      searchCache.set(key, result);

      const guidance = result.startsWith("No results")
        ? "Try broader terms, or use list_projects to see available projects."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── list_projects ──────────────────────────────────────────────────

  server.tool(
    "list_projects",
    `🔍 DISCOVERY: List all projects with conversation history.

Shows project names, session counts, message counts, and date ranges. Use this to discover what projects have searchable history before running targeted searches.

Parameters:
- sort_by: Sort order — 'recent' (default), 'sessions', 'messages', or 'name'
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)

Example: List projects sorted by most recent activity
Example: Find which project has the most conversation sessions`,
    {
      sort_by: z.enum(["recent", "sessions", "messages", "name"]).optional().describe("Sort order (default: recent)"),
      format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
      user: z.string().optional().describe("Filter to a specific user scope (omit to list all)"),
    },
    async (args) => {
      const key = cacheKey("list_projects", args.sort_by, args.format, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      const result = handleListProjects(args);
      historyCache.set(key, result);
      return buildTextResponse(result);
    }
  );

  // ── find_solutions ─────────────────────────────────────────────────

  server.tool(
    "find_solutions",
    `🔍 SEARCH: Find how you solved a specific error or problem in a past session.

Use when you have an ACTIVE problem and need past fixes — solution-biased ranking surfaces fix/resolution language. NOT for general topic searches; use search_history to find past discussions about any subject. Automatically enhanced with semantic search when GEMINI_API_KEY is set.

Parameters:
- error_or_problem: The error message or problem description (required)
- technology: Technology context for better matching (optional)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)
- max_chars: Maximum characters per result text (default: 2500, max: 10000)

Example: Find how a "ECONNREFUSED" error was fixed in past Docker work
Example: Search for solutions to TypeScript type inference issues`,
    {
      error_or_problem: z.string().describe("The error message, problem description, or issue to find solutions for"),
      technology: z.string().optional().describe("Technology context (e.g., 'docker', 'typescript', 'react')"),
      format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
      user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
      max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
    },
    async (args) => {
      const key = cacheKey("find_solutions", args.error_or_problem, args.technology, args.format, args.user, args.max_chars);
      const cached = searchCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = await handleFindSolutions(searchEngine, args, indexManager.db, asyncSearchSolutions);

      searchCache.set(key, result);

      const guidance = result.startsWith("No past solutions")
        ? "Try shorter error text, or use search_history with broader terms."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── semantic_search ────────────────────────────────────────────────

  server.tool(
    "semantic_search",
    `🔍 SEARCH: Semantic search using vector embeddings — finds results that keyword search misses.

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
    {
      query: z.string().describe("Search query — supports semantic matching beyond keywords"),
      project: z.string().optional().describe("Filter to a specific project name or path"),
      limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
      threshold: z.number().optional().describe("Minimum cosine similarity threshold (0.0-1.0)"),
      user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
      max_chars: z.number().optional().describe("Maximum characters per result text (default: 2500, max: 10000)"),
    },
    async (args) => {
      const key = cacheKey("semantic_search", args.query, args.project, args.limit, args.threshold, args.user, args.max_chars);
      const cached = searchCache.get(key);
      if (cached) {
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
      return buildTextResponse(result);
    }
  );

  // ── get_session_summary ────────────────────────────────────────────

  server.tool(
    "get_session_summary",
    `📖 READ: Get a summary of a single conversation session — what happened today, in your last session, or in a specific session by ID.

Returns session metadata, initial topic, tools used, key topics, and conversation flow. Provide either a session ID or project name (returns most recent session). NOT for multi-session overviews — use list_projects for "what have I been working on lately" or find_patterns for recurring trends.

Parameters:
- session_id: Specific session UUID (optional)
- project: Project name — returns most recent session (optional)
- At least one parameter is required.

Example: Get summary of the most recent session for the Kytheros project
Example: What did I work on today?`,
    {
      session_id: z.string().optional().describe("Specific session UUID"),
      project: z.string().optional().describe("Project name or path — returns most recent session"),
      user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
    },
    async (args) => {
      const key = cacheKey("session_summary", args.session_id, args.project, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      const result = handleGetSessionSummary(args);
      historyCache.set(key, result);

      const guidance = result.includes("not found")
        ? "Use list_projects to see available projects, or search_history to find session IDs."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── get_project_context ────────────────────────────────────────────

  server.tool(
    "get_project_context",
    `📖 READ: Get comprehensive context for a specific project — recent sessions, key topics, and patterns.

Deep dive into one named project. Use when the user asks "what do you know about [project]?" or wants project-level context before starting work. Returns recent sessions with topics, message counts, and optionally common topics analysis.

Parameters:
- project: Project name or path (required)
- depth: Detail level — 'brief' (last session), 'normal' (last 3), 'detailed' (last 5 + topic analysis). Default: normal.

Example: Get brief context for the current project before starting work
Example: What do you know about my React project?`,
    {
      project: z.string().optional().describe("Project name or path"),
      depth: z.enum(["brief", "normal", "detailed"]).optional().describe("Detail level (default: normal)"),
      user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
    },
    async (args) => {
      const key = cacheKey("project_context", args.project, args.depth, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = handleGetProjectContext(searchEngine, args);
      historyCache.set(key, result);

      const guidance = result.includes("No history found")
        ? "Use list_projects to see which projects have conversation history."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── find_patterns ──────────────────────────────────────────────────

  server.tool(
    "find_patterns",
    `📊 ANALYSIS: Discover recurring patterns in conversation history.

Analyzes common topics, activity patterns (busiest day/hour, session lengths), and repeated issues. Helps identify workflow trends and recurring problems.

Parameters:
- project: Limit analysis to a specific project (optional — analyzes all if omitted)
- type: Pattern category — 'topics', 'workflows', 'issues', or 'all' (default: all)

Example: Find recurring issues in the Kytheros project
Example: Analyze workflow patterns across all projects`,
    {
      project: z.string().optional().describe("Limit to a specific project"),
      type: z.enum(["topics", "workflows", "issues", "all"]).optional().describe("Type of patterns to find (default: all)"),
      user: z.string().optional().describe("Filter to a specific user scope (omit to search all users)"),
    },
    async (args) => {
      const key = cacheKey("find_patterns", args.project, args.type, args.user);
      const cached = historyCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      const result = handleFindPatterns(args);
      historyCache.set(key, result);
      return buildTextResponse(result);
    }
  );

  // ── store_memory ────────────────────────────────────────────────────

  server.tool(
    "store_memory",
    `💾 MEMORY: Explicitly store a memory for future recall.

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
    {
      memory: z.string().describe("The text to remember"),
      type: z.enum(["decision", "solution", "error_fix", "pattern", "learning", "procedure", "fact", "preference", "episodic"]).describe("Category: decision, solution, error_fix, pattern, learning, procedure, fact, preference, or episodic"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
      project: z.string().optional().describe("Project context (default: global)"),
      user: z.string().optional().describe("User scope (default: STRATA_DEFAULT_USER env var or 'default')"),
    },
    async (args) => {
      const result = await handleStoreMemory(indexManager.knowledge, args, indexManager.db);
      return buildTextResponse(result);
    }
  );

  // ── delete_memory ───────────────────────────────────────────────────

  server.tool(
    "delete_memory",
    `🗑️ MEMORY: Remove or permanently delete a stored memory entry.

Use this directly — NOT search_history — when the user wants to delete, remove, erase, retract, or discard an incorrect/stale/wrong memory. The deletion is recorded in the audit history.

Parameters:
- id: The entry ID to delete (required)

Example: Delete a stale entry — delete_memory({ id: "abc-123" })`,
    {
      id: z.string().describe("The entry ID to delete"),
    },
    {
      destructiveHint: true,
      idempotentHint: false,
    },
    async (args) => {
      const result = await handleDeleteMemory(indexManager.knowledge, args);
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
    startIncrementalIndexer(): IncrementalIndexer {
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
