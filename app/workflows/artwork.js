import db from '../db/client.js';
import fetch from 'node-fetch';
import { chat } from '../services/openai.js';
import { createMockups } from '../services/framemock.js';
import { qPublish } from '../queue/queues.js';

// Read configuration (prefer env helper, fallback to process.env)
import { env } from '../config/env.js';
const PAINT_ENDPOINT = (env && (env.paintEndpoint || env.PAINT_ENDPOINT)) || process.env.PAINT_ENDPOINT;
const CLOUDINARY_CLOUD_NAME = (env && (env.cloudinaryCloudName || env.cloudName || env.CLOUDINARY_CLOUD_NAME)) || process.env.CLOUDINARY_CLOUD_NAME;

const PAINT_API_KEY = process.env.PAINT_API_KEY || (env && (env.paintApiKey || env.PAINT_API_KEY));
function isPiapiEndpoint(url) { try { return new URL(url).host.endsWith('piapi.ai'); } catch { return false; } }

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
                { type: 'text', text: 'Generate a framed fine-art style painting based on this reference photo.' }
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

    let painting_url;
    if (usePiapi) {
      console.log('[artwork] Reading PiAPI stream response...');
      // PiAPI streams chunks; find a URL in the stream (best-effort)
      let chunks = '';
      for await (const chunk of res.body) {
        chunks += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      // Try to extract a URL from the stream payload
      const urlMatch = chunks.match(/https?:\/\/[^\s"']+/g);
      if (urlMatch) {
        console.log('[artwork] Found candidate URLs in stream:', urlMatch);
      }
      const candidate = urlMatch && urlMatch.find(u => /(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u));
      if (candidate) painting_url = candidate;
      if (!painting_url) {
        // Fallback: some responses embed a JSON line after "data:"
        const jsonLines = chunks.split('\n').filter(l => l.startsWith('data:'));
        for (const line of jsonLines) {
          try {
            const obj = JSON.parse(line.replace(/^data:\s*/, ''));
            const str = JSON.stringify(obj);
            const m = str.match(/https?:\/\/[^"']+/);
            if (m && m[0]) { 
              console.log('[artwork] Found painting URL in JSON line:', m[0]);
              painting_url = m[0].replace(/\\\//g, '/'); 
              break; 
            }
          } catch (_) { /* ignore */ }
        }
      }
      if (!painting_url) {
        throw new Error('PiAPI stream did not include an image URL');
      }
      console.log('[artwork] Painting URL resolved from PiAPI:', painting_url);
    } else {
      const data = await res.json();
      painting_url = data && data.painting_url;
      if (!painting_url || typeof painting_url !== 'string') {
        throw new Error('Paint service did not return a valid painting_url');
      }
      console.log('[artwork] Painting URL resolved from legacy service:', painting_url);
    }

    // 2. GPT auto-description
    console.log('[artwork] Requesting GPT auto-description for painting...');
    const description = await chat(
      'Describe a painting in 35 words.',
      `Describe the colours, medium and vibe of the painting at ${painting_url}`
    );

    // 3. Save
    console.log('[artwork] Inserting artwork into database...');
    const [{ id: artId }] = await db('artwork')
      .insert({ photo_id: photoId, image_url: painting_url, description })
      .returning(['id']);

    // 4. Mock-ups next (best-effort)
    let mockups = [];
    try {
      console.log('[artwork] Creating mockups...');
      mockups = await createMockups(painting_url);
    } catch (e) {
      console.warn('createMockups failed', e);
    }
    console.log('[artwork] Updating artwork record with mockup URLs');
    await db('artwork').where({ id: artId }).update({ mockup_urls: mockups });

    // Enqueue publish with a stable jobId for idempotency
    console.log('[artwork] Enqueuing publish job for artworkId:', artId);
    await qPublish.add('publish', { artworkId: artId }, { jobId: `publish:${artId}` });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error(`[artwork] Paint service request timed out after ${200}s`);
      throw new Error('Paint service request timed out (200s)');
    }
    console.error('artwork workflow failed', { photoId, err });
    throw err;
  }
}