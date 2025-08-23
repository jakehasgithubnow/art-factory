import express from 'express';
import db from './db/client.js';
import { env } from './config/env.js';
import { qCatchment } from './queue/queues.js';
import { qArtwork } from './queue/queues.js';
import { qPublish } from './queue/queues.js';
import { qCatchmentArtwork } from './queue/queues.js';
import { uploadImage } from './services/cloudinary.js';
import './queue/workers.js'; // spin up processors
import { randomUUID } from 'crypto';

console.log('REDIS_URL present?', Boolean(process.env.REDIS_URL));
// Ensure DB column for second-stage moderation exists (safe on repeated runs)
(async () => {
  try {
    await db.raw('ALTER TABLE IF EXISTS artwork ADD COLUMN IF NOT EXISTS approved_for_publish boolean;');
    await db.raw('ALTER TABLE IF EXISTS artwork ADD COLUMN IF NOT EXISTS moderated_at timestamptz;');
    console.log('[startup] ensured artwork.approved_for_publish and artwork.moderated_at columns');
  } catch (e) {
    console.warn('[startup] failed to ensure artwork.approved_for_publish column:', e?.message || e);
  }
})();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Disable ETag and force no-store to avoid 304 caching on dynamic endpoints
app.set('etag', false);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

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

/**
 * Mount modular Artwork moderation routes first (UI + API)
 * These handle:
 *  - GET /admin/artworks
 *  - POST /moderate/artwork/:id  (approve/reject with Cloudinary delete + queue removal)
 *  - GET /admin/moderate-artwork/:catchmentId (enhanced UI with error handling)
 */
app.use('/', (await import('./server/routes/moderationArtwork.js')).default);
app.use('/', (await import('./server/routes/moderationArtworkUI.js')).default);

