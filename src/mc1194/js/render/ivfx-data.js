// ImmersiveVFX port — data tables (fogs.json / sky.json / biome_tags.json /
// light_rays.json) + sampling helpers. Loaded lazily via the page fetch path
// (works live and in the offline single-file build, same as touch-icons).
//
// fogs.json: 771 entries keyed by obfuscated biome-variant id, each
//   {air:[start,end,"hex",mode], water:[...], weather:[...]}.
//   Keys can't be de-obfuscated (private substitution), so entries are picked
//   by stable hash of the biome name — same distribution of real values the
//   mod ships, stable per biome.
// sky.json: {columns:[15 day-times], profiles:{0..29:[8 rows x 15 hex]}}.
//   Sampled by time-of-day for the Realistic sky tint LUT.
// light_rays.json: {0..29:"hex"} accent colors, picked by biome hash.
// biome_tags.json: real 1.19.4 biome names -> tags (desert, ocean, forest...).

let cache = null;

async function fetchJson(rel) {
  const r = await fetch('src/mc1194/ivfx/' + rel);
  if (!r.ok) throw new Error('ivfx missing ' + rel);
  return r.json();
}

export async function ivfxData() {
  if (cache) return cache;
  const [fogs, sky, biomeTags, lightRays] = await Promise.all([
    fetchJson('vfx/fogs.json').catch(() => ({})),
    fetchJson('vfx/sky.json').catch(() => null),
    fetchJson('vfx/biome_tags.json').catch(() => ({ biomes: {} })),
    fetchJson('vfx/light_rays.json').catch(() => ({})),
  ]);
  cache = {
    fogs, fogKeys: Object.keys(fogs),
    sky, biomeTags: biomeTags.biomes || {},
    lightRays,
  };
  return cache;
}

export function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function hexRgb(hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Fog entry for a biome name (stable pick from the mod's real table).
export function fogFor(data, biomeName) {
  if (!data || !data.fogKeys.length) return null;
  return data.fogs[data.fogKeys[hashStr(biomeName || 'plains') % data.fogKeys.length]];
}

// Sky profile LUT sample: profile picked by biome CLIMATE (desert WARM,
// snowy PALE, else temperate BLUE — the 30 profiles are climate palettes, so
// raw hashing lands e.g. plains on an amber desert profile = beige noon),
// column by day time (columns are day-times in ticks). Returns 8 rows.
const WARM_PROFILES = ['3', '5', '8', '13', '23', '24', '25', '29'];
const PALE_PROFILES = ['10', '27'];
export function skyProfileFor(data, biomeName, worldTime, tags) {
  const sky = data && data.sky;
  if (!sky || !sky.columns || !sky.profiles) return null;
  const T = tags || [];
  const isWarm = T.includes('desert') || T.includes('mesa') || T.includes('badlands') || T.includes('savanna') || T.includes('warm');
  const isCold = T.includes('snowy') || T.includes('frozen') || T.includes('ice') || T.includes('snow');
  let ids = Object.keys(sky.profiles);
  if (isWarm) ids = WARM_PROFILES;
  else if (isCold) ids = PALE_PROFILES;
  else ids = ids.filter((id) => !WARM_PROFILES.includes(id) && !PALE_PROFILES.includes(id));
  if (!ids.length) ids = Object.keys(sky.profiles);
  const prof = sky.profiles[ids[hashStr(biomeName || 'plains') % ids.length]];
  if (!prof) return null;
  const t = ((Number(worldTime) || 0) % 24000 + 24000) % 24000;
  const cols = sky.columns;
  let i = 0;
  while (i < cols.length - 2 && t >= cols[i + 1] && t < 24000) i++;
  // columns wrap (last == first == 18000); find bracketing segment.
  let a = 0;
  for (let k = 0; k < cols.length - 1; k++) {
    const c0 = cols[k], c1 = cols[k + 1];
    if (c1 > c0 ? (t >= c0 && t < c1) : (t >= c0 || t < c1)) { a = k; break; }
    a = k;
  }
  const b = Math.min(a + 1, cols.length - 1);
  const c0 = cols[a], c1 = cols[b];
  let f = c1 === c0 ? 0 : (t - c0) / (c1 - c0);
  if (!(f >= 0 && f <= 1)) f = 0;
  return prof.map((row) => {
    const A = hexRgb(row[a] || '000000'), B = hexRgb(row[b] || '000000');
    return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
  });
}

export function lightRayColor(data, biomeName) {
  if (!data) return [1, 0.9, 0.65];
  const keys = Object.keys(data.lightRays || {});
  if (!keys.length) return [1, 0.9, 0.65];
  return hexRgb(data.lightRays[keys[hashStr(biomeName || 'plains') % keys.length]] || 'FFE8A6');
}

export function biomeTags(data, biomeName) {
  if (!data) return [];
  return data.biomeTags['minecraft:' + biomeName] || data.biomeTags[biomeName] || [];
}
