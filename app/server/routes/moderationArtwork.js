import express from 'express';
import db from '../../db/client.js';
import { qPublish } from '../../queue/queues.js';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { createMockups } from '../../services/framemock.js';
import { deleteImage } from '../../services/cloudinary.js';

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
        'p.id as photo_id','l.name as location_name','p.thumbnail_url as photo_thumbnail_url','p.detail_url as photo_detail_url'
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
  const rawAction = (req.body && req.body.action) || '';
  const action = String(rawAction).toLowerCase() === 'fail' ? 'reject' : String(rawAction).toLowerCase();
  const t0 = Date.now();
  if (typeof req.log === 'function') req.log({ event: 'moderate_artwork_request', artworkId: id, action: rawAction, normalizedAction: action, hasApiKey: Boolean(req.headers['x-api-key'] || req.headers['x-ingest-key']) });
  try {
    if (!['approve','reject'].includes(String(action))) return res.status(400).json({ error: 'bad_action' });

    if (action === 'reject') {
      // Load the artwork row to determine Cloudinary identifier(s)
      const art = await db('artwork').where({ id }).first();

      if (typeof req.log === 'function') {
        let mockCount = 0;
        try {
          if (Array.isArray(art?.mockup_urls)) mockCount = art.mockup_urls.length;
          else if (typeof art?.mockup_urls === 'string') mockCount = (JSON.parse(art.mockup_urls) || []).length;
        } catch {}
        req.log({
          event: 'moderate_artwork.reject.loaded',
          artworkId: id,
          hasArt: Boolean(art),
          hasImageUrl: Boolean(art?.image_url),
          photo_id: art?.photo_id,
          style_prompt_id: art?.style_prompt_id,
          mockup_count: mockCount
        });
      }

      // Best-effort: delete the Cloudinary asset for this artwork
      try {
        if (art?.image_url) {
          if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.delete_image_by_url', artworkId: id, url: art.image_url });
          await deleteImage({ url: art.image_url });
        } else if (art?.photo_id && art?.style_prompt_id != null) {
          // Reconstruct the deterministic publicId used during upload
          const fallbackPublicId = `art-factory/artwork/artwork_${art.photo_id}_${art.style_prompt_id}_0`;
          if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.delete_image_by_public_id', artworkId: id, public_id: fallbackPublicId });
          await deleteImage({ publicId: fallbackPublicId });
        } else {
          console.warn('moderate_artwork.reject: no_image_reference', { artworkId: id });
        }
      } catch (err) {
        console.warn('moderate_artwork.reject: cloudinary_delete_failed', { artworkId: id, error: err && err.message });
      }

      // Optional: delete any mockup assets linked to this artwork
      try {
        const mocks = Array.isArray(art?.mockup_urls)
          ? art.mockup_urls
          : (typeof art?.mockup_urls === 'string' ? (JSON.parse(art.mockup_urls) || []) : []);
        for (const u of (Array.isArray(mocks) ? mocks : [])) {
          try {
            if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.mockup_delete', artworkId: id, url: u });
            await deleteImage({ url: u });
          } catch (e) {
            console.warn('moderate_artwork.reject: mockup_delete_failed', { artworkId: id, error: e && e.message, url: u });
          }
        }
      } catch (_) {}

      // Remove any pending publish job for this artwork (if previously enqueued)
      try {
        const jobId = `publish:${id}`;
        const job = await qPublish.getJob(jobId);
        if (job) {
          await job.remove();
          if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.publish_job_removed', artworkId: id, jobId });
        } else {
          if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.publish_job_not_found', artworkId: id, jobId });
        }
      } catch (err) {
        console.warn('moderate_artwork.reject: remove_publish_job_failed', { artworkId: id, error: err && err.message });
      }

      // Permanently remove the artwork from the database so it no longer appears in moderation
      if (typeof req.log === 'function') req.log({ event: 'moderate_artwork.reject.deleting_db_row', artworkId: id });
      await db('artwork').where({ id }).del();

      if (typeof req.log === 'function') req.log({ event: 'moderate_artwork', artworkId: id, action: 'reject_delete', duration_ms: Date.now() - t0 });
      return res.json({ ok: true, status: 'deleted' });
    }

    console.log('moderationArtwork: approve branch entered', { id, action });

    await db('artwork').where({ id }).update({ approved_for_publish: true, moderated_at: db.fn.now() });

    // Fetch artwork to get image_url
    const art = await db('artwork').where({ id }).first();
    if (!art || !art.image_url) {
      console.error('No image_url for artwork, cannot generate mockups', { id });
    } else {
      // Check environment variables needed for framemock
      const { frameMockUrl, frameMockApiKey, frameUrl1, frameUrl2, frameUrl3 } = (await import('../../config/env.js')).env;
      if (!frameMockUrl) {
        console.error('Missing env.frameMockUrl');
      }
      if (!frameMockApiKey) {
        console.warn('Missing env.frameMockApiKey - requests may fail if auth is required');
      }

      try {
        console.log('Calling createMockups for artwork', { id, image_url: art.image_url });
        const mockupUrls = await createMockups({
          frameUrl1,
          frameUrl2,
          frameUrl3,
          artUrl: art.image_url,
          orientation: 'auto',
          enableInnerShadow: true
        });
        console.log('Mockups generated', { id, mockupsCount: mockupUrls.length });
        await db('artwork').where({ id }).update({ mockup_urls: JSON.stringify(mockupUrls) });
        if (typeof req.log === 'function') {
          req.log({ event: 'generate_mockups', artworkId: id, mockupsCount: mockupUrls.length });
        } else {
          console.log('generate_mockups', { artworkId: id, mockupsCount: mockupUrls.length });
        }
      } catch (err) {
        if (typeof req.log === 'function') {
          req.log({ event: 'generate_mockups_failed', artworkId: id, error: err.message });
        }
        console.error('generate_mockups_failed', { artworkId: id, error: err });
      }
    }

    await qPublish.add('publish', { artworkId: id }, { jobId: `publish:${id}` });
    if (typeof req.log === 'function') req.log({ event: 'moderate_artwork', artworkId: id, action: 'approve', enqueuedPublish: true, duration_ms: Date.now() - t0 });
    res.json({ ok: true, status: 'approved' });
  } catch (err) { next(err); }
});

export default router;
