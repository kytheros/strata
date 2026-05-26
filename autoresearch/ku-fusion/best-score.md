# Best score — autoresearch-ku-fusion

| Mode | Accuracy | Date | Notes |
|---|---|---|---|
| off (canonical baseline) | 61/78 = 78.21% | 2026-05-26 | Day-of measured baseline. Ship-gate floor. |
| off (variance probe) | 63/78 = 80.77% | 2026-05-26 | Same-day baseline run; ±2.5pp Gemini variance band. |
| append (M1) | 63/78 = 80.77% | 2026-05-26 | +2.56pp; **inside noise floor — DO NOT SHIP**. |
| **rrf (M2) ★ SHIP** | **67/78 = 85.90%** | **2026-05-26** | **+7.69pp over canonical, +5.13pp over variance probe — clears the +3pp gate by a comfortable margin.** |

## Verdict — SHIP M2 (rrf)

`STRATA_KU_FUSION_MODE=rrf` is the validated improvement path for KU-heavy workloads. Default config stays `mode: "off"` per the design's invariant. Flipping the default ships in a future release after broader validation across non-KU question types (current eval scope is KU-only by design).

## Ship gate (locked at)

A variant ships only if it beats the canonical 2026-05-26 baseline (78.21%) by **≥ +3pp absolute** (= ≥ 64/78 = 82.05%). M2 cleared with **67/78 = 85.90%**.
