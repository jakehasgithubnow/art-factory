import db from '../db/client.js';
import { imageSearch as googleImageSearch } from '../services/google.js';
import { imageSearch as openverseImageSearch } from '../services/openverse.js';
import { chat } from '../services/openai.js';
import { uploadImage } from '../services/cloudinary.js';
import { qArtwork } from '../queue/queues.js';

const KEEP_THRESHOLD = 0.65;
const MAX_IMAGES = 10; // keep requests small; page inside imageSearch if needed

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export default async function photos(job) {
  const { locationId } = job.data;
  const location = await db('locations').where({ id: locationId }).first();
  if (!location || location.processed) return;

  let images = [];
  try {
    const source = location.image_source || 'google';
    if (source === 'openverse') {
      images = await openverseImageSearch(location.search_term, MAX_IMAGES);
    } else {
      images = await googleImageSearch(location.search_term, MAX_IMAGES);
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

    // 1) Ask GPT to score (best-effort; never throw the worker)
    let score = 0;
    try {
      const { getByKey } = await import('../db/systemPrompts.js');
      const sysPromptRow = await getByKey('photo_scoring_system');
      const sysPrompt = sysPromptRow?.text;
      const userPromptRow = await getByKey('photo_scoring_user');
      const userTemplate = userPromptRow?.text;
      const userPrompt = userTemplate?.replace('{{imageUrl}}', srcUrl);
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

    // 2) Insert photo row idempotently
    let photoRow;
    try {
      const insertData = { location_id: locationId, src_url: srcUrl, score, kept };

      // If this is from Openverse, store the metadata fields
      if (img.id) {
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
      console.warn('photos: failed to upsert photo row', { locationId, srcUrl, err });
      continue;
    }

    if (!photoRow?.id) continue;

    // 3) If we decided to keep it, mark for moderation but do not upload or enqueue yet
    if (kept) {
      try {
        // Mark as kept but leave processed false for moderation to handle
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

  // 4) Mark location processed after iterating all images
  await db('locations').where({ id: locationId }).update({ processed: true });
}
