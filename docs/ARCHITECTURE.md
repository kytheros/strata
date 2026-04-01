# Strata Architecture Overview

Strata is a local memory layer for AI coding assistants. It indexes conversation history into a SQLite database, extracts structured knowledge through quality-gated evaluation, and serves it back through MCP (Model Context Protocol) tools.

---

## Three-Tier Product Model

Strata ships as a layered product family. Each tier extends the one below it:

```
strata (community, free)         15 MCP tools
  ^
  |  imported via "strata-mcp" (npm)
  |
strata-pro (enterprise)         +11 MCP tools, license-gated
  ^
  |  imported via "@kytheros/strata-pro" (npm)
  |
strata-team (team)              + team sync, shared knowledge, RBAC
```

### Community (free, 8 tools)

The core engine. Indexes conversations from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI. Provides full-text search via FTS5 with BM25 ranking, explicit memory storage, pattern discovery, and project context.

**Tools:** `search_history`, `find_solutions`, `list_projects`, `get_session_summary`, `get_project_context`, `find_patterns`, `store_memory`, `delete_memory`

### Pro (licensed, +11 tools)

Adds hybrid retrieval (FTS5 + vector cosine similarity fused via Reciprocal Rank Fusion), cross-machine cloud sync, step-by-step procedure capture, entity graph, usage analytics, conversation ingestion from external agents, and a full audit trail interface.

**Tools:** `semantic_search`, `find_procedures`, `store_procedure`, `search_entities`, `update_memory`, `memory_history`, `ingest_conversation`, `cloud_sync_status`, `cloud_sync_push`, `cloud_sync_pull`, `get_analytics`, `list_evidence_gaps`

### Team (licensed, extends Pro)

Adds shared knowledge bases across teams, RBAC for access control, vector-clock sync for conflict-free team collaboration, and multi-user scoping.

---

## Storage: SQLite + FTS5 + sqlite-vec

Everything lives in a single SQLite database at `~/.strata/strata.db` (configurable via `STRATA_DATA_DIR`).

| Component | Role |
|-----------|------|
| **better-sqlite3** | Synchronous SQLite binding for Node.js. Zero-config, bundled. |
| **WAL mode** | `PRAGMA journal_mode = WAL` enables concurrent reads during writes. |
| **FTS5** | Virtual table `documents_fts` for full-text search with Porter stemming and Unicode tokenization. Kept in sync via INSERT/DELETE/UPDATE triggers. |
| **sqlite-vec** (Pro) | Vector KNN search for cosine similarity on embeddings stored as BLOBs. |

### Core Tables

| Table | Purpose |
|-------|---------|
| `documents` | Indexed conversation chunks with text, session ID, project, role, timestamp, importance score |
| `documents_fts` | FTS5 virtual table over `documents.text` for BM25-ranked full-text search |
| `knowledge` | Extracted knowledge entries (9 types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic) |
| `summaries` | Session summaries with topic, tools used, message counts, date ranges |
| `entities` | Named entities (libraries, services, tools, frameworks) with mention counts and aliases |
| `entity_relations` | Relationships between entities (replaced_by, used_for, depends_on, co_occurs) |
| `knowledge_entities` | Junction table linking knowledge entries to entities |
| `knowledge_history` | Full audit trail of all knowledge mutations -- add, update, delete with before/after content |
| `embeddings` | Vector embeddings stored as BLOBs (Float32Array serialized) with model name |
| `analytics` | Local-only usage events (search, tool_use, knowledge_access, session_index) |
| `evidence_gaps` | Queries that returned no or low-confidence results, with occurrence counts and resolution tracking |
| `index_meta` | Key-value metadata for index state |

Schema initialization is in `src/storage/database.ts`. All `CREATE TABLE` statements use `IF NOT EXISTS`. Column additions use `ALTER TABLE` migrations with existence checks, making schema initialization fully idempotent.

---

## Why Compression-Immune Knowledge Matters

AI coding assistants operate with limited context windows. As conversations grow, older messages are compressed, summarized, or dropped. When a session ends, the context vanishes.

This creates a fundamental problem: operational knowledge discovered during one session -- an API rate limit, a deployment procedure, a bug workaround -- disappears when the session ends or context compresses.

Strata solves this by maintaining a separate persistence layer:

```
Session Context (ephemeral)              Strata Knowledge (permanent)
+-------------------------------+        +-------------------------------+
| Conversation messages         |        | Extracted decisions           |
| Tool calls and results        | -----> | Solutions and error fixes     |
| Compressed, rotated, lost     |        | Patterns and procedures       |
| when session ends             |        | Facts and preferences         |
+-------------------------------+        +-------------------------------+
       Compresses                               Never compresses
```

Knowledge entries survive session teardown, context rotation, and server restarts. They are searchable across all past sessions and all projects, scored by importance so the most valuable knowledge surfaces first.

---

## Retrieval Pipeline

### Community: BM25 Full-Text Search

```
Raw query string
      |
      v
parseQuery()            Extract inline filters (project:, before:, after:, tool:, branch:)
      |
      v
FTS5 MATCH              BM25 ranking (k1=1.2, b=0.75) with Porter stemming
      |
      v
applyFilters()          Remove results not matching project/date/tool filters
      |
      v
applyBoosts()           Multiplicative score adjustments:
      |                   - Recency: 1.2x (<=7d), 1.1x (<=30d)
      |                   - Project match: 1.3x
      |                   - Memory decay (Pro): 0.85x (>90d), 0.7x (>180d)
      |                   - Importance: score *= (1.0 + importance * 0.5)
      v
Session dedup           Keep only the highest-scoring chunk per session
      |
      v
Confidence scoring      Normalize to [0, 1] relative to top score
      |
      v
SearchResult[]
```

