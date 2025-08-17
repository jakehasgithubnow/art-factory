/**
 * Heuristic image ranking utilities.
 * Focus: fast, deterministic pre-ranking for Openverse results using only metadata.
 * Designed to be used before any ML/LLM aesthetic scoring to reduce candidate set size.
 */

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function toLower(str) {
  return typeof str === 'string' ? str.toLowerCase() : '';
}

function safeInt(n, def = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}

function pixelsOf(img) {
  const w = safeInt(img?.width, 0);
  const h = safeInt(img?.height, 0);
  return w * h;
}

function ratioOf(img) {
  const w = safeInt(img?.width, 0);
  const h = safeInt(img?.height, 0);
  if (w <= 0 || h <= 0) return 0;
  return w / h;
}

function normalizedResolutionScore(px) {
  // Map 0.5MP..16MP to 0..1 (log scale)
  const minPx = 0.5e6;
  const maxPx = 16e6;
  const v = Math.log10(Math.max(px, 1));
  const minV = Math.log10(minPx);
  const maxV = Math.log10(maxPx);
  return clamp01((v - minV) / (maxV - minV));
}

function aspectClosenessScore(ratio, preferredRatios = [1.5, 1.777, 1.333]) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  let minRel = Infinity;
  for (const pr of preferredRatios) {
    if (!Number.isFinite(pr) || pr <= 0) continue;
    const rel = Math.abs(ratio - pr) / pr;
    if (rel < minRel) minRel = rel;
  }
  if (!Number.isFinite(minRel)) return 0;
  const closeness = 1 - minRel; // 1 when exact match, decreases with distance
  return clamp01(closeness * 1.2); // gentle boost
}

function makeAliases(query = '', extra = []) {
  const q = toLower(query).trim();
  const al = new Set(extra.map(toLower));
  if (q) al.add(q);
  // Light-weight special casing for a very common case
  if (/\bnew york\b|\bnyc\b|\bmanhattan\b/.test(q)) {
    [
      'nyc',
      'new york',
      'manhattan',
      'brooklyn',
      'queens',
      'bronx',
      'staten island',
      'times square',
      'central park',
      'empire state',
      'one world trade',
      'brooklyn bridge',
      'manhattan skyline',
    ].forEach(s => al.add(s));
  }
  return Array.from(al);
}

const DEFAULT_LICENSE_WEIGHTS = {
  cc0: 0.06,
  pdm: 0.06,
  by: 0.04,
  'by-sa': 0.03,
  'by-nc': 0.0,
  'by-nd': 0.0,
  'by-nc-sa': 0.0,
  'by-nc-nd': 0.0,
};

const DEFAULT_PROVIDER_WEIGHTS = {
  flickr: 0.02,
  // conservative defaults; add more empirically if desired
  // 'stocksnap': 0.01,
  // 'rawpixel': 0.01,
};

export const DEFAULT_RANK_OPTIONS = {
  minWidth: 1200,
  minHeight: 800,
  extremeRatioMin: 0.3, // reject very tall
  extremeRatioMax: 3.5, // reject very wide
  preferredRatios: [1.5, 1.777, 1.333], // 3:2, 16:9, 4:3
  orientationPreference: 'landscape', // 'landscape' | 'portrait' | null
  orientationBonus: 0.05, // if matches preference
  keywordAliases: [], // extra aliases, query is always included
  keywordBonus: 0.04,
  licenseWeights: DEFAULT_LICENSE_WEIGHTS,
  providerWeights: DEFAULT_PROVIDER_WEIGHTS,
};

function keywordMatchBonus(title, query, aliases, bonus = 0.04) {
  const t = toLower(title || '');
  if (!t) return 0;
  const all = makeAliases(query, aliases);
  for (const a of all) {
    if (a && t.includes(a)) return bonus;
  }
  return 0;
}

function licenseBonus(license, weights = DEFAULT_LICENSE_WEIGHTS) {
  const k = toLower(license || '');
  if (!k) return 0;
  return Number(weights[k]) || 0;
}

function providerBonus(provider, weights = DEFAULT_PROVIDER_WEIGHTS) {
  const k = toLower(provider || '');
  if (!k) return 0;
  return Number(weights[k]) || 0;
}

