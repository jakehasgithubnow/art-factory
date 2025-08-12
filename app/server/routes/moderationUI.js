import express from 'express';

const router = express.Router();

// Moderation UI for photos
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
  body{margin:0;background:#0b0d11;color:#e7ecf3;font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:1080px;margin:20px auto;padding:0 16px}
  h1{font-size:18px;margin:12px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
  .card{background:#151922;border:1px solid #202636;border-radius:12px;overflow:hidden}
  .img{width:100%;height:160px;object-fit:cover;display:block;background:#0f1320}
  .meta{padding:10px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  button{background:#6aa4ff;border:0;border-radius:8px;color:#fff;padding:8px 10px;font-weight:600;cursor:pointer}
  .reject{background:#ef4444}
  input{width:100%;background:#0f1320;border:1px solid #283044;border-radius:8px;color:#e7ecf3;padding:8px;margin-bottom:8px}
  .muted{color:#9aa4b2}
</style>
<div class="wrap">
  <h1>Moderate Photos</h1>
  <div class="muted">Catchment: ${catchmentId}</div>
  <div style="max-width:420px;margin:10px 0">
    <input id="apiKey" placeholder="x-api-key (required if INGEST_KEY set)"/>
  </div>
  <div id="grid" class="grid"></div>
</div>
<script>
const apiKeyInput = document.getElementById('apiKey');
const grid = document.getElementById('grid');
async function json(url, opts={}){ const r = await fetch(url, opts); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function load(){
  const data = await json('/admin/photos?catchmentId=${catchmentId}');
  grid.innerHTML = '';
  for(const p of data.photos){
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = \`
      <img class="img" src="\${p.src_url}" alt=""/>
      <div class="meta">
        <div class="row"><div>score: \${(p.score ?? 0).toFixed ? p.score.toFixed(2) : (p.score || 0)} · kept: \${p.kept ? true : false} </div></div>
        <div class="row">
          <button data-act="approve" data-id="\${p.id}">Approve</button>
          <button class="reject" data-act="reject" data-id="\${p.id}">Reject</button>
        </div>
      </div>\`;
    grid.appendChild(card);
  }
}

grid.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest('button');
  if(!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  try{
    await fetch('/moderate/photo/' + id, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key': apiKeyInput.value || '' }, body: JSON.stringify({ action: act }) });
    await load();
  }catch(e){ alert(e.message); }
});

load();
</script>
</html>`);
  } catch (err) {
    next(err);
  }
});

export default router;
