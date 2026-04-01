# Strata MCP Tools Reference

Strata exposes 15 MCP tools in the community edition. All tools are registered in `src/server.ts` and handled by dedicated modules in `src/tools/`.

---

## Summary Table

| Tool | Category | Tier | Description |
|------|----------|------|-------------|
| `search_history` | Search | Free | Full-text search across all past conversations |
| `find_solutions` | Search | Free | Solution-biased search for errors and problems |
| `list_projects` | Discovery | Free | List all projects with conversation history |
| `get_session_summary` | Read | Free | Structured summary of a specific session |
| `get_project_context` | Read | Free | Comprehensive project context with recent sessions |
| `find_patterns` | Analysis | Free | Discover recurring patterns in conversation history |
| `store_memory` | Memory | Free | Explicitly store a memory for future recall |
| `delete_memory` | Memory | Free | Permanently delete a memory entry |

---

## Search Tools

### search_history

**Category:** Search
**Tier:** Free
**Handler:** `src/tools/search-history.ts`
**Registration:** `src/server.ts`, line 78

Full-text search across all indexed conversations using FTS5 with BM25 ranking. Supports inline filter syntax for project, date range, and tool filtering.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | -- | Search text with optional inline filters |
| `project` | `string` | No | -- | Filter to a specific project name or path |
| `limit` | `number` | No | 20 | Maximum results (1-100) |
| `include_context` | `boolean` | No | `false` | Include surrounding message context |
| `format` | `"concise" \| "standard" \| "detailed"` | No | `"standard"` | Response format |
| `user` | `string` | No | -- | Filter to a specific user scope |
| `max_chars` | `number` | No | 2500 | Maximum characters per result text (max: 10000) |

#### Inline Filter Syntax

Filters can be embedded directly in the query string:

```
docker compose project:myapp after:7d
typescript migration before:2024-01-15
redis caching tool:Bash
```

| Filter | Syntax | Examples |
|--------|--------|---------|
| Project | `project:name` | `project:strata` |
| Before | `before:Nd` or `before:YYYY-MM-DD` | `before:30d`, `before:2024-06-01` |
| After | `after:Nd` | `after:7d`, `after:1m` |
| Tool | `tool:name` | `tool:Bash`, `tool:Edit` |

Relative date units: `d` (days), `w` (weeks), `m` (months), `y` (years).

#### Example Input

```json
{
  "query": "docker compose networking project:myapp after:7d",
  "limit": 10,
  "format": "standard"
}
```

#### Example Output (standard format)

```
Found 3 result(s) for "docker compose networking":

--- myapp (3/10/2026) [high] [tools: Bash, Edit] ---
We configured the Docker Compose networking to use a custom bridge network
so the API container can reach the database by service name. Added
`networks: backend` to both services in docker-compose.yml...

--- myapp (3/8/2026) [medium] ---
The ECONNREFUSED error was caused by the API trying to connect to
localhost:5432 instead of the Docker service name. Fixed by changing
DB_HOST from localhost to "db" in the .env file...
```

#### Notes

- Results are cached in an LRU cache (200 entries, 5 minute TTL)
- When results are empty or low-confidence (top score < 1.5), an evidence gap is recorded
- Gap-aware nudge messages appear when the same topic has been searched >= 2 times without good matches
- The `concise` format uses TOON serialization (~60% fewer tokens)
- The `detailed` format returns full JSON for programmatic consumers

---

### find_solutions

**Category:** Search
**Tier:** Free
**Handler:** `src/tools/find-solutions.ts`
**Registration:** `src/server.ts`, line 162

Searches conversation history with solution-biased ranking. Results containing fix/resolution language ("fixed", "solved", "resolved", "the fix was", etc.) score 1.5x higher. Use when encountering an error you may have solved before.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `error_or_problem` | `string` | Yes | -- | The error message or problem description |
| `technology` | `string` | No | -- | Technology context for better matching |
| `format` | `"concise" \| "standard" \| "detailed"` | No | `"standard"` | Response format |
| `user` | `string` | No | -- | Filter to a specific user scope |
| `max_chars` | `number` | No | 2500 | Maximum characters per result text (max: 10000) |

#### Example Input

