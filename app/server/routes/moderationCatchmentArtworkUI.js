import express from 'express';

const router = express.Router();

/**
 * UI for moderating catchment-level artwork (from catchment_artwork table)
 * Routes: GET /admin/moderate-catchment-artwork/:catchmentId
 * Uses API:
 *   - GET /admin/catchment-artworks?catchmentId=...&status=pending
 *   - POST /moderate/catchment-artwork/:id  { action: 'approve' | 'reject' }
 */
router.get('/admin/moderate-catchment-artwork/:catchmentId', async (req, res, next) => {
  const { catchmentId } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Moderate Catchment Artwork</title>
<style>
  :root{
    --bg:#0b0d11; --panel:#11151c; --panel2:#151922; --border:#202636; --muted:#9aa4b2;
    --fg:#e7ecf3; --blue:#6aa4ff; --red:#ef4444; --green:#22c55e; --shadow:0 10px 30px rgba(0,0,0,.4);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;overscroll-behavior:none}
  button{background:var(--blue);border:0;border-radius:10px;color:#fff;padding:12px 16px;font-weight:700;cursor:pointer}
  button.fail{background:var(--red)}
  button:active{transform:translateY(1px)}
  input{background:#0f1320;border:1px solid #283044;border-radius:8px;color:var(--fg);padding:8px}
  .topbar{
    position:fixed;inset:0 0 auto 0;height:56px;display:flex;align-items:center;gap:12px;
    background:linear-gradient(180deg,rgba(11,13,17,.95),rgba(11,13,17,.6) 70%,transparent);
    padding:8px 14px;z-index:40;backdrop-filter:saturate(120%) blur(6px);border-bottom:1px solid rgba(32,38,54,.5)
  }
  .title{font-size:14px;font-weight:700;opacity:.9}
  .muted{color:var(--muted)}
  .grow{flex:1}
  .viewer{
    position:fixed;inset:56px 0 90px 0; /* below topbar, above controls */
    display:flex;align-items:center;justify-content:center;overflow:hidden
  }
  #artImg{
    max-width:100vw;max-height:calc(100vh - 146px); /* 56 topbar + 90 controls */
    object-fit:contain;display:block;background:#0f1320;border-radius:14px;box-shadow:var(--shadow)
  }
  .controls{
    position:fixed;inset:auto 0 0 0;height:90px;display:flex;align-items:center;justify-content:center;gap:12px;
    background:linear-gradient(0deg,rgba(11,13,17,.95),rgba(11,13,17,.6) 70%,transparent);z-index:30;border-top:1px solid rgba(32,38,54,.5)
  }
  .pill{background:var(--panel2);border:1px solid var(--border);border-radius:999px;padding:6px 10px;color:var(--muted)}
  .empty{
    position:fixed;inset:56px 0 0 0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:16px
  }
</style>

<div class="topbar">
  <div class="title">Moderate Catchment Artwork</div>
  <div class="pill">Catchment: ${catchmentId}</div>
  <div id="location" class="pill">—</div>
  <div class="grow"></div>
  <input id="apiKey" placeholder="x-api-key (required if INGEST_KEY set)" style="min-width:260px"/>
</div>

<div id="viewer" class="viewer">
  <img id="artImg" alt="Catchment Artwork"/>
</div>

<div class="controls">
  <button id="passBtn">Pass (p)</button>
  <button id="failBtn" class="fail">Fail (f)</button>
  <div id="count" class="pill" style="margin-left:16px">0 / 0</div>
</div>

<div id="empty" class="empty" style="display:none">No pending catchment artwork. Try again later.</div>

<script>
(function(){
  const apiKeyInput = document.getElementById('apiKey');
  const artImg = document.getElementById('artImg');
  const locationEl = document.getElementById('location');
  const countEl = document.getElementById('count');
  const passBtn = document.getElementById('passBtn');
  const failBtn = document.getElementById('failBtn');
  const emptyEl = document.getElementById('empty');

  const catchmentId = ${JSON.stringify(catchmentId)};
  const PRELOAD_AHEAD = 5;

  let items = [];
  let idx = 0;
  const cache = new Map(); // id -> { art: Image }

  function showToast(msg){
    console.log('toast:', msg);
  }

  async function j(url, opts={}) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function displayUrl(a){
    try {
      const mocks = Array.isArray(a.mockup_urls) ? a.mockup_urls : (a.mockup_urls ? JSON.parse(a.mockup_urls) : []);
      const mock = Array.isArray(mocks) && mocks.length ? mocks[0] : null;
      return mock || a.image_url;
    } catch (_) {
      return a.image_url;
    }
  }

  function ensureCache(a){
    let c = cache.get(a.id);
    if (!c) { c = {}; cache.set(a.id, c); }
    if (!c.art){
      const img = new Image();
      img.decoding = 'async';
      img.loading = 'eager';
      img.src = displayUrl(a);
      c.art = img;
    }
    return c;
  }

  function preloadAhead(startIndex){
    for (let i = startIndex; i < Math.min(items.length, startIndex + PRELOAD_AHEAD + 1); i++){
      ensureCache(items[i]);
    }
  }

  function render(){
    const total = items.length;
    if (total === 0){
      emptyEl.style.display = 'flex';
      artImg.removeAttribute('src');
      locationEl.textContent = '—';
      countEl.textContent = '0 / 0';
      return;
    }
    emptyEl.style.display = 'none';

    const a = items[idx];
    const c = cache.get(a.id);
    const src = (c && c.art && c.art.complete) ? c.art.src : displayUrl(a);
    if (artImg.src !== src){
      artImg.src = src;
    }
    locationEl.textContent = a.location_name || '—';
    countEl.textContent = (idx + 1) + ' / ' + total;
  }

  function advance(){
    if (idx < items.length - 1){
      idx++;
      preloadAhead(idx);
      render();
    } else {
      showToast('All done');
      idx = items.length - 1;
      render();
    }
  }

  async function act(action){
    const a = items[idx];
    if (!a) return;
    // Optimistic advance before network
    const curId = a.id;
    advance();

    const headers = { 'Content-Type':'application/json' };
    const key = apiKeyInput.value.trim();
    if (key) headers['x-api-key'] = key;

    try {
      await fetch('/moderate/catchment-artwork/' + curId, {
        method:'POST',
        headers,
        body: JSON.stringify({ action })
      });
    } catch (e) {
      showToast('Failed to ' + (action==='approve'?'pass':'fail') + ' id ' + curId + ': ' + (e.message || 'error'));
    }
  }

  function bindHotkeys(){
    document.addEventListener('keydown', (ev)=>{
      const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'p' || ev.key === 'P'){ ev.preventDefault(); act('approve'); }
      if (ev.key === 'f' || ev.key === 'F'){ ev.preventDefault(); act('reject'); }
    });
  }

  async function load(){
    try{
      const data = await j('/admin/catchment-artworks?catchmentId=' + encodeURIComponent(catchmentId) + '&status=pending');
      items = Array.isArray(data.artworks) ? data.artworks : [];
      idx = 0;
      if (items.length > 0){
        ensureCache(items[0]);
        preloadAhead(0);
      }
      render();
    }catch(e){
      showToast('Failed to load catchment artworks: ' + e.message);
      items = [];
      idx = 0;
      render();
    }
  }

  passBtn.addEventListener('click', ()=> act('approve'));
  failBtn.addEventListener('click', ()=> act('reject'));

  bindHotkeys();
  load();
})();
</script>
</html>`);
  } catch (err) {
    next(err);
  }
});

export default router;
