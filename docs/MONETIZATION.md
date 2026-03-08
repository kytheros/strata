# Strata Monetization Plan

## Brand Architecture

- **Product**: Strata
- **Company**: Kytheros LLC
- **Domain**: strata.kytheros.dev (future: kytheros.ai)
- **GitHub**: kytheros/strata
- **npm**: strata-mcp
- **Model**: Open core (Vercel/Next.js pattern)

## Tiers

| Tier | Price | Target |
|------|-------|--------|
| **Community** | Free forever | Individual developers |
| **Pro** | $9/mo or $90/yr | Power users, multi-machine |
| **Team** | $19/user/mo | Engineering teams |
| **Enterprise** | Custom | Large orgs (SSO, compliance) |

## Feature Matrix

### Community (Free) — 8 MCP Tools

| Tool | Category | Description |
|------|----------|-------------|
| `search_history` | Search | FTS5 full-text search with BM25 ranking, inline filter syntax (project, date, tool) |
| `find_solutions` | Search | Solution-biased search (1.5x boost for fix/resolve language) |
| `list_projects` | Discovery | List all projects with session counts, message counts, date ranges |
| `get_session_summary` | Read | Structured session summary — metadata, topic, tools, conversation flow |
| `get_project_context` | Read | Comprehensive project context — recent sessions, key topics, patterns |
| `find_patterns` | Analysis | Discover recurring topics, workflow patterns, repeated issues |
| `store_memory` | Memory CRUD | Explicitly store memories (9 types: decision, solution, error_fix, pattern, learning, procedure, fact, preference, episodic) |
| `delete_memory` | Memory CRUD | Hard-delete with audit history preservation |

### Community — Core Capabilities

| Capability | Description |
|------------|-------------|
| **3 AI tool parsers** | Claude Code, Cline, Codex |
| **Knowledge extraction** | Heuristic KnowledgeEvaluator with configurable scoring — decisions, solutions, error fixes, patterns, learnings |
| **Conflict resolution** | Detects contradictory facts and resolves by recency (newest wins) |
| **Deduplication** | Trigram Jaccard similarity (>0.90 threshold) prevents duplicate entries |
| **Secret sanitization** | Automatic redaction of API keys, tokens, passwords, and secrets before indexing |
| **Session summarization** | Automatic structured summaries with topics, tools, and conversation flow |
| **TOON token optimization** | Compact response format saves 30-60% tokens for LLM consumers (`format: "concise"`) |
| **3-tier response format** | `concise` (TOON), `standard` (structured text), `detailed` (full JSON for programmatic consumers) |
| **Field-level verbosity** | Per-entity-type field configs control which fields appear at each format level |
| **Inline filter syntax** | `project:name`, `before:7d`, `after:30d`, `tool:Bash` in search queries |
| **SQLite FTS5 search** | Full-text search with BM25 ranking, recency boosts, project match boosts |
| **LRU caching** | Search result and history parse caching with configurable TTL |
| **Realtime watcher** | File-system watcher for live session knowledge extraction |
| **Incremental indexer** | Multi-tool file watcher with debounced knowledge pipeline |
| **Dual transport** | stdio (default for Claude Code) and HTTP/SSE (`strata-mcp serve`) |
| **CLI commands** | `search`, `status`, `migrate`, `activate`, `license` |

### Pro (Licensed) — Additional Tools & Capabilities

**Upgraded from Community (6 tools):**

| Tool | Gate | Description |
|------|------|-------------|
| `update_memory` | `pro` | Partial update of existing memories with full audit trail |
| `memory_history` | `pro` | View mutation audit trail (add, update, delete) for any entry |
| `store_procedure` | `pro` | Store step-by-step workflows with prerequisites and warnings; auto-merges on re-store |
| `find_procedures` | `pro` | Search stored procedures and workflows |
| `search_entities` | `pro` | Query cross-session entity graph (libraries, services, tools, languages, frameworks) |
| `ingest_conversation` | `pro` | Push conversations from any agent into the full extraction pipeline |

**Pro-exclusive tools (5 tools):**

