import db from './client.js';

export async function getEnabled() {
  return db('style_prompts').where({ enabled: true }).orderBy('id', 'asc');
}

export async function getAll() {
  return db('style_prompts').orderBy('id', 'asc');
}

export async function createPrompt(text, enabled = true, model = null) {
  const insertData = { text, enabled };
  if (model != null && typeof model === 'string' && model.trim()) {
    insertData.model = model.trim();
  }
  const [prompt] = await db('style_prompts')
    .insert(insertData)
    .returning('*');
  return prompt;
}

export async function updatePrompt(id, text, model) {
  const patch = { updated_at: db.fn.now() };
  if (typeof text === 'string') patch.text = text;
  if (model !== undefined) {
    if (model == null || model === '') {
      patch.model = null;
    } else if (typeof model === 'string') {
      patch.model = model.trim();
    }
  }
  const [prompt] = await db('style_prompts')
    .where({ id })
    .update(patch)
    .returning('*');
  return prompt;
}

export async function deletePrompt(id) {
  return db('style_prompts').where({ id }).del();
}

export async function togglePrompt(id, enabled) {
  const [prompt] = await db('style_prompts')
    .where({ id })
    .update({ enabled, updated_at: db.fn.now() })
    .returning('*');
  return prompt;
}
