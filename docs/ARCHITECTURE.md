# Strata MCP Server -- Architecture Overview

## 1. System Overview

Strata is an MCP (Model Context Protocol) server that indexes conversations from AI coding assistants into a local SQLite database, then exposes that indexed history as searchable knowledge through MCP tools.

**Core premise:** Every conversation you have with an AI coding assistant contains decisions, solutions, error fixes, and patterns. Strata captures these automatically so they can be recalled in future sessions.

**Licensing model:** Open core. The main codebase is MIT-licensed. The `src/extensions/` directory contains commercial features (vector search, LLM-enhanced extraction, cloud sync, analytics, team collaboration) under a source-available license requiring a Strata Pro key for production commercial use.

**Transports:**

- **stdio** (default) -- Used when Claude Code or other MCP clients launch the server as a subprocess. Entry point: `src/index.ts` or `src/cli.ts` with no arguments.
- **Streamable HTTP** -- Started via `strata-mcp serve`. Exposes `/mcp` (JSON-RPC over HTTP/SSE) and `/health`. Managed by `src/transports/http-transport.ts`.

**CLI commands** (`src/cli.ts`):

| Command | Purpose |
|---------|---------|
| *(none)* | Start MCP server on stdio |
| `serve` | Start HTTP server on port 3000 (or `$PORT`) |
| `search <query>` | CLI search against the index |
| `status` | Print index statistics |
| `migrate` | Migrate legacy data to SQLite |
| `activate <key>` | Activate a Strata Pro license |
| `license` | Show license status |
| `embed` | Generate vector embeddings (Pro) |


## 2. Data Flow

```
  Conversation Files              Strata Pipeline                 MCP Tools
 (on disk from 5 tools)                                        (exposed to LLMs)
                              +------------------+
  ~/.claude/projects/**  ---->|                  |
  ~/.codex/sessions/**   ---->|   1. PARSERS     |    Each parser implements
  .aider.chat.history.md ---->|   (registry)     |    detect() / discover() / parse()
  VS Code globalStorage  ---->|                  |    (Cline)
  ~/.gemini/tmp/**       ---->+--------+---------+
                                       |
                              ParsedSession (unified format)
                                       |
                              +--------v---------+
                              |                  |
                              |  2. INDEXING      |    Chunks sessions by word count
                              |  (SqliteIndex-   |    Groups same-role messages
                              |   Manager)       |    Stores in SQLite + FTS5
                              |                  |
                              +--------+---------+
                                       |
                         +-------------+-------------+
                         |                           |
                +--------v---------+     +-----------v-----------+
                |                  |     |                       |
                | 3a. KNOWLEDGE    |     | 3b. ENTITY            |
                |  EXTRACTION      |     |  EXTRACTION           |
                |  - Evaluator     |     |  - Alias map          |
                |  - Extractor     |     |  - Relation patterns  |
                |  - Procedures    |     |  - Graph storage      |
                |  - Dedup         |     |                       |
                |  - Conflict Res  |     +-----------+-----------+
                +--------+---------+                 |
                         |                           |
                +--------v---------+     +-----------v-----------+
                |                  |     |                       |
                | 3c. SYNTHESIS    |     | 4. STORAGE             |
                |  - Clustering    |     |  - SqliteDocumentStore |
                |  - Scoring       |     |  - SqliteKnowledgeStore|
                |  - Promotion     |     |  - SqliteEntityStore   |
                |  - Memory write  |     |  - SqliteSummaryStore  |
                +--------+---------+     |  - SqliteMetaStore     |
                         |               +-----------+-----------+
                         +---->--------->+           |
                                                     |
                              +--------+-------------+
                              |                      |
                              |  5. SEARCH           |
                              |  - FTS5 BM25         |
                              |  - Query parsing     |
                              |  - Recency/project   |
                              |    boosts            |
                              |  - Memory decay      |
                              |  - Confidence scores |
                              |  - Optional: hybrid  |
                              |    RRF with vectors  |
                              +--------+-------------+
                                       |
                              +--------v---------+
                              |                  |
                              |  6. MCP TOOLS    |   19 tool handlers
                              |  (14 free +      |   Format results
                              |   5 Pro-gated)   |   Return via MCP
                              |                  |
                              +------------------+
```

