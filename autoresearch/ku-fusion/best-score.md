# Best score — autoresearch-ku-fusion

| Mode | Accuracy | Date | Notes |
|---|---|---|---|
| **off (canonical baseline)** | **61/78 = 78.21%** | 2026-05-26 | Day-of measured baseline. Spec-projected 84.62% from the 2026-03-27 frozen 500Q run was 6.41pp higher — drift attributed to Gemini-2.5-flash version + corpus state. |
| off (variance probe) | 63/78 = 80.77% | 2026-05-26 | Earlier same-day exploratory run; 2.56pp variance between identical runs confirms Gemini stochasticity. |
| append (M1) | _pending_ | _pending_ | Append unique turn-lane sessions, up to `maxAppend=5` |
| rrf (M2) | _pending_ | _pending_ | RRF fusion (k=60), wider-net chunk lane (limit=100) |

## Ship gate

A variant ships only if it beats the canonical 2026-05-26 baseline by **≥ +3pp absolute**:
- M1/M2 must hit ≥ **64/78 = 82.05%** (78.21 + 3 = 81.21%; rounded up to next achievable integer count)

If neither variant clears the gate, the feature stays default-off and the work converts to a regression check for the existing chunk-lane path.
