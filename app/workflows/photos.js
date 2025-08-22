import db from '../db/client.js';
import { imageSearch as googleImageSearch } from '../services/google.js';
import { imageSearch as openverseImageSearch } from '../services/openverse.js';
import { chat } from '../services/openai.js';
import { uploadImage } from '../services/cloudinary.js';
import { qArtwork } from '../queue/queues.js';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';
import { log } from '../server/utils/logger.js';

const KEEP_THRESHOLD = 0.65; // used for non-openverse (google) path
const OPENVERSE_TOP_N = 20;
const GOOGLE_TOP_N = 10;

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function to01(text) {
  const s = String(text || '').trim();
  // If it's a strict single char 0/1, use it directly
  if (/^[01]$/.test(s)) return Number(s);
  // If it's a numeric string like 0.65, parse and threshold at 0.5
  const num = Number.parseFloat(s);
  if (Number.isFinite(num)) return num >= 0.5 ? 1 : 0;
  // Fallback: look for any 0/1 digit hints; prefer '1' if clearly present
  const digits = s.match(/[01]/g);
  if (digits && digits.length) return digits.includes('1') && !digits.every(d => d === '0') ? 1 : 0;
  // Default conservative: delete
  return 0;
}

export default async function photos(job) {
  const { locationId } = job.data;
  const location = await db('locations as l')
    .leftJoin('catchments as c', 'c.id', 'l.catchment_id')
    .where('l.id', locationId)
    .first([
      'l.*',
      db.raw('c.name as c_name'),
      db.raw('c.openverse_top_n as c_ov_top_n'),
      db.raw('c.openverse_per_page as c_ov_per_page'),
      db.raw('c.openverse_max_pages as c_ov_max_pages'),
      db.raw('c.openverse_params as c_ov_params')
    ]);
  if (!location || location.processed) return;

  const source = location.image_source || 'google';

  // Openverse run tracking for logging
  let ovRunId = null;
  let ovModerationEnabledCount = 0;
  let ovKeptCount = 0;
  let ovDeletedCount = 0;

  let images = [];
  try {
    if (source === 'openverse') {
      ovRunId = randomUUID();
      try {
        log({ event: 'openverse_run_start', runId: ovRunId, locationId, search_term: location.search_term });
      } catch (_) {}
      // Determine per-catchment Openverse config (fallback to defaults)
      let topN = OPENVERSE_TOP_N;
      const nTop = Number(location?.c_ov_top_n);
      if (Number.isFinite(nTop) && nTop > 0) topN = nTop;

      const ovOptions = {};
      const perPageN = Number(location?.c_ov_per_page);
      if (Number.isFinite(perPageN) && perPageN > 0) ovOptions.perPage = perPageN;

      const maxPagesN = Number(location?.c_ov_max_pages);
      if (Number.isFinite(maxPagesN) && maxPagesN > 0) ovOptions.maxPages = maxPagesN;

      if (location?.c_ov_params && typeof location.c_ov_params === 'object') {
        ovOptions.openverseParams = location.c_ov_params;
      }

      try {
        log({
          event: 'openverse_run_config',
          runId: ovRunId,
          locationId,
          top_n: topN,
          options: ovOptions
        });
      } catch (_) {}

      images = await openverseImageSearch(location.search_term, topN, ovOptions);
      try {
        log({
          event: 'openverse_run_results',
          runId: ovRunId,
          locationId,
          requested_top_n: topN,
          returned_count: Array.isArray(images) ? images.length : 0
        });
      } catch (_) {}
    } else {
      images = await googleImageSearch(location.search_term, GOOGLE_TOP_N);
    }
  } catch (err) {
    console.error('photos: imageSearch failed', { locationId, err });
    images = [];
  }

  if (!Array.isArray(images) || images.length === 0) {
    if (source === 'openverse') {
      try {
        log({
          event: 'openverse_run_summary',
          runId: ovRunId,
          locationId,
          returned_count: 0,
          moderation_enabled_count: 0,
          kept_count: 0,
          deleted_count: 0,
          ai_review_disabled: env.openverseAiReview === false
        });
      } catch (_) {}
    }
    await db('locations').where({ id: locationId }).update({ processed: true });
    return;
  }

  for (const img of images) {
    const srcUrl = img?.url || img?.src || '';
    if (!srcUrl) continue;

    // Load prompts once per image (kept here for simplicity)
    let sysPrompt = '';
    let userTemplate = '';
    try {
      const { getByKey } = await import('../db/systemPrompts.js');
      const sysPromptRow = await getByKey('photo_scoring_system');
      sysPrompt = sysPromptRow?.text || '';
      const userPromptRow = await getByKey('photo_scoring_user');
      userTemplate = userPromptRow?.text || '';
    } catch (err) {
      console.warn('photos: failed to load system/user prompts; defaulting', { locationId, err });
      sysPrompt = '';
      userTemplate = '';
    }

    if (source === 'openverse') {
      // OPENVERSE PATH: store top 20, then classify with GPT using thumbnail; delete if 0, keep if 1
      let photoRow;
      try {
        const insertData = {
          location_id: locationId,
          src_url: srcUrl,
          kept: false,
          score: null,
        };

        // Persist Openverse metadata if present
        if (img.id) {
          // Legacy column family (pre-ov_*)
          insertData.openverse_id = img.id || null;
          insertData.title = img.title || null;
          insertData.creator = img.creator || null;
          insertData.creator_url = img.creator_url || null;
          insertData.license = img.license || null;
          insertData.license_version = img.license_version || null;
          insertData.license_url = img.license_url || null;
          insertData.source = img.source || null;
          insertData.category = img.category || null;
          insertData.provider = img.provider || null;
          insertData.thumbnail_url = img.thumbnail || null;
          insertData.detail_url = img.detail_url || null;
          insertData.width = img.width || null;
          insertData.height = img.height || null;

          // Newer ov_* column family for parity with schema.sql
          insertData.ov_id = img.id || null;
          insertData.ov_title = img.title || null;
          insertData.ov_creator = img.creator || null;
          insertData.ov_creator_url = img.creator_url || null;
          insertData.ov_license = img.license || null;
          insertData.ov_license_version = img.license_version || null;
          insertData.ov_license_url = img.license_url || null;
          insertData.ov_source = img.source || null;
          insertData.ov_category = img.category || null;
          insertData.ov_provider = img.provider || null;
          insertData.ov_thumbnail = img.thumbnail || null;
          insertData.ov_detail_url = img.detail_url || null;
          insertData.ov_width = img.width || null;
          insertData.ov_height = img.height || null;

          insertData.openverse_metadata = img || {};

          // Ingestion-side logging for diagnostics
          try {
            console.log(JSON.stringify({
              event: 'ingest_openverse_photo',
              locationId,
              srcUrl,
              ov_id: img.id || null,
              provider: img.provider || null,
              hasThumbnail: Boolean(img.thumbnail)
            }));
            if (!img.thumbnail) {
              console.warn(JSON.stringify({
                event: 'ingest_openverse_missing_thumbnail',
                locationId,
                srcUrl,
                ov_id: img.id || null
              }));
            }
          } catch (_) {}
        }

        const insert = await db('photos')
          .insert(insertData)
          .onConflict(['location_id', 'src_url'])
          .ignore()
          .returning(['id']);

        if (insert && insert[0]) {
          photoRow = { id: insert[0].id };
        } else {
          photoRow = await db('photos')
            .where({ location_id: locationId, src_url: srcUrl })
            .first(['id', 'cloudinary_id', 'secure_url', 'processed', 'kept']);
        }
      } catch (err) {
        console.warn('photos: failed to upsert photo row (openverse)', { locationId, srcUrl, err });
        continue;
      }

      if (!photoRow?.id) continue;

      // If Openverse AI review is disabled, skip classification and queue for moderation
      if (env.openverseAiReview === false) {
        try {
          await db('photos').where({ id: photoRow.id }).update({
            kept: false,
            processed: false,
            score: null,
          });
          try {
            console.log('photos: openverse AI review disabled; queued for moderation', { locationId, photoId: photoRow.id, srcUrl });
          } catch (_) {}
        } catch (err) {
          console.error('photos: failed to mark openverse photo for moderation (AI review disabled)', { locationId, photoId: photoRow.id, err });
        }
        try { ovModerationEnabledCount += 1; } catch (_) {}
        continue;
      }

      // Build user payload: use thumbnail when available; fall back to srcUrl
      const thumbUrl = img?.thumbnail || img?.thumbnail_url || srcUrl;
      try {
        console.log(JSON.stringify({
          event: 'ingest_thumb_choice',
          locationId,
          srcUrl,
          used: img?.thumbnail ? 'thumbnail' : (img?.thumbnail_url ? 'thumbnail_url' : 'src_url')
        }));
      } catch (_) {}
      const userText = typeof userTemplate === 'string'
        ? userTemplate
            .replace('{{imageUrl}}', thumbUrl)
            .replace('{{locationName}}', location.name || '')
            .replace('{{catchmentName}}', location.c_name || '')
        : '';

      // Classify with gpt-4.1-mini: expect '0' or '1'
      let keep = 0;
      try {
        const sysForBinary = (typeof sysPrompt === 'string' && sysPrompt.trim())
          ? `${sysPrompt}\n\nReturn ONLY a single character: 1 (keep) or 0 (delete).`
          : 'Return ONLY a single character: 1 (keep) or 0 (delete).';
        const result = await chat(
          sysForBinary,
          { imageUrls: [thumbUrl], text: userText },
          0,
          'gpt-4.1-mini'
        );
        keep = to01(result);
      } catch (err) {
        console.warn('photos: openverse classification failed; defaulting to 0 (delete)', { locationId, srcUrl, err });
        keep = 0;
      }

      try {
        if (keep === 1) {
          // Keep photo: mark for moderation (processed stays false)
          if (!photoRow.processed) {
            await db('photos').where({ id: photoRow.id }).update({
              kept: true,
              processed: false,
              score: 1,
            });
            try { ovModerationEnabledCount += 1; } catch (_) {}
          }
          console.log('photos: kept openverse photo', { locationId, photoId: photoRow.id, srcUrl });
          try { ovKeptCount += 1; } catch (_) {}
        } else {
          // Delete photo row entirely
          await db('photos').where({ id: photoRow.id }).del();
          console.log('photos: deleted openverse photo (classified 0)', { locationId, photoId: photoRow.id, srcUrl });
          try { ovDeletedCount += 1; } catch (_) {}
        }
      } catch (err) {
        console.error('photos: openverse post-classification update failed', { locationId, photoId: photoRow.id, err });
      }
    } else {
      // NON-OPENVERSE PATH: keep existing behavior (score numeric, threshold)
      let score = 0;
      try {
        const userPrompt = typeof userTemplate === 'string'
          ? userTemplate
              .replace('{{imageUrl}}', srcUrl)
              .replace('{{locationName}}', location.name || '')
              .replace('{{catchmentName}}', location.c_name || '')
          : '';
        const scoreTxt = await chat(
          sysPrompt,
          userPrompt,
          0
        );
        score = clamp01(Number(scoreTxt));
      } catch (err) {
        console.warn('photos: scoring failed; defaulting to 0', { locationId, srcUrl, err });
        score = 0;
      }

      const kept = score >= KEEP_THRESHOLD;

      // Upsert and mark kept (idempotent)
      let photoRow;
      try {
        const insertData = { location_id: locationId, src_url: srcUrl, score, kept };

        const insert = await db('photos')
          .insert(insertData)
          .onConflict(['location_id', 'src_url'])
          .ignore()
          .returning(['id']);

        if (insert && insert[0]) {
          photoRow = { id: insert[0].id };
        } else {
          photoRow = await db('photos')
            .where({ location_id: locationId, src_url: srcUrl })
            .first(['id', 'cloudinary_id', 'secure_url', 'processed', 'kept']);
        }
      } catch (err) {
        console.warn('photos: failed to upsert photo row (non-openverse)', { locationId, srcUrl, err });
        continue;
      }

      if (!photoRow?.id) continue;

      if (kept) {
        try {
          if (!photoRow.processed) {
            await db('photos').where({ id: photoRow.id }).update({
              kept: true,
              processed: false,
            });
          }
        } catch (err) {
          console.error('photos: marking for moderation failed', { locationId, photoId: photoRow.id, err });
        }
      }
    }
  }

  // Mark location processed after iterating all images
  if (source === 'openverse') {
    try {
      log({
        event: 'openverse_run_summary',
        runId: ovRunId,
        locationId,
        returned_count: Array.isArray(images) ? images.length : 0,
        moderation_enabled_count: ovModerationEnabledCount,
        kept_count: ovKeptCount,
        deleted_count: ovDeletedCount,
        ai_review_disabled: env.openverseAiReview === false
      });
    } catch (_) {}
  }
  await db('locations').where({ id: locationId }).update({ processed: true });
}
