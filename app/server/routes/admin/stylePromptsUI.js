import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import { getAll as getStylePrompts } from '../../../db/stylePrompts.js';
import { getAll as getSystemPrompts, updatePrompt as updateSystemPrompt } from '../../../db/systemPrompts.js';

const router = express.Router();

// Admin UI page - system prompts + style prompts
router.get('/admin/style-prompts-ui', requireApiKey, async (req, res, next) => {
  try {
    const [stylePrompts, systemPrompts] = await Promise.all([
      getStylePrompts(),
      getSystemPrompts()
    ]);

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
          <ul>
            ${stylePrompts.map(p => `<li>${p.text} (${p.enabled ? 'enabled' : 'disabled'})</li>`).join('')}
          </ul>
        </body>
      </html>
    `);
  } catch (err) {
    next(err);
  }
});

// Handle updates for system prompts
router.post('/admin/system-prompts-ui/update', requireApiKey, async (req, res, next) => {
  try {
    const updates = Object.entries(req.body);
    for (const [key, text] of updates) {
      if (text) {
        await updateSystemPrompt(key, text, true);
      }
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

export default router;
