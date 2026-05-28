-- Migration 0006: Reasoning trace capture — agent-loop training pair task_types.
--
-- Expands the training_data.task_type CHECK constraint to include
-- 'reasoning_tool_call' and 'reasoning_final_answer', enabling the
-- LongMemEval agent-loop to capture (state → reasoning → action) training
-- pairs from every benchmark run.
--
-- Forward-only, additive-only discipline (per pg-migrations.ts contract):
-- never alter a prior migration; all constraint changes go in new numbered
-- files. The constraint was last widened in 0005_training_data_phase0.sql
-- (added 'conflict'); this migration adds the two reasoning_* values on top.
--
-- Spec: specs/2026-05-28-reasoning-trace-capture-design.md

ALTER TABLE training_data DROP CONSTRAINT IF EXISTS training_data_task_type_check;

ALTER TABLE training_data
  ADD CONSTRAINT training_data_task_type_check
  CHECK (task_type IN ('extraction', 'summarization', 'dialogue', 'conflict',
                       'reasoning_tool_call', 'reasoning_final_answer'));
