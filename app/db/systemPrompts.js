import db from './client.js';

export async function getSystemPrompt(key) {
  const row = await db('system_prompts').where({ key }).first();
  return row ? row.prompt : null;
}

export async function getAll() {
  return db('system_prompts').orderBy('id', 'asc');
}

export async function getByKey(key) {
  return db('system_prompts').where({ key }).first();
}

export async function updatePrompt(key, text, enabled = true) {
  const existing = await db('system_prompts').where({ key }).first();
  if (existing) {
    await db('system_prompts')
      .where({ key })
      .update({ text, enabled, updated_at: db.fn.now() });
    return db('system_prompts').where({ key }).first();
  } else {
    await db('system_prompts')
      .insert({ key, text, enabled, updated_at: db.fn.now() });
    return db('system_prompts').where({ key }).first();
  }
}
