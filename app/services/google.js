import fetch from 'node-fetch';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';

const STAGE = 'google_image_search';
function log(data = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      stage: STAGE,
      ...data,
    }));
  } catch (_) {
    // ignore logging errors
  }
}

export async function imageSearch(query, num = 10) {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: 'start', traceId, query, num });
  try {
    const qs = new URLSearchParams({
      key: env.googleKey,
      cx: env.googleCseId,
      searchType: 'image',
      q: query,
      num
    });
    const res = await fetch(`https://customsearch.googleapis.com/customsearch/v1?${qs}`);
    log({ event: 'fetched', traceId, status: res.status, statusText: res.statusText });
    const { items = [] } = await res.json();
    log({ event: 'success', traceId, count: items.length, duration_ms: Date.now() - start });
    return items.map(i => ({ url: i.link, context: i.image?.contextLink }));
  } catch (err) {
    log({ event: 'error', traceId, name: err?.name, message: err?.message });
    throw err;
  }
}