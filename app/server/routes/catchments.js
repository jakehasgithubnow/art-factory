import express from 'express';
import db from '../../db/client.js';
import { qCatchment } from '../../queue/queues.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateCatchmentBody } from '../helpers/validation.js';

const router = express.Router();

// Ingest: create a catchment and kick off the pipeline
router.post('/catchments', requireApiKey, rateLimit, async (req, res, next) => {
  try {
    const t0 = Date.now();
    const { valid, errors, name, lat, lon, intro } = validateCatchmentBody(req.body);

    // Optional: image source selection
    const imageSource = (req.body.imageSource || '').toLowerCase() === 'openverse' ? 'openverse' : 'google';
    if (!valid) return res.status(400).json({ error: 'invalid_request', details: errors });

    // Find-or-create to avoid 23505 on unique (lower(name), lat, lon)
    let id;
    try {
      const existing = await db('catchments')
        .whereRaw('lower(name) = ? and lat = ? and lon = ?', [name.toLowerCase(), lat, lon])
        .first('id');

      if (existing?.id) {
        id = existing.id;
        if (typeof req.log === 'function') {
          req.log({ event: 'catchment_found', catchmentId: id });
        }
      } else {
        const insert = await db('catchments')
          .insert({ name, lat, lon, intro })
          .returning(['id']);
        id = insert?.[0]?.id;
        if (!id) throw new Error('Failed to create catchment');
        if (typeof req.log === 'function') {
          req.log({ event: 'catchment_inserted', catchmentId: id });
        }
      }
    } catch (e) {
      // Attach minimal context and bubble to error handler
      e.context = { route: 'POST /catchments', phase: 'db_find_or_create', name, lat, lon };
      throw e;
    }

    // Enqueue stage 1 explicitly (idempotent jobId)
    try {
      await qCatchment.add(
        'catchment',
        { catchmentId: id, imageSource },
        { jobId: `catchment:${id}` }
      );
      if (typeof req.log === 'function') {
        req.log({ event: 'catchment_enqueued', catchmentId: id, jobId: `catchment:${id}`, duration_ms: Date.now() - t0 });
      }
      return res.status(202).json({ id });
    } catch (e) {
      if (typeof req.log === 'function') {
        req.log({ event: 'catchment_enqueue_failed', catchmentId: id, jobId: `catchment:${id}`, name: e?.name, message: e?.message });
      }
      // Service unavailable: record exists but pipeline not started; client can retry/requeue
      return res.status(503).json({ id, error: 'enqueue_failed' });
    }
  } catch (err) {
    if (typeof req.log === 'function') {
      req.log({ event: 'catchment_request_error', name: err?.name, message: err?.message });
    }
    err.context = { ...(err.context || {}), route: 'POST /catchments' };
    next(err);
  }
});

router.post('/requeue/:stage/:id', requireApiKey, async (req, res) => {
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

export default router;
