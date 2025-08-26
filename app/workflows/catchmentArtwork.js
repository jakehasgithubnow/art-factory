import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat, chatJson, generateImage } from '../services/openai.js';
import { uploadImage } from '../services/cloudinary.js';
import { generateImageWithGemini } from '../services/openrouter.js';

function applyTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (ctx && ctx[k] != null ? String(ctx[k]) : ''));
}

export default async function catchmentArtwork(job) {
  const { catchmentId } = job.data;
  if (!catchmentId) return;

  // Load catchment row
  const c = await db('catchments').where({ id: catchmentId }).first();
  if (!c) return;

  // Context uses catchment lat/lon
  const phrasesArr = Array.isArray(c?.phrases) ? c.phrases : [];
  const phrasesBulleted = phrasesArr
    .map(p => (typeof p === 'string' ? `- ${p}`.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const ctx = {
    catchmentName: c.name || '',
    catchmentname: c.name || '',
    lat: c.lat,
    lon: c.lon,
    // Structured JSON form
    phrases: JSON.stringify(phrasesArr),
    // Human-friendly variants
    phrasesBulleted,
    phrasesCsv: phrasesArr.filter(p => typeof p === 'string' && p.trim()).join(', ')
  };
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'catchmentArtwork', event: 'ctx_ready', catchmentId, phrases_count: phrasesArr.length })); } catch (_) {}

  // Ensure pseudo-location and pseudo-photo for catchment so we can reuse the unified artwork -> moderation -> publish flow
  // Pseudo location: one row per catchment (unique by (catchment_id, lower(name)))
  const pseudoLocationName = `Catchment – ${c.name || ''}`;
  let pseudoLocation = await db('locations')
    .where({ catchment_id: catchmentId })
    .andWhereRaw('lower(name) = lower(?)', [pseudoLocationName])
    .first();

  if (!pseudoLocation) {
    try {
      const insLoc = await db('locations')
        .insert({
          catchment_id: catchmentId,
          name: pseudoLocationName,
          category: 'catchment',
          // populate Google-esque lat/lng fields used by publish.js
          g_lat: c.lat,
          g_lng: c.lon,
          processed: true
        })
        .returning(['id', 'name']);
      pseudoLocation = insLoc?.[0] || null;
    } catch (e) {
      // Concurrent creation safety: if unique constraint hit, re-select
      pseudoLocation = await db('locations')
        .where({ catchment_id: catchmentId })
        .andWhereRaw('lower(name) = lower(?)', [pseudoLocationName])
        .first();
    }
  }

  if (!pseudoLocation || !pseudoLocation.id) {
    console.warn('[catchmentArtwork] Failed to ensure pseudo-location for catchment', { catchmentId });
    return;
  }

  // Pseudo photo: one row per pseudo-location/catchment
  const pseudoSrcUrl = `catchment:${catchmentId}`;
  let pseudoPhoto = await db('photos')
    .where({ location_id: pseudoLocation.id, src_url: pseudoSrcUrl })
    .first();

  if (!pseudoPhoto) {
    try {
      const insPhoto = await db('photos')
        .insert({
          location_id: pseudoLocation.id,
          src_url: pseudoSrcUrl,
          kept: true,
          processed: true
        })
        .returning(['id']);
      pseudoPhoto = insPhoto?.[0] || null;
    } catch (e) {
      // Concurrent creation safety: if unique constraint hit, re-select
      pseudoPhoto = await db('photos')
        .where({ location_id: pseudoLocation.id, src_url: pseudoSrcUrl })
        .first();
    }
  }
  const photoId = pseudoPhoto?.id;
  if (!photoId) {
    console.warn('[catchmentArtwork] Failed to ensure pseudo-photo for catchment', { catchmentId, locationId: pseudoLocation.id });
    return;
  }

  // Fetch enabled catchment-scoped style prompts
  const { getEnabled } = await import('../db/stylePrompts.js');
  const prompts = await getEnabled('catchment');
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'catchmentArtwork', event: 'prompts_loaded', count: Array.isArray(prompts) ? prompts.length : 0 })); } catch (_) {}
  if (!prompts || prompts.length === 0) {
    console.log('[catchmentArtwork] No enabled catchment-scoped style prompts found.');
    return;
  }

  // For each style prompt, generate image(s) via provider (Gemini or PiAPI). No base image; use text + refs.
  for (const stylePrompt of prompts) {
    // Resolve and clean prompt; allow image URLs embedded in prompt text as references
    const resolved = applyTemplate(stylePrompt.text, ctx);

    // Extract any image URLs and strip them from the text so we can pass via additionalImageUrls param
    const urlMatches = (resolved && resolved.match(/https?:\/\/[^\s"'()\\]+/g)) || [];
    const promptImageUrls = Array.from(new Set(
      urlMatches.filter(u => /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u) || /res\.cloudinary\.com/i.test(u))
    ));
    let cleanedPrompt = resolved;
    for (const u of promptImageUrls) cleanedPrompt = cleanedPrompt.split(u).join('');
    cleanedPrompt = cleanedPrompt.replace(/\s{2,}/g, ' ').trim();
    try { console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'catchmentArtwork', event: 'prompt_resolved', style_prompt_id: stylePrompt.id, has_refs: promptImageUrls.length > 0, refs_count: promptImageUrls.length, preview: cleanedPrompt.slice(0, 140) })); } catch (_) {}

    const provider = String(stylePrompt?.provider || 'piapi').toLowerCase();
    let imageUrls = [];
    try {
      if (provider === 'gemini') {
        imageUrls = await generateImageWithGemini({
          prompt: cleanedPrompt,
          imageUrl: null,
          additionalImageUrls: promptImageUrls
        });
      } else {
        imageUrls = await generateImage({
          prompt: cleanedPrompt,
          imageUrl: null,
          additionalImageUrls: promptImageUrls
        });
      }
    } catch (e) {
      console.warn('[catchmentArtwork] generateImage provider call failed', { provider, catchmentId, stylePromptId: stylePrompt.id, err: e && (e.message || e) });
      imageUrls = [];
    }

    // Fallback: reinforce instruction to produce an output image if first attempt returned none
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      try {
        const reinforced = cleanedPrompt + '\n\nReturn an output image. Do not return text. Provide the final image as an output_image.';
        const retryUrls = await generateImage({
          prompt: reinforced,
          imageUrl: null,
          additionalImageUrls: promptImageUrls
        });
        if (Array.isArray(retryUrls) && retryUrls.length > 0) {
          imageUrls = retryUrls;
        }
      } catch (e2) {
        console.warn('[catchmentArtwork] generateImage retry failed', { catchmentId, stylePromptId: stylePrompt.id, err: e2 && (e2.message || e2) });
      }
    }

    try { console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'catchmentArtwork', event: 'generateImage_result', style_prompt_id: stylePrompt.id, count: Array.isArray(imageUrls) ? imageUrls.length : 0 })); } catch (_) {}

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      console.warn('[catchmentArtwork] No image URLs returned for catchment/style', { catchmentId, stylePromptId: stylePrompt.id });
      continue;
    }

    // Upload first image to Cloudinary and persist one row per catchment/style (unique constraint)
    const firstUrl = imageUrls[0];
    let finalUrl = firstUrl;
    try {
      const { secure_url } = await uploadImage(String(firstUrl), {
        folder: 'art-factory/artwork',
        publicId: `artwork_${photoId}_${stylePrompt.id}_0`
      });
      if (secure_url) finalUrl = secure_url;
    } catch (e) {
      console.warn('[catchmentArtwork] Cloudinary upload failed, using original URL', e);
    }

    // Generate a title/description JSON for the artwork using existing system prompts
    let description = '';
    try {
      const { getByKey } = await import('../db/systemPrompts.js');
      const sysPromptRow = await getByKey('artwork_description_system');
      const userPromptRow = await getByKey('artwork_description_user');
      const defaultUser = 'Describe the colours, medium and vibe of the painting.';
      const sysPrompt = applyTemplate(sysPromptRow?.text, { imageUrl: String(finalUrl), ...ctx });
      const userPromptTemplate = applyTemplate(userPromptRow?.text || defaultUser, { imageUrl: String(finalUrl), ...ctx });
      const instruction = userPromptTemplate.replace('at {url}', '').replace('{url}', '').trim();
      const model = sysPromptRow?.model || userPromptRow?.model || 'gpt-4o-mini';

      const details = await chatJson({
        system: `${sysPrompt}\n\nReturn ONLY minified JSON strictly matching the schema.`,
        user: { text: `Generate an evocative, concise artwork title and ~35-word description for this painting. ${instruction}`, imageUrls: [String(finalUrl)] },
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
      }
    } catch (e) {
      console.warn('[catchmentArtwork] Description generation failed; storing empty description', e);
    }

    // Insert into unified artwork table (one per photo/style), idempotent on (photo_id, style_prompt_id)
    try {
      const ins = await db('artwork')
        .insert({
          photo_id: photoId,
          style_prompt_id: stylePrompt.id,
          style_name: stylePrompt.text,
          image_url: finalUrl,
          description,
          approved_for_publish: false
        })
        .onConflict(['photo_id', 'style_prompt_id'])
        .ignore()
        .returning(['id']);
      const insertedId = ins?.[0]?.id || null;
      try { console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'catchmentArtwork', event: 'artwork_inserted', photo_id: photoId, style_prompt_id: stylePrompt.id, id: insertedId })); } catch (_) {}
    } catch (e) {
      console.error('[catchmentArtwork] Insert into artwork failed', { catchmentId, photoId, stylePromptId: stylePrompt.id, err: e && (e.message || e) });
    }
  }
}