| Tool | Gate | Description |
|------|------|-------------|
| `semantic_search` | `vector_search` | Hybrid FTS5 + vector cosine similarity via Reciprocal Rank Fusion (RRF) |
| `cloud_sync_status` | `cloud_sync` | Check cloud sync configuration and connection health |
| `cloud_sync_push` | `cloud_sync` | Incremental push of local knowledge and sessions to cloud |
| `cloud_sync_pull` | `cloud_sync` | Pull and merge cloud data with local store (dedup on pull) |
| `get_analytics` | `analytics` | Local usage analytics — search patterns, tool usage, activity trends |

**Pro-exclusive capabilities:**

| Feature | Gate | Description |
|---------|------|-------------|
| **2 additional parsers** | `pro` | Aider, Gemini CLI (Community has Claude Code, Cline, Codex) |
| **Confidence scoring** | `pro` | Per-result confidence (0.0-1.0) normalized against top result; high/medium/low bands |
| **Memory decay** | `pro` | Retrieval-time score penalty for stale entries (>90d: 0.85x, >180d: 0.7x); explicit memories exempt |
| **Entity extraction** | `pro` | Named entity recognition — libraries, services, tools, languages, frameworks, people, concepts, files |
| **Procedure extraction** | `pro` | Automatic extraction of step-by-step workflows from conversations |
| **Learning synthesizer** | `pro` | Clusters related knowledge entries, promotes high-score patterns to learnings |
| **Vector embeddings** | `vector_search` | Gemini embedding provider, vector store, embedding generation via `strata-mcp embed` CLI |
| **LLM-powered extraction** | `llm_extraction` | Smart summarizer, enhanced extractor using Gemini LLM for deeper knowledge extraction |
| **Cloud sync engine** | `cloud_sync` | Supabase Edge Functions backend, incremental sync with conflict resolution |
| **Python SDK** | `pro` | Python client library for agent builders (Coming Soon) |

### Team (Licensed) — Additional Capabilities

| Feature | Gate | Description |
|---------|------|-------------|
| **Shared knowledge base** | `team_knowledge` | Cross-developer knowledge sharing, team-wide search |
| **Team sync** | `team_sync` | Bi-directional team knowledge synchronization |
| **Access control** | `access_control` | Role-based permissions (admin, member, viewer), project-level and entry-level access |

### Enterprise — Additional Capabilities

| Feature | Description |
|---------|-------------|
| **SSO / SAML** | Enterprise identity provider integration |
| **HIPAA / SOC2 compliance** | Compliance-ready deployment |
| **On-prem deployment** | Self-hosted option |
| **Priority support** | Dedicated support channel |

## Code Separation

### Pattern: Single Repo + `/ee` Directory (PostHog/Cal.com model)

```
src/
  # --- Free (MIT License) ---
  server.ts, cli.ts, index.ts, config.ts
  indexing/          # SQLite index manager, FTS5
  knowledge/         # KnowledgeEvaluator, basic extractors, dedup, conflict resolution
  parsers/           # Claude Code, Cline, Codex (3 free parsers)
  search/            # BM25 search engine, query processor, result ranker
  storage/           # SQLite document store, knowledge store
  tools/             # 8 free MCP tools
  hooks/             # Session lifecycle
  sanitizer/         # Secret redaction
  watcher/           # Realtime watcher, file watcher, incremental indexer
  transports/        # HTTP/SSE transport (stdio is built-in)
  utils/             # TOON, response formatting, compact serializer, field config, cache

  # --- Paid (Strata Commercial License) ---
  ee/
    LICENSE           # Strata Commercial License
    license-validator.ts   # JWT verification (offline, RSA)
    feature-gate.ts        # hasFeature() / requireFeature() checks

    parsers/               # Pro: additional parsers
      aider-parser.ts      #   Aider
      gemini-parser.ts     #   Gemini CLI

    search-intelligence/   # Pro: smart ranking
      confidence-scorer.ts
      memory-decay.ts

    entity-extraction/     # Pro: entity graph
      entity-extractor.ts
      entity-store.ts

    procedure-extraction/  # Pro: procedures
      procedure-extractor.ts

    learning-synthesis/    # Pro: learning synthesizer
      learning-synthesizer.ts

    tools/                 # Pro: 6 upgraded tools
      update-memory.ts
      memory-history.ts
      store-procedure.ts
      find-procedures.ts
      search-entities.ts
      ingest-conversation.ts

    vector-search/         # Pro: vector_search
      embedding-provider.ts
      vector-store.ts
      hybrid-search.ts

    embeddings/            # Pro: vector_search
      gemini-embedder.ts
      vector-search.ts

    llm-extraction/        # Pro: llm_extraction
      llm-provider.ts
      gemini-provider.ts
      config.ts
      smart-summarizer.ts
      enhanced-extractor.ts

    cloud-sync/            # Pro: cloud_sync
      cloud-client.ts
      sync-state.ts

    analytics/             # Pro: analytics
      query-analytics.ts
      usage-tracker.ts

    tools/                 # Pro MCP tools
      get-analytics.ts

    team/                  # Team tier
      shared-knowledge.ts  # team_knowledge
      team-sync.ts         # team_sync
      access-control.ts    # access_control
```

