import fetch from 'node-fetch';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';

const STAGE = 'shopify';
function log(data = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      stage: STAGE,
      ...data,
    }));
  } catch (_) {
    // best-effort logging only
  }
}

const API_VERSION = env.shopifyVersion || '2024-04';
const shopDomain = String(env.shop)
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
const API_BASE = `https://${shopDomain}/admin/api/${API_VERSION}`;

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function authHeaders() {
  return {
    'X-Shopify-Access-Token': env.shopToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function isRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchJson(path, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}, attempt = 0) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  log({ event: 'request_start', traceId, method, path });

  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: authHeaders(), body, signal: controller.signal });

    log({ event: 'response', traceId, status: res.status, statusText: res.statusText, retryAfter: res.headers.get('Retry-After') });

    // Retry logic for 429/5xx
    if (!res.ok && isRetryable(res.status) && attempt < MAX_RETRIES) {
      // Respect Retry-After if present, else do exponential backoff
      const retryAfter = parseFloat(res.headers.get('Retry-After'));
      const delay = Number.isFinite(retryAfter)
        ? Math.ceil(retryAfter * 1000)
        : BASE_DELAY_MS * Math.pow(2, attempt);
      try { await res.text(); } catch { /* ignore body */ }
      log({ event: 'retry', traceId, attempt: attempt + 1, status: res.status, delay_ms: delay });
      await sleep(delay);
      return fetchJson(path, { method, body, timeoutMs }, attempt + 1);
    }

    let payload;
    try {
      payload = await res.json();
    } catch {
      // Try text for better diagnostics
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Shopify ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
      }
      throw new Error(`Unexpected non-JSON response from Shopify at ${path}: ${text.slice(0, 300)}`);
    }

    if (!res.ok) {
      const errMsg = typeof payload?.errors === 'string'
        ? payload.errors
        : JSON.stringify(payload?.errors || payload);
      log({ event: 'http_error', traceId, method, path, status: res.status, error: errMsg });
      throw new Error(`Shopify ${method} ${path} failed (${res.status}): ${errMsg}`);
    }

    return payload;
  } catch (err) {
    log({ event: 'network_error', traceId, name: err?.name, message: err?.message });
    if (err && err.name === 'AbortError') {
      throw new Error(`Shopify ${method} ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    log({ event: 'request_end', traceId, duration_ms: Date.now() - startedAt });
    clearTimeout(timer);
  }
}

function normalizeImages(images) {
  if (!images) return [];
  // Accept strings (src) or objects { src, alt }
  return images
    .filter(Boolean)
    .map((img) => {
      if (typeof img === 'string') return { src: img };
      if (typeof img === 'object' && img.src) {
        const out = { src: String(img.src) };
        if (img.alt) out.alt = String(img.alt);
        return out;
      }
      return null;
    })
    .filter(Boolean);
}

export async function createCollection(title, bodyHtml, handle) {
  const traceId = randomUUID();
  log({ event: 'create_collection_start', traceId, title, handle });

  const body = JSON.stringify({ custom_collection: { title, body_html: bodyHtml, handle } });
  const data = await fetchJson('/custom_collections.json', { method: 'POST', body });
  const id = data?.custom_collection?.id;
  log({ event: 'create_collection_response', traceId, hasId: Boolean(id) });
  if (!id) throw new Error('Shopify did not return custom_collection.id');
  log({ event: 'create_collection_success', traceId, id });
  return id; // backward compatible
}

/**
 * Create a product and (optionally) attach ALL provided metafields.
 *
 * @param {Object} params
 * @param {string} params.title - Product title (required)
 * @param {string} [params.bodyHtml]
 * @param {Array<string|{src:string,alt?:string}>} [params.images]
 * @param {Array<{namespace:string,key:string,type:string,value:string}>} [params.metafields]
 * @param {string} [params.handle]
 * @param {string} [params.status] - 'active' | 'draft' | 'archived'
 * @param {string|string[]} [params.tags]
 * @param {string} [params.vendor]
 * @param {string} [params.productType]
 * @returns {Promise<number>} Product ID
 */
export async function createProduct({
  title,
  bodyHtml,
  images,
  metafields,
  handle,
  status = 'draft',
  tags,
  vendor,
  productType,
}) {
  if (!title) throw new Error('createProduct: title is required');

  const traceId = randomUUID();
  log({ event: 'create_product_start', traceId, title, images_count: Array.isArray(images) ? images.length : 0, metafields_count: Array.isArray(metafields) ? metafields.length : 0, status });

  const product = {
    title,
    body_html: bodyHtml,
    handle,
    status,
    tags: Array.isArray(tags) ? tags.join(', ') : tags,
    vendor,
    product_type: productType,
    images: normalizeImages(images),
  };

  const createBody = JSON.stringify({ product });
  const data = await fetchJson('/products.json', { method: 'POST', body: createBody });
  log({ event: 'create_product_res', traceId });
  const created = data?.product;
  log({ event: 'create_product_created', traceId, hasId: Boolean(created?.id) });
  if (!created?.id) throw new Error('Shopify did not return product.id');
  log({ event: 'create_product_success', traceId, productId: created.id });

  // Attach ALL metafields, if provided
  if (Array.isArray(metafields) && metafields.length) {
    for (const mf of metafields) {
      if (!mf || !mf.namespace || !mf.key || !mf.type) {
        // Skip invalid entries but keep going
        // eslint-disable-next-line no-console
        console.warn('Skipping invalid metafield; expected {namespace,key,type,value}', mf);
        continue;
      }
      const mfBody = JSON.stringify({ metafield: mf });
      log({ event: 'metafield_attach', traceId, productId: created.id, namespace: mf.namespace, key: mf.key, type: mf.type });
      await fetchJson(`/products/${created.id}/metafields.json`, { method: 'POST', body: mfBody });
    }
  }

  log({ event: 'create_product_done', traceId, productId: created.id });
  return created.id; // backward compatible
}