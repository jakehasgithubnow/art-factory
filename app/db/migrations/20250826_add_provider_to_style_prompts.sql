-- Add provider column and constraints to style_prompts
ALTER TABLE style_prompts ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE style_prompts ALTER COLUMN provider SET DEFAULT 'piapi';
UPDATE style_prompts SET provider = 'piapi' WHERE provider IS NULL;
ALTER TABLE style_prompts ALTER COLUMN provider SET NOT NULL;
ALTER TABLE style_prompts DROP CONSTRAINT IF EXISTS style_prompts_provider_check;
ALTER TABLE style_prompts ADD CONSTRAINT style_prompts_provider_check CHECK (provider in ('piapi','gemini'));
