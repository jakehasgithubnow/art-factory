import db from '../db/client.js';
import { chat } from '../services/openai.js';
import { createCollection } from '../services/shopify.js';
import { qLocation } from '../queue/queues.js';

export default async function catchment(job) {
  const { catchmentId } = job.data;
  const row = await db('catchments').where({ id: catchmentId }).first();
  if (!row || row.processed) return;

  const intro50 = row.intro ?? await chat(
    'You are a concise travel copywriter. Reply with <=50 words.',
    `Write a 50-word warm introduction to visiting ${row.name}.`
  );

  const handle = row.name.toLowerCase().replace(/\s+/g, '-');
  const shopifyId = await createCollection(row.name, intro50, handle);

  await db('catchments').where({ id: catchmentId }).update({
    intro: intro50,
    shopify_id: shopifyId,
    processed: true
  });

  await qLocation.add('location', { catchmentId }, { jobId: `location:${catchmentId}` });
}