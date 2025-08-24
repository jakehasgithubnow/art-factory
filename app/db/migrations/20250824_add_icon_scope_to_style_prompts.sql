-- 2025-08-24: Expand style_prompts.scope to include 'icon'

BEGIN;

-- Replace CHECK constraint to allow the new 'icon' scope
ALTER TABLE IF EXISTS style_prompts
  DROP CONSTRAINT IF EXISTS style_prompts_scope_check;

ALTER TABLE IF EXISTS style_prompts
  ADD CONSTRAINT style_prompts_scope_check
  CHECK (scope IN ('location','catchment','icon'));

-- Helpful indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_style_prompts_scope ON style_prompts(scope);
CREATE INDEX IF NOT EXISTS idx_style_prompts_enabled_scope ON style_prompts(enabled, scope);

COMMIT;
