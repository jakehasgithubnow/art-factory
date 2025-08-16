import { randomUUID } from 'crypto';

export async function chat(system, user, temperature = 0.7, model = 'gpt-4o-mini') {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: 'chat_start', traceId, model, temperature });

  // Prefer configured OpenAI base URL; fall back to the public API
  const endpoint =
    process.env.OPENAI_BASE_URL ||
    env.openaiBaseUrl ||
    'https://api.openai.com/v1/chat/completions';

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || env.openaiKey || process.env.PIAPI_API_KEY || env.piapiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });

    if (!resp.ok) {
      const preview = await (async () => { try { return await resp.text(); } catch { return ''; } })();
      log({ event: 'chat_http_error', traceId, status: resp.status, preview: preview?.slice(0, 400) });
      throw new Error(`Chat request failed with status ${resp.status}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
      : String(content || '').trim();

    if (!text) throw new Error('Empty response from model');

    log({ event: 'chat_success', traceId, duration_ms: Date.now() - start, content_len: text.length });
    return text;
  } catch (err) {
    log({ event: 'chat_error', traceId, message: err?.message });
    throw enhanceError(err, { stage: 'chat', model });
  }
}

export async function chatJson({
  system,
  user,
  schema,
  temperature = 0,
  model = 'gpt-4o-mini',
  maxRetries = 2,
}) {
  const traceId = randomUUID();
  const overallStart = Date.now();
  log({ event: 'chatJson_start', traceId, model, temperature, hasSchema: Boolean(schema) });

  const endpoint =
    process.env.OPENAI_BASE_URL ||
    env.openaiBaseUrl ||
    'https://api.openai.com/v1/chat/completions';

  // Helper: tolerant JSON parse (tries to extract a balanced object/array if extra text slips in)
  function extractBalancedJson(text) {
    if (typeof text !== 'string') return null;
    const tryMatch = (open, close) => {
      const start = text.indexOf(open);
      if (start === -1) return null;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return null;
    };
    return tryMatch('{', '}') ?? tryMatch('[', ']');
  }
  function parseJsonLoose(text) {
    try { return JSON.parse(text); } catch {}
    const snippet = extractBalancedJson(text);
    if (snippet) { try { return JSON.parse(snippet); } catch {} }
    const preview = (text || '').slice(0, 240);
    throw new Error(`Failed to parse JSON from model output. Preview: ${preview}`);
  }

  // Prefer json_schema if provided, otherwise request a json_object
  const response_format = schema
    ? { type: 'json_schema', json_schema: { name: 'Output', schema, strict: true } }
    : { type: 'json_object' };

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    log({ event: 'chatJson_attempt', traceId, attempt: attempt + 1 });
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.OPENAI_API_KEY || env.openaiKey || process.env.PIAPI_API_KEY || env.piapiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature,
          response_format,
          messages: [
            { role: 'system', content: schema ? `${system}\n\nReturn ONLY minified JSON strictly matching the provided schema.` : `${system}\n\nReturn ONLY minified JSON.` },
            { role: 'user', content: user },
          ],
        }),
      });

      if (!resp.ok) {
        const preview = await (async () => { try { return await resp.text(); } catch { return ''; } })();
        log({ event: 'chatJson_http_error', traceId, status: resp.status, preview: preview?.slice(0, 400) });
        throw new Error(`Chat JSON request failed with status ${resp.status}`);
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content;
      const raw = Array.isArray(content)
        ? content.map(p => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
        : String(content || '').trim();

      const parsed = parseJsonLoose(raw);
      log({ event: 'chatJson_success', traceId, duration_ms: Date.now() - attemptStart });
      return parsed;
    } catch (err) {
      lastErr = err;
      log({ event: 'chatJson_error', traceId, attempt: attempt + 1, message: err?.message });
      if (attempt < maxRetries) continue;
      log({ event: 'chatJson_fail', traceId, total_duration_ms: Date.now() - overallStart });
      throw enhanceError(lastErr, { stage: 'chatJson', model });
    }
  }
}

export async function generateImage({ prompt, imageUrl, model = "gpt-4o-image" }) {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: "generateImage_start", traceId, model });

  // Prefer env-configured endpoint; fall back to the direct PiAPI endpoint used by the worker logs
  const endpoint =
    process.env.PAINT_ENDPOINT ||
    env.paintEndpoint ||
    "https://api-direct.piapi.ai/v1/chat/completions";

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      Authorization: `Bearer ${process.env.PIAPI_API_KEY || env.piapiKey || env.openaiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            ...(imageUrl ? [{ type: "image_url", image_url: { url: imageUrl } }] : []),
            { type: "text", text: prompt }
          ]
        }
      ],
      stream: true,
    }),
  });

  if (!resp.ok || !resp.body) {
    const preview = await (async () => {
      try { return await resp.text(); } catch { return ""; }
    })();
    log({ event: "generateImage_http_error", traceId, status: resp.status, preview: preview?.slice(0, 400) });
    throw new Error(`PiAPI request failed with status ${resp.status}`);
  }

  let imageUrls = [];
  const decoder = new TextDecoder();

  function collectFromContentParts(parts, source) {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      // Standard image_url part
      if (part?.type === "image_url" && part.image_url?.url) {
        imageUrls.push(String(part.image_url.url));
        log({ event: "generateImage_found_url", traceId, source, imageUrl: part.image_url.url });
      }
      // PiAPI/OpenAI output_image (URL-backed)
      if (part?.type === "output_image" && part.source?.type === "url" && part.source?.url) {
        imageUrls.push(String(part.source.url));
        log({ event: "generateImage_found_url", traceId, source, imageUrl: part.source.url });
      }
      // Generic image part with url
      if (part?.type === "image" && part.image_url?.url) {
        imageUrls.push(String(part.image_url.url));
        log({ event: "generateImage_found_url", traceId, source, imageUrl: part.image_url.url });
      }
      // Base64 fallback (convert to data URL)
      if (part?.type === "output_image" && part.b64_json) {
        const dataUrl = `data:image/png;base64,${part.b64_json}`;
        imageUrls.push(dataUrl);
        log({ event: "generateImage_found_b64", traceId, source, length: part.b64_json.length });
      }
    }
  }

  // Robust SSE parsing: buffer until full events separated by \n\n
  let buffer = "";
  try {
    for await (const chunk of resp.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sepIndex;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const eventBlock = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);

        // Concatenate multi-line "data:" payloads
        const dataLines = eventBlock
          .split("\n")
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).trim());

        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        if (dataStr === "[DONE]") continue;

        try {
          log({ event: "generateImage_raw_chunk", traceId, preview: dataStr.slice(0, 300) });
          const data = JSON.parse(dataStr);

          // Streaming deltas
          collectFromContentParts(data?.choices?.[0]?.delta?.content, "delta");
          // Final message (non-streaming end frame)
          collectFromContentParts(data?.choices?.[0]?.message?.content, "message");

          // Regex fallback
          const str = JSON.stringify(data);
          const urlMatches = str.match(/https?:\/\/[^\s"'()\\]+/g);
          if (urlMatches) {
            for (const u of urlMatches) {
              if (/(\.png|\.jpg|\.jpeg|\.webp)(\?|$)/i.test(u)) {
                imageUrls.push(u);
                log({ event: "generateImage_found_url_fallback", traceId, imageUrl: u });
              }
            }
          }
        } catch (e) {
          log({ event: "generateImage_chunk_parse_failed", traceId, line: dataStr.slice(0, 200) });
        }
      }
    }
  } catch (err) {
    log({ event: "generateImage_error", traceId, message: err?.message });
    throw enhanceError(err, { stage: "generateImage", model });
  }

  // Deduplicate & normalize
  imageUrls = [...new Set(imageUrls.map(u => String(u).trim()))];

  log({ event: "generateImage_complete", traceId, duration_ms: Date.now() - start, foundCount: imageUrls.length });
  if (imageUrls.length === 0) {
    throw new Error("PiAPI stream did not include any image URLs");
  }
  return imageUrls;
}
