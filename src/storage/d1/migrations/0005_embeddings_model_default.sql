-- Reconcile embeddings.model default from 'text-embedding-004' to 'gemini-embedding-001'
-- to match schema.ts and the rest of the Strata stack.
-- This migration fixes any legacy rows written with the old default.

-- Normalize legacy 'text-embedding-004' rows (from old 0001_init.sql default).
UPDATE embeddings SET model = 'gemini-embedding-001' WHERE model = 'text-embedding-004';
