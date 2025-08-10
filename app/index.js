import express from 'express';
import db from './db/client.js';
import { env } from './config/env.js';
import { qCatchment } from './queue/queues.js';
import { qArtwork } from './queue/queues.js';
import { qPublish } from './queue/queues.js';
import { uploadImage } from './services/cloudinary.js';
import './queue/workers.js'; // spin up processors
import { randomUUID } from 'crypto';
console.log('REDIS_URL present?', Boolean(process.env.REDIS_URL));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------- Basic structured request logging ----------
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = randomUUID();
  req.requestId = requestId;
  req.log = (data = {}) => {
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        requestId,
        method: req.method,
        path: req.path,
        ...data,
      }));
    } catch (_) {
      // best-effort logging
    }
  };
  req.log({ event: 'request_start' });
  res.on('finish', () => {
    req.log({ event: 'request_end', status: res.statusCode, duration_ms: Date.now() - start });
  });
  next();
});

// ---------- Moderation UI ----------
app.get('/admin/moderate/:catchmentId', async (req, res, next) => {
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

// ---------- Artwork Moderation UI ----------
app.get('/admin/moderate-artwork/:catchmentId', async (req, res, next) => {
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
    card.innerHTML = `
      <img class="img" src="${mock||a.image_url}" alt=""/>
      <div class="meta">
        <div class="row"><div>${a.location_name||''}</div></div>
        <div class="row">
          <button data-act="approve" data-id="${a.id}">Approve</button>
          <button class="reject" data-act="reject" data-id="${a.id}">Reject</button>
        </div>
      </div>`;
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

// JSON for moderation grid
app.get('/admin/photos', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });
    const rows = await db('photos as p')
      .join('locations as l', 'l.id', 'p.location_id')
      .select('p.id','p.src_url','p.kept','p.score','p.processed')
      .where('l.catchment_id', catchmentId)
      .orderBy('p.created_at','desc');
    if (typeof req.log === 'function') {
      req.log({ event: 'admin_photos', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    }
    res.json({ photos: rows });
  } catch (err) {
    next(err);
  }
});

// List artworks for moderation (pending by default)
app.get('/admin/artworks', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId, status = 'pending' } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });
    const rows = await db('artwork as a')
      .join('photos as p', 'p.id', 'a.photo_id')
      .join('locations as l', 'l.id', 'p.location_id')
      .select(
        'a.id','a.image_url','a.description','a.mockup_urls','a.published','a.approved_for_publish','a.moderated_at',
        'p.id as photo_id','l.name as location_name'
      )
      .where('l.catchment_id', catchmentId)
      .modify(qb => {
        if (status === 'pending') qb.where('a.approved_for_publish', false).andWhere('a.published', false);
        if (status === 'approved') qb.where('a.approved_for_publish', true);
        if (status === 'rejected') qb.where('a.approved_for_publish', false).whereNotNull('a.moderated_at');
      })
      .orderBy('a.id','desc')
      .limit(200);
    if (typeof req.log === 'function') req.log({ event: 'admin_artworks', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    res.json({ artworks: rows });
  } catch (err) { next(err); }
});

// Approve/Reject photo
app.post('/moderate/photo/:id', requireApiKey, async (req, res, next) => {
  const { id } = req.params;
  const action = (req.body?.action || '').toString();
  const t0 = Date.now();
  let uploadedToCloudinary = false;
  let enqueuedArtwork = false;
  try {
    const photo = await db('photos').where({ id }).first();
    if (!photo) return res.status(404).json({ error: 'not_found' });

    if (action === 'reject') {
      await db('photos').where({ id }).update({ kept: false, processed: true });
      if (typeof req.log === 'function') {
        req.log({ event: 'moderate_photo', photoId: id, action: 'reject', duration_ms: Date.now() - t0 });
      }
      return res.json({ ok: true, status: 'rejected' });
    }

    if (action !== 'approve') return res.status(400).json({ error: 'bad_action' });

    // Approve: mark kept, ensure upload, then enqueue artwork
    await db('photos').where({ id }).update({ kept: true });

    if (!photo.cloudinary_id || !photo.secure_url) {
      const { public_id, secure_url } = await uploadImage(photo.src_url, {
        folder: 'art-factory/source',
        publicId: `source_${photo.id}`,
        overwrite: false,
      });
      await db('photos').where({ id }).update({ cloudinary_id: public_id, secure_url });
      uploadedToCloudinary = true;
    }

    await db('photos').where({ id }).update({ processed: true });
    await qArtwork.add('artwork', { photoId: id }, { jobId: `artwork:${id}` });
    enqueuedArtwork = true;
    if (typeof req.log === 'function') {
      req.log({ event: 'moderate_photo', photoId: id, action: 'approve', uploadedToCloudinary, enqueuedArtwork, duration_ms: Date.now() - t0 });
    }
    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    next(err);
  }
});

