// Minimal, dependency-free rate limiter
const RATE_WINDOW_MS = 60_000; // 1 minute
const RATE_MAX = 60; // requests per window per IP
const rateMap = new Map(); // ip -> { count, reset }

export function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  let entry = rateMap.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_WINDOW_MS };
    rateMap.set(ip, entry);
  }
  entry.count += 1;
  const remaining = Math.max(RATE_MAX - entry.count, 0);
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.reset / 1000)));
  if (entry.count > RATE_MAX) {
    if (typeof req.log === 'function') {
      req.log({ event: 'rate_limited', ip, count: entry.count, window_ms: RATE_WINDOW_MS });
    }
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}
