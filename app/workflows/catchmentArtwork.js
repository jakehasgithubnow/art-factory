import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat, chatJson, generateImage } from '../services/openai.js';
import { uploadImage } from '../services/cloudinary.js';

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
  const ctx = {
    catchmentName: c.name || '',
    catchmentname: c.name || '',
    lat: c.lat,
    lon: c.lon,
    phrases: JSON.stringify(phrasesArr)
  };

  // Fetch enabled catchment-scoped style prompts
  const { getEnabled } = await import('../db/stylePrompts.js');
  const prompts = await getEnabled('catchment');
  if (!prompts || prompts.length === 0) {
    console.log('[catchmentArtwork] No enabled catchment-scoped style prompts found.');
    return;
  }

  // For each style prompt, generate image(s) with PiAPI/OpenAI (no base image; use text + coords)
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

    let imageUrls = [];
    try {
      imageUrls = await generateImage({
        prompt: cleanedPrompt,
        imageUrl: null,
        additionalImageUrls: promptImageUrls
      });
    } catch (e) {
      console.warn('[catchmentArtwork] generateImage failed', { catchmentId, stylePromptId: stylePrompt.id, err: e && (e.message || e) });
      imageUrls = [];
    }

    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      console.warn('[catchmentArtwork] No image URLs returned for catchment/style', { catchmentId, stylePromptId: stylePrompt.id });
      continue;
    }

    // Upload first image to Cloudinary and persist one row per catchment/style (unique constraint)
    const firstUrl = imageUrls[0];
    let finalUrl = firstUrl;
    try {
      const { secure_url } = await uploadImage(String(firstUrl), {
        folder: 'art-factory/catchment-artwork',
        publicId: `catchment_${catchmentId}_${stylePrompt.id}_0`
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

    // Insert catchment_artwork row, idempotent per catchment/style
    try {
      await db('catchment_artwork')
        .insert({
          catchment_id: catchmentId,
          style_prompt_id: stylePrompt.id,
          style_name: stylePrompt.text,
          image_url: finalUrl,
          description,
          approved_for_publish: false
        })
        .onConflict(['catchment_id', 'style_prompt_id'])
        .ignore();
    } catch (e) {
      console.error('[catchmentArtwork] Insert failed', { catchmentId, stylePromptId: stylePrompt.id, err: e && (e.message || e) });
    }
  }
}
