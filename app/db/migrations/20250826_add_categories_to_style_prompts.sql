-- 2025-08-26: Add categories to style_prompts for location/icon category filtering

BEGIN;

-- 1) Add categories column (nullable means no restriction)
ALTER TABLE IF EXISTS style_prompts
  ADD COLUMN IF NOT EXISTS categories text[];

-- 2) Ensure only allowed category values are stored (or NULL)
DO $$
BEGIN
  ALTER TABLE style_prompts
    DROP CONSTRAINT IF EXISTS style_prompts_categories_allowed;
  ALTER TABLE style_prompts
    ADD CONSTRAINT style_prompts_categories_allowed
    CHECK (
      categories IS NULL OR
      categories <@ ARRAY[
        'mountain_hill',
        'forest_park',
        'meadow_field',
        'river_lake_waterfall',
        'ocean_beach_coast',
        'village',
        'city',
        'industrial',
        'castle_church_ruin',
        'other'
      ]::text[]
    );
EXCEPTION
  WHEN undefined_table THEN
    -- Table might not exist in some environments; ignore here
    NULL;
END $$;

-- 3) Helpful index for membership queries
CREATE INDEX IF NOT EXISTS idx_style_prompts_categories
  ON style_prompts
  USING GIN (categories);

COMMIT;
