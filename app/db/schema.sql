create extension if not exists pgcrypto;

-- ===================== 1. Catchments =====================
create table if not exists catchments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  lat        numeric not null,
  lon        numeric not null,
  intro      text,
  shopify_id text,
  processed  boolean not null default false,
  created_at timestamptz default now()
);

-- System prompts table
CREATE TABLE IF NOT EXISTS system_prompts (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  text TEXT NOT NULL,
  model TEXT,
  enabled BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMP DEFAULT now()
);

-- Seed default system prompts
INSERT INTO system_prompts (key, text) VALUES
  ('location_intro_system', 'You are a concise travel copywriter. Reply with <=50 words.'),
  ('artwork_description_system', 'Describe a painting in 35 words.'),
  ('location_places_system', 'Suggest 10 interesting places to paint with short descriptions.'),
  ('artwork_description_user', 'Describe the colours, medium and vibe of the painting at {url}')
ON CONFLICT(key) DO NOTHING;

-- Guardrails for geo ranges (no-op if already present)
alter table catchments drop constraint if exists catchments_lat_range;
alter table catchments add constraint catchments_lat_range check (lat >= -90 and lat <= 90);
alter table catchments drop constraint if exists catchments_lon_range;
alter table catchments add constraint catchments_lon_range check (lon >= -180 and lon <= 180);

-- Prevent duplicate catchments (same name+lat+lon, case-insensitive on name)
create unique index if not exists catchments_unique_name_geo
  on catchments(lower(name), lat, lon);

-- Avoid duplicate Shopify collections when backfilling
create unique index if not exists catchments_shopify_unique
  on catchments(shopify_id)
  where shopify_id is not null;

create index if not exists idx_catchments_created_at on catchments(created_at);

-- Backfill column for image source on existing catchments
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS image_source text;
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS openverse_top_n integer;
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS openverse_per_page integer;
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS openverse_max_pages integer;
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS openverse_params jsonb DEFAULT '{}'::jsonb;

-- ===================== 2. Locations ======================
create table if not exists locations (
  id           uuid primary key default gen_random_uuid(),
  catchment_id uuid not null references catchments(id) on delete cascade,
  name         text not null,
  address      text,
  category     text,
  description  text,
  search_term  text,
  -- Google Places enrichment fields
  g_place_id text,
  g_name text,
  g_formatted_address text,
  g_phone text,
  g_website text,
  g_lat numeric,
  g_lng numeric,
  g_rating numeric,
  g_user_ratings_total integer,
  g_types text,
  g_photo_refs jsonb default '[]'::jsonb,
  processed    boolean not null default false,
  created_at   timestamptz default now()
);

-- Helpful index for joins
create index if not exists idx_locations_catchment on locations(catchment_id);

-- Prevent duplicate places inside the same catchment (case-insensitive on name)
create unique index if not exists locations_unique_place_per_catchment
  on locations(catchment_id, lower(name));

-- Fast retrieval by creation time
create index if not exists idx_locations_created_at on locations(created_at);

-- Backfill Google Places enrichment and source columns for existing locations rows
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS image_source text,
  ADD COLUMN IF NOT EXISTS g_place_id text,
  ADD COLUMN IF NOT EXISTS g_name text,
  ADD COLUMN IF NOT EXISTS g_formatted_address text,
  ADD COLUMN IF NOT EXISTS g_phone text,
  ADD COLUMN IF NOT EXISTS g_website text,
  ADD COLUMN IF NOT EXISTS g_lat numeric,
  ADD COLUMN IF NOT EXISTS g_lng numeric,
  ADD COLUMN IF NOT EXISTS g_rating numeric,
  ADD COLUMN IF NOT EXISTS g_user_ratings_total integer,
  ADD COLUMN IF NOT EXISTS g_types text,
  ADD COLUMN IF NOT EXISTS g_photo_refs jsonb DEFAULT '[]'::jsonb;

-- ===================== 3. Photos =========================
create table if not exists photos (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references locations(id) on delete cascade,
  src_url        text not null,
  kept           boolean not null default false,
  score          numeric,
  cloudinary_id  text,
  secure_url     text,
  processed      boolean not null default false,
  -- Openverse metadata columns
  ov_id              text,
  ov_title           text,
  ov_creator         text,
  ov_creator_url     text,
  ov_license         text,
  ov_license_version text,
  ov_license_url     text,
  ov_source          text,
  ov_category        text,
  ov_provider        text,
  ov_thumbnail       text,
  ov_detail_url      text,
  ov_width           integer,
  ov_height          integer,
  created_at     timestamptz default now()
);

