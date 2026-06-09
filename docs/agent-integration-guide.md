# Building an Agent on Strata — Recommended Pipeline

> **STATUS: validated.** Numbers below are from the N≥3 LongMemEval-S canary (2026-06-09):
> **~81% task-averaged (range 80.6–81.3), recall@20 95.2%.** `retrieval_strategy:"deep"` is
> reachable via the MCP `search_history` enum (shipping in the same PR as this doc).

This guide shows the **recommended read pipeline** for building an agent that answers
questions from a user's Strata memory. Follow it and you reproduce Strata's benchmarked
retrieval quality.

The division of labor:

- **Strata owns retrieval + assembly** — finding the right memories and formatting them
  for a language model.
- **Your agent owns the answer** — you call your own LLM with the assembled context and
  the recommended prompt.

Strata is a memory layer, not a QA system. It does not make the LLM call for you.

---

## The recipe

```
1. search_history(query, format:"agent", retrieval_strategy:"deep")   ← Strata
2. fill the recommended prompt with that context                       ← Strata (template)
3. call YOUR model with the prompt                                     ← you
```

### 1. Retrieve with the deep pipeline

Call `search_history` with two options:

| Option | Value | Why |
|---|---|---|
| `retrieval_strategy` | `"deep"` | Session-scoring retrieval (candidate pool 60 / sessionK 20) + cross-encoder reranker + dense turn-lane fusion. This is the configuration that produces the benchmarked number. |
| `format` | `"agent"` | Emits a clean, **chronologically ordered**, dated, deduplicated notes block — the assembly that lets the model reason about recency and ordering. |
| `max_chars` | `10000` | **Set this — do not use the default (2500).** The deep pipeline returns full session text; the default truncates each note and costs ~4pp of accuracy (~80.8 → ~76.7 on LongMemEval-S). 10000 is the maximum. |

The reranker is **load-bearing** — it provides the precision ordering the answer model
relies on. (Disabling it to chase higher raw recall measurably *lowers* answer accuracy.)

### 2. Fill the recommended prompt

Strata ships the recommended prompt as an exported constant so the docs, SDK, and your
agent share one source of truth:

```ts
import { buildRecommendedPrompt } from "strata-mcp/prompts/recommended-agent-prompt";

const { system, user } = buildRecommendedPrompt(agentContext, currentDate, question);
```

It is a single **unified, type-label-free** prompt (a production agent has no
question-type label), folding in recency, counting, temporal, and preference disciplines.

### 3. Call your model

```ts
const answer = await yourModel.chat({
  system,
  user,
  temperature: 0,
});
```

That's the whole pipeline. Use any model you like — the retrieval quality is Strata's;
the answer quality scales with the model you bring.

---

## Reference harness (copy-paste)

```ts
// Pseudocode — adapt to your MCP client / SDK.
import { buildRecommendedPrompt } from "strata-mcp/prompts/recommended-agent-prompt";

async function answerFromMemory(question: string, today: string) {
  const ctx = await mcp.call("search_history", {
    query: question,
    format: "agent",
    retrieval_strategy: "deep",
    limit: 20,
    max_chars: 10000, // required — the default (2500) truncates session text, ~-4pp
  });
  const { system, user } = buildRecommendedPrompt(ctx, today, question);
  return yourModel.chat({ system, user, temperature: 0 });
}
```

---

## Published numbers

Strata publishes **two** numbers, and is explicit about what each means:

| Number | What it measures | Value |
|---|---|---|
| **Recall@k** (model-independent) | Fraction of LongMemEval-S questions where a gold answer-evidence session appears in the `format:"agent"` block at k=20. This is what Strata's retrieval guarantees. | **95.2%** (k=20) |
| **End-to-end (illustrative)** | `format:"agent"` + `retrieval_strategy:"deep"` + the recommended prompt + a reference model (Gemini 2.5 Flash), LongMemEval-S task-averaged. Depends on the answer model you bring. | **~81%** (80.6–81.3, N=3, label-free) |

> **Recall@k is a diagnostic, not a quality guarantee in isolation.** Higher recall does
> not always mean better answers — over-retrieving floods the answer model and *lowers*
> accuracy. The end-to-end number with a named model is the figure to compare against.

### About the "84.4%" benchmark figure

Our internal LongMemEval benchmark scores higher (~84–85%), but that configuration reads
the dataset's **gold question-type label** to switch ranking and prompting per question —
information a production agent does not have. The numbers above are the **honest,
label-free, reproducible** figures. Closing part of that gap in production would require a
question-type classifier (tracked as a roadmap item), and even then lands *under* the
benchmark figure. We publish the number you can actually reproduce.

### Reproduce it yourself

```bash
# Dataset: LongMemEval-S (500 questions). Reference harness lives in this repo.
# Answer model is swappable — point LONGMEMEVAL_ANSWER_MODEL at your own model.
LONGMEMEVAL_ANSWER_MODEL=vertex:gemini-2.5-flash \
  npx tsx benchmarks/longmemeval/prod-consumer-parity.ts \
  --arm=prod-consumer --agent-format --deep --max-chars=10000 --judge-votes=3 --run-id=repro

# N=3 result (Gemini 2.5 Flash answerer, GPT-4o judge, judge-votes=3):
#   task-avg 80.6 / 81.3 / 81.2  (mean ~81%, range 80.6–81.3) · recall@20 95.2%
```

---

## Backend coverage

The recommended deep pipeline is **validated on local SQLite (Node) today.** Other
backends are on the roadmap:

| Backend | Status | Notes |
|---|---|---|
| **SQLite** (local, Node) | ✅ **Validated** | Full deep path: session-scoring + ONNX reranker + dense turns, with auto-indexing. The reference number is measured here. |
| **Postgres** (Node, Cloud SQL / Cloud Run) | 🔶 Roadmap | Same compute runs (Node), but there is no conversation-ingest path yet, so the stores are empty. Gated on the ingest API. |
| **Cloudflare D1** (workerd) | 🔶 Roadmap | workerd can't load the native ONNX reranker; an *equivalent* pipeline is buildable on Cloudflare-native primitives (Workers AI `bge-reranker-base` + Vectorize) as a separate path with its **own** validated number. |

The `format:"agent"` assembly itself is pure formatting and runs on any backend; the gap
is the retrieval engine (session-scoring + reranker + dense turns) and the data path.
