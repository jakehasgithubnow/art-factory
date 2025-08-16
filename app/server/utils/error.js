export function enhanceError(err, context = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    e.context = { ...(e.context || {}), ...context };
  } catch {
    // Fallback in case property assignment fails
    e.extraContext = context;
  }
  return e;
}
