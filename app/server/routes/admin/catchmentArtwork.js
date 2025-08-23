import express from 'express';
import db from '../../../db/client.js';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import { createMockups } from '../../../services/framemock.js';
import { deleteImage } from '../../../services/cloudinary.js';

const router = express.Router();

/**
 * List catchment_artwork rows for moderation.
 * Query:
 *  - catchmentId (required)
 *  - status=pending|approved|rejected (default: pending)
 *
 * Response shape mirrors /admin/artworks where possible:
 *  - id, image_url, description, mockup_urls, published, approved_for_publish, moderated_at
 *  - location_name (we map to catchment name)
 *  - photo_thumbnail_url, photo_detail_url (not applicable; omitted)
 */
router.get('/admin/catchment-artworks', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const { catchmentId, status = 'pending' } = req.query;
    if (!catchmentId) return res.status(400).json({ error: 'missing_catchmentId' });

    const rows = await db('catchment_artwork as a')
      .join('catchments as c', 'c.id', 'a.catchment_id')
      .select(
        'a.id',
        'a.image_url',
        'a.description',
        'a.mockup_urls',
        'a.published',
        'a.approved_for_publish',
        'a.moderated_at',
        db.raw('c.name as location_name')
      )
      .where('a.catchment_id', catchmentId)
      .modify(qb => {
        if (status === 'pending') {
          qb.where('a.published', false)
            .andWhere(inner => {
              inner.where('a.approved_for_publish', false).orWhereNull('a.approved_for_publish');
            });
        } else if (status === 'approved') {
          qb.where('a.approved_for_publish', true);
        } else if (status === 'rejected') {
          qb.where('a.approved_for_publish', false).whereNotNull('a.moderated_at');
        }
      })
      .orderBy('a.id', 'desc')
      .limit(200);

    if (typeof req.log === 'function') {
      req.log({ event: 'admin_catchment_artworks', catchmentId, rows: rows.length, duration_ms: Date.now() - t0 });
    }
    res.json({ artworks: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Moderate catchment_artwork (approve => generate mockups, reject => delete assets and row)
 * POST /moderate/catchment-artwork/:id { action: 'approve' | 'reject' }
 */
router.post('/moderate/catchment-artwork/:id', requireApiKey, async (req, res, next) => {
  const { id } = req.params;
  const rawAction = (req.body && req.body.action) || '';
  const action = String(rawAction).toLowerCase() === 'fail' ? 'reject' : String(rawAction).toLowerCase();
  const t0 = Date.now();
  if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork_request', artworkId: id, action: rawAction, normalizedAction: action, hasApiKey: Boolean(req.headers['x-api-key'] || req.headers['x-ingest-key']) });

  try {
    if (!['approve','reject'].includes(String(action))) {
      return res.status(400).json({ error: 'bad_action' });
    }

    if (action === 'reject') {
      const art = await db('catchment_artwork').where({ id }).first();

      if (typeof req.log === 'function') {
        let mockCount = 0;
        try {
          if (Array.isArray(art?.mockup_urls)) mockCount = art.mockup_urls.length;
          else if (typeof art?.mockup_urls === 'string') mockCount = (JSON.parse(art.mockup_urls) || []).length;
        } catch {}
        req.log({
          event: 'moderate_catchment_artwork.reject.loaded',
          artworkId: id,
          hasArt: Boolean(art),
          hasImageUrl: Boolean(art?.image_url),
          style_prompt_id: art?.style_prompt_id,
          mockup_count: mockCount
        });
      }

      try {
        if (art?.image_url) {
          if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork.reject.delete_image_by_url', artworkId: id, url: art.image_url });
          await deleteImage({ url: art.image_url });
        } else if (art?.catchment_id && art?.style_prompt_id != null) {
          const fallbackPublicId = `art-factory/catchment-artwork/catchment_${art.catchment_id}_${art.style_prompt_id}_0`;
          if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork.reject.delete_image_by_public_id', artworkId: id, public_id: fallbackPublicId });
          await deleteImage({ publicId: fallbackPublicId });
        } else {
          console.warn('moderate_catchment_artwork.reject: no_image_reference', { artworkId: id });
        }
      } catch (err) {
        console.warn('moderate_catchment_artwork.reject: cloudinary_delete_failed', { artworkId: id, error: err && err.message });
      }

      try {
        const mocks = Array.isArray(art?.mockup_urls)
          ? art.mockup_urls
          : (typeof art?.mockup_urls === 'string' ? (JSON.parse(art.mockup_urls) || []) : []);
        for (const u of (Array.isArray(mocks) ? mocks : [])) {
          try {
            if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork.reject.mockup_delete', artworkId: id, url: u });
            await deleteImage({ url: u });
          } catch (e) {
            console.warn('moderate_catchment_artwork.reject: mockup_delete_failed', { artworkId: id, error: e && e.message, url: u });
          }
        }
      } catch (_) {}

      await db('catchment_artwork').where({ id }).del();

      if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork', artworkId: id, action: 'reject_delete', duration_ms: Date.now() - t0 });
      return res.json({ ok: true, status: 'deleted' });
    }

    // approve
    await db('catchment_artwork').where({ id }).update({ approved_for_publish: true, moderated_at: db.fn.now() });

    const art = await db('catchment_artwork').where({ id }).first();
    if (!art || !art.image_url) {
      console.error('No image_url for catchment_artwork, cannot generate mockups', { id });
    } else {
      try {
        const { frameMockUrl, frameMockApiKey, frameUrl1, frameUrl2, frameUrl3 } = (await import('../../config/env.js')).env;
        const mockupUrls = await createMockups({
          frameUrl1,
          frameUrl2,
          frameUrl3,
          artUrl: art.image_url,
          orientation: 'auto',
          enableInnerShadow: true
        });
        await db('catchment_artwork').where({ id }).update({ mockup_urls: JSON.stringify(mockupUrls) });
        if (typeof req.log === 'function') {
          req.log({ event: 'generate_catchment_mockups', artworkId: id, mockupsCount: mockupUrls.length });
        }
      } catch (err) {
        if (typeof req.log === 'function') {
          req.log({ event: 'generate_catchment_mockups_failed', artworkId: id, error: err.message });
        }
        console.error('generate_catchment_mockups_failed', { artworkId: id, error: err });
      }
    }

    if (typeof req.log === 'function') req.log({ event: 'moderate_catchment_artwork', artworkId: id, action: 'approve', duration_ms: Date.now() - t0 });
    res.json({ ok: true, status: 'approved' });
  } catch (err) {
    next(err);
  }
});

export default router;
