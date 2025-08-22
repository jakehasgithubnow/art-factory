import express from 'express';

const router = express.Router();

// Moderation UI for artwork - single item fullscreen review
router.get('/admin/moderate-artwork/:catchmentId', async (req, res, next) => {
  const { catchmentId } = req.params;
  try {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html>
<html lang="en">
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Moderate Artwork</title>
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
  .metaRow{position:fixed;left:12px;bottom:96px;color:var(--muted);font-size:12px;z-index:20}
  .photoContainer{
    position:fixed;top:10px;right:10px;z-index:50;display:none; /* toggled via JS */
  }
  .photoContainer img{
    display:block;width:160px;height:160px;object-fit:cover;border-radius:12px;border:1px solid var(--border);box-shadow:var(--shadow);background:#0f1320
  }
  /* Invisible hot corner to toggle photo visibility */
  .hotCorner{
    position:fixed;top:0;right:0;width:160px;height:160px;z-index:60;background:transparent;cursor:pointer;
  }
  .toast{
    position:fixed;right:12px;bottom:102px;background:#1b2230;border:1px solid #2c3650;color:#e7ecf3;border-radius:10px;padding:10px 12px;z-index:70;
    display:none;max-width:60vw;box-shadow:var(--shadow);font-size:12px
  }
  .empty{
    position:fixed;inset:56px 0 0 0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:16px
  }
</style>

<div class="topbar">
  <div class="title">Moderate Artwork</div>
  <div class="pill">Catchment: ${catchmentId}</div>
  <div id="location" class="pill">—</div>
  <div class="grow"></div>
  <input id="apiKey" placeholder="x-api-key (required if INGEST_KEY set)" style="min-width:260px"/>
</div>

<div id="viewer" class="viewer">
  <img id="artImg" alt="Artwork"/>
  <div id="photoContainer" class="photoContainer" aria-hidden="true" tabindex="-1">
    <img id="photoThumb" alt="Source photo (Openverse thumbnail)"/>
  </div>
  <div id="hotCorner" class="hotCorner" title="Toggle source photo (z)"></div>
</div>

<div class="controls">
  <button id="passBtn">Pass (p)</button>
  <button id="failBtn" class="fail">Fail (f)</button>
  <div id="count" class="pill" style="margin-left:16px">0 / 0</div>
</div>

<div id="toast" class="toast"></div>
<div id="empty" class="empty" style="display:none">No pending artwork. Try again later.</div>

<script>
(function(){
  const apiKeyInput = document.getElementById('apiKey');
  const artImg = document.getElementById('artImg');
  const locationEl = document.getElementById('location');
  const countEl = document.getElementById('count');
  const passBtn = document.getElementById('passBtn');
  const failBtn = document.getElementById('failBtn');
  const toast = document.getElementById('toast');
  const photoContainer = document.getElementById('photoContainer');
  const photoThumb = document.getElementById('photoThumb');
  const hotCorner = document.getElementById('hotCorner');
  const emptyEl = document.getElementById('empty');

  const PRELOAD_AHEAD = 5;

  let items = [];
  let idx = 0;
  let showPhoto = false;
  const cache = new Map(); // id -> { art: Image, thumb: Image }

  function showToast(msg){
    toast.textContent = msg;
    toast.style.display='block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{ toast.style.display='none'; }, 3000);
  }

  function j(u, opt){ return fetch(u, opt).then(async r => { if(!r.ok){ const t = await r.text().catch(()=>r.statusText); throw new Error(t || ('HTTP '+r.status)); } return r.json(); }); }

  function safeParseJson(v){
    if (Array.isArray(v)) return v;
    if (!v) return [];
    try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch(e){ return []; }
  }

  function displayUrl(a){
    const mocks = safeParseJson(a.mockup_urls);
    const mock = mocks.length ? mocks[0] : null;
    return mock || a.image_url;
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
    if (a.photo_thumbnail_url && !c.thumb){
      const t = new Image();
      t.decoding = 'async';
      t.loading = 'eager';
      t.src = a.photo_thumbnail_url;
      c.thumb = t;
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
      document.body.classList.add('empty-state');
      artImg.removeAttribute('src');
      locationEl.textContent = '—';
      countEl.textContent = '0 / 0';
      photoContainer.style.display = 'none';
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

    if (showPhoto && a.photo_thumbnail_url){
      if (!photoThumb.src || photoThumb.src !== a.photo_thumbnail_url){
        const ct = cache.get(a.id);
        photoThumb.src = (ct && ct.thumb) ? ct.thumb.src : a.photo_thumbnail_url;
      }
      photoContainer.style.display = 'block';
      photoContainer.setAttribute('aria-hidden','false');
    } else {
      photoContainer.style.display = 'none';
      photoContainer.setAttribute('aria-hidden','true');
    }
  }

  function advance(){
    if (idx < items.length - 1){
      idx++;
      preloadAhead(idx);
      render();
    } else {
      // End of queue
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
      await fetch('/moderate/artwork/' + curId, {
        method:'POST',
        headers,
        body: JSON.stringify({ action })
      });
    } catch (e) {
      // Non-blocking error
      showToast('Failed to ' + (action==='approve'?'pass':'fail') + ' id ' + curId + ': ' + (e.message || 'error'));
    }
  }

  function togglePhoto(){
    showPhoto = !showPhoto;
    render();
  }

  function bindHotkeys(){
    document.addEventListener('keydown', (ev)=>{
      const tag = (ev.target && ev.target.tagName) ? ev.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'p' || ev.key === 'P'){ ev.preventDefault(); act('approve'); }
      if (ev.key === 'f' || ev.key === 'F'){ ev.preventDefault(); act('reject'); }
      if (ev.key === 'z' || ev.key === 'Z'){ ev.preventDefault(); togglePhoto(); }
    });
  }

  function persistApiKey(){
    const saved = localStorage.getItem('xApiKey') || '';
    if (saved) apiKeyInput.value = saved;
    apiKeyInput.addEventListener('input', ()=>{
      localStorage.setItem('xApiKey', apiKeyInput.value || '');
    });
  }

  async function load(){
    try{
      const data = await j('/admin/artworks?catchmentId=${catchmentId}&status=pending');
      items = Array.isArray(data.artworks) ? data.artworks : [];
      idx = 0;
      if (items.length > 0){
        // seed cache and preload
        ensureCache(items[0]);
        preloadAhead(0);
      }
      render();
    }catch(e){
      showToast('Failed to load artworks: ' + e.message);
      items = [];
      idx = 0;
      render();
    }
  }

  // Wire up
  passBtn.addEventListener('click', ()=> act('approve'));
  failBtn.addEventListener('click', ()=> act('reject'));
  hotCorner.addEventListener('click', togglePhoto);

  bindHotkeys();
  persistApiKey();
  load();
})();
</script>
</html>`);
  } catch (err) { next(err); }
});

export default router;
