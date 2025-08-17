-- Seed default prompts for catchment introductions

INSERT INTO system_prompts (key, prompt) VALUES
  ('catchment_intro_system', 'You are a concise travel copywriter. Reply with <=50 words.'),
  ('catchment_intro_user', 'Write a 50-word warm introduction to visiting {{catchmentName}}.')
ON CONFLICT (key) DO NOTHING;
