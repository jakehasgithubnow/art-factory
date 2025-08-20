import db from '../db/client.js';
import * as n8n from '../services/n8n.js';
import { env } from '../config/env.js';
import { createProductRaw, setMetafieldsGraphQL } from '../services/shopify.js';
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
      location_category: 'l.category',
      formatted_address: 'l.address',
      latitude: 'l.g_lat',
      longitude: 'l.g_lng'
    });

  console.log("DEBUG publish: resolved location row", row);

  if (!row) {
    throw new Error(`Unable to resolve location/catchment for photo ${art.photo_id}`);
  }

  const title = `${row.location_name} – Bomberg Series`;
  const bodyHtml = `${art.description ?? ''}<br><br><em>${row.location_description ?? ''}</em>`;

  // Attempt mockup generation if none exist
  let mockups = [];
  let mu = art.mockup_urls;

  if (!mu || (Array.isArray(mu) && mu.length === 0) || (typeof mu === 'string' && mu.trim() === '')) {
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
        const { frameUrl1, frameUrl2, frameUrl3, defaultOrientation } = (await import('../config/env.js')).env;
        const generated = await createMockups({
          frameUrl1,
          frameUrl2,
          frameUrl3,
          artUrl: art.image_url,
          orientation: defaultOrientation || 'horizontal',
          enableInnerShadow: true
        });
        console.log('publish: Mockups generated', { artworkId, mockupsCount: generated.length });
        await db('artwork').where({ id: artworkId }).update({ mockup_urls: JSON.stringify(generated) });
        mu = generated;
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
      images: [
        { src: art.image_url },
        ...(mockups[0] ? [{ src: mockups[0] }] : []),
        ...(mockups[1] ? [{ src: mockups[1] }] : []),
        ...(mockups[2] ? [{ src: mockups[2] }] : []),
        { src: "https://res.cloudinary.com/dyvp677di/image/upload/w_900/v1747827728/canvas_back_hfrqy8.png" }
      ]
    },
    location_title: row.location_name || '',
    google_id: '', // not present in schema
    country: '',   // not in schema
    state: '',     // not in schema
    city: '',      // not in schema
    formatted_address: row.formatted_address || '',
    latitude: row.latitude ?? '',
    longitude: row.longitude ?? '',
    location_category: row.location_category || '',
    location_description: row.location_description || '',
    location_photo: row.image_source || '', // from schema
    style_name: '',
    uuid: String(artworkId),
    featured: art.featured || ''
  };

  if (env.createViaN8n) {
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
  } else {
    // Internal Shopify path (in-app, replacing n8n)
    let created;
    try {
      created = await createProductRaw(payload.product);
    } catch (err) {
      console.error('publish: createProductRaw failed', { artworkId, err });
      throw err;
    }

    // Persist Shopify ID and mark as published after successful create
    try {
      await db('artwork')
        .where({ id: artworkId })
        .update({ shopify_id: String(created.id), published: true });
    } catch (err) {
      // Avoid throwing here to prevent duplicate product creation on retry.
      console.error('publish: DB update failed after Shopify create', { artworkId, createdId: created?.id, err });
    }

    // Build metafields mirroring previous n8n flow
    const ownerId = created.admin_graphql_api_id || `gid://shopify/Product/${created.id}`;

    const details = {
      title: payload.location_title,
      google_id: payload.google_id || '',
      country: payload.country || '',
      state: payload.state || '',
      city: payload.city || '',
      formatted_address: payload.formatted_address || '',
      category: payload.location_category || '',
      description: payload.location_description || '',
      location_photo: payload.location_photo || '',
      style_name: payload.style_name || '',
    };
    const lat = Number.parseFloat(payload.latitude);
    if (Number.isFinite(lat)) details.latitude = lat;
    const lon = Number.parseFloat(payload.longitude);
    if (Number.isFinite(lon)) details.longitude = lon;

    const meta = [
      { namespace: 'location', key: 'details', type: 'json', value: JSON.stringify(details) },
    ];
    const imgs = Array.isArray(created.images) ? created.images : [];
    if (imgs[1]?.src) meta.push({ namespace: 'images', key: 'image2', type: 'single_line_text_field', value: String(imgs[1].src) });
    if (imgs[2]?.src) meta.push({ namespace: 'images', key: 'image3', type: 'single_line_text_field', value: String(imgs[2].src) });
    if (imgs[3]?.src) meta.push({ namespace: 'images', key: 'image4', type: 'single_line_text_field', value: String(imgs[3].src) });
    if (payload.featured) meta.push({ namespace: 'notes', key: 'features', type: 'single_line_text_field', value: String(payload.featured) });

    try {
      await setMetafieldsGraphQL(ownerId, meta);
    } catch (err) {
      console.error('publish: setMetafieldsGraphQL failed', { artworkId, ownerId, err });
      if (env.requireMetafieldsSuccess) throw err;
    }
  }
}
