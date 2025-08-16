export function log(entry) {
  const timestamp = new Date().toISOString();
  try {
    console.log(`[${timestamp}]`, JSON.stringify(entry));
  } catch {
    console.log(`[${timestamp}]`, entry);
  }
}
