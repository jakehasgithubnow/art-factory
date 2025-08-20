import IORedis from 'ioredis';
import { env } from '../config/env.js';

// Lightweight, dependency-free logger fallback
function logSafe(event, extra = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...extra }));
  } catch {
    // best-effort
  }
}

// Singleton Redis connection for resilience utilities
let _redis;
function getRedis() {
  if (_redis) return _redis;
  _redis = new IORedis(env.redisUrl);
  return _redis;
}

export class RetryableError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'RetryableError';
    this.retryable = true;
    this.meta = meta;
  }
}

export class CircuitOpenError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
    this.meta = meta;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt, base = 1000, max = 30000, jitter = true) {
  const exp = Math.min(max, base * Math.pow(2, attempt));
  if (!jitter) return exp;
  // Full jitter
  return Math.floor(Math.random() * exp);
}

function defaultClassify(err) {
  // Explicit retryable
  if (err && (err.retryable || err instanceof RetryableError)) return true;

  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const status = Number(err?.status || err?.statusCode);

  // Abort/Timeout/Networkish errors are retryable
  if (name === 'AbortError') return true;
  if (/ECONNRESET|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(code)) return true;

  // Fetch may throw TypeError for network failures
  if (name === 'TypeError' && /fetch|network/i.test(String(err?.message || ''))) return true;

  // HTTP status-based: retry 408, 409 (sometimes), 425, 429, and 5xx
  if (Number.isFinite(status)) {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status === 409) return true;
    if (status >= 500) return true;
    // Other 4xx are considered non-retryable (auth/validation/etc.)
    return false;
  }

  // Unknowns: be conservative and do not retry
  return false;
}

/**
 * Retry a function with exponential backoff and jitter.
 * The function will be called as fn({ attempt, signal }) where:
 *  - attempt starts at 0
 *  - signal is an AbortSignal with per-attempt timeout applied
 */
export async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = 2,
    base = 1000,
    max = 8000,
    jitter = true,
    timeoutMs = 300000, // 5 minutes default (matches PiAPI long tail)
    classify = defaultClassify,
    totalBudgetMs, // optional cap for total elapsed time
    onAttempt, // optional hook: ({ attempt }) => void
    onFail,    // optional hook: ({ attempt, err }) => void
  } = opts;

  const start = Date.now();
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (typeof onAttempt === 'function') {
      try { onAttempt({ attempt }); } catch {}
    }

    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await fn({ attempt, signal: controller.signal });
      clearTimeout(to);
      return result;
    } catch (err) {
      clearTimeout(to);
      lastErr = err;

      const retryable = classify(err);
      if (!retryable || attempt === retries) {
        if (typeof onFail === 'function') {
          try { onFail({ attempt, err }); } catch {}
        }
        throw err;
      }

      const delay = backoffDelay(attempt, base, max, jitter);
      const elapsed = Date.now() - start;
      if (Number.isFinite(totalBudgetMs) && elapsed + delay > totalBudgetMs) {
        // Exceeded total retry budget
        throw err;
      }

      await sleep(delay);
    }
  }

  // Should not reach here
  throw lastErr || new Error('retryWithBackoff exhausted without an error');
}

/**
 * Simple Redis-backed circuit breaker.
 *
 * Trips after minFailures within windowMs.
 * When open, rejects immediately until cooldownMs elapses.
 * On success, clears failures and closes the circuit.
 */
export async function withCircuitBreaker(key, fn, options = {}) {
  const redis = getRedis();
  const now = Date.now();

  const {
    minFailures = Number(process.env.PIAPI_CIRCUIT_MIN_FAILURES || 5),
    windowMs   = Number(process.env.PIAPI_CIRCUIT_WINDOW_MS     || 60000),
    cooldownMs = Number(process.env.PIAPI_CIRCUIT_COOLDOWN_MS   || 120000),
    countAllFailures = false, // if true, count all errors; if false, only retryable
    classify = defaultClassify,
  } = options;

  const openKey = `cb:${key}:open_until`;
  const failKey = `cb:${key}:failures`;

  // If circuit is currently open, fail fast
  const openUntilRaw = await redis.get(openKey);
  const openUntil = openUntilRaw ? parseInt(openUntilRaw, 10) : 0;
  if (openUntil && openUntil > now) {
    logSafe('circuit_rejected', { key, openUntil, remaining_ms: openUntil - now });
    throw new CircuitOpenError(`Circuit '${key}' is open`, { key, openUntil });
  }

  try {
    const res = await fn();
    // Success: clear old failures and close circuit
    try {
      await redis.del(openKey);
      await redis.del(failKey);
      logSafe('circuit_closed', { key });
    } catch {}
    return res;
  } catch (err) {
    // Record a failure and possibly trip the circuit
    const shouldCount = countAllFailures || classify(err);
    if (shouldCount) {
      try {
        const ts = Date.now();
        // Use ZSET of timestamps to maintain a sliding window
        await redis.zadd(failKey, ts, String(ts));
        await redis.zremrangebyscore(failKey, 0, ts - windowMs);
        const count = await redis.zcard(failKey);

        if (count >= minFailures) {
          const until = ts + cooldownMs;
          // Store open_until with PX so it auto-expires
          await redis.set(openKey, String(until), 'PX', cooldownMs);
          logSafe('circuit_open', { key, count, until, cooldownMs });
        } else {
          logSafe('circuit_failure_counted', { key, count });
        }
      } catch {}
    } else {
      logSafe('circuit_failure_ignored', { key, reason: 'non-retryable' });
    }
    throw err;
  }
}

// Convenience exports for PiAPI use-cases
export function classifyPiapiError(err) {
  // Reuse default but allow easy override in callers
  return defaultClassify(err);
}
