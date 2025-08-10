
import express from 'express';
import db from './db/client.js';
import { env } from './config/env.js';
import { qCatchment } from './queue/queues.js';
import './queue/workers.js'; // spin up processors
console.log('REDIS_URL present?', Boolean(process.env.REDIS_URL));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

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