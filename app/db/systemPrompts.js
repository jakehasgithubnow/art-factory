import db from './client.js';

export async function getSystemPrompt(key) {
  const row = await db('system_prompts').where({ key }).first();
  return row ? row.text : null;
}

export async function getAll() {
  return db('system_prompts').orderBy('id', 'asc');
}

export async function getByKey(key) {
  return db('system_prompts').where({ key }).first();
}

export async function updatePrompt(key, text, enabled = true, model) {
  const patch = { updated_at: db.fn.now() };
  if (typeof text === 'string') patch.text = text;
  if (typeof enabled === 'boolean') patch.enabled = enabled;
  if (model !== undefined) {
    if (model == null || model === '') {
      patch.model = null;
    } else if (typeof model === 'string') {
      patch.model = model.trim();
    }
  }

  const existing = await db('system_prompts').where({ key }).first();
  if (existing) {
    await db('system_prompts')
      .where({ key })
      .update(patch);
    return db('system_prompts').where({ key }).first();
  } else {
    await db('system_prompts')
      .insert({ key, ...patch });
    return db('system_prompts').where({ key }).first();
  }
}
