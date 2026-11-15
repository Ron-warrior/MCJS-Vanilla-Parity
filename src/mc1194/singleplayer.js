/* MinecraftJS singleplayer for the 1.18.2 engine (src/mc1194/).
 *
 * Port of src/mc1152/singleplayer.js onto the 1.18.2 client modules:
 * world menu (engine-rendered Screens), seeded terrain (hills/tectonic/flat/
 * void/voxel-Terralith/Skyblock-island), chunk streaming, localStorage saves
 * (1194 namespaced keys; the 1152 line keeps its own store), creative
 * placement fixes, offline chat commands, void rescue.
 *
 * ID strategy: resolveIds()/resolveVoxelPal() read names from the live
 * 1.18.2 tables, so genState() emits NATIVE 1.18.2 states directly. Old
 * saves do NOT load here (state ids differ; overrides would misrender) —
 * the frozen 1152 line owns those worlds.
 * The engine API surface used here (world.loadChunk/setState/beginBatch/
 * endBatch, entities.*, inventory.main, screens, hud.addChat, input.lock,
 * interaction._predictPlace/_onItemUse/_placementPos, ChatScreen) was
 * audited against client/js and matches; differences are noted inline.
 */

// 1.18.2 vertical range (same values as js/world/dims.js; imported so the
// two can never drift apart).
import { MIN_Y, MAX_Y, inY } from "./js/world/dims.js";
// Tectonic worldgen (P3): router heights + climate for type === "tectonic".
// Facade caches per-seed router state and per-chunk height lattices; all
// calls here are pure of (x, z, seed) so generation stays save-pruning-safe.
import { tectonicChunk, tectonicClimate, tectonicClimateLite, tectonicState } from "./js/world/tectonic.js";
// Upgrade safety net (2.0.0 prep): asserts the sim-vs-wire registry tables
// still agree after any table swap. Warn-only, runs once at boot.
import { runRegistryCheck } from "./js/registry-check.js";

/* ---------------------------------------------------------------- utils */

function clamp(v, a, b) { return v < a ? v : v > b ? b : v; }

function seedFromString(str) {
  str = String(str == null ? "" : str).trim();
  if (str === "") return (Math.random() * 0xFFFFFFFF) >>> 0;
  if (/^-?\d+$/.test(str)) return (parseInt(str, 10) >>> 0) || 1;
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 974634211);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 2246822519) +
          Math.imul(z | 0, 3266489917) + Math.imul(seed | 0, 974634211);
  h = Math.imul(h ^ (h >>> 15), 2654435761);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, z, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  const u = smooth(xf), v = smooth(zf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z, seed, octaves) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, (seed + i * 1013904223) | 0);
    norm += amp;
    amp *= 0.5; freq *= 2.03;
  }
  return sum / norm;
}

/* ---------------------------------------------------------- storage */

// 1194 namespaced keys (1.18.2 states/items). Separate store from the frozen
// 1152 line: old saves stay loadable there and never leak ids across.
const LS_INDEX = "mcjs.sp1194.v1.index";
const LS_WORLD = (id) => "mcjs.sp1194.v1.world." + id;
const LS_INDEX_V2 = "mcjs.sp.v2.index";
const LS_WORLD_V2 = (id) => "mcjs.sp.v2.world." + id;
let memFallback = { index: null, worlds: {} };
let storageOK = true;

function lsGet(k) {
  try { return localStorage.getItem(k); }
  catch (e) { storageOK = false; return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; }
  catch (e) { storageOK = false; return false; }
}
function lsDel(k) {
  try { localStorage.removeItem(k); } catch (e) { storageOK = false; }
}

function loadIndex() {
  if (memFallback.index) return memFallback.index;
  try {
    const raw = lsGet(LS_INDEX);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveIndex(arr) {
  memFallback.index = arr;
  try { lsSet(LS_INDEX, JSON.stringify(arr)); } catch (e) {}
}
function loadWorldRec(id) {
  if (memFallback.worlds[id]) return memFallback.worlds[id];
  try {
    const raw = lsGet(LS_WORLD(id));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveWorldRec(id, rec) {
  memFallback.worlds[id] = rec;
  try { return lsSet(LS_WORLD(id), JSON.stringify(rec)); }
  catch (e) { return false; }
}
function deleteWorldRec(id) {
  delete memFallback.worlds[id];
  try { lsDel(LS_WORLD(id)); } catch (e) {}
}
function newId() {
  return "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
// World-mode normalization (P4 mob-verification find): older saves and the
// Re-Create path can carry the mode as the UI strings "Survival"/"Creative"
// instead of the numeric 0/1 the engine uses. Anything survival-like maps to
// 0; everything else stays Creative (1), matching the previous default.
function normMode(m) {
  if (m === 0 || m === "0") return 0;
  if (typeof m === "string" && /^surv/i.test(m)) return 0;
  return 1;
}

// Migrate one v2 (1.13.2 ids) world record to v3 (native 1.18.2 ids).
function migrateV2Rec(rec) {
  if (!rec || !COMPAT) return rec;
  const out = Object.assign({}, rec);
  if (out.overrides) {
    const ov = {};
    for (const k of Object.keys(out.overrides)) {
      const old = out.overrides[k] | 0;
      ov[k] = (old >= 0 && old < COMPAT.states.length && COMPAT.states[old]) || 0;
    }
    out.overrides = ov;
  }
  if (out.inv && Array.isArray(out.inv.main)) {
    out.inv.main = out.inv.main.map((it) => {
      if (!it || !(it.id > 0)) return it;
      const nid = COMPAT.items[it.id];
      if (nid == null) return null;
      const c = Object.assign({}, it, { id: nid });
      return c;
    });
  }
  return out;
}

function migrateV2() {
  // One-shot: if v3 is empty but v2 worlds exist, import them converted.
  try {
    if (loadIndex().length) return;
    const raw = lsGet(LS_INDEX_V2);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return;
    const idx = [];
    for (const e of arr) {
      if (!e || !e.id) continue;
      let v2rec = null;
      try {
        const r = lsGet(LS_WORLD_V2(e.id));
        v2rec = r ? JSON.parse(r) : null;
      } catch (err) { v2rec = null; }
      const rec = migrateV2Rec(v2rec || {});
      rec.name = e.name || rec.name || "Migrated World";
      rec.seed = (e.seed != null ? e.seed : rec.seed) >>> 0;
      rec.type = e.type || rec.type || "hills";
      rec.mode = e.mode != null ? e.mode : (rec.mode != null ? rec.mode : 0);
      saveWorldRec(e.id, rec);
      idx.push({
        id: e.id, name: rec.name,
        seedStr: String(rec.seed >>> 0),
        type: rec.type, mode: rec.mode,
        created: e.created || Date.now(), modified: e.modified || Date.now(),
        shot: null,
      });
    }
    if (idx.length) {
      saveIndex(idx);
      try { game.hud.addChat("§aMigrated " + idx.length + " world(s) from 1.13.2"); } catch (e) {}
    }
  } catch (e) { console.warn("[singleplayer] v2 migrate failed", e); }
}

/* ---------------------------------------------------------- session */

const SP = {
  active: false,
  entering: false,
  id: null,
  seed: 0,
  type: "hills",
  dim: 0,               // 0 overworld, -1 nether, 1 end (mirrors game.dimension)
  generated: new Set(),   // "cx,cz" — overworld chunks
  genN: new Set(),        // "cx,cz" — nether chunks
  genE: new Set(),        // "cx,cz" — end chunks
  overrides: {},          // "x,y,z" -> 1.18.2 state (overworld diffs)
  nether: {},             // "x,y,z" -> 1.18.2 state (nether diffs)
  end: {},                // "x,y,z" -> 1.18.2 state (end diffs)
  links: [],              // portal pairs {ox,oy,oz,nx,ny,nz}
  portalCdUntil: 0,       // teleport cooldown (Date.now ms)
  clearEpoch: 0,          // bumped on every world.clear(); chunk sets reset
  epoch0: -1, epochN: -1, epochE: -1, // world state each dim's set was filled under
  dirty: false,
  gen: false,             // true while the generator itself writes blocks
  streamTimer: 0,
  saveTimer: 0,
  spawn: { x: 8.5, y: 80, z: 8.5 },
  safe: true,
  difficulty: 1,
  structures: true,
  cheats: false,
};

let game = null;          // globalThis.game, once booted
let IDS = null;           // resolved 1.18.2 default states
let COMPAT = null;        // data/compat.json (old-id maps, for migration)

async function loadCompat() {
  if (COMPAT) return COMPAT;
  try {
    const r = await fetch("src/mc1194/data/compat.json");
    if (r.ok) COMPAT = await r.json();
    try { globalThis.__mcCompat = COMPAT; } catch (e) {}
  } catch (e) { console.warn("[singleplayer] compat.json unavailable", e); }
  return COMPAT;
}

function resolveIds() {
  // Name-based: automatically yields NATIVE 1.15.2 default states.
  // ALIAS still needed (the plant "grass" exists, so "grass" must win as
  // grass_block; 1.15 renames rose_red etc. are handled by compat, not here).
  const ALIAS = {
    grass: "grass_block", log: "oak_log", leaves: "oak_leaves",
    tallgrass: "grass", yellow_flower: "dandelion", red_flower: "poppy",
    snow_layer: "snow",
  };
 const want = ["air", "stone", "grass", "dirt", "cobblestone", "bedrock", "sand",
   "log", "leaves", "water", "coal_ore", "iron_ore", "copper_ore", "gold_ore", "diamond_ore",
    "lapis_ore", "redstone_ore", "emerald_ore",
   "deepslate", "tuff", "deepslate_coal_ore", "deepslate_iron_ore", "deepslate_copper_ore",
    "deepslate_gold_ore", "deepslate_diamond_ore", "deepslate_lapis_ore", "deepslate_redstone_ore",
    "deepslate_emerald_ore",
    "smooth_basalt", "calcite", "amethyst_block", "budding_amethyst",
    "small_amethyst_bud", "medium_amethyst_bud", "large_amethyst_bud",
    "amethyst_cluster", "pointed_dripstone",
    "moss_block", "moss_carpet", "rooted_dirt", "spore_blossom",
    "sculk", "sculk_sensor", "sculk_shrieker", "sculk_catalyst", "sculk_vein",
    "pink_petals",
    "prismarine", "prismarine_bricks", "dark_prismarine", "sea_lantern",
    "sponge", "gold_block",
    "tallgrass", "yellow_flower", "red_flower", "snow_layer",
    "mud", "cherry_log", "cherry_leaves",
    "cornflower", "azure_bluet", "allium",
    "dark_oak_log", "dark_oak_planks",
    "oak_planks", "oak_log", "glass", "torch", "oak_fence", "farmland",
    "wheat", "gravel", "jungle_log", "jungle_leaves", "spruce_log",
    "spruce_leaves", "cactus", "dead_bush", "clay", "ice", "sugar_cane",
    "sandstone",
    "netherrack", "soul_sand", "glowstone", "nether_quartz_ore", "obsidian",
    "nether_portal", "lava", "fire", "magma_block",
    "soul_soil", "crimson_nylium", "warped_nylium",
    "crimson_wart_block", "warped_wart_block", "basalt", "blackstone",
    "nether_bricks", "nether_brick_fence", "nether_wart",
    "crimson_fungus", "warped_fungus",
    "end_stone", "end_portal", "end_portal_frame", "chorus_plant",
    "chorus_flower", "stone_bricks", "chest",
    "purpur_block", "purpur_pillar", "purpur_stairs", "purpur_slab",
    "end_stone_bricks", "end_rod", "end_gateway", "dragon_egg"];
  const byName = {};
  try {
    for (const b of game.assets.data.blocks) {
      if (b && typeof b.name === "string" && typeof b.defaultState === "number") byName[b.name] = b.defaultState;
    }
  } catch (e) {}
  const out = {};
  for (const k of want) {
    let v = null;
    for (const n of [ALIAS[k], k]) { if (n != null && byName[n] != null) { v = byName[n]; break; } }
    if (v == null) v = 0;
    out[k] = v;
  }
  for (const k of want) {
    if (ALIAS[k] && !(ALIAS[k] in out)) out[ALIAS[k]] = out[k];
  }
  return out;
}

/* ---------------------------------------------------------- voxel (Terralith) */

let VPAL = null;
let voxelBiomes = null;
let voxelBiomesLoading = null;
let VG = null, VGSeed = -1;

const VOXEL_WANT = ["stone", "deepslate", "dirt", "coarse_dirt", "grass_block",
  "sand", "red_sand", "sandstone", "red_sandstone", "gravel", "water", "bedrock",
  "snow", "ice", "mycelium", "moss_block", "decor_terracotta", "orange_terracotta",
  "white_terracotta", "red_terracotta", "yellow_terracotta", "brown_terracotta",
  "light_gray_terracotta", "basalt", "blackstone", "mud", "oak_log", "spruce_log",
  "birch_log", "jungle_log", "acacia_log", "oak_leaves", "spruce_leaves",
  "birch_leaves", "jungle_leaves", "acacia_leaves", "cherry_log", "cherry_leaves",
  "pale_oak_log", "pale_oak_leaves", "decor_cactus_side", "dead_bush",
  "short_grass", "tall_grass", "fern", "large_fern", "dandelion", "poppy",
  "blue_orchid", "allium", "azure_bluet", "red_tulip", "orange_tulip",
  "white_tulip", "pink_tulip", "oxeye_daisy", "cornflower", "lily_of_the_valley",
  "brown_mushroom", "red_mushroom", "decor_red_mushroom_block",
  "decor_brown_mushroom_block", "decor_mushroom_stem", "sugar_cane", "lily_pad",
  "seagrass", "kelp", "kelp_plant", "flowering_azalea_leaves", "short_dry_grass",
  "coal_ore", "iron_ore", "copper_ore", "gold_ore", "diamond_ore", "lapis_ore",
  "redstone_ore", "deepslate_coal_ore", "deepslate_iron_ore",
  "deepslate_copper_ore", "deepslate_gold_ore", "deepslate_diamond_ore",
  "deepslate_lapis_ore", "deepslate_redstone_ore"];

// Blocks missing from 1.15.2 fall back to the closest vanilla equivalent
// (resolved against the live block list at boot; 1.15 adds cornflower,
// lily_of_the_valley, walls etc. natively, so several old fallbacks now
// hit the real block).
const VOXEL_FALLBACKS = {
  deepslate: ["stone"],
  deepslate_coal_ore: ["coal_ore"], deepslate_iron_ore: ["iron_ore"],
  deepslate_copper_ore: ["stone"], deepslate_gold_ore: ["gold_ore"],
  deepslate_diamond_ore: ["diamond_ore"], deepslate_lapis_ore: ["lapis_ore"],
  deepslate_redstone_ore: ["redstone_ore"], copper_ore: ["stone"],
  mud: ["dirt"], basalt: ["stone"], blackstone: ["cobblestone"],
  moss_block: ["dirt"], short_grass: ["grass"],
  flowering_azalea_leaves: ["oak_leaves"], short_dry_grass: ["dead_bush", "grass"],
  decor_terracotta: ["terracotta"], decor_cactus_side: ["cactus"],
  decor_red_mushroom_block: ["red_mushroom_block"],
  decor_brown_mushroom_block: ["brown_mushroom_block"],
  decor_mushroom_stem: ["mushroom_stem"],
  cherry_log: ["oak_log"], cherry_leaves: ["oak_leaves"],
  pale_oak_log: ["oak_log"], pale_oak_leaves: ["oak_leaves"],
};
let voxelWarned = false;

function resolveVoxelPal() {
  if (VPAL) return VPAL;
  const byName = {};
  try {
    for (const b of game.assets.data.blocks) {
      if (b && typeof b.name === "string" && typeof b.defaultState === "number") byName[b.name] = b.defaultState;
    }
  } catch (e) {}
  const out = {};
  for (const n of VOXEL_WANT) {
    let v = null;
    const cands = [n].concat(VOXEL_FALLBACKS[n] || []);
    for (const c of cands) { if (byName[c] != null) { v = byName[c]; break; } }
    if (v == null) {
      v = 0;
      if (!voxelWarned) { voxelWarned = true; console.warn("[singleplayer] voxel block missing, using air:", n); }
    }
    out[n] = v;
  }
  VPAL = out;
  return out;
}

function ensureVoxelBiomes() {
  if (voxelBiomes) return Promise.resolve(voxelBiomes);
  if (!voxelBiomesLoading) {
    voxelBiomesLoading = fetch("src/mc1194/vc-biomes.json").then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then((rows) => (voxelBiomes = globalThis.__voxelGen.normalizeBiomes(rows)));
  }
  return voxelBiomesLoading;
}

function voxelGen(seed) {
  if (!voxelBiomes || !globalThis.__voxelGen) return null;
  if (!VG || VGSeed !== (seed >>> 0)) {
    VG = globalThis.__voxelGen.create(seed >>> 0, voxelBiomes, resolveVoxelPal());
    VGSeed = seed >>> 0;
  }
  return VG;
}

function isVoxel(type) { return (type || "hills") === "voxel"; }

/* ---------------------------------------------------------- terrain */

const SEA = 62;

function groundHeight(x, z, seed, type) {
  if (type === "tectonic") {
    // Tectonic router surface via the facade's 5x5-per-chunk lattice
    // (bilinear): 25 exact final_density scans per chunk, amortized over
    // its 256 columns. genCol/PCC/colInfo/spawn all route through here, so
    // every consumer sees identical heights. Engine sea is SEA (62);
    // vanilla/Tectonic use 63 — documented engine adaptation, shoreline
    // differs by one block (see colInfo tectonic branch).
    try {
      const tc = tectonicChunk(x >> 4, z >> 4, seed >>> 0);
      return tc.h[((z & 15) << 4) | (x & 15)];
    } catch (e) { return SEA + 1; }
  }
  if (type === "flat" || type === "void" || type === "oneblock") return 3;
  const c = fbm(x * 0.0045, z * 0.0045, seed, 4);
  const d = fbm(x * 0.021 + 913.7, z * 0.021 - 517.2, seed ^ 0x5f3759df, 3);
  let h = 60 + (c - 0.5) * 38 + (d - 0.5) * 9;
  return clamp(Math.floor(h), 38, 96);
}

// Biome ids: 0 plains, 1 desert, 2 jungle, 3 swamp, 4 ocean, 5 river,
// 6 beach, 7 snowy, 8 rock. One-entry column cache: fillChunk walks y
// innermost, so consecutive genState calls share (x,z) and skip the
// noise evals entirely.
let COL = { x: 1e9, z: 1e9, s: -1, t: "", h: 0, b: 0, c: 0, lp: 0 };
// Persistent-record probe for colInfo (no creation): pccRec memoizes every
// column it visits with its (h,b,c,lp), so second-pass consumers over the
// same columns (fillBiomes' 256-cell sweep, leaf-neighborhood sampling, map
// survey pixels) skip the climate re-evaluation entirely. Records are pure
// of (seed, type, spawn) — h/b/c/lp never depend on spawn (tree exclusion
// lives in tr, not here) — so the cached values are identical to a fresh
// evaluation. Returns the stored record or null.
function pccProbe(x, z, seed, type) {
  const P = PCC;
  const sp = (typeof SP !== "undefined" && SP && SP.spawn) || null;
  const sx = sp ? sp.x : 0, sz = sp ? sp.z : 0;
  if (P.s !== (seed >>> 0) || P.t !== type || P.sx !== sx || P.sz !== sz) return null;
  const r = pccGet(P.map, x, z);
  return r === undefined ? null : r;
}
function colInfo(x, z, seed, type) {
  if (COL.x === x && COL.z === z && COL.s === (seed >>> 0) && COL.t === type) return COL;
  const pr = pccProbe(x, z, seed, type);
  if (pr) {
    COL = { x, z, s: seed >>> 0, t: type, h: pr.h, b: pr.b, c: pr.c, lp: pr.lp };
    return COL;
  }
  let h = groundHeight(x, z, seed, type);
  let b = 0, c = 0;
  if (type === "hills") {
    const m = fbm(x * 0.006 + 311.7, z * 0.006 - 177.3, (seed ^ 0xB10E) | 0, 3);
    const t2 = fbm(x * 0.004 - 97.2, z * 0.004 + 531.9, (seed ^ 0x7E9A) | 0, 2);
    c = t2 < 0.32 ? 1 : 0;
    if (h < SEA - 1) b = 4;
    else if (h <= SEA + 1) b = 6;
    else if (c) b = 7;
    else if (m < 0.34 && t2 > 0.5) b = 1;
    else if (m > 0.62 && t2 > 0.55) b = 2;
    else if (m > 0.58 && h <= SEA + 4) b = 3;
    else if (h >= 82) b = 8;
    if ((b === 0 || b === 8) && h > SEA + 1 && h < SEA + 7) {
      const rv = fbm(x * 0.008 + 51.3, z * 0.008 - 403.1, (seed ^ 0x21C5) | 0, 2);
      if (Math.abs(rv - 0.5) < 0.015) { b = 5; h = SEA - 2; }
    }
  }
  if (type === "tectonic") {
    // Climate-driven biome mapping onto the shared 0..8 ids (so the hills
    // fill path, trees, cacti, snow/ice and biome tints all work unchanged).
    // Thresholds calibrated from the live climate survey (seed 1+7, 2304
    // columns each): temp p15~-0.4, p85~+0.3; veg p15~-0.3, p85~+0.3;
    // erosion stepped (clamped bands at -1/-0.5/-0.3). No rivers (no carve
    // pass yet), no lava pits, no villages/strongholds on tectonic (their
    // guards stay hills-only).
    try {
      const cl = tectonicClimateLite(x, z, seed >>> 0);
      c = cl.temperature < -0.35 ? 1 : 0;
      if (h < SEA - 1) b = 4;
      else if (h <= SEA + 2) b = 6;
      else if (c) b = 7;
      else if (cl.temperature > 0.3 && cl.vegetation < -0.15) b = 1;
      else if (cl.vegetation > 0.3 && cl.temperature > 0.1) b = 2;
      else if (cl.erosion > 0.0 && cl.temperature < 0.3 && h <= SEA + 5) b = 3;
      else if (h >= SEA + 33 && h < SEA + 53 && !c && Math.abs(groundHeight(x + 1, z, seed, type) - h) + Math.abs(groundHeight(x, z + 1, seed, type) - h) <= 1) b = 9;
      else if (h >= SEA + 53) b = 8;
      else b = 0;
    } catch (e) { b = 0; c = 0; }
  }
  // lava-pit roll, hoisted here (was recomputed per block): identical inputs.
  let lp = 0;
  if (type === "hills" && h > SEA + 1 && b !== 5 &&
      hash2(x, z, (seed ^ 0x1A9E) | 0) < 0.0015 &&
      !(SP.structures !== false && villageClearAt(x, z, seed, type))) lp = 1;
  COL = { x, z, s: seed >>> 0, t: type, h, b, c, lp };
  return COL;
}

const BIOME_NAMES = ["plains", "desert", "jungle", "swamp", "ocean", "river", "beach", "snow", "rock", "meadow"];
export { BIOME_NAMES };
function biomeAt(x, z, seed, type) {
  if (type !== "hills" && type !== "tectonic") return type === "voxel" ? "voxel" : type;
  return BIOME_NAMES[colInfo(x, z, seed, type).b] || "plains";
}

function treeAt(x, z, seed, type) {
  if (type !== "hills" && type !== "tectonic") return false;
  if (SP.structures === false) return false;
  if (villageClearAt(x, z, seed, type)) return false;
  const ci = colInfo(x, z, seed, type);
  const b = ci.b;
  if (b === 1 || b === 4 || b === 5 || b === 6) return false;
  // cherry groves (P4): meadow grows cherry trees, but only inside grove
  // patches (same gate as treeWood's wood-3 branch below).
  if (b === 9) return hash2(x, z, (seed ^ 0x62E0) | 0) < 0.35;
  if (mansionClearAt(x, z, seed, type)) return false;
  const h = ci.h;
  if (h <= SEA + 1) return false;
  const dx = x - SP.spawn.x, dz = z - SP.spawn.z;
  if (dx * dx + dz * dz < 36) return false;
  const dense = b === 2 ? 0.055 : b === 3 ? 0.008 : b === 7 ? 0.010 : 0.013;
  return hash2(x, z, (seed ^ 0x9e3779b9) | 0) < dense;
}

// 0 oak, 1 jungle, 2 spruce, 3 cherry — pure per column (biome-driven).
// Cherry only arises where treeAt's grove gate already passed (meadow
// groves), so a bare wood-3 here is always a real cherry tree.
function treeWood(x, z, seed, type) {
  const b = colInfo(x, z, seed, type).b;
  if (b === 9) return 3;
  return b === 2 ? 1 : b === 7 ? 2 : 0;
}

// desert cactus height (0 = none) — pure per column
function cactusAt(x, z, seed, type) {
  if ((type !== "hills" && type !== "tectonic") || SP.structures === false) return 0;
  if (colInfo(x, z, seed, type).b !== 1) return 0;
  if (villageClearAt(x, z, seed, type)) return 0;
  if (hash2(x, z, (seed ^ 0xCA071) | 0) >= 0.015) return 0;
  return 1 + Math.floor(hash2(x, z, (seed ^ 0xCAC72) | 0) * 3);
}

function trunkHeight(x, z, seed) {
  return 4 + Math.floor(hash2(x, z, (seed ^ 0x51ab3c) | 0) * 3);
}

// Persistent per-column memo (hills overworld): the y-walk hits the same
// (x,z) 128 times and leaf checks sample a 5x5 tree neighborhood per
// block; without this every sample recomputes full fbm columns (the
// 1-entry COL/V_LAST caches thrash on neighbor coords). Records are pure
// of (seed, type, spawn) and capped, so output is identical everywhere.
let PCC = { s: -1, t: "", sx: 0, sz: 0, map: new Map(), n: 0 };
// 2-level nested maps instead of "x,z" string keys: same records, no per-
// lookup string allocation. Eviction drops the oldest x-stripe (streaming
// moves on, so the dropped columns are the ones behind us).
function pccGet(map, x, z) {
  const mx = map.get(x);
  return mx === undefined ? undefined : mx.get(z);
}
function pccSet(map, x, z, r) {
  let mx = map.get(x);
  if (mx === undefined) { mx = new Map(); map.set(x, mx); }
  mx.set(z, r);
}
function pccEvict() {
  const fk = PCC.map.keys().next().value;
  if (fk === undefined) return;
  const stripe = PCC.map.get(fk);
  if (stripe) PCC.n -= stripe.size;
  PCC.map.delete(fk);
}
function pccRec(x, z, seed, type) {
  const sp = (typeof SP !== "undefined" && SP && SP.spawn) || null;
  const sx = sp ? sp.x : 0, sz = sp ? sp.z : 0;
  if (PCC.s !== (seed >>> 0) || PCC.t !== type || PCC.sx !== sx || PCC.sz !== sz) {
    PCC = { s: seed >>> 0, t: type, sx, sz, map: new Map(), n: 0 };
  }
  let r = pccGet(PCC.map, x, z);
  if (r !== undefined) return r;
  // Column identity, captured once: treeAt/treeWood/village checks below all
  // re-derive this same record through the COL 1-entry cache, and the stored
  // (h,b,c,lp) lets later colInfo calls for this column skip the climate
  // re-evaluation via pccProbe. h is the possibly-carved colInfo height
  // (river carve); gh stays the pure groundHeight (tuft rule needs it).
  const selfCi = colInfo(x, z, seed, type);
  let tr = null;
  if (treeAt(x, z, seed, type)) {
    tr = {
      th: trunkHeight(x, z, seed),
      wood: treeWood(x, z, seed, type),
      h: selfCi.h,
    };
  }
  let v = null, s = null, mo = null, mn = null, cu = 0;
  if (SP.structures !== false) {
    v = villageAt(x, z, seed, type);
    mo = mansionAt(x, z, seed, type);
    mn = monumentAt(x, z, seed, type);
    const S = strongholdAt(seed, type);
    if (S && Math.abs(x - S.x) <= 6 && Math.abs(z - S.z) <= 5) s = S;
    if (selfCi.b === 1 &&
        !villageClearAt(x, z, seed, type) &&
        hash2(x, z, (seed ^ 0xCA071) | 0) < 0.015) {
      cu = 1 + Math.floor(hash2(x, z, (seed ^ 0xCAC72) | 0) * 3);
    }
  }
  r = { tr, v, s, mo, mn, cu, gh: groundHeight(x, z, seed, type), h: selfCi.h, b: selfCi.b, c: selfCi.c, lp: selfCi.lp, tl: undefined };
  if (PCC.n > 8192) pccEvict();
  pccSet(PCC.map, x, z, r);
  PCC.n++;
  return r;
}
// One-entry column cache for the y-walk: consecutive genState calls share
// (x,z,seed,type), so the colInfo + pccRec lookups are paid once per
// column instead of once per block. Cross-column sampling (leaf lists)
// still goes through the persistent PCC map.
let GCOL = { x: 1e9, z: 1e9, s: -1, t: "", sx: 0, sz: 0, ci: null, PR: null, h: 0, B: 0 };
function genCol(x, z, seed, type) {
  const G = GCOL;
  const sp = (typeof SP !== "undefined" && SP && SP.spawn) || null;
  const sx = sp ? sp.x : 0, sz = sp ? sp.z : 0;
  if (G.x === x && G.z === z && G.s === (seed >>> 0) && G.t === type && G.sx === sx && G.sz === sz) return G;
  const ci = colInfo(x, z, seed, type);
  const PR = pccRec(x, z, seed, type);
  GCOL = { x, z, s: seed >>> 0, t: type, sx, sz, ci, PR, h: ci.h, B: ci.b };
  return GCOL;
}
// trunk list for one column in leaf-loop order (flat [rec, ox, oz] ...):
// same trunks, same order, same winner as the live 5x5 search — but the
// 25 cache lookups happen once per column, not once per block.
function pccTrunkList(x, z, seed, type) {
  const out = [];
  for (let ox = -2; ox <= 2; ox++) {
    for (let oz = -2; oz <= 2; oz++) {
      const r = pccRec(x + ox, z + oz, seed, type).tr;
      if (r) out.push(r, ox, oz);
    }
  }
  return out;
}

/* ---------------------------------------------------------- structures: villages (Phase A) */

// Deterministic structure framework: villages live on a jittered lattice
// (cell 384, jitter +-112, ~55% of cells), hills-type only, land only,
// kept clear of spawn. All layout derives from (seed, cell) so genState
// stays pure and save-pruning keeps working (village blocks regenerate;
// player edits to them persist as overrides).
const V_CELL = 384, V_RAD = 32;
// Exact numeric cell key (|cell| <= 2^20 — world coords far beyond use).
function cellKey(cx, cz) { return (cx + 1048576) * 2097152 + (cz + 1048576); }
let VCACHE = { seed: -1, type: "", map: new Map() };

function villageCenterOfCell(cx, cz, seed, type) {
  if (type !== "hills") return null;
  const vc = VCACHE;
  if (vc.seed !== (seed >>> 0) || vc.type !== type) { vc.seed = seed >>> 0; vc.type = type; vc.map = new Map(); }
  const key = cellKey(cx, cz);
  if (vc.map.has(key)) return vc.map.get(key);
  let out = null;
  if (hash2(cx, cz, (seed ^ 0x9e51) | 0) < 0.55) {
    const jx = (hash2(cx, cz, (seed ^ 0x31a1) | 0) - 0.5) * 224;
    const jz = (hash2(cx, cz, (seed ^ 0x77d3) | 0) - 0.5) * 224;
    const x = Math.round(cx * V_CELL + V_CELL / 2 + jx);
    const z = Math.round(cz * V_CELL + V_CELL / 2 + jz);
    const h = groundHeight(x, z, seed, type);
    let ok = h > SEA + 1 && h < SEA + 24;
    if (ok && SP && SP.active && SP.spawn) {
      const sx = x - SP.spawn.x, sz = z - SP.spawn.z;
      if (sx * sx + sz * sz < 64 * 64) ok = false;
    }
    if (ok) {
      const houses = [];
      const offs = [[14, 6], [-21, 7], [6, -20], [-7, 16], [21, -13]];
      for (const o of offs) {
        const hx = x + o[0], hz = z + o[1];
        const fy = groundHeight(hx + 3, hz + 2, seed, type);
        if (fy > SEA + 1 && fy < SEA + 24) houses.push({ x: hx, z: hz, fy });
      }
      const farms = [];
      for (const o of [[-29, -9], [15, 17]]) {
        const fx = x + o[0], fz = z + o[1];
        const fy = groundHeight(fx + 4, fz + 2, seed, type);
        if (fy > SEA + 1 && fy < SEA + 24) farms.push({ x: fx, z: fz, fy });
      }
      const lamps = [];
      for (const o of [[-22, -22], [22, -22], [-22, 22], [22, 22]]) {
        const lx = x + o[0], lz = z + o[1];
        const fy = groundHeight(lx, lz, seed, type);
        if (fy > SEA + 1 && fy < SEA + 24) lamps.push({ x: lx, z: lz, fy });
      }
      out = { x, z, fy: h, houses, farms, lamps };
    }
  }
  vc.map.set(key, out);
  return out;
}

let V_LAST = { x: 1e9, z: 1e9, s: -1, t: "", c: null };
function villageAt(x, z, seed, type) {
  if (type !== "hills") return null;
  if (V_LAST.x === x && V_LAST.z === z && V_LAST.s === (seed >>> 0) && V_LAST.t === type) return V_LAST.c;
  const ccx = Math.floor(x / V_CELL), ccz = Math.floor(z / V_CELL);
  const r2 = (V_RAD + 4) * (V_RAD + 4);
  let found = null;
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = villageCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz <= r2) { found = c; break; }
    }
    if (found) break;
  }
  V_LAST = { x, z, s: seed >>> 0, t: type, c: found };
  return found;
}

let V_LASTC = { x: 1e9, z: 1e9, s: -1, t: "", c: false };
function villageClearAt(x, z, seed, type) {
  if (type !== "hills") return false;
  if (SP && SP.structures === false) return false;
  if (V_LASTC.x === x && V_LASTC.z === z && V_LASTC.s === (seed >>> 0) && V_LASTC.t === type) return V_LASTC.c;
  const ccx = Math.floor(x / V_CELL), ccz = Math.floor(z / V_CELL);
  const r2 = (V_RAD + 2) * (V_RAD + 2);
  let found = false;
  for (let ax = -1; ax <= 1 && !found; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = villageCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz <= r2) { found = true; break; }
    }
  }
  V_LASTC = { x, z, s: seed >>> 0, t: type, c: found };
  return found;
}

