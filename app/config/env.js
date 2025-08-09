import 'dotenv/config';

function required(key) {
  const v = process.env[key];
  if (v == null || v === '') throw new Error(`Missing required env ${key}`);
  return v;
}
function optional(key, def = undefined) {
  const v = process.env[key];
  return v == null || v === '' ? def : v;
}
function num(key, def) {
  const v = optional(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(key, def = false) {
  const v = optional(key);
  if (v == null) return def;
  return v === 'true' || v === '1';
}

export const env = {
  // Core infra (required for the app to boot)
  databaseUrl: required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),

  // Server
  port: num('PORT', 3000),
  ingestKey: optional('INGEST_KEY'),

  // OpenAI (optional until a workflow needs it)
  openaiKey: optional('OPENAI_API_KEY'),

  // Google CSE (image search)
  googleKey: optional('GOOGLE_API_KEY'),
  googleCseId: optional('GOOGLE_CSE_ID'),

  // Cloudinary
  cloudName: optional('CLOUDINARY_CLOUD_NAME'),
  cloudKey: optional('CLOUDINARY_API_KEY'),
  cloudSecret: optional('CLOUDINARY_API_SECRET'),

  // Frame-mock service
  frameMockUrl: optional('FRAME_MOCK_URL'),
  frameMockApiKey: optional('FRAME_MOCK_API_KEY'),

  // Paint service
  paintEndpoint: optional('PAINT_ENDPOINT'),

  // Shopify
  shop: optional('SHOPIFY_SHOP'),
  shopToken: optional('SHOPIFY_ACCESS_TOKEN'),
  shopifyVersion: optional('SHOPIFY_API_VERSION', '2024-04'),

  // Queues & workers (mirrors defaults in queues/workers)
  queuePrefix: optional('QUEUE_PREFIX', 'art-factory'),
  queue: {
    attempts: num('QUEUE_ATTEMPTS', 5),
    backoffMs: num('QUEUE_BACKOFF_MS', 1000),
    removeOnComplete: bool('QUEUE_REMOVE_ON_COMPLETE', true),
    removeOnFail: bool('QUEUE_REMOVE_ON_FAIL', false),
  },
  concurrency: {
    catchment: num('CONCURRENCY_CATCHMENT', 3),
    location: num('CONCURRENCY_LOCATION', 3),
    photo: num('CONCURRENCY_PHOTO', 4),
    artwork: num('CONCURRENCY_ARTWORK', 2),
    publish: num('CONCURRENCY_PUBLISH', 2),
  },
};