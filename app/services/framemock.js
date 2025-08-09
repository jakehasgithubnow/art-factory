import fetch from 'node-fetch';
import { env } from '../config/env.js';

const DEFAULT_TIMEOUT_MS = 15000; // 15s
const DEFAULT_RETRIES = 2; // total attempts = retries + 1
const BASE_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpRetryable(res) {
  return res.status === 429 || (res.status >= 500 && res.status <= 599);
}

function assertAbsoluteHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('paintingUrl must be a non-empty string');
  }
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    throw new Error('paintingUrl must be a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('paintingUrl must be http(s)');
  }
}

async function postJsonWithRetry(url, body, { timeoutMs, retries = DEFAULT_RETRIES, headers = {} } = {}) {
  let attempt = 0;
  let lastErr;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Non-2xx. Decide if retryable.
        if (isHttpRetryable(res) && attempt < retries) {
          // Consume body to free sockets
          try { await res.text(); } catch { /* ignore */ }
          attempt++;
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          await sleep(delay);
          continue;
        }

        let snippet = '';
        try {
          const text = await res.text();
          snippet = text ? `: ${text.slice(0, 200)}` : '';
        } catch { /* ignore */ }
        const err = new Error(`Frame mock-up failed (${res.status} ${res.statusText})${snippet}`);
        err.status = res.status;
        throw err;
      }

      // Try to parse JSON
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error('Frame mock-up service returned invalid JSON');
      }
      return data;
    } catch (err) {
      lastErr = err;
      const isAbort = err && err.name === 'AbortError';
      const canRetry = !isAbort && attempt < retries; // network errors (ECONNRESET, etc.)
      if (canRetry) {
        attempt++;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      throw isAbort ? new Error('Frame mock-up request timed out') : err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Unknown frame mock-up error');
}

/**
 * Call the frame-mock service to create staged mockups for a painting image URL.
 * @param {string} paintingUrl - Absolute URL to the painting image.
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string[]>} Array of mockup image URLs
 */
export async function createMockups(paintingUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!env.frameMockUrl) {
    throw new Error('Missing env.frameMockUrl');
  }
  assertAbsoluteHttpUrl(paintingUrl);

  const headers = {};
  if (env.frameMockApiKey) {
    headers['Authorization'] = `Bearer ${env.frameMockApiKey}`;
  }

  const data = await postJsonWithRetry(
    env.frameMockUrl,
    { image: paintingUrl },
    { timeoutMs, headers }
  );

  const mockups = data?.mockups;
  if (!Array.isArray(mockups) || mockups.some((m) => typeof m !== 'string')) {
    throw new Error('Frame mock-up response missing a valid "mockups" string array');
  }
  return mockups;
}