import { randomUUID } from 'crypto';
import cloudinary from 'cloudinary';
import { env } from '../config/env.js';

cloudinary.v2.config({
  cloud_name: env.cloudName,
  api_key: env.cloudKey,
  api_secret: env.cloudSecret,
});

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 2;
const BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const code = err?.http_code || err?.statusCode;
  // Retry on 429 and 5xx or common network-ish errors
  return (
    code === 429 || (typeof code === 'number' && code >= 500) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(String(err?.message || ''))
  );
}

/**
 * Upload an image (remote URL, local path, or buffer/stream) to Cloudinary.
 * Backward compatible return shape: { url, id } while also returning raw fields.
 *
 * @param {string|Buffer|Stream} image - Source to upload (URL, path, buffer, stream)
 * @param {Object} [options]
 * @param {string} [options.folder] - Cloudinary folder to store under
 * @param {string[]} [options.tags]
 * @param {string} [options.publicId] - Provide for idempotency/deterministic uploads
 * @param {boolean} [options.overwrite=false]
 * @param {boolean} [options.invalidate=false]
 * @param {number} [options.timeoutMs=20000]
 * @param {number} [options.retries=2]
 */
export async function getImageMetadata(publicId, {
  exif = true,
  context = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES
} = {}) {
  if (!publicId) throw new Error('getImageMetadata: "publicId" is required');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await cloudinary.v2.api.resource(publicId, {
        resource_type: 'image',
        exif,
        context,
        timeout: timeoutMs
      });
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isRetryable(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Unknown Cloudinary metadata retrieval error');
}

export async function uploadImage(
  image,
  {
    folder,
    tags,
    publicId,
    overwrite = false,
    invalidate = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = {}
) {
  const log = (data = {}) => {
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        stage: 'cloudinary_upload',
        traceId: randomUUID(),
        ...data,
      }));
    } catch (_) {
      // ignore logging errors
    }
  };

  log({ event: 'start', folder, publicId, hasImage: Boolean(image) });
  if (!image) throw new Error('uploadImage: "image" is required');

  const options = {
    resource_type: 'image',
    folder,
    tags,
    public_id: publicId,
    overwrite,
    invalidate,
    timeout: timeoutMs,
  };

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const result = await cloudinary.v2.uploader.upload(image, options);
      const { secure_url, public_id } = result || {};
      if (!secure_url || !public_id) {
        throw new Error('Cloudinary did not return secure_url/public_id');
      }
      log({ event: 'success', public_id, secure_url, duration_ms: Date.now() - t0 });
      return { url: secure_url, id: public_id, secure_url, public_id, result };
    } catch (err) {
      lastErr = err;
      const code = err?.http_code || err?.statusCode;
      const msg = err?.message || String(err);
      log({ event: 'error', attempt, retries, code, message: msg });
      if (attempt < retries && isRetryable(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw new Error(`Cloudinary upload failed${code ? ` (${code})` : ''}: ${msg}`);
    }
  }
  throw lastErr || new Error('Unknown Cloudinary upload error');
}