### Pipeline stages in detail

**Stage 1: Parsing** (`src/parsers/`). The `ParserRegistry` holds five parser implementations, one per AI tool. On startup, `SqliteIndexManager` registers all parsers. Each parser implements the `ConversationParser` interface: `detect()` checks if the tool's data directory exists, `discover()` enumerates session files, and `parse()` reads a file into the unified `ParsedSession` format.

**Stage 2: Indexing** (`src/indexing/`). `SqliteIndexManager` coordinates the full build and incremental update paths. It iterates detected parsers, discovers session files, and calls `chunkSession()` to split each session into indexable chunks. Chunks are grouped by consecutive same-role messages and split at a configurable word limit (default 500 words, see `CONFIG.indexing.chunkSize`). Each chunk is inserted into the `documents` table, which has an FTS5 virtual table (`documents_fts`) kept in sync via triggers. Incremental updates compare file modification times against stored metadata to avoid re-indexing unchanged sessions.

**Stage 3: Knowledge extraction** (`src/knowledge/`). Three extraction paths run in parallel:

- **Knowledge extraction**: `KnowledgeExtractor` uses regex patterns to identify decisions, solutions, and error-fix sequences in session messages. Candidates pass through `KnowledgeEvaluator` (actionability + specificity + relevance gates) and `checkDuplicate()` (trigram Jaccard > 0.90 = duplicate). When an LLM provider is available (Pro feature), `ConflictResolver` classifies the relationship between new entries and existing similar entries, producing ADD/UPDATE/DELETE mutations.
- **Entity extraction**: `extractEntities()` identifies named entities (libraries, services, tools, languages, frameworks, files) using a built-in alias map of 50+ technologies and regex patterns for npm packages, file paths, and URLs. `extractRelations()` detects directional relationships (replaced_by, used_for, depends_on) and co-occurrence.
- **Procedure extraction**: `extractProcedures()` detects multi-step workflows in assistant messages via numbered lists, "Step N:" headers, and ordinal language flows (first/then/next/finally).

**Stage 3c: Synthesis** (`src/knowledge/learning-synthesizer.ts`). After extraction, the synthesizer clusters related solution/error_fix entries by tag overlap and stemmed-word Jaccard similarity, scores clusters (frequency + cross-session + cross-project), and promotes clusters above the threshold into synthesized "learning" entries.

**Stage 4: Storage** (`src/storage/`). All persistence is in a single SQLite database at `~/.strata/strata.db` (configurable via `STRATA_DATA_DIR`). WAL mode is enabled for concurrent reads.

**Stage 5: Search** (`src/search/`). `SqliteSearchEngine` wraps FTS5 BM25 search with a query processor that extracts inline filters (`project:`, `before:`, `after:`, `tool:`) and a result ranker that applies recency boosts, project-match boosts, memory decay penalties, and per-session deduplication. Confidence scores are normalized against the top result. When a Pro license enables vector search, the async search path embeds the query, runs vector cosine similarity in parallel, and merges the two ranked lists via Reciprocal Rank Fusion (RRF).

**Stage 6: Tools** (`src/tools/`). Each MCP tool has a dedicated handler module. The server (`src/server.ts`) registers all tools with Zod schemas, description text, and MCP annotations. Results pass through an LRU cache (200 entries, 5 min TTL for search; 10 entries, 60s TTL for parsed history) before being returned.


## 3. Key Modules

### `src/parsers/` -- Parser Registry and Individual Parsers

| File | Purpose |
|------|---------|
| `parser-interface.ts` | `ConversationParser` interface: `id`, `name`, `detect()`, `discover()`, `parse()` |
| `parser-registry.ts` | `ParserRegistry` class: registration, lookup, and detection of available parsers |
| `claude-code-parser.ts` | Claude Code JSONL parser (`~/.claude/projects/`) |
| `codex-parser.ts` | OpenAI Codex parser |
| `aider-parser.ts` | Aider parser |
| `cline-parser.ts` | Cline parser |
| `gemini-parser.ts` | Gemini CLI parser |
| `session-parser.ts` | Shared JSONL line parser, `ParsedSession` and `SessionMessage` types, `SessionFileInfo` interface |
| `content-extractor.ts` | Extracts text from various content block formats, strips system reminders |

