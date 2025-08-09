import db from '../db/client.js';
import { imageSearch } from '../services/google.js';
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
    images = await imageSearch(location.search_term, MAX_IMAGES);
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
      const scoreTxt = await chat(
        'You rate reference photos for painting. Reply ONLY a decimal 0-1.',
        `Score this image for painting quality (composition, subject clarity, no watermarks): ${srcUrl}`,
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
      const insert = await db('photos')
        .insert({ location_id: locationId, src_url: srcUrl, score, kept })
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

    // 3) If we decided to keep it, ensure upload to Cloudinary and enqueue artwork
    if (kept) {
      try {
        if (!photoRow.processed || !photoRow.cloudinary_id || !photoRow.secure_url) {
          // Upload to Cloudinary; store both public_id and secure_url
          const { public_id, secure_url } = await uploadImage(srcUrl, {
            folder: 'art-factory/source',
            publicId: `source_${photoRow.id}`,
            overwrite: false,
          });
          await db('photos').where({ id: photoRow.id }).update({
            cloudinary_id: public_id,
            secure_url,
            processed: true,
          });
        }

        // Enqueue next stage with a stable jobId for idempotency
        await qArtwork.add('artwork', { photoId: photoRow.id }, { jobId: `artwork:${photoRow.id}` });
      } catch (err) {
        console.error('photos: upload/enqueue failed', { locationId, photoId: photoRow.id, err });
        // Do not throw; continue with other images
      }
    }
  }

  // 4) Mark location processed after iterating all images
  await db('locations').where({ id: locationId }).update({ processed: true });
}