// Structure override for one column: block state, 0 for carved air, or
// null to fall through to terrain. Order: well, houses, farms, lamps,
// then gravel paths over the natural surface.
function villageBlock(x, y, z, seed, type, h) {
  const c = villageAt(x, z, seed, type);
  if (!c) return null;
  const I = IDS;
  if (!I) return null;
  const dx = x - c.x, dz = z - c.z;
  // well: 3x3 cobble platform, water heart
  if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
    if (y === c.fy) return I.cobblestone;
    if (y === c.fy + 1) return (dx === 0 && dz === 0) ? I.water : I.cobblestone;
    return null;
  }
  // houses: 7x6 plank walls, log corners, glass windows, south door,
  // cobble floor + foundation + roof, one torch inside
  for (const hs of c.houses) {
    const lx = x - hs.x, lz = z - hs.z;
    if (lx < 0 || lx > 6 || lz < 0 || lz > 5) continue;
    const fy = hs.fy;
    if (y < fy - 2) return null;
    if (y === fy - 2 || y === fy - 1) return y > h ? I.cobblestone : null;
    if (y === fy) return I.cobblestone;
    if (y >= fy + 1 && y <= fy + 3) {
      const edge = lx === 0 || lx === 6 || lz === 0 || lz === 5;
      if (!edge) return (lx === 3 && lz === 2 && y === fy + 1) ? I.torch : 0;
      const corner = (lx === 0 || lx === 6) && (lz === 0 || lz === 5);
      if (corner) return I.oak_log;
      if (lz === 5 && lx === 3 && y <= fy + 2) return 0; // door
      if (y === fy + 2) {
        if (lx === 3 && lz === 5) return 0;
        const win = ((lx === 0 || lx === 6) && (lz % 2 === 1)) ||
          ((lz === 0 || lz === 5) && (lx % 2 === 0));
        if (win) return I.glass;
      }
      return I.oak_planks;
    }
    if (y === fy + 4) return I.cobblestone;
    return null;
  }
  // farms: 8x5 log-bordered plots, farmland + wheat hearts
  for (const f of c.farms) {
    const lx = x - f.x, lz = z - f.z;
    if (lx < 0 || lx > 7 || lz < 0 || lz > 4) continue;
    const fy = f.fy;
    const edge = lx === 0 || lx === 7 || lz === 0 || lz === 4;
    if (y === fy) return edge ? I.oak_log : I.farmland;
    if (y === fy + 1 && !edge) return I.wheat;
    if (y < fy && y > h) return I.dirt;
    return null;
  }
  // lamps: cobble foot, fence post, torch cap
  for (const l of c.lamps) {
    if (x !== l.x || z !== l.z) continue;
    if (y === l.fy) return I.cobblestone;
    if (y === l.fy + 1) return I.oak_fence;
    if (y === l.fy + 2) return I.torch;
    return null;
  }
  // paths: gravel cross over the natural surface
  if ((Math.abs(dx) <= 1 || Math.abs(dz) <= 1) && y === h) return I.gravel;
  return null;
}

function findVillageNear(nx, nz, seed, type, maxR) {
  if (type !== "hills") return null;
  maxR = maxR || 3000;
  const cells = Math.ceil(maxR / V_CELL) + 1;
  const ccx = Math.floor(nx / V_CELL), ccz = Math.floor(nz / V_CELL);
  let best = null, best2 = Infinity;
  for (let ax = -cells; ax <= cells; ax++) {
    for (let az = -cells; az <= cells; az++) {
      const c = villageCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = c.x - nx, dz = c.z - nz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= maxR * maxR && d2 < best2) { best2 = d2; best = c; }
    }
  }
  return best ? { x: best.x, z: best.z, fy: best.fy } : null;
}

/* ---------------------------------------------------------- mansion (P4) */

// Woodland-mansion analogue for tectonic: one grand single-floor hall
// (41x31, 4-high walls + roof band) on a rare jittered lattice (cell 2048,
// ~30% of cells), land only, gentle slopes, kept clear of spawn. Same purity
// contract as villages: layout derives from (seed, cell); blocks regenerate,
// player edits persist as overrides. Tectonic-only.
const M_CELL = 2048, M_HX = 20, M_HZ = 15;
let MCACHE = { seed: -1, type: "", map: new Map() };
// Sync cell budget: full scans (169 cells @10000) each cost a cold lattice
// build, so unbounded sync search freezes entry/trade (~13s). Ring search
// below takes a budget (default 40: a mansion lands within 2 rings 99.99%
// of the time at 30% density); the entry warmer fills the rest async.
function mansionCenterOfCell(cx, cz, seed, type) {
  if (type !== "tectonic") return null;
  const mc = MCACHE;
  if (mc.seed !== (seed >>> 0) || mc.type !== type) { mc.seed = seed >>> 0; mc.type = type; mc.map = new Map(); }
  const key = cellKey(cx, cz);
  if (mc.map.has(key)) return mc.map.get(key);
  let out = null;
  if (hash2(cx, cz, (seed ^ 0x6A5104) | 0) < 0.30) {
    const jx = (hash2(cx, cz, (seed ^ 0x31a2) | 0) - 0.5) * 1280;
    const jz = (hash2(cx, cz, (seed ^ 0x77d4) | 0) - 0.5) * 1280;
    const x = Math.round(cx * M_CELL + M_CELL / 2 + jx);
    const z = Math.round(cz * M_CELL + M_CELL / 2 + jz);
    const h = groundHeight(x, z, seed, type);
    let ok = h > SEA + 1 && h < SEA + 40;
    if (ok && Math.abs(groundHeight(x + 1, z, seed, type) - h) + Math.abs(groundHeight(x, z + 1, seed, type) - h) > 2) ok = false;
    if (ok) {
      const cb = colInfo(x, z, seed, type).b;
      if (cb === 1 || cb === 4 || cb === 5 || cb === 6) ok = false;
    }
    if (ok && SP && SP.active && SP.spawn) {
      const sx = x - SP.spawn.x, sz = z - SP.spawn.z;
      if (sx * sx + sz * sz < 128 * 128) ok = false;
    }
    if (ok) out = { x, z, fy: h };
  }
  if (MCACHE.map.size > 256) MCACHE.map.delete(MCACHE.map.keys().next().value);
  MCACHE.map.set(key, out);
  return out;
}
let M_LAST = { x: 1e9, z: 1e9, s: -1, t: "", c: null };
function mansionAt(x, z, seed, type) {
  if (type !== "tectonic") return null;
  if (M_LAST.x === x && M_LAST.z === z && M_LAST.s === (seed >>> 0) && M_LAST.t === type) return M_LAST.c;
  const ccx = Math.floor(x / M_CELL), ccz = Math.floor(z / M_CELL);
  let found = null;
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = mansionCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) <= M_HX + 3 && Math.abs(dz) <= M_HZ + 3) { found = c; break; }
    }
    if (found) break;
  }
  M_LAST = { x, z, s: seed >>> 0, t: type, c: found };
  return found;
}
let M_LASTC = { x: 1e9, z: 1e9, s: -1, t: "", c: false };
function mansionClearAt(x, z, seed, type) {
  if (type !== "tectonic") return false;
  if (SP && SP.structures === false) return false;
  if (M_LASTC.x === x && M_LASTC.z === z && M_LASTC.s === (seed >>> 0) && M_LASTC.t === type) return M_LASTC.c;
  const ccx = Math.floor(x / M_CELL), ccz = Math.floor(z / M_CELL);
  let found = false;
  for (let ax = -1; ax <= 1 && !found; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = mansionCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) <= M_HX + 5 && Math.abs(dz) <= M_HZ + 5) { found = true; break; }
    }
  }
  M_LASTC = { x, z, s: seed >>> 0, t: type, c: found };
  return found;
}
function mansionBlock(x, y, z, seed, type, h) {
  const c = mansionAt(x, z, seed, type);
  if (!c) return null;
  const I = IDS;
  if (!I) return null;
  const dx = x - c.x, dz = z - c.z;
  if (Math.abs(dx) > M_HX || Math.abs(dz) > M_HZ) return null;
  const fy = c.fy;
  const edgeX = Math.abs(dx) === M_HX, edgeZ = Math.abs(dz) === M_HZ;
  const edge = edgeX || edgeZ;
  const corner = edgeX && edgeZ;
  if (y < fy) return y > h ? I.dirt : null;
  if (y === fy) {
    if (dx >= -1 && dx <= 1 && dz >= -14 && dz <= -12) return I.obsidian;
    return I.cobblestone;
  }
  if (y >= fy + 1 && y <= fy + 4) {
    if (dz === M_HZ && dx >= -1 && dx <= 1 && y <= fy + 3) return 0;
    if (edge) {
      if (corner) return I.dark_oak_log;
      if (y === fy + 2 && (((dx + dz) % 3 + 3) % 3 === 0)) return I.glass;
      if (y === fy + 4) return I.dark_oak_planks;
      return I.cobblestone;
    }
    if ((dx === -10 || dx === 10) && (dz === -10 || dz === 0 || dz === 10)) return I.dark_oak_log;
    if (y === fy + 1) {
      if ((dx === -11 || dx === -9 || dx === 9 || dx === 11) && (dz === -11 || dz === -9 || dz === -1 || dz === 1 || dz === 9 || dz === 11)) return I.torch;
      if (dx === 2 && dz === -14) return I.chest || 0;
      if (dx === 0 && Math.abs(dz) <= 14 && !(dz >= -6 && dz <= -5) && !(dz >= 5 && dz <= 6) && !(dz >= -13 && dz <= -12)) return I.dark_oak_planks;
      if (dz === -5 && dx >= -19 && dx <= 19 && !(dx >= -11 && dx <= -10) && !(dx >= 9 && dx <= 10)) return I.dark_oak_planks;
      if (dz === 5 && dx >= -19 && dx <= 19 && !(dx >= -11 && dx <= -10) && !(dx >= 9 && dx <= 10)) return I.dark_oak_planks;
      return 0;
    }
    if (y >= fy + 2 && y <= fy + 4) {
      if (dx === 0 && Math.abs(dz) <= 14 && !(dz >= -6 && dz <= -5) && !(dz >= 5 && dz <= 6) && !(dz >= -13 && dz <= -12)) return I.dark_oak_planks;
      if ((dz === -5 || dz === 5) && Math.abs(dx) <= 19 && !(dx >= -11 && dx <= -10) && !(dx >= 9 && dx <= 10)) return I.dark_oak_planks;
      return 0;
    }
    return 0;
  }
  if (y === fy + 5) {
    if (corner) return I.dark_oak_log;
    if (edge) return I.cobblestone;
    return I.dark_oak_planks;
  }
  return null;
}
// v1.15.0: nearest fortress to (nx,nz) within maxR (nether coords), budget-
// bounded lattice scan like findMansionNear (centers are O(1) hash, no
// cold-column cost, so entry can afford a generous budget)
function findFortressNear(nx, nz, seed, maxR, budget) {
  maxR = maxR || 10000;
  budget = budget == null ? 200 : budget;
  const cells = Math.ceil(maxR / F_CELL) + 1;
  const ccx = Math.floor(nx / F_CELL), ccz = Math.floor(nz / F_CELL);
  let best = null, best2 = Infinity, spent = 0;
  for (let r = 0; r <= cells; r++) {
    for (let ax = -r; ax <= r; ax++) {
      for (let az = -r; az <= r; az++) {
        if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
        if (spent >= budget) { r = cells + 1; break; }
        spent++;
        const c = fortressCenterOfCell(ccx + ax, ccz + az, seed);
        if (!c) continue;
        const dx = c.x - nx, dz = c.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= maxR * maxR && d2 < best2) { best2 = d2; best = c; }
      }
    }
  }
  return best ? { x: best.x, z: best.z, fy: best.fy } : null;
}
// Fortress garden chest: the chest BLOCK comes from fortressBlock; contents
// are seeded here at world entry into the nether stash (dimEnt[-1]) plus the
// live tile map when already in the nether. Lattice + floor are pure hash so
// no async warmer is needed (unlike mansions over cold tectonic columns).
function writeFortressChest(rec) {
  try {
    if (!rec || rec.fortressChestDone) return;
    if (!game || !game.items || !game.items.byName) return;
    // nether coords are overworld/8 (vanilla travel ratio)
    const nx = (SP.spawn.x || 0) / 8, nz = (SP.spawn.z || 0) / 8;
    const F = findFortressNear(nx, nz, SP.seed, 10000, 500);
    if (!F) return; // nothing in range: retry next entry
    const items = new Array(27).fill(null);
    const put = (slot, name, count) => {
      try {
        const def = game.items.byName.get(name);
        if (def && def.id != null) items[slot] = { id: def.id, c: count | 0 };
      } catch (e) {}
    };
    put(4, "diamond", 2); put(5, "gold_ingot", 5); put(6, "iron_ingot", 4);
    put(12, "obsidian", 4); put(13, "saddle", 1); put(14, "nether_wart", 6);
    put(21, "torch", 8); put(22, "golden_apple", 1);
    const tile = { k: (F.x + 11) + "," + (F.fy + 1) + "," + F.z, type: "chest", items };
    const full = loadWorldRec(SP.id) || rec;
    full.dimEnt = full.dimEnt || {};
    const st = full.dimEnt[-1] = full.dimEnt[-1] || {};
    st.tiles = (st.tiles || []).concat([tile]);
    full.fortressChestDone = true;
    full.svIds = 1194;
    saveWorldRec(SP.id, full);
    rec.fortressChestDone = true;
    rec.svIds = 1194;
    // already in the nether: patch the live tile map too (idempotent)
    try {
      if ((SP.dim | 0) === -1) {
        const sv = globalThis.__mcSurvival;
        if (sv && sv.giveTile) sv.giveTile(tile.k, {
          type: "chest", x: F.x + 11, y: F.fy + 1, z: F.z,
          items: items.map((s) => s ? { id: s.id, count: s.c | 0, nbt: null } : null),
          burn: 0, burnTotal: 0, cook: 0, xp: 0, lastOut: 0, fuel: 0, time: 0, ing: null, cd: 0, pow: false,
        });
      }
    } catch (e) {}
  } catch (e) {}
}
function findMansionNear(nx, nz, seed, type, maxR, budget) {  if (type !== "tectonic") return null;
  maxR = maxR || 10000;
  budget = budget == null ? 40 : budget;
  const cells = Math.ceil(maxR / M_CELL) + 1;
  const ccx = Math.floor(nx / M_CELL), ccz = Math.floor(nz / M_CELL);
  let best = null, best2 = Infinity, spent = 0;
  // expanding rings: nearest-first; the budget bounds cold-scan cost
  // (warm cache makes full scans cheap). Returns best within budget.
  for (let r = 0; r <= cells; r++) {
    for (let ax = -r; ax <= r; ax++) {
      for (let az = -r; az <= r; az++) {
        if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
        if (spent >= budget) { r = cells + 1; break; }
        spent++;
        const c = mansionCenterOfCell(ccx + ax, ccz + az, seed, type);
        if (!c) continue;
        const dx = c.x - nx, dz = c.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= maxR * maxR && d2 < best2) { best2 = d2; best = c; }
      }
    }
  }
  return best ? { x: best.x, z: best.z, fy: best.fy } : null;
}

// Async entry warmer: fills MCACHE rings around spawn a few cells per tick
// (never blocks), then seeds the sanctum chest tile. Sync entry/trade paths
// stay bounded; this backfills correctness for far mansions.
let M_WARM = { id: null, done: false };
function warmMansions(rec) {
  try {
    if (!rec || M_WARM.id === rec.id || M_WARM.done) {
      // writeMansionChest is idempotent (giveTile never overwrites), so run
      // it whenever the warmer is done — repairs pre-fix worlds too.
      if (M_WARM.done && rec) writeMansionChest(rec);
      return;
    }
    M_WARM = { id: rec.id, done: false };
    const seed = SP.seed, type = SP.type, sx = SP.spawn.x, sz = SP.spawn.z;
    const ccx = Math.floor(sx / M_CELL), ccz = Math.floor(sz / M_CELL);
    const jobs = [];
    for (let r = 0; r <= 6; r++) {
      for (let ax = -r; ax <= r; ax++) {
        for (let az = -r; az <= r; az++) {
          if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
          jobs.push([ccx + ax, ccz + az]);
        }
      }
    }
    let i = 0;
    const step = () => {
      try {
        if (!SP.active || SP.id !== M_WARM.id) return; // left the world: stop
        for (let n = 0; n < 6 && i < jobs.length; n++, i++) {
          try { mansionCenterOfCell(jobs[i][0], jobs[i][1], seed, type); } catch (e) {}
        }
        if (i < jobs.length) { setTimeout(step, 0); return; }
        M_WARM.done = true;
        writeMansionChest(rec);
      } catch (e) {}
    };
    setTimeout(step, 250);
  } catch (e) {}
}
function writeMansionChest(rec) {
  try {
    if (!rec) return;
    if (SP.type !== "tectonic" || (SP.dim | 0) !== 0) { rec.mansionChestDone = true; return; }
    if (!game || !game.items || !game.items.byName) return;
    const M = findMansionNear(SP.spawn.x, SP.spawn.z, SP.seed, SP.type, 10000, 500);
    if (!M) return; // nothing in range (or still cold): retry next entry
    const items = new Array(27).fill(null);
    const put = (slot, name, count) => {
      try {
        const def = game.items.byName.get(name);
        if (def && def.id != null) items[slot] = { id: def.id, c: count | 0 };
      } catch (e) {}
    };
    put(4, "emerald", 3); put(5, "gold_ingot", 4); put(6, "iron_ingot", 6);
    put(12, "arrow", 12); put(13, "string", 5); put(14, "bread", 3);
    put(21, "torch", 8); put(22, "diamond", 1);
    // P4 (1.19.4 stopgap): ancient cities are future work, so the mansion
    // stash carries echo shards + disc fragments (recovery compass / disc 5
    // would otherwise be unobtainable).
    put(10, "echo_shard", 8); put(11, "disc_fragment_5", 3);
    const tile = { k: (M.x + 2) + "," + (M.fy + 1) + "," + (M.z - 14), type: "chest", items };
    if (!rec.mansionChestDone) {
      const full = loadWorldRec(SP.id) || rec;
      full.tiles = (full.tiles || []).concat([tile]);
      full.mansionChestDone = true;
      full.svIds = 1194;
      saveWorldRec(SP.id, full);
      rec.mansionChestDone = true;
      rec.svIds = 1194;
      rec.tiles = full.tiles;
    }
    // survival already restored: patch the live tile map too, via the
    // survival record (restoreTiles only reads loadWorldRecSv — the SP rec
    // tile above is bookkeeping). giveTile is idempotent, so this also
    // repairs pre-fix worlds whose SP rec already has mansionChestDone.
    try {
      const sv = globalThis.__mcSurvival;
      if (sv && sv.giveTile) sv.giveTile(tile.k, {
        type: "chest", x: M.x + 2, y: M.fy + 1, z: M.z - 14,
        items: items.map((s) => s ? { id: s.id, count: s.c | 0, nbt: null } : null),
        burn: 0, burnTotal: 0, cook: 0, xp: 0, lastOut: 0, fuel: 0, time: 0, ing: null, cd: 0, pow: false,
      });
    } catch (e) {}
  } catch (e) {}
}

/* ---------------------------------------------------------- nether (Phase A) */