```json
{
  "error_or_problem": "ECONNREFUSED 127.0.0.1:5432",
  "technology": "docker"
}
```

#### Example Output

```
Found 2 potential solution(s) for "ECONNREFUSED 127.0.0.1:5432":

--- myapp (3/8/2026) [high] ---
The ECONNREFUSED error was caused by the API trying to connect to
localhost:5432 instead of the Docker service name. Fixed by changing
DB_HOST from localhost to "db" in the .env file. The Docker Compose
network resolves service names automatically...

--- backend (2/15/2026) [medium] ---
Had a similar connection refused error with PostgreSQL in Docker.
The issue was that the database container hadn't finished initializing.
Added a healthcheck and depends_on condition to wait for postgres...
```

#### Notes

- Internally calls `searchSolutions()` which runs a normal search then applies 1.5x boost to results with solution-indicator words (`src/search/sqlite-search-engine.ts`, line 236)
- Solution indicator words: "fixed", "solved", "solution", "resolved", "issue was", "the problem", "worked", "working now"
- Results are capped at 10 in the output
- Evidence gap tracking is active -- empty/low-confidence results are recorded

---

## Discovery Tools

### list_projects

**Category:** Discovery
**Tier:** Free
**Handler:** `src/tools/list-projects.ts`
**Registration:** `src/server.ts`, line 130

Lists all projects that have conversation history, with session counts, message counts, and date ranges. Use to discover what projects are searchable before running targeted searches.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sort_by` | `"recent" \| "sessions" \| "messages" \| "name"` | No | `"recent"` | Sort order |
| `format` | `"concise" \| "standard" \| "detailed"` | No | `"standard"` | Response format |
| `user` | `string` | No | -- | Filter to a specific user scope |

#### Example Input

```json
{
  "sort_by": "recent"
}
```

#### Example Output

```
5 projects with conversation history:

- **strata** -- 23 sessions, 1847 messages
  Path: -Users-dev-code-strata
  Active: 1/15/2026 -> 3/12/2026

- **myapp** -- 15 sessions, 892 messages
  Path: -Users-dev-code-myapp
  Active: 2/1/2026 -> 3/10/2026

- **backend** -- 8 sessions, 443 messages
  Path: -Users-dev-code-backend
  Active: 12/5/2025 -> 2/28/2026
```

#### Notes

- Reads from `~/.claude/history.jsonl` to gather project metadata
- Cached in LRU cache (10 entries, 60 second TTL)
- Project paths are encoded versions of the actual filesystem paths

---

## Read Tools

### get_session_summary

**Category:** Read
**Tier:** Free
**Handler:** `src/tools/get-session-summary.ts`
**Registration:** `src/server.ts`, line 204

Returns a structured summary of a specific conversation session including metadata, topic, tools used, key topics, and conversation flow. Provide either a session ID (exact match) or project name (returns most recent session).

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | `string` | No* | -- | Specific session UUID |
| `project` | `string` | No* | -- | Project name (returns most recent session) |
| `user` | `string` | No | -- | Filter to a specific user scope |

*At least one of `session_id` or `project` is required.

#### Example Input

```json
{
  "project": "strata"
}
```

#### Example Output

```
## Session Summary: strata

**Session ID**: a1b2c3d4-5678-9abc-def0-123456789abc
**Project**: -Users-dev-code-strata
**Branch**: main
**Time**: 3/12/2026, 10:30:00 AM -> 3/12/2026, 11:45:00 AM
**Messages**: 12 user, 15 assistant

### Initial Topic
Add evidence gap tracking to the search pipeline

### Tools Used
Bash, Edit, Read, Write

### Key Topics
- "evidence gaps"
- "search pipeline"
- Error: SQLITE_CONSTRAINT: UNIQUE constraint failed

