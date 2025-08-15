import db from '../db/client.js';
import * as n8n from '../services/n8n.js';
const { sendProduct } = n8n;

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

  // Attempt mockup generation if none exist
  let mockups = [];
  if (!art.mockup_urls || (Array.isArray(art.mockup_urls) && art.mockup_urls.length === 0) || (typeof art.mockup_urls === 'string' && art.mockup_urls.trim() === '')) {
    try {
      const { createMockups } = await import('../services/framemock.js');
      const { frameMockUrl, frameMockApiKey } = (await import('../config/env.js')).env;
      if (!frameMockUrl) {
        console.error('publish: Missing env.frameMockUrl');
      }
      if (!frameMockApiKey) {
        console.warn('publish: Missing env.frameMockApiKey - requests may fail if auth is required');
      }
      if (art.image_url) {
        console.log('publish: Generating mockups for artwork', { artworkId, image_url: art.image_url });
        const generated = await createMockups(art.image_url);
        console.log('publish: Mockups generated', { artworkId, mockupsCount: generated.length });
        await db('artwork').where({ id: artworkId }).update({ mockup_urls: JSON.stringify(generated) });
        mockups = generated;
      } else {
        console.error('publish: No image_url, cannot generate mockups', { artworkId });
      }
    } catch (err) {
      console.error('publish: Mockup generation failed', { artworkId, error: err });
    }
  }

  // Build images array (painting first, then staged mockups)
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

  // Build payload in n8n expected format
  const payload = {
    product: {
      title,
      body_html: bodyHtml,
      options: [
        { name: 'Format', values: ['Original Painting', 'Prints'] },
        { name: 'Size', values: ['10 x 15cm', '20 x 30cm', '27 x 35cm', '33 x 43cm', '50 x 60cm'] }
      ],
      variants: [
        { option1: 'Original Painting', option2: '20 x 30cm', price: '70.00' },
        { option1: 'Original Painting', option2: '27 x 35cm', price: '90.00' },
        { option1: 'Original Painting', option2: '33 x 43cm', price: '140.00' },
        { option1: 'Original Painting', option2: '50 x 60cm', price: '190.00' },
        { option1: 'Prints', option2: '10 x 15cm', price: '6.00' },
        { option1: 'Prints', option2: '20 x 30cm', price: '9.00' },
        { option1: 'Prints', option2: '27 x 35cm', price: '15.00' },
        { option1: 'Prints', option2: '33 x 43cm', price: '35.00' }
      ],
      images: images.map(img => ({ src: img.src }))
    },
    location_title: row.location_name || '',
    google_id: '',
    country: '',
    state: '',
    city: '',
    formatted_address: '',
    latitude: row.catchment_lat || '',
    longitude: row.catchment_lon || '',
    location_category: '',
    location_description: row.location_description || '',
    location_photo: '',
    style_name: '',
    uuid: String(artworkId),
    featured: ''
  };

  try {
    await sendProduct(payload);
  } catch (err) {
    console.error('publish: sendProduct to n8n failed', { artworkId, err });
    throw err;
  }

  // Mark as published/idempotent once webhook has been successfully sent
  await db('artwork')
    .where({ id: artworkId })
    .update({ published: true });
}
