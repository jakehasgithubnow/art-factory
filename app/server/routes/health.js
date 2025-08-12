import express from 'express';

const router = express.Router();

// Health check endpoint
router.get('/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

export default router;
