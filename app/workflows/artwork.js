import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat } from '../services/openai.js';
import { createMockups } from '../services/framemock.js';
import { qPublish } from '../queue/queues.js';

// Read configuration (prefer env helper, fallback to process.env)
import { env } from '../config/env.js';
const PAINT_ENDPOINT = (env && (env.paintEndpoint || env.PAINT_ENDPOINT)) || process.env.PAINT_ENDPOINT;
const CLOUDINARY_CLOUD_NAME = (env && (env.cloudinaryCloudName || env.cloudName || env.CLOUDINARY_CLOUD_NAME)) || process.env.CLOUDINARY_CLOUD_NAME;

export default async function artwork(job) {
  const { photoId } = job.data;
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

    // 1. generate painting (AbortController for timeout in node-fetch v3)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    let res;
    try {
      res = await fetch(PAINT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageSource }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Paint service error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const painting_url = data && data.painting_url;
    if (!painting_url || typeof painting_url !== 'string') {
      throw new Error('Paint service did not return a valid painting_url');
    }

    // 2. GPT auto-description
    const description = await chat(
      'Describe a painting in 35 words.',
      `Describe the colours, medium and vibe of the painting at ${painting_url}`
    );

    // 3. Save
    const [{ id: artId }] = await db('artwork')
      .insert({ photo_id: photoId, image_url: painting_url, description })
      .returning(['id']);

    // 4. Mock-ups next (best-effort)
    let mockups = [];
    try {
      mockups = await createMockups(painting_url);
    } catch (e) {
      console.warn('createMockups failed', e);
    }
    await db('artwork').where({ id: artId }).update({ mockup_urls: mockups });

    // Enqueue publish with a stable jobId for idempotency
    await qPublish.add('publish', { artworkId: artId }, { jobId: `publish:${artId}` });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error('artwork workflow timed out contacting paint service', { photoId });
      throw new Error('Paint service request timed out (30s)');
    }
    console.error('artwork workflow failed', { photoId, err });
    throw err;
  }
}