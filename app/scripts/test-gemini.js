/**
 * Usage:
 *   OPENROUTER_API_KEY=sk-... node app/scripts/test-gemini.js "A dreamy watercolor of mountains at sunrise, misty valleys, soft pastels"
 *
 * Optional envs (already wired in env.js):
 *   - OPENROUTER_MODEL (default: google/gemini-2.5-flash-image-preview)
 *   - OPENROUTER_BASE_URL (default: https://openrouter.ai/api/v1)
 *   - OPENROUTER_SITE_URL, OPENROUTER_SITE_NAME (optional attribution headers)
 */
import { env } from '../config/env.js';
import { generateImageWithGemini } from '../services/openrouter.js';

async function main() {
  const prompt = process.argv[2] || 'Generate a vibrant impressionist landscape painting with mountains, a lake, and golden-hour lighting. Return the final image.';
  console.log('[test-gemini] Model:', env.openRouterModel || 'google/gemini-2.5-flash-image-preview');
  console.log('[test-gemini] Prompt:', prompt);

  const urls = await generateImageWithGemini({ prompt });
  if (!Array.isArray(urls) || urls.length === 0) {
    console.error('[test-gemini] No image URLs returned.');
    process.exit(2);
  }

  console.log('[test-gemini] Returned image URLs:');
  for (const u of urls) console.log(' -', u);
}

main().catch((err) => {
  console.error('[test-gemini] Failed:', err?.message || err);
  process.exit(1);
});
