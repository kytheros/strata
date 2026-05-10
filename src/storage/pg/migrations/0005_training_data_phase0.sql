-- Migration 0005: Phase 0 distillation capture — conflict task_type.
--
-- Expands the training_data.task_type CHECK constraint to include 'conflict',
-- enabling the conflict resolver to store its LLM-based decisions as training
-- pairs (capture gap identified in the Phase 0 distillation research spec).
--
-- Why not update 0001_baseline.sql?
-- The migration runner records and verifies SHA-256 checksums for every applied
-- migration (see pg-migrations.ts design contract). Altering 0001_baseline.sql
-- after it has been applied to any deployment causes a checksum mismatch on the
-- next startup, aborting the server. Forward-only, additive-only discipline
-- means all constraint changes are delivered via new numbered files.
--
-- Implementation note: the simple SQL splitter in pg-migrations.ts does not
-- handle dollar-quoted strings (DO $$ ... $$), so this migration uses plain
-- ALTER TABLE statements. Postgres auto-names the constraint on 0001 as
-- "training_data_task_type_check" (table_column_check convention).
--
-- Ticket: kytheros/strata#11 (B.2)

ALTER TABLE training_data DROP CONSTRAINT IF EXISTS training_data_task_type_check;

ALTER TABLE training_data
  ADD CONSTRAINT training_data_task_type_check
  CHECK (task_type IN ('extraction', 'summarization', 'dialogue', 'conflict'));
