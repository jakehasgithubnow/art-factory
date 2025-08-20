import express from 'express';
import db from '../../db/client.js';
import { uploadImage } from '../../services/cloudinary.js';
import { qArtwork } from '../../queue/queues.js';
import { requireApiKey } from '../middleware/requireApiKey.js';

const router = express.Router();

// JSON for moderation grid (legacy: all photos for a catchment)
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
        'p.openverse_id',
        'p.title',
        'p.creator',
        'p.creator_url',
        'p.license',
        'p.license_version',
        'p.license_url',
        'p.source',
        'p.category',
        'p.provider',
        'p.thumbnail_url',
        'p.detail_url',
        'p.width',
        'p.height',
        'p.openverse_metadata'
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

/**
 * New: Get next location (within a catchment) that has photos requiring moderation,
 * and return up to 20 unprocessed photos for that location.
 */
router.get('/admin/photos/next', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });

    // Find the next location with at least one unprocessed photo
    const loc = await db('locations as l')
      .where('l.catchment_id', catchmentId)
      .whereExists(function () {
        this.select(1)
          .from('photos as p')
          .whereRaw('p.location_id = l.id')
          .andWhere('p.processed', false);
      })
      .orderBy('l.created_at', 'asc')
      .select('l.id', 'l.name')
      .first();

    if (!loc) {
      if (typeof req.log === 'function') {
        req.log({ event: 'admin_photos_next', catchmentId, done: true, duration_ms: Date.now() - t0 });
      }
      return res.json({ done: true });
    }

    // Up to 20 photos for this location that are not yet processed
    const photos = await db('photos as p')
      .where('p.location_id', loc.id)
      .andWhere('p.processed', false)
      .orderBy('p.created_at', 'desc')
      .limit(20)
      .select(
        'p.id',
        'p.src_url',
        'p.kept',
        'p.score',
        'p.processed',
        // Openverse metadata columns as defined in schema (ov_*)
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
        db.raw("coalesce(p.ov_thumbnail, p.thumbnail_url, p.openverse_metadata->>'thumbnail_url', p.openverse_metadata->>'thumbnail') as ov_thumbnail"),
        db.raw("coalesce(p.ov_detail_url, p.detail_url, p.openverse_metadata->>'detail_url', p.openverse_metadata->>'foreign_landing_url') as ov_detail_url"),
        'p.ov_width',
        'p.ov_height',
        // include legacy fields for diagnostics
        'p.thumbnail_url',
        'p.detail_url',
        'p.provider',
        'p.openverse_metadata'
      );

    const remainingRow = await db('photos as p')
      .where('p.location_id', loc.id)
      .andWhere('p.processed', false)
      .count({ c: '*' })
      .first();
    const remaining = Number(remainingRow?.c ?? 0);

    if (typeof req.log === 'function') {
      const thumbSummary = {
        ovThumb: photos.filter(p => p.ov_thumbnail).length,
        legacyThumb: photos.filter(p => !p.ov_thumbnail && p.thumbnail_url).length,
        noThumb: photos.filter(p => !p.ov_thumbnail && !p.thumbnail_url).length
      };
      req.log({
        event: 'admin_photos_next',
        catchmentId,
        locationId: loc.id,
        photos: photos.length,
        remaining,
        thumbSummary,
        duration_ms: Date.now() - t0
      });
    }

    res.json({ location: { id: loc.id, name: loc.name }, photos, remaining });
  } catch (err) {
    next(err);
  }
});

/**
 * New: Bulk moderation for all photos in a single location (approve/pass vs reject/fail),
 * then enqueue approved ones for artwork generation. Requires API key.
 * Body: { decisions: [{ id: photoId, kept: boolean }], catchmentId?: string }
 */
router.post('/moderate/location/:locationId', requireApiKey, async (req, res, next) => {
  const t0 = Date.now();
  const { locationId } = req.params;
  const { decisions, catchmentId } = req.body || {};
  try {
    if (!Array.isArray(decisions) || decisions.length === 0) {
      return res.status(400).json({ error: 'missing_decisions' });
    }

    // Normalize decisions into a map for quick lookup
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

    // Ensure photos exist and belong to the provided location
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

    // Rejects: mark kept=false, processed=true
    if (rejectIds.length > 0) {
      await db('photos').whereIn('id', rejectIds).update({ kept: false, processed: true });
    }

    // Approvals: kept=true, ensure Cloudinary upload present; then processed=true and enqueue artwork
    if (approveIds.length > 0) {
      // Set kept=true upfront for all approvals
      await db('photos').whereIn('id', approveIds).update({ kept: true });

      // Separate those that already have assets vs need upload
      const approveRows = rows.filter(r => approveIds.includes(r.id));
      const haveAssets = approveRows.filter(r => r.cloudinary_id && r.secure_url).map(r => r.id);
      const needUpload = approveRows.filter(r => !r.cloudinary_id || !r.secure_url);

      // For those with existing assets: mark processed and enqueue
      if (haveAssets.length > 0) {
        await db('photos').whereIn('id', haveAssets).update({ processed: true });
        await Promise.all(
          haveAssets.map(id => qArtwork.add('artwork', { photoId: id }, { jobId: `artwork:${id}` }))
        );
        enqueuedArtwork += haveAssets.length;
      }

      // For those needing upload: try per-item; on failure delete and continue
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
          // Upload failed: delete the photo and move on
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

// Approve/Reject single photo (legacy granular moderation)
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

    // Approve: mark kept; if Cloudinary upload fails, delete and move on
    await db('photos').where({ id }).update({ kept: true });

    let hasAssets = Boolean(photo.cloudinary_id && photo.secure_url);
    if (!hasAssets) {
      try {
        const { public_id, secure_url } = await uploadImage(photo.src_url, {
          folder: 'art-factory/source',
          publicId: `source_${photo.id}`,
          overwrite: false
        });
        await db('photos').where({ id }).update({ cloudinary_id: public_id, secure_url });
        uploadedToCloudinary = true;
        hasAssets = true;
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
      req.log({
        event: 'moderate_photo',
        photoId: id,
        action: 'approve',
        uploadedToCloudinary,
        enqueuedArtwork,
        duration_ms: Date.now() - t0
      });
    }
    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    next(err);
  }
});

export default router;
