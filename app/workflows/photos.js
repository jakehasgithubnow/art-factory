import db from '../db/client.js';
import { imageSearch as googleImageSearch } from '../services/google.js';
import { imageSearch as openverseImageSearch } from '../services/openverse.js';
import { chat } from '../services/openai.js';
import { uploadImage } from '../services/cloudinary.js';
import { qArtwork } from '../queue/queues.js';

const KEEP_THRESHOLD = 0.65; // used for non-openverse (google) path
const OPENVERSE_TOP_N = 50;
const GOOGLE_TOP_N = 10;

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function to01(text) {
  const s = String(text || '').trim();
  // Find first explicit 0 or 1; default to 0 if ambiguous
  const m = s.match(/[01]/);
  return m && m[0] === '1' ? 1 : 0;
}

export default async function photos(job) {
  const { locationId } = job.data;
  const location = await db('locations').where({ id: locationId }).first();
  if (!location || location.processed) return;

  const source = location.image_source || 'google';

  let images = [];
  try {
    if (source === 'openverse') {
      images = await openverseImageSearch(location.search_term, OPENVERSE_TOP_N);
    } else {
      images = await googleImageSearch(location.search_term, GOOGLE_TOP_N);
    }
  } catch (err) {
    console.error('photos: imageSearch failed', { locationId, err });
    images = [];
  }

  if (!Array.isArray(images) || images.length === 0) {
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
      // OPENVERSE PATH: store top 50, then classify with GPT using thumbnail; delete if 0, keep if 1
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
          insertData.openverse_metadata = img || {};
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

      // Build user payload: use thumbnail when available; fall back to srcUrl
      const thumbUrl = img?.thumbnail || img?.thumbnail_url || srcUrl;
      const userText = typeof userTemplate === 'string'
        ? userTemplate.replace('{{imageUrl}}', thumbUrl)
        : '';

      // Classify with gpt-4.1-mini: expect '0' or '1'
      let keep = 0;
      try {
        const result = await chat(
          sysPrompt,
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
          }
          console.log('photos: kept openverse photo', { locationId, photoId: photoRow.id, srcUrl });
        } else {
          // Delete photo row entirely
          await db('photos').where({ id: photoRow.id }).del();
          console.log('photos: deleted openverse photo (classified 0)', { locationId, photoId: photoRow.id, srcUrl });
        }
      } catch (err) {
        console.error('photos: openverse post-classification update failed', { locationId, photoId: photoRow.id, err });
      }
    } else {
      // NON-OPENVERSE PATH: keep existing behavior (score numeric, threshold)
      let score = 0;
      try {
        const userPrompt = typeof userTemplate === 'string'
          ? userTemplate.replace('{{imageUrl}}', srcUrl)
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
  await db('locations').where({ id: locationId }).update({ processed: true });
}
