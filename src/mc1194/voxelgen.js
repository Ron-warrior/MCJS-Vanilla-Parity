/* Voxel-craft worldgen port.
 *
 * Chunk/column terrain engine adapted from voxel-craft's src/js/worldgen.js
 * (Terralith-biome climate noise, height fields, caves, surface rules and
 * tree/vegetation decoration), retargeted at this engine:
 *  - no worker, no mesher, no biome tinting (the engine tints biome 1)
 *  - blocks are written through caller callbacks as 1.13.2 global state ids
 *  - biome records come from src/mc1194/vc-biomes.json (stripped Terralith
 *    26.2 datapack: id, temperature, downfall, grass/foliage/water colours,
 *    old-style tags), normalised by normalizeBiomes() before use
 *
 * Import-free IIFE (sets globalThis.__voxelGen) so the offline copy can
 * inject it as a plain module like the other feature files.
 */

(function () {
"use strict";

const CHUNK = 16;
const WORLD_H = 128;
const SEA = 62;

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ---------------- noise (voxel-craft src/js/noise.js) ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }
function grad3(h, x, y, z) {
  switch (h & 15) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
    case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
    case 12: return y + x; case 13: return -y + z; case 14: return y - x; default: return -y - z;
  }
}
function grad2(h, x, y) {
  switch (h & 7) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x; case 5: return -x; case 6: return y; default: return -y;
  }
}

