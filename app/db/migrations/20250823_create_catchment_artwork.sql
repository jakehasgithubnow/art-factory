-- 2025-08-23: Create catchment_artwork table for catchment-level style prompts

BEGIN;

CREATE TABLE IF NOT EXISTS catchment_artwork (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catchment_id     uuid NOT NULL REFERENCES catchments(id) ON DELETE CASCADE,
  style_prompt_id  integer REFERENCES style_prompts(id),
  style_name       text,
  image_url        text NOT NULL,
  description      text,
  mockup_urls      jsonb DEFAULT '[]'::jsonb,
  shopify_id       text,
  approved_for_publish boolean DEFAULT false,
  moderated_at     timestamptz,
  published        boolean NOT NULL DEFAULT false,
  created_at       timestamptz DEFAULT now()
);

-- One artwork per catchment per style
CREATE UNIQUE INDEX IF NOT EXISTS catchment_artwork_unique_per_catchment_style
  ON catchment_artwork(catchment_id, style_prompt_id);

CREATE INDEX IF NOT EXISTS idx_catchment_artwork_catchment ON catchment_artwork(catchment_id);
CREATE INDEX IF NOT EXISTS idx_catchment_artwork_published ON catchment_artwork(published);

COMMIT;
