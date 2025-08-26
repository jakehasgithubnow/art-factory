import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat, chatJson, generateImage } from '../services/openai.js';
import { createMockups } from '../services/framemock.js';
import { uploadImage } from '../services/cloudinary.js';
import { qPublish } from '../queue/queues.js';
import { generateImageWithGemini } from '../services/openrouter.js';

function applyTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (ctx && ctx[k] != null ? String(ctx[k]) : ''));
}

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

  let locMeta = {};
  try {
    if (photo?.location_id) {
      const meta = await db('locations as l')
        .leftJoin('catchments as c', 'c.id', 'l.catchment_id')
        .where('l.id', photo.location_id)
        .first([
          db.raw('l.name as location_name'),
          db.raw('c.name as catchment_name'),
          db.raw('c.phrases as catchment_phrases'),
          db.raw('l.category as location_category')
        ]);
      const phrasesArr = Array.isArray(meta?.catchment_phrases) ? meta.catchment_phrases : [];
      locMeta = {
        locationName: meta?.location_name || '',
        catchmentName: meta?.catchment_name || '',
        locationCategory: meta?.location_category || '',
        phrases: JSON.stringify(phrasesArr)
      };
    }
  } catch (_) {}

  if (!PAINT_ENDPOINT) {
    console.warn('PAINT_ENDPOINT is not configured; PiAPI/legacy paint disabled. Gemini provider will still run.');
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

  // Fetch enabled style prompts: always include 'location'; include 'icon' only for icon photos
  const { getEnabled } = await import('../db/stylePrompts.js');
  let enabledPrompts = await getEnabled('location');
  if (photo.icon === true) {
    try {
      const iconPrompts = await getEnabled('icon');
      if (Array.isArray(iconPrompts) && iconPrompts.length > 0) {
        enabledPrompts = [...enabledPrompts, ...iconPrompts];
      }
    } catch (_) {}
  }

  // Category filter: only run prompts whose categories include the photo's location category
  const photoCategory = String(locMeta?.locationCategory || '').trim();
  enabledPrompts = (enabledPrompts || []).filter(p => {
    const cats = p?.categories;
    if (!cats || (Array.isArray(cats) && cats.length === 0)) return true; // unrestricted
    if (!photoCategory) return false; // no location category -> no restricted prompts
    return Array.isArray(cats) && cats.includes(photoCategory);
  });

  if (!enabledPrompts || enabledPrompts.length === 0) {
    console.warn('[artwork] No enabled style prompts matched photo location category. Skipping paint generation.');
    return;
  }

    /// Loop for each style prompt, process independently
    let res; // Declare res in the outer scope of the for-loop
    for (const stylePrompt of enabledPrompts) {
      const controller = new AbortController();
      // PiAPI can take up to 300s – set generous timeout
      const timeoutId = setTimeout(() => controller.abort(), 310_000);
      // Track provider across try/finally scope
      let providerName = 'piapi';

      try {
        // Interpolate template variables in the style prompt (supports both camelCase and lowercase keys).
        const resolvedPrompt = applyTemplate(stylePrompt.text, {
          ...locMeta,
          locationname: (locMeta && locMeta.locationName) || '',
          catchmentname: (locMeta && locMeta.catchmentName) || ''
        });
        const provider = String(stylePrompt?.provider || 'piapi').toLowerCase();
        providerName = provider;
        if (provider === 'gemini') {
          // Parse image URLs embedded in the style prompt and pass them to Gemini
          const promptUrlMatches = (resolvedPrompt && resolvedPrompt.match(/https?:\/\/[^\s"'()\\]+/g)) || [];
          const promptImageUrls = Array.from(new Set(
            promptUrlMatches.filter(u =>
              /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u) || /res\.cloudinary\.com/i.test(u)
            )
          ));
          const finalPromptImageUrls = promptImageUrls.filter(u => u !== imageSource);

          // Remove any image URLs from the text prompt to avoid leaking raw links
          let cleanedPrompt = resolvedPrompt;
          for (const u of finalPromptImageUrls) cleanedPrompt = cleanedPrompt.split(u).join('');
          cleanedPrompt = cleanedPrompt.replace(/\s{2,}/g, ' ').trim();

          console.log(`[artwork] Calling OpenRouter(Gemini) with style prompt (cleaned): ${cleanedPrompt}`);
          if (finalPromptImageUrls.length) {
            console.log('[artwork] Including prompt image URLs for Gemini:', finalPromptImageUrls);
          }

          const imageUrls = await generateImageWithGemini({
            prompt: cleanedPrompt,
            imageUrl: imageSource,
            additionalImageUrls: finalPromptImageUrls,
          });
          let localPromptPaintingUrls = [];
          if (imageUrls && imageUrls.length > 0) {
            localPromptPaintingUrls = imageUrls;
          } else {
            console.warn('[artwork] No image URLs returned from Gemini (OpenRouter)');
          }
          res = { status: imageUrls && imageUrls.length > 0 ? 200 : 500, ok: imageUrls && imageUrls.length > 0, body: null, promptPaintingUrls: localPromptPaintingUrls };
        } else if (usePiapi) {
          // --- DEBUG LOGS START ---
          console.log('[artwork][DEBUG] Piapi debug pre-flight:');
          console.log('[artwork][DEBUG] usePiapi:', usePiapi);
          console.log('[artwork][DEBUG] PAINT_ENDPOINT:', PAINT_ENDPOINT);
          console.log('[artwork][DEBUG] PAINT_API_KEY present:', !!PAINT_API_KEY);
          console.log('[artwork][DEBUG] imageSource:', imageSource);
          try {
            const headRes = await fetch(imageSource, { method: 'HEAD' });
            console.log('[artwork][DEBUG] image HEAD status:', headRes.status);
            if (!headRes.ok) console.warn('[artwork][DEBUG] Image URL not accessible to Piapi');
          } catch (e) {
            console.warn('[artwork][DEBUG] Error checking image URL reachability:', e);
          }
          // --- DEBUG LOGS END ---
// Use updated generateImage helper with both prompt and imageUrl
          // Parse image URLs embedded in the style prompt and pass them to PiAPI
          const promptUrlMatches = (resolvedPrompt && resolvedPrompt.match(/https?:\/\/[^\s"'()\\]+/g)) || [];
          const promptImageUrls = Array.from(new Set(
            promptUrlMatches.filter(u =>
              /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u) || /res\.cloudinary\.com/i.test(u)
            )
          ));
          const finalPromptImageUrls = promptImageUrls.filter(u => u !== imageSource);

          // Remove any image URLs from the text prompt to avoid leaking raw links
          let cleanedPrompt = resolvedPrompt;
          for (const u of finalPromptImageUrls) cleanedPrompt = cleanedPrompt.split(u).join('');
          cleanedPrompt = cleanedPrompt.replace(/\s{2,}/g, ' ').trim();

          console.log(`[artwork] Calling PiAPI generateImage() with style prompt (cleaned): ${cleanedPrompt}`);
          if (finalPromptImageUrls.length) {
            console.log('[artwork] Including prompt image URLs for PiAPI:', finalPromptImageUrls);
          }

          const imageUrls = await generateImage({
            prompt: cleanedPrompt,
            imageUrl: imageSource,
            additionalImageUrls: finalPromptImageUrls,
          });
          let localPromptPaintingUrls = [];
          if (imageUrls && imageUrls.length > 0) {
            localPromptPaintingUrls = imageUrls;
          } else {
            console.warn('[artwork] No image URLs returned from PiAPI generateImage()');
          }
          res = { status: imageUrls && imageUrls.length > 0 ? 200 : 500, ok: imageUrls && imageUrls.length > 0, body: null, promptPaintingUrls: localPromptPaintingUrls };
        } else {
          console.log(`[artwork] Sending request to legacy paint service with style prompt: ${resolvedPrompt}`);
          res = await fetch(PAINT_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(PAINT_API_KEY ? { 'Authorization': `Bearer ${PAINT_API_KEY}` } : {})
            },
            body: JSON.stringify({ image: imageSource, prompt: resolvedPrompt }),
            signal: controller.signal
          });
        }
      } finally {
        clearTimeout(timeoutId);
      }

      // Removed redundant post-loop res.status log to prevent ReferenceError when res is undefined

      // Handle PiAPI SSE stream parsing
      // Use the PiAPI-provided list if present on res, otherwise fallback to empty array
      let promptPaintingUrls = (res && res.promptPaintingUrls) ? res.promptPaintingUrls : [];
      let promptFinalUrls = [];

      if (!usePiapi && providerName !== 'gemini') {
        const data = await res.json();
        if (data && data.painting_url) promptPaintingUrls = [normalizeUrl(data.painting_url)];
      }

      // Upload each to Cloudinary
      for (let i = 0; i < promptPaintingUrls.length; i++) {
        let finalUrl = promptPaintingUrls[i];
        try {
          const { public_id, secure_url } = await uploadImage(
            String(finalUrl),
            { folder: 'art-factory/artwork', publicId: `artwork_${photoId}_${stylePrompt.id}_${i}` }
          );
          if (secure_url) finalUrl = secure_url;
        } catch (e) {
          console.warn('[artwork] Upload failed for', finalUrl, e);
        }
        promptFinalUrls.push(finalUrl);
      }

      // Fallback
      if (promptFinalUrls.length === 0) promptFinalUrls = promptPaintingUrls;

      // Description (now JSON: {title, description})
      const mainPaintingUrl = promptFinalUrls[0];
      let description = '';
      if (mainPaintingUrl) {
        const { getByKey } = await import('../db/systemPrompts.js');
        const sysPromptRow = await getByKey('artwork_description_system');
        const userPromptRow = await getByKey('artwork_description_user');
        const defaultUser = 'Describe the colours, medium and vibe of the painting.';
        const ctx = { imageUrl: String(mainPaintingUrl), ...locMeta };
        const sysPrompt = applyTemplate(sysPromptRow?.text, ctx);
        const userPromptTemplate = applyTemplate(userPromptRow?.text || defaultUser, ctx);
        const instruction = userPromptTemplate.replace('at {url}', '').replace('{url}', '').trim();
        const model = sysPromptRow?.model || userPromptRow?.model || 'gpt-4o-mini';

        try {
          const details = await chatJson({
            system: `${sysPrompt}\n\nReturn ONLY minified JSON strictly matching the schema.`,
            user: { text: `Generate an evocative, concise artwork title and ~35-word description for this painting. ${instruction}`, imageUrls: [String(mainPaintingUrl)] },
            schema: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['title', 'description'],
              additionalProperties: false
            },
            temperature: 0.7,
            model
          });
          if (details && typeof details.title === 'string' && typeof details.description === 'string') {
            description = JSON.stringify({ title: details.title, description: details.description });
          } else {
            throw new Error('chatJson did not return expected fields');
          }
        } catch (e) {
          console.warn('[artwork] Failed to generate JSON details; falling back to text description', e);
          try {
            const textDesc = await chat(
              sysPrompt,
              { text: instruction, imageUrls: [String(mainPaintingUrl)] },
              0.7,
              model
            );
            // Fallback: store as plain text; publish.js will handle legacy format
            description = textDesc;
          } catch (e2) {
            console.warn('[artwork] Fallback description failed', e2);
          }
        }
      } else {
        console.warn('[artwork] No mainPaintingUrl found, skipping description generation.');
      }

      // Mark complete
      try {
        const tracker = await import('../services/artworkTracker.js').then(m => m.default || m);
        await tracker.markCompleted(photoId);
      } catch (e) {
        console.warn('[artwork] Could not mark artwork complete in tracker', e);
      }

      // Save to DB — one artwork row per photo per style (first image only)
      if (mainPaintingUrl) {
        const inserted = await db('artwork')
          .insert({
            photo_id: photoId,
            style_prompt_id: stylePrompt.id,
            style_name: stylePrompt.text,
            image_url: mainPaintingUrl,
            description: description
          })
          .onConflict(['photo_id', 'style_prompt_id']).ignore()
          .returning(['id']);
        const artId = inserted?.[0]?.id;
        if (!artId) {
          console.warn(`[artwork] No artwork inserted for photoId ${photoId} and style ${stylePrompt.id} (possibly duplicate). Skipping mockup/publish steps for this style.`);
          // Avoid any undefined variables from lingering from earlier steps
          res = null;
        } else {
          // Always require moderation approval before mockup/publish
          try {
            await db('artwork').where({ id: artId }).update({ approved_for_publish: false });
          } catch {}
        }
      } else {
        console.warn('[artwork] No mainPaintingUrl to save for this style; skipping DB insert.');
      }
    }

    // Exit after per-style processing to avoid legacy duplicate flow
    return;

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
        let localTimeoutId = setTimeout(() => localController.abort(), 310_000);
        let localRes;
        try {
          console.log('[artwork] Sending request to PiAPI paint endpoint...');
          const body = {
            model: 'gpt-4o-image',
            messages: [

              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageSource } }
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
    const { getByKey: getSysPrompt } = await import('../db/systemPrompts.js');
    const sysPromptRow2 = await getSysPrompt('artwork_description_system');
    const sysPrompt2 = sysPromptRow2?.text;
    const userPromptRow2 = await getSysPrompt('artwork_description_user');
    const userPromptTemplate2 = userPromptRow2?.text || 'Describe the colours, medium and vibe of the painting at {url}';
    const instruction2 = userPromptTemplate2.replace('at {url}', '').replace('{url}', '').trim();
    const description = await chat(
      sysPrompt2,
      { text: instruction2, imageUrls: [String(mainPaintingUrl)] }
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
        const inserted = await db('artwork')
          .insert({ photo_id: photoId, image_url: url, description: desc })
          .returning(['id']);
        const artId = inserted?.[0]?.id;
        if (!artId) {
          console.warn(`[artwork] No artwork inserted for photoId ${photoId} (possibly duplicate). Skipping mockup/publish steps for this image.`);
          continue;
        }
        // 4. Mock-ups next (best-effort) -- only for first image
        if (i === 0) {
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
    // 4. Moderation required before mockup/publish
    console.log('[artwork] Awaiting artwork moderation before publish. artworkId:', artId);
    try { await db('artwork').where({ id: artId }).update({ approved_for_publish: false }); } catch (_) {}
  } catch (err) {
    // Clear in-progress tracker entry on failure
    try {
      const tracker = await import('../services/artworkTracker.js').then(m => m.default || m);
      await tracker.clearInProgress(photoId);
    } catch (e) {
      console.warn('[artwork] Could not clear in-progress state in tracker', e);
    }
    if (err && err.name === 'AbortError') {
      console.error(`[artwork] Paint service request timed out after ${310}s`);
      throw new Error('Paint service request timed out (310s)');
    }
    console.error('artwork workflow failed', { photoId, err });
    throw err;
  }
}
