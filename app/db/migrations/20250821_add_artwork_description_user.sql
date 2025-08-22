-- Migration: add artwork_description_user system prompt
INSERT INTO system_prompts (key, text, enabled, updated_at)
VALUES
  ('artwork_description_user', 'Describe the colours, medium and vibe of the painting at {url}', true, now())
ON CONFLICT (key) DO NOTHING;