// Nether terrain: netherrack body with a bedrock floor AND ceiling (vanilla
// has both), lava seas at LAVA_SEA, soul-sand + gravel patches on the
// surface, quartz-ore sprinkles below, glowstone stalactites under the
// ceiling, sparse surface fire. Pure function of (seed) like the overworld
// gen, so saves stay override-free and player edits persist as overrides.
const LAVA_SEA = 32;
let NETH = { x: 1e9, z: 1e9, s: -1, h: 0 };
function netherGround(x, z, seed) {
  if (NETH.x === x && NETH.z === z && NETH.s === (seed >>> 0)) return NETH.h;
  const c = fbm(x * 0.008 + 37.2, z * 0.008 - 11.9, seed, 3);
  const d = fbm(x * 0.03 + 913.7, z * 0.03 - 517.2, (seed ^ 0x9e31) | 0, 2);
  let h = 34 + (c - 0.5) * 60 + (d - 0.5) * 14;
  h = clamp(Math.floor(h), 30, 100);
  NETH = { x, z, s: seed >>> 0, h };
  return h;
}
function netherState(x, y, z, seed) {
  if (y < 0 || y > 127) return 0;
  const I = IDS;
  if (!I || !I.netherrack) return 0;
  if (y === 0 || y === 127) return I.bedrock;
  if ((y === 1 || y === 126) && hash3(x, y, z, seed) < 0.5) return I.bedrock;
  // v1.15.0: fortresses override terrain (or carve air) — checked first so
  // brickwork survives any biome swap below. F_LAST makes the per-block
  // lattice lookup a cache hit down a column.
  try {
    if (!SP || SP.structures !== false) {
      const fb = fortressBlock(x, y, z, seed);
      if (fb != null) return fb;
    }
  } catch (e) {}
  const h = netherGround(x, z, seed);
  const nb = netherBiome(x, z, seed); // v1.15.0: 5 nether biomes
  if (y <= h) {
    if (y === h) {
      if (h <= LAVA_SEA) return I.netherrack; // lava-sea floor
      return netherSurfaceAt(x, z, seed, h, nb);
    }
    if (y >= h - 2 && h > LAVA_SEA) {
      if (nb === 1 && hash2(x, z, (seed ^ 0x5011) | 0) < 0.09) return I.soul_sand;
      if (nb === 4) return I.basalt; // delta flows run 3 deep
    }
    if (y <= 100 && hash3(x, y, z, (seed ^ 0x9A27) | 0) < 0.018) return I.nether_quartz_ore;
    return I.netherrack;
  }
  // above the surface: lava seas/lakes, glowstone, forest/valley decor,
  // sparse wastes fire (vanilla soul valleys burn blue — gap, see below)
  if (h < LAVA_SEA && y <= LAVA_SEA) return I.lava;
  if (y === h + 1 && h > LAVA_SEA) {
    const dc = netherDecorAt(x, y, z, seed, h, nb);
    if (dc) return dc;
  }
  if (y >= 112 && y <= 123 &&
      hash2(x, z, (seed ^ 0x6105) | 0) < 0.012 &&
      hash3(x, y, z, (seed ^ 0x610E) | 0) < 0.55) return I.glowstone;
  if (y === h + 1 && h > LAVA_SEA && nb === 0 &&
      hash2(x * 2 + 3, z * 2 - 5, (seed ^ 0xF12E) | 0) < 0.004) return I.fire;
  return 0;
}

/* ---------------------------------------------------------- nether biomes + fortresses (v1.15.0) */

// 0 nether_wastes, 1 soul_sand_valley, 2 crimson_forest, 3 warped_forest,
// 4 basalt_deltas. Two low-frequency masks (same fbm family as netherGround,
// so the biome field is smooth at chunk scale and free of cliffs).
let NBIOME = { x: 1e9, z: 1e9, s: -1, b: 0 };
function netherBiome(x, z, seed) {
  if (NBIOME.x === x && NBIOME.z === z && NBIOME.s === (seed >>> 0)) return NBIOME.b;
  const t = fbm(x * 0.006 + 41.3, z * 0.006 + 17.8, (seed ^ 0xB10E) | 0, 2);
  const u = fbm(x * 0.02 - 133.1, z * 0.02 + 71.7, (seed ^ 0xB10F) | 0, 2);
  let b = 0;
  if (u > 0.74) b = 4; // volcanic pockets anywhere (vanilla deltas interrupt)
  else if (t < 0.40) b = 0;
  else if (t < 0.52) b = 1;
  else if (t < 0.64) b = 2;
  else if (t < 0.76) b = 3;
  NBIOME = { x, z, s: seed >>> 0, b };
  return b;
}
// soul-valley basalt pillar top (0 = none): narrow columns rising off the
// valley floor, pure of (x,z,seed) like everything else here
function netherPillarTop(x, z, seed, h) {
  if (hash2(x, z, (seed ^ 0xBA57) | 0) >= 0.012) return 0;
  return h + 6 + ((hash2(x * 3 + 1, z * 3 - 2, (seed ^ 0xBA58) | 0) * 5) | 0);
}
function netherSurfaceAt(x, z, seed, h, nb) {
  // top-block swap for the 5 biomes; called for y === h above the lava seas
  const I = IDS;
  if (nb === 1) {
    const r = hash2(x, z, (seed ^ 0x5011) | 0);
    if (r < 0.30) return I.soul_soil;
    return I.soul_sand;
  }
  if (nb === 2) return I.crimson_nylium;
  if (nb === 3) return I.warped_nylium;
  if (nb === 4) {
    if (hash2(x + 71, z - 43, (seed ^ 0x62A9) | 0) < 0.35) return I.blackstone;
    return I.basalt;
  }
  if (hash2(x, z, (seed ^ 0x5011) | 0) < 0.09) return I.soul_sand;
  if (hash2(x + 71, z - 43, (seed ^ 0x62A9) | 0) < 0.04) return I.gravel;
  return I.netherrack;
}
function netherDecorAt(x, y, z, seed, h, nb) {
  // one block above the surface (y === h+1): fungi + wart bushes in the
  // forests, basalt pillars in soul valleys; deltas stay bare (vanilla)
  const I = IDS;
  if (nb === 1) {
    const pt = netherPillarTop(x, z, seed, h);
    if (pt > h && y <= pt) return I.basalt;
    return 0;
  }
  if (nb === 2 || nb === 3) {
    const r = hash2(x * 2 + 3, z * 2 - 5, (seed ^ 0xF0E5) | 0);
    if (r < 0.025) return nb === 2 ? I.crimson_fungus : I.warped_fungus;
    if (r < 0.045) return nb === 2 ? I.crimson_wart_block : I.warped_wart_block;
    return 0;
  }
  return 0;
}

// Fortresses: nether-brick complexes on a 512 lattice (30% of cells skip,
// jittered centers), floor a few blocks above the local terrain. Skipped
// when the center sits over a lava sea (bridges may still cross lava at the
// edges — vanilla fortresses do the same). Pure of (seed).
const F_CELL = 512;
function fortressCenterOfCell(ccx, ccz, seed) {
  if (hash2(ccx, ccz, (seed ^ 0xF071) | 0) < 0.30) return null;
  const jx = (hash2(ccx * 2 + 1, ccz * 2 + 3, (seed ^ 0xF072) | 0) - 0.5) * 200;
  const jz = (hash2(ccx * 2 + 7, ccz * 2 + 5, (seed ^ 0xF073) | 0) - 0.5) * 200;
  const cx = Math.round(ccx * F_CELL + 256 + jx), cz = Math.round(ccz * F_CELL + 256 + jz);
  const h = netherGround(cx, cz, seed);
  if (h <= LAVA_SEA + 1) return null;
  return { x: cx, z: cz, fy: h + 3 };
}
let F_LAST = { x: 1e9, z: 1e9, s: -1, c: null };
function fortressAt(x, z, seed) {
  if (F_LAST.x === x && F_LAST.z === z && F_LAST.s === (seed >>> 0)) return F_LAST.c;
  const ccx = Math.floor(x / F_CELL), ccz = Math.floor(z / F_CELL);
  let found = null;
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = fortressCenterOfCell(ccx + ax, ccz + az, seed);
      if (!c) continue;
      if (Math.abs(x - c.x) <= 26 && Math.abs(z - c.z) <= 10) { found = c; break; }
    }
    if (found) break;
  }
  F_LAST = { x, z, s: seed >>> 0, c: found };
  return found;
}
function fortressBlock(x, y, z, seed) {
  // null = not a fortress cell (fall through to terrain); 0 = carved air
  const c = fortressAt(x, z, seed);
  if (!c) return null;
  const I = IDS;
  if (!I || !I.nether_bricks) return null;
  const dx = x - c.x, dz = z - c.z, fy = c.fy;
  if (Math.abs(dx) > 26 || Math.abs(dz) > 10) return null;
  const courtyard = Math.abs(dx) <= 6 && Math.abs(dz) <= 6;
  const bridge = Math.abs(dx) > 6 && Math.abs(dx) <= 18 && Math.abs(dz) <= 1;
  const rail = Math.abs(dx) > 6 && Math.abs(dx) <= 18 && Math.abs(dz) === 2;
  const garden = dx >= 8 && dx <= 14 && Math.abs(dz) <= 2;
  const pillar = (Math.abs(dx) === 6 && Math.abs(dz) === 6);
  if (y < fy - 2) return null;
  if (y <= fy - 1) {
    if (courtyard && !pillar) return I.nether_bricks; // foundation raft
    return null;
  }
  if (y === fy) {
    if (courtyard || bridge) return I.nether_bricks;
    if (garden) return I.soul_sand;
    return null;
  }
  if (y >= fy + 1 && y <= fy + 4) {
    if (pillar) return I.nether_bricks;
    if (rail && y === fy + 1) return I.nether_brick_fence;
    if (garden) {
      if (dx === 11 && dz === 0) return y === fy + 1 ? (I.chest || 0) : 0;
      if (y === fy + 1) {
        // wart garden: mostly mature wart, some young (tile-free farm source;
        // nether_wart states are age 0-3 contiguous — verified at test time)
        const r = hash2(x * 3 + 5, z * 3 - 1, (seed ^ 0x9A77) | 0);
        if (r < 0.15) return 0; // gaps
        return I.nether_wart + (r < 0.75 ? 3 : (((r * 100) | 0) % 3));
      }
      return 0;
    }
    if (courtyard || bridge) return 0;
    return null;
  }
  return null;
}

/* ---------------------------------------------------------- the End (Phase A) */

// Central island (end stone, noisy top ~63), 10 obsidian pillars with
// bedrock caps (crystals ride Phase E), a 5x5 obsidian arrival platform at
// (100,48,0), and outer chorus islands on a jittered lattice. Pure of
// (seed) like the other gens, so saves stay override-free.
let ENDP = null;
function endPillars(seed) {
  if (ENDP && ENDP.s === (seed >>> 0)) return ENDP.p;
  const p = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2 + ((seed % 100) / 100) * 0.6;
    p.push({
      x: Math.round(Math.cos(a) * 22),
      z: Math.round(Math.sin(a) * 22),
      h: 6 + ((hash2(i, 7, (seed ^ 0xE11A) | 0) * 12) | 0),
    });
  }
  ENDP = { s: seed >>> 0, p };
  return p;
}
let ETTC = { x: 1e9, z: 1e9, s: -1, t: 63 };
function endTop(x, z, seed) {
  if (ETTC.x === x && ETTC.z === z && ETTC.s === (seed >>> 0)) return ETTC.t;
  const n = fbm(x * 0.02 + 11.3, z * 0.02 - 7.1, (seed ^ 0xE51) | 0, 2);
  const t = 63 + Math.round((n - 0.5) * 6);
  ETTC = { x, z, s: seed >>> 0, t };
  return t;
}
let OUTC = { x: 1e9, z: 1e9, s: -1, o: null };
function outerIsland(x, z, seed) {
  if (OUTC.x === x && OUTC.z === z && OUTC.s === (seed >>> 0)) return OUTC.o;
  let o = null;
  const C = 96;
  const ccx = Math.floor(x / C), ccz = Math.floor(z / C);
  outer:
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const cx0 = ccx + ax, cz0 = ccz + az;
      if (hash2(cx0, cz0, (seed ^ 0x0151) | 0) < 0.45) continue;
      const jx = (hash2(cx0, cz0, (seed ^ 0x0152) | 0) - 0.5) * 64;
      const jz = (hash2(cx0, cz0, (seed ^ 0x0153) | 0) - 0.5) * 64;
      const ix = Math.round(cx0 * C + C / 2 + jx), iz = Math.round(ccz * C + C / 2 + jz);
      if (ix * ix + iz * iz < 80 * 80) continue; // clear of the main island
      const dx = x - ix, dz = z - iz;
      const rad = 10 + Math.floor(hash2(cx0, cz0, (seed ^ 0x0154) | 0) * 11);
      if (dx * dx + dz * dz <= rad * rad) {
        o = { x: ix, z: iz, r: rad, top: 58 + Math.floor(hash2(cx0, cz0, (seed ^ 0x0155) | 0) * 9) };
        break outer;
      }
    }
  }
  OUTC = { x, z, s: seed >>> 0, o };
  return o;
}
function endState(x, y, z, seed) {
  if (y < 0 || y > 255) return 0;
  const I = IDS;
  if (!I || !I.end_stone) return 0;
  // arrival platform: 5x5 obsidian, air above (stand at 100.5,49.1,0.5)
  if (x >= 98 && x <= 102 && z >= -2 && z <= 2) {
    if (y === 48) return I.obsidian;
    return 0;
  }
  // pillars first (they stand on the central island)
  const pls = endPillars(seed);
  for (let i = 0; i < pls.length; i++) {
    const pl = pls[i];
    if (Math.abs(x - pl.x) <= 1 && Math.abs(z - pl.z) <= 1) {
      const t = endTop(pl.x, pl.z, seed);
      if (y >= t && y <= t + pl.h) return I.obsidian;
      if (y === t + pl.h + 1) return I.bedrock;
      return 0;
    }
  }
  // exit fountain (gated behind the dragon kill: pre-kill the center is
  // flat end stone; the portal ring appears once ENDKILLS > 0, with the
  // egg written as an override by the kill hook so already-generated chunks
  // update without a regen (ring/rim/gateway match open-gen exactly, so the
  // prune keeps or drops them with zero visual difference). Touching its
  // portal blocks returns to the overworld spawn via the normal touch path.
  if (Math.abs(x) <= 2 && Math.abs(z) <= 2) {
    const t0 = endTop(0, 0, seed);
    const open = endKillsFor(seed) > 0;
    if (y === t0 + 1) {
      if (!open) return I.end_stone;
      // portal cardinals + bedrock rim (corners anchor the respawn-rite
      // crystals via tryDragonRitual; center caps the bowl like vanilla)
      if (Math.abs(x) > 1 || Math.abs(z) > 1 || (x === 0 && z === 0) ||
          (Math.abs(x) === 1 && Math.abs(z) === 1)) return I.bedrock;
      return I.end_portal;
    }
    if (!open) {
      if (y <= t0 && y >= t0 - 8) return I.end_stone;
      return 0;
    }
    if (x === 0 && z === 0 && y >= t0 + 2 && y <= t0 + 4) return I.bedrock;
    if (y <= t0 && y >= t0 - 8) return I.end_stone;
    return 0;
  }
  // end gateways: one rim slot per kill (max 20), floating past the island
  // edge. Checked before the island fill so the bedrock base always wins.
  const gw = endGatewayAt(x, y, z, seed);
  if (gw) return gw;
  const r2 = x * x + z * z;
  if (r2 <= 54 * 54) {
    const t = endTop(x, z, seed);
    if (y <= t && y >= t - 8) return I.end_stone;
    return 0;
  }
  const oc = outerIsland(x, z, seed);
  if (oc) {
    if (Math.abs(oc.x - 100) + Math.abs(oc.z) < 40) return 0; // platform clear
    // v1.16.0 cities override island terrain (checked first, like fortresses)
    const ec = endCityAt(x, z, seed);
    if (ec) {
      const eb = endCityBlock(x, y, z, seed, ec);
      if (eb !== -1) return eb;
    }
    const t = oc.top;
    if (y <= t && y >= t - 3) return I.end_stone;
    if (y > t && y <= t + 4) {
      if (hash2(x, z, (seed ^ 0xC40) | 0) < 0.03) {
        const hgt = 2 + Math.floor(hash2(x * 3 + 1, z * 3 - 1, (seed ^ 0xC41) | 0) * 3);
        if (y === t + hgt) return I.chorus_flower;
        if (y < t + hgt) return I.chorus_plant;
      }
    }
    return 0;
  }
  return 0;
}

/* ------------------------------------------- v1.16.0 End: gateways + cities */

// Dragon-kill count gating the exit fountain / gateway rim. Set from the
// world rec on entry and by the kill hook; keyed by seed (same-seed worlds
// sharing a count is a negligible edge — genState only runs for the open
// world in practice).
let ENDK = { s: -1, n: 0 };
function setEndKills(seed, n) {
  try { ENDK = { s: (seed >>> 0), n: Math.max(0, n | 0) }; } catch (e) {}
}
function endKillsFor(seed) {
  try { return (ENDK.s === (seed >>> 0)) ? (ENDK.n | 0) : 0; } catch (e) { return 0; }
}
// v1.16.0: ENDK must be correct before the first chunk generates (fountain +
// gateways render from it). dragonKills lives in the SURVIVAL rec
// (mcjs.sp.v3.world.<id>), not the SP rec — read it directly so this works
// regardless of survival load order. onEnterEnd re-syncs on End entry.
function seedEndKills(id, seed) {
  try {
    const svr = JSON.parse(lsGet("mcjs.sp.v3.world." + id) || "null");
    setEndKills(seed, (svr && svr.dragonKills | 0) || 0);
  } catch (e) {}
}
// 20 gateway rim slots (vanilla cap): jittered ring past the island edge,
// floating ~12 above the center top. Slot k exists once kills > k.
function endGatewaySpots(seed) {
  const out = [];
  let t0 = 63;
  try { t0 = endTop(0, 0, seed); } catch (e) {}
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2 + (hash2(k, 77, (seed ^ 0x6A1E) | 0) - 0.5) * 0.2;
    out.push({ x: Math.round(Math.cos(a) * 92), y: t0 + 12, z: Math.round(Math.sin(a) * 92) });
  }
  return out;
}
function endGatewayAt(x, y, z, seed) {
  const I = IDS;
  if (!I || !I.end_gateway) return 0;
  const n = endKillsFor(seed);
  if (n <= 0) return 0;
  const spots = endGatewaySpots(seed);
  for (let k = 0; k < Math.min(n, 20); k++) {
    const s = spots[k];
    if (x === s.x && z === s.z) {
      if (y === s.y) return I.end_gateway;
      if (y === s.y - 1) return I.bedrock;
      return 0;
    }
  }
  return 0;
}
// End cities: one jittered lattice (cell 384) over the outer islands.
// A cell holds a city only on a big island (r >= 12). Pure of (cell, seed).
const E_CITY_CELL = 384;
function endCityCenterOfCell(ccx, ccz, seed) {
  if (hash2(ccx, ccz, (seed ^ 0xC117) | 0) < 0.55) return null; // ~45% of cells
  const jx = (hash2(ccx, ccz, (seed ^ 0xC118) | 0) - 0.5) * 256;
  const jz = (hash2(ccx, ccz, (seed ^ 0xC119) | 0) - 0.5) * 256;
  let ix = Math.round(ccx * E_CITY_CELL + E_CITY_CELL / 2 + jx);
  let iz = Math.round(ccz * E_CITY_CELL + E_CITY_CELL / 2 + jz);
  if (ix * ix + iz * iz < 130 * 130) return null; // clear of main island
  if (Math.abs(ix - 100) + Math.abs(iz) < 60) return null; // platform clear
  let isl = null;
  try { isl = outerIsland(ix, iz, seed); } catch (e) {}
  if (!isl || isl.r < 12) return null; // needs a big island
  // recenter on the island (the jittered cell point can sit near the
  // island's edge, leaving the base disc hanging over the void)
  ix = isl.x; iz = isl.z;
  const top = isl.top;
  const h = 10 + Math.floor(hash2(ccx, ccz, (seed ^ 0xC11A) | 0) * 8);
  const ship = hash2(ccx, ccz, (seed ^ 0xC11B) | 0) < 0.45;
  const sx = ix + 16, sz = iz + Math.floor((hash2(ccx, ccz, (seed ^ 0xC11C) | 0) - 0.5) * 10);
  const c = { x: ix, z: iz, top, h, ship, sx, sz, sy: top + 7 };
  c.chest = { x: ix + 1, y: top + 3 + h, z: iz };
  c.slots = [
    { x: ix - 2, y: top + 3 + h, z: iz, face: 4 },
    { x: ix + 2, y: top + 3 + h, z: iz, face: 5 },
  ];
  if (ship) {
    c.shipChest = { x: sx - 3, y: top + 8, z: sz };
    c.slots.push({ x: sx + 3, y: top + 8, z: sz, face: 4 });
  }
  c.key = ccx + "," + ccz;
  return c;
}
let ECITYC = { x: 1e9, z: 1e9, s: -1, c: null };
function endCityAt(x, z, seed) {
  if (ECITYC.x === x && ECITYC.z === z && ECITYC.s === (seed >>> 0)) return ECITYC.c;
  let c = null;
  const ccx = Math.floor(x / E_CITY_CELL), ccz = Math.floor(z / E_CITY_CELL);
  outer:
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const ctr = endCityCenterOfCell(ccx + ax, ccz + az, seed);
      if (!ctr) continue;
      // footprint: base r6 + tower + ship at +16 + margin
      const dx = x - ctr.x, dz = z - ctr.z;
      if (dx * dx + dz * dz > 28 * 28) {
        const sx = x - ctr.sx, sz = z - ctr.sz;
        if (!ctr.ship || sx * sx + sz * sz > 12 * 12) continue;
      }
      c = ctr;
      break outer;
    }
  }
  ECITYC = { x, z, s: seed >>> 0, c };
  return c;
}
function endCitiesNear(x, z, seed, maxR, budget) {
  maxR = maxR || 4000;
  budget = budget == null ? 40 : budget;
  const out = [];
  const ccx = Math.floor(x / E_CITY_CELL), ccz = Math.floor(z / E_CITY_CELL);
  const cells = Math.ceil(maxR / E_CITY_CELL) + 1;
  let spent = 0;
  outer:
  for (let r = 0; r <= cells; r++) {
    for (let ax = -r; ax <= r; ax++) {
      for (let az = -r; az <= r; az++) {
        if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
        if (++spent > budget) break outer;
        const ctr = endCityCenterOfCell(ccx + ax, ccz + az, seed);
        if (!ctr) continue;
        const dx = ctr.x - x, dz = ctr.z - z;
        if (dx * dx + dz * dz <= maxR * maxR) out.push(ctr);
      }
    }
  }
  out.sort((a, b) => ((a.x - x) * (a.x - x) + (a.z - z) * (a.z - z)) - ((b.x - x) * (b.x - x) + (b.z - z) * (b.z - z)));
  return out;
}
// City blocks. Returns -1 to fall through to island terrain/chorus, else
// the state (0 carves air). Tower: center pillar + slab floors every 5 +
// alternating slab ladder; top room 5x5 with rods, chest, shulker walls.
function endCityBlock(x, y, z, seed, c) {
  const I = IDS;
  if (!I || !I.purpur_pillar) return -1;
  const T = c.top + 2 + c.h; // tower-top room floor
  const dx = x - c.x, dz = z - c.z;
  // ship (checked first; separate footprint)
  if (c.ship) {
    const hx = x - c.sx, hz = z - c.sz;
    if (Math.abs(hx) <= 4 && Math.abs(hz) <= 2) {
      if (y === c.sy) {
        if (Math.abs(hx) === 4 || Math.abs(hz) === 2) return I.purpur_block;
        return I.purpur_slab;
      }
      if (y === c.sy + 1) {
        if (hx === -3 && hz === 0) return I.chest;
        if (hx === 0 && hz === 0) return I.purpur_pillar; // mast
        return 0;
      }
      if (hx === 0 && hz === 0 && y > c.sy + 1 && y <= c.sy + 7) return I.purpur_pillar;
      if (hx === 0 && hz === 0 && y === c.sy + 8) return I.end_rod;
      return -1;
    }
  }
  // base floor disc r6 at top+1
  if (y === c.top + 1 && dx * dx + dz * dz <= 38) {
    if (dx === 1 && dz === 0) return 0; // doorway gap
    return I.end_stone_bricks;
  }
  // tower column + slab floors + ladder
  if (y >= c.top + 2 && y < T) {
    if (dx === 0 && dz === 0) return I.purpur_pillar;
    if ((y - c.top - 2) % 5 === 0 && Math.abs(dx) <= 2 && Math.abs(dz) <= 2) return I.purpur_slab;
    const k = y - c.top - 3;
    if (k >= 0) {
      const side = (k % 2 === 0) ? 1 : -1;
      if (dx === side && dz === 0) return I.purpur_slab;
    }
    return -1;
  }
  // top room: floor y=T ring 5x5, walls T+1..T+3, roof T+4
  if (y >= T && y <= T + 4 && Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
    const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
    if (y === T) return edge ? I.end_stone_bricks : I.end_stone_bricks;
    if (y === T + 4) return I.purpur_slab;
    if (edge) {
      if ((dx === -2 || dx === 2) && dz === 0 && y === T + 1) return 0; // shulker doors
      return I.end_stone_bricks;
    }
    // interior
    if (dx === 1 && dz === 0 && y === T + 1) return I.chest;
    if (Math.abs(dx) === 2 && Math.abs(dz) === 2) return 0;
    if (Math.abs(dx) === 2 && Math.abs(dz) === 2 && false) return I.end_rod;
    if ((dx === 2 || dx === -2) && (dz === 2 || dz === -2) && y >= T + 1 && y <= T + 3) return I.end_rod;
    return 0;
  }
  return -1;
}
// City + ship chest contents (seeded at world entry into the End stash,
// dimEnt[1], plus the live tile map when already in the End).
function writeEndCityChests(rec) {
  try {
    if (!rec || rec.endCitiesDoneV2) return;
    if (!game || !game.items || !game.items.byName) return;
    const cities = endCitiesNear(100, 0, SP.seed, 4000, 60).slice(0, 4);
    if (!cities.length) return; // none in range: retry next entry
    const items = new Array(27).fill(null);
    const mk = (list) => {
      const arr = new Array(27).fill(null);
      const put = (slot, name, count) => {
        try {
          const def = game.items.byName.get(name);
          if (def && def.id != null) arr[slot] = { id: def.id, c: count | 0 };
        } catch (e) {}
      };
      for (const [slot, name, count] of list) put(slot, name, count);
      return arr;
    };
    const tiles = [];
    const full = loadWorldRec(SP.id) || rec;
    full.dimEnt = full.dimEnt || {};
    const st = full.dimEnt[1] = full.dimEnt[1] || {};
    st.tiles = st.tiles || [];
    for (const c of cities) {
      const t1 = { k: c.chest.x + "," + c.chest.y + "," + c.chest.z, type: "chest", items: mk([[4, "diamond", 3], [5, "emerald", 2], [12, "iron_ingot", 6], [13, "gold_ingot", 4], [14, "saddle", 1]]) };
      tiles.push({ t: t1, x: c.chest.x, y: c.chest.y, z: c.chest.z });
      st.tiles.push(t1);
      if (c.ship) {
        const t2 = { k: c.shipChest.x + "," + c.shipChest.y + "," + c.shipChest.z, type: "chest", items: mk([[4, "elytra", 1], [5, "diamond", 4], [13, "iron_ingot", 6]]) };
        tiles.push({ t: t2, x: c.shipChest.x, y: c.shipChest.y, z: c.shipChest.z });
        st.tiles.push(t2);
      }
    }
    full.endCitiesDoneV2 = true;
    full.svIds = 1194;
    saveWorldRec(SP.id, full);
    rec.endCitiesDoneV2 = true;
    rec.svIds = 1194;
    // already in the End: patch the live tile map too (idempotent)
    try {
      if ((SP.dim | 0) === 1) {
        const sv = globalThis.__mcSurvival;
        if (sv && sv.giveTile) {
          for (const e of tiles) {
            sv.giveTile(e.t.k, {
              type: "chest", x: e.x, y: e.y, z: e.z,
              items: e.t.items.map((s) => s ? { id: s.id, count: s.c | 0, nbt: null } : null),
              burn: 0, burnTotal: 0, cook: 0, xp: 0, lastOut: 0, fuel: 0, time: 0, ing: null, cd: 0, pow: false,
            });
          }
        }
      }
    } catch (e) {}
  } catch (e) {}
}
// Resolved from the live tables like portalStateFor, so the offsets below
// never hardcode state ids.
let ENDF = null;
function endFrameIds() {
  if (ENDF) return ENDF;
  try {
    for (const b of game.assets.data.blocks) {
      if (b && b.name === "end_portal_frame" && Array.isArray(b.states)) {
        const eyeI = b.states.findIndex((s) => s.name === "eye");
        let stride = 1;
        for (let i = eyeI + 1; i < b.states.length; i++) stride *= b.states[i].num_values;
        const face = b.states.find((s) => s.name === "facing");
        ENDF = { min: b.minStateId, stride, order: face && face.values ? face.values.slice() : ["north", "south", "west", "east"] };
        return ENDF;
      }
    }
  } catch (e) {}
  return null;
}
function endFrameState(facing, eye) {
  const E = endFrameIds();
  if (!E) return 0;
  let fi = E.order.indexOf(facing);
  if (fi < 0) fi = 0;
  return E.min + (eye ? E.stride : 0) + fi;
}
function endFrameEye(st) {
  const E = endFrameIds();
  if (!E) return false;
  return st >= E.min + E.stride && st < E.min + E.stride + E.order.length;
}

