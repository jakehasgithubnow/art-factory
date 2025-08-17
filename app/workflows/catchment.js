import db from '../db/client.js';
import { chat } from '../services/openai.js';
import { createCollection } from '../services/shopify.js';
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

  const intro50 = row.intro ?? await chat(safeSystem, safeUser);

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
  const shopifyId = await createCollection(row.name, intro50, handle);

  await db('catchments').where({ id: catchmentId }).update({
    intro: intro50,
    shopify_id: shopifyId,
    processed: true
  });

  await qLocation.add('location', { catchmentId, imageSource: row.image_source || imageSource }, { jobId: `location:${catchmentId}` });
}