### `src/indexing/` -- Index Management

| File | Purpose |
|------|---------|
| `sqlite-index-manager.ts` | Coordinates parsing, chunking, and storage. `buildFullIndex()` and `incrementalUpdate()` |
| `document-store.ts` | `DocumentChunk` and `DocumentMetadata` type definitions |
| `bm25.ts` | BM25 scoring implementation |
| `tfidf.ts` | TF-IDF scoring implementation |
| `tokenizer.ts` | Text tokenization utilities |

### `src/knowledge/` -- Knowledge Extraction Pipeline

| File | Purpose |
|------|---------|
| `knowledge-evaluator.ts` | Quality gate: actionability patterns, specificity signals (2+ required), relevance filter |
| `knowledge-extractor.ts` | Regex-based extraction of decisions, solutions, error-fix sequences. Tag and file path extraction |
| `entity-extractor.ts` | Heuristic entity extraction: alias map, npm packages, file paths, URLs. Relation extraction (replaced_by, used_for, depends_on, co_occurs) |
| `procedure-extractor.ts` | Detects numbered lists, step headers, ordinal flows. Returns `ProcedureDetails` JSON |
| `dedup.ts` | Trigram Jaccard similarity. Threshold: >0.90 = duplicate, checks if candidate adds new detail |
| `conflict-resolver.ts` | LLM-powered semantic conflict resolution (Pro). Classifies ADD/UPDATE/DELETE/NOOP mutations |
| `learning-synthesizer.ts` | Clusters entries by tag + stemmed-word similarity, scores, promotes to "learning" type |
| `knowledge-store.ts` | `KnowledgeEntry` type definition, in-memory store (legacy, replaced by SQLite store) |
| `session-summarizer.ts` | Generates session summaries with topic, tools used, key topics |
| `memory-writer.ts` | Writes synthesized learnings to tool-appropriate memory locations |

### `src/storage/` -- SQLite Stores

| File | Purpose |
|------|---------|
| `database.ts` | Database creation, schema initialization, migrations. Opens `~/.strata/strata.db` |
| `sqlite-document-store.ts` | CRUD for document chunks. FTS5 search with BM25 ranking |
| `sqlite-knowledge-store.ts` | CRUD for knowledge entries. Dedup by project+type+summary. Audit history. Procedure merge logic. Optional embedding on write |
| `sqlite-entity-store.ts` | CRUD for entities and relations. Upsert with alias merging and mention counting. Knowledge-entity linking |
| `sqlite-summary-store.ts` | Session summary storage and retrieval |
| `sqlite-meta-store.ts` | Key-value metadata (lastIndexed timestamps, build time, version) |

### `src/search/` -- Search Engine

| File | Purpose |
|------|---------|
| `sqlite-search-engine.ts` | Wraps `SqliteDocumentStore.search()`. Sync search (FTS5 only) and async search (hybrid FTS5 + vector via RRF). Solution-specific search with fix/resolution language boost (1.5x) |
| `query-processor.ts` | Parses inline filter syntax: `project:`, `before:`, `after:`, `tool:`, `branch:`. Supports relative dates (`7d`, `30d`, `1m`) and ISO dates |
| `result-ranker.ts` | Reciprocal Rank Fusion (RRF). Recency boosts (7d: 1.2x, 30d: 1.1x). Project match boost (1.3x). Memory decay (>90d: 0.85x, >180d: 0.7x, explicit memories exempt). Per-session deduplication |

### `src/tools/` -- MCP Tool Handlers

14 free-tier tools + 5 Pro-gated tools:

**Free tier (always available):**

