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
