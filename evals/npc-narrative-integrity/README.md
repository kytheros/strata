# NPC Narrative Integrity Eval (Frozen)

Scores the store produced by the extraction worker for four scenarios that
reproduce the 2026-04-22 playtest failures. Spec:
`specs/2026-04-22-npc-narrative-integrity-design.md`.

Run:

    cd strata
    GEMINI_API_KEY=... npx tsx evals/npc-narrative-integrity/eval.ts

Ship gate: total >= 85%, no scenario scoring 0.

Regression gate (separate): `evals/longmemeval/` stays >= 80.0%.

DO NOT modify `eval.ts` or `scenarios/**` during optimization.
