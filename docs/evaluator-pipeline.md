# Evaluator Pipeline

The evaluator pipeline is Strata's primary differentiator: a deterministic, rule-based quality gate that evaluates every knowledge entry before it enters the store. While every competitor in the agent memory space stores first and ranks later, Strata evaluates before storage -- ensuring the knowledge base stays clean, actionable, and auditable.

**Source:** `src/knowledge/knowledge-evaluator.ts`, `src/knowledge/importance.ts`, `src/knowledge/conflict-resolver.ts`

---

## How It Works

The `KnowledgeEvaluator` class checks three criteria in sequence. If any check fails, the entry is rejected and never stored. Each evaluation targets less than 50ms of latency.

```
Candidate knowledge entry
      |
      v
1. Actionability check    Does it contain usable patterns?
      | pass
      v
2. Specificity check      Does it have concrete details?
      | pass
      v
3. Relevance check        Is it about operational/technical topics?
      | pass
      v
ACCEPTED                  Entry proceeds to dedup + conflict resolution + storage
```

A rejected entry receives an outcome of `"rejected"` with a reason string explaining which gate it failed and why. An accepted entry receives `"accepted"` with the reason `"Passes actionability, specificity, and relevance checks"`.

---

## Gate 1: Actionability

**Question:** Does this content contain concrete, usable patterns that a developer could act on?

The actionability check tests the content against a set of regex patterns looking for:

- **Action verbs:** use, avoid, prefer, always, never, must, should, ensure, set, configure, enable, disable, add, remove, check, verify, implement, call, pass, include, exclude, specify, require
- **Conditional patterns:** "when...then", "if...then/use/set/avoid"
- **Comparison language:** "instead of", "rather than"
- **Operational terms:** rate limit, timeout, retry, backoff, threshold, maximum, minimum
- **Technical references:** endpoint, url, header, parameter, flag, option, argument
- **Error-fix patterns:** "error/exception/failure...fix/resolve/workaround/handle"

An entry passes if **any one** of these patterns matches.

### Examples that PASS actionability

1. "Always use `--legacy-peer-deps` when installing packages in the monorepo to avoid peer dependency conflicts"
2. "Set the Redis connection timeout to 5000ms to prevent hanging connections during peak load"
3. "When deploying to Cloud Run, ensure the PORT environment variable is set to 8080"
4. "Avoid using `fs.writeFileSync` in the hot path -- use the async version instead to prevent blocking the event loop"
5. "Use `better-sqlite3` instead of `sql.js` for production -- the WASM-based sql.js has a 10x performance penalty on large datasets"
6. "The Stripe webhook endpoint must include signature verification using the `STRIPE_WEBHOOK_SECRET` header"

### Examples that FAIL actionability

1. "The codebase is well-organized" -- no actionable pattern, just an observation
2. "We discussed the architecture" -- descriptive, not prescriptive
3. "TypeScript is a popular language" -- general statement, not a directive
4. "The meeting went well" -- status update with no operational content
5. "I looked at the code for a while" -- activity log, not knowledge

---

## Gate 2: Specificity

**Question:** Does this content contain concrete, specific details rather than vague generalities?

The specificity check counts how many of the following signal patterns are present in the content:

