-- Add optional human-friendly name for each style prompt
ALTER TABLE style_prompts
  ADD COLUMN IF NOT EXISTS name text;
