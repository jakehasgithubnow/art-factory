import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import { getAll as getStylePrompts, updatePrompt as updateStylePrompt, togglePrompt as toggleStylePrompt } from '../../../db/stylePrompts.js';
import { getAll as getSystemPrompts, updatePrompt as updateSystemPrompt } from '../../../db/systemPrompts.js';

const router = express.Router();

// Admin UI page - system prompts + style prompts
router.get('/admin/style-prompts-ui', requireApiKey, async (req, res, next) => {
  try {
    const [stylePrompts, systemPrompts] = await Promise.all([
      getStylePrompts(),
      getSystemPrompts()
    ]);

    res.set('Cache-Control', 'no-store');

    res.send(`
      <html>
        <head>
          <title>Prompts Configuration</title>
        </head>
        <body>
          <h1>System Prompts</h1>
          <form method="POST" action="/admin/system-prompts-ui/update">
            ${systemPrompts.map(p => `
              <div>
                <label for="${p.key}">${p.key}</label><br/>
                <textarea name="${p.key}" rows="3" cols="80">${p.text}</textarea><br/>
              </div>
            `).join('')}
            <button type="submit">Save System Prompts</button>
          </form>

          <h1>Style Prompts</h1>
          <form method="POST" action="/admin/style-prompts-ui/update">
            ${stylePrompts.map(p => `
              <div>
                <label for="style-${p.id}">Prompt #${p.id}</label><br/>
                <textarea name="text_${p.id}" rows="2" cols="80">${p.text}</textarea><br/>
                <label>
                  <input type="checkbox" name="enabled_${p.id}" ${p.enabled ? 'checked' : ''}/> Enabled
                </label>
              </div>
            `).join('')}
            <button type="submit">Save Style Prompts</button>
          </form>
        </body>
      </html>
    `);
  } catch (err) {
    next(err);
  }
});

// Handle updates for system prompts
router.post('/admin/system-prompts-ui/update', async (req, res, next) => {
  try {
    const updates = Object.entries(req.body);
    console.log('SystemPrompt Update body:', req.body);
    for (const [key, text] of updates) {
      await updateSystemPrompt(key, text || "", true);
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

  
// Handle updates for style prompts
router.post('/admin/style-prompts-ui/update', requireApiKey, async (req, res, next) => {
  try {
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('text_')) {
        const id = key.split('_')[1];
        const text = req.body[`text_${id}`];
        const enabled = req.body[`enabled_${id}`] !== undefined;
        if (text) {
          await updateStylePrompt(id, text);
        }
        await toggleStylePrompt(id, enabled);
      }
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

export default router;
