-- Add 'model' column to prompts tables so each prompt can specify an OpenAI model.
-- Idempotent: uses IF NOT EXISTS and safe updates.

BEGIN;

ALTER TABLE IF EXISTS system_prompts
  ADD COLUMN IF NOT EXISTS model text;

ALTER TABLE IF EXISTS style_prompts
  ADD COLUMN IF NOT EXISTS model text;

COMMIT;