### Conversation Flow
- Add evidence gap tracking to the search pipeline
- The gap should be recorded when search returns empty results
- Also record when confidence is below the threshold
- Now add gap resolution when store_memory is called
- Run the tests to make sure everything passes
```

#### Notes

- Looks up sessions by scanning `~/.claude/projects/{projectDir}/{sessionId}.jsonl`
- Key phrase extraction uses heuristics: quoted strings, error patterns
- Cached in LRU cache (10 entries, 60 second TTL)

---

### get_project_context

**Category:** Read
**Tier:** Free
**Handler:** `src/tools/get-project-context.ts`
**Registration:** `src/server.ts`, line 241

Returns comprehensive project context: recent sessions with topics, message counts, and optionally common topic analysis. Useful for session-start context injection.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | Yes | -- | Project name or path |
| `depth` | `"brief" \| "normal" \| "detailed"` | No | `"normal"` | Detail level |
| `user` | `string` | No | -- | Filter to a specific user scope |

Depth levels:
- `brief`: Last session only
- `normal`: Last 3 sessions
- `detailed`: Last 5 sessions + common topic frequency analysis

#### Example Input

```json
{
  "project": "strata",
  "depth": "detailed"
}
```

#### Example Output

```
## Project Context: strata

**Total sessions**: 23
**Total messages**: 1847

### Recent Sessions
- **3/12/2026** (today): Add evidence gap tracking to the search pipeline
  Session: a1b2c3d4 -- 27 messages
- **3/11/2026** (yesterday): Implement importance scoring for cognitive retrieval
  Session: e5f6a7b8 -- 34 messages
- **3/10/2026** (2 days ago): Fix learning synthesis clustering threshold
  Session: c9d0e1f2 -- 18 messages
- **3/8/2026** (4 days ago): Add procedure extraction from assistant messages
  Session: 3a4b5c6d -- 22 messages
- **3/5/2026** (7 days ago): Refactor parser registry for multi-tool support
  Session: 7e8f9a0b -- 31 messages

### Common Topics
- "search" (15 mentions)
- "knowledge" (12 mentions)
- "sqlite" (9 mentions)
- "parser" (8 mentions)
- "test" (7 mentions)
```

#### Notes

- Topic frequency analysis (in `detailed` mode) uses word frequency across user messages, filtered by stop words from `src/indexing/tokenizer.ts`
- Cached in LRU cache (10 entries, 60 second TTL)

---

## Analysis Tools

### find_patterns

**Category:** Analysis
**Tier:** Free
**Handler:** `src/tools/find-patterns.ts`
**Registration:** `src/server.ts`, line 278

Analyzes conversation history to discover recurring topics, activity patterns (busiest day/hour, session lengths), and repeated issues.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | `string` | No | -- | Limit to a specific project (all projects if omitted) |
| `type` | `"topics" \| "workflows" \| "issues" \| "all"` | No | `"all"` | Pattern category |
| `user` | `string` | No | -- | Filter to a specific user scope |

#### Example Input

```json
{
  "project": "strata",
  "type": "all"
}
```

#### Example Output

```
## Patterns Found

### Recurring Topics
- "sqlite" -- mentioned in 15 messages
- "parser" -- mentioned in 12 messages
- "search" -- mentioned in 11 messages
- "knowledge" -- mentioned in 9 messages
- "typescript" -- mentioned in 8 messages

### Activity Patterns
- Most active day: Wed (247 messages)
- Most active hour: 14:00 (189 messages)
- Average session length: 24.3 messages
- Total sessions: 23

### Repeated Issues
- "sqlite constraint failed" (4 occurrences)
- "parser error jsonl" (3 occurrences)
- "test timeout async" (2 occurrences)
```

#### Notes

- Topic detection: word frequency analysis with stop word filtering, threshold >= 3 occurrences
- Activity patterns: day-of-week and hour-of-day distribution
- Issue detection: messages containing "error", "fix", "bug", "broken", "failing", "not working", "issue" -- grouped by first 5 significant words
- Cached in LRU cache (10 entries, 60 second TTL)

---

## Memory Tools

### store_memory

**Category:** Memory
**Tier:** Free
**Handler:** `src/tools/store-memory.ts`
**Registration:** `src/server.ts`, line 310

Explicitly store a memory/knowledge entry that is immediately searchable. Stored memories get the highest importance boost (`sessionId = "explicit-memory"`, exempt from memory decay).

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory` | `string` | Yes | -- | The text to remember (min 5 chars) |
| `type` | `string` | Yes | -- | Category (see below) |
| `tags` | `string[]` | No | `[]` | Tags for categorization |
| `project` | `string` | No | `"global"` | Project context |
| `user` | `string` | No | `STRATA_DEFAULT_USER` or `"default"` | User scope |

