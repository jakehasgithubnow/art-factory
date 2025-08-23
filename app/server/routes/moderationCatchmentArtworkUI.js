import express from 'express';

const router = express.Router();

/**
 * Unify moderation UI: redirect catchment artwork moderation to the single artwork moderation screen.
 * Old path: /admin/moderate-catchment-artwork/:catchmentId
 * New unified screen: /admin/moderate-artwork/:catchmentId
 */
router.get('/admin/moderate-catchment-artwork/:catchmentId', async (req, res, next) => {
  try {
    const { catchmentId } = req.params;
    // Permanent redirect to the unified moderation UI
    res.redirect(301, `/admin/moderate-artwork/${encodeURIComponent(catchmentId)}`);
  } catch (err) {
    next(err);
  }
});

export default router;
