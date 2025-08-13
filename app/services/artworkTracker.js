/**
 * Simple in-memory tracker for artwork processing state.
 * In production, replace with a persistent store (DB, Redis, etc.)
 */

const state = {
  inProgress: new Set(),
  completed: new Set()
};

/**
 * Check if the given photoId has already been processed or is currently being processed.
 * @param {string} photoId
 * @returns {Promise<boolean>}
 */
export async function isProcessed(photoId) {
  return state.inProgress.has(photoId) || state.completed.has(photoId);
}

/**
 * Mark the given photoId as in-progress.
 * @param {string} photoId
 */
export async function markInProgress(photoId) {
  state.inProgress.add(photoId);
}

/**
 * Mark the given photoId as completed and remove from in-progress.
 * @param {string} photoId
 */
export async function markCompleted(photoId) {
  state.inProgress.delete(photoId);
  state.completed.add(photoId);
}

/**
 * Clear the in-progress state for the given photoId without marking it completed.
 * Useful when a job fails and should be retried later.
 * @param {string} photoId
 */
export async function clearInProgress(photoId) {
  state.inProgress.delete(photoId);
}

export default {
  isProcessed,
  markInProgress,
  markCompleted,
  clearInProgress
};
