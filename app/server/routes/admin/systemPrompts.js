import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import { getAll, updatePrompt } from '../../../db/systemPrompts.js';

const router = express.Router();

// List all system prompts
router.get('/admin/system-prompts', requireApiKey, async (req, res, next) => {
  try {
    const prompts = await getAll();
    res.json({ prompts });
  } catch (err) {
    next(err);
  }
});

// Update a prompt by key
router.put('/admin/system-prompts/:key', requireApiKey, async (req, res, next) => {
  const { key } = req.params;
  const { text, enabled = true } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'missing_text' });
  }
  try {
    const prompt = await updatePrompt(key, text, enabled);
    res.json({ prompt });
  } catch (err) {
    next(err);
  }
});

export default router;