-- Idempotent constraints & indexes for photos
alter table photos drop constraint if exists photos_score_range;
alter table photos add constraint photos_score_range check (score is null or (score >= 0 and score <= 1));
create index if not exists idx_photos_location on photos(location_id);
create unique index if not exists photos_location_src_url on photos(location_id, src_url);

-- Ensure a Cloudinary asset is not linked twice (when present)
create unique index if not exists photos_cloudinary_unique
  on photos(cloudinary_id)
  where cloudinary_id is not null;

create index if not exists idx_photos_created_at on photos(created_at);

-- Add icon flag to mark photos selected as app icon during moderation
ALTER TABLE photos
  ADD COLUMN IF NOT EXISTS icon boolean not null default false;

-- ===================== 4. Artwork ========================
create table if not exists artwork (
  id          uuid primary key default gen_random_uuid(),
  photo_id    uuid not null references photos(id) on delete cascade,
  style_prompt_id integer references style_prompts(id),
  style_name  text,
  image_url   text not null,
  description text,
  mockup_urls jsonb default '[]'::jsonb,
  shopify_id  text,
  approved_for_publish boolean default false,
  moderated_at timestamptz,
  published   boolean not null default false,
  created_at  timestamptz default now()
);

create index if not exists idx_artwork_photo on artwork(photo_id);

-- One artwork per source photo per style
create unique index if not exists artwork_unique_per_photo_style on artwork(photo_id, style_prompt_id);

-- Avoid duplicate Shopify products when backfilling
create unique index if not exists artwork_shopify_unique
  on artwork(shopify_id)
  where shopify_id is not null;

create index if not exists idx_artwork_created_at on artwork(created_at);

-- ===================== 4b. Catchment Artwork ========================
create table if not exists catchment_artwork (
  id               uuid primary key default gen_random_uuid(),
  catchment_id     uuid not null references catchments(id) on delete cascade,
  style_prompt_id  integer references style_prompts(id),
  style_name       text,
  image_url        text not null,
  description      text,
  mockup_urls      jsonb default '[]'::jsonb,
  shopify_id       text,
  approved_for_publish boolean default false,
  moderated_at     timestamptz,
  published        boolean not null default false,
  created_at       timestamptz default now()
);

-- One artwork per catchment per style
create unique index if not exists catchment_artwork_unique_per_catchment_style
  on catchment_artwork(catchment_id, style_prompt_id);

create index if not exists idx_catchment_artwork_catchment on catchment_artwork(catchment_id);
create index if not exists idx_catchment_artwork_published on catchment_artwork(published);

-- ===================== Orchestration =====================
-- We are using code-driven queue chaining (Option A). Remove LISTEN/NOTIFY triggers.
-- Drop old triggers/functions if they exist so schemas remain clean.

drop trigger if exists trg_notify_catchments on catchments;
drop trigger if exists trg_notify_locations  on locations;
drop trigger if exists trg_notify_photos     on photos;
drop trigger if exists trg_notify_artwork    on artwork;

drop function if exists notify_event() cascade;

-- ===================== 5. Style Prompts ===================
create table if not exists style_prompts (
  id serial primary key,
  text text not null,
  model text,
  scope text not null default 'location',
  categories text[],
  enabled boolean not null default true,
  updated_at timestamptz default now(),
  created_at timestamptz default now(),
  constraint style_prompts_scope_check check (scope in ('location','catchment','icon')),
  constraint style_prompts_categories_allowed check (
    categories is null or
    categories <@ array[
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
  )
);

create index if not exists idx_style_prompts_enabled on style_prompts(enabled);
create index if not exists idx_style_prompts_scope on style_prompts(scope);
create index if not exists idx_style_prompts_enabled_scope on style_prompts(enabled, scope);
create index if not exists idx_style_prompts_categories on style_prompts using gin (categories);

-- Backfill provider column and constraint for style_prompts
ALTER TABLE style_prompts ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE style_prompts ALTER COLUMN provider SET DEFAULT 'piapi';
UPDATE style_prompts SET provider = 'piapi' WHERE provider IS NULL;
ALTER TABLE style_prompts ALTER COLUMN provider SET NOT NULL;
ALTER TABLE style_prompts DROP CONSTRAINT IF EXISTS style_prompts_provider_check;
ALTER TABLE style_prompts ADD CONSTRAINT style_prompts_provider_check CHECK (provider in ('piapi','gemini'));

-- ===================== Quality-of-life ===================
create index if not exists idx_catchments_processed on catchments(processed);
create index if not exists idx_locations_processed on locations(processed);
create index if not exists idx_photos_processed    on photos(processed);
create index if not exists idx_artwork_published   on artwork(published);
