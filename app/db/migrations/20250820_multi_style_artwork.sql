-- 2025-08-20: Multi-style artwork support and moderation columns

-- Add columns needed by code paths (moderation + style association)
ALTER TABLE artwork
  ADD COLUMN IF NOT EXISTS style_prompt_id integer REFERENCES style_prompts(id),
  ADD COLUMN IF NOT EXISTS style_name text,
  ADD COLUMN IF NOT EXISTS approved_for_publish boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS moderated_at timestamptz;

-- Drop old uniqueness on photo_id (handle both constraint and index names)
ALTER TABLE artwork DROP CONSTRAINT IF EXISTS artwork_unique_per_photo;
DROP INDEX IF EXISTS artwork_unique_per_photo;

-- New uniqueness: one artwork per photo per style
CREATE UNIQUE INDEX IF NOT EXISTS artwork_unique_per_photo_style
  ON artwork(photo_id, style_prompt_id);