| Tool | Handler | Description |
|------|---------|-------------|
| `search_history` | `search-history.ts` | Full-text search with inline filter syntax |
| `list_projects` | `list-projects.ts` | List projects with session/message counts |
| `find_solutions` | `find-solutions.ts` | Solution-biased search (1.5x boost for fix language) |
| `get_session_summary` | `get-session-summary.ts` | Structured session summary by ID or project |
| `get_project_context` | `get-project-context.ts` | Comprehensive project context (recent sessions, topics) |
| `find_patterns` | `find-patterns.ts` | Discover recurring topics, workflows, issues |
| `store_memory` | `store-memory.ts` | Explicitly store a memory entry |
| `update_memory` | `update-memory.ts` | Partial update of existing memory |
| `delete_memory` | `delete-memory.ts` | Hard-delete with audit trail |
| `memory_history` | `memory-history.ts` | View mutation audit trail for an entry |
| `find_procedures` | `find-procedures.ts` | Search stored step-by-step procedures |
| `store_procedure` | `store-procedure.ts` | Store a procedure (merges on duplicate title) |
| `search_entities` | `search-entities.ts` | Query the cross-session entity graph |
| `ingest_conversation` | `ingest-conversation.ts` | Push external conversations into the extraction pipeline |

**Pro-gated (require license with specific feature):**

| Tool | Feature Gate | Description |
|------|-------------|-------------|
| `cloud_sync_status` | `cloud_sync` | Check sync configuration and health |
| `cloud_sync_push` | `cloud_sync` | Push knowledge and summaries to cloud |
| `cloud_sync_pull` | `cloud_sync` | Pull and merge cloud data locally |
| `semantic_search` | `vector_search` | Hybrid FTS5 + vector cosine similarity via RRF |
| `get_analytics` | `analytics` | Local usage analytics (search patterns, tool usage) |

### `src/sanitizer/` -- Secret Redaction

`sanitizer.ts` contains the `Sanitizer` class with pre-compiled regex patterns for detecting and redacting secrets before indexing. Handles: PEM private keys (real and escaped newlines), AWS keys/secrets, GitHub tokens (PAT and fine-grained), Anthropic API keys, OpenAI API keys, Bearer tokens, Authorization headers, and passwords embedded in URLs. All matches are replaced with `[REDACTED:<type>]` placeholders. False positive detection for UUIDs, hex colors, and data URLs.

### `src/watcher/` -- File Watchers

| File | Purpose |
|------|---------|
| `realtime-watcher.ts` | Watches a single active session file using `fs.watch` with configurable debounce (default 5s). Reads new lines incrementally, runs knowledge extraction on the partial session |
| `incremental-indexer.ts` | Watches all registered parser directories. On file change (after stale session timeout of 5 min), runs: incremental index update, knowledge extraction (LLM-enhanced if available), procedure extraction, entity extraction, conflict resolution, synthesis, summary caching |
| `file-watcher.ts` | Low-level `FileWatcher` class that manages `fs.watch` instances across multiple directories. `getWatchTargets()` builds the watch list from all detected parsers plus `STRATA_EXTRA_WATCH_DIRS` |

### `src/transports/` -- HTTP/SSE Transport

| File | Purpose |
|------|---------|
| `http-transport.ts` | Streamable HTTP transport using the MCP SDK's `StreamableHTTPServerTransport`. Routes: `POST /mcp` (JSON-RPC), `GET /mcp` (SSE stream), `DELETE /mcp` (session termination), `GET /health`. Session management via `mcp-session-id` header |
| `health.ts` | Health check endpoint handler |

### `src/utils/` -- Utilities

| File | Purpose |
|------|---------|
| `toon-serializer.ts` | TOON (Token-Optimized Object Notation) serializer. 30-60% token reduction vs JSON for list responses |
| `response-format.ts` | Response formatting with field configs per verbosity level |
| `response.ts` | `buildTextResponse()` helper for MCP tool responses |
| `field-config.ts` | Field configurations per entity type per verbosity level (concise/standard/detailed) |
| `compact-serializer.ts` | Compact JSON serialization |
| `cache.ts` | `LRUCache<K,V>` with TTL support. `cacheKey()` SHA-256 hash generator |
| `stemmer.ts` | Porter stemmer for text normalization |
| `context-budgeter.ts` | Context budget management utilities |
| `path-encoder.ts` | Path encoding/decoding utilities |

### `src/extensions/` -- Paid Features (Strata Pro)

All code in `src/extensions/` is under a source-available commercial license (`src/extensions/LICENSE`).