// ---------- Moderation UI (Photos by Location: up to 20 images, default PASS, toggle FAIL, Next) ----------
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
  :root{
    --bg:#0b0d11;--panel:#151922;--border:#202636;--muted:#9aa4b2;--ink:#e7ecf3;
    --btn:#6aa4ff;--danger:#ef4444;--ok:#10b981;--warn:#f59e0b;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
  .wrap{max-width:1200px;margin:20px auto;padding:0 16px 88px}
  h1{font-size:18px;margin:12px 0}
  .muted{color:var(--muted)}
  .row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  input{width:100%;max-width:420px;background:#0f1320;border:1px solid #283044;border-radius:8px;color:#e7ecf3;padding:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:12px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;cursor:pointer;position:relative;outline:2px solid transparent;transition:outline-color .12s ease, transform .06s ease}
  .card:hover{transform:translateY(-1px)}
  .img{width:100%;height:180px;object-fit:cover;display:block;background:#0f1320}
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
      <div class="muted small" id="hint">Tap a card to toggle pass/fail</div>
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
  const src = p?.ov_thumbnail || p?.thumbnail_url || p?.src_url;
  if (!p?.ov_thumbnail && !p?.thumbnail_url) {
    try {
      console.warn('ui_thumb_fallback_fullres', {
        id: p?.id,
        provider: p?.ov_provider || p?.provider || null,
        hasOvThumb: !!p?.ov_thumbnail,
        hasLegacyThumb: !!p?.thumbnail_url,
        srcUrl: p?.src_url
      });
    } catch (_) {}
  } else {
    try {
      console.info('ui_thumb_used', {
        id: p?.id,
        used: p?.ov_thumbnail ? 'ov_thumbnail' : 'thumbnail_url'
      });
    } catch (_) {}
  }
  return \`
  <div class="card" id="card-\${p.id}" data-id="\${p.id}">
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
  grid.innerHTML = current.photos.map(cardHTML).join('');
  doneEl.style.display = 'none';
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
  const willFail = !card.classList.contains('fail');
  card.classList.toggle('fail', willFail);
  setBadge(card);
  updateCounts();
});

nextBtn.addEventListener('click', async () => {
  if (!current.location) return;
  try {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Saving…';
    const decisions = current.photos.map(p => {
      const el = document.getElementById('card-' + p.id);
      const kept = el ? !el.classList.contains('fail') : true;
      return { id: p.id, kept };
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

// ---------- Photos API for moderation (legacy: full list) ----------
app.get('/admin/photos', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });
    const rows = await db('photos as p')
      .join('locations as l', 'l.id', 'p.location_id')
      .select(
        'p.id',
        'p.src_url',
        'p.kept',
        'p.score',
        'p.processed',
        'p.ov_id',
        'p.ov_title',
        'p.ov_creator',
        'p.ov_creator_url',
        'p.ov_license',
        'p.ov_license_version',
        'p.ov_license_url',
        'p.ov_source',
        'p.ov_category',
        'p.ov_provider',
        'p.ov_thumbnail',
        'p.ov_detail_url',
        'p.ov_width',
        'p.ov_height'
      )
      .where('l.catchment_id', catchmentId)
      .orderBy('p.created_at', 'desc');
    if (typeof req.log === 'function') {
      req.log({ event: 'admin_photos', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    }
    res.json({ photos: rows });
  } catch (err) {
    next(err);
  }
});

// ---------- New: Fetch next location with up to 20 unprocessed photos ----------
app.get('/admin/photos/next', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });

    const loc = await db('locations as l')
      .where('l.catchment_id', catchmentId)
      .whereExists(function () {
        this.select(1)
          .from('photos as p')
          .whereRaw('p.location_id = l.id')
          .andWhere(function () { this.where('p.processed', false).orWhereNull('p.processed'); });
      })
      .orderBy('l.created_at', 'asc')
      .select('l.id', 'l.name', 'l.search_term')
      .first();

    if (!loc) {
      if (typeof req.log === 'function') {
        req.log({ event: 'admin_photos_next', catchmentId, done: true, duration_ms: Date.now() - t0 });
      }
      return res.json({ done: true });
    }

    const photos = await db('photos as p')
      .where('p.location_id', loc.id)
      .andWhere(function () { this.where('p.processed', false).orWhereNull('p.processed'); })
      .orderBy('p.created_at', 'desc')
      .limit(20)
      .select(
        'p.id',
        'p.src_url',
        'p.kept',
        'p.score',
        'p.processed',
        'p.ov_id',
        'p.ov_title',
        'p.ov_creator',
        'p.ov_creator_url',
        'p.ov_license',
        'p.ov_license_version',
        'p.ov_license_url',
        'p.ov_source',
        'p.ov_category',
        'p.ov_provider',
        'p.ov_thumbnail',
        'p.ov_detail_url',
        'p.ov_width',
        'p.ov_height'
      );

    const remainingRow = await db('photos as p')
      .where('p.location_id', loc.id)
      .andWhere(function () { this.where('p.processed', false).orWhereNull('p.processed'); })
      .count({ c: '*' })
      .first();
    const remaining = Number(remainingRow?.c ?? 0);

    if (typeof req.log === 'function') {
      req.log({
        event: 'admin_photos_next',
        catchmentId,
        locationId: loc.id,
        photos: photos.length,
        remaining,
        duration_ms: Date.now() - t0
      });
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json({ location: { id: loc.id, name: loc.name, search_term: loc.search_term }, photos, remaining });
  } catch (err) {
    next(err);
  }
});

// ---------- Legacy single-photo moderation ----------
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

    await db('photos').where({ id }).update({ kept: true });

    if (!photo.cloudinary_id || !photo.secure_url) {
      try {
        const { public_id, secure_url } = await uploadImage(photo.src_url, {
          folder: 'art-factory/source',
          publicId: `source_${photo.id}`,
          overwrite: false,
        });
        await db('photos').where({ id }).update({ cloudinary_id: public_id, secure_url });
        uploadedToCloudinary = true;
      } catch (e) {
        // Upload failed: delete the photo and return ok
        await db('photos').where({ id }).del();
        if (typeof req.log === 'function') {
          req.log({ event: 'moderate_photo', photoId: id, action: 'approve', deletedDueToUploadFailure: true });
        }
        return res.json({ ok: true, status: 'deleted' });
      }
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

// ---------- New: Bulk moderation for a location (pass/fail) ----------
app.post('/moderate/location/:locationId', requireApiKey, async (req, res, next) => {
  const t0 = Date.now();
  const { locationId } = req.params;
  const { decisions, catchmentId } = req.body || {};
  try {
    if (!Array.isArray(decisions) || decisions.length === 0) {
      return res.status(400).json({ error: 'missing_decisions' });
    }

    const keepMap = new Map();
    const ids = [];
    for (const d of decisions) {
      if (!d || !d.id) continue;
      ids.push(d.id);
      keepMap.set(d.id, Boolean(d.kept));
    }
    if (ids.length === 0) {
      return res.status(400).json({ error: 'no_ids' });
    }

    const rows = await db('photos')
      .whereIn('id', ids)
      .andWhere({ location_id: locationId })
      .select('id', 'src_url', 'cloudinary_id', 'secure_url');

    const validIds = rows.map(r => r.id);
    const approveIds = validIds.filter(id => keepMap.get(id) === true);
    const rejectIds = validIds.filter(id => keepMap.get(id) === false);

    let uploadedToCloudinary = 0;
    let enqueuedArtwork = 0;
    let deletedDueToUploadFailure = 0;

    if (rejectIds.length > 0) {
      await db('photos').whereIn('id', rejectIds).update({ kept: false, processed: true });
    }

    if (approveIds.length > 0) {
      // Mark approvals as kept
      await db('photos').whereIn('id', approveIds).update({ kept: true });

      const approveRows = rows.filter(r => approveIds.includes(r.id));
      const haveAssets = approveRows.filter(r => r.cloudinary_id && r.secure_url).map(r => r.id);
      const needUpload = approveRows.filter(r => !r.cloudinary_id || !r.secure_url);

      // Already have assets: mark processed + enqueue
      if (haveAssets.length > 0) {
        await db('photos').whereIn('id', haveAssets).update({ processed: true });
        await Promise.all(
          haveAssets.map(id => qArtwork.add('artwork', { photoId: id }, { jobId: `artwork:${id}` }))
        );
        enqueuedArtwork += haveAssets.length;
      }

      // Missing assets: try upload; on failure delete and continue
      for (const p of needUpload) {
        try {
          const { public_id, secure_url } = await uploadImage(p.src_url, {
            folder: 'art-factory/source',
            publicId: `source_${p.id}`,
            overwrite: false
          });
          await db('photos').where({ id: p.id }).update({ cloudinary_id: public_id, secure_url, processed: true });
          uploadedToCloudinary++;
          await qArtwork.add('artwork', { photoId: p.id }, { jobId: `artwork:${p.id}` });
          enqueuedArtwork++;
        } catch (e) {
          // Upload failed (e.g., >10MB): delete the photo and move on
          await db('photos').where({ id: p.id }).del();
          deletedDueToUploadFailure++;
        }
      }
    }

    if (typeof req.log === 'function') {
      req.log({
        event: 'moderate_location',
        locationId,
        catchmentId: catchmentId || null,
        approved: approveIds.length,
        rejected: rejectIds.length,
        uploadedToCloudinary,
        enqueuedArtwork,
        deletedDueToUploadFailure,
        duration_ms: Date.now() - t0
      });
    }

    res.json({
      ok: true,
      approved: approveIds.length,
      rejected: rejectIds.length,
      uploadedToCloudinary,
      enqueuedArtwork,
      deletedDueToUploadFailure
    });
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
        <label>Image Source</label>
        <select id="imageSource" style="width:100%;background:#0f1320;border:1px solid #283044;border-radius:8px;color:#e7ecf3;padding:10px;margin-bottom:8px">
          <option value="google" selected>Google</option>
          <option value="openverse">Openverse</option>
        </select>
        <div id="ovCfg" style="display:none;margin:8px 0 0 0">
          <div class="small muted" style="margin-bottom:6px">Openverse search options</div>
          <div class="row" style="gap:8px">
            <div style="flex:1">
              <label>Top N</label>
              <input id="ovTopN" placeholder="20"/>
            </div>
            <div style="flex:1">
              <label>Per Page</label>
              <input id="ovPerPage" placeholder="50"/>
            </div>
            <div style="flex:1">
              <label>Max Pages</label>
              <input id="ovMaxPages" placeholder="5"/>
            </div>
          </div>
          <label>license_type (comma-separated)</label>
          <input id="ovLicenseType" placeholder="commercial,modification"/>
          <label>Extra params (JSON, optional)</label>
          <textarea id="ovExtraParams" rows="2" placeholder='{"aspect_ratio":"wide"}'></textarea>
        </div>
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
    const imageSourceSel = document.getElementById('imageSource');
    const ovCfg = document.getElementById('ovCfg');
    const ovTopN = document.getElementById('ovTopN');
    const ovPerPage = document.getElementById('ovPerPage');
    const ovMaxPages = document.getElementById('ovMaxPages');
    const ovLicenseType = document.getElementById('ovLicenseType');
    const ovExtraParams = document.getElementById('ovExtraParams');

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

    // Toggle OV config visibility
    function updateOvVisibility(){
      ovCfg.style.display = (imageSourceSel.value === 'openverse') ? 'block' : 'none';
    }
    imageSourceSel.addEventListener('change', updateOvVisibility);
    updateOvVisibility();

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
        const imgSrc = imageSourceSel.value;
        const body = {
          name: nameInput.value.trim(),
          lat: Number(latInput.value),
          lon: Number(lonInput.value),
          intro: (introInput.value || '').trim() || undefined,
          imageSource: imgSrc
        };
        if (imgSrc === 'openverse') {
          // Optional Openverse tuning from UI
          const nTop = Number(ovTopN.value);
          const nPer = Number(ovPerPage.value);
          const nMax = Number(ovMaxPages.value);
          if (Number.isFinite(nTop) && nTop > 0) body.openverseTopN = nTop;
          if (Number.isFinite(nPer) && nPer > 0) body.openversePerPage = nPer;
          if (Number.isFinite(nMax) && nMax > 0) body.openverseMaxPages = nMax;

          let params = {};
          const lic = (ovLicenseType.value || '').trim();
          if (lic) params.license_type = lic;
          try {
            const extra = (ovExtraParams.value || '').trim();
            if (extra) {
              const parsed = JSON.parse(extra);
              if (parsed && typeof parsed === 'object') params = { ...params, ...parsed };
            }
          } catch (_) { /* ignore malformed JSON */ }
          if (Object.keys(params).length > 0) body.openverseParams = params;
        }
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

    const image_source = ['google', 'openverse'].includes(req.body?.imageSource)
      ? req.body.imageSource
      : 'google';

    // Optional Openverse config from UI
    const ovTopN = Number(req.body?.openverseTopN);
    const ovPerPage = Number(req.body?.openversePerPage);
    const ovMaxPages = Number(req.body?.openverseMaxPages);
    let ovParams = {};
    if (req.body?.openverseParams && typeof req.body.openverseParams === 'object') {
      ovParams = req.body.openverseParams;
    }

    const payload = { name, lat, lon, intro, image_source };
    if (image_source === 'openverse') {
      if (Number.isFinite(ovTopN) && ovTopN > 0) payload.openverse_top_n = ovTopN;
      if (Number.isFinite(ovPerPage) && ovPerPage > 0) payload.openverse_per_page = ovPerPage;
      if (Number.isFinite(ovMaxPages) && ovMaxPages > 0) payload.openverse_max_pages = ovMaxPages;
      if (ovParams && Object.keys(ovParams).length > 0) payload.openverse_params = ovParams;
    }

    const insert = await db('catchments')
      .insert(payload)
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
    case 'catchment': {
      const jobId = `catchment:${id}`;
      await qCatchment.add('catchment', { catchmentId: id }, { jobId });
      if (typeof req.log === 'function') req.log({ event: 'requeue', stage: 'catchment', id, jobId });
      break;
    }
    case 'catchmentArtwork': {
      const jobId = `catchmentArtwork:${id}`;
      await qCatchmentArtwork.add('catchmentArtwork', { catchmentId: id }, { jobId });
      if (typeof req.log === 'function') req.log({ event: 'requeue', stage: 'catchmentArtwork', id, jobId });
      break;
    }
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

// Mount admin style prompts UIs
app.use('/admin/style-prompts', (await import('./server/routes/admin/stylePrompts.js')).default);
app.use('/', (await import('./server/routes/admin/stylePromptsUI.js')).default);

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
