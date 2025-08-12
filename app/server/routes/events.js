import express from 'express';
import db from '../../db/client.js';

const router = express.Router();

// Server-Sent Events (SSE) for realtime operator updates
router.get('/events', async (req, res, next) => {
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

export default router;
