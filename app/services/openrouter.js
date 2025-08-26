import fetch from 'node-fetch';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';
import { log } from '../server/utils/logger.js';
import { enhanceError } from '../server/utils/error.js';

/**
 * Generate image(s) using OpenRouter (Gemini 2.5 Flash Image).
 * Returns an array of image URLs or data URLs.
 *
 * Note: This uses streaming SSE parsing similar to our PiAPI path and
 * is tolerant to a variety of output shapes:
 *  - parts with type=image_url and a .image_url.url
 *  - parts with type=output_image and a { source: { type: 'url', url } }
 *  - parts with type=output_image and b64_json (we convert to data URL)
 *  - regex fallback to catch https? image URLs in payloads
 */
export async function generateImageWithGemini({
  prompt,
  imageUrl = null,
  additionalImageUrls = [],
  model = env.openRouterModel || 'google/gemini-2.5-flash-image-preview',
}) {
  const traceId = randomUUID();
  const start = Date.now();
  const baseUrl = env.openRouterBaseUrl || 'https://openrouter.ai/api/v1';
  const apiKey = env.openRouterKey || process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY');
  }

  log({ event: 'openrouter_generate_start', traceId, model });

  // Build messages array (OpenAI-compatible schema)
  const content = [
    ...(imageUrl ? [{ type: 'image_url', image_url: { url: String(imageUrl) } }] : []),
    ...(Array.isArray(additionalImageUrls)
      ? additionalImageUrls.map((u) => ({ type: 'image_url', image_url: { url: String(u) } }))
      : []),
    { type: 'text', text: String(prompt || '') },
  ];

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };
  // Optional attribution headers for OpenRouter rankings
  if (env.openRouterSiteUrl) headers['HTTP-Referer'] = String(env.openRouterSiteUrl);
  if (env.openRouterSiteName) headers['X-Title'] = String(env.openRouterSiteName);

  const body = JSON.stringify({
    model,
    stream: true,
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    // Some models may require explicit hints to produce images
    // extra_body: {} // reserved
  });

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body,
  });

  if (!resp.ok || !resp.body) {
    const preview = await (async () => {
      try {
        return await resp.text();
      } catch {
        return '';
      }
    })();
    log({
      event: 'openrouter_http_error',
      traceId,
      status: resp.status,
      preview: preview?.slice(0, 400),
    });
    throw enhanceError(
      new Error(`OpenRouter request failed with status ${resp.status}`),
      { stage: 'openrouter_generate', status: resp.status },
    );
  }

  let imageUrls = [];
  const decoder = new TextDecoder();

  function collectFromContentParts(parts, source) {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      // Standard image_url part
      if (part?.type === 'image_url' && part.image_url?.url) {
        imageUrls.push(String(part.image_url.url));
        log({ event: 'openrouter_generate_found_url', traceId, source, imageUrl: part.image_url.url });
      }
      // Output image with URL-backed source
      if (part?.type === 'output_image' && part.source?.type === 'url' && part.source?.url) {
        imageUrls.push(String(part.source.url));
        log({ event: 'openrouter_generate_found_url', traceId, source, imageUrl: part.source.url });
      }
      // Base64 fallback
      if (part?.type === 'output_image' && part.b64_json) {
        const dataUrl = `data:image/png;base64,${part.b64_json}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64', traceId, source, length: part.b64_json.length });
      }
    }
  }

  // Robust SSE parsing: buffer until full events separated by \n\n
  let buffer = '';
  try {
    for await (const chunk of resp.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sepIndex;
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        const dataLines = eventBlock
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());

        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join('\n');
        if (dataStr === '[DONE]') continue;

        try {
          const data = JSON.parse(dataStr);

          // Streaming deltas (OpenAI-compatible)
          collectFromContentParts(data?.choices?.[0]?.delta?.content, 'delta');
          // Final message (non-streaming end frame)
          collectFromContentParts(data?.choices?.[0]?.message?.content, 'message');

          // Regex fallback: any image-like URL in payload
          const str = JSON.stringify(data);
          const urlMatches = str.match(/https?:\/\/[^\s"'()\\]+/g);
          if (urlMatches) {
            for (const u of urlMatches) {
              if (/(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u)) {
                imageUrls.push(u);
                log({ event: 'openrouter_generate_found_url_fallback', traceId, imageUrl: u });
              }
            }
          }

          // Early break when first URL arrives to reduce latency
          if (imageUrls.length > 0) {
            const deduped = [...new Set(imageUrls.map((u) => String(u).trim()))];
            log({
              event: 'openrouter_generate_success',
              traceId,
              duration_ms: Date.now() - start,
              foundCount: deduped.length,
            });
            return deduped;
          }
        } catch (e) {
          // Non-JSON line in stream; ignore
        }
      }
    }
  } catch (err) {
    log({ event: 'openrouter_generate_error', traceId, message: err?.message });
    throw enhanceError(err, { stage: 'openrouter_generate_stream' });
  }

  // Deduplicate & return what we have (may be empty)
  imageUrls = [...new Set(imageUrls.map((u) => String(u).trim()))];
  log({
    event: 'openrouter_generate_complete',
    traceId,
    duration_ms: Date.now() - start,
    foundCount: imageUrls.length,
  });
  return imageUrls;
}
