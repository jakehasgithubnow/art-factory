import express from 'express';
import * as stylePrompts from '../../../db/stylePrompts.js';

const router = express.Router({ mergeParams: true });

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
    const { text, enabled } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Prompt text is required' });
    }
    const prompt = await stylePrompts.createPrompt(text, enabled);
    res.status(201).json(prompt);
  } catch (err) {
    console.error('Failed to create style prompt', err);
    res.status(500).json({ error: 'Failed to create style prompt' });
  }
});

// Update prompt text
router.patch('/:id', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Prompt text is required' });
    }
    const prompt = await stylePrompts.updatePrompt(req.params.id, text);
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
