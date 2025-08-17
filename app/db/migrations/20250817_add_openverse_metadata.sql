-- Migration: Add Openverse metadata fields to photos table

ALTER TABLE photos
  ADD COLUMN openverse_id text,
  ADD COLUMN title text,
  ADD COLUMN creator text,
  ADD COLUMN creator_url text,
  ADD COLUMN license text,
  ADD COLUMN license_version text,
  ADD COLUMN license_url text,
  ADD COLUMN source text,
  ADD COLUMN category text,
  ADD COLUMN provider text,
  ADD COLUMN thumbnail_url text,
  ADD COLUMN detail_url text,
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN openverse_metadata jsonb DEFAULT '{}'::jsonb;