// Stronghold portal room (Phase A access path): one buried 13x11
// stone-brick room per hills world, found by walking a seed ray out from
// spawn until dry land. No corridors yet (Phase E) — the eye leads to the
// room column and the player digs down. 12-frame end ring with vanilla
// 10%-each pre-filled eyes; one loot chest (TEMP blaze-rod bridge until
// Phase E blazes — see the parity doc).
let SHC = { s: -1, t: "", sh: null };
function strongholdAt(seed, type) {
  if (type !== "hills") return null;
  if (SHC.s === (seed >>> 0) && SHC.t === type) return SHC.sh;
  let sh = null;
  try {
    const a0 = hash2(7, 13, seed ^ 0xE17) * Math.PI * 2;
    let D = 768 + ((hash2(29, 41, seed ^ 0xE17) * 512) | 0);
    for (let k = 0; k < 8 && !sh; k++) {
      const cx = Math.round(Math.cos(a0) * D), cz = Math.round(Math.sin(a0) * D);
      try {
        const ci = colInfo(cx, cz, seed, type);
        if (ci.h > SEA + 1 && ci.h < SEA + 24 && ci.b !== 4 && ci.b !== 5) {
          sh = { x: cx, z: cz, fy: clamp(Math.min(ci.h - 8, 40), 16, 44) };
        }
      } catch (e) {}
      D += 128;
    }
    if (!sh) sh = { x: Math.round(Math.cos(a0) * D), z: Math.round(Math.sin(a0) * D), fy: 32 };
  } catch (e) { sh = null; }
  SHC = { s: seed >>> 0, t: type, sh };
  return sh;
}
function strongholdBlock(x, y, z, seed, type, h) {
  if (type !== "hills") return null;
  const S = strongholdAt(seed, type);
  if (!S) return null;
  const dx = x - S.x, dz = z - S.z;
  if (dx < -6 || dx > 6 || dz < -5 || dz > 5) return null;
  if (y < S.fy || y > S.fy + 5) return null;
  const I = IDS;
  if (!I) return null;
  if (y === S.fy) return I.stone_bricks; // floor under the whole room
  const wall = dx === -6 || dx === 6 || dz === -5 || dz === 5;
  if (y >= S.fy + 2 && y <= S.fy + 4) return wall ? I.stone_bricks : 0;
  if (y === S.fy + 5) return I.stone_bricks; // ceiling
  if (wall) return I.stone_bricks;
  // y === S.fy + 1: portal ring, loot chest, carved room
  if (Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
    const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
    const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
    if (edge && !corner) {
      const facing = dz === -2 ? "south" : dz === 2 ? "north" : dx === -2 ? "east" : "west";
      const eye = hash2(S.x + dx, S.z + dz, (seed ^ 0xE9E5) | 0) < 0.10;
      return endFrameState(facing, eye);
    }
    if (!edge) {
      // interior: lit only when all 12 frames rolled eyes (vanilla)
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          const e2 = Math.abs(i) === 2 || Math.abs(j) === 2;
          const c2 = Math.abs(i) === 2 && Math.abs(j) === 2;
          if (e2 && !c2 && !(hash2(S.x + i, S.z + j, (seed ^ 0xE9E5) | 0) < 0.10)) return 0;
        }
      }
      return I.end_portal;
    }
    return 0; // ring corners stay carved air
  }
  if (dx === 5 && dz === 0) return I.chest || 0; // loot chest by the east wall
  return 0;
}

// nether_portal default state is axis=x (4000); axis=z is the next state.
function portalStateFor(axis) {
  try {
    if (!IDS || !IDS.nether_portal) return 0;
    if (axis === "z") {
      for (const b of game.assets.data.blocks) {
        if (b && b.name === "nether_portal" &&
            typeof b.maxStateId === "number" && b.maxStateId > b.defaultState) {
          return b.defaultState + 1;
        }
      }
    }
    return IDS.nether_portal;
  } catch (e) { return (IDS && IDS.nether_portal) || 0; }
}

// Per-seed salt cache for the genState ore/surface rolls: (seed ^ k) | 0
// is loop-invariant per chunk fill (384 x 256 blocks), so compute once.
// Values are identical to the inline expressions (same ops, same order).
let SALTC = { s: -1, v: null };
function genSalts(seed) {
  if (SALTC.s !== seed) {
    SALTC = {
      s: seed,
      sBlend: (seed ^ 0x57A7) | 0, sTuff: (seed ^ 0x7FF5) | 0,
      sEm: (seed ^ 0xE1E0) | 0, sDia: (seed ^ 0xD1A0) | 0,
      sRed: (seed ^ 0x2ED0) | 0, sLap: (seed ^ 0x1AB5) | 0,
      sGold: (seed ^ 0x601D) | 0, sCop: (seed ^ 0xC09E) | 0,
      sIrL: (seed ^ 0x120E) | 0, sIrH: (seed ^ 0x120F) | 0,
      sCoal: (seed ^ 0xC0A1) | 0, sClay4: (seed ^ 0xC1A7) | 0,
      sGrav: (seed ^ 0x90CC) | 0, sClay3: (seed ^ 0x5EED) | 0,
      sBush: (seed ^ 0xBD5A) | 0, sCane: (seed ^ 0xCA9E) | 0,
      sCaneH: (seed ^ 0xCA91) | 0, sTuft: (seed ^ 0xf10e5) | 0,
      sGeoL: (seed ^ 0x6E0A) | 0, sGeoB: (seed ^ 0x6E0B) | 0,
      sGeoD: (seed ^ 0x6E0C) | 0, sDripC: (seed ^ 0xD21A) | 0,
      sSpore: (seed ^ 0x5E02) | 0, sMossK: (seed ^ 0x4055) | 0,
      sMossC: (seed ^ 0x405C) | 0, sMoss: (seed ^ 0x4050) | 0,
      sMossP: (seed ^ 0x4059) | 0, sCavL: (seed ^ 0xCA1E) | 0,
      sCavD: (seed ^ 0xCA1D) | 0, sMud: (seed ^ 0x6D9D) | 0,
      sGrove: (seed ^ 0x62E0) | 0, sSculk: (seed ^ 0x5C07) | 0,
    };
  }
  return SALTC;
}
// Per-y ore thresholds: seed/x/z-independent, so precomputed once with the
// same expressions as the old inline formulas (bit-identical doubles).
// Range check folded in: every in-range threshold is strictly positive,
// so `T.* > 0` is exactly the old range test; out-of-range entries are 0.
const ORE_THR = (() => {
  const t = [];
  for (let y = -64; y <= 232; y++) {
    t[y + 64] = {
      d: (y <= 16 && y >= -64) ? 0.011 * (1 - (y + 64) / 90) : 0,
      r: (y <= 16 && y >= -64) ? 0.016 * (1 - (y + 64) / 84) : 0,
      l: (y <= 64 && y >= -64) ? 0.012 * (1 - Math.abs(y) / 72) : 0,
      g: (y <= 32 && y >= -64) ? 0.010 * (1 - Math.abs(y + 16) / 56) : 0,
      c: (y >= -16 && y <= 112) ? 0.020 * (1 - Math.abs(y - 48) / 68) : 0,
      i: (y >= -24 && y <= 56) ? 0.020 * (1 - Math.abs(y - 15) / 48) : 0,
      i2: (y > 56 && y <= 232) ? 0.008 * (y - 56) / 176 : 0,
      k: (y >= -32 && y <= 192) ? 0.025 * (1 - Math.abs(y - 96) / 134) : 0,
    };
  }
  return t;
})();

// pure function: what the generator wants at (x,y,z) — used both for
// filling chunks and for pruning redundant saved overrides. Emits NATIVE
// 1.18.2 states (IDS is resolved from the live 1.18.2 tables).
function genState(x, y, z, seed, type) {
  if (isVoxel(type)) {
    const g = voxelGen(seed);
    return g ? g.voxelStateAt(x, y, z) : 0;
  }
  if (!inY(y)) return 0;
  // Hot path first: hills/tectonic skip the per-block world-type dispatch
  // (fillBulk fixes the type per chunk; other callers route through here).
  if (type === "hills" || type === "tectonic") return genStateHill(x, y, z, seed, type, IDS);
  const I = IDS;
  if (type === "flat") {
    if (y === MIN_Y) return I.bedrock;
    if (y <= MIN_Y + 2) return I.dirt;
    if (y === MIN_Y + 3) return I.grass;
    return 0;
  }
  if (type === "void") {
    if (Math.abs(x) <= 8 && Math.abs(z) <= 8) {
      if (y === 59) return I.bedrock;
      if (y === 60) return I.stone;
    }
    return 0;
  }
  if (type === "oneblock") {
    if (x === 0 && z === 0 && y === 61) return I.grass;
    if (y === 60) {
      if (Math.abs(x) <= 3 && Math.abs(z) <= 3) {
        if (x === 0 && z === 0) return I.stone;
        return I.grass;
      }
      return 0;
    }
    if (y === 59) {
      if (Math.abs(x) <= 3 && Math.abs(z) <= 3) return I.dirt;
      return 0;
    }
    if (y === 58) {
      if (Math.abs(x) <= 2 && Math.abs(z) <= 2) return I.stone;
      return 0;
    }
    return 0;
  }
  // Any other (unknown) type fell through to the hills body before — keep
  // that exact behavior rather than returning air.
  return genStateHill(x, y, z, seed, type, IDS);
}
// Hills/tectonic column body: single source of truth for both the fill fast
/* ------------------------------------------------- monuments (v1.15.0 ocean) */
// Ocean monuments: deep-ocean palaces on a jittered lattice (cell 1024,
// ~40% of cells), tectonic-only. 41x41 footprint, prismarine walls just
// below the surface, dark-prismarine corners/pillars, sea-lantern accents,
// 4 wing rooms (one is the sponge room), a dark core with 8 gold blocks,
// and 3 fixed elder slots the sim seeds. Interior stays water (returned
// null falls through to the ocean fill) — vanilla monuments are wet too.
// Same purity contract as villages/mansions: layout derives from (seed,
// cell); blocks regenerate, player edits persist as overrides.
const O_CELL = 1024, O_HX = 20;
let OCACHE = { seed: -1, type: "", map: new Map() };
function monumentCenterOfCell(cx, cz, seed, type) {
  if (type !== "tectonic") return null;
  const oc = OCACHE;
  if (oc.seed !== (seed >>> 0) || oc.type !== type) { oc.seed = seed >>> 0; oc.type = type; oc.map = new Map(); }
  const key = cellKey(cx, cz);
  if (oc.map.has(key)) return oc.map.get(key);
  let out = null;
  if (hash2(cx, cz, (seed ^ 0x0CEA) | 0) < 0.40) {
    const jx = (hash2(cx, cz, (seed ^ 0x0EA1) | 0) - 0.5) * 768;
    const jz = (hash2(cx, cz, (seed ^ 0x0EA2) | 0) - 0.5) * 768;
    const x = Math.round(cx * O_CELL + O_CELL / 2 + jx);
    const z = Math.round(cz * O_CELL + O_CELL / 2 + jz);
    const h = groundHeight(x, z, seed, type);
    let ok = h < SEA - 6 && h > MIN_Y + 20;
    if (ok) {
      for (let ox = -20; ox <= 20 && ok; ox += 20) {
        for (let oz = -20; oz <= 20 && ok; oz += 20) {
          if (!ox && !oz) continue;
          if (groundHeight(x + ox, z + oz, seed, type) > SEA - 2) ok = false;
        }
      }
    }
    if (ok && SP && SP.active && SP.spawn) {
      const sx = x - SP.spawn.x, sz = z - SP.spawn.z;
      if (sx * sx + sz * sz < 256 * 256) ok = false;
    }
    if (ok) {
      const sw = Math.floor(hash2(cx, cz, (seed ^ 0x0EA3) | 0) * 4);
      out = { x, z, fy: h, sw, elders: [[0, 3, 0], [-12, 3, -12], [12, 3, 12]] };
    }
  }
  if (OCACHE.map.size > 256) OCACHE.map.delete(OCACHE.map.keys().next().value);
  OCACHE.map.set(key, out);
  return out;
}
let O_LAST = { x: 1e9, z: 1e9, s: -1, t: "", c: null };
function monumentAt(x, z, seed, type) {
  if (type !== "tectonic") return null;
  if (O_LAST.x === x && O_LAST.z === z && O_LAST.s === (seed >>> 0) && O_LAST.t === type) return O_LAST.c;
  const ccx = Math.floor(x / O_CELL), ccz = Math.floor(z / O_CELL);
  let found = null;
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = monumentCenterOfCell(ccx + ax, ccz + az, seed, type);
      if (!c) continue;
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) <= O_HX + 3 && Math.abs(dz) <= O_HX + 3) { found = c; break; }
    }
    if (found) break;
  }
  O_LAST = { x, z, s: seed >>> 0, t: type, c: found };
  return found;
}
function findMonumentNear(nx, nz, seed, type, maxR, budget) {
  if (type !== "tectonic") return null;
  maxR = maxR || 10000;
  budget = budget == null ? 40 : budget;
  const cells = Math.ceil(maxR / O_CELL) + 1;
  const ccx = Math.floor(nx / O_CELL), ccz = Math.floor(nz / O_CELL);
  let best = null, best2 = Infinity, spent = 0;
  for (let r = 0; r <= cells; r++) {
    for (let ax = -r; ax <= r; ax++) {
      for (let az = -r; az <= r; az++) {
        if (Math.max(Math.abs(ax), Math.abs(az)) !== r) continue;
        if (spent >= budget) { r = cells + 1; break; }
        spent++;
        const c = monumentCenterOfCell(ccx + ax, ccz + az, seed, type);
        if (!c) continue;
        const dx = c.x - nx, dz = c.z - nz;
        const d2 = dx * dx + dz * dz;
        if (d2 <= maxR * maxR && d2 < best2) { best2 = d2; best = c; }
      }
    }
  }
  return best ? { x: best.x, z: best.z, fy: best.fy } : null;
}
function monumentBlock(x, y, z, seed, type, h) {
  const c = monumentAt(x, z, seed, type);
  if (!c) return null;
  const I = IDS;
  if (!I) return null;
  const dx = x - c.x, dz = z - c.z;
  if (Math.abs(dx) > O_HX || Math.abs(dz) > O_HX) return null;
  const fy = c.fy;
  if (y < fy - 1) return null;
  if (y === fy - 1 || y === fy) return I.prismarine_bricks;
  const edgeX = Math.abs(dx) === O_HX, edgeZ = Math.abs(dz) === O_HX;
  if (edgeX || edgeZ) {
    if (y > SEA - 2) return null;
    if (edgeZ && dz === O_HX && Math.abs(dx) <= 2 && y <= fy + 5) return null;
    if (edgeX && edgeZ) return I.dark_prismarine;
    if (y === SEA - 2 && (((x + z) % 5 + 5) % 5) === 0) return I.sea_lantern;
    return I.prismarine;
  }
  if (Math.abs(dx) === 10 && Math.abs(dz) === 10) {
    if (y > SEA - 3) return null;
    if (y === SEA - 3) return I.sea_lantern;
    return I.dark_prismarine;
  }
  const wings = [[-12, -12], [12, -12], [-12, 12], [12, 12]];
  for (let w = 0; w < 4; w++) {
    const ldx = dx - wings[w][0], ldz = dz - wings[w][1];
    if (Math.abs(ldx) > 3 || Math.abs(ldz) > 3) continue;
    if (Math.abs(ldx) === 3 || Math.abs(ldz) === 3) {
      if (y < fy + 1 || y > fy + 5) return null;
      return I.dark_prismarine;
    }
    if (w === c.sw && Math.abs(ldx) <= 1 && Math.abs(ldz) <= 1 && y >= fy + 1 && y <= fy + 2) return I.sponge;
    if (ldx === 0 && ldz === 0 && y === fy + 6) return I.sea_lantern;
    return null;
  }
  if (Math.abs(dx) <= 4 && Math.abs(dz) <= 4) {
    if (Math.abs(dx) === 4 || Math.abs(dz) === 4) {
      if (y < fy + 1 || y > fy + 7) return null;
      return I.dark_prismarine;
    }
    if (y === fy + 1 && ((Math.abs(dx) === 1 && Math.abs(dz) === 2) || (Math.abs(dx) === 2 && Math.abs(dz) === 1))) return I.gold_block;
    if (y === fy + 2 && dx === 0 && dz === 0) return I.sea_lantern;
    return null;
  }
  return null;
}
/* ------------------------------------------------- v1.15.0 underground */
// Data-driven state-id resolver with the engine's canonical codec (mirrors
// survival.js stWith: FIRST property varies slowest, bool order is
// ["true","false"] — verified against the live tables, e.g. bud default).
// Falls back to the block's own default combo for unmentioned props, and to
// 0 (air — a safe invisible gap, never a crash) when the tables lack the
// block. Resolved from the LIVE 1.18 tables, so no hardcoded state ids.
let STLAY = {};
function stLayout(name) {
  if (name in STLAY) return STLAY[name];
  let out = null;
  try {
    for (const b of game.assets.data.blocks) {
      if (b && b.name === name && Array.isArray(b.states)) {
        const props = [];
        for (const p of b.states) {
          let vals = p.values;
          if (!vals) {
            if (p.type === "bool") vals = ["true", "false"];
            else if (p.type === "int") { vals = []; for (let i = 0; i < (p.num_values | 0); i++) vals.push(String(i)); }
          }
          props.push({ name: p.name, vals: (vals || []).map(String) });
        }
        let off = (b.defaultState | 0) - (b.minStateId | 0);
        const defVals = {};
        for (let i = props.length - 1; i >= 0; i--) {
          const n = props[i].vals.length || 1;
          defVals[props[i].name] = props[i].vals[(((off % n) + n) % n)];
          off = Math.floor(off / n);
        }
        out = { min: b.minStateId | 0, props, defVals };
        break;
      }
    }
  } catch (e) {}
  STLAY[name] = out;
  return out;
}
function stStateFor(name, want) {
  const L = stLayout(name);
  if (!L) return 0;
  let off = 0;
  for (const pr of L.props) {
    const w = want && want[pr.name] !== undefined ? String(want[pr.name]) : L.defVals[pr.name];
    let vi = pr.vals.indexOf(w);
    if (vi < 0) vi = 0;
    off = off * pr.vals.length + vi;
  }
  return L.min + off;
}
function budStage(h) {
  return h < 0.30 ? "small_amethyst_bud" : h < 0.55 ? "medium_amethyst_bud" :
    h < 0.75 ? "large_amethyst_bud" : "amethyst_cluster";
}
// Light carve predicate (no structures/decor/ores — just the router field),
// so cave-decor rules can test NEIGHBOR cells without recursing into the
// full genStateHill (which would chain upward unboundedly). The carve branch
// below uses this same predicate, so the two can never diverge.
function carveOpen(x, y, z, seed, type, h) {
  return type === "tectonic" && y < h && y > MIN_Y + 1 &&
    tectonicState(seed >>> 0).finalDensity.sign(x, y, z) <= 0;
}
// Underground biome blobs (0 none, 1 lush, 2 dripstone): coarse fbm on
// diagonal slices so the blobs vary with depth too, gated to vanilla-ish y
// bands. Only evaluated for hash-gated candidate cells, never per block.
function caveBiome(x, y, z, seed) {
  if (y > 32 || y < -64) return 0;
  let bl = -2, bd = -2;
  if (y <= 24 && y >= -48)
    bl = fbm(x * 0.006 + 11.3, (z + y) * 0.006 + 7.1, (seed ^ 0xCA1E) | 0, 3) - 0.62;
  if (y <= 16 && y >= -64)
    bd = fbm(x * 0.007 - 5.9 + y * 0.002, (z - y) * 0.007 + 3.7, (seed ^ 0xCA1D) | 0, 3) - 0.60;
  if (bl < 0 && bd < 0) return 0;
  return bl >= bd ? 1 : 2;
}
// Amethyst geodes: one rare jittered lattice (cell 192, ~30% of cells),
// centers y -54..29, radius 4..6, buried only (rejected when the crown
// would poke above the surface). Vanilla order: generated into already
// carved terrain, so shells stay intact where caves cut through. Shell:
// smooth basalt / calcite / amethyst ring (8% budding); hollow interior
// with buds on shell-adjacent faces (floor/up, ceiling/down, else walls).
const G_CELL = 192;
let GCACHE = { s: -1, map: new Map() };
function geodeCenterOfCell(cx, cz, seed) {
  const s = seed >>> 0;
  if (GCACHE.s !== s) GCACHE = { s, map: new Map() };
  const key = cellKey(cx, cz);
  const hit = GCACHE.map.get(key);
  if (hit !== undefined) return hit;
  let out = null;
  if (hash2(cx, cz, (seed ^ 0x6E0D) | 0) < 0.30) {
    const x = Math.round(cx * G_CELL + G_CELL / 2 + (hash2(cx, cz, (seed ^ 0x6E01) | 0) - 0.5) * 152);
    const z = Math.round(cz * G_CELL + G_CELL / 2 + (hash2(cx, cz, (seed ^ 0x6E02) | 0) - 0.5) * 152);
    const y = -54 + Math.floor(hash2(cx, cz, (seed ^ 0x6E03) | 0) * 84);
    const r = 4 + Math.floor(hash2(cx, cz, (seed ^ 0x6E04) | 0) * 3);
    try { if (groundHeight(x, z, seed, "tectonic") > y + r + 1) out = { x, y, z, r }; } catch (e) {}
  }
  if (GCACHE.map.size > 256) GCACHE.map.delete(GCACHE.map.keys().next().value);
  GCACHE.map.set(key, out);
  return out;
}
// 0 = outside this geode, 3/2/1 = basalt/calcite/amethyst shell, -1 interior.
function geodeShell(x, y, z, c, seed) {
  const dx = x - c.x, dy = y - c.y, dz = z - c.z, rr = c.r + 2;
  if (dx > rr || dx < -rr || dy > rr || dy < -rr || dz > rr || dz < -rr) return 0;
  const S = genSalts(seed);
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + (hash3(x, y, z, S.sGeoL) - 0.5) * 2;
  if (d > c.r + 1.5) return 0;
  if (d > c.r - 0.5) return 3;
  if (d > c.r - 2) return 2;
  if (d > c.r - 3) return 1;
  return -1;
}
function geodeAt(x, y, z, seed) {
  const ccx = Math.floor(x / G_CELL), ccz = Math.floor(z / G_CELL);
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const c = geodeCenterOfCell(ccx + ax, ccz + az, seed);
      if (c && Math.abs(x - c.x) <= c.r + 2 && Math.abs(y - c.y) <= c.r + 2 && Math.abs(z - c.z) <= c.r + 2) return c;
    }
  }
  return null;
}
function geodeBlock(x, y, z, seed, type, I) {
  if (type !== "tectonic" || y > 40 || y < MIN_Y + 3) return null;
  const c = geodeAt(x, y, z, seed);
  if (!c) return null;
  const L = geodeShell(x, y, z, c, seed);
  if (L === 0) return null;
  if (L === 3) return I.smooth_basalt;
  if (L === 2) return I.calcite;
  if (L === 1) {
    const S = genSalts(seed);
    return hash3(x, y, z, S.sGeoB) < 0.08 ? I.budding_amethyst : I.amethyst_block;
  }
  const S = genSalts(seed);
  const bh = hash3(x, y, z, S.sGeoD);
  if (geodeShell(x, y - 1, z, c, seed) > 0) {
    if (bh < 0.22) return stStateFor(budStage(hash3(x, y, z, (seed ^ 0x6E05) | 0)), { facing: "up" });
  } else if (geodeShell(x, y + 1, z, c, seed) > 0) {
    if (bh < 0.16) return stStateFor(budStage(hash3(x, y, z, (seed ^ 0x6E06) | 0)), { facing: "down" });
  } else if (bh < 0.15) {
    const w = hash3(x, y, z, (seed ^ 0x6E07) | 0);
    if (geodeShell(x - 1, y, z, c, seed) > 0) return stStateFor(budStage(w), { facing: "east" });
    if (geodeShell(x + 1, y, z, c, seed) > 0) return stStateFor(budStage(w), { facing: "west" });
    if (geodeShell(x, y, z - 1, c, seed) > 0) return stStateFor(budStage(w), { facing: "south" });
    if (geodeShell(x, y, z + 1, c, seed) > 0) return stStateFor(budStage(w), { facing: "north" });
  }
  return 0;
}
// Lush floor kind at a ROCK cell: -1 none, 0 moss, 1 clay, 2 rooted dirt.
// Shared by the rock body and the carpet rule in the air cell above it.
function lushFloorKind(x, y, z, seed, type, S, h) {
  if (y > 24 || y < -48) return -1;
  if (hash2(x, z, S.sMossC) >= 0.10) return -1;
  if (!carveOpen(x, y + 1, z, seed, type, h)) return -1;
  if (caveBiome(x, y, z, seed) !== 1) return -1;
  if (hash2(x >> 2, z >> 2, S.sMossP) < 0.30) return 1;
  return hash3(x, y, z, S.sMoss) < 0.10 ? 2 : 0;
}
// path and the genState() dispatcher above, so the two can never diverge.
// y is always in [MIN_Y, MAX_Y+1) here (fillBulk's range; the dispatcher
// checks inY), hence no range check, and y + 64 always indexes ORE_THR
// when y <= 232. Output is bit-identical to the old inline body.
function genStateHill(x, y, z, seed, type, I) {
  // One persistent-cache lookup per block: tree/structure/cactus records.
  // PR.v/PR.s gate the structure stamps (identical to the stamps' own
  // null checks, but skips their per-block function-call chains).
  // (genCol is 1-entry: the y-walk hits the same column 384 times, so the
  // colInfo + pccRec pair costs ~one lookup per column, not per block.)
  const S = genSalts(seed);
  const gc = genCol(x, z, seed, type);
  const ci = gc.ci, PR = gc.PR, h = gc.h, B = gc.B;
  if (SP.structures !== false) {
    if (PR.v) {
      const vs = villageBlock(x, y, z, seed, type, h);
      if (vs != null) return vs;
    }
    if (PR.mo) {
      const ms = mansionBlock(x, y, z, seed, type, h);
      if (ms != null) return ms;
    }
    if (PR.s) {
      const ss = strongholdBlock(x, y, z, seed, type, h);
      if (ss != null) return ss;
    }
    if (PR.mn) {
      const mb = monumentBlock(x, y, z, seed, type, h);
      if (mb != null) return mb;
    }
  }
  if (y === MIN_Y) return I.bedrock;
  if (y === MIN_Y + 1 && hash3(x, y, z, seed) < 0.5) return I.bedrock;
  // Tectonic cave carving (v1.15.0): the router's final_density already
  // contains the spaghetti/noodle/cheese fields, so a per-block sign() test
  // below the surface opens exactly the caves the data describes (sign() is
  // proven to agree with compute(); Interpolated corners stay cached across
  // the chunk fill). Flooded at/below sea level like the ocean fill; deep
  // caves stay dry (no aquifer pass yet). The bedrock floor above is
  // untouched, structures return before this, hills never reaches here.
  // v1.15.0 geodes: generated into already-carved terrain (vanilla order),
  // so shells stay intact where caves cut through. Overwrites rock AND cave
  // air/water; bedrock already returned above, structures before that.
  if (type === "tectonic") {
    const gd = geodeBlock(x, y, z, seed, type, I);
    if (gd != null) return gd;
  }
  if (carveOpen(x, y, z, seed, type, h)) {
    // Cave decor (dripstone / lush ceiling bits). No aquifer pass yet, so the
    // flood rule is surface-based: caves under the ocean flood, caves under
    // land stay dry and walkable (vanilla's aquifers leave many deep caves
    // dry too). Hash-gated first, then at most two light neighbor reads (no
    // genStateHill recursion).
    if (y < 32 && hash3(x, y, z, S.sDripC) < 0.06) {
      const cb = caveBiome(x, y, z, seed);
      if (cb === 2) {
        if (y + 1 <= h && !carveOpen(x, y + 1, z, seed, type, h)) {
          const belowOpen = y - 1 > MIN_Y + 1 && carveOpen(x, y - 1, z, seed, type, h);
          return stStateFor("pointed_dripstone", { thickness: belowOpen ? "frustum" : "tip", vertical_direction: "down" });
        }
        if (y - 1 > MIN_Y + 1 && !carveOpen(x, y - 1, z, seed, type, h))
          return stStateFor("pointed_dripstone", { thickness: "tip", vertical_direction: "up" });
      } else if (cb === 1) {
        if (y + 1 <= h && !carveOpen(x, y + 1, z, seed, type, h) && hash3(x, y, z, S.sSpore) < 0.12)
          return I.spore_blossom;
        if (y - 1 > MIN_Y + 1 && !carveOpen(x, y - 1, z, seed, type, h) &&
            lushFloorKind(x, y - 1, z, seed, type, S, h) === 0 && hash3(x, y, z, S.sMossK) < 0.5)
          return I.moss_carpet;
      }
    }
    // P4: sculk patches live BELOW the carve branch now (solid cells only —
    // see the block after the carve close). Spore/drip decor above keeps
    // priority (separate branches), sculk takes the fallthrough.
    if (y <= SEA) return h < SEA ? I.water : 0;
    return 0;
  }
  // P4: sculk patches in deep dry caves (vanilla deep dark, hash-region
  // approximation: 4-block regions at y<-16 hold sculk blobs; functional
  // blocks sprinkle on floors, veins crust the walls). SOLID cells only —
  // the carve branch above already returned for open cells, so reaching here
  // means this cell is rock. (Spore/drip decor above keeps priority: it
  // returned inside the carve branch.)
  if (type === "tectonic" && I.sculk && y < -16 && y > MIN_Y + 1 &&
      hash2(x >> 2, z >> 2, S.sSculk) < 0.10 && hash3(x, y, z, S.sSculk) < 0.30) {
    const belowOpen = y - 1 > MIN_Y + 1 ? carveOpen(x, y - 1, z, seed, type, h) : false;
    const aboveOpen = y + 1 > h || carveOpen(x, y + 1, z, seed, type, h);
    if (!belowOpen && aboveOpen) {
      const sr = hash3(x, y + 7, z, S.sSculk);
      if (sr < 0.012 && I.sculk_shrieker) return I.sculk_shrieker;
      if (sr < 0.030 && I.sculk_sensor) return I.sculk_sensor;
      if (sr < 0.042 && I.sculk_catalyst) return I.sculk_catalyst;
      return I.sculk;
    }
    if (I.sculk_vein && hash3(x + 3, y, z - 5, S.sSculk) < 0.10) {
      if (carveOpen(x + 1, y, z, seed, type, h) || carveOpen(x - 1, y, z, seed, type, h) ||
          carveOpen(x, y, z + 1, seed, type, h) || carveOpen(x, y, z - 1, seed, type, h))
        return I.sculk_vein;
    }
  }
  // rare surface lava pits on dry land (vanilla has them; they are the
  // survival path to obsidian: water bucket + lava -> obsidian). Kept out
  // of villages and shorelines so paths/farms never flood.
  // Rolled once per column in colInfo (ci.lp) — identical inputs.
  const lavaPit = ci.lp === 1;
  if (y <= h) {
    if (y === h) {
      if (lavaPit) return I.lava;
      if (B === 4) return hash2(x, z, S.sClay4) < 0.2 ? I.clay : I.dirt;
      if (B === 5) return I.sand;
      if (B === 6 || B === 1) return I.sand;
      if (B === 8) return hash2(x, z, S.sGrav) < 0.3 ? I.gravel : I.stone;
      if (B === 3) {
        // swamp (P4): wettest spots go muddy (new salt, so the old
        // clay/grass boundary is untouched where mud doesn't take over).
        if (hash2(x, z, S.sMud) < 0.18) return I.mud;
        return hash2(x, z, S.sClay3) < 0.25 ? I.clay : I.grass;
      }
      if (h <= SEA + 1) return I.sand;
      return I.grass;
    }
    if (y >= h - 2) {
      if (lavaPit) return I.lava; // 3-deep lava pit (surface + 2 below)
      if (B === 1) return y === h - 2 ? I.sandstone : I.sand;
      if (B === 4 || B === 5) return I.dirt;
      if (B === 8) return I.stone;
      if (h <= SEA + 1) return I.sand;
      return I.dirt;
    }
    // 1.18 base rock: stone blends to deepslate across y=0..-8 (vanilla),
    // with rare tuff blobs deep down. Ore variants follow the base rock.
    let base = I.stone;
    if (y < 0) {
      base = I.deepslate;
      if (y >= -8 && hash3(x, y, z, S.sBlend) < (y + 8) / 8) base = I.stone;
    }
    if (y < 16 && y >= -64 && hash3(x, y, z, S.sTuff) < 0.003) return I.tuff;
    const dv = (base === I.deepslate);
    // 1.18 depth bands (per-block triangle approximations, rarest first).
    // Emerald: mountain (rock biome) only, increasing with height.
    if (B === 8 && y >= -16 && hash3(x, y, z, S.sEm) < 0.004) return dv ? I.deepslate_emerald_ore : I.emerald_ore;
    // Thresholds T.* are the same per-y formulas precomputed (range check
    // folded in: every in-range threshold is strictly positive, so T.* > 0
    // is exactly the old range test).
    if (y <= 232) {
      const T = ORE_THR[y + 64];
      // Diamond: y -64..16, peaking at the floor.
      if (T.d > 0 && hash3(x, y, z, S.sDia) < T.d) return dv ? I.deepslate_diamond_ore : I.diamond_ore;
      // Redstone: y -64..16, increasing downward.
      if (T.r > 0 && hash3(x, y, z, S.sRed) < T.r) return dv ? I.deepslate_redstone_ore : I.redstone_ore;
      // Lapis: y -64..64, peaking at 0.
      if (T.l > 0 && hash3(x, y, z, S.sLap) < T.l) return dv ? I.deepslate_lapis_ore : I.lapis_ore;
      // Gold: y -64..32, peaking at -16.
      if (T.g > 0 && hash3(x, y, z, S.sGold) < T.g) return dv ? I.deepslate_gold_ore : I.gold_ore;
      // Copper: y -16..112, peaking at 48.
      if (T.c > 0 && hash3(x, y, z, S.sCop) < T.c) return dv ? I.deepslate_copper_ore : I.copper_ore;
      // Iron: y -24..56 peaking at 15, plus a rich high band rising to the peaks.
      if (T.i > 0 && hash3(x, y, z, S.sIrL) < T.i) return dv ? I.deepslate_iron_ore : I.iron_ore;
      if (T.i2 > 0 && hash3(x, y, z, S.sIrH) < T.i2) return I.iron_ore;
      // Coal: y -32..192, peaking at 96.
      if (T.k > 0 && hash3(x, y, z, S.sCoal) < T.k) return dv ? I.deepslate_coal_ore : I.coal_ore;
    }
    // v1.15.0 lush floors: moss/clay/rooted dirt over rock with cave air
    // above (ore rolls above keep priority — moss only takes the no-ore
    // fallthrough, so lush zones keep their ores).
    const lk = lushFloorKind(x, y, z, seed, type, S, h);
    if (lk === 0) return I.moss_block;
    if (lk === 1) return I.clay;
    if (lk === 2) return I.rooted_dirt;
    return base;
  }
  if (y <= SEA && h < SEA) return ci.c ? I.ice : I.water;
  if (B === 1) {
    // PR.cu is the cactusAt value (height or 0) — identical inputs.
    if (PR.cu > 0 && y > h && y <= h + PR.cu) return I.cactus;
    if (y === h + 1 && hash2(x * 3 - 5, z * 3 + 9, S.sBush) < 0.03) return I.dead_bush;
  }
  if (y > h && y <= h + 3 && h === SEA + 1 && !ci.c && B !== 1 &&
      hash2(x, z, S.sCane) < 0.04) {
    const chh = 2 + Math.floor(hash2(x, z, S.sCaneH) * 2);
    if (y <= h + chh) return I.sugar_cane;
  }
  const tr = PR.tr;
  if (tr) {
    if (y > h && y <= h + tr.th) {
      return tr.wood === 1 ? I.jungle_log : tr.wood === 2 ? I.spruce_log : tr.wood === 3 ? I.cherry_log : I.log;
    }
  }
  if (y > h && y <= h + 8) {
    // trunk list in leaf-loop order (same trunks, same order, same
    // winner as the live 5x5 search), built once per column.
    if (PR.tl === undefined) PR.tl = pccTrunkList(x, z, seed, type);
    const tl = PR.tl;
    for (let i = 0; i < tl.length; i += 3) {
      const ntr = tl[i], tx = x + tl[i + 1], tz = z + tl[i + 2];
      const top = ntr.h + ntr.th;
      const dy = y - top;
      const adx = tl[i + 1] < 0 ? -tl[i + 1] : tl[i + 1], adz = tl[i + 2] < 0 ? -tl[i + 2] : tl[i + 2];
      if (dy <= 0 && dy >= -2) {
        const rad = dy === 0 || dy === -1 ? 2 : 1;
        if (adx <= rad && adz <= rad && !(adx === rad && adz === rad && hash3(x, y, z, seed) < 0.5)) {
          if (!(adx === 0 && adz === 0)) {
            return ntr.wood === 1 ? I.jungle_leaves : ntr.wood === 2 ? I.spruce_leaves : ntr.wood === 3 ? I.cherry_leaves : I.leaves;
          }
        }
      } else if (dy === 1) {
        if (adx + adz <= 1 && !(adx === 0 && adz === 0)) {
          return ntr.wood === 1 ? I.jungle_leaves : ntr.wood === 2 ? I.spruce_leaves : ntr.wood === 3 ? I.cherry_leaves : I.leaves;
        }
      }
    }
    // groundHeight(x,z) is pure but NOT always === h: river carving in
    // colInfo lowers h without changing groundHeight, and the original
    // check skips tufts there. PR.gh is that same pure value, memoized.
    if (y === h + 1 && PR.gh === h) {
      if (ci.c && h >= SEA) return I.snow;
      if (B === 1) return 0;
      // (no tufts/flowers inside villages: they would poke through paths)
      if (SP.structures !== false && villageClearAt(x, z, seed, type)) return 0;
      if (mansionClearAt(x, z, seed, type)) return 0;
      const r = hash2(x * 3 + 11, z * 3 - 7, S.sTuft);
      // meadow (P4): vanilla's flowery high pastures — dense tall grass and
      // a six-flower mix (cornflower/azure_bluet/allium resolve to 0 when
      // absent, guarded). Skip table order mirrors rarity: common first.
      if (B === 9) {
        if (r < 0.060) return I.tallgrass;
        if (r < 0.080) return I.yellow_flower;
        if (r < 0.100) return I.red_flower;
        if (r < 0.115 && I.cornflower) return I.cornflower;
        if (r < 0.130 && I.azure_bluet) return I.azure_bluet;
        if (r < 0.140 && I.allium) return I.allium;
        // P4: pink petals carpet cherry groves (same grove gate as trees).
        if (r < 0.160 && I.pink_petals && hash2(x, z, (seed ^ 0x62E0) | 0) < 0.35) return I.pink_petals;
        return 0;
      }
      if (r < 0.035) return I.tallgrass;
      if (r < 0.043) return I.yellow_flower;
      if (r < 0.051) return I.red_flower;
    }
  }
  return 0;
}

