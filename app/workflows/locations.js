import db from '../db/client.js';
import { chatJson } from '../services/openai.js';
import { qPhoto } from '../queue/queues.js';

const PLACES_SCHEMA = {
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
    required: ['name', 'search_term'],
  },
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

  const system = 'You generate clean JSON for downstream automation.';
  const user = `Return ONLY a minified JSON array (max 10) of interesting public places within 30km of the point (lat: ${catchment.lat}, lon: ${catchment.lon}) around "${catchment.name}".
Each item MUST follow this JSON shape: {"name": string, "address": string, "category": string, "description": string, "search_term": string}.
The "search_term" should be what a person would type into an image search to find photos of this exact place (e.g., include the city/neighbourhood).`;

  let places = [];
  try {
    const raw = await chatJson({ system, user, schema: PLACES_SCHEMA, temperature: 0 });
    if (!Array.isArray(raw)) return;

    // sanitize, dedupe, cap at 10
    const seen = new Set();
    for (const item of raw) {
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
      const [loc] = await db('locations')
        .insert({ ...p, catchment_id: catchmentId, image_source: catchment.image_source || imageSource || 'google' })
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
