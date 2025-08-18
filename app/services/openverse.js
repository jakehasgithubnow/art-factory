import fetch from 'node-fetch';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';
import { rankAndTrim, DEFAULT_RANK_OPTIONS } from './imageRanker.js';

const STAGE = 'openverse_image_search';
function log(data = {}) {
  try {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        stage: STAGE,
        ...data,
      }),
    );
  } catch (_) {
    // ignore logging errors
  }
}

/**
 * Search Openverse images, then apply a fast heuristic ranking to return the top-N.
 * Mirrors the interface of google.imageSearch for interchangeability.
 *
 * @param {string} query - Search term.
 * @param {number} num - Number of results to return (after ranking). Defaults to 10.
 * @param {object} options - Optional tuning:
 *   - candidateSize: how many candidates to fetch before ranking (default: max(num*6, 40), capped by perPage*maxPages)
 *   - perPage: page size for API requests (default 50)
 *   - maxPages: maximum pages to fetch (default 5)
 *   - rankOptions: options forwarded to the heuristic ranker (see DEFAULT_RANK_OPTIONS)
 *   - disableRanking: if true, returns first 'num' results unranked (API order)
 *   - openverseParams: extra params to include in the search (e.g., license, aspect_ratio, etc.)
 * @returns {Promise<Array<{url: string, context: string}>>}
 */
export async function imageSearch(query, num = 10, options = {}) {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: 'start', traceId, query, num });

  const {
    perPage = 50,
    maxPages = 5,
    disableRanking = false,
    rankOptions = {},
    openverseParams = {},
  } = options || {};

  // Calculate fetch size (respect Openverse anonymous per-page limit of 20)
  const hasKey = Boolean(env.openverseApiKey);
  const target = Math.max(1, Number(num) || 10);
  const defaultCandidate = Math.max(target * 6, 40);
  const perPageLimit = hasKey ? perPage : Math.min(perPage, 20);
  const hardCap = Math.max(1, perPageLimit * maxPages);
  const candidateSize = Math.min(
    Math.max(1, Number(options?.candidateSize) || defaultCandidate),
    hardCap,
  );

  try {
    const headers = {
      Accept: 'application/json',
      'User-Agent': env.openverseUserAgent || `art-factory/${process.env.npm_package_version || '0.0.0'} (+${env.appContact || 'https://github.com/jakehasgithubnow/art-factory'})`,
    };
    if (env.openverseApiKey) {
      headers['Authorization'] = `Bearer ${env.openverseApiKey}`;
    }

    const all = [];
    let page = 1;
    while (all.length < candidateSize && page <= maxPages) {
      const pageSize = Math.min(perPageLimit, candidateSize - all.length);
      const qs = new URLSearchParams({
        q: String(query || ''),
        page_size: String(pageSize),
        page: String(page),
        ...Object.fromEntries(
          Object.entries(openverseParams || {}).flatMap(([k, v]) => {
            if (v == null || v === '') return [];
            const key = String(k).toLowerCase();
            // Prevent overriding reserved params
            if (key === 'q' || key === 'page' || key === 'page_size') return [];
            return [[k, String(v)]];
          }),
        ),
      });

      const url = `https://api.openverse.org/v1/images/?${qs}`;
      const res = await fetch(url, { headers });
      log({ event: 'page_fetch', traceId, page, status: res.status, statusText: res.statusText });
      if (!res.ok) {
        let preview = '';
        try { preview = await res.text(); } catch {}
        log({ event: 'page_http_error', traceId, page, status: res.status, preview: String(preview).slice(0, 400) });
        break;
      }

      let json;
      try {
        json = await res.json();
      } catch (e) {
        log({ event: 'page_parse_error', traceId, page, message: e?.message });
        break;
      }

      const { results = [] } = json || {};
      log({ event: 'page_result', traceId, page, count: Array.isArray(results) ? results.length : 0 });

      if (!Array.isArray(results) || results.length === 0) {
        break;
      }

      // Map Openverse fields to our common image object (preserve key metadata)
      const mapped = results.map((i) => ({
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
        height: i.height || null,
      }));

      all.push(...mapped);

      // If the API returned fewer than requested, no more pages are likely available
      if (results.length < pageSize) break;
      page += 1;
    }

    log({
      event: 'fetched',
      traceId,
      pages_fetched: page - 1,
      candidate_count: all.length,
      duration_ms: Date.now() - start,
    });

    if (all.length === 0) return [];

    if (disableRanking) {
      const sliced = all.slice(0, target);
      log({
        event: 'return_unranked',
        traceId,
        count: sliced.length,
        reason: 'disableRanking',
      });
      return sliced;
    }

    // Rank and trim to top-N using heuristics
    const ranked = rankAndTrim(all, query, { ...DEFAULT_RANK_OPTIONS, ...rankOptions }, target);

    log({
      event: 'success_ranked',
      traceId,
      candidate_count: all.length,
      top_count: ranked.length,
      duration_ms: Date.now() - start,
    });

    return ranked;
  } catch (err) {
    log({ event: 'error', traceId, name: err?.name, message: err?.message });
    throw err;
  }
}
