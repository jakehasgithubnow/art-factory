/**
 * Usage:
 *   OPENROUTER_API_KEY=sk-... node app/scripts/test-gemini.js "A dreamy watercolor of mountains at sunrise, misty valleys, soft pastels"
 *
 * Optional envs (already wired in env.js):
 *   - OPENROUTER_MODEL (default: google/gemini-2.5-flash-image-preview)
 *   - OPENROUTER_BASE_URL (default: https://openrouter.ai/api/v1)
 *   - OPENROUTER_SITE_URL, OPENROUTER_SITE_NAME (optional attribution headers)
 */
import { env } from '../config/env.js';
import { generateImageWithGemini } from '../services/openrouter.js';
import { promises as fs } from 'fs';
import path from 'path';

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

async function saveDataUrlToFile(dataUrl, outDir, base) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match) throw new Error('Unrecognized data URL');
  const mime = match[1];
  const b64 = match[2];
  const ext = extFromMime(mime);
  const filename = `${base}.${ext}`;
  const filePath = path.join(outDir, filename);
  await fs.writeFile(filePath, Buffer.from(b64, 'base64'));
  return filePath;
}

function sniffMimeFromBytes(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return 'application/octet-stream';
}

async function saveRawBase64ToFile(b64, outDir, base) {
  const clean = String(b64).replace(/\s+/g, '');
  const buf = Buffer.from(clean, 'base64');
  const mime = sniffMimeFromBytes(buf);
  const ext = extFromMime(mime);
  const filename = `${base}.${ext}`;
  const filePath = path.join(outDir, filename);
  await fs.writeFile(filePath, buf);
  return filePath;
}

function isLikelyBase64(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 256) return false;
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s);
}

async function main() {
  const prompt = process.argv[2] || 'Generate a vibrant impressionist landscape painting with mountains, a lake, and golden-hour lighting. Return the final image.';
  console.log('[test-gemini] Model:', env.openRouterModel || 'google/gemini-2.5-flash-image-preview');
  console.log('[test-gemini] Prompt:', prompt);

  const urls = await generateImageWithGemini({ prompt });
  if (!Array.isArray(urls) || urls.length === 0) {
    console.error('[test-gemini] No image URLs returned.');
    process.exit(2);
  }

  const outDir = path.resolve(process.cwd(), 'output');
  await fs.mkdir(outDir, { recursive: true });
  console.log('[test-gemini] Output dir:', outDir);

  let idx = 0;
  console.log('[test-gemini] Results:');
  for (const u of urls) {
    if (typeof u !== 'string') {
      console.log(' - non-string payload ignored');
      continue;
    }

    if (u.startsWith('data:')) {
      const filePath = await saveDataUrlToFile(u, outDir, `gemini-${Date.now()}-${idx++}`);
      console.log(' - saved data image ->', filePath);
      continue;
    }

    if (/^https?:\/\//i.test(u)) {
      console.log(' - remote image URL ->', u);
      continue;
    }

    if (isLikelyBase64(u)) {
      try {
        const filePath = await saveRawBase64ToFile(u, outDir, `gemini-${Date.now()}-${idx++}`);
        console.log(' - saved base64 image ->', filePath);
      } catch (e) {
        const short = u.length > 140 ? u.slice(0, 140) + '…' : u;
        console.log(' - unrecognized base64 payload (could not save). length=', u.length, ' preview=', short);
      }
      continue;
    }

    const short = u.length > 140 ? u.slice(0, 140) + '…' : u;
    console.log(' - unrecognized payload ->', short);
  }
}

main().catch((err) => {
  console.error('[test-gemini] Failed:', err?.message || err);
  process.exit(1);
});
