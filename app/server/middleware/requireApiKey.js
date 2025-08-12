import { env } from '../../config/env.js';

// Optional API key auth for write endpoints
export function requireApiKey(req, res, next) {
  const expected = env.ingestKey; // set to enable
  if (!expected) return next();
  const provided = req.headers['x-api-key'] || req.headers['x-ingest-key'];
  if (provided !== expected) {
    if (typeof req.log === 'function') {
      req.log({ event: 'auth_failed' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
