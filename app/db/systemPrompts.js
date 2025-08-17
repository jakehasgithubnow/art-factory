import db from './client.js';

export async function getAll() {
  return db('system_prompts').orderBy('id', 'asc');
}

export async function getByKey(key) {
  return db('system_prompts').where({ key }).first();
}

export async function updatePrompt(key, text, enabled = true) {
  const existing = await db('system_prompts').where({ key }).first();
  let prompt;
  if (existing) {
    [prompt] = await db('system_prompts')
      .where({ key })
      .update({ text, enabled, updated_at: db.fn.now() })
      .returning('*');
  } else {
    [prompt] = await db('system_prompts')
      .insert({ key, text, enabled })
      .returning('*');
  }
  return prompt;
}
