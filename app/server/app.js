import express from 'express';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requireApiKey } from './middleware/requireApiKey.js';

import operatorUI from './routes/operatorUI.js';
import moderationUI from './routes/moderationUI.js';
import moderationArtworkUI from './routes/moderationArtworkUI.js';
import moderationPhotos from './routes/moderationPhotos.js';
import moderationArtwork from './routes/moderationArtwork.js';
import eventsRoute from './routes/events.js';
import catchmentsRoute from './routes/catchments.js';
import adminRecent from './routes/adminRecent.js';
import healthRoute from './routes/health.js';

// Initialize app
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // ---------- Basic structured request logging ----------
  app.use((req, res, next) => {
    const start = Date.now();
    const requestId = randomUUID();
    req.requestId = requestId;
    req.log = (data = {}) => {
      try {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          requestId,
          method: req.method,
          path: req.path,
          ...data,
        }));
      } catch (_) {
        // best-effort logging
      }
    };
    req.log({ event: 'request_start' });
    res.on('finish', () => {
      req.log({ event: 'request_end', status: res.statusCode, duration_ms: Date.now() - start });
    });
    next();
  });

  // Mount routes
  app.use('/', operatorUI);
  app.use('/', moderationUI);
  app.use('/', moderationArtworkUI);
  app.use('/', moderationPhotos);
  app.use('/', moderationArtwork);
  app.use('/', eventsRoute);
  app.use('/', catchmentsRoute);
  app.use('/', adminRecent);
  app.use('/', healthRoute);
  app.use('/', stylePromptsApi);
  app.use('/', stylePromptsUI);

  // ---------- Error handling ----------
  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    try {
      const payload = {
        ts: new Date().toISOString(),
        event: 'unhandled_error',
        requestId: req?.requestId,
        name: err?.name,
        message: err?.message,
        stack: err?.stack,
      };
      console.error(JSON.stringify(payload));
    } catch (_) {
      // best-effort
      console.error('Unhandled error', err);
    }
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
