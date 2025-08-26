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
    { type: 'text', text: String((prompt || '') + '\n\nReturn an output image. Provide the final image as an output_image.') },
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
    // Hints for image-capable models (OpenRouter passthrough)
    extra_body: {
      modalities: ['text', 'image'],
      image: { size: '1536x1024' },
    },
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
  const dataUriRe = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

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
      // Generic image part with url (some providers use type "image")
      if (part?.type === 'image' && part.image_url?.url) {
        imageUrls.push(String(part.image_url.url));
        log({ event: 'openrouter_generate_found_url', traceId, source, imageUrl: part.image_url.url });
      }
      // Base64 fallback(s)
      if (part?.type === 'output_image' && part.b64_json) {
        const dataUrl = `data:image/png;base64,${part.b64_json}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64', traceId, source, length: part.b64_json.length });
      }
      if (part?.type === 'output_image' && (part.b64 || part.data)) {
        const b64 = part.b64 || part.data;
        const dataUrl = `data:image/png;base64,${b64}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64_generic', traceId, source, length: b64.length });
      }
      // Base64 via nested source (OpenRouter/Gemini variant)
      if (part?.type === 'output_image' && part.source?.type === 'base64' && (part.source?.data || part.source?.base64)) {
        const b64 = part.source.data || part.source.base64;
        const mt = part.source?.media_type || part.source?.mime_type || 'image/png';
        const dataUrl = `data:${mt};base64,${b64}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64_source', traceId, source, media_type: mt, length: b64.length });
      }
      // Base64 via inline_data (Gemini-style)
      if (part?.type === 'output_image' && part.inline_data?.data) {
        const b64 = part.inline_data.data;
        const mt = part.inline_data?.mime_type || 'image/png';
        const dataUrl = `data:${mt};base64,${b64}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64_inline', traceId, source, media_type: mt, length: b64.length });
      }
      // Generic image part with base64 source
      if (part?.type === 'image' && part.source?.type === 'base64' && (part.source?.data || part.source?.base64)) {
        const b64 = part.source.data || part.source.base64;
        const mt = part.source?.media_type || part.source?.mime_type || 'image/png';
        const dataUrl = `data:${mt};base64,${b64}`;
        imageUrls.push(dataUrl);
        log({ event: 'openrouter_generate_found_b64_image_source', traceId, source, media_type: mt, length: b64.length });
      }

      // Deep scan for any http(s) URLs or data URIs present in arbitrary fields
      try {
        const s = JSON.stringify(part);
        const anyUrls = s.match(/https?:\/\/[^\s"'()\\]+/g);
        if (anyUrls) {
          for (const u of anyUrls) {
            imageUrls.push(String(u));
            log({ event: 'openrouter_generate_found_url_any', traceId, source, imageUrl: u });
          }
        }
        const anyData = s.match(dataUriRe);
        if (anyData) {
          for (const du of anyData) {
            imageUrls.push(String(du));
            log({ event: 'openrouter_generate_found_data_uri_any', traceId, source, length: du.length });
          }
        }
      } catch {}
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
              // Accept any http(s) URL; some Gemini URLs may not have a file extension
              imageUrls.push(u);
              log({ event: 'openrouter_generate_found_url_fallback', traceId, imageUrl: u });
            }
          }
          const dataMatches = str.match(dataUriRe);
          if (dataMatches) {
            for (const du of dataMatches) {
              imageUrls.push(du);
              log({ event: 'openrouter_generate_found_data_uri', traceId, length: du.length });
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

  // If streaming yielded nothing, try a non-streaming request and parse the full JSON
  if (imageUrls.length === 0) {
    try {
      const resp2 = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          ...(env.openRouterSiteUrl ? { 'HTTP-Referer': String(env.openRouterSiteUrl) } : {}),
          ...(env.openRouterSiteName ? { 'X-Title': String(env.openRouterSiteName) } : {}),
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            {
              role: 'user',
              content,
            },
          ],
          extra_body: {
            modalities: ['text', 'image'],
            image: { size: '1536x1024' },
          },
        }),
      });

      if (resp2.ok) {
        const full = await resp2.json();
        // Attempt to collect known parts
        const messageContent = full?.choices?.[0]?.message?.content;
        if (messageContent) collectFromContentParts(messageContent, 'message_non_stream');
        // Regex fallback across entire payload: http(s) image links and data URIs
        const str2 = JSON.stringify(full);
        const urlMatches2 = str2.match(/https?:\/\/[^\s"'()\\]+/g);
        if (urlMatches2) {
          for (const u of urlMatches2) {
            // Accept any http(s) URL; some Gemini URLs may not have a file extension
            imageUrls.push(u);
            log({ event: 'openrouter_generate_found_url_fallback_ns', traceId, imageUrl: u });
          }
        }
        const dataMatches2 = str2.match(dataUriRe);
        if (dataMatches2) {
          for (const du of dataMatches2) {
            imageUrls.push(du);
            log({ event: 'openrouter_generate_found_data_uri_ns', traceId, length: du.length });
          }
        }
      } else {
        const preview2 = await (async () => { try { return await resp2.text(); } catch { return ''; } })();
        log({ event: 'openrouter_http_error_non_stream', traceId, status: resp2.status, preview: preview2?.slice(0, 400) });
      }
    } catch (e) {
      log({ event: 'openrouter_non_stream_fallback_failed', traceId, message: e?.message });
    }
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