function orientationBonusOf(img, preference = 'landscape', bonus = 0.05) {
  if (!preference) return 0;
  const w = safeInt(img?.width, 0);
  const h = safeInt(img?.height, 0);
  if (w <= 0 || h <= 0) return 0;
  const isLandscape = w >= h;
  if (preference === 'landscape' && isLandscape) return bonus;
  if (preference === 'portrait' && !isLandscape) return bonus;
  return 0;
}

/**
 * Compute heuristic score for an image based on metadata.
 * Returns an object with granular subscores and final score.
 */
export function computeHeuristicScore(img, query, options = {}) {
  const opts = { ...DEFAULT_RANK_OPTIONS, ...options };

  const w = safeInt(img?.width, 0);
  const h = safeInt(img?.height, 0);
  const px = pixelsOf(img);
  const ratio = ratioOf(img);

  // Pre-filters (caller may also apply, but we reflect in debug)
  const tooSmall = w < opts.minWidth || h < opts.minHeight;
  const extreme = ratio > 0 ? (ratio < opts.extremeRatioMin || ratio > opts.extremeRatioMax) : true;

  const resScore = normalizedResolutionScore(px);
  const aspectScore = aspectClosenessScore(ratio, opts.preferredRatios);
  const oBonus = orientationBonusOf(img, opts.orientationPreference, opts.orientationBonus);
  const lBonus = licenseBonus(img?.license, opts.licenseWeights);
  const pBonus = providerBonus(img?.provider, opts.providerWeights);
  const kBonus = keywordMatchBonus(img?.title, query, opts.keywordAliases, opts.keywordBonus);

  // Combine per documented weights
  const score =
    0.55 * resScore +
    0.30 * aspectScore +
    oBonus +
    lBonus +
    pBonus +
    kBonus;

  return {
    score: clamp01(score),
    resScore,
    aspectScore,
    orientationBonus: oBonus,
    licenseBonus: lBonus,
    providerBonus: pBonus,
    keywordBonus: kBonus,
    px,
    ratio,
    tooSmall,
    extremeRatio: extreme,
  };
}

/**
 * Filter, score, and sort candidates.
 * Returns array of enriched items: { ...img, heuristic: { score, ...debug } }
 */
export function rankAndTrim(images, query, options = {}, limit = images?.length || 0) {
  if (!Array.isArray(images) || images.length === 0) return [];

  const opts = { ...DEFAULT_RANK_OPTIONS, ...options };

  // Deduplicate by normalized URL (lowercased)
  const seen = new Set();
  const deduped = [];
  for (const img of images) {
    const key = toLower(String(img?.url || ''));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(img);
  }

  const scored = [];
  for (const img of deduped) {
    const debug = computeHeuristicScore(img, query, opts);
    // Apply pre-filters
    if (debug.tooSmall) continue;
    if (debug.extremeRatio) continue;
    scored.push({ img, debug });
  }

  scored.sort((a, b) => {
    // Primary: heuristic score desc
    if (b.debug.score !== a.debug.score) return b.debug.score - a.debug.score;
    // Tie-break: pixels desc
    if (b.debug.px !== a.debug.px) return b.debug.px - a.debug.px;
    // Next: width desc
    const aw = safeInt(a.img?.width, 0);
    const bw = safeInt(b.img?.width, 0);
    if (bw !== aw) return bw - aw;
    // Stable fallback: lexical URL
    const au = String(a.img?.url || '');
    const bu = String(b.img?.url || '');
    return au.localeCompare(bu);
  });

  const top = scored.slice(0, Math.max(0, limit));

  // Attach heuristic info to returned objects
  return top.map(({ img, debug }) => ({
    ...img,
    heuristic: {
      score: debug.score,
      resScore: debug.resScore,
      aspectScore: debug.aspectScore,
      orientationBonus: debug.orientationBonus,
      licenseBonus: debug.licenseBonus,
      providerBonus: debug.providerBonus,
      keywordBonus: debug.keywordBonus,
      px: debug.px,
      ratio: debug.ratio,
    },
  }));
}
