import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat } from '../services/openai.js';
import { createMockups } from '../services/framemock.js';
import { uploadImage } from '../services/cloudinary.js';
import { qPublish } from '../queue/queues.js';

// Read configuration (prefer env helper, fallback to process.env)
import { env } from '../config/env.js';
const PAINT_ENDPOINT = (env && (env.paintEndpoint || env.PAINT_ENDPOINT)) || process.env.PAINT_ENDPOINT;
const CLOUDINARY_CLOUD_NAME = (env && (env.cloudinaryCloudName || env.cloudName || env.CLOUDINARY_CLOUD_NAME)) || process.env.CLOUDINARY_CLOUD_NAME;

const PAINT_API_KEY = process.env.PAINT_API_KEY || (env && (env.paintApiKey || env.PAINT_API_KEY));
function isPiapiEndpoint(url) { try { return new URL(url).host.endsWith('piapi.ai'); } catch { return false; } }

export default async function artwork(job) {
  const { photoId } = job.data;

  // --- Deduplication check ---
  try {
    const tracker = await import('../services/artworkTracker.js').then(m => m.default || m);
    if (await tracker.isProcessed(photoId)) {
      console.log(`[artwork] Artwork for ${photoId} already processed or in progress — skipping PiAPI call`);
      return;
    }
    // Mark as in-progress and initialise attempt counter if not set
    const attemptKey = `artwork_attempts:${photoId}`;
    const currentAttempts = parseInt(process.env[`ATTEMPT_${photoId}`] || '0', 10);
    if (currentAttempts >= 3) {
      console.log(`[artwork] Max retry attempts reached for ${photoId}, skipping`);
      return;
    }
    process.env[`ATTEMPT_${photoId}`] = String(currentAttempts + 1);
    await tracker.markInProgress(photoId);
  } catch (e) {
    console.warn('[artwork] Dedupe tracker unavailable or failed', e);
  }
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo || !photo.processed) return;

  if (!PAINT_ENDPOINT) {
    throw new Error('PAINT_ENDPOINT is not configured');
  }

  try {
    // Build the source image URL for the paint service
    const imageSource =
      photo.secure_url ||
      (CLOUDINARY_CLOUD_NAME
        ? `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/${photo.cloudinary_id}`
        : null);

    if (!imageSource) {
      throw new Error('Cannot derive source image URL (missing photo.secure_url and CLOUDINARY_CLOUD_NAME).');
    }

    // Will hold the final artwork URL we use across steps
    // For multiple images
    let painting_urls = [];         // array of raw URLs from paint service
    let finalPaintingUrls = [];     // array of Cloudinary (preferred) or fallback to painting_urls

    const normalizeUrl = (u) =>
      String(u)
        .trim()
        .replace(/^['"(]+|[)'"]+$/g, '')   // strip leading '(' '" and trailing ) '"
        .replace(/\\u0026/g, '&')          // decode common escapes from SSE JSON
        .replace(/\\u003d/g, '=')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/');

    // Choose request shape based on endpoint
    const usePiapi = isPiapiEndpoint(PAINT_ENDPOINT);
    console.log(`[artwork] Starting job for photoId=${photoId}, using endpoint: ${PAINT_ENDPOINT}, usePiapi=${usePiapi}`);
    console.log(`[artwork] Source image URL: ${imageSource}`);
    if (usePiapi && !PAINT_API_KEY) {
      throw new Error('PAINT_API_KEY is required for PiAPI endpoint');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 200_000);

    let res;
    try {
      if (usePiapi) {
        console.log('[artwork] Sending request to PiAPI paint endpoint...');
        // PiAPI gpt-4o-image requires chat/completions streaming
        const body = {
          model: 'gpt-4o-image',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageSource } },
                { type: 'text', text: 'Generate a framed fine-art style painting based on this reference photo. Output an image' }
              ]
            }
          ],
          stream: true
        };
        res = await fetch(PAINT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${PAINT_API_KEY}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } else {
        console.log('[artwork] Sending request to legacy paint service...');
        // Legacy/simple paint service
        res = await fetch(PAINT_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(PAINT_API_KEY ? { 'Authorization': `Bearer ${PAINT_API_KEY}` } : {})
          },
          body: JSON.stringify({ image: imageSource }),
          signal: controller.signal
        });
      }
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[artwork] Paint service response status: ${res.status}`);

    if (usePiapi) {
      // --- RETRY LOGIC for PiAPI ---
      let attempt = 0;
      let maxAttempts = 3;
      let foundImageLinks = false;
      let lastChunks = '';
      while (attempt < maxAttempts && !foundImageLinks) {
        if (attempt > 0) {
          console.warn(`[artwork] PiAPI image URL not found, retrying... attempt ${attempt + 1}/${maxAttempts}`);
          await new Promise((r) => setTimeout(r, 3000));
        }
        attempt++;
        let localController = new AbortController();
        let localTimeoutId = setTimeout(() => localController.abort(), 200_000);
        let localRes;
        try {
          console.log('[artwork] Sending request to PiAPI paint endpoint...');
          const body = {
            model: 'gpt-4o-image',
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageSource } },
                  { type: 'text', text: 'Generate a framed fine-art style painting based on this reference photo. Output an image' }
                ]
              }
            ],
            stream: true
          };
          localRes = await fetch(PAINT_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Authorization': `Bearer ${PAINT_API_KEY}`
            },
            body: JSON.stringify(body),
            signal: localController.signal
          });
        } finally {
          clearTimeout(localTimeoutId);
        }
        console.log(`[artwork] PiAPI paint service response status: ${localRes.status}`);
        console.log('[artwork] Reading PiAPI stream response...');
        let chunks = '';
        for await (const chunk of localRes.body) {
          chunks += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        }
        lastChunks = chunks;
        // Find all URLs matching image extensions
        let urlMatches = chunks.match(/https?:\/\/[^\s"'()\\]+/g);
        let imgCandidates = [];
        if (urlMatches) {
          imgCandidates = urlMatches.filter(u => /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u));
        }
        // Also, parse JSON lines for embedded image links
        const jsonLines = chunks.split('\n').filter(l => l.startsWith('data:'));
        for (const line of jsonLines) {
          try {
            const obj = JSON.parse(line.replace(/^data:\s*/, ''));
            const str = JSON.stringify(obj);
            // Find all image URLs in the JSON string
            const matches = str.match(/https?:\/\/[^\s"'()\\]+/g);
            if (matches && matches.length > 0) {
              for (const m of matches) {
                if (/(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(m)) {
                  imgCandidates.push(m);
                }
              }
            }
          } catch (_) { /* ignore */ }
        }
        // Deduplicate
        painting_urls = [...new Set(imgCandidates.map(normalizeUrl))];
        if (painting_urls.length > 0) {
          foundImageLinks = true;
          console.log('[artwork] Found candidate image URLs in stream:', painting_urls);
        }
      }
      if (!painting_urls || painting_urls.length === 0) {
        console.error('[artwork] PiAPI stream did not include any image URLs');
        throw new Error('PiAPI stream did not include an image URL');
      }
      // --- Upload all generated paintings to Cloudinary ---
      for (let i = 0; i < painting_urls.length; ++i) {
        const painting_url = painting_urls[i];
        let finalUrl = painting_url;
        try {
          console.log('[artwork] Uploading painting to Cloudinary from URL:', painting_url);
          console.log('[artwork] Cloudinary upload args types:', typeof painting_url, 'options');
          const { public_id, secure_url } = await uploadImage(
            String(painting_url),
            { folder: 'art-factory/artwork', publicId: `artwork_${photoId}_${i}` }
          );
          if (secure_url) {
            finalUrl = secure_url;
            console.log('[artwork] Painting uploaded to Cloudinary:', secure_url, 'public_id:', public_id);
          } else {
            console.warn('[artwork] Cloudinary upload returned no secure_url, keeping original paint URL');
          }
        } catch (e) {
          console.warn('[artwork] Cloudinary upload failed, falling back to paint URL. src=', painting_url, 'error=', e && (e.message || e));
        }
        finalPaintingUrls.push(finalUrl);
      }
    } else {
      const data = await res.json();
      // Legacy API: only one painting_url
      let painting_url = data && data.painting_url;
      if (!painting_url || typeof painting_url !== 'string') {
        throw new Error('Paint service did not return a valid painting_url');
      }
      painting_url = normalizeUrl(painting_url);
      console.log('[artwork] Painting URL resolved from legacy service:', painting_url);
      painting_urls = [painting_url];
      // --- Upload painting to Cloudinary ---
      let finalUrl = painting_url;
      try {
        console.log('[artwork] Uploading painting to Cloudinary from URL:', painting_url);
        console.log('[artwork] Cloudinary upload args types:', typeof painting_url, 'options');
        const { public_id, secure_url } = await uploadImage(
          String(painting_url),
          { folder: 'art-factory/artwork', publicId: `artwork_${photoId}` }
        );
        if (secure_url) {
          finalUrl = secure_url;
          console.log('[artwork] Painting uploaded to Cloudinary:', secure_url, 'public_id:', public_id);
        } else {
          console.warn('[artwork] Cloudinary upload returned no secure_url, keeping original paint URL');
        }
      } catch (e) {
        console.warn('[artwork] Cloudinary upload failed, falling back to paint URL. src=', painting_url, 'error=', e && (e.message || e));
      }
      finalPaintingUrls = [finalUrl];
    }

    // Fallback: if upload failed and finalPaintingUrls wasn't set, use raw painting_urls
    if (!finalPaintingUrls || finalPaintingUrls.length === 0) finalPaintingUrls = painting_urls;

    // 2. GPT auto-description (use first painting for description)
    const mainPaintingUrl = finalPaintingUrls[0];
    console.log('[artwork] Requesting GPT auto-description for painting...');
    const description = await chat(
      'Describe a painting in 35 words.',
      `Describe the colours, medium and vibe of the painting at ${mainPaintingUrl}`
    );

    // Mark artwork as completed in tracker
    try {
      const tracker = await import('../services/artworkTracker.js').then(m => m.default || m);
      await tracker.markCompleted(photoId);
    } catch (e) {
      console.warn('[artwork] Could not mark artwork complete in tracker', e);
    }

    // 3. Save
    // If DB supports an array column image_urls, prefer that; else, insert one row per image
    let supportsArrayCol = false;
    try {
      // Try to insert with image_urls array column (if exists)
      await db('artwork')
        .insert({ photo_id: photoId, image_urls: finalPaintingUrls, description })
        .returning(['id']);
      supportsArrayCol = true;
      console.log('[artwork] Inserted artwork with image_urls array column.');
    } catch (e) {
      // Fallback: insert one row per image_url
      supportsArrayCol = false;
      console.log('[artwork] image_urls array column not supported, inserting one row per image_url...');
      for (let i = 0; i < finalPaintingUrls.length; ++i) {
        const url = finalPaintingUrls[i];
        // For the first image, use the GPT description; for others, use empty or generic
        let desc = (i === 0) ? description : '';
        const [{ id: artId }] = await db('artwork')
          .insert({ photo_id: photoId, image_url: url, description: desc })
          .returning(['id']);
        // 4. Mock-ups next (best-effort) -- only for first image
        if (i === 0) {
          let mockups = [];
          try {
            console.log('[artwork] Creating mockups...');
            mockups = await createMockups(url);
          } catch (e) {
            console.warn('createMockups failed', e);
          }
          console.log('[artwork] Updating artwork record with mockup URLs');
          await db('artwork').where({ id: artId }).update({ mockup_urls: mockups });
          // Moderation gate: require approval before publishing unless explicitly disabled
          const moderateArtwork = String(process.env.MODERATE_ARTWORK ?? 'true') === 'true';
          if (moderateArtwork) {
            console.log('[artwork] Awaiting artwork moderation before publish. artworkId:', artId);
            // ensure the flag exists (noop if column absent)
            try { await db('artwork').where({ id: artId }).update({ approved_for_publish: false }); } catch (_) {}
          } else {
            console.log('[artwork] Skipping artwork moderation. Enqueuing publish for artworkId:', artId);
            await qPublish.add('publish', { artworkId: artId }, { jobId: `publish:${artId}` });
          }
        }
      }
      return; // done
    }

    // If we reach here, image_urls array column is supported, so only one row inserted
    // Get the inserted artwork id (from the first insert above)
    const [{ id: artId }] = await db('artwork')
      .where({ photo_id: photoId })
      .orderBy('id', 'desc')
      .limit(1)
      .select('id');
    // 4. Mock-ups next (best-effort) -- only for first image
    let mockups = [];
    try {
      console.log('[artwork] Creating mockups...');
      mockups = await createMockups(mainPaintingUrl);
    } catch (e) {
      console.warn('createMockups failed', e);
    }
    console.log('[artwork] Updating artwork record with mockup URLs');
    await db('artwork').where({ id: artId }).update({ mockup_urls: mockups });
    // Moderation gate: require approval before publishing unless explicitly disabled
    const moderateArtwork = String(process.env.MODERATE_ARTWORK ?? 'true') === 'true';
    if (moderateArtwork) {
      console.log('[artwork] Awaiting artwork moderation before publish. artworkId:', artId);
      // ensure the flag exists (noop if column absent)
      try { await db('artwork').where({ id: artId }).update({ approved_for_publish: false }); } catch (_) {}
    } else {
      console.log('[artwork] Skipping artwork moderation. Enqueuing publish for artworkId:', artId);
      await qPublish.add('publish', { artworkId: artId }, { jobId: `publish:${artId}` });
    }
  } catch (err) {
    // Clear in-progress tracker entry on failure
    try {
      const tracker = await import('../services/artworkTracker.js').then(m => m.default || m);
      await tracker.clearInProgress(photoId);
    } catch (e) {
      console.warn('[artwork] Could not clear in-progress state in tracker', e);
    }
    if (err && err.name === 'AbortError') {
      console.error(`[artwork] Paint service request timed out after ${200}s`);
      throw new Error('Paint service request timed out (200s)');
    }
    console.error('artwork workflow failed', { photoId, err });
    throw err;
  }
}
