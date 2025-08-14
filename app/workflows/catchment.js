import db from '../db/client.js';
import { chat } from '../services/openai.js';
import { createCollection } from '../services/shopify.js';
import { qLocation } from '../queue/queues.js';

import * as google from '../services/google.js';
import * as openverse from '../services/openverse.js';

export default async function catchment(job) {
  const { catchmentId, imageSource = 'google' } = job.data;
  const row = await db('catchments').where({ id: catchmentId }).first();
  if (!row || row.processed) return;

  const intro50 = row.intro ?? await chat(
    'You are a concise travel copywriter. Reply with <=50 words.',
    `Write a 50-word warm introduction to visiting ${row.name}.`
  );

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
