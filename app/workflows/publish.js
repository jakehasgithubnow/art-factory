import db from '../db/client.js';
import { createProduct } from '../services/shopify.js';

export default async function publish(job) {
  const { artworkId } = job.data;

  // Re-read artwork and guard against duplicate publish attempts
  const art = await db('artwork').where({ id: artworkId }).first();
  if (!art) return;
  if (art.published || art.shopify_id) return; // idempotency guard

  // Resolve location (for copy) and catchment (for geo lat/lon)
  const row = await db('photos as p')
    .join('locations as l', 'l.id', 'p.location_id')
    .join('catchments as c', 'c.id', 'l.catchment_id')
    .where('p.id', art.photo_id)
    .first({
      location_name: 'l.name',
      location_description: 'l.description',
      catchment_lat: 'c.lat',
      catchment_lon: 'c.lon',
    });

  if (!row) {
    throw new Error(`Unable to resolve location/catchment for photo ${art.photo_id}`);
  }

  const title = `${row.location_name} – Bomberg Series`;
  const bodyHtml = `${art.description ?? ''}<br><br><em>${row.location_description ?? ''}</em>`;

  // Build images array (painting first, then staged mockups)
  let mockups = [];
  const mu = art.mockup_urls;
  if (Array.isArray(mu)) {
    mockups = mu.filter((u) => typeof u === 'string' && u);
  } else if (typeof mu === 'string') {
    try {
      const parsed = JSON.parse(mu);
      if (Array.isArray(parsed)) {
        mockups = parsed.filter((u) => typeof u === 'string' && u);
      }
    } catch (_) {
      // Ignore parse errors — we can still publish with just the painting image
    }
  }

  // Ensure painting image exists
  if (!art.image_url) {
    throw new Error('No painting image (art.image_url) available to publish');
  }

  // Deduplicate and attach alt text. First is painting, others are mockups.
  const seen = new Set();
  const images = [];
  const pushImg = (src, alt) => {
    if (!src || typeof src !== 'string') return;
    if (seen.has(src)) return;
    seen.add(src);
    images.push({ src, alt });
  };
  pushImg(art.image_url, `Painting – ${title}`);
  for (const u of mockups) pushImg(u, `Mockup – ${title}`);

  if (images.length === 0) {
    throw new Error('No images available to publish');
  }

  // Metafields: include geo JSON plus a couple of descriptive fields
  const metafields = [
    {
      namespace: 'location',
      key: 'geo',
      type: 'json',
      value: JSON.stringify({ lat: row.catchment_lat, lon: row.catchment_lon }),
    },
    {
      namespace: 'location',
      key: 'name',
      type: 'single_line_text_field',
      value: String(row.location_name || ''),
    },
    {
      namespace: 'art',
      key: 'series',
      type: 'single_line_text_field',
      value: 'Bomberg',
    },
  ];

  // Optional tags for easier cataloging
  const tags = [row.location_name, 'Bomberg', 'generated'].filter(Boolean);

  let shopifyId;
  try {
    shopifyId = await createProduct({ title, bodyHtml, images, metafields, tags, status: 'draft', productType: 'Art Print' });
  } catch (err) {
    // Add context for easier debugging in logs
    console.error('publish: createProduct failed', { artworkId, err });
    throw err;
  }

  // Mark as published/idempotent once we have a product id
  await db('artwork')
    .where({ id: artworkId })
    .update({ shopify_id: shopifyId, published: true });
}