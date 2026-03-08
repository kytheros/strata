/**
 * MCP server: tool registration and request handling using McpServer API.
 *
 * Community edition — 8 free tools for search, memory, and pattern discovery.
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SqliteIndexManager } from "./indexing/sqlite-index-manager.js";
import { SqliteSearchEngine } from "./search/sqlite-search-engine.js";
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
import { RealtimeWatcher } from "./watcher/realtime-watcher.js";
import { IncrementalIndexer } from "./watcher/incremental-indexer.js";

/** Search result cache: 200 entries, 5 min TTL */
const searchCache = new LRUCache<string, string>(200, 300_000);

/** History parse cache: 10 entries, 60s TTL */
const historyCache = new LRUCache<string, string>(10, 60_000);

export function createServer(): {
  server: McpServer;
  indexManager: SqliteIndexManager;
  entityStore: SqliteEntityStore;
  init: () => Promise<void>;
  startRealtimeWatcher: (sessionFilePath: string) => RealtimeWatcher | null;
  stopRealtimeWatcher: () => void;
  startIncrementalIndexer: () => IncrementalIndexer;
  stopIncrementalIndexer: () => void;
} {
  const server = new McpServer(
    { name: "strata-mcp", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const indexManager = new SqliteIndexManager();
  const searchEngine = new SqliteSearchEngine(indexManager.documents);
  const entityStore = new SqliteEntityStore(indexManager.db);
  let initialized = false;

  async function ensureIndex(): Promise<void> {
    if (initialized) return;

    const stats = indexManager.getStats();
    if (stats.documents === 0) {
      indexManager.buildFullIndex();
    } else {
      indexManager.incrementalUpdate();
    }
    initialized = true;
  }

  // ── search_history ─────────────────────────────────────────────────

  server.tool(
    "search_history",
    `🔍 SEARCH: Full-text search across past conversations.

FTS5 full-text search with BM25 ranking. Supports inline filter syntax for project, date range, and tool filtering.

Parameters:
- query: Search text with optional filters (required)
- project: Filter to specific project (optional)
- limit: Max results, 1-100 (default: 20)
- include_context: Show surrounding messages (default: false)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)

Filter syntax (include in query string):
- project:name — filter by project
- before:7d / after:30d — relative date filters
- before:2024-01-15 — absolute date filter
- tool:Bash — filter by tool used

Example: Search for Docker configuration discussions in a specific project
Example: Find all TypeScript migration work from the last week`,
    {
      query: z.string().describe("Search query with optional inline filters (e.g., 'docker compose project:myapp after:7d')"),
      project: z.string().optional().describe("Filter to a specific project name or path"),
      limit: z.number().optional().describe("Maximum results (default: 20, max: 100)"),
      include_context: z.boolean().optional().describe("Include surrounding message context (default: false)"),
      format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
      user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
    },
    async (args) => {
      const key = cacheKey("search", args.query, args.project, args.limit, args.include_context, args.format, args.user);
      const cached = searchCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = handleSearchHistory(searchEngine, args);

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
    `🔍 SEARCH: Find solutions to errors or problems from past conversations.

Searches conversation history with solution-biased ranking — results containing fix/resolution language score 1.5x higher. Use when encountering an error you may have solved before.

Parameters:
- error_or_problem: The error message or problem description (required)
- technology: Technology context for better matching (optional)
- format: Response format — 'concise' (TOON, ~60% fewer tokens), 'standard' (default), or 'detailed' (full JSON)

Example: Find how a "ECONNREFUSED" error was fixed in past Docker work
Example: Search for solutions to TypeScript type inference issues`,
    {
      error_or_problem: z.string().describe("The error message, problem description, or issue to find solutions for"),
      technology: z.string().optional().describe("Technology context (e.g., 'docker', 'typescript', 'react')"),
      format: z.enum(["concise", "standard", "detailed"]).optional().describe("Response format: 'concise' (TOON, ~60% fewer tokens), 'standard' (default), 'detailed' (full JSON)"),
      user: z.string().optional().describe("Filter results to a specific user scope (omit to search all users)"),
    },
    async (args) => {
      const key = cacheKey("find_solutions", args.error_or_problem, args.technology, args.format, args.user);
      const cached = searchCache.get(key);
      if (cached) {
        return buildTextResponse(cached);
      }

      await ensureIndex();
      const result = handleFindSolutions(searchEngine, args);

      searchCache.set(key, result);

      const guidance = result.startsWith("No past solutions")
        ? "Try shorter error text, or use search_history with broader terms."
        : undefined;
      return buildTextResponse(result, guidance);
    }
  );

  // ── get_session_summary ────────────────────────────────────────────

  server.tool(
    "get_session_summary",
    `📖 READ: Get a structured summary of a specific conversation session.

Returns session metadata, initial topic, tools used, key topics, and conversation flow. Provide either a session ID (exact match) or project name (returns most recent session).

Parameters:
- session_id: Specific session UUID (optional)
- project: Project name — returns most recent session (optional)
- At least one parameter is required.

Example: Get summary of the most recent session for the Kytheros project
Example: Review what happened in a specific session by UUID`,
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
    `📖 READ: Get comprehensive project context — recent sessions, key topics, and patterns.

Useful for session-start context injection. Returns recent sessions with topics, message counts, and optionally common topics analysis.

Parameters:
- project: Project name or path (required)
- depth: Detail level — 'brief' (last session), 'normal' (last 3), 'detailed' (last 5 + topic analysis). Default: normal.

Example: Get brief context for the current project before starting work
Example: Get detailed analysis of all activity on the Kytheros project`,
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
      const result = await handleStoreMemory(indexManager.knowledge, args);
      return buildTextResponse(result);
    }
  );

  // ── delete_memory ───────────────────────────────────────────────────

  server.tool(
    "delete_memory",
    `🗑️ MEMORY: Permanently delete a memory entry.

Hard-delete a knowledge entry by ID. The deletion is recorded in the audit history so the change can be traced later via memory_history.

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