/* ---------------------------------------------------------- chunk gen */

// hills custom biome ids (colInfo b) -> vanilla 1.15 registry ids, so the
// engine's tint/weather systems see real biomes (desert sand tint + no
// rain, jungle greens, snowy tint + snowfall, ocean water color...).
// b=9 meadow (P4, tectonic-only) maps to engine plains (1): 1.18 meadows
// have no 1.15 registry id, and plains is the closest wire biome (same rain,
// near-identical grass tint). F3 shows Plains; biomeAt says meadow.
const HILLS_BIOME_IDS = [1, 2, 21, 6, 0, 7, 16, 12, 3, 1];
export { HILLS_BIOME_IDS };
// 2.0.0 prep: set once the registry check has seen the survival tables
// (boot runs before survival loads, so playWorldInner completes it).
let registrySimDone = false;
function fillBiomes(cx, cz, seed, type, dim) {
  const w = game.world;
  const c = w.getChunk(cx, cz);
  if (!c || !c.biomes) return;
  if (dim === -1) { if (c.biomes.fill) c.biomes.fill(8); return; }
  if (dim === 1) { if (c.biomes.fill) c.biomes.fill(9); return; }
  if (type !== "hills" && type !== "tectonic") { if (c.biomes.fill) c.biomes.fill(1); return; }
  const pre = cx * 16, prz = cz * 16;
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      c.biomes[(lz << 4) | lx] = HILLS_BIOME_IDS[colInfo(pre + lx, prz + lz, seed, type).b] || 1;
    }
  }
}

// Create an empty chunk through the same loadChunk path the network uses,
// then fill via setState. 1.15.2 loadChunk(x,z,groundUp,bitMap,data,offset,
// skyLight) keeps the old positional signature; bitMap 0 = all-air.
function ensureShell(cx, cz) {
  const w = game.world;
  try {
    const have = w.getChunk(cx, cz);
    if (have) return have;
  } catch (e) {}
  try {
    w.loadChunk(cx, cz, true, 0, new Uint8Array(0), 0, w.hasSky);
  } catch (e) {
    return null;
  }
  try {
    const ch = w.getChunk(cx, cz);
    if (ch && ch.biomes && ch.biomes.fill) ch.biomes.fill(1); // plains tint
    return ch || null;
  } catch (e) {
    return null;
  }
}

// dimension helpers: chunk sets + override maps are per-dimension so the
// three worlds never clobber each other (same "x,y,z" key space).
// Exact numeric chunk key (|chunk| <= 2^21, i.e. +-33M blocks).
function chunkKey(cx, cz) { return (cx + 2097152) * 4194304 + (cz + 2097152); }
function genSetFor(dim) { return dim === -1 ? SP.genN : dim === 1 ? SP.genE : SP.generated; }
function ovMapFor(dim) { return dim === -1 ? SP.nether : dim === 1 ? SP.end : SP.overrides; }
// world.clear() (dimension switches, entries) wipes chunks but not our
// filled-sets — without this, ensureArea would skip the wiped chunks and
// leave permanent hollow shells (found live: portal chunk emptied itself).
function noteCleared() { SP.clearEpoch++; }
function syncGenEpoch() {
  const k = SP.dim === -1 ? "N" : SP.dim === 1 ? "E" : "0";
  if (SP["epoch" + k] !== SP.clearEpoch) {
    genSetFor(SP.dim).clear();
    SP["epoch" + k] = SP.clearEpoch;
  }
}
// what the generator wants at (x,y,z) in a dimension — for filling chunks
// and for pruning redundant saved overrides.
function genWant(x, y, z, seed, type, dim) {
  if (dim === -1) return netherState(x, y, z, seed);
  if (dim === 1) return endState(x, y, z, seed);
  return genState(x, y, z, seed, type);
}
// surface Y for portal generation: overworld hills height, nether ground,
// End island top (unused — End arrivals use the fixed platform).
function surfaceY(x, z, seed, type, dim) {
  if (dim === -1) return netherGround(x, z, seed);
  if (dim === 1) return 64;
  if (type === "flat") return MIN_Y + 3;
  if (type === "void" || type === "oneblock") return 60;
  if (type !== "hills" && type !== "tectonic") return 64;
  return groundHeight(x, z, seed, type);
}

function applyOverrides(cx, cz) {
  // chunk-indexed override application: the maps are world-global, so a
  // naive per-fill scan is O(edits) per chunk (a death spiral in
  // long-played worlds). The index rebuilds only when its map changed
  // (version bumped at every mutation site), so streaming reuses it.
  const keys = ovIdxFor(SP.dim).get(cx + ',' + cz);
  if (!keys || !keys.length) return;
  const w = game.world;
  const pre = cx * 16, prz = cz * 16;
  const ov = ovMapFor(SP.dim);
  // generator writes: survival must not treat these as player edits
  // (break tracking, lava mixing, frame normalization would corrupt them —
  // found live: chunk re-fill normalized eyed portal frames back to eyeless).
  SP.gen = true;
  try {
    for (const k of keys) {
      if (!(k in ov)) continue;
      const c = k.split(",");
      if (c.length !== 3) continue;
      const x = +c[0], y = +c[1], z = +c[2];
      if (x >= pre && x < pre + 16 && z >= prz && z < prz + 16) {
        w.setState(x, y, z, ov[k] | 0);
      }
    }
  } finally {
    SP.gen = false;
  }
}

// edit-versioned chunk index over one dim's override map ("cx,cz" -> keys).
function ovIdxFor(dim) {
  const tag = dim === -1 ? 'N' : dim === 1 ? 'E' : '0';
  const ver = SP['ovVer' + tag] | 0;
  let rec = SP['ovIdx' + tag];
  if (rec && rec.ver === ver) return rec.map;
  const map = new Map();
  const ov = ovMapFor(dim);
  for (const k in ov) {
    const a = k.indexOf(','), b = a >= 0 ? k.indexOf(',', a + 1) : -1;
    if (a < 0 || b < 0) continue;
    const ck = ((+k.slice(0, a)) >> 4) + ',' + ((+k.slice(b + 1)) >> 4);
    let arr = map.get(ck);
    if (!arr) map.set(ck, arr = []);
    arr.push(k);
  }
  SP['ovIdx' + tag] = rec = { ver, map };
  return map;
}

// bump after ANY mutation of a dim's override map (add/delete/replace).
function bumpOvVer(dim) {
  const tag = dim === -1 ? 'N' : dim === 1 ? 'E' : '0';
  try { SP['ovVer' + tag] = (SP['ovVer' + tag] | 0) + 1; } catch (e) {}
}

// scratch buffer for voxel chunk fills (generate() -> fillBulk). Fill-local
// use only: fillChunkVoxel runs synchronously, no reentrancy.
const VOX_BUF = new Uint32Array(16 * 128 * 16);

function fillChunkVoxel(cx, cz) {
  const w = game.world;
  const g = voxelGen(SP.seed);
  if (!g) return false;
  if (!ensureShell(cx, cz)) return false;
  // column-wise chunk fill (surface/trees/decor once per column) instead
  // of voxelStateAt per block (~30-200x faster when cold; verified output-
  // identical over a full chunk: 0 diffs in 32768 voxels).
  VOX_BUF.fill(0);
  const ox = cx * 16, oz = cz * 16;
  g.generate(cx, cz, {
    get(x, y, z) {
      const lx = x - ox, lz = z - oz;
      if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < 0 || y >= 128) return 0;
      return VOX_BUF[(y * 16 + lz) * 16 + lx];
    },
    set(x, y, z, s) {
      const lx = x - ox, lz = z - oz;
      if (lx < 0 || lx >= 16 || lz < 0 || lz >= 16 || y < 0 || y >= 128) return;
      VOX_BUF[(y * 16 + lz) * 16 + lx] = s;
    },
  });
  SP.gen = true;
  try {
    // Voxel (Terralith) worlds keep their own 0..127 column space: VOX_BUF
    // and the voxel generator are untouched, so fill only that band.
    w.fillBulk(cx, cz, 0, 128, (x, y, z) => VOX_BUF[((y * 16 + (z - oz)) * 16 + (x - ox))]);
  } finally {
    SP.gen = false;
  }
  fillBiomes(cx, cz, SP.seed, SP.type, SP.dim);
  applyOverrides(cx, cz);
  genSetFor(SP.dim).add(chunkKey(cx, cz));
  return true;
}

function fillChunk(cx, cz) {
  if (isVoxel(SP.type)) return fillChunkVoxel(cx, cz);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) ensureShell(cx + ox, cz + oz);
  }
  if (!ensureShell(cx, cz)) return false;
  const w = game.world;
  const seed = SP.seed, type = SP.type, dim = SP.dim;
  SP.gen = true;
  try {
    // Hot path: overworld hills/tectonic fix the world type and y-range for
    // the whole chunk, so the per-block type dispatch and inY check are
    // hoisted out of the ~98k-callback loop. genStateHill is the same body
    // the genState() dispatcher routes to — identical output by construction.
    const hillFill = dim === 0 && (type === "hills" || type === "tectonic");
    const Ih = hillFill ? IDS : null;
    w.fillBulk(cx, cz, MIN_Y, MAX_Y + 1, hillFill
      ? (x, y, z) => genStateHill(x, y, z, seed, type, Ih)
      : (x, y, z) => genWant(x, y, z, seed, type, dim));
  } finally {
    SP.gen = false;
  }
  fillBiomes(cx, cz, seed, type, dim);
  applyOverrides(cx, cz);
  genSetFor(SP.dim).add(chunkKey(cx, cz));
  return true;
}

function ensureArea(ccx, ccz, radius, budget) {
  syncGenEpoch();
  const gs = genSetFor(SP.dim);
  const missing = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const cx = ccx + dx, cz = ccz + dz;
      if (!gs.has(chunkKey(cx, cz))) missing.push([dx * dx + dz * dz, cx, cz]);
    }
  }
  missing.sort((a, b) => a[0] - b[0]);
  // budget: null = fill all (world entry); a number = max chunks; a
  // {ms} object = time budget (nearest-first, at least 1 chunk, so the
  // main thread is never hogged by streaming while exploring).
  let n = missing.length, t0 = 0;
  if (budget != null) {
    if (typeof budget === 'object') {
      t0 = performance.now();
      n = 0;
      const ms = budget.ms | 0;
      for (; n < missing.length; n++) {
        if (n > 0 && performance.now() - t0 >= ms) break;
        fillChunk(missing[n][1], missing[n][2]);
      }
      return missing.length - n;
    }
    n = Math.min(budget, missing.length);
  }
  for (let i = 0; i < n; i++) fillChunk(missing[i][1], missing[i][2]);
  return missing.length - n;
}

function genRadius() {
  try {
    const r = game.settings.renderDistance | 0;
    return clamp(r, 4, 8);
  } catch (e) { return 6; }
}
/* ---------------------------------------------------------- enter / exit */

function uuidHex(str) {
  let h1 = 2166136261, h2 = 0x811c9dc5 ^ 0x9e3779b9;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ (s.charCodeAt(i) * 31 + i), 16777619);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return (hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(h1 + h2)).slice(0, 32);
}

function skinParityAlex(uuid32) {
  try {
    const t = String(uuid32).replace(/-/g, "");
    const e = BigInt.asIntN(64, BigInt("0x" + t.slice(0, 16)));
    const s = BigInt.asIntN(64, BigInt("0x" + t.slice(16)));
    const i = e ^ s;
    const r = Number(BigInt.asIntN(32, i >> 32n)) ^ Number(BigInt.asIntN(32, i));
    return (r & 1) === 1;
  } catch (err) { return false; }
}
function skinUuid(base) {
  let sk = null;
  try { sk = localStorage.getItem("mcjs.oneblock.skin"); } catch (e) {}
  if (sk !== "steve" && sk !== "alex") return base;
  try {
    if (skinParityAlex(base) !== (sk === "alex")) {
      const last = parseInt(base.slice(-1), 16) ^ 1;
      return base.slice(0, -1) + last.toString(16);
    }
  } catch (e) {}
  return base;
}

function activeAccountName() {
  try {
    const a = game.accounts && game.accounts.active && game.accounts.active();
    if (a && a.name) return a.name;
  } catch (e) {}
  try {
    if (game.settings.username) return game.settings.username;
  } catch (e) {}
  return "webuser";
}

function defaultSpawn(seed, type) {
  if (type === "flat") return { x: 8.5, y: MIN_Y + 5.5, z: 8.5 };
  if (type === "void") return { x: 0.5, y: 63, z: 0.5 };
  if (type === "oneblock") return { x: 3.5, y: 63, z: 3.5 };
  if (type === "tectonic") {
    // Two-phase: cheap climate pre-filter (~0.1ms/col lite) for likely land,
    // then lattice heights only on clustered candidates. A naive radius
    // walk would fault a full router lattice per column (~9ms each, so ~10s
    // for the 960-column sweep — still too slow for world creation).
    try {
      const cand = [];
      for (let r = 0; r <= 640 && cand.length < 240; r += 8) {
        for (let a = 0; a < 16; a++) {
          const x = Math.round(Math.cos(a / 16 * Math.PI * 2) * r);
          const z = Math.round(Math.sin(a / 16 * Math.PI * 2) * r);
          let cl = null;
          try { cl = tectonicClimate(x, z, seed >>> 0); } catch (e) {}
          // -0.11 matches Tectonic's own spawn_target continentalness floor.
          if (cl && cl.continents > -0.11) cand.push([x, z]);
        }
      }
      for (const pair of cand) {
        const x = pair[0], z = pair[1];
        const ci = colInfo(x, z, seed, type);
        // Tectonic spawns on real mountains — allow high land (the radial
        // search prefers the closest, which is usually gentle).
        if (ci.h > SEA + 1 && ci.h < SEA + 120 && ci.b !== 4 && ci.b !== 5 &&
            !treeAt(x, z, seed, type)) {
          return { x: x + 0.5, y: ci.h + 2.5, z: z + 0.5 };
        }
      }
    } catch (e) {}
    const x = 8, z = 8; // all-ocean seed fallback (same as below)
    return { x: x + 0.5, y: groundHeight(x, z, seed, type) + 2.5, z: z + 0.5 };
  }
  if (isVoxel(type)) {
    try {
      const g = voxelGen(seed >>> 0);
      const SEA = globalThis.__voxelGen.SEA;
      if (g) {
        for (let r = 0; r <= 640; r += 8) {
          for (let a = 0; a < 12; a++) {
            const x = Math.round(Math.cos(a / 12 * Math.PI * 2) * r);
            const z = Math.round(Math.sin(a / 12 * Math.PI * 2) * r);
            const S = g.surfaceAt(x, z);
            if (S.h > SEA + 1 && S.h < SEA + 26 &&
                !S.b.f.ocean && !S.b.f.river && !S.b.f.beach) {
              return { x: x + 0.5, y: S.h + 2.5, z: z + 0.5 };
            }
          }
        }
      }
    } catch (e) {}
    return { x: 8.5, y: 80, z: 8.5 };
  }
  // Tectonic oceans can be vast — search wider for dry land.
  const maxR = type === "tectonic" ? 320 : 80;
  for (let r = 0; r <= maxR; r += 4) {
    for (let a = 0; a < 12; a++) {
      const x = Math.round(Math.cos(a / 12 * Math.PI * 2) * r);
      const z = Math.round(Math.sin(a / 12 * Math.PI * 2) * r);
      const ci = colInfo(x, z, seed, type);
      if (ci.h > SEA + 1 && ci.h < SEA + 22 && ci.b !== 4 && ci.b !== 5 &&
          !treeAt(x, z, seed, type)) {
        return { x: x + 0.5, y: ci.h + 2.5, z: z + 0.5 };
      }
    }
  }
  const x = 8, z = 8;
  return { x: x + 0.5, y: groundHeight(x, z, seed, type) + 2.5, z: z + 0.5 };
}

