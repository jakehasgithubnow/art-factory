import express from 'express';
import * as stylePrompts from '../../../db/stylePrompts.js';
import db from '../../../db/client.js';
import { generateImage } from '../../../services/openai.js';
import { generateImageWithGemini } from '../../../services/openrouter.js';

const router = express.Router({ mergeParams: true });

const ALLOWED_CATEGORIES = [
  'mountain_hill',
  'forest_park',
  'meadow_field',
  'river_lake_waterfall',
  'ocean_beach_coast',
  'village',
  'city',
  'industrial',
  'castle_church_ruin',
  'other'
];

const ALLOWED_PROVIDERS = ['piapi', 'gemini'];
const normProvider = (p) => (ALLOWED_PROVIDERS.includes(String(p || '').toLowerCase()) ? String(p).toLowerCase() : 'piapi');

function normalizeCategories(input) {
  if (input == null || input === '') return null;
  let arr = input;
  if (typeof input === 'string') {
    arr = input.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr)) {
    // Express urlencoded parser may give a single value when one checkbox is selected
    if (typeof input === 'string') arr = [input.trim()];
    else return null;
  }
  const set = new Set();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const val = v.trim();
    if (!val) continue;
    if (ALLOWED_CATEGORIES.includes(val)) set.add(val);
  }
  if (set.size === 0) return null;
  return Array.from(set);
}

function applyTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (ctx && ctx[k] != null ? String(ctx[k]) : ''));
}

function extractPromptImageUrls(text) {
  const matches = (typeof text === 'string' && text.match(/https?:\/\/[^\s"'()\\]+/g)) || [];
  const filtered = matches.filter(u => /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u) || /res\.cloudinary\.com/i.test(u));
  return Array.from(new Set(filtered));
}

// Get all prompts
router.get('/', async (req, res) => {
  try {
    const prompts = await stylePrompts.getAll();
    res.json(prompts);
  } catch (err) {
    console.error('Failed to get style prompts', err);
    res.status(500).json({ error: 'Failed to get style prompts' });
  }
});

// Create a prompt
router.post('/', async (req, res) => {
  try {
    const { text, enabled, model, scope, categories, provider, name } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Prompt text is required' });
    }
    // normalize categories (string, array or null)
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return res.status(400).json({ error: 'Name must be a string or null' });
    }
    const cats = normalizeCategories(categories);
    const prompt = await stylePrompts.createPrompt(text.trim(), enabled, model, scope, cats, normProvider(provider), name);
    res.status(201).json(prompt);
  } catch (err) {
    console.error('Failed to create style prompt', err);
    res.status(500).json({ error: 'Failed to create style prompt' });
  }
});

// Update prompt (text/model/scope/categories)
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid prompt id' });
    }

    const { text, model, scope, categories, provider, name } = req.body;

    if (text === undefined && model === undefined && scope === undefined && categories === undefined && provider === undefined && name === undefined) {
      return res.status(400).json({ error: 'Nothing to update. Provide one of: text, model, scope, categories, provider, name.' });
    }

    if (text !== undefined && typeof text !== 'string') {
      return res.status(400).json({ error: 'Prompt text must be a string if provided' });
    }
    if (model !== undefined && model !== null && typeof model !== 'string') {
      return res.status(400).json({ error: 'Model must be a string or null' });
    }
    if (scope !== undefined && scope !== null && typeof scope !== 'string') {
      return res.status(400).json({ error: 'Scope must be a string or null' });
    }
    if (categories !== undefined && !(categories === null || typeof categories === 'string' || Array.isArray(categories))) {
      return res.status(400).json({ error: 'Categories must be a string (comma-separated), array of strings, or null' });
    }
    if (provider !== undefined && provider !== null && typeof provider !== 'string') {
      return res.status(400).json({ error: 'Provider must be a string (piapi or gemini) or null' });
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return res.status(400).json({ error: 'Name must be a string or null' });
    }

    const cats = (categories === undefined) ? undefined : normalizeCategories(categories);

    const prompt = await stylePrompts.updatePrompt(id, text, model, scope, cats, provider === undefined ? undefined : normProvider(provider), name);
    res.json(prompt);
  } catch (err) {
    console.error('Failed to update style prompt', err);
    res.status(500).json({ error: 'Failed to update style prompt' });
  }
});

