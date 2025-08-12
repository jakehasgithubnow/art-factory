import db from './client.js';

export async function getEnabled() {
  return db('style_prompts').where({ enabled: true }).orderBy('id', 'asc');
}

export async function getAll() {
  return db('style_prompts').orderBy('id', 'asc');
}

export async function createPrompt(text, enabled = true) {
  const [prompt] = await db('style_prompts')
    .insert({ text, enabled })
    .returning('*');
  return prompt;
}

export async function updatePrompt(id, text) {
  const [prompt] = await db('style_prompts')
    .where({ id })
    .update({ text, updated_at: db.fn.now() })
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