function playWorld(id) {
  // FastQuit guard: re-entering a world whose background save hasn't landed
  // would load the pre-save record and then get clobbered by the job's
  // write. Refuse with a toast; the save lands within slices.
  try {
    if (fqSaving(id)) {
      let nm = "world";
      try { nm = (loadIndex().find((x) => x.id === id) || {}).name || nm; } catch (e) {}
      toast("Still saving \"" + nm + "\" — one moment…");
      return;
    }
  } catch (e) {}
  const rec = loadWorldRec(id);
  if (!rec) { toast("World not found"); return; }
  if (isVoxel(rec.type)) {
    showLoading("Loading biome data...");
    ensureVoxelBiomes().then(
      () => playWorldInner(id),
      (err) => {
        console.error(err);
        hideLoading();
        toast("Could not load biome data (offline copy needs a rebuild?)");
      });
    return;
  }
  playWorldInner(id);
}

function playWorldInner(id) {
  const rec = loadWorldRec(id);
  if (!rec) { toast("World not found"); return; }
  if (!registrySimDone) {
    try {
      const surv = globalThis.__mcSurvival;
      const mobs = surv && surv.mobTypes ? surv.mobTypes() : null;
      if (mobs) {
        registrySimDone = true;
        runRegistryCheck({ mobs, biomeIds: HILLS_BIOME_IDS, biomeNames: BIOME_NAMES });
      }
    } catch (e) {}
  }
  hideMenu();
  showLoading("Generating world...");
  // FerriteCore: title-screen pixels are dead weight in-world (device
  // textures stay cached for instant title-on-quit; reloads re-decode).
  try { if (game.assets && game.assets.releaseTitlePixels) game.assets.releaseTitlePixels(); } catch (e) {}
  try { game.input && game.input.lock && game.input.lock(); } catch (e) {}

  setTimeout(() => {
    try {
      // FastQuit for world-switching: persist the outgoing world in the
      // background instead of dropping its dirty state (the old entering
      // path never saved it at all — only autosaves did).
      try { if (SP.active && SP.id && !SP.entering) beginFastQuit(); } catch (e) {}
      SP.entering = true;
      try { game.disconnect(true); } catch (e) {}
      SP.entering = false;

      game.reset();
      // 1.15.2 reset() keeps the world object (1.13.2 swapped it): clear it.
      try { game.world.clear(); } catch (e) {}
      try { noteCleared(); } catch (e) {}
      game.serverAddress = { host: "singleplayer", port: 0 };

      SP.active = true;
      SP.id = id;
      SP.seed = rec.seed >>> 0;
      try { seedEndKills(id, SP.seed); } catch (e) {}
      SP.type = rec.type || "hills";
      SP.mode = normMode(rec.mode);
      // self-heal string-mode saves (and the index row) to numeric, once
      try {
        if (rec.mode !== SP.mode) {
          rec.mode = SP.mode;
          saveWorldRec(id, rec);
          const ix = loadIndex();
          const en = ix.find((x) => x && x.id === id);
          if (en && en.mode !== SP.mode) { en.mode = SP.mode; saveIndex(ix); }
        }
      } catch (e) {}
      SP.generated = new Set();
      SP.genN = new Set();
      SP.genE = new Set();
      SP.overrides = rec.overrides || {};
      SP.nether = rec.nether || {};
      SP.end = rec.end || {};
      bumpOvVer(0); bumpOvVer(-1); bumpOvVer(1);
      SP.links = Array.isArray(rec.links) ? rec.links : [];
      SP.portalCdUntil = 0;
      SP.dim = rec.dim === 1 ? 1 : rec.dim === -1 ? -1 : 0;
      SP.dirty = false;
      SP.difficulty = rec.difficulty == null ? 1 : clamp(rec.difficulty | 0, 0, 3);
      SP.structures = rec.structures !== false;
      SP.cheats = rec.cheats === true;
      SP.spawn = rec.spawn || defaultSpawn(SP.seed, SP.type);

      const name = activeAccountName();
      game.username = name;
      game.playerUuid = skinUuid(uuidHex("singleplayer:" + name));
      game.entityId = 1;
      game.gameMode = normMode(rec.mode);
      game.previousGameMode = game.gameMode;
      game.hardcore = false;
      game.dimension = SP.dim;
      game.difficulty = SP.difficulty;
      game.maxPlayers = 1;
      game.levelType = "default";
      game.reducedDebug = false;
      game.world.setDimension(SP.dim);
      // SP chunks carry 256-entry biomes (never the 1024 wire format), so
      // the BiomeZoom path in getBiome always misses (8 wasted chunk
      // lookups per call, 8000 calls per mesh slice) and falls through to
      // the direct read below. Leave it off: identical output, ~3ms saved
      // per section mesh. (The network path still sets a real seed.)
      try { game.world.setBiomeSeed(undefined); } catch (e) {}
      game.applyGameMode();
      game.health = 20; game.prevHealth = 20;
      game.food = 20; game.saturation = 5;
      try {
        if (normMode(rec.mode) === 0) {
          if (rec.hp != null) { game.health = clamp(rec.hp | 0, 0, 20); game.prevHealth = game.health; }
          if (rec.food != null) game.food = clamp(rec.food | 0, 0, 20);
        }
      } catch (e) {}
      try { game.player.health = 20; } catch (e) {}
      try { if (typeof game.player.food === "number") game.player.food = 20; } catch (e) {}
      game.world.timeOfDay = (rec.time != null ? rec.time : 1000);
      game.world.worldAge = rec.age || 0;
      game.inWorld = true;
      game.doneLoadingTerrain = false;
      game.spawnPos = { x: Math.floor(SP.spawn.x), y: Math.floor(SP.spawn.y), z: Math.floor(SP.spawn.z) };

      const p = rec.player || SP.spawn;
      game.player.setPosition(p.x, p.y, p.z);
      game.player.prevX = p.x; game.player.prevY = p.y; game.player.prevZ = p.z;
      game.player.yaw = p.yaw || 0; game.player.pitch = p.pitch || 0;
      game.player.prevYaw = game.player.yaw; game.player.prevPitch = game.player.pitch;
      game.player.motionX = game.player.motionY = game.player.motionZ = 0;

      if (rec.inv && rec.inv.main) {
        try {
          for (let i = 0; i < 36 && i < rec.inv.main.length; i++) {
            game.inventory.main[i] = rec.inv.main[i];
          }
          if (typeof rec.heldSlot === "number") game.heldSlot = clamp(rec.heldSlot, 0, 8);
        } catch (e) {}
      }

      // entry builds the spawn chunk + ring synchronously (radius 1) and
      // streams the rest via the looper: a full radius-2 sync blocks the
      // main thread past the 15s watchdog on hills with structures on
      const ccx = Math.floor(p.x / 16), ccz = Math.floor(p.z / 16);
      ensureArea(ccx, ccz, 1, null);

    // vanilla-style starter chest on fresh bonus worlds (block override +
    // seeded survival tile; survival restore picks the tile up on entry)
    try { maybeBonusChest(rec); } catch (e) {}
    // stronghold loot chest (TEMP blaze-rod bridge — see parity doc)
    try { maybeStrongholdChest(rec); } catch (e) {}
    // mansion sanctum chest (P4): entry kicks the async cache warmer,
    // which seeds the tile once the mansion is located (never blocks entry)
    try { warmMansions(rec); } catch (e) {}
    // v1.15.0: fortress garden chest (sync lattice — no warmer needed)
    try { writeFortressChest(rec); } catch (e) {}
    // v1.16.0: dragon-kill gating for the End fountain/gateways + city chests
    // (ENDK seeded pre-gen above from the SV rec; the kill hook + onEnterEnd
    // re-sync it live — the SP rec carries no dragonKills, don't read it here)
    try { writeEndCityChests(rec); } catch (e) {}

      game.doneLoadingTerrain = true;
      try { game.screens.close(); } catch (e) {}
      hideLoading();

      try {
        game.hud.addChat("§aSingleplayer: " + rec.name + " — progress saves automatically");
        if (!storageOK) game.hud.addChat("§cWarning: browser storage is blocked, progress will NOT persist");
      } catch (e) {}

      setTimeout(() => { try { refreshThumb(); } catch (e) {} }, 4000);

      startLooper();
    } catch (err) {
      console.error(err);
      hideLoading();
      try { game.screens.openMainMenu("Failed to start singleplayer: " + err.message); } catch (e) {}
      SP.active = false;
    }
  }, 60);
}

function saveNow() {
  if (!SP.active || !SP.id) return true;
  SP.prunedVer = SP.prunedVer || {};
  let pruned = 0;
  for (const [map, dim] of [[SP.overrides, 0], [SP.nether, -1], [SP.end, 1]]) {
    const tag = dim === -1 ? "N" : dim === 1 ? "E" : "0";
    // FastQuit support: genWant is pure of (x,y,z,seed,type), so a dim whose
    // override map is untouched since the last prune has nothing to cull.
    // Autosaves (13s, dirty-only) usually re-scan zero dims after this.
    if ((SP["ovVer" + tag] | 0) === (SP.prunedVer[tag] | 0)) continue;
    for (const k in map) {
      const c = k.split(",");
      if (c.length !== 3) { delete map[k]; bumpOvVer(dim); continue; }
      const want = genWant(+c[0], +c[1], +c[2], SP.seed, SP.type, dim);
      if ((map[k] | 0) === want) { delete map[k]; bumpOvVer(dim); pruned++; }
    }
    SP.prunedVer[tag] = SP["ovVer" + tag] | 0;
  }
  const idx = loadIndex();
  const now = Date.now();
  for (const e of idx) {
    if (e.id === SP.id) { e.modified = now; break; }
  }
  saveIndex(idx);
  const rec = loadWorldRec(SP.id) || {};
  rec.seed = SP.seed;
  rec.type = SP.type;
  rec.dim = SP.dim;
  rec.spawn = SP.spawn;
  rec.overrides = SP.overrides;
  rec.nether = SP.nether;
  rec.end = SP.end;
  rec.links = SP.links;
  rec.time = game.world ? game.world.timeOfDay : rec.time;
  rec.age = game.world ? game.world.worldAge : rec.age;
  try {
    if (game.gameMode === 0) { rec.hp = game.health | 0; rec.food = game.food | 0; }
  } catch (e) {}
  try {
    rec.player = {
      x: game.player.x, y: game.player.y, z: game.player.z,
      yaw: game.player.yaw, pitch: game.player.pitch,
    };
    rec.heldSlot = game.heldSlot;
    rec.inv = { main: game.inventory.main };
  } catch (e) {}
  const ok = saveWorldRec(SP.id, rec);
  if (ok) {
    SP.dirty = false;
    try {
      const idx2 = loadIndex();
      const e2 = idx2.find((x) => x.id === SP.id);
      if (e2) { e2.edits = Object.keys(SP.overrides).length + Object.keys(SP.nether).length + Object.keys(SP.end).length; e2.size = JSON.stringify(rec).length; saveIndex(idx2); }
    } catch (e) {}
    refreshThumb();
  }
  else {
    try { game.hud.addChat("§cSingleplayer: could not save (storage full?)"); } catch (e) {}
  }
  return ok;
}

function deactivate() {
  SP.active = false;
  SP.id = null;
  SP.generated = new Set();
  SP.genN = new Set();
  SP.genE = new Set();
  SP.overrides = {};
  SP.nether = {};
  SP.end = {};
  bumpOvVer(0); bumpOvVer(-1); bumpOvVer(1);
  SP.links = [];
  SP.dim = 0;
  SP.portalCdUntil = 0;
  SP.clearEpoch = 0; SP.epoch0 = -1; SP.epochN = -1; SP.epochE = -1;
  SP.dirty = false;
  SP.prunedVer = {};
  if (SP.streamTimer) { clearInterval(SP.streamTimer); SP.streamTimer = 0; }
}

/* ---------------------------------------------------------- fast quit */
// Fabric FastQuit analogue: quitting a singleplayer world returns to the
// title screen IMMEDIATELY while the save finishes in background slices,
// instead of blocking the UI on prune + serialize + storage write. The quit
// path (leaveWorld wrapper) snapshots everything saveNow needs (cheap field
// copies + the override maps by reference — deactivate() then swaps in
// fresh maps, so the job owns its objects outright), unloads, and lets the
// title open; prune runs in <=SLICE_MS slices and the store write lands
// after. Re-entering (or renaming/re-creating) a still-saving world is
// refused with a toast until its job completes; deleting one cancels its
// job first so the completion can't resurrect the record. pagehide flushes
// any unfinished jobs synchronously (best effort). Thumbnails are left
// alone on quit (last autosave's vista stands — no title-screen overwrite).
const FQ = {
  jobs: [],       // background save jobs (usually 0-1; >1 on fast world-switch)
  SLICE_MS: 8,    // max prune work per background slice
  last: null,     // summary of the last completed job (timings for verification)
};
function fqSaving(id) {
  try {
    for (const j of FQ.jobs) if (j && j.id === id && !j.done && !j.cancelled) return true;
  } catch (e) {}
  return false;
}
// Snapshot everything the background save needs. Cheap: field copies plus
// map references (caller must deactivate/switch session right after so no
// live writer touches these objects again). Also bumps the index modified
// stamp now so the world list sorts correctly even before completion.
function snapshotFastSave() {
  const id = SP.id;
  if (!SP.active || !id) return null;
  const tSnap0 = performance.now();
  const now = Date.now();
  const maps = { 0: SP.overrides, "-1": SP.nether, 1: SP.end };
  const tags = { 0: "0", "-1": "N", 1: "E" };
  const skips = {};
  try {
    SP.prunedVer = SP.prunedVer || {};
    for (const d of [0, -1, 1]) {
      if ((SP["ovVer" + tags[d]] | 0) === (SP.prunedVer[tags[d]] | 0)) skips[d] = true;
    }
  } catch (e) {}
  const rec = loadWorldRec(id) || {};
  rec.seed = SP.seed;
  rec.type = SP.type;
  rec.dim = SP.dim;
  rec.spawn = SP.spawn;
  rec.overrides = maps[0];
  rec.nether = maps[-1];
  rec.end = maps[1];
  rec.links = SP.links;
  try {
    rec.time = game.world ? game.world.timeOfDay : rec.time;
    rec.age = game.world ? game.world.worldAge : rec.age;
  } catch (e) {}
  try {
    if (game.gameMode === 0) { rec.hp = game.health | 0; rec.food = game.food | 0; }
  } catch (e) {}
  try {
    rec.player = {
      x: game.player.x, y: game.player.y, z: game.player.z,
      yaw: game.player.yaw, pitch: game.player.pitch,
    };
    rec.heldSlot = game.heldSlot;
    rec.inv = { main: game.inventory.main };
  } catch (e) {}
  try {
    const idx = loadIndex();
    for (const e of idx) { if (e.id === id) { e.modified = now; break; } }
    saveIndex(idx);
  } catch (e) {}
  return {
    id, seed: SP.seed, type: SP.type, maps, skips, rec, now,
    di: 0, keys: null, ki: 0, done: false, cancelled: false,
    tSnap: performance.now() - tSnap0, tPrune: 0, slices: 0,
  };
}
// Prune one slice of the job (time-budgeted). Returns true when fully pruned.
function pruneFastSlice(job, budgetMs) {
  const dims = [0, -1, 1];
  const t0 = performance.now();
  while (job.di < dims.length) {
    const d = dims[job.di];
    if (job.skips[d]) { job.di++; job.keys = null; job.ki = 0; continue; }
    if (!job.keys) { try { job.keys = Object.keys(job.maps[d]); } catch (e) { job.keys = []; } job.ki = 0; }
    const map = job.maps[d];
    while (job.ki < job.keys.length) {
      const k = job.keys[job.ki++];
      const c = k.split(",");
      if (c.length !== 3) { try { delete map[k]; } catch (e) {} continue; }
      let want = 0, ok = true;
      try { want = genWant(+c[0], +c[1], +c[2], job.seed, job.type, d); }
      catch (e) { ok = false; }
      if (ok) { try { if ((map[k] | 0) === want) delete map[k]; } catch (e) {} }
      if (((job.ki & 127) === 0) && (performance.now() - t0 >= budgetMs)) break;
    }
    if (job.ki < job.keys.length) return false; // slice exhausted, resume later
    job.di++; job.keys = null; job.ki = 0;
  }
  return true;
}
// Store write + index edits/size refresh (one sync section, runs AFTER the
// title is already up so a large-world hitch never blocks the quit UI).
function finalizeFastSave(job) {
  if (!job || job.done) return;
  job.done = true;
  try {
    const i = FQ.jobs.indexOf(job);
    if (i >= 0) FQ.jobs.splice(i, 1);
  } catch (e) {}
  if (job.cancelled) return;
  let ok = false;
  const tW0 = performance.now();
  try { ok = saveWorldRec(job.id, job.rec); } catch (e) { ok = false; }
  try {
    const idx2 = loadIndex();
    const e2 = idx2.find((x) => x.id === job.id);
    if (e2) {
      try {
        e2.edits = Object.keys(job.rec.overrides || {}).length +
          Object.keys(job.rec.nether || {}).length +
          Object.keys(job.rec.end || {}).length;
      } catch (e) {}
      try { e2.size = JSON.stringify(job.rec).length; } catch (e) {}
      saveIndex(idx2);
    }
  } catch (e) {}
  try { if (!ok && game && game.hud && game.inWorld) game.hud.addChat("§cSingleplayer: could not save (storage full?)"); } catch (e) {}
  try {
    FQ.last = {
      id: job.id, keys: Object.keys(job.rec.overrides || {}).length,
      msSnap: +job.tSnap.toFixed(1), msPrune: +job.tPrune.toFixed(1),
      msWrite: +(performance.now() - tW0).toFixed(1), slices: job.slices,
      at: Date.now(),
    };
  } catch (e) {}
}
function pumpFastSave(job) {
  if (!job || job.done || job.cancelled) { try { if (job && job.cancelled) finalizeFastSave(job); } catch (e) {} return; }
  let pruned = false;
  const tP0 = performance.now();
  try { pruned = pruneFastSlice(job, FQ.SLICE_MS); }
  catch (e) { pruned = true; } // prune must never trap the save: write what we have
  try { job.tPrune += performance.now() - tP0; job.slices++; } catch (e) {}
  if (pruned) { try { finalizeFastSave(job); } catch (e) {} return; }
  try { setTimeout(() => pumpFastSave(job), 0); } catch (e) { try { finalizeFastSave(job); } catch (e2) {} }
}
// Synchronous fallback (pagehide): finish whatever is left, blocking.
function finishFastSaveSync(job) {
  if (!job || job.done) return;
  try { pruneFastSlice(job, 1e9); } catch (e) {}
  try { finalizeFastSave(job); } catch (e) {}
}
function flushFastSavesSync() {
  try {
    const jobs = FQ.jobs.slice();
    for (const j of jobs) finishFastSaveSync(j);
  } catch (e) {}
}
// Quit path: snapshot (cheap), stop the session, unload now, save after.
// If the snapshot itself throws, fall back to the old synchronous save so a
// quit can never strand dirty state behind a cleared session.
function beginFastQuit() {
  if (!SP.active || !SP.id) return false;
  let job = null;
  try { job = snapshotFastSave(); }
  catch (e) {
    job = null;
    try { saveNow(); } catch (e2) {}
  }
  if (job) {
    try { FQ.jobs.push(job); } catch (e) {}
  }
  try { deactivate(); } catch (e) {}
  if (job) {
    try { setTimeout(() => pumpFastSave(job), 0); } catch (e) { try { finishFastSaveSync(job); } catch (e2) {} }
  }
  return true;
}

/* ---------------------------------------------------------- dimensions: nether travel */

// Scale between overworld and nether (vanilla 8:1). Links are portal pairs
// recorded whenever a jump builds or finds its target, so repeat trips land
// in the existing portal instead of spawning a new one each time.
function portalTarget(from, x, z) {
  const to = from === 0 ? -1 : 0;
  try {
    for (const L of SP.links) {
      if (from === 0) {
        const dx = L.ox - x, dz = L.oz - z;
        if (dx * dx + dz * dz < 256) return { to, x: L.nx, y: L.ny, z: L.nz };
      } else {
        const dx = L.nx - x, dz = L.nz - z;
        if (dx * dx + dz * dz < 256) return { to, x: L.ox, y: L.oy, z: L.oz };
      }
    }
  } catch (e) {}
  const s = from === 0 ? 1 / 8 : 8;
  return { to, x: clamp(x * s, -1000000, 1000000), y: null, z: clamp(z * s, -1000000, 1000000) };
}

// nearest lit portal interior in LOADED chunks (missing chunks throw, so we
// only walk game.world.chunks). Returns stand position or null.
function findPortalNear(x, y, z, range) {
  const w = game.world;
  const px = portalStateFor("x"), pz = portalStateFor("z");
  if (!px) return null;
  try {
    const x0 = Math.floor((x - range) / 16), x1 = Math.floor((x + range) / 16);
    const z0 = Math.floor((z - range) / 16), z1 = Math.floor((z + range) / 16);
    for (const key of w.chunks.keys()) {
      const c = key.split(",");
      if (c.length !== 2) continue;
      const ccx = +c[0], ccz = +c[1];
      if (ccx < x0 || ccx > x1 || ccz < z0 || ccz > z1) continue;
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          const bx = ccx * 16 + lx, bz = ccz * 16 + lz;
          if (Math.abs(bx - x) > range || Math.abs(bz - z) > range) continue;
          for (let by = Math.max(1, Math.floor(y) - 10); by <= Math.min(319, Math.floor(y) + 10); by++) {
            let st = 0;
            try { st = w.getState(bx, by, bz); } catch (e) { break; }
            if (st === px || st === pz) return { x: bx + 0.5, y: by + 0.5, z: bz + 0.5 };
          }
        }
      }
    }
  } catch (e) {}
  return null;
}

// freestanding vanilla-shape return portal (4x5 obsidian, 2x3 interior,
// axis=x) on a platform where the ground is liquid or air. Runs AFTER the
// target chunks exist, through the normal wrapped setState so the portal
// persists as overrides. Returns the stand position.
function buildReturnPortal(x, z, dim) {
  const seed = SP.seed, type = SP.type;
  let gy = surfaceY(Math.round(x), Math.round(z), seed, type, dim);
  if (dim === -1 && gy <= LAVA_SEA) gy = LAVA_SEA + 1;
  if (dim === 0 && gy <= SEA) gy = SEA + 1;
  if (dim === -1) gy = Math.min(gy, 118);
  else gy = Math.min(gy, 310);
  const px = Math.round(x), pz = Math.round(z), y0 = gy + 1;
  const put = (bx, by, bz, st) => { try { game.world.setState(bx, by, bz, st); } catch (e) {} };
  const O = IDS.obsidian, P = portalStateFor("x");
  if (!O || !P) return { x: px + 0.5, y: y0 + 0.5, z: pz + 0.5 };
  // platform under the frame
  for (let ox = -2; ox <= 2; ox++) {
    for (let oz = -2; oz <= 2; oz++) {
      let cur = 0;
      try { cur = game.world.getState(px + ox, y0 - 1, pz + oz); } catch (e) {}
      if (!cur) put(px + ox, y0 - 1, pz + oz, dim === -1 ? IDS.netherrack : IDS.cobblestone);
    }
  }
  // clear room, then the frame (uprights + caps obsidian, interior portal)
  for (let ix = -1; ix <= 4; ix++) {
    for (let iy = 0; iy <= 6; iy++) {
      if (ix >= 0 && ix <= 3 && iy >= 1 && iy <= 5) put(px + ix, y0 + iy, pz, 0);
    }
  }
  for (let ix = 0; ix < 4; ix++) {
    for (let iy = 1; iy <= 5; iy++) {
      const edge = ix === 0 || ix === 3 || iy === 1 || iy === 5;
      put(px + ix, y0 + iy, pz, edge ? O : P);
    }
  }
  return { x: px + 1.5, y: y0 + 2.5, z: pz + 0.5 };
}