// Moderate generated artwork (approve => enqueue publish, reject => mark only)
app.post('/moderate/artwork/:id', requireApiKey, async (req, res, next) => {
  const { id } = req.params;
  const { action } = req.body || {};
  const t0 = Date.now();
  try {
    if (!['approve','reject'].includes(String(action))) return res.status(400).json({ error: 'bad_action' });

    if (action === 'reject') {
      await db('artwork').where({ id }).update({ approved_for_publish: false, moderated_at: db.fn.now() });
      if (typeof req.log === 'function') req.log({ event: 'moderate_artwork', artworkId: id, action: 'reject', duration_ms: Date.now() - t0 });
      return res.json({ ok: true, status: 'rejected' });
    }

    await db('artwork').where({ id }).update({ approved_for_publish: true, moderated_at: db.fn.now() });
    await qPublish.add('publish', { artworkId: id }, { jobId: `publish:${id}` });
    if (typeof req.log === 'function') req.log({ event: 'moderate_artwork', artworkId: id, action: 'approve', enqueuedPublish: true, duration_ms: Date.now() - t0 });
    res.json({ ok: true, status: 'approved' });
  } catch (err) { next(err); }
});


// ---------- Operator UI (no build step) ----------
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
  <html lang="en">
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Art Factory · Operator</title>
  <style>
    :root { --bg:#0b0d11; --panel:#151922; --text:#e7ecf3; --muted:#9aa4b2; --acc:#6aa4ff; --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; }
    html,body{height:100%}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
    .wrap{max-width:980px;margin:40px auto;padding:0 16px}
    h1{font-size:20px;margin:0 0 12px}
    .row{display:flex;gap:16px;align-items:stretch}
    .col{flex:1;background:var(--panel);border:1px solid #202636;border-radius:12px;padding:16px}
    label{display:block;font-weight:600;margin:10px 0 6px}
    input,textarea{width:100%;background:#0f1320;border:1px solid #283044;border-radius:8px;color:var(--text);padding:10px}
    button{background:var(--acc);border:0;border-radius:8px;color:#fff;padding:10px 14px;font-weight:600;cursor:pointer}
    table{width:100%;border-collapse:collapse;margin-top:8px}
    th,td{padding:8px;border-bottom:1px solid #273044}
    th{color:var(--muted);text-align:left;font-weight:600}
    .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
    .ok{background:#12361f;color:#7be49d}
    .warn{background:#3a2a13;color:#ffd99a}
    .err{background:#3a1717;color:#ff9c9c}
    .muted{color:var(--muted)}
    .small{font-size:12px}
    .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:8px}
    .kpi{background:#0f1320;border:1px solid #1f2839;border-radius:10px;padding:10px;text-align:center}
    .kpi b{display:block;font-size:18px}
    .bar{height:8px;background:#0f1320;border:1px solid #1f2839;border-radius:999px;overflow:hidden}
    .bar > i{display:block;height:100%;width:0%}
    .bar.photos > i{background:#6aa4ff}
    .bar.art > i{background:#22c55e}
    .bar.pub > i{background:#f59e0b}
  </style>
  <div class="wrap">
    <h1>Art Factory · Operator</h1>
    <div class="row">
      <div class="col" style="max-width:420px">
        <div class="small muted" id="envHint"></div>
        <label>API Key (x-api-key)</label>
        <input id="apiKey" placeholder="optional if INGEST_KEY unset"/>
        <label>Name</label>
        <input id="name" placeholder="Lisbon"/>
        <div class="row" style="gap:8px">
          <div style="flex:1">
            <label>Lat</label>
            <input id="lat" placeholder="38.7223"/>
          </div>
          <div style="flex:1">
            <label>Lon</label>
            <input id="lon" placeholder="-9.1393"/>
          </div>
        </div>
        <label>Intro (optional)</label>
        <textarea id="intro" rows="3" placeholder="A sunlit city of tiles and hills." ></textarea>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="kick">Create Catchment</button>
          <button id="refresh" type="button">Refresh</button>
        </div>
        <div id="msg" class="small" style="margin-top:8px"></div>
      </div>
      <div class="col">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="small muted">Recent</div>
          <div class="small muted" id="lastUpdated"></div>
        </div>
        <table id="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Locations</th>
              <th>Photos (kept/total)</th>
              <th>Artwork</th>
              <th>Published</th>
              <th>Progress</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>
  <script>
    const $ = s => document.querySelector(s);
    const apiKeyInput = $('#apiKey');
    const nameInput = $('#name');
    const latInput = $('#lat');
    const lonInput = $('#lon');
    const introInput = $('#intro');
    const msg = $('#msg');
    const tblBody = document.querySelector('#tbl tbody');
    const lastUpdated = $('#lastUpdated');
    const envHint = $('#envHint');

    async function json(url, opts={}){ const r = await fetch(url, opts); if(!r.ok) throw new Error(await r.text()); return r.json(); }

    function renderRows(rows){
      tblBody.innerHTML = '';
      for(const row of rows){
        const photosTotal = Number(row.photos_total)||0;
        const photosKept = Number(row.photos_kept)||0;
        const artworks = Number(row.artworks)||0;
        const published = Number(row.published)||0;
        const pPhotos = photosTotal>0 ? Math.round((photosKept/photosTotal)*100) : 0;
        const pArt = photosKept>0 ? Math.round((artworks/Math.max(photosKept,1))*100) : 0;
        const pPub = artworks>0 ? Math.round((published/Math.max(artworks,1))*100) : 0;
        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td><b>\${row.name}</b><div class="small muted">\${new Date(row.created_at).toLocaleString()}</div></td>
          <td>\${row.locations}</td>
          <td>\${photosKept}/\${photosTotal}</td>
          <td>\${artworks}</td>
          <td>\${published}</td>
          <td>
            <div class="small muted">Photos</div>
            <div class="bar photos"><i style="width:\${pPhotos}%"></i></div>
            <div class="small muted" style="margin-top:6px">Artwork</div>
            <div class="bar art"><i style="width:\${pArt}%"></i></div>
            <div class="small muted" style="margin-top:6px">Publish</div>
            <div class="bar pub"><i style="width:\${pPub}%"></i></div>
          </td>
          <td>
            <a href="/admin/moderate/\${row.id}" target="_blank">Moderate</a>
            &nbsp;
            <a href="/admin/moderate-artwork/\${row.id}" target="_blank">Moderate Artwork</a>
            &nbsp;
            <button data-requeue="\${row.id}">Requeue</button>
          </td>\`;
        tblBody.appendChild(tr);
      }
      lastUpdated.textContent = new Date().toLocaleTimeString();
    }

    async function load(){
      try{
        const data = await json('/admin/recent');
        envHint.textContent = 'REDIS_URL: ' + (data.redisPresent ? 'set' : 'missing') + ' · DB: ' + (data.dbOk ? 'ok' : 'err');
        renderRows(data.rows);
      }catch(e){ msg.textContent = 'Load failed: ' + e.message; }
    }

    // Realtime updates via SSE
    try {
      const es = new EventSource('/events');
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if(payload && payload.type === 'recent'){
            renderRows(payload.rows || []);
          }
        } catch {}
      };
      es.onerror = () => { /* fallback to polling if needed */ };
    } catch {}

    document.addEventListener('click', async (ev)=>{
      const id = ev.target?.dataset?.requeue;
      if(!id) return;
      ev.target.disabled = true;
      try{
        const r = await fetch('/requeue/catchment/' + id, { method:'POST', headers:{ 'x-api-key': apiKeyInput.value || '' } });
        if(!r.ok) throw new Error(await r.text());
        await load();
      }catch(e){ alert('Requeue failed: ' + e.message); }
      finally{ ev.target.disabled = false; }
    });

    $('#kick').addEventListener('click', async ()=>{
      msg.textContent = '';
      try{
        const body = {
          name: nameInput.value.trim(),
          lat: Number(latInput.value),
          lon: Number(lonInput.value),
          intro: introInput.value.trim() || undefined
        };
        const r = await fetch('/catchments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKeyInput.value || '' },
          body: JSON.stringify(body)
        });
        if(!r.ok) throw new Error(await r.text());
        const j = await r.json();
        msg.textContent = 'Queued catchment ' + j.id;
        nameInput.value = latInput.value = lonInput.value = introInput.value = '';
        await load();
      }catch(e){ msg.textContent = 'Submit failed: ' + e.message; }
    });

    $('#refresh').addEventListener('click', load);
    load();
  </script>
  </html>`);
});

// ---------- Server-Sent Events (SSE) for realtime operator updates ----------
app.get('/events', async (req, res, next) => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (payload) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (_) {
        // ignore
      }
    };

    // Immediately push a snapshot
    const snapshot = await db
      .select(
        'c.id', 'c.name', 'c.created_at',
        db.raw(`(select count(*) from locations l where l.catchment_id = c.id) as locations`),
        db.raw(`(select count(*) from photos p join locations l on l.id = p.location_id where l.catchment_id = c.id) as photos_total`),
        db.raw(`(select count(*) from photos p join locations l on l.id = p.location_id where l.catchment_id = c.id and p.kept) as photos_kept`),
        db.raw(`(select count(*) from artwork a join photos p on p.id = a.photo_id join locations l on l.id = p.location_id where l.catchment_id = c.id) as artworks`),
        db.raw(`(select count(*) from artwork a join photos p on p.id = a.photo_id join locations l on l.id = p.location_id where l.catchment_id = c.id and a.published) as published`)
      )
      .from({ c: 'catchments' })
      .orderBy('c.created_at', 'desc')
      .limit(20);
    send({ type: 'recent', rows: snapshot });

    // Stream periodic updates
    const intervalMs = 2000;
    const iv = setInterval(async () => {
      try {
        const rows = await db
          .select(
            'c.id', 'c.name', 'c.created_at',
            db.raw(`(select count(*) from locations l where l.catchment_id = c.id) as locations`),
            db.raw(`(select count(*) from photos p join locations l on l.id = p.location_id where l.catchment_id = c.id) as photos_total`),
            db.raw(`(select count(*) from photos p join locations l on l.id = p.location_id where l.catchment_id = c.id and p.kept) as photos_kept`),
            db.raw(`(select count(*) from artwork a join photos p on p.id = a.photo_id join locations l on l.id = p.location_id where l.catchment_id = c.id) as artworks`),
            db.raw(`(select count(*) from artwork a join photos p on p.id = a.photo_id join locations l on l.id = p.location_id where l.catchment_id = c.id and a.published) as published`)
          )
          .from({ c: 'catchments' })
          .orderBy('c.created_at', 'desc')
          .limit(20);
        send({ type: 'recent', rows });
      } catch (e) {
        // best-effort
      }
    }, intervalMs);

    req.on('close', () => {
      clearInterval(iv);
      try { res.end(); } catch {}
    });
  } catch (err) {
    next(err);
  }
});
 
// ---------- Minimal, dependency-free rate limiter ----------
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX = 60; // requests per window per IP
const rateMap = new Map(); // ip -> { count, reset }

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  let entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_WINDOW_MS };
    rateMap.set(ip, entry);
  }
  entry.count += 1;
  const remaining = Math.max(RATE_MAX - entry.count, 0);
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.reset / 1000)));
  if (entry.count > RATE_MAX) {
    if (typeof req.log === 'function') {
      req.log({ event: 'rate_limited', ip, count: entry.count, window_ms: RATE_WINDOW_MS });
    }
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

// ---------- Optional API key auth for write endpoints ----------
function requireApiKey(req, res, next) {
  const expected = env.ingestKey; // set to enable
  if (!expected) return next();
  const provided = req.headers['x-api-key'] || req.headers['x-ingest-key'];
  if (provided !== expected) {
    if (typeof req.log === 'function') {
      req.log({ event: 'auth_failed' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- Health ----------
app.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------- Helpers ----------
function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
}

function validateCatchmentBody(body) {
  const errors = [];
  const name = (body?.name ?? '').toString().trim();
  const lat = toNumber(body?.lat);
  const lon = toNumber(body?.lon);
  const intro = body?.intro ? body.intro.toString().trim() : null;

  if (!name) errors.push('name is required');
  if (!Number.isFinite(lat)) errors.push('lat must be a number');
  if (!Number.isFinite(lon)) errors.push('lon must be a number');
  if (Number.isFinite(lat) && (lat < -90 || lat > 90)) errors.push('lat out of range');
  if (Number.isFinite(lon) && (lon < -180 || lon > 180)) errors.push('lon out of range');

  return { valid: errors.length === 0, errors, name, lat, lon, intro };
}

// ---------- Ingest: create a catchment and kick off the pipeline ----------
app.post('/catchments', requireApiKey, rateLimit, async (req, res, next) => {
  try {
    const t0 = Date.now();
    const { valid, errors, name, lat, lon, intro } = validateCatchmentBody(req.body);
    if (!valid) return res.status(400).json({ error: 'invalid_request', details: errors });

    const insert = await db('catchments')
      .insert({ name, lat, lon, intro })
      .returning(['id']);
    const id = insert?.[0]?.id;
    if (!id) throw new Error('Failed to create catchment');
    if (typeof req.log === 'function') {
      req.log({ event: 'catchment_inserted', catchmentId: id });
    }
    // Enqueue stage 1 explicitly (idempotent jobId)
    await qCatchment.add('catchment', { catchmentId: id }, { jobId: `catchment:${id}` });
    if (typeof req.log === 'function') {
      req.log({ event: 'catchment_enqueued', catchmentId: id, jobId: `catchment:${id}`, duration_ms: Date.now() - t0 });
    }
    return res.status(202).json({ id });
  } catch (err) {
    next(err);
  }
});

app.post('/requeue/:stage/:id', requireApiKey, async (req, res) => {
  const { stage, id } = req.params;
  switch (stage) {
    case 'catchment':
      await qCatchment.add('catchment', { catchmentId: id }, { jobId: `catchment:${id}` });
      if (typeof req.log === 'function') {
        req.log({ event: 'requeue', stage: 'catchment', id, jobId: `catchment:${id}` });
      }
      break;
    default:
      return res.status(400).send('bad stage');
  }
  res.send('queued');
});

// ---------- Admin data for UI ----------
app.get('/admin/recent', async (_req, res, next) => {
  try {
    const t0 = Date.now();
    // last 20 catchments with rollup counts
    const rows = await db
      .select(
        'c.id', 'c.name', 'c.created_at',
        db.raw(`(
          select count(*) from locations l
          where l.catchment_id = c.id
        ) as locations`),
        db.raw(`(
          select count(*) from photos p
          join locations l on l.id = p.location_id
          where l.catchment_id = c.id
        ) as photos_total`),
        db.raw(`(
          select count(*) from photos p
          join locations l on l.id = p.location_id
          where l.catchment_id = c.id and p.kept
        ) as photos_kept`),
        db.raw(`(
          select count(*) from artwork a
          join photos p on p.id = a.photo_id
          join locations l on l.id = p.location_id
          where l.catchment_id = c.id
        ) as artworks`),
        db.raw(`(
          select count(*) from artwork a
          join photos p on p.id = a.photo_id
          join locations l on l.id = p.location_id
          where l.catchment_id = c.id and a.published
        ) as published`)
      )
      .from({ c: 'catchments' })
      .orderBy('c.created_at', 'desc')
      .limit(20);

    if (typeof _req.log === 'function') {
      _req.log({ event: 'admin_recent', count: rows.length, duration_ms: Date.now() - t0 });
    }
    res.json({
      rows,
      redisPresent: Boolean(process.env.REDIS_URL),
      dbOk: true
    });
  } catch (err) {
    return next(err);
  }
});

// ---------- Error handling ----------
// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// 500
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  try {
    const payload = {
      ts: new Date().toISOString(),
      event: 'unhandled_error',
      requestId: req?.requestId,
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    };
    console.error(JSON.stringify(payload));
  } catch (_) {
    // best-effort
    console.error('Unhandled error', err);
  }
  res.status(500).json({ error: 'internal_error' });
});

// ---------- Startup ----------
const PORT = env.port || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'app_listening', host: HOST, port: PORT, moderationEnabled: Boolean(process.env.MODERATION_ENABLED), redisPresent: Boolean(process.env.REDIS_URL) }));
});

export default app;