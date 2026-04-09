# Local Inference Quality Eval

Frozen eval suite for comparing local (Gemma 4) and frontier (Gemini 2.5 Flash)
LLM providers across the three ingest pipeline stages.

## Frozen rules (Karpathy AutoResearch convention)

- Eval script and fixture set are **frozen** once committed.
- No modifying fixtures during model selection.
- All comparisons go through `run-eval.ts` for reproducibility.
- Adding a fixture is allowed; removing or changing existing fixtures is not.

## Stages

| Stage | Fixture count | Metric | Pass threshold |
|-------|--------------|--------|----------------|
| Extraction | 30 | Keyword recall against expected_keywords | >= 0.85 * Gemini score |
| Summarization | 30 | Keyword recall against expected_topic_keywords | >= 0.80 * Gemini score |
| Conflict resolution | 30 | Action-type accuracy (add/delete/update) | >= 0.90 * Gemini score |

Pass thresholds are **relative to the Gemini baseline** run on the same
fixtures. Local model ships as default only if all three stages clear.

## Fixture format

Each fixture is a self-contained JSON object. No external dependencies.
Expectations are structural (keyword recall, action-type classification),
never byte-exact — this keeps fixtures maintainable across provider
response-style differences.

### extraction-cases.json

```
[
  {
    "id": "ext-001",
    "session": { /* ParsedSession-compatible minimal fragment */ },
    "expected_keywords": ["camping", "weekend"],
    "min_entries": 1
  }
]
```

Pass criteria per case: parsed output has `>= min_entries`, and at least
one entry's `summary + details` contains any one of the `expected_keywords`
(case-insensitive).

### summarization-cases.json

```
[
  {
    "id": "sum-001",
    "session": { /* ParsedSession-compatible minimal fragment */ },
    "expected_topic_keywords": ["react", "hook"]
  }
]
```

Pass criteria per case: parsed `topic` string contains at least one of the
`expected_topic_keywords` (case-insensitive).

### conflict-cases.json

```
[
  {
    "id": "conf-001",
    "candidate": { /* KnowledgeEntry */ },
    "similar": [ /* array of existing KnowledgeEntry */ ],
    "expected_action": "add" | "delete" | "update" | "noop"
  }
]
```

Pass criteria per case: the parsed resolution's top action matches
`expected_action`. `"add"` means `shouldAdd === true && actions is empty`.

## Running the eval

```
cd strata
npm run eval:local-inference -- --provider gemini
npm run eval:local-inference -- --provider gemma4
npm run eval:local-inference -- --provider both  # side-by-side table
```

See `run-eval.ts` for implementation.
