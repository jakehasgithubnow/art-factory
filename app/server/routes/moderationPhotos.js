import express from 'express';
import db from '../../db/client.js';
import { uploadImage } from '../../services/cloudinary.js';
import { qArtwork } from '../../queue/queues.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = express.Router();

// JSON for moderation grid
router.get('/admin/photos', async (req, res, next) => {
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
      .orderBy('p.created_at','desc');
    if (typeof req.log === 'function') {
      req.log({ event: 'admin_photos', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    }
    res.json({ photos: rows });
  } catch (err) {
    next(err);
  }
});

// Approve/Reject photo
router.post('/moderate/photo/:id', requireApiKey, async (req, res, next) => {
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

export default router;
