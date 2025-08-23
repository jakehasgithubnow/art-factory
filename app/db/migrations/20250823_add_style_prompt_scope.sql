-- 2025-08-23: Add 'scope' to style_prompts to support catchment-level prompts

BEGIN;

-- 1) Add scope column if missing
ALTER TABLE IF EXISTS style_prompts
  ADD COLUMN IF NOT EXISTS scope text;

-- 2) Set default and backfill existing rows to 'location'
ALTER TABLE IF EXISTS style_prompts
  ALTER COLUMN scope SET DEFAULT 'location';

UPDATE style_prompts
SET scope = 'location'
WHERE scope IS NULL;

-- 3) Make NOT NULL
ALTER TABLE IF EXISTS style_prompts
  ALTER COLUMN scope SET NOT NULL;

-- 4) Add CHECK constraint for allowed scopes (location | catchment)
DO $$
BEGIN
  ALTER TABLE style_prompts
    ADD CONSTRAINT style_prompts_scope_check CHECK (scope IN ('location','catchment'));
EXCEPTION
  WHEN duplicate_object THEN
    -- constraint already exists, ignore
    NULL;
END $$;

-- 5) Helpful indexes
CREATE INDEX IF NOT EXISTS idx_style_prompts_scope ON style_prompts(scope);
CREATE INDEX IF NOT EXISTS idx_style_prompts_enabled_scope ON style_prompts(enabled, scope);

COMMIT;
