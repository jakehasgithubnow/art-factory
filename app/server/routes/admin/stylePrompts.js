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
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Enabled must be a boolean' });
    }
    const prompt = await stylePrompts.togglePrompt(req.params.id, enabled);
    res.json(prompt);
  } catch (err) {
    console.error('Failed to toggle style prompt', err);
    res.status(500).json({ error: 'Failed to toggle style prompt' });
  }
});

// Delete a prompt
router.delete('/:id', async (req, res) => {
  try {
    await stylePrompts.deletePrompt(req.params.id);
    res.status(204).send();
  } catch (err) {
    console.error('Failed to delete style prompt', err);
    res.status(500).json({ error: 'Failed to delete style prompt' });
  }
});

export default router;
