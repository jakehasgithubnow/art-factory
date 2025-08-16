-- Migration: Ensure locations table has Google coordinates fields
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS g_lat numeric,
  ADD COLUMN IF NOT EXISTS g_lng numeric;