Valid types: `decision`, `solution`, `error_fix`, `pattern`, `learning`, `procedure`, `fact`, `preference`, `episodic`.

#### Example Input

```json
{
  "memory": "Always run database migrations before seeding in the CI pipeline. The seed script depends on the latest schema.",
  "type": "decision",
  "tags": ["database", "ci"],
  "project": "myapp"
}
```

#### Example Output

```
Stored decision: "Always run database migrations before seeding in the CI pipeline" [tags: database, ci]
```

With conflict resolution (Pro):

```
Stored decision: "Always run database migrations before seeding in the CI pipeline" [tags: database, ci] (replaced 1 conflicting entry)
```

Duplicate detection:

```
Skipped duplicate decision: "Always run database migrations before seeding" (already exists)
```

#### Notes

- Entries are stored with `sessionId = "explicit-memory"`, which gives them the maximum explicit importance signal (0.10 weight * 1.0 score) and exempts them from memory decay
- When an LLM provider is available (Pro), long memories (> 100 chars) are compressed into a 1-2 sentence summary while preserving the full text in details
- Conflict resolution runs before writing: checks for up to 5 similar entries, classifies as delete/update/noop
- After storing, `resolveGaps()` checks if any open evidence gaps are resolved by the new entry
- Importance score is computed at write time and stored in the `importance` column

---

### delete_memory

**Category:** Memory
**Tier:** Free
**Handler:** `src/tools/delete-memory.ts`
**Registration:** `src/server.ts`, line 340

Permanently deletes a knowledge entry by ID. The deletion is recorded in the `knowledge_history` audit table.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | `string` | Yes | -- | The entry ID to delete |

#### MCP Annotations

```json
{
  "destructiveHint": true,
  "idempotentHint": false
}
```

#### Example Input

```json
{
  "id": "a1b2c3d4-5678-9abc-def0-123456789abc"
}
```

#### Example Output

```
Deleted entry a1b2c3d4-5678-9abc-def0-123456789abc
```

Error case:

```
Error: entry a1b2c3d4-5678-9abc-def0-123456789abc not found.
```

#### Notes

- Hard delete from the `knowledge` table
- Deletion event is written to `knowledge_history` table with `event = 'delete'`
- Never throws -- errors are returned as strings
- To find entry IDs, use `search_history` or `find_solutions` which include `sessionId` in results

---

## Response Formats

All search and discovery tools support three response formats:

| Format | Description | Token Usage |
|--------|-------------|-------------|
| `standard` | Structured text with headers and metadata | Baseline |
| `concise` | TOON serialization (compact key-value notation) | ~60% fewer tokens |
| `detailed` | Full JSON output | Higher (for programmatic consumers) |

The `concise` format is recommended when token budget is a concern. The `detailed` format is used by the strata-py SDK and other programmatic consumers.

---

## Caching

**Source:** `src/server.ts`, lines 34-38

Two LRU caches reduce redundant computation:

| Cache | Size | TTL | Used By |
|-------|------|-----|---------|
| `searchCache` | 200 entries | 5 minutes | `search_history`, `find_solutions` |
| `historyCache` | 10 entries | 60 seconds | `list_projects`, `get_session_summary`, `get_project_context`, `find_patterns` |

Cache keys are constructed from all relevant parameters. The `store_memory` and `delete_memory` tools do not use caching since they are write operations.

---

## Feature Gating

**Source:** `src/extensions/feature-gate.ts`

The community edition feature gate returns `false` for all feature checks. Pro and Team editions replace this file with a license-aware implementation.

Features gated behind Pro:
- Gemini CLI and Aider parsers (`src/indexing/sqlite-index-manager.ts`, line 52)
- Memory decay penalties (`src/search/result-ranker.ts`, line 66)
- Gemini CLI watch target (`src/watcher/file-watcher.ts`, line 54)
- LLM-enhanced extraction, smart summarization, conflict resolution
- Vector/hybrid search, embeddings, cloud sync

Community edition tools are always available with no license required.

---

## Cross-References

- For architecture details, see [ARCHITECTURE.md](./ARCHITECTURE.md)
- For configuration reference, see [CONFIGURATION.md](./CONFIGURATION.md)