// cross-dimension teleport: stash survival entities (other dim), save,
// swap the world out from under the engine, gen the arrival chunks, land
// in (or build) a portal, restore that dim's entities.
function switchDim(to, x, y, z, opts) {
  if (!SP.active || (to !== 0 && to !== -1 && to !== 1)) return false;
  opts = opts || {};
  const from = SP.dim | 0;
  if (to === from) {
    // same-dim reposition (rescue paths)
    try {
      game.player.setPosition(x, y, z);
      game.player.prevX = x; game.player.prevY = y; game.player.prevZ = z;
      game.player.motionX = game.player.motionY = game.player.motionZ = 0;
    } catch (e) {}
    return true;
  }
  try {
    const S = globalThis.__mcSurvival;
    if (S && typeof S.stashDim === "function") S.stashDim(from);
  } catch (e) {}
  try { saveNow(); } catch (e) {}
  SP.dim = to;
  // all three together: a throw between them would desync SP/engine/world
  // (seen live as SP.dim=0 with the world still in -1)
  try { game.world.setDimension(to); } catch (e) {}
  try { game.dimension = to; } catch (e) {}
  try { noteCleared(); } catch (e) {} // setDimension cleared the chunks
  const ccx = Math.floor(x / 16), ccz = Math.floor(z / 16);
  try { ensureArea(ccx, ccz, 1, null); } catch (e) {}
  let stand = (y != null) ? { x, y, z } : null;
  if (opts.portal) {
    try {
      const yy = stand ? stand.y : (to === -1 ? 70 : 80);
      const found = findPortalNear(x, yy, z, 64);
      if (found) stand = found;
      else if (!stand) stand = buildReturnPortal(x, z, to);
    } catch (e) {}
    if (!stand) stand = { x, y: 80, z };
  }
  if (!stand) stand = { x, y: y == null ? 80 : y, z };
  if (opts.link && stand) {
    try {
      // don't stack duplicate pairs for the same two portals
      const near = (ax, ay, az, b) => Math.abs(ax - b.x) < 2 && Math.abs(ay - b.y) < 3 && Math.abs(az - b.z) < 2;
      let have = false;
      for (const L of SP.links) {
        if (from === 0 && near(L.ox, L.oy, L.oz, opts.link) && near(L.nx, L.ny, L.nz, stand)) { have = true; break; }
        if (from !== 0 && near(L.ox, L.oy, L.oz, stand) && near(L.nx, L.ny, L.nz, opts.link)) { have = true; break; }
      }
      if (!have) {
        if (from === 0) {
          SP.links.push({
            ox: opts.link.x, oy: opts.link.y, oz: opts.link.z,
            nx: stand.x, ny: stand.y, nz: stand.z,
          });
        } else {
          SP.links.push({
            ox: stand.x, oy: stand.y, oz: stand.z,
            nx: opts.link.x, ny: opts.link.y, nz: opts.link.z,
          });
        }
        if (SP.links.length > 64) SP.links.splice(0, SP.links.length - 64);
      }
    } catch (e) {}
  }
  try {
    game.player.setPosition(stand.x, stand.y, stand.z);
    game.player.prevX = stand.x; game.player.prevY = stand.y; game.player.prevZ = stand.z;
    game.player.motionX = game.player.motionY = game.player.motionZ = 0;
  } catch (e) {}
  try { game.portalTime = 0; game.prevPortalTime = 0; } catch (e) {}
  SP.portalCdUntil = Date.now() + 3000;
  try {
    const S = globalThis.__mcSurvival;
    if (S && typeof S.unstashDim === "function") S.unstashDim(to);
  } catch (e) {}
  SP.dirty = true;
  return true;
}

function startLooper() {
  if (SP.streamTimer) clearInterval(SP.streamTimer);
  let saveTick = 0;
  SP.streamTimer = setInterval(() => {
    if (!SP.active) return;
    try {
      if (game.inWorld && game.player) {
        const ccx = Math.floor(game.player.x / 16), ccz = Math.floor(game.player.z / 16);
        // time-budgeted streaming, small slices at 10Hz: one ~8ms fill
        // burst per tick (~1 chunk, up to ~10 chunks/s) instead of a 60ms
        // burst at 2.5Hz — same throughput, no single-frame hitches.
        // The mesh backlog gate below NEVER applies to the critical
        // radius 2 (physics + the ground under the player): starving that
        // would freeze the player in an unloaded chunk. It only throttles
        // far streaming so the dirty-set scan/sort stays cheap and near
        // sections mesh first.
        try {
          ensureArea(ccx, ccz, 2, { ms: 30 });
          const backlog = game.dirty ? game.dirty.size : 0;
          if (backlog <= 800) ensureArea(ccx, ccz, genRadius(), { ms: 8 });
        } catch (e) { try { ensureArea(ccx, ccz, genRadius(), { ms: 8 }); } catch (e2) {} }
        // nether portal trips live here (not in survival's tick) so they
        // also fire in creative mode, where the survival sim is off
        try {
          if ((game.portalTime || 0) >= 1 && Date.now() >= SP.portalCdUntil) {
            const S = globalThis.__mcSurvival;
            if (S && typeof S.portalTick === "function") S.portalTick();
          }
        } catch (e) {}
        // end portal touch-travel (vanilla: instant on contact, no nausea
        // build-up) + creative eye-flight steps (survival ticks its own)
        try {
          const S = globalThis.__mcSurvival;
          if (S && typeof S.endPortalTick === "function" && IDS && IDS.end_portal) {
            let st = -1;
            try { st = game.world.getState(Math.floor(game.player.x), Math.floor(game.player.y + 0.3), Math.floor(game.player.z)); } catch (e) {}
            // v1.16.0: gateways ride the same looper (endPortalTick dispatches)
            if (st === IDS.end_portal || (IDS.end_gateway && st === IDS.end_gateway)) S.endPortalTick();
          }
          if (S && typeof S.eyeTick === "function" && (SP.mode | 0) !== 0) S.eyeTick(0.1);
        } catch (e) {}
        if (game.player.y < MIN_Y - 32 && !(SP.mode === 0 && globalThis.__mcSurvival && globalThis.__mcSurvival.on)) {
          // fell out of the world in creative (or survival without the
          // sim): back to the overworld spawn, whatever dimension we're in.
          // (threshold tracks the 1.18 floor: the old -32 assumed y=0 bedrock.)
          if (SP.dim !== 0) switchDim(0, SP.spawn.x, SP.spawn.y, SP.spawn.z);
          else {
            game.player.setPosition(SP.spawn.x, SP.spawn.y, SP.spawn.z);
            game.player.prevX = SP.spawn.x; game.player.prevY = SP.spawn.y; game.player.prevZ = SP.spawn.z;
            game.player.motionX = game.player.motionY = game.player.motionZ = 0;
          }
        }
        if (++saveTick >= 130 && SP.dirty) { saveTick = 0; saveNow(); }
      }
    } catch (e) {}
  }, 100);
  try {
    // pagehide: active session saves synchronously as before; a FastQuit
    // background job that hasn't finished is flushed blocking (best effort —
    // the tab is going away, so there is no title UI left to protect).
    window.addEventListener("pagehide", () => {
      if (SP.active) { try { saveNow(); } catch (e) {} }
      else { try { flushFastSavesSync(); } catch (e) {} }
    });
  } catch (e) {}
}

function captureThumb(cb) {
  try {
    const c = document.querySelector("#game-canvas") || document.querySelector("canvas");
    if (!c) { cb(null); return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const tw = 192, th = 108;
        const cv = document.createElement("canvas");
        cv.width = tw; cv.height = th;
        const ctx = cv.getContext("2d");
        const sr = c.width / c.height, tr = tw / th;
        let sw, sh, sx, sy;
        if (sr > tr) { sh = c.height; sw = sh * tr; sx = (c.width - sw) / 2; sy = 0; }
        else { sw = c.width; sh = sw / tr; sx = 0; sy = (c.height - sh) / 2; }
        ctx.drawImage(c, sx, sy, sw, sh, 0, 0, tw, th);
        cb(cv.toDataURL("image/jpeg", 0.72));
      } catch (e) { cb(null); }
    }));
  } catch (e) { cb(null); }
}

// Bonus chest for fresh worlds created with the option on (vanilla-style:
// a stocked chest near spawn + torches around it). The block goes through
// the wrapped setState so it persists as an override; the contents are
// seeded into the world record's tile list so survival's entry restore
// picks them up (restoreTiles replaces the live map, so seeding live here
// would be wiped). Runs once per world (rec.bonusDone).
function bonusStateByName(nm) {
  try {
    for (const b of game.assets.data.blocks) {
      if (b && b.name === nm && typeof b.defaultState === "number") return b.defaultState;
    }
  } catch (e) {}
  return null;
}
function maybeBonusChest(rec) {
  try {
    if (!rec || !rec.bonus || rec.bonusDone) return;
    if (!game || !game.world || !game.items || !game.items.byName) return;
    const chestSt = bonusStateByName("chest");
    if (chestSt == null) return;
    // NOTE: scan genState (pure function of seed/type), NOT the live world:
    // at entry time the spawn chunks may not exist yet and getState throws
    // on missing chunks. The setState writes below go through the wrapped
    // world, so they persist as overrides and self-apply when chunks generate.
    const seed = SP.seed, type = SP.type;
    const gen = (x, y, z) => { try { return genState(x, y, z, seed, type) | 0; } catch (e) { return -1; } };
    const sx = Math.floor(SP.spawn.x), sz = Math.floor(SP.spawn.z);
    let bx = null, by = null, bz = null;
    outer:
    for (let r = 0; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const x = sx + 2 + dx, z = sz + dz;
        for (let y = 120; y >= 1; y--) {
          const s = gen(x, y, z);
          if (s === -1) continue;
          if (s !== 0) {
            if (gen(x, y + 1, z) === 0) { bx = x; by = y + 1; bz = z; break outer; }
            break;
          }
        }
      }
    }
    if (bx == null) return; // void world or no room: skip silently
    game.world.setState(bx, by, bz, chestSt);
    const torchSt = bonusStateByName("torch");
    if (torchSt != null) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const d of dirs) {
        try {
          const x = bx + d[0], z = bz + d[1];
          if (gen(x, by, z) === 0 && gen(x, by - 1, z) !== 0) {
            game.world.setState(x, by, z, torchSt);
          }
        } catch (e) {}
      }
    }
    // curated approximation of the vanilla bonus-chest pools (exact table
    // is loot_tables/chests/bonus_chest.json; counts match vanilla rolls)
    const items = new Array(27).fill(null);
    const put = (slot, name, count) => {
      try {
        const def = game.items.byName.get(name);
        if (def && def.id != null) items[slot] = { id: def.id, c: count | 0 };
      } catch (e) {}
    };
    put(1, "oak_log", 5); put(4, "oak_planks", 8); put(7, "stick", 8);
    put(10, "bread", 4); put(13, "apple", 3); put(16, "torch", 6);
    put(19, "wooden_pickaxe", 1); put(22, "wooden_axe", 1);
    try {
      const full = loadWorldRec(SP.id) || rec;
      full.tiles = (full.tiles || []).concat([{ k: bx + "," + by + "," + bz, type: "chest", items }]);
      full.bonusDone = true;
      full.svIds = 1194; // seeded ids are native 1.18.2 — skip compat remap on restore
      saveWorldRec(SP.id, full);
      rec.bonusDone = true;
      rec.svIds = 1194;
      rec.tiles = full.tiles;
    } catch (e) {}
  } catch (e) {}
}

// Stronghold loot chest (called once per world at entry): the portal room
// block itself comes from genState, but contents live in the survival tile
// store. TEMP bridge until Phase E blazes/greenhouses: rods for blaze powder
// (the eye recipe needs them; prefilled-portal luck aside, survival has no
// other rod source) + nether wart (no fortresses grow it yet; brewing needs
// it, and the alternative is waiting for Phase E) + torches for the dark
// room. The portal distribution itself stays the vanilla 10%-each.
function maybeStrongholdChest(rec) {
  try {
    if (!rec || rec.endChestDone) return;
    if (SP.type !== "hills") return;
    if ((SP.dim | 0) !== 0) return; // overworld tiles; only seed on overworld entry
    if (!game || !game.items || !game.items.byName) return;
    const S = strongholdAt(SP.seed, SP.type);
    if (!S) return;
    const items = new Array(27).fill(null);
    const put = (slot, name, count) => {
      try {
        const def = game.items.byName.get(name);
        if (def && def.id != null) items[slot] = { id: def.id, c: count | 0 };
      } catch (e) {}
    };
    put(13, "blaze_rod", 6); put(14, "torch", 8); put(15, "nether_wart", 16);
    const full = loadWorldRec(SP.id) || rec;
    full.tiles = (full.tiles || []).concat([{ k: (S.x + 5) + "," + (S.fy + 1) + "," + S.z, type: "chest", items }]);
    full.endChestDone = true;
    full.svIds = 1194; // seeded ids are native 1.18.2 — skip compat remap on restore
    saveWorldRec(SP.id, full);
    rec.endChestDone = true;
    rec.svIds = 1194;
    rec.tiles = full.tiles;
  } catch (e) {}
}

// Mansion sanctum chest: the chest BLOCK comes from genState (mansionBlock);
// contents are seeded by the async entry warmer (writeMansionChest), since a
// sync lattice scan at entry freezes the page. See warmMansions above.

function refreshThumb() {
  if (!SP.active || !SP.id) return;
  captureThumb((url) => {
    try {
      if (!url || !SP.id) return;
      const idx = loadIndex();
      const e = idx.find((x) => x.id === SP.id);
      if (!e) return;
      e.shot = url;
      e.edits = Object.keys(SP.overrides).length;
      saveIndex(idx);
    } catch (err) {}
  });
}

/* ---------------------------------------------------------- patches */

function installPatches() {
  // 1) enable the title-screen Singleplayer button + hook screens.open.
  // 1.15.2 TitleScreen builds the button disabled (id 1, like the old
  // engine); enabling it here is the same wiring trick, new GUI classes.
  const screens = game.screens;
  const origOpen = screens.open.bind(screens);
  screens.open = function (screen) {
    const r = origOpen(screen);
    try {
      hideMenuOnScreenChange();
      // same-frame wiring (incl. init-wrap install) so a resize-driven
      // init() reset never leaves the button dark waiting for the poll
      wireTitle();
      maybeHookChatScreen();
    } catch (e) {}
    return r;
  };
  const wireTitle = () => {
    try {
      const cur = screens.current;
      if (cur && !cur._spInitHooked) {
        cur._spInitHooked = true;
        const origInit = cur.init;
        cur.init = function () {
          const r = origInit.call(this);
          try { wireTitle(); } catch (e) {}
          return r;
        };
      }
      if (cur && !game.inWorld && cur.buttons) {
        const btn = cur.buttons.find((b) => b && b.id === 1);
        if (btn && btn.enabled === false) {
          btn.enabled = true;
          btn.onClick = function () { openMenu(); };
          return true;
        }
        if (btn && btn.enabled) return true;
      }
    } catch (e) {}
    return false;
  };
  try { wireTitle(); } catch (e) {}
  if (!game._spTitlePoll) {
    game._spTitlePoll = setInterval(() => {
      try { wireTitle(); } catch (e) {}
    }, 2000);
  }

  // 2) record player edits for saving (the generator sets SP.gen while writing).
  // 1.15.2 reset() keeps the world object, so one wrap survives; the guard
  // re-wraps if anything ever swaps it (same fix as the post-entry bug).
  // Only EFFECTIVE writes are recorded (read back after): survival swallows
  // breaks of unbreakable blocks (end portal/frames) without writing, and a
  // naive record would plant phantom air-overrides that later entries would
  // obey (found live: a swallowed end-portal break recorded air over the
  // portal, erasing it on the next load).
  const wrapWorld = () => {
    try {
      const w = game.world;
      if (!w || w._spPatched) return;
      w._spPatched = true;
      const origSetState = w.setState.bind(w);
      w.setState = function (x, y, z, state) {
        const r = origSetState(x, y, z, state);
        try {
          if (SP.active && !SP.gen && inY(y)) {
            let eff = -1;
            try { eff = w.getState(x, y, z); } catch (e) {}
            if (eff === (state | 0)) {
              ovMapFor(SP.dim)[x + "," + y + "," + z] = state | 0;
              bumpOvVer(SP.dim);
              SP.dirty = true;
            }
          }
        } catch (e) {}
        return r;
      };
    } catch (e) {}
  };
  wrapWorld();
  if (!game._spWorldPoll) {
    game._spWorldPoll = setInterval(() => { try { wrapWorld(); } catch (e) {} }, 1000);
  }

  // 3) save + unload when leaving the local world (MP join, disconnect, quit)
  if (!game._spLeaveWrapped) {
    game._spLeaveWrapped = true;
    const origLeave = game.leaveWorld.bind(game);
    game.leaveWorld = function () {
      try {
        // FastQuit: snapshot + unload NOW, finish the save in background
        // slices. The title screen opens in ms; prune + serialize + the
        // store write land after (see the fast-quit section above).
        if (SP.active && !SP.entering) beginFastQuit();
      } catch (e) {}
      return origLeave();
    };
  }

  // 4) creative placement: keep stacks infinite + place blocks the vanilla
  //    predictor leaves as air (stairs/slabs/torch/ladder/doors/...)
  installPlacementPatch();
}

// 1.15.2 placement: flattened states — resolve an item to its block's
// defaultState from the live tables. No version-specific list needed.
function stateForItem(item) {
  try {
    const idef = game.items && game.items.def ? game.items.def(item.id) : null;
    const nm = idef && idef.name;
    if (!nm) return null;
    const arr = game.assets.data.blocks;
    for (const blk of arr) {
      if (blk && blk.name === nm && typeof blk.defaultState === "number") return blk.defaultState;
    }
  } catch (e) {}
  return null;
}

function installPlacementPatch() {
  const inter = game.interaction;
  if (!inter || inter._spPatched) return;
  inter._spPatched = true;

  const origPredict = inter._predictPlace ? inter._predictPlace.bind(inter) : null;
  const origOnItemUse = inter._onItemUse ? inter._onItemUse.bind(inter) : null;

  if (origPredict) {
    inter._predictPlace = function (pos, item, def) {
      const r = origPredict(pos, item, def);
      try {
        if (SP.active && def && game.world.getState(pos.x, pos.y, pos.z) === 0) {
          const name = def.name || "";
          if (def.boundingBox === "block" &&
              name.indexOf("door") < 0 && name !== "bed" && name.indexOf("portal") < 0) {
            const st = stateForItem(item);
            if (st != null) game.world.setState(pos.x, pos.y, pos.z, st);
          }
        }
      } catch (e) {}
      return r;
    };
  }

  if (origOnItemUse) {
    inter._onItemUse = function (t, e) {
      const keep = SP.active && game.gameMode === 1 ? e.count : null;
      const r = origOnItemUse(t, e);
      try {
        if (keep != null) e.count = keep;
        if (SP.active && r && e && e.id > 0) {
          let p = null;
          try { p = inter._placementPos(t, e).p; } catch (err) { p = null; }
          if (p && game.world.getState(p.x, p.y, p.z) === 0) {
            const st = stateForItem(e);
            if (st != null) game.world.setState(p.x, p.y, p.z, st);
          }
        }
      } catch (err) {}
      return r;
    };
  }
}

/* ---------------------------------------------------------- chat */

function maybeHookChatScreen() {
  try {
    const cur = game.screens.current;
    if (!cur || !cur.isChatScreen || cur._spHooked) return;
    cur._spHooked = true;
    const origKey = cur.key.bind(cur);
    cur.key = function (t) {
      if (SP.active && (t.code === "Enter" || t.code === "NumpadEnter")) {
        let msg = "";
        try { msg = (cur.input.text || "").trim(); } catch (e) {}
        if (msg) handleChatCommand(msg);
        try { game.screens.close(); } catch (e) {}
        return true;
      }
      return origKey(t);
    };
  } catch (e) {}
}

function handleChatCommand(msg) {
  const hud = game.hud;
  if (msg.charAt(0) !== "/") {
    try { hud.addChat("§7<" + game.username + "> " + msg); } catch (e) {}
    return;
  }
  const parts = msg.slice(1).split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();
  const arg = parts.slice(1);
  const say = (t) => { try { hud.addChat(t); } catch (e) {} };
  if (SP.active && SP.mode === 0 && SP.cheats !== true &&
      (cmd === "gamemode" || cmd === "gm" || cmd === "time" || cmd === "give" || cmd === "tp" || cmd === "difficulty" || cmd === "weather")) {
    say("§cCheats are not enabled in this world (Allow Cheats: OFF)");
    return;
  }
  if (cmd === "help") {
    say("§eSingleplayer commands: /time set <day|night|N>, /gamemode <0|1>, /difficulty <peaceful|easy|normal|hard>, /weather <clear|rain|thunder> [seconds], /tp <x> <y> <z>, /give <id> [count], /spawn");
  } else if (cmd === "difficulty") {
    const v = (arg[0] || "").toLowerCase();
    const names = { peaceful: 0, easy: 1, normal: 2, hard: 3, p: 0, e: 1, n: 2, h: 3, "0": 0, "1": 1, "2": 2, "3": 3 };
    if (!(v in names)) { say("§cUsage: /difficulty <peaceful|easy|normal|hard>"); return; }
    const d = names[v];
    try {
      game.difficulty = d;
      SP.difficulty = d; SP.dirty = true;
      const r = loadWorldRec(SP.id) || {};
      r.difficulty = d;
      saveWorldRec(SP.id, r);
    } catch (e) {}
    say("§eDifficulty: " + ["peaceful", "easy", "normal", "hard"][d]);
  } else if (cmd === "time" && arg[0] === "set") {
    const v = (arg[1] || "").toLowerCase();
    let t = null;
    if (v === "day") t = 1000;
    else if (v === "noon") t = 6000;
    else if (v === "night") t = 13000;
    else if (v === "midnight") t = 18000;
    else if (/^-?\d+$/.test(v)) t = parseInt(v, 10);
    if (t == null) say("§cUsage: /time set <day|noon|night|midnight|ticks>");
    else { game.world.timeOfDay = ((t % 24000) + 24000) % 24000; SP.dirty = true; say("§eTime set"); }
  } else if (cmd === "gamemode" || cmd === "gm") {
    const v = (arg[0] || "").toLowerCase();
    const m = v === "1" || v === "c" || v === "creative" ? 1 : v === "0" || v === "s" || v === "survival" ? 0 : -1;
    if (m < 0) say("§cUsage: /gamemode <0|1>");
    else {
      game.gameMode = m; game.applyGameMode();
      say("§eGamemode: " + (m === 1 ? "creative" : "survival (damage, hunger, drops, mobs)"));
    }
  } else if (cmd === "tp") {
    if (arg.length < 3 || !arg.slice(0, 3).every((a) => /^-?\d+(\.\d+)?$/.test(a))) {
      say("§cUsage: /tp <x> <y> <z>");
    } else {
      const x = +arg[0], y = clamp(+arg[1], 1, 250), z = +arg[2];
      game.player.setPosition(x, y, z);
      game.player.motionX = game.player.motionY = game.player.motionZ = 0;
    }
  } else if (cmd === "spawn") {
    game.player.setPosition(SP.spawn.x, SP.spawn.y, SP.spawn.z);
    game.player.motionX = game.player.motionY = game.player.motionZ = 0;
  } else if (cmd === "give") {
    const id = parseInt(arg[0], 10);
    const count = clamp(parseInt(arg[1] || "64", 10) || 64, 1, 64);
    if (!(id > 0)) { say("§cUsage: /give <id> [count] (1.18.2 numeric id)"); return; }
    try {
      game.inventory.addToInventory({ id: id, damage: 0, count: count });
      say("§eGiven item " + id);
    } catch (e) { say("§cGive failed"); }
  } else if (cmd === "weather") {
    const k = (arg[0] || "").toLowerCase();
    const secs = arg[1] != null ? parseInt(arg[1], 10) : null;
    if (k !== "clear" && k !== "rain" && k !== "thunder" && k !== "storm") { say("§cUsage: /weather <clear|rain|thunder> [seconds]"); return; }
    try {
      const S = globalThis.__mcSurvival;
      if (!S || !S.setWeather) { say("§cWeather not ready (survival port pending)"); return; }
      S.setWeather(k === "storm" ? "thunder" : k, secs || undefined);
      say("§eWeather: " + (k === "storm" ? "thunder" : k));
      SP.dirty = true;
    } catch (e) { say("§cWeather failed"); }
  } else {
    say("§cUnknown command. Try /help");
  }
}
/* ---------------------------------------------------------- menu UI (engine Screens) */

import { Screen } from "./js/gui/screens/manager.js";
import { Button, TextField } from "./js/gui/widgets.js";

const UI = {
  view: "list", // list | create
  page: 0,
  sel: null,      // selected world id
  search: "",
  toast: null,    // {msg, until}
  lastClick: 0, lastRow: null,
  F: { gm: 0, diff: 1, cheats: false, wtype: "tectonic", struct: true, bonus: false },
  name: "New World",
  seed: "",
};
const SN_GM = ["Survival", "Creative"];
const SN_DIFF = ["Peaceful", "Easy", "Normal", "Hard"];
const SN_WT = [["tectonic", "Default"], ["voxel", "Terralith"], ["hills", "Classic (hills+trees)"], ["flat", "Superflat"], ["void", "Void"], ["oneblock", "Skyblock"]];
const SN_WT_LONG = { voxel: "Terralith", hills: "Classic", tectonic: "Tectonic", flat: "Superflat", void: "Void", oneblock: "Skyblock" };

function fmtDate(t) {
  try {
    const d = new Date(t);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}
function snRows() {
  const q = (UI.search || "").trim().toLowerCase();
  return loadIndex().slice().sort((a, b) => (b.modified || 0) - (a.modified || 0))
    .filter((e) => !q || (e.name || "").toLowerCase().indexOf(q) >= 0);
}
function snRowLabel(e) {
  const gm = normMode(e.mode) === 0 ? "Survival" : "Creative";
  return (e.name || "Unnamed") + "  §7" + gm + ", " + (SN_WT_LONG[e.type] || e.type || "?");
}
function snRowDetail(e) {
  const gm = normMode(e.mode) === 0 ? "Survival" : "Creative";
  let d = gm + ", " + (SN_WT_LONG[e.type] || e.type || "?");
  try { if (e.modified) d += ", " + fmtDate(e.modified); } catch (err) {}
  try { if (e.edits != null) d += ", " + e.edits + " edits"; } catch (err) {}
  // FastQuit: surface the background save in the list (Fabric shows the
  // world as saving until the store write lands).
  try { if (e && e.id && fqSaving(e.id)) d += ", §esaving…"; } catch (err) {}
  return d;
}
// world-thumbnail texture cache: id -> {url, tex}. Decodes the JPEG
// dataURL captured by refreshThumb into an engine texture (same recipe as
// the oneblock skin paper-doll). makeTexture disposes the previous texture
// under a reused key, so a re-captured shot replaces cleanly.
const SHOT_TEX = {};
function shotTex(e) {
  try {
    if (!e || !e.id || !e.shot || !game || !game.assets) return null;
    const hit = SHOT_TEX[e.id];
    if (hit && hit.url === e.shot) return hit.tex || null;
    delete SHOT_TEX[e.id];
    // bound the cache: drop the oldest ids first (their GPU textures are
    // tiny and same-key makeTexture disposes on replace; removals leak one
    // 96x54 texture each — negligible)
    try {
      const ks = Object.keys(SHOT_TEX);
      while (ks.length > 40) delete SHOT_TEX[ks.shift()];
    } catch (err) {}
    SHOT_TEX[e.id] = { url: e.shot, tex: null };
    const url = e.shot, id = e.id;
    (async () => {
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = url;
        });
        const cv = document.createElement("canvas");
        cv.width = 96; cv.height = 54;
        const px = cv.getContext("2d");
        px.drawImage(img, 0, 0, 96, 54);
        const d = px.getImageData(0, 0, 96, 54);
        const rec = SHOT_TEX[id];
        if (rec && rec.url === url) {
          try { rec.tex = game.assets.makeTexture("mcjs-shot-" + id, 96, 54, d.data, { filter: "linear" }); }
          catch (err) { try { rec.tex = game.assets.makeTexture("mcjs-shot-" + id, 96, 54, d.data); } catch (e2) {} }
        }
      } catch (err) {}
    })();
    return null;
  } catch (e) { return null; }
}
function toast(text) {
  try {
    const cur = game && game.screens && game.screens.current;
    if (cur && cur._isSpMenu) { UI.toast = { msg: String(text || ""), until: Date.now() + 2600 }; return; }
  } catch (e) {}
  try {
    if (game && game.inWorld) { game.hud.addChat(String(text || "")); return; }
  } catch (e) {}
  try { console.log("[singleplayer] " + text); } catch (e) {}
}

