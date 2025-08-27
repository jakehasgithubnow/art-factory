import db from './client.js';

const ALLOWED_CATEGORIES = [
  'mountain_hill',
  'forest_park',
  'meadow_field',
  'river_lake_waterfall',
  'ocean_beach_coast',
  'village',
  'city',
  'industrial',
  'castle_church_ruin',
  'other'
];

const ALLOWED_PROVIDERS = ['piapi', 'gemini'];
function normalizeProvider(p) {
  const s = typeof p === 'string' ? p.trim().toLowerCase() : '';
  return ALLOWED_PROVIDERS.includes(s) ? s : 'piapi';
}

function normalizeCategories(input) {
  if (input == null || input === '') return null;
  let arr = input;
  if (typeof input === 'string') {
    arr = input.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(arr)) return null;
  const set = new Set();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const val = v.trim();
    if (!val) continue;
    if (ALLOWED_CATEGORIES.includes(val)) set.add(val);
  }
  if (set.size === 0) return null;
  return Array.from(set);
}

export async function getEnabled(scope = null) {
  const q = db('style_prompts').where({ enabled: true });
  if (scope && typeof scope === 'string') q.andWhere({ scope: scope.trim() });
  return q.orderBy('id', 'asc');
}

export async function getAll() {
  return db('style_prompts').orderBy('id', 'asc');
}

export async function createPrompt(text, enabled = true, model = null, scope = 'location', categories = null, provider = 'piapi', name = null) {
  const insertData = {
    text,
    enabled,
    scope: (typeof scope === 'string' && scope.trim()) ? scope.trim() : 'location',
    provider: normalizeProvider(provider),
  };
  if (model != null && typeof model === 'string' && model.trim()) {
    insertData.model = model.trim();
  }
  const normCats = normalizeCategories(categories);
  if (normCats) insertData.categories = normCats;
  else insertData.categories = null;

  if (name !== undefined) {
    if (name == null || (typeof name === 'string' && name.trim() === '')) {
      insertData.name = null;
    } else if (typeof name === 'string') {
      insertData.name = name.trim();
    }
  }

  const [prompt] = await db('style_prompts')
    .insert(insertData)
    .returning('*');
  return prompt;
}

export async function updatePrompt(id, text, model, scope, categories, provider, name) {
  const patch = { updated_at: db.fn.now() };
  if (typeof text === 'string') patch.text = text;
  if (model !== undefined) {
    if (model == null || model === '') {
      patch.model = null;
    } else if (typeof model === 'string') {
      patch.model = model.trim();
    }
  }
  if (scope !== undefined) {
    if (scope == null || scope === '') {
      // default back to 'location' if explicitly nulled
      patch.scope = 'location';
    } else if (typeof scope === 'string') {
      patch.scope = scope.trim();
    }
  }
  if (categories !== undefined) {
    const normCats = normalizeCategories(categories);
    patch.categories = normCats; // null clears restriction
  }
  if (provider !== undefined) {
    patch.provider = normalizeProvider(provider);
  }
  if (name !== undefined) {
    if (name == null || (typeof name === 'string' && name.trim() === '')) {
      patch.name = null;
    } else if (typeof name === 'string') {
      patch.name = name.trim();
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
