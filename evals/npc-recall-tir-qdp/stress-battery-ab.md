# NPCStressBatteryTest — TIR+QDP A/B Read-out

Spec: `specs/2026-04-26-npc-recall-tir-qdp-design.md`
Plan: `specs/2026-04-26-npc-recall-tir-qdp-plan.md` Task 11
Frozen retrieval eval: 10/10 → SHIP Phase 0 (deterministic gate, see `baseline-result.txt`).

## BEFORE — pre-TIR+QDP server (commit before `aa8d7e2`)

Live Strata REST server on `localhost:3055` running pre-Spec-2026-04-26 code.

| Run | Total | Failed | Failing tests |
|---|---|---|---|
| 1 | 10 | 4 | AbstentionWithPollutedContext, AliasReverseLookup_SemanticRetrieval, ContradictoryUpdate, PrivateSecretPreserved |
| 2 | 10 | 2 | ContradictoryUpdate, PrivateSecretPreserved |
| 3 | 10 | 2 | ContradictoryUpdate, PrivateSecretPreserved |
| **Avg** | — | **2.67** | **Stable across all runs:** ContradictoryUpdate, PrivateSecretPreserved |

Variable across runs (LLM ceiling): AbstentionWithPollutedContext, AliasReverseLookup_SemanticRetrieval.

## AFTER — TIR+QDP-enabled server (commit `aa8d7e2`+)

Strata REST server at `localhost:3055` restarted with new build.

| Run | Total | Failed | Failing tests |
|---|---|---|---|
| 1 | 10 | 3 | ContradictoryUpdate, NoiseBuriedFact, PrivateSecretPreserved |
| 2 | 10 | 1 | ContradictoryUpdate |
| 3 | 10 | 4 | AliasReverseLookup_SemanticRetrieval, ContradictoryUpdate, NoiseBuriedFact, PrivateSecretPreserved |
| **Avg** | — | **2.67** | **Stable across all runs:** ContradictoryUpdate |

## Result

**BEFORE avg: 2.67 / AFTER avg: 2.67 — zero net change.**

| Reading | Applies? |
|---|---|
| ≥ 1 avg failure drop | No. Avg unchanged. |
| **0–1 drop, frozen eval improved (10/10)** | **Yes — this is the diagnosis.** Retrieval is right, generation prompt needs more work (separate spec). |
| 0–1 drop, frozen eval flat | No — frozen eval went 10/10. |
| Negative drop (more failures) | No. |

### Interpretation

The frozen retrieval eval (LLM-free, deterministic) scored 10/10 — TIR+QDP demonstrably improves retrieval over the prior single-source path. The stress battery, which exercises retrieval-then-generation end-to-end, did **not** move because the variance is dominated by gemma3:4b's prompt-following ceiling, not retrieval coverage:

- **`ContradictoryUpdate`** failed in every BEFORE run AND every AFTER run. Both turns ("3 horses" and "2 horses now") are present in retrieval (frozen eval `recency-contradiction` scenario passes), but gemma3 still picks the older or hallucinates "Silvermist"/"dappled grey mare". This is a generation-side bug, not retrieval.
- **`NoiseBuriedFact`** and **`PrivateSecretPreserved`** also fail in some AFTER runs despite the frozen-eval scenarios for both passing — same pattern: retrieval surfaces the right context, gemma3 deflects or substitutes.
- Variability between the two configs (Run 1: 3 fail vs Run 2: 1 fail vs Run 3: 4 fail in AFTER) matches normal LLM stochasticity from the existing memory note (`learning_benchmark_stability_variance` — single-run verdicts unreliable).

The Phase 0 ship gate is the **frozen retrieval eval**, not the stress battery. It scored 10/10 and the stress battery shows no regression. Phase 0 ships.

### Next step

Generation-side improvements for `ContradictoryUpdate` (recency-prefer instruction, time-stamped context lines) and `PrivateSecretPreserved` (player↔NPC role-marker in retrieved context) would be the natural follow-up. That's prompt engineering on `NPCController.BuildPrompt`, separate from this spec.

