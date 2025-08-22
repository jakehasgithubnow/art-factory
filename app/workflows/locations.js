import db from '../db/client.js';
import { chatJson } from '../services/openai.js';
import { qPhoto } from '../queue/queues.js';
import { getPlaceDetails } from '../services/google.js';

function applyTemplate(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/{{\s*(\w+)\s*}}/g, (_, k) => (ctx && ctx[k] != null ? String(ctx[k]) : ''));
}

const PLACES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    places: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          address: { type: 'string' },
          category: { type: 'string' },
          description: { type: 'string' },
          search_term: { type: 'string' },
        },
        required: ['name', 'address', 'category', 'description', 'search_term'],
        additionalProperties: false,
      },
    },
  },
  required: ['places'],
};

function sanitizePlace(p) {
  // Ensure strings; trim; default missing optional fields to ''
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const place = {
    name: s(p.name),
    address: s(p.address),
    category: s(p.category),
    description: s(p.description),
    search_term: s(p.search_term || p.name),
  };
  // Minimal validation: require name and search_term
  if (!place.name || !place.search_term) return null;
  return place;
}

export default async function locations(job) {
  const { catchmentId, imageSource } = job.data;
  const catchment = await db('catchments').where({ id: catchmentId }).first();
  if (!catchment) return;

  // Load system prompt for location places from DB
  const { getByKey } = await import('../db/systemPrompts.js');
  const sysPromptRow = await getByKey('location_places_system');
  const { getByKey: getUserPrompt } = await import('../db/systemPrompts.js');
  const userPromptRow = await getUserPrompt('location_places_user');

  const ctx = { lat: catchment.lat, lon: catchment.lon, catchmentName: catchment.name };
  const system = applyTemplate(sysPromptRow?.text, ctx);
  const user = applyTemplate(userPromptRow?.text, ctx);

  const model = sysPromptRow?.model || userPromptRow?.model || 'gpt-4o-mini';

  let places = [];
  try {
    const raw = await chatJson({ system, user, schema: PLACES_SCHEMA, temperature: 0, model });
    if (!raw || !Array.isArray(raw.places)) {
      console.error('locations workflow: invalid response format', { catchmentId, raw });
      return;
    }

    // sanitize, dedupe, cap at 10
    const seen = new Set();
    for (const item of raw.places) {
      const p = sanitizePlace(item);
      if (!p) continue;
      const key = `${p.name.toLowerCase()}|${p.address.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(p);
      if (places.length >= 10) break;
    }
  } catch (err) {
    console.error('locations workflow: failed to get/parse places', { catchmentId, err });
    return;
  }

  if (!places.length) return;

  for (const p of places) {
    try {
      // Enrich with Google Places data
      let enrichment = {};
      try {
        const details = await getPlaceDetails(p.search_term || p.name);
        if (details) {
          enrichment = details;
        }
      } catch (e) {
        console.warn('locations workflow: Google Places enrichment failed', { catchmentId, place: p?.name, err: e });
      }

      // Normalize fields for DB types
      // g_photo_refs column is jsonb; ensure we send valid JSON text, not a PG array literal
      if (Array.isArray(enrichment.g_photo_refs)) {
        try {
          enrichment.g_photo_refs = JSON.stringify(enrichment.g_photo_refs);
        } catch (_e) {
          // On serialization failure, drop the field so DB default ('[]') applies
          delete enrichment.g_photo_refs;
        }
      }

      const [loc] = await db('locations')
        .insert({ 
          ...p, 
          catchment_id: catchmentId, 
          image_source: catchment.image_source || imageSource || 'google',
          ...enrichment
        })
        .returning('*');

      if (loc && loc.id) {
        await qPhoto.add('photo', { locationId: loc.id }, { jobId: `photo:${loc.id}` });
      }
    } catch (err) {
      console.warn('locations workflow: failed to insert/enqueue', { catchmentId, place: p?.name, err });
      continue;
    }
  }
}
