import express from 'express';
import * as stylePrompts from '../../../db/stylePrompts.js';

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
    const { text, enabled, model, scope, categories, provider } = req.body;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Prompt text is required' });
    }
    // normalize categories (string, array or null)
    const cats = normalizeCategories(categories);
    const prompt = await stylePrompts.createPrompt(text.trim(), enabled, model, scope, cats, normProvider(provider));
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

    const { text, model, scope, categories, provider } = req.body;

    if (text === undefined && model === undefined && scope === undefined && categories === undefined && provider === undefined) {
      return res.status(400).json({ error: 'Nothing to update. Provide one of: text, model, scope, categories, provider.' });
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

    const cats = (categories === undefined) ? undefined : normalizeCategories(categories);

    const prompt = await stylePrompts.updatePrompt(id, text, model, scope, cats, provider === undefined ? undefined : normProvider(provider));
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