| Directory | Feature Gate | Purpose |
|-----------|-------------|---------|
| `ee/vector-search/` | `vector_search` | `VectorStore` (SQLite BLOB storage), `EmbeddingProvider` interface, `HybridSearchEngine` (FTS5 + vector RRF fusion) |
| `ee/embeddings/` | `vector_search` | `GeminiEmbedder` (Gemini embedding-001 model), `VectorSearch` cosine similarity |
| `ee/llm-extraction/` | `llm_extraction` | `LlmProvider` interface, `GeminiProvider`, `EnhancedExtractor` (LLM-powered knowledge extraction), `SmartSummarizer` (LLM session summaries) |
| `ee/cloud-sync/` | `cloud_sync` | `CloudClient` (HTTP API client), `SyncState` (last push/pull timestamps, counts) |
| `ee/analytics/` | `analytics` | `QueryAnalytics` (search pattern tracking, hashed queries), `UsageTracker` (tool usage metrics) |
| `ee/team/` | *(team tier)* | `TeamSync`, `SharedKnowledge`, `AccessControl` for multi-user collaboration |
| `ee/tools/` | *(varies)* | `get-analytics.ts` tool handler |
| `ee/feature-gate.ts` | -- | License state cache, `hasFeature()`, `requireFeature()` |
| `ee/license-validator.ts` | -- | RSA-SHA256 JWT validation with embedded public key |


## 4. Database Schema

All tables are created in `src/storage/database.ts` via `initSchema()`. The database file lives at `~/.strata/strata.db` (configurable via `STRATA_DATA_DIR`).

**Pragmas:** WAL journal mode, NORMAL synchronous, foreign keys ON.

### Core Tables

**`documents`** -- Conversation chunks (the main search corpus)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `session_id` | TEXT | Source session identifier |
| `project` | TEXT | Project name or path |
| `tool` | TEXT | Source parser ID (default: `'claude-code'`) |
| `text` | TEXT | Chunk content |
| `role` | TEXT | `'user'`, `'assistant'`, or `'mixed'` |
| `timestamp` | INTEGER | Unix timestamp (ms) |
| `tool_names` | TEXT | JSON array of MCP tools used |
| `token_count` | INTEGER | Approximate token count |
| `message_index` | INTEGER | Position within the session |
| `user` | TEXT | User scope (default: `'default'`) |

Indexes: `session_id`, `project`, `tool`, `timestamp`, `user`.

**`documents_fts`** -- FTS5 virtual table

```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  text,
  content=documents,
  content_rowid=rowid,
  tokenize='porter unicode61'
);
```

Kept in sync via `AFTER INSERT/DELETE/UPDATE` triggers on `documents`.

**`knowledge`** -- Extracted knowledge entries

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `type` | TEXT | One of: `decision`, `solution`, `error_fix`, `pattern`, `learning`, `procedure`, `fact`, `preference`, `episodic` |
| `project` | TEXT | Project context |
| `session_id` | TEXT | Source session |
| `timestamp` | INTEGER | Entry timestamp |
| `summary` | TEXT | Short summary |
| `details` | TEXT | Full details (plain text or JSON for procedures) |
| `tags` | TEXT | JSON array of tags |
| `related_files` | TEXT | JSON array of file paths |
| `occurrences` | INTEGER | For learnings: source entry count |
| `project_count` | INTEGER | For learnings: distinct project count |
| `extracted_at` | INTEGER | Extraction timestamp |
| `updated_at` | INTEGER | Last update timestamp |
| `user` | TEXT | User scope (default: `'default'`) |

Indexes: `project`, `type`, `user`.

**`summaries`** -- Session summaries

| Column | Type | Description |
|--------|------|-------------|
| `session_id` | TEXT PK | Session identifier |
| `project` | TEXT | Project name |
| `tool` | TEXT | Source parser ID |
| `topic` | TEXT | Session topic |
| `start_time` | INTEGER | Session start |
| `end_time` | INTEGER | Session end |
| `message_count` | INTEGER | Total messages |
| `tools_used` | TEXT | JSON array |
| `data` | TEXT | Full summary JSON |

**`index_meta`** -- Key-value metadata

| Column | Type | Description |
|--------|------|-------------|
| `key` | TEXT PK | Metadata key (e.g., `lastIndexed`, `buildTime`, `version`) |
| `value` | TEXT | Metadata value |

### Entity Graph Tables