### License Files

- `LICENSE` (root) — MIT, covers everything outside `src/extensions/`
- `src/extensions/LICENSE` — Strata Commercial License:
  - Source available for reference
  - Production use requires valid license
  - Free for non-commercial/personal use

## License Enforcement

### Cryptographic License Keys (Offline)

License key = signed JWT containing:
```json
{
  "tier": "pro",
  "features": ["cloud_sync", "vector_search", "llm_extraction", "analytics"],
  "email": "user@example.com",
  "exp": 1772600000,
  "iss": "kytheros.dev"
}
```

Validation:
1. RSA public key embedded in `license-validator.ts`
2. JWT signature verified locally — no network call
3. Features checked via `hasFeature("cloud_sync")` / `requireFeature("team_knowledge")`
4. Pro tools only registered in MCP server if license valid
5. Works fully offline / air-gapped

### User Activation

```bash
# Option A: CLI command
strata-mcp activate eyJhbGciOiJS...
# Writes to ~/.strata/license.key

# Option B: Environment variable
STRATA_LICENSE_KEY=eyJhbGciOiJS...

# Option C: MCP config
{ "env": { "STRATA_LICENSE_KEY": "eyJhbGciOiJS..." } }
```

## Payment Infrastructure

### Stack

| Component | Provider | Cost |
|-----------|----------|------|
| Payments + MoR | Polar.sh | ~5% |
| License key signing | Supabase Edge Functions | Free tier |
| Website | strata.kytheros.dev (static) | ~$0 |
| Key storage | Supabase (Postgres) | Free tier |

### Flow

1. User visits `strata.kytheros.dev/pricing`
2. Clicks "Upgrade to Pro" → Polar.sh checkout
3. Polar.sh handles payment, tax, VAT, invoicing
4. Webhook → Supabase Edge Function generates signed JWT
5. User copies license key from dashboard
6. `strata-mcp activate <key>` — validated offline forever

### Why Polar.sh

- Merchant of Record (handles global tax/VAT)
- Built-in license key management
- Developer-native (17K+ developers)
- Open source itself
- Built-in customer dashboard
- Webhook API for custom license generation

## Competitive Pricing Context

| Competitor | Free Tier | Paid |
|-----------|-----------|------|
| Mem0 | 10K memories | $19-249/mo (hosting) |
| Recall | 500 memories | $5-15/mo |
| Pieces | Individual free | Teams (contact sales) |
| **Strata** | **Unlimited local, 8 tools** | **$9/mo Pro (19 tools), $19/user Team** |

Strata's free tier covers core search and memory (unlimited local, no memory caps, 8 MCP tools, 3 AI tool parsers). Pro unlocks the full 19-tool suite with entity graph, procedures, ingest API, confidence scoring, cloud sync, vector search, and Python SDK — cheaper than Mem0 with genuinely differentiated capabilities.

## Launch Strategy

### Phase 1: Community Launch (current)
- Ship free v1.0 to npm and GitHub
- 8 free tools, 3 AI tool parsers, core search and memory
- Target: 1,000 stars in first week
- Channels: Show HN → Reddit → Dev.to → Product Hunt

### Phase 2: Pro Launch
- Ship vector search, LLM extraction, cloud sync, analytics
- Set up Polar.sh store + Supabase license infrastructure
- Target: First 100 paying customers

### Phase 3: Team Launch
- Ship shared knowledge, team sync, access control
- Target: 10 paying teams

## Kytheros Synergy

- Strata = open-source gateway to Kytheros ecosystem
- Shared cloud backend (auth, sync, billing)
- Kytheros platform can use Strata as memory layer
- Cross-promotion: Strata README → Kytheros, Kytheros onboarding → Strata
- Both products under Kytheros LLC entity