function isOurScreen(s) {
  return !!(s && s._isSpMenu);
}
function openMenu() {
  try {
    UI.view = "list";
    game.screens.open(new SpListScreen(game));
  } catch (e) { console.error(e); }
}
function hideMenu() {
  try {
    const cur = game.screens.current;
    if (isOurScreen(cur)) game.screens.current = null;
  } catch (e) {}
}
function hideMenuOnScreenChange() {
  // Stack-replace semantics: engine opens replace our menu automatically.
  // Only the chat hook needs attention here.
}
function showLoading(text) {
  try { game.screens.open(new SpLoadingScreen(game, String(text || "Loading..."))); } catch (e) {}
}
function hideLoading() {
  try {
    const cur = game.screens && game.screens.current;
    if (cur && cur._isSpLoading) game.screens.current = null;
  } catch (e) {}
}

class SpLoadingScreen extends Screen {
  constructor(g, msg) { super(g); this._isSpMenu = true; this._isSpLoading = true; this.background = "dirt"; this._msg = msg; }
  init() {}
  key() { return true; }
  char() { return true; }
  renderContent(gui) {
    try { gui.textCentered(this._msg, Math.floor(this.width / 2), Math.floor(this.height / 2) - 6, 16777215); } catch (e) {}
  }
}

class SpConfirmScreen extends Screen {
  constructor(g, msg, onYes) {
    super(g);
    this._isSpMenu = true; this.background = "dirt";
    this._msg = msg; this._onYes = onYes;
  }
  init() {
    const cx = Math.floor(this.width / 2), y = Math.floor(this.height / 2);
    this.buttons.push(new Button(1, cx - 102, y + 8, 100, 20, "Yes", () => {
      const f = this._onYes; this._onYes = null;
      game.screens.open(new SpListScreen(game));
      if (f) f();
    }));
    this.buttons.push(new Button(0, cx + 2, y + 8, 100, 20, "No", () => game.screens.open(new SpListScreen(game))));
  }
  key(e) {
    if (e.code === "Escape") { game.screens.open(new SpListScreen(game)); return true; }
    return super.key(e);
  }
  renderContent(gui) {
    try { gui.textCentered(this._msg, Math.floor(this.width / 2), Math.floor(this.height / 2) - 16, 16777215); } catch (e) {}
  }
}

class SpPromptScreen extends Screen {
  constructor(g, title, initial, onOk) {
    super(g);
    this._isSpMenu = true; this.background = "dirt";
    this._title = title; this._initial = initial || ""; this._onOk = onOk;
  }
  init() {
    const cx = Math.floor(this.width / 2), y = Math.floor(this.height / 2);
    const fw = Math.min(300, this.width - 16), fx = cx - Math.floor(fw / 2);
    const f = new TextField(fx, y - 10, fw, 20, { text: this._initial, maxLength: 32, focused: true });
    this.fields.push(f);
    this.buttons.push(new Button(1, cx - 102, y + 20, 100, 20, "OK", () => {
      const v = f.text; const cb = this._onOk; this._onOk = null;
      game.screens.open(new SpListScreen(game));
      if (cb) cb(v);
    }));
    this.buttons.push(new Button(0, cx + 2, y + 20, 100, 20, "Cancel", () => game.screens.open(new SpListScreen(game))));
  }
  key(e) {
    if (e.code === "Escape") { game.screens.open(new SpListScreen(game)); return true; }
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      const b = this.buttons.find((x) => x.id === 1);
      if (b) b.onClick(b);
      return true;
    }
    return super.key(e);
  }
  renderContent(gui) {
    try { gui.textCentered(this._title, Math.floor(this.width / 2), Math.floor(this.height / 2) - 34, 16777215); } catch (e) {}
  }
}

class SpListScreen extends Screen {
  constructor(g) { super(g); this._isSpMenu = true; this.background = "dirt"; }
  init() {
    const w = this.width, h = this.height;
    const cx = Math.floor(w / 2);
    // search field (top, clamped to fit narrow screens) + rows + bottom bars
    const sw = Math.min(300, this.width - 16), sx = cx - Math.floor(sw / 2);
    this.fields.push(new TextField(sx, 30, sw, 20, {
      text: UI.search || "", maxLength: 64,
      onChange: (t) => { UI.search = t; UI.page = 0; this.refreshRows(); },
    }));
    this._rowTop = 58;
    this._rowH = 44;
    // bottom action bars shrink to fit narrow screens (3 x bw + 2 x gap)
    this._barGap = 8;
    this._barW = Math.min(148, Math.floor((this.width - 16 - 2 * this._barGap) / 3));
    this.refreshRows();
    const by = h - 52;
    const bw = this._barW, gap = this._barGap;
    const x0 = cx - (bw * 3 + gap * 2) / 2;
    const mk = (i, label, fn, en) => {
      const b = new Button(10 + i, x0 + i * (bw + gap), by, bw, 20, label, fn);
      if (en === false) b.enabled = false;
      this.buttons.push(b);
      return b;
    };
    mk(0, "Play Selected World", () => { if (UI.sel) playWorld(UI.sel); });
    mk(1, "Create New World", () => { UI.view = "create"; game.screens.open(new SpCreateScreen(game)); });
    mk(2, "Delete", () => {
      if (!UI.sel) return;
      const e = loadIndex().find((x) => x.id === UI.sel);
      game.screens.open(new SpConfirmScreen(game, "Delete \"" + (e ? e.name : "?") + "\"?", () => {
        try {
          // FastQuit: a pending background job for this world must die with
          // it, or its completion write would resurrect the record.
          try {
            for (let i = FQ.jobs.length - 1; i >= 0; i--) {
              const j = FQ.jobs[i];
              if (j && j.id === UI.sel) { j.cancelled = true; j.done = true; FQ.jobs.splice(i, 1); }
            }
          } catch (err) {}
          const idx = loadIndex().filter((x) => x.id !== UI.sel);
          saveIndex(idx);
          deleteWorldRec(UI.sel);
          if (UI.sel) { UI.sel = null; }
          toast("World deleted");
        } catch (err) { toast("Delete failed"); }
      }));
    });
    const by2 = h - 28;
    const mk2 = (i, label, fn) => this.buttons.push(new Button(20 + i, x0 + i * (bw + gap), by2, bw, 20, label, fn));
    mk2(0, "Rename", () => {
      if (!UI.sel) return;
      // FastQuit: the background job's record carries the old name — let it
      // land first (slices, ~instant) rather than racing it.
      try { if (fqSaving(UI.sel)) { toast("Still saving — one moment…"); return; } } catch (e) {}
      const e = loadIndex().find((x) => x.id === UI.sel);
      game.screens.open(new SpPromptScreen(game, "Rename world", e ? e.name : "", (v) => {
        const name = (v || "").slice(0, 32) || (e ? e.name : "Unnamed");
        try {
          const idx = loadIndex();
          const rec = idx.find((x) => x.id === UI.sel);
          if (rec) { rec.name = name; rec.modified = Date.now(); saveIndex(idx); }
          const wr = loadWorldRec(UI.sel) || {};
          wr.name = name;
          saveWorldRec(UI.sel, wr);
          toast("Renamed");
        } catch (err) { toast("Rename failed"); }
      }));
    });
    mk2(1, "Re-Create", () => {
      if (!UI.sel) return;
      try { if (fqSaving(UI.sel)) { toast("Still saving — one moment…"); return; } } catch (e) {}
      const idx = loadIndex().find((x) => x.id === UI.sel);
      const wr = loadWorldRec(UI.sel) || {};
      UI.name = (idx && idx.name) || "New World";
      UI.seed = "";
      UI.F = {
        gm: normMode(idx && idx.mode),
        diff: wr.difficulty != null ? wr.difficulty : 1,
        cheats: wr.cheats === true,
        wtype: (idx && idx.type) || "voxel",
        struct: wr.structures !== false,
        bonus: wr.bonus === true,
      };
      UI.view = "create";
      game.screens.open(new SpCreateScreen(game));
    });
    mk2(2, "Back", () => game.screens.close());
  }
  refreshRows() {
    // rebuild row buttons (keep search field + bottom bars)
    const keep = this.buttons.filter((b) => b.id >= 10);
    this.buttons = keep;
    const rows = snRows();
    const perPage = Math.max(1, Math.floor((this.height - 58 - 64) / this._rowH));
    const pages = Math.max(1, Math.ceil(rows.length / perPage));
    UI.page = clamp(UI.page, 0, pages - 1);
    const slice = rows.slice(UI.page * perPage, UI.page * perPage + perPage);
    this._slice = slice;
    const cx = Math.floor(this.width / 2);
    slice.forEach((e, i) => {
      const y = this._rowTop + i * this._rowH;
      const rw = Math.min(440, this.width - 8), rx0 = cx - Math.floor(rw / 2);
      // frameless click target (render suppressed below): the row draws its
      // own art + hover/selection in _drawRows, vanilla server-list style
      const b = new Button(1000 + i, rx0, y, rw, this._rowH, "", () => {
        const now = Date.now();
        if (UI.lastRow === e.id && now - UI.lastClick < 450) { playWorld(e.id); return; }
        UI.lastRow = e.id; UI.lastClick = now;
        UI.sel = e.id;
        this.refreshRows();
      });
      b.render = function () {};
      this.buttons.push(b);
    });
    if (pages > 1) {
      const y = this._rowTop + slice.length * this._rowH + 2;
      const pw = 100, px0 = cx - pw - 4;
      this.buttons.push(new Button(2001, px0, y, pw, 18, "◀ Prev", () => { UI.page--; this.refreshRows(); }));
      this.buttons.push(new Button(2002, cx + 4, y, pw, 18, "Next ▶", () => { UI.page++; this.refreshRows(); }));
    }
    // enable/disable bottom buttons by selection
    for (const b of this.buttons) {
      if (b.id === 10 || b.id === 20 || b.id === 21) b.enabled = !!UI.sel;
    }
  }
  key(e) {
    if (e.code === "Enter" || e.code === "NumpadEnter") {
      if (UI.sel) { playWorld(UI.sel); return true; }
    }
    return super.key(e);
  }
  render(gui, mx, my, partial) {
    // buttons paint AFTER renderContent (engine order), so row art must be
    // drawn after super.render or the opaque button frames cover it
    try { super.render(gui, mx, my, partial); } catch (e) {}
    try { this._drawRows(gui, mx, my); } catch (e) {}
  }
  _drawRows(gui, mx, my) {
    // thumbnail rows (vanilla-style: shot left, name + details right)
    const slice = this._slice || [];
    const cx = Math.floor(this.width / 2);
    const rowW = Math.min(440, this.width - 8), rx = cx - Math.floor(rowW / 2);
    for (let i = 0; i < slice.length; i++) {
      const e = slice[i];
      if (!e) continue;
      const y = this._rowTop + i * this._rowH;
      const x = rx, w = rowW;
      const hov = mx != null && my != null && mx >= x && mx < x + w && my >= y && my < y + this._rowH;
      if (hov) { try { gui.rect(x, y, x + w, y + this._rowH, 0x18ffffff); } catch (err) {} }
      if (e.id === UI.sel) {
        try {
          gui.rect(x, y, x + w, y + 1, 0xffffffff); gui.rect(x, y + this._rowH - 1, x + w, y + this._rowH, 0xffffffff);
          gui.rect(x, y, x + 1, y + this._rowH, 0xffffffff); gui.rect(x + w - 1, y, x + w, y + this._rowH, 0xffffffff);
        } catch (err) {}
      }
      const tex = shotTex(e);
      if (tex) { try { gui.drawImage(tex, 0, 0, tex.width, tex.height, x + 2, y + 2, 72, 40); } catch (err) {} }
      else { try { gui.rect(x + 2, y + 2, x + 74, y + 42, 0xff101010); } catch (err) {} }
      try {
        const tx = x + 80, tw = w - 80 - 6;
        gui.text(e.name || "Unnamed", tx, y + 4, 16777215, false);
        gui.text(gui.font.trimToWidth(snRowDetail(e), tw), tx, y + 22, 0x808080, false);
      } catch (err) {}
    }
  }
  renderContent(gui) {
    try {
      gui.textCentered("Select World", Math.floor(this.width / 2), 12, 16777215);
      const rows = snRows();
      if (!rows.length) gui.textCentered("No worlds yet — create one!", Math.floor(this.width / 2), this._rowTop + 4, 0xa0a0a0);
      if (UI.toast && Date.now() < UI.toast.until) {
        gui.textCentered("§e" + UI.toast.msg, Math.floor(this.width / 2), this.height - 72, 16777215);
      } else UI.toast = null;
    } catch (e) {}
  }
}

class SpCreateScreen extends Screen {
  constructor(g) { super(g); this._isSpMenu = true; this.background = "dirt"; }
  init() {
    const cx = Math.floor(this.width / 2);
    // clamp control widths so narrow screens don't overhang
    const fw = Math.min(200, this.width - 16), fx = cx - Math.floor(fw / 2);
    this._fx = fx;
    let y = 40;
    const fld = (label, initial, max, set) => {
      const f = new TextField(fx, y, fw, 20, {
        text: initial || "", maxLength: max || 32,
        onChange: (t) => set(t),
      });
      f._y0 = y;
      this.fields.push(f);
      this._labels = this._labels || [];
      this._labels.push([label, y]);
      y += 30;
      return f;
    };
    fld("World Name", UI.name, 32, (t) => { UI.name = t; });
    fld("Seed (blank = random)", UI.seed, 32, (t) => { UI.seed = t; });
    y += 4;
    const cyc = (label, vals, get, set) => {
      this._labels.push([label, y]);
      const b = new Button(3000 + this.buttons.length, fx, y + 10, fw, 20,
        () => label + ": " + vals[get()], () => { set((get() + 1) % vals.length); });
      b._y0 = y + 10;
      this.buttons.push(b);
      y += 36;
    };
    cyc("Mode", SN_GM, () => UI.F.gm, (v) => { UI.F.gm = v; });
    cyc("World Type", SN_WT.map((x) => x[1]), () => Math.max(0, SN_WT.findIndex((x) => x[0] === UI.F.wtype)), (v) => { UI.F.wtype = SN_WT[v][0]; });
    cyc("Difficulty", SN_DIFF, () => UI.F.diff, (v) => { UI.F.diff = v; });
    cyc("Allow Cheats", ["OFF", "ON"], () => UI.F.cheats ? 1 : 0, (v) => { UI.F.cheats = v === 1; });
    cyc("Generate Structures", ["ON", "OFF"], () => UI.F.struct ? 0 : 1, (v) => { UI.F.struct = v === 0; });
    cyc("Bonus Chest", ["OFF", "ON"], () => UI.F.bonus ? 1 : 0, (v) => { UI.F.bonus = v === 1; });
    const by = this.height - 30;
    // short screens (landscape phones, small embeds): the form scrolls
    // instead of running under the bottom bar
    this._scroll = 0;
    this._maxScroll = Math.max(0, (y + 8) - (by - 8));
    const cw = Math.min(200, Math.floor((this.width - 16 - 8) / 2)), cx0 = cx - cw - 4;
    this.buttons.push(new Button(1, cx0, by, cw, 20, "Create New World", () => snCreateWorld()));
    this.buttons.push(new Button(0, cx + 4, by, cw, 20, "Cancel", () => {
      UI.view = "list";
      game.screens.open(new SpListScreen(game));
    }));
  }
  key(e) {
    if (e.code === "Escape") { UI.view = "list"; game.screens.open(new SpListScreen(game)); return true; }
    return super.key(e);
  }
  wheel(d) {
    if (!this._maxScroll) return false;
    this._scroll = Math.max(0, Math.min(this._maxScroll, (this._scroll || 0) + (d > 0 ? 24 : -24)));
    return true;
  }
  render(gui, mx, my, partial) {
    // apply form scroll (bottom bar stays fixed) before the engine paints
    try {
      const s = this._scroll || 0;
      for (const w of this.buttons) if (w && w._y0 != null) w.y = w._y0 - s;
      for (const f of this.fields) if (f && f._y0 != null) f.y = f._y0 - s;
    } catch (e) {}
    super.render(gui, mx, my, partial);
  }
  renderContent(gui) {
    try {
      gui.textCentered("Create New World", Math.floor(this.width / 2), 12, 16777215);
      // labels right-aligned to the field's left edge (trimmed on narrow
      // screens), following the form scroll; off-screen ones are skipped
      const s = this._scroll || 0;
      if (this._labels) for (const [t, y] of this._labels) {
        try {
          const ly = y + 6 - s;
          if (ly < -12 || ly > this.height) continue;
          const avail = Math.max(0, (this._fx || 0) - 6 - 4);
          const str = avail >= 20 ? gui.font.trimToWidth(String(t), avail) : String(t);
          gui.text(str, Math.max(4, (this._fx || 0) - 6 - gui.font.width(str)), ly, 0xa0a0a0);
        } catch (err) {}
      }
    } catch (e) {}
  }
}

function snCreateWorld() {
  const type = UI.F.wtype;
  if (isVoxel(type) && !voxelBiomes) {
    toast("Loading biome data...");
    ensureVoxelBiomes().then(
      () => { try { snCreateWorld(); } catch (e) { console.error(e); } },
      (err) => { console.error(err); toast("Could not load biome data"); });
    return;
  }
  const name = ((UI.name || "New World").slice(0, 32) || "New World");
  const seedStr = (UI.seed || "").trim();
  const seed = seedStr === "" ? (Math.random() * 0xFFFFFFFF) >>> 0 : seedFromString(seedStr);
  const id = newId();
  const now = Date.now();
  const idx = loadIndex();
  idx.push({
    id: id, name: name,
    seedStr: seedStr === "" ? String(seed >>> 0) : seedStr,
    type: UI.F.wtype, mode: normMode(UI.F.gm), created: now, modified: now,
  });
  saveIndex(idx);
  saveWorldRec(id, {
    name: name, seed: seed >>> 0, type: UI.F.wtype, mode: normMode(UI.F.gm),
    difficulty: UI.F.diff, structures: UI.F.struct, cheats: UI.F.cheats,
    bonus: UI.F.bonus,
  });
  UI.sel = id;
  UI.view = "list";
  playWorld(id);
}

/* ---------------------------------------------------------- boot */

export function bootSingleplayer(g) {
  game = g || globalThis.game;
  if (!game || !game.assets || !game.assets.data || !game.assets.data.blocks) return false;
  IDS = resolveIds();
  VPAL = null;
  try { globalThis.__mcCompat = COMPAT || globalThis.__mcCompat || null; } catch (e) {}
  // No save migration on the 1194 line: this store is 1194-namespaced and
  // starts empty; 1.13.2/1.15.2 worlds live on their own lines. (migrateV2
  // is intentionally never called here.)
  try { installPatches(); } catch (e) { console.error("[singleplayer] patch failed", e); }
  try {
    const surv = globalThis.__mcSurvival;
    const mobs = surv && surv.mobTypes ? surv.mobTypes() : null;
    if (mobs) registrySimDone = true; // survival already up: full check now
    runRegistryCheck({ mobs, biomeIds: HILLS_BIOME_IDS, biomeNames: BIOME_NAMES });
  } catch (e) { console.warn("[registry-check] skipped:", (e && e.message) || e); }
  try { wireMenuNow(); } catch (e) {}
  globalThis.__mcSingleplayer = {
    state: SP,
    play: playWorld,
    save: saveNow,
    fq: FQ, // FastQuit jobs (test/debug surface: fqSaving via jobs list)
    flushSave: () => { try { flushFastSavesSync(); return true; } catch (e) { return false; } },
    worlds: loadIndex,
    toast: (m) => toast(m),
    chat: handleChatCommand,
    // test hooks: scripted world create/delete (mirror the menu paths)
    create: (o) => {
      try {
        o = o || {};
        const id = newId(), now = Date.now();
        const idx = loadIndex();
        idx.push({ id, name: (o.name || "Test World").slice(0, 32), seedStr: String(o.seed == null ? (Math.random() * 0xFFFFFFFF) >>> 0 : o.seed), type: o.type || "tectonic", mode: normMode(o.mode == null ? 0 : o.mode), created: now, modified: now });
        saveIndex(idx);
        saveWorldRec(id, { name: (o.name || "Test World").slice(0, 32), seed: (o.seed == null ? (Math.random() * 0xFFFFFFFF) >>> 0 : o.seed) >>> 0, type: o.type || "tectonic", mode: normMode(o.mode == null ? 0 : o.mode), difficulty: o.diff == null ? 1 : o.diff, structures: o.structures !== false, cheats: !!o.cheats, bonus: !!o.bonus });
        return id;
      } catch (e) { return null; }
    },
    del: (id) => {
      try {
        // FastQuit mirror of the menu Delete: cancel any background job so
        // its completion can't resurrect the record.
        try {
          for (let i = FQ.jobs.length - 1; i >= 0; i--) {
            const j = FQ.jobs[i];
            if (j && j.id === id) { j.cancelled = true; j.done = true; FQ.jobs.splice(i, 1); }
          }
        } catch (e) {}
        saveIndex(loadIndex().filter((x) => x.id !== id)); deleteWorldRec(id); return true;
      } catch (e) { return false; }
    },
    genState: function (x, y, z) { return genState(x, y, z, SP.seed, SP.type); },
    genWant: function (x, y, z, dim) { return genWant(x, y, z, SP.seed, SP.type, dim | 0); },
    netherState: function (x, y, z) { return netherState(x, y, z, SP.seed); },
    endState: function (x, y, z) { return endState(x, y, z, SP.seed); },
    findStronghold: function () {
      try {
        const s = strongholdAt(SP.seed, SP.type);
        return s ? { x: s.x, y: s.fy + 1, z: s.z } : null;
      } catch (e) { return null; }
    },
    surfaceY: function (x, z, dim) { try { return surfaceY(x, z, SP.seed, SP.type, dim | 0); } catch (e) { return 64; } },
    switchDim: function (to, x, y, z, opts) { try { return switchDim(to | 0, x, y, z, opts); } catch (e) { return false; } },
    portalTarget: function (from, x, z) { try { return portalTarget(from | 0, x, z); } catch (e) { return null; } },
    villageAt: function (x, z) { try { return villageAt(x, z, SP.seed, SP.type); } catch (e) { return null; } },
    findVillage: function (nx, nz, maxR) {
      try {
        return findVillageNear(nx == null ? SP.spawn.x : nx, nz == null ? SP.spawn.z : nz, SP.seed, SP.type, maxR || 3000);
      } catch (e) { return null; }
    },
    mansionAt: function (x, z) { try { return mansionAt(x, z, SP.seed, SP.type); } catch (e) { return null; } },
    findMansion: function (nx, nz, maxR, budget) {
      try {
        return findMansionNear(nx == null ? SP.spawn.x : nx, nz == null ? SP.spawn.z : nz, SP.seed, SP.type, maxR || 10000, budget);
      } catch (e) { return null; }
    },
    geodeAt: function (x, y, z) { try { return geodeAt(x, y, z, SP.seed); } catch (e) { return null; } },
    geodeCell: function (cx, cz) { try { return geodeCenterOfCell(cx, cz, SP.seed); } catch (e) { return null; } },
    caveBiome: function (x, y, z) { try { return caveBiome(x, y, z, SP.seed); } catch (e) { return -9; } },
    stFor: function (name, want) { try { return stStateFor(name, want || {}); } catch (e) { return -9; } },
    monumentAt: function (x, z) { try { return monumentAt(x, z, SP.seed, SP.type); } catch (e) { return null; } },
    findMonument: function (nx, nz, maxR, budget) {
      try {
        return findMonumentNear(nx == null ? SP.spawn.x : nx, nz == null ? SP.spawn.z : nz, SP.seed, SP.type, maxR || 10000, budget);
      } catch (e) { return null; }
    },
    // v1.15.0: fortress lattice (nether coords) + finder + biome probe
    fortressAt: function (x, z) { try { return fortressAt(x, z, SP.seed); } catch (e) { return null; } },
    findFortress: function (nx, nz, maxR, budget) {
      try {
        return findFortressNear(nx == null ? (SP.spawn.x || 0) / 8 : nx, nz == null ? (SP.spawn.z || 0) / 8 : nz, SP.seed, maxR || 10000, budget);
      } catch (e) { return null; }
    },
    netherBiome: function (x, z) { try { return netherBiome(x, z, SP.seed); } catch (e) { return -1; } },
    // v1.16.0: End cities lattice + gateway rim + kill gating
    cityAt: function (x, z) { try { return endCityAt(x, z, SP.seed); } catch (e) { return null; } },
    // v1.16.0: journal an override for any dimension (works on unloaded
    // chunks, unlike live setState — used for the gateway return pedestal)
    setOv: function (dim, x, y, z, s) {
      try { ovMapFor(dim | 0)[(x | 0) + "," + (y | 0) + "," + (z | 0)] = s | 0; bumpOvVer(dim | 0); SP.dirty = true; return true; } catch (e) { return false; }
    },
    citiesNear: function (x, z, maxR, budget) {
      try {
        return endCitiesNear(x == null ? 100 : x, z == null ? 0 : z, SP.seed, maxR || 4000, budget);
      } catch (e) { return []; }
    },
    gatewaySpots: function () { try { return endGatewaySpots(SP.seed); } catch (e) { return []; } },
    endTopAt: function (x, z) { try { return endTop(x, z, SP.seed); } catch (e) { return 63; } },
    pillarTops: function () {
      try {
        return endPillars(SP.seed).map((pl) => {
          const t = endTop(pl.x, pl.z, SP.seed);
          return { x: pl.x, y: t + pl.h + 1, z: pl.z };
        });
      } catch (e) { return []; }
    },
    islandAt: function (x, z) { try { return outerIsland(Math.floor(x), Math.floor(z), SP.seed); } catch (e) { return null; } },
    endKills: function () { try { return endKillsFor(SP.seed); } catch (e) { return 0; } },
    setEndKills: function (n) { try { setEndKills(SP.seed, n); } catch (e) {} },
    // light column probe for the explorer-map builder (h + fill-path biome)
    colAt: function (x, z) { try { const c = colInfo(x, z, SP.seed, SP.type); return { h: c.h, b: c.b }; } catch (e) { return null; } },
    biomeAt: function (x, z) { try { return biomeAt(x, z, SP.seed, SP.type); } catch (e) { return null; } },
    // v1.10 bees: trunk info for natural nest seeding (null off-hills)
    treeInfo: function (x, z) {
      try {
        if (SP.type !== "hills" && SP.type !== "tectonic") return null;
        const has = treeAt(x, z, SP.seed, SP.type);
        return {
          trunk: !!has,
          th: has ? trunkHeight(x, z, SP.seed) : 0,
          wood: has ? treeWood(x, z, SP.seed, SP.type) : 0,
          gy: colInfo(x, z, SP.seed, SP.type).h,
          biome: biomeAt(x, z, SP.seed, SP.type),
        };
      } catch (e) { return null; }
    },
    // survival persists its payload straight to LS (bypassing memFallback);
    // it calls this after each write so the next loadWorldRec re-reads fresh.
    dropCache: function (id) { try { delete memFallback.worlds[id]; } catch (e) {} },
    // realms (room mirrors) shares the same world store
    index: loadIndex,
    saveIndex,
    worldRec: loadWorldRec,
    saveWorldRec,
    newId,
  };
  console.log("[singleplayer-1194] ready");
  return true;
}

function wireMenuNow() {
  // Wire the current title screen immediately (same as the poll/patch path).
  try {
    const cur = game.screens && game.screens.current;
    if (cur && !game.inWorld && cur.buttons) {
      const btn = cur.buttons.find((b) => b && b.id === 1);
      if (btn && btn.enabled === false) {
        btn.enabled = true;
        btn.onClick = function () { openMenu(); };
      }
    }
  } catch (e) {}
}
//__SP_END__
