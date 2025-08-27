import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import {
  getAll as getStylePrompts,
  createPrompt as createStylePrompt,
  updatePrompt as updateStylePrompt,
  togglePrompt as toggleStylePrompt
} from '../../../db/stylePrompts.js';
import { getAll as getSystemPrompts, updatePrompt as updateSystemPrompt } from '../../../db/systemPrompts.js';

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

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

const prettyCat = (c) => c.replace(/_/g, ' ');

const renderCategoryCheckboxes = (name, selected = []) => `
  <div class="group">
    <div class="label-row">
      <label class="label">Categories</label>
      <button
        type="button"
        class="link small"
        onclick="(function(el){ const g=el.closest('.group'); g.querySelectorAll('input[type=checkbox]').forEach(cb=>cb.checked=false) })(this)"
      >Clear</button>
    </div>
    <div class="chips">
      ${ALLOWED_CATEGORIES.map((c) => `
        <label class="chip">
          <input type="checkbox" name="${name}" value="${c}" ${Array.isArray(selected) && selected.includes(c) ? 'checked' : ''}/>
          <span>${prettyCat(c)}</span>
        </label>
      `).join('')}
    </div>
    <div class="muted">Leave none selected to apply to all categories.</div>
  </div>
`;

// Admin UI page - system prompts + style prompts
router.get('/admin/style-prompts-ui', async (req, res, next) => {
  try {
    const [stylePrompts, systemPrompts] = await Promise.all([getStylePrompts(), getSystemPrompts()]);

    // Allowed OpenAI chat models for selection
    const allowedModelsSystem = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
    const allowedModelsStyle = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'];

    const renderModelSelect = (name, selected, isSystem = false) => `
      <div class="field">
        <label class="label">Model</label>
        <select class="select" name="${name}">
          ${(isSystem ? allowedModelsSystem : allowedModelsStyle)
            .map((m) => `<option value="${m}" ${String(selected || '') === m ? 'selected' : ''}>${m}</option>`)
            .join('')}
        </select>
      </div>
    `;

    const renderScopeSelect = (name, selected) => `
      <div class="field">
        <label class="label">Scope</label>
        <select class="select" name="${name}">
          ${['location', 'catchment', 'icon']
            .map((s) => `<option value="${s}" ${String(selected || 'location') === s ? 'selected' : ''}>${s}</option>`)
            .join('')}
        </select>
      </div>
    `;

    const renderProviderSelect = (name, selected) => `
      <div class="field">
        <label class="label">Provider</label>
        <select class="select" name="${name}">
          ${['piapi','gemini']
            .map((p) => `<option value="${p}" ${String(selected || 'piapi') === p ? 'selected' : ''}>${p}</option>`)
            .join('')}
        </select>
      </div>
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
              --bg:#0b0d11;--surface:#0f1320;--panel:#121828;--panel2:#0e1422;--elev:rgba(255,255,255,0.04);
              --border:#202636;--muted:#9aa4b2;--ink:#e7ecf3;--ink-2:#cfd7e3;--accent:#6aa4ff;--accent-2:#3b82f6;
              --danger:#ef4444;--ok:#10b981;--warn:#f59e0b;
              --radius:12px; --radius-sm:10px; --pad:14px
            }
            *{box-sizing:border-box}
            html,body{height:100%}
            body{margin:0;background:radial-gradient(1200px 600px at 20% -10%, rgba(59,130,246,.08), transparent 50%),radial-gradient(1000px 700px at 110% 10%, rgba(16,185,129,.06), transparent 50%),var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
            .topbar{position:fixed;left:0;right:0;top:0;height:56px;display:flex;align-items:center;gap:14px;background:linear-gradient(180deg,rgba(11,13,17,.9),rgba(11,13,17,.65) 70%,transparent);border-bottom:1px solid var(--border);padding:8px 16px;z-index:60;backdrop-filter:saturate(120%) blur(6px)}
            .brand{font-weight:800;letter-spacing:.02em}
            .nav{display:flex;gap:10px;align-items:center}
            .nav a{color:#b7cdfc;text-decoration:none;font-weight:600;padding:6px 10px;border-radius:8px;border:1px solid transparent}
            .nav a:hover{background:rgba(138,180,255,.10);border-color:rgba(138,180,255,.2)}
            .wrap{max-width:1100px;margin:76px auto 40px;padding:0 16px}
            h1{font-size:20px;margin:24px 0 12px}
            h2{font-size:16px;margin:18px 0 10px;color:#d6deea}
            .panel{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin:12px 0 22px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
            .section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
            .muted{color:var(--muted)}
            .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
            .label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
            .label{font-weight:700;color:#d6deea}
            .field{display:flex;flex-direction:column;gap:6px;min-width:200px}
            .textarea, textarea, input[type="text"]{width:100%;background:var(--surface);border:1px solid #283044;border-radius:var(--radius-sm);color:var(--ink);padding:10px 12px}
            textarea{min-height:88px;resize:vertical}
            textarea:focus, input[type="text"]:focus, select:focus{outline:2px solid rgba(106,164,255,.35);border-color:#35507c}
            select{background:var(--surface);border:1px solid #283044;border-radius:var(--radius-sm);color:var(--ink);padding:10px 12px}
            .card{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:var(--radius);padding:12px 12px 14px;margin:12px 0}
            .card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
            .card-title{font-weight:800;color:#eef3fb}
            .badge{font-size:12px;padding:4px 8px;border-radius:999px;background:#1b2337;color:#cfe1ff;border:1px solid #2b3550}
            .chips{display:flex;flex-wrap:wrap;gap:8px}
            .chip{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid #2b3550;border-radius:999px;background:#0e1422;color:#cfe1ff;cursor:pointer;user-select:none}
            .chip input{appearance:none;width:0;height:0;position:absolute;opacity:0}
            .chip span{pointer-events:none}
            .chip:has(input:checked){background:#203056;border-color:#38558d}
            .group{border:1px dashed #283044;border-radius:var(--radius-sm);padding:10px;margin:10px 0}
            .switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
            .switch input{appearance:none;width:0;height:0;position:absolute;opacity:0}
            .switch .track{position:relative;width:44px;height:24px;background:#2a3246;border:1px solid #3a435a;border-radius:999px;transition:all .2s ease}
            .switch .track:after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;background:#cfd8e3;border-radius:50%;transition:transform .2s ease, background .2s ease}
            .switch input:checked + .track{background:#2e7d5b;border-color:#2e7d5b}
            .switch input:checked + .track:after{transform:translateX(20px);background:#fff}
            .switch .txt{color:#cfe1ff}
            .actions{display:flex;justify-content:flex-end;margin-top:12px}
            .actions.sticky{position:sticky;bottom:12px;background:linear-gradient(180deg, rgba(18,24,40,0), var(--panel) 35%);padding-top:8px;z-index:80}
            .btn{background:var(--accent);border:0;border-radius:10px;color:#fff;padding:10px 16px;font-weight:800;cursor:pointer}
            .btn:hover{background:var(--accent-2)}
            .btn.secondary{background:#2b3550}
            .btn.danger{background:var(--danger)}
            .link{background:transparent;border:0;color:#9fb8ff;cursor:pointer;padding:0}
            .small{font-size:12px}
            @media (max-width:720px){
              .field{min-width:140px}
            }
            .test-grid{display:block;margin-top:8px}
            .test-grid a{display:block;border:1px solid var(--border);background:rgba(255,255,255,.02);border-radius:12px;overflow:hidden;margin:10px 0}
            .test-img{width:100%;height:auto;object-fit:contain;display:block}
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
            <div class="section-head">
              <h1>System Prompts</h1>
              <span class="muted">Edit system-wide instructions and choose models</span>
            </div>
            <form class="panel" method="POST" action="/admin/system-prompts-ui/update">
              ${systemPrompts.map(p => `
                <div class="card">
                  <div class="card-h">
                    <div class="row">
                      <div class="card-title">${escapeHtml(p.key)}</div>
                      <span class="badge">system</span>
                    </div>
                    <div class="row">
                      ${renderModelSelect('model_' + p.key, p.model, true)}
                    </div>
                  </div>
                  <div class="field">
                    <label class="label" for="${p.key}">Prompt Text</label>
                    <textarea class="textarea" name="${p.key}" rows="3" cols="80">${escapeHtml(p.text)}</textarea>
                  </div>
                </div>
              `).join('')}
              <div class="actions">
                <button class="btn" type="submit">Save System Prompts</button>
              </div>
            </form>

            <div class="section-head">
              <h1>Style Prompts</h1>
              <span class="muted">Prompts used to generate styles; toggle, scope, categories and model</span>
            </div>
            <form class="panel" method="POST" action="/admin/style-prompts-ui/update">
              ${stylePrompts.map(p => `
                <div class="card">
                  <div class="card-h">
                    <div class="row">
                      <div class="card-title">Prompt #${p.id}${p.name ? ' — ' + escapeHtml(p.name) : ''}</div>
                      <span class="badge">${escapeHtml(p.scope || 'location')}</span>
                    </div>
                    <label class="switch">
                      <input type="checkbox" name="enabled_${p.id}" ${p.enabled ? 'checked' : ''}/>
                      <span class="track"></span>
                      <span class="txt">${p.enabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                  </div>

                  <div class="row" style="margin-bottom:8px">
                    ${renderModelSelect('model_' + p.id, p.model)}
                    ${renderScopeSelect('scope_' + p.id, p.scope)}
                    ${renderProviderSelect('provider_' + p.id, p.provider)}
                  </div>

                  ${renderCategoryCheckboxes('categories_' + p.id + '[]', Array.isArray(p.categories) ? p.categories : [])}

                  <div class="field">
                    <label class="label" for="name_${p.id}">Style Name</label>
                    <input type="text" class="textarea" name="name_${p.id}" value="${escapeHtml(p.name || '')}"/>
                  </div>

                  <div class="field">
                    <label class="label" for="style-${p.id}">Prompt Text</label>
                    <textarea class="textarea" name="text_${p.id}" rows="3" cols="80">${escapeHtml(p.text)}</textarea>
                  </div>

                  <div class="actions" style="justify-content:flex-start;gap:8px">
                    <button type="button" class="btn secondary" onclick="testStylePrompt(${p.id}, 1, this)">Test 1</button>
                    <button type="button" class="btn secondary" onclick="testStylePrompt(${p.id}, 5, this)">Test 5</button>
                    <span id="tp-status-${p.id}" class="muted small"></span>
                  </div>
                  <div class="test-grid" id="tp-grid-${p.id}"></div>
                </div>
              `).join('')}
              <div class="actions sticky">
                <button class="btn" type="submit">Save Style Prompts</button>
              </div>
            </form>

            <h2>Add New Style Prompt</h2>
            <form class="panel" method="POST" action="/admin/style-prompts-ui/create">
              <div class="card">
                <div class="card-h">
                  <div class="card-title">New Style Prompt</div>
                  <label class="switch">
                    <input type="checkbox" name="enabled" checked/>
                    <span class="track"></span>
                    <span class="txt">Enabled</span>
                  </label>
                </div>

                <div class="row" style="margin-bottom:8px">
                  ${renderModelSelect('model', null)}
                  ${renderScopeSelect('scope', 'location')}
                  ${renderProviderSelect('provider', 'piapi')}
                </div>

                ${renderCategoryCheckboxes('categories[]', [])}

                <div class="field">
                  <label class="label" for="new-style-name">Style Name</label>
                  <input id="new-style-name" type="text" class="textarea" name="name"/>
                </div>

                <div class="field">
                  <label class="label" for="new-style-text">Prompt Text</label>
                  <textarea id="new-style-text" class="textarea" name="text" rows="3" cols="80"></textarea>
                </div>
              </div>
              <div class="actions">
                <button class="btn" type="submit">Add Style Prompt</button>
              </div>
            </form>
          </div>
          <script>
            async function testStylePrompt(id, count, btn) {
              const statusEl = document.getElementById('tp-status-' + id);
              const grid = document.getElementById('tp-grid-' + id);
              if (statusEl) statusEl.textContent = 'Generating ' + (count || 5) + ' image' + ((count || 5) === 1 ? '' : 's') + '...';
              if (grid) grid.innerHTML = '';
              if (btn) btn.disabled = true;
              try {
                const resp = await fetch('/admin/style-prompts/' + id + '/test', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ count: count || 5 })
                });
                const data = await resp.json().catch(() => ({}));
                if (!resp.ok) throw new Error(data && data.error ? data.error : 'Request failed');
                const images = Array.isArray(data && data.images) ? data.images : [];
                if (images.length === 0) {
                  if (statusEl) statusEl.textContent = 'No images returned.';
                  return;
                }
                for (const url of images) {
                  const a = document.createElement('a');
                  a.href = url;
                  a.target = '_blank';
                  const img = document.createElement('img');
                  img.src = url;
                  img.loading = 'lazy';
                  img.className = 'test-img';
                  a.appendChild(img);
                  grid.appendChild(a);
                }
                if (statusEl) statusEl.textContent = 'Showing ' + images.length + ' result(s).';
              } catch (e) {
                if (statusEl) statusEl.textContent = 'Error: ' + (e && e.message ? e.message : 'failed');
              } finally {
                if (btn) btn.disabled = false;
              }
            }
          </script>
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
      const model = normModel(req.body['model_' + key]);
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
        const text = req.body['text_' + id];
        const enabled = req.body['enabled_' + id] !== undefined;
        const model = normModel(req.body['model_' + id]);
        const scope = normScope(req.body['scope_' + id]);
        // categories may be provided as categories_id or categories_id[] depending on parser
        const rawCats = (req.body['categories_' + id] !== undefined) ? req.body['categories_' + id] : req.body['categories_' + id + '[]'];
        const provider = req.body['provider_' + id];
        const name = req.body['name_' + id];

        if (text !== undefined || model !== null || scope || rawCats !== undefined || provider !== undefined || name !== undefined) {
          await updateStylePrompt(id, text, model, scope, rawCats, provider, name);
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
    const rawCats = (req.body?.categories !== undefined) ? req.body.categories : req.body?.['categories[]'];
    const provider = req.body?.provider;
    const name = req.body?.name;

    if (typeof text === 'string' && text.trim().length > 0) {
      await createStylePrompt(text.trim(), enabled, model, scope, rawCats, provider, name);
    }
    res.redirect('/admin/style-prompts-ui');
  } catch (err) {
    next(err);
  }
});

export default router;
