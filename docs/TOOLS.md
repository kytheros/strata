# Strata MCP Tools Reference

Strata exposes its functionality through the Model Context Protocol (MCP) as a set of tools that AI coding agents can call directly. These tools provide persistent memory, knowledge search, entity tracking, procedure storage, and conversation ingestion across sessions and projects.

All tools are available via the MCP `tools/call` method. Free tools (14 total) are always available. Pro tools (5 total) require a valid Strata license with the appropriate feature gate.

---

## Table of Contents

- [Response Formats](#response-formats)
- [Search Tools](#search-tools)
  - [search_history](#search_history)
  - [find_solutions](#find_solutions)
  - [list_projects](#list_projects)
  - [get_session_summary](#get_session_summary)
  - [get_project_context](#get_project_context)
  - [find_patterns](#find_patterns)
- [Memory Tools](#memory-tools)
  - [store_memory](#store_memory)
  - [update_memory](#update_memory)
  - [delete_memory](#delete_memory)
  - [memory_history](#memory_history)
- [Procedure Tools](#procedure-tools)
  - [store_procedure](#store_procedure)
  - [find_procedures](#find_procedures)
- [Entity Tools](#entity-tools)
  - [search_entities](#search_entities)
- [Ingest Tools](#ingest-tools)
  - [ingest_conversation](#ingest_conversation)
- [Pro Tools](#pro-tools)
  - [semantic_search](#semantic_search)
  - [cloud_sync_status](#cloud_sync_status)
  - [cloud_sync_push](#cloud_sync_push)
  - [cloud_sync_pull](#cloud_sync_pull)
  - [get_analytics](#get_analytics)

---

## Response Formats

Most search and discovery tools accept a `format` parameter that controls response verbosity and token usage. Choose the format that matches your consumer.

| Format | Description | Token Impact | Best For |
|--------|-------------|--------------|----------|
| `concise` | TOON (Token-Optimized Object Notation) -- compact key:value pairs | 30-60% fewer tokens | LLM consumption, token-constrained contexts |
| `standard` | Structured text with confidence bands `[high]`/`[medium]`/`[low]` | Baseline (default) | General use, human-readable output |
| `detailed` | Full JSON array with all fields | Highest token count | Programmatic consumers, SDKs, agents that parse structured data |

### Field Visibility by Format (Search Results)

| Field | concise | standard | detailed |
|-------|---------|----------|----------|
| `project` | Yes | Yes | Yes |
| `sessionId` | -- | -- | Yes |
| `date` | Yes | Yes | Yes |
| `score` | Yes | Yes | Yes |
| `confidence` | -- | Yes | Yes |
| `role` | -- | -- | Yes |
| `tools` | -- | Yes | Yes |
| `snippet` | Yes | Yes | -- |
| `text` | -- | -- | Yes |

### Field Visibility by Format (Project Listings)

| Field | concise | standard | detailed |
|-------|---------|----------|----------|
| `name` | Yes | Yes | Yes |
| `path` | -- | Yes | Yes |
| `sessions` | Yes | Yes | Yes |
| `messages` | Yes | Yes | Yes |
| `firstActive` | -- | Yes | Yes |
| `lastActive` | Yes | Yes | Yes |

---

## Search Tools

### search_history

Full-text search across past conversations using FTS5 with BM25 ranking.

**When to use:** You need to find past discussions, decisions, or code changes across your conversation history. This is the primary search tool and the best starting point for most queries.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | -- | Search text with optional inline filters |
| `project` | string | No | all projects | Filter to a specific project name or path |
| `limit` | number | No | 20 | Maximum results (1-100) |
| `include_context` | boolean | No | false | Include surrounding message context |
| `format` | enum | No | `standard` | `concise`, `standard`, or `detailed` |
| `user` | string | No | all users | Filter results to a specific user scope |

#### Inline Filter Syntax

Filters can be embedded directly in the `query` string:

| Filter | Syntax | Example |
|--------|--------|---------|
| Project | `project:<name>` | `docker compose project:myapp` |
| After (relative) | `after:<duration>` | `migration after:7d` |
| Before (relative) | `before:<duration>` | `deployment before:30d` |
| After (absolute) | `after:<date>` | `refactor after:2024-06-01` |
| Before (absolute) | `before:<date>` | `bug fix before:2024-12-31` |
| Tool used | `tool:<name>` | `database tool:Bash` |

Relative durations use the format `Nd` (days). Absolute dates use `YYYY-MM-DD`.

#### Ranking Behavior

- **BM25 ranking** from FTS5 full-text search
- **Recency boosts**: Results from the last 7 days get 1.2x score; last 30 days get 1.1x
- **Project match boost**: 1.3x when the result's project matches the `project` parameter
- **Memory decay**: Auto-indexed entries older than 90 days get 0.85x; older than 180 days get 0.7x. Entries created via `store_memory` are exempt from decay.
- **Confidence scoring**: Each result receives a 0.0-1.0 confidence score normalized against the top result. In `standard` format, results display `[high]`, `[medium]`, or `[low]` confidence bands.

#### Example

```json
{
  "name": "search_history",
  "arguments": {
    "query": "docker compose networking after:7d",
    "project": "myapp",
    "limit": 10,
    "format": "standard"
  }
}
```

Returns structured text with confidence bands:

```
Found 3 result(s) for "docker compose networking":

--- myapp (3/5/2026) [high] [tools: Bash, Edit] ---
Fixed Docker networking issue by adding custom bridge network...

--- myapp (3/2/2026) [medium] ---
Discussed docker-compose.yml port mapping configuration...
```

#### Tips

- Start with broad queries and narrow down using inline filters.
- If no results are found, try `list_projects` to see available projects.
- Use `format: "concise"` when calling from within an agent to save context window tokens.
- Combine the `project` parameter with inline `tool:` filters to find specific tool usage in a project.

---

### find_solutions

Solution-biased search for errors and problems from past conversations.

**When to use:** You have encountered an error or problem and want to check if you (or your team) have solved it before. This tool boosts results that contain resolution language.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `error_or_problem` | string | Yes | -- | The error message or problem description |
| `technology` | string | No | -- | Technology context for better matching (e.g., `docker`, `typescript`) |
| `format` | enum | No | `standard` | `concise`, `standard`, or `detailed` |
| `user` | string | No | all users | Filter results to a specific user scope |

#### Ranking Behavior

- **Solution bias**: Results containing keywords like "fixed", "solved", "resolved", "solution", "the problem", "worked", "working now" score 1.5x higher
- Searches up to 50 results internally, returns the top 20 (or top 10 in standard format display)
- Same confidence scoring and decay rules as `search_history`

#### Example

```json
{
  "name": "find_solutions",
  "arguments": {
    "error_or_problem": "ECONNREFUSED 127.0.0.1:5432",
    "technology": "docker"
  }
}
```

Returns:

```
Found 2 potential solution(s) for "ECONNREFUSED 127.0.0.1:5432":

--- myapp (2/28/2026) [high] ---
Fixed: the PostgreSQL container wasn't in the same Docker network.
Added `networks: [app-net]` to both services in docker-compose.yml...
```

#### Tips

- Paste the exact error message for best results.
- Add `technology` context to disambiguate -- "ECONNREFUSED" with `technology: "docker"` returns different results than with `technology: "node"`.
- If results seem irrelevant, try `search_history` with broader terms.

---

### list_projects

List all projects that have conversation history.

**When to use:** You need to discover what projects are available before running targeted searches. Also useful for understanding your overall activity across projects.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `sort_by` | enum | No | `recent` | `recent`, `sessions`, `messages`, or `name` |
| `format` | enum | No | `standard` | `concise`, `standard`, or `detailed` |
| `user` | string | No | all users | Filter to a specific user scope |

#### Example

```json
{
  "name": "list_projects",
  "arguments": {
    "sort_by": "sessions"
  }
}
```

Returns:

```
3 projects with conversation history:

- **strata-mcp-server** -- 47 sessions, 1,203 messages
  Path: /home/user/projects/strata-mcp-server
  Active: 1/15/2026 -> 3/6/2026

- **myapp** -- 23 sessions, 456 messages
  Path: /home/user/projects/myapp
  Active: 2/1/2026 -> 3/5/2026
```

#### Tips

- Run this first when starting work on a new machine or after a break to orient yourself.
- Use `sort_by: "messages"` to find your most active projects.
- Project names shown here can be used as values for the `project` parameter in other tools.

---

### get_session_summary

Get a structured summary of a specific conversation session.

**When to use:** You want to review what happened in a particular session -- the topic, tools used, key decisions, and conversation flow.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session_id` | string | No | -- | Specific session UUID |
| `project` | string | No | -- | Project name -- returns most recent session |
| `user` | string | No | all users | Filter to a specific user scope |

At least one of `session_id` or `project` is required. When `project` is provided without `session_id`, the most recent session for that project is returned.

#### Example

```json
{
  "name": "get_session_summary",
  "arguments": {
    "project": "strata-mcp-server"
  }
}
```

Returns:

```
## Session Summary: strata-mcp-server

**Session ID**: a1b2c3d4-...
**Project**: /home/user/projects/strata-mcp-server
**Branch**: main
**Time**: 3/6/2026, 10:00:00 AM -> 3/6/2026, 11:30:00 AM
**Messages**: 12 user, 12 assistant

### Initial Topic
Implement the ingest_conversation MCP tool...

### Tools Used
Bash, Edit, Read, Write

### Conversation Flow
- Implement the ingest_conversation MCP tool...
- Add validation for metadata field...
- Write acceptance tests for the pipeline...
```

#### Tips

- Use `project` for a quick "what did I do last?" check.
- Session IDs can be found in `search_history` results (visible in `detailed` format).

---

### get_project_context

Get comprehensive project context: recent sessions, key topics, and patterns.

**When to use:** You are starting a new session and want context about what has been done recently in a project. This is the recommended tool for session-start context injection.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | string | No | -- | Project name or path (effectively required -- returns error if omitted) |
| `depth` | enum | No | `normal` | `brief` (last session), `normal` (last 3), `detailed` (last 5 + topic analysis) |
| `user` | string | No | all users | Filter to a specific user scope |

#### Depth Levels

| Depth | Sessions Shown | Topic Analysis |
|-------|---------------|----------------|
| `brief` | Last 1 | No |
| `normal` | Last 3 | No |
| `detailed` | Last 5 | Yes -- top word frequency analysis across all messages |

#### Example

```json
{
  "name": "get_project_context",
  "arguments": {
    "project": "strata-mcp-server",
    "depth": "detailed"
  }
}
```

Returns:

```
## Project Context: strata-mcp-server

**Total sessions**: 47
**Total messages**: 1203

### Recent Sessions
- **3/6/2026** (today): Implement the ingest_conversation MCP tool
  Session: a1b2c3d4-... -- 24 messages
- **3/5/2026** (yesterday): Add entity extraction pipeline
  Session: e5f6g7h8-... -- 18 messages
...

### Common Topics
- "sqlite" (45 mentions)
- "knowledge" (38 mentions)
- "extraction" (29 mentions)
```

#### Tips

- Use `depth: "brief"` in automated session-start hooks to minimize token usage.
- Use `depth: "detailed"` when you need a thorough overview of project activity.

---

### find_patterns

Discover recurring patterns in conversation history.

**When to use:** You want to understand workflow trends, identify frequently discussed topics, find recurring issues, or see activity patterns (busiest times, session lengths).

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `project` | string | No | all projects | Limit analysis to a specific project |
| `type` | enum | No | `all` | `topics`, `workflows`, `issues`, or `all` |
| `user` | string | No | all users | Filter to a specific user scope |

#### Pattern Types

| Type | What It Finds |
|------|---------------|
| `topics` | Words mentioned in 3+ messages, ranked by frequency |
| `workflows` | Activity patterns: busiest day, busiest hour, average session length, total sessions |
| `issues` | Messages containing error/fix/bug/failing language, grouped by similarity |

#### Example

```json
{
  "name": "find_patterns",
  "arguments": {
    "project": "strata-mcp-server",
    "type": "issues"
  }
}
```

Returns:

```
## Patterns Found

### Repeated Issues
- "sqlite locking error" (4 occurrences)
- "type error knowledge" (2 occurrences)
```

---

## Memory Tools

### store_memory

Explicitly store a memory for future recall.

**When to use:** You want to permanently save a decision, solution, pattern, or fact that should be searchable in future sessions. Stored memories are immediately available via `search_history` and `find_solutions`, and are exempt from memory decay.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memory` | string | Yes | -- | The text to remember (minimum 5 characters) |
| `type` | enum | Yes | -- | Category (see types below) |
| `tags` | string[] | No | `[]` | Tags for categorization |
| `project` | string | No | `global` | Project context |
| `user` | string | No | env `STRATA_DEFAULT_USER` or `default` | User scope |

#### Memory Types

| Type | When to Use |
|------|------------|
| `decision` | Architectural or design decisions with rationale |
| `solution` | Working solutions to problems |
| `error_fix` | Specific error resolutions with root cause |
| `pattern` | Recurring patterns observed across sessions |
| `learning` | Key learnings or insights |
| `procedure` | Step-by-step processes (prefer `store_procedure` for structured steps) |
| `fact` | Technical facts: API limits, config values, version requirements |
| `preference` | User or project preferences |
| `episodic` | Context-specific events worth remembering |

#### Conflict Resolution

When a new memory semantically conflicts with existing entries, Strata automatically:
1. Detects conflicting facts (e.g., "API limit is 100/min" vs. "API limit is 200/min")
2. Resolves by recency -- the newest entry wins
3. Reports resolution in the response (e.g., "replaced 1 conflicting entry")

Duplicate memories (>0.90 trigram Jaccard similarity) are silently skipped.

#### Example

```json
{
  "name": "store_memory",
  "arguments": {
    "memory": "Always run database migrations before seeding in this project. The seed script depends on the latest schema.",
    "type": "decision",
    "tags": ["database", "migrations"],
    "project": "myapp"
  }
}
```

Returns:

```
Stored decision: "Always run database migrations before seeding in this project." [tags: database, migrations]
```

#### Tips

- Be specific and include technical details -- memories are only as useful as their content.
- Use `tags` to enable broader discovery across projects.
- If a Gemini API key is configured, Strata will LLM-compress long memories into concise summaries while preserving the full text as details.

---

### update_memory

Partially update an existing memory entry.

**When to use:** You need to correct, refine, or re-categorize a previously stored memory. Only the fields you provide are changed; all others remain as-is.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | -- | The entry ID to update |
| `summary` | string | No | -- | New summary text |
| `details` | string | No | -- | New details text |
| `tags` | string[] | No | -- | New tags (replaces existing tags) |
| `type` | enum | No | -- | New type: `decision`, `solution`, `error_fix`, `pattern`, `learning`, `procedure`, `fact`, `preference`, `episodic` |

At least one optional field must be provided. All changes are recorded in the audit history accessible via `memory_history`.

#### Example

```json
{
  "name": "update_memory",
  "arguments": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "summary": "API rate limit is 200/min (updated from 100/min)",
    "tags": ["api", "rate-limit", "updated"]
  }
}
```

Returns:

```
Updated entry a1b2c3d4-...: summary, tags changed
```

---

### delete_memory

Permanently delete a memory entry.

**When to use:** A stored memory is incorrect, outdated, or no longer relevant and should be removed from search results.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | -- | The entry ID to delete |

The deletion is a hard delete -- the entry is removed from the knowledge store. However, the deletion event is preserved in the audit trail and remains accessible via `memory_history`.

#### Example

```json
{
  "name": "delete_memory",
  "arguments": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

Returns:

```
Deleted entry a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

### memory_history

View the mutation audit trail for a memory entry.

**When to use:** You need to see how a memory changed over time, verify when it was created, or check the state of a deleted entry.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | -- | The entry ID to get history for |
| `limit` | number | No | 20 | Maximum rows to return (1-100) |

Returns history events in reverse chronological order (most recent first). History persists even after deletion, so you can always audit what happened to an entry.

#### Event Types

| Event | Description |
|-------|-------------|
| `add` | Entry was created -- shows the initial summary |
| `update` | Entry was modified -- shows old and new values for changed fields |
| `delete` | Entry was removed -- shows the summary at time of deletion |

#### Example

```json
{
  "name": "memory_history",
  "arguments": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "limit": 50
  }
}
```

Returns:

```
History for entry a1b2c3d4-... (3 events):

  [2026-03-06 14:30:00] delete -- summary: "API rate limit is 200/min"
  [2026-03-05 10:15:00] update -- summary: "API rate limit is 100/min" -> "API rate limit is 200/min"
  [2026-03-01 09:00:00] add -- summary: "API rate limit is 100/min"
```

---

## Procedure Tools

### store_procedure

Store a step-by-step procedure for future recall.

**When to use:** You want to save a workflow, how-to guide, deployment process, or any multi-step operation. Re-storing a procedure with the same title auto-merges steps, so you can incrementally build up procedures across sessions.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `title` | string | Yes | -- | Procedure title (max 200 characters) |
| `steps` | string[] | Yes | -- | Ordered list of steps (2-20 items, each max 500 characters) |
| `prerequisites` | string[] | No | -- | Setup requirements that must be met before starting |
| `warnings` | string[] | No | -- | Caution notes or common pitfalls |
| `tags` | string[] | No | `[]` | Categorization tags (merged with auto-extracted tags, max 20 total) |
| `project` | string | No | `global` | Project context |
| `user` | string | No | env `STRATA_DEFAULT_USER` or `default` | User scope |

#### Auto-Merge Behavior

If a procedure with the same `title` already exists, the new steps are merged with the existing ones rather than creating a duplicate. This allows building up comprehensive procedures across multiple sessions.

#### Example

```json
{
  "name": "store_procedure",
  "arguments": {
    "title": "Deploy to Cloud Run",
    "steps": [
      "Build the Docker image: docker build -t gcr.io/myproject/app .",
      "Push to Container Registry: docker push gcr.io/myproject/app",
      "Deploy: gcloud run deploy app --image gcr.io/myproject/app --region us-central1",
      "Verify: curl https://app-xxxxx.a.run.app/health"
    ],
    "prerequisites": [
      "gcloud CLI installed and authenticated",
      "Docker daemon running"
    ],
    "warnings": [
      "Cloud Run cold starts may cause first request to take 5-10s"
    ],
    "tags": ["deployment", "gcp", "docker"],
    "project": "myapp"
  }
}
```

Returns:

```
Stored procedure: "Deploy to Cloud Run" (4 steps)
```

---

### find_procedures

Search for stored step-by-step procedures and workflows.

**When to use:** You need to recall a previously stored or automatically extracted procedure. Returns formatted, numbered step lists.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | -- | Search text to find matching procedures |
| `project` | string | No | all projects | Filter to a specific project |
| `user` | string | No | all users | Filter to a specific user scope |

Results are ranked by step count (more complete procedures first), then by occurrence count.

#### Example

```json
{
  "name": "find_procedures",
  "arguments": {
    "query": "deploy cloud run",
    "project": "myapp"
  }
}
```

Returns:

```
Deploy to Cloud Run
Steps:
  1. Build the Docker image: docker build -t gcr.io/myproject/app .
  2. Push to Container Registry: docker push gcr.io/myproject/app
  3. Deploy: gcloud run deploy app --image gcr.io/myproject/app --region us-central1
  4. Verify: curl https://app-xxxxx.a.run.app/health
Prerequisites:
  - gcloud CLI installed and authenticated
  - Docker daemon running
Warnings:
  - Cloud Run cold starts may cause first request to take 5-10s
```

#### Tips

- Strata also auto-extracts procedures from conversations, so `find_procedures` may return results even if you never explicitly stored any.
- The query matches against the title, steps, and tags.

---

## Entity Tools

### search_entities

Query the cross-session entity graph.

**When to use:** You want to find information about libraries, services, tools, languages, frameworks, people, concepts, or files that have been discussed across your sessions. Also useful for discovering what technologies are most frequently referenced.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | -- | Entity name or partial match. Pass an empty string `""` to get top entities by mention count |
| `type` | string | No | all types | Filter by entity type: `library`, `service`, `tool`, `language`, `framework`, `person`, `concept`, `file` |
| `project` | string | No | all projects | Filter to a specific project |
| `limit` | number | No | 10 | Maximum knowledge entries per entity (1-100) |
| `user` | string | No | all users | Filter to a specific user scope |

#### Response Structure

For each matching entity, the response includes:
- **Entity details**: canonical name, type, mention count, first/last seen dates, aliases
- **Related knowledge**: Knowledge entries linked to this entity (decisions, solutions, patterns, etc.)
- **Relations**: Connections to other entities (e.g., "React -> uses -> TypeScript")

#### Example: Search for a specific entity

```json
{
  "name": "search_entities",
  "arguments": {
    "query": "PostgreSQL",
    "type": "service",
    "limit": 5
  }
}
```

Returns:

```
## Entity: PostgreSQL (service)
Mentions: 23 | First seen: 2026-01-15 | Last seen: 2026-03-06
Aliases: postgres, pg, postgresql
Project: myapp

### Related Knowledge
- [solution] Fixed connection pooling issue with PgBouncer (2026-03-05)
- [decision] Use PostgreSQL over MySQL for JSONB support (2026-02-10)
- [error_fix] ECONNREFUSED resolved by checking Docker network (2026-01-20)

### Relations
- -> uses pgbouncer
- -> stores_data_for myapp-api
```

#### Example: Get top entities

```json
{
  "name": "search_entities",
  "arguments": {
    "query": ""
  }
}
```

Returns:

```
## Top Entities by Mention Count

- **TypeScript** (language) -- 89 mentions
- **SQLite** (library) -- 67 mentions
- **Docker** (tool) -- 45 mentions
```

---

## Ingest Tools

### ingest_conversation

Push a conversation from any AI agent into the full extraction pipeline.

**When to use:** You have conversations from non-file-based agents (Slack bots, Cursor, Copilot, custom orchestration frameworks) that you want indexed into Strata. This is the programmatic entry point for cross-agent knowledge sharing.

The ingestion pipeline runs six steps, each independently error-guarded:
1. **Knowledge extraction** -- decisions, solutions, patterns, learnings
2. **Entity extraction** -- libraries, services, tools, etc.
3. **Procedure extraction** -- step-by-step workflows
4. **Document indexing** -- FTS5 full-text indexing for search
5. **Session summarization** -- structured summary with topic
6. **Learning synthesis** -- clusters related knowledge into higher-level learnings

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `messages` | array | Yes | -- | Conversation messages (see message schema below) |
| `agent` | string | Yes | -- | Source agent identifier (max 128 characters), e.g. `my-slack-bot`, `cursor`, `copilot` |
| `sessionId` | string | No | auto-generated UUID | Unique session ID (max 128 characters). Re-ingesting the same ID is idempotent |
| `project` | string | No | `global` | Project context |
| `user` | string | No | env `STRATA_DEFAULT_USER` or `default` | User scope |
| `metadata` | string | No | -- | JSON-encoded metadata object (max 20 keys, max 1000 characters per value) |

#### Message Schema

Each message in the `messages` array:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `role` | enum | Yes | `user`, `assistant`, or `system` |
| `text` | string | Yes | Message text content |
| `timestamp` | string | No | ISO 8601 timestamp (e.g., `2026-03-06T10:30:00Z`) |
| `toolCalls` | array | No | Tool invocations in this message |

Each tool call in `toolCalls`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Tool name |
| `input` | string | No | Tool input snippet (first 200 characters used) |

#### Idempotency

Providing the same `sessionId` for a re-ingest is safe. The pipeline removes existing documents for that session before re-indexing, preventing duplicates.

#### Example

```json
{
  "name": "ingest_conversation",
  "arguments": {
    "messages": [
      {
        "role": "user",
        "text": "How do I fix the CORS error in the API?",
        "timestamp": "2026-03-06T10:00:00Z"
      },
      {
        "role": "assistant",
        "text": "Add the cors middleware before your routes: app.use(cors({ origin: 'https://myapp.com' })). The error occurs because the browser blocks cross-origin requests without proper headers.",
        "timestamp": "2026-03-06T10:00:30Z",
        "toolCalls": [
          { "name": "Edit", "input": "src/server.ts" }
        ]
      }
    ],
    "agent": "cursor",
    "project": "myapp-api",
    "metadata": "{\"env\": \"development\", \"editor\": \"cursor\"}"
  }
}
```

Returns (JSON):

```json
{
  "sessionId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "entriesExtracted": 1,
  "entitiesFound": 2,
  "proceduresFound": 0,
  "conflictsResolved": 0,
  "summary": "Fixing CORS error in API"
}
```

#### Tips

- System role messages are automatically merged into the next user message (the internal pipeline only supports user/assistant roles).
- Empty-text messages are silently filtered out.
- If a Gemini API key is configured, the pipeline uses LLM-enhanced extraction for deeper knowledge extraction and smarter summarization.
- Use `metadata` for custom context (environment, editor, deployment target) -- it is preserved but not currently searchable.

---

## Pro Tools

These tools require a valid Strata license with the corresponding feature gate. See the [Monetization](MONETIZATION.md) doc for licensing details.

### semantic_search

Hybrid FTS5 + vector cosine similarity search via Reciprocal Rank Fusion (RRF).

**Feature gate:** `vector_search`

**When to use:** Keyword search is not finding what you need because the relevant content uses different terminology. Semantic search finds conceptually similar results (e.g., searching "authentication" also finds "login flow" and "OAuth setup").

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | -- | Search query (supports semantic matching beyond keywords) |
| `project` | string | No | all projects | Filter to a specific project |
| `limit` | number | No | 20 | Maximum results (1-100) |
| `threshold` | number | No | -- | Minimum cosine similarity (0.0-1.0). Only results at or above this threshold are returned |
| `user` | string | No | all users | Filter to a specific user scope |

#### How It Works

1. Runs BM25 keyword search via FTS5
2. Runs vector cosine similarity search via embeddings
3. Combines results using Reciprocal Rank Fusion (RRF) to produce a unified ranking
4. Results from both sources are deduplicated and sorted by fused score

#### Example

```json
{
  "name": "semantic_search",
  "arguments": {
    "query": "handling user authentication",
    "project": "myapp",
    "threshold": 0.5
  }
}
```

Returns:

```
Semantic search: 4 result(s)

[0.823] [vector] myapp (2026-03-01) -- Implemented JWT-based login flow with refresh tokens...
[0.756] [fts] myapp (2026-02-15) -- Added OAuth2 provider integration for Google sign-in...
[0.691] [vector] myapp (2026-01-20) -- Session management middleware with cookie-based auth...
[0.534] [fts] myapp (2026-01-10) -- Password hashing with bcrypt, salt rounds set to 12...
```

#### Tips

- Requires running `strata-mcp embed` to generate vector embeddings before first use.
- Use `threshold` to filter out low-relevance results when precision matters.
- Falls back gracefully to keyword-only search if embeddings are not yet generated.

---

### cloud_sync_status

Check cloud sync configuration and connection status.

**Feature gate:** `cloud_sync`

**When to use:** Verify that cloud sync is properly configured, check connection health, or see when the last sync occurred.

#### Parameters

None.

#### Example

```json
{
  "name": "cloud_sync_status",
  "arguments": {}
}
```

Returns (when configured):

```
Cloud sync: Connected
Server: https://your-server.supabase.co
User: user@example.com
Team: my-team

Last sync:
  Push knowledge: 2026-03-06T10:30:00.000Z
  Push sessions:  2026-03-06T10:30:00.000Z
  Pull knowledge: 2026-03-06T09:00:00.000Z
  Pull sessions:  2026-03-06T09:00:00.000Z
  Total pushes: 23
  Total pulls: 15
```

Returns (when not configured):

```
Cloud sync is not configured.

To enable, set these environment variables:
- CLAUDE_HISTORY_API_URL: Your cloud server URL
- CLAUDE_HISTORY_API_KEY: Your API key
- CLAUDE_HISTORY_TEAM_ID: (optional) Team ID for shared sync
```

---

### cloud_sync_push

Push local knowledge and session summaries to the cloud.

**Feature gate:** `cloud_sync`

**When to use:** You want to back up local data to the cloud or share knowledge across machines.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `force` | boolean | No | false | Push all entries regardless of last sync time. When false, only pushes entries newer than the last push timestamp. |

#### Example

```json
{
  "name": "cloud_sync_push",
  "arguments": {
    "force": false
  }
}
```

Returns:

```
Push complete:
  Knowledge: 5 new, 12 already synced (17 total)
  Sessions: 2 new, 0 updated (2 total)
```

---

### cloud_sync_pull

Pull knowledge and session summaries from the cloud.

**Feature gate:** `cloud_sync`

**When to use:** You want to sync data from the cloud to your local machine, such as when setting up a new machine or pulling knowledge shared by teammates.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `force` | boolean | No | false | Pull all entries regardless of last sync time. When false, only pulls entries newer than the last pull timestamp. |

Merges cloud data with the local store without creating duplicates (entries with matching IDs are skipped).

#### Example

```json
{
  "name": "cloud_sync_pull",
  "arguments": {
    "force": true
  }
}
```

Returns:

```
Pull complete:
  Knowledge: 8 new entries merged (23 received from cloud)
  Sessions: 15 received from cloud
```

---

### get_analytics

View local usage analytics.

**Feature gate:** `analytics`

**When to use:** You want to understand your Strata usage patterns -- search frequency, tool invocations, knowledge creation rates, and activity trends.

All analytics data is stored locally and never transmitted. For privacy, no raw query text is stored -- only hashed and categorized data.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `period` | enum | No | `30d` | Time range: `7d`, `30d`, `90d`, or `all` |
| `type` | enum | No | `all` | Data type: `search`, `usage`, `activity`, or `all` |

#### Analytics Types

| Type | What It Shows |
|------|--------------|
| `search` | Total searches, average results per search, average response time, top query categories |
| `usage` | Sessions indexed, tool invocations by tool name, knowledge entries created by type |
| `activity` | Busiest day, busiest hour, sessions this week |

#### Example

```json
{
  "name": "get_analytics",
  "arguments": {
    "period": "7d",
    "type": "all"
  }
}
```

Returns (JSON):

```json
{
  "period": "7d",
  "search": {
    "total_searches": 42,
    "avg_results_per_search": 8.3,
    "avg_response_time_ms": 23,
    "top_categories": ["debugging", "architecture", "deployment"]
  },
  "usage": {
    "sessions_indexed": 12,
    "tool_invocations": { "Bash": 156, "Edit": 89, "Read": 234 },
    "knowledge_created": { "decision": 5, "solution": 8, "error_fix": 3 }
  },
  "activity": {
    "busiest_day": "Wednesday",
    "busiest_hour": 14,
    "sessions_this_week": 12
  }
}
```