class Perlin {
  constructor(seed) {
    const r = mulberry32(seed >>> 0);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  noise2(x, y) {
    const p = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(lerp(grad2(p[A], x, y), grad2(p[B], x - 1, y), u),
                lerp(grad2(p[A + 1], x, y - 1), grad2(p[B + 1], x - 1, y - 1), u), v);
  }
  noise3(x, y, z) {
    const p = this.perm;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = fade(x), v = fade(y), w = fade(z);
    const A = p[X] + Y, AA = p[A] + Z, AB = p[A + 1] + Z;
    const B = p[X + 1] + Y, BA = p[B] + Z, BB = p[B + 1] + Z;
    return lerp(
      lerp(lerp(grad3(p[AA], x, y, z), grad3(p[BA], x - 1, y, z), u),
           lerp(grad3(p[AB], x, y - 1, z), grad3(p[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad3(p[AA + 1], x, y, z - 1), grad3(p[BA + 1], x - 1, y, z - 1), u),
           lerp(grad3(p[AB + 1], x, y - 1, z - 1), grad3(p[BB + 1], x - 1, y - 1, z - 1), u), v), w);
  }
  fbm2(x, y, oct) {
    oct = oct || 4;
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.noise2(x * f, y * f); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
  ridged2(x, y, oct) {
    oct = oct || 4;
    let a = 1, f = 1, s = 0, n = 0;
    for (let i = 0; i < oct; i++) { s += a * (1 - Math.abs(this.noise2(x * f, y * f)) * 2); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }
}

function hash2i(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
function hashFloat(x, y, seed) { return hash2i(x, y, seed) / 4294967296; }

/* ---------------- biome table ---------------- */

function hasTag(tags, t) {
  for (let i = 0; i < tags.length; i++) if (tags[i] === t) return true;
  return false;
}
function hasAny(tags, list) {
  for (const t of list) if (hasTag(tags, t)) return true;
  return false;
}

// vc-biomes.json records are compact ({i,t,d,g,f,w,tags}); expand to the
// shape classifyBiome expects.
function normalizeBiomes(rows) {
  return rows.map((r) => ({
    id: r.i, temperature: r.t, downfall: r.d,
    grass: r.g, foliage: r.f, water: r.w, tags: r.tags || [],
  }));
}

function classifyBiome(b) {
  const tags = b.tags || [];
  const f = {
    ocean: hasAny(tags, ["is_aquatic", "is_deep_ocean"]),
    deepOcean: hasTag(tags, "is_deep_ocean"),
    beach: hasTag(tags, "is_beach"),
    river: hasTag(tags, "is_river"),
    snowy: hasAny(tags, ["is_snowy", "reference/temperature/frozen_all", "reference/temperature/frozen_with_structures"]),
    cold: hasTag(tags, "reference/temperature/cold"),
    warm: hasTag(tags, "reference/temperature/warm"),
    desert: hasAny(tags, ["reference/desert_all", "reference/desert_with_structures"]),
    badlands: hasAny(tags, ["reference/badlands_all", "reference/badlands_with_structures"]),
    forest: hasTag(tags, "reference/forest"),
    jungle: hasTag(tags, "reference/jungle"),
    taiga: hasTag(tags, "reference/taiga"),
    plains: hasTag(tags, "reference/plains"),
    savanna: hasTag(tags, "reference/savanna"),
    swamp: hasTag(tags, "reference/swamp"),
    peak: hasTag(tags, "reference/mountain_peak"),
    slope: hasTag(tags, "reference/mountain_slope"),
    mountain: hasAny(tags, ["reference/mountain_peak", "reference/mountain_slope"]),
    mushroom: hasAny(tags, ["is_mushroom", "reference/mushroom_fields"]),
    dead: hasTag(tags, "is_dead"),
    floral: hasAny(tags, ["is_floral", "is_flower_forest"]),
    stony: hasTag(tags, "is_stony_shores"),
    highlands: hasTag(tags, "highlands"),
    cliffs: hasTag(tags, "cliffs"),
    windswept: hasTag(tags, "reference/windswept"),
    plateau: hasTag(tags, "is_plateau"),
    oldGrowth: hasTag(tags, "is_old_growth"),
    mystical: hasTag(tags, "mystical"),
    volcanic: hasTag(tags, "volcanic"),
    skylands: hasTag(tags, "skylands"),
    wasteland: hasAny(tags, ["is_wasteland", "is_dead"]),
    shrublands: hasTag(tags, "shrublands"),
    oases: hasTag(tags, "oases"),
    rare: hasAny(tags, ["rare_island", "skylands"]),
    birch: hasTag(tags, "is_birch_forest"),
    cherry: hasTag(tags, "is_cherry_grove") || /cherry/.test(b.id || ""),
    pale: /pale/.test(b.id || ""),
  };
  let h = 3, amp = 9;
  if (f.deepOcean) { h = -26; amp = 6; }
  else if (f.ocean) { h = -14; amp = 7; }
  else if (f.river) { h = -7; amp = 3; }
  else if (f.beach) { h = 0; amp = 2; }
  else {
    if (f.peak) { h = 44; amp = 26; }
    else if (f.slope) { h = 20; amp = 22; }
    else if (f.mountain) { h = 16; amp = 20; }
    else if (f.highlands) { h = 11; amp = 15; }
    else if (f.cliffs) { h = 8; amp = 17; }
    else if (f.windswept) { h = 7; amp = 14; }
    if (f.plateau) { h = 14; amp = 4; }
    if (f.badlands) { h = 9; amp = 13; }
    if (f.skylands) { h = 34; amp = 24; }
    if (f.mushroom) { h = 5; amp = 8; }
    if (f.desert) { h = 5; amp = 9; }
    if (f.swamp) { h = 0; amp = 3; }
    if (f.oases) { h = 2; amp = 4; }
  }
  let weird = 0;
  if (hasAny(tags, ["highlands", "cliffs", "reference/windswept", "is_plateau", "shrublands", "is_stony_shores", "oases", "is_floral", "is_flower_forest", "is_old_growth"])) weird = 0.4;
  if (hasAny(tags, ["mystical", "volcanic", "is_dead", "is_mushroom", "is_wasteland", "skylands"])) weird = 0.8;
  let rarity = 0;
  if (f.rare) rarity += 0.35;
  if (hasAny(tags, ["mystical", "volcanic", "is_mushroom", "is_dead", "is_wasteland"])) rarity += 0.25;

  let cat = "lowland";
  if (f.river) cat = "river";
  else if (f.ocean) cat = "ocean";
  else if (f.peak) cat = "peak";
  else if (f.slope || f.mountain) cat = "mountain";
  else if (f.highlands || f.cliffs || f.plateau || f.skylands) cat = "highland";

  let top = "grass_block", filler = "dirt";
  if (f.snowy) { top = "grass_block"; filler = "dirt"; }
  else if (f.desert) { top = "sand"; filler = "sandstone"; }
  else if (f.badlands) { top = "red_sand"; filler = "red_sandstone"; }
  else if (f.mushroom) { top = "mycelium"; filler = "dirt"; }
  else if (f.dead || f.wasteland) { top = "coarse_dirt"; filler = "dirt"; }
  else if (f.volcanic) { top = "basalt"; filler = "blackstone"; }
  if (f.stony && !f.beach) { top = "stone"; filler = "stone"; }
  if (f.swamp) { filler = "mud"; top = "grass_block"; }

  const tn = clamp((b.temperature + 0.5) / 2.5, 0, 1);
  const hn = clamp((b.downfall + 0.5) / 1.7, 0, 1);

  return Object.assign({}, b, { f, cat, h, amp, weird, rarity, top, filler, tn, hn });
}

/* ---------------- generator ---------------- */

class VoxelGen {
  constructor(seed, biomesRaw, pal) {
    this.seed = seed >>> 0;
    this.pal = pal;
    this.perlin = new Perlin(seed);
    this.perlin2 = new Perlin(seed ^ 0x9e3779b9);
    this.perlin3 = new Perlin(seed ^ 0x85ebca6b);
    this.biomes = biomesRaw.map(classifyBiome);
    this.biomes.forEach((b, i) => { b.idx = i; b.var = hashFloat(i * 131 + 17, 7, this.seed); });
    this.ocean = this.biomes.filter((b) => b.f.ocean);
    this.byCat = { ocean: [], river: [], peak: [], mountain: [], highland: [], lowland: [] };
    for (const b of this.biomes) {
      if (b.f.skylands || b.f.rare) continue;
      const list = this.byCat[b.cat] || this.byCat.lowland;
      list.push(b);
    }
    this.shoreList = this.byCat.lowland.concat(this.byCat.highland);
    this._h = -1;
    this.beachCache = new Map();
    this.riverCache = new Map();
    this.cache = new Map();
    const P = pal;
    this.AIR = 0;
    this.STONE = P.stone;
    this.DEEPSLATE = P.deepslate;
    this.WATER = P.water;
    this.BEDROCK = P.bedrock;
  }

  climateAt(x, z) {
    const key = (x >> 2) * 1048576 + (z >> 2);
    let c = this.cache.get(key);
    if (c) return c;
    const cx = (x >> 2) << 2, cz = (z >> 2) << 2;
    const cont = clamp(this.perlin.fbm2(cx * 0.00082 + 11.3, cz * 0.00082 - 4.7, 3) * 2.25, -1, 1);
    const ero = clamp(Math.abs(this.perlin2.fbm2(cx * 0.0013 + 200.5, cz * 0.0013 - 88.2, 3)) * 3.4, 0, 1);
    const T = clamp(0.58 + this.perlin3.fbm2(cx * 0.00062 - 5.5, cz * 0.00062 + 3.3, 2) * 1.55, 0.02, 1);
    const H = clamp(0.55 + this.perlin2.fbm2(cx * 0.0017 + 51.2, cz * 0.0017 + 17.9, 3) * 1.35, 0.02, 1);
    const W = clamp(this.perlin.fbm2(cx * 0.0029 - 31.7, cz * 0.0029 + 77.1, 2) * 0.9 + 0.5, 0, 1);
    const riv = Math.abs(this.perlin3.fbm2(cx * 0.0025 + 9.1, cz * 0.0025 - 2.3, 2));
    const V = clamp(this.perlin.fbm2(cx * 0.0055 + 300.7, cz * 0.0055 - 120.4, 2) * 1.1 + 0.5, 0, 1);
    c = { cont, ero, T, H, W, riv, V };
    if (this.cache.size > 32768) this.cache.clear();
    this.cache.set(key, c);
    return c;
  }

  terrainAt(x, z) {
    const gx = x >> 2, gz = z >> 2;
    const fx = (x - (gx << 2)) / 4, fz = (z - (gz << 2)) / 4;
    const c00 = this.climateAt(gx << 2, gz << 2);
    const c10 = this.climateAt((gx + 1) << 2, gz << 2);
    const c01 = this.climateAt(gx << 2, (gz + 1) << 2);
    const c11 = this.climateAt((gx + 1) << 2, (gz + 1) << 2);
    const L = (a, b, t) => a + (b - a) * t;
    const s = (f) => L(L(f(c00), f(c10), fx), L(f(c01), f(c11), fx), fz);
    return {
      cont: s((c) => c.cont), ero: s((c) => c.ero), T: s((c) => c.T),
      H: s((c) => c.H), W: s((c) => c.W), riv: s((c) => c.riv), V: s((c) => c.V),
    };
  }

  heightAt(x, z) {
    const t = this.terrainAt(x, z);
    const land = smoothstep(-0.50, -0.14, t.cont);
    const shelf = smoothstep(-0.90, -0.35, t.cont);
    const oceanH = -46 + 36 * shelf;
    const inlandH = 4 + Math.max(0, t.cont) * 12;
    const rugged = 1 - t.ero;
    const rn = this.perlin2.ridged2(x * 0.0021 + 40.2, z * 0.0021 + 12.4, 4);
    const ridge = clamp(rn, 0, 1);
    const mtn = land * land * Math.pow(ridge, 2.1) * (6 + 38 * rugged);
    const roll = land * this.perlin.fbm2(x * 0.0043 + 7.7, z * 0.0043 - 2.2, 3) * (2.4 + 8.0 * rugged);
    const det = land * this.perlin3.fbm2(x * 0.021, z * 0.021, 2) * (0.9 + 1.5 * rugged);
    let y = SEA + (oceanH + (inlandH - oceanH) * land) + mtn + roll + det;
    const riverAmt = smoothstep(0.020, 0.003, t.riv) * land * (1 - t.ero * 0.45);
    if (riverAmt > 0.001) y = y + (Math.min(y, SEA - 1) - y) * riverAmt;
    const hi = clamp(Math.round(y), 4, WORLD_H - 6);
    this._h = hi;
    return hi;
  }

  pickBiome(list, T, H, W, V) {
    if (!list.length) list = this.byCat.lowland;
    let best = list[0], bd = 1e9;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const d = Math.abs(T - b.tn) * 1.5 + Math.abs(H - b.hn) * 1.1 +
        Math.abs(W - b.weird) * 0.7 + Math.abs(V - b.var) * 0.9 + b.rarity;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  shoreVariant(kind, T, H, W, V) {
    const map = kind === "beach" ? this.beachCache : this.riverCache;
    const cold = T < 0.34;
    const land = this.pickBiome(this.shoreList, T, H, W, V);
    const key = kind + "|" + land.idx + "|" + (cold ? 1 : 0);
    let v = map.get(key);
    if (v) return v;
    v = Object.assign({}, land, {
      cat: kind, top: cold ? "gravel" : "sand", filler: cold ? "gravel" : "sand", noTrees: true,
      f: Object.assign({}, land.f, {
        beach: kind === "beach", river: kind === "river", ocean: false, snowy: cold,
        forest: false, jungle: false, taiga: false, savanna: false, mountain: false, peak: false,
        slope: false, highlands: false, cliffs: false, plateau: false, swamp: false, desert: false,
        badlands: false, skylands: false, mushroom: false, floral: false, dead: false, stony: false,
      }),
    });
    map.set(key, v);
    return v;
  }

  biomeAt(x, z, h) {
    if (h === undefined || this._h !== h) h = this.heightAt(x, z);
    const t = this.terrainAt(x, z);
    const T = t.T, H = t.H, W = t.W, V = t.V;
    let list;
    if (h <= SEA - 22) list = this.byCat.ocean;
    else if (h < SEA - 2) list = this.byCat.ocean.length ? this.byCat.ocean : this.byCat.lowland;
    else if (h <= SEA + 2 && t.riv < 0.024) return this.shoreVariant("river", T, H, W, V);
    else if (h <= SEA + 3) return this.shoreVariant("beach", T, H, W, V);
    else if (h >= SEA + 40) list = this.byCat.peak.length ? this.byCat.peak : this.byCat.mountain;
    else if (h >= SEA + 21) list = this.byCat.mountain.length ? this.byCat.mountain : this.byCat.highland;
    else if (h >= SEA + 11) list = this.byCat.highland.length ? this.byCat.highland : this.byCat.lowland;
    else list = this.byCat.lowland;
    return this.pickBiome(list, T, H, W, V);
  }

  caveAt(x, y, z) {
    if (y < 3 || y > 96) return false;
    const n = this.perlin3.noise3(x * 0.018, y * 0.028, z * 0.018);
    if (n > 0.075 || n < -0.075) return false;
    const n2 = this.perlin.noise3(x * 0.035 + 5, y * 0.05, z * 0.035 - 3);
    return n2 > -0.32 && n2 < 0.32;
  }

  // surface material ids for a column (top block at h included)
  surfaceAt(x, z) {
    const h = this.heightAt(x, z);
    const b = this.biomeAt(x, z, h);
    const P = this.pal;
    let terr;
    if (b.f.badlands) {
      const bandPerl = this.perlin.noise2(x * 0.08, z * 0.08);
      const band = (((h + Math.round(bandPerl * 3)) % 7) + 7) % 7;
      terr = [P.decor_terracotta, P.orange_terracotta, P.white_terracotta, P.red_terracotta,
        P.yellow_terracotta, P.brown_terracotta, P.light_gray_terracotta][band];
    } else {
      terr = P[b.top] !== undefined ? P[b.top] : P.grass_block;
    }
    const fill = P[b.filler] !== undefined ? P[b.filler] : P.dirt;
    const S = { h, b, terr, fill };
    S.topSolid = this.columnState(x, h, z, S);
    return S;
  }

  // solid part of one column voxel (bedrock → surface → water/ice); 0 = air
  columnState(x, y, z, S) {
    const P = this.pal;
    const h = S.h, b = S.b;
    if (y === 0) return P.bedrock;
    if (y < h - 2) {
      let blk = y < 40 ? this.DEEPSLATE : this.STONE;
      if (this.caveAt(x, y, z)) return 0;
      if (y < 96 && (blk === this.STONE || blk === this.DEEPSLATE)) {
        const deep = y < 40;
        const hv = hashFloat(x * 31 + y * 7, z * 17 - y * 3, this.seed);
        const hv2 = hashFloat(x * 13 - y * 5, z * 29 + y * 11, this.seed ^ 0x5555);
        if (y < 16 && hv < 0.0016) blk = deep ? P.deepslate_diamond_ore : P.diamond_ore;
        else if (y < 34 && hv < 0.0032) blk = deep ? P.deepslate_gold_ore : P.gold_ore;
        else if (y < 30 && hv2 < 0.004) blk = deep ? P.deepslate_redstone_ore : P.redstone_ore;
        else if (y < 40 && hv2 < 0.0035) blk = deep ? P.deepslate_lapis_ore : P.lapis_ore;
        else if (y < 52 && hv < 0.005) blk = deep ? P.deepslate_iron_ore : P.iron_ore;
        else if (y < 72 && hv < 0.006) blk = deep ? P.deepslate_copper_ore : P.copper_ore;
        else if (y < 96 && hv2 < 0.008) blk = deep ? P.deepslate_coal_ore : P.coal_ore;
      }
      return blk;
    }
    if (y <= h) {
      if (y === h) {
        if (b.f.ocean) return b.f.deepOcean ? P.gravel : P.sand;
        return S.terr;
      }
      if (b.f.ocean) return P.sand;
      if (b.f.badlands) {
        const bandPerl = this.perlin.noise2(x * 0.08, z * 0.08);
        const band = (((y + Math.round(bandPerl * 3)) % 7) + 7) % 7;
        return [P.decor_terracotta, P.orange_terracotta, P.white_terracotta, P.red_terracotta,
          P.yellow_terracotta, P.brown_terracotta, P.light_gray_terracotta][band];
      }
      return S.fill;
    }
    if (h < SEA && y <= SEA) {
      if (y === SEA && b.f.snowy) return P.ice;
      return this.WATER;
    }
    return 0;
  }

  // ---- trees: pure placement list for a root, shared by chunk fill and
  // ---- single-voxel queries so both always agree.
  // Root candidates sit on multiples of 4 (see generate()); the list holds
  // [dx,dy,dz,pal,soft] relative to (bx, h, bz).
  treeAt(bx, bz) {
    const h = this.heightAt(bx, bz);
    const b = this.biomeAt(bx, bz, h);
    if (b.f.ocean || b.f.river || b.noTrees) return null;
    const r = hashFloat(bx, bz, this.seed ^ 0xbeef);
    const f = b.f;
    let chance = 0, type = null;
    if (f.forest) { chance = f.jungle ? 0.75 : 0.5; type = f.snowy ? "conifer" : (f.jungle ? "jungle" : (f.birch ? "birch" : "oak")); }
    if (f.taiga) { chance = 0.5; type = "conifer"; }
    if (f.jungle) { chance = 0.75; type = "jungle"; }
    if (f.savanna) { chance = 0.18; type = "acacia"; }
    if (f.swamp) { chance = 0.4; type = "swamp"; }
    if (f.desert || f.badlands) { chance = 0.05; type = "cactus"; }
    if (f.mushroom) { chance = 0.08; type = "mushroom"; }
    if (f.plains) chance = f.floral ? 0.05 : 0.03;
    if (f.birch) { type = "birch"; chance = Math.max(chance, 0.4); }
    if (f.cherry) { type = "cherry"; chance = Math.max(chance, 0.45); }
    if (f.pale) { type = "pale"; chance = Math.max(chance, 0.45); }
    if (f.highlands || f.slope || f.peak) chance = Math.max(chance, 0.22);
    if (f.mystical) chance = Math.max(chance, 0.18);
    if (f.oldGrowth) chance += 0.2;
    if (!(type && r < chance)) return null;
    const jx = Math.floor(hashFloat(bx, bz, this.seed ^ 0xa1) * 5) - 2;
    const jz = Math.floor(hashFloat(bx, bz, this.seed ^ 0xb2) * 5) - 2;
    const rr = hashFloat(bx, bz, this.seed ^ 0xc3);
    return this.treeBlocks(type, rr, jx, jz);
  }

  treeBlocks(type, r, jx, jz) {
    const P = this.pal;
    const list = [];
    const put = (dx, dy, dz, blk, soft) => { list.push([dx, dy, dz, blk, soft]); };
    const blob = (cx0, cy0, cz0, rad, leaf) => {
      for (let dy = -rad; dy <= rad; dy++) for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
        const d = dx * dx + dy * dy * 1.5 + dz * dz;
        if (d > rad * rad + rad) continue;
        if (dx === 0 && dz === 0 && dy <= 0) continue;
        if (rad > 1 && d > rad * rad * 0.5 && ((dx + dy + dz) & 1)) continue;
        put(cx0 + dx, cy0 + dy, cz0 + dz, leaf, true);
      }
    };
    if (type === "cactus") {
      const hh = 2 + Math.floor(r * 3);
      for (let i = 0; i < hh; i++) put(jx, 1 + i, jz, P.decor_cactus_side, false);
      return { list };
    }
    if (type === "mushroom") {
      const hh = 3 + Math.floor(r * 3);
      for (let i = 0; i < hh; i++) put(jx, 1 + i, jz, P.decor_mushroom_stem, false);
      blob(jx, hh, jz, 2, r < 0.5 ? P.decor_red_mushroom_block : P.decor_brown_mushroom_block);
      return { list };
    }
    let trunk = 4 + Math.floor(r * 3), leaf = P.oak_leaves, log = P.oak_log, rad = 2;
    if (type === "birch") { leaf = P.birch_leaves; log = P.birch_log; trunk = 5 + Math.floor(r * 2); }
    else if (type === "conifer") { leaf = P.spruce_leaves; log = P.spruce_log; trunk = 6 + Math.floor(r * 4); }
    else if (type === "jungle") { leaf = P.jungle_leaves; log = P.jungle_log; trunk = 8 + Math.floor(r * 6); rad = 3; }
    else if (type === "acacia") { leaf = P.acacia_leaves; log = P.acacia_log; trunk = 4 + Math.floor(r * 2); rad = 3; }
    else if (type === "swamp") { trunk = 4 + Math.floor(r * 2); }
    else if (type === "cherry") { leaf = P.cherry_leaves; log = P.cherry_log; trunk = 5 + Math.floor(r * 2); }
    else if (type === "pale") { leaf = P.pale_oak_leaves; log = P.pale_oak_log; trunk = 6 + Math.floor(r * 3); }
    if (type === "conifer") {
      for (let i = 0; i < trunk; i++) put(jx, 1 + i, jz, log, false);
      let rr2 = 2.3;
      for (let i = trunk; i > 1; i--) {
        const lr = Math.max(1, Math.round(rr2));
        for (let dz = -lr; dz <= lr; dz++) for (let dx = -lr; dx <= lr; dx++) {
          if (dx * dx + dz * dz > lr * lr + 1) continue;
          put(jx + dx, i, jz + dz, leaf, true);
        }
        rr2 -= 0.3;
      }
      put(jx, trunk + 1, jz, leaf, true);
    } else if (type === "acacia") {
      for (let i = 0; i < trunk; i++) put(jx, 1 + i, jz, log, false);
      put(jx, trunk, jz + 1, log, false);
      put(jx, trunk - 1, jz + 2, log, false);
      blob(jx, trunk + 1, jz - 1, rad, leaf);
      blob(jx + 2, trunk, jz + 1, rad - 1, leaf);
    } else {
      for (let i = 0; i < trunk; i++) put(jx, 1 + i, jz, log, false);
      blob(jx, trunk, jz, rad, leaf);
      if (type === "jungle") blob(jx, trunk - 1, jz, rad, leaf);
    }
    return { list };
  }

  // decoration occupying one voxel: underwater flora, tree parts from roots
  // near this column (roots sit on multiples of 4; ±8 scan covers max jitter
  // 2 + canopy reach 6), and ground cover. `col` is the column's own state
  // (water counts as empty for soft leaves). 0 = nothing.
  decorState(x, y, z, S, col) {
    const P = this.pal;
    const h = S.h, b = S.b, f = b.f;
    if (h < SEA) {
      if (y < h + 1 || y > SEA) return 0;
      const bed = h + 1;
      const plant = hashFloat(x * 3, z * 5, this.seed ^ 0x77);
      if (y === bed && plant < 0.16 && !b.f.deepOcean) return P.seagrass;
      if (plant >= 0.16 && plant < 0.22) {
        const tall = 2 + Math.floor(hashFloat(x * 7, z * 11, this.seed ^ 0x99) * 6);
        const top = Math.min(SEA - 1, bed + tall);
        if (y >= bed && y <= top) return y === top ? P.kelp : P.kelp_plant;
        return 0;
      }
      if (y === SEA && (f.swamp || f.river) && hashFloat(x * 13, z * 17, this.seed ^ 0xab) < 0.22) return P.lily_pad;
      return 0;
    }
    if (y > h) {
      const x0 = Math.ceil((x - 8) / 4) * 4;
      const z0 = Math.ceil((z - 8) / 4) * 4;
      for (let rx = x0; rx <= x + 8; rx += 4) {
        for (let rz = z0; rz <= z + 8; rz += 4) {
          const t = this.treeAt(rx, rz);
          if (!t) continue;
          const rh = this.heightAt(rx, rz);
          for (const [dx, dy, dz, blk, soft] of t.list) {
            if (rx + dx === x && rh + dy === y && rz + dz === z) {
              if (!soft) return blk;
              if (col === 0 || col === this.WATER) return blk;
            }
          }
        }
      }
      if (y !== h + 1) return 0;
    }
    if (y === h + 1 && col === 0) {
      const r = hashFloat(x, z, this.seed ^ 0x5151);
      if (f.snowy && S.topSolid === P.grass_block) return P.snow;
      let p = 0;
      if (S.topSolid === P.grass_block || S.topSolid === P.mycelium || S.topSolid === P.moss_block) {
        if (r < 0.34) p = P.short_grass;
        else if (r < 0.40) p = P.tall_grass;
        else if (r < 0.43) p = P.fern;
        else if (r < 0.48 && (f.floral || f.forest)) {
          p = [P.dandelion, P.poppy, P.blue_orchid, P.allium, P.azure_bluet, P.red_tulip,
            P.orange_tulip, P.white_tulip, P.pink_tulip, P.oxeye_daisy, P.cornflower,
            P.lily_of_the_valley][Math.floor(hashFloat(x, z, this.seed) * 12) % 12];
        }
        else if (r < 0.50 && f.mushroom) p = hashFloat(x, z, this.seed ^ 1) < 0.5 ? P.red_mushroom : P.brown_mushroom;
        else if (r < 0.52 && (f.swamp || f.oldGrowth)) p = P.brown_mushroom;
        else if (r < 0.54 && f.jungle) p = P.large_fern;
        else if (r < 0.56 && f.taiga) p = P.fern;
        else if (r < 0.58 && f.mystical) p = P.flowering_azalea_leaves;
        else if (r < 0.59 && f.oases) p = P.sugar_cane;
      } else if (S.topSolid === P.coarse_dirt || S.topSolid === P.decor_terracotta) {
        if (r < 0.14) p = hashFloat(x, z, this.seed ^ 3) < 0.5 ? P.dead_bush : P.short_dry_grass;
      } else if (S.topSolid === P.sand || S.topSolid === P.red_sand) {
        if (r < 0.02) p = hashFloat(x, z, this.seed ^ 5) < 0.6 ? P.dead_bush : P.short_dry_grass;
        else if (r < 0.025 && (f.beach || f.desert)) p = P.sugar_cane;
      }
      if (p) return p;
    }
    return 0;
  }

  // sugar-cane stalk base condition (interior columns by water). Cane is a
  // hard overwrite placed after cover, like the original's cane loop.
  caneAt(x, z, S) {
    const P = this.pal;
    const lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
    if (lx < 1 || lx > 14 || lz < 1 || lz > 14) return 0;
    if (S.h < SEA) return 0;
    const top = S.topSolid;
    if (top !== P.grass_block && top !== P.sand && top !== P.mud) return 0;
    // cover must be empty here (the cane loop skips occupied columns)
    if (this.decorState(x, S.h + 1, z, S, 0) !== 0) return 0;
    const h = S.h;
    const w1 = this.columnState(x + 1, h, z, this.surfaceAt(x + 1, z));
    const w2 = this.columnState(x - 1, h, z, this.surfaceAt(x - 1, z));
    const w3 = this.columnState(x, h, z + 1, this.surfaceAt(x, z + 1));
    const w4 = this.columnState(x, h, z - 1, this.surfaceAt(x, z - 1));
    if (w1 !== this.WATER && w2 !== this.WATER && w3 !== this.WATER && w4 !== this.WATER) return 0;
    const r = hashFloat(x, z, this.seed ^ 0x9999);
    if (r < 0.20) return 1 + Math.floor(r * 15);
    return 0;
  }

  // full chunk fill through caller callbacks (world coords):
  //   api.get(x,y,z) -> current state id; api.set(x,y,z,state) -> write.
  // Mirrors voxel-craft's generate(): columns, then trees, then cover, then
  // cane. Tree writes clip strictly to the chunk (roots are evaluated
  // redundantly by neighbouring chunks, so nothing is lost).
  generate(cx, cz, api) {
    const P = this.pal;
    const ox = cx * CHUNK, oz = cz * CHUNK;
    const surf = new Map();
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx, z = oz + lz;
        const S = this.surfaceAt(x, z);
        surf.set(lx + "," + lz, S);
        const top = Math.max(S.h, SEA);
        for (let y = 0; y <= top; y++) {
          const want = this.columnState(x, y, z, S);
          if (want === 0) continue;
          if (api.get(x, y, z) !== 0) continue;
          api.set(x, y, z, want);
        }
      }
    }
    for (let gz = -1; gz <= 4; gz++) {
      for (let gx = -1; gx <= 4; gx++) {
        const hx = ox + gx * 4, hz = oz + gz * 4;
        const t = this.treeAt(hx, hz);
        if (!t) continue;
        const hy = this.heightAt(hx, hz);
        for (const [dx, dy, dz, blk, soft] of t.list) {
          const px = hx + dx, py = hy + dy, pz = hz + dz;
          const lx = px - ox, lz = pz - oz;
          if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || py < 0 || py >= 256) continue;
          if (soft) {
            const cur = api.get(px, py, pz);
            if (cur !== 0 && cur !== this.WATER) continue;
          }
          api.set(px, py, pz, blk);
        }
      }
    }
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const x = ox + lx, z = oz + lz;
        const S = surf.get(lx + "," + lz);
        if (api.get(x, S.h + 1, z) !== 0) continue;
        const d = this.decorState(x, S.h + 1, z, S, 0);
        if (d) api.set(x, S.h + 1, z, d);
        else if (S.b.f.snowy && S.topSolid === P.grass_block &&
            hashFloat(x, z, this.seed ^ 0x5151) < 0.06 && api.get(x, S.h + 2, z) === 0) {
          api.set(x, S.h + 2, z, P.short_grass);
        }
      }
    }
    for (let lz = 1; lz < CHUNK - 1; lz++) {
      for (let lx = 1; lx < CHUNK - 1; lx++) {
        const x = ox + lx, z = oz + lz;
        const S = surf.get(lx + "," + lz);
        if (api.get(x, S.h + 1, z) !== 0) continue;
        const n = this.caneAt(x, z, S);
        if (n > 0) {
          for (let i = 0; i < n; i++) api.set(x, S.h + 1 + i, z, P.sugar_cane);
        }
      }
    }
  }

  // single-voxel query: what the generator wants at (x,y,z). Used for
  // pruning saved overrides and the test API. Agrees with generate().
  voxelStateAt(x, y, z) {
    const P = this.pal;
    if (y < 0 || y > 255) return 0;
    const S = this.surfaceAt(x, z);
    const h = S.h;
    const col = this.columnState(x, y, z, S);
    if (h < SEA) {
      if (y <= h) return col;
      if (y > SEA) return 0;
      const d = this.decorState(x, y, z, S, col);
      return d || col;
    }
    if (y <= h) return col;
    if (y === h + 1) {
      if (col !== 0) return col;
      const d = this.decorState(x, y, z, S, 0);
      if (d) return d;
      const n = this.caneAt(x, z, S);
      if (n > 0) return P.sugar_cane;
      return 0;
    }
    const d = this.decorState(x, y, z, S, 0);
    if (d) return d;
    if (y === h + 2 && S.b.f.snowy && S.topSolid === P.grass_block &&
        hashFloat(x, z, this.seed ^ 0x5151) < 0.06) return P.short_grass;
    const n = this.caneAt(x, z, S);
    if (n > 0 && y <= h + n) return P.sugar_cane;
    return 0;
  }
}

globalThis.__voxelGen = {
  SEA,
  WORLD_H,
  normalizeBiomes,
  create(seed, biomesRaw, pal) { return new VoxelGen(seed, biomesRaw, pal); },
};

})();
