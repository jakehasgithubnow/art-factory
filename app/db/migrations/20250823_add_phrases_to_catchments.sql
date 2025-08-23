-- Add phrases column to catchments to store city/catchment phrases array
ALTER TABLE catchments
  ADD COLUMN IF NOT EXISTS phrases jsonb DEFAULT '[]'::jsonb;