**`entities`** -- Named entities extracted from knowledge

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `name` | TEXT | Original name as found |
| `type` | TEXT | `library`, `service`, `tool`, `language`, `framework`, `person`, `concept`, `file` |
| `canonical_name` | TEXT | Normalized canonical name |
| `aliases` | TEXT | JSON array of known aliases |
| `first_seen` | INTEGER | First mention timestamp |
| `last_seen` | INTEGER | Most recent mention |
| `mention_count` | INTEGER | Total mentions (incremented on upsert) |
| `project` | TEXT | Project scope (nullable) |
| `user` | TEXT | User scope (nullable) |

**`entity_relations`** -- Relationships between entities

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | UUID |
| `source_entity_id` | TEXT FK | Source entity |
| `target_entity_id` | TEXT FK | Target entity |
| `relation_type` | TEXT | `replaced_by`, `used_for`, `depends_on`, `co_occurs` |
| `context` | TEXT | Surrounding text (truncated to 200 chars) |
| `session_id` | TEXT | Source session |
| `created_at` | INTEGER | Timestamp |

**`knowledge_entities`** -- Junction table linking knowledge entries to entities

| Column | Type | Description |
|--------|------|-------------|
| `entry_id` | TEXT FK | Knowledge entry ID |
| `entity_id` | TEXT FK | Entity ID |
| Primary key: `(entry_id, entity_id)` | | |

### Audit and Analytics Tables

**`knowledge_history`** -- Mutation audit trail

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `entry_id` | TEXT | Knowledge entry ID |
| `old_summary` | TEXT | Previous summary (null for add) |
| `new_summary` | TEXT | New summary (null for delete) |
| `old_details` | TEXT | Previous details |
| `new_details` | TEXT | New details |
| `event` | TEXT | `add`, `update`, or `delete` |
| `created_at` | INTEGER | Timestamp |

Pruned to 100 rows per entry.

**`analytics`** -- Local usage tracking (Pro)

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `event_type` | TEXT | `search`, `tool_use`, `knowledge_access`, `session_index` |
| `event_data` | TEXT | JSON event payload |
| `project` | TEXT | Project context |
| `timestamp` | INTEGER | Event timestamp |

**`embeddings`** -- Vector embeddings (Pro)

| Column | Type | Description |
|--------|------|-------------|
| `entry_id` | TEXT PK | Knowledge entry or document ID |
| `embedding` | BLOB | Float32Array serialized as Buffer |
| `model` | TEXT | Embedding model name |
| `created_at` | INTEGER | Generation timestamp |


## 5. Feature Gating

Feature gating is implemented in `src/extensions/feature-gate.ts` and `src/extensions/license-validator.ts`.

### License loading

`initLicense()` is called once during server creation. It looks for a license key in priority order:

1. `STRATA_LICENSE_KEY` environment variable
2. `~/.strata/license.key` file

### License validation

`validateLicense()` in `license-validator.ts` performs offline JWT verification:

1. Parses the JWT (header.payload.signature)
2. Validates the header (`alg: RS256`, `typ: JWT`)
3. Verifies the RSA-SHA256 signature against an embedded production RSA public key
4. Decodes the payload and validates required fields (`sub`, `tier`, `features`, `exp`, `iss`)
5. Checks the issuer is `kytheros.dev`
6. Checks expiration with a 5-minute clock skew tolerance

The payload contains:

```typescript
interface LicensePayload {
  sub: string;          // Email address
  tier: LicenseTier;    // "pro" | "team" | "enterprise"
  features: string[];   // ["vector_search", "llm_extraction", "cloud_sync", "analytics"]
  exp: number;          // Expiration (Unix seconds)
  iat: number;          // Issued at
  iss: string;          // Issuer ("kytheros.dev")
  jti?: string;         // Unique token ID
}
```

### Runtime checks

- **`hasFeature(feature)`**: Returns `true` if the cached license is valid AND includes the specified feature string. Used in `server.ts` to conditionally register Pro tools.
- **`requireFeature(feature)`**: Throws a descriptive error with upgrade instructions if the feature is not available. Distinguishes between expired licenses and missing licenses.
- **`getLicenseInfo()`**: Returns public license info (tier, features, email, expiration) or null.

