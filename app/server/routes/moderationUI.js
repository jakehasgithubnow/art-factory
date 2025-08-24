import express from 'express';

const router = express.Router();

// Moderation UI for photos - by location, 20 at a time, default pass, flip to fail, submit "Next"
router.get('/admin/moderate/:catchmentId', async (req, res, next) => {
  const { catchmentId } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Moderate Photos</title>
<style>
  :root{
    --bg:#0b0d11;--panel:#151922;--border:#202636;--muted:#9aa4b2;--ink:#e7ecf3;
    --btn:#6aa4ff;--danger:#ef4444;--ok:#10b981;--warn:#f59e0b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;padding-top:56px}
  .topbar{position:fixed;left:0;right:0;top:0;height:56px;display:flex;align-items:center;gap:12px;background:linear-gradient(180deg,rgba(11,13,17,.95),rgba(11,13,17,.6) 70%,transparent);border-bottom:1px solid var(--border);padding:8px 14px;z-index:60;backdrop-filter:saturate(120%) blur(6px)}
  .brand{font-weight:800;letter-spacing:.02em}
  .nav{display:flex;gap:10px;align-items:center}
  .nav a{color:#8ab4ff;text-decoration:none;font-weight:600;padding:6px 10px;border-radius:8px;border:1px solid transparent}
  .nav a:hover{background:rgba(138,180,255,.08);border-color:rgba(138,180,255,.2)}
  .wrap{max-width:1200px;margin:20px auto;padding:0 16px 88px}
  h1{font-size:18px;margin:12px 0}
  .muted{color:var(--muted)}
  .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  input{width:100%;max-width:420px;background:#0f1320;border:1px solid #283044;border-radius:8px;color:#e7ecf3;padding:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:12px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;position:relative;outline:2px solid transparent;transition:outline-color .12s ease, transform .06s ease}
  .card:hover{transform:translateY(-1px)}
  .img{width:100%;height:180px;object-fit:cover;display:block;background:#0f1320}
  .icon-token{position:absolute;left:8px;top:8px;width:28px;height:28px;border-radius:8px;background:rgba(11,13,17,.75);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-weight:800;color:#d1d5db;z-index:10;cursor:pointer;user-select:none}
  .card.icon .icon-token{background:rgba(99,102,241,.2);color:#ffd166;border-color:rgba(99,102,241,.5)}
  .card.fail .icon-token{opacity:.5}
  .meta{padding:10px;display:flex;justify-content:space-between;align-items:center}
  .badge{font-size:12px;font-weight:700;border-radius:999px;padding:4px 8px;letter-spacing:.02em}
  .badge.pass{background:rgba(16,185,129,.18);color:#b1f3d9;border:1px solid rgba(16,185,129,.35)}
  .badge.fail{background:rgba(239,68,68,.18);color:#fecaca;border:1px solid rgba(239,68,68,.35)}
  .card.fail .img{filter:grayscale(.6) contrast(.8) brightness(.9)}
  .card.fail{outline-color:rgba(239,68,68,.5)}
  .strike{position:absolute;inset:0;display:none;pointer-events:none}
  .card.fail .strike{display:block}
  .strike:before,.strike:after{content:"";position:absolute;left:10%;right:10%;top:50%;height:2px;background:rgba(239,68,68,.8)}
  .strike:after{transform:rotate(90deg)}
  .small{font-size:12px}
  .cta{position:fixed;left:0;right:0;bottom:0;background:rgba(11,13,17,.9);backdrop-filter:saturate(120%) blur(10px);border-top:1px solid var(--border)}
  .cta-inner{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .btn{background:var(--btn);border:0;border-radius:10px;color:#fff;padding:10px 16px;font-weight:700;cursor:pointer}
  .btn[disabled]{opacity:.6;cursor:not-allowed}
  .counts{display:flex;gap:10px;align-items:center}
  .pill{border:1px solid var(--border);border-radius:999px;padding:6px 10px}
  .kpis{display:flex;gap:16px;align-items:center}
  a.link{color:#8ab4ff;text-decoration:none}
  .empty{padding:48px 16px;background:var(--panel);border:1px dashed var(--border);border-radius:12px;text-align:center}
</style>
<header class="topbar">
  <div class="brand">Art Factory</div>
  <nav class="nav">
    <a href="/admin/style-prompts-ui">Style Prompts</a>
    <a href="#" onclick="(function(){ const id=prompt('Catchment ID'); if(id) location.href='/admin/moderate/'+encodeURIComponent(id) })()">Moderate Photos</a>
    <a href="#" onclick="(function(){ const id=prompt('Catchment ID'); if(id) location.href='/admin/moderate-artwork/'+encodeURIComponent(id) })()">Moderate Artwork</a>
  </nav>
</header>

<div class="wrap">
  <h1>Moderate Photos</h1>
  <div class="row">
    <div class="muted small">Catchment: ${catchmentId}</div>
    <div class="muted small">Location: <span id="locName">…</span></div>
    <div class="muted small" id="searchTermWrap" style="display:none">Openverse search: <span id="searchTerm">—</span></div>
    <div class="muted small" id="remainingWrap" style="display:none">Remaining in this location: <span id="remaining">0</span></div>
  </div>
  <div style="margin:10px 0">
    <input id="apiKey" placeholder="x-api-key (required if INGEST_KEY set)"/>
  </div>
  <div id="grid" class="grid"></div>
  <div id="done" class="empty" style="display:none">
    <div style="font-weight:700;margin-bottom:6px">All locations reviewed</div>
    <div class="muted">No more photos need moderation in this catchment.</div>
  </div>
</div>

<div class="cta">
  <div class="cta-inner">
    <div class="kpis">
      <div class="pill counts"><span class="muted small">Pass</span>&nbsp;<strong id="passCount">0</strong></div>
      <div class="pill counts"><span class="muted small">Fail</span>&nbsp;<strong id="failCount">0</strong></div>
      <div class="muted small" id="hint">Tap a card to toggle pass/fail • Tap star to mark Icon</div>
    </div>
    <button id="nextBtn" class="btn">Next</button>
  </div>
</div>

<script>
const catchmentId = ${JSON.stringify(catchmentId)};
const apiKeyInput = document.getElementById('apiKey');
const grid = document.getElementById('grid');
const locNameEl = document.getElementById('locName');
const remainingWrap = document.getElementById('remainingWrap');
const remainingEl = document.getElementById('remaining');
const searchTermWrap = document.getElementById('searchTermWrap');
const searchTermEl = document.getElementById('searchTerm');
const passCountEl = document.getElementById('passCount');
const failCountEl = document.getElementById('failCount');
const nextBtn = document.getElementById('nextBtn');
const doneEl = document.getElementById('done');

let current = { location: null, photos: [] };

async function j(url, opts={}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function cardHTML(p) {
  // default to PASS regardless of previous kept value
  const computedOvThumb = (!p?.ov_thumbnail && p?.ov_id)
    ? \`https://api.openverse.org/v1/images/\${p.ov_id}/thumb/\`
    : null;
  const src = p?.ov_thumbnail || p?.thumbnail_url || computedOvThumb || p?.src_url;

  try {
    if (src === p?.src_url) {
      console.warn('ui_thumb_fallback_fullres', {
        id: p?.id,
        provider: p?.ov_provider || p?.provider || null,
        hasOvThumb: !!p?.ov_thumbnail || !!computedOvThumb,
        hasLegacyThumb: !!p?.thumbnail_url,
        ov_id: p?.ov_id || null,
        srcUrl: p?.src_url
      });
    } else {
      console.info('ui_thumb_used', {
        id: p?.id,
        used: p?.ov_thumbnail ? 'ov_thumbnail' : (p?.thumbnail_url ? 'thumbnail_url' : 'computed_ov_thumb')
      });
    }
  } catch (_) {}

  return \`
  <div class="card\${p.icon ? ' icon' : ''}" id="card-\${p.id}" data-id="\${p.id}">
    <div class="icon-token" title="Mark as app icon">★</div>
    <div class="strike"></div>
    <img class="img" src="\${src}" alt="" loading="lazy" decoding="async"/>
    <div class="meta">
      <div class="small muted">score: \${(typeof p.score === 'number' && Number.isFinite(p.score)) ? p.score.toFixed(2) : ((p.score != null && p.score !== '') ? p.score : 0)}</div>
      <div class="badge pass">PASS</div>
    </div>
  </div>\`;
}

function render() {
  if (!current.location) return;
  locNameEl.textContent = current.location.name || '—';
  const st = current.location.search_term || '';
  if (st) {
    searchTermWrap.style.display = 'inline-flex';
    searchTermEl.textContent = st;
  } else {
    searchTermWrap.style.display = 'none';
    searchTermEl.textContent = '—';
  }
  const html = Array.isArray(current.photos)
    ? current.photos.map(p => {
        try { return cardHTML(p); }
        catch (e) { try { console.error('card_render_error', { id: p?.id, e }); } catch (_) {} return ''; }
      }).join('')
    : '';
  grid.innerHTML = html;
  doneEl.style.display = 'none';
  // update counts (all pass by default)
  updateCounts();
}

function updateCounts() {
  const cards = Array.from(grid.querySelectorAll('.card'));
  const fail = cards.filter(c => c.classList.contains('fail')).length;
  const pass = cards.length - fail;
  passCountEl.textContent = pass;
  failCountEl.textContent = fail;
}

function setBadge(card) {
  const badge = card.querySelector('.badge');
  if (!badge) return;
  if (card.classList.contains('fail')) {
    badge.textContent = 'FAIL';
    badge.classList.remove('pass');
    badge.classList.add('fail');
  } else {
    badge.textContent = 'PASS';
    badge.classList.remove('fail');
    badge.classList.add('pass');
  }
}

grid.addEventListener('click', (ev) => {
  const card = ev.target.closest('.card');
  if (!card) return;

  // If clicking the icon token, toggle icon state only
  if (ev.target.closest('.icon-token')) {
    const newIcon = !card.classList.contains('icon');
    card.classList.toggle('icon', newIcon);
    updateCounts();
    return;
  }

  // Otherwise toggle fail on card click
  const willFail = !card.classList.contains('fail');
  card.classList.toggle('fail', willFail);
  if (willFail) {
    // Clear icon when marking as fail to avoid confusion
    card.classList.remove('icon');
  }
  setBadge(card);
  updateCounts();
});

nextBtn.addEventListener('click', async () => {
  if (!current.location) return;
  try {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Saving…';
    // Build decisions for all visible photos
    const decisions = current.photos.map(p => {
      const el = document.getElementById('card-' + p.id);
      const kept = el ? !el.classList.contains('fail') : true;
      const icon = el ? el.classList.contains('icon') : false;
      return { id: p.id, kept, icon };
    });
    await j('/moderate/location/' + current.location.id, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKeyInput.value || ''
      },
      body: JSON.stringify({ decisions, catchmentId })
    });
    await loadNext();
  } catch (e) {
    alert(e.message || 'Save failed');
  } finally {
    nextBtn.disabled = false;
    nextBtn.textContent = 'Next';
  }
});

async function loadNext() {
  locNameEl.textContent = '…';
  searchTermWrap.style.display = 'none';
  searchTermEl.textContent = '…';
  passCountEl.textContent = '0';
  failCountEl.textContent = '0';
  grid.innerHTML = '';
  const data = await j('/admin/photos/next?catchmentId=' + encodeURIComponent(catchmentId) + '&t=' + Date.now());
  if (data.done) {
    current = { location: null, photos: [] };
    remainingWrap.style.display = 'none';
    doneEl.style.display = 'block';
    return;
  }
  current = { location: data.location, photos: data.photos || [] };
  remainingWrap.style.display = (typeof data.remaining === 'number') ? 'inline-flex' : 'none';
  if (typeof data.remaining === 'number') remainingEl.textContent = data.remaining;
  render();
}

loadNext();
</script>
</html>`);
  } catch (err) {
    next(err);
  }
});

export default router;
