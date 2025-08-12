import express from 'express';
import db from '../../db/client.js';

const router = express.Router();

// Admin data for UI: last 20 catchments with rollup counts
router.get('/admin/recent', async (_req, res, next) => {
  try {
    const t0 = Date.now();
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

export default router;
