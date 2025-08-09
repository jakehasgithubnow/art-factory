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

-- Guardrails for geo ranges (no-op if already present)
alter table catchments
  add constraint if not exists catchments_lat_range check (lat >= -90 and lat <= 90);
alter table catchments
  add constraint if not exists catchments_lon_range check (lon >= -180 and lon <= 180);

-- Prevent duplicate catchments (same name+lat+lon, case-insensitive on name)
create unique index if not exists catchments_unique_name_geo
  on catchments(lower(name), lat, lon);

-- Avoid duplicate Shopify collections when backfilling
create unique index if not exists catchments_shopify_unique
  on catchments(shopify_id)
  where shopify_id is not null;

create index if not exists idx_catchments_created_at on catchments(created_at);

-- ===================== 2. Locations ======================
create table if not exists locations (
  id           uuid primary key default gen_random_uuid(),
  catchment_id uuid not null references catchments(id) on delete cascade,
  name         text not null,
  address      text,
  category     text,
  description  text,
  search_term  text,
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
  created_at     timestamptz default now()
);

-- Idempotent constraints & indexes for photos
alter table photos
  add constraint if not exists photos_score_range check (score is null or (score >= 0 and score <= 1));
create index if not exists idx_photos_location on photos(location_id);
create unique index if not exists photos_location_src_url on photos(location_id, src_url);

-- Ensure a Cloudinary asset is not linked twice (when present)
create unique index if not exists photos_cloudinary_unique
  on photos(cloudinary_id)
  where cloudinary_id is not null;

create index if not exists idx_photos_created_at on photos(created_at);

-- ===================== 4. Artwork ========================
create table if not exists artwork (
  id          uuid primary key default gen_random_uuid(),
  photo_id    uuid not null references photos(id) on delete cascade,
  image_url   text not null,
  description text,
  mockup_urls jsonb default '[]'::jsonb,
  shopify_id  text,
  published   boolean not null default false,
  created_at  timestamptz default now()
);

create index if not exists idx_artwork_photo on artwork(photo_id);

-- One artwork per source photo
create unique index if not exists artwork_unique_per_photo on artwork(photo_id);

-- Avoid duplicate Shopify products when backfilling
create unique index if not exists artwork_shopify_unique
  on artwork(shopify_id)
  where shopify_id is not null;

create index if not exists idx_artwork_created_at on artwork(created_at);

-- ===================== Orchestration =====================
-- We are using code-driven queue chaining (Option A). Remove LISTEN/NOTIFY triggers.
-- Drop old triggers/functions if they exist so schemas remain clean.

drop trigger if exists trg_notify_catchments on catchments;
drop trigger if exists trg_notify_locations  on locations;
drop trigger if exists trg_notify_photos     on photos;
drop trigger if exists trg_notify_artwork    on artwork;

drop function if exists notify_event() cascade;

-- ===================== Quality-of-life ===================
create index if not exists idx_catchments_processed on catchments(processed);
create index if not exists idx_locations_processed on locations(processed);
create index if not exists idx_photos_processed    on photos(processed);
create index if not exists idx_artwork_published   on artwork(published);