// Toggle prompt enabled status
router.patch('/:id/toggle', async (req, res) => {
  try {
    let { enabled } = req.body;

    // Coerce string "true"/"false" to boolean
    if (typeof enabled === 'string') {
      if (enabled.toLowerCase() === 'true') enabled = true;
      else if (enabled.toLowerCase() === 'false') enabled = false;
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid prompt id' });
    }

    const prompt = await stylePrompts.togglePrompt(id, enabled);
    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // If returning array or null, ensure JSON serializable object
    res.json({ id: prompt.id, text: prompt.text, enabled: prompt.enabled, updated_at: prompt.updated_at });
  } catch (err) {
    console.error('Failed to toggle style prompt', err);
    res.status(500).json({ error: 'Failed to toggle style prompt', details: err?.message });
  }
});

 // Test a prompt (generate sample images without persisting)
router.post('/:id/test', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'invalid_prompt_id' });
    }
    const count = Math.min(10, Math.max(1, Number(req.body?.count ?? 5)));

    const style = await db('style_prompts').where({ id }).first();
    if (!style) return res.status(404).json({ error: 'prompt_not_found' });

    // Pick a random approved photo with a secure URL (any catchment)
    const row = await db('photos as p')
      .join('locations as l', 'l.id', 'p.location_id')
      .leftJoin('catchments as c', 'c.id', 'l.catchment_id')
      .where('p.kept', true)
      .andWhere('p.processed', true)
      .whereNotNull('p.secure_url')
      .orderByRaw('random()')
      .select(
        'p.id as photo_id',
        'p.secure_url as image_url',
        'l.id as location_id',
        'l.name as location_name',
        'l.category as location_category',
        'c.name as catchment_name',
        'c.phrases as catchment_phrases'
      )
      .first();

    if (!row || !row.image_url) {
      return res.status(409).json({ error: 'no_approved_source_found' });
    }

    const locMeta = {
      locationName: row.location_name || '',
      catchmentName: row.catchment_name || '',
      locationCategory: row.location_category || '',
      phrases: JSON.stringify(Array.isArray(row.catchment_phrases) ? row.catchment_phrases : [])
    };

    // Interpolate template variables
    const resolved = applyTemplate(String(style.text || ''), {
      ...locMeta,
      locationname: row.location_name || '',
      catchmentname: row.catchment_name || ''
    });

    // Extract and remove any image URLs embedded in the prompt
    const promptImageUrls = extractPromptImageUrls(resolved).filter(u => u !== row.image_url);
    let cleanedPrompt = resolved;
    for (const u of promptImageUrls) cleanedPrompt = cleanedPrompt.split(u).join('');
    cleanedPrompt = cleanedPrompt.replace(/\s{2,}/g, ' ').trim();

    const provider = normProvider(style.provider);

    async function runOnce() {
      try {
        if (provider === 'gemini') {
          const urls = await generateImageWithGemini({
            prompt: cleanedPrompt,
            imageUrl: row.image_url,
            additionalImageUrls: promptImageUrls,
          });
          return urls?.[0] || null;
        } else {
          const urls = await generateImage({
            prompt: cleanedPrompt,
            imageUrl: row.image_url,
            additionalImageUrls: promptImageUrls,
          });
          return urls?.[0] || null;
        }
      } catch (e) {
        return null;
      }
    }

    const tasks = Array.from({ length: count }, () => runOnce());
    const results = await Promise.all(tasks);
    const images = results.filter(Boolean);

    return res.json({
      images,
      source: { photoId: row.photo_id, imageUrl: row.image_url },
      location: { id: row.location_id, name: row.location_name, category: row.location_category, catchmentName: row.catchment_name }
    });
  } catch (err) {
    console.error('Failed to test style prompt', err);
    res.status(500).json({ error: 'test_failed' });
  }
});

// Delete a prompt
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid prompt id' });
    }
    const deletedCount = await stylePrompts.deletePrompt(id);
    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Prompt not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete style prompt', err);
    res.status(500).json({ error: 'Failed to delete style prompt', details: err?.message });
  }
});

export default router;
