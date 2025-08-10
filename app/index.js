
import express from 'express';
import db from './db/client.js';
import { env } from './config/env.js';
import { qCatchment } from './queue/queues.js';
import './queue/workers.js'; // spin up processors
console.log('REDIS_URL present?', Boolean(process.env.REDIS_URL));

const app = express();
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));

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
              <th>Loc</th>
              <th>Photos</th>
              <th>Art</th>
              <th>Published</th>
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

    async function load(){
      try{
        const data = await json('/admin/recent');
        envHint.textContent = 'REDIS_URL: ' + (data.redisPresent ? 'set' : 'missing') + ' · DB: ' + (data.dbOk ? 'ok' : 'err');
        tblBody.innerHTML = '';
        for(const row of data.rows){
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><b>${row.name}</b><div class="small muted">${new Date(row.created_at).toLocaleString()}</div></td>
            <td>${row.locations}</td>
            <td>${row.photos_kept}/${row.photos_total}</td>
            <td>${row.artworks}</td>
            <td>${row.published}</td>
            <td><button data-requeue="${row.id}">Requeue</button></td>`;
          tblBody.appendChild(tr);
        }
        lastUpdated.textContent = new Date().toLocaleTimeString();
      }catch(e){ msg.textContent = 'Load failed: ' + e.message; }
    }

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
    setInterval(load, 4000);
  </script>
  </html>`);
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
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

// ---------- Optional API key auth for write endpoints ----------
function requireApiKey(req, res, next) {
  const expected = env.ingestKey; // set to enable
  if (!expected) return next();
  const provided = req.headers['x-api-key'];
  if (provided !== expected) {
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
    const { valid, errors, name, lat, lon, intro } = validateCatchmentBody(req.body);
    if (!valid) return res.status(400).json({ error: 'invalid_request', details: errors });

    const insert = await db('catchments')
      .insert({ name, lat, lon, intro })
      .returning(['id']);
    const id = insert?.[0]?.id;
    if (!id) throw new Error('Failed to create catchment');

    // Enqueue stage 1 explicitly (idempotent jobId)
    await qCatchment.add('catchment', { catchmentId: id }, { jobId: `catchment:${id}` });

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
      break;
    default:
      return res.status(400).send('bad stage');
  }
  res.send('queued');
});

// ---------- Admin data for UI ----------
app.get('/admin/recent', async (_req, res, next) => {
  try {
    // last 20 catchments with rollup counts
    const rows = await db
      .select(
        'c.id', 'c.name', 'c.created_at',
        db.raw('COALESCE(lc.cnt,0) as locations'),
        db.raw('COALESCE(pc.total,0) as photos_total'),
        db.raw('COALESCE(pc.kept,0) as photos_kept'),
        db.raw('COALESCE(ac.artworks,0) as artworks'),
        db.raw('COALESCE(ac.published,0) as published')
      )
      .from({ c: 'catchments' })
      .leftJoin(
        db({ lc: db.raw(`(
          select catchment_id, count(*) as cnt
          from locations
          group by catchment_id
        ) lc`) }), 'lc.catchment_id', 'c.id'
      )
      .leftJoin(
        db({ pc: db.raw(`(
          select l.catchment_id,
                 count(*) as total,
                 sum(case when p.kept then 1 else 0 end) as kept
          from photos p
          join locations l on l.id = p.location_id
          group by l.catchment_id
        ) pc`) }), 'pc.catchment_id', 'c.id'
      )
      .leftJoin(
        db({ ac: db.raw(`(
          select l.catchment_id,
                 count(*) as artworks,
                 sum(case when a.published then 1 else 0 end) as published
          from artwork a
          join photos p on p.id = a.photo_id
          join locations l on l.id = p.location_id
          group by l.catchment_id
        ) ac`) }), 'ac.catchment_id', 'c.id'
      )
      .orderBy('c.created_at', 'desc')
      .limit(20);

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
app.use((err, _req, res, _next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'internal_error' });
});

// ---------- Startup ----------
const PORT = env.port || 3000;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Art-factory listening on http://${HOST}:${PORT}`);
});

export default app;