| Signal | Pattern | Example |
|--------|---------|---------|
| Numbers | `/\d+/` | "retry 3 times", "port 5432" |
| Version strings | `/v\d+(\.\d+)*/i` | "v2.1.0", "v18" |
| URLs/endpoints | `/\b(http\|https\|ftp):\/\//i` | "https://api.stripe.com/v1/" |
| HTTP/error codes | `/\b\d{3}\b/` | "returns 429", "error 500" |
| API references | `/\b(api\|endpoint\|url\|path\|route)\b/i` | "the /users endpoint" |
| Constants | `/\b[A-Z_]{2,}[_-][A-Z_]{2,}\b/` | "MAX_RETRIES", "NODE_ENV" |
| Backtick-quoted values | `/`[^`]+`/` | "`--force`", "`strict` mode" |
| Units | `/\b(ms\|seconds?\|minutes?\|hours?\|req\/s\|mb\|gb\|kb)\b/i` | "500ms timeout", "10 req/s" |
| Technical terms | `/\b(port\|header\|token\|key\|flag\|param)\b/i` | "auth token", "API key" |

An entry passes if **at least 2** of these signals are present.

### Examples that PASS specificity

1. "Set `MAX_RETRIES` to 3 with a 500ms backoff delay" -- has constant, number, and unit
2. "The endpoint https://api.example.com/v2/users returns 429 when exceeding 100 req/s" -- has URL, version, code, number, unit
3. "Configure port 3000 and set the `AUTH_TOKEN` header for API authentication" -- has number, constant, technical terms
4. "Use `--legacy-peer-deps` flag with npm v7+ to resolve peer conflicts" -- has backtick-quoted value, version
5. "The Redis key `session:{userId}` expires after 3600 seconds" -- has backtick-quoted value, number, unit

### Examples that FAIL specificity

1. "Use a caching layer for better performance" -- no concrete signals (no numbers, no specific tools)
2. "Always validate inputs" -- only one signal (action verb from gate 1, but no specificity signals)
3. "Configure the server properly" -- vague, no concrete details
4. "Make sure to handle errors" -- no specific error codes, no concrete patterns
5. "Use environment variables for secrets" -- close, but "variables" and "secrets" do not match the technical term patterns (port, header, token, key, flag, param)

---

## Gate 3: Relevance

**Question:** Is this content about operational or technical topics (not casual conversation)?

The relevance check tests whether the content matches any irrelevance patterns:

- **Casual opinion openers:** "the weather", "today is", "I think", "in my opinion", "personally"
- **Non-technical topics:** politics, sports, entertainment, gossip, celebrity
- **Humor:** joke, funny, humor, lol, haha

An entry passes if **none** of these patterns match. This is a negative filter -- it rejects content rather than requiring content.

### Examples that PASS relevance

All technical/operational content passes this gate by default, as long as it does not contain the irrelevance markers. The gate is deliberately permissive to avoid false negatives on legitimate knowledge.

### Examples that FAIL relevance

1. "I think the weather today is nice" -- matches "the weather" and "I think"
2. "That was a funny joke about deployment" -- matches "funny" and "joke"
3. "Personally, I prefer watching sports on the weekend" -- matches "personally", "sports"
4. "In my opinion, the celebrity drama is overblown" -- matches "in my opinion", "celebrity"
5. "Lol, that bug was hilarious" -- matches "lol"

---

## Combined Gate Examples

These examples show the complete evaluation path through all three gates:

### ACCEPTED (passes all three gates)

1. **"Use `bcrypt` with cost factor 12 for password hashing -- argon2 had deployment issues on Alpine Linux"**
   - Actionability: "use" verb, "instead of" implicit comparison
   - Specificity: backtick-quoted `bcrypt`, number (12), technical context
   - Relevance: technical content, no irrelevance markers

2. **"When the PostgreSQL connection pool exceeds 20 connections, set `idle_timeout` to 30 seconds to prevent connection exhaustion"**
   - Actionability: "when...set" conditional, "set" verb
   - Specificity: number (20, 30), backtick-quoted value, unit (seconds), technical term
   - Relevance: technical content

3. **"Always configure CORS to allow only https://app.example.com -- the wildcard `*` origin caused a security audit failure"**
   - Actionability: "always", "configure" verb
   - Specificity: URL, backtick-quoted value, number implicit in audit reference
   - Relevance: technical content

4. **"The `/api/v2/webhooks` endpoint returns 401 if the `X-Signature` header is missing -- check the Stripe docs for HMAC verification"**
   - Actionability: "check" verb, error-fix pattern
   - Specificity: API path, version, HTTP code (401), backtick-quoted header
   - Relevance: technical content

5. **"Set `NODE_OPTIONS='--max-old-space-size=4096'` when building -- the default 2048 MB heap causes OOM on large TypeScript projects"**
   - Actionability: "set" verb, "when" conditional
   - Specificity: constant, backtick-quoted value, numbers (4096, 2048), unit (MB)
   - Relevance: technical content

---

## Importance Scoring

After evaluation and acceptance, each knowledge entry receives a composite importance score in [0, 1]. This score is computed once at write time and stored in the `importance` column. During search, it produces a multiplicative boost: `score *= (1.0 + importance * 0.5)`.

**Source:** `src/knowledge/importance.ts`

### Formula

```
importance = 0.35 * type_score
           + 0.20 * language_score
           + 0.35 * frequency_score
           + 0.10 * explicit_score
```

### Signal 1: Type Score (35% weight)

Each knowledge type has a fixed importance value:

| Type | Score | Rationale |
|------|-------|-----------|
| `decision` | 1.0 | Architectural decisions have the highest long-term value |
| `learning` | 0.9 | Synthesized cross-session patterns are highly valuable |
| `error_fix` | 0.85 | Error fixes save significant debugging time |
| `pattern` | 0.8 | Recurring patterns inform future work |
| `procedure` | 0.75 | Step-by-step workflows are reusable |
| `preference` | 0.7 | User preferences should be respected consistently |
| `fact` | 0.6 | Facts are useful but may become stale |
| `solution` | 0.5 | Solutions are contextual and may not generalize |
| `episodic` | 0.3 | Episodic notes have limited long-term value |

For raw document chunks without an explicit knowledge type, importance is inferred from message role and content.

### Signal 2: Language Markers (20% weight)

Regex-detected phrases that predict importance. Only the max-scoring match is used. If no patterns match, the default is 0.3 (neutral).

| Score | Markers |
|-------|---------|
| 1.0 | "decided to", "going with", "we chose", "switched to", "from now on" |
| 0.9 | "instead of", "rather than", "not using", "rejected" |
| 0.85 | "this caused", "this broke", "the issue was", "root cause" |
| 0.8 | "always", "never", "going forward", "permanently" |
| 0.75 | "I prefer", "please always", "don't ever", "make sure to" |
| 0.5 | "implemented", "deployed", "shipped", "released" |
| 0.1 | "working on", "looking at", "let me check" |

### Signal 3: Frequency (35% weight)

Cross-session occurrence count and project spread, used for learning entries produced by the synthesis pipeline:

```
frequency_score = min(1.0, (occurrences / 5) * 0.6 + (projectCount / 3) * 0.4)
```

For entries without occurrence data, this signal is 0.0.

### Signal 4: Explicit Storage (10% weight)

Score is 1.0 when the entry was stored via `store_memory` (identified by `sessionId === "explicit-memory"`), 0.0 otherwise. This ensures that user-intentional memories receive a modest boost over auto-extracted ones.

### Boost Application

In the search ranker (`src/search/result-ranker.ts`):

```typescript
score *= (1.0 + importance * CONFIG.importance.boostMax)
```

With the default `boostMax = 0.5`, the effective multiplier range is [1.0, 1.5]. Setting `boostMax = 0` disables importance-based boosting entirely.

---

## Conflict Resolution and Deduplication

After evaluation passes and importance is scored, the entry goes through two deduplication layers before storage.

### Layer 1: Exact Dedup

The `SqliteKnowledgeStore.addEntry()` method (`src/storage/sqlite-knowledge-store.ts`) checks for exact matches on `project + type + summary + user`. If a match exists, the entry is silently skipped.

### Layer 2: Semantic Conflict Resolution (requires LLM provider)

When an LLM provider is available (Pro feature), the `ConflictResolver` (`src/knowledge/conflict-resolver.ts`) performs semantic deduplication:

1. **Search** for up to 5 similar existing entries using `store.search(candidate.summary)`
2. **Build a classification prompt** with the candidate and similar entries (text truncated to 300 chars each)
3. **Send to LLM** with low temperature (0.1) and 256-token limit for deterministic classification
4. **Parse the JSON response** into actions for each similar entry:
   - `delete`: existing entry is superseded or contradicted by the new one
   - `update`: existing entry should be merged with new information (mergedSummary required)
   - `noop`: existing entry is compatible, no change needed
   - `shouldAdd: false`: new entry is a trivial duplicate (no new information)
5. **Execute mutations** in order: deletes first, then updates, then add

Safety mechanisms:
- **Killswitch:** `STRATA_CONFLICT_RESOLUTION=0` env var disables the feature entirely
- **Graceful fallback:** If no LLM provider is available, no similar entries exist, or the LLM call fails, the system falls back to direct `addEntry()` with exact dedup only
- **Input sanitization:** Entry text is truncated to 300 characters to prevent prompt bloat and injection

---

## Further Reading

- [Architecture Overview](architecture.md) -- system design, storage model, retrieval pipeline
- [Provenance & Audit](provenance.md) -- how mutations are tracked in knowledge_history
