import express from 'express';
import db from '../../db/client.js';
import { qPublish } from '../../queue/queues.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = express.Router();

// List artworks for moderation (pending by default)
router.get('/admin/artworks', async (req, res, next) => {
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
        if (status === 'pending') {
          qb.where('a.published', false)
            .andWhere(inner => {
              inner.where('a.approved_for_publish', false).orWhereNull('a.approved_for_publish');
            });
        }
        if (status === 'approved') qb.where('a.approved_for_publish', true);
        if (status === 'rejected') qb.where('a.approved_for_publish', false).whereNotNull('a.moderated_at');
      })
      .orderBy('a.id','desc')
      .limit(200);
    if (typeof req.log === 'function') req.log({ event: 'admin_artworks', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    res.json({ artworks: rows });
  } catch (err) { next(err); }
});

// Moderate generated artwork (approve => enqueue publish, reject => mark only)
router.post('/moderate/artwork/:id', requireApiKey, async (req, res, next) => {
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

export default router;