### Feature gates in server.ts

Pro tools are registered inside `if (hasFeature("..."))` blocks. If the license lacks the feature, the tool is simply not registered and not visible to MCP clients:

```
if (hasFeature("cloud_sync"))  -> cloud_sync_status, cloud_sync_push, cloud_sync_pull
if (hasFeature("vector_search")) -> semantic_search
if (hasFeature("analytics"))   -> get_analytics
```


## 6. Configuration

All configuration lives in `src/config.ts` as the exported `CONFIG` object.

### Paths

| Property | Default | Description |
|----------|---------|-------------|
| `claudeDir` | `~/.claude` | Claude Code data directory |
| `dataDir` | `~/.claude-history-mcp` | Legacy data directory |
| `indexFile` | `{dataDir}/index.msgpack` | Legacy index file |
| `knowledgeFile` | `{dataDir}/knowledge.json` | Legacy knowledge file |
| `summariesDir` | `{dataDir}/summaries` | Legacy summaries directory |

The SQLite database path is configured separately in `src/storage/database.ts`:
- Default: `~/.strata/strata.db`
- Override: `STRATA_DATA_DIR` environment variable

### BM25 Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `bm25.k1` | 1.2 | Term frequency saturation |
| `bm25.b` | 0.75 | Document length normalization |

### TF-IDF Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `tfidf.maxTerms` | 10,000 | Maximum terms in vocabulary |

### Search Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `search.defaultLimit` | 20 | Default result count |
| `search.maxLimit` | 100 | Maximum result count |
| `search.contextLines` | 3 | Surrounding context lines |
| `search.recencyBoost7d` | 1.2 | Score multiplier for results <= 7 days old |
| `search.recencyBoost30d` | 1.1 | Score multiplier for results <= 30 days old |
| `search.projectMatchBoost` | 1.3 | Score multiplier when result matches current project |
| `search.rrfK` | 60 | RRF constant (k parameter in 1/(k + rank)) |
| `search.decayPenalty90d` | 0.85 | Score multiplier for auto-indexed results > 90 days old |
| `search.decayPenalty180d` | 0.7 | Score multiplier for auto-indexed results > 180 days old |
| `search.confidenceHighThreshold` | 0.6 | High confidence cutoff |
| `search.confidenceMediumThreshold` | 0.3 | Medium confidence cutoff |
| `search.lowConfidenceThreshold` | 1.5 | Low confidence cutoff |

Explicit memories (stored via `store_memory`) are exempt from decay penalties.

### Indexing Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `indexing.chunkSize` | 500 | Target words per chunk |
| `indexing.chunkOverlap` | 50 | Overlap between chunks (words) |
| `indexing.maxChunksPerSession` | 200 | Maximum chunks per session |

### Watcher Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `watcher.debounceMs` | 5,000 | File change debounce interval (ms) |
| `watcher.staleSessionMinutes` | 5 | Minutes after last modification before re-indexing |

### Learning Synthesis Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `learning.similarityThreshold` | 0.6 | Jaccard similarity threshold for clustering |
| `learning.promotionThreshold` | 10 | Minimum cluster score to promote to learning |
| `learning.maxLearningsPerProject` | 10 | Cap on learnings per project |
| `learning.maxLearningLength` | 120 | Maximum characters per learning summary |
| `learning.memoryLineBudget` | 200 | Maximum lines in MEMORY.md |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `STRATA_DATA_DIR` | Override data directory (default: `~/.strata/`) |
| `STRATA_LICENSE_KEY` | License key (alternative to `~/.strata/license.key` file) |
| `STRATA_DEFAULT_USER` | Default user scope for multi-user setups (default: `'default'`) |
| `STRATA_EXTRA_WATCH_DIRS` | Additional directories to watch, comma-separated |
| `STRATA_CONFLICT_RESOLUTION` | Set to `0` to disable LLM conflict resolution |
| `CLAUDE_HISTORY_API_URL` | Cloud sync server URL |
| `CLAUDE_HISTORY_API_KEY` | Cloud sync API key |
| `CLAUDE_HISTORY_TEAM_ID` | Team ID for shared cloud sync |
| `PORT` | HTTP server port for `strata-mcp serve` (default: 3000) |
