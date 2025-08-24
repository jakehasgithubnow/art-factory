import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import { getAll as getStylePrompts, createPrompt as createStylePrompt, updatePrompt as updateStylePrompt, togglePrompt as toggleStylePrompt } from '../../../db/stylePrompts.js';
import { getAll as getSystemPrompts, updatePrompt as updateSystemPrompt } from '../../../db/systemPrompts.js';

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

// Admin UI page - system prompts + style prompts
router.get('/admin/style-prompts-ui', async (req, res, next) => {
  try {
    const [stylePrompts, systemPrompts] = await Promise.all([
      getStylePrompts(),
      getSystemPrompts()
    ]);

    // Allowed OpenAI chat models for selection
    const allowedModelsSystem = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
    const allowedModelsStyle = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
    const renderModelSelect = (name, selected, isSystem = false) => `
      <label>Model
        <select name="${name}">
          ${(isSystem ? allowedModelsSystem : allowedModelsStyle).map(m => `<option value="${m}" ${String(selected || '') === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </label>
    `;
    const renderScopeSelect = (name, selected) => `
      <label>Scope
        <select name="${name}">
          ${['location','catchment','icon'].map(s => `<option value="${s}" ${String(selected || 'location') === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
      </label>
    `;

    res.set('Cache-Control', 'no-store');

    res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>Prompts Configuration</title>
          <style>
            :root{
              --bg:#0b0d11;--panel:#151922;--panel2:#11151c;--border:#202636;--muted:#9aa4b2;--ink:#e7ecf3;
              --btn:#6aa4ff;--danger:#ef4444;--ok:#10b981;--warn:#f59e0b
            }
            *{box-sizing:border-box}
            html,body{height:100%}
            body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;padding-top:56px}
            .topbar{position:fixed;left:0;right:0;top:0;height:56px;display:flex;align-items:center;gap:12px;background:linear-gradient(180deg,rgba(11,13,17,.95),rgba(11,13,17,.6) 70%,transparent);border-bottom:1px solid var(--border);padding:8px 14px;z-index:60;backdrop-filter:saturate(120%) blur(6px)}
            .brand{font-weight:800;letter-spacing:.02em}
            .nav{display:flex;gap:10px;align-items:center}
            .nav a{color:#8ab4ff;text-decoration:none;font-weight:600;padding:6px 10px;border-radius:8px;border:1px solid transparent}
            .nav a:hover{background:rgba(138,180,255,.08);border-color:rgba(138,180,255,.2)}
            .wrap{max-width:1100px;margin:20px auto;padding:0 16px 40px}
            h1{font-size:18px;margin:18px 0 10px}
            h2{font-size:16px;margin:24px 0 10px;color:#cdd6e3}
            form{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px 12px 14px;margin:10px 0 18px}
            label{font-weight:600;color:#cdd6e3}
            textarea, input[type="text"]{width:100%;background:#0f1320;border:1px solid #283044;border-radius:8px;color:var(--ink);padding:8px}
            textarea:focus, input[type="text"]:focus{outline:2px solid rgba(106,164,255,.35);border-color:#35507c}
            .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
            .muted{color:var(--muted)}
            .btn{background:var(--btn);border:0;border-radius:10px;color:#fff;padding:10px 16px;font-weight:700;cursor:pointer}
            .btn[disabled]{opacity:.6;cursor:not-allowed}
            .group{border:1px dashed var(--border);border-radius:10px;padding:10px;margin:8px 0}
          </style>
        </head>
        <body>
          <header class="topbar">
            <div class="brand">Art Factory</div>
            <nav class="nav">
              <a href="/admin/style-prompts-ui">Style Prompts</a>
              <a href="#" onclick="(function(){ const id=prompt('Catchment ID'); if(id) location.href='/admin/moderate/'+encodeURIComponent(id) })()">Moderate Photos</a>
              <a href="#" onclick="(function(){ const id=prompt('Catchment ID'); if(id) location.href='/admin/moderate-artwork/'+encodeURIComponent(id) })()">Moderate Artwork</a>
            </nav>
          </header>
          <div class="wrap">
            <h1>System Prompts</h1>
          <form method="POST" action="/admin/system-prompts-ui/update">
            ${systemPrompts.map(p => `
              <div>
                <label for="${p.key}">${p.key}</label><br/>
                <textarea name="${p.key}" rows="3" cols="80">${escapeHtml(p.text)}</textarea><br/>
                ${renderModelSelect(`model_${p.key}`, p.model, true)}<br/>
              </div>
            `).join('')}
            <button type="submit">Save System Prompts</button>
          </form>

          <h1>Style Prompts</h1>
          <form method="POST" action="/admin/style-prompts-ui/update">
            ${stylePrompts.map(p => `
              <div>
                <label for="style-${p.id}">Prompt #${p.id}</label><br/>
                <textarea name="text_${p.id}" rows="2" cols="80">${escapeHtml(p.text)}</textarea><br/>
                ${renderModelSelect(`model_${p.id}`, p.model)}<br/>
                ${renderScopeSelect(`scope_${p.id}`, p.scope)}<br/>
                <label>
                  <input type="checkbox" name="enabled_${p.id}" ${p.enabled ? 'checked' : ''}/> Enabled
                </label>
              </div>
            `).join('')}
            <button type="submit">Save Style Prompts</button>
          </form>

          <h2>Add New Style Prompt</h2>
          <form method="POST" action="/admin/style-prompts-ui/create">
            <div>
              <label for="new-style-text">New Prompt Text</label><br/>
              <textarea id="new-style-text" name="text" rows="2" cols="80"></textarea><br/>
              ${renderModelSelect('model', null)}<br/>
              ${renderScopeSelect('scope', 'location')}<br/>
              <label>
                <input type="checkbox" name="enabled" checked/> Enabled
              </label>
            </div>
            <button type="submit">Add Style Prompt</button>
          </form>
          </div>
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
    // Build a lookup of current enabled states so we don't clobber them on save
    const currentList = await getSystemPrompts();
    const enabledByKey = Object.fromEntries(currentList.map(p => [p.key, !!p.enabled]));

    const allowedModelsSystem = ['gpt-4o-mini','gpt-4o','gpt-4.1-mini','gpt-4.1','gpt-5','gpt-5-mini','gpt-5-nano'];
    const normModel = (m) => (allowedModelsSystem.includes(String(m || '')) ? String(m) : null);

    console.log('SystemPrompt Update body:', req.body);

    for (const p of currentList) {
      const key = p.key;
      const text = req.body[key] ?? '';
      const model = normModel(req.body[`model_${key}`]);
      const enabled = enabledByKey.hasOwnProperty(key) ? enabledByKey[key] : true;
      await updateSystemPrompt(key, text || "", enabled, model);
    }

    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

  
// Handle updates for style prompts
router.post('/admin/style-prompts-ui/update', async (req, res, next) => {
  try {
    const allowedModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
    const normModel = (m) => (allowedModels.includes(String(m || '')) ? String(m) : null);
    const normScope = (s) => (['location','catchment','icon'].includes(String(s || 'location')) ? String(s || 'location') : 'location');

    for (const key of Object.keys(req.body)) {
      if (key.startsWith('text_')) {
        const id = key.split('_')[1];
        const text = req.body[`text_${id}`];
        const enabled = req.body[`enabled_${id}`] !== undefined;
        const model = normModel(req.body[`model_${id}`]);
        const scope = normScope(req.body[`scope_${id}`]);

        if (text !== undefined || model !== null || scope) {
          await updateStylePrompt(id, text, model, scope);
        }
        await toggleStylePrompt(id, enabled);
      }
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

/**
 * Create a new style prompt from the UI
 */
router.post('/admin/style-prompts-ui/create', async (req, res, next) => {
  try {
    const text = req.body?.text;
    const enabled = req.body?.enabled !== undefined;
    const allowedModels = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];
    const modelInput = req.body?.model;
    const model = allowedModels.includes(String(modelInput || '')) ? String(modelInput) : null;
    const scope = (['location','catchment','icon'].includes(String(req.body?.scope || 'location')) ? String(req.body?.scope || 'location') : 'location');

    if (typeof text === 'string' && text.trim().length > 0) {
      await createStylePrompt(text.trim(), enabled, model, scope);
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

export default router;
