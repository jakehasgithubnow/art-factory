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

export async function createCollection(title, bodyHtml, handle, templateSuffix = 'geographic') {
  const traceId = randomUUID();
  log({ event: 'create_collection_start', traceId, title, handle });

  const body = JSON.stringify({ custom_collection: { title, body_html: bodyHtml, handle, template_suffix: templateSuffix } });
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

/**
 * Create a product using a raw Shopify-compatible product object.
 * Returns the full created product object (including id, admin_graphql_api_id, images).
 *
 * @param {Object} productBody - The object that would normally be under { product: ... }
 * @returns {Promise<Object>} - The created product object from Shopify
 */
export async function createProductRaw(productBody) {
  if (!productBody || typeof productBody !== 'object') {
    throw new Error('createProductRaw: productBody is required');
  }

  const traceId = randomUUID();
  log({ event: 'create_product_raw_start', traceId });

  const body = JSON.stringify({ product: productBody });
  const data = await fetchJson('/products.json', { method: 'POST', body });
  const created = data?.product;
  log({ event: 'create_product_raw_res', traceId, hasId: Boolean(created?.id) });
  if (!created?.id) throw new Error('Shopify did not return product.id');
  log({ event: 'create_product_raw_success', traceId, productId: created.id });

  return created;
}

/**
 * Set metafields via Admin GraphQL metafieldsSet mutation.
 *
 * @param {string} ownerId - The admin_graphql_api_id for the Product (or GID fallback)
 * @param {Array<{namespace:string,key:string,type:string,value:string}>} metafields
 * @returns {Promise<Object>} - GraphQL response metafieldsSet payload
 * Throws when env.requireMetafieldsSuccess is true and userErrors are returned.
 */
export async function setMetafieldsGraphQL(ownerId, metafields) {
  if (!ownerId) throw new Error('setMetafieldsGraphQL: ownerId is required');
  const traceId = randomUUID();

  const meta = Array.isArray(metafields)
    ? metafields.filter(m => m && m.namespace && m.key && m.type)
    : [];

  if (!meta.length) {
    log({ event: 'graphql_metafields_set_skipped', traceId, reason: 'no_valid_metafields' });
    return { metafields: [], userErrors: [] };
  }

  const query = `
    mutation setMeta($meta: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $meta) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    meta: meta.map(m => ({
      ownerId,
      namespace: m.namespace,
      key: m.key,
      type: m.type,
      value: String(m.value ?? ''),
    })),
  };

  const body = JSON.stringify({ query, variables });
  const res = await fetchJson('/graphql.json', { method: 'POST', body });

  // Handle GraphQL top-level errors (HTTP 200 with errors array)
  const topErrors = Array.isArray(res?.errors)
    ? res.errors.map(e => ({
        field: Array.isArray(e?.path) ? e.path.join('.') : undefined,
        message: e?.message || 'GraphQL error'
      }))
    : [];

  if (topErrors.length) {
    log({ event: 'graphql_top_level_errors', traceId, errors: topErrors });
    if (env.requireMetafieldsSuccess) {
      const err = new Error(`Shopify GraphQL errors: ${JSON.stringify(topErrors)}`);
      err.context = { ownerId, topErrors };
      throw err;
    }
    // Return in a shape that callers treat as userErrors to trigger REST fallback
    return { metafields: [], userErrors: topErrors };
  }

  // n8n referenced shape: { data: { metafieldsSet: { metafields, userErrors } } }
  const out = res?.data?.metafieldsSet || res?.metafieldsSet || res;
  const userErrors = Array.isArray(out?.userErrors) ? out.userErrors : [];

  log({
    event: 'graphql_metafields_set_res',
    traceId,
    errors: userErrors.map(e => ({ field: e.field, message: e.message })),
  });

  if (userErrors.length && env.requireMetafieldsSuccess) {
    const errMsg = JSON.stringify(userErrors);
    const err = new Error(`Shopify metafieldsSet returned userErrors: ${errMsg}`);
    // Preserve context for upstream logs
    err.context = { ownerId, userErrors };
    throw err;
  }

  return out;
}

/**
 * Set a collection's templateSuffix via Admin GraphQL collectionUpdate.
 *
 * @param {string} ownerId - GID for the Collection: gid://shopify/Collection/{id}
 * @param {string} templateSuffix - e.g. 'geographic'
 * @returns {Promise<Object>} - GraphQL response collectionUpdate payload
 */
export async function setCollectionTemplateGraphQL(ownerId, templateSuffix = 'geographic') {
  if (!ownerId) throw new Error('setCollectionTemplateGraphQL: ownerId is required');
  const traceId = randomUUID();

  const query = `
    mutation updateCollection($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection { id templateSuffix }
        userErrors { field message }
      }
    }
  `;

  const variables = { input: { id: ownerId, templateSuffix } };
  const body = JSON.stringify({ query, variables });
  const res = await fetchJson('/graphql.json', { method: 'POST', body });

  const topErrors = Array.isArray(res?.errors)
    ? res.errors.map(e => ({
        field: Array.isArray(e?.path) ? e.path.join('.') : undefined,
        message: e?.message || 'GraphQL error'
      }))
    : [];

  if (topErrors.length) {
    log({ event: 'graphql_collection_update_top_errors', traceId, errors: topErrors });
    if (env.requireMetafieldsSuccess) {
      const err = new Error(`Shopify GraphQL errors: ${JSON.stringify(topErrors)}`);
      err.context = { ownerId, topErrors };
      throw err;
    }
    return { collectionUpdate: { collection: null, userErrors: topErrors } };
  }

  const out = res?.data?.collectionUpdate || res?.collectionUpdate || res;
  const userErrors = Array.isArray(out?.userErrors) ? out.userErrors : [];

  log({
    event: 'graphql_collection_update_res',
    traceId,
    templateSuffix,
    errors: userErrors.map(e => ({ field: e.field, message: e.message })),
  });

  if (userErrors.length && env.requireMetafieldsSuccess) {
    const errMsg = JSON.stringify(userErrors);
    const err = new Error(`Shopify collectionUpdate returned userErrors: ${errMsg}`);
    err.context = { ownerId, userErrors };
    throw err;
  }

  return out;
}

/**
 * REST fallback to set a collection's template suffix.
 * @param {number|string} id - Numeric REST id of the collection
 * @param {string} templateSuffix
 */
export async function updateCollectionTemplateREST(id, templateSuffix = 'geographic') {
  if (!id) throw new Error('updateCollectionTemplateREST: id is required');
  const traceId = randomUUID();
  const body = JSON.stringify({ custom_collection: { template_suffix: templateSuffix } });
  log({ event: 'rest_update_collection_template', traceId, id, templateSuffix });
  await fetchJson(`/custom_collections/${id}.json`, { method: 'PUT', body });
  return true;
}

/**
 * Fallback: Set product metafields via REST endpoint.
 * @param {number|string} productId
 * @param {Array<{namespace:string,key:string,type:string,value:string}>} metafields
 */
export async function setProductMetafieldsREST(productId, metafields) {
  if (!productId) throw new Error('setProductMetafieldsREST: productId is required');
  const traceId = randomUUID();

  const meta = Array.isArray(metafields)
    ? metafields.filter(m => m && m.namespace && m.key && m.type)
    : [];

  if (!meta.length) {
    log({ event: 'rest_metafields_set_skipped', traceId, reason: 'no_valid_metafields' });
    return;
  }

  for (const mf of meta) {
    const body = JSON.stringify({
      metafield: {
        namespace: mf.namespace,
        key: mf.key,
        type: mf.type,
        value: String(mf.value ?? ''),
      },
    });
    log({ event: 'rest_metafield_attach', traceId, productId, namespace: mf.namespace, key: mf.key, type: mf.type });
    await fetchJson(`/products/${productId}/metafields.json`, { method: 'POST', body });
  }

  log({ event: 'rest_metafields_set_done', traceId, productId });
}
