-- Migration: seed all former hardcoded prompts into system_prompts
INSERT INTO system_prompts (key, text, enabled, updated_at)
VALUES
  ('artwork_description_system', 'Describe a painting in 35 words.', true, now()),
  ('photo_scoring_system', 'You rate reference photos for painting. Reply ONLY a decimal 0-1.', true, now()),
  ('photo_scoring_user', 'Score this image for painting quality (composition, subject clarity, no watermarks): {{imageUrl}}', true, now()),
  ('catchment_intro_system', 'You are a concise travel copywriter. Reply with <=50 words.', true, now()),
  ('catchment_intro_user', 'Write a 50-word warm introduction to visiting {{catchmentName}}.', true, now()),
  ('location_places_system', 'You generate clean JSON for downstream automation.', true, now()),
  ('location_places_user', 'Return ONLY a minified JSON array (max 10) of interesting public places within 30km of the point (lat: {{lat}}, lon: {{lon}}) around "{{catchmentName}}".\nEach item MUST follow this JSON shape: {"name": string, "address": string, "category": string, "description": string, "search_term": string}.\nThe "search_term" should be what a person would type into an image search to find photos of this exact place (e.g., include the city/neighbourhood).', true, now())
ON CONFLICT (key) DO NOTHING;
