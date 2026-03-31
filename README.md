# strata-mcp

Local memory layer for AI coding assistants. Strata indexes your conversations from Claude Code, Codex CLI, Aider, Cline, and Gemini CLI into a local SQLite database, then exposes MCP tools so your assistant can recall past decisions, solutions, and patterns across sessions.

**Semantic search included.** Add a free [Gemini API key](https://aistudio.google.com/apikey) to enable hybrid FTS5 + vector search with 3072-dimensional embeddings, LLM-powered knowledge extraction, and training data accumulation for local model distillation. Falls back to keyword search without it.

No cloud required. No memory caps. Everything stays on your machine. Or deploy to [Cloudflare Workers + D1](#deploy-on-cloudflare-workers--d1) or [Google Cloud Run](#deploy-on-gcp-cloud-run) for a cloud-hosted setup.

**Cross-tool memory.** Store a decision in Claude Code, recall it from Gemini CLI. One shared knowledge base across all your AI coding assistants.

**What makes Strata different:** Every knowledge entry passes through a [quality-gated evaluator pipeline](docs/evaluator-pipeline.md) before storage. Actionability, specificity, and relevance are checked deterministically. The result is a knowledge base that stays clean and auditable -- not a growing pile of everything.

---

## Quick Start (< 5 minutes)

### 1. Install

```bash
npm install -g strata-mcp
```

### 2. Set up your AI tool

**Claude Code:**
```bash
strata init --claude
```

**Gemini CLI:**
```bash
strata init --gemini
```

**Both (auto-detects installed CLIs):**
```bash
strata init
```

This registers the MCP server, installs session hooks, skills, and creates the project context file (CLAUDE.md / GEMINI.md).

### 3. Restart your CLI

The index builds automatically on first use.

### 4. Try it

Store a memory, then search for it:

```
You: "Remember that we use bcrypt with cost factor 12 for password hashing"

  -> store_memory({
       memory: "Use bcrypt with cost factor 12 for password hashing",
       type: "decision",
       tags: ["security", "bcrypt"]
     })
  -> Stored decision: "Use bcrypt with cost factor 12..."

You: "What did we decide about password hashing?"

  -> search_history({ query: "password hashing decision" })
  -> [HIGH] "Use bcrypt with cost factor 12 for password hashing"
```

### Verify

```bash
strata status
```

```
Strata v1.3.0
Database: ~/.strata/strata.db
Sessions: 142 | Documents: 3847 | Projects: 12
```

---

## Community Tools (9, free)

### Search and Discovery

| Tool | Description |
|------|-------------|
| `search_history` | FTS5 full-text search with BM25 ranking, auto-enhanced with vector search when Gemini is configured. Inline filters: `project:name`, `before:7d`, `after:30d`, `tool:Bash`. |
| `find_solutions` | Solution-biased search -- fix/resolve language scores 1.5x higher. Auto-enhanced with semantic search. |
| `semantic_search` | Hybrid FTS5 + vector cosine similarity via Reciprocal Rank Fusion. Finds results that keyword search misses. Requires `GEMINI_API_KEY`. |
| `list_projects` | All indexed projects with session counts, message counts, and date ranges. |
| `get_session_summary` | Structured session summary: metadata, topic, tools used, conversation flow. |
| `get_project_context` | Comprehensive project context with recent sessions, decisions, and patterns. |
| `find_patterns` | Recurring topics, workflow patterns, and repeated issues across sessions. |

### Memory Management

| Tool | Description |
|------|-------------|
| `store_memory` | Store memories with 9 types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic. |
| `delete_memory` | Hard-delete with audit history preservation. |

---

## How It Works

```
Conversation files  -->  Parsers  -->  SQLite + FTS5 index
                                             |
                                    Knowledge Pipeline
                                    (evaluate -> score -> dedup -> store)
                                             |
                              Decisions / Solutions / Fixes / Patterns
                                             |
                                       9 MCP Tools
                                             |
                                     Your AI Assistant
```

Every extracted knowledge entry passes through three quality gates before storage:

1. **Actionability** -- contains usable patterns (use, avoid, when...then, rate limits, error fixes)
2. **Specificity** -- has 2+ concrete details (numbers, versions, URLs, error codes, API refs)
3. **Relevance** -- about operational/technical topics (not weather, sports, humor)

Entries that fail any gate are rejected. This keeps the knowledge base clean and searchable. See [Evaluator Pipeline](docs/evaluator-pipeline.md) for the full specification with examples.

---

## Deploy on Cloudflare Workers + D1

Strata ships a pluggable storage layer with a Cloudflare D1 adapter. Deploy Strata as a serverless MCP server on Cloudflare's global edge — zero ops, infinite scale, $0 idle cost.

```bash
npm install strata-mcp @modelcontextprotocol/sdk
```

```typescript
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server";
import { createD1Storage } from "strata-mcp/d1";
import { createServer } from "strata-mcp/server";

export default {
  async fetch(request: Request, env: { STRATA_DB: D1Database }): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/strata\/([a-f0-9-]+)\/mcp$/);
    if (!match) return new Response("Not found", { status: 404 });

    const storage = await createD1Storage({ d1: env.STRATA_DB, userId: match[1] });
    const { server } = createServer({ storage });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
```

Full-text search (FTS5) works out of the box. Add a `GEMINI_API_KEY` secret for semantic search with 3072-dim embeddings — same quality as the local SQLite path.

See the full deployment guide at [kytheros.dev/docs/cloudflare-workers-d1](https://kytheros.dev/docs/cloudflare-workers-d1).

### Storage Backends

| Backend | Use Case | Deploy Command |
|---------|----------|----------------|
| **SQLite** (default) | Local CLI, single user | `npm install -g strata-mcp` |
| **D1** | Cloudflare Workers, multi-tenant | `strata deploy cloudflare` |
| **SQLite + Litestream** | GCP Cloud Run, single-user | `strata deploy gcp` |
| **Postgres** | GCP Cloud Run + Cloud SQL, multi-tenant | `strata deploy gcp --multi-tenant` |

All backends support the same MCP tools, full-text search, and semantic search. The storage layer is pluggable via the `StorageContext` interface -- pass it to `createServer({ storage })`.

---

## Deploy on GCP Cloud Run

Deploy Strata to Google Cloud Platform with a single command. Two tiers available:

- **Single-user** -- Cloud Run + Litestream (SQLite backed up to GCS). ~$40-65/mo.
- **Multi-tenant** -- Cloud Run + Cloud SQL (Postgres). ~$90+/mo, scales horizontally.

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud` CLI)
- A GCP project with billing enabled
- Authenticated: `gcloud auth login`

### Single-user deployment

```bash
strata deploy gcp
```

Deploys a Cloud Run service with Litestream continuously replicating your SQLite database to a GCS bucket. Automatic restore on cold start. CPU always-on for background workers.

### Multi-tenant deployment

```bash
strata deploy gcp --multi-tenant
```

Deploys Cloud Run with a managed Cloud SQL (Postgres 17) instance. Row-level tenant isolation, auto-scaling from 1 to 10+ instances, Cloud SQL Auth Proxy for secure connections.

Both modes use the same search pipeline (BM25 full-text + vector cosine similarity via RRF). Add a `GEMINI_API_KEY` secret for semantic search.

---

## Search Intelligence

Every search result is scored through multiple ranking signals, all [empirically optimized](CHANGELOG.md) via AutoResearch:

- **BM25 full-text ranking** via SQLite FTS5 with Porter stemming (`k1=1.2`, `b=0.75`)
- **Vector cosine similarity** via Gemini `gemini-embedding-001` (3072-dim) with code-optimized task types
- **Reciprocal Rank Fusion** (`k=40`) -- merges keyword and vector results for best-of-both retrieval
- **Dual-list bonus** (`0.3x`) -- results appearing in both keyword and vector lists get a score boost
- **Vector similarity tiebreaker** (`0.005`) -- restores magnitude information that RRF rank-based scoring discards
- **Recency boosts** -- last 7 days: 1.1x, last 30 days: 1.05x
- **Project match boost** -- results from the current project: 1.3x
- **Importance scoring** -- composite heuristic across type (0.35), frequency (0.35), language cues (0.20), explicit storage (0.10)
- **Memory decay** -- auto-indexed entries older than 90 days: 0.85x, older than 180 days: 0.7x (explicit memories exempt)
- **Confidence bands** -- results normalized to [0, 1] and bucketed into HIGH/MED/LOW
- **Chunking** -- 1600-token chunks with 50-token overlap for optimal context preservation

Vector search uses `CODE_RETRIEVAL_QUERY` task type for queries and `RETRIEVAL_DOCUMENT` for stored entries, optimizing Gemini's attention for code retrieval patterns.

All ranking parameters are centralized in [`src/config.ts`](src/config.ts) and were validated against frozen eval suites (search retrieval: 30/30, chunking: 25/25, RRF fusion: 58/58).

---

## Local Model Distillation

Fine-tune a private model from your own coding sessions. When `GEMINI_API_KEY` is set, Strata captures (input, output) training pairs from every LLM-powered extraction and summarization. Once you have enough data (~1,000 pairs), export and train a local model that runs entirely offline.

```bash
strata distill status        # Check training data readiness
strata distill export-data   # Export pairs to JSONL
strata distill activate      # Switch to hybrid provider (local model first, Gemini fallback)
strata distill deactivate    # Revert to frontier-only
```

The training pipeline lives in `strata-py`. Install with `pip install strata-memory[distill]` and run `strata-distill start` to fine-tune via QLoRA. See the [distillation spec](specs/strata-local-model-distillation.md) for the full architecture.

---

## Supported AI Tools

| Tool | Data Location |
|------|---------------|
| Claude Code | `~/.claude/projects/` |
| Codex CLI | `~/.codex/sessions/` |
| Aider | `.aider.chat.history.md` (per-project) |
| Cline | VS Code `globalStorage/saoudrizwan.claude-dev/tasks/` |
| Gemini CLI | `~/.gemini/tmp/` |

Run `strata status` to see which tools are detected on your system.

---

## Pro & Team Editions (Coming Soon)

Audit trails, entity intelligence, LLM-powered extraction, local dashboard, and cross-machine sync.

| Feature | Description |
|---------|-------------|
| `memory_history` | Full audit trail of every knowledge mutation (add/update/delete) |
| `update_memory` | Partial updates with change tracking |
| `find_procedures` / `store_procedure` | Step-by-step workflow capture and search |
| `search_entities` | Cross-session entity graph (libraries, services, tools, frameworks) |
| `ingest_conversation` | Push conversations from any agent into the extraction pipeline |
| `cloud_sync_push/pull/status` | Encrypted cross-machine sync |
| `get_analytics` | Local usage analytics -- search patterns, tool usage, trends |
| `list_evidence_gaps` | Knowledge blind spots -- topics searched but never answered |
| Multi-provider extraction | LLM-powered extraction with Anthropic, OpenAI, and Gemini (community gets Gemini with API key; Pro adds provider choice) |
| Local dashboard | Browser-based UI for knowledge exploration, settings, and maintenance |
| Pre-trained base models | Skip months of training data accumulation with Pro-only base models for distillation |

---

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `GEMINI_API_KEY` | Gemini API key for semantic search and embeddings. [Get one free](https://aistudio.google.com/apikey). Also reads from `~/.strata/config.json`. | _(FTS5 only)_ |
| `STRATA_DATA_DIR` | Database directory | `~/.strata/` |
| `STRATA_LICENSE_KEY` | Pro/Team license key | _(free tier)_ |
| `STRATA_DEFAULT_USER` | Default user scope | `default` |
| `STRATA_EXTRA_WATCH_DIRS` | Additional watch directories | _(none)_ |
| `NO_COLOR` | Disable colored CLI output | _(unset)_ |

You can also set the Gemini key in `~/.strata/config.json` instead of an environment variable:

```json
{
  "geminiApiKey": "AIzaSy..."
}
```

---

## CLI

| Command | Description |
|---------|-------------|
| `strata` | Start MCP server on stdio |
| `strata init` | Auto-detect CLIs and set up integration (hooks, skills, config) |
| `strata init --gemini` | Set up Gemini CLI integration only |
| `strata init --claude` | Set up Claude Code integration only |
| `strata serve` | Start HTTP server on port 3000 (or `$PORT`) |
| `strata search <query>` | Search from the terminal |
| `strata store-memory <text> --type <t>` | Store a memory |
| `strata status` | Print index statistics |
| `strata deploy cloudflare` | Deploy to Cloudflare Workers + D1 |
| `strata deploy gcp` | Deploy to GCP Cloud Run (+ Litestream or Cloud SQL) |
| `strata activate <key>` | Activate a Pro license |
| `strata --help` | Full usage |

---

## Requirements

- Node.js >= 18

No other system dependencies. SQLite is bundled via better-sqlite3. For Cloudflare Workers deployment, the D1 adapter has no native dependencies.

---

## Documentation

Full documentation at [kytheros.dev/docs](https://kytheros.dev/docs).

| Document | Description |
|----------|-------------|
| [Cloudflare Workers + D1 Guide](https://kytheros.dev/docs/cloudflare-workers-d1) | Deploy Strata as a serverless MCP server |
| [Architecture](docs/architecture.md) | System design, storage model, retrieval pipeline |
| [Evaluator Pipeline](docs/evaluator-pipeline.md) | Quality gates, accepted/rejected examples, importance scoring |
| [Provenance & Audit](docs/provenance.md) | knowledge_history table, tracing entries to origin |
| [Benchmarks](docs/benchmarks.md) | Retrieval quality metrics and methodology |
| [Claude Code Integration](docs/integration/claude-code.md) | Setup, tools, workflows |
| [MCP Client Integration](docs/integration/mcp-client.md) | stdio and HTTP transport, SDK examples |
| [Hooks and Skills](docs/HOOKS-AND-SKILLS.md) | Hook setup, skill definitions, agent integration |
| [Multi-Tool Support](docs/MULTI-TOOL.md) | Claude Code, Codex, Aider, Cline, Gemini CLI |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, config constants |
| [Deployment](docs/DEPLOYMENT.md) | stdio, HTTP, Docker, Cloud Run |

---

## License

MIT
