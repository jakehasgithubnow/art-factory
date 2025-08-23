import db from '../db/client.js';
import * as n8n from '../services/n8n.js';
import { env } from '../config/env.js';
import { createProductRaw, setMetafieldsGraphQL, setProductMetafieldsREST } from '../services/shopify.js';
import { chatJson } from '../services/openai.js';
const { sendProduct } = n8n;

function parseFormattedAddress(addr) {
  if (!addr || typeof addr !== 'string') return { country: '', state: '', city: '' };
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  const country = parts.at(-1) || '';
  let state = '', city = '';
  if (parts.length >= 2) {
    const mid = parts.at(-2);
    const m = mid.match(/\b([A-Z]{2})\b/); // US state code heuristic
    if (m) {
      state = m[1];
      city = parts.at(-3) || '';
    } else {
      city = mid; // non‑US best-effort
    }
  }
  return { country, state, city };
}

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
      longitude: 'l.g_lng',
      g_place_id: 'l.g_place_id',
      g_formatted_address: 'l.g_formatted_address',
      image_source: 'l.image_source',
      openverse_metadata: 'p.openverse_metadata'
    });

  console.log("DEBUG publish: resolved location row", row);

  if (!row) {
    throw new Error(`Unable to resolve location/catchment for photo ${art.photo_id}`);
  }

  function applyTemplate(str, ctx) {
    if (typeof str !== 'string') return str;
    return str.replace(/{{\s*(\w+)\s*}}/g, (_m, k) => (ctx && ctx[k] != null ? String(ctx[k]) : ''));
  }
  function tryParseArtworkDetails(s) {
    if (!s || typeof s !== 'string') return null;
    // First, try strict JSON
    try {
      const o = JSON.parse(s);
      return (o && typeof o.title === 'string') ? o : null;
    } catch {}
    // Loose parse: extract the first balanced JSON object and parse that
    function extractBalancedObject(text) {
      const start = text.indexOf('{');
      if (start === -1) return null;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return null;
    }
    const snippet = extractBalancedObject(s);
    if (snippet) {
      try {
        const o = JSON.parse(snippet);
        return (o && typeof o.title === 'string') ? o : null;
      } catch {}
    }
    return null;
  }
  function extractTitleLoose(s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.match(/"title"\s*:\s*"([^"]{1,256})"/i);
    if (m && m[1]) return m[1].trim();
    const m2 = s.match(/^\s*title\s*[:\-]\s*(.+)$/im);
    if (m2 && m2[1]) return m2[1].trim().replace(/^["'`]|["'`]$/g, '');
    return null;
  }
  const artDetails = tryParseArtworkDetails(art.description);
  const ctx = { locationName: row.location_name || '' };
  let title = (artDetails && typeof artDetails.title === 'string' && artDetails.title.trim())
    ? artDetails.title.trim()
    : (extractTitleLoose(art.description || '') || `${row.location_name} – Bomberg Series`);
  const bodyHtml = (artDetails && typeof artDetails.description === 'string')
    ? (applyTemplate(artDetails.description, ctx) || '')
    : (art.description ?? '');
  // Fallback: if we still only have the legacy fallback title, try generating JSON on-the-fly
  if (!artDetails || !artDetails.title || title === `${row.location_name} – Bomberg Series`) {
    try {
      const ai = await chatJson({
        system: 'Return ONLY minified JSON strictly matching the schema.',
        user: { text: 'Generate a concise, evocative artwork title and a ~35-word description for this painting image. Return JSON with keys: title (string), description (string).', imageUrls: [String(art.image_url || '')] },
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['title', 'description'],
          additionalProperties: false
        },
        temperature: 0.7
      });
      if (ai && typeof ai.title === 'string') {
        title = ai.title.trim() || title;
        const descText = typeof ai.description === 'string' ? ai.description : bodyHtml;
        bodyHtml = descText;
        // Persist back to DB so future runs use the JSON
        try {
          await db('artwork').where({ id: artworkId }).update({ description: JSON.stringify({ title: title, description: descText }) });
        } catch {}
      }
    } catch (e) {
      console.warn('publish: chatJson fallback failed', e);
    }
  }

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
        const { frameUrl1, frameUrl2, frameUrl3 } = (await import('../config/env.js')).env;
        const generated = await createMockups({
          frameUrl1,
          frameUrl2,
          frameUrl3,
          artUrl: art.image_url,
          orientation: 'auto',
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
      value: JSON.stringify({ lat: row.latitude, lon: row.longitude }),
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
  const primaryImage = (Array.isArray(images) && images[0]?.src) ? images[0].src : (art.image_url || (Array.isArray(mockups) && mockups[0]) || row.image_source || '');
  const { country, state, city } = parseFormattedAddress(row.g_formatted_address);
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
    google_id: row.g_place_id || '',
    country: country || '',
    state: state || '',
    city: city || '',
    formatted_address: row.g_formatted_address || row.formatted_address || '',
    latitude: row.latitude ?? '',
    longitude: row.longitude ?? '',
    location_category: row.location_category || '',
    location_description: row.location_description || '',
    location_photo: primaryImage || '',
    style_name: 'Bomberg',
    uuid: String(artworkId),
    featured: art.featured || ''
  };

  // Add Openverse copyright metafield into product payload (for n8n or direct REST create)
  try {
    const ov = row?.openverse_metadata && typeof row.openverse_metadata === 'object' ? row.openverse_metadata : null;
    if (row?.image_source === 'openverse' && ov && (ov.license || ov.license_url || ov.creator)) {
      const code = String(ov.license || '').toLowerCase();
      const version = ov.license_version || '';
      const licenseHuman = code === 'cc0'
        ? `CC0 ${version}`.trim()
        : `CC ${code.toUpperCase().replace(/-/g, '-')} ${version}`.trim();
      const assetPage = ov.context || ov.detail_url || ov.url || '';
      const attribution = [
        ov.creator ? `Image by ${ov.creator}` : null,
        licenseHuman || null,
        ov.license_url || null
      ].filter(Boolean).join(' • ');
      const copyright = {
        source: 'openverse',
        id: ov.id || null,
        title: ov.title || null,
        creator: ov.creator || null,
        creator_url: ov.creator_url || null,
        license: licenseHuman || null,
        license_code: ov.license || null,
        license_version: ov.license_version || null,
        license_url: ov.license_url || null,
        asset_page_url: assetPage || null,
        provider: ov.provider || null,
        thumbnail_url: ov.thumbnail || null,
        attribution,
        fetched_at: new Date().toISOString()
      };
      if (env.createViaN8n) {
        payload.product.metafields = Array.isArray(payload.product.metafields) ? payload.product.metafields : [];
        payload.product.metafields.push({ namespace: 'custom', key: 'copyright', type: 'json', value: JSON.stringify(copyright) });
      }
    }
  } catch (e) {
    console.warn('publish: failed to add copyright metafield to payload', { artworkId, error: e?.message });
  }

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

    // Add Openverse copyright metafield when available
    try {
      const ov = row?.openverse_metadata && typeof row.openverse_metadata === 'object' ? row.openverse_metadata : null;
      if (row?.image_source === 'openverse' && ov && (ov.license || ov.license_url || ov.creator)) {
        const code = String(ov.license || '').toLowerCase();
        const version = ov.license_version || '';
        const licenseHuman = code === 'cc0'
          ? `CC0 ${version}`.trim()
          : `CC ${code.toUpperCase().replace(/-/g, '-')} ${version}`.trim();
        const assetPage = ov.context || ov.detail_url || ov.url || '';
        const attribution = [
          ov.creator ? `Image by ${ov.creator}` : null,
          licenseHuman || null,
          ov.license_url || null
        ].filter(Boolean).join(' • ');

        const copyright = {
          source: 'openverse',
          id: ov.id || null,
          title: ov.title || null,
          creator: ov.creator || null,
          creator_url: ov.creator_url || null,
          license: licenseHuman || null,
          license_code: ov.license || null,
          license_version: ov.license_version || null,
          license_url: ov.license_url || null,
          asset_page_url: assetPage || null,
          provider: ov.provider || null,
          thumbnail_url: ov.thumbnail || null,
          attribution,
          fetched_at: new Date().toISOString()
        };

        meta.push({ namespace: 'custom', key: 'copyright', type: 'json', value: JSON.stringify(copyright) });
      }
    } catch (e) {
      console.warn('publish: failed to build copyright metafield', { artworkId, error: e?.message });
    }

    const imgs = Array.isArray(created.images) ? created.images : [];
    if (imgs[1]?.src) meta.push({ namespace: 'images', key: 'image2', type: 'single_line_text_field', value: String(imgs[1].src) });
    if (imgs[2]?.src) meta.push({ namespace: 'images', key: 'image3', type: 'single_line_text_field', value: String(imgs[2].src) });
    if (imgs[3]?.src) meta.push({ namespace: 'images', key: 'image4', type: 'single_line_text_field', value: String(imgs[3].src) });
    if (payload.featured) meta.push({ namespace: 'notes', key: 'features', type: 'single_line_text_field', value: String(payload.featured) });

    // Prefer REST for reliability (observed success in n8n); fall back to GraphQL if REST fails
    try {
      await setProductMetafieldsREST(created.id, meta);
    } catch (restErr) {
      console.warn('publish: REST metafields failed, attempting GraphQL fallback', { artworkId, productId: created?.id, restErr });
      try {
        const gqlRes = await setMetafieldsGraphQL(ownerId, meta);
        const gqlErrors = Array.isArray(gqlRes?.userErrors) ? gqlRes.userErrors : [];
        if (gqlErrors.length) {
          console.error('publish: GraphQL metafieldsSet returned userErrors after REST failure', {
            artworkId,
            ownerId,
            userErrors: gqlErrors
          });
          if (env.requireMetafieldsSuccess) throw new Error(`GraphQL userErrors: ${JSON.stringify(gqlErrors)}`);
        }
      } catch (gqlErr) {
        console.error('publish: GraphQL metafields fallback failed', { artworkId, ownerId, gqlErr });
        if (env.requireMetafieldsSuccess) throw gqlErr;
      }
    }
  }
}
