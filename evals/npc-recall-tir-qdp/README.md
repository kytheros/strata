# NPC Recall TIR + QDP Eval (Frozen)

Scores the recall path produced by `npc-turn-store` + `recall-fusion` + `recall-qdp`
against ten hand-curated scenarios that recreate the NPCStressBatteryTest failure modes.

Spec: `specs/2026-04-26-npc-recall-tir-qdp-design.md`.

Run:

    cd strata
    npx tsx evals/npc-recall-tir-qdp/eval.ts

Ship gate (Phase 0 → Phase 1 decision):

| Score | Decision |
|---|---|
| ≥ 8/10 scenarios pass | Ship Phase 0 |
| 5–7/10 pass | Ship Phase 0, plan Phase 1 (LLM-QDP) |
| < 5/10 pass | Re-evaluate. Possibly Phase 2 (deprecate npc_memories from recall) |

DO NOT modify `eval.ts` or `scenarios/**` during optimization. The script is the source of truth.
