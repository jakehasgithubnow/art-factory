import fetch from 'node-fetch';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';

const STAGE = 'openverse_image_search';
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

/**
 * Search Openverse images.
 * Mirrors the interface of google.imageSearch for interchangeability.
 * @param {string} query - Search term.
 * @param {number} num - Number of results to return. Defaults to 10.
 * @returns {Promise<Array<{url: string, context: string}>>}
 */
export async function imageSearch(query, num = 10) {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: 'start', traceId, query, num });

  try {
    const qs = new URLSearchParams({
      q: query,
      page_size: num.toString(),
      page: '1'
    });

    const headers = {};
    if (env.openverseApiKey) {
      headers['Authorization'] = `Bearer ${env.openverseApiKey}`;
    }

    const res = await fetch(`https://api.openverse.org/v1/images/?${qs}`, {
      headers
    });

    log({ event: 'fetched', traceId, status: res.status, statusText: res.statusText });

    const { results = [] } = await res.json();

    log({ event: 'success', traceId, count: results.length, duration_ms: Date.now() - start });

    // Map Openverse fields to match Google style objects, but include all metadata
    return results.map(i => ({
      url: i.url,
      context: i.foreign_landing_url || null,
      id: i.id,
      title: i.title || null,
      creator: i.creator || null,
      creator_url: i.creator_url || null,
      license: i.license || null,
      license_version: i.license_version || null,
      license_url: i.license_url || null,
      source: i.source || null,
      category: i.category || null,
      provider: i.provider || null,
      thumbnail: i.thumbnail || null,
      detail_url: i.detail_url || null,
      width: i.width || null,
      height: i.height || null
    }));
  } catch (err) {
    log({ event: 'error', traceId, name: err?.name, message: err?.message });
    throw err;
  }
}
