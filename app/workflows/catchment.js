import db from '../db/client.js';
import { chat, chatJson } from '../services/openai.js';
import { createCollection, setMetafieldsGraphQL, setCollectionTemplateGraphQL, updateCollectionTemplateREST } from '../services/shopify.js';
import { qLocation, qCatchmentArtwork } from '../queue/queues.js';

import * as google from '../services/google.js';
import * as openverse from '../services/openverse.js';
import { getByKey as getSystemPromptRow } from '../db/systemPrompts.js';

function applyTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (ctx?.[k] != null ? String(ctx[k]) : ''));
}

export default async function catchment(job) {
  const { catchmentId, imageSource = 'google' } = job.data;
  const row = await db('catchments').where({ id: catchmentId }).first();
  if (!row) return;

  const sysRow = await getSystemPromptRow('catchment_intro_system');
  const userRow = await getSystemPromptRow('catchment_intro_user');
  const model = sysRow?.model || userRow?.model || 'gpt-4o-mini';
  const ctx = { catchmentName: row.name, lat: row.lat, lon: row.lon };
  const sysPrompt = applyTemplate(sysRow?.text, ctx);
  const userPrompt = applyTemplate(userRow?.text, ctx);

  const safeSystem = typeof sysPrompt === 'string' ? sysPrompt : 'You are a helpful assistant.';
  const safeUser = typeof userPrompt === 'string' ? userPrompt : `Write a short introduction for ${row.name}.`;

  // If already processed but missing phrases, backfill phrases only and exit
  if (row.processed && (!Array.isArray(row.phrases) || row.phrases.length === 0)) {
    try {
      const json = await chatJson({
        system: safeSystem,
        user: safeUser,
        schema: {
          type: 'object',
          properties: {
            blurb: { type: 'string' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
            phrases: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['blurb', 'latitude', 'longitude'],
          additionalProperties: false
        },
        temperature: 0,
        model
      });

      const parsedPhrases = Array.isArray(json?.phrases)
        ? json.phrases.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
        : [];

      if (parsedPhrases.length) {
        await db('catchments')
          .where({ id: catchmentId })
          .update({ phrases: db.raw('?::jsonb', [JSON.stringify(parsedPhrases)]) });
      }
    } catch (e) {
      // ignore backfill errors; keep existing data
    }
    return;
  }

  let blurb = row.intro;
let latForMeta = row.lat;
let lonForMeta = row.lon;
let phrases = Array.isArray(row?.phrases) ? row.phrases : [];

if (!blurb || !phrases.length) {
  try {
    const json = await chatJson({
      system: safeSystem,
      user: safeUser,
      schema: {
        type: 'object',
        properties: {
          blurb: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
          phrases: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['blurb', 'latitude', 'longitude'],
        additionalProperties: false
      },
      temperature: 0,
      model
    });

    blurb = typeof json?.blurb === 'string' ? json.blurb.trim() : blurb;

    const latParsed = Number(json?.latitude);
    const lonParsed = Number(json?.longitude);
    if (Number.isFinite(latParsed)) latForMeta = latParsed;
    if (Number.isFinite(lonParsed)) lonForMeta = lonParsed;

    const parsedPhrases = Array.isArray(json?.phrases)
      ? json.phrases.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
      : [];
    if (parsedPhrases.length) phrases = parsedPhrases;

    if (!blurb) throw new Error('missing blurb');
  } catch (e) {
    // Fallback to plain text chat if JSON parsing fails
    blurb = await chat(safeSystem, safeUser, 0.7, model);
  }
}

  // Example: perform image search before proceeding (if required by workflow)
  const imageService = imageSource === 'openverse' ? openverse : google;
  // This example just fetches but doesn't yet store images — integrate per business logic
  try {
    const images = await imageService.imageSearch(row.name, 10);
    if (typeof job.log === 'function') {
      job.log({ event: 'image_search', provider: imageSource, count: images.length });
    }
  } catch (e) {
    if (typeof job.log === 'function') {
      job.log({ event: 'image_search_error', provider: imageSource, error: e.message });
    }
  }

  const handle = row.name.toLowerCase().replace(/\s+/g, '-');
  const shopifyId = await createCollection(row.name, blurb || safeUser, handle);

  // Ensure collection theme template is 'geographic'
  try {
    const collectionOwnerId = `gid://shopify/Collection/${shopifyId}`;
    const upd = await setCollectionTemplateGraphQL(collectionOwnerId, 'geographic');
    const applied =
      upd?.collection?.templateSuffix ||
      upd?.collectionUpdate?.collection?.templateSuffix ||
      null;

    if (typeof job.log === 'function') {
      job.log({ event: 'collection_template_set', ownerId: collectionOwnerId, applied });
    }

    if (applied !== 'geographic') {
      await updateCollectionTemplateREST(shopifyId, 'geographic');
      if (typeof job.log === 'function') job.log({ event: 'collection_template_rest_fallback', id: shopifyId });
    }
  } catch (e) {
    try {
      await updateCollectionTemplateREST(shopifyId, 'geographic');
      if (typeof job.log === 'function') job.log({ event: 'collection_template_rest_on_error', id: shopifyId, error: e.message });
    } catch (e2) {
      if (typeof job.log === 'function') job.log({ event: 'collection_template_set_error', error: e2.message });
    }
  }

// Attach collection metafields for location data (latitude, longitude, city_name)
try {
  const ownerId = `gid://shopify/Collection/${shopifyId}`;
  const meta = [
    { namespace: 'location', key: 'latitude', type: 'single_line_text_field', value: String(latForMeta) },
    { namespace: 'location', key: 'longitude', type: 'single_line_text_field', value: String(lonForMeta) },
    { namespace: 'location', key: 'city_name', type: 'single_line_text_field', value: row.name }
  ];
  await setMetafieldsGraphQL(ownerId, meta);
  if (typeof job.log === 'function') job.log({ event: 'collection_metafields_set', ownerId, meta_count: meta.length });
} catch (e) {
  if (typeof job.log === 'function') job.log({ event: 'collection_metafields_error', error: e.message });
}

  await db('catchments').where({ id: catchmentId }).update({
    intro: blurb,
    shopify_id: shopifyId,
    processed: true,
    phrases: db.raw('?::jsonb', [JSON.stringify(phrases)])
  });

  // Enqueue catchment-level artwork generation (once per catchment, using catchment lat/lon)
  try {
    await qCatchmentArtwork.add('catchmentArtwork', { catchmentId }, { jobId: `catchmentArtwork:${catchmentId}` });
  } catch (e) {
    if (typeof job.log === 'function') job.log({ event: 'enqueue_catchment_artwork_error', error: e.message });
  }

  await qLocation.add('location', { catchmentId, imageSource: row.image_source || imageSource }, { jobId: `location:${catchmentId}` });
}
