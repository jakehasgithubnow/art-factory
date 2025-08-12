import express from 'express';

const router = express.Router();

// Moderation UI for artwork
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
  body{margin:0;background:#0b0d11;color:#e7ecf3;font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:1080px;margin:20px auto;padding:0 16px}
  h1{font-size:18px;margin:12px 0}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
  .card{background:#151922;border:1px solid #202636;border-radius:12px;overflow:hidden}
  .img{width:100%;height:220px;object-fit:cover;display:block;background:#0f1320}
  .meta{padding:10px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  button{background:#6aa4ff;border:0;border-radius:8px;color:#fff;padding:8px 10px;font-weight:600;cursor:pointer}
  .reject{background:#ef4444}
  input{width:100%;background:#0f1320;border:1px solid #283044;border-radius:8px;color:#e7ecf3;padding:8px;margin-bottom:8px}
  .muted{color:#9aa4b2}
</style>
<div class="wrap">
  <h1>Moderate Artwork</h1>
  <div class="muted">Catchment: ${catchmentId}</div>
  <div style="max-width:420px;margin:10px 0">
    <input id="apiKey" placeholder="x-api-key (required if INGEST_KEY set)"/>
  </div>
  <div id="grid" class="grid"></div>
</div>
<script>
const apiKeyInput = document.getElementById('apiKey');
const grid = document.getElementById('grid');
async function j(u, opt){ const r = await fetch(u, opt); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function load(){
  const data = await j('/admin/artworks?catchmentId=${catchmentId}&status=pending');
  grid.innerHTML='';
  for(const a of data.artworks){
    const card=document.createElement('div'); card.className='card';
    const mock = Array.isArray(a.mockup_urls)&&a.mockup_urls.length?a.mockup_urls[0]:null;
    card.innerHTML = \`
      <img class="img" src="\${mock||a.image_url}" alt=""/>
      <div class="meta">
        <div class="row"><div>\${a.location_name||''}</div></div>
        <div class="row">
          <button data-act="approve" data-id="\${a.id}">Approve</button>
          <button class="reject" data-act="reject" data-id="\${a.id}">Reject</button>
        </div>
      </div>\`;
    grid.appendChild(card);
  }
}

grid.addEventListener('click', async (ev)=>{
  const btn = ev.target.closest('button'); if(!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  try{
    await fetch('/moderate/artwork/'+id, { method:'POST', headers:{ 'Content-Type':'application/json', 'x-api-key': apiKeyInput.value || '' }, body: JSON.stringify({ action: act }) });
    await load();
  }catch(e){ alert(e.message); }
});

load();
</script>
</html>`);
  } catch (err) { next(err); }
});

export default router;
