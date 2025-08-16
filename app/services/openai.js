import OpenAI from 'openai';
import { env } from '../config/env.js';
import { randomUUID } from 'crypto';

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || env.openaiKey,
  baseURL: 'https://api.openai.com/v1'
});

const piapiClient = new OpenAI({
  apiKey: process.env.PIAPI_API_KEY || env.piapiKey || env.openaiKey,
  baseURL: 'https://api-direct.piapi.ai/v1/chat/completions'
});

const STAGE = 'openai';
function log(data = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      stage: STAGE,
      ...data,
    }));
  } catch (_) {
    // best-effort logging only
  }
}

function enhanceError(err, context = {}) {
  const e = new Error(
    `OpenAI request failed${context.stage ? ` at ${context.stage}` : ''}: ${err?.message || err}`
  );
  e.cause = err;
  e.context = context;
  return e;
}

function extractBalancedJson(text) {
  if (typeof text !== 'string') return null;
  const tryBraces = () => {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  };
  const tryBrackets = () => {
    const start = text.indexOf('[');
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
    return null;
  };
  return tryBraces() ?? tryBrackets();
}

function parseJsonLoose(text) {
  // First, try direct parse
  try {
    return JSON.parse(text);
  } catch {}
  // Next, try to extract a balanced JSON object/array from the text
  const snippet = extractBalancedJson(text);
  if (snippet) {
    try {
      return JSON.parse(snippet);
    } catch {}
  }
  // Give up with a helpful error
  const preview = (text || '').slice(0, 240);
  throw new Error(`Failed to parse JSON from model output. Preview: ${preview}`);
}

function assertTopLevelTypeMatches(value, schema) {
  if (!schema || !schema.type) return; // best-effort only
  const expected = schema.type;
  const actual = Array.isArray(value) ? 'array' : (value === null ? 'null' : typeof value);
  if (expected === 'object' && typeof value !== 'object') {
    throw new Error(`Expected JSON object but got ${actual}`);
  }
  if (expected === 'array' && !Array.isArray(value)) {
    throw new Error(`Expected JSON array but got ${actual}`);
  }
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  if (schema.type === 'object') {
    const inputProps = schema.properties || {};
    const properties = {};
    for (const [k, v] of Object.entries(inputProps)) {
      properties[k] = normalizeSchema(v);
    }
    const required = Object.keys(properties);
    return {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    };
  }

  if (schema.type === 'array') {
    return {
      type: 'array',
      items: normalizeSchema(schema.items),
    };
  }

  return schema; // primitives as-is
}

/**
 * Simple chat helper (backwards compatible)
 */
export async function chat(system, user, temperature = 0.7, model = 'gpt-4o-mini') {
  const traceId = randomUUID();
  const start = Date.now();
  log({ event: 'chat_start', traceId, model, temperature });
  try {
    const { choices } = await openaiClient.chat.completions.create({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    log({ event: 'chat_response', traceId, hasChoices: Array.isArray(choices), choiceCount: choices?.length ?? 0 });
    const content = choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Empty response from model');
    }
    log({ event: 'chat_success', traceId, duration_ms: Date.now() - start, content_len: typeof content === 'string' ? content.length : 0 });
    return content.trim();
  } catch (err) {
    log({ event: 'chat_error', traceId, name: err?.name, message: err?.message });
    throw enhanceError(err, { stage: 'chat', model });
  }
}

/**
 * Structured JSON chat helper.
 * Uses response_format to request strict JSON and adds lightweight validation & retries.
 *
 * @param {Object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {Object} [args.schema] - JSON Schema (draft-like) with at least a top-level `type` of 'object' or 'array'.
 * @param {number} [args.temperature=0]
 * @param {string} [args.model='gpt-4o-mini']
 * @param {number} [args.maxRetries=2]
 * @returns {Promise<any>} parsed JSON
 */
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
  // Prefer strict JSON mode if supported, fall back gracefully.
  const normalized = schema ? normalizeSchema(schema) : undefined;
  const isArraySchema = !!normalized && normalized.type === 'array';
  const effectiveSchema = normalized
    ? (isArraySchema
        ? { type: 'object', additionalProperties: false, properties: { data: normalized }, required: ['data'] }
        : normalized)
    : undefined;

  const response_format = effectiveSchema
    ? { type: 'json_schema', json_schema: { name: 'Output', schema: effectiveSchema, strict: true } }
    : { type: 'json_object' };

  log({ event: 'chatJson_prepared', traceId, response_format: response_format?.type, isArraySchema });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    log({ event: 'chatJson_attempt', traceId, attempt: attempt + 1 });
    try {
      const { choices } = await openaiClient.chat.completions.create({
        model,
        temperature,
        response_format,
        messages: [
          { role: 'system', content: effectiveSchema
              ? `${system}\n\nYou must return ONLY valid minified JSON satisfying the provided schema.${isArraySchema ? ' The top-level object MUST have a single key "data" containing the array.' : ''}`
              : `${system}\n\nYou must return ONLY valid minified JSON.` },
          { role: 'user', content: user },
        ],
      });
      log({ event: 'chatJson_response', traceId, attempt: attempt + 1, hasChoices: Array.isArray(choices), choiceCount: choices?.length ?? 0 });
      const raw = choices?.[0]?.message?.content ?? '';
      log({ event: 'chatJson_raw', traceId, attempt: attempt + 1, raw_len: typeof raw === 'string' ? raw.length : 0 });
      const parsed = parseJsonLoose(raw);
      log({ event: 'chatJson_parsed', traceId, attempt: attempt + 1 });

      if (isArraySchema) {
        if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
          throw new Error('Model did not return an object with a "data" array');
        }
        assertTopLevelTypeMatches(parsed.data, schema);
        log({ event: 'chatJson_success', traceId, duration_ms: Date.now() - overallStart });
        return parsed.data;
      } else {
        assertTopLevelTypeMatches(parsed, schema);
        log({ event: 'chatJson_success', traceId, duration_ms: Date.now() - overallStart });
        return parsed;
      }
    } catch (err) {
      log({ event: 'chatJson_error', traceId, attempt: attempt + 1, name: err?.name, message: err?.message });
      lastErr = err;
      if (attempt < maxRetries) {
        // On retry, make the instruction even more explicit
        system = `${system}\n\nReturn ONLY minified JSON with no commentary, markdown, or code fences.`;
        log({ event: 'chatJson_retry', traceId, next_attempt: attempt + 2 });
        continue;
      }
      log({ event: 'chatJson_fail', traceId, total_duration_ms: Date.now() - overallStart });
      throw enhanceError(lastErr, { stage: 'chatJson', model, attempt });
    }
  }
}

export { openaiClient, piapiClient };