Explicit memories (stored via `store_memory`, sessionId = `"explicit-memory"`) are exempt from memory decay.

### Pro: Hybrid BM25 + Vector + RRF

Strata Pro adds vector search and fuses it with BM25 using Reciprocal Rank Fusion (RRF).

```
Raw query
      |
      +-------------------+
      |                   |
      v                   v
FTS5 BM25            Vector embed query
(same as above)      (Gemini 3072d, or MiniLM 384d, or OpenAI 1536d)
      |                   |
      |                   v
      |              Cosine similarity search
      |              against stored embeddings
      |                   |
      +-------------------+
      |
      v
reciprocalRankFusion()    RRF(d) = SUM(1 / (k + rank_i(d))), k=60
      |
      v
applyFilters() -> applyBoosts() -> dedup -> confidence
      |
      v
SearchResult[]
```

The hybrid pipeline finds results that keyword search misses. A query for "authentication" finds results about "login flow" or "OAuth setup" through vector similarity, even when those exact keywords do not appear in the text.

If the embedding provider is unavailable (no API key, service down), the pipeline degrades gracefully to BM25-only search.

**Embedding providers** (configured via `STRATA_EMBEDDING_PROVIDER` env var):
- **Gemini** (`gemini-embedding-001`): 3072 dimensions. Primary provider. Auth via `GEMINI_API_KEY` or Google Cloud ADC.
- **Local** (`all-MiniLM-L6-v2`): 384 dimensions. Downloads ~23MB model on first use. No API key needed.
- **OpenAI** (`text-embedding-3-small`): 1536 dimensions. Auth via `STRATA_OPENAI_API_KEY`.

### Solution-Biased Search

The `find_solutions` tool applies an additional 1.5x boost to results containing solution-indicator words: "fixed", "solved", "solution", "resolved", "issue was", "the problem", "worked", "working now". This re-ranks results so fix/resolution content surfaces first when debugging.

---

## Evaluator Pipeline: Quality Gates Before Storage

Before any knowledge enters the store, it passes through the `KnowledgeEvaluator` (`src/knowledge/knowledge-evaluator.ts`). This is a deterministic, rule-based quality gate -- not a learned model. It is the primary architectural differentiator: every competitor stores first and ranks later; Strata evaluates before storage.

Three criteria are checked in sequence. If any check fails, the entry is rejected:

1. **Actionability** -- Must contain actionable patterns: action verbs (use, avoid, prefer, always, never, must, should, configure, enable, disable...), conditional patterns (when...then, if...use), comparison language (instead of, rather than), operational terms (rate limit, timeout, retry, endpoint, error fix).

2. **Specificity** -- Must contain at least 2 of: numbers, version strings (`v1.2.3`), URLs, HTTP status codes, API/endpoint references, constants (`MAX_RETRIES`), backtick-quoted values, measurement units (ms, seconds, MB, req/s), technical terms (port, header, token, key, flag, param).

3. **Relevance** -- Must not match irrelevance patterns: casual opinions ("I think", "in my opinion"), non-technical topics (politics, sports, entertainment, gossip), humor (joke, funny, lol, haha).

See [Evaluator Pipeline](evaluator-pipeline.md) for detailed examples of accepted and rejected content, the importance scoring formula, and conflict resolution behavior.

---

## Data Flow: Ingestion to Retrieval

```
Conversation History Files
  (Claude Code, Codex, Aider, Cline, Gemini CLI)
         |
         v
  +--------------+
  |   Parsers    |  Parse vendor-specific formats into normalized messages
  +--------------+
         |
         v
  +--------------+
  |   Chunker    |  Split into ~500-token chunks with 50-token overlap
  +--------------+
         |
    +----+----+
    |         |
    v         v
 Documents   Knowledge Pipeline
 + FTS5      1. Extract (regex-based, or LLM-enhanced with Pro)
 Index       2. Evaluate (actionability + specificity + relevance gates)
             3. Score importance (type 35% + language 20% + frequency 35% + explicit 10%)
             4. Check duplicates (trigram Jaccard > 0.90 = duplicate)
             5. Resolve conflicts (LLM classification if provider available)
             6. Store in knowledge table
             7. Log to knowledge_history (audit trail)
         |
         v
  +-------------------+
  | Entity Extraction  |  Libraries, services, tools, frameworks
  | Procedure Extract  |  Step-by-step workflows
  | Session Summary    |  Topic, tools used, key decisions
  +-------------------+
         |
         v
  +-------------------+
  | 8 MCP Tools       |  search_history, find_solutions, store_memory, ...
  | (stdio or HTTP)   |
  +-------------------+
         |
         v
  Your AI Assistant
```

---

## Further Reading

- [Evaluator Pipeline](evaluator-pipeline.md) -- quality gate criteria, examples, importance scoring
- [Provenance & Audit](provenance.md) -- knowledge_history table, tracing entries to origin
- [Benchmarks](benchmarks.md) -- retrieval quality metrics and methodology
- [Integration: Claude Code](integration/claude-code.md) -- setup and configuration
- [Integration: MCP Client](integration/mcp-client.md) -- generic MCP client setup
