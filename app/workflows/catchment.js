import db from '../db/client.js';
import { chat, chatJson } from '../services/openai.js';
import { createCollection, setMetafieldsGraphQL } from '../services/shopify.js';
import { qLocation } from '../queue/queues.js';

import * as google from '../services/google.js';
import * as openverse from '../services/openverse.js';
import { getSystemPrompt } from '../db/systemPrompts.js';

export default async function catchment(job) {
  const { catchmentId, imageSource = 'google' } = job.data;
  const row = await db('catchments').where({ id: catchmentId }).first();
  if (!row || row.processed) return;

  const sysPrompt = await getSystemPrompt('catchment_intro_system');
  const userPromptTemplate = await getSystemPrompt('catchment_intro_user');
  const userPrompt = userPromptTemplate?.replace('{{catchmentName}}', row.name);

  const safeSystem = typeof sysPrompt === 'string' ? sysPrompt : 'You are a helpful assistant.';
  const safeUser = typeof userPrompt === 'string' ? userPrompt : `Write a short introduction for ${row.name}.`;

  let blurb = row.intro;
let latForMeta = row.lat;
let lonForMeta = row.lon;

if (!blurb) {
  try {
    const json = await chatJson({
      system: safeSystem,
      user: safeUser,
      schema: {
        type: 'object',
        properties: {
          blurb: { type: 'string' },
          latitude: { type: 'number' },
          longitude: { type: 'number' }
        },
        required: ['blurb', 'latitude', 'longitude'],
        additionalProperties: false
      },
      temperature: 0
    });

    blurb = typeof json?.blurb === 'string' ? json.blurb.trim() : blurb;

    const latParsed = Number(json?.latitude);
    const lonParsed = Number(json?.longitude);
    if (Number.isFinite(latParsed)) latForMeta = latParsed;
    if (Number.isFinite(lonParsed)) lonForMeta = lonParsed;

    if (!blurb) throw new Error('missing blurb');
  } catch (e) {
    // Fallback to plain text chat if JSON parsing fails
    blurb = await chat(safeSystem, safeUser);
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
    processed: true
  });

  await qLocation.add('location', { catchmentId, imageSource: row.image_source || imageSource }, { jobId: `location:${catchmentId}` });
}
