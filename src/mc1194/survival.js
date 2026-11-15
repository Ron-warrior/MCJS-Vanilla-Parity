/* MinecraftJS Survival — 1.15.2 port (src/mc1152).
 *
 * The engine is a lone client: in singleplayer there is no server, so it
 * never takes damage, drops nothing and spawns no mobs. This module IS the
 * missing server half, but only when the world is in survival mode
 * (SP.mode === 0). Creative worlds are untouched.
 *
 * Numeric ids below are the NATIVE 1.15.2 unified entity registry
 * (src/mc1152/js/game/entity-registry-1.15.2.js: mobs, objects and
 * projectiles share one id space since 1.14 — there is no separate
 * Spawn-Mob/Spawn-Entity numbering anymore).
 *
 * Systems (all in this file):
 *   player damage  — fall, drowning, lava, void, starvation, mob hits;
 *     armor reduction, hurt cooldown, regen, death overlay + respawn
 *   hunger         — distance-based drain, eating via right-click food
 *   drops+items    — player breaks drop loot (tool-gated); item entities
 *     with physics, magnet, engine-native pickup fly-in (the engine's own
 *     onCollect path: 3-tick lerp to the player + hotbar pop), despawn,
 *     and persistence across saves (the dead collect nothing)
 *   mobs           — spawn director (night hostiles, day passives, caps,
 *     despawn, daylight burn), AABB physics (gravity, step-up, water),
 *     melee AI, skeleton arrows, creeper explosions, combat both ways,
 *     sounds, loot
 *   bees (v1.10)   — forage/nectar/pollinate loop, hives/nests + honey,
 *     campfire-smoke calming, hand/dispenser harvest, poison stings,
 *     campfire light/burn, natural nests, silk carry
 *
 * Conventions: import-free IIFE (offline copies inject blob modules, so no
 * relative imports). Everything guards on SV.on (survival world active).
 * Debug/test surface: globalThis.__mcSurvival.
 */

(function () {
"use strict";

/* ---------------------------------------------------------- basics */

function game() { return globalThis.game; }
function SP() { return globalThis.__mcSingleplayer && globalThis.__mcSingleplayer.state; }
function chat(m) { try { game().hud.addChat(m); } catch (e) {} }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

const SV = {
  on: false,          // survival world currently active
  tickTimer: 0,
  eidSeq: 1000000,    // entity ids: far above anything the client assigns
  mobs: new Map(),    // entityId -> mob record
  corpses: [],        // v1.12 death-animation records {id, at}: the engine
                      // entity stays falling for ~1s after the sim record dies
  items: new Map(),   // entityId -> item record
  arrows: new Map(),  // entityId -> projectile record
  orbs: new Map(),    // entityId -> xp orb record
  air: 15, // drown breath, seconds (vanilla 300 ticks)
  peakY: null,        // fall tracking
  wasGround: true,
  exh: 0, // exhaustion 0-4 (drains saturation first, then hunger)
  starveAcc: 0, regenAcc: 0,
  hurtAt: 0, // player hurt cooldown timestamp
  burnUntil: 0, burnAcc: 0, // player burning: 1 dmg/sec while lit
  lavaAcc: 0, fireAcc: 0, voidAcc: 0, // per-source half-second accumulators
  fx: {}, // status effects: name -> {lvl, until} (ms timestamps)
  absorb: 0, // absorption buffer HP (golden apple). The engine HUD has no
             // yellow-hearts field, so this pool is invisible — see README.
  xpLevel: 0, xpTotal: 0,
  atkAt: 0, // last player attack timestamp (cooldown)
  stateToDef: null,   // stateId -> block def (built lazily)
  itemNameToId: null, // food/weapon resolution
  foodNutri: null, // engine foods table cache (hunger/saturation)
 dead: false,
 grief: false,       // true while WE break blocks (no drops, still saved)
 savedItems: null,
  boats: new Map(),  // entityId -> boat record {id, e, variant, hits, hitAt}
  rideBoat: -1,       // boat entityId the player currently rides (-1 = none)
  rideCamel: -1,      // P4 camel entityId the player rides (-1 = none)
  savedBoats: null,
 carts: new Map(),  // entityId -> cart record {id, e, variant, vx, vy, vz, ...}
 rideCart: -1,       // cart entityId the player currently rides (-1 = none)
 savedCarts: null,
  horses: new Map(), // entityId -> horse record {id, e, species, tame, saddle, ...}
  rideHorse: -1,      // horse entityId the player currently rides (-1 = none)
  savedHorses: null,
  stands: new Map(), // entityId -> armor-stand record {id, e, x,y,z, yaw, vy, gear[4], name}
  savedStands: null,
  crops: new Map(),   // "x,y,z" -> {x,y,z} crop/farmland watch-set (blocks persist as world diffs)
  cropAcc: 0,         // slow-tick accumulator (crop sim runs at 1 Hz)
  conduits: new Map(), // v1.15.0 "x,y,z" -> {x,y,z} placed conduits (frame validated live by conduitTick; persists via rec.conduits)
  frogspawn: new Map(), // P4 "x,y,z" -> {x,y,z,until} laid frogspawn (hatches to tadpoles; persists via rec.frogspawn)
  wires: new Map(),   // v1.11 "x,y,z" -> {x,y,z,kind} redstone watch-set (dust + components + lamps/tnt/note/detectors)
  rsDirty: new Set(), // v1.11 keys needing a redstone propagate pass
  rsQueue: [],        // v1.11 scheduled component updates {x,y,z,until}
  rsAcc: 0,           // v1.11 periodic-refresh accumulator (detector drift)
  torchTog: new Map(),// v1.11 key -> [tickN...] recent torch toggles (burnout window)
  torchOut: new Set(),// v1.11 burnt-out torch keys (revive on nearby change)
  compLvl: new Map(),// v1.11 comparator key -> output level 0-15
  notePrev: new Map(),// v1.11 note-block key -> was powered (rising edge)
  obsPulse: new Map(),// v1.13 observer key -> until tickN: active pulse (off at fire)
  obsSeen: new Map(), // v1.13 changedCell>state -> tickN (live-path notifications; settle dedupe)
  pistJ: [],          // v1.13 piston move journal [{face,dx,dy,dz,ext,sticky,px,py,pz,writes}]
  pistSettleAt: 0,    // v1.13 tickN to process settle drops/pops/notify
  pistProg: new Map(),// v1.13 moving-key -> {prog, at} stall watchdog
  obsOn: false,       // v1.13 true once an observer is tracked (gates wrapper reads)
  pistonMove: null,   // v1.13 {writes:{key:oldS}} while engine piston writes run
 wx: null, // weather: {rain, thunder, rainT, thunderT, strikeAt} seconds; null = unseeded
};

/* Only true while a survival world is live. Everything below no-ops otherwise. */
function survives() {
  try {
    const sp = SP(), g = game();
    return !!(SV.on && sp && sp.active && (sp.mode | 0) === 0 && g && g.inWorld && !SV.dead);
  } catch (e) { return false; }
}
function survivesLoose() {
  // for loops that must also run while the death overlay is up
  try {
    const sp = SP(), g = game();
    return !!(SV.on && sp && sp.active && (sp.mode | 0) === 0 && g && g.inWorld);
  } catch (e) { return false; }
}

function difficulty() {
  // 0 peaceful, 1 easy, 2 normal, 3 hard. Engine default is 1; singleplayer
  // sets it per world on entry; /difficulty changes it live.
  try {
    const d = game().difficulty | 0;
    return d >= 0 && d <= 3 ? d : 2;
  } catch (e) { return 2; }
}

function getSat() {
  try { return Math.max(0, game().saturation | 0); } catch (e) { return 0; }
}
function setSat(s) {
  s = clamp(s, 0, 20);
  try {
    game().saturation = s;
    if (game().player && typeof game().player.saturation === "number") game().player.saturation = s;
  } catch (e) {}
  return s;
}
function addExhaustion(n) {
  // vanilla: exhaustion accumulates to 4, then eats 1 saturation (or 1 hunger
  // if saturation is empty). Peaceful never drains.
  if (difficulty() === 0) return;
  SV.exh += n;
  while (SV.exh >= 4) {
    SV.exh -= 4;
    if (getSat() > 0) setSat(getSat() - 1);
    else if (getFood() > 0) setFood(getFood() - 1);
  }
}

/* ---------------------------------------------------------- registries */

function buildStateIndex() {
  if (SV.stateToDef) return SV.stateToDef;
  const idx = [];
  try {
    const arr = game().assets.data.blocks;
    for (const b of arr) {
      if (!b) continue;
      const lo = b.minStateId | 0, hi = (b.maxStateId != null ? b.maxStateId : lo) | 0;
      for (let s = lo; s <= hi; s++) idx[s] = b;
    }
  } catch (e) {}
  SV.stateToDef = idx;
  return idx;
}
function defOf(state) {
  if ((state | 0) === 0) return null;
  const idx = buildStateIndex();
  return idx[state | 0] || null;
}
function blockNameAt(x, y, z) {
  try {
    // Math.floor (not |0): truncation reads the wrong block for negative
    // fractional coords (-9.5|0 === -9, but the point sits in block -10)
    const d = defOf(game().world.getState(Math.floor(x), Math.floor(y), Math.floor(z)));
    return d ? d.name : "";
  } catch (e) { return ""; }
}
// hills biome at a column ("plains"/"desert"/"jungle"/"swamp"/"ocean"/
// "river"/"beach"/"snow"/"rock"), or null off-hills/unavailable —
// spawn rules below keep their legacy behavior when null.
function spBiome(x, z) {
  try {
    const sp = globalThis.__mcSingleplayer;
    if (sp && typeof sp.biomeAt === "function") return sp.biomeAt(x, z);
  } catch (e) {}
  return null;
}
function isSolidXYZ(x, y, z) {
  // Math.floor (not |0): see blockNameAt — truncation misreads negative
  // fractional coords
  const d = defOf(game().world.getState(Math.floor(x), Math.floor(y), Math.floor(z)));
  if (!d || d.id === 0) return false;
  if (d.name === "water" || d.name === "lava") return false;
  if (d.boundingBox === "empty") return false;
  if (d.material === "plant" || d.material === "web") return false;
  return true;
}
function itemIdByName(name) {
  try {
    if (!SV.itemNameToId) {
      SV.itemNameToId = {};
      const byName = game().assets.itemsByName;
      if (byName) {
        if (typeof byName.get === "function") {
          // Map-like; keys unknown — fall through to scan below
        } else {
          for (const k in byName) {
            const v = byName[k];
            SV.itemNameToId[k] = (v && v.id != null) ? v.id : v | 0;
          }
        }
      }
      if (game().items) {
        if (game().items.byName) {
          const bn = game().items.byName;
          if (bn.forEach) bn.forEach((v, k) => { SV.itemNameToId[k] = v.id != null ? v.id : v; });
          else for (const k in bn) SV.itemNameToId[k] = bn[k].id != null ? bn[k].id : bn[k];
        }
      }
    }
    const v = SV.itemNameToId[name];
    if (v != null) return v | 0;
    // 1.13 names retired in 1.14+ (sign->oak_sign, rose_red->red_dye, ...):
    // resolve through the compat alias table so old loot/save names keep working
    try {
      const C = globalThis.__mcCompat;
      const al = C && C.aliases && C.aliases[name];
      if (al && SV.itemNameToId[al] != null) return SV.itemNameToId[al] | 0;
    } catch (e) {}
    return null;
  } catch (e) { return null; }
}

/* ---------------------------------------------------------- data tables
 * Wiki-crosschecked (minecraft.wiki, 1.13.2-era values):
 *  - food hunger/saturation: engine assets.data.foods table (matches wiki),
 *    fallbacks for items the engine table omits (still real 1.13 items)
 *  - tool damage/speed: Sword/Axe/Shovel/Hoe wiki infoboxes (JE rows)
 *  - armor points: 1.13 values (diamond has 2 toughness/piece, rest 0)
 *  - mob hp/speed/damage/drops/xp: per-mob wiki pages
 *  - explosion: impact=(1-d/2p)*exposure, dmg=(impact^2+impact)/2*7*(2p)+1
 *  - xp curve: 2L+7 (0-15), 5L-38 (16-30), 9L-158 (31+)
 *  - exhaustion: swim .01/m, break .005, sprint .1/m, jump .05 (.2 sprint),
 *    attack .1, regen 6.0/hp, hunger-effect .005*lvl/tick
 *  - light: hostiles <=7 (1.13 rule; the "0" on the wiki is post-1.18),
 *    passives >=9, spiders hostile at <=11
 * 1.13.2 notes: no sweet_berries/suspicious_stew (1.14 items, not in engine).
 */

const FOOD_FALLBACK = { // name -> {hunger, sat} for real 1.13 foods the engine table omits
  pufferfish: { hunger: 1, sat: 0.2 }, tropical_fish: { hunger: 1, sat: 0.2 },
  salmon: { hunger: 2, sat: 0.4 }, cooked_salmon: { hunger: 6, sat: 9.6 },
  dried_kelp: { hunger: 1, sat: 0.6 },
};
const FOOD_ALIAS = { // item-registry name -> foods-table name
  carrot: "carrots", potato: "potatoes", melon_slice: "melon_block",
  cod: "fish", cooked_cod: "cooked_fish",
};
function foodNutri(name) {
  if (!name || name === "cake") return null; // cake is a placeable block, not hand food
  try {
    if (!SV.foodNutri) {
      SV.foodNutri = {};
      const arr = game().assets.data.foods || [];
      for (const f of arr) {
        if (f && f.name) SV.foodNutri[f.name] = { hunger: f.foodPoints | 0, sat: +f.saturation || 0 };
      }
      for (const k in FOOD_FALLBACK) if (!SV.foodNutri[k]) SV.foodNutri[k] = FOOD_FALLBACK[k];
    }
    return SV.foodNutri[FOOD_ALIAS[name] || name] || FOOD_FALLBACK[name] || null;
  } catch (e) { return FOOD_FALLBACK[FOOD_ALIAS[name] || name] || FOOD_FALLBACK[name] || null; }
}
// name -> on-eat extras (wiki Effects rows; ticks at 20/s)
const FOOD_FX = {
  rotten_flesh: { chance: 0.8, fx: [["hunger", 1, 600]] },   // Hunger I 0:30
  chicken: { chance: 0.3, fx: [["hunger", 1, 600]] },         // Hunger I 0:30
  spider_eye: { chance: 1, fx: [["poison", 1, 100]] },        // Poison I 0:05
  pufferfish: { chance: 1, fx: [["hunger", 3, 300], ["poison", 2, 1200]] }, // Hunger III 0:15 + Poison II 1:00 (nausea has no survival effect, skipped)
  poisonous_potato: { chance: 0.6, fx: [["poison", 2, 100]] }, // Poison II 0:05
  // suspicious stew: one random flower effect (vanilla 1.15 durations;
  // blindness/wither have no survival effect and are skipped)
  suspicious_stew: { chance: 1, stew: true },
  golden_apple: { chance: 1, always: true, fx: [["absorption", 1, 2400], ["regen", 2, 100]] }, // Abs I 2:00 + Regen II 0:05
  chorus_fruit: { chance: 1, teleport: true },
};
const WEAPON = { // kind -> damage by material (halves) + attack speed
  sword: { dmg: { wood: 4, gold: 4, stone: 5, iron: 6, diamond: 7 }, speed: 1.6 },
  axe: { dmg: { wood: 7, gold: 7, stone: 9, iron: 9, diamond: 9 }, speed: { wood: 0.8, gold: 1, stone: 0.8, iron: 0.9, diamond: 1 } },
  pickaxe: { dmg: { wood: 2, gold: 2, stone: 3, iron: 4, diamond: 5 }, speed: 1.2 },
  shovel: { dmg: { wood: 2.5, gold: 2.5, stone: 3.5, iron: 4.5, diamond: 5.5 }, speed: 1 },
  hoe: { dmg: { wood: 1, gold: 1, stone: 1, iron: 1, diamond: 1 }, speed: { wood: 1, gold: 1, stone: 2, iron: 3, diamond: 4 } },
};
function weaponStats(itemName) {
  if (!itemName) return { dmg: 1, period: 0.25 }; // bare hand: 1 dmg, 4.0 speed
  for (const kind in WEAPON) {
    if (itemName.endsWith("_" + kind)) {
      const w = WEAPON[kind];
      const mat = itemName.slice(0, -(kind.length + 1));
      const dmg = w.dmg[mat] != null ? w.dmg[mat] : 1;
      const sp = typeof w.speed === "number" ? w.speed : (w.speed[mat] != null ? w.speed[mat] : 1);
      return { dmg, period: 1 / sp };
    }
  }
  if (itemName === "trident") return { dmg: 8, period: 1 / 1.1 };
  return { dmg: 1, period: 0.25 };
}
function weaponDamage(itemName) { return weaponStats(itemName).dmg; }

// armor piece points (1.13) + toughness (diamond 2/piece, rest 0)
const ARMOR_PTS = {
  helmet: { leather: 1, gold: 2, chainmail: 2, iron: 2, diamond: 3 },
  chestplate: { leather: 3, gold: 5, chainmail: 5, iron: 6, diamond: 8 },
  leggings: { leather: 2, gold: 3, chainmail: 4, iron: 5, diamond: 6 },
  boots: { leather: 1, gold: 1, chainmail: 1, iron: 2, diamond: 3 },
};
function wornArmor() {
  // {A: total points, T: total toughness} from actually worn pieces.
  // Slot order isn't needed — only names matter.
  let A = 0, T = 0;
  try {
    const inv = game().inventory;
    const worn = (inv && inv.armor) || [];
    for (const s of worn) {
      if (!s || !s.id) continue;
      const def = game().items && game().items.def ? game().items.def(s.id) : null;
      const nm = def ? def.name : null;
      if (!nm) continue;
      const m = nm.match(/^(leather|gold|chainmail|iron|diamond|chain)_?(helmet|chestplate|leggings|boots)$/);
      if (!m) continue;
      const mat = m[1] === "chain" ? "chainmail" : m[1], piece = m[2];
      const pts = (ARMOR_PTS[piece] && ARMOR_PTS[piece][mat]) || 0;
      A += pts;
      if (mat === "diamond") T += 2;
    }
  } catch (e) {}
  if (!A) {
    // engine fallback (older layout): total points only, no toughness info
    try {
      const inv = game().inventory;
      if (inv && typeof inv.armorPoints === "number") A = inv.armorPoints;
      else if (inv && typeof inv.armorPoints === "function") A = inv.armorPoints() | 0;
    } catch (e) {}
  }
  return { A, T };
}
function armorReduce(dmg, A, T) {
  // 1.9+ formula (unchanged in 1.13): min(20, max(A/5, A - dmg/(2+T/4)))/25
  const red = Math.min(20, Math.max(A / 5, A - dmg / (2 + T / 4))) / 25;
  return dmg * (1 - red);
}

// block name -> extra/chance drops beyond def.drops (1.13 names)
function bonusDrops(name, rand, held) {
  if (name === "redstone_wire") return ["redstone"]; // dust item, not the wire block
  if (name === "redstone_wall_torch") return ["redstone_torch"];
  const isLeaves = name === "oak_leaves" || name === "birch_leaves" || name === "spruce_leaves" ||
      name === "jungle_leaves" || name === "acacia_leaves" || name === "dark_oak_leaves";
  if (isLeaves) {
    if (held === "shears") return [name]; // leaf block itself, vanilla
    const sap = name.replace("_leaves", "_sapling");
    return rand() < 0.05 ? [sap] : null;
  }
  if (name === "vine") return held === "shears" ? ["vine"] : []; // hands tear vines, vanilla
  if (name === "cobweb") return held && held.slice(-6) === "_sword" ? ["string"] : null; // shears->web (def), swords->string
  if (name === "dead_bush") { const r = rand(); return r < 0.25 ? [] : r < 0.75 ? ["stick"] : ["stick", "stick"]; } // 0-2 sticks, vanilla
  if (name === "gravel" && rand() < 0.1) return ["flint"];
  if (name === "grass_block") return ["dirt"];
  if (name === "stone") return ["cobblestone"];
  if (name === "deepslate") return ["cobbled_deepslate"];
  if (name === "tall_grass" || name === "grass") return rand() < 0.12 ? ["wheat_seeds"] : [];
  if (name === "melon") return ["melon_slice", "melon_slice", "melon_slice"];
  if (name === "farmland") return ["dirt"];
  return null; // use def.drops
}

const MOB_DEFS = {
  // type id (native 1.15.2 unified entity registry), hp, speed m/s, melee dmg {Easy,Normal,Hard},
  // follow range, xp (number or [lo,hi]). Wiki-crosschecked per mob page.
  zombie:    { type: 95, hp: 20, speed: 2.2, dmg: { 1: 2.5, 2: 3, 3: 4.5 }, range: 24, hostile: true, burns: true, armor: 2, xp: 5, loot: [["rotten_flesh", 0, 2]] },
  husk:      { type: 33, hp: 20, speed: 2.2, dmg: { 1: 2.5, 2: 3, 3: 4.5 }, range: 24, hostile: true, burns: false, armor: 2, xp: 5, hungerHit: true, loot: [["rotten_flesh", 0, 2]] },
  skeleton:  { type: 66, hp: 20, speed: 2.3, dmg: { 1: 2, 2: 2, 3: 3 }, range: 20, hostile: true, burns: true, ranged: true, arrowDmg: { 1: [2, 4], 2: [3, 5], 3: [4, 8] }, xp: 5, loot: [["bone", 0, 2], ["arrow", 0, 2]] },
  stray:     { type: 75, hp: 20, speed: 2.3, dmg: { 1: 2, 2: 2, 3: 3 }, range: 20, hostile: true, burns: false, ranged: true, arrowDmg: { 1: [2, 4], 2: [3, 5], 3: [4, 8] }, xp: 5, loot: [["bone", 0, 2], ["arrow", 0, 2]] },
  creeper:   { type: 12, hp: 20, speed: 2.2, dmg: 0, range: 20, hostile: true, burns: false, creeper: true, fuse: 1.5, xp: 5, loot: [["gunpowder", 0, 2]] },
  spider:    { type: 73, hp: 16, speed: 3.2, dmg: { 1: 2, 2: 2, 3: 3 }, range: 20, hostile: true, burns: false, climb: true, w: 1.4, h: 0.9, xp: 5, loot: [["string", 0, 2]] },
  enderman:  { type: 20, hp: 40, speed: 3.1, dmg: { 1: 4, 2: 7, 3: 10 }, range: 32, hostile: true, burns: false, stare: true, h: 2.9, xp: 5, loot: [["ender_pearl", 0, 1]] },
  // passives
  cow:       { type: 11, hp: 10, speed: 1.8, dmg: 0, range: 0, hostile: false, xp: [1, 3], loot: [["leather", 0, 2], ["beef", 1, 3]] },
  pig:       { type: 55, hp: 10, speed: 1.8, dmg: 0, range: 0, hostile: false, xp: [1, 3], loot: [["porkchop", 1, 3]] },
  sheep:     { type: 62, hp: 8, speed: 1.5, dmg: 0, range: 0, hostile: false, xp: [1, 3], loot: [["white_wool", 1, 1], ["mutton", 1, 2]] },
  chicken:   { type: 9, hp: 4, speed: 2.0, dmg: 0, range: 0, hostile: false, glide: true, xp: [1, 3], loot: [["feather", 0, 2], ["chicken", 1, 1]] },
  rabbit:    { type: 60, hp: 3, speed: 2.2, dmg: 0, range: 0, hostile: false, hop: true, xp: [1, 3], loot: [["rabbit", 0, 1], ["rabbit_hide", 0, 1]] },
  wolf:      { type: 94, hp: 8, speed: 2.6, dmg: { 1: 3, 2: 4, 3: 6 }, range: 20, hostile: false, neutral: true, xp: 3, loot: [] },
  squid:     { type: 74, hp: 10, speed: 1.6, dmg: 0, range: 0, hostile: false, swim: true, xp: [1, 3], loot: [["ink_sac", 1, 3]] },
  bat:       { type: 3, hp: 6, speed: 2.0, dmg: 0, range: 0, hostile: false, fly: true, xp: 0, loot: [] },
  turtle:    { type: 78, hp: 30, speed: 1.2, dmg: 0, range: 0, hostile: false, swim: true, xp: [1, 3], loot: [["seagrass", 0, 2]] },
  ocelot:    { type: 51, hp: 10, speed: 2.0, dmg: 0, range: 0, hostile: false, xp: [1, 3], loot: [] },
  parrot:    { type: 54, hp: 6, speed: 2.0, dmg: 0, range: 0, hostile: false, fly: true, xp: [1, 3], loot: [["feather", 1, 2]] },
  polar:     { type: 58, hp: 30, speed: 2.2, dmg: { 1: 4, 2: 6, 3: 9 }, range: 20, hostile: false, neutral: true, xp: [1, 3], loot: [["cod", 0, 2], ["salmon", 0, 2]] },
  dolphin:   { type: 14, hp: 10, speed: 3.0, dmg: 0, range: 0, hostile: false, swim: true, xp: [1, 3], loot: [["cod", 0, 1]] },
  bee:       { type: 4, hp: 10, speed: 2.4, dmg: { 1: 2, 2: 2, 3: 3 }, range: 20, hostile: false, neutral: true, fly: true, bee: true, xp: [1, 3], loot: [] },
  villager:  { type: 85, hp: 20, speed: 2.0, dmg: 0, range: 0, hostile: false, village: true, persistent: true, xp: 0, loot: [] },
  // hostiles wave 2 (silverfish/pearl-mite have no natural source here: see below)
  slime:     { type: 68, hp: 16, speed: 2.4, dmg: { 1: 3, 2: 4, 3: 6 }, range: 20, hostile: true, burns: false, hop: true, xp: 4, loot: [] },
  witch:     { type: 90, hp: 26, speed: 2.2, dmg: 0, range: 12, hostile: true, burns: false, witch: true, xp: 5, loot: [["stick", 0, 2], ["glowstone_dust", 0, 2], ["redstone", 0, 2], ["sugar", 0, 2], ["gunpowder", 0, 2], ["spider_eye", 0, 2], ["glass_bottle", 0, 2]] },
  silverfish:{ type: 65, hp: 8, speed: 2.4, dmg: { 1: 1, 2: 1, 3: 2 }, range: 20, hostile: true, burns: false, xp: 5, loot: [] },
  endermite: { type: 21, hp: 8, speed: 2.4, dmg: { 1: 2, 2: 2, 3: 3 }, range: 20, hostile: true, burns: false, xp: 3, loot: [] },
  phantom:   { type: 98, hp: 20, speed: 3.4, dmg: { 1: 4, 2: 6, 3: 9 }, range: 32, hostile: true, burns: true, phantom: true, fly: true, xp: 5, loot: [["phantom_membrane", 0, 1]] },
  magma_cube:{ type: 41, hp: 16, speed: 2.4, dmg: { 1: 3, 2: 5, 3: 7 }, range: 20, hostile: true, burns: false, hop: true, xp: 4, loot: [] },
  // player-built defenders (no villages/strongholds exist, so no natural spawns)
  iron_golem:{ type: 86, hp: 100, speed: 2.2, dmg: { 1: 7, 2: 15, 3: 21 }, range: 12, hostile: false, defender: true, xp: 0, loot: [["iron_ingot", 3, 5], ["poppy", 0, 2]] },
  snow_golem:{ type: 70, hp: 4, speed: 1.8, dmg: 0, range: 10, hostile: false, snowman: true, xp: 0, loot: [["snowball", 0, 15]] },
  // village-system wave (v1.14): illagers raid, patrol and garrison; the
  // trader wanders in on his own schedule. Melee numbers are the wiki
  // infobox {easy, normal, hard} values; pillager arrows are crossbow
  // shots (2-9 by difficulty); evoker fangs hit 6 like vanilla.
  pillager:  { type: 88, hp: 24, speed: 2.2, dmg: { 1: 3, 2: 5, 3: 7 }, range: 20, hostile: true, ranged: true, arrowDmg: { 1: [2, 4], 2: [3, 6], 3: [4, 8] }, illager: true, xp: 5, loot: [["arrow", 0, 2]] },
  vindicator:{ type: 87, hp: 24, speed: 2.4, dmg: { 1: 7, 2: 13, 3: 19 }, range: 20, hostile: true, illager: true, xp: 5, loot: [["emerald", 0, 1]] },
  evoker:    { type: 23, hp: 24, speed: 2.0, dmg: 0, range: 16, hostile: true, evoker: true, illager: true, xp: 10, loot: [["totem_of_undying", 1, 1], ["emerald", 0, 1]] },
   vex:       { type: 84, hp: 14, speed: 3.4, dmg: { 1: 5, 2: 9, 3: 13 }, range: 24, hostile: true, fly: true, illager: true, vex: true, xp: 3, loot: [] },
  ravager:   { type: 99, hp: 100, speed: 2.6, dmg: { 1: 7, 2: 12, 3: 18 }, range: 16, hostile: true, illager: true, heavy: true, xp: 20, loot: [] },
  wandering_trader: { type: 89, hp: 20, speed: 2.0, dmg: 0, range: 0, hostile: false, persistent: true, trader: true, xp: 0, loot: [["lead", 1, 2]] },
  trader_llama: { type: 76, hp: 25, speed: 2.2, dmg: 0, range: 16, hostile: false, neutral: true, spit: true, persistent: true, xp: 3, loot: [] },
  // P4 (1.17 mobs): goat rams unprovoked (def.ram branch) and retaliates
  // (neutral); axolotl/glow_squid swim (def.swim branch). Sim ids 103-105.
  goat:      { type: 103, hp: 10, speed: 2.0, dmg: { 1: 1, 2: 2, 3: 3 }, range: 16, hostile: false, neutral: true, ram: true, softFall: true, xp: [1, 3], loot: [] },
  axolotl:   { type: 104, hp: 14, speed: 1.8, dmg: 0, range: 0, hostile: false, swim: true, xp: [1, 3], loot: [] },
  glow_squid:{ type: 105, hp: 10, speed: 1.6, dmg: 0, range: 0, hostile: false, swim: true, xp: [1, 3], loot: [["glow_ink_sac", 1, 3]] },
  // P4 (1.19 mobs, sim ids 106-111): frog hops and eats small slimes (froglight
  // by variant); tadpole swims and grows; allay flies, fetches and duplicates;
  // camel is rideable (saddle) with a dash; sniffer sniffs up seeds; warden is
  // summoned by shriekers (senses, booms, despawns when calm).
  frog:      { type: 106, hp: 10, speed: 2.2, dmg: 0, range: 0, hostile: false, frog: true, hop: true, xp: [1, 3], loot: [] },
  tadpole:   { type: 107, hp: 6, speed: 1.6, dmg: 0, range: 0, hostile: false, swim: true, tadpole: true, xp: [1, 3], loot: [] },
  allay:     { type: 108, hp: 20, speed: 2.6, dmg: 0, range: 0, hostile: false, fly: true, allay: true, xp: 0, loot: [] },
  camel:     { type: 109, hp: 32, speed: 2.4, dmg: 0, range: 0, hostile: false, camel: true, rideable: true, xp: [1, 3], loot: [] },
  sniffer:   { type: 110, hp: 14, speed: 1.8, dmg: 0, range: 0, hostile: false, sniffer: true, xp: [1, 3], loot: [] },
  warden:    { type: 111, hp: 500, speed: 2.4, dmg: { 1: 16, 2: 30, 3: 45 }, range: 24, hostile: true, burns: false, warden: true, xp: 5, loot: [["sculk_catalyst", 0, 1]] },
  // v1.15.0 ocean: guardian swims and melees; elders seed only in monuments
  // (persistent) with a mining-fatigue aura; drowned swim and rarely drop
  // tridents/shells. Type ids are indices into the alphabetical 1.15.2
  // registry (verify live on first spawn: drowned 16, elder 17, guardian 31).
  guardian:  { type: 31, hp: 30, speed: 2.4, dmg: { 1: 4, 2: 6, 3: 9 }, range: 24, hostile: true, swim: true, xp: 10, loot: [["prismarine_shard", 0, 2], ["cod", 0, 1]] },
  elder_guardian: { type: 17, hp: 80, speed: 2.4, dmg: { 1: 5, 2: 8, 3: 12 }, range: 32, hostile: true, swim: true, elder: true, persistent: true, xp: 10, loot: [["prismarine_shard", 0, 2], ["sponge", 1, 1]] },
  drowned:   { type: 16, hp: 20, speed: 2.2, dmg: { 1: 2, 2: 3, 3: 4.5 }, range: 24, hostile: true, swim: true, burns: false, xp: 5, loot: [["rotten_flesh", 0, 2]] },
  // summoned boss (soul-sand T + 3 wither skulls, by hand or dispenser)
  wither:{ type: 64, hp: 300, speed: 3.0, dmg: { 1: 8, 2: 15, 3: 22 }, range: 48, hostile: true, wither: true, fly: true, persistent: true, xp: 50, loot: [["nether_star", 1, 1]] },
  // v1.15.0 nether: blazes hover and fire small-fireball volleys; wither
  // skeletons hit hard and wither. Type ids are registry indices
  // (blaze 5, wither_skeleton 92 — verified live at first spawn).
  blaze:     { type: 5, hp: 20, speed: 2.2, dmg: 6, range: 18, hostile: true, burns: false, blaze: true, xp: 10, loot: [["blaze_rod", 0, 1]] },
  wither_skeleton: { type: 92, hp: 20, speed: 2.2, dmg: { 1: 5, 2: 8, 3: 12 }, range: 20, hostile: true, burns: false, xp: 5, loot: [["coal", 0, 1], ["bone", 0, 2]] },
  // v1.16.0: End-city turrets — stationary, persistent, lob guided bullets
  // (type 63 = registry index of shulker; verified live at first spawn)
  shulker:   { type: 63, hp: 30, speed: 0, dmg: 0, range: 16, hostile: true, burns: false, shulker: true, persistent: true, xp: 5, loot: [["shulker_shell", 0, 1]] },
  // v1.16.0 endgame: the dragon circles the island, dives, perches and
  // breathes (type 19 = registry index of ender_dragon, 16x8 boss, 200 hp)
  ender_dragon: { type: 19, hp: 200, speed: 10, dmg: { 1: 6, 2: 10, 3: 15 }, range: 96, hostile: true, burns: false, dragon: true, fly: true, persistent: true, xp: 0, loot: [] },
};

// spawn-egg item -> our species (only mobs we simulate; the rest need their
// mob first — see VANILLA_PARITY Tier 1/3)
const EGG_SPECIES = {
  axolotl_spawn_egg: "axolotl",
  bat_spawn_egg: "bat", bee_spawn_egg: "bee", chicken_spawn_egg: "chicken", cow_spawn_egg: "cow",
  creeper_spawn_egg: "creeper", dolphin_spawn_egg: "dolphin",
  enderman_spawn_egg: "enderman", endermite_spawn_egg: "endermite",
  evoker_spawn_egg: "evoker",
  glow_squid_spawn_egg: "glow_squid", goat_spawn_egg: "goat",
  husk_spawn_egg: "husk", magma_cube_spawn_egg: "magma_cube",
  ocelot_spawn_egg: "ocelot", parrot_spawn_egg: "parrot",
  phantom_spawn_egg: "phantom", pig_spawn_egg: "pig",
  horse_spawn_egg: "horse", donkey_spawn_egg: "donkey",
  mule_spawn_egg: "mule", llama_spawn_egg: "llama",
  pillager_spawn_egg: "pillager",
  polar_bear_spawn_egg: "polar", rabbit_spawn_egg: "rabbit",
  ravager_spawn_egg: "ravager",
  frog_spawn_egg: "frog", tadpole_spawn_egg: "tadpole",
  allay_spawn_egg: "allay", camel_spawn_egg: "camel",
  sniffer_spawn_egg: "sniffer", warden_spawn_egg: "warden",
  sheep_spawn_egg: "sheep", silverfish_spawn_egg: "silverfish",
  skeleton_spawn_egg: "skeleton", slime_spawn_egg: "slime",
  spider_spawn_egg: "spider", squid_spawn_egg: "squid",
  stray_spawn_egg: "stray", turtle_spawn_egg: "turtle",
  trader_llama_spawn_egg: "trader_llama",
  vex_spawn_egg: "vex",
  vindicator_spawn_egg: "vindicator",
  wandering_trader_spawn_egg: "wandering_trader",
  shulker_spawn_egg: "shulker",
  witch_spawn_egg: "witch", wolf_spawn_egg: "wolf",
  zombie_spawn_egg: "zombie", villager_spawn_egg: "villager",
  guardian_spawn_egg: "guardian", elder_guardian_spawn_egg: "elder_guardian",
  drowned_spawn_egg: "drowned",
  blaze_spawn_egg: "blaze", wither_skeleton_spawn_egg: "wither_skeleton",
};

// dye item -> sheep wool color (1.14+ *_dye names; the 1.13 names still in
// old saves resolve via the compat alias fallback in itemIdByName)
const DYE_COLOR = {
  bone_meal: "white", orange_dye: "orange", magenta_dye: "magenta",
  light_blue_dye: "light_blue", yellow_dye: "yellow", dandelion_yellow: "yellow",
  lime_dye: "lime", pink_dye: "pink", gray_dye: "gray",
  light_gray_dye: "light_gray", cyan_dye: "cyan", purple_dye: "purple",
  lapis_lazuli: "blue", cocoa_beans: "brown",
  green_dye: "green", cactus_green: "green",
  red_dye: "red", rose_red: "red", ink_sac: "black",
};
// vanilla dye order = fleece color index (entity-renderer FLEECE/ENTITY_DYES)
const FLEECE_ORDER = ["white", "orange", "magenta", "light_blue", "yellow",
  "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown",
  "green", "red", "black"];
function fleeceOf(color) {
  const i = FLEECE_ORDER.indexOf(color || "white");
  return i < 0 ? 0 : i;
}
// set the coat on both the sim record and the engine entity (the 1.15.2
// renderer tints from e.fleece/e.sheared natively, not e.color)
function paintSheep(rec, color) {
  if (!rec) return;
  rec.color = color;
  try {
    if (rec.e) { rec.e.fleece = fleeceOf(color); rec.e.sheared = !!rec.sheared; }
  } catch (e) {}
}

// drinkable/splashable potion -> effects. Keys are the 1.13 Potion-tag suffix
// (minecraft: prefix stripped). Durations are game ticks (20/s), levels are
// vanilla 1-based — stored as-is, matching the SV.fx convention that every
// hasFx reader (poison/regen periods, presence guards) already expects.
const POTION_FX = {
  // [effect, vanillaLvl, ticks] / drink+throw both; harm/heal are instant
  night_vision: [["night_vision", 1, 3600]], long_night_vision: [["night_vision", 1, 9600]],
  invisibility: [["invisibility", 1, 3600]], long_invisibility: [["invisibility", 1, 9600]],
  leaping: [["leaping", 1, 3600]], strong_leaping: [["leaping", 2, 1800]],
  fire_resistance: [["fire_resistance", 1, 3600]], long_fire_resistance: [["fire_resistance", 1, 9600]],
  swiftness: [["swiftness", 1, 3600]], strong_swiftness: [["swiftness", 2, 1800]], long_swiftness: [["swiftness", 1, 9600]],
  slowness: [["slowness", 1, 1800]], strong_slowness: [["slowness", 2, 800]], long_slowness: [["slowness", 1, 4800]],
  water_breathing: [["water_breathing", 1, 3600]], long_water_breathing: [["water_breathing", 1, 9600]],
  healing: [["instant_heal", 1, 0]], strong_healing: [["instant_heal", 2, 0]],
  harming: [["instant_harm", 1, 0]], strong_harming: [["instant_harm", 2, 0]],
  poison: [["poison", 1, 900]], strong_poison: [["poison", 2, 420]], long_poison: [["poison", 1, 1800]],
  regeneration: [["regen", 1, 900]], strong_regeneration: [["regen", 2, 450]], long_regeneration: [["regen", 1, 1800]],
  strength: [["strength", 1, 3600]], strong_strength: [["strength", 2, 1800]], long_strength: [["strength", 1, 9600]],
  weakness: [["weakness", 1, 1800]], long_weakness: [["weakness", 1, 4800]],
  slow_falling: [["slow_falling", 1, 1800]], long_slow_falling: [["slow_falling", 1, 4800]],
  turtle_master: [["slowness", 3, 400], ["strength", 1, 400]],
  strong_turtle_master: [["slowness", 4, 400], ["strength", 2, 400]],
  // mundane/mundane?... bases below do nothing (vanilla-accurate)
};

// ore name -> xp orb value range (vanilla; quartz lives in the Nether, which
// doesn't exist here, so it's absent)
const ORE_XP = {
  coal_ore: [0, 2], diamond_ore: [3, 7], emerald_ore: [3, 7],
  lapis_ore: [2, 5], redstone_ore: [1, 5],
  deepslate_coal_ore: [0, 2], deepslate_diamond_ore: [3, 7], deepslate_emerald_ore: [3, 7],
  deepslate_lapis_ore: [2, 5], deepslate_redstone_ore: [1, 5],
};

function xpForLevelUp(level) { // cost to go level -> level+1
  if (level <= 15) return 2 * level + 7;
  if (level <= 30) return 5 * level - 38;
  return 9 * level - 158;
}
function xpTotalForLevel(level) { // total xp to HAVE reached `level`
  if (level <= 16) return level * level + 6 * level;
  if (level <= 31) return 2.5 * level * level - 40.5 * level + 360;
  return 4.5 * level * level - 162.5 * level + 2220;
}
function orbSplit(v) { // vanilla orb sizes, greedy
  const sizes = [2477, 1231, 617, 307, 149, 73, 37, 17, 7, 3, 1];
  const out = [];
  for (const s of sizes) while (v >= s) { out.push(s); v -= s; }
  return out;
}

/* ---------------------------------------------------------- HUD sync */

function setHP(hp) {
  hp = clamp(Math.round(hp), 0, 20);
  try {
    game().health = hp; game().prevHealth = hp;
    if (game().player) game().player.health = hp;
  } catch (e) {}
  return hp;
}
function getHP() {
  try { return game().health | 0; } catch (e) { return 20; }
}
function setFood(f) {
  f = clamp(Math.round(f), 0, 20);
  try {
    game().food = f;
    if (game().player && typeof game().player.food === "number") game().player.food = f;
  } catch (e) {}
  return f;
}
function getFood() {
  try { return game().food | 0; } catch (e) { return 20; }
}
function armorPoints() {
  // legacy shim: prefer wornArmor() (per-piece points + toughness)
  try { return wornArmor().A; } catch (e) { return 0; }
}
function sfx(name, vol) {
  // playAtPlayer: global (non-positional) sound, the 1.15.2 signature is
  // play(name, x, y, z, volume, pitch, opts) — no null coords. Async: swallow
  // rejections (bad names resolve null anyway).
  try {
    const pr = game().sound.playAtPlayer(name, vol == null ? 1 : vol);
    if (pr && typeof pr.catch === "function") pr.catch(() => {});
  } catch (e) {}
}
function hurtSound() { sfx("entity.player.hurt"); }

/* ---------------------------------------------------------- status effects
 * fx: name -> {lvl, until} with ms timestamps. Durations/periods from the
 * wiki effect pages: Poison I 25t/hp (floor 1), II 12t/hp; Regen I 50t/hp,
 * II 25t/hp; Hunger adds 0.005*lvl exhaustion/tick; Absorption is a damage
 * pool (engine HUD has no yellow hearts, so no visual); Fire Resistance
 * nullifies lava/fire/burn. Milk clears all.
 */
function addFx(name, lvl, ticks) {
  try {
    const until = Date.now() + ticks * 50;
    const cur = SV.fx[name];
    if (!cur || cur.lvl < lvl || cur.until < until) SV.fx[name] = { lvl, until };
  } catch (e) {}
}
function hasFx(name) {
  try {
    const f = SV.fx[name];
    if (!f) return 0;
    if (Date.now() > f.until) { delete SV.fx[name]; return 0; }
    return f.lvl;
  } catch (e) { return 0; }
}
function clearFx() { SV.fx = {}; SV.absorb = 0; }
function tickFx(dt) {
  const now = Date.now();
  // poison: drains to a floor of 1 HP (never kills)
  const pl = hasFx("poison");
  if (pl) {
    const period = pl >= 2 ? 1.2 : 2.5; // II: 12 ticks, I: 25 ticks
    SV.poisonAcc = (SV.poisonAcc || 0) + dt;
    if (SV.poisonAcc >= period && getHP() > 1) {
      SV.poisonAcc = 0;
      damagePlayer(1, "poison", { bypassArmor: true, ignoreCooldown: true });
    }
  }
  // wither: same clock shape as poison, but it can kill (no 1-HP floor)
  const wl = hasFx("wither");
  if (wl) {
    const wperiod = wl >= 2 ? 1.0 : 2.0;
    SV.witherAcc = (SV.witherAcc || 0) + dt;
    if (SV.witherAcc >= wperiod) {
      SV.witherAcc = 0;
      damagePlayer(1, "wither", { bypassArmor: true, ignoreCooldown: true });
    }
  }
  // regen: heals on its own clock (separate from natural regen)
  const rl = hasFx("regen");
  if (rl) {
    const period = rl >= 2 ? 1.25 : 2.5; // II: 25 ticks, I: 50 ticks
    SV.regenFxAcc = (SV.regenFxAcc || 0) + dt;
    if (SV.regenFxAcc >= period && getHP() < 20) {
      SV.regenFxAcc = 0;
      setHP(getHP() + 1);
    }
  }
  // hunger effect: extra exhaustion (0.005*lvl per tick); peaceful exempt
  const hl = hasFx("hunger");
  if (hl && difficulty() !== 0) addExhaustion(0.005 * hl * dt * 10);
  // expiry sweep + absorption expiry
  for (const k in SV.fx) if (SV.fx[k] && now > SV.fx[k].until) delete SV.fx[k];
  if (!SV.fx.absorption) SV.absorb = 0;
}

/* ---------------------------------------------------------- player damage */

function damagePlayer(amount, cause, o) {
  // o: {bypassArmor (lava/fire/drown/void/starve/magic), bypassAbsorb,
  //      ignoreCooldown (burn/poison-style ticks with their own accumulators),
  //      killer (display name for the death message)}
  o = o || {};
  if (!survives()) return false;
  if (amount <= 0) return false;
  const now = Date.now();
  if (!o.ignoreCooldown && now - SV.hurtAt < 500) return false; // hurt cooldown
  SV.hurtAt = now;
  // fire resistance nullifies lava/fire/burn outright
  if ((cause === "lava" || cause === "fire" || cause === "burn") && (hasFx("fire_resistance") || hasFx("fireres"))) return false;
  // shields: actively blocking (RMB + shield) nullifies melee and arrows
  // (not explosions, magic, fire, falls, hunger, drowning...)
  let dmg = amount;
  if ((cause === "mob" || cause === "arrow") && blockingWith()) {
    try {
      const hand = blockingWith();
      try { SV.lastBlock = { cause, hand, t: Date.now() }; } catch (ee) {}
      if (hand === "off") wearOff(1); else wearMain(1);
      game().sound.play("item.shield.block");
    } catch (e) {}
    return false;
  }
  if (!o.bypassArmor) {
    const w = wornArmor();
    dmg = armorReduce(dmg, w.A, w.T);
  }
  // vanilla: worn armor takes 1 durability per physical-ish hit
  // (not from falls, drowning, starvation, magic, void...)
  try {
    if (!o.bypassArmor && amount > 0 &&
        (cause === "mob" || cause === "arrow" || cause === "boom" ||
         cause === "lava" || cause === "fire" || cause === "burn")) {
      wearWornArmor(1);
    }
  } catch (e) {}
  // absorption pool eats damage first (any cause)
  if (SV.absorb > 0 && !o.bypassAbsorb) {
    const eat = Math.min(SV.absorb, dmg);
    SV.absorb -= eat; dmg -= eat;
  }
  dmg = Math.round(dmg);
  const hp = getHP();
  // starvation floors: Easy stops at 10, Normal at 1, Hard kills
  if (cause === "starve") {
    const d = difficulty();
    if (d === 0) return false;
    if (d === 1 && hp <= 10) return false;
    if (d === 2 && hp <= 1) return false;
  }
  if (dmg <= 0) return false;
  setHP(hp - dmg);
  hurtSound();
  try {
    const p = game().player;
    if (p) p.hurtTime = 10;
    // mirror the engine's own damage packet (on_update_health): the Game
    // hurt timer plus the red blinking hearts (hud.healthFlash)
    game().hurtTime = 10;
    if (game().hud) game().hud.healthFlash = (game().ticks | 0) + 20;
  } catch (e) {}
  if (cause) SV.lastDeath = { cause, killer: o.killer || null };
  if (cause === "mob" || cause === "arrow") rallyPets(); // your wolves saw that
  if (getHP() <= 0) killPlayer(cause || "died", o.killer);
  return true;
}

function killPlayer(cause, killer) {
  if (!survivesLoose() || SV.dead) return;
  // totem of undying: cheats death once (either hand)
  try {
    if (totemIn("main") || totemIn("off")) {
      const v = inv();
      if (v) {
        if (totemIn("main")) consumeOne(() => v.main[game().heldSlot | 0], (s) => { v.main[game().heldSlot | 0] = s; });
        else consumeOne(() => v.offhand[0], (s) => { v.offhand[0] = s; });
      }
      setHP(1);
      try { SV.fx = {}; SV.absorb = 4; } catch (e) {}
      addFx("regen", 1, 900); addFx("fireres", 1, 800);
      try { game().sound.play("item.totem.use"); } catch (e) {}
      try {
        const p = game().player;
        game().particles.totem(p.x, p.y + 1, p.z, 30);
      } catch (e) {}
      return;
    }
  } catch (e) {}
  SV.dead = true;
  setHP(0);
  try { if ((SV.rideCamel | 0) >= 0) dismountCamel(); } catch (eC) {}
  // P4: recovery compass target (persists via rec.deathPos below).
  try {
    const p = game().player;
    SV.deathPos = { x: p.x, y: p.y, z: p.z, dim: game().dimension | 0 };
  } catch (eD) {}
  // vanilla: drop a portion of xp as orbs (7 per 100, up to 100), then wipe
  try {
    const drop = Math.min(100, Math.floor(SV.xpTotal * 0.07));
    if (drop > 0) {
      const g = game(), p = g.player;
      for (const v of orbSplit(drop)) spawnXPOrb(p.x, p.y + 0.5, p.z, v);
    }
  } catch (e) {}
  SV.xpLevel = 0; SV.xpTotal = 0;
  try { syncXP(); } catch (e) {}
  // scatter the inventory around the death point
  try { dropAllItems(); } catch (e) {}
  try { game().sound.play("entity.player.death"); } catch (e) {}
  showDeath(cause || "died", killer);
}

function deathMessage(cause, killer) {
  const n = game().username || "Player";
  const k = killer ? " by " + killer : "";
  const msgs = {
    fall: n + " hit the ground too hard",
    drown: n + " drowned",
    lava: n + " tried to swim in lava",
    fire: n + " went up in flames",
    burn: n + " burned to death",
    void: n + " fell out of the world",
    starve: n + " starved to death",
    mob: n + " was slain" + k,
    boom: n + " was blown up" + k,
    arrow: n + " was shot" + k,
    poison: n + " was killed by magic",
  };
  return msgs[cause] || (n + " died");
}

function showDeath(cause, killer) {
  hideDeath();
  const msg = deathMessage(cause, killer);
  // native engine death screen first (real MC look, world visible behind)
  try {
    const ng = globalThis.__mcNativeGui;
    if (ng && typeof ng.showDeath === "function" &&
        ng.showDeath({ title: "You died!", message: msg, okLabel: "Respawn" }, onDeathDismiss)) return;
  } catch (e) {}
  // Native-only from here: the engine harvest runs at boot and the
  // title is always up before any world loads, so the native screen is
  // available whenever death can happen. Last resort (should not happen):
  // respawn directly rather than strand a corpse-walking player with no UI.
  try { game.hud.addChat("\u00a7cYou died! (" + msg + ")"); } catch (e) {}
  try { respawn(); } catch (e2) {}
}
function hideDeath() {
  try {
    const ng = globalThis.__mcNativeGui;
    if (ng && typeof ng.dismiss === "function") ng.dismiss();
  } catch (e) {}
}
// native death screen button/Enter path (same as the old Respawn click)
function onDeathDismiss() {
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
  respawn();
}

function respawn() {
  hideDeath();
  const sp = SP();
  SV.dead = false;
  if (SV.rideBoat >= 0) dismountBoat(); // don't wake up still glued to a boat
  if (SV.rideCart >= 0) dismountCart();
  if (SV.rideHorse >= 0) dismountHorse();
  try { if ((SV.rideCamel | 0) >= 0) dismountCamel(); } catch (e) {}
  // death in the Nether respawns at the overworld spawn (vanilla)
  try {
    if (sp && (sp.dim | 0) !== 0) {
      const mc = globalThis.__mcSingleplayer;
      if (mc && typeof mc.switchDim === "function") {
        const s = sp.spawn || { x: 8.5, y: 80, z: 8.5 };
        mc.switchDim(0, s.x, s.y, s.z);
      }
    }
  } catch (e) {}
  SV.air = 15;
  SV.exh = 0;
  SV.fx = {}; SV.absorb = 0;
  SV.burnUntil = 0; SV.burnAcc = 0;
  SV.peakY = null;
 SV.mobs.clear();
 SV.arrows.clear();
 SV.orbs.clear();
  // v1.15.0: a mid-flight trident is neither in hand nor inventory — drop its
  // stashed stack at the flight position (vanilla death drops) before clearing
  try {
    SV.arrows.forEach((a) => {
      if (a && a.kind === "trident" && a.stash) {
        try {
          const id = spawnItemEntity(a.x, a.y + 0.2, a.z, a.stash.id, 1);
          if (id != null) {
            const rec = SV.items.get(id);
            if (rec && rec.e && rec.e.item) {
              rec.e.item.damage = a.stash.dmg | 0;
              if (a.stash.nbt) rec.e.item.nbt = a.stash.nbt;
            }
          }
        } catch (e) {}
        try { game().entities.destroy([a.id]); } catch (e) {}
      }
    });
  } catch (e) {}
 // B2: the village seed-once sets must go too, or re-seed skips every
  // village (they were just wiped) and they stay empty forever. Re-seeds
  // restore the same villagers (stable slot hashes + rec.vtrade).
  try { V_SEED.done.clear(); V_SEED.slots.clear(); } catch (e2) {}
  try { if (SV.bobber) game().entities.destroy([SV.bobber.id]); } catch (e) {}
 SV.bobber = null; SV.bowDraw = null;
  SV.tridentDraw = null; // v1.15.0: trident throw charge (mirrors bowDraw)
  if (SV.trackedArrows) SV.trackedArrows.clear();
  setHP(20);
  setFood(20);
  setSat(20);
  try {
    const s = (sp && sp.spawn) || { x: 0.5, y: 70, z: 0.5 };
    const p = game().player;
    p.setPosition(s.x, s.y + 0.5, s.z);
    p.prevX = s.x; p.prevY = s.y; p.prevZ = s.z;
    p.motionX = p.motionY = p.motionZ = 0;
    p.yaw = 0; p.pitch = 0;
  } catch (e) {}
  chat("§eRespawned");
}

/* inventory helpers */
function heldStack() {
  try {
    const inv = game().inventory;
    if (inv) {
      if (typeof inv.getHand === "function") {
        const h = inv.getHand();
        if (h) return h;
      }
      if (inv.main && typeof game().heldSlot === "number") return inv.main[game().heldSlot] || null;
      if (inv.held) return inv.held;
    }
  } catch (e) {}
  return null;
}
function heldName() {
  try {
    const s = heldStack();
    if (!s || !s.id) return null;
    const def = game().items && game().items.def ? game().items.def(s.id) : null;
    return def ? def.name : null;
  } catch (e) { return null; }
}
function consumeHeld(count) {
  try {
    const inv = game().inventory;
    const slot = game().heldSlot | 0;
    const s = inv.main && inv.main[slot];
    if (!s) return false;
    s.count -= (count || 1);
    if (s.count <= 0) inv.main[slot] = null;
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- environment tick (10 Hz) */

function envTick(dt) {
  const g = game(), p = g.player;
  if (!p) return;
  const peaceful = difficulty() === 0;
  // v1.16.0: elytra wears 1 durability per second of flight (vanilla 1/s);
  // a broken elytra stops flying (engine clears on landing already)
  try {
    if (p.elytraFlying && survives() && !SV.dead) {
      SV.elytraAcc = (SV.elytraAcc || 0) + dt;
      if (SV.elytraAcc >= 1) {
        SV.elytraAcc = 0;
        const v = inv(), worn = (v && v.armor) || [];
        if (worn[2] && worn[2].id) {
          try {
            const d = game().items.def(worn[2].id);
            if (d && d.name === "elytra") {
              wearStackAt(() => worn[2], (s) => { worn[2] = s; }, 1);
              if (!worn[2]) { try { p.elytraFlying = false; } catch (e2) {} }
            }
          } catch (e2) {}
        } else { try { p.elytraFlying = false; } catch (e2) {} }
      }
    } else SV.elytraAcc = 0;
  } catch (e) {}
  // --- falling (vanilla: floor(fall - 3); armor reduces)
  if (p.onGround) {
    if (SV.peakY != null && !SV.wasGround) {
      const fall = SV.peakY - p.y;
      if (fall > 3 && !hasFx("slow_falling")) { // vanilla: slow falling takes no fall damage
        damagePlayer(Math.floor(fall - 3), "fall");
        try { sfx("entity.player.big_fall", Math.min(1, fall / 12)); } catch (e) { try { sfx("entity.player.small_fall"); } catch (e2) {} }
      }
      try { if (fall > 0.75) trampleAt(p.x, p.y, p.z); } catch (e) {}
    }
    SV.peakY = null;
    SV.wasGround = true;
  } else {
    if (SV.peakY == null || p.y > SV.peakY) SV.peakY = p.y;
    SV.wasGround = false;
  }
  // --- exhaustion from movement: sprint 0.1/m, swim 0.01/m, jump 0.05
  try {
    const dx = p.x - (SV.lastX == null ? p.x : SV.lastX);
    const dz = p.z - (SV.lastZ == null ? p.z : SV.lastZ);
    const dist = Math.sqrt(dx * dx + dz * dz);
    SV.lastX = p.x; SV.lastZ = p.z;
    if (dist > 0.001 && !peaceful) {
      if (p.sprinting) addExhaustion(dist * 0.1);
      else if (liquidAt(p.x, p.y + 0.2, p.z) === "water") addExhaustion(dist * 0.01);
    }
    if (p.onGround) SV.jumpMark = true;
    else if (SV.jumpMark && (p.motionY || 0) > 0.3 && !peaceful) {
      SV.jumpMark = false;
      addExhaustion(p.sprinting ? 0.2 : 0.05);
    }
  } catch (e) {}
  // --- drowning (eyes in water; 15s air, then 2 dmg/sec)
  let eyeWater = false, inLava = false, inFire = false;
  try {
    const eyeY = p.y + 1.62;
    eyeWater = blockNameAt(p.x, eyeY, p.z) === "water";
    const feet = blockNameAt(p.x, p.y + 0.2, p.z);
    inLava = feet === "lava" || blockNameAt(p.x, eyeY, p.z) === "lava";
    inFire = feet === "fire" || blockNameAt(p.x, eyeY, p.z) === "fire";
  } catch (e) {}
  if (eyeWater) {
    // vanilla: water breathing stops the air drain (potion/turtle shell)
    if (!hasFx("water_breathing")) SV.air -= dt;
    else SV.air = Math.min(15, SV.air + dt * 5);
    // air bubbles are native (hud.renderStats reads selfMetadata[1] = air*20,
    // 300 = full): feed it, since no server packet ever will offline
    try {
      const gg = game();
      gg.selfMetadata = gg.selfMetadata || {};
      gg.selfMetadata[1] = clamp(Math.ceil(SV.air * 20), 0, 300);
    } catch (e) {}
    if (SV.air <= 0) {
      SV.air = 0;
      if (!SV.drownAcc || Date.now() - SV.drownAcc > 1000) {
        SV.drownAcc = Date.now();
        damagePlayer(2, "drown", { bypassArmor: true });
      }
    }
  } else SV.air = Math.min(15, SV.air + dt * 5);
  try { if (typeof p.air === "number") p.air = Math.ceil(SV.air); } catch (e) {}
  // out of water: drop the key so the HUD falls back to its default (300 = full)
  if (!eyeWater) {
    try { if (game().selfMetadata && (1 in game().selfMetadata)) delete game().selfMetadata[1]; } catch (e) {}
  }
  // --- lava: 4 dmg per 0.5s + ignite 15s (fire res nullifies)
  if (inLava && !hasFx("fire_resistance")) {
    SV.lavaAcc += dt;
    if (SV.lavaAcc >= 0.5) { SV.lavaAcc = 0; damagePlayer(4, "lava", { bypassArmor: true }); }
    SV.burnUntil = Date.now() + 15000;
  }
  // --- fire block: 1 dmg per 0.5s + ignite 8s
  if (inFire && !hasFx("fire_resistance")) {
    SV.fireAcc += dt;
    if (SV.fireAcc >= 0.5) { SV.fireAcc = 0; damagePlayer(1, "fire", { bypassArmor: true }); }
    SV.burnUntil = Math.max(SV.burnUntil, Date.now() + 8000);
  }
  // --- lit campfire: 1 dmg per 0.5s + ignite 8s (vanilla campfire burn)
  try {
    if (blockNameAt(p.x, p.y + 0.2, p.z) === "campfire") {
      const cst = g.world.getState(Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z));
      if (stProp(cst, "lit") === "true") {
        SV.campAcc = (SV.campAcc || 0) + dt;
        if (SV.campAcc >= 0.5) { SV.campAcc = 0; damagePlayer(1, "fire", { bypassArmor: true }); }
        SV.burnUntil = Math.max(SV.burnUntil, Date.now() + 8000);
      } else SV.campAcc = 0;
    } else SV.campAcc = 0;
  } catch (e) {}
  // --- burning: 1 dmg/sec while lit (armor does NOT reduce).
  // vanilla: rain on bare skin puts fire out fast. Fire resistance swaps
  // burning for immunity (still shows flames, takes no damage).
  if (Date.now() < SV.burnUntil && !hasFx("fire_resistance")) {
    try { if (isRainingAt(p.x, p.y + 1, p.z)) SV.burnUntil = Math.min(SV.burnUntil, Date.now() + 400); } catch (e) {}
    SV.burnAcc += dt;
    if (SV.burnAcc >= 1) { SV.burnAcc = 0; damagePlayer(1, "burn", { bypassArmor: true, ignoreCooldown: true }); }
  } else SV.burnAcc = 0;
  // --- void: 4 dmg per 0.5s below MIN_Y (-64 in 1.18; the old -64 constant
  // happens to coincide, kept as a literal with the engine-agnostic check)
  if (p.y < -64) {
    SV.voidAcc += dt;
    if (SV.voidAcc >= 0.5) { SV.voidAcc = 0; damagePlayer(4, "void", { bypassArmor: true }); }
  } else SV.voidAcc = 0;
  // --- status effects tick
  try { tickFx(dt); } catch (e) {}
  // --- peaceful: hunger locked full, fast regen, nothing drains
  if (peaceful) {
    if (getFood() < 20) setFood(20);
    if (getHP() < 20) {
      SV.peaceAcc = (SV.peaceAcc || 0) + dt;
      if (SV.peaceAcc >= 0.5) { SV.peaceAcc = 0; setHP(getHP() + 1); }
    }
    return;
  }
  // --- starvation: 1 dmg per 4s (Easy stops at 10hp, Normal at 1, Hard kills)
  if (getFood() <= 0) {
    if (Date.now() - (SV.starveAcc || 0) > 4000) {
      SV.starveAcc = Date.now();
      damagePlayer(1, "starve", { bypassArmor: true, ignoreCooldown: true });
    }
  } else if (getFood() >= 18 && getHP() < 20) {
    // natural regen: 1 HP per 4s costing 6.0 exhaustion (saturation first)
    if (Date.now() - (SV.regenAcc || 0) > 4000) {
      SV.regenAcc = Date.now();
      setHP(getHP() + 1);
      addExhaustion(6.0);
    }
  }
}

function ignitePlayer(seconds) {
  SV.burnUntil = Math.max(SV.burnUntil, Date.now() + seconds * 1000);
}

/* ---------------------------------------------------------- eating */

function eatTick() {
  // right-click is engine-handled; we only need the item-use path (below).
  // This tick handles nothing — kept for symmetry with future effects.
}

function tryEat(item) {
  // item: engine stack {id, count, ...} from _onItemUse
  try {
    const def = game().items && game().items.def ? game().items.def(item.id) : null;
    const nm = def ? def.name : null;
    if (!nm) return false;
    // honey bottles cure poison and leave the glass bottle (vanilla);
    // drinkable even at full hunger
    if (nm === "honey_bottle") {
      consumeHeld(1);
      setFood(Math.min(20, getFood() + 6));
      try { setSat(Math.min(getFood(), getSat() + 1.2)); } catch (e) {}
      try { if (SV.fx && SV.fx.poison) delete SV.fx.poison; } catch (e) {}
      try {
        const bid = itemIdByName("glass_bottle");
        if (bid != null) {
          const v = game().inventory;
          if (v && typeof v.addToInventory === "function") v.addToInventory({ id: bid, damage: 0, count: 1 });
        }
        game().sound.play("entity.generic.drink");
      } catch (e) {}
      return true;
    }
    // milk clears all status effects, returns the bucket
    if (nm === "milk_bucket") {
      if (!Object.keys(SV.fx).length && !SV.absorb) return false;
      consumeHeld(1);
      clearFx();
      try {
        const bid = itemIdByName("bucket");
        if (bid != null) {
          const inv = game().inventory;
          if (inv && typeof inv.addToInventory === "function") inv.addToInventory({ id: bid, damage: 0, count: 1 });
        }
        game().sound.play("entity.generic.drink");
      } catch (e) {}
      return true;
    }
    const nut = foodNutri(nm);
    if (!nut) return false;
    const fx = FOOD_FX[nm];
    const alwaysEdible = !!(fx && fx.always);
    if (getFood() >= 20 && !alwaysEdible) return false; // full hunger (vanilla gate)
    consumeHeld(1);
    // vanilla: hunger += value, saturation += value capped at the food level
    setFood(Math.min(20, getFood() + nut.hunger));
    setSat(Math.min(getFood(), getSat() + nut.sat));
    if (fx && Math.random() < (fx.chance == null ? 1 : fx.chance)) {
      if (fx.stew) {
        // suspicious stew: exactly one random flower effect per bowl
        const r = Math.random();
        if (r < 0.14) { setFood(Math.min(20, getFood() + 1)); setSat(Math.min(getFood(), getSat() + 4)); }
        else {
          const pool = [["night_vision", 1, 100], ["fire_resistance", 1, 80], ["weakness", 1, 160], ["poison", 1, 240], ["regen", 1, 160], ["leaping", 1, 100]];
          const p = pool[(Math.random() * pool.length) | 0];
          addFx(p[0], p[1], p[2]);
        }
      } else for (const [ename, lvl, ticks] of (fx.fx || [])) {
        if (ename === "absorption") { SV.absorb = Math.max(SV.absorb, 4); addFx("absorption", lvl, ticks); }
        else addFx(ename, lvl, ticks);
      }
      if (fx.teleport) {
        // chorus fruit: random teleport ±8 on each axis (vanilla behavior)
        try {
          const p = game().player;
          const tx = p.x + (Math.random() * 16 - 8), tz = p.z + (Math.random() * 16 - 8);
          const gy = groundAt(tx, tz, Math.min(200, p.y + 8));
          if (gy != null) {
            try { game().particles.portal(p.x, p.y + 1, p.z, 0, 0, 0); } catch (e) {}
            p.setPosition(tx + 0.5, gy + 0.1, tz + 0.5);
            try { game().particles.portal(tx, gy + 1, tz, 0, 0, 0); } catch (e) {}
            sfx("entity.chorus_fruit.teleport");
          }
        } catch (e) {}
      }
    }
    try { game().sound.play("entity.generic.eat"); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// drinkable potions: read the Potion tag (minecraft:<name>), apply, return
// the glass bottle (vanilla). Water/mundane/thick/awkward do nothing.
function tryDrinkPotion(stack) {
  try {
    let tag = null;
    try { tag = (game().items.nbt(stack) || {}).Potion || null; } catch (e) {}
    const list = potionFxFor(tag);
    if (!list) return false; // water bottle etc: no effect, not consumed
    applyPotionFx(list, true, null);
    consumeHeld(1);
    try {
      const bid = itemIdByName("glass_bottle");
      if (bid != null) {
        const inv = game().inventory;
        if (inv && typeof inv.addToInventory === "function") inv.addToInventory({ id: bid, damage: 0, count: 1 });
      }
      game().sound.play("entity.generic.drink");
    } catch (e) {}
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- drops + item entities */

function dropIdForState(state, heldNameStr) {
  const d = defOf(state);
  if (!d) return null;
  if (d.name === "water" || d.name === "lava") return null;
  // tool gate: gated blocks drop nothing by hand/wrong tool
  try {
    if (d.harvestTools) {
      let ok = false;
      const held = heldNameStr || heldName();
      if (held) {
        // harvestTools keys are tool item ids; resolve held id instead
        const hs = heldStack();
        if (hs && d.harvestTools[hs.id]) ok = true;
      }
      if (!ok) return [];
    }
  } catch (e) {}
  // special cases first (leaves/saplings, gravel/flint, crops...)
  try {
    let held = null;
    try { held = heldNameStr || heldName(); } catch (e) {}
    // age-aware crop harvest (needs the state, not just the name)
    try {
      const cd = cropBreakDrops(state);
      if (cd) {
        const out = [];
        for (const n of cd) { const id = itemIdByName(n); if (id != null) out.push(id); }
        return out;
      }
    } catch (e) {}
    const bonus = bonusDrops(d.name, Math.random, held);
    if (bonus) {
      const out = [];
      for (const n of bonus) { const id = itemIdByName(n); if (id != null) out.push(id); }
      if (bonus.length && !out.length) return [];
      return out.length ? out : []; // [] = nothing (torn vines, unlucky grass); null above = def.drops
    }
  } catch (e) {}
  if (d.drops && d.drops.length) return d.drops.slice(0, 3);
  const self = itemIdByName(d.name);
  return self != null ? [self] : null;
}

function spawnItemEntity(x, y, z, itemId, count) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x, y, z, yaw: Math.random() * 360, pitch: 0,
      type: 35, objectData: 1,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    e.item = { id: itemId, count: count || 1, damage: 0 };
    SV.items.set(id, {
      id, e, vx: (Math.random() - 0.5) * 2, vy: 4 + Math.random() * 2.5, vz: (Math.random() - 0.5) * 2,
      age: 0, pickupDelay: 0.5,
    });
    syncEnt(e);
    // cap: oldest despawns first
    if (SV.items.size > 120) {
      let oldest = null, oldestAge = -1;
      SV.items.forEach((it) => { if (it.age > oldestAge) { oldestAge = it.age; oldest = it.id; } });
      if (oldest != null) removeItem(oldest);
    }
    return id;
  } catch (err) { return null; }
}

function removeItem(id) {
  try { SV.items.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}

function onPlayerBreak(x, y, z, oldState, newState) {
  if ((newState | 0) !== 0) return; // only full breaks drop
  // v1.16.0: punching the dragon egg teleports it (vanilla) instead of
  // dropping — relocate to nearby air, keep the item out of the world.
  try {
    const d0 = defOf(oldState);
    if (d0 && d0.name === "dragon_egg") {
      const g = game();
      let placed = false;
      for (let i = 0; i < 16 && !placed; i++) {
        try {
          const nx = (x | 0) + (((Math.random() * 31) | 0) - 15);
          const ny = (y | 0) + (((Math.random() * 11) | 0) - 3);
          const nz = (z | 0) + (((Math.random() * 31) | 0) - 15);
          // vanilla targets air (no support check — the egg is not a
          // falling block and stays where it lands)
          if (g.world.getState(nx, ny, nz) !== 0) continue;
          SV.grief = true;
          try { g.world.setState(nx, ny, nz, oldState); } finally { SV.grief = false; }
          placed = true;
        } catch (e) {}
      }
      try { g.sound.play("entity.enderman.teleport"); } catch (e) {}
      try { g.particles.poof(x + 0.5, y + 0.5, z + 0.5); } catch (e) {}
      return;
    }
  } catch (e) {}
  // v1.15.0: broken conduit blocks unregister (live block read = air now)
  try { conduitTrack(x | 0, y | 0, z | 0, oldState); } catch (e) {}
  // broken rails reshape their neighbors (vanilla auto-connect)
  try {
    const d = defOf(oldState);
    if (d && isRailName(d.name)) updateRailNeighbors(x, y, z);
  } catch (e) {}
  // Skyblock islands: the oneblock ticker owns drops (direct-to-inventory, so
  // nothing falls into the void) — don't ALSO spawn item entities here.
  try {
    const sp = SP();
    if (sp && sp.type === "oneblock" && globalThis.__mcOneBlockTicker && globalThis.__mcOneBlockTicker.synced) return;
  } catch (e) {}
  addExhaustion(0.005); // mining a block exhausts (vanilla 0.005)
  // vanilla: the used tool takes 1 durability (+1 extra for swords)
  try {
    const hn = heldName();
    if (hn && survives()) wearMain(hn.slice(-6) === "_sword" ? 2 : 1);
  } catch (e) {}
  // hives/nests/campfires override the engine drop table (1.15 rules +
  // swarm/carry handling); handled breaks skip the generic path below
  try {
    const d0 = defOf(oldState);
    if (d0 && (d0.name === "beehive" || d0.name === "bee_nest")) { if (hiveBreak(x, y, z, oldState)) return; }
    else if (d0 && d0.name === "campfire") { if (campfireBreak(x, y, z)) return; }
  } catch (e) {}
  const ids = dropIdForState(oldState);
  if (ids && ids.length) for (const id of ids) {
    try { spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1); } catch (e) {}
  }
  // container break: spill tile contents (vanilla) + close the window if open
  try {
    const k = tileKey(x, y, z);
    const t = SV.tiles && SV.tiles.get(k);
    if (t) {
      for (const s of (t.items || [])) {
        if (s && s.id) { try { spawnItemEntity(x + 0.5, y + 0.7, z + 0.5, s.id, s.count | 0 || 1); } catch (e) {} }
      }
      // furnace break also drops its banked XP as orbs (vanilla)
      if (furnaceLike(t.type) && (t.xp | 0) > 0) {
        try {
          let n = Math.floor(t.xp);
          if (Math.random() < t.xp - n) n++;
          if (n > 0) for (const v of orbSplit(n)) spawnXPOrb(x + 0.5, y + 0.5, z + 0.5, v);
        } catch (e) {}
      }
      try { SV.tiles.delete(k); } catch (e) {}
      if (SV.openTile && SV.openTile.key === k) {
        try { if (game().window) game().on_close_window({ windowId: game().window.windowId }); } catch (e) {}
        try { game().window = null; } catch (e) {}
        SV.openTile = null;
      }
    }
  } catch (e) {}
  // ore experience (no silk touch in this environment — always drops)
  try {
    const d = defOf(oldState);
    if (d && ORE_XP[d.name]) {
      const [lo, hi] = ORE_XP[d.name];
      const v = lo + ((Math.random() * (hi - lo + 1)) | 0);
      for (const s of orbSplit(v)) spawnXPOrb(x + 0.5, y + 0.5, z + 0.5, s);
    }
  } catch (e) {}
}

function dropAllItems() {
  try {
    const g = game(), p = g.player, inv = g.inventory;
    if (!inv || !inv.main) return;
    for (let i = 0; i < inv.main.length; i++) {
      const s = inv.main[i];
      if (s && s.id) {
        try { spawnItemEntity(p.x, p.y + 1, p.z, s.id, s.count || 1); } catch (e) {}
        inv.main[i] = null;
      }
    }
  } catch (e) {}
}

function tryPickup(rec) {
  // vanilla has NO magnet: the player picks up any item whose hitbox overlaps
  // their pickup box (+1 block horizontal, +0.5 vertical). Called at 10 Hz.
  const g = game(), p = g.player;
  if (!p) return;
  if (SV.dead) return; // the dead collect nothing (drops wait for respawn)
  if (rec.pickupDelay > 0) { rec.pickupDelay -= 0.1; return; }
  const dx = p.x - rec.e.x, dz = p.z - rec.e.z;
  if (Math.abs(dx) > 1.2 || Math.abs(dz) > 1.2) return;
  const dy = (p.y + 0.8) - rec.e.y;
  if (Math.abs(dy) > 1.0) return;
  try {
    const it = rec.e.item;
    if (!it || !it.id) { removeItem(rec.id); return; }
    const inv = g.inventory;
    if (inv && typeof inv.addToInventory === "function") {
      inv.addToInventory({ id: it.id, damage: it.damage | 0, count: it.count || 1 });
      try { g.sound.play("entity.item.pickup"); } catch (e) {}
    }
  } catch (e) {}
  // hand the visual to the engine: its own onCollect path plays the vanilla
  // 3-tick fly-in to the player (plus the hotbar pop on the matching stack)
  // and deletes the entity itself — we just stop simulating it.
  try { SV.items.delete(rec.id); } catch (e) {}
  try {
    rec.e.pickable = false;
    g.entities.onCollect({ collectedEntityId: rec.id, collectorEntityId: g.entityId });
  } catch (e) { try { removeItem(rec.id); } catch (_) {} }
}

function syncEnt(e) {
  // realms-style render sync: snap the interpolator to the sim position
  try {
    e.x = e.newX = e.prevX = e.lastTickX = e.x;
    e.y = e.newY = e.prevY = e.lastTickY = e.y;
    e.z = e.newZ = e.prevZ = e.lastTickZ = e.z;
    e.inc = 2;
  } catch (err) {}
}

/* ---------------------------------------------------------- body physics (mobs, items, arrows) */

const GRAV = 28, TERMINAL = -12, STEPH = 1.01; // blocks/sec, blocks/sec

function bodyCollide(b) {
  // b: {x,y,z,w,h} feet-centered; returns colliding boxes overlapping a slightly
  // shrunk AABB (stable resting contact without snagging on edges)
  try {
    const e = 0.02;
    return game().world.getCollisions([b.x - b.w / 2 + e, b.y + e, b.z - b.w / 2 + e,
      b.x + b.w / 2 - e, b.y + b.h, b.z + b.w / 2 - e]) || [];
  } catch (err) { return []; }
}

function stepMove(b, dx, dy, dz, out) {
  // single axis-separated AABB step; out accumulates collision flags
  // X
  b.x += dx;
  for (const c of bodyCollide(b)) {
    if (dx > 0 && b.x + b.w / 2 > c[0] && b.x - b.w / 2 < c[0]) { b.x = c[0] - b.w / 2 - 0.001; out.hitX = true; }
    else if (dx < 0 && b.x - b.w / 2 < c[3] && b.x + b.w / 2 > c[3]) { b.x = c[3] + b.w / 2 + 0.001; out.hitX = true; }
  }
  // Z
  b.z += dz;
  for (const c of bodyCollide(b)) {
    if (dz > 0 && b.z + b.w / 2 > c[2] && b.z - b.w / 2 < c[2]) { b.z = c[2] - b.w / 2 - 0.001; out.hitZ = true; }
    else if (dz < 0 && b.z - b.w / 2 < c[5] && b.z + b.w / 2 > c[5]) { b.z = c[5] + b.w / 2 + 0.001; out.hitZ = true; }
  }
  // Y
  b.y += dy;
  for (const c of bodyCollide(b)) {
    if (dy <= 0 && b.y < c[4] && b.y + b.h > c[4]) { b.y = c[4]; out.ground = true; }
    else if (dy > 0 && b.y + b.h > c[1] && b.y < c[1]) { b.y = c[1] - b.h - 0.001; }
  }
}

function physMove(b, dx, dy, dz) {
  // substepped AABB move (blocks/sec * dt); returns {ground, hitX, hitZ}.
  // Substep cap (0.3 < smallest body height 0.4) keeps fast falls from
  // tunneling through 1-block floors.
  // Lithium-style resting-contact cache: getCollisions is ~22us a sweep and
  // a resting body spends 3 sweeps per tick proving nothing moved. When the
  // displacement is ~zero AND the box is bitwise where it was AND the world
  // is untouched since (world._colGen, bumped by every write path), the last
  // sweep result is exact — reuse it. PM_EPS (1e-9 blocks) is far below
  // float32 render resolution and every physics threshold, so the skipped
  // move is unobservable; any world edit invalidates the cache same-tick.
  const out = { ground: false, hitX: false, hitZ: false };
  let wv = -1;
  try {
    const w = game().world;
    wv = w ? (w._colGen | 0) : -1;
    if (wv >= 0 && b && b._pmRes &&
      Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-9 &&
      b._pmGen === wv && b._pmX === b.x && b._pmY === b.y && b._pmZ === b.z &&
      b._pmW === b.w && b._pmH === b.h) {
      out.ground = !!b._pmRes.ground; out.hitX = !!b._pmRes.hitX; out.hitZ = !!b._pmRes.hitZ;
      return out;
    }
  } catch (e) {}
  const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const n = Math.max(1, Math.ceil(m / 0.3));
  const ex = b.x, ey = b.y, ez = b.z; // entry box: the reuse key
  for (let i = 0; i < n; i++) stepMove(b, dx / n, dy / n, dz / n, out);
  try {
    if (b) {
      b._pmGen = wv; b._pmX = ex; b._pmY = ey; b._pmZ = ez; b._pmW = b.w; b._pmH = b.h;
      b._pmRes = out;
    }
  } catch (e) {}
  return out;
}

function tryStep(b) {
  // auto-step one block when blocked horizontally
  const sx = b.x, sy = b.y, sz = b.z;
  b.y += STEPH;
  const blocked = bodyCollide(b).length > 0;
  if (blocked) { b.x = sx; b.y = sy; b.z = sz; return false; }
  return true;
}

function liquidAt(x, y, z) {
  const n = blockNameAt(x, y, z);
  return n === "water" ? "water" : n === "lava" ? "lava" : null;
}

/* ---------------------------------------------------------- mobs */

function isNight() {
  try {
    const t = game().world.timeOfDay % 24000;
    return t >= 12500 && t <= 23500;
  } catch (e) { return true; }
}
function skyAt(x, y, z) {
  try { return game().world.getSkyLight(x | 0, y | 0, z | 0); } catch (e) { return 15; }
}
function blockLightAt(x, y, z) {
  try {
    if (typeof game().world.getBlockLight === "function") return game().world.getBlockLight(x | 0, y | 0, z | 0);
  } catch (e) {}
  return 0;
}
function effLight(x, y, z) {
  // effective light level: stored sky light is the DAYTIME maximum (it reads
  // 15 outdoors even at midnight), so clamp it to moonlight (~4) at night,
  // then take the max with emitted block light (torches etc).
  let sky = 15;
  try { sky = game().world.getSkyLight(x | 0, y | 0, z | 0); } catch (e) {}
  if (isNight()) sky = Math.min(sky, 4);
  return Math.max(sky, blockLightAt(x, y, z));
}
function mobCount(hostile) {
  let n = 0;
  SV.mobs.forEach((m) => { if (!!m.def.hostile === !!hostile) n++; });
  return n;
}

/* ---------------------------------------------------------- weather (vanilla
 * 1.13 cycle, engine-native render). The engine already renders rain when
 * world.raining + rainStrength>0 (particles.rain, isRainingAt for sky
 * exposure) — offline no server ever drives it, so we are the server:
 * vanilla timers (clear 5min-3.75d? 1.13: clear 6000-90000 ticks, rain
 * 6000-24000, thunder within rain), fades over ~5s, gameplay hooks below
 * (burn, fire, fishing, sleep, lightning). Runs in ANY loaded world, not
 * just survival — like vanilla. */
function wxState() {
  if (!SV.wx) {
    SV.wx = {
      rain: false, thunder: false,
      rainT: 300 + Math.random() * 1200, // first change soon-ish (vanilla re-rolls anyway)
      thunderT: 0, strikeAt: 8 + Math.random() * 20,
    };
  }
  return SV.wx;
}
function isRaining() { try { return !!wxState().rain; } catch (e) { return false; } }
function isThundering() { try { const w = wxState(); return !!(w.rain && w.thunder); } catch (e) { return false; } }
// sky-exposed rain at a point: engine knows roofs/overhangs via isRainingAt
function isRainingAt(x, y, z) {
  try {
    if (!wxState().rain) return false;
    const w = game().world;
    if (w && typeof w.isRainingAt === "function") return !!w.isRainingAt(x, y, z);
    return skyAt(x, y, z) >= 15;
  } catch (e) { return false; }
}
function setWeather(kind, secs) {
  const w = wxState();
  const dur = secs != null ? Math.max(1, secs | 0) : 0;
  if (kind === "clear") {
    w.rain = false; w.thunder = false;
    w.rainT = dur || (6000 + Math.random() * 84000) / 20;
    w.thunderT = 0;
  } else if (kind === "rain") {
    w.rain = true; w.thunder = false;
    w.rainT = dur || (6000 + Math.random() * 18000) / 20;
    w.thunderT = 0;
  } else if (kind === "thunder" || kind === "storm") {
    w.rain = true; w.thunder = true;
    w.rainT = dur || (6000 + Math.random() * 18000) / 20;
    w.thunderT = dur || (3600 + Math.random() * 12000) / 20;
    w.strikeAt = Math.min(w.strikeAt || 99, 3);
  }
  pushWeatherToEngine(1);
  return w;
}
function clearWeatherOnSleep() {
  // vanilla: a successful sleep resets rain + thunder timers
  const w = wxState();
  w.rain = false; w.thunder = false;
  w.rainT = (6000 + Math.random() * 84000) / 20;
  w.thunderT = 0;
  pushWeatherToEngine(1);
}
function pushWeatherToEngine(snap) {
  // fade strengths toward targets so rain/thunder ease in/out (~5s)
  try {
    const g = game(), w = g && g.world;
    if (!w) return;
    // no weather in the Nether (vanilla): keep the engine dry while the
    // overworld timers pause untouched in SV.wx
    if ((g.dimension | 0) !== 0) {
      w.raining = false; w.rainStrength = 0; w.thunderStrength = 0;
      return;
    }
    const s = wxState();
    w.raining = !!s.rain;
    const rt = s.rain ? 1 : 0, tt = (s.rain && s.thunder) ? 1 : 0;
    // vanilla World.updateWeather order: prev = current, then ease current
    // toward the target. Render interpolates prev->current by partial; without
    // the prev update the sky rain factor ramps 0->full every tick (flicker).
    if (snap) { w.prevRain = w.rainStrength = rt; w.thunderStrength = tt; return; }
    w.prevRain = w.rainStrength;
    const f = (cur, tgt) => {
      cur = typeof cur === "number" ? cur : 0;
      if (cur === tgt) return tgt;
      const d = tgt > cur ? 0.02 : -0.02; // ~5s at 10Hz
      const n = cur + d;
      return tgt > cur ? Math.min(tgt, n) : Math.max(tgt, n);
    };
    w.rainStrength = f(w.rainStrength, rt);
    w.thunderStrength = f(w.thunderStrength, tt);
  } catch (e) {}
}
function weatherTick(dt) {
  let g = null;
  try { g = game(); if (!g || !g.inWorld || !g.world) return; } catch (e) { return; }
  // overworld timers pause in the Nether (vanilla has no Nether weather)
  try { if ((g.dimension | 0) !== 0) return; } catch (e) { return; }
  const w = wxState();
  // countdowns (creative too — weather is world state, not survival)
  w.rainT -= dt;
  if (w.thunder) w.thunderT -= dt;
  if (w.rainT <= 0) {
    if (!w.rain) {
      w.rain = true;
      w.rainT = (6000 + Math.random() * 18000) / 20;
      // ~1 in 4 rains is a thunderstorm (vanilla rolls thunder timers separately)
      if (Math.random() < 0.25) {
        w.thunder = true;
        w.thunderT = (3600 + Math.random() * 12000) / 20;
        w.strikeAt = 3 + Math.random() * 10;
      }
    } else {
      w.rain = false; w.thunder = false;
      w.rainT = (6000 + Math.random() * 84000) / 20;
      w.thunderT = 0;
    }
  }
  if (w.thunder && w.thunderT <= 0) {
    w.thunder = false; // thunder ends, rain continues
    w.thunderT = 0;
  }
  try { pushWeatherToEngine(0); } catch (e) {}
  // lightning while thundering: strike near the player every ~10-30s
  if (w.rain && w.thunder && g.player) {
    w.strikeAt -= dt;
    if (w.strikeAt <= 0) {
      w.strikeAt = 10 + Math.random() * 20;
      try { lightningStrike(); } catch (e) {}
    }
  }
  // rain puts out open fire around the player (sampled, cheap)
  if (w.rain && Math.random() < dt * 2 && g.player) {
    try {
      const p = g.player;
      for (let i = 0; i < 3; i++) {
        const x = Math.round(p.x + (Math.random() - 0.5) * 16);
        const y = Math.round(p.y + (Math.random() - 0.5) * 6);
        const z = Math.round(p.z + (Math.random() - 0.5) * 16);
        if (blockNameAt(x, y, z) === "fire" && isRainingAt(x, y, z)) {
          SV.grief = true;
          try { g.world.setState(x, y, z, 0); } catch (e) {} finally { SV.grief = false; }
        }
      }
    } catch (e) {}
  }
}
function lightningStrike() {
  // vanilla-ish: bolt lands on sky-exposed ground near the player —
  // fire, damage, charged creepers, thunder crack. Pigs/villagers morphs
  // need mobs we don't have yet (pigman/witch-from-villager) — see parity doc.
  const g = game(), p = g.player;
  if (!p) return;
  const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 24;
  const sx = Math.round(p.x + Math.cos(a) * r), sz = Math.round(p.z + Math.sin(a) * r);
  let sy = null;
  try {
    for (let y = Math.min(250, Math.round(p.y) + 20); y > Math.max(1, Math.round(p.y) - 20); y--) {
      const n = blockNameAt(sx, y, sz);
      if (n && n !== "air" && n !== "water" && n !== "lava" && n !== "fire") { sy = y + 1; break; }
    }
  } catch (e) {}
  if (sy == null) sy = Math.round(p.y);
  lightningStrikeAt(sx, sy, sz);
}
function lightningStrikeAt(sx, sy, sz) {
  // Targeted bolt core (channeling + weather share it): flash, crack, fire,
  // injuries and creeper charging at an exact ground cell.
  const g = game(), p = g.player;
  if (!p) return;
  try { g.particles.rain(sx + 0.5, sy + 2, sz + 0.5, 40); } catch (e) {}
  try { g.particles.explosion(sx + 0.5, sy + 0.5, sz + 0.5, 1); } catch (e) {}
  try { g.sound.play("entity.lightning_bolt.thunder"); } catch (e) {}
  try { g.sound.play("entity.lightning_bolt.impact"); } catch (e2) {}
  // ignite + hurt things at the strike
  try {
    const st = g.world.getState(sx, sy, sz);
    if (st === 0) {
      const fireId = itemIdByName("fire");
      if (fireId > 0) { SV.grief = true; try { g.world.setState(sx, sy, sz, fireId); } catch (e) {} finally { SV.grief = false; } }
    }
  } catch (e) {}
  try {
    const dx = p.x - (sx + 0.5), dy = (p.y + 1) - sy, dz = p.z - (sz + 0.5);
    if (dx * dx + dy * dy + dz * dz < 36 && difficulty() !== 0) damagePlayer(5, "lightning", { bypassArmor: true });
  } catch (e) {}
  try {
    SV.mobs.forEach((m) => {
      if (m.hp <= 0) return;
      const dx = m.x - (sx + 0.5), dy = m.y - sy, dz = m.z - (sz + 0.5);
      if (dx * dx + dy * dy + dz * dz > 25) return;
      if (m.species === "creeper" && !m.charged) {
        m.charged = true; // charged: double radius (below in explode)
        try { g.particles.entityEffect(m.x, m.y + 1, m.z, 8); } catch (e) {}
        return;
      }
      damageMob(m.id, 5, dx, dz, { lightning: true });
      m.vy = Math.max(m.vy || 0, 3);
    });
  } catch (e) {}
}

function spawnMob(species, x, y, z) {
  const def = MOB_DEFS[species];
  if (!def) return null;
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnMob({
      entityId: id, x, y, z, yaw: 0, pitch: 0, type: def.type,
      entityUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    e.health = e.maxHealth = def.hp;
    e.width = e.width || 0.6; e.height = e.height || 1.8;
    const rec = {
      id, species, def, e,
      x, y, z, vx: 0, vy: 0, vz: 0,
      w: e.width, h: e.height,
      hp: def.hp, maxHp: def.hp, yaw: 0,
      ground: false, hurtCd: 0, atkCd: 0, fuse: -1,
      wx: x, wy: y, wz: z, // wander target
      retarget: 0, inWater: false,
      lastETick: 0, // v1.12: driveMobEnt snaps the interpolator on first sight
    };
    if (species === "axolotl") {
      // vanilla coats: lucy/wild/gold/cyan common, blue ~1% natural
      const r = Math.random();
      const v = r < 0.249 ? 0 : r < 0.499 ? 1 : r < 0.749 ? 2 : r < 0.99 ? 3 : 4;
      rec.axolotlVariant = v;
      try { e.axolotlVariant = v; } catch (e2) {}
    }
    if (species === "goat" && Math.random() < 0.02) {
      // vanilla: ~2% of goats are screamers (screaming sound variant)
      rec.screaming = true;
      try { e.screaming = true; } catch (e2) {}
    }
    if (species === "sheep") {
      // vanilla 1.13 natural coats: mostly white, rare colors
      const r = Math.random();
      rec.color = r < 0.82 ? "white" : r < 0.87 ? "light_gray" : r < 0.92 ? "gray"
        : r < 0.95 ? "black" : r < 0.98 ? "brown" : "pink";
      rec.sheared = false; rec.regrow = 0;
      paintSheep(rec, rec.color); // engine tints from e.fleece/e.sheared
    }
    if (species === "frog") {
      // vanilla variant by spawning biome temperature: cold (snow) / warm
      // (desert/jungle/badlands) / temperate (everything else). The sim has
      // no biome registry at the spawn point, so approximate from the ground:
      // snow/ice below -> cold, sand/sandstone/red below -> warm.
      let v = 0;
      try {
        const gb = blockNameAt(x, y - 0.5, z);
        if (gb === "snow" || gb === "snow_block" || gb === "ice" || gb === "packed_ice" ||
            gb === "blue_ice" || gb === "frosted_ice") v = 2;
        else if (gb === "sand" || gb === "sandstone" || gb === "red_sand" ||
            gb === "red_sandstone" || gb === "terracotta" || gb === "jungle_log" ||
            gb === "jungle_leaves") v = 1;
        else v = Math.random() < 0.7 ? 0 : (Math.random() < 0.5 ? 1 : 2);
      } catch (e2) { v = 0; }
      rec.frogVariant = v;
      try { e.frogVariant = v; } catch (e2) {}
    }
    if (species === "tadpole") {
      // tadpoles grow into frogs (vanilla ~20 min, same clock as babies).
      // growUp morphs species (see below); the renderer reads e.child.
      rec.baby = true; rec.growT = GROW_T;
      try { e.child = true; } catch (e2) {}
    }
    if (species === "camel" || species === "sniffer") {
      // bred babies ride the same baby clock (renderer reads e.child).
      try { e.child = !!rec.baby; } catch (e2) {}
    }
    if (species === "villager") {
      // profession variety; the renderer reads these live (villager-layers
      // + the render cache key). Farmer/librarian-heavy like real villages.
      // Village residents get a STABLE profession from the village+slot hash
      // (B2: villagers persist); eggs stay random. Repainted at seed time.
      const pi = vtRandomProf();
      vtPaintProf(rec, pi);
    }
    e.hurtTime = 0;
    if (species === "skeleton" || species === "stray") {
      // skeletons carry their bow drawn: enables the engine's aim pose
      // (armsRaised + held bow) and renders the weapon while strafing
      try {
        const bid = itemIdByName("bow");
        if (bid != null) e.equipment[0] = { id: bid, count: 1 };
      } catch (e2) {}
    }
    if (species === "pillager") {
      // crossbow in hand (renders like the skeleton bow) — captains get
      // the ominous banner on top via paintCaptain below
      try {
        const cid = itemIdByName("crossbow");
        if (cid != null) e.equipment[0] = { id: cid, count: 1 };
      } catch (e2) {}
    }
    if (species === "vindicator") {
      // vanilla vindicators carry an iron axe
      try {
        const aid = itemIdByName("iron_axe");
        if (aid != null) e.equipment[0] = { id: aid, count: 1 };
      } catch (e2) {}
    }
    if (species === "wither_skeleton") {
      // vanilla carries a stone sword; taller than a player (0.7 x 2.4)
      try {
        const sid = itemIdByName("stone_sword");
        if (sid != null) e.equipment[0] = { id: sid, count: 1 };
      } catch (e2) {}
      try { e.width = 0.7; e.height = 2.4; } catch (e2) {}
      rec.w = 0.7; rec.h = 2.4;
    }
    if (species === "elder_guardian") {
      // vanilla elder texture variant (engine reads e.elder; set here so
      // eggs and debug spawns match seeded elders)
      try { e.elder = true; } catch (e2) {}
    }
    SV.mobs.set(id, rec);
    syncEnt(e);
    return rec;
  } catch (err) { return null; }
}

function removeMob(id, quiet) {
  try { SV.mobs.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}
// v1.14: patrol/raid captain — white banner in the head slot (equipment[1..4]
// = feet..head), pillagers keep the crossbow in hand. Plain banner item, no
// ominous NBT (the engine renders what it renders); the captain behavior —
// Bad Omen on a player kill — is what matters.
function paintCaptain(m) {
  if (!m) return;
  m.captain = true;
  try {
    const bid = itemIdByName("white_banner");
    if (bid != null && m.e) m.e.equipment[4] = { id: bid, count: 1 };
  } catch (e) {}
}
// ---- v1.14 Bad Omen + patrols. Omen is gameplay state only (the HUD has
// no effect-icon path — SV.fx never surfaces either, see the header); the
// chat line + raid bar carry the feedback instead.
const OMEN_MS = 100 * 60 * 1000; // vanilla 100 minutes
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
function omenLevel() {
  try {
    const o = SV.omen;
    if (!o) return 0;
    if (Date.now() > o.until) { SV.omen = null; return 0; }
    return Math.min(5, o.lvl | 0) || 0;
  } catch (e) { return 0; }
}
function addOmen() {
  // killing a captain stacks the omen up to V (vanilla); refreshes the clock
  const lvl = Math.min(5, omenLevel() + 1);
  SV.omen = { lvl, until: Date.now() + OMEN_MS };
  try { chat("\u00a7cBad Omen " + (ROMAN[lvl] || lvl)); } catch (e) {}
}
function patrolTick() {
  // illager patrols: every 10-20 min (first 6 after entry), overworld,
  // surface only. Vanilla wants 5 days of playtime first; we skip the gate
  // so the content shows up in real sessions (documented in the header).
  try {
    const g = game(), p = g && g.player;
    if (!p || !survives() || (g.dimension | 0) !== 0 || difficulty() === 0) return;
    if (patrolTargetVillage(p)) return; // raid hosts its own spawns
    SV.patrolT = (SV.patrolT == null ? 3600 : SV.patrolT) - 1;
    if (SV.patrolT > 0) return;
    SV.patrolT = 6000 + ((Math.random() * 6000) | 0);
    const diff = difficulty();
    const n = 2 + ((Math.random() * 3) | 0) + (diff >= 3 ? 1 : 0);
    const vind = diff >= 2 && Math.random() < 0.35;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 24;
      const sx = p.x + Math.cos(a) * r, sz = p.z + Math.sin(a) * r;
      if (!chunkLoaded(sx, sz)) continue;
      let gy = null;
      // full-column scan in 12-bands (groundAt only looks 12 down; hills
      // can sit far above or below the player — vanilla spawns there too)
      try {
        for (let yy = p.y + 36; yy > 1 && gy == null; yy -= 12) gy = groundAt(sx, sz, yy);
      } catch (e) {}
      if (gy == null) continue;
      // surface only (no caves): the column above must be open to the sky.
      // (sky light reads 0 at night, so it can't gate this — see v1.14 notes)
      try {
        let open = true;
        for (let b = 1; b <= 10; b++) {
          if (isSolidXYZ(sx, gy + b, sz)) { open = false; break; }
        }
        if (!open) continue;
      } catch (e) {}
      try {
        if (isSolidXYZ(sx, gy + 0.5, sz) || isSolidXYZ(sx, gy + 1.5, sz)) continue;
      } catch (e) {}
      const sp = (vind && i === n - 1) ? "vindicator" : "pillager";
      const m = spawnMob(sp, sx + 0.5, gy + 0.1, sz + 0.5);
      if (!m) continue;
      m.patrol = true;
      if (i === 0) paintCaptain(m); // the patrol leader carries the banner
    }
  } catch (e) {}
}
function patrolTargetVillage(p) {
  // a patrol never spawns on top of a raid-eligible village visit — the
  // raid owns that airspace (Phase C reads the same predicate)
  try {
    const mc = globalThis.__mcSingleplayer;
    if (!mc || !mc.villageAt || !p) return false;
    const v = mc.villageAt(Math.floor(p.x), Math.floor(p.z));
    return !!(v && omenLevel() > 0);
  } catch (e) { return false; }
}
// ---- v1.14 Phase C: village raids. Bad Omen + village entry starts one
// (omen consumed, level remembered for the Hero tier); waves scale 3/5/7 by
// difficulty (vanilla). Raiders spawn on the village rim, hold the center
// via the m.raid stamp the illager branch already honors, and hunt players,
// villagers, traders and golems through the shared pickVictim path. Win:
// Hero of the Village (rep +20 clamped, persisted through vtrade gossip) —
// the HUD has no effect-icon path, so chat + the price cuts carry it. Lose:
// every villager near the center is dead. Witches never join our waves
// (ours only hunts the player — documented gap); patrols stay independent.
const RAID_UUID = "mcjs-raid";
function raidWaves() { const d = difficulty(); return d <= 1 ? 3 : d === 2 ? 5 : 7; }
function raidBar(action, frac, title) {
  // drive the client's boss overlay directly (singleplayer has no server
  // packets to do it): 0 add, 2 health, 3 title, 1 remove. Color 2 = red
  // (vanilla raid bar), overlay 0 = plain progress, flags 0 = no sky/music.
  try {
    const hud = game().hud;
    if (!hud || !hud.onBossBar) return;
    if (action === 0) hud.onBossBar({ action: 0, uuid: RAID_UUID, title: title || "Raid", health: frac == null ? 1 : frac, color: 2, dividers: 0, flags: 0 });
    else if (action === 1) hud.onBossBar({ action: 1, uuid: RAID_UUID });
    else if (action === 2) hud.onBossBar({ action: 2, uuid: RAID_UUID, health: frac == null ? 1 : frac });
    else if (action === 3) hud.onBossBar({ action: 3, uuid: RAID_UUID, title });
  } catch (e) {}
}
function raidWaveComp(w, total) {
  // vanilla-flavored: pillager bulk every wave, vindicators from 2, one
  // evoker from 3 (+1 at the finale on normal+), ravagers muscle in late
  const d = difficulty(), hard = d >= 3, comp = [];
  const pil = 2 + w + (hard ? 1 : 0);
  for (let i = 0; i < pil; i++) comp.push("pillager");
  if (w >= 2) {
    let vin = 1 + (w >= 4 ? 1 : 0) + (hard && w >= 3 ? 1 : 0);
    for (let i = 0; i < vin; i++) comp.push("vindicator");
  }
  if (w >= 3) {
    comp.push("evoker");
    if (w >= total && d >= 2) comp.push("evoker");
  }
  if (d >= 2 && w >= 3) comp.push("ravager");
  if (d >= 2 && w >= total) comp.push("ravager");
  if (d <= 1 && w >= total) comp.push("ravager");
  return comp;
}
function raidGround(x, z, fromY) {
  // patrol-style surface scan: full column in 12-bands, open sky above
  try {
    let gy = null;
    for (let yy = fromY + 24; yy > 1 && gy == null; yy -= 12) gy = groundAt(x, z, yy);
    if (gy == null) return null;
    for (let b = 1; b <= 10; b++) { if (isSolidXYZ(x, gy + b, z)) return null; }
    if (isSolidXYZ(x, gy + 0.5, z) || isSolidXYZ(x, gy + 1.5, z)) return null;
    return gy;
  } catch (e) { return null; }
}
function raidStart(v) {
  const lvl = omenLevel() || 1;
  SV.omen = null; // the omen is spent starting the raid (vanilla)
  const R = { cx: v.x, cz: v.z, r: v.r || 16, top: v.top || 70, wave: 0, total: raidWaves(), heroLvl: Math.min(5, lvl), nextT: (SV.tickN | 0) + 50, size: 1 };
  SV.raid = R;
  try { chat("\u00a7cRaid incoming!"); } catch (e) {}
  try { sfx("event.raid.horn"); } catch (e) {}
  raidBar(0, 1, "Raid - Wave 1/" + R.total);
}
function raidSpawnWave() {
  const R = SV.raid;
  if (!R) return;
  R.wave++;
  const comp = raidWaveComp(R.wave, R.total);
  let n = 0;
  for (let i = 0; i < comp.length; i++) {
    try {
      const a = Math.random() * Math.PI * 2, rr = R.r + 6 + Math.random() * 8;
      const sx = R.cx + Math.cos(a) * rr, sz = R.cz + Math.sin(a) * rr;
      if (!chunkLoaded(sx, sz)) continue;
      const gy = raidGround(sx, sz, Math.round(R.top || 70));
      if (gy == null) continue;
      const m = spawnMob(comp[i], sx + 0.5, gy + 0.1, sz + 0.5);
      if (!m) continue;
      m.raid = true; m.wx = R.cx; m.wz = R.cz; // hold the center (illager branch)
      if (R.wave === 1 && n === 0 && m.species === "pillager") paintCaptain(m); // raid captain
      n++;
    } catch (e) {}
  }
  R.size = Math.max(1, n);
  R.nextT = (SV.tickN | 0) + 50;
  if (n === 0) return; // rim unloaded: retry next tick window
  try { chat("Raid - Wave " + R.wave + "/" + R.total); } catch (e) {}
  raidBar(3, 0, "Raid - Wave " + R.wave + "/" + R.total);
  raidBar(2, 1);
}
function raidWin() {
  const R = SV.raid;
  SV.raid = null;
  raidBar(1);
  try { chat("\u00a7aRaid Victory!"); } catch (e) {}
  try { sfx("ui.toast.challenge_complete"); } catch (e) {}
  // Hero of the Village at the spent omen's tier: big gossip discounts in
  // this village (rep persists through vtrade) + a wall-clock hero record
  try {
    const rr = (R.r || 16) + 16, r2 = rr * rr;
    SV.mobs.forEach((m) => {
      if (!m || m.species !== "villager" || m.hp <= 0) return;
      const dx = m.x - R.cx, dz = m.z - R.cz;
      if (dx * dx + dz * dz <= r2) tradeRep(m, 20);
    });
  } catch (e) {}
  try { SV.hero = { lvl: Math.min(5, R.heroLvl || 1), until: Date.now() + OMEN_MS }; } catch (e) {}
}
function raidLose() {
  const R = SV.raid;
  SV.raid = null;
  raidBar(1);
  try { chat("\u00a77Raid Defeat - the village has fallen"); } catch (e) {}
  // survivors drop the raid stamp and melt back into ordinary illagers
  try { SV.mobs.forEach((m) => { if (m && m.raid) m.raid = false; }); } catch (e) {}
}
function raidTick() {
  // runs inside directorTick (10 Hz). Raiders + villagers are counted live;
  // waves advance when the field is clear, victory after the final wave.
  try {
    const g = game(), p = g && g.player;
    if (!p) return;
    if (SV.raid && difficulty() === 0) {
      // peaceful ends it the vanilla way: raiders gone, bar down, no hero
      try { SV.mobs.forEach((m) => { if (m && m.raid) removeMob(m.id, true); }); } catch (e) {}
      SV.raid = null; raidBar(1);
      return;
    }
    if (!SV.raid) {
      if (!survives() || (g.dimension | 0) !== 0 || difficulty() === 0) return;
      if (omenLevel() <= 0) return;
      let v = null;
      try {
        const mc = globalThis.__mcSingleplayer;
        if (mc && mc.villageAt) v = mc.villageAt(Math.floor(p.x), Math.floor(p.z));
      } catch (e) {}
      // lazy seeding lags entry by ~2s: only start once residents exist,
      // or the raid would instant-lose on an empty headcount (vanilla
      // villages are never empty; ours seed as you explore)
      if (v) {
        let vils = 0;
        try {
          const rr = (v.r || 16) + 16, r2 = rr * rr;
          SV.mobs.forEach((m) => {
            if (!m || m.species !== "villager" || m.hp <= 0) return;
            const dx = m.x - v.x, dz = m.z - v.z;
            if (dx * dx + dz * dz <= r2) vils++;
          });
        } catch (e) {}
        if (vils > 0) raidStart(v);
      }
      return;
    }
    const R = SV.raid;
    let raiders = 0, vils = 0;
    try {
      const rr = (R.r || 16) + 16, r2 = rr * rr;
      SV.mobs.forEach((m) => {
        if (!m || m.hp <= 0) return;
        if (m.raid) { raiders++; return; }
        if (m.species === "villager") {
          const dx = m.x - R.cx, dz = m.z - R.cz;
          if (dx * dx + dz * dz <= r2) vils++;
        }
      });
    } catch (e) {}
    if (vils <= 0) { raidLose(); return; }
    if (raiders <= 0) {
      if (R.wave >= R.total) { raidWin(); return; }
      if ((SV.tickN | 0) >= (R.nextT | 0)) raidSpawnWave();
    } else {
      raidBar(2, Math.max(0, Math.min(1, raiders / (R.size || 1))));
    }
  } catch (e) {}
}

// ---- v1.14 Phase D: wandering trader + leads. The trader visits on his own
// schedule (20min first, every 20-40min after, stays 40min) with two llamas
// on leads; his 6 trades run the shared merchant path (no levels/restocks —
// vanilla). Leads work on the vanilla-leashable set: attaching consumes one,
// every release refunds exactly one (dropped). Knots ride fence posts as
// engine leash_knot entities (the rope renders from e.leashHolder) with a
// sim-side rec; fence broken -> knot breaks, leads drop. Trader llamas spit
// at the player (their only tracked foe — mobs get no retaliation, noted);
// llamas defend a hurt trader. Horses take no leads (separate rig — noted).
const LEASHABLE = { cow: 1, pig: 1, sheep: 1, chicken: 1, rabbit: 1, wolf: 1, iron_golem: 1, snow_golem: 1, trader_llama: 1, goat: 1, camel: 1, allay: 1 };
// vanilla-flavored trader stock (JE 1.15-ish): buys water/milk, sells plants
// and bits for 1-5 emeralds. Explorer maps stay withheld — no mansions or
// monuments exist yet, same rule as the cartographer note above (Phase E).
const VT_TRADER_BUYS = [
  { w: "water_bucket", q: 1, gq: 1, m: 0.05, mx: 12, xp: 2 },
  { w: "milk_bucket", q: 1, gq: 2, m: 0.05, mx: 12, xp: 2 },
];
const VT_TRADER_SELLS = [
  { q: 1, g: "sugar_cane", gq: 2 }, { q: 1, g: "wheat_seeds", gq: 1 }, { q: 1, g: "vine", gq: 3 },
  { q: 1, g: "lily_pad", gq: 2 }, { q: 1, g: "sand", gq: 4 }, { q: 1, g: "red_sand", gq: 4 },
  { q: 1, g: "cactus", gq: 3 }, { q: 1, g: "kelp", gq: 2 }, { q: 1, g: "oak_sapling", gq: 1 },
  { q: 1, g: "dandelion", gq: 2 }, { q: 1, g: "poppy", gq: 2 }, { q: 1, g: "brown_mushroom", gq: 1 },
  { q: 1, g: "fern", gq: 1 }, { q: 2, g: "glowstone_dust", gq: 1 }, { q: 3, g: "slime_ball", gq: 1 },
  { q: 3, g: "podzol", gq: 3 }, { q: 5, g: "nautilus_shell", gq: 1 }, { q: 5, g: "pufferfish_bucket", gq: 1 },
];
function vtMakeTraderTrade() {
  const offers = [];
  for (const e of VT_TRADER_BUYS) { const o = vtResolve(e); if (o) offers.push(o); }
  const pool = VT_TRADER_SELLS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
  for (const e of pool) {
    if (offers.length >= 6) break;
    const o = vtResolve(Object.assign({ m: 0.05, mx: 12, xp: 1 }, e));
    if (o) offers.push(o);
  }
  return { lvl: 1, xp: 0, offers, restocks: 0, restockDay: -1, lastN: SV.tickN | 0, rep: 0, noLevel: true, noRestock: true };
}
function openTraderTrade(m) {
  if (!m || !survives() || SV.dead) return false;
  try {
    if (!m.trade) m.trade = vtMakeTraderTrade();
    if (!m.trade || !m.trade.offers.length) return true;
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (g.window) {
      if (g.window.type === "minecraft:villager" && SV.openTrade && SV.openTrade.vid === m.id) return true;
      try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:villager", windowTitle: { text: "Wandering Trader" }, slotCount: 3, entityId: m.id });
    if (!g.window || g.window.type !== "minecraft:villager") return false;
    const wb = g.window.container;
    if (wb) for (let i = 0; i < 3; i++) wb[i] = null;
    g.on_trade_list(vtPacket(m));
    SV.openTrade = { vid: m.id, wid: 1 };
    m.tradeOpen = true;
    try { sfx("entity.villager.trade"); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function traderTick() {
  // visits: first ~20min after entry, every 20-40min after; one at a time,
  // stays 40min. Llamas ride m.lead (same follow path as player leads).
  try {
    const g = game(), p = g && g.player;
    if (!p || !survives() || (g.dimension | 0) !== 0 || difficulty() === 0) return;
    SV.traderT = (SV.traderT == null ? 12000 + ((Math.random() * 6000) | 0) : SV.traderT) - 1;
    let trader = null;
    try {
      SV.mobs.forEach((m) => {
        if (m && m.species === "wandering_trader" && m.hp > 0) trader = m;
      });
    } catch (e) {}
    if (trader && (SV.tickN | 0) > (trader.traderT | 0)) {
      // time: llamas stay (unleashed), two leads drop where he stood
      traderRelease(trader, true);
      try { removeMob(trader.id, true); } catch (e) {}
      trader = null;
    }
    if (SV.traderT > 0) return;
    SV.traderT = 12000 + ((Math.random() * 12000) | 0);
    if (trader) return;
    const a = Math.random() * Math.PI * 2, rr = 24 + Math.random() * 24;
    const sx = p.x + Math.cos(a) * rr, sz = p.z + Math.sin(a) * rr;
    if (!chunkLoaded(sx, sz)) return;
    const gy = raidGround(sx, sz, Math.round(p.y));
    if (gy == null) return;
    const t = spawnMob("wandering_trader", sx + 0.5, gy + 0.1, sz + 0.5);
    if (!t) return;
    t.traderVisit = true; t.traderT = (SV.tickN | 0) + 24000; t.llamaIds = [];
    for (let i = 0; i < 2; i++) {
      const lx = sx + (Math.random() * 4 - 2), lz = sz + (Math.random() * 4 - 2);
      const lgy = raidGround(lx, lz, Math.round(p.y));
      if (lgy == null) continue;
      const l = spawnMob("trader_llama", lx + 0.5, lgy + 0.1, lz + 0.5);
      if (!l) continue;
      l.traderId = t.id; t.llamaIds.push(l.id);
      attachLead(l, { to: "mob", id: t.id });
    }
  } catch (e) {}
}
function traderRelease(t, drop) {
  // free a trader's llamas (despawn + death): visuals cleared, the trader's
  // own loot table already covers lead refunds on death
  try {
    const ids = (t.llamaIds || []).slice();
    try {
      SV.mobs.forEach((m) => {
        if (m && m.species === "trader_llama" && m.traderId === t.id && ids.indexOf(m.id) < 0) ids.push(m.id);
      });
    } catch (e) {}
    for (const id of ids) {
      const l = SV.mobs.get(id);
      if (l && l.hp > 0) { l.traderId = 0; releaseLead(l, false); }
    }
    if (drop) {
      const lid = itemIdByName("lead");
      if (lid != null) { spawnItemEntity(t.x, t.y + 0.5, t.z, lid, 1); spawnItemEntity(t.x, t.y + 0.5, t.z, lid, 1); }
    }
  } catch (e) {}
}
function attachLead(m, to) {
  // (re)ties a mob: clears any old knot membership first, then publishes
  // the rope (player entity, holder mob entity, or knot entity)
  try {
    if (m.lead && m.lead.to === "knot") {
      const k = (SV.knots || []).find((k) => k.key === m.lead.key);
      if (k) {
        k.mobs = (k.mobs || []).filter((id) => id !== m.id);
        if (!k.mobs.length) destroyKnot(k);
      }
    }
  } catch (e) {}
  m.lead = (to && to.to) ? to : null;
  try {
    const eid = m.e && m.e.id;
    if (eid == null) return;
    let holder = -1;
    if (m.lead) {
      if (m.lead.to === "player") { try { holder = game().entityId; } catch (e) {} }
      else if (m.lead.to === "mob") { const h = SV.mobs.get(m.lead.id); holder = (h && h.e) ? h.e.id : -1; }
      else if (m.lead.to === "knot") { const k = (SV.knots || []).find((k) => k.key === m.lead.key); holder = k ? k.eid : -1; }
    }
    try { game().entities.setLeash(eid, holder); } catch (e) {}
  } catch (e) {}
}
function releaseLead(m, drop) {
  // unclips: rope down, exactly one lead refunded when asked (dropped, so
  // stacks can never dupe through hand/inventory edge cases)
  try {
    if (m.lead && m.lead.to === "knot") {
      const k = (SV.knots || []).find((k) => k.key === m.lead.key);
      if (k) {
        k.mobs = (k.mobs || []).filter((id) => id !== m.id);
        if (!k.mobs.length) destroyKnot(k);
      }
    }
  } catch (e) {}
  m.lead = null;
  try { if (m.e) game().entities.setLeash(m.e.id, -1); } catch (e) {}
  if (drop) {
    try {
      const lid = itemIdByName("lead");
      if (lid != null) spawnItemEntity(m.x, m.y + 0.5, m.z, lid, 1);
    } catch (e) {}
  }
  try { sfx("entity.leash_knot.break"); } catch (e) {}
}
function spawnKnotEntity(x, y, z) {
  // type 38 = leash_knot in the pinned 1.15.2 registry (ENTITY_TYPES index;
  // legacy Spawn-Object id 77 does NOT apply — it spawns a tropical fish)
  try {
    const g = game();
    const id = SV.eidSeq++;
    g.entities.spawnObject({
      entityId: id, x, y, z, yaw: 0, pitch: 0, type: 38,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    return id;
  } catch (e) { return null; }
}
function destroyKnot(k) {
  try { if (k && k.eid != null) game().entities.destroy([k.eid]); } catch (e) {}
  try { SV.knots = (SV.knots || []).filter((q) => q !== k); } catch (e) {}
}
function handleLeadKnot(t, hand) {
  // fence posts take and release leads (vanilla knot). Tie: every mob you
  // currently lead within 8 blocks joins the new knot (no extra consume —
  // the leads are already on them). Untie: right-click the knotted post and
  // the whole hitch transfers to you.
  if (!survives() || SV.dead) return false;
  let nm = null;
  try { nm = blockNameAt(t.x, t.y, t.z); } catch (e) { return false; }
  if (!nm || nm.indexOf("fence") < 0 || nm.indexOf("gate") >= 0) return false;
  const key = t.x + "," + t.y + "," + t.z;
  SV.knots = SV.knots || [];
  let k = null;
  try { k = SV.knots.find((q) => q.key === key) || null; } catch (e) {}
  if (k) {
    try {
      for (const id of (k.mobs || []).slice()) {
        const m = SV.mobs.get(id);
        if (m && m.hp > 0) attachLead(m, { to: "player" });
      }
    } catch (e) {}
    destroyKnot(k);
    try { sfx("entity.leash_knot.break"); } catch (e) {}
    return true;
  }
  const s = hand === 1 ? offHeld() : mainHeld();
  const hn = stackName(s);
  if (hn !== "lead") return false;
  let led = [];
  try {
    const p = game().player;
    SV.mobs.forEach((m) => {
      if (!m || !m.lead || m.lead.to !== "player" || m.hp <= 0) return;
      const dx = m.x - p.x, dz = m.z - p.z;
      if (dx * dx + dz * dz < 64) led.push(m);
    });
  } catch (e) {}
  if (!led.length) return false;
  const eid = spawnKnotEntity(t.x + 0.5, t.y + 1.2, t.z + 0.5);
  if (eid == null) return false;
  k = { key, x: t.x + 0.5, y: t.y + 1.2, z: t.z + 0.5, eid, mobs: [] };
  SV.knots.push(k);
  for (const m of led) { attachLead(m, { to: "knot", key }); k.mobs.push(m.id); }
  try { sfx("entity.leash_knot.place"); } catch (e) {}
  return true;
}
function knotTick() {
  // knots are fence-bound: post broken (or restored bare) -> the hitch
  // breaks, every mob drops its lead. Also respawns a knot entity lost to
  // a reload (positions persist, mob hitches don't — mobs never persist).
  try {
    if (!SV.knots || !SV.knots.length) return;
    for (const k of SV.knots.slice()) {
      let nm = null;
      try { nm = blockNameAt(Math.floor(k.x), Math.floor(k.y - 1.2), Math.floor(k.z)); } catch (e) {}
      if (!nm || nm.indexOf("fence") < 0 || nm.indexOf("gate") >= 0) {
        try {
          for (const id of (k.mobs || []).slice()) {
            const m = SV.mobs.get(id);
            if (m && m.hp > 0) releaseLead(m, true);
          }
        } catch (e) {}
        destroyKnot(k);
        continue;
      }
      let alive = false;
      try { alive = !!(k.eid != null && game().entities.get(k.eid)); } catch (e) {}
      if (!alive) {
        const eid = spawnKnotEntity(k.x, k.y, k.z);
        if (eid != null) {
          k.eid = eid;
          try {
            for (const id of (k.mobs || []).slice()) {
              const m = SV.mobs.get(id);
              if (m && m.hp > 0) attachLead(m, { to: "knot", key: k.key });
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}
}
function chunkLoaded(x, z) {
  // streaming keeps a wide radius around the player loaded; outside it the
  // engine fabricates phantom-solid 1m collision boxes (see B1 notes), so
  // mobs must never spawn/teleport there. Fail-open if the API changes.
  try {
    const g = game();
    const ch = g && g.world && g.world.chunks;
    if (!ch || typeof ch.has !== "function") return true;
    return ch.has(Math.floor(x / 16) + "," + Math.floor(z / 16));
  } catch (e) { return true; }
}
function groundAt(x, z, fromY) {
  // scan down for first solid top (max 12 below)
  for (let y = Math.floor(fromY); y > Math.floor(fromY) - 12 && y > 0; y--) {
    if (isSolidXYZ(x, y, z)) return y + 1;
  }
  return null;
}

function directorTick() {
  const g = game(), p = g.player;
  if (!p) return;
  const diff = difficulty();
  // --- despawn (vanilla JE rules, approximated to the 10 Hz tick).
  // Tamed pets never despawn and are exempt from the peaceful clear.
  const dead = [];
  SV.mobs.forEach((m) => {
    if (m.tame || m.def.persistent || m.village || m.mansion || m.raid) { m.awayT = 0; return; }
    const dx = m.x - p.x, dz = m.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 128 * 128) { dead.push(m.id); return; } // instant past 128
    if (d2 > 32 * 32) {
      // 1/800 per game tick after 30s away (we tick at 10 Hz -> 1/8000)
      m.awayT = (m.awayT || 0) + 0.1;
      if (m.awayT > 30 && Math.random() < 1 / 8000) dead.push(m.id);
    } else m.awayT = 0;
  });
  for (const id of dead) removeMob(id, true);
  // --- peaceful: hostiles never spawn; clear any present (pets exempt;
  // v1.16.0: the dragon stays like vanilla — a harmless boss, not a mob.
  // Persistent residents (city shulkers, elders, bosses, traders) stay too.)
  if (diff === 0) {
    const hostiles = [];
    SV.mobs.forEach((m) => { if (m.def.hostile && !m.tame && !m.def.dragon && !m.def.persistent) hostiles.push(m.id); });
    for (const id of hostiles) removeMob(id, true);
  }
  // v1.14: evoker fang cleanup (the engine animates them, survival destroys)
  try {
    if (SV.fangFx && SV.fangFx.length) {
      const now = Date.now();
      SV.fangFx = SV.fangFx.filter((f) => {
        if (f.until < now) { try { game().entities.destroy([f.id]); } catch (e) {} return false; }
        return true;
      });
    }
  } catch (e) {}
  // the End gets endermen only (vanilla), on end stone, any light; the
  // Nether spawns below (fortress crews, magma cubes, warped endermen)
  try {
    const dimNow = (game().dimension | 0);
    if (dimNow === 1) {
      if (diff !== 0 && mobCount(true) < 10 && Math.random() < 0.08) {
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
          const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          const gy = groundAt(x, z, p.y + 4);
          if (gy == null) continue;
          if (blockNameAt(x, gy - 1, z) !== "end_stone") continue;
          const m = spawnMob("enderman", x + 0.5, gy + 0.1, z + 0.5);
          if (m) break;
        }
      }
      // v1.16.0: city shulkers seed on the same visit cadence as the
      // overworld structure seeds (the shared 2s chain below is dim-0-only)
      if ((SV.tickN | 0) % 20 === 0) { try { seedEndCities(); } catch (e) {} }
      return;
    }
    // v1.15.0 nether: fortress crews spawn on the brickwork the player stands
    // in; magma cubes wander the wastes; warped forests get endermen (vanilla).
    // No light gates (no day/night); caps stay browser-small like overworld.
    if (dimNow === -1) {
      if (diff !== 0 && mobCount(true) < 24) {
      try {
        const mc = globalThis.__mcSingleplayer;
        let fort = null;
        try { fort = mc && mc.fortressAt ? mc.fortressAt(Math.floor(p.x), Math.floor(p.z)) : null; } catch (e) {}
        if (fort) {
          // attempts nearly always succeed (flat brick floor), so keep the
          // chance low — 0.35/tick murdered the tester in seconds
          if (Math.random() < 0.08) {
            const sp = Math.random() < 0.5 ? "blaze" : "wither_skeleton";
            if (villageCount(sp) < 6) {
              // courtyard/bridge band (keeps spawns on brick, out of lava)
              const x = fort.x + (Math.random() * 24 - 12), z = fort.z + (Math.random() * 8 - 4);
              spawnMob(sp, x + 0.5, fort.fy + 1.1, z + 0.5);
            }
          }
        } else if (Math.random() < 0.2) {
          const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
          const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
          const gy = groundAt(x, z, p.y + 4);
          if (gy != null && villageCount("magma_cube") < 6) {
            const m = spawnMob("magma_cube", x + 0.5, gy + 0.1, z + 0.5);
            if (m) {
              const sr = Math.random();
              m.size = sr < 0.6 ? 1 : sr < 0.9 ? 2 : 4;
              m.hp = m.size >= 4 ? 16 : m.size >= 2 ? 4 : 1;
              m.maxHp = m.hp;
              try { syncSlimeSize(m); } catch (e) {}
            }
          }
        }
        try {
          if (mc && mc.netherBiome && mc.netherBiome(Math.floor(p.x), Math.floor(p.z)) === 3 &&
              Math.random() < 0.06 && villageCount("enderman") < 3) {
            const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
            const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
            const gy = groundAt(x, z, p.y + 4);
            if (gy != null) spawnMob("enderman", x + 0.5, gy + 0.1, z + 0.5);
          }
        } catch (e) {}
      } catch (e) {}
      }
      return;
    }
    if (dimNow !== 0) return;
  } catch (e) { return; }
  const night = isNight();
  // phantom clock: vanilla insomnia hits 72000 ticks (60 min awake); sleeping
  // resets it. directorTick runs at 10 Hz, so +0.1 per tick while in-world.
  if (diff !== 0) SV.noSleep = (SV.noSleep || 0) + 0.1;
  // --- spawn (caps below vanilla 70/10 for browser perf — see README)
  try { patrolTick(); } catch (e) {} // v1.14: day-or-night patrols (self-gated)
  try { raidTick(); } catch (e) {} // v1.14 Phase C: village raids
  try { traderTick(); } catch (e) {} // v1.14 Phase D: trader visits
  try { knotTick(); } catch (e) {} // v1.14 Phase D: fence-knot upkeep
  if (night && diff !== 0) {
    if (SV.noSleep > 3600 && mobCount(true) < 40) {
      // 1-2 phantoms high above, swooping (vanilla group size 1+)
      const n = 1 + (Math.random() < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 10;
        spawnMob("phantom", p.x + Math.cos(a) * r, p.y + 18 + Math.random() * 4, p.z + Math.sin(a) * r);
      }
      SV.noSleep = 0; // one haunting per clock (vanilla re-rolls each night)
    }
    if (mobCount(true) < 40) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 24 + Math.random() * 24;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const gy = groundAt(x, z, p.y + 4);
        if (gy == null) continue;
        if (effLight(x, gy + 1, z) > 7) continue; // 1.13 rule: light <= 7
        let sp;
        const below = blockNameAt(x, gy - 1, z);
        const roll = Math.random();
        if (below === "sand" || below === "sandstone" || below === "red_sand") sp = "husk";
        else if (below === "snow" || below === "snow_block" || below === "ice" || below === "packed_ice") sp = "stray";
        else {
          const nb = spBiome(x, z);
          if (nb === "desert") sp = "husk";
          else if (nb === "snow") sp = "stray";
          else if (roll < 0.02) sp = "enderman";
          else if (roll < 0.05) sp = "witch";
          else if (roll < 0.08) sp = (nb == null || nb === "swamp") ? "slime" : "zombie";
          else if (roll < 0.10) sp = "silverfish";
        else {
          const pool = ["zombie", "zombie", "zombie", "skeleton", "skeleton", "creeper", "spider"];
          sp = pool[(Math.random() * pool.length) | 0];
          }
        }
        // packs: up to 4 of the same species nearby
        const n = 1 + ((Math.random() * 4) | 0);
        let made = false;
        for (let k = 0; k < n; k++) {
          const px = x + (Math.random() * 8 - 4), pz = z + (Math.random() * 8 - 4);
          const pgy = groundAt(px, pz, gy + 3);
          if (pgy == null) continue;
          if (effLight(px, pgy + 1, pz) > 7) continue;
          const rec = spawnMob(sp, px + 0.5, pgy + 0.1, pz + 0.5);
          if (rec) {
            // slime spawn sizes: mostly small, sometimes medium, rarely large
            if (sp === "slime" || sp === "magma_cube") {
              const sr = Math.random();
              rec.size = sr < 0.6 ? 1 : sr < 0.9 ? 2 : 4;
              rec.hp = rec.size >= 4 ? 16 : rec.size >= 2 ? 4 : 1;
              rec.maxHp = rec.hp;
              syncSlimeSize(rec);
            }
            made = true;
          }
        }
        if (made) break;
      }
      // bats: dark pockets (light <= 4), any height with headroom
      if (Math.random() < 0.2 && mobCount(false) < 12) {
        const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const gy = groundAt(x, z, p.y + 6);
        if (gy != null) {
          const by = gy + 2 + ((Math.random() * 4) | 0);
          if (effLight(x, by, z) <= 4 && isSolidXYZ(x | 0, by + 2, z | 0)) {
            const b = spawnMob("bat", x + 0.5, by, z + 0.5);
            if (b) { b.wy = by; b.wx = x; b.wz = z; }
          }
        }
      }
    }
  } else if (!night) {
    if (mobCount(false) < 10) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 12 + Math.random() * 20;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const gy = groundAt(x, z, p.y + 4);
        if (gy == null) continue;
        const below = blockNameAt(x, gy - 1, z);
        // beach turtles: sand with water nearby
        let sp = null;
        const db = spBiome(x, z);
        if (below === "sand" || below === "red_sand") {
          let wet = false;
          for (let ox = -4; ox <= 4 && !wet; ox += 2) {
            for (let oz = -4; oz <= 4 && !wet; oz += 2) {
              if (liquidAt(x + ox, gy, z + oz) === "water") wet = true;
            }
          }
          if (wet && Math.random() < 0.5) sp = "turtle";
          // P4: camels wander deserts by day (vanilla herd animal)
          else if (!wet && db !== "snow" && Math.random() < 0.15) sp = "camel";
        } else if (below === "ice" || below === "packed_ice" || below === "snow" || below === "snow_block" || db === "snow") {
          if (Math.random() < 0.4) sp = "polar";
        }
        // P4: frogs in swamps (vanilla; mangrove swamps on the 1.15 table read
        // as swamp here until P3 replaces the biome table).
        if (!sp && (below === "grass_block" || below === "mud" || below === "clay") &&
            (db === "swamp" || db == null) && gy <= 70 && Math.random() < 0.25) sp = "frog";
        if (!sp && (below === "grass_block" || below === "stone") && gy >= 68 && effLight(x, gy + 1, z) >= 9 && Math.random() < 0.06) sp = "goat";
        if (!sp) {
          if (below !== "grass_block") continue;
          if (effLight(x, gy + 1, z) < 9) continue; // animals need light >= 9
          const roll = Math.random();
          if (roll < 0.12) sp = "rabbit";
          else if (roll < 0.18) sp = "wolf";
          else if (roll < 0.24 && (db == null || db === "jungle")) sp = "parrot";
          else if (roll < 0.26 && db === "snow") sp = "polar";
          else {
            const pool = ["cow", "cow", "pig", "pig", "sheep", "sheep", "chicken"];
            sp = pool[(Math.random() * pool.length) | 0];
          }
        } else if (effLight(x, gy + 1, z) < 9 && sp !== "polar") continue;
        const m = spawnMob(sp, x + 0.5, gy + 0.1, z + 0.5);
        if (m) break;
      }
    }
      // water life: squids anywhere wet, dolphins in the deep (both need 2+ water)
      if (mobCount(false) < 12 && Math.random() < 0.3) {
        const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const wy = Math.floor(p.y) - 2;
        if (liquidAt(x, wy, z) === "water" && liquidAt(x, wy - 1, z) === "water") {
          const wr = Math.random();
          if (wr < 0.12) spawnMob("dolphin", x + 0.5, wy, z + 0.5);
          else if (wr < 0.27) spawnMob("axolotl", x + 0.5, wy, z + 0.5);
          else if (wr < 0.35) spawnMob("tadpole", x + 0.5, wy, z + 0.5); // P4: tadpoles share lush waters
          else if (wr < 0.42 && wy < 50 && effLight(x, wy, z) <= 7) spawnMob("glow_squid", x + 0.5, wy, z + 0.5);
          else spawnMob("squid", x + 0.5, wy, z + 0.5);
        }
      }
    }
  // v1.15.0 ocean: guardians inside monument footprints (day or night, water
  // only, cap 6 incl. seeded elders); drowned in nearby water at night.
  if (diff !== 0 && mobCount(true) < 40) {
    try {
      const mc = globalThis.__mcSingleplayer;
      if (mc && mc.monumentAt) {
        let mon = null;
        try { mon = mc.monumentAt(Math.floor(p.x), Math.floor(p.z)); } catch (e) {}
        if (mon && villageCount("guardian") + villageCount("elder_guardian") < 6 && Math.random() < 0.3) {
          for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 16;
            const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
            const wy = Math.floor(p.y) - 2;
            if (liquidAt(x, wy, z) === "water" && liquidAt(x, wy - 1, z) === "water") {
              if (spawnMob("guardian", x + 0.5, wy, z + 0.5)) break;
            }
          }
        }
      }
    } catch (e) {}
    if (night && Math.random() < 0.5) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = 12 + Math.random() * 20;
        const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        const wy = Math.floor(p.y) - 2;
        if (liquidAt(x, wy, z) === "water" && liquidAt(x, wy - 1, z) === "water") {
          if (spawnMob("drowned", x + 0.5, wy, z + 0.5)) break;
        }
      }
    }
  }
  // villages seed their residents as you explore (every ~2s, dim 0 only)
  try {
    V_SEED.acc = (V_SEED.acc || 0) + 1;
    if (V_SEED.acc >= 20) { V_SEED.acc = 0; seedVillages(false); try { seedNests(false); } catch (e) {} try { seedMansions(); } catch (e2) {} try { seedMonuments(); } catch (e3) {} }
  } catch (e) {}
}

// ---- Phase B1: deterministic village residents (no trading yet) ----
// N villagers (one per house, up to 5) + one golem per village, seeded
// lazily as the player explores. No save-schema change: villages are pure
// of seed, so residents re-seed identically each entry; trading rides on
// top in B2. Villagers wander near home and flee when hurt (shared passive
// path); golems hunt hostiles nearby and retaliate (shared defender path).
var V_SEED = { done: new Set(), slots: new Set(), acc: 0 };
function villageCount(species) {
  let n = 0;
  try { SV.mobs.forEach((m) => { if (m.species === species) n++; }); } catch (e) {}
  return n;
}
function seedVillages(force) {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0) return;
    if ((g.dimension | 0) !== 0) return;
    const mc = globalThis.__mcSingleplayer;
    if (!mc || !mc.villageAt) return;
    const p = g.player;
    if (!p) return;
    // only the village the player is standing in: its chunks stream around
    // the player, so spawns land in loaded columns. Seeding farther villages
    // would place mobs into unloaded columns, where the engine fabricates
    // phantom-solid collisions that ratchet mobs into the sky (see B1 notes).
    // Exploring players get seeded by the director throttle within ~2s.
    void force;
    let list = [];
    try {
      const c = mc.villageAt(Math.floor(p.x), Math.floor(p.z));
      if (c) list = [c];
    } catch (e) {}
    for (const v of list) {
      const key = v.x + "," + v.z;
      if (V_SEED.done.has(key)) continue;
      if (villageCount("villager") >= 30) return;
      const baseY = v.fy || 64;
      const n = Math.min(v.houses ? v.houses.length : 0, 5);
      const offs = [[5, 3], [-4, -2], [2, 6], [-6, 4], [7, -5]];
      // per-slot once-flags (not one village flag): a slot skipped for an
      // UNLOADED chunk must retry next visit, while a spawned slot must
      // never double-spawn. Headroom failures mark too (no respawn there).
      let pending = false;
      for (let i = 0; i < n; i++) {
        const skey = key + ":" + i;
        if (V_SEED.slots.has(skey)) continue;
        const sx = v.x + offs[i % offs.length][0] + 0.5;
        const sz = v.z + offs[i % offs.length][1] + 0.5;
        if (!chunkLoaded(sx, sz)) { pending = true; continue; } // streamed later; retries
        let y = baseY + 1;
        try { const gy = groundAt(sx, sz, baseY + 4); if (gy != null) y = gy + 0.1; } catch (e) {}
        // never spawn inside walls: bump up for headroom, else give up
        let ok = true;
        try {
          if (isSolidXYZ(sx, y, sz) || isSolidXYZ(sx, y + 1, sz)) {
            ok = false;
            for (let b = 1; b <= 3 && !ok; b++) {
              if (!isSolidXYZ(sx, y + b, sz) && !isSolidXYZ(sx, y + b + 1, sz)) { y = y + b; ok = true; }
            }
          }
        } catch (e) {}
        if (ok) {
          const rec = spawnMob("villager", sx, y, sz);
          if (rec) {
            rec.village = { x: v.x, z: v.z, fy: baseY }; rec.wx = sx; rec.wz = sz;
            // stable slot: profession + trade record survive re-seeds (B2)
            rec.tradeKey = skey;
            vtPaintProf(rec, vtHashProf(rec.tradeKey));
          }
        }
        V_SEED.slots.add(skey);
      }
      const gkey = key + ":golem";
      if (!V_SEED.slots.has(gkey) && villageCount("iron_golem") < 6) {
        const gx = v.x + 3.5, gz = v.z + 0.5;
        if (!chunkLoaded(gx, gz)) pending = true; // streamed later; retries
        else {
          let gy2 = baseY + 1;
          try { const gy = groundAt(gx, gz, baseY + 4); if (gy != null) gy2 = gy + 0.1; } catch (e) {}
          // golems are 2.7 tall: need 3 air blocks, else skip this village
          let gok = true;
          try {
            if (isSolidXYZ(gx, gy2, gz) || isSolidXYZ(gx, gy2 + 1, gz) || isSolidXYZ(gx, gy2 + 2, gz)) {
              gok = false;
              for (let b = 1; b <= 3 && !gok; b++) {
                if (!isSolidXYZ(gx, gy2 + b, gz) && !isSolidXYZ(gx, gy2 + b + 1, gz) && !isSolidXYZ(gx, gy2 + b + 2, gz)) { gy2 = gy2 + b; gok = true; }
              }
            }
          } catch (e) {}
          if (gok) {
            const gr = spawnMob("iron_golem", gx, gy2, gz);
            if (gr) {
              gr.village = { x: v.x, z: v.z, fy: baseY };
              try { if (gr.e) gr.e.playerCreated = false; } catch (e) {}
            }
          }
          V_SEED.slots.add(gkey);
        }
      }
      if (!pending) V_SEED.done.add(key);
    }
  } catch (e) {}
}

// ---- P4: deterministic mansion residents (evoker + vindicators + allays) ----
// One evoker in the obsidian sanctum, four vindicators in the hall rooms,
// two allays caged with the evoker (vanilla mansions hold allays),
// seeded lazily like villages (once-flags, headroom checks, loaded-chunk
// gate). No save-schema change: the mansion is pure of seed.
function seedMansions() {
  try {
    SV.mansionDbg = SV.mansionDbg || {};
    SV.mansionDbg.runs = ((SV.mansionDbg && SV.mansionDbg.runs) | 0) + 1;
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0) { SV.mansionDbg.gate = "sp"; return; }
    if ((g.dimension | 0) !== 0) { SV.mansionDbg.gate = "dim"; return; }
    const mc = globalThis.__mcSingleplayer;
    if (!mc || !mc.mansionAt) { SV.mansionDbg.gate = "mc"; return; }
    const p = g.player;
    if (!p) { SV.mansionDbg.gate = "p"; return; }
    let c = null;
    try { c = mc.mansionAt(Math.floor(p.x), Math.floor(p.z)); } catch (e) {}
    SV.mansionDbg.found = !!c;
    if (!c) return;
    const key = "m" + c.x + "," + c.z;
    if (V_SEED.done.has(key)) { SV.mansionDbg.done = true; return; }
    const baseY = (c.fy | 0) + 1;
    const slots = [
      ["evoker", 2.5, -10.5],
      ["allay", 1.5, -10.5], ["allay", 3.5, -10.5],
      ["vindicator", -7.5, -7.5], ["vindicator", 7.5, -7.5],
      ["vindicator", -7.5, 7.5], ["vindicator", 7.5, 7.5],
    ];
    let pending = false;
    SV.mansionDbg.slots = SV.mansionDbg.slots || {};
    for (let i = 0; i < slots.length; i++) {
      const skey = key + ":" + i;
      if (V_SEED.slots.has(skey)) { SV.mansionDbg.slots[i] = "marked"; continue; }
      const sx = c.x + slots[i][1], sz = c.z + slots[i][2];
      if (!chunkLoaded(sx, sz)) { pending = true; SV.mansionDbg.slots[i] = "unloaded"; continue; }
      // headroom probe (engine collision, not genState): phantom-solid
      // boxes in still-streaming chunks read solid — treat as pending,
      // NOT as a failed slot, or residents would be skipped forever
      let y = baseY + 0.1, ok = true;
      try {
        if (isSolidXYZ(sx, y, sz) || isSolidXYZ(sx, y + 1, sz)) {
          ok = false;
          for (let b = 1; b <= 3 && !ok; b++) {
            if (!isSolidXYZ(sx, y + b, sz) && !isSolidXYZ(sx, y + b + 1, sz)) { y = y + b; ok = true; }
          }
        }
      } catch (e) { ok = false; }
      if (!ok) { pending = true; SV.mansionDbg.slots[i] = "solid"; continue; }
      const rec = spawnMob(slots[i][0], sx, y, sz);
      if (rec) {
        rec.mansion = { x: c.x, z: c.z, fy: baseY - 1 };
        rec.wx = sx; rec.wz = sz;
        V_SEED.slots.add(skey);
        SV.mansionDbg.slots[i] = "spawned";
      } else { pending = true; SV.mansionDbg.slots[i] = "spawnfail"; }
    }
    if (!pending) V_SEED.done.add(key);
  } catch (e) {}
}

// ---- v1.15.0: deterministic monument elders (3 per monument, persistent) ----
// One elder in the core, two in the wings, seeded lazily like mansions
// (once-flags, loaded-chunk gate). Elders live in water: the headroom probe
// passes through water/air (isSolidXYZ is false for both) and only climbs
// out of solid rock. No save-schema change: monuments are pure of seed.
function seedMonuments() {
  try {
    SV.monumentDbg = SV.monumentDbg || {};
    SV.monumentDbg.runs = ((SV.monumentDbg && SV.monumentDbg.runs) | 0) + 1;
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0) { SV.monumentDbg.gate = "sp"; return; }
    if ((g.dimension | 0) !== 0) { SV.monumentDbg.gate = "dim"; return; }
    const mc = globalThis.__mcSingleplayer;
    if (!mc || !mc.monumentAt) { SV.monumentDbg.gate = "mc"; return; }
    const p = g.player;
    if (!p) { SV.monumentDbg.gate = "p"; return; }
    let c = null;
    try { c = mc.monumentAt(Math.floor(p.x), Math.floor(p.z)); } catch (e) {}
    SV.monumentDbg.found = !!c;
    if (!c) return;
    const key = "mn" + c.x + "," + c.z;
    if (V_SEED.done.has(key)) { SV.monumentDbg.done = true; return; }
    const offs = (c.elders && c.elders.length === 3) ? c.elders : [[0, 3, 0], [-12, 3, -12], [12, 3, 12]];
    let pending = false;
    SV.monumentDbg.slots = SV.monumentDbg.slots || {};
    for (let i = 0; i < offs.length; i++) {
      const skey = key + ":" + i;
      if (V_SEED.slots.has(skey)) { SV.monumentDbg.slots[i] = "marked"; continue; }
      const sx = c.x + offs[i][0] + 0.5, sz = c.z + offs[i][2] + 0.5;
      if (!chunkLoaded(sx, sz)) { pending = true; SV.monumentDbg.slots[i] = "unloaded"; continue; }
      let y = c.fy + offs[i][1], ok = true;
      try {
        if (isSolidXYZ(sx, y, sz) || isSolidXYZ(sx, y + 1, sz) || isSolidXYZ(sx, y + 2, sz)) {
          ok = false;
          for (let b = 1; b <= 3 && !ok; b++) {
            if (!isSolidXYZ(sx, y + b, sz) && !isSolidXYZ(sx, y + b + 1, sz) && !isSolidXYZ(sx, y + b + 2, sz)) { y = y + b; ok = true; }
          }
        }
      } catch (e) { ok = false; }
      if (!ok) { pending = true; SV.monumentDbg.slots[i] = "solid"; continue; }
      const rec = spawnMob("elder_guardian", sx, y, sz);
      if (rec) {
        rec.monument = { x: c.x, z: c.z, fy: c.fy };
        rec.wx = sx; rec.wz = sz;
        V_SEED.slots.add(skey);
        SV.monumentDbg.slots[i] = "spawned";
      } else { pending = true; SV.monumentDbg.slots[i] = "spawnfail"; }
    }
    if (!pending) V_SEED.done.add(key);
  } catch (e) {}
}

// ---- v1.16.0: deterministic End-city shulkers (2 per tower room) ----
// Seeded lazily like mansions/monuments (once-flags, loaded-chunk gate).
// Shulkers are persistent turrets: no leash-steer, no despawn.
function seedEndCities() {
  try {
    SV.cityDbg = SV.cityDbg || {};
    SV.cityDbg.runs = ((SV.cityDbg && SV.cityDbg.runs) | 0) + 1;
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0) { SV.cityDbg.gate = "sp"; return; }
    if ((g.dimension | 0) !== 1) { SV.cityDbg.gate = "dim"; return; }
    const mc = globalThis.__mcSingleplayer;
    if (!mc || !mc.cityAt) { SV.cityDbg.gate = "mc"; return; }
    const p = g.player;
    if (!p) { SV.cityDbg.gate = "p"; return; }
    let c = null;
    try { c = mc.cityAt(Math.floor(p.x), Math.floor(p.z)); } catch (e) {}
    SV.cityDbg.found = !!c;
    if (!c || !c.slots) return;
    const key = "ec" + c.x + "," + c.z;
    if (V_SEED.done.has(key)) { SV.cityDbg.done = true; return; }
    let pending = false;
    SV.cityDbg.slots = SV.cityDbg.slots || {};
    for (let i = 0; i < c.slots.length; i++) {
      const s = c.slots[i], skey = key + ":" + i;
      if (V_SEED.slots.has(skey)) { SV.cityDbg.slots[i] = "marked"; continue; }
      const sx = s.x + 0.5, sz = s.z + 0.5;
      if (!chunkLoaded(sx, sz)) { pending = true; SV.cityDbg.slots[i] = "unloaded"; continue; }
      let y = s.y, ok = true;
      try {
        if (isSolidXYZ(sx, y, sz)) {
          ok = false;
          for (let b = 1; b <= 3 && !ok; b++) {
            if (!isSolidXYZ(sx, y + b, sz)) { y = y + b; ok = true; }
          }
        }
      } catch (e) { ok = false; }
      if (!ok) { pending = true; SV.cityDbg.slots[i] = "solid"; continue; }
      const rec = spawnMob("shulker", sx, y, sz);
      if (rec) {
        rec.city = { x: c.x, z: c.z };
        try { if (rec.e && s.face != null) rec.e.attachFace = s.face | 0; } catch (e2) {}
        V_SEED.slots.add(skey);
        SV.cityDbg.slots[i] = "spawned";
      } else { pending = true; SV.cityDbg.slots[i] = "spawnfail"; }
    }
    if (!pending) V_SEED.done.add(key);
  } catch (e) {}
}

function leashHome(m) {
  // teleport a strayed village resident back next to its well. Strictly
  // gated: only onto loaded, breathable ground (never into walls).
  try {
    const g = game();
    if (!g || !g.inWorld || (g.dimension | 0) !== 0) return false;
    const mc = globalThis.__mcSingleplayer;
    if (!mc) return false;
    const hx = m.village.x + 2.5, hz = m.village.z + 2.5;
    const p = g.player;
    if (!p) return false;
    const pdx = hx - p.x, pdz = hz - p.z;
    if (pdx * pdx + pdz * pdz > 9216) return false; // home chunk not streamed
    if (!chunkLoaded(hx, hz)) return false;
    const fromY = (m.village.fy || 64) + 6;
    const gy = groundAt(hx, hz, fromY);
    if (gy == null || gy < 1 || gy > 200) return false;
    if (isSolidXYZ(hx, gy, hz) || isSolidXYZ(hx, gy + 1, hz)) return false;
    if (m.def.defender && isSolidXYZ(hx, gy + 2, hz)) return false;
    m.x = hx; m.y = gy + 0.1; m.z = hz;
    m.vx = m.vy = m.vz = 0;
    m.wx = hx; m.wz = hz; m.retarget = 0;
    return true;
  } catch (e) { return false; }
}
/* ---------------------------------------------------------- Phase B2: villager trading
 * Server half over the engine's native merchant window (workstations.js
 * renders + predicts client-side: row clicks set win.selectedTrade and
 * onPickupFromSlot consumes inputs / bumps uses / adds XP locally — all
 * offline-safe since game.send is dead; nothing fills the result slot, so
 * we recompute it every tick from the live trade list, then commit the
 * predicted uses into villager XP/levels/demand/restock and persist).
 *
 * Data: JE 1.15.2-era pools (Feb-2020 minecraft.wiki Trading revision;
 * Bedrock slots + experimental rebalance excluded). Each level unlocks up
 * to 2 new trades, picked randomly from that level's pool (JE rule).
 * Entry: {w,q,w2,q2,g,gq,m,mx,xp,sp} — q=wanted qty|[lo,hi] (the emerald
 * PRICE on sell rows), gq=given qty; w2/q2=second wanted. m=multi,
 * mx=maxUses, xp=villager XP. sp=special: {book}, {gear:'kind'},
 * {col:'family'}, {stew}, {tip}, {dye}. Table version VT_TV below gates
 * stale saves (bump it whenever pool semantics change).
 * Explorer maps are withheld (no mansions/monuments in Phase A worldgen;
 * vanilla withholds the trade when the target doesn't exist).
 */
const VT_XP_NEED = [0, 10, 70, 150, 250]; // xp to go level -> level+1 (JE)
const VT_TV = 1; // trade-table version: stale saves regenerate
const VT_COL16 = ["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"];
const VT_TIPPED = ["night_vision", "invisibility", "leaping", "fire_resistance", "swiftness", "slowness", "water_breathing", "healing", "harming", "poison", "regeneration", "strength", "weakness", "turtle_master", "slow_falling"];
const VT_PURSE = { maxTrades: 10 }; // JE cap (vanilla); pools below never exceed it
const VT_POOLS = {
  armorer: [
    [{ w: "coal", q: 15, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 4, g: "iron_boots", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 7, g: "iron_leggings", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 5, g: "iron_helmet", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 9, g: "iron_chestplate", gq: 1, m: 0.2, mx: 12, xp: 1 }],
    [{ w: "iron_ingot", q: 4, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 36, g: "bell", gq: 1, m: 0.2, mx: 12, xp: 5 }, { q: 1, g: "chainmail_boots", gq: 1, m: 0.2, mx: 12, xp: 5 }, { q: 3, g: "chainmail_leggings", gq: 1, m: 0.2, mx: 12, xp: 5 }],
    [{ w: "lava_bucket", q: 1, gq: 1, m: 0.05, mx: 12, xp: 20 }, { w: "diamond", q: 1, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: 1, g: "chainmail_helmet", gq: 1, m: 0.2, mx: 12, xp: 10 }, { q: 4, g: "chainmail_chestplate", gq: 1, m: 0.2, mx: 12, xp: 10 }, { q: 5, g: "shield", gq: 1, m: 0.2, mx: 12, xp: 10 }],
    [{ w: "diamond", q: 1, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: [18, 35], g: "diamond_leggings", gq: 1, m: 0.2, mx: 3, xp: 15, sp: { gear: "leggings" } }, { q: [11, 27], g: "diamond_boots", gq: 1, m: 0.2, mx: 3, xp: 15, sp: { gear: "boots" } }],
    [{ q: [11, 27], g: "diamond_helmet", gq: 1, m: 0.2, mx: 3, xp: 30, sp: { gear: "helmet" } }, { q: [18, 35], g: "diamond_chestplate", gq: 1, m: 0.2, mx: 3, xp: 30, sp: { gear: "chestplate" } }],
  ],
  butcher: [
    [{ w: "chicken", q: 14, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "porkchop", q: 7, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "rabbit", q: 4, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "rabbit_stew", gq: 1, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "coal", q: 15, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "cooked_porkchop", gq: 5, m: 0.05, mx: 16, xp: 5 }, { q: 1, g: "cooked_chicken", gq: 8, m: 0.05, mx: 16, xp: 5 }],
    [{ w: "mutton", q: 7, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "beef", q: 10, gq: 1, m: 0.05, mx: 16, xp: 20 }],
    [{ w: "dried_kelp_block", q: 10, gq: 1, m: 0.05, mx: 12, xp: 30 }],
    [{ w: "sweet_berries", q: 10, gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  cartographer: [
    [{ w: "paper", q: 24, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 7, g: "map", gq: 1, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "glass_pane", q: 11, gq: 1, m: 0.05, mx: 16, xp: 10 }],
    [{ w: "compass", q: 1, gq: 1, m: 0.05, mx: 12, xp: 20 },
     // v1.15.0: journeyman ocean map (vanilla JE placement — level 3)
     { q: 13, w2: "compass", q2: 1, g: "filled_map", gq: 1, m: 0.05, mx: 12, xp: 10, sp: { explorer: 2 } }],
    [{ q: 7, g: "item_frame", gq: 1, m: 0.05, mx: 12, xp: 15 }, { q: 3, g: "banner", gq: 1, m: 0.05, mx: 12, xp: 15, sp: { col: "banner" } }, { q: 13, w2: "compass", q2: 1, g: "filled_map", gq: 1, m: 0.05, mx: 12, xp: 30, sp: { explorer: 1 } }],
    [{ q: 8, g: "globe_banner_pattern", gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  cleric: [
    [{ w: "rotten_flesh", q: 32, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "redstone", gq: 2, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "gold_ingot", q: 3, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 1, g: "lapis_lazuli", gq: 1, m: 0.05, mx: 12, xp: 5 }],
    [{ w: "rabbit_foot", q: 2, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: 4, g: "glowstone_dust", gq: 1, m: 0.05, mx: 12, xp: 10 }],
    [{ w: "turtle_scute", q: 4, gq: 1, m: 0.05, mx: 12, xp: 30 }, { w: "glass_bottle", q: 9, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 5, g: "ender_pearl", gq: 1, m: 0.05, mx: 12, xp: 15 }],
    [{ w: "nether_wart", q: 22, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 3, g: "experience_bottle", gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  farmer: [
    [{ w: "wheat", q: 20, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "potato", q: 26, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "carrot", q: 22, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "beetroot", q: 15, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "bread", gq: 6, m: 0.05, mx: 16, xp: 1 }],
    [{ w: "pumpkin", q: 6, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 1, g: "pumpkin_pie", gq: 4, m: 0.05, mx: 12, xp: 5 }, { q: 1, g: "apple", gq: 4, m: 0.05, mx: 16, xp: 5 }],
    [{ w: "melon_slice", q: 4, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: 3, g: "cookie", gq: 18, m: 0.05, mx: 12, xp: 10 }],
    [{ q: 1, g: "cake", gq: 1, m: 0.05, mx: 12, xp: 15 }, { q: 1, g: "suspicious_stew", gq: 1, m: 0.05, mx: 12, xp: 15, sp: { stew: 1 } }],
    [{ q: 3, g: "golden_carrot", gq: 3, m: 0.05, mx: 12, xp: 30 }, { q: 4, g: "glistering_melon_slice", gq: 3, m: 0.05, mx: 12, xp: 30 }],
  ],
  fisherman: [
    [{ w: "string", q: 20, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "coal", q: 10, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "cooked_cod", gq: 6, w2: "cod", q2: 6, m: 0.05, mx: 16, xp: 1 }, { q: 3, g: "cod_bucket", gq: 1, m: 0.05, mx: 16, xp: 1 }],
    [{ w: "cod", q: 15, gq: 1, m: 0.05, mx: 16, xp: 10 }, { q: 1, g: "cooked_salmon", gq: 6, w2: "salmon", q2: 6, m: 0.05, mx: 16, xp: 5 }, { q: 2, g: "campfire", gq: 1, m: 0.05, mx: 12, xp: 5 }],
    [{ w: "salmon", q: 13, gq: 1, m: 0.05, mx: 16, xp: 20 }, { q: [7, 22], g: "fishing_rod", gq: 1, m: 0.2, mx: 3, xp: 10, sp: { gear: "rod" } }],
    [{ w: "tropical_fish", q: 6, gq: 1, m: 0.05, mx: 12, xp: 30 }],
    [{ w: "pufferfish", q: 4, gq: 1, m: 0.05, mx: 12, xp: 30 }, { w: "oak_boat", q: 1, gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  fletcher: [
    [{ w: "stick", q: 32, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "arrow", gq: 16, m: 0.05, mx: 12, xp: 1 }, { q: 1, g: "flint", gq: 10, w2: "gravel", q2: 10, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "flint", q: 26, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 2, g: "bow", gq: 1, m: 0.05, mx: 12, xp: 5 }],
    [{ w: "string", q: 14, gq: 1, m: 0.05, mx: 16, xp: 20 }, { q: 3, g: "crossbow", gq: 1, m: 0.05, mx: 12, xp: 10 }],
    [{ w: "feather", q: 24, gq: 1, m: 0.05, mx: 16, xp: 30 }, { q: [7, 22], g: "bow", gq: 1, m: 0.05, mx: 3, xp: 15, sp: { gear: "bow" } }],
    [{ w: "tripwire_hook", q: 8, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: [7, 22], g: "crossbow", gq: 1, m: 0.05, mx: 3, xp: 15, sp: { gear: "xbow" } }, { q: 2, g: "tipped_arrow", gq: 5, w2: "arrow", q2: 5, m: 0.05, mx: 12, xp: 30, sp: { tip: 1 } }],
  ],
  leatherworker: [
    [{ w: "leather", q: 6, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 3, g: "leather_leggings", gq: 1, m: 0.2, mx: 12, xp: 1, sp: { dye: 1 } }, { q: 7, g: "leather_chestplate", gq: 1, m: 0.2, mx: 12, xp: 1, sp: { dye: 1 } }],
    [{ w: "flint", q: 26, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 5, g: "leather_helmet", gq: 1, m: 0.2, mx: 12, xp: 5, sp: { dye: 1 } }, { q: 4, g: "leather_boots", gq: 1, m: 0.2, mx: 12, xp: 5, sp: { dye: 1 } }],
    [{ w: "rabbit_hide", q: 9, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: 7, g: "leather_chestplate", gq: 1, m: 0.2, mx: 12, xp: 1, sp: { dye: 1 } }],
    [{ w: "turtle_scute", q: 4, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 6, g: "leather_horse_armor", gq: 1, m: 0.2, mx: 12, xp: 15, sp: { dye: 1 } }],
    [{ q: 6, g: "saddle", gq: 1, m: 0.2, mx: 12, xp: 30 }, { q: 5, g: "leather_helmet", gq: 1, m: 0.2, mx: 12, xp: 5, sp: { dye: 1 } }],
  ],
  librarian: [
    [{ w: "paper", q: 24, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "enchanted_book", gq: 1, w2: "book", q2: 1, m: 0.2, mx: 12, xp: 1, sp: { book: 1 } }, { q: 9, g: "bookshelf", gq: 1, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "book", q: 4, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 1, g: "lantern", gq: 1, m: 0.05, mx: 12, xp: 5 }, { q: 1, g: "enchanted_book", gq: 1, w2: "book", q2: 1, m: 0.2, mx: 12, xp: 5, sp: { book: 1 } }],
    [{ w: "ink_sac", q: 5, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: 1, g: "glass", gq: 4, m: 0.05, mx: 12, xp: 10 }, { q: 1, g: "enchanted_book", gq: 1, w2: "book", q2: 1, m: 0.2, mx: 12, xp: 10, sp: { book: 1 } }],
    [{ w: "writable_book", q: 2, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 5, g: "clock", gq: 1, m: 0.05, mx: 12, xp: 15 }, { q: 4, g: "compass", gq: 1, m: 0.05, mx: 12, xp: 15 }, { q: 1, g: "enchanted_book", gq: 1, w2: "book", q2: 1, m: 0.2, mx: 12, xp: 15, sp: { book: 1 } }],
    [{ q: 20, g: "name_tag", gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  mason: [
    [{ w: "clay_ball", q: 10, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "brick", gq: 10, m: 0.05, mx: 16, xp: 1 }],
    [{ w: "stone", q: 20, gq: 1, m: 0.05, mx: 16, xp: 10 }, { q: 1, g: "chiseled_stone_bricks", gq: 4, m: 0.05, mx: 16, xp: 5 }],
    [{ w: "granite", q: 16, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "andesite", q: 16, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "diorite", q: 16, gq: 1, m: 0.05, mx: 16, xp: 20 }, { q: 1, g: "polished_andesite", gq: 4, m: 0.05, mx: 16, xp: 10 }, { q: 1, g: "polished_granite", gq: 4, m: 0.05, mx: 16, xp: 10 }, { q: 1, g: "polished_diorite", gq: 4, m: 0.05, mx: 16, xp: 10 }],
    [{ w: "quartz", q: 12, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 1, g: "terracotta", gq: 1, m: 0.05, mx: 12, xp: 15, sp: { col: "terracotta" } }, { q: 1, g: "glazed", gq: 1, m: 0.05, mx: 12, xp: 15, sp: { col: "glazed" } }],
    [{ q: 1, g: "quartz_pillar", gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: 1, g: "quartz_block", gq: 1, m: 0.05, mx: 12, xp: 30 }],
  ],
  shepherd: [
    [{ w: "white_wool", q: 18, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "brown_wool", q: 18, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "black_wool", q: 18, gq: 1, m: 0.05, mx: 16, xp: 2 }, { w: "gray_wool", q: 18, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 2, g: "shears", gq: 1, m: 0.05, mx: 12, xp: 1 }],
    [{ w: "black_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 10 }, { w: "gray_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 10 }, { w: "lime_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 10 }, { w: "light_blue_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 10 }, { w: "white_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 10 }, { q: 1, g: "wool", gq: 1, m: 0.05, mx: 16, xp: 5, sp: { col: "wool" } }, { q: 1, g: "carpet", gq: 4, m: 0.05, mx: 16, xp: 5, sp: { col: "carpet" } }],
    [{ w: "red_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "light_gray_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "pink_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "yellow_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 20 }, { w: "orange_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 20 }, { q: 3, g: "bed", gq: 1, m: 0.05, mx: 12, xp: 10, sp: { col: "bed" } }],
    [{ w: "green_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { w: "brown_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { w: "blue_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { w: "purple_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { w: "cyan_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { w: "magenta_dye", q: 12, gq: 1, m: 0.05, mx: 16, xp: 30 }, { q: 3, g: "banner", gq: 1, m: 0.05, mx: 12, xp: 15, sp: { col: "banner" } }],
    [{ q: 2, g: "painting", gq: 3, m: 0.05, mx: 12, xp: 30 }],
  ],
  toolsmith: [
    [{ w: "coal", q: 15, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 1, g: "stone_axe", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 1, g: "stone_shovel", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 1, g: "stone_pickaxe", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: 1, g: "stone_hoe", gq: 1, m: 0.2, mx: 12, xp: 1 }],
    [{ w: "iron_ingot", q: 4, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 36, g: "bell", gq: 1, m: 0.2, mx: 12, xp: 5 }],
    [{ w: "flint", q: 30, gq: 1, m: 0.05, mx: 12, xp: 20 }, { q: [6, 20], g: "iron_axe", gq: 1, m: 0.2, mx: 3, xp: 10, sp: { gear: "axe" } }, { q: [7, 21], g: "iron_shovel", gq: 1, m: 0.2, mx: 3, xp: 10, sp: { gear: "shovel" } }, { q: [8, 22], g: "iron_pickaxe", gq: 1, m: 0.2, mx: 3, xp: 10, sp: { gear: "pickaxe" } }, { q: [11, 27], g: "diamond_hoe", gq: 1, m: 0.2, mx: 3, xp: 10 }],
    [{ w: "diamond", q: 1, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: [18, 35], g: "diamond_axe", gq: 1, m: 0.2, mx: 3, xp: 15, sp: { gear: "axe" } }, { q: [11, 27], g: "diamond_shovel", gq: 1, m: 0.2, mx: 3, xp: 15, sp: { gear: "shovel" } }],
    [{ q: [18, 35], g: "diamond_pickaxe", gq: 1, m: 0.2, mx: 3, xp: 30, sp: { gear: "pickaxe" } }],
  ],
  weaponsmith: [
    [{ w: "coal", q: 15, gq: 1, m: 0.05, mx: 16, xp: 2 }, { q: 3, g: "iron_axe", gq: 1, m: 0.2, mx: 12, xp: 1 }, { q: [7, 22], g: "iron_sword", gq: 1, m: 0.05, mx: 3, xp: 1, sp: { gear: "sword" } }],
    [{ w: "iron_ingot", q: 4, gq: 1, m: 0.05, mx: 12, xp: 10 }, { q: 36, g: "bell", gq: 1, m: 0.2, mx: 12, xp: 5 }],
    [{ w: "flint", q: 24, gq: 1, m: 0.05, mx: 12, xp: 20 }],
    [{ w: "diamond", q: 1, gq: 1, m: 0.05, mx: 12, xp: 30 }, { q: [18, 35], g: "diamond_axe", gq: 1, m: 0.2, mx: 3, xp: 15, sp: { gear: "axe" } }],
    [{ q: [11, 27], g: "diamond_sword", gq: 1, m: 0.2, mx: 3, xp: 30, sp: { gear: "sword" } }],
  ],
};
/* ---- B2 trade offers: roll, price, persist, tick. Offers live in
 * m.trade = {lvl, xp, offers:[...], restocks, restockDay, lastN, rep}.
 * The window's tradeData.trades ARE these offer objects, so the engine's
 * client-side prediction (uses++/disabled/XP) lands on them directly and
 * tradeTick commits the deltas (uses vs _committed) each masterTick. */
function vtProfName(m) {
  try {
    const P = ["none", "armorer", "butcher", "cartographer", "cleric", "farmer", "fisherman", "fletcher", "leatherworker", "librarian", "mason", "nitwit", "shepherd", "toolsmith", "weaponsmith"];
    return P[(m && m.prof) | 0] || "none";
  } catch (e) { return "none"; }
}
function vtCanTrade(m) {
  if (!m || m.species !== "villager" || m.baby) return false;
  const p = vtProfName(m);
  return p !== "none" && p !== "nitwit" && !!VT_POOLS[p];
}
function vtRollN(q) { // qty: fixed or rolled [lo,hi]
  if (Array.isArray(q)) return q[0] + ((Math.random() * (q[1] - q[0] + 1)) | 0);
  return q | 0;
}
function vtEnchReg() {
  if (SV.vtEnch) return SV.vtEnch;
  const out = [];
  try {
    for (const e of (game().assets.data.enchantments || [])) {
      if (!e || e.tradeable === false || e.curse) continue;
      out.push({ id: String(e.name || "").replace(/^minecraft:/, ""), max: e.maxLevel | 0 || 1, wt: e.weight | 0 || 1, cat: e.category || "", treasure: !!e.treasureOnly });
    }
  } catch (e) {}
  SV.vtEnch = out;
  return out;
}
// enchantment pools per gear kind (JE: no treasure, no curses on gear)
function vtGearPool(kind) {
  const all = vtEnchReg().filter((e) => !e.treasure);
  const byCat = (cats) => all.filter((e) => cats.indexOf(e.cat) >= 0);
  const unb = all.filter((e) => e.id === "unbreaking");
  switch (kind) {
    case "helmet": return byCat(["armor", "armor_head"]).concat(unb);
    case "chestplate": return byCat(["armor", "armor_chest"]).concat(unb);
    case "leggings": return byCat(["armor"]).concat(unb);
    case "boots": return byCat(["armor", "armor_feet"]).filter((e) => e.id !== "frost_walker").concat(unb);
    case "sword": return byCat(["weapon"]).concat(unb);
    case "axe": case "shovel": case "pickaxe": return byCat(["digger"]).concat(unb);
    case "bow": return byCat(["bow"]).concat(unb);
    case "xbow": return all.filter((e) => e.id === "multishot" || e.id === "quick_charge" || e.id === "piercing").concat(unb);
    case "rod": return byCat(["fishing_rod"]).concat(unb);
    default: return unb;
  }
}
function vtPickWeighted(pool) {
  let tot = 0;
  for (const e of pool) tot += e.wt;
  let r = Math.random() * tot;
  for (const e of pool) { r -= e.wt; if (r < 0) return e; }
  return pool[pool.length - 1] || null;
}
function vtNbtEnch(list, stored) {
  // engine {t,v} NBT: enchant list is TAG LIST of compounds {id:STRING, lvl:SHORT}
  const items = list.map((p) => ({ id: { t: 8, v: "minecraft:" + p[0] }, lvl: { t: 2, v: p[1] | 0 } }));
  const key = stored ? "StoredEnchantments" : "Enchantments";
  const o = {}; o[key] = { t: 9, v: { et: 10, items } };
  return { t: 10, v: o };
}
// P4: woodland explorer map — a locked filled_map pre-rendered from our
// own columns (vanilla map color ids, zoom 2 = 4 blocks/px, 512-block span
// centered on the mansion), mansion footprint in brown with a red center.
// Engine gap (not P4): hand maps don't draw icons, so there is no live
// player arrow or structure marker — the mansion blob IS the marker.
// The 128x128 terrain survey is far too slow to run synchronously (16k
// column reads thrash the tectonic lattice cache — minutes on cold terrain,
// a frozen-page kill). So the map allocates instantly with the marker blob
// drawn on a grass field, and the terrain fills in async (8 rows per
// setTimeout slice); the renderer re-uploads on every version bump, so a
// held map visibly resolves. Surveys memoize per mansion.
function allocExplorerMap() {
  return allocStructureMap(1);
}
// v1.15.0: ocean explorer map (cartographer journeyman trade). Same survey
// machinery as the woodland map, retargeted at monuments: water-blue base
// field (vanilla ocean maps show ocean), brown monument blob + red heart.
function allocOceanMap() {
  return allocStructureMap(2);
}
// kind 1 = woodland (mansion), 2 = ocean (monument). Shared survey/fill;
// per-kind memo + map keys so the two never collide.
function allocStructureMap(kind) {
  try {
    const g = game(), mc = globalThis.__mcSingleplayer;
    const ocean = (kind | 0) === 2;
    if (!g || !g.items || !mc || !mc.colAt) return null;
    if (!ocean && !mc.findMansion) return null;
    if (ocean && !mc.findMonument) return null;
    const p = g.player;
    // Fast path: standing inside a mansion footprint (containment check is
    // MCACHE-cheap). Otherwise ring-search (bounded, memo-warm after entry).
    // NOTE: a cold-cache ring search can take seconds on contended entry;
    // callers should prefer settled state. Results memoize per player cell.
    let M = null;
    try {
      const at = ocean ? mc.monumentAt : mc.mansionAt;
      M = at ? at.call(mc, Math.floor(p ? p.x : 0), Math.floor(p ? p.z : 0)) : null;
    } catch (e) {}
    if (!M || !isFinite(M.x) || !isFinite(M.z)) {
      try {
        const ck = (ocean ? "O" : "W") + Math.floor((p ? p.x : 0) / 512) + "," + Math.floor((p ? p.z : 0) / 512);
        allocStructureMap._memo = allocStructureMap._memo || {};
        M = allocStructureMap._memo[ck] || null;
        if (!M) {
          const find = ocean ? mc.findMonument : mc.findMansion;
          M = find.call(mc, p ? p.x : 0, p ? p.z : 0, 10000, 60);
          if (M && isFinite(M.x) && isFinite(M.z)) {
            allocStructureMap._memo[ck] = M;
            const keys = Object.keys(allocStructureMap._memo);
            if (keys.length > 32) delete allocStructureMap._memo[keys[0]];
          }
        }
      } catch (e) { M = null; }
    }
    if (!M || !isFinite(M.x) || !isFinite(M.z)) return null;
    const key = (ocean ? "O" : "W") + Math.round(M.x) + "," + Math.round(M.z);
    try {
      for (const entry of g.items.maps) {
        const id0 = entry[0], rec0 = entry[1];
        if (rec0 && rec0.exKey === key && rec0.exDone) return id0 | 0;
      }
    } catch (e) {}
    const NS = 4, HALF = 64 * NS; // 128px * 4 blocks
    const colors = new Uint8Array(128 * 128);
    // ocean maps start water-blue, woodland maps grass, until the survey
    colors.fill(ocean ? 50 : 6);
    // monument footprint is 41 wide (vs the 40x30 mansion mark)
    const HW = 20, HH = ocean ? 20 : 15;
    // pixel space: the structure center always falls in cell (64,64), so mark
    // the blob by pixel distance — block-space |mdx|<=1 straddles the NS-wide
    // center cell whenever the center is even and the red heart never draws
    const RW = Math.ceil(HW / NS), RH = Math.ceil(HH / NS);
    const mcx = Math.round(M.x), mcz = Math.round(M.z);
    for (let pz = 0; pz < 128; pz++) {
      for (let px = 0; px < 128; px++) {
        const adx = Math.abs(px - 64), adz = Math.abs(pz - 64);
        if (adx <= RW && adz <= RH) colors[pz * 128 + px] = (adx === 0 && adz === 0) ? 18 : 138; // red heart, brown mark
      }
    }
    const surveyCol = (wx, wz) => {
      let col = 6; // grass bright
      try {
        const c = mc.colAt(Math.round(wx), Math.round(wz));
        if (c) {
          if (c.h < 62) col = 50; // water
          else if (c.b === 8) col = 46; // rock/stone
          else if (c.b === 1 || c.b === 6) col = 54; // desert/beach sand
          else if (c.b === 7) col = 34; // snow
          else if (c.b === 4) col = 30; // swamp green-dark (leaves id)
          else col = 6;
          if (c.b !== 4 && c.h >= 62) {
            try { const ti = mc.treeInfo ? mc.treeInfo(Math.round(wx), Math.round(wz)) : null; if (ti && ti.trunk) col = 30; } catch (e) {}
          }
        }
      } catch (e) {}
      return col;
    };
    let id = 1;
    try {
      g.items.maps.forEach((v, k) => { if ((k | 0) >= id) id = (k | 0) + 1; });
    } catch (e) {}
    const rec = { colors, icons: [], scale: 2, version: 0, locked: true, exKey: key, exDone: false };
    try {
      g.items.maps.set(id, rec);
    } catch (e) { return null; }
    const myId = id;
    let idx = 0;
    const step = () => {
      try {
        let cur = null;
        try { cur = g.items.maps.get(myId); } catch (e) {}
        if (!cur) return; // map gone: stop
        // Time-budgeted (≤8ms per slice, checked every 8px): a cold
        // tectonic column can cost tens of ms (lattice gen + cache thrash),
        // so coarse checks still freeze. Slices re-schedule with a 30ms
        // gap so render/tick/streaming always win scheduling.
        const t0 = Date.now();
      while (idx < 128 * 128) {
        const px = idx % 128, pz = (idx / 128) | 0;
        const wx = mcx - HALF + px * NS + NS / 2, wz = mcz - HALF + pz * NS + NS / 2;
        const adx = Math.abs(px - 64), adz = Math.abs(pz - 64);
        if (adx <= RW && adz <= RH) colors[idx] = (adx === 0 && adz === 0) ? 18 : 138;
        else colors[idx] = surveyCol(wx, wz);
        idx++;
        if ((idx & 7) === 0 && Date.now() - t0 > 8) break;
      }
        try { cur.version = (cur.version | 0) + 1; } catch (e) {}
        if (idx < 128 * 128) setTimeout(step, 30);
        else { try { cur.exDone = true; } catch (e) {} }
      } catch (e) {}
    };
    setTimeout(step, 0);
    return myId;
  } catch (e) { return null; }
}

// resolve one pool entry into a concrete offer (null = skip: withheld map /
// unknown item). Rolls price ranges, colors, enchantments once — the roll
// persists, so offers are stable across close/reopen/reload.
function vtResolve(e) {
  try {
    const w = e.w || "emerald", g = e.g || "emerald";
    const q = ("q" in e) ? vtRollN(e.q) : 1;
    const q2 = e.w2 ? vtRollN(e.q2 == null ? 1 : e.q2) : 0;
    const gq = ("gq" in e) ? vtRollN(e.gq) : 1;
    let gName = g, nbt = null;
    const sp = e.sp || null;
    if (sp && sp.col) {
      // one random color per offer (mason terracotta/glazed, shepherd
      // wool/carpet/bed/banner, cartographer banner)
      const c = VT_COL16[(Math.random() * VT_COL16.length) | 0];
      gName = sp.col === "terracotta" ? c + "_terracotta" : sp.col === "glazed" ? c + "_glazed_terracotta" : sp.col === "wool" ? c + "_wool" : sp.col === "carpet" ? c + "_carpet" : sp.col === "bed" ? c + "_bed" : c + "_banner";
    } else if (sp && sp.tip) {
      const fx = VT_TIPPED[(Math.random() * VT_TIPPED.length) | 0];
      nbt = { t: 10, v: { Potion: { t: 8, v: "minecraft:" + fx } } };
    } else if (sp && sp.stew) {
      // random flower effect, rolled at eat time; tag marks the stew
      nbt = { t: 10, v: { Effects: { t: 9, v: { et: 10, items: [{ EffectId: { t: 1, v: 8 }, EffectDuration: { t: 4, v: 100 } }] } } } };
    } else if (sp && sp.dye) {
      nbt = { t: 10, v: { display: { t: 10, v: { color: { t: 3, v: (Math.random() * 0xffffff) | 0 } } } } };
    } else if (sp && sp.book) {
      const pool = vtEnchReg();
      if (!pool.length) return null;
      const pick = pool[(Math.random() * pool.length) | 0]; // JE: uniform type+level
      const lvl = 1 + ((Math.random() * pick.max) | 0);
      let price = 2 + 3 * lvl + ((Math.random() * (11 * lvl + 5)) | 0); // 2+3L..6+13L
      if (pick.treasure) price *= 2;
      nbt = vtNbtEnch([[pick.id, lvl]], true);
      const wId = itemIdByName(w), gId = itemIdByName("enchanted_book");
      if (wId == null || gId == null) return null;
      return vtOffer(e, { w: wId, q: Math.min(64, price), w2: itemIdByName(e.w2 || "book"), q2: q2 || 1, g: gId, gq: 1, nbt });
    } else if (sp && sp.gear) {
      const pool = vtGearPool(sp.gear);
      if (!pool.length) return null;
      const pick = vtPickWeighted(pool);
      const lvl = 1 + ((Math.random() * pick.max) | 0); // power 5-19 worth
      nbt = vtNbtEnch([[pick.id, lvl]], false);
    } else if (sp && sp.explorer) {
      // explorer map: compass + emeralds for a filled_map tagged with our
      // pre-rendered structure survey (withheld when no target in range,
      // same rule as the wandering trader's maps). 1 = woodland (mansion),
      // 2 = ocean (monument, v1.15.0).
      const mid = ((sp.explorer | 0) === 2) ? allocOceanMap() : allocExplorerMap();
      if (mid == null) return null;
      const mapName = ((sp.explorer | 0) === 2) ? "Ocean Explorer Map" : "Woodland Explorer Map";
      nbt = { t: 10, v: { map: { t: 3, v: mid }, display: { t: 10, v: { Name: { t: 8, v: '{"text":"' + mapName + '"}' } } } } };
    }
    const wId = itemIdByName(w), gId = itemIdByName(gName);
    if (wId == null || gId == null) return null;
    let w2Id = 0;
    if (e.w2) { w2Id = itemIdByName(e.w2); if (w2Id == null) return null; }
    return vtOffer(e, { w: wId, q, w2: w2Id, q2, g: gId, gq, nbt });
  } catch (err) { return null; }
}
function vtOffer(e, r) {
  const mk = (id, count, nbt) => (id ? { id, count: Math.max(1, count | 0), nbt: nbt || undefined } : null);
  return {
    a: mk(r.w, r.q), out: mk(r.g, r.gq, r.nbt), b: r.w2 ? mk(r.w2, r.q2) : null,
    disabled: false, uses: 0, max: e.mx | 0 || 12, xp: e.xp | 0 || 1,
    specialPrice: 0, priceMultiplier: e.m != null ? +e.m : 0.05, demand: 0,
    _key: (e.w || "e") + ":" + (e.g || "e") + ":" + (e.w2 || "") + ":" + (r.gq | 0) + ":" + JSON.stringify(r.nbt || null),
    _committed: 0,
  };
}
function vtUnlock(m, lvl) {
  // add up to 2 new trades from the level pool (JE rule), skipping offers
  // already held (color families dedupe by resolved color) and the vanilla
  // fletcher-master rule (tipped arrows: 1/3 chance on top of the 2 draws)
  try {
    const t = m.trade;
    if (!t) return;
    const pool = (VT_POOLS[vtProfName(m)] || [])[lvl - 1] || [];
    const have = {};
    for (const o of t.offers) have[o._key] = true;
    let cands = [];
    for (const e of pool) {
      if (e.sp && e.sp.tip) continue; // fletcher tipped handled below
      const o = vtResolve(e);
      if (o && !have[o._key]) { have[o._key] = true; cands.push(o); }
    }
    // shuffle + take 2
    for (let i = cands.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = cands[i]; cands[i] = cands[j]; cands[j] = x; }
    const take = cands.slice(0, 2);
    if (vtProfName(m) === "fletcher" && lvl === 5 && Math.random() < 1 / 3) {
      for (const e of pool) {
        if (e.sp && e.sp.tip) {
          const o = vtResolve(e);
          if (o && !have[o._key]) take.push(o);
          break;
        }
      }
    }
    for (const o of take) {
      if (t.offers.length >= VT_PURSE.maxTrades) break;
      t.offers.push(o);
    }
  } catch (e) {}
}
function vtMakeTrade(prof) {
  const t = { lvl: 1, xp: 0, offers: [], restocks: 0, restockDay: -1, lastN: 0, rep: 0 };
  const m = { species: "villager", prof: 0, trade: t };
  // prof index lookup without the engine table
  try {
    const P = ["none", "armorer", "butcher", "cartographer", "cleric", "farmer", "fisherman", "fletcher", "leatherworker", "librarian", "mason", "nitwit", "shepherd", "toolsmith", "weaponsmith"];
    m.prof = Math.max(0, P.indexOf(prof));
  } catch (e) {}
  const pool = (VT_POOLS[prof] || [])[0] || [];
  const have = {}, cands = [];
  for (const e of pool) { const o = vtResolve(e); if (o && !have[o._key]) { have[o._key] = true; cands.push(o); } }
  for (let i = cands.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = cands[i]; cands[i] = cands[j]; cands[j] = x; }
  t.offers = cands.slice(0, 2);
  return t;
}
/* ---- B2 merchant window: open, commit, refresh, restock, close. */
function vtTradeCost(a, demand, multi, special, maxStack) {
  // engine tradeCost() verbatim (workstations-1.14.4.js): demand + special
  // fold into the first item only, clamped to [1, stack]
  try {
    const extra = Math.max(0, Math.floor(Math.fround(Math.fround(a.count * demand) * multi)));
    return Object.assign({}, a, { count: Math.max(1, Math.min(maxStack || 64, a.count + extra + (special | 0))) });
  } catch (e) { return a; }
}
function vtPacket(m) {
  const t = m.trade;
  return { windowId: 1, villagerLevel: t.lvl, experience: t.xp, isRegularVillager: true, canRestock: true, trades: t.offers };
}
function vtPushTrade(m) {
  // (re)send the live offer list; the screen re-renders from tradeData
  try {
    const g = game();
    if (!g || !g.inWorld || !m.trade) return false;
    if (!g.window || g.window.windowId !== 1 || g.window.type !== "minecraft:villager") return false;
    g.on_trade_list(vtPacket(m));
    return true;
  } catch (e) { return false; }
}
function openTrade(m) {
  if (!m || !survives() || SV.dead) return false;
  if (!vtCanTrade(m)) {
    try { sfx("entity.villager.no"); } catch (e) {}
    return true; // swallowed: vanilla headshake, no window
  }
  try {
    vtEnsureTrade(m);
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (g.window) {
      if (g.window.type === "minecraft:villager" && SV.openTrade && SV.openTrade.vid === m.id) return true; // dup route
      try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:villager", windowTitle: { text: "Villager" }, slotCount: 3, entityId: m.id });
    if (!g.window || g.window.type !== "minecraft:villager") return false;
    const wb = g.window.container;
    if (wb) for (let i = 0; i < 3; i++) wb[i] = null;
    g.on_trade_list(vtPacket(m));
    SV.openTrade = { vid: m.id, wid: 1 };
    m.tradeOpen = true;
    try { sfx("entity.villager.trade"); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function vtMatchResult(w, sel) {
  // mirror the engine pickup scan (selected first, either input order) to
  // find the offer whose inputs are satisfied; result slot follows it
  try {
    const data = w.tradeData;
    if (!data || !data.trades) return null;
    const matches = (slot, item) => {
      const s = w.get(slot);
      if (item) return !!s && s.id === item.id && s.count >= item.count;
      return !s;
    };
    const list = data.trades, selected = list[sel | 0] || null;
    const ordered = selected ? [selected].concat(list.filter((t) => t !== selected)) : list.slice();
    const maxStack = (it) => { try { return game().items.maxStack(it.id); } catch (e) { return 64; } };
    for (const cand of ordered) {
      if (!cand || cand.disabled || !cand.out) continue;
      const cost = vtTradeCost(cand.a, cand.demand | 0, cand.priceMultiplier, cand.specialPrice | 0, maxStack(cand.a));
      if (matches(0, cost) && matches(1, cand.b)) return { trade: cand, first: 0 };
      if (matches(1, cost) && matches(0, cand.b)) return { trade: cand, first: 1 };
    }
  } catch (e) {}
  return null;
}
function vtRefreshResult(w) {
  // the server half of set_slot: show the matched offer's output, else air
  try {
    if (!w || w.type !== "minecraft:villager" || !w.tradeData) return;
    const hit = vtMatchResult(w, w.selectedTrade | 0);
    const want = hit ? hit.trade.out : null;
    const cur = w.get(2);
    const same = (!cur && !want) || (cur && want && cur.id === want.id && cur.count === want.count);
    if (!same) {
      try {
        w.put(2, want ? { id: want.id, count: want.count, nbt: want.nbt ? structuredClone(want.nbt) : undefined } : null);
      } catch (e) {
        try { w.put(2, want ? { id: want.id, count: want.count } : null); } catch (e2) {}
      }
    }
  } catch (e) {}
}
function vtCommitWindow() {
  // fold the engine's predicted uses into villager XP/levels/reputation,
  // player orbs, level-up unlocks; returns leveled-up mob or null
  let leveled = null;
  try {
    const ot = SV.openTrade;
    if (!ot) return null;
    const m = SV.mobs.get(ot.vid);
    const g = game();
    const w = g && g.window;
    if (!m || !m.trade || !w || w.type !== "minecraft:villager" || (w.tradeData && w.tradeData.trades !== m.trade.offers)) {
      if (m && m.trade) { for (const o of m.trade.offers) o._committed = o.uses; }
      return null;
    }
    const t = m.trade;
    let xpGain = 0;
    for (const o of t.offers) {
      const d = (o.uses | 0) - (o._committed | 0);
      if (d <= 0) { o._committed = o.uses | 0; continue; }
      o._committed = o.uses | 0;
      xpGain += d * (o.xp | 0);
      t.rep = Math.min(20, (t.rep | 0) + 2 * d); // trading gossip (minor positive)
      try {
        for (const v of orbSplit(3 + ((Math.random() * 4) | 0))) spawnXPOrb(m.x, m.y + 1.2, m.z, v);
      } catch (e) {}
      try { sfx("entity.villager.yes"); } catch (e) {}
    }
    if (xpGain > 0) {
      t.xp += xpGain;
      // wandering traders don't level or unlock (vanilla); villagers do
      if (!t.noLevel) {
      while (t.lvl < 5 && t.xp >= VT_XP_NEED[t.lvl]) {
        t.lvl++;
        vtUnlock(m, t.lvl);
        leveled = m;
        try {
          m.hp = Math.min(m.maxHp || 20, m.hp + 4);
          game().particles.happy_villager(m.x, m.y + 1, m.z);
        } catch (e) {}
        try { sfx("entity.villager.celebrate"); } catch (e) {}
        try {
          for (const v of orbSplit(5)) spawnXPOrb(m.x, m.y + 1.2, m.z, v);
        } catch (e) {}
      }
      if (leveled) vtPushTrade(m);
      else { try { if (w.tradeData) w.tradeData.experience = t.xp; } catch (e) {} }
      try { if (m.e) m.e.villagerLevel = t.lvl; } catch (e) {}
      } // !t.noLevel
    }
  } catch (e) {}
  return leveled;
}
function vtRestockDue(t) {
  try {
    const day = Math.floor((SV.tickN | 0) / 12000);
    if ((t.restockDay | 0) !== day && day !== 0) { t.restockDay = day; t.restocks = 0; }
    return (t.restocks | 0) < 2 && (SV.tickN | 0) - (t.lastN | 0) >= 3600 &&
      t.offers.some((o) => o.disabled || (o.demand | 0) !== 0 || (o.uses | 0) > 0);
  } catch (e) { return false; }
}
function vtRestock(m) {
  // JE: demand += 2*uses - (max-uses), uses reset; caps at 2/day
  try {
    const t = m.trade;
    if (!t) return false;
    for (const o of t.offers) {
      const u = o.uses | 0, mx = o.max | 0;
      o.demand = (o.demand | 0) + 2 * u - (mx - u);
      o.uses = 0; o.disabled = false; o._committed = 0;
    }
    t.restocks = (t.restocks | 0) + 1; t.lastN = SV.tickN | 0;
    if ((t.restockDay | 0) < 0) t.restockDay = Math.floor((SV.tickN | 0) / 12000);
    t.rep = Math.trunc((t.rep | 0) / 2); // gossip decays
    vtApplyRep(m);
    if (SV.openTrade && SV.openTrade.vid === m.id) { vtPushTrade(m); }
    return true;
  } catch (e) { return false; }
}
function vtApplyRep(m) {
  // JE price formula's reputation term folds into specialPrice (hero=0 here;
  // raids come later): special = -floor(m*r), clamped by tradeCost itself
  try {
    const t = m.trade;
    if (!t) return;
    const r = t.rep | 0;
    for (const o of t.offers) o.specialPrice = -Math.floor((o.priceMultiplier || 0) * r);
  } catch (e) {}
}
function tradeRep(m, d) {
  try {
    if (!m || !m.trade) return;
    m.trade.rep = Math.max(-30, Math.min(20, (m.trade.rep | 0) + d));
    vtApplyRep(m);
  } catch (e) {}
}
function tradeTick() {
  // runs every masterTick; cheap when no merchant window is open
  try {
    const ot = SV.openTrade;
    if (!ot) return;
    const g = game();
    const w = g && g.window;
    const m = SV.mobs.get(ot.vid);
    if (!m || !m.trade || m.hp <= 0 || !w || w.type !== "minecraft:villager" || w.windowId !== (ot.wid | 0 || 1)) {
      try { closeTradeWindow(true); } catch (e) {}
      return;
    }
    const p = g.player;
    if (p) {
      const dx = p.x - m.x, dz = p.z - m.z, dy = p.y - m.y;
      if (dx * dx + dz * dz > 64 || dy > 6 || dy < -6) { // left reach: menu closes
        try { closeTradeWindow(false); } catch (e) {}
        return;
      }
    }
    vtCommitWindow();
    if (!m.trade.noRestock && vtRestockDue(m.trade)) vtRestock(m);
    vtRefreshResult(w);
  } catch (e) {}
}
function closeTradeWindow(silent) {
  // commit pending uses, salvage input slots 0/1 to the player (vanilla
  // drops them; inventory return is friendlier — workbench precedent)
  try {
    const ot = SV.openTrade;
    SV.openTrade = null;
    const g = game();
    const w = g && g.window;
    const m = ot ? SV.mobs.get(ot.vid) : null;
    if (m) m.tradeOpen = false;
    if (w && w.type === "minecraft:villager") {
      try { vtCommitWindow(); } catch (e) {}
      for (let i = 0; i <= 1; i++) {
        let s = null;
        try { s = w.container[i]; } catch (e) {}
        if (s && s.id) {
          try {
            const cp = { id: s.id, count: s.count | 0 };
            if (s.nbt) cp.nbt = s.nbt;
            let left = cp.count;
            try {
              const inv = g.inventory;
              if (inv && typeof inv.addToInventory === "function") { inv.addToInventory(cp); left = cp.count | 0; }
            } catch (e) {}
            if (left > 0) {
              try {
                const p = g.player;
                spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
              } catch (e) {}
            }
          } catch (e) {}
        }
      }
      if (!silent) {
        try { g.on_close_window({ windowId: w.windowId }); } catch (e) {}
        try { g.window = null; } catch (e) {}
      }
    }
  } catch (e) {
    try { SV.openTrade = null; } catch (e2) {}
  }
}
function handleVillagerUse(t) {
  if (!survives() || SV.dead) return false;
  let m = null;
  try { m = resolveMobTarget(t); } catch (e) {}
  if (!m || (m.species !== "villager" && m.species !== "wandering_trader")) return false;
  if (m.species === "wandering_trader") return openTraderTrade(m);
  return openTrade(m);
}
/* ---- B2 trade persistence: rec.vtrade keyed by village+house slot (the
 * seed order is deterministic, villages are pure of seed). Egg-spawned
 * villagers (no village) trade session-only. */
function vtTradeKey(m) {
  try {
    if (m.tradeKey) return m.tradeKey;
    if (!m.village) return null;
    const vkey = m.village.x + "," + m.village.z;
    // house slot: nearest seeded offset to the spawn point (matches the
    // seedVillages slot at spawn time; stable across reloads)
    let best = 0, bd = 1e12;
    const offs = [[5, 3], [-4, -2], [2, 6], [-6, 4], [7, -5]];
    const sx = m.wx != null ? m.wx : m.x, sz = m.wz != null ? m.wz : m.z;
    for (let i = 0; i < offs.length; i++) {
      const hx = m.village.x + offs[i][0] + 0.5, hz = m.village.z + offs[i][1] + 0.5;
      const d = (hx - sx) * (hx - sx) + (hz - sz) * (hz - sz);
      if (d < bd) { bd = d; best = i; }
    }
    m.tradeKey = vkey + ":" + best;
    return m.tradeKey;
  } catch (e) { return null; }
}
function vtPackTrade(t) {
  // resolved offers + dynamics; numeric ids remapped like all saved ids
  try {
    return {
      tv: VT_TV, lvl: t.lvl | 0, xp: t.xp | 0, restocks: t.restocks | 0, restockDay: t.restockDay | 0, lastN: t.lastN | 0, rep: t.rep | 0,
      offers: t.offers.map((o) => ({
        w: o.a.id, q: o.a.count, w2: o.b ? o.b.id : 0, q2: o.b ? o.b.count : 0,
        g: o.out.id, gq: o.out.count, n: o.out.nbt || o.a.nbt || null,
        m: o.priceMultiplier, mx: o.max, xp: o.xp, u: o.uses, d: o.demand, k: o._key,
      })),
    };
  } catch (e) { return null; }
}
function vtUnpackTrade(p) {
  try {
    if (!p || p.tv !== VT_TV || !Array.isArray(p.offers)) return null;
    const t = { lvl: p.lvl | 0 || 1, xp: p.xp | 0, restocks: p.restocks | 0, restockDay: p.restockDay == null ? -1 : p.restockDay | 0, lastN: p.lastN | 0, rep: p.rep | 0, offers: [] };
    if (t.lvl < 1 || t.lvl > 5) t.lvl = 1;
    for (const s of p.offers) {
      if (!s || s.w == null || s.g == null) continue;
      const mk = (id, c, nbt) => (id ? { id: id | 0, count: Math.max(1, c | 0), nbt: nbt || undefined } : null);
      // trade inputs never carry NBT in vanilla (armor durability ignored);
      // only outputs (enchants, maps, stew, dyed leather) do
      t.offers.push({
        a: mk(s.w, s.q), out: mk(s.g, s.gq, s.n || null), b: s.w2 ? mk(s.w2, s.q2) : null,
        disabled: (s.u | 0) >= (s.mx | 0), uses: s.u | 0, max: s.mx | 0 || 12, xp: s.xp | 0 || 1,
        specialPrice: 0, priceMultiplier: s.m != null ? +s.m : 0.05, demand: s.d | 0,
        _key: s.k || (s.w + ":" + s.g), _committed: s.u | 0,
      });
    }
    if (!t.offers.length) return null;
    return t;
  } catch (e) { return null; }
}
function vtSavedTrade(key) {
  try {
    const sp = SP();
    if (!sp || !sp.id || !key) return null;
    const rec = loadWorldRecSv(sp.id);
    const p = rec && rec.vtrade && rec.vtrade[key];
    return vtUnpackTrade(p);
  } catch (e) { return null; }
}
function vtEnsureTrade(m) {
  // attach the persisted record (same prof) or roll a fresh novice
  try {
    if (m.trade) return m.trade;
    const prof = vtProfName(m);
    let t = null;
    const key = vtTradeKey(m);
    if (key) {
      t = vtSavedTrade(key);
      if (t) {
        // pool sanity: offers must belong to this profession's pools
        const pools = VT_POOLS[prof] || [];
        const keys = {};
        for (const lv of pools) for (const e of lv) keys[(e.w || "e") + ":" + (e.g || "e") + ":" + (e.w2 || "")] = true;
        const ok = t.offers.every((o) => keys[String(o._key).split(":").slice(0, 3).join(":")] || /minecraft:/.test(o._key));
        if (!ok) t = null;
      }
    }
    if (!t) t = vtMakeTrade(prof);
    if (t.lvl < 1) t.lvl = 1;
    if (t.lvl > 5) t.lvl = 5;
    m.trade = t;
    vtApplyRep(m);
    return t;
  } catch (e) { return null; }
}
/* ---- B2 stable village professions (engine ids): farmer-heavy, all 13
 * employed professions plus unemployed (0) and rare nitwit (11). */
const VT_PROF_W = [[5, 4], [9, 2], [6, 2], [7, 2], [12, 2], [13, 2], [1, 1], [2, 1], [3, 1], [4, 1], [8, 1], [10, 1], [14, 1], [0, 2], [11, 1]];
function vtRandomProf() {
  let tot = 0;
  for (const p of VT_PROF_W) tot += p[1];
  let r = Math.random() * tot;
  for (const p of VT_PROF_W) { r -= p[1]; if (r < 0) return p[0]; }
  return 5;
}
function vtHashProf(key) {
  // stable pick per village+slot so re-seeds restore the same villagers
  try {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    let tot = 0;
    for (const p of VT_PROF_W) tot += p[1];
    let r = (h >>> 0) % tot;
    for (const p of VT_PROF_W) { r -= p[1]; if (r < 0) return p[0]; }
  } catch (e) {}
  return 5;
}
function vtPaintProf(rec, pi) {
  try {
    rec.prof = pi;
    const e = rec.e;
    if (e) { e.profession = pi; e.villagerProfession = pi; e.villagerType = 2; e.villagerLevel = (rec.trade && rec.trade.lvl) || 1; }
  } catch (err) {}
}
function calmSpider(m) {
  // vanilla: spiders stay hostile while the light around them is 11 or less;
  // in brighter light they go neutral unless provoked (retaliation still counts)
  if (m.species !== "spider") return false;
  try {
    if (effLight(m.x, m.y + 1, m.z) <= 11) return false;
  } catch (e) { return false; }
  return Date.now() - (m.provokedAt || 0) > 10000;
}
function mobMeleeDmg(def) {
  const d = difficulty();
  if (def.dmg && typeof def.dmg === "object") return def.dmg[d] != null ? def.dmg[d] : def.dmg[2];
  return def.dmg || 0;
}
function mobLabel(species) {
  return { zombie: "Zombie", husk: "Husk", skeleton: "Skeleton", stray: "Stray", creeper: "Creeper", spider: "Spider", enderman: "Enderman", slime: "Slime", magma_cube: "Magma Cube", witch: "Witch", silverfish: "Silverfish", endermite: "Endermite", phantom: "Phantom", wolf: "Wolf", polar: "Polar Bear", iron_golem: "Iron Golem", snow_golem: "Snow Golem", wither: "Wither", villager: "Villager", cow: "Cow", pig: "Pig", sheep: "Sheep", chicken: "Chicken", rabbit: "Rabbit", ocelot: "Ocelot", cat: "Cat", parrot: "Parrot", squid: "Squid", bat: "Bat", turtle: "Turtle", dolphin: "Dolphin", bee: "Bee", goat: "Goat", axolotl: "Axolotl", glow_squid: "Glow Squid", guardian: "Guardian", elder_guardian: "Elder Guardian", drowned: "Drowned", blaze: "Blaze", wither_skeleton: "Wither Skeleton", ender_dragon: "Ender Dragon", shulker: "Shulker", frog: "Frog", tadpole: "Tadpole", allay: "Allay", camel: "Camel", sniffer: "Sniffer", warden: "Warden" }[species] || species;
}
function faceMove(m, tx, tz) {
  const dx = tx - m.x, dz = tz - m.z;
  // engine yaw is DEGREES (models render with yaw*PI/180), so convert.
  if (dx * dx + dz * dz > 0.0004) m.yaw = Math.atan2(-dx, dz) * 180 / Math.PI;
}

// v1.12 mob animation pass: the engine renders limb swings from the
// per-frame x/prevX delta plus a set of visual flags (onGround, inWater,
// angry, screaming, armsRaised, eatingGrass, sitting, ...). The old
// write-back snapped prev==current every tick, so every mob slid around
// with frozen limbs. Now the sim acts like a multiplayer server: it
// publishes the target (newX/inc) and lets the engine integrate x toward
// it — the exact path vanilla limbSwing is computed from. Teleports,
// spawns and stalls still snap (yesterday's behavior, jump-detected).
function snapMobEnt(rec) {
  const e = rec.e; if (!e) return;
  try {
    e.x = e.newX = e.prevX = e.lastTickX = rec.x;
    e.y = e.newY = e.prevY = e.lastTickY = rec.y;
    e.z = e.newZ = e.prevZ = e.lastTickZ = rec.z;
    e.inc = 0;
    e.yaw = e.newYaw = e.headYaw = e.prevYaw = e.prevHeadYaw = rec.yaw;
    e.bodyYaw = e.prevBodyYaw = rec.yaw;
    rec.lastETick = e.ticks | 0;
  } catch (err) {}
}
function mobAnimSwing(m) {
  // melee/ranged wind-up flash: the engine counts swingTicks 0..5 itself
  try { if (m && m.e) { m.e.swinging = true; m.e.swingTicks = 0; } } catch (e) {}
}
function driveMobEnt(m, dt) {
  const e = m.e; if (!e) return;
  try {
    const dx = m.x - e.newX, dy = m.y - e.newY, dz = m.z - e.newZ;
    const frames = (e.ticks | 0) - (m.lastETick | 0);
    if (!m.lastETick || frames <= 0 || frames > 40 ||
        dx * dx + dz * dz > 16 || dy > 6 || dy < -12) snapMobEnt(m);
    else {
      e.newX = m.x; e.newY = m.y; e.newZ = m.z;
      e.newYaw = m.yaw;
      e.inc = Math.max(1, Math.min(frames, 6));
      m.lastETick = e.ticks | 0;
    }
    // yaw/head/body turn discretely with the sim (as before); only the
    // position rides the interpolator, which is what limbSwing diffs
    e.yaw = e.prevYaw = m.yaw;
    e.headYaw = e.prevHeadYaw = m.yaw;
    e.bodyYaw = e.prevBodyYaw = m.yaw;
    e.onGround = !!m.ground;
    e.inWater = !!m.inWater;
    if (m.def) {
      if (m.def.creeper) e.creeperState = m.fuse >= 0 ? 1 : -1;
      if (m.species === "enderman") { e.screaming = !!m.angry; e.angry = !!m.angry; }
      else if (m.species === "wolf") {
        e.tamed = !!m.tame;
        try { e.wolfHealth = m.hp; } catch (er) {}
        e.angry = Date.now() - (m.provokedAt || 0) < 10000;
        e.sitting = !!m.sitting;
      } else if (m.species === "bee") {
        // banking roll while recently provoked (peaceful bees never anger)
        try { e.beeRolling = !!(Date.now() - (m.provokedAt || 0) < 10000 && difficulty() !== 0); } catch (er) {}
      }
      if (m.species === "skeleton" || m.species === "stray") e.armsRaised = !!m.aiming;
      if (m.species === "pillager") e.armsRaised = !!m.aiming; // 'attacking' pose (bow pose is illusioner-hardcoded in the engine)
      else if (m.species === "vindicator") e.armsRaised = Date.now() - (m.swingAt || 0) < 600;
      else if (m.species === "evoker") e.spell = !!m.casting; // spellcasting pose
      else if (m.species === "vex") e.charging = !!m.swoop; // wings-back dive
      // sheep graze in bursts while the coat regrows (engine counts down);
      // coat fields re-asserted every tick (save-restore safe)
      if (m.species === "sheep") {
        try { m.e.sheared = !!m.sheared; m.e.fleece = fleeceOf(m.color); } catch (er) {}
        if (m.sheared && (m.regrow | 0) > 0 && !(e.eatingGrass > 0)) e.eatingGrass = 40;
      }
      if (m.species === "witch") {
        // nose-wiggle drink/throw tell (engine reads type-66 usingItem only)
        if ((m.drinkAnim | 0) > 0 || (m.throwAnim | 0) > 0) e.usingItem = true;
        else if (e.usingItem) e.usingItem = false;
      }
      if (m.drinkAnim > 0) m.drinkAnim -= dt;
      if (m.throwAnim > 0) m.throwAnim -= dt;
      try { e.powered = !!m.charged; } catch (er) {}
      // P4 1.19 visuals: variant/child/dance/sniff flags the renderer reads.
      try {
        if (m.species === "frog" && m.frogVariant != null) e.frogVariant = m.frogVariant | 0;
        if (m.species === "camel" || m.species === "sniffer") e.child = !!m.baby;
        if (m.species === "allay") e.dancing = !!m.dancing;
        if (m.species === "sniffer" && m.snifferState) e.snifferState = m.snifferState;
        if (m.species === "warden" && m.angerLevel != null) e.angerLevel = m.angerLevel;
        if (m.species === "camel") e.dashing = !!m.dashing;
      } catch (er2) {}
    }
  } catch (err) {}
}
// v1.12: horse twin of driveMobEnt (same interpolator path + the horse
// model's head/rear/graze/mouth/tail flags). Boats/carts/stands keep
// their own write-backs — vehicles, not mobs.
function driveHorseEnt(h) {
  const e = h.e; if (!e) return;
  try {
    const dx = h.x - e.newX, dy = h.y - e.newY, dz = h.z - e.newZ;
    const frames = (e.ticks | 0) - (h.lastETick | 0);
    if (!h.lastETick || frames <= 0 || frames > 40 ||
        dx * dx + dz * dz > 16 || dy > 6 || dy < -12) {
      e.x = e.newX = e.prevX = e.lastTickX = h.x;
      e.y = e.newY = e.prevY = e.lastTickY = h.y;
      e.z = e.newZ = e.prevZ = e.lastTickZ = h.z;
      e.inc = 0;
      e.yaw = e.newYaw = e.headYaw = e.prevYaw = e.prevHeadYaw = h.yaw;
      e.bodyYaw = e.prevBodyYaw = h.yaw;
      h.lastETick = e.ticks | 0;
    } else {
      e.newX = h.x; e.newY = h.y; e.newZ = h.z;
      e.newYaw = h.yaw;
      e.inc = Math.max(1, Math.min(frames, 6));
      h.lastETick = e.ticks | 0;
    }
    e.yaw = e.prevYaw = h.yaw;
    e.headYaw = e.prevHeadYaw = h.yaw;
    e.bodyYaw = e.prevBodyYaw = h.yaw;
    e.onGround = !!h.ground;
    e.inWater = !!h.inWater;
    e.saddled = !!h.saddle;
    e.horseChest = !!h.chested;
    e.hasRider = h.id === SV.rideHorse;
    let flags = 0;
    if (h.buckT > 0) flags |= 64; // rearing while bucking the rider
    else if (!e.hasRider && h.ground && Math.abs(h.vx) + Math.abs(h.vz) < 0.3) flags |= 32; // grazing head-down while idle
    if (flags & 32) flags |= 128; // nibbling mouth while grazing
    e.horseFlags = flags;
    if ((h.tailT = (h.tailT | 0) - 1) <= 0) h.tailT = 60 + ((Math.random() * 120) | 0);
    e.tailWag = h.tailT < 15;
  } catch (e2) {}
}
// v1.12: sweep finished death animations (engine falls the body over ~20
// of its own ticks, then poofs it; we destroy late and silent if it did)
function sweepCorpses() {
  if (!SV.corpses || !SV.corpses.length) return;
  const now = Date.now(), keep = [];
  for (const c of SV.corpses) {
    if (now - c.at < (c.long ? 10000 : 1200)) { keep.push(c); continue; }
    try {
      const e = game().entities.get(c.id);
      if (e) {
        if (!(e.deathTime >= 20)) { try { game().particles.deathPoof(e.x, e.y + 0.5, e.z); } catch (e2) {} }
        game().entities.destroy([c.id]);
      }
    } catch (e2) {}
  }
  SV.corpses = keep;
}

/* ---------------------------------------------------------- P4 1.19 mobs:
 * frog eats small slimes (froglight by variant); tadpole bucketing is in
 * handleMobUse/handleBlockUse; allay fetch/duplicate/dance; camel ride/dash
 * (SV.rideCamel, horse-steering idiom); sniffer digs torchflower seeds;
 * warden senses/booms/despawns. Shrieker summons + recovery compass + horn
 * blow live in their own sections below. */

// numeric item id -> registry name (reverse of itemIdByName's cache)
function p4ItemName(id) {
  try {
    if (!SV.itemIdToName) {
      SV.itemIdToName = {};
      if (game().items && game().items.byName) {
        const bn = game().items.byName;
        const put = (k, v) => { const i = v && v.id != null ? v.id : v; if (i != null) SV.itemIdToName[i | 0] = k; };
        if (bn.forEach) bn.forEach(put);
        else for (const k in bn) put(k, bn[k]);
      }
    }
    return SV.itemIdToName[id | 0] || null;
  } catch (e) { return null; }
}

function frogTick(m, dt) {
  // eat small slimes/magma cubes whole (vanilla); drops a froglight of the
  // frog's variant color. Small cooldown so one frog clears a swarm slowly.
  try {
    if ((m.frogCd || 0) > Date.now()) return;
    if (!m.inWater && !m.ground) return;
    let prey = null, bd = 9;
    SV.mobs.forEach((o) => {
      if (prey || !o || o === m || o.hp <= 0) return;
      if (o.species !== "slime" && o.species !== "magma_cube") return;
      if ((o.size | 0) > 1) return;
      const dx = o.x - m.x, dz = o.z - m.z;
      if (Math.abs(o.y - m.y) > 2) return;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; prey = o; }
    });
    if (!prey) return;
    m.frogCd = Date.now() + 8000;
    try { faceMove(m, prey.x, prey.z); } catch (e) {}
    try { if (m.e) m.e.tongueTarget = prey.id; } catch (e2) {}
    try { sfx("entity.frog.eat"); } catch (e3) {}
    try { removeMob(prey.id); } catch (e4) {}
    const v = m.frogVariant | 0;
    const fl = v === 1 ? "verdant_froglight" : v === 2 ? "pearlescent_froglight" : "ochre_froglight";
    try {
      const fid = itemIdByName(fl);
      if (fid != null) spawnItemEntity(m.x, m.y + 0.5, m.z, fid, 1);
    } catch (e5) {}
  } catch (e) {}
}

function allayTick(m, dt) {
  const g = game(), p = g.player;
  if (!p) return;
  // dance near a jukebox (vanilla dances to playing discs; we read proximity
  // to any jukebox as the trigger — no disc-play tracker exists yet).
  try {
    let dance = false;
    for (let ox = -4; ox <= 4 && !dance; ox++) {
      for (let oy = -3; oy <= 3 && !dance; oy++) {
        for (let oz = -4; oz <= 4 && !dance; oz++) {
          if (blockNameAt(m.x + ox, m.y + oy, m.z + oz) === "jukebox") dance = true;
        }
      }
    }
    m.dancing = dance;
    if (m.e) m.e.dancing = dance;
  } catch (e) {}
  // duplication: amethyst shard while dancing makes a copy (5-min cooldown).
  // The consume itself happens in handleMobUse; the timer gates both.
  // follow the player when they hold an item (vanilla 64-block liked-player
  // leash, approximated as follow-within-3 here; movement runs in mobTick's
  // fly branch, this only picks the target).
  try {
    const hs = mainHeld(), hn = hs && hs.id ? stackName(hs) : null;
    if (hn) { m.wx = p.x; m.wy = p.y + 1; m.wz = p.z; m.retarget = 0.5; }
  } catch (e) {}
  // fetch: with a held item, drift to the nearest matching dropped item and
  // bring it to the player (vanilla allay delivery, simplified).
  try {
    if (!m.heldName) return;
    if (!m.fetchT || Date.now() > m.fetchT) {
      m.fetchT = Date.now() + 500;
      let best = null, bd = 32 * 32;
      SV.items.forEach((it) => {
        if (!it || !it.e || !it.e.item) return;
        if (p4ItemName(it.e.item.id) !== m.heldName) return;
        const dx = it.e.x - m.x, dy = it.e.y - m.y, dz = it.e.z - m.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bd) { bd = d2; best = it; }
      });
      if (best && best.e) { m.wx = best.e.x; m.wy = best.e.y + 0.6; m.wz = best.e.z; m.retarget = 0.5; m.fetchId = best.id; }
      else if ((m.fetchId == null || !SV.items.has(m.fetchId)) && bd === 32 * 32) {
        // nothing to fetch: stay near the player
        m.wx = p.x; m.wy = p.y + 1; m.wz = p.z; m.retarget = 0.5;
      }
    }
    // pickup on contact, deliver at the player's feet
    if (m.fetchId != null) {
      const it = SV.items.get(m.fetchId);
      if (!it || !it.e) m.fetchId = null;
      else {
        const dx = it.e.x - m.x, dz = it.e.z - m.z;
        if (dx * dx + dz * dz < 2.25 && Math.abs(it.e.y - m.y) < 2) {
          try { removeItem(m.fetchId); } catch (e) {}
          m.fetchId = null;
          try {
            const iid = itemIdByName(m.heldName);
            if (iid != null) spawnItemEntity(p.x, p.y + 0.5, p.z, iid, 1);
            sfx("entity.allay.item_thrown");
          } catch (e2) {}
        }
      }
    }
  } catch (e) {}
}

function snifferTick(m, dt) {
  // sniff cycle (vanilla ~2 min between sniffs): head-down sniff 4s, then dig
  // up torchflower seeds where standing. Babies never sniff (vanilla).
  try {
    if (m.baby) return;
    if (!m.ground || m.inWater) return;
    const now = Date.now();
    if (!m.sniffUntil && (m.sniffAt || 0) <= now) {
      m.sniffUntil = now + 4000;
      m.snifferState = "sniffing";
      try { if (m.e) m.e.snifferState = "sniffing"; } catch (e) {}
      try { sfx("entity.sniffer.sniffing"); } catch (e2) {}
      return;
    }
    if (m.sniffUntil && now >= m.sniffUntil) {
      m.sniffUntil = 0;
      m.sniffAt = now + 60000 + Math.random() * 60000;
      m.snifferState = "digging";
      try { if (m.e) m.e.snifferState = "digging"; } catch (e2) {}
      try { sfx("entity.sniffer.digging"); } catch (e3) {}
      try { game().particles.happy_villager(m.x, m.y + 1, m.z); } catch (e4) {}
      try {
        const sid = itemIdByName("torchflower_seeds");
        if (sid != null) spawnItemEntity(m.x, m.y + 1, m.z, sid, 1);
      } catch (e5) {}
      setTimeout(() => {
        try { if (m && m.snifferState === "digging") { m.snifferState = "idle"; if (m.e) m.e.snifferState = "idle"; } } catch (e6) {}
      }, 1500);
    }
  } catch (e) {}
}

function wardenTick(m, dt, dist) {
  const g = game(), p = g.player;
  if (!p) return false; // true = suppress normal movement (sonic boom wind-up)
  try {
    // anger: rises while a target is near, decays in the quiet (vanilla
    // 0-150 scale approximated 0-100 here; hostile at any anger).
    const heard = dist < 24 && Math.abs(p.y - m.y) < 12;
    if (heard) {
      const moving = (p.motionX && Math.abs(p.motionX) > 0.05) || (p.motionZ && Math.abs(p.motionZ) > 0.05);
      m.angerLevel = Math.min(100, (m.angerLevel | 0) + dt * (moving || dist < 8 ? 18 : 6));
      m.lastHeard = Date.now();
    } else {
      m.angerLevel = Math.max(0, (m.angerLevel | 0) - dt * 4);
    }
    try { if (m.e) m.e.angerLevel = m.angerLevel | 0; } catch (e) {}
    // sonic boom: 4-20m line of sight, 15s cooldown (vanilla 10 dmg, ignores
    // armor; knockback + particles here).
    if (dist > 4 && dist < 20 && (m.boomCd || 0) <= Date.now() && (m.angerLevel | 0) >= 40) {
      m.boomCd = Date.now() + 15000;
      m.boomUntil = Date.now() + 1200;
      try { if (m.e) m.e.sonicBoomStart = m.e.ticks | 0; } catch (e2) {}
      try { faceMove(m, p.x, p.z); } catch (e3) {}
    }
    if (m.boomUntil && Date.now() < m.boomUntil) {
      // wind-up: hold still while the boom charges (vanilla ~1.2s)
      if (Date.now() >= m.boomUntil - 400 && !m.boomFired) {
        m.boomFired = true;
        try {
          game().particles.nativeParticle("sonic_boom", p.x, p.y + 1, p.z);
        } catch (e4) {}
        try { sfx("entity.warden.sonic_boom"); } catch (e5) {}
        try {
          damagePlayer(10, "mob", { killer: "Warden", bypassArmor: true });
          p.motionX += ((p.x - m.x) / (dist || 1)) * 1.2;
          p.motionZ += ((p.z - m.z) / (dist || 1)) * 1.2;
          p.motionY += 0.6;
        } catch (e6) {}
      }
      if (Date.now() >= m.boomUntil) { m.boomUntil = 0; m.boomFired = false; }
      return true;
    }
    m.boomFired = false;
    // calm despawn: a minute with nothing to hear and it burrows away
    // (vanilla digs out; we poof + sfx since there is no dig-in animation).
    if (Date.now() - (m.lastHeard || Date.now()) > 60000 && dist > 32) {
      try { game().particles.poof(m.x, m.y + 1, m.z); } catch (e7) {}
      try { sfx("entity.warden.dig"); } catch (e8) {}
      try { removeMob(m.id); } catch (e9) {}
      return true;
    }
  } catch (e) {}
  return false;
}

function mobTick(m, dt) {
  const g = game(), p = g.player, e = m.e;
  if (!e || !p) return;
  const def = m.def;
  const dx = p.x - m.x, dz = p.z - m.z;
  const dist2 = dx * dx + dz * dz;
  const dist = Math.sqrt(dist2);
  if (m.village) {
    // frozen outside streamed range: the engine reports phantom-solid
    // collisions for unloaded columns, which would ratchet resting mobs
    // into the sky (normal mobs despawn out here instead — see B1 notes).
    if (dist2 > 9216) return;
    // flung or exiled residents come home (bounds every failure mode).
    const lhx = m.x - m.village.x, lhz = m.z - m.village.z;
    if (lhx * lhx + lhz * lhz > 2304 && leashHome(m)) return;
  }
  if (m.monument) {
    // seeded elders: same phantom-solid freeze as villagers outside streamed
    // range; drifted elders steer home (48m) via the wander target, which the
    // hostile branch overrides while a victim is near (they defend).
    if (dist2 > 9216) return;
    const mhx = m.x - m.monument.x, mhz = m.z - m.monument.z;
    if (mhx * mhx + mhz * mhz > 2304) {
      m.wx = m.monument.x; m.wz = m.monument.z;
      m.wy = m.monument.fy + 3; m.retarget = 0;
    }
  }
  // invisible players are sensed at ~30% range (mobs that already aggroed keep it)
  const visRange = def.range * ((def.hostile && !m.angry && hasFx("invisibility")) ? 0.3 : 1);
  // sheep regrow wool by grazing: ~45s on grass (vanilla eats grass blocks;
  // we regrow on grass without terrain damage — no griefing offline)
  if (m.species === "sheep" && m.sheared) {
    try {
      if (blockNameAt(m.x, m.y - 0.5, m.z) === "grass_block") {
        m.regrow = (m.regrow || 0) + dt;
        if (m.regrow > 45) { m.sheared = false; m.regrow = 0; try { m.e.sheared = false; } catch (e2) {} }
      }
    } catch (e) {}
  }
  // babies grow up (20 min; fed food takes 10% off, see handleMobUse).
  // The engine visual is rebuilt at full size on skin reloads, so re-assert.
  if (m.baby) {
    m.growT = (m.growT == null ? GROW_T : m.growT) - dt;
    try {
      if (!m.scaledVis) setBabyScale(m, true);
      else if ((m.tickN = ((m.tickN | 0) + 1)) % 50 === 0) setBabyScale(m, true);
    } catch (e) {}
    if (m.growT <= 0) growUp(m);
  }
  // axolotl playing dead expires (set when hurt — see damageMob); brief
  // regen while flopped (vanilla regenerates during play-dead)
  if (m.playUntil) {
    if (Date.now() > m.playUntil) { m.playUntil = 0; try { m.e.playingDead = false; } catch (err) {} }
    else {
      m.playAcc = (m.playAcc || 0) + dt;
      if (m.playAcc >= 2) { m.playAcc = 0; try { m.hp = Math.min(m.maxHp, m.hp + 1); } catch (err) {} }
    }
  }
  // love mode expires; partners heart-pulse while waiting (vanilla shows
  // hearts above animals in love)
  if (m.loveUntil) {
    if (Date.now() > m.loveUntil) m.loveUntil = 0;
    else {
      m.heartAcc = (m.heartAcc || 0) + dt;
      if (m.heartAcc >= 1) {
        m.heartAcc = 0;
        try { game().particles.heart(m.x, m.y + 1.5, m.z); } catch (e) {}
      }
    }
  }
  // daylight burn (vanilla: rain shelters the undead)
  if (def.burns && !isNight() && !isRainingAt(m.x, m.y + m.h, m.z)) {
    try {
      if (skyAt(m.x, m.y + m.h, m.z) >= 15 && liquidAt(m.x, m.y + 0.2, m.z) !== "water") {
        m.hp -= dt * 1.5;
        if (m.hp <= 0) { mobDie(m, null); return; }
      }
    } catch (err) {}
  }
  const liq = liquidAt(m.x, m.y + 0.2, m.z);
  m.inWater = liq === "water";
  // v1.15.0: elder guardian mining-fatigue aura (vanilla: 50m, MF III for
  // 5 minutes, reapplied ~1/min with the curse sound + ghost particles).
  // addFx is the sim record; game().effects is the engine read (dig speed
  // in interaction.js reads the engine map live — the sim store alone would
  // do nothing). Effect id 4, amplifier 2 = MF III.
  if (m.species === "elder_guardian" && dist < 50 && (g.dimension | 0) === 0) {
    if ((m.auraCd || 0) <= Date.now()) {
      m.auraCd = Date.now() + 60000;
      addFx("mining_fatigue", 3, 6000);
      try {
        game().effects.set(4, { amplifier: 2, duration: 6000, hideParticles: false, ambient: false, showIcon: true, start: game().ticks });
      } catch (e) {}
      try { sfx("entity.elder_guardian.curse"); } catch (e2) {}
      try { game().particles.nativeParticle("elder_guardian", p.x, p.y + 1, p.z); } catch (e3) {}
    }
  }
  // v1.16.0: the dragon is kinematic (it phases through the island like
  // vanilla) — its own tick sets position directly, then publishes through
  // the engine interpolator like every other mob (see driveMobEnt).
  if (def.dragon) {
    dragonTick(m, dt);
    m.hurtCd -= dt;
    m.age = (m.age || 0) + dt;
    try { driveMobEnt(m, dt); } catch (err) {}
    return;
  }
  let wantX = 0, wantZ = 0, wantJump = false;
  // P4 1.19 per-species ticks (timers/senses; movement branches below stay).
  try {
    if (m.species === "frog") frogTick(m, dt);
    else if (m.species === "allay") allayTick(m, dt);
    else if (m.species === "sniffer") snifferTick(m, dt);
  } catch (eP4) {}
  if (def.camel && (SV.rideCamel | 0) === m.id) {
    // ridden camel: steer from live input (horse idiom); Space = dash.
    try {
      if (p.sneaking) { try { dismountCamel(); } catch (eD) {} }
      else {
        let fw = 0, st = 0, jump = false;
        try {
          const inp = g.input;
          if (inp && inp.down) {
            if (inp.down.has("KeyW")) fw += 1;
            if (inp.down.has("KeyS")) fw -= 1;
            if (inp.down.has("KeyD")) st += 1;
            if (inp.down.has("KeyA")) st -= 1;
            if (inp.down.has("Space")) jump = true;
          }
        } catch (eI) {}
        if (fw || st) {
          let sp = 7; // vanilla camel sprint ~7 m/s
          if (m.dashUntil && Date.now() < m.dashUntil) sp = 11;
          const yaw = (p.yaw || 0) * Math.PI / 180;
          const sy = Math.sin(yaw), cy = Math.cos(yaw);
          const ddx = -sy * fw - cy * st, ddz = cy * fw - sy * st;
          const l = Math.hypot(ddx, ddz) || 1;
          wantX = (ddx / l) * sp; wantZ = (ddz / l) * sp;
          try { faceMove(m, m.x + ddx, m.z + ddz); } catch (eF) {}
        }
        if (jump && m.ground && (m.dashCd || 0) <= Date.now()) {
          m.dashCd = Date.now() + 8000;
          m.dashUntil = Date.now() + 1200;
          m.dashing = true;
          try { m.vy = 8; } catch (eJ) {}
          try { sfx("entity.camel.dash"); } catch (eS) {}
          setTimeout(() => { try { if (m) m.dashing = false; } catch (eT) {} }, 1200);
        }
      }
    } catch (eC) {}
  } else if (m.species === "warden" && wardenTick(m, dt, dist)) {
    // sonic-boom wind-up holds still; despawned mobs stop here too.
    wantX = 0; wantZ = 0;
  } else if (def.creeper) {
    // vanilla: creepers would rather be anywhere else than near a cat
    const cat = nearestTameOcelot(m.x, m.z, 6);
    if (cat) {
      const cx = m.x - cat.x, cz = m.z - cat.z, cd = Math.sqrt(cx * cx + cz * cz) || 1;
      wantX = (cx / cd) * def.speed * 1.2; wantZ = (cz / cd) * def.speed * 1.2;
      faceMove(m, m.x + cx, m.z + cz);
    } else if (dist < 3.2 && Math.abs(p.y - m.y) < 3) {
      if (m.fuse < 0) {
        m.fuse = def.fuse || 1.5;
        try { g.sound.play("entity.creeper.primed"); } catch (err) {}
      }
    }
    // vanilla: once ignited the fuse burns out (no defuse)
    if (m.fuse >= 0) {
      m.fuse -= dt;
      wantX = 0; wantZ = 0;
      faceMove(m, p.x, p.z);
      if (m.fuse < 0) { explode(m); return; }
    } else if (dist < visRange && dist > 1.6) {
      wantX = (dx / (dist || 1)) * def.speed; wantZ = (dz / (dist || 1)) * def.speed;
      faceMove(m, p.x, p.z);
    }
  } else if (def.stare) {
    // enderman: neutral until stared at (64m, crosshair on head) or provoked
    if (!m.angry) {
      try {
        const dxh = m.x - p.x, dyh = (m.y + 2.5) - (p.y + 1.62), dzh = m.z - p.z;
        const dh = Math.sqrt(dxh * dxh + dyh * dyh + dzh * dzh);
        if (dh < 64) {
          // engine yaw/pitch are degrees; 0.09 rad ~= 5 deg stare cone
          const yaw = Math.atan2(-dxh, dzh) * 180 / Math.PI;
          let dyaw = Math.abs(yaw - p.yaw) % 360;
          if (dyaw > 180) dyaw = 360 - dyaw;
          const pitch = Math.atan2(dyh, Math.sqrt(dxh * dxh + dzh * dzh)) * 180 / Math.PI;
          if (dyaw < 5 && Math.abs(pitch - p.pitch) < 5) m.angry = true;
        }
      } catch (e) {}
    }
    if (m.angry && dist < def.range) {
      faceMove(m, p.x, p.z);
      if (dist > 2.2) {
        wantX = (dx / (dist || 1)) * def.speed; wantZ = (dz / (dist || 1)) * def.speed;
      } else {
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.0;
          mobAnimSwing(m);
          damagePlayer(mobMeleeDmg(def), "mob", { killer: "Enderman" });
          // vanilla knockback velocity (~0.4 horiz + 0.4 up; engine motion
          // units match: 0.42 = full jump). Measured: 0.35 -> ~3.2 blocks.
          try {
            p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4;
          } catch (err) {}
        }
      }
    } else {
      // wander while calm
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 3 + Math.random() * 4;
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2;
          m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
        } else { m.wx = m.x; m.wz = m.z; }
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.phantom) {
    // phantom: circles high, swoops to bite. Spawns are gated by the
    // no-sleep clock in directorTick; daylight burns them (def.burns).
    const ty = p.y + 16;
    if (dist > 3 || Math.abs(m.y - ty) > 4) {
      const dxn = (p.x - m.x), dzn = (p.z - m.z), dh = Math.sqrt(dxn * dxn + dzn * dzn) || 1;
      wantX = (dxn / dh) * def.speed; wantZ = (dzn / dh) * def.speed;
      m.vy += clamp((ty - m.y) * 0.8, -6, 2) * dt * 4;
      faceMove(m, p.x, p.z);
    } else {
      // swoop connects: bite, then climb back up
      m.atkCd -= dt;
      if (m.atkCd <= 0) {
        m.atkCd = 1.0;
        mobAnimSwing(m);
        damagePlayer(mobMeleeDmg(def), "mob", { killer: "Phantom" });
        try { p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4; } catch (err) {}
      }
      m.vy = Math.max(m.vy, 6);
      faceMove(m, p.x, p.z);
    }
  } else if (def.witch) {
    // witch: keeps her distance, drinks healing when hurt, throws poison /
    // harming on a 3 s cycle. Slowness/weakness potions are N/A (engine moves
    // the player), so the cycle is poison -> harming -> poison ...
    if (m.hp < (m.maxHp || m.def.hp) && (m.drinkCd || 0) <= 0) {
      // vanilla witches sip healing when hurt: instant +6 here (no mob-side
      // status system), then a cooldown so she can't out-drink focus fire
      m.drinkCd = 30;
      damageMobHeal(m, 6);
      m.drinkAnim = 1.0; // v1.12: nose-wiggle drink tell
      sfx("entity.witch.drink");
    }
    if ((m.drinkCd || 0) > 0) m.drinkCd -= dt;
    if (dist < visRange) {
      faceMove(m, p.x, p.z);
      if (dist < 3) { wantX = (-dx / (dist || 1)) * def.speed * 0.6; wantZ = (-dz / (dist || 1)) * def.speed * 0.6; }
      else if (dist > 9) { wantX = (dx / (dist || 1)) * def.speed; wantZ = (dz / (dist || 1)) * def.speed; }
      m.atkCd -= dt;
      if (m.atkCd <= 0 && dist < visRange) {
        m.atkCd = 3.0;
        shootWitch(m, p);
      }
    } else {
      // wander while the player is far
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 2 + Math.random() * 3;
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 6; m.wz = m.z + Math.sin(a) * 6;
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.snowman) {
    // snow golem: stands its snow, lobs snowballs at the nearest hostile
    const foe = nearestHostile(m.x, m.z, def.range);
    if (foe) {
      faceMove(m, foe.x, foe.z);
      wantX = 0; wantZ = 0;
      m.atkCd -= dt;
      if (m.atkCd <= 0) {
        m.atkCd = 1.5;
        snowmanThrow(m, foe);
      }
    } else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 3 + Math.random() * 4;
        if (Math.random() < 0.5) { const a = Math.random() * Math.PI * 2; m.wx = m.x + Math.cos(a) * 4; m.wz = m.z + Math.sin(a) * 4; }
        else { m.wx = m.x; m.wz = m.z; }
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.6) { wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.defender) {
    // iron golem: hunts hostile mobs near it; turns on the player only when
    // the player hurts it (lastPlayerHit). Slow but devastating + launch.
    let foe = null;
    if (m.lastPlayerHit && Date.now() - m.lastPlayerHit < 10000) foe = { x: p.x, z: p.z, isPlayer: true };
    else foe = nearestHostile(m.x, m.z, 10);
    if (foe) {
      const fx = foe.x - m.x, fz = foe.z - m.z;
      const fd = Math.sqrt(fx * fx + fz * fz) || 1;
      faceMove(m, foe.x, foe.z);
      if (fd > 2.4) { wantX = (fx / fd) * def.speed; wantZ = (fz / fd) * def.speed; }
      else {
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.2;
          if (foe.isPlayer) {
            mobAnimSwing(m);
            damagePlayer(mobMeleeDmg(def), "mob", { killer: "Iron Golem" });
            try { p.motionX += (fx / fd) * 1.2; p.motionZ += (fz / fd) * 1.2; p.motionY += 1.2; } catch (err) {}
          } else if (SV.mobs.get(foe.id)) {
            damageMob(foe.id, mobMeleeDmg(def) + 4, fx, fz, { byPlayer: false });
            try { const v = SV.mobs.get(foe.id); if (v) v.vy = Math.max(v.vy, 12); } catch (err) {}
            mobAnimSwing(m);
          }
        }
      }
    } else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 4 + Math.random() * 4;
        if (Math.random() < 0.5) {
          const a = Math.random() * Math.PI * 2;
          let tx = m.x + Math.cos(a) * 6, tz = m.z + Math.sin(a) * 6;
          if (m.village) {
            const hx = m.village.x, hz = m.village.z;
            const ox = tx - hx, oz = tz - hz, od = Math.sqrt(ox * ox + oz * oz) || 1;
            if (od > 20) { tx = hx + ox / od * 20; tz = hz + oz / od * 20; }
          }
          m.wx = tx; m.wz = tz;
        }
        else { m.wx = m.x; m.wz = m.z; }
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.wither) {
    // wither boss: hovers ~5 above the player, drifts in, lobs a wither
    // skull every 2.5 s + heavy contact damage when crowded (vanilla's
    // strafe/regen phases are out of scope — see the header)
    const ty = p.y + 5;
    if (dist > 3 || Math.abs(m.y - ty) > 2) {
      const dh = Math.sqrt(dx * dx + dz * dz) || 1;
      wantX = (dx / dh) * def.speed; wantZ = (dz / dh) * def.speed;
      m.vy += clamp((ty - m.y) * 0.8, -6, 2) * dt * 4;
      faceMove(m, p.x, p.z);
    } else {
      wantX = 0; wantZ = 0;
      faceMove(m, p.x, p.z);
    }
    m.atkCd -= dt;
    if (m.atkCd <= 0 && dist < def.range) {
      if (dist < 3) {
        m.atkCd = 1.0;
        mobAnimSwing(m);
        damagePlayer(mobMeleeDmg(def), "mob", { killer: "Wither" });
        try { p.motionX += (dx / (dist || 1)) * 0.6; p.motionZ += (dz / (dist || 1)) * 0.6; p.motionY += 0.6; } catch (err) {}
      } else {
        m.atkCd = 2.5;
        shootWitherSkull(m, p);
      }
    }
  } else if (def.hop) {
    // slime / magma cube / rabbit: move in jumps; slimes damage on contact.
    // rabbits are passive (flee), slimes always hunt in range.
    const hunting = def.hostile && dist < visRange;
    let hx = 0, hz = 0;
    if (hunting) { const d = dist || 1; hx = dx / d; hz = dz / d; faceMove(m, p.x, p.z); }
    else if (m.flee && Date.now() - m.flee < 3000 && dist < 8 && dist > 0.01) {
      hx = -dx / dist; hz = -dz / dist; faceMove(m, m.x - dx, m.z - dz);
    } else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 1 + Math.random() * 2;
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 6; m.wz = m.z + Math.sin(a) * 6;
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { hx = wx / wd; hz = wz / wd; faceMove(m, m.wx, m.wz); }
    }
    if (m.ground) {
      m.hopCd = (m.hopCd || 0) - dt;
      if (m.hopCd <= 0 && (hx || hz)) {
        m.hopCd = 0.5 + Math.random() * 0.8;
        m.vx = hx * def.speed * 2.2; m.vz = hz * def.speed * 2.2;
        m.vy = 7;
      }
    }
    if (def.hostile && dist < 1.4) {
      m.atkCd -= dt;
      if (m.atkCd <= 0) {
        m.atkCd = 1.0;
        mobAnimSwing(m);
        let dmg = mobMeleeDmg(def);
        if (m.species === "slime") dmg = (m.size | 0) > 2 ? dmg : (m.size | 0) > 1 ? Math.max(1, Math.round(dmg / 2)) : 0;
        if (dmg > 0) {
          damagePlayer(dmg, "mob", { killer: "Slime" });
          try { p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4; } catch (err) {}
        }
      }
    }
  } else if (def.bee) {
    // --- bees (v1.10): forage/nectar/pollinate loop, night/rain shelter in
    //     the home hive, one poison sting then death within a minute.
    //     Inside-hive bees are abstract counts on the hive record — only
    //     outsiders simulate here. Peaceful bees never anger (passive).
    const beeAngry = difficulty() !== 0 && dist < visRange &&
      Date.now() - (m.provokedAt || 0) < BEE_CALM_MS;
    try {
      m.e.angry = beeAngry;
      m.e.hasNectar = !!m.hasNectar;
      m.e.hasStung = !!m.hasStung;
    } catch (e) {}
    if (m.hasStung) {
      // spent stinger: death within about a minute (vanilla)
      m.stingT = (m.stingT == null ? 60 : m.stingT) - dt;
      if (m.stingT <= 0) { mobDie(m, false); return; }
    }
    if (beeAngry && !m.hasStung) {
      // sting run: fast chase, poison sting on contact. A blocked sting
      // keeps coming back every second (vanilla).
      faceMove(m, p.x, p.z);
      m.vy += clamp((p.y + 1 - m.y) * 2, -3, 3);
      if (dist > 1.7) {
        wantX = (dx / (dist || 1)) * def.speed * 1.6;
        wantZ = (dz / (dist || 1)) * def.speed * 1.6;
      } else {
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.0;
          mobAnimSwing(m);
          damagePlayer(mobMeleeDmg(def), "mob", { killer: "Bee" });
          addFx("poison", 1, difficulty() >= 3 ? 360 : 200); // I 0:10 (E/N), 0:18 (H)
          m.hasStung = true; m.stingT = 60;
          try { m.e.hasStung = true; } catch (e) {}
        }
      }
    } else {
      // calm foraging / homing (spent bees just drift while the timer runs)
      let home = null;
      try {
        if (m.homeHive) {
          const h0 = hiveAtKey(m.homeHive);
          if (h0 && hiveKindOf(game().world.getState(h0.x, h0.y, h0.z))) home = h0;
          else m.homeHive = null;
        }
      } catch (e) { home = null; }
      let shelter = false;
      try { shelter = (game().dimension | 0) === 0 && (isNight() || isRainingAt(m.x, m.y, m.z)); } catch (e) {}
      // pollinate en route (nectar trips only, 10 blooms max per trip):
      // a growable crop 1-2 below advances exactly one stage
      if (!m.hasStung && m.hasNectar && (m.pollens | 0) < 10) {
        try {
          const c = cropBelowBee(m);
          if (c) {
            game().world.setState(c.x, c.y, c.z, (c.state | 0) + 1);
            m.pollens = (m.pollens | 0) + 1;
            try { game().particles.happy_villager(c.x + 0.5, c.y + 1.2, c.z + 0.5); } catch (e) {}
          }
        } catch (e) {}
      }
      // fill the nectar sac circling one bloom (~20s on it)
      let onFlower = false;
      if (!m.hasStung && !m.hasNectar) {
        try { onFlower = !!flowerAt(m.x, m.y, m.z); } catch (e) {}
        if (onFlower) {
          m.flowerT = (m.flowerT || 0) + dt;
          wantX = 0; wantZ = 0;
          m.vy += clamp(0 - m.vy, -1, 1); // hold the hover (no gravity on flyers)
          faceMove(m, m.x + 1, m.z);
          if (m.flowerT >= BEE_NECTAR_T) {
            m.hasNectar = true; m.pollens = 0; m.flowerT = 0;
            try { m.e.hasNectar = true; } catch (e) {}
          }
        } else m.flowerT = 0;
      }
      // steering: shelter or a full sac ferries home (enters on arrival);
      // everyone else drifts like the untamed flyers
      const ferry = !!home && (shelter || !!m.hasNectar);
      let arrived = false;
      if (ferry) {
        const vx = (home.x + 0.5) - m.x, vy = (home.y + 0.5) - m.y, vz = (home.z + 0.5) - m.z;
        const vd = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (vd < 1.6) {
          if (enterHive(home, m)) return;
          arrived = true; // full hive: mill around the mouth (vanilla)
        } else {
          wantX = (vx / vd) * def.speed; wantZ = (vz / vd) * def.speed;
          m.vy += clamp((vy / vd) * def.speed - m.vy, -1, 1);
          faceMove(m, home.x + 0.5, home.z + 0.5);
        }
      }
      if (!ferry || arrived) {
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 2 + Math.random() * 3;
          if (!m.hasNectar && !m.hasStung) {
            // nectar-seekers fly to the nearest bloom in 12 (vanilla);
            // nothing in range: drift at flower height (feet..-2 column)
            let f = null;
            try { f = nearestFlower(m.x, m.y, m.z, 12); } catch (e) {}
            if (f) { m.wx = f.x + 0.5; m.wy = f.y + 1; m.wz = f.z + 0.5; }
            else {
              const a = Math.random() * Math.PI * 2;
              m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
              m.wy = m.y + (Math.random() * 6 - 3);
              try { const gy = groundAt(m.x, m.z, m.y); if (gy != null) m.wy = gy + 1.5; } catch (e) {}
            }
          } else {
            const a = Math.random() * Math.PI * 2;
            m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
            m.wy = m.y + (Math.random() * 6 - 3);
          }
        }
        const wx = m.wx - m.x, wy = (m.wy == null ? m.y : m.wy) - m.y, wz = m.wz - m.z;
        const wd = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (wd > 1 && !onFlower) {
          wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed;
          m.vy += clamp((wy / wd) * def.speed - m.vy, -1, 1);
          faceMove(m, m.wx, m.wz);
        }
      }
    }
  } else if (def.fly && !m.tame && !def.illager) {
    // bat / parrot: drift through the air, no gravity, no player interest
    // (tamed parrots skip this branch and follow via the tame branch below;
    // vexes are flyers too but hunt via the illager branch below)
    if (m.inWater) { /* sinking water: the integrate step takes it down */ }
    else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 2 + Math.random() * 3;
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
        m.wy = m.y + (Math.random() * 6 - 3);
      }
      const wx = m.wx - m.x, wy = (m.wy == null ? m.y : m.wy) - m.y, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (wd > 1) {
        wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed;
        m.vy += clamp((wy / wd) * def.speed - m.vy, -1, 1);
        faceMove(m, m.wx, m.wz);
      }
    }
  } else if (def.swim && !m.tame) {
    // squid / dolphin / turtle: graceful in water, helpless out of it.
    // (no tameable species swims; the guard is for future-proofing)
    // v1.15.0: guardian/elder_guardian/drowned are hostile swimmers — they
    // chase and bite in 3D (vy steers toward the victim's depth). No beam
    // attack is simulated; the bite carries the difficulty-scaled melee.
    if (m.inWater) {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 2 + Math.random() * 3;
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
        m.wy = m.y + (Math.random() * 4 - 2);
      }
      if (def.hostile && dist < visRange) {
        // hunt: steer at the victim's position AND depth
        faceMove(m, p.x, p.z);
        try { if (m.e) m.e.guardianMoving = true; } catch (e) {}
        const dyh = (p.y + 1) - m.y;
        const d3 = Math.sqrt(dist2 + dyh * dyh) || 1;
        if (m.species === "drowned" && dist > 2.5 && dist < 24 && difficulty() !== 0) {
          // drowned trident throw (vanilla): mid-range swimmers hold station
          // and hurl tridents instead of closing to bite.
          wantX = 0; wantZ = 0;
          m.vy += clamp((dyh / d3) * def.speed * 0.3 - m.vy, -1, 1);
          m.atkCd -= dt;
          if (m.atkCd <= 0) {
            m.atkCd = 2.5 + Math.random() * 2;
            try { shootDrowned(m, p); } catch (e) {}
          }
        } else if (dist > 1.9) {
          wantX = (dx / d3) * def.speed; wantZ = (dz / d3) * def.speed;
          m.vy += clamp((dyh / d3) * def.speed - m.vy, -1, 1);
        } else {
          wantX = 0; wantZ = 0;
          m.atkCd -= dt;
          if (m.atkCd <= 0) {
            m.atkCd = 1.0;
            mobAnimSwing(m);
            damagePlayer(mobMeleeDmg(def), "mob", { killer: mobLabel(m.species) });
            try {
              p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4;
            } catch (err) {}
          }
        }
      } else {
        try { if (m.e) m.e.guardianMoving = false; } catch (e) {}
        const wx = m.wx - m.x, wy = (m.wy == null ? m.y : m.wy) - m.y, wz = m.wz - m.z;
        const wd = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (wd > 1) {
          wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed;
          m.vy += clamp((wy / wd) * def.speed - m.vy, -1, 1);
          faceMove(m, m.wx, m.wz);
        }
      }
      if (m.flee && Date.now() - m.flee < 3000) {
        // ink-jet away: vanilla squid squirt (burst of speed + ink cloud)
        if (dist < 6 && dist > 0.01) { wantX = (-dx / (dist || 1)) * def.speed * 2; wantZ = (-dz / (dist || 1)) * def.speed * 2; }
        if ((m.species === "squid" || m.species === "glow_squid") && !m.inked) {
          m.inked = true;
          try { game().particles.nativeParticle(m.species === "glow_squid" ? "glow_squid_ink" : "squid_ink", m.x, m.y + 0.5, m.z); } catch (e) {}
          try { sfx(m.species === "glow_squid" ? "entity.glow_squid.squirt" : "entity.squid.squirt"); } catch (e2) {}
          if (m.species === "glow_squid") { try { m.e.darkTicks = 10; } catch (e3) {} }
        }
      }
      if (!m.flee || Date.now() - m.flee >= 3000) m.inked = false;
    } else if (m.species === "squid" || m.species === "dolphin" || m.species === "glow_squid" || m.species === "guardian" || m.species === "elder_guardian" || m.species === "tadpole") {
      // vanilla: fish out of water suffocate (guardians flop and die too)
      m.hp -= dt * 2;
      if (m.hp <= 0) { mobDie(m, false); return; }
    } else if (m.species === "drowned") {
      // vanilla drowned walk on land like zombies (and never burn)
      if (dist < visRange) {
        faceMove(m, p.x, p.z);
        if (dist > 1.9) {
          wantX = (dx / (dist || 1)) * def.speed; wantZ = (dz / (dist || 1)) * def.speed;
        } else {
          wantX = 0; wantZ = 0;
          m.atkCd -= dt;
          if (m.atkCd <= 0) {
            m.atkCd = 1.0;
            mobAnimSwing(m);
            damagePlayer(mobMeleeDmg(def), "mob", { killer: "Drowned" });
            try {
              p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4;
            } catch (err) {}
          }
        }
      } else {
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 3 + Math.random() * 4;
          if (Math.random() < 0.5) { const a = Math.random() * Math.PI * 2; m.wx = m.x + Math.cos(a) * 4; m.wz = m.z + Math.sin(a) * 4; }
          else { m.wx = m.x; m.wz = m.z; }
        }
        const wx = m.wx - m.x, wz = m.wz - m.z;
        const wd = Math.sqrt(wx * wx + wz * wz);
        if (wd > 0.6) { wantX = (wx / wd) * def.speed * 0.5; wantZ = (wz / wd) * def.speed * 0.5; faceMove(m, m.wx, m.wz); }
      }
    } else {
      // turtle beach crawl
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 3 + Math.random() * 4;
        if (Math.random() < 0.5) { const a = Math.random() * Math.PI * 2; m.wx = m.x + Math.cos(a) * 4; m.wz = m.z + Math.sin(a) * 4; }
        else { m.wx = m.x; m.wz = m.z; }
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.6) { wantX = (wx / wd) * def.speed * 0.5; wantZ = (wz / wd) * def.speed * 0.5; faceMove(m, m.wx, m.wz); }
    }
  } else if (m.tame) {
    // pets follow you; tamed wolves also bodyguard (whatever is closest to
    // hurting you, or whatever just hurt them — approximated as the nearest
    // hostile to you, else to them). v1.12: sitting dogs hold their spot.
    let foe = null;
    if (m.sitting) faceMove(m, p.x, p.z);
    else if (m.species === "wolf") {
      foe = nearestHostile(p.x, p.z, 10) || nearestHostile(m.x, m.z, 6);
      // bodyguard, not hunter: only engage near you (or right after pain)
      if (foe && Date.now() - (m.provokedAt || 0) > 10000) {
        const px = foe.x - p.x, pz = foe.z - p.z;
        if (px * px + pz * pz > 100) foe = null;
      }
    }
    if (m.sitting) {
      // hold the sit: face the owner, wants stay 0 (teleport/follow skipped)
    } else if (foe) {
      const fx = foe.x - m.x, fz = foe.z - m.z;
      const fd = Math.sqrt(fx * fx + fz * fz) || 1;
      faceMove(m, foe.x, foe.z);
      if (fd > 1.9) { wantX = (fx / fd) * def.speed * 1.3; wantZ = (fz / fd) * def.speed * 1.3; }
      else {
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.0;
          mobAnimSwing(m);
          damageMob(foe.id, mobMeleeDmg(def), fx, fz, { byPlayer: false });
        }
      }
    } else if (dist > 12 || Math.abs(p.y - m.y) > 8) {
      // vanilla: a pet that falls too far behind teleports to you (this is
      // also our stuck-in-a-hole fix — ground pets have no pathfinding, same
      // as every other mob in this engine)
      m.x = p.x + (Math.random() * 4 - 2); m.z = p.z + (Math.random() * 4 - 2);
      m.y = p.y + 0.5; m.vx = m.vy = m.vz = 0;
      m.wx = m.x; m.wz = m.z; m.retarget = 0;
      faceMove(m, p.x, p.z);
    } else if (dist > 4) {
      wantX = (dx / (dist || 1)) * def.speed * 1.2; wantZ = (dz / (dist || 1)) * def.speed * 1.2;
      faceMove(m, p.x, p.z);
      // tamed flyers (parrots) also track your altitude; ground pets jump gaps
      if (def.fly) m.vy += clamp(((p.y + 1) - m.y) * 1.2, -3, 3);
      else if ((m.leapCd || 0) <= 0 && m.ground && dist > 6) { m.vy = 7.5; m.leapCd = 1; }
      if ((m.leapCd || 0) > 0) m.leapCd -= dt;
    } else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 3 + Math.random() * 4;
        m.wx = p.x + (Math.random() * 6 - 3); m.wz = p.z + (Math.random() * 6 - 3);
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.5; wantZ = (wz / wd) * def.speed * 0.5; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.illager && !calmSpider(m)) {
    // v1.14: illagers hunt players, villagers, traders and golems alike.
    // Johnny vindicators (name tag) turn on almost everything instead.
    const foe = pickVictim(m);
    if (foe) {
      const fx = foe.x - m.x, fz = foe.z - m.z;
      const fd = Math.sqrt(fx * fx + fz * fz) || 1;
      faceMove(m, foe.x, foe.z);
      if (m.species === "pillager") {
        // crossbow strafe at range, butt-stroke up close (vanilla)
        m.aiming = fd > 5 && fd < 18;
        if (fd > 5 && fd < 18) {
          m.retarget -= dt;
          if (m.retarget <= 0) {
            m.retarget = 0.4;
            m.strafe = (m.strafe || 1) * (Math.random() < 0.3 ? -1 : 1);
          }
          const s = m.strafe || 1;
          wantX = (-fz / fd) * def.speed * 0.5 * s;
          wantZ = (fx / fd) * def.speed * 0.5 * s;
          m.atkCd -= dt;
          if (m.atkCd <= 0 && fd < 16) { m.atkCd = 2.2; shootArrowAt(m, foe); }
        } else if (fd >= 18) {
          wantX = (fx / fd) * def.speed; wantZ = (fz / fd) * def.speed;
        } else {
          wantX = 0; wantZ = 0;
          m.atkCd -= dt;
          if (m.atkCd <= 0) { m.atkCd = 1.0; strikeFoe(m, foe, fx, fz, fd); }
        }
      } else if (m.species === "evoker") {
        // stands off and casts: fangs in range, vexes while outnumbered,
        // wololo whenever a blue sheep is near (vanilla party trick)
        if (fd > 12) { wantX = (fx / fd) * def.speed; wantZ = (fz / fd) * def.speed; }
        else if (fd < 6) { wantX = -(fx / fd) * def.speed; wantZ = -(fz / fd) * def.speed; }
        else { wantX = 0; wantZ = 0; }
        m.casting = Date.now() - (m.castAnim || 0) < 1200;
        m.castCd = (m.castCd == null ? 2 : m.castCd) - dt;
        if (m.castCd <= 0) { m.castCd = 3 + Math.random() * 2; evokerCast(m, foe, fd); }
      } else if (m.species === "vex") {
        // 3D swoop at the victim; charging pose on the dive (v1.12 flags)
        const vy = (foe.y != null ? foe.y + 1 : m.y) - m.y;
        const d3 = Math.sqrt(fd * fd + vy * vy) || 1;
        wantX = (fx / d3) * def.speed * 2; wantZ = (fz / d3) * def.speed * 2;
        m.vy += clamp((vy / d3) * def.speed * 2 - m.vy, -2, 2);
        m.swoop = d3 < 8;
        m.atkCd -= dt;
        if (d3 < 2.2 && m.atkCd <= 0) { m.atkCd = 1.0; strikeFoe(m, foe, fx, fz, fd); }
      } else {
        // vindicator + ravager: run in swinging
        if (fd > 2.2) { wantX = (fx / fd) * def.speed; wantZ = (fz / fd) * def.speed; }
        else {
          wantX = 0; wantZ = 0;
          m.atkCd -= dt;
          if (m.atkCd <= 0) { m.atkCd = m.species === "ravager" ? 1.5 : 1.0; strikeFoe(m, foe, fx, fz, fd); }
        }
      }
    } else {
      // no victim: wander (raid members hold near the raid center instead —
      // Phase C stamps m.wx/m.wz and this branch must not fight it)
      if (!(m.raid && m.wx != null)) {
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 2 + Math.random() * 3;
          const a = Math.random() * Math.PI * 2;
          m.wx = m.x + Math.cos(a) * 6; m.wz = m.z + Math.sin(a) * 6;
        }
      }
      const wx = (m.wx == null ? m.x : m.wx) - m.x, wz = (m.wz == null ? m.z : m.wz) - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
 } else if ((def.hostile || (def.neutral && Date.now() - (m.provokedAt || 0) < 10000)) && !calmSpider(m)) {
    if (dist < visRange) {
      faceMove(m, p.x, p.z);
      m.aiming = !!(def.ranged && dist > 5 && dist < 18); // v1.12: bow-aim pose
      if (def.shulker) {
        // v1.16.0: stationary city turret — never moves, opens its shell and
        // lobs guided bullets while the victim is in range (vanilla 16 m)
        wantX = 0; wantZ = 0;
        try { if (m.e) m.e.peekTick = (dist < 16 && difficulty() !== 0) ? 50 : 0; } catch (e) {}
        m.atkCd -= dt;
        if (m.atkCd <= 0 && dist < 16 && dist > 1 && difficulty() !== 0) {
          m.atkCd = 2.5 + Math.random() * 2;
          try { shootShulker(m, p); } catch (e) {}
        }
      } else if (def.blaze && dist > 2.5 && dist < 18) {
        // v1.15.0: blaze hovers at the victim's height and fires a 3-fireball
        // volley (vanilla), then cools down. Close up it falls into melee.
        faceMove(m, p.x, p.z);
        wantX = 0; wantZ = 0;
        m.vy += clamp(((p.y + 1) - m.y) * 1.2, -3, 3) * dt * 4; // wither hover idiom
        if ((m.blazeVolley | 0) > 0) {
          m.blazeT = (m.blazeT || 0) - dt;
          if (m.blazeT <= 0) {
            m.blazeT = 0.3; m.blazeVolley--;
            try { shootBlaze(m, p); } catch (e) {}
            if (m.blazeVolley <= 0) m.atkCd = 3.0;
          }
        } else {
          m.atkCd -= dt;
          if (m.atkCd <= 0 && dist < 16) {
            m.blazeVolley = 3; m.blazeT = 0; // first fires next tick
            m.atkCd = 3.0;
          }
        }
      } else if (def.ranged && dist > 5 && dist < 18) {
        // strafe + shoot
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 0.4;
          m.strafe = (m.strafe || 1) * (Math.random() < 0.3 ? -1 : 1);
        }
        const s = m.strafe || 1;
        wantX = (-dz / (dist || 1)) * def.speed * 0.5 * s;
        wantZ = (dx / (dist || 1)) * def.speed * 0.5 * s;
        m.atkCd -= dt;
        if (m.atkCd <= 0 && dist < 16) {
          m.atkCd = 2.2;
          shootArrow(m, p);
        }
      } else if (def.spit && dist > 2.5 && dist < 16) {
        // trader llama: spits for 1 from range instead of biting (vanilla);
        // closes in only when the target crowds it (falls into melee below)
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.5;
          try { sfx("entity.llama.spit"); } catch (e) {}
          try { game().particles.crit(p.x, p.y + 1, p.z); } catch (e2) {}
          damagePlayer(1, "mob", { killer: "Trader Llama" });
        }
      } else if (dist > 1.9) {
        // spider pounce: leap at nearby prey
        if (def.climb && dist < 4 && m.ground && (m.leapCd || 0) <= 0) {
          m.leapCd = 2.5;
          m.vx = (dx / (dist || 1)) * 4; m.vz = (dz / (dist || 1)) * 4; m.vy = 5.5;
          wantX = 0; wantZ = 0;
        } else {
          wantX = (dx / (dist || 1)) * def.speed; wantZ = (dz / (dist || 1)) * def.speed;
        }
        if ((m.leapCd || 0) > 0) m.leapCd -= dt;
      } else {
        // melee
        wantX = 0; wantZ = 0;
        m.atkCd -= dt;
        if (m.atkCd <= 0) {
          m.atkCd = 1.0;
          mobAnimSwing(m);
          damagePlayer(mobMeleeDmg(def), "mob", { killer: mobLabel(m.species) });
          if (def.hungerHit) addFx("hunger", 1, 140); // husk: Hunger I for 7s
          // v1.15.0: wither skeletons inflict Wither II for 10 s (vanilla).
          // addFx is the sim record; game().effects is the engine read
          // (same dual-write as the elder-guardian aura). Effect id 20,
          // amplifier 1 = Wither II.
          if (m.species === "wither_skeleton") {
            addFx("wither", 2, 200);
            try {
              game().effects.set(20, { amplifier: 1, duration: 200, hideParticles: false, ambient: false, showIcon: true, start: game().ticks });
            } catch (e) {}
          }
          // vanilla knockback velocity (see enderman branch above)
          try {
            p.motionX += (dx / (dist || 1)) * 0.4; p.motionZ += (dz / (dist || 1)) * 0.4; p.motionY += 0.4;
          } catch (err) {}
        }
      }
    } else {
      // wander while no target
      m.aiming = false; // v1.12: bow lowers outside firing range
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 2 + Math.random() * 3;
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 6; m.wz = m.z + Math.sin(a) * 6;
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
  } else if (def.ram && Date.now() - (m.provokedAt || 0) > 10000) {
    // goat: wanders like a passive, but every 10-25s lowers its head and
    // charges (vanilla ram): heavy knockback on contact, then a cooldown.
    // (Provoked goats skip this and retaliate via the hostile branch above.)
    m.retarget -= dt;
    if (m.retarget <= 0) {
      m.retarget = 3 + Math.random() * 4;
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        m.wx = m.x + Math.cos(a) * 8; m.wz = m.z + Math.sin(a) * 8;
      } else { m.wx = m.x; m.wz = m.z; }
    }
    m.ramCd = (m.ramCd == null ? 8 + Math.random() * 8 : m.ramCd) - dt;
    if (!m.ramT && m.ramCd <= 0 && dist < 14 && dist > 2.5 && Math.abs(p.y - m.y) < 4) {
      m.ramT = true; m.ramUntil = Date.now() + 5000;
      try { m.e.goatRamming = true; } catch (e) {}
      try { sfx(m.screaming ? "entity.goat.screaming.prepare_ram" : "entity.goat.prepare_ram"); } catch (e2) {}
    }
    if (m.ramT) {
      if (Date.now() > (m.ramUntil || 0)) {
        m.ramT = false; m.ramCd = 10 + Math.random() * 15;
        try { m.e.goatRamming = false; } catch (e) {}
      } else {
        faceMove(m, p.x, p.z);
        wantX = (dx / (dist || 1)) * def.speed * 2.2; wantZ = (dz / (dist || 1)) * def.speed * 2.2;
        // P4 goat horns: ramming a hard block head-first knocks a horn loose
        // (vanilla behavior — horns come from walls, not from players). Probe
        // the block ahead at head height along the charge line first.
        if (m.blocked && m.ground) {
          const nx = dx / (dist || 1), nz = dz / (dist || 1);
          const ahead = blockNameAt(m.x + nx * 1.2, m.y + 1.0, m.z + nz * 1.2) ||
            blockNameAt(m.x + nx * 1.2, m.y + 0.3, m.z + nz * 1.2);
          const hard = ahead === "stone" || ahead === "deepslate" || ahead === "packed_ice" ||
            ahead === "blue_ice" || ahead.endsWith("_ore") || ahead.endsWith("_log") || ahead.endsWith("_stem");
          if (hard && ahead.indexOf("leaves") < 0) {
            try {
              const hid = itemIdByName("goat_horn");
              if (hid != null) spawnItemEntity(m.x, m.y + 1, m.z, hid, 1);
              sfx(m.screaming ? "entity.goat.screaming.ram_impact" : "entity.goat.ram_impact");
            } catch (herr) {}
            m.ramT = false; m.ramCd = 10 + Math.random() * 15;
            try { m.e.goatRamming = false; } catch (e) {}
          } else m.vy = 9.5; // leaps obstacles mid-charge
        }
        if (dist < 2.1) {
          m.ramT = false; m.ramCd = 10 + Math.random() * 15;
          try { m.e.goatRamming = false; } catch (e) {}
          mobAnimSwing(m);
          damagePlayer(mobMeleeDmg(def) + 1, "mob", { killer: "Goat" });
          try {
            sfx(m.screaming ? "entity.goat.screaming.ram_impact" : "entity.goat.ram_impact");
            p.motionX += (dx / (dist || 1)) * 1.1; p.motionZ += (dz / (dist || 1)) * 1.1; p.motionY += 0.7;
          } catch (err) {}
        }
      }
    }
    if (!m.ramT) {
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.8) { wantX = (wx / wd) * def.speed * 0.4; wantZ = (wz / wd) * def.speed * 0.4; faceMove(m, m.wx, m.wz); }
    }
  } else {
    // passive wander; babies trail the nearest adult of their species
    // (vanilla calves follow), fleeing still overrides
    if (m.species === "villager" && !m.trade && vtCanTrade(m)) {
      // lazy attach for keyless villagers (eggs, pre-B2 seeds); restock
      // rides the same path every tick
      try { vtEnsureTrade(m); } catch (e) {}
    }
    if (m.species === "villager" && m.trade && vtRestockDue(m.trade)) {
      try { vtRestock(m); } catch (e) {}
    }
    if (m.species === "villager" && m.tradeOpen && SV.openTrade && SV.openTrade.vid === m.id) {
      // trading: face the customer, hold still (pathfinding pauses)
      try { faceMove(m, p.x, p.z); } catch (e) {}
    } else if (m.flee && Date.now() - m.flee < 3000) {
      if (dist < 8 && dist > 0.01) {
        wantX = (-dx / (dist || 1)) * def.speed * 1.6; wantZ = (-dz / (dist || 1)) * def.speed * 1.6;
        faceMove(m, m.x - dx, m.z - dz);
      }
    } else if (m.baby) {
      const a = nearestAdult(m, 12);
      if (a) {
        const ax = a.x - m.x, az = a.z - m.z;
        const ad = Math.sqrt(ax * ax + az * az) || 1;
        faceMove(m, a.x, a.z);
        if (ad > 3) { wantX = (ax / ad) * def.speed * 1.2; wantZ = (az / ad) * def.speed * 1.2; }
      } else {
        m.retarget -= dt;
        if (m.retarget <= 0) {
          m.retarget = 3 + Math.random() * 4;
          if (Math.random() < 0.6) {
            const ra = Math.random() * Math.PI * 2;
            m.wx = m.x + Math.cos(ra) * 5; m.wz = m.z + Math.sin(ra) * 5;
          } else { m.wx = m.x; m.wz = m.z; }
        }
        const wx = m.wx - m.x, wz = m.wz - m.z;
        const wd = Math.sqrt(wx * wx + wz * wz);
        if (wd > 0.6) { wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed; faceMove(m, m.wx, m.wz); }
      }
    } else {
      m.retarget -= dt;
      if (m.retarget <= 0) {
        m.retarget = 3 + Math.random() * 4;
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2;
          let tx = m.x + Math.cos(a) * 5, tz = m.z + Math.sin(a) * 5;
          if (m.village) {
            const hx = m.village.x, hz = m.village.z;
            const ox = tx - hx, oz = tz - hz, od = Math.sqrt(ox * ox + oz * oz) || 1;
            if (od > 12) { tx = hx + ox / od * 12; tz = hz + oz / od * 12; }
          }
          m.wx = tx; m.wz = tz;
        } else { m.wx = m.x; m.wz = m.z; }
      }
      const wx = m.wx - m.x, wz = m.wz - m.z;
      const wd = Math.sqrt(wx * wx + wz * wz);
      if (wd > 0.6) { wantX = (wx / wd) * def.speed; wantZ = (wz / wd) * def.speed; faceMove(m, m.wx, m.wz); }
    }
  }
  // --- leads (v1.14 Phase D): leashed mobs trail their holder; knots hold
  // tight. Runs after every branch so holds survive AI states, before the
  // --- integrate with AABB physics
  if (m.lead) {
    // holder position (player, mob, or knot); holder gone -> unclip + refund
    let hx = null, hy = 0, hz = null, holdR = 3;
    try {
      const L = m.lead;
      if (L.to === "player") { const p0 = game().player; if (p0) { hx = p0.x; hy = p0.y; hz = p0.z; } }
      else if (L.to === "mob") { const h = SV.mobs.get(L.id); if (h && h.hp > 0) { hx = h.x; hy = h.y; hz = h.z; } }
      else if (L.to === "knot") { const k = (SV.knots || []).find((k) => k.key === L.key); if (k) { hx = k.x; hy = k.y; hz = k.z; holdR = 4; } }
    } catch (e) {}
    if (hx == null) {
      try { releaseLead(m, true); } catch (e) { try { m.lead = null; } catch (e2) {} }
    } else {
      const ldx = hx - m.x, ldz = hz - m.z, ld = Math.sqrt(ldx * ldx + ldz * ldz) || 0.001;
      if (ld > 12) {
        try { releaseLead(m, true); } catch (e) { try { m.lead = null; } catch (e2) {} }
      } else if (ld > holdR) {
        wantX = (ldx / ld) * def.speed * 1.2; wantZ = (ldz / ld) * def.speed * 1.2;
        faceMove(m, hx, hz);
      }
    }
  }
  const k = m.inWater ? 0.55 : 1;
  m.vx += clamp(wantX - m.vx, -0.5 * k, 0.5 * k);
  m.vz += clamp(wantZ - m.vz, -0.5 * k, 0.5 * k);
  // spiders climb walls: crawl upward while horizontally blocked
  if (def.climb && m.blocked) m.vy = Math.max(m.vy, 2.5);
  // buoyancy: true flyers (bats/parrots/phantoms) and swimming mobs steer
  // their own vy — gravity must not drag them down (it sank every bat)
  if (def.fly || def.phantom) m.vy = clamp(m.vy, -6, 6);
  else if (m.inWater) m.vy = clamp(m.vy, -3, 3);
  // resting on solid ground with no vertical motion: gravity is already
  // balanced (it would add -2.8 and the sweep would take it back). Skipping
  // keeps displacement ~zero so the physMove resting-contact cache below
  // can reuse the sweep. Exact: support removal bumps world._colGen, which
  // invalidates the cache and the next tick falls normally.
  else if (m.ground && m.vy === 0) {}
  else if (def.glide) m.vy = Math.max(m.vy - GRAV * dt, -2); // chickens float down
  else m.vy = Math.max(m.vy - GRAV * dt, TERMINAL);
  if (!m.ground && (m.peakY == null || m.y > m.peakY)) m.peakY = m.y;
  let res = physMove(m, m.vx * dt, m.vy * dt, m.vz * dt);
  m.blocked = res.hitX || res.hitZ;
  if (!m.ground && res.ground && m.peakY != null) {
    // landed: vanilla floor(fall - 3) for everything but gliders
    const fall = m.peakY - m.y;
    if (!def.glide && fall > 3) {
      let fd = Math.floor(fall - 3);
      if (def.softFall) fd = Math.floor(fd / 2); // goats shrug off half
      if (m.def.armor) fd = armorReduce(fd, m.def.armor, 0);
      m.hp -= Math.round(fd);
      if (m.hp <= 0) { mobDie(m, false); return; }
    }
    try { if (fall > 0.75) trampleAt(m.x, m.y, m.z); } catch (e) {}
    m.peakY = null;
  }
  m.ground = res.ground;
  if ((res.hitX || res.hitZ) && m.ground && !def.climb) {
    if (tryStep(m)) { m.vy = 7.5; }
    else { m.vx *= 0.3; m.vz *= 0.3; }
  }
  if (m.vy < -3 && m.ground) m.vy = 0;
  if (m.ground && m.vy < 0) m.vy = 0;
  // lava: 4 dmg per 0.5s + ignite 15s; burning: 1 dmg/sec (armor ignores)
  const lz = liquidAt(m.x, m.y + 0.2, m.z);
  if (lz === "lava") {
    m.lavaAcc = (m.lavaAcc || 0) + dt;
    if (m.lavaAcc >= 0.5) { m.lavaAcc = 0; m.hp -= 4; }
    m.burnUntil = Date.now() + 15000;
    if (m.hp <= 0) { m.burning = true; mobDie(m, false); return; }
  }
  if (Date.now() < (m.burnUntil || 0)) {
    m.burnAcc = (m.burnAcc || 0) + dt;
    m.burning = true;
    if (m.burnAcc >= 1) {
      m.burnAcc = 0; m.hp -= 1;
      try { game().particles.flame(m.x, m.y + 0.5, m.z); } catch (e) {}
      if (m.hp <= 0) { mobDie(m, false); return; }
    }
  } else m.burning = false;
  // endermen teleport out of water (and take 1 damage)
  if (def.stare && m.inWater && (m.tpCd || 0) <= 0) {
    m.tpCd = 2;
    m.hp -= 1;
    teleportMob(m);
    if (m.hp <= 0) { mobDie(m, false); return; }
  }
  // lit campfires burn mobs standing in them: 1 dmg/sec (vanilla)
  try {
    if (blockNameAt(m.x, m.y + 0.2, m.z) === "campfire") {
      const cst = game().world.getState(Math.floor(m.x), Math.floor(m.y + 0.2), Math.floor(m.z));
      if (stProp(cst, "lit") === "true") {
        m.campAcc = (m.campAcc || 0) + dt;
        if (m.campAcc >= 1) { m.campAcc = 0; m.hp -= 1; if (m.hp <= 0) { mobDie(m, false); return; } }
      } else m.campAcc = 0;
    } else m.campAcc = 0;
  } catch (e) {}
  if ((m.tpCd || 0) > 0) m.tpCd -= dt;
  // chickens lay an egg every 5-10 minutes
  if (m.species === "chicken") {
    m.eggAt = m.eggAt || (Date.now() + (300 + Math.random() * 300) * 1000);
    if (Date.now() > m.eggAt) {
      m.eggAt = Date.now() + (300 + Math.random() * 300) * 1000;
      try {
        const id = itemIdByName("egg");
        if (id != null) spawnItemEntity(m.x, m.y + 0.5, m.z, id, 1);
      } catch (e) {}
    }
  }
  // zombies batter wooden doors on Hard (10s to break)
  if (difficulty() === 3 && (m.species === "zombie" || m.species === "husk")) {
    try {
      let door = null;
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nm = blockNameAt(m.x + ox, m.y + 0.5, m.z + oz);
        if (nm && nm.indexOf("door") >= 0 && nm.indexOf("iron") < 0) { door = [m.x + ox, m.y + 0.5, m.z + oz]; break; }
      }
      if (door) {
        m.doorT = (m.doorT || 0) + dt;
        if (m.doorT >= 10) {
          m.doorT = 0;
          game().world.setState(Math.floor(door[0]), Math.floor(door[1]), Math.floor(door[2]), 0);
          sfx("entity.zombie.break_wooden_door");
        }
      } else m.doorT = 0;
    } catch (e) {}
  }
  m.hurtCd -= dt;
  m.age = (m.age || 0) + dt;
  // endermites wink out after 2 minutes (vanilla, unnamed)
  if (m.species === "endermite" && m.age > 120) { removeMob(m.id, true); return; }
  // v1.12: publish position + visual flags through the engine
  // interpolator (limb swings, textures, poses) — see driveMobEnt
  try { driveMobEnt(m, dt); } catch (err) {}
}

function damageMob(id, amount, kx, kz, o) {
  // o: {crit (falling attack: +50%), byPlayer, byArrow, from ("skeleton" arrow: disc rule),
  //     noDamage (snowball/egg: knockback + provoke, zero HP loss)}
  o = o || {};
  const m = SV.mobs.get(id);
  if (!m || !survives()) return false;
  if (m.hurtCd > 0) return false;
  m.hurtCd = 0.4;
  if (o.noDamage) {
    // vanilla snowball/egg: no HP loss, but knockback, anger, enderman-tp, flee
    provoke(m);
    if (m.def.stare && m.hp > 0 && (m.tpCd || 0) <= 0) { m.tpCd = 1; teleportMob(m); }
    if (kx || kz) {
      const d = Math.sqrt(kx * kx + kz * kz) || 1;
      m.vx += (kx / d) * 4; m.vz += (kz / d) * 4;
      m.vy = Math.max(m.vy, 5);
    }
    if (!m.def.hostile) { m.flee = Date.now(); }
    return true;
  }
  let dmg = amount;
  if (o.crit) {
    dmg = Math.floor(dmg * 1.5);
    try { game().particles.crit({ x: m.x, y: m.y + m.h / 2, z: m.z }); } catch (e) { try { game().particles.crit(m.x, m.y + m.h / 2, m.z); } catch (e2) {} }
  }
  // zombie armor: 2 armor points, no toughness
  if (m.def.armor) dmg = armorReduce(dmg, m.def.armor, 0);
  try { const ga = mobGearArmor(m); if (ga.A > 0) dmg = armorReduce(dmg, ga.A, ga.T); } catch (e) {}
  dmg = Math.max(1, Math.round(dmg));
  m.hp -= dmg;
  m.lastPlayerHit = (o.byPlayer || o.byArrowPlayer) ? Date.now() : (m.lastPlayerHit || 0);
  // skeleton-arrow kill -> music disc. Skeleton arrows arrive as {byArrow, from:"skeleton"}
  // (arrowTick) or {byArrow:{from:"skeleton"}} (test hooks / legacy callers).
  if ((o.byArrow && o.byArrow.from === "skeleton") || (o.byArrow && o.from === "skeleton")) m.lastHitBySkeleton = true;
  provoke(m);
  // trader defense (vanilla): hurting the trader turns his llamas on you
  try {
    if (m.species === "wandering_trader" && m.hp > 0) {
      SV.mobs.forEach((o) => {
        if (o && o.species === "trader_llama" && o.hp > 0 && (o.traderId === m.id || ((m.llamaIds || []).indexOf(o.id) >= 0))) provoke(o);
      });
    }
  } catch (e) {}
  // bees: a survivor (not one-hit) angers every bee in 16 blocks (vanilla).
  // One-hit kills stay quiet.
  if (m.species === "bee" && m.hp > 0) {
    try {
      SV.mobs.forEach((o) => {
        if (!o || o.species !== "bee" || o.hp <= 0) return;
        const dx = o.x - m.x, dz = o.z - m.z;
        if (dx * dx + dz * dz < 256) provoke(o);
      });
    } catch (e) {}
  }
  // axolotls play dead when hurt (vanilla): flop over + regen, ~6s
  if (m.species === "axolotl" && m.hp > 0 && Math.random() < 0.5) {
    m.playUntil = Date.now() + 6000;
    try { m.e.playingDead = true; } catch (e) {}
  }
  // endermen usually teleport away when struck
  if (m.def.stare && m.hp > 0 && (m.tpCd || 0) <= 0) {
    m.tpCd = 1;
    teleportMob(m);
  }
  try {
    m.e.hurtTime = 10;
    game().sound.play("entity." + m.species + ".hurt");
  } catch (err) {}
  if (kx || kz) {
    const d = Math.sqrt(kx * kx + kz * kz) || 1;
    const kb = (o.sprintKnock ? 1.5 : 1) * (m.species === "enderman" ? 0 : 1);
    m.vx += (kx / d) * 4 * kb; m.vz += (kz / d) * 4 * kb;
    m.vy = Math.max(m.vy, 5);
  }
  if (!m.def.hostile) { m.flee = Date.now(); }
  // B2: hitting a villager sours it on you — price penalty (gossip
  // minor-negative), the trade menu closes, and nearby village golems
  // take it personally (vanilla).
  if (m.species === "villager" && (o.byPlayer || o.byArrowPlayer)) {
    try {
      tradeRep(m, -25);
      if (SV.openTrade && SV.openTrade.vid === m.id) closeTradeWindow(false);
      if (m.village) {
        SV.mobs.forEach((g2) => {
          try {
            if (g2.species === "iron_golem" && g2.hp > 0 && g2.village &&
              g2.village.x === m.village.x && g2.village.z === m.village.z) g2.lastPlayerHit = Date.now();
          } catch (e) {}
        });
      }
    } catch (e) {}
  }
  if (m.hp <= 0) mobDie(m, o.byPlayer || o.byArrowPlayer);
  return true;
}

function provoke(m) {
  try { m.provokedAt = Date.now(); } catch (e) {}
  if (m.def && m.def.stare) m.angry = true;
}

function teleportMob(m) {
  // enderman-style teleport: random spot within ±32, on solid ground
  try {
    const g = game();
    try { g.particles.portal(m.x, m.y + 1, m.z, 0, 0, 0); } catch (e) {}
    for (let i = 0; i < 16; i++) {
      const x = m.x + (Math.random() * 64 - 32), z = m.z + (Math.random() * 64 - 32);
      // search from just above the mob's own height (groundAt scans 12 down):
      // fromY = m.y+16 overshoots flat terrain and finds nothing.
      const gy = groundAt(x, z, m.y + 4);
      if (gy == null) continue;
      m.x = x + 0.5; m.y = gy + 0.1; m.z = z + 0.5;
      m.vx = m.vy = m.vz = 0;
      break;
    }
    try { g.particles.portal(m.x, m.y + 1, m.z, 0, 0, 0); } catch (e) {}
    sfx("entity.enderman.teleport");
  } catch (e) {}
}

function mobDie(m, byPlayer) {
  const playerKill = !!(byPlayer || (m.lastPlayerHit && Date.now() - m.lastPlayerHit < 5000));
  const burning = m.burning || Date.now() < (m.burnUntil || 0);
  // v1.16.0: dragon death pays the vanilla purse + opens the way home
  // (normal loot/xp below run empty on its def: loot [] and xp 0)
  if (m.species === "ender_dragon") { try { dragonKilled(m, playerKill); } catch (e) {} }
  // --- item loot (drops regardless of killer, except noted rares)
  try {
    const cook = burning ? { beef: "cooked_beef", porkchop: "cooked_porkchop", chicken: "cooked_chicken", mutton: "cooked_mutton", rabbit: "cooked_rabbit", potato: "baked_potato" } : {};
    const give = (name, n) => {
      const id = itemIdByName(cook[name] || name);
      if (id != null && n > 0) spawnItemEntity(m.x, m.y + 0.5, m.z, id, Math.min(n, 64));
    };
    for (const [name, lo, hi] of m.def.loot) {
      if (m.species === "sheep" && name === "white_wool") continue; // colored below
      give(name, lo + ((Math.random() * (hi - lo + 1)) | 0));
    }
    if (m.species === "sheep") give((m.color || "white") + "_wool", 1); // 1 wool, vanilla
    if (m.species === "zombie" || m.species === "husk") {
      // rare drops: 2.5% each, player kills only; burning -> baked potato
      if (playerKill) {
        if (Math.random() < 0.025) give("iron_ingot", 1);
        if (Math.random() < 0.025) give("carrot", 1);
        if (Math.random() < 0.025) give(burning ? "baked_potato" : "potato", 1);
      }
    }
    if (m.species === "skeleton" || m.species === "stray") {
      // naturally-spawned bow: 8.5% drop on player kill (+1-3 bonus xp)
      if (playerKill && Math.random() < 0.085) {
        give("bow", 1);
        m.bowDropped = true;
      }
    }
    if (m.species === "pillager") {
      // naturally-spawned crossbow: same 8.5% player-kill rule as bows
      if (playerKill && Math.random() < 0.085) give("crossbow", 1);
    }
    if (m.species === "drowned") {
      // v1.15.0: trident + nautilus shell, player kills only (vanilla gates
      // the trident behind spawned-with-one; flat small chances here)
      if (playerKill && Math.random() < 0.06) give("trident", 1);
      if (playerKill && Math.random() < 0.03) give("nautilus_shell", 1);
    }
    if (m.species === "wither_skeleton") {
      // v1.15.0: 2.5% wither skeleton skull on player kill (vanilla).
      // Looting is not simulated, so the flat small chance stands.
      if (playerKill && Math.random() < 0.025) give("wither_skeleton_skull", 1);
    }
    if (m.captain) {
      // raid captain: the ominous banner always drops, and killing one
      // the hard way (by player) brings down Bad Omen — except mid-raid
      // (vanilla raid captains don't re-omen; the raid owns this airspace)
      give("white_banner", 1);
      if (playerKill && !SV.raid) { try { addOmen(); } catch (e) {} }
    }
    if (m.species === "spider") {
      // spider eye: 1/3 chance, player kills only (JE)
      if (playerKill && Math.random() < 1 / 3) give("spider_eye", 1);
    }
    if (m.species === "rabbit") {
      // rabbit's foot: 10% on player kill (used for leaping potions)
      if (playerKill && Math.random() < 0.1) give("rabbit_foot", 1);
    }
    // dispenser-dressed gear drops plain (vanilla drops it; NBT is skipped)
    try {
      for (const gs of (m.gear || [])) {
        if (gs && gs.id) {
          const gid = spawnItemEntity(m.x, m.y + 0.5, m.z, gs.id, 1);
          if (gid != null && gs.nbt) {
            try { const ge = game().entities.get(gid); if (ge && ge.item) ge.item.nbt = gs.nbt; } catch (e2) {}
          }
        }
      }
    } catch (e) {}
    if ((m.species === "slime" || m.species === "magma_cube") && (m.size | 0) > 1) {
      // vanilla split: large -> 2-4 medium, medium -> 2-4 small (no loot but xp)
      const ns = (m.size | 0) > 2 ? 2 : 1;
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        try {
          const s = spawnMob(m.species, m.x + (Math.random() * 2 - 1), m.y + 0.3, m.z + (Math.random() * 2 - 1));
          if (s) {
            s.size = ns;
            s.hp = ns >= 4 ? 16 : ns >= 2 ? 4 : 1;
            s.maxHp = s.hp;
            syncSlimeSize(s);
          }
        } catch (e) {}
      }
    }
    if (m.species === "creeper" && m.lastHitBySkeleton) {
      // killed by a skeleton's arrow -> random music disc (1.18 pool:
      // otherside drops too; pigstep stays bastion-loot only)
      const discs = ["music_disc_13", "music_disc_cat", "music_disc_blocks", "music_disc_chirp", "music_disc_far", "music_disc_mall", "music_disc_mellohi", "music_disc_stal", "music_disc_strad", "music_disc_ward", "music_disc_11", "music_disc_wait", "music_disc_otherside"];
      give(discs[(Math.random() * discs.length) | 0], 1);
    }
    if ((m.species === "slime" || m.species === "magma_cube") && (m.size | 0) <= 1) {
      // only the smallest drop slimeballs/magma cream (0-2)
      give(m.species === "slime" ? "slime_ball" : "magma_cream", (Math.random() * 3) | 0);
    }
  } catch (e) {}
  // --- xp orbs: only for player kills (incl. 5s claim rule), split by size
  // slimes pay by size (large 4 / medium 2 / small 1, vanilla)
  try {
    if (playerKill) {
      let xp = m.def.xp;
      if (m.species === "slime" || m.species === "magma_cube") xp = (m.size | 0) > 2 ? 4 : (m.size | 0) > 1 ? 2 : 1;
      if (Array.isArray(xp)) xp = xp[0] + ((Math.random() * (xp[1] - xp[0] + 1)) | 0);
      if (m.bowDropped) xp += 1 + ((Math.random() * 3) | 0);
      for (const v of orbSplit(Math.max(0, Math.round(xp)))) spawnXPOrb(m.x, m.y + 0.5, m.z, v);
    }
  } catch (e) {}
  try { game().sound.play("entity." + m.species + ".death"); } catch (e) {}
  // trader death frees his llamas (leads stay on the loot table, not the corpses)
  try { if (m.species === "wandering_trader") traderRelease(m, false); } catch (e) {}
  // v1.12: leave the body for the engine's death fall-over (~1s) instead of
  // vanishing it instantly; drops/xp already spawned above. sweepCorpses()
  // destroys the entity late (engine poofs at deathTime 20 if it gets there
  // first). Explosions keep the instant vanish via explode(), not here.
  try {
    if (m.e) { m.e.dead = true; m.e.deathTime = 0; }
    // v1.16.0: the dragon's death rays run ~10 s (engine renders them while
    // the entity lives) — hold its corpse past the 1.2 s sweep like vanilla
    SV.corpses.push({ id: m.id, at: Date.now(), long: m.species === "ender_dragon" });
    SV.mobs.delete(m.id);
  } catch (e) { try { removeMob(m.id); } catch (e2) {} }
}

function explode(m, P) {
  // vanilla creeper: power 3, charged 6, TNT: power 4. exposure-sampled falloff.
  // impact = (1 - d/2p) * exposure; dmg = (impact^2+impact)/2 * 7 * 2p + 1
  // Easy: min(d/2+1, d); Normal: d; Hard: d*1.5; Peaceful: no damage.
  const g = game();
  const POWER = P || (m && m.charged ? 6 : 3);
  const R = POWER;
  SV.grief = true;
  const chain = [];
  try {
    for (let x = Math.floor(m.x - R); x <= Math.floor(m.x + R); x++) {
      for (let y = Math.floor(m.y - R); y <= Math.floor(m.y + R); y++) {
        for (let z = Math.floor(m.z - R); z <= Math.floor(m.z + R); z++) {
          const d2 = (x - m.x) * (x - m.x) + (y - m.y) * (y - m.y) + (z - m.z) * (z - m.z);
          if (d2 > R * R) continue;
          const st = g.world.getState(x, y, z);
          const d = defOf(st);
          if (!d || d.id === 0 || d.name === "bedrock") continue;
          if (d.name === "tnt") { chain.push([x, y, z]); continue; } // chain-prime
          if ((d.resistance | 0) > 6) continue;
          // vanilla-style debris: the engine's own block-break particles
          try { g.particles.blockBreak(x, y, z, st); } catch (e) {}
          try { g.world.setState(x, y, z, 0); } catch (e) {}
        }
      }
    }
  } finally { SV.grief = false; }
  for (const [x, y, z] of chain) {
    try { SV.grief = true; g.world.setState(x, y, z, 0); } catch (e) {} finally { SV.grief = false; }
    spawnPrimedTNT(x + 0.5, y, z + 0.5);
  }
  // vanilla destroys nearby item entities
  try {
    const gone = [];
    SV.items.forEach((rec) => {
      const dx = rec.e.x - m.x, dy = rec.e.y - m.y, dz = rec.e.z - m.z;
      if (dx * dx + dy * dy + dz * dz < 49) gone.push(rec.id);
    });
    for (const id of gone) removeItem(id);
  } catch (e) {}
  try {
    const p = g.player;
    const dx = p.x - m.x, dy = (p.y + 1) - m.y, dz = p.z - m.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < POWER * 2) {
      const exposure = explosionExposure(m.x, m.y + 0.5, m.z, p.x, p.y + 1, p.z);
      const impact = Math.max(0, (1 - dist / (2 * POWER)) * exposure);
      let dmg = ((impact * impact + impact) / 2) * 7 * (2 * POWER) + 1;
      const d = difficulty();
      if (d === 0) dmg = 0;
      else if (d === 1) dmg = Math.min(dmg / 2 + 1, dmg);
      else if (d === 3) dmg = dmg * 1.5;
      if (dmg > 0) {
        damagePlayer(dmg, "boom", { killer: "Creeper" });
        // vanilla explosion knockback: normalized dir * impact (max ~1.0,
        // same velocity units as melee above — 1.0 ≈ full point-blank launch)
        const k = (1 - dist / (2 * POWER)) * exposure;
        try {
          p.motionX += (dx / (dist || 1)) * k;
          p.motionY += (((p.y + 1) - m.y) / (dist || 1)) * k;
          p.motionZ += (dz / (dist || 1)) * k;
        } catch (e) {}
      }
    }
    try { g.particles.explosion(m.x, m.y + 0.5, m.z, 1); } catch (e) {}
    g.sound.play("entity.generic.explode");
  } catch (e) {}
  removeMob(m.id);
}

function explosionExposure(x0, y0, z0, x1, y1, z1) {
  // fraction of the segment not buried in solid blocks (12 samples)
  try {
    let open = 0;
    const N = 12;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t, z = z0 + (z1 - z0) * t;
      if (!isSolidXYZ(x, y, z)) open++;
    }
    return open / N;
  } catch (e) { return 1; }
}

function damageMobHeal(m, n) {
  // mobs have no status system: witch sips are instant HP (capped at max)
  try {
    m.hp = Math.min(m.maxHp || m.def.hp || 20, m.hp + n);
  } catch (e) {}
}
function nearestHostile(x, z, range) {
  // closest living hostile mob to a point (for golem defenders + snowmen)
  let best = null, bd = range * range;
  try {
    SV.mobs.forEach((m) => {
      if (!m.def.hostile || m.hp <= 0) return;
      const dx = m.x - x, dz = m.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = m; }
    });
  } catch (e) {}
  return best;
}
function shootWitch(m, p) {
  // poison -> harming -> poison ... (slowness/weakness need engine movement
  // hooks, so the cycle is the two that read on our side)
  const g = game();
  const id = SV.eidSeq++;
  try {
    const n = (m.potionN = (m.potionN || 0) + 1);
    const kind = n % 3 === 0 ? "harm" : "poison";
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 60,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1.2) - (m.y + 1.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const sp = 9;
    const diff = difficulty();
    const dmg = kind === "harm" ? (diff >= 3 ? 6 : diff === 2 ? 6 : 4) : (diff >= 2 ? 3 : 2);
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * sp, vy: dy / d * sp + d * 0.12, vz: (dz / d) * sp,
      age: 0, fromMob: true, kind: "witch", fx: kind, dmg, from: "witch",
    });
    syncEnt(e);
    mobAnimSwing(m);
    m.throwAnim = 0.6; // v1.12: nose-wiggle drink/throw tell
    sfx("entity.witch.throw");
  } catch (err) {}
}
function snowmanThrow(m, foe) {
  // snow golem snowball: 0 damage, knockback only (vanilla), breaks on impact
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 61,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = foe.x - m.x, dy = (foe.y + foe.h / 2) - (m.y + 1.5), dz = foe.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const sp = 12;
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * sp, vy: dy / d * sp + d * 0.08, vz: (dz / d) * sp,
      age: 0, fromMob: false, kind: "snow", dmg: 0, thrown: true, from: "snowgolem",
    });
    syncEnt(e);
    mobAnimSwing(m);
    sfx("entity.snowman.shoot");
  } catch (err) {}
}
function shootBlaze(m, p) {
  // v1.15.0: one small fireball per volley step — same projectile as the
  // dispenser fire charge (type 69, kind "fire"), so terrain ignite + mob
  // impact reuse the dispenser paths. Vanilla volley = 3 over ~0.9 s.
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 69,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1.2) - (m.y + 1.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * 16, vy: dy / d * 16 + d * 0.08, vz: (dz / d) * 16,
      age: 0, fromMob: true, kind: "fire", thrown: true, dmg: 5, from: "blaze", shooter: m.id,
    });
    syncEnt(e);
    mobAnimSwing(m);
    sfx("entity.blaze.shoot");
  } catch (err) {}
}
function shootDrowned(m, p) {
  // drowned thrown trident (type 83, like the player path): 8 damage,
  // attributed to the thrower, no loyalty — it does not come back.
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 83,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1.2) - (m.y + 1.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.5, h: 0.5,
      vx: (dx / d) * 15, vy: dy / d * 15 + d * 0.08, vz: (dz / d) * 15,
      age: 0, fromMob: true, kind: "trident", thrown: true, dmg: 8, from: "drowned", shooter: m.id,
    });
    syncEnt(e);
    mobAnimSwing(m);
    sfx("item.trident.throw");
  } catch (err) {}
}
function shootWitherSkull(m, p) {
  // wither skull: aimed shot, impact + Wither I for 10 s (vanilla skulls
  // always explode; ours burst on terrain hits and strike directly
  // otherwise, so a direct hit never double-dips — see the header)
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 66,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1.2) - (m.y + 1.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const sp = 14;
    const diff = difficulty();
    const dmg = diff >= 3 ? 8 : diff === 2 ? 6 : 4;
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * sp, vy: dy / d * sp + d * 0.08, vz: (dz / d) * sp,
      age: 0, fromMob: true, kind: "wither", thrown: true, dmg, from: "wither",
    });
    syncEnt(e);
    mobAnimSwing(m);
    sfx("entity.wither.shoot");
  } catch (err) {}
}
function shootShulker(m, p) {
  // v1.16.0: guided shulker bullet (legacy object id 67, like the other
  // projectile types). Slow, homing, 4 damage + levitation on contact.
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 0.5, z: m.z, yaw: 0, pitch: 0, type: 67,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 0.8) - (m.y + 0.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const sp = 6; // blocks/sec (vanilla bullets are slow)
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 0.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * sp, vy: (dy / d) * sp, vz: (dz / d) * sp,
      age: 0, fromMob: true, kind: "shulkerbullet", thrown: false, dmg: 4, from: "shulker", shooter: m.id,
    });
    syncEnt(e);
    try { g.sound.play("entity.shulker.shoot"); } catch (err) {}
  } catch (err) {}
}
function shulkerHoming(a, dt) {
  // steer toward the player with a gentle turn cap (vanilla tracks but can
  // be dodged). Returns true when the bullet expired (caller returns).
  if (a.age > 20) { try { removeArrow(a.id); } catch (e) {} return true; }
  try {
    const p = game().player;
    const dx = p.x - a.x, dy = (p.y + 0.8) - a.y, dz = p.z - a.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const sp = 6, k = Math.min(1, 3 * dt);
    a.vx += ((dx / d) * sp - a.vx) * k;
    a.vy += ((dy / d) * sp - a.vy) * k;
    a.vz += ((dz / d) * sp - a.vz) * k;
  } catch (e) {}
  return false;
}
function witherBurst(x, y, z) {
  // small terrain-hit burst (power ~1): weak blocks break, the player
  // takes exposure-sampled damage + Wither I, mobs nearby take 8
  const g = game();
  try { g.particles.explosion(x, y + 0.5, z, 1); } catch (e) {}
  try { g.sound.play("entity.generic.explode"); } catch (e) {}
  SV.grief = true;
  try {
    for (let bx = Math.floor(x - 1); bx <= Math.floor(x + 1); bx++) {
      for (let by = Math.floor(y - 1); by <= Math.floor(y + 1); by++) {
        for (let bz = Math.floor(z - 1); bz <= Math.floor(z + 1); bz++) {
          const ddx = bx - x, ddy = by - y, ddz = bz - z;
          if (ddx * ddx + ddy * ddy + ddz * ddz > 2.25) continue;
          const st = g.world.getState(bx, by, bz);
          const d = defOf(st);
          if (!d || d.id === 0 || d.name === "bedrock") continue;
          if ((d.resistance | 0) > 6) continue;
          try { g.particles.blockBreak(bx, by, bz, st); } catch (e) {}
          try { g.world.setState(bx, by, bz, 0); } catch (e) {}
        }
      }
    }
  } finally { try { SV.grief = false; } catch (e) {} }
  try {
    const p = g.player;
    const dx = p.x - x, dy = (p.y + 1) - (y + 0.5), dz = p.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 4) {
      const exp = explosionExposure(x, y + 0.5, z, p.x, p.y + 1, p.z);
      const impact = Math.max(0, (1 - dist / 8) * exp);
      let dmg = ((impact * impact + impact) / 2) * 7 * 4 + 1;
      const d = difficulty();
      if (d === 0) dmg = 0;
      else if (d === 1) dmg = Math.min(dmg / 2 + 1, dmg);
      else if (d === 3) dmg = dmg * 1.5;
      if (dmg > 0) {
        damagePlayer(dmg, "boom", { killer: "Wither" });
        try { addFx("wither", 1, 200); } catch (e) {}
      }
    }
  } catch (e) {}
  try {
    SV.mobs.forEach((m) => {
      if (!m || (m.hp | 0) <= 0 || m.species === "wither") return;
      const dx = m.x - x, dy = (m.y + m.h / 2) - (y + 0.5), dz = m.z - z;
      if (dx * dx + dy * dy + dz * dz < 6.25) damageMob(m.id, 8, dx, dz, { byPlayer: false, from: "wither" });
    });
  } catch (e) {}
}
// ---- v1.16.0 Ender Dragon fight + breath clouds + pillar crystals ----
function dimWatchTick() {
  try {
    const g = game();
    if (!g || !g.inWorld) return;
    const dim = g.dimension | 0;
    if (dim === 1 && SV.lastDim !== 1) { SV.lastDim = 1; try { onEnterEnd(); } catch (e) {} }
    else if (dim !== 1 && SV.lastDim === 1) { SV.lastDim = dim; try { SV.dragon = 0; } catch (e) {} }
    else SV.lastDim = dim;
  } catch (e) {}
}
function onEnterEnd() {
  try {
    const sp = SP();
    if (!sp || !sp.id) return;
    const rec = loadWorldRecSv(sp.id);
    const kills = (rec && rec.dragonKills | 0) || 0;
    try { globalThis.__mcSingleplayer.setEndKills(kills); } catch (e) {}
    if (!rec) return;
    if (!rec.dragonSeen) { rec.dragonSeen = true; try { saveWorldRecSv(sp.id, rec); } catch (e) {} }
    if (kills > 0) return; // already slain: no dragon waiting
    let live = false;
    try { SV.mobs.forEach((m) => { if (m.species === "ender_dragon" && m.hp > 0) live = true; }); } catch (e) {}
    if (!live) startDragonFight();
  } catch (e) {}
}
function startDragonFight() {
  try {
    const g = game(), mc = globalThis.__mcSingleplayer;
    let tops = [];
    try { tops = (mc && mc.pillarTops ? mc.pillarTops() : []) || []; } catch (e) {}
    if (!SV.crystals) SV.crystals = new Map();
    for (const t of tops) {
      try {
        const id = SV.eidSeq++;
        g.entities.spawnObject({
          entityId: id, x: t.x + 0.5, y: t.y + 1, z: t.z + 0.5, yaw: 0, pitch: 0, type: 51,
          objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
          velocity: { x: 0, y: 0, z: 0 }, metadata: {},
        });
        const e = g.entities.get(id);
        if (!e) continue;
        SV.crystals.set(id, { id, e, x: t.x + 0.5, y: t.y + 1, z: t.z + 0.5 });
        try { syncEnt(e); } catch (e2) {}
      } catch (e) {}
    }
    const m = spawnMob("ender_dragon", 0.5, 90, 0.5);
    if (m) {
      m.dragonPhase = "circle"; m.dragonT = 12; m.dragonA = Math.random() * Math.PI * 2;
      SV.dragon = m.id;
      try { chat("§5The Ender Dragon descends..."); } catch (e) {}
      try { g.sound.play("entity.ender_dragon.growl"); } catch (e2) {}
    }
  } catch (e) {}
}
function dragonTick(m, dt) {
  const g = game(), p = g.player;
  // pillar crystals heal (vanilla 1 hp/s in range); beams draw themselves
  try {
    if (SV.crystals && SV.crystals.size) {
      let heal = false;
      SV.crystals.forEach((c) => {
        if (heal) return;
        try {
          if (c.e && !c.e.dead) c.e.beamTarget = m.e;
          const dx = c.x - m.x, dy = c.y - m.y, dz = c.z - m.z;
          if (dx * dx + dy * dy + dz * dz < 33 * 33) heal = true;
        } catch (e) {}
      });
      if (heal && m.hp < m.maxHp) m.hp = Math.min(m.maxHp, m.hp + dt * 1);
    }
  } catch (e) {}
  m.dragonT = (m.dragonT || 0) - dt;
  let t0 = 61;
  try { t0 = globalThis.__mcSingleplayer.endTopAt(0, 0); } catch (e) {}
  const ind = (g.dimension | 0) === 1;
  if (m.dragonPhase === "perch") {
    // sit on the fountain, breathe + bite
    m.x += (0.5 - m.x) * Math.min(1, dt * 2);
    m.z += (0.5 - m.z) * Math.min(1, dt * 2);
    m.y += ((t0 + 3) - m.y) * Math.min(1, dt * 2);
    faceMove(m, p.x, p.z);
    m.atkCd = (m.atkCd || 0) - dt;
    if (m.atkCd <= 0 && ind && difficulty() !== 0) {
      m.atkCd = 2;
      try { spawnCloud(m.x + (Math.random() * 4 - 2), m.y + 1, m.z + (Math.random() * 4 - 2), 3.5, 200); } catch (e) {}
      try { g.sound.play("entity.ender_dragon.shoot"); } catch (e2) {}
    }
    const bdx = p.x - m.x, bdy = (p.y + 1) - m.y, bdz = p.z - m.z;
    if (bdx * bdx + bdy * bdy + bdz * bdz < 49 && ind && difficulty() !== 0) {
      m.biteCd = (m.biteCd || 0) - dt;
      if (m.biteCd <= 0) {
        m.biteCd = 1;
        mobAnimSwing(m);
        damagePlayer(mobMeleeDmg(m.def), "mob", { killer: "Ender Dragon" });
      }
    } else m.biteCd = 0;
    if (m.dragonT <= 0) { m.dragonPhase = "circle"; m.dragonT = 15 + Math.random() * 15; }
    return;
  }
  if (m.dragonPhase !== "dive" && ind && difficulty() !== 0) {
    const pd2 = p.x * p.x + p.z * p.z;
    if (pd2 < 120 * 120 && m.dragonT <= 0) {
      const roll = Math.random();
      if (roll < 0.45) { m.dragonPhase = "dive"; m.dragonT = 8; }
      else if (roll < 0.65) {
        m.dragonPhase = "perch"; m.dragonT = 10;
        try { g.sound.play("entity.ender_dragon.growl"); } catch (e) {}
        return;
      } else m.dragonT = 8 + Math.random() * 12;
    }
  }
  if (m.dragonPhase === "dive") {
    // swoop at the player, fireball in range, climb out on contact or timeout
    const dx = p.x - m.x, dy = (p.y + 1) - m.y, dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const sp = 14;
    m.x += dx / d * sp * dt; m.y += dy / d * sp * dt; m.z += dz / d * sp * dt;
    faceMove(m, p.x, p.z);
    m.fireCd = (m.fireCd || 0) - dt;
    if (d < 30 && m.fireCd <= 0 && ind && difficulty() !== 0) {
      m.fireCd = 3;
      try { shootDragonFire(m, p); } catch (e) {}
    }
    if (d < 7) {
      if (ind && difficulty() !== 0) {
        mobAnimSwing(m);
        damagePlayer(mobMeleeDmg(m.def), "mob", { killer: "Ender Dragon" });
        try { p.motionY += 0.6; } catch (e) {}
      }
      m.dragonPhase = "circle"; m.dragonT = 15 + Math.random() * 15;
    }
    if (m.dragonT <= 0) { m.dragonPhase = "circle"; m.dragonT = 15 + Math.random() * 15; }
  } else {
    // holding circle: orbit the island at ~10 m/s
    m.dragonA = (m.dragonA || 0) + dt * 0.26;
    const tx = Math.cos(m.dragonA) * 38, tz = Math.sin(m.dragonA) * 38;
    m.x += (tx - m.x) * Math.min(1, dt * 3);
    m.z += (tz - m.z) * Math.min(1, dt * 3);
    m.y += ((78 + Math.sin(m.dragonA * 2) * 4) - m.y) * Math.min(1, dt * 2);
    faceMove(m, m.x - Math.sin(m.dragonA), m.z + Math.cos(m.dragonA));
    m.fireCd = (m.fireCd || 0) - dt;
    if (m.fireCd <= 0) {
      if (ind && difficulty() !== 0 && p.x * p.x + p.z * p.z < 10000) {
        m.fireCd = 6 + Math.random() * 4;
        try { shootDragonFire(m, p); } catch (e) {}
      } else m.fireCd = 2;
    }
  }
}
function shootDragonFire(m, p) {
  // vanilla dragon fireball: slow aimed shot, bursts into a breath cloud
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 2, z: m.z, yaw: 0, pitch: 0, type: 93,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1) - (m.y + 2), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const diff = difficulty();
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 2, z: m.z, w: 0.5, h: 0.5,
      vx: (dx / d) * 12, vy: dy / d * 12 + d * 0.02, vz: (dz / d) * 12,
      age: 0, fromMob: true, kind: "dragonfire", thrown: false,
      dmg: diff >= 3 ? 9 : diff === 2 ? 6 : 4, from: "ender_dragon", shooter: m.id,
    });
    syncEnt(e);
    mobAnimSwing(m);
    try { g.sound.play("entity.ender_dragon.shoot"); } catch (err) {}
  } catch (err) {}
}
function dragonBlast(x, y, z) {
  // dragon fireball impact: small burst + lingering breath cloud (vanilla)
  const g = game();
  try { g.particles.explosion(x, y + 0.5, z, 0); } catch (e) {}
  try { g.sound.play("entity.generic.explode"); } catch (e2) {}
  try {
    const p = g.player;
    const dx = p.x - x, dy = (p.y + 1) - (y + 0.5), dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz < 25 && difficulty() !== 0) {
      damagePlayer(4, "mob", { killer: "Ender Dragon" });
    }
  } catch (e) {}
  try { spawnCloud(x, y + 0.5, z, 3, 160); } catch (e) {}
}
function spawnCloud(x, y, z, r, ticks) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x, y, z, yaw: 0, pitch: 0, type: 3,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    try { e.cloudColor = 0x7f40ff; e.noGravity = true; } catch (e2) {}
    try { syncEnt(e); } catch (e3) {}
    if (!SV.clouds) SV.clouds = new Map();
    SV.clouds.set(id, { id, e, x, y, z, r, ticks, max: ticks });
    return id;
  } catch (e) { return null; }
}
function cloudTick(dt) {
  try {
    if (!SV.clouds || !SV.clouds.size) return;
    const g = game(), p = g && g.player;
    const gone = [];
    SV.clouds.forEach((c) => {
      c.ticks -= dt * 10;
      if (c.ticks <= 0 || (c.r -= dt * 0.25) <= 0.3) { gone.push(c.id); return; }
      if (p && !SV.dead && difficulty() !== 0) {
        const dx = p.x - c.x, dy = (p.y + 0.8) - c.y, dz = p.z - c.z;
        if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
          c.dmgAcc = (c.dmgAcc || 0) + dt;
          if (c.dmgAcc >= 1) {
            c.dmgAcc = 0;
            damagePlayer(3, "mob", { killer: "Dragon Breath", bypassArmor: true });
          }
        }
      }
      try {
        SV.mobs.forEach((m) => {
          if (m.hp <= 0 || m.species === "ender_dragon") return;
          const dx = m.x - c.x, dy = (m.y + 0.5) - c.y, dz = m.z - c.z;
          if (dx * dx + dy * dy + dz * dz < c.r * c.r) {
            m.cloudAcc = (m.cloudAcc || 0) + dt;
            if (m.cloudAcc >= 1) { m.cloudAcc = 0; damageMob(m.id, 3, dx, dz, { from: "dragon" }); }
          }
        });
      } catch (e) {}
    });
    for (const id of gone) {
      try { SV.clouds.delete(id); } catch (e) {}
      try { game().entities.destroy([id]); } catch (e2) {}
    }
  } catch (e) {}
}
// v1.16.0: glass bottle scooped in a breath cloud fills with dragon's
// breath (vanilla). Returns true when handled (bottle consumed).
function scoopBreath(stack) {
  try {
    if (!survives() || SV.dead) return false;
    if (!SV.clouds || !SV.clouds.size) return false;
    const g = game(), p = g.player;
    if (!p) return false;
    let inside = false;
    try {
      SV.clouds.forEach((c) => {
        if (inside) return;
        const dx = p.x - c.x, dy = (p.y + 0.8) - c.y, dz = p.z - c.z;
        const rr = (c.r || 0) + 1.5;
        if (dx * dx + dy * dy + dz * dz < rr * rr) inside = true;
      });
    } catch (e) {}
    if (!inside) return false;
    // consume one bottle from whichever hand holds this stack
    let h = 0;
    try {
      const mh = mainHeld(), oh = offHeld();
      if (stack && oh && stack.id === oh.id && !(mh && stack.id === mh.id)) h = 1;
    } catch (e) {}
    if (h === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeHeld(1);
    try {
      const bid = itemIdByName("dragon_breath");
      if (bid != null && g.inventory && typeof g.inventory.addToInventory === "function") {
        g.inventory.addToInventory({ id: bid, damage: 0, count: 1 });
      }
      g.sound.play("item.bottle.fill_dragonbreath");
    } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function explodeCrystal(id) {
  // vanilla end crystal: power-6 explosion, chains nothing (our bursts
  // don't chain-detonate — single blast, player + mobs + terrain)
  const g = game();
  let c = null;
  try { c = SV.crystals && SV.crystals.get(id); } catch (e) {}
  if (!c) return;
  try { SV.crystals.delete(id); } catch (e) {}
  try { g.entities.destroy([id]); } catch (e2) {}
  const x = c.x, y = c.y, z = c.z;
  try { g.particles.explosion(x, y + 0.5, z, 2); } catch (e) {}
  try { g.sound.play("entity.generic.explode"); } catch (e2) {}
  try {
    const p = g.player;
    const dx = p.x - x, dy = (p.y + 1) - (y + 0.5), dz = p.z - z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 12 && difficulty() !== 0) {
      const exp = explosionExposure(x, y + 0.5, z, p.x, p.y + 1, p.z);
      const impact = Math.max(0, (1 - dist / 24) * exp);
      let dmg = ((impact * impact + impact) / 2) * 7 * 12 + 1;
      if (difficulty() === 1) dmg = Math.min(dmg / 2 + 1, dmg);
      else if (difficulty() === 3) dmg = dmg * 1.5;
      if (dmg > 0) {
        damagePlayer(dmg, "boom", { killer: "End Crystal" });
        try {
          p.motionX += (dx / (dist || 1)) * impact;
          p.motionY += (((p.y + 1) - y) / (dist || 1)) * impact;
          p.motionZ += (dz / (dist || 1)) * impact;
        } catch (e) {}
      }
    }
  } catch (e) {}
  try {
    SV.mobs.forEach((m) => {
      if (!m || (m.hp | 0) <= 0) return;
      const dx = m.x - x, dy = (m.y + m.h / 2) - (y + 0.5), dz = m.z - z;
      if (dx * dx + dy * dy + dz * dz < 36) damageMob(m.id, 12, dx, dz, { byPlayer: false, from: "crystal" });
    });
  } catch (e) {}
}
function dragonKilled(m, playerKill) {
  // first kill 12000 xp, later kills 500 (vanilla); fountain + egg +
  // one gateway per kill are written as overrides so loaded chunks update
  const g = game(), mc = globalThis.__mcSingleplayer;
  let t0 = 61;
  try { t0 = mc.endTopAt(0, 0); } catch (e) {}
  const sp = SP();
  let kills = 0;
  try {
    const rec = sp && sp.id ? loadWorldRecSv(sp.id) : null;
    kills = (rec && rec.dragonKills | 0) || 0;
    if (rec) {
      rec.dragonKills = kills + 1;
      try { saveWorldRecSv(sp.id, rec); } catch (e) {}
    }
  } catch (e) {}
  try { mc.setEndKills(kills + 1); } catch (e) {}
  try {
    for (const v of orbSplit(kills === 0 ? 12000 : 500)) spawnXPOrb(m.x, m.y + 1, m.z, v);
  } catch (e) {}
  SV.grief = true;
  try {
    const portal = mc.stFor("end_portal", {});
    const egg = mc.stFor("dragon_egg", {});
    const cells = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [ox, oz] of cells) {
      try { if (portal) g.world.setState(ox, t0 + 1, oz, portal); } catch (e) {}
    }
    // v1.16.0: the ritual corners must be bedrock (pre-kill the center is
    // plain end stone, so the first kill raises the bedrock rim the respawn
    // rite anchors on — vanilla parity for tryDragonRitual)
    try {
      const rock = mc.stFor("bedrock", {});
      if (rock) for (const [ox, oz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        try { g.world.setState(ox, t0 + 1, oz, rock); } catch (e) {}
      }
    } catch (e) {}
    try { if (egg && g.world.getState(0, t0 + 5, 0) === 0) g.world.setState(0, t0 + 5, 0, egg); } catch (e) {}
    if (kills < 20) {
      try {
        const spots = mc.gatewaySpots() || [];
        const s = spots[kills];
        if (s) {
          g.world.setState(s.x, s.y - 1, s.z, mc.stFor("bedrock", {}));
          g.world.setState(s.x, s.y, s.z, mc.stFor("end_gateway", {}));
        }
      } catch (e) {}
    }
  } finally { try { SV.grief = false; } catch (e) {} }
  try { chat(kills === 0 ? "§5Ender Dragon defeated! The way home is open." : "§5Ender Dragon defeated again! (gateway " + Math.min(kills + 1, 20) + "/20)"); } catch (e) {}
  try { g.sound.play("entity.ender_dragon.death"); } catch (e2) {}
  try { SV.dragon = 0; } catch (e) {}
}
function tryDragonRitual(t, hand) {
  // vanilla respawn rite: an end crystal used on each bedrock corner of the
  // fountain (post-kill) draws the dragon back. Returns true when handled.
  try {
    if (!survives() || (game().dimension | 0) !== 1) return false;
    if (!t || typeof t.x !== "number") return false;
    const held = hand === 1 ? offHeld() : mainHeld();
    let hn = "";
    try { hn = held && game().items.name(held.id); } catch (e) {}
    if (hn !== "end_crystal") return false;
    const mc = globalThis.__mcSingleplayer;
    let t0 = 61;
    try { t0 = mc.endTopAt(0, 0); } catch (e) {}
    let kills = 0;
    try { kills = mc.endKills(); } catch (e) {}
    if (kills <= 0) return false;
    const bx = t.x | 0, by = t.y | 0, bz = t.z | 0;
    if (by !== t0 + 1 || Math.abs(bx) !== 1 || Math.abs(bz) !== 1) return false;
    if (blockNameAt(bx, by, bz) !== "bedrock") return false;
    // one crystal per corner (re-clicking a filled corner does nothing)
    let filled = false;
    try {
      SV.crystals.forEach((c) => {
        if (Math.abs(c.x - (bx + 0.5)) < 0.6 && Math.abs(c.z - (bz + 0.5)) < 0.6 && Math.abs(c.y - (by + 1)) < 1.5) filled = true;
      });
    } catch (e) {}
    if (filled) return true;
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try {
      const g = game(), id = SV.eidSeq++;
      g.entities.spawnObject({
        entityId: id, x: bx + 0.5, y: by + 1, z: bz + 0.5, yaw: 0, pitch: 0, type: 51,
        objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
        velocity: { x: 0, y: 0, z: 0 }, metadata: {},
      });
      const e = g.entities.get(id);
      if (e) {
        try { syncEnt(e); } catch (e2) {}
        if (!SV.crystals) SV.crystals = new Map();
        SV.crystals.set(id, { id, e, x: bx + 0.5, y: by + 1, z: bz + 0.5, ritual: true });
      }
      g.sound.play("entity.end_crystal.place");
    } catch (e) {}
    let n = 0;
    try { SV.crystals.forEach((c) => { if (c.ritual) n++; }); } catch (e) {}
    if (n >= 4) {
      try {
        const ids = [];
        SV.crystals.forEach((c) => { if (c.ritual) ids.push(c.id); });
        for (const rid of ids) { try { SV.crystals.delete(rid); } catch (e) {} }
        game().entities.destroy(ids);
      } catch (e) {}
      try { chat("§5The Ender Dragon is drawn back..."); } catch (e) {}
      startDragonFight();
    }
    return true;
  } catch (e) { return false; }
}
// ---- v1.14 village system: victim selection, crossbow shots, evoker spells
function pickVictim(m) {
  // nearest of: the player, villagers/traders, golems. Johnny vindicators
  // (name tag) turn on almost every mob instead (vanilla).
  const range = m.def.range || 20, r2 = range * range;
  let best = null, bd = r2;
  try {
    const p = game().player;
    if (p && survives()) {
      const dx = p.x - m.x, dz = p.z - m.z, d2 = dx * dx + dz * dz;
      if (d2 < bd && Math.abs(p.y - m.y) < 10) { bd = d2; best = { x: p.x, y: p.y, z: p.z, isPlayer: true }; }
    }
  } catch (e) {}
  const johnny = m.species === "vindicator" && m.name === "Johnny";
  try {
    SV.mobs.forEach((o) => {
      if (!o || o.hp <= 0 || o.id === m.id) return;
      if (johnny) {
        if (o.def.illager || o.def.vex) return;
      } else {
      if (!(o.species === "villager" || o.species === "wandering_trader" ||
          o.species === "iron_golem" || o.species === "snow_golem" ||
          o.species === "trader_llama")) return;
      }
      const dx = o.x - m.x, dz = o.z - m.z, d2 = dx * dx + dz * dz;
      if (d2 < bd && Math.abs(o.y - m.y) < 10) { bd = d2; best = { x: o.x, y: o.y, z: o.z, id: o.id }; }
    });
  } catch (e) {}
  return best;
}
function strikeFoe(m, foe, fx, fz, fd) {
  // one melee hit on a victim that may be the player or a mob
  const d = fd || 1;
  mobAnimSwing(m);
  if (m.species === "vindicator" || m.species === "ravager") m.swingAt = Date.now();
  const dmg = mobMeleeDmg(m.def);
  if (foe.isPlayer) {
    damagePlayer(dmg, "mob", { killer: mobLabel(m.species) });
    const kb = m.species === "ravager" ? 1.6 : 0.4;
    try {
      const p = game().player;
      p.motionX += (fx / d) * kb; p.motionZ += (fz / d) * kb; p.motionY += kb;
    } catch (e) {}
  } else {
    const v = SV.mobs.get(foe.id);
    if (v) {
      damageMob(foe.id, dmg + (m.species === "ravager" ? 4 : 0), fx, fz, { byPlayer: false });
      // ravagers launch mobs skyward like they do the player (vanilla)
      if (m.species === "ravager") { try { v.vy = Math.max(v.vy, 12); } catch (e) {} }
    }
  }
}
function shootArrowAt(m, foe) {
  // pillager crossbow on any victim (player or mob). Same flight as the
  // skeleton shot below; arrowTick attributes mob hits via a.from.
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 60,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const ty = foe.y != null ? foe.y + 1.2 : m.y + 1.2;
    const dx = foe.x - m.x, dy = ty - (m.y + 1.5), dz = foe.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const diff = difficulty();
    const range = (m.def.arrowDmg && m.def.arrowDmg[diff]) || [2, 4];
    const dmg = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * 9 + dy * 0.1 * (dx / d), vy: dy / d * 9 + d * 0.12, vz: (dz / d) * 9,
      age: 0, fromMob: true, from: m.species, dmg, shooter: m.id,
    });
    syncEnt(e);
    mobAnimSwing(m);
    try { g.sound.play("item.crossbow.shoot"); } catch (err) {}
  } catch (err) {}
}
function evokerCast(m, foe, fd) {
  // one spell per cast: summon while outnumbered, fangs in range, wololo
  // whenever a blue sheep is near (vanilla party trick)
  m.castAnim = Date.now();
  try { sfx("entity.evoker.cast_spell"); } catch (e) {}
  const vn = villageCount("vex");
  if (vn < 6) {
    try {
      for (let i = 0; i < 3; i++) {
        const v = spawnMob("vex", m.x + (Math.random() * 4 - 2), m.y + 1.2, m.z + (Math.random() * 4 - 2));
        if (v) {
          v.raid = m.raid;
          try { game().particles.poof(v.x, v.y + 0.5, v.z); } catch (e2) {}
        }
      }
      try { sfx("entity.evoker.prepare_summon"); } catch (e2) {}
    } catch (e) {}
  } else if (fd <= 16) {
    evokerFangs(m, foe.x, foe.z);
  }
  try {
    SV.mobs.forEach((o) => {
      if (!o || o.species !== "sheep" || o.color !== "blue" || o.sheared) return;
      const dx = o.x - m.x, dz = o.z - m.z;
      if (dx * dx + dz * dz < 256) {
        paintSheep(o, "red");
        try { game().particles.happy_villager(o.x, o.y + 1, o.z); } catch (e2) {}
      }
    });
  } catch (e) {}
}
function evokerFangs(m, tx, tz) {
  // a line of snapping fangs from the evoker toward the target (vanilla
  // has a 0.5s warmup telegraph; ours snap at once — documented gap)
  const g = game();
  const dx = tx - m.x, dz = tz - m.z, d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  try { sfx("entity.evoker.fangs_attack"); } catch (e) {}
  SV.fangFx = SV.fangFx || [];
  for (let i = 1; i <= 10; i++) {
    const fx = m.x + nx * i * 1.1, fz = m.z + nz * i * 1.1;
    let fy = null;
    try { fy = groundAt(fx, fz, m.y + 3); } catch (e) {}
    if (fy == null || Math.abs(fy - m.y) > 4) continue;
    const id = SV.eidSeq++;
    try {
      g.entities.spawnObject({
        entityId: id, x: fx, y: fy + 0.1, z: fz, yaw: 0, pitch: 0, type: 22,
        objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
        velocity: { x: 0, y: 0, z: 0 }, metadata: {},
      });
      const e = g.entities.get(id);
      if (!e) continue;
      e.fangsActive = true; // engine animates + ages it from here
      try { game().particles.crit(fx, fy + 0.5, fz); } catch (e2) {}
      // one 6-damage bite: the player, plus every non-illager mob nearby
      try {
        const p = g.player;
        if (p && survives()) {
          const px = p.x - fx, pz = p.z - fz;
          if (px * px + pz * pz < 1.4 && Math.abs(p.y - fy) < 2) damagePlayer(6, "mob", { killer: "Evoker" });
        }
      } catch (e2) {}
      try {
        SV.mobs.forEach((o) => {
          if (!o || o.hp <= 0 || o.def.illager || o.def.vex) return;
          const ox = o.x - fx, oz = o.z - fz;
          if (ox * ox + oz * oz < 1.4 && Math.abs(o.y - fy) < 2) damageMob(o.id, 6, ox, oz, { byPlayer: false });
        });
      } catch (e2) {}
      SV.fangFx.push({ id, until: Date.now() + 1500 });
    } catch (e) {}
  }
}
function shootArrow(m, p) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x: m.x, y: m.y + 1.5, z: m.z, yaw: 0, pitch: 0, type: 60,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    const dx = p.x - m.x, dy = (p.y + 1.2) - (m.y + 1.5), dz = p.z - m.z;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    const sp = 9; // blocks/sec
    // skeleton arrow damage by difficulty (wiki infobox ranges)
    const diff = difficulty();
    const range = (m.def.arrowDmg && m.def.arrowDmg[diff]) || [2, 4];
    const dmg = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
    SV.arrows.set(id, {
      id, e, x: m.x, y: m.y + 1.5, z: m.z, w: 0.3, h: 0.3,
      vx: (dx / d) * sp + dy * 0.1 * (dx / d), vy: dy / d * sp + d * 0.12, vz: (dz / d) * sp,
      age: 0, fromMob: true, from: m.species, dmg, shooter: m.id,
    });
    syncEnt(e);
    mobAnimSwing(m);
    try { g.sound.play("entity.skeleton.shoot"); } catch (err) {}
  } catch (err) {}
}

function arrowTick(a, dt) {
  const g = game();
  if (!a.returning) {
    a.age += dt;
    // v1.15.0: a loyalty trident never despawns mid-flight — on age-out it
    // starts its return instead (vanilla: loyalty always comes back)
    if (a.age > 6 && a.kind !== "shulkerbullet") {
      if (a.kind === "trident" && (a.loyalty | 0) > 0) {
        a.returning = true; a.hitDone = true;
        try { sfx("item.trident.return"); } catch (e) {}
      } else { removeArrow(a.id); return; }
    }
  }
  // v1.15.0: loyalty return flight steers home and phases through blocks
  if (a.returning) { try { tridentReturnStep(a, dt); } catch (e) { try { removeArrow(a.id); } catch (e2) {} } return; }
  // v1.16.0: shulker bullets home instead of falling (engine gives them no
  // gravity either); everything else keeps its arc. Own 20 s cap here since
  // the shared 6 s age-out above exempts them.
  if (a.kind === "shulkerbullet") { try { if (shulkerHoming(a, dt)) return; } catch (e) {} }
  else a.vy -= 1.6 * dt * 10 * 0.1; // gravity ~1.6 blocks/s^2 scaled
  const steps = 3;
  for (let i = 0; i < steps; i++) {
    const b = { x: a.x, y: a.y, z: a.z, w: a.w, h: a.h };
    const res = physMove(b, (a.vx * dt) / steps, (a.vy * dt) / steps, (a.vz * dt) / steps);
    a.x = b.x; a.y = b.y; a.z = b.z;
    // unloaded-chunk physics can go NaN (long pearl flights): kill the shot
    // rather than teleporting the player into the void on impact
    if (!isFinite(a.x + a.y + a.z)) { removeArrow(a.id); return; }
    if (res.hitX || res.hitZ || (res.ground && a.vy < 0)) {
      // v1.16.0: dragon fireballs burst into breath clouds on terrain
      if (a.kind === "dragonfire") { try { dragonBlast(a.x, a.y, a.z); } catch (e) {} removeArrow(a.id); return; }
      // v1.16.0: shulker bullets fizzle on terrain (vanilla puff)
      if (a.kind === "shulkerbullet") { try { g.particles.poof(a.x, a.y, a.z); } catch (e) {} try { sfx("entity.shulker_bullet.hit"); } catch (e2) {} removeArrow(a.id); return; }
      // v1.15.0: tridents stick (loyalty returns, plain drops) instead of vanishing
      if (a.kind === "trident") { try { tridentImpact(a); } catch (e) {} return; }
      if (a.thrown) { try { thrownHit(a, null); } catch (e) {} }
      removeArrow(a.id); return;
    }
  }
  // hit player? (mob arrows only; ours are tracked, the player's own are visual)
  try {
    const p = g.player;
    if (a.fromMob) {
      const dx = p.x - a.x, dy = (p.y + 1) - a.y, dz = p.z - a.z;
      if (dx * dx + dy * dy + dz * dz < 1.2) {
        if (a.kind === "witch") {
            // poison splashes + harming cracks (armor only helps vs poison)
            if (a.fx === "harm") damagePlayer(a.dmg, "mob", { killer: "Witch", bypassArmor: true });
            else {
              damagePlayer(a.dmg, "mob", { killer: "Witch" });
              try { addFx("poison", 1, 200); } catch (e) {}
            }
        } else if (a.kind === "wither") {
          // wither skull direct hit: impact + Wither I for 10 s (vanilla)
          damagePlayer(a.dmg != null ? a.dmg : 6, "mob", { killer: "Wither" });
          try { addFx("wither", 1, 200); } catch (e) {}
        } else if (a.kind === "fire" && a.fromMob) {
          // v1.15.0: blaze fireball — impact + ignite 5 s (vanilla). The
          // dispenser path (fromMob false) keeps its old killer below.
          damagePlayer(a.dmg != null ? a.dmg : 5, "mob", { killer: mobLabel(a.from || "blaze") });
          try { ignitePlayer(5); } catch (e) {}
        } else if (a.kind === "dragonfire") {
          // v1.16.0: direct dragon-fireball hit + the burst cloud
          damagePlayer(a.dmg != null ? a.dmg : 6, "mob", { killer: "Ender Dragon" });
          try { dragonBlast(a.x, a.y, a.z); } catch (e) {}
        } else if (a.kind === "shulkerbullet") {
          // v1.16.0: guided-bullet hit — impact + Levitation for 10 s
          // (vanilla). addFx is the sim record; game().effects is the engine
          // read that actually floats the player. Effect id 25, amplifier 0.
          damagePlayer(a.dmg != null ? a.dmg : 4, "mob", { killer: "Shulker" });
          try { addFx("levitation", 1, 200); } catch (e) {}
          try {
            game().effects.set(25, { amplifier: 0, duration: 200, hideParticles: false, ambient: false, showIcon: true, start: game().ticks });
          } catch (e2) {}
          try { sfx("entity.shulker_bullet.hit"); } catch (e3) {}
        } else if (a.kind === "trident" && a.fromMob) {
          // drowned thrown trident: 8 damage attributed to the drowned (vanilla).
          damagePlayer(a.dmg != null ? a.dmg : 8, "mob", { killer: mobLabel(a.from || "drowned") });
        } else {
          damagePlayer(a.dmg != null ? a.dmg : 3, "arrow", { killer: "Skeleton" });
        }
        removeArrow(a.id);
        return;
      }
    }
    // arrows (any source) can strike mobs: skeleton arrows killing a
    // creeper drop a music disc, so every arrow hit is attributed.
    // v1.16.0: projectiles detonate end crystals on contact (vanilla)
    try {
      if (SV.crystals && SV.crystals.size && !a.returning) {
        let boom = null;
        SV.crystals.forEach((c) => {
          if (boom) return;
          const cdx = c.x - a.x, cdy = (c.y + 1) - a.y, cdz = c.z - a.z;
          if (cdx * cdx + cdy * cdy + cdz * cdz < 6.25) boom = c;
        });
        if (boom) { try { explodeCrystal(boom.id); } catch (e) {} removeArrow(a.id); return; }
      }
    } catch (e) {}
    if (!a.hitDone) {
      let hit = null;
      SV.mobs.forEach((m) => {
        if (hit) return;
        if (m.id === a.shooter) return; // v1.14: mob arrows spawn inside the shooter
        // v1.16.0: the dragon's 16-wide body needs its own hit test —
        // the 1.1-block scan below would only clip its center column
        if (m.species === "ender_dragon") {
          const mdx = m.x - a.x, mdz = m.z - a.z;
          if (mdx * mdx + mdz * mdz > 64) return;
          if (a.y < m.y - 2 || a.y > m.y + 8) return;
          hit = m; return;
        }
        const mdx = m.x - a.x, mdz = m.z - a.z;
        if (mdx * mdx + mdz * mdz > 1.2) return;
        if (Math.abs((m.y + m.h / 2) - a.y) > m.h) return;
        hit = m;
      });
      if (hit) {
        a.hitDone = true;
      if (a.thrown) {
        // snow/egg: knockback only; pearl: teleport to the victim
        // v1.15.0: trident: 8 damage (+impaling vs aquatic), then stick/return
        if (a.kind === "trident") {
          let tdmg = a.dmg != null ? a.dmg : 8;
          try {
            const sp = hit && hit.species;
            if ((a.impaling | 0) > 0 && (sp === "guardian" || sp === "elder_guardian" || sp === "drowned")) tdmg += 2.5 * (a.impaling | 0);
          } catch (e) {}
          const tByPlayer = !a.fromMob;
          damageMob(hit.id, tdmg, a.vx, a.vz, { byArrow: true, byArrowPlayer: tByPlayer, from: tByPlayer ? "player" : (a.from || "drowned") });
          try { sfx("item.trident.hit"); } catch (e) {}
          // channeling: a channeling trident striking a mob in a thunderstorm
          // calls down a real bolt on the victim (vanilla).
          try { if ((a.channeling | 0) > 0 && isThundering() && hit) lightningStrikeAt(Math.round(hit.x), Math.round(hit.y), Math.round(hit.z)); } catch (e) {}
          if (a.fromMob) { try { removeArrow(a.id); } catch (e) {} return; }
          try { tridentImpact(a); } catch (e) {}
          return;
        }
        if (a.kind === "pearl") { try { thrownHit(a, hit); } catch (e) {} removeArrow(a.id); return; }
          if (a.kind === "fire") {
            // dispenser fire charge: 5 damage + ignite (thrownHit lights the block)
            damageMob(hit.id, 5, a.vx, a.vz, { byArrow: true, byArrowPlayer: !a.neutral, from: a.from || "dispenser" });
            try { thrownHit(a, hit); } catch (e) {}
            removeArrow(a.id);
            return;
          }
          damageMob(hit.id, 0, a.vx, a.vz, { noDamage: true, byPlayer: !a.neutral });
          if (a.kind === "egg") {
            try { if (Math.random() < 1 / 8) spawnMob("chicken", a.x, a.y + 0.2, a.z); } catch (e) {}
          }
          removeArrow(a.id);
          return;
        }
        const byPlayer = !a.fromMob && !a.neutral;
        damageMob(hit.id, a.dmg != null ? a.dmg : 4, a.vx, a.vz,
          { byArrow: true, byArrowPlayer: byPlayer, from: a.from || "player", crit: a.crit });
        // v1.16.0: dragon fireballs burst into breath clouds on mobs too
        if (a.kind === "dragonfire") { try { dragonBlast(a.x, a.y, a.z); } catch (e) {} }
      }
    }
  } catch (e) {}
  try {
    const e = a.e;
    e.x = e.newX = a.x; e.y = e.newY = a.y; e.z = e.newZ = a.z; e.inc = 2;
  } catch (err) {}
}
function removeArrow(id) {
  try { SV.arrows.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}

/* ---------------------------------------------------------- throwables, bow, fishing
 * The engine has no offline throw/fire/cast (snowballs vanish with no
 * entity, bows animate but never release, rods do nothing), so survival owns
 * all three. Vanilla rules:
 *   snowball/egg/pearl: instant throw on RMB (even aimed at blocks — they
 *     have no block use), one item each. Snowballs deal 0 (knockback only),
 *     eggs hatch a chicken 1/8 on impact, pearls teleport + 5 fall damage.
 *   bow: hold to draw (engine animates via usingItem), release fires with
 *     power from draw time; needs an arrow in inventory; wears bow + arrow.
 *   rod: RMB casts (or reels when out); bobber floats on water, bites in
 *     5-15 s, 1 s to reel a catch; loot 85% fish / 10% junk / 5% treasure,
 *     1-6 XP, rod wears 1 per catch.
 * Touch devices have no RMB path (engine touch taps are left-clicks), so
 * throwing/casting there is a known gap (see README).
 */
const THROW_KIND = { snowball: "snow", egg: "egg", ender_pearl: "pearl", splash_potion: "splash", lingering_potion: "linger" };
function lookDir() {
  try {
    const p = game().player;
    // engine yaw/pitch are degrees — convert before trig
    const yr = (p.yaw || 0) * Math.PI / 180, pr = (p.pitch || 0) * Math.PI / 180;
    const cp = Math.cos(pr);
    return { x: -Math.sin(yr) * cp, y: -Math.sin(pr), z: Math.cos(yr) * cp };
  } catch (e) { return { x: 0, y: 0, z: 1 }; }
}
function throwFastPath() {
  // RMB edge with a throwable/rod held and no container open. Returns true
  // when we owned the click (caller must swallow it so the engine can't
  // double-consume). Main hand first, offhand only when main is empty.
  // Ender eyes also throw in creative (no consume) — they fly without an
  // engine entity, so they need no survival sim running.
  try {
    let eyeOnly = false;
    try {
      const mh0 = mainHeld(), oh0 = offHeld();
      const n0 = mh0 && mh0.id ? stackName(mh0) : (oh0 && oh0.id ? stackName(oh0) : null);
      if (n0 === "ender_eye") eyeOnly = true;
    } catch (e) {}
    if ((!survives() && !eyeOnly) || SV.dead) return false;
    if (game().window) return false;
    try { if (game().currentScreen) return false; } catch (e) {}
    const mh = mainHeld(), oh = offHeld();
    let hand = -1, nm = null;
    if (mh && mh.id) { hand = 0; nm = stackName(mh); }
    else if (oh && oh.id) { hand = 1; nm = stackName(oh); }
    else return false;
    if (nm === "ender_eye") { eyeThrow(hand, survives()); return true; }
    if (THROW_KIND[nm]) {
      const kind = THROW_KIND[nm];
      // capture the Potion tag BEFORE consuming: a count-1 stack leaves the
      // slot empty, so spawnThrown could not read it back afterwards
      let prePotion = null;
      try {
        const s0 = hand === 1 ? oh : mh;
        prePotion = s0 && s0.nbt ? ((game().items.nbt(s0) || {}).Potion || null) : null;
      } catch (e) {}
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      spawnThrown(kind, hand, prePotion);
      return true;
    }
    if (nm === "fishing_rod") {
      rodUse(hand);
      return true;
    }
  } catch (e) {}
  return false;
}
function spawnThrown(kind, hand, potionOverride) {
  const g = game(), p = g.player;
  const type = kind === "snow" ? 71 : kind === "egg" ? 79 : kind === "pearl" ? 80 : 82; // unified 1.15.2 ids
  // splash/lingering carry their Potion-tag effect to impact
  let potion = potionOverride || null;
  if (!potion && (kind === "splash" || kind === "linger")) {
    try {
      const s = handStack(hand);
      potion = s && s.nbt ? ((g.items.nbt(s) || {}).Potion || null) : null;
    } catch (e) {}
  }
  const id = SV.eidSeq++;
  try {
    const d = lookDir();
    const sx = p.x, sy = p.y + 1.5, sz = p.z;
    g.entities.spawnObject({
      entityId: id, x: sx, y: sy, z: sz, yaw: 0, pitch: 0, type,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    const sp = kind === "pearl" ? 20 : 18;
    SV.arrows.set(id, {
      id, e, x: sx, y: sy, z: sz, w: 0.3, h: 0.3,
      vx: d.x * sp, vy: d.y * sp + 1.5, vz: d.z * sp,
      age: 0, fromMob: false, kind, dmg: 0, thrown: true, hand, potion,
    });
    syncEnt(e);
    if (kind === "splash" || kind === "linger") {
      try { sfx("entity.splash_potion.throw"); } catch (err) {}
      return id;
    }
    try {
      if (kind === "pearl") sfx("entity.ender_pearl.throw");
      else sfx("entity.snowball.throw");
    } catch (err) {}
    return id;
  } catch (err) { return null; }
}
function thrownHit(a, hitMob) {
  // impact effects for our thrown kinds; called from arrowTick paths
  const kind = a.kind;
  try {
    if (kind === "egg" && Math.random() < 1 / 8) {
      try { spawnMob("chicken", a.x, a.y + 0.2, a.z); } catch (e) {}
    }
    if (kind === "pearl" && !a.noTeleport) {
      if (!isFinite(a.x + a.y + a.z)) return; // stale shot: fizzle, no teleport
      const g = game(), p = g.player;
      try { g.particles.portal(p.x, p.y + 1, p.z, 30); } catch (e) {}
      let ny = groundAt(a.x, a.z, a.y + 2);
      if (ny == null) ny = a.y;
      try {
        p.setPosition(a.x, ny + 0.1, a.z);
        p.prevX = a.x; p.prevY = ny; p.prevZ = a.z;
        p.motionX = p.motionY = p.motionZ = 0;
      } catch (e) {}
      try { g.particles.portal(a.x, ny + 1, a.z, 30); } catch (e2) {}
      sfx("entity.enderman.teleport");
      damagePlayer(5, "fall", { bypassArmor: true }); // vanilla pearl: 5 fall-type dmg
      addExhaustion(0.1);
      // vanilla: 5% of landings hatch an endermite
      try {
        if (Math.random() < 0.05) spawnMob("endermite", a.x, ny + 0.2, a.z);
      } catch (e2) {}
    }
    if ((kind === "splash" || kind === "linger") && a.potion) {
      // lingering has no lingering cloud offline: same burst, noted in parity doc
      try { splashPotionFx(a.potion, a.x, a.y, a.z, kind === "linger"); } catch (e) {}
    }
    if (kind === "wither") {
      // skulls burst on terrain impact (direct hits already paid above)
      try { witherBurst(a.x, a.y, a.z); } catch (e) {}
    }
    if (kind === "fire" && !a.done) {
      // dispenser fire charge: 5 damage + ignite the impact block
      a.done = true;
      try {
        const g = game(), bx = Math.floor(a.x), by = Math.floor(a.y), bz = Math.floor(a.z);
        const cur = g.world.getState(bx, by, bz);
        let ix = bx, iy = by, iz = bz;
        if ((cur | 0) !== 0) { iy = by + 1; } // hit a wall: fire above
        if ((g.world.getState(ix, iy, iz) | 0) === 0) {
          const below = defOf(g.world.getState(ix, iy - 1, iz));
          if (below && below.id !== 0) {
            try { SV.grief = true; g.world.setState(ix, iy, iz, FIRE_ST); } finally { SV.grief = false; }
          }
        }
        try { g.sound.play("item.flintandsteel.use"); } catch (e) {}
      } catch (e) {}
    }
  } catch (e) {}
}
// apply a potion-tag effect at a point (drunk or splashed): player in radius
// gets the full effect, mobs likewise. Instant heal/harm apply immediately;
// durations are game ticks (20/s). Unknown/weak tags do nothing (vanilla).
function potionFxFor(suffix) {
  if (!suffix) return null;
  const key = String(suffix).replace(/^minecraft:/, "");
  return POTION_FX[key] || null;
}
function applyPotionFx(list, isPlayer, mob) {
  if (!list) return;
  for (const [fx, lvl, ticks] of list) {
    if (fx === "instant_heal") {
      if (isPlayer) setHP(Math.min(20, getHP() + (lvl >= 2 ? 8 : 4)));
      else if (mob) damageMobHeal(mob, lvl >= 2 ? 8 : 4);
    } else if (fx === "instant_harm") {
      const d = lvl >= 2 ? 12 : 6;
      if (isPlayer) damagePlayer(d, "magic", { bypassArmor: true, killer: "Potion" });
      else if (mob) damageMob(mob.id, d, 0, 0, { magic: true, byPlayer: true });
    } else {
      if (isPlayer) addFx(fx, lvl, ticks);
      else if (mob) addMobFx(mob, fx, lvl, ticks);
    }
  }
}
// mob-side status store (player uses SV.fx). Only effects with mob gameplay
// are read back: poison (in mobTick? no — applied as direct ticks here for
// simplicity: harm-style damage over the effect's short duration is overkill;
// we store and let generic handlers read), regen. Others stored harmlessly.
function addMobFx(mob, name, lvl, ticks) {
  try {
    mob.fx = mob.fx || {};
    const until = Date.now() + ticks * 50;
    const cur = mob.fx[name];
    if (!cur || cur.lvl < lvl || cur.until < until) mob.fx[name] = { lvl, until };
  } catch (e) {}
}
function splashPotionFx(suffix, x, y, z) {
  const list = potionFxFor(suffix);
  if (!list) return;
  const g = game(), R = 4;
  try { g.particles.potionSwirl(x, y + 0.5, z, 24); } catch (e) {}
  try { g.particles.splash(x, y, z, 8); } catch (e) {}
  sfx("entity.splash_potion.break");
  try {
    const p = g.player;
    const dx = p.x - x, dy = (p.y + 1) - y, dz = p.z - z;
    if (dx * dx + dy * dy + dz * dz < R * R) applyPotionFx(list, true, null);
  } catch (e) {}
  try {
    SV.mobs.forEach((m) => {
      if (m.hp <= 0) return;
      const dx = m.x - x, dy = (m.y + m.h / 2) - y, dz = m.z - z;
      if (dx * dx + dy * dy + dz * dz < R * R) applyPotionFx(list, false, m);
    });
  } catch (e) {}
}
// --- bow: draw tracked via the engine's own usingItem flag (it animates the
// draw offline, it just never fires). Release with >=0.3 s draw fires ours.
function bowInHand() {
  try { if (stackName(mainHeld()) === "bow") return "main"; } catch (e) {}
  try { if (stackName(offHeld()) === "bow") return "off"; } catch (e) {}
  return null;
}
function bowTick() {
  if (!survives()) { SV.bowDraw = null; return; }
  let using = false;
  try { using = !!(game().player && game().player.usingItem); } catch (e) {}
  const held = using ? bowInHand() : null;
  if (held) {
    if (!SV.bowDraw) SV.bowDraw = { t: 0, hand: held };
    else { SV.bowDraw.t += 0.1; SV.bowDraw.hand = held; }
    return;
  }
  if (SV.bowDraw) {
    const d = SV.bowDraw;
    SV.bowDraw = null;
    if (d.t >= 0.3) fireBow(d);
  }
}
function findArrowSlot() {
  try {
    const v = inv();
    const aid = itemIdByName("arrow");
    if (aid == null || !v || !v.main) return -1;
    for (let i = 0; i < v.main.length; i++) {
      const s = v.main[i];
      if (s && s.id === aid && (s.count | 0) > 0) return i;
    }
  } catch (e) {}
  return -1;
}
function fireBow(d) {
  try {
    const ai = findArrowSlot();
    if (ai < 0) { sfx("random.click"); return; } // vanilla: empty click, no shot
    const g = game(), p = g.player;
    const charge = clamp(d.t / 1.0, 0, 1); // full power at 1 s (vanilla 20 ticks)
    const id = SV.eidSeq++;
    const dir = lookDir();
    const sp = 6 + 14 * charge;
    g.entities.spawnObject({
      entityId: id, x: p.x, y: p.y + 1.5, z: p.z, yaw: 0, pitch: 0, type: 60,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    // spread tightens as draw completes (vanilla)
    const spread = (1 - charge) * 0.06;
    SV.arrows.set(id, {
      id, e, x: p.x, y: p.y + 1.5, z: p.z, w: 0.3, h: 0.3,
      vx: dir.x * sp + (Math.random() - 0.5) * spread * sp,
      vy: dir.y * sp + 1 + (Math.random() - 0.5) * spread * sp,
      vz: dir.z * sp + (Math.random() - 0.5) * spread * sp,
      age: 0, fromMob: false, kind: "player",
      dmg: Math.round(4 + 5 * charge), from: "player", crit: charge >= 1,
      byPlayer: true,
    });
    syncEnt(e);
    sfx("entity.arrow.shoot");
    // consume arrow + wear bow (whichever hand drew it)
    try {
      const v = inv(), s = v.main[ai];
      s.count = (s.count | 0) - 1;
      if (s.count <= 0) v.main[ai] = null;
    } catch (e) {}
    try { if (d.hand === "off") wearOff(1); else wearMain(1); } catch (e2) {}
    addExhaustion(0.1);
  } catch (e) {}
}
// --- v1.15.0 trident: hold to charge like the bow (engine animates the spear
// draw via usingItem), release with >=0.5 s to throw. The trident leaves the
// hand while flying (wear-then-stash-then-clear): loyalty returns the stashed
// stack to the hand, plain tridents drop it where they land. Riptide throws
// are skipped — the engine already launched the player in stopUsingItem.
function tridentInHand() {
  try { if (stackName(mainHeld()) === "trident") return "main"; } catch (e) {}
  try { if (stackName(offHeld()) === "trident") return "off"; } catch (e) {}
  return null;
}
function tridentWet() {
  // mirrors interaction.js _wetForRiptide (body water or rain at the player)
  try {
    const p = game().player;
    if (p && p.inWater) return true;
    const w = game().world;
    if (w && typeof w.isRainingAt === "function") {
      if (w.isRainingAt(p.x, p.y, p.z)) return true;
      try { if (w.isRainingAt(p.x, p.y + p.height, p.z)) return true; } catch (e) {}
    }
  } catch (e) {}
  return false;
}
function tridentTick() {
  if (!survives()) { SV.tridentDraw = null; return; }
  let using = false;
  try { using = !!(game().player && game().player.usingItem); } catch (e) {}
  const held = using ? tridentInHand() : null;
  if (held) {
    if (!SV.tridentDraw) SV.tridentDraw = { t: 0, hand: held };
    else { SV.tridentDraw.t += 0.1; SV.tridentDraw.hand = held; }
    return;
  }
  if (SV.tridentDraw) {
    const d = SV.tridentDraw;
    SV.tridentDraw = null;
    if (d.t >= 0.5) fireTrident(d);
  }
}
function fireTrident(d) {
  try {
    const g = game(), p = g.player;
    const v = inv();
    const get = d.hand === "off" ? () => offHeld() : () => mainHeld();
    const set = d.hand === "off" ? (s) => { v.offhand[0] = s; } : (s) => { v.main[game().heldSlot | 0] = s; };
    const s = get();
    if (!s || stackName(s) !== "trident") return;
    const lvl = (name) => { try { return game().items.enchantLevel(s, name) | 0; } catch (e) { return 0; } };
    if (lvl("riptide") > 0 && tridentWet()) return; // engine already ripped
    const loyalty = lvl("loyalty"), impaling = lvl("impaling"), channeling = lvl("channeling");
    // wear 1 without wiping the enchant NBT (wearStackAt rewrites nbt to Damage-only)
    let max = 0, dmg = 0;
    try { max = game().items.maxDurability(s.id) | 0; } catch (e) {}
    try { dmg = game().items.damage(s) | 0; } catch (e) {}
    if (max > 0 && dmg + 1 >= max) {
      try {
        s.count = (s.count | 0) - 1;
        if ((s.count | 0) <= 0) set(null);
      } catch (e) {}
      try { game().sound.play("entity.item.break"); } catch (e) {}
      return;
    }
    try {
      const raw = s.nbt;
      if (raw && raw.v && typeof raw.v === "object") { raw.v.Damage = { t: 3, v: dmg + 1 }; delete s._simple; delete s._simpleFor; }
      else setStackDmg(s, dmg + 1);
    } catch (e) { try { setStackDmg(s, dmg + 1); } catch (e2) {} }
    // stash the stack, then clear the hand: the trident flies, not the player
    const stash = { id: s.id, dmg: dmg + 1, nbt: s.nbt || null, stack: s };
    try { set(null); } catch (e) {}
    const id = SV.eidSeq++;
    const dir = lookDir();
    const sp = 15; // thrown-trident flight (slower than a full-draw arrow)
    // type 83 = index of 'trident' in ENTITY_REGISTRY_1152 (the engine's
    // OBJECT_TYPES space is registry indices, not legacy object ids — 94 is
    // the pre-1.14 object id and spawns a wolf here)
    const TRIDENT_OBJ = 83;
    try {
      g.entities.spawnObject({
        entityId: id, x: p.x, y: p.y + 1.5, z: p.z, yaw: 0, pitch: 0, type: TRIDENT_OBJ,
        objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
        velocity: { x: 0, y: 0, z: 0 }, metadata: {},
      });
    } catch (e) { try { set(stash.stack); } catch (e2) {} return; }
    const e = g.entities.get(id);
    if (!e) { try { set(stash.stack); } catch (e2) {} return; }
    SV.arrows.set(id, {
      id, e, x: p.x, y: p.y + 1.5, z: p.z, w: 0.5, h: 0.5,
      vx: dir.x * sp, vy: dir.y * sp + 1, vz: dir.z * sp,
      age: 0, fromMob: false, kind: "trident", dmg: 8, thrown: true,
      loyalty, impaling, channeling, hand: d.hand, stash,
    });
    syncEnt(e);
    sfx("item.trident.throw");
    addExhaustion(0.1);
  } catch (e) {}
}
function tridentImpact(a) {
  // block or mob hit on a non-returning flight
  if ((a.loyalty | 0) > 0) {
    a.returning = true; a.hitDone = true;
    try { sfx("item.trident.return"); } catch (e) {}
    return;
  }
  // no loyalty: drop the stashed trident where it landed (damage kept;
  // enchants are a known gap — tryPickup carries id/damage/count only)
  try {
    const st = a.stash;
    if (st) {
      const id = spawnItemEntity(a.x, a.y + 0.2, a.z, st.id, 1);
      if (id != null) {
        try {
          const rec = SV.items.get(id);
          if (rec && rec.e && rec.e.item) {
            rec.e.item.damage = st.dmg | 0;
            if (st.nbt) rec.e.item.nbt = st.nbt;
          }
        } catch (e) {}
      }
    }
    try { sfx("item.trident.hit_ground"); } catch (e) {}
  } catch (e) {}
  removeArrow(a.id);
}
function tridentReturnStep(a, dt) {
  // loyalty return flight: steer home, phase through blocks (vanilla)
  const g = game(), p = g.player;
  if (!p) { removeArrow(a.id); return; }
  const dx = p.x - a.x, dy = (p.y + 1) - a.y, dz = p.z - a.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1.6) { try { tridentReturnToPlayer(a); } catch (e) {} removeArrow(a.id); return; }
  const sp = 22;
  a.vx = dx / d * sp; a.vy = dy / d * sp; a.vz = dz / d * sp;
  const b = { x: a.x, y: a.y, z: a.z, w: a.w, h: a.h };
  physMove(b, a.vx * dt, a.vy * dt, a.vz * dt);
  a.x = b.x; a.y = b.y; a.z = b.z;
  if (!isFinite(a.x + a.y + a.z)) { removeArrow(a.id); return; }
  try {
    const e = a.e;
    e.x = e.newX = a.x; e.y = e.newY = a.y; e.z = e.newZ = a.z; e.inc = 2;
  } catch (err) {}
}
function tridentReturnToPlayer(a) {
  try {
    const st = a.stash;
    if (st && st.stack) {
      const v = inv();
      const slot = game().heldSlot | 0;
      if (v && v.main) {
        if (!v.main[slot]) v.main[slot] = st.stack;
        else {
          let idx = -1;
          for (let i = 0; i < v.main.length; i++) { if (!v.main[i]) { idx = i; break; } }
          if (idx >= 0) v.main[idx] = st.stack;
          else addPlayerItem(st.id, 1); // full: data loss accepted (documented)
        }
      }
    }
  } catch (e) {}
  try { sfx("entity.item.pickup"); } catch (e) {}
}
// --- fishing: single bobber (vanilla: one rod, one bobber; recast replaces)
const FISH_LOOT = {
  fish: [["cod", 60], ["salmon", 25], ["pufferfish", 13], ["tropical_fish", 2]],
  junk: [["bowl", 10], ["stick", 5], ["leather", 10], ["bone", 10], ["string", 5], ["rotten_flesh", 10]],
  treasure: [["bow", 1], ["book", 1], ["saddle", 1], ["name_tag", 1], ["nautilus_shell", 1]],
};
function pickWeighted(pairs) {
  let total = 0;
  const avail = [];
  for (const [nm, w] of pairs) {
    const id = itemIdByName(nm);
    if (id == null) continue;
    avail.push([id, w]); total += w;
  }
  if (!total) return null;
  let r = Math.random() * total;
  for (const [id, w] of avail) { r -= w; if (r <= 0) return id; }
  return avail[avail.length - 1][0];
}
function rodUse(hand) {
  // RMB with rod: reel the active bobber, else cast
  if (SV.bobber) { reelBobber(); return; }
  const g = game(), p = g.player;
  const id = SV.eidSeq++;
  try {
    const d = lookDir();
    g.entities.spawnObject({
      entityId: id, x: p.x, y: p.y + 1.5, z: p.z, yaw: 0, pitch: 0, type: 102,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return;
    SV.bobber = {
      id, e, x: p.x, y: p.y + 1.5, z: p.z,
      vx: d.x * 12, vy: d.y * 12 + 3, vz: d.z * 12,
      age: 0, state: "fly", hand,
      biteAt: 0, biteUntil: 0, floatY: 0,
    };
    syncEnt(e);
    sfx("entity.fishing_bobber.throw");
  } catch (err) {}
}
function reelBobber() {
  const b = SV.bobber;
  SV.bobber = null;
  if (!b) return;
  try { game().entities.destroy([b.id]); } catch (e) {}
  sfx("entity.fishing_bobber.retrieve");
  if (b.state === "bite") {
    // catch! vanilla: 85% fish / 10% junk / 5% treasure + 1-6 XP
    const r = Math.random();
    const id = r < 0.85 ? pickWeighted(FISH_LOOT.fish)
      : r < 0.95 ? pickWeighted(FISH_LOOT.junk) : pickWeighted(FISH_LOOT.treasure);
    if (id != null) addPlayerItem(id, 1);
    try {
      const p = game().player;
      for (const v of orbSplit(1 + ((Math.random() * 6) | 0))) spawnXPOrb(p.x, p.y + 0.5, p.z, v);
    } catch (e) {}
    try { if (b.hand === 1) wearOff(1); else wearMain(1); } catch (e2) {}
    addExhaustion(0.1);
  }
}
function bobberTick(dt) {
  const b = SV.bobber;
  if (!b) return;
  if (!survives()) { try { game().entities.destroy([b.id]); } catch (e) {} SV.bobber = null; return; }
  b.age += dt;
  if (b.age > 120) { reelBobber(); return; } // 2 min safety (vanilla bobbers persist, but ours must not leak)
  if (b.state === "fly") {
    b.vy = Math.max(b.vy - GRAV * dt, TERMINAL);
    const rec = { x: b.x, y: b.y, z: b.z, w: 0.3, h: 0.3 };
    const res = physMove(rec, b.vx * dt, b.vy * dt, b.vz * dt);
    b.x = rec.x; b.y = rec.y; b.z = rec.z;
    try { b.e.x = b.e.newX = b.x; b.e.y = b.e.newY = b.y; b.e.z = b.e.newZ = b.z; b.e.inc = 2; } catch (e) {}
    if (liquidAt(b.x, b.y, b.z) === "water") {
      // float: rise to the surface, splash, start the bite clock
      let sy = b.y;
      for (let i = 0; i < 10; i++) {
        if (liquidAt(b.x, sy + 0.3, b.z) === "water") sy += 0.2;
        else break;
      }
      b.floatY = sy; b.x = rec.x; b.y = sy; b.z = rec.z;
      b.state = "float";
      // vanilla: rain on open water bites sooner (~-25% wait when sky-exposed)
      let wait = 5000 + Math.random() * 10000;
      try { if (isRainingAt(b.x, b.y + 0.5, b.z)) wait *= 0.75; } catch (e) {}
      b.biteAt = Date.now() + wait;
      try { game().particles.splash(b.x, b.y, b.z, 10); } catch (e) {}
      sfx("entity.fishing_bobber.splash");
    } else if (res.ground || res.hitX || res.hitZ) {
      b.state = "stuck"; // beached: reel to clear (no catch, no wear)
    }
    return;
  }
  // float / bite / stuck: ride the surface, countdown to a bite
  try {
    if (b.state === "float" && liquidAt(b.x, b.y - 0.1, b.z) === "water") b.y = b.floatY;
    b.e.x = b.e.newX = b.x; b.e.y = b.e.newY = b.y; b.e.z = b.e.newZ = b.z; b.e.inc = 2;
  } catch (e) {}
  if (b.state === "float" && Date.now() >= b.biteAt) {
    b.state = "bite";
    b.biteUntil = Date.now() + 1000;
    try { game().particles.splash(b.x, b.y, b.z, 6); } catch (e) {}
    sfx("entity.fishing_bobber.splash");
  } else if (b.state === "bite" && Date.now() > b.biteUntil) {
    b.state = "float";
    let wait = 5000 + Math.random() * 10000;
    try { if (isRainingAt(b.x, b.y + 0.5, b.z)) wait *= 0.75; } catch (e) {}
    b.biteAt = Date.now() + wait;
  }
}

/* ---------------------------------------------------------- experience orbs
 * Rendered natively via the engine's own spawnXpOrb path. Values split by
 * vanilla orb sizes; attracted within ~6 blocks (approximation — the wiki
 * Behavior section is transcluded and wouldn't extract), 5-min despawn, merge.
 */
function spawnXPOrb(x, y, z, value) {
  const g = game();
  value = Math.max(0, Math.round(value));
  if (!value) return null;
  const id = SV.eidSeq++;
  try {
    g.entities.spawnXpOrb({ entityId: id, x, y, z, count: value });
    const e = g.entities.get(id);
    if (!e) return null;
    SV.orbs.set(id, {
      id, e, x, y, z,
      vx: (Math.random() - 0.5) * 2, vy: 3 + Math.random() * 2, vz: (Math.random() - 0.5) * 2,
      age: 0, value, mergeAcc: 0,
    });
    syncEnt(e);
    return id;
  } catch (err) { return null; }
}

function removeOrb(id) {
  try { SV.orbs.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}

function orbTick(rec, dt) {
  const g = game(), p = g.player;
  const e = rec.e;
  rec.age += dt;
  if (rec.age > 300) { removeOrb(rec.id); return; } // 5 min despawn
  let ax = 0, ay = 0, az = 0;
  try {
    if (p && !SV.dead) {
      const dx = p.x - e.x, dy = (p.y + 0.8) - e.y, dz = p.z - e.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 6 && d > 0.01) {
        // attracted: accelerate toward the player, capped
        const pull = 40 * dt;
        ax = (dx / d) * pull; ay = (dy / d) * pull; az = (dz / d) * pull;
      }
      if (d < 1.0) {
        addXP(rec.value);
        try { g.sound.play("entity.experience_orb.pickup"); } catch (err) {}
        removeOrb(rec.id);
        return;
      }
    }
  } catch (err) {}
  // resting on solid ground with no pull: gravity already balanced (see
  // mobTick note) — skip so the physMove cache can reuse the sweep.
  // (Gravity moved below the pull computation; addition commutes, EXACT.)
  if (!(rec._ground && rec.vy === 0 && ax === 0 && ay === 0 && az === 0)) rec.vy = Math.max(rec.vy - GRAV * dt, TERMINAL);
  rec.vx += ax; rec.vy += ay; rec.vz += az;
  const sp = Math.sqrt(rec.vx * rec.vx + rec.vz * rec.vz);
  if (sp > 8) { rec.vx *= 8 / sp; rec.vz *= 8 / sp; }
  const b = rec._box || (rec._box = { x: 0, y: 0, z: 0, w: 0.4, h: 0.4 });
  b.x = e.x; b.y = e.y; b.z = e.z; b.w = 0.4; b.h = 0.4; // persistent box: feeds the physMove resting-contact cache
  const res = physMove(b, rec.vx * dt, rec.vy * dt, rec.vz * dt);
  e.x = b.x; e.y = b.y; e.z = b.z;
  rec._ground = res.ground;
  if (res.ground) { rec.vy = 0; rec.vx *= 0.7; rec.vz *= 0.7; }
  // merge with nearby orbs every 2s (flag: forEach can't break, and an
  // already-merged rec must not donate its value twice — that inflated
  // dragon purse totals in live testing)
  rec.mergeAcc += dt;
  if (rec.mergeAcc > 2) {
    rec.mergeAcc = 0;
    try {
      let merged = false;
      SV.orbs.forEach((o) => {
        if (merged || o.id === rec.id || !o.e || !rec.e) return;
        if (Math.abs(o.e.x - e.x) > 0.8 || Math.abs(o.e.y - e.y) > 0.8 || Math.abs(o.e.z - e.z) > 0.8) return;
        o.value += rec.value;
        merged = true;
        removeOrb(rec.id);
      });
      if (!SV.orbs.has(rec.id)) return;
    } catch (err) {}
  }
  syncEnt(e);
}

function addXP(n) {
  SV.xpTotal = Math.max(0, (SV.xpTotal | 0) + (n | 0));
  let lvl = SV.xpLevel | 0;
  while (SV.xpTotal >= xpTotalForLevel(lvl + 1) && lvl < 200) lvl++;
  if (lvl > SV.xpLevel) {
    SV.xpLevel = lvl;
    sfx("entity.player.levelup");
  }
  syncXP();
}

function deductXPLevels(k) {
  // vanilla addExperienceLevels(-k): levels drop, bar fraction preserved
  try {
    let lvl = SV.xpLevel | 0;
    const base0 = xpTotalForLevel(lvl), next0 = xpTotalForLevel(lvl + 1);
    const frac = next0 > base0 ? clamp((SV.xpTotal - base0) / (next0 - base0), 0, 1) : 0;
    lvl = Math.max(0, lvl - (k | 0));
    SV.xpLevel = lvl;
    const base = xpTotalForLevel(lvl), next = xpTotalForLevel(lvl + 1);
    SV.xpTotal = Math.round(base + frac * Math.max(0, next - base));
    syncXP();
  } catch (e) {}
}

function syncXP() {
  try {
    const g = game();
    if (!g) return;
    g.xpTotal = SV.xpTotal | 0;
    g.xpLevel = SV.xpLevel | 0;
    const base = xpTotalForLevel(SV.xpLevel), next = xpTotalForLevel(SV.xpLevel + 1);
    g.xpBar = next > base ? clamp((SV.xpTotal - base) / (next - base), 0, 1) : 0;
  } catch (e) {}
}

/* Engine-shot player arrows: the client renders them itself (a server would
 * confirm damage); offline nothing applies damage, so we track fresh arrows
 * and let them hurt our mobs once each. The visual stays engine-owned.
 * Detection is by entity name scan (robust to however the engine spawns
 * them) plus a spawnObject hook as backup.
 */
function trackPlayerArrows(dt) {
  const g = game();
  if (!SV.trackedArrows) SV.trackedArrows = new Map();
  // census: learn engine entity names (debug aid, capped)
  try {
    if (!SV.entityCensus) SV.entityCensus = {};
    g.entities.map.forEach((e) => {
      const n = e.entityName || e.typeName || ("t" + e.type);
      if (!SV.entityCensus[n]) SV.entityCensus[n] = 0;
      SV.entityCensus[n]++;
    });
  } catch (e) {}
  // adopt any engine arrow near the player that isn't one of ours
  try {
    if (SV.trackedArrows.size < 12) {
      const p = g.player;
      g.entities.map.forEach((e) => {
        if (SV.trackedArrows.size >= 12) return;
        if (!e || e.entityName !== "arrow") return;
        if (SV.arrows.has(e.id) || SV.trackedArrows.has(e.id)) return;
        const dx = e.x - p.x, dz = e.z - p.z;
        if (dx * dx + dz * dz > 144) return;
        SV.trackedArrows.set(e.id, { id: e.id, age: 0, lx: null, ly: null, lz: null });
      });
    }
  } catch (e) {}
  SV.trackedArrows.forEach((t, id) => {
    let e = null;
    try { e = g.entities.get(id); } catch (err) {}
    if (!e) { SV.trackedArrows.delete(id); return; }
    const vx = (e.x - (t.lx == null ? e.x : t.lx)) / dt;
    const vy = (e.y - (t.ly == null ? e.y : t.ly)) / dt;
    const vz = (e.z - (t.lz == null ? e.z : t.lz)) / dt;
    t.lx = e.x; t.ly = e.y; t.lz = e.z;
    t.age = (t.age || 0) + dt;
    if (t.age > 8) { SV.trackedArrows.delete(id); return; }
    if (t.hitDone) return;
    try {
      let hit = null;
      SV.mobs.forEach((m) => {
        if (hit) return;
        const mdx = m.x - e.x, mdz = m.z - e.z;
        if (mdx * mdx + mdz * mdz > 1.2) return;
        if (Math.abs((m.y + m.h / 2) - e.y) > m.h) return;
        hit = m;
      });
      if (hit) {
        t.hitDone = true;
        let dmg = 4;
        if (typeof e.damage === "number") dmg = e.damage;
        else if (typeof e.dmg === "number") dmg = e.dmg;
        else {
          const spd = Math.sqrt(vx * vx + vy * vy + vz * vz);
          dmg = clamp(Math.round(1 + spd * 0.22), 1, 11);
        }
        SV.arrowProbe = { dmg, spd: Math.sqrt(vx * vx + vy * vy + vz * vz) | 0, keys: Object.keys(e).slice(0, 20) };
        damageMob(hit.id, dmg, vx, vz, { byArrow: true, byArrowPlayer: true, from: "player" });
      }
    } catch (err) {}
  });
}

/* ---------------------------------------------------------- items tick */

function itemTick(rec, dt) {
  const e = rec.e;
  rec.age += dt;
  if (rec.age > 300) { removeItem(rec.id); return; } // 5 min despawn
  // vanilla: items burn in fire/lava (lava was already fatal)
  try {
    const bn = blockNameAt(e.x, e.y + 0.1, e.z);
    if (bn === "lava" || bn === "fire") { removeItem(rec.id); return; }
  } catch (err) {}
  // vanilla merging: stackable same-type items within a 0.5 box combine
  rec.mergeAcc = (rec.mergeAcc || 0) + dt;
  if (rec.mergeAcc > 2) {
    rec.mergeAcc = 0;
    try {
      SV.items.forEach((o) => {
        if (o.id === rec.id || !o.e || !o.e.item || !rec.e.item) return;
        if (o.e.item.id !== rec.e.item.id) return;
        if (Math.abs(o.e.x - e.x) > 0.5 || Math.abs(o.e.y - e.y) > 0.5 || Math.abs(o.e.z - e.z) > 0.5) return;
        const room = 64 - (o.e.item.count || 1);
        const move = Math.min(room, rec.e.item.count || 1);
        if (move > 0) {
          o.e.item.count += move; rec.e.item.count -= move;
          if (rec.e.item.count <= 0) removeItem(rec.id);
        }
      });
      if (!SV.items.has(rec.id)) return;
    } catch (err) {}
  }
  const liq = liquidAt(rec.e.x, rec.e.y, rec.e.z);
  if (liq === "water") {
    rec.vy = Math.max(rec.vy - 0.3, -1.5);
    rec.vx *= 0.9; rec.vz *= 0.9;
  } else if (liq === "lava") { removeItem(rec.id); return; }
  // resting on solid ground: gravity is already balanced (see mobTick note).
  // Skipping keeps displacement ~zero for the physMove cache. rec._ground is
  // last tick's sweep result; any world edit invalidates the cache via _colGen.
  else if (!(rec._ground && rec.vy === 0)) rec.vy = Math.max(rec.vy - GRAV * dt, TERMINAL);
  const b = rec._box || (rec._box = { x: 0, y: 0, z: 0, w: 0.4, h: 0.4 });
  b.x = e.x; b.y = e.y; b.z = e.z; b.w = 0.4; b.h = 0.4; // persistent box: feeds the physMove resting-contact cache
  const res = physMove(b, rec.vx * dt, rec.vy * dt, rec.vz * dt);
  e.x = b.x; e.y = b.y; e.z = b.z;
  rec._ground = res.ground;
  if (res.ground) { rec.vy = 0; rec.vx *= 0.7; rec.vz *= 0.7; }
  syncEnt(e);
  tryPickup(rec);
}

/* ---------------------------------------------------------- master tick (10 Hz) */

function masterTick() {
  if (!survivesLoose()) return;
  SV.tickN = (SV.tickN | 0) + 1; // world-time-independent tick clock (B2 restock)
  const dt = 0.1;
  try { envTick(dt); } catch (e) {}
  if (SV.dead) return;
  try {
    SV.mobs.forEach((m) => { try { mobTick(m, dt); } catch (e) {} });
  } catch (e) {}
  try { sweepCorpses(); } catch (e) {} // v1.12 death-animation cleanup
  try {
    // values() snapshot: same visit semantics as before (entries added or
    // removed mid-loop behave exactly as they did under keys()+get), minus
    // the key array and the per-entry map lookup.
    for (const rec of Array.from(SV.items.values())) {
      if (rec) { try { itemTick(rec, dt); } catch (e) {} }
    }
  } catch (e) {}
  try {
    for (const a of Array.from(SV.arrows.values())) {
      if (a) { try { arrowTick(a, dt); } catch (e) {} }
    }
  } catch (e) {}
  try { eyeTick(dt); } catch (e) {}
  try {
    for (const o of Array.from(SV.orbs.values())) {
      if (o) { try { orbTick(o, dt); } catch (e) {} }
    }
  } catch (e) {}
  try {
    if (SV.tnt) {
      for (const r of Array.from(SV.tnt.values())) {
        if (r) { try { tntTick(r, dt); } catch (e) {} }
      }
    }
  } catch (e) {}
  // --- tiles tick (furnaces smelt even with the UI closed)
  try { tilesTick(dt); } catch (e) {}
  // --- momentary buttons release themselves
  try { pressTick(); } catch (e) {}
  try { rsTick(); } catch (e) {} // v1.11: redstone delays + propagation
  try { pistTick(); } catch (e) {} // v1.13: piston settle/repair/watchdog/shove
  // --- open container tracking: Esc clears the window natively; save back
  try {
    if (SV.openTile && (!game().window || game().window.windowId !== SV.openTile.wid)) {
      saveOpenTile();
    }
  } catch (e) { try { SV.openTile = null; } catch (e2) {} }
  try { trackPlayerArrows(dt); } catch (e) {}
  try { bowTick(); } catch (e) {}
  try { tridentTick(); } catch (e) {} // v1.15.0: player-thrown trident charge/throw
  try { bobberTick(dt); } catch (e) {}
  try { boatTick(dt); } catch (e) {}
  try { cartTick(dt); } catch (e) {}
  try { horseTick(dt); } catch (e) {}
  try { standTick(dt); } catch (e) {}
  try { cropTick(dt); } catch (e) {}
  try { hiveTick(dt); } catch (e) {} // v1.10: hive exits + break reconciliation
  try { tradeTick(); } catch (e) {} // B2: merchant commit/result/restock
  if ((SV.tickN | 0) % 20 === 0) { try { conduitTick(); } catch (e) {} try { frogspawnTick(); } catch (e2) {} try { shriekerTick(); } catch (e3) {} } // v1.15.0: conduit power/zap (2s cadence); P4: frogspawn hatch + shrieker summons
  try { directorTick(); } catch (e) {}
  try { dimWatchTick(); } catch (e) {} // v1.16.0: End entry (dragon seeding)
  try { cloudTick(dt); } catch (e) {} // v1.16.0: breath clouds damage/shrink
  // persist hp/food + item entities with the world
  try { persistSurvState(); } catch (e) {}
}

let persistAcc = 0;
function persistSurvState() {
  persistAcc += 0.1;
  if (persistAcc < 10) return;
  persistAcc = 0;
  // never overwrite the record before entry restore ran (SV.on): a live but
  // not-yet-restored session holds empty tables and would clobber good data.
  if (!SV.on) return;
  try {
    const sp = SP();
    if (!sp || !sp.active || !sp.id) return;
    const rec = loadWorldRecSv(sp.id);
    if (!rec) return;
    rec.hp = getHP();
    rec.food = getFood();
    try { rec.sat = getSat(); } catch (e) {}
    rec.exh = SV.exh;
    rec.xpLevel = SV.xpLevel | 0;
    rec.xpTotal = SV.xpTotal | 0;
    const items = [];
    SV.items.forEach((it) => {
      if (it.e && it.e.item && it.e.item.id && items.length < 60) {
        items.push({ x: +it.e.x.toFixed(1), y: +it.e.y.toFixed(1), z: +it.e.z.toFixed(1), id: it.e.item.id, c: it.e.item.count || 1 });
      }
    });
    rec.items = items;
    const boats = [];
    SV.boats.forEach((b) => {
      if (b.e && boats.length < 20) {
        const r = { v: b.variant | 0, x: +b.e.x.toFixed(1), y: +b.e.y.toFixed(1), z: +b.e.z.toFixed(1) };
        // P4: chest flag + contents (contents ride the boat record so the
        // "boat:N" tile key mismatch on restore doesn't strand items).
        if (b.chest) {
          r.chest = 1;
          try {
            const t = SV.tiles && SV.tiles.get("boat:" + b.id);
            if (t && t.items) {
              r.items = t.items.map((s) => s && s.id ? { id: s.id, c: s.count | 0 || 1, n: s.nbt || null } : null);
            }
          } catch (e2) {}
        }
        boats.push(r);
      }
    });
    rec.boats = boats;
    const carts = [];
    SV.carts.forEach((c) => {
      if (c.e && carts.length < 20) {
        const r = { v: c.variant | 0, x: +c.e.x.toFixed(1), y: +c.e.y.toFixed(1), z: +c.e.z.toFixed(1), fuel: c.fuel | 0 || 0 };
        if (c.variant === 1 || c.variant === 5) {
          try {
            const t = SV.tiles && SV.tiles.get("cart:" + c.id);
            r.items = (t && t.items ? t.items : []).map((s) => s ? { id: s.id, c: s.count | 0, n: s.nbt || null } : null);
          } catch (e) {}
        }
        carts.push(r);
      }
    });
    rec.carts = carts;
    const horses = [];
    SV.horses.forEach((h) => {
      if (horses.length < 20) horses.push({
        sp: h.species, x: +h.x.toFixed(1), y: +h.y.toFixed(1), z: +h.z.toFixed(1),
        hp: Math.round(h.hp), mhp: h.maxHp | 0, speed: +h.speed.toFixed(2), jumpV: +h.jumpV.toFixed(2),
        tame: h.tame ? 1 : 0, temper: h.temper | 0, mtem: h.maxTemper | 0,
        saddle: h.saddle ? 1 : 0, armor: h.armor || null, chest: h.chested ? 1 : 0,
        str: h.strength | 0, v: h.variant | 0, grow: h.growT | 0,
        items: (() => { try { const t = SV.tiles && SV.tiles.get("horse:" + h.id); return (t && t.items ? t.items : []).map((s) => s ? { id: s.id, c: s.count | 0, n: s.nbt || null } : null); } catch (e) { return []; } })(),
      });
    });
    rec.horses = horses;
    const stands = [];
    SV.stands.forEach((s) => {
      if (s.e && stands.length < 20) stands.push({
        x: +s.e.x.toFixed(1), y: +s.e.y.toFixed(1), z: +s.e.z.toFixed(1), yaw: Math.round(s.yaw || 0),
        gear: (s.gear || []).map((gg) => gg && gg.id ? { id: gg.id, c: 1 } : null),
        name: s.name || null,
      });
    });
    rec.stands = stands;
    try {
      // B2: villager trade records, keyed by village+house slot (stable:
      // seed order is deterministic and villages are pure of seed)
      const vt = {};
      SV.mobs.forEach((m) => {
        if (m.species === "villager" && m.trade && m.trade.offers && m.trade.offers.length) {
          const k = vtTradeKey(m);
          if (k) { const p = vtPackTrade(m.trade); if (p) { p.prof = vtProfName(m); vt[k] = p; } }
        }
      });
      rec.vtrade = vt;
    } catch (e) {}
    try { persistTiles(rec); } catch (e) {}
    try {
      // v1.15.0: placed conduits (frame validated live on tick)
      const cd = [];
      if (SV.conduits) SV.conduits.forEach((c) => {
        if (c && cd.length < 20) cd.push({ x: c.x | 0, y: c.y | 0, z: c.z | 0 });
      });
      rec.conduits = cd;
    } catch (e) {}
    try {
      // P4: laid frogspawn (hatch validated live on tick)
      const fs = [];
      if (SV.frogspawn) SV.frogspawn.forEach((c) => {
        if (c && fs.length < 40) fs.push({ x: c.x | 0, y: c.y | 0, z: c.z | 0, until: c.until | 0 });
      });
      rec.frogspawn = fs;
    } catch (e) {}
    try { persistHives(rec); } catch (e) {} // v1.10: inside-bee rosters
    try { if (SV.wx) rec.wx = { r: SV.wx.rain ? 1 : 0, t: SV.wx.thunder ? 1 : 0, rt: SV.wx.rainT | 0, tt: SV.wx.thunderT | 0 }; } catch (e) {}
    try { rec.pistJ = SV.pistJ.length ? SV.pistJ.slice(-8) : []; } catch (e) {} // v1.13: move journal (entry repair)
    try { rec.omen = SV.omen && omenLevel() > 0 ? { lvl: SV.omen.lvl, until: SV.omen.until } : null; } catch (e) {} // v1.14
    try { rec.patrolT = SV.patrolT | 0; } catch (e) {} // v1.14
    try { rec.traderT = SV.traderT | 0; } catch (e) {} // v1.14 Phase D
    try { rec.knots = (SV.knots || []).map((k) => ({ key: k.key, x: +k.x.toFixed(1), y: +k.y.toFixed(1), z: +k.z.toFixed(1) })); } catch (e) {} // v1.14 Phase D
    try { rec.raid = SV.raid ? { cx: SV.raid.cx, cz: SV.raid.cz, r: SV.raid.r, top: SV.raid.top, wave: SV.raid.wave, total: SV.raid.total, heroLvl: SV.raid.heroLvl } : null; } catch (e) {} // v1.14 Phase C
    try { rec.hero = SV.hero && SV.hero.until > Date.now() ? { lvl: SV.hero.lvl, until: SV.hero.until } : null; } catch (e) {} // v1.14 Phase C
    try { if (SV.deathPos) rec.deathPos = { x: SV.deathPos.x, y: SV.deathPos.y, z: SV.deathPos.z, dim: SV.deathPos.dim | 0 }; } catch (e) {} // P4: recovery compass
    rec.svIds = 1152; // native 1.15.2 item ids; older stamps get remapped on restore
    saveWorldRecSv(sp.id, rec);
  } catch (e) {}
}

// localStorage access without touching singleplayer's privates.
// v3 keys (native 1.15.2 ids) — the 1.13.2 v2 line is gone; restores of
// pre-port worlds remap old item ids via remapSvIds() below.
function svLSKey(id) { return "mcjs.sp.v3.world." + id; }
function loadWorldRecSv(id) {
  try {
    const raw = localStorage.getItem(svLSKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function saveWorldRecSv(id, rec) {
  try { localStorage.setItem(svLSKey(id), JSON.stringify(rec)); }
  catch (e) { return false; }
  // singleplayer caches records in memFallback: drop it so its next
  // loadWorldRec (e.g. inside saveNow/autosave) re-reads this payload
  // instead of clobbering LS with the entry-time snapshot.
  try { if (globalThis.__mcSingleplayer && globalThis.__mcSingleplayer.dropCache) globalThis.__mcSingleplayer.dropCache(id); } catch (e) {}
  return true;
}
// one-way migration for survival payloads written by the 1.13.2 line
// (v2 records carried into v3 by singleplayer's migrateV2Rec, which only
// converts overrides + inventory): remap persisted numeric ITEM ids through
// compat.json. Live lookups always use names, so only these stored ids need it.
function remapSvIds(rec) {
  try {
    if (!rec || rec.svIds === 1152) return;
    const C = globalThis.__mcCompat;
    if (!C || !C.items) return;
    const f = (id) => (id != null && C.items[id] != null ? C.items[id] : id);
    const arr = (a) => Array.isArray(a) ? a.map((s) => s ? Object.assign({}, s, { id: f(s.id) }) : s) : a;
    if (Array.isArray(rec.items)) rec.items = rec.items.map((it) => it ? Object.assign({}, it, { id: f(it.id) }) : it);
    if (Array.isArray(rec.carts)) rec.carts = rec.carts.map((c) => c && c.items ? Object.assign({}, c, { items: arr(c.items) }) : c);
    if (Array.isArray(rec.horses)) rec.horses = rec.horses.map((h) => h && h.items ? Object.assign({}, h, { items: arr(h.items) }) : h);
    if (rec.vtrade) {
      // B2 trade offers carry numeric item ids too
      for (const k in rec.vtrade) {
        const p = rec.vtrade[k];
        if (p && Array.isArray(p.offers)) for (const s of p.offers) {
          if (s) { s.w = f(s.w); s.g = f(s.g); if (s.w2) s.w2 = f(s.w2); }
        }
      }
    }
    if (Array.isArray(rec.tiles)) {
      for (const t of rec.tiles) { if (t && Array.isArray(t.items)) t.items = arr(t.items); }
    }
    rec.svIds = 1152;
  } catch (e) {}
}
function restoreSurvState() {
  try {
    const sp = SP();
    if (!sp || !sp.id) return;
    const rec = loadWorldRecSv(sp.id);
    if (!rec) return;
    try { remapSvIds(rec); } catch (e) {}
    if (rec.hp != null) setHP(rec.hp > 0 ? rec.hp : 20); // a 0-hp save means "died": wake up fresh, not corpse-walking
    if (rec.food != null) setFood(rec.food);
    if (rec.sat != null) setSat(rec.sat);
    if (rec.exh != null) SV.exh = rec.exh;
    if (rec.xpLevel != null) SV.xpLevel = rec.xpLevel | 0;
    if (rec.xpTotal != null) SV.xpTotal = rec.xpTotal | 0;
    try { syncXP(); } catch (e) {}
    SV.savedItems = rec.items || null;
    SV.savedBoats = rec.boats || null;
    try {
      // v1.14: Bad Omen + patrol clock survive reloads (wall-clock expiry,
      // so a long-away save simply wakes clean — documented in the header)
      if (rec.omen && rec.omen.until > Date.now()) SV.omen = { lvl: rec.omen.lvl | 0, until: rec.omen.until };
      if (rec.patrolT != null) SV.patrolT = rec.patrolT | 0;
      // v1.14 Phase D: trader clock survives; knot posts restore bare (mobs
      // never persist, so hitches don't — knotTick respawns the entities)
      try { if (rec.traderT != null) SV.traderT = rec.traderT | 0; } catch (e) {}
      try {
        SV.knots = [];
        if (Array.isArray(rec.knots)) for (const k of rec.knots.slice(0, 12)) {
          if (k && k.key) SV.knots.push({ key: String(k.key), x: +k.x || 0, y: (+k.y || 0), z: +k.z || 0, eid: null, mobs: [] });
        }
      } catch (e) { try { SV.knots = []; } catch (e2) {} }
      // v1.14 Phase C: raids + hero survive reloads (wall-clock hero expiry;
      // the wiped wave replays — raiders are never persisted, see the header)
      try { if (rec.hero && rec.hero.until > Date.now()) SV.hero = { lvl: rec.hero.lvl | 0 || 1, until: rec.hero.until }; } catch (e) {}
      // P4: recovery compass target survives reloads.
      try { SV.deathPos = rec.deathPos ? { x: rec.deathPos.x, y: rec.deathPos.y, z: rec.deathPos.z, dim: rec.deathPos.dim | 0 } : null; } catch (e) {}
      try {
        if (rec.raid && rec.raid.total > 0) {
          SV.raid = { cx: rec.raid.cx, cz: rec.raid.cz, r: rec.raid.r || 16, top: rec.raid.top || 70, wave: Math.max(0, (rec.raid.wave | 0) - 1), total: rec.raid.total | 0, heroLvl: rec.raid.heroLvl | 0 || 1, nextT: (SV.tickN | 0) + 50, size: 1 };
          raidBar(0, 1, "Raid - Wave " + Math.min(SV.raid.total, SV.raid.wave + 1) + "/" + SV.raid.total);
        }
      } catch (e) { try { SV.raid = null; } catch (e2) {} }
    } catch (e) {}
    SV.savedCarts = rec.carts || null;
    SV.savedHorses = rec.horses || null;
    SV.savedStands = rec.stands || null;
    try { restoreTiles(rec); } catch (e) {}
    try {
      // v1.15.0: conduit watch-set (blocks persist as world diffs)
      SV.conduits = new Map();
      if (Array.isArray(rec.conduits)) for (const c of rec.conduits.slice(0, 20)) {
        if (c && isFinite(c.x) && isFinite(c.y) && isFinite(c.z)) {
          SV.conduits.set((c.x | 0) + "," + (c.y | 0) + "," + (c.z | 0), { x: c.x | 0, y: c.y | 0, z: c.z | 0 });
        }
      }
    } catch (e) { try { SV.conduits = new Map(); } catch (e2) {} }
    try {
      SV.frogspawn = new Map();
      if (Array.isArray(rec.frogspawn)) for (const c of rec.frogspawn.slice(0, 40)) {
        if (c && isFinite(c.x) && isFinite(c.y) && isFinite(c.z)) {
          SV.frogspawn.set((c.x | 0) + "," + (c.y | 0) + "," + (c.z | 0),
            { x: c.x | 0, y: c.y | 0, z: c.z | 0, until: c.until | 0 || Date.now() + 300000 });
        }
      }
    } catch (e) { try { SV.frogspawn = new Map(); } catch (e2) {} }
    try { restoreHives(rec); } catch (e) {} // v1.10: inside-bee rosters
    try { rescanWiresFromOverrides(); } catch (e) {} // v1.11: redstone watch-set (states persist as diffs)
    try { SV.pistJ = Array.isArray(rec.pistJ) ? rec.pistJ.slice(-8) : []; } catch (e) { SV.pistJ = []; } // v1.13: ghosts repair in pistTick
    try {
      if (rec.wx) SV.wx = { rain: !!rec.wx.r, thunder: !!rec.wx.t, rainT: rec.wx.rt || 600, thunderT: rec.wx.tt || 0, strikeAt: 8 };
      else SV.wx = null;
      pushWeatherToEngine(1);
    } catch (e) {}
  } catch (e) {}
}
function respawnSavedItems() {
  if (!SV.savedItems) return;
  const items = SV.savedItems;
  SV.savedItems = null;
  for (const it of items.slice(0, 60)) {
    try { spawnItemEntity(it.x, it.y, it.z, it.id, it.c); } catch (e) {}
  }
}

/* ---------------------------------------------------------- phase-2 parity:
 * block use, shields/totems, durability (NBT {t:10,v:{Damage:{t:3,v:n}}}) */

function stackDmg(s) {
  try { return (s && s.id && game().items) ? (game().items.damage(s) | 0) : 0; } catch (e) { return 0; }
}
function setStackDmg(s, n) {
  try { s.nbt = { t: 10, v: { Damage: { t: 3, v: Math.max(0, n | 0) } } }; } catch (e) {}
  try { delete s._simple; } catch (e) {}
  return s;
}
// wear a stack by n; returns false if it broke (slot cleared)
function wearStackAt(get, set, n) {
  let s = null;
  try { s = get(); } catch (e) { return true; }
  if (!s || !s.id) return true;
  let max = 0, dmgable = false;
  try { max = game().items.maxDurability(s.id) | 0; dmgable = game().items.isDamageable(s); } catch (e) {}
  if (!max || !dmgable) return true;
  const d = stackDmg(s) + n;
  if (d >= max) {
    try {
      s.count = (s.count | 0) - 1;
      if (s.count <= 0) set(null);
      else setStackDmg(s, 0);
    } catch (e) { try { set(null); } catch (e2) {} }
    try { game().sound.play("entity.item.break"); } catch (e) {}
    return false;
  }
  setStackDmg(s, d);
  return true;
}
function inv() { try { return game().inventory; } catch (e) { return null; } }
function mainHeld() {
  try {
    const v = inv(); if (!v || !v.main) return null;
    return v.main[game().heldSlot | 0] || null;
  } catch (e) { return null; }
}
function offHeld() { try { const v = inv(); return (v && v.offhand && v.offhand[0]) || null; } catch (e) { return null; } }
function wearMain(n) {
  const v = inv(); if (!v) return true;
  const slot = game().heldSlot | 0;
  return wearStackAt(() => v.main[slot], (s) => { v.main[slot] = s; }, n);
}
function wearOff(n) {
  const v = inv(); if (!v) return true;
  return wearStackAt(() => v.offhand[0], (s) => { v.offhand[0] = s; }, n);
}
function wearWornArmor(n) {
  // vanilla: every worn piece takes durability on a damaging hit
  try {
    const v = inv(), worn = (v && v.armor) || [];
    for (let i = 0; i < worn.length; i++) {
      wearStackAt(((j) => () => worn[j]) (i), ((j) => (s) => { worn[j] = s; })(i), n);
    }
  } catch (e) {}
}
function isShieldStack(s) {
  if (!s || !s.id) return false;
  try { const d = game().items.def(s.id); return !!d && d.name === "shield"; } catch (e) { return false; }
}
function blockingWith() {
  // vanilla: actively blocking (RMB held) with a shield in either hand.
  // The engine never sets usingItem for shields offline (its use packet is
  // dead), so we track the physical button ourselves; usingItem covers any
  // path where the engine does engage.
  let held = false;
  try { held = !!(game().player && game().player.usingItem); } catch (e) {}
  try { held = held || !!SV.rmb; } catch (e) {}
  if (!held) return null;
  try { if (isShieldStack(mainHeld())) return "main"; } catch (e) {}
  try { if (isShieldStack(offHeld())) return "off"; } catch (e) {}
  return null;
}
function totemIn(hand) {
  try {
    const s = hand === "off" ? offHeld() : mainHeld();
    if (!s || (s.count | 0) < 1) return false;
    const d = game().items.def(s.id);
    return !!d && d.name === "totem_of_undying";
  } catch (e) { return false; }
}
function consumeOne(get, set) {
  try {
    const s = get();
    if (!s) return false;
    s.count = (s.count | 0) - 1;
    if (s.count <= 0) set(null);
    return true;
  } catch (e) { return false; }
}
// add loose items to the player (merge, empty slot, else drop as entity)
function addPlayerItem(id, count) {
  count = count | 0;
  if (!(id > 0) || count <= 0) return;
  try {
    const v = inv(); if (!v || !v.main) return;
    let max = 64;
    try { max = game().items.maxStack(id) | 0 || 64; } catch (e) {}
    for (let i = 0; i < v.main.length && count > 0; i++) {
      const s = v.main[i];
      if (s && s.id === id && !s.nbt && (s.count | 0) < max) {
        const room = max - (s.count | 0), mv = Math.min(room, count);
        s.count = (s.count | 0) + mv; count -= mv;
      }
    }
    for (let i = 0; i < v.main.length && count > 0; i++) {
      if (!v.main[i]) {
        const mv = Math.min(max, count);
        v.main[i] = { id, count: mv }; count -= mv;
      }
    }
  } catch (e) {}
  while (count > 0) {
    try {
      const p = game().player;
      spawnItemEntity(p.x, p.y + 1, p.z, id, Math.min(64, count));
    } catch (e) { break; }
    count -= Math.min(64, count);
  }
}

// --- primed TNT (unified id 59, kind "tnt", rendered natively; 4s fuse, power 4, chains) ---
function spawnPrimedTNT(x, y, z) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnObject({
      entityId: id, x, y: y + 0.2, z, yaw: 0, pitch: 0, type: 59, objectData: 0,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    const rec = { id, e, x, y: y + 0.2, z, vx: (Math.random() - 0.5) * 2, vy: 3, vz: (Math.random() - 0.5) * 2, fuse: 4.0, w: 0.9, h: 0.9, ground: false };
    SV.tnt = SV.tnt || new Map();
    SV.tnt.set(id, rec);
    try { g.sound.play("entity.tnt.primed"); } catch (err) {}
    syncEnt(e);
    return rec;
  } catch (err) { return null; }
}
function tntTick(rec, dt) {
  rec.fuse -= dt;
  // resting on solid ground: gravity already balanced (see mobTick note).
  if (!(rec._ground && rec.vy === 0)) rec.vy = Math.max(rec.vy - GRAV * dt, TERMINAL);
  const b = rec._box || (rec._box = { x: 0, y: 0, z: 0, w: 0.5, h: 0.5 });
  b.x = rec.e.x; b.y = rec.e.y; b.z = rec.e.z; b.w = rec.w; b.h = rec.h; // persistent box: feeds the physMove resting-contact cache
  const res = physMove(b, rec.vx * dt, rec.vy * dt, rec.vz * dt);
  rec.e.x = rec.x = b.x; rec.e.y = rec.y = b.y; rec.e.z = rec.z = b.z;
  rec._ground = res.ground;
  if (res.ground) { rec.vy = 0; rec.vx *= 0.7; rec.vz *= 0.7; }
  syncEnt(rec.e);
  if (rec.fuse <= 0) {
    explode({ x: rec.x, y: rec.y, z: rec.z }, 4);
    try { SV.tnt.delete(rec.id); } catch (e) {}
    try { game().entities.destroy([rec.id]); } catch (e) {}
  }
}

// --- block right-click handling (offline: engine send() is dead, so we do it) ---
const FACE_D = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
function stackName(s) {
  if (!s || !s.id) return null;
  try { const d = game().items.def(s.id); return d ? d.name : null; } catch (e) { return null; }
}
function handStack(hand) { return hand === 1 ? offHeld() : mainHeld(); }
/* ---------------------------------------------------------- boats (Tier 1):
 * rideable boat entity, paddle movement, dismount, break loot. The engine
 * renders + floats + paddles boats natively (kind "boat", spawnObject unified
 * type 6, objectData 0-5 wood variant) and steers them from player input once mounted
 * (game.vehicle). We are the server half: placement from the 6 boat items,
 * mount on right-click, sneak dismount, punch-to-break with boat-item loot. */
const BOAT_VARIANT = { oak_boat: 0, spruce_boat: 1, birch_boat: 2, jungle_boat: 3, acacia_boat: 4, dark_oak_boat: 5,
  oak_chest_boat: 0, spruce_chest_boat: 1, birch_chest_boat: 2, jungle_chest_boat: 3, acacia_chest_boat: 4, dark_oak_chest_boat: 5 };
const VARIANT_BOAT = ["oak_boat", "spruce_boat", "birch_boat", "jungle_boat", "acacia_boat", "dark_oak_boat"];
const VARIANT_CHEST_BOAT = ["oak_chest_boat", "spruce_chest_boat", "birch_chest_boat", "jungle_chest_boat", "acacia_chest_boat", "dark_oak_chest_boat"];
function boatChestOf(hn) { return hn ? hn.slice(-11) === "_chest_boat" : false; }
function spawnBoat(variant, x, y, z, chest) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    let yaw = 0;
    try { yaw = g.player ? g.player.yaw : 0; } catch (e) {}
    g.entities.spawnObject({
      entityId: id, x, y, z, yaw, pitch: 0,
      type: 6, objectData: clamp(variant | 0, 0, 5),
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    if (chest) { try { e.chestBoat = true; e.entityName = "chest_boat"; } catch (e2) {} }
    SV.boats.set(id, { id, e, variant: clamp(variant | 0, 0, 5), chest: !!chest, hits: 0, hitAt: 0 });
    syncEnt(e);
    if (SV.boats.size > 24) {
      // cap: oldest non-ridden boat despawns first
      let oldest = null;
      SV.boats.forEach((b) => { if (b.id !== SV.rideBoat && (oldest == null || b.id < oldest)) oldest = b.id; });
      if (oldest != null) removeBoat(oldest);
    }
    return id;
  } catch (err) { return null; }
}
function removeBoat(id) {
  try { SV.boats.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}
function boatIdOf(t) {
  // entity-shaped right-click target -> boat id (engine kind check first)
  try {
    if (!t || typeof t !== "object") return -1;
    const ids = [];
    if (t.id != null) ids.push(t.id | 0);
    if (t.entityId != null) ids.push(t.entityId | 0);
    for (const k of ["target", "entity", "mob", "victim"]) {
      const v = t[k];
      if (typeof v === "number") ids.push(v | 0);
      else if (v && typeof v === "object" && v.id != null) ids.push(v.id | 0);
    }
    for (const id of ids) {
      if (SV.boats.has(id)) return id;
      try {
        const e = game().entities.get(id);
        if (e && e.kind === "boat") return id;
      } catch (e2) {}
    }
  } catch (e) {}
  return -1;
}
function mountBoat(id) {
  const g = game();
  try {
    if (!survives() || SV.dead || SV.rideBoat >= 0) return false;
    const e = g.entities.get(id);
    if (!e || e.kind !== "boat") return false;
    try {
      const occ = g.entities.passengersOf(id) || [];
      if (occ.length >= 2) return false; // both seats taken (vanilla holds 2)
    } catch (err) {}
    const pid = g.entityId;
    g.entities.attach(pid, id);
    g.ridingEntityId = id;
    try { g.player.ridingEntity = e; } catch (err) {}
    SV.rideBoat = id;
    return true;
  } catch (err) { return false; }
}
function dismountBoat() {
  const g = game();
  const id = SV.rideBoat;
  SV.rideBoat = -1;
  try { g.entities.attach(g.entityId, -1); } catch (e) {}
  try {
    const b = id >= 0 ? g.entities.get(id) : null;
    if (b) b.passenger = -1;
  } catch (e) {}
  try { g.ridingEntityId = -1; } catch (e) {}
  try { if (g.player) g.player.ridingEntity = null; } catch (e) {}
  try { if (g.vehicle) g._dropVehicle(); } catch (e) {}
}
function handleBoatMount(t) {
  if (!survives() || SV.dead) return false;
  const id = boatIdOf(t);
  if (id < 0) return false;
  // P4: sneak-right-click a chest boat opens its chest (vanilla).
  try {
    const rec = SV.boats.get(id);
    if (rec && rec.chest && game().player && game().player.sneaking) {
      return openBoatWindow(id);
    }
  } catch (e) {}
  return mountBoat(id);
}
// P4: chest-boat storage (27 slots, vanilla). Tiles persist via the normal
// rec/SV.tiles path; saveOpenTile's generic branch writes the window back.
function boatTile(id) {
  try {
    SV.tiles = SV.tiles || new Map();
    let t = SV.tiles.get("boat:" + id);
    if (!t) { t = { items: new Array(27).fill(null) }; SV.tiles.set("boat:" + id, t); }
    return t;
  } catch (e) { return { items: new Array(27).fill(null) }; }
}
function openBoatWindow(id) {
  const g = game();
  const rec = SV.boats.get(id);
  if (!rec || !rec.chest) return false;
  SV.openTile = { key: "boat:" + id, wid: 1 };
  try {
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:chest", windowTitle: { text: "Chest Boat" }, slotCount: 27, entityId: id });
  } catch (e) { SV.openTile = null; return false; }
  try {
    const w = g.window;
    if (!w) { SV.openTile = null; return false; }
    const t = boatTile(id);
    for (let i = 0; i < 27; i++) {
      const s = t.items[i];
      w.container[i] = s ? { id: s.id, count: s.count, nbt: s.nbt || undefined } : null;
    }
    w.properties = [];
  } catch (e) {}
  return true;
}
function handleBoatPlace(t, hand) {
  // right-click water (or shore ground) with a boat item (vanilla)
  const g = game();
  const s = handStack(hand);
  const hn = stackName(s);
  if (!hn || BOAT_VARIANT[hn] == null) return false;
  if (t == null || t.face == null) return false;
  try {
    const d = FACE_D[t.face | 0] || FACE_D[1];
    const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
    let px = 0, py = 0, pz = 0;
    if (blockNameAt(t.x, t.y, t.z) === "water") {
      px = t.x + 0.5; py = t.y + 0.5; pz = t.z + 0.5;
    } else if (blockNameAt(ax, ay, az) === "water") {
      px = ax + 0.5; py = ay + 0.5; pz = az + 0.5;
    } else {
      // land: needs an air cell with ground below (boats sit on shore)
      let occ = -1;
      try { occ = g.world.getState(ax, ay, az); } catch (e) {}
      if (occ !== 0) return false;
      if (!isSolidXYZ(ax, ay - 1, az)) return false;
      px = ax + 0.5; py = ay + 0.1; pz = az + 0.5;
    }
    const id = spawnBoat(BOAT_VARIANT[hn], px, py, pz, boatChestOf(hn));
    if (id == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    sfx("entity.generic.splash");
    return true;
  } catch (e) { return false; }
}
function boatBreakHit(id) {
  // vanilla: punched boats wobble, then break and drop the boat item itself
  const rec = SV.boats.get(id);
  if (!rec) return;
  if (id === SV.rideBoat) return; // can't punch out your own seat
  try {
    const now = Date.now();
    rec.hits = (now - (rec.hitAt || 0) > 5000) ? 1 : (rec.hits | 0) + 1;
    rec.hitAt = now;
    try {
      rec.e.timeSinceHit = 10;
      rec.e.damageTaken = (rec.e.damageTaken | 0) + 10;
    } catch (e) {}
    if (rec.hits >= 2) {
      const v = rec.variant | 0;
      const p = rec.e;
      const cn = (rec.chest ? VARIANT_CHEST_BOAT : VARIANT_BOAT)[v] || "oak_boat";
      // P4: chest boats spill their stored items (vanilla drops contents).
      try {
        if (rec.chest) {
          const t = SV.tiles && SV.tiles.get("boat:" + id);
          if (t && t.items) {
            for (const s of t.items) {
              if (s && s.id) spawnItemEntity(p.x, p.y + 0.5, p.z, s.id, s.count | 0 || 1);
            }
          }
          try { SV.tiles && SV.tiles.delete("boat:" + id); } catch (eT) {}
        }
      } catch (eC) {}
      removeBoat(id);
      const bid = itemIdByName(cn);
      if (bid != null) spawnItemEntity(p.x, p.y + 0.5, p.z, bid, 1);
      sfx("block.wood.break");
    }
  } catch (e) {}
}
function boatTick(dt) {
  const g = game();
  if (SV.dead) { if (SV.rideBoat >= 0) dismountBoat(); return; }
  if (!survives()) return;
  // sneak (shift) dismounts (vanilla); the engine only slows the boat
  try {
    if (SV.rideBoat >= 0 && g.player && g.player.sneaking) dismountBoat();
  } catch (e) {}
  // forget engine-destroyed boats
  try {
    const dead = [];
    SV.boats.forEach((b) => {
      try { if (!g.entities.get(b.id)) dead.push(b.id); } catch (e2) { dead.push(b.id); }
    });
    for (const id of dead) {
      try { SV.boats.delete(id); } catch (e2) {}
      if (SV.rideBoat === id) {
        SV.rideBoat = -1;
        try { g.ridingEntityId = -1; } catch (e2) {}
        try { if (g.player) g.player.ridingEntity = null; } catch (e2) {}
        try { if (g.vehicle) g._dropVehicle(); } catch (e2) {}
      }
    }
  } catch (e) {}
}
function respawnSavedBoats() {
  if (!SV.savedBoats) return;
  const list = SV.savedBoats;
  SV.savedBoats = null;
  for (const b of list.slice(0, 20)) {
    try {
      const id = spawnBoat(b.v | 0, b.x, b.y, b.z, !!b.chest);
      // chest contents restore (tile keyed by new id would mismatch — stash
      // by order: contents saved alongside, restored to the fresh record).
      if (id != null && b.chest && Array.isArray(b.items)) {
        try {
          const t = boatTile(id);
          for (let i = 0; i < 27 && i < b.items.length; i++) {
            const s = b.items[i];
            t.items[i] = s && s.id ? { id: s.id, count: s.c | 0 || 1, nbt: s.n || null } : null;
          }
        } catch (e2) {}
      }
    } catch (e) {}
  }
}
/* ---------------------------------------------------------- armor stands (v1.9.0):
 * placed from the armor_stand item onto a solid top face, dressed by hand
 * (swap, vanilla) or dispenser (empty slot only, heads too), name-tagged,
 * one-punch break dropping the stand + gear, gravity fall, per-world
 * persist. The engine renders kind "armorstand" natively (armor layers,
 * head blocks, elytra, floating names). No arms/poses in survival
 * (vanilla: commands only), so no held items; fire/lava/cactus don't hurt
 * stands (documented simplification). */
const STAND_TYPE = 1; // ENTITY_TYPES index of armor_stand (registry-verified)
function spawnStand(x, y, z, yaw) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    let py = yaw;
    if (py == null) { try { py = g.player ? g.player.yaw : 0; } catch (e) {} py = ((py | 0) + 180) % 360; }
    g.entities.spawnMob({
      entityId: id, x, y, z, yaw: py, pitch: 0, type: STAND_TYPE,
      entityUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e || e.entityName !== "armor_stand") { try { g.entities.destroy([id]); } catch (ee) {} return null; }
    const rec = { id, e, x, y, z, yaw: py, vy: 0, rest: false, gear: [null, null, null, null], name: null };
    SV.stands.set(id, rec);
    syncStandLook(rec);
    syncEnt(e);
    if (SV.stands.size > 24) {
      // cap: oldest stand despawns first (boats/carts precedent)
      let oldest = null;
      SV.stands.forEach((s) => { if (s.id !== id && (oldest == null || s.id < oldest)) oldest = s.id; });
      if (oldest != null) removeStand(oldest);
    }
    return id;
  } catch (err) { return null; }
}
function removeStand(id) {
  try { SV.stands.delete(id); } catch (e) {}
  try { game().entities.destroy([id]); } catch (e) {}
}
function syncStandLook(s) {
  // cosmetic record -> engine flags (same direct-write pattern as
  // paintSheep): equipment[1..4] = feet..head, floating name, yaw.
  try {
    const e = (s && s.e) || game().entities.get(s && s.id);
    if (!e) return;
    for (let i = 0; i < 4; i++) {
      const g = (s.gear || [])[i];
      e.equipment[i + 1] = g && g.id ? { id: g.id, count: 1 } : null;
    }
    if (s.name) { e.customName = s.name; e.nameVisible = true; }
    else { e.customName = null; e.nameVisible = false; }
    e.yaw = e.newYaw = e.headYaw = s.yaw || 0;
    e.bodyYaw = e.prevBodyYaw = s.yaw || 0;
  } catch (err) {}
}
function standIdOf(t) {
  // entity-shaped right-click target -> stand id (engine kind check first)
  try {
    if (!t || typeof t !== "object") return -1;
    const ids = [];
    if (t.id != null) ids.push(t.id | 0);
    if (t.entityId != null) ids.push(t.entityId | 0);
    for (const k of ["target", "entity", "mob", "victim"]) {
      const v = t[k];
      if (typeof v === "number") ids.push(v | 0);
      else if (v && typeof v === "object" && v.id != null) ids.push(v.id | 0);
    }
    for (const id of ids) {
      if (SV.stands.has(id)) return id;
      try {
        const e = game().entities.get(id);
        if (e && e.kind === "armorstand") return id;
      } catch (e2) {}
    }
  } catch (e) {}
  return -1;
}
function handleStandPlace(t, hand) {
  // right-click the top face of a solid block with an armor_stand item
  const g = game();
  const s = handStack(hand);
  const hn = stackName(s);
  if (!hn || hn !== "armor_stand") return false;
  if (t == null || (t.face | 0) !== 1) return false; // top face only (vanilla)
  try {
    const ax = t.x, ay = t.y + 1, az = t.z;
    let occ = -1;
    try { occ = g.world.getState(ax, ay, az); } catch (e) {}
    if (occ !== 0) return false; // no room (vanilla puffs and refuses)
    if (!isSolidXYZ(ax, ay - 1, az)) return false;
    const id = spawnStand(ax + 0.5, ay, az + 0.5);
    if (id == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    sfx("entity.armor_stand.place");
    return true;
  } catch (e) { return false; }
}
function handleStandUse(t, hand) {
  if (!survives() || SV.dead) return false;
  const id = standIdOf(t);
  if (id < 0) return false;
  const s = SV.stands.get(id);
  if (!s) return false;
  const hs = hand === 1 ? offHeld() : mainHeld();
  const hn = hs && hs.id ? stackName(hs) : null;
  if (!hn) return false;
  // same dup-click swallow as taming (one click, two wrapper arrivals)
  let dup = false;
  try { dup = SV.lastStandUse === id && Date.now() - (SV.lastStandAt || 0) < 200; } catch (e) {}
  const mark = () => { try { SV.lastStandUse = id; SV.lastStandAt = Date.now(); } catch (e) {} };
  const takeOne = () => {
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
  };
  // name tag: apply the anvil name (unnamed tags refuse — nothing to write)
  if (hn === "name_tag") {
    let nm = null;
    try {
      const tg = game().items.nbt(hs);
      const raw = tg && tg.display && tg.display.Name;
      if (typeof raw === "string") {
        try { const j = JSON.parse(raw); nm = (j && j.text) || raw; } catch (e2) { nm = raw; }
      }
    } catch (e) {}
    if (!nm) return false;
    if (dup) return true;
    mark();
    s.name = String(nm).slice(0, 32);
    syncStandLook(s);
    takeOne();
    return true;
  }
  const slot = dispArmorSlot(hn);
  if (slot < 0) return false; // not wearable: leave for other handlers
  if (dup) return true;
  mark();
  s.gear = s.gear || [null, null, null, null];
  const old = s.gear[slot];
  const oneId = hs.id, oneNbt = hs.nbt || null;
  takeOne();
  s.gear[slot] = { id: oneId, count: 1, nbt: oneNbt };
  if (old && old.id) { try { addPlayerItem(old.id, 1); } catch (e) {} } // swap (vanilla)
  syncStandLook(s);
  try {
    let snd = "item.armor.equip_iron";
    const mt = String(hn).match(/^(leather|chainmail|gold|iron|diamond|turtle|elytra)/);
    if (mt) snd = "item.armor.equip_" + (mt[1] === "chainmail" ? "chain" : mt[1]);
    sfx(snd);
  } catch (e) {}
  return true;
}
function breakStand(id) {
  // vanilla: any punch breaks the stand, dropping itself + all gear
  const s = SV.stands.get(id);
  if (!s) return;
  try {
    const sid = itemIdByName("armor_stand");
    if (sid != null) spawnItemEntity(s.x, s.y + 0.5, s.z, sid, 1);
    for (const g of (s.gear || [])) {
      if (g && g.id) spawnItemEntity(s.x, s.y + 0.5, s.z, g.id, 1);
    }
  } catch (e) {}
  sfx("entity.armor_stand.break");
  removeStand(id);
}
function standTick(dt) {
  if (!survives()) return;
  const g = game();
  // forget engine-destroyed stands (boats/carts precedent)
  try {
    const dead = [];
    SV.stands.forEach((s) => {
      try { if (!g.entities.get(s.id)) dead.push(s.id); } catch (e2) { dead.push(s.id); }
    });
    for (const id of dead) { try { SV.stands.delete(id); } catch (e2) {} }
  } catch (e) {}
  let px = 0, pz = 0;
  try { const p = g.player; px = p.x; pz = p.z; } catch (e) {}
  SV.stands.forEach((s) => {
    try {
      const e = g.entities.get(s.id);
      if (!e) return;
      const dx = s.x - px, dz = s.z - pz;
      if (dx * dx + dz * dz > 48 * 48) return; // far chunks read as air: sleep
      if (s.rest) {
        // supported still? a broken floor must release the stand
        try {
          if (isSolidXYZ(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z))) return;
        } catch (e2) { return; }
        s.rest = false;
      }
      const b = { x: s.x, y: s.y, z: s.z, w: 0.5, h: 1.975 };
      s.vy = Math.max(TERMINAL, (s.vy || 0) - GRAV * dt);
      const r = physMove(b, 0, s.vy * dt, 0);
      if (r.ground) { s.vy = 0; s.rest = true; }
      s.x = b.x; s.y = b.y; s.z = b.z;
      e.x = s.x; e.y = s.y; e.z = s.z;
      syncEnt(e);
    } catch (e2) {}
  });
}
function respawnSavedStands() {
  if (!SV.savedStands) return;
  const list = SV.savedStands;
  SV.savedStands = null;
  for (const b of list.slice(0, 20)) {
    try {
      const id = spawnStand(b.x, b.y, b.z, b.yaw | 0);
      if (id == null) continue;
      const s = SV.stands.get(id);
      if (!s) continue;
      s.gear = [null, null, null, null];
      (b.gear || []).slice(0, 4).forEach((gg, i) => {
        if (gg && gg.id) s.gear[i] = { id: gg.id, count: 1, nbt: null };
      });
      s.name = b.name || null;
      syncStandLook(s);
    } catch (e) {}
  }
}
/* ---------------------------------------------------------- minecarts + rails (Tier 1):
 * rideable carts, furnace/chest/hopper/tnt variants, rail auto-shape,
 * powered/detector/activator behavior. The engine renders minecarts natively
 * (kind "minecart", spawnObject unified type 42, objectData 0-5) and snaps riders, but
 * moves nothing offline — so carts are simulated here like mobs, with rail
 * shape math done on our side (the engine places default shapes only). */
const RAIL_SHAPES = ["north_south", "east_west", "ascending_east", "ascending_west", "ascending_north", "ascending_south", "south_east", "south_west", "north_west", "north_east"];
const RAIL_BASE = { rail: 3180, powered_rail: 1004, detector_rail: 1016, activator_rail: 5781 };
// shapeIdx -> its two end ports [dx, dz, dy] (dy = end height above rail base)
const SHAPE_PORTS = [
  [[0, -1, 0], [0, 1, 0]], [[1, 0, 0], [-1, 0, 0]],
  [[1, 0, 1], [-1, 0, 0]], [[-1, 0, 1], [1, 0, 0]],
  [[0, -1, 1], [0, 1, 0]], [[0, 1, 1], [0, -1, 0]],
  [[0, 1, 0], [1, 0, 0]], [[0, 1, 0], [-1, 0, 0]],
  [[0, -1, 0], [-1, 0, 0]], [[0, -1, 0], [1, 0, 0]],
];
const CART_ITEM = { minecart: 0, chest_minecart: 1, furnace_minecart: 2, tnt_minecart: 3, hopper_minecart: 5 };
const CART_DROP = ["minecart", "chest_minecart", "furnace_minecart", "tnt_minecart", null, "hopper_minecart"];
const CART_REST = 0.3; // cart feet above rail-block top (tuned visually)
const CART_MAXV = 8; // vanilla max minecart speed, blocks/sec
function railInfo(bx, by, bz) {
  let st = -1;
  try { st = game().world.getState(bx, by, bz); } catch (e) { return null; }
  if ((st | 0) === 0) return null;
  for (const type in RAIL_BASE) {
    const base = RAIL_BASE[type], off = st - base;
    if (type === "rail") {
      if (off >= 0 && off < 10) return { type, shapeIdx: off, powered: false, bx, by, bz };
    } else if (off >= 0 && off < 12) {
      return { type, shapeIdx: off % 6, powered: off >= 6, bx, by, bz };
    }
  }
  return null;
}
function isRailName(nm) {
  return nm === "rail" || (nm && nm.slice(-5) === "_rail");
}
function cartRailAt(x, y, z) {
  const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
  for (let d = 0; d <= 2; d++) {
    const r = railInfo(fx, fy - d, fz);
    if (r) return r;
  }
  return null;
}
function railLinks(bx, by, bz) {
  const out = [], D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of D) {
    if (railInfo(bx + dx, by, bz + dz)) out.push({ dx, dz, dy: 0 });
    else if (railInfo(bx + dx, by + 1, bz + dz)) out.push({ dx, dz, dy: 1 });
    else if (railInfo(bx + dx, by - 1, bz + dz)) out.push({ dx, dz, dy: -1 });
  }
  return out;
}
function autoRailShape(bx, by, bz, type) {
  const curved = (type === "rail"); // powered/detector/activator never curve
  const links = railLinks(bx, by, bz);
  const has = (dx, dz) => links.find((l) => l.dx === dx && l.dz === dz) || null;
  const E = has(1, 0), W = has(-1, 0), N = has(0, -1), S = has(0, 1);
  // slope toward the higher end, else flat straight
  const slope = (A, B, upA, upB) => {
    const ay = A ? A.dy : 0, byy = B ? B.dy : 0;
    if (ay === 1 || byy === -1) return upA;
    if (byy === 1 || ay === -1) return upB;
    return -1;
  };
  let s = -1;
  if (E && W) s = slope(E, W, 2, 3);
  else if (N && S) s = slope(N, S, 4, 5);
  if (s >= 0) return s;
  if (E && W) return 1;
  if (N && S) return 0;
  if (curved) {
    if (E && S) return 6; if (W && S) return 7;
    if (W && N) return 8; if (E && N) return 9;
  }
  if (E || W) return 1;
  if (N || S) return 0;
  return -1; // isolated: keep current shape
}
function setRailShape(bx, by, bz) {
  try {
    const r = railInfo(bx, by, bz);
    if (!r) return false;
    const idx = autoRailShape(bx, by, bz, r.type);
    if (idx < 0 || idx === r.shapeIdx) return false;
    const cur = (r.type === "rail") ? 0 : (r.powered ? 6 : 0);
    SV.grief = true;
    try { game().world.setState(bx, by, bz, RAIL_BASE[r.type] + cur + idx); }
    finally { SV.grief = false; }
    return true;
  } catch (e) { return false; }
}
function updateRailNeighbors(bx, by, bz) {
  try {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      setRailShape(bx + dx, by + dy, bz + dz);
    }
  } catch (e) {}
}
function handleRailPlace(t, hand) {
  // rails go down on solid tops with auto-shape + neighbor fixup (vanilla)
  const g = game();
  const s = handStack(hand);
  const hn = stackName(s);
  if (!hn || RAIL_BASE[hn] == null) return false;
  if (t == null || t.face == null) return false;
  try {
    const d = FACE_D[t.face | 0] || FACE_D[1];
    const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
    let occ = -1;
    try { occ = g.world.getState(ax, ay, az); } catch (e) {}
    if (occ !== 0) return false;
    if (!isSolidXYZ(ax, ay - 1, az)) return false;
    let idx = autoRailShape(ax, ay, az, hn);
    if (idx < 0) idx = 0; // isolated default north_south
    SV.grief = true;
    try { g.world.setState(ax, ay, az, RAIL_BASE[hn] + idx); }
    finally { SV.grief = false; }
    updateRailNeighbors(ax, ay, az);
    // deferred pass: covers any read-your-write race in state flush
    try { setTimeout(() => { setRailShape(ax, ay, az); updateRailNeighbors(ax, ay, az); }, 800); } catch (e) {}
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    sfx("block.metal.place");
    return true;
  } catch (e) { return false; }
}
// detector rails power adjacent powered/activator rails (pre-redstone power)
function railPoweredAt(bx, by, bz) {
  try {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2) continue;
      const r = railInfo(bx + dx, by + dy, bz + dz);
      if (r && r.type === "detector_rail" && r.powered) return true;
    }
  } catch (e) {}
  return false;
}
function setDetector(bx, by, bz, on) {
  // flip a detector rail's power bit, preserving its shape (vanilla)
  try {
    const r = railInfo(bx, by, bz);
    if (!r || r.type !== "detector_rail" || r.powered === on) return false;
    SV.grief = true;
    try { game().world.setState(bx, by, bz, RAIL_BASE.detector_rail + r.shapeIdx + (on ? 6 : 0)); }
    finally { SV.grief = false; }
    return true;
  } catch (e) { return false; }
}
function setRailPowered(r, on) {
  // powered/activator rails mirror redstone power in their state (vanilla:
  // lit rails), preserving shape. Power comes from adjacent on-detectors
  // until Tier 2 redstone exists.
  try {
    if (!r || r.powered === on) return false;
    if (r.type === "rail" || r.type === "detector_rail") return false;
    SV.grief = true;
    try { game().world.setState(r.bx, r.by, r.bz, RAIL_BASE[r.type] + r.shapeIdx + (on ? 6 : 0)); }
    finally { SV.grief = false; }
    r.powered = on;
    return true;
  } catch (e) { return false; }
}
function spawnCart(variant, x, y, z) {
  const g = game();
  const id = SV.eidSeq++;
  try {
    let yaw = 0;
    try { yaw = g.player ? g.player.yaw : 0; } catch (e) {}
    g.entities.spawnObject({
      entityId: id, x, y, z, yaw, pitch: 0,
      type: 42, objectData: clamp(variant | 0, 0, 5),
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    const v = clamp(variant | 0, 0, 5);
    SV.carts.set(id, {
      id, e, variant: v, vx: 0, vy: 0, vz: 0, lx: 0, lz: 0,
      cell: null, detCell: null, fuel: 0, hits: 0, hitAt: 0, pullAcc: 0,
    });
    if (v === 1 || v === 5) cartTile(id, v); // chest (27) / hopper (5) storage
    syncEnt(e);
    if (SV.carts.size > 24) {
      let oldest = null;
      SV.carts.forEach((c) => { if (c.id !== SV.rideCart && (oldest == null || c.id < oldest)) oldest = c.id; });
      if (oldest != null) removeCart(oldest);
    }
    return id;
  } catch (err) { return null; }
}
function removeCart(id, drop) {
  const rec = SV.carts.get(id);
  try { SV.carts.delete(id); } catch (e) {}
  try { SV.tiles && SV.tiles.delete("cart:" + id); } catch (e) {}
  if (id === SV.rideCart) dismountCart();
  try { game().entities.destroy([id]); } catch (e) {}
  if (drop && rec) {
    const nm = CART_DROP[rec.variant | 0];
    if (nm) {
      const bid = itemIdByName(nm);
      if (bid != null) spawnItemEntity(rec.e.x, rec.e.y + 0.5, rec.e.z, bid, 1);
    }
    // chest/hopper contents spill (vanilla)
    try {
      const t = SV["_cartSpill"];
      if (t && t.length) for (const s of t) {
        if (s && s.id) spawnItemEntity(rec.e.x, rec.e.y + 0.5, rec.e.z, s.id, s.count | 0 || 1);
      }
    } catch (e) {}
  }
}
function cartTile(id, variant) {
  const key = "cart:" + id, n = variant === 5 ? 5 : 27;
  const t = { type: "chest", key, cart: id, x: 0, y: -999, z: 0, items: new Array(n).fill(null) };
  try { SV.tiles = SV.tiles || new Map(); SV.tiles.set(key, t); } catch (e) {}
  return t;
}
function openCartTile(id) {
  const g = game();
  const cart = SV.carts.get(id);
  if (!cart || (cart.variant !== 1 && cart.variant !== 5)) return false;
  let t = null;
  try { t = SV.tiles && SV.tiles.get("cart:" + id); } catch (e) {}
  if (!t) t = cartTile(id, cart.variant);
  const n = cart.variant === 5 ? 5 : 27;
  const title = cart.variant === 5 ? "Minecart with Hopper" : "Minecart with Chest";
  SV.openTile = { key: "cart:" + id, wid: 1 };
  try {
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:chest", windowTitle: { text: title }, slotCount: n, entityId: id });
  } catch (e) { SV.openTile = null; return false; }
  try {
    const w = g.window;
    if (!w || w.type !== "minecraft:chest") { SV.openTile = null; return false; }
    for (let i = 0; i < n; i++) {
      const s = t.items[i];
      w.container[i] = s ? { id: s.id, count: s.count, nbt: s.nbt || undefined } : null;
    }
    w.properties = [];
  } catch (e) {}
  return true;
}
function cartIdOf(t) {
  try {
    if (!t || typeof t !== "object") return -1;
    const ids = [];
    if (t.id != null) ids.push(t.id | 0);
    if (t.entityId != null) ids.push(t.entityId | 0);
    for (const k of ["target", "entity", "mob", "victim"]) {
      const v = t[k];
      if (typeof v === "number") ids.push(v | 0);
      else if (v && typeof v === "object" && v.id != null) ids.push(v.id | 0);
    }
    for (const id of ids) {
      if (SV.carts.has(id)) return id;
      try {
        const e = game().entities.get(id);
        if (e && e.kind === "minecart") return id;
      } catch (e2) {}
    }
  } catch (e) {}
  return -1;
}
function mountCart(id) {
  const g = game();
  try {
    if (!survives() || SV.dead || SV.rideCart >= 0) return false;
    const c = SV.carts.get(id);
    if (!c) return false;
    if (c.variant !== 0) return false; // only empty carts are rideable (vanilla)
    const e = g.entities.get(id);
    if (!e || e.kind !== "minecart") return false;
    const pid = g.entityId;
    g.entities.attach(pid, id);
    g.ridingEntityId = id;
    try { g.player.ridingEntity = e; } catch (err) {}
    SV.rideCart = id;
    return true;
  } catch (err) { return false; }
}
function dismountCart() {
  const g = game();
  const id = SV.rideCart;
  SV.rideCart = -1;
  try { g.entities.attach(g.entityId, -1); } catch (e) {}
  try {
    const c = id >= 0 ? SV.carts.get(id) : null;
    if (c && c.e) c.e.passenger = -1;
  } catch (e) {}
  try { g.ridingEntityId = -1; } catch (e) {}
  try { if (g.player) g.player.ridingEntity = null; } catch (e) {}
  try { if (g.vehicle) g._dropVehicle(); } catch (e) {}
}
function handleCartUse(t, hand) {
  // right-click a cart: ride (empty), open (chest/hopper), fuel (furnace)
  if (!survives() || SV.dead) return false;
  const id = cartIdOf(t);
  if (id < 0) return false;
  const c = SV.carts.get(id);
  if (!c) return false;
  if (c.variant === 0) return mountCart(id);
  if (c.variant === 1 || c.variant === 5) return openCartTile(id);
  if (c.variant === 2) {
    const s = handStack(hand);
    const hn = stackName(s);
    if (hn !== "coal" && hn !== "charcoal") return false;
    c.fuel += 1800; // 3 min each (10 ticks/sec)
    try {
      // shoved away from whoever fueled it (vanilla): stand behind the cart
      // on the track and it rolls forward along the rails
      const p = game().player;
      const px = c.e.x - (p ? p.x : c.e.x), pz = c.e.z - (p ? p.z : c.e.z);
      const l = Math.hypot(px, pz);
      if (l > 0.01) { c.lx = px / l; c.lz = pz / l; }
      else {
        const dx = Math.sin((c.e.yaw || 0) * Math.PI / 180), dz = Math.cos((c.e.yaw || 0) * Math.PI / 180);
        c.lx = -dx; c.lz = -dz;
      }
    } catch (e) {}
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    sfx("entity.tnt.primed");
    return true;
  }
  return false; // tnt: punch it
}
function handleCartPlace(t, hand) {
  // minecart items used on a rail (vanilla)
  const g = game();
  const s = handStack(hand);
  const hn = stackName(s);
  if (!hn || CART_ITEM[hn] == null) return false;
  if (t == null) return false;
  try {
    let r = null;
    if (t.x != null && railInfo(t.x, t.y, t.z)) r = railInfo(t.x, t.y, t.z);
    if (!r && t.face != null) {
      const d = FACE_D[t.face | 0] || FACE_D[1];
      if (railInfo(t.x + d[0], t.y + d[1], t.z + d[2])) r = railInfo(t.x + d[0], t.y + d[1], t.z + d[2]);
    }
    if (!r) return false;
    const id = spawnCart(CART_ITEM[hn], r.bx + 0.5, r.by + 1 + CART_REST, r.bz + 0.5);
    if (id == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    return true;
  } catch (e) { return false; }
}
function igniteCart(c) {
  // powered activator rail sets off tnt carts (vanilla)
  try {
    const x = c.e.x, y = c.e.y, z = c.e.z;
    removeCart(c.id, false);
    spawnPrimedTNT(x, y, z);
  } catch (e) {}
}
function cartBreakHit(id) {
  // vanilla: punched carts wobble, then break and drop the cart item
  const rec = SV.carts.get(id);
  if (!rec) return;
  if (id === SV.rideCart) return; // can't punch out your own seat
  try {
    const now = Date.now();
    rec.hits = (now - (rec.hitAt || 0) > 5000) ? 1 : (rec.hits | 0) + 1;
    rec.hitAt = now;
    try {
      rec.e.cartDamage = (rec.e.cartDamage | 0) + 10;
      rec.e.rollingAmplitude = 10;
    } catch (e) {}
    if (rec.hits >= 2) {
      try {
        const t = SV.tiles && SV.tiles.get("cart:" + id);
        SV["_cartSpill"] = (t && t.items ? t.items.filter((s) => s && s.id) : []).map((s) => ({ id: s.id, count: s.count | 0 || 1 }));
      } catch (e) { try { SV["_cartSpill"] = null; } catch (e2) {} }
      removeCart(id, true);
      try { SV["_cartSpill"] = null; } catch (e) {}
      sfx("block.metal.break");
    }
  } catch (e) {}
}
function refreshRailPower(bx, by, bz) {
  // mirror redstone power into visible powered/activator states (vanilla:
  // lit rails) for the rail at (bx,by,bz) plus every rail touching it —
  // neighbor rails carry no cart of their own and would otherwise keep
  // stale states. Power comes from adjacent on-detectors until Tier 2.
  try {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 2) continue;
      const nr = (dx || dy || dz) ? railInfo(bx + dx, by + dy, bz + dz) : railInfo(bx, by, bz);
      if (nr && (nr.type === "powered_rail" || nr.type === "activator_rail"))
        setRailPowered(nr, railPoweredAt(nr.bx, nr.by, nr.bz));
    }
  } catch (e) {}
}
function releaseDetCell(c, keepCell) {
  // clear a detector the cart left (vanilla: detectors stay ON only while
  // occupied). keepCell = "x,y,z" of the rail the cart is still on, or null
  // when derailed. A second cart still on the detector keeps it ON.
  try {
    if (!c.detCell || c.detCell === keepCell) return;
    const p = c.detCell.split(",");
    let other = false;
    SV.carts.forEach((o) => {
      if (o !== c && o.e && Math.floor(o.e.x) === +p[0] && Math.floor(o.e.y - 1) <= +p[1] && +p[1] <= Math.floor(o.e.y) && Math.floor(o.e.z) === +p[2]) other = true;
    });
    if (!other) {
      if (setDetector(+p[0], +p[1], +p[2], false)) refreshRailPower(+p[0], +p[1], +p[2]);
    }
    c.detCell = null;
  } catch (e) {}
}
function cartSim(c, dt) {
  const g = game(), e = c.e;
  // furnace fuel burns continuously, on rails or off (vanilla: it's a lit
  // furnace — only the push needs rails to act on)
  if (c.variant === 2 && c.fuel > 0) {
    c.fuel--;
    try {
      if ((c.fuel & 3) === 0) game().particles.smoke(e.x, e.y + 0.8, e.z);
    } catch (err) {}
  }
  const r = cartRailAt(e.x, e.y, e.z);
  if (!r) {
    // derailed: gravity + friction, rest on ground
    c.vy = Math.max(c.vy - 30 * dt, -20);
    c.vx *= 0.92; c.vz *= 0.92;
    let nx = e.x + c.vx * dt, ny = e.y + c.vy * dt, nz = e.z + c.vz * dt;
    try {
      if (isSolidXYZ(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        ny = Math.floor(ny) + 1 + CART_REST;
        c.vy = 0; c.vx *= 0.7; c.vz *= 0.7;
        if (Math.abs(c.vx) + Math.abs(c.vz) < 0.05) { c.vx = 0; c.vz = 0; }
      }
    } catch (err) {}
    e.x = nx; e.y = ny; e.z = nz;
    try { syncEnt(e); } catch (err) {}
    // leaving a detector for open ground must also release it (vanilla):
    // otherwise the detector — and every rail it powers — stays ON forever
    try { releaseDetCell(c, null); } catch (err) {}
    return;
  }
  const ports = SHAPE_PORTS[r.shapeIdx];
  const curved = r.shapeIdx >= 6;
  const cellKey = r.bx + "," + r.by + "," + r.bz;
  // powered/activator rails mirror power in their visible state (vanilla):
  // refresh the cart's rail plus every rail touching it (see refreshRailPower)
  try { refreshRailPower(r.bx, r.by, r.bz); } catch (err) {}
  let ux = 0, uz = 0, upgrade = 0; // horizontal unit + slope grade (+1 toward high)
  let seedS = null; // curve entry: incoming speed (momentum carries through turns)
  if (curved) {
    if (c.cell !== cellKey) {
      // entering a curve: keep the port we came through, leave by the other.
      // Seed s with incoming speed (vanilla: momentum carries through turns —
      // raw projection reads ~0 since travel is perpendicular to the exit).
      let entry = 0;
      const sp = Math.hypot(c.vx, c.vz);
      if (sp > 0.05) {
        const d0 = -(ports[0][0] * c.vx + ports[0][1] * c.vz);
        const d1 = -(ports[1][0] * c.vx + ports[1][1] * c.vz);
        entry = d1 > d0 ? 1 : 0;
        seedS = sp;
      }
      c.exit = 1 - entry;
    }
    const xp = ports[c.exit == null ? 1 : c.exit];
    ux = xp[0]; uz = xp[1]; upgrade = 0;
  } else {
    // straight/slope axis from port 0
    const px = ports[0][0], pz = ports[0][1];
    ux = px; uz = pz;
    const hi = ports[0][2] === 1 ? 1 : (ports[1][2] === 1 ? -1 : 0);
    upgrade = hi; // +1 if port0 end is the high end
  }
  // signed speed along the axis
  let s = c.vx * ux + c.vz * uz;
  if (seedS != null) s = seedS; // curve entry: carry momentum through the turn
  // slope gravity: constant pull toward the low end (uphill slows, rest starts rolling)
  if (upgrade !== 0) s += -upgrade * 2.2 * dt;
  // furnace carts self-propel while fueled (fuel burns above, on/off rail)
  if (c.variant === 2 && c.fuel > 0) {
    // kick from TRUE rest only (projection s reads ~0 mid-turn even at speed).
    // On curves the rails pick the direction (out the selected exit); on
    // straights the stored push disambiguates +/-.
    if (Math.hypot(c.vx, c.vz) < 0.1 && (c.lx || c.lz)) {
      if (curved) {
        const xp2 = ports[c.exit == null ? 1 : c.exit];
        ux = xp2[0]; uz = xp2[1];
      } else {
        const l = Math.hypot(c.lx, c.lz) || 1;
        ux = c.lx / l; uz = c.lz / l;
      }
      s = 0.5;
    }
    s += (s >= 0 ? 1 : -1) * 3.0 * dt;
    if (Math.abs(s) > CART_MAXV) s = (s >= 0 ? 1 : -1) * CART_MAXV;
  }
  // powered rails boost or brake (vanilla)
  if (r.type === "powered_rail") {
    if (railPoweredAt(r.bx, r.by, r.bz)) {
      if (Math.abs(s) < 0.2) s = 1.2; // kick off from rest
      else s += (s >= 0 ? 1 : -1) * 5.0 * dt;
      if (Math.abs(s) > CART_MAXV) s = (s >= 0 ? 1 : -1) * CART_MAXV;
    } else {
      s *= Math.max(0, 1 - 4.5 * dt); // unpowered rails brake hard
      if (Math.abs(s) < 0.05) s = 0;
    }
  }
  // rolling drag + cap
  s *= Math.max(0, 1 - 0.12 * dt);
  if (Math.abs(s) > CART_MAXV) s = (s >= 0 ? 1 : -1) * CART_MAXV;
  if (Math.abs(s) < 0.02 && upgrade === 0 && !(c.variant === 2 && c.fuel > 0)) s = 0;
  c.vx = ux * s; c.vz = uz * s;
  if (Math.abs(s) > 0.01) { c.lx = ux * (s >= 0 ? 1 : -1); c.lz = uz * (s >= 0 ? 1 : -1); }
  // slope vertical: ride the grade
  let vy = 0;
  if (upgrade !== 0) vy = (s >= 0 ? upgrade : -upgrade) * Math.abs(s) / Math.SQRT2;
  c.vy = vy;
  let nx = e.x + c.vx * dt, nz = e.z + c.vz * dt;
  // snap: perpendicular onto the rail line, height onto the grade
  let ny;
  if (ux !== 0) {
    nz = r.bz + 0.5;
    ny = r.by + 1 + CART_REST + (upgrade !== 0 ? ((upgrade > 0 ? (nx - r.bx) : (r.bx + 1 - nx))) : 0);
  } else {
    nx = r.bx + 0.5;
    ny = r.by + 1 + CART_REST + (upgrade !== 0 ? ((upgrade > 0 ? (nz - r.bz) : (r.bz + 1 - nz))) : 0);
  }
  if (upgrade === 0) ny = r.by + 1 + CART_REST;
  e.x = nx; e.y = ny; e.z = nz;
  try { syncEnt(e); } catch (err) {}
  // entry tracking: record the rail PROCESSED this tick — not the post-move
  // position. The move that brought us here ran under the previous rail, so
  // post-move position always equals cellKey and curve entry would never
  // fire during normal travel (only on teleports). Processed-vs-previous is
  // the transition that matters.
  c.cell = cellKey;
  // detector rails flip while a cart sits on them (vanilla)
  try {
    if (r.type === "detector_rail" && !r.powered) setDetector(r.bx, r.by, r.bz, true);
    releaseDetCell(c, r.bx + "," + r.by + "," + r.bz);
    c.detCell = (r.type === "detector_rail") ? (r.bx + "," + r.by + "," + r.bz) : null;
  } catch (err) {}
  // activator rails eject riders / ignite tnt carts (vanilla)
  try {
    if (r.type === "activator_rail" && railPoweredAt(r.bx, r.by, r.bz)) {
      if (c.variant === 3) igniteCart(c);
      else if (c.id === SV.rideCart) dismountCart();
    }
  } catch (err) {}
}
function cartsCollide() {
  // carts shove each other (vanilla); furnace carts push hardest
  try {
    const list = Array.from(SV.carts.values());
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.e.x - a.e.x, dz = b.e.z - a.e.z;
      const dy = Math.abs(b.e.y - a.e.y);
      const d2 = dx * dx + dz * dz;
      if (d2 > 1.1 * 1.1 || dy > 0.8 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      const overlap = 1.1 - d;
      a.e.x -= nx * overlap / 2; a.e.z -= nz * overlap / 2;
      b.e.x += nx * overlap / 2; b.e.z += nz * overlap / 2;
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const push = -rel * 0.55;
        const aw = a.variant === 2 && a.fuel > 0 ? 0.2 : 1;
        const bw = b.variant === 2 && b.fuel > 0 ? 0.2 : 1;
        a.vx -= nx * push * bw; a.vz -= nz * push * bw;
        b.vx += nx * push * aw; b.vz += nz * push * aw;
      }
      try { syncEnt(a.e); syncEnt(b.e); } catch (e) {}
    }
  } catch (e) {}
}
function cartPlayerPush() {
  // walking into a cart shoves it (vanilla), so slopes aren't the only start
  try {
    const g = game(), p = g.player;
    if (!p) return;
    SV.carts.forEach((c) => {
      if (c.id === SV.rideCart) return;
      const dx = c.e.x - p.x, dz = c.e.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1.2 * 1.2 || Math.abs(c.e.y - p.y) > 1.6 || d2 < 1e-6) return;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      const pm = Math.hypot(p.motionX || 0, p.motionZ || 0);
      const shove = 1.5 + Math.min(4, pm * 2);
      c.vx += nx * shove * 0.1; c.vz += nz * shove * 0.1;
      if (Math.abs(c.vx) + Math.abs(c.vz) > 0.05 && !(Math.abs(c.vx) > 0 || Math.abs(c.vz) > 0)) { /* keep */ }
    });
  } catch (e) {}
}
function hopperPull(c) {
  // hopper carts suck in nearby item entities (vanilla, 5 slots)
  try {
    let t = null;
    try { t = SV.tiles && SV.tiles.get("cart:" + c.id); } catch (e) {}
    if (!t) t = cartTile(c.id, 5);
    let best = null, bd = 1.44;
    SV.items.forEach((it) => {
      if (!it.e || !it.e.item || !it.e.item.id) return;
      if ((it.pickupDelay || 0) > 0) return;
      const dx = it.e.x - c.e.x, dy = it.e.y - c.e.y, dz = it.e.z - c.e.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bd) { bd = d2; best = it; }
    });
    if (!best) return;
    const id = best.e.item.id, n = Math.min(best.e.item.count | 0 || 1, 64);
    for (let i = 0; i < t.items.length; i++) {
      const s = t.items[i];
      if (s && s.id === id && !s.nbt && (s.count | 0) < 64) {
        const room = 64 - (s.count | 0), mv = Math.min(room, n);
        s.count += mv; best.e.item.count -= mv;
        if (best.e.item.count <= 0) removeItem(best.id);
        return;
      }
    }
    for (let i = 0; i < t.items.length; i++) {
      if (!t.items[i]) {
        t.items[i] = { id, count: n, nbt: null };
        best.e.item.count -= n;
        if (best.e.item.count <= 0) removeItem(best.id);
        return;
      }
    }
  } catch (e) {}
}
function cartTick(dt) {
  const g = game();
  if (SV.dead) { if (SV.rideCart >= 0) dismountCart(); return; }
  if (!survives()) return;
  try {
    if (SV.rideCart >= 0 && g.player && g.player.sneaking) dismountCart();
  } catch (e) {}
  try {
    SV.carts.forEach((c) => { try { cartSim(c, dt); } catch (e) {} });
  } catch (e) {}
  try { cartsCollide(); } catch (e) {}
  try { cartPlayerPush(); } catch (e) {}
  try {
    SV.carts.forEach((c) => {
      if (c.variant !== 5) return;
      c.pullAcc = (c.pullAcc | 0) + 1;
      if (c.pullAcc >= 4) { c.pullAcc = 0; try { hopperPull(c); } catch (e) {} }
    });
  } catch (e) {}
  // forget engine-destroyed carts
  try {
    const dead = [];
    SV.carts.forEach((c) => {
      try { if (!g.entities.get(c.id)) dead.push(c.id); } catch (e2) { dead.push(c.id); }
    });
    for (const id of dead) {
      try { SV.carts.delete(id); } catch (e2) {}
      try { SV.tiles && SV.tiles.delete("cart:" + id); } catch (e2) {}
      if (SV.rideCart === id) {
        SV.rideCart = -1;
        try { g.ridingEntityId = -1; } catch (e2) {}
        try { if (g.player) g.player.ridingEntity = null; } catch (e2) {}
        try { if (g.vehicle) g._dropVehicle(); } catch (e2) {}
      }
    }
  } catch (e) {}
}
function respawnSavedCarts() {
  if (!SV.savedCarts) return;
  const list = SV.savedCarts;
  SV.savedCarts = null;
  for (const b of list.slice(0, 20)) {
    try {
      const id = spawnCart(b.v | 0, b.x, b.y, b.z);
      if (id != null) {
        const c = SV.carts.get(id);
        if (c) {
          c.fuel = b.fuel | 0 || 0;
          if ((b.v | 0) === 1 || (b.v | 0) === 5) {
            const t = cartTile(id, b.v | 0);
            t.items = (b.items || []).map((s) => s ? { id: s.id, count: s.c | 0, nbt: s.n || null } : null);
            while (t.items.length < (b.v === 5 ? 5 : 27)) t.items.push(null);
          }
        }
      }
    } catch (e) {}
  }
  // detectors left ON by a save made while occupied: a restored world with
  // no cart sitting on them must read OFF (vanilla). Sweep around restored
  // carts (a cart that was on a detector at save time restores next to it).
  // Wide radius: test teleports can move a cart many blocks between its last
  // sim tick and the save, stranding the ON state far from the saved pos.
  try {
    SV.carts.forEach((c) => {
      const cx = Math.floor(c.e.x), cy = Math.floor(c.e.y), cz = Math.floor(c.e.z);
      for (let dy = -4; dy <= 1; dy++) for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) {
        let r = null;
        try { r = railInfo(cx + dx, cy + dy, cz + dz); } catch (e) { continue; }
        if (!r || r.type !== "detector_rail" || !r.powered) continue;
        let on = false;
        SV.carts.forEach((o) => {
          try {
            const cr = cartRailAt(o.e.x, o.e.y, o.e.z);
            if (cr && cr.bx === r.bx && cr.by === r.by && cr.bz === r.bz) on = true;
          } catch (e) {}
        });
        if (!on) {
          if (setDetector(r.bx, r.by, r.bz, false)) refreshRailPower(r.bx, r.by, r.bz);
        }
      }
    });
  } catch (e) {}
}
/* ---------------------------------------------------------- horses + donkeys + mules + llamas (Tier 1):
 * tame + saddle + ride + armor/chests, foals. The engine renders the models
 * natively (spawnMob types 29/11/46/36) and snaps riders like boats/carts,
 * but taming/steering/GUI contents are ours — and so is ridden steering:
 * the engine never drives a ridden horse offline (verified: attach + forced
 * KeyW + locked input over 40 ticks = zero motion), so horseTick steers
 * from live player input every tick. */
const HORSE_DEFS = {
  horse:  { type: 32, w: 1.4, h: 1.6, hp: [15, 30], speed: [5, 9], jump: [8, 11], loot: [["leather", 0, 2]] },
  donkey:  { type: 13, w: 1.4, h: 1.6, hp: [15, 30], speed: [5, 9], jump: [8, 11], loot: [["leather", 0, 2]] },
  mule:    { type: 49, w: 1.4, h: 1.6, hp: [15, 30], speed: [5, 9], jump: [8, 11], loot: [["leather", 0, 2]] },
  llama:   { type: 39, w: 0.9, h: 1.87, hp: [15, 30], speed: [4, 6], jump: [7, 8], loot: [["leather", 0, 2]] },
};
const HORSE_ARMOR_PTS = { leather: 0, iron_horse_armor: 5, golden_horse_armor: 7, diamond_horse_armor: 11 };
const HORSE_FOOD = {
  // [temper, heal HP, love]: wiki-approx (sugar/apple/wheat small, golden big)
  sugar: [3, 1, null], wheat: [3, 2, null], apple: [3, 3, null],
  golden_carrot: [5, 4, "equid"], golden_apple: [10, 10, "equid"], hay_block: [20, 20, "llama"],
};
const HORSE_TITLE = { horse: "Horse", donkey: "Donkey", mule: "Mule", llama: "Llama" };
function horseStorageSlots(h) {
  // vanilla: horses none, donkey/mule 15, llama 3 per strength (1-5)
  if (h.species === "donkey" || h.species === "mule") return 15;
  if (h.species === "llama") return (h.strength | 0 || 3) * 3;
  return 0;
}
function spawnHorse(species, x, y, z, opts) {
  const def = HORSE_DEFS[species];
  if (!def) return null;
  const g = game();
  const id = SV.eidSeq++;
  try {
    g.entities.spawnMob({
      entityId: id, x, y, z, yaw: Math.random() * 360, pitch: 0, type: def.type,
      entityUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return null;
    const o = opts || {};
    const maxHp = o.maxHp | 0 || (def.hp[0] + ((Math.random() * (def.hp[1] - def.hp[0] + 1)) | 0));
    const h = {
      id, e, species, def,
      x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0,
      w: def.w, h: def.h, ground: false,
      hp: o.hp != null ? o.hp : maxHp, maxHp,
      speed: o.speed || (def.speed[0] + Math.random() * (def.speed[1] - def.speed[0])),
      jumpV: o.jumpV || (def.jump[0] + Math.random() * (def.jump[1] - def.jump[0])),
      tame: !!o.tame, temper: o.temper | 0 || 0,
      maxTemper: o.maxTemper | 0 || (20 + ((Math.random() * 81) | 0)),
      saddle: !!o.saddle, armor: o.armor || null, chested: !!o.chested,
      strength: o.strength | 0 || (1 + ((Math.random() * 5) | 0)),
      variant: o.variant | 0 || ((Math.random() * 7) | 0), // coat record (engine renders default)
      growT: o.growT | 0 || 0, // foal countdown ticks (20 min); 0 = adult
      loveUntil: 0, coolUntil: 0, buckT: 0, fleeT: 0, fleeX: 0, fleeZ: 0,
      spitCd: 0, spitX: 0, spitZ: 0, spitAt: 0, hurtAt: 0,
      retarget: Math.random() * 3, wx: x, wz: z, herdCd: 0,
      lastETick: 0, // v1.12: driveHorseEnt snaps the interpolator on first sight
      tailT: 60 + ((Math.random() * 120) | 0), // tail-swish countdown (10 Hz)
    };
    if (h.growT > 0) { try { e.child = true; } catch (err) {} }
    // v1.12: engine visual flags (saddle/chest/rider/horse-type drive the
    // model + reins layers; rearing/grazing/tail are synced per-tick below)
    try {
      e.horseType = h.species === "donkey" ? 1 : h.species === "mule" ? 2 : 0;
      e.saddled = !!h.saddle;
      e.horseChest = !!h.chested;
    } catch (err) {}
    e.health = e.maxHealth = h.maxHp;
    if (h.chested) horseTile(id, h);
    SV.horses.set(id, h);
    try { syncEnt(e); } catch (err) {}
    return id;
  } catch (err) { return null; }
}
function removeHorse(id, drop) {
  const h = SV.horses.get(id);
  try { SV.horses.delete(id); } catch (e) {}
  try { SV.tiles && SV.tiles.delete("horse:" + id); } catch (e) {}
  if (id === SV.rideHorse) dismountHorse();
  try { game().entities.destroy([id]); } catch (e) {}
  if (drop && h) {
    // loot (vanilla: leather 0-2) + worn/carried gear pops off
    try {
      for (const [nm, lo, hi] of (h.def.loot || [])) {
        const bid = itemIdByName(nm);
        if (bid == null) continue;
        const n = lo + ((Math.random() * (hi - lo + 1)) | 0);
        for (let i = 0; i < n; i++) spawnItemEntity(h.e.x, h.e.y + 0.8, h.e.z, bid, 1);
      }
    } catch (e) {}
    const gear = [];
    if (h.saddle) gear.push("saddle");
    if (h.armor) gear.push(h.armor);
    if (h.chested) gear.push("chest");
    for (const nm of gear) {
      try {
        const bid = itemIdByName(nm);
        if (bid != null) spawnItemEntity(h.e.x, h.e.y + 0.8, h.e.z, bid, 1);
      } catch (e) {}
    }
    try {
      const t = SV.tiles && SV.tiles.get("horse:" + id);
      const items = (t && t.items ? t.items : []).filter((s) => s && s.id);
      if (items.length) SV["_horseSpill"] = items.map((s) => ({ id: s.id, count: s.count | 0 || 1 }));
    } catch (e) {}
    try {
      const sp = SV["_horseSpill"];
      if (sp && sp.length) for (const s of sp) {
        if (s && s.id) spawnItemEntity(h.e.x, h.e.y + 0.8, h.e.z, s.id, s.count | 0 || 1);
      }
    } catch (e) {}
    try { SV["_horseSpill"] = null; } catch (e) {}
    try {
      for (const v of orbSplit(1 + ((Math.random() * 3) | 0))) spawnXPOrb(h.e.x, h.e.y + 0.5, h.e.z, v);
    } catch (e) {}
  }
}
function horseTile(id, h) {
  const n = horseStorageSlots(h);
  const key = "horse:" + id;
  const t = { type: "horse", key, horse: id, x: 0, y: -999, z: 0, items: new Array(2 + n).fill(null) };
  try { SV.tiles = SV.tiles || new Map(); SV.tiles.set(key, t); } catch (e) {}
  return t;
}
function openHorseWindow(id) {
  const g = game();
  const h = SV.horses.get(id);
  if (!h || !h.tame) return false;
  const n = horseStorageSlots(h);
  SV.openTile = { key: "horse:" + id, wid: 1, horse: true };
  try {
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "EntityHorse", windowTitle: { text: HORSE_TITLE[h.species] || "Horse" }, slotCount: 2 + n, entityId: id });
  } catch (e) { SV.openTile = null; return false; }
  try {
    const w = g.window;
    if (!w) { SV.openTile = null; return false; }
    const t = (SV.tiles && SV.tiles.get("horse:" + id)) || horseTile(id, h);
    const slots = 2 + n;
    for (let i = 0; i < slots; i++) {
      const s = t.items[i];
      w.container[i] = s ? { id: s.id, count: s.count, nbt: s.nbt || undefined } : null;
    }
    w.properties = [];
  } catch (e) {}
  return true;
}
function saveHorseWindow() {
  // map EntityHorse slots back: 0 saddle, 1 armor, 2+ storage (validated)
  try {
    const key = SV.openTile && SV.openTile.key;
    if (!key || !SV.openTile.horse) return;
    const id = parseInt(String(key).slice(6), 10);
    const h = SV.horses.get(id);
    const w = game().window;
    if (!h || !w || !w.container) return;
    const t = (SV.tiles && SV.tiles.get(key)) || horseTile(id, h);
    const n = horseStorageSlots(h);
    const put = (stack) => {
      if (!stack || !stack.id) return null;
      return { id: stack.id, count: stack.count | 0 || 1, nbt: stack.nbt || null };
    };
    // slot 0: saddle only
    let s0 = w.container[0];
    if (s0 && s0.id) {
      let nm = null;
      try { nm = game().items.def(s0.id).name; } catch (e) {}
      if (nm === "saddle") {
        if (!h.saddle) { h.saddle = true; try { w.container[0] = null; } catch (e) {} }
      }
    }
    if (h.saddle && (!s0 || !s0.id)) {
      // saddle taken out -> unequipped (vanilla)
      h.saddle = false;
    }
    else if (s0 && s0.id && !h.saddle) {
      // something that isn't a saddle in slot 0: bounce it back to the player
      let nm0 = null;
      try { nm0 = game().items.def(s0.id).name; } catch (e) {}
      if (nm0 !== "saddle") {
        try { addPlayerItem(s0.id, s0.count | 0 || 1); } catch (e2) {}
        try { w.container[0] = null; } catch (e2) {}
      }
    }
    // slot 1: horse armor only (horses; validated by name)
    let s1 = w.container[1];
    if (s1 && s1.id) {
      let nm = null;
      try { nm = game().items.def(s1.id).name; } catch (e) {}
      const akey = nm === "leather_horse_armor" ? "leather" : nm;
      if (nm && HORSE_ARMOR_PTS[akey] != null && h.species === "horse") {
        if (h.armor !== nm) {
          if (h.armor) {
            const bid = itemIdByName(h.armor);
            if (bid != null) { try { addPlayerItem(bid, 1); } catch (e2) {} }
          }
          h.armor = nm;
          try { w.container[1] = null; } catch (e) {}
        }
      } else {
        // invalid here: bounce back to the player (vanilla slot rules)
        try { addPlayerItem(s1.id, s1.count | 0 || 1); } catch (e2) {}
        try { w.container[1] = null; } catch (e) {}
      }
    }
    if (h.armor && (!s1 || !s1.id)) h.armor = null;
    // storage slots (chested carriers only)
    if (h.chested && n > 0) {
      for (let i = 0; i < n; i++) {
        t.items[2 + i] = put(w.container[2 + i]);
      }
    }
    try { syncHorseLook(h); } catch (e) {}
  } catch (e) {}
}
function syncHorseLook(h) {
  // cosmetic record -> engine flags we know exist (more if metadata allows)
  try { if (h && h.e) h.e.health = h.hp; } catch (e) {}
}
function horseIdOf(t) {
  try {
    if (typeof t === "number") return SV.horses.has(t | 0) ? (t | 0) : -1;
    if (!t || typeof t !== "object") return -1;
    const ids = [];
    if (t.id != null && typeof t.id !== "object") ids.push(t.id | 0);
    if (t.entityId != null) ids.push(t.entityId | 0);
    for (const k of ["target", "entity", "mob", "victim"]) {
      const v = t[k];
      if (typeof v === "number") ids.push(v | 0);
      else if (v && typeof v === "object" && v.id != null) ids.push(v.id | 0);
    }
    let sawEntity = false;
    for (const id of ids) {
      if (SV.horses.has(id)) return id;
      try {
        const e = game().entities.get(id);
        if (e) {
          sawEntity = true; // an id that names a live non-horse entity:
          if (e.kind === "mob") { // someone else's click (cow, wolf...) — never steal it
            for (const [hid, h] of SV.horses) { if (h.e === e) return hid; }
            return -1;
          }
        }
      } catch (e2) {}
    }
    // a named live entity that isn't a horse claimed this click
    if (sawEntity) return -1;
    // proximity fallback for id-less wrappers (mirrors resolveMobTarget):
    // item-stack echoes ({id, count}) and block clicks never qualify
    if (typeof t.count === "number") return -1;
    if (t.type === "block" || t.x != null) return -1;
    let best = -1, bd = 3.5 * 3.5;
    try {
      const p = game().player;
      SV.horses.forEach((h) => {
        const dx = h.x - p.x, dz = h.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd && Math.abs(h.y - p.y) < 3) { bd = d2; best = h.id; }
      });
    } catch (e) {}
    return best;
  } catch (e) { return -1; }
}
function mountHorse(id) {
  const g = game();
  try {
    if (!survives() || SV.dead || SV.rideHorse >= 0) return false;
    if (SV.rideBoat >= 0 || SV.rideCart >= 0) return false;
    const h = SV.horses.get(id);
    if (!h) return false;
    const e = g.entities.get(id);
    if (!e) return false;
    const pid = g.entityId;
    g.entities.attach(pid, id);
    g.ridingEntityId = id;
    try { g.player.ridingEntity = e; } catch (err) {}
    SV.rideHorse = id;
    try { syncHorseLook(h); } catch (err) {}
    return true;
  } catch (err) { return false; }
}
function dismountHorse() {
  const g = game();
  const id = SV.rideHorse;
  SV.rideHorse = -1;
  try { g.entities.attach(g.entityId, -1); } catch (e) {}
  try { g.ridingEntityId = -1; } catch (e) {}
  try { if (g.player) g.player.ridingEntity = null; } catch (e) {}
  try { if (g.vehicle) g._dropVehicle(); } catch (e) {}
}
// P4: camels ride like horses (attach + sim-side steering in mobTick).
// Saddle first (right-click with saddle), then right-click to mount.
function mountCamel(id) {
  const g = game();
  try {
    if (!survives() || SV.dead || (SV.rideCamel | 0) >= 0) return false;
    if (SV.rideBoat >= 0 || SV.rideCart >= 0 || SV.rideHorse >= 0) return false;
    const m = SV.mobs.get(id);
    if (!m || m.species !== "camel" || m.baby) return false;
    if (!m.saddled) return false;
    const e = g.entities.get(id);
    if (!e) return false;
    const pid = g.entityId;
    g.entities.attach(pid, id);
    g.ridingEntityId = id;
    try { g.player.ridingEntity = e; } catch (err) {}
    SV.rideCamel = id;
    return true;
  } catch (err) { return false; }
}
function dismountCamel() {
  const g = game();
  const id = SV.rideCamel;
  SV.rideCamel = -1;
  try { g.entities.attach(g.entityId, -1); } catch (e) {}
  try { g.ridingEntityId = -1; } catch (e) {}
  try { if (g.player) g.player.ridingEntity = null; } catch (e) {}
  try { if (g.vehicle) g._dropVehicle(); } catch (e) {}
}
function feedHorse(h, hn, hand) {
  // returns true if the item was accepted (caller consumes 1)
  const info = HORSE_FOOD[hn];
  if (!info) return false;
  const isFoal = h.growT > 0;
  h.temper = Math.min(100, h.temper + info[0]);
  h.hp = Math.min(h.maxHp, h.hp + info[1]);
  try { syncHorseLook(h); } catch (e) {}
  if (isFoal) h.growT = Math.max(1, Math.floor(h.growT * 0.9)); // feeding takes 10% off
  try { game().particles.heart(h.x, h.y + 1.8, h.z); } catch (e) {}
  // love mode (vanilla: golden foods for equids, hay for llamas; mules sterile)
  const loveKind = info[2];
  if (loveKind && h.coolUntil < Date.now()) {
    const okKind = (loveKind === "equid" && h.species !== "llama") || (loveKind === "llama" && h.species === "llama");
    if (okKind && h.species !== "mule" && !isFoal && h.tame) {
      h.inLove = true;
      h.loveUntil = Date.now() + 30000;
    }
  }
  sfx("entity.generic.eat");
  return true;
}
function handleHorseUse(t, hand) {
  if (!survives() || SV.dead) return false;
  const id = horseIdOf(t);
  if (id < 0) return false;
  const h = SV.horses.get(id);
  if (!h) return false;
  const hs = hand === 1 ? offHeld() : mainHeld();
  const hn = hs && hs.id ? stackName(hs) : null;
  // NOTE: no !hn bail here — bare-hand right-click mounts (vanilla); only the
  // food/chest branches below need a held item.
  // one click can arrive through both use wrappers: swallow the echo
  try {
    if (SV.lastHorseId === id && Date.now() - (SV.lastHorseAt || 0) < 200) return true;
  } catch (e) {}
  const mark = () => { try { SV.lastHorseId = id; SV.lastHorseAt = Date.now(); } catch (e) {} };
  // food first (vanilla: feeding tames/heals/grows/breeds, never mounts)
  if (HORSE_FOOD[hn]) {
    if (!feedHorse(h, hn, hand)) return false;
    mark();
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    return true;
  }
  // chest onto a tamed carrier (vanilla; donkey/mule/llama only)
  if (hn === "chest" && h.tame && !h.chested &&
      (h.species === "donkey" || h.species === "mule" || h.species === "llama")) {
    mark();
    h.chested = true;
    horseTile(id, h);
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    sfx("entity.donkey.chest");
    return true;
  }
  // sneak + tame = tack window (vanilla)
  let sneaking = false;
  try { sneaking = !!game().player.sneaking; } catch (e) {}
  if (sneaking && h.tame) {
    mark();
    return openHorseWindow(id);
  }
  // mount (tame check + buck below)
  if (SV.rideHorse >= 0 || SV.rideBoat >= 0 || SV.rideCart >= 0) return false;
  mark();
  if (!h.tame) {
    // taming: every mount attempt raises temper; tame at maxTemper (vanilla)
    h.temper = Math.min(100, h.temper + 5 + ((Math.random() * 20) | 0));
    mountHorse(id);
    if (h.temper >= h.maxTemper) {
      h.tame = true;
      try { game().particles.heart(h.x, h.y + 1.8, h.z); } catch (e) {}
      sfx("entity.horse.ambient");
    } else {
      h.buckT = 8; // thrown after a beat (vanilla buck)
    }
    return true;
  }
  return mountHorse(id);
}
function horseDamage(id, n, kx, kz, o) {
  const h = SV.horses.get(id);
  if (!h || h.hp <= 0) return;
  try {
    const now = Date.now();
    if (now - (h.hurtAt || 0) < 500) return; // hit cooldown
    h.hurtAt = now;
  } catch (e) {}
  let dmg = n | 0 || 1;
  // horse armor soaks (vanilla points: iron 5 / gold 7 / diamond 11)
  try {
    const pts = h.armor ? (HORSE_ARMOR_PTS[h.armor] | 0) : 0;
    if (pts > 0) dmg = armorReduce(dmg, pts, 0);
  } catch (e) {}
  h.hp -= Math.max(1, Math.round(dmg));
  try { syncHorseLook(h); } catch (e) {}
  // flee / spit retaliation (vanilla: horses bolt, llamas spit back)
  try {
    if (h.species === "llama") {
      h.spitX = h.x - (kx || 0); h.spitZ = h.z - (kz || 0);
      h.spitAt = Date.now();
    } else {
      const d = Math.hypot(kx || 0, kz || 0) || 1;
      h.fleeT = 30;
      h.fleeX = h.x - (kx || 0) / d * 8; h.fleeZ = h.z - (kz || 0) / d * 8;
    }
  } catch (e) {}
  if (h.hp <= 0) horseDie(id, !!(o && o.byPlayer));
}
function horseDie(id, byPlayer) {
  const h = SV.horses.get(id);
  if (!h) return;
  removeHorse(id, true);
}
function breedHorses(a, b) {
  // vanilla pairs: horse+horse, donkey+donkey, llama+llama, horse+donkey=mule
  const sa = a.species, sb = b.species;
  let foal = null;
  if (sa === sb && (sa === "horse" || sa === "donkey" || sa === "llama")) foal = sa;
  else if ((sa === "horse" && sb === "donkey") || (sa === "donkey" && sb === "horse")) foal = "mule";
  if (!foal) return false;
  a.inLove = false; b.inLove = false;
  a.loveUntil = 0; b.loveUntil = 0;
  const now = Date.now();
  a.coolUntil = now + 300000; b.coolUntil = now + 300000; // 5-min cooldown
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const mix = (x, y) => (x + y) / 2 * (0.9 + Math.random() * 0.2);
  const id = spawnHorse(foal, mx, a.y, mz, {
    tame: true, temper: 100, maxTemper: 100,
    maxHp: Math.round(mix(a.maxHp, b.maxHp)),
    speed: mix(a.speed, b.speed), jumpV: mix(a.jumpV, b.jumpV),
    growT: 12000, variant: Math.random() < 0.5 ? a.variant : b.variant,
    strength: Math.random() < 0.5 ? a.strength : b.strength,
  });
  if (id == null) return false;
  try {
    game().particles.heart(mx, a.y + 1.8, mz);
    game().particles.heart(a.x, a.y + 1.8, a.z);
    game().particles.heart(b.x, b.y + 1.8, b.z);
  } catch (e) {}
  sfx("entity.chicken.egg");
  try {
    for (const v of orbSplit(1 + ((Math.random() * 7) | 0))) spawnXPOrb(mx, a.y + 0.5, mz, v);
  } catch (e) {}
  return true;
}
function horseGroundAt(x, z) {
  for (let y = 8; y >= -4; y--) {
    try {
      if (isSolidXYZ(Math.floor(x), y, Math.floor(z))) {
        if (!isSolidXYZ(Math.floor(x), y + 1, Math.floor(z)) && !isSolidXYZ(Math.floor(x), y + 2, Math.floor(z))) return y + 1;
      }
    } catch (e) {}
  }
  return null;
}
function horseTick(dt) {
  const g = game();
  if (SV.dead) { if (SV.rideHorse >= 0) dismountHorse(); return; }
  if (!survives()) return;
  const p = g.player;
  // sneak dismounts (same as boats/carts)
  try {
    if (SV.rideHorse >= 0 && p && p.sneaking) dismountHorse();
  } catch (e) {}
  // herd spawns: plains-style herds of 2-4 on grass (vanilla)
  try {
    SV.herdAcc = (SV.herdAcc | 0) + 1;
    if (SV.herdAcc >= 200 && SV.horses.size < 8) {
      SV.herdAcc = 0;
      const a = Math.random() * Math.PI * 2, d = 24 + Math.random() * 24;
      const hx = p.x + Math.cos(a) * d, hz = p.z + Math.sin(a) * d;
      const gy = horseGroundAt(hx, hz);
      if (gy != null) {
        let nm = "grass_block";
        try { nm = blockNameAt(Math.floor(hx), gy - 1, Math.floor(hz)); } catch (e) {}
        if (nm === "grass_block" || nm === "grass") {
          const n = 2 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n && SV.horses.size < 12; i++) {
            const r = Math.random();
            const sp = r < 0.75 ? "horse" : r < 0.9 ? "donkey" : "llama";
            spawnHorse(sp, hx + (Math.random() * 6 - 3), gy, hz + (Math.random() * 6 - 3));
          }
        }
      }
    }
  } catch (e) {}
  // love pairing (same 8-block rule as the other breedables)
  try {
    const now = Date.now();
    SV.horses.forEach((a) => {
      if (!a.inLove || a.loveUntil < now) { a.inLove = false; return; }
      SV.horses.forEach((b) => {
        if (b === a || !b.inLove || b.loveUntil < now) return;
        const dx = b.x - a.x, dz = b.z - a.z;
        if (dx * dx + dz * dz > 64) return;
        if (Math.abs(b.y - a.y) > 3) return;
        try { breedHorses(a, b); } catch (e) {}
      });
    });
  } catch (e) {}
  const dead = [];
  SV.horses.forEach((h) => {
    try {
      const e = h.e;
      if (!e) { dead.push(h.id); return; }
      // far-away untamed horses despawn (vanilla); tamed ones persist
      try {
        const dx = h.x - p.x, dz = h.z - p.z;
        if (!h.tame && dx * dx + dz * dz > 128 * 128) { dead.push(h.id); return; }
      } catch (e2) {}
      if (h.y < -64) { dead.push(h.id); return; } // void
      // foal growth (20 min; feeding takes 10% off, see feedHorse)
      if (h.growT > 0) {
        h.growT--;
        if (h.growT <= 0) { try { h.e.child = false; } catch (e2) {} }
      }
      // buck timer: untamed mount throws the rider (vanilla)
      if (h.buckT > 0) {
        h.buckT--;
        if (h.buckT <= 0 && !h.tame && h.id === SV.rideHorse) {
          dismountHorse();
          sfx("entity.horse.angry");
        }
      }
      let wantX = 0, wantZ = 0;
      const ridden = h.id === SV.rideHorse;
      if (ridden) {
        // ridden control: ours (the engine never drives offline)
        let fw = 0, st = 0, jump = false;
        try {
          const inp = g.input;
          if (inp && inp.down) {
            if (inp.down.has("KeyW")) fw += 1;
            if (inp.down.has("KeyS")) fw -= 1;
            if (inp.down.has("KeyD")) st += 1;
            if (inp.down.has("KeyA")) st -= 1;
            if (inp.down.has("Space")) jump = true;
          }
        } catch (e2) {}
        const canSteer = h.tame && h.saddle && h.species !== "llama";
        if (canSteer && (fw || st || jump)) {
          if (fw || st) {
            const yaw = (p.yaw || 0) * Math.PI / 180;
            const sy = Math.sin(yaw), cy = Math.cos(yaw);
            const dx = -sy * fw - cy * st, dz = cy * fw - sy * st;
            const l = Math.hypot(dx, dz) || 1;
            wantX = (dx / l) * h.speed; wantZ = (dz / l) * h.speed;
            faceMove(h, h.x + dx, h.z + dz);
          }
          if (jump && h.ground) h.vy = h.jumpV; // space hops from standstill too
        } else if (h.growT <= 0 && Math.abs(h.vx) + Math.abs(h.vz) > 0.3) {
          faceMove(h, h.x + h.vx, h.z + h.vz);
        }
      } else if (h.fleeT > 0) {
        h.fleeT--;
        const dx = h.x - h.fleeX, dz = h.z - h.fleeZ;
        const d = Math.hypot(dx, dz) || 1;
        wantX = (dx / d) * h.speed * 1.3; wantZ = (dz / d) * h.speed * 1.3;
        faceMove(h, h.fleeX + dx, h.fleeZ + dz);
      } else if (h.species === "llama") {
        // caravans: unridden llamas trail a ridden horse/llama (vanilla)
        let lead = null, bd = 12 * 12;
        try {
          const r = SV.horses.get(SV.rideHorse);
          if (r && r !== h) {
            const dx = r.x - h.x, dz = r.z - h.z;
            if (dx * dx + dz * dz < bd) lead = r;
          }
        } catch (e2) {}
        if (lead) {
          const dx = lead.x - h.x, dz = lead.z - h.z;
          const d = Math.hypot(dx, dz) || 1;
          if (d > 3) { wantX = (dx / d) * h.speed; wantZ = (dz / d) * h.speed; faceMove(h, lead.x, lead.z); }
        } else {
          h.retarget -= dt;
          if (h.retarget <= 0) {
            h.retarget = 3 + Math.random() * 4;
            if (Math.random() < 0.5) {
              const a2 = Math.random() * Math.PI * 2;
              h.wx = h.x + Math.cos(a2) * 4; h.wz = h.z + Math.sin(a2) * 4;
            } else { h.wx = h.x; h.wz = h.z; }
          }
          const wx = h.wx - h.x, wz = h.wz - h.z;
          const wd = Math.hypot(wx, wz);
          if (wd > 0.8) { wantX = (wx / wd) * h.speed * 0.4; wantZ = (wz / wd) * h.speed * 0.4; faceMove(h, h.wx, h.wz); }
        }
      } else {
        // graze/wander
        h.retarget -= dt;
        if (h.retarget <= 0) {
          h.retarget = 3 + Math.random() * 4;
          if (Math.random() < 0.5) {
            const a2 = Math.random() * Math.PI * 2;
            h.wx = h.x + Math.cos(a2) * 4; h.wz = h.z + Math.sin(a2) * 4;
          } else { h.wx = h.x; h.wz = h.z; }
        }
        const wx = h.wx - h.x, wz = h.wz - h.z;
        const wd = Math.hypot(wx, wz);
        if (wd > 0.8) { wantX = (wx / wd) * h.speed * 0.4; wantZ = (wz / wd) * h.speed * 0.4; faceMove(h, h.wx, h.wz); }
      }
      // llama spit: instant 1 dmg within 16 blocks, 5s cooldown (vanilla)
      try {
        if (h.species === "llama") {
          if (h.spitCd > 0) h.spitCd -= dt;
          if (h.spitAt && Date.now() - h.spitAt < 5000 && h.spitCd <= 0) {
            const sx = h.x - h.spitX, sz2 = h.z - h.spitZ;
            const sd = Math.hypot(sx, sz2) || 1;
            if (sd < 16) {
              h.spitCd = 5;
              sfx("entity.llama.spit");
              faceMove(h, h.x - sx, h.z - sz2);
              // v1: spits the player (the usual attacker); mob attackers
              // take no damage back (noted gap)
              damagePlayer(1, "mob", { killer: "Llama" });
            }
          }
        }
      } catch (e2) {}
      // integrate (same AABB pattern as mobs)
      const k = h.inWater ? 0.55 : 1;
      h.vx += clamp(wantX - h.vx, -0.5 * k, 0.5 * k);
      h.vz += clamp(wantZ - h.vz, -0.5 * k, 0.5 * k);
      h.vy = Math.max(h.vy - GRAV * dt, TERMINAL);
      if (!h.ground && (h.peakY == null || h.y > h.peakY)) h.peakY = h.y;
      const res = physMove(h, h.vx * dt, h.vy * dt, h.vz * dt);
      h.blocked = res.hitX || res.hitZ;
      h.ground = res.ground;
      if ((res.hitX || res.hitZ) && h.ground) {
        if (tryStep(h)) { h.vy = h.jumpV * 0.7; }
        else { h.vx *= 0.3; h.vz *= 0.3; }
      }
      if (h.ground && h.vy < 0) h.vy = 0;
      // fall damage (vanilla floor(fall - 3))
      if (!h.ground && res.ground && h.peakY != null) {
        const fall = h.peakY - h.y;
        if (fall > 3) {
          let fd = Math.floor(fall - 3);
          try {
            const pts = h.armor ? (HORSE_ARMOR_PTS[h.armor] | 0) : 0;
            if (pts > 0) fd = armorReduce(fd, pts, 0);
          } catch (e2) {}
          h.hp -= Math.round(fd);
          try { syncHorseLook(h); } catch (e2) {}
          if (h.hp <= 0) { horseDie(h.id, false); return; }
        }
        try { if (fall > 0.75) trampleAt(h.x, h.y, h.z); } catch (e2) {}
        h.peakY = null;
      }
      if (h.vy < -3 && h.ground) h.vy = 0;
      const lz = liquidAt(h.x, h.y + 0.2, h.z);
      h.inWater = lz === "water";
      if (lz === "lava") {
        h.lavaAcc = (h.lavaAcc || 0) + dt;
        if (h.lavaAcc >= 0.5) { h.lavaAcc = 0; h.hp -= 4; try { syncHorseLook(h); } catch (e2) {} }
        if (h.hp <= 0) { horseDie(h.id, false); return; }
      }
      try {
        // v1.12: same interpolator path as mobs (limb swings) + the horse
        // model's head/rear/graze/mouth/tail flags — see driveHorseEnt
        driveHorseEnt(h);
      } catch (e2) {}
    } catch (e) {}
  });
  for (const id of dead) {
    try { removeHorse(id, false); } catch (e) {}
  }
  // forget engine-destroyed horses
  try {
    const gone = [];
    SV.horses.forEach((h) => {
      try { if (!g.entities.get(h.id)) gone.push(h.id); } catch (e2) { gone.push(h.id); }
    });
    for (const id of gone) {
      try { SV.horses.delete(id); } catch (e2) {}
      try { SV.tiles && SV.tiles.delete("horse:" + id); } catch (e2) {}
      if (SV.rideHorse === id) {
        SV.rideHorse = -1;
        try { g.ridingEntityId = -1; } catch (e2) {}
        try { if (g.player) g.player.ridingEntity = null; } catch (e2) {}
        try { if (g.vehicle) g._dropVehicle(); } catch (e2) {}
      }
    }
  } catch (e) {}
}
function respawnSavedHorses() {
  if (!SV.savedHorses) return;
  const list = SV.savedHorses;
  SV.savedHorses = null;
  for (const b of list.slice(0, 20)) {
    try {
      if (!HORSE_DEFS[b.sp]) continue;
      const id = spawnHorse(b.sp, b.x, b.y, b.z, {
        hp: b.hp, maxHp: b.mhp, speed: b.speed, jumpV: b.jumpV,
        tame: b.tame, temper: b.temper, maxTemper: b.mtem,
        saddle: b.saddle, armor: b.armor, chested: b.chest, strength: b.str,
        variant: b.v, growT: b.grow,
      });
      if (id != null && b.items) {
        const h = SV.horses.get(id);
        if (h) {
          const t = horseTile(id, h);
          t.items = (b.items || []).map((s) => s ? { id: s.id, count: s.c | 0, nbt: s.n || null } : null);
          while (t.items.length < 2 + horseStorageSlots(h)) t.items.push(null);
        }
      }
    } catch (e) {}
  }
}
/* ---------------------------------------------------------- crops/stems (Tier 1):
 * hoe->farmland, planting, growth, bone meal, trample, harvest. The engine
 * renders crop stages natively (state ids) but advances/places nothing
 * offline (verified: wheat sits at age 0 forever, hoe right-click is a
 * no-op), so the whole loop is ours; blocks persist as world diffs, so
 * SV.crops is only a runtime watch-set (rebuilt by the setState wrapper as
 * chunks stream, pruned past 1200 with far ones dropped first).
 * State bases are NATIVE 1.18 ids resolved by NAME at boot (initStateIds
 * below) — the old 1.15.2 literals went stale and silently wrote wrong
 * blocks (till made redstone wire, bone meal made note blocks). */
/* State ids below are resolved by NAME at boot (initStateIds): the 1.15.2
 * literals went stale in 1.18 (farmland 3363->3422, wheat 3355->3414, fire
 * 1136->1527, ...). CROP_LO is the single source: kindOf/age/growth/fruit
 * all derive from it, so a future registry shift only touches the table. */
let CROP_LO = {
  wheat: 3355, carrots: 5794, potatoes: 5802, beetroots: 8683,
  melon_stem: 4764, pumpkin_stem: 4756, sugar_cane: 3946, cactus: 3929,
  farmland: 3363, wart: 5329, chorusFlower: 9378, // v1.16.0: chorus_flower age 0 (1.18 verified live)
  torchflower: 12350, // P4: torchflower_crop age 0 (1.19 verified live)
};
// state-count per crop base (age 0..max for growers; heights for cane/cactus;
// moisture for farmland) — 1.18 verified: wheat 3414-3421, carrots 6536-6543,
// potatoes 6544-6551, beetroots 9469-9472, stems 4853-4860/4845-4852,
// cane 4017-4032, cactus 4000-4015, farmland 3422-3429, wart 5329-5332
const CROP_SIZE = { wheat: 8, carrots: 8, potatoes: 8, beetroots: 4, melon_stem: 8, pumpkin_stem: 8, sugar_cane: 16, cactus: 16, farmland: 8, wart: 4, chorusFlower: 6, torchflower: 3 };
let FRUIT_ST = { melon: 4747, pumpkin: 3996 }; // 1.18: 4836/4067
let ATTACH_LO = { melon: 4752, pumpkin: 4748 }; // 1.18: 4841/4837
let FIRE_ST = 1136; // 1.18: fire default 1527
let FLOWER_ST = { dandelion: 1112, poppy: 1111, cornflower: 1115, azure_bluet: 1120, tuft: 1041 };
let DIRT_ST = 10; // dirt is 10 in both registries (verified live)
let CHORUS_PLANT_ST = 9377; // v1.16.0: chorus_plant default (1.18 verified live)
function stateOfBlock(name) {
  try {
    const b = game().assets.data.blocks.find((x) => x && x.name === name);
    return b ? b.defaultState : null;
  } catch (e) { return null; }
}
function initStateIds() {
  // name-based: automatically yields NATIVE 1.18 default states (falls back
  // to the 1.15.2 literals above if a name ever goes missing)
  const get = (name, fb) => { const v = stateOfBlock(name); return v == null ? fb : v; };
  CROP_LO = {
    wheat: get("wheat", CROP_LO.wheat), carrots: get("carrots", CROP_LO.carrots),
    potatoes: get("potatoes", CROP_LO.potatoes), beetroots: get("beetroots", CROP_LO.beetroots),
    melon_stem: get("melon_stem", CROP_LO.melon_stem), pumpkin_stem: get("pumpkin_stem", CROP_LO.pumpkin_stem),
    sugar_cane: get("sugar_cane", CROP_LO.sugar_cane), cactus: get("cactus", CROP_LO.cactus),
    farmland: get("farmland", CROP_LO.farmland), wart: get("nether_wart", CROP_LO.wart),
    chorusFlower: get("chorus_flower", CROP_LO.chorusFlower), // v1.16.0
    torchflower: get("torchflower_crop", CROP_LO.torchflower), // P4
  };
  FRUIT_ST = { melon: get("melon", FRUIT_ST.melon), pumpkin: get("pumpkin", FRUIT_ST.pumpkin) };
  ATTACH_LO = { melon: get("attached_melon_stem", ATTACH_LO.melon), pumpkin: get("attached_pumpkin_stem", ATTACH_LO.pumpkin) };
  FIRE_ST = get("fire", FIRE_ST);
  FLOWER_ST = {
    dandelion: get("dandelion", FLOWER_ST.dandelion), poppy: get("poppy", FLOWER_ST.poppy),
    cornflower: get("cornflower", FLOWER_ST.cornflower), azure_bluet: get("azure_bluet", FLOWER_ST.azure_bluet),
    tuft: get("grass", FLOWER_ST.tuft),
  };
  DIRT_ST = get("dirt", DIRT_ST);
  CHORUS_PLANT_ST = get("chorus_plant", CHORUS_PLANT_ST); // v1.16.0
}
const CROP_MAXAGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3, melon_stem: 7, pumpkin_stem: 7, wart: 3, torchflower: 2 };
const SEED_CROP = {
  wheat_seeds: "wheat", carrot: "carrots", potato: "potatoes",
  beetroot_seeds: "beetroots", melon_seeds: "melon_stem", pumpkin_seeds: "pumpkin_stem",
  nether_wart: "wart", // v1.15.0: plants on soul sand, not farmland
  torchflower_seeds: "torchflower", // P4: sniffer seeds grow torchflowers
};
const ATTACH_FACING = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // N,S,W,E (engine enum order)
function cropKindOf(st) {
  // state id -> crop key (farmland included); null when not a crop block.
  // Ranges derive from CROP_LO so registry shifts can't strand them.
  const s = st | 0;
  const inR = (k) => s >= CROP_LO[k] && s < CROP_LO[k] + (CROP_SIZE[k] || 0);
  if (inR("wheat")) return "wheat";
  if (inR("carrots")) return "carrots";
  if (inR("potatoes")) return "potatoes";
  if (inR("beetroots")) return "beetroots";
  if (inR("melon_stem")) return "melon_stem";
  if (inR("pumpkin_stem")) return "pumpkin_stem";
  if (s >= ATTACH_LO.melon && s < ATTACH_LO.melon + 4) return "attached_melon";
  if (s >= ATTACH_LO.pumpkin && s < ATTACH_LO.pumpkin + 4) return "attached_pumpkin";
  if (s >= CROP_LO.wart && s < CROP_LO.wart + 4) return "wart"; // v1.15.0: nether wart, soul sand soil
  if (inR("sugar_cane")) return "sugar_cane";
  if (inR("cactus")) return "cactus";
  if (inR("farmland")) return "farmland";
  if (inR("chorusFlower")) return "chorus_flower"; // v1.16.0: flower ages tracked; plant uses def.drops
  if (inR("torchflower")) return "torchflower"; // P4
  return null;
}
function cropAge(st, kind) {
  const lo = CROP_LO[kind === "attached_melon" ? "melon_stem" : kind === "attached_pumpkin" ? "pumpkin_stem" : kind];
  // attached stems use their own base (4 facings)
  if (kind === "attached_melon") return (st | 0) - ATTACH_LO.melon;
  if (kind === "attached_pumpkin") return (st | 0) - ATTACH_LO.pumpkin;
  return (st | 0) - (lo | 0);
}
function trackCrop(x, y, z, s) {
  // watch-set maintenance from the setState wrapper (hot path: keep tiny)
  try {
    if (!SV.crops) return;
    const k = cropKindOf(s);
    const key = x + "," + y + "," + z;
    if (k) {
      if (SV.crops.size > 1200 && !SV.crops.has(key)) {
        // prune far entries first (static pruned farms stop growing past the
        // cap until a block changes near them — documented, farms are small)
        try {
          const p = game().player;
          let worst = null, wd = -1;
          SV.crops.forEach((v, kk) => {
            const dx = v.x - p.x, dz = v.z - p.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > wd) { wd = d2; worst = kk; }
          });
          if (worst) SV.crops.delete(worst);
        } catch (e) {}
      }
      SV.crops.set(key, { x: x | 0, y: y | 0, z: z | 0 });
    } else {
      if (SV.crops.has(key)) SV.crops.delete(key);
    }
  } catch (e) {}
}
function cropLight(x, y, z) {
  // crops advance at light 9+ (vanilla); max of sky + block light
  try {
    const w = game().world;
    let s = 0, b = 0;
    try { s = w.getSkyLight(x, y + 1, z) | 0; } catch (e) {}
    try { b = w.getBlockLight(x, y + 1, z) | 0; } catch (e) {}
    return Math.max(s, b);
  } catch (e) { return 15; }
}
function nearWater(x, y, z) {
  // farmland drinks within 4 blocks horizontal, water at same level or 1 below
  try {
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -1; dy <= 0; dy++) {
        try { if (liquidAt(x + dx, y + dy, z + dz) === "water") return true; } catch (e) {}
      }
    }
  } catch (e) {}
  return false;
}
function cropBreakDrops(state) {
  // age-aware harvest table (item NAMES, bonusDrops convention); null = not a crop
  try {
    const d = defOf(state);
    if (!d) return null;
    const nm = d.name;
    const R = Math.random;
    const seeds = (n, k) => { const a = []; const c = (R() * (k + 1)) | 0; for (let i = 0; i < c; i++) a.push(n); return a; };
    if (nm === "wheat") {
      const a = (state | 0) - CROP_LO.wheat;
      const s = seeds("wheat_seeds", 3);
      return a >= 7 ? ["wheat"].concat(s) : s;
    }
    if (nm === "carrots") {
      const a = (state | 0) - CROP_LO.carrots;
      if (a < 7) return ["carrot"];
      const a2 = ["carrot"]; const ex = (R() * 4) | 0; for (let i = 0; i < ex; i++) a2.push("carrot");
      return a2;
    }
    if (nm === "potatoes") {
      const a = (state | 0) - CROP_LO.potatoes;
      if (a < 7) return ["potato"];
      const a2 = ["potato"]; const ex = (R() * 4) | 0; for (let i = 0; i < ex; i++) a2.push("potato");
      if (R() < 0.02) a2.push("poisonous_potato");
      return a2;
    }
    if (nm === "beetroots") {
      const a = (state | 0) - CROP_LO.beetroots;
      const s = seeds("beetroot_seeds", 3);
      return a >= 3 ? ["beetroot"].concat(s) : s;
    }
    if (nm === "torchflower_crop") {
      // P4: mature (age 2) yields the flower; young yields nothing (vanilla).
      // Seeds come only from sniffers.
      const a = (state | 0) - CROP_LO.torchflower;
      return a >= 2 ? ["torchflower"] : [];
    }
    if (nm === "nether_wart") {
      // v1.15.0: mature (age 3) yields 2-4, young yields 1 (vanilla)
      const a = (state | 0) - CROP_LO.wart;
      if (a < 3) return ["nether_wart"];
      const out = ["nether_wart"];
      const ex = 1 + ((R() * 3) | 0);
      for (let i = 0; i < ex; i++) out.push("nether_wart");
      return out;
    }
    if (nm === "melon_stem" || nm === "attached_melon_stem") return seeds("melon_seeds", 3);
    if (nm === "pumpkin_stem" || nm === "attached_pumpkin_stem") return seeds("pumpkin_seeds", 3);
    if (nm === "melon") {
      const a2 = []; const n = 3 + ((R() * 5) | 0);
      for (let i = 0; i < n; i++) a2.push("melon_slice");
      return a2;
    }
    // v1.16.0: chorus flower drops itself (plant falls through to def.drops = fruit)
    if (nm === "chorus_flower") return ["chorus_flower"];
  } catch (e) {}
  return null;
}
function popCrop(x, y, z) {
  // unsupported crop pops with its normal loot (not player-mined: no wear/exhaust)
  try {
    const st = game().world.getState(x | 0, y | 0, z | 0);
    const drops = cropBreakDrops(st) || dropIdForState(st);
    SV.grief = true;
    try { game().world.setState(x | 0, y | 0, z | 0, 0); } finally { SV.grief = false; }
    if (drops) for (const id of drops) {
      const iid = (typeof id === "number") ? id : itemIdByName(id);
      if (iid != null) { try { spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, iid, 1); } catch (e) {} }
    }
  } catch (e) {}
}
function trampleAt(x, y, z) {
  // landing on farmland with fall > 0.75 reverts it to dirt + pops the crop
  try {
    const bx = Math.floor(x), by = Math.floor(y - 0.5), bz = Math.floor(z);
    if (blockNameAt(bx, by, bz) !== "farmland") return;
    SV.grief = true;
    try { game().world.setState(bx, by, bz, DIRT_ST); } finally { SV.grief = false; }
    try { SV.crops && SV.crops.delete(bx + "," + by + "," + bz); } catch (e) {}
    try {
      const cs = game().world.getState(bx, by + 1, bz);
      if (cropKindOf(cs) && CROP_MAXAGE[cropKindOf(cs)] != null) popCrop(bx, by + 1, bz);
    } catch (e) {}
    sfx("block.grass.break");
  } catch (e) {}
}
function tillSoil(bx, by, bz) {
  // hoe use: dirt/grass -> farmland, coarse dirt -> dirt (vanilla)
  try {
    const above = game().world.getState(bx, by + 1, bz);
    if (above !== 0) return false;
    const nm = blockNameAt(bx, by, bz);
    if (nm === "coarse_dirt") {
      game().world.setState(bx, by, bz, DIRT_ST);
      sfx("item.hoe.till");
      return true;
    }
    if (nm === "dirt" || nm === "grass_block") {
      game().world.setState(bx, by, bz, CROP_LO.farmland);
      sfx("item.hoe.till");
      return true;
    }
  } catch (e) {}
  return false;
}
function plantCrop(itemName, ax, ay, az) {
  // cell (ax,ay,az) must be air; soil crops need farmland below
  try {
    const g = game();
    if (g.world.getState(ax | 0, ay | 0, az | 0) !== 0) return false;
    const crop = SEED_CROP[itemName];
    if (crop) {
      if (crop === "wart") {
        // v1.15.0: nether wart plants on soul sand (vanilla), any light
        if (blockNameAt(ax, ay - 1, az) !== "soul_sand") return false;
        g.world.setState(ax | 0, ay | 0, az | 0, CROP_LO.wart);
        sfx("item.crop.plant");
        return true;
      }
      if (blockNameAt(ax, ay - 1, az) !== "farmland") return false;
      g.world.setState(ax | 0, ay | 0, az | 0, CROP_LO[crop]);
      sfx("item.crop.plant");
      return true;
    }
    if (itemName === "sugar_cane") {
      const below = blockNameAt(ax, ay - 1, az);
      if (below !== "sand" && below !== "red_sand" && below !== "dirt" &&
          below !== "grass_block" && below !== "coarse_dirt" && below !== "podzol") return false;
      let wet = false;
      try {
        const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dz] of nb) {
          if (liquidAt(ax + dx, ay, az + dz) === "water" || liquidAt(ax + dx, ay - 1, az + dz) === "water") { wet = true; break; }
        }
      } catch (e) {}
      if (!wet) return false;
      g.world.setState(ax | 0, ay | 0, az | 0, CROP_LO.sugar_cane);
      sfx("item.crop.plant");
      return true;
    }
    if (itemName === "cactus") {
      const below = blockNameAt(ax, ay - 1, az);
      if (below !== "sand" && below !== "red_sand" && below !== "cactus") return false;
      try {
        const nb = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
        for (const [dx, dy, dz] of nb) { if (isSolidXYZ(ax + dx, ay + dy, az + dz)) return false; }
      } catch (e) { return false; }
      g.world.setState(ax | 0, ay | 0, az | 0, CROP_LO.cactus);
      sfx("item.crop.plant");
      return true;
    }
    // v1.16.0: chorus flower plants on end stone or chorus plant (vanilla)
    if (itemName === "chorus_flower") {
      const below = blockNameAt(ax, ay - 1, az);
      if (below !== "end_stone" && below !== "chorus_plant") return false;
      g.world.setState(ax | 0, ay | 0, az | 0, CROP_LO.chorusFlower);
      sfx("item.crop.plant");
      return true;
    }
  } catch (e) {}
  return false;
}
function applyBoneMeal(x, y, z) {
  // returns true when the meal was consumed (success)
  try {
    const g = game();
    const st = g.world.getState(x | 0, y | 0, z | 0);
    const kind = cropKindOf(st);
    const maxAge = kind && CROP_MAXAGE[kind];
    if (maxAge != null) {
      if (kind === "wart") return false; // vanilla: bone meal does nothing
      const age = (st | 0) - (CROP_LO[kind] | 0);
      if (age >= maxAge) return false; // mature: no effect (vanilla puffs)
      let adv = 2 + ((Math.random() * 4) | 0);
      if (kind === "beetroots") adv = 1;
      if (kind === "melon_stem" || kind === "pumpkin_stem") adv = 1 + ((Math.random() * 2) | 0);
      g.world.setState(x | 0, y | 0, z | 0, Math.min(CROP_LO[kind] + maxAge, (st | 0) + adv));
      sfx("item.bone_meal.use");
      return true;
    }
    if (defOf(st) && defOf(st).name === "grass_block") {
      if (g.world.getState(x | 0, (y | 0) + 1, z | 0) !== 0) return false;
      let placed = 0;
      const flowers = [FLOWER_ST.dandelion, FLOWER_ST.poppy, FLOWER_ST.cornflower, FLOWER_ST.azure_bluet];
      for (let i = 0; i < 12 && placed < 8; i++) {
        const px = (x | 0) + ((Math.random() * 7) | 0) - 3;
        const pz = (z | 0) + ((Math.random() * 7) | 0) - 3;
        try {
          if (blockNameAt(px, y | 0, pz) !== "grass_block") continue;
          if (g.world.getState(px, (y | 0) + 1, pz) !== 0) continue;
          const f = Math.random() < 0.12 ? flowers[(Math.random() * flowers.length) | 0] : FLOWER_ST.tuft;
          g.world.setState(px, (y | 0) + 1, pz, f);
          placed++;
        } catch (e) {}
      }
      if (placed > 0) { sfx("item.bone_meal.use"); return true; }
      return false;
    }
  } catch (e) {}
  return false;
}
function handleHoeUse(t, hand) {
  if (!survives() || SV.dead) return false;
  try {
    const hn = stackName(handStack(hand));
    if (!hn || hn.slice(-4) !== "_hoe") return false;
    if (t.type !== "block" && t.x == null) return false;
    if (!tillSoil(t.x, t.y, t.z)) return false;
    if (hand === 1) wearOff(1); else wearMain(1);
    return true;
  } catch (e) { return false; }
}
function handlePlantUse(t, hand) {
  if (!survives() || SV.dead) return false;
  try {
    const hs = handStack(hand);
    const hn = hs && hs.id ? stackName(hs) : null;
    if (!hn) return false;
    if (!SEED_CROP[hn] && hn !== "sugar_cane" && hn !== "cactus" && hn !== "chorus_flower") return false;
    let ax, ay, az;
    if (SEED_CROP[hn]) {
      // seeds plant ONTO the farmland block itself (vanilla click target);
      // nether wart plants onto soul sand instead (vanilla)
      if (t.type !== "block" && t.x == null) return false;
      const soil = blockNameAt(t.x, t.y, t.z);
      if (hn === "nether_wart" ? soil !== "soul_sand" : soil !== "farmland") return false;
      ax = t.x; ay = t.y + 1; az = t.z;
    } else {
      // cane/cactus plant into the adjacent cell (face offset)
      if (t.face == null) return false;
      const d = (typeof FACE_D !== "undefined" && FACE_D[t.face | 0]) || [0, 1, 0];
      ax = (t.x | 0) + d[0]; ay = (t.y | 0) + d[1]; az = (t.z | 0) + d[2];
    }
    if (!plantCrop(hn, ax, ay, az)) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    return true;
  } catch (e) { return false; }
}
function handleBoneUse(t, hand) {
  if (!survives() || SV.dead) return false;
  try {
    const hn = stackName(handStack(hand));
    if (hn !== "bone_meal") return false;
    if (t.type !== "block" && t.x == null) return false;
    if (!applyBoneMeal(t.x, t.y, t.z)) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
    else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    return true;
  } catch (e) { return false; }
}
function cropTick(dt) {
  // slow (1 Hz) watch-set simulation: moisture, growth, fruiting, support
  if (!survives()) return;
  SV.cropAcc = (SV.cropAcc || 0) + dt;
  if (SV.cropAcc < 1) return;
  SV.cropAcc = 0;
  const g = game();
  let n = 0;
  try {
    for (const [key, v] of SV.crops) {
      if (n++ >= 80) break;
      try {
        // unloaded chunks read back as air (getState -> 0) — skip them
        // instead of pruning, or walking away would wipe the watch-set.
        try { if (!g.world.getChunk(Math.floor(v.x / 16), Math.floor(v.z / 16))) continue; } catch (e) {}
        const st = g.world.getState(v.x, v.y, v.z);
        const kind = cropKindOf(st);
        if (!kind) { SV.crops.delete(key); continue; }
        if (kind === "farmland") {
          // moisture: drink nearby water, else dry out (bare dry reverts)
          let moist = st - CROP_LO.farmland;
          if (nearWater(v.x, v.y, v.z)) {
            if (moist < 7) g.world.setState(v.x, v.y, v.z, CROP_LO.farmland + 7);
          } else if (moist > 0) {
            if (Math.random() < 0.25) g.world.setState(v.x, v.y, v.z, st - 1);
          } else {
            const above = g.world.getState(v.x, v.y + 1, v.z);
            // dry + bare farmland reverts slowly (vanilla; not instantly, so
            // fresh-tilled soil survives until the player plants or hydrates)
            if (!cropKindOf(above) && Math.random() < 0.05) {
              SV.grief = true;
              try { g.world.setState(v.x, v.y, v.z, DIRT_ST); } finally { SV.grief = false; }
              SV.crops.delete(key);
            }
          }
          continue;
        }
        const maxAge = CROP_MAXAGE[kind];
        if (maxAge != null) {
          // soil crops + stems: need farmland below (pop otherwise);
          // wart needs soul sand instead (vanilla)
          const wantSoil = kind === "wart" ? "soul_sand" : "farmland";
          if (blockNameAt(v.x, v.y - 1, v.z) !== wantSoil) { popCrop(v.x, v.y, v.z); SV.crops.delete(key); continue; }
          const age = st - CROP_LO[kind];
          if (age < maxAge) {
            // wart grows in any light on dry soul sand (vanilla nether rules)
            if (kind !== "wart" && cropLight(v.x, v.y, v.z) < 9) continue;
            const moist = kind === "wart" ? true : (() => { try { const b = g.world.getState(v.x, v.y - 1, v.z); return (b - CROP_LO.farmland) >= 4; } catch (e) { return false; } })();
            const p = moist ? 1 / 20 : 1 / 80; // ~17 min hydrated, ~70 min dry
            if (Math.random() < p) g.world.setState(v.x, v.y, v.z, st + 1);
          } else if ((kind === "melon_stem" || kind === "pumpkin_stem") && Math.random() < 1 / 5) {
            // mature stem fruits onto adjacent dirt/grass/farmland, then attaches
            const dirs = [[1, 0, 3], [-1, 0, 2], [0, 1, 1], [0, -1, 0]]; // dx,dz,facing
            const d = dirs[(Math.random() * 4) | 0];
            const fx = v.x + d[0], fz = v.z + d[1];
            try {
              if (g.world.getState(fx, v.y, fz) !== 0) continue;
              const gb = blockNameAt(fx, v.y - 1, fz);
              if (gb !== "dirt" && gb !== "grass_block" && gb !== "farmland") continue;
              SV.grief = true;
              try {
                // native fruit states (single-state blocks)
                g.world.setState(fx, v.y, fz, kind === "melon_stem" ? FRUIT_ST.melon : FRUIT_ST.pumpkin);
                g.world.setState(v.x, v.y, v.z, (kind === "melon_stem" ? ATTACH_LO.melon : ATTACH_LO.pumpkin) + d[2]);
              } finally { SV.grief = false; }
            } catch (e) {}
          }
          continue;
        }
        if (kind === "sugar_cane" || kind === "cactus") {
          // support: anything but air below (planting validated the rest)
          const below = g.world.getState(v.x, v.y - 1, v.z);
          if (below === 0) { popCrop(v.x, v.y, v.z); SV.crops.delete(key); continue; }
          if (kind === "cactus") {
            // cactus pops when boxed in (vanilla) + pricks overlapping entities
            let boxed = false;
            try {
              const nb = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
              for (const [dx, dy, dz] of nb) { if (isSolidXYZ(v.x + dx, v.y + dy, v.z + dz)) { boxed = true; break; } }
            } catch (e) {}
            if (boxed) { popCrop(v.x, v.y, v.z); SV.crops.delete(key); continue; }
            try {
              const p = g.player;
              if (Math.abs(p.x - (v.x + 0.5)) < 0.95 && Math.abs(p.z - (v.z + 0.5)) < 0.95 && p.y > v.y - 1 && p.y < v.y + 1) {
                try { damagePlayer(1, "cactus"); } catch (e) {}
              }
              SV.mobs.forEach((m) => {
                try {
                  if (Math.abs(m.x - (v.x + 0.5)) < 0.95 && Math.abs(m.z - (v.z + 0.5)) < 0.95 && m.y > v.y - 1 && m.y < v.y + 1) {
                    damageMob(m.id, 1, m.x - (v.x + 0.5), m.z - (v.z + 0.5), {});
                  }
                } catch (e) {}
              });
              SV.horses.forEach((h) => {
                try {
                  if (Math.abs(h.x - (v.x + 0.5)) < 1.05 && Math.abs(h.z - (v.z + 0.5)) < 1.05 && h.y > v.y - 1 && h.y < v.y + 1.6) {
                    horseDamage(h.id, 1, h.x - (v.x + 0.5), h.z - (v.z + 0.5), {});
                  }
                } catch (e) {}
              });
            } catch (e) {}
          }
          const age = st - CROP_LO[kind];
          if (age >= 15) {
            // fully aged: grow one up if room (max 3 high), reset to 0
            let hgt = 1;
            try {
              for (let i = 1; i < 3; i++) { if (cropKindOf(g.world.getState(v.x, v.y - i, v.z)) === kind) hgt++; else break; }
            } catch (e) {}
            try {
              if (hgt < 3 && g.world.getState(v.x, v.y + 1, v.z) === 0) {
                SV.grief = true;
                try {
                  g.world.setState(v.x, v.y + 1, v.z, CROP_LO[kind]);
                  g.world.setState(v.x, v.y, v.z, CROP_LO[kind]);
                } finally { SV.grief = false; }
              }
            } catch (e) {}
          } else if (Math.random() < 1 / 10) {
            g.world.setState(v.x, v.y, v.z, st + 1);
          }
          continue;
        }
        // v1.16.0: chorus flower — support on end stone / plant (pops
        // otherwise), then grows a plant segment + one age older flower
        // above while age < 5 (simplified vanilla: no side branches)
        if (kind === "chorus_flower") {
          const below = blockNameAt(v.x, v.y - 1, v.z);
          if (below !== "end_stone" && below !== "chorus_plant") { popCrop(v.x, v.y, v.z); SV.crops.delete(key); continue; }
          const age = st - CROP_LO.chorusFlower;
          if (age < 5 && Math.random() < 1 / 10) {
            try {
              if (g.world.getState(v.x, v.y + 1, v.z) === 0) {
                SV.grief = true;
                try {
                  g.world.setState(v.x, v.y, v.z, CHORUS_PLANT_ST);
                  g.world.setState(v.x, v.y + 1, v.z, CROP_LO.chorusFlower + age + 1);
                } finally { SV.grief = false; }
              }
            } catch (e) {}
          }
          continue;
        }
        // attached stems: unattach when the fruit is gone (vanilla)
        if (kind === "attached_melon" || kind === "attached_pumpkin") {
          const di = (st | 0) - (kind === "attached_melon" ? ATTACH_LO.melon : ATTACH_LO.pumpkin);
          const f = ATTACH_FACING[di] || [0, 0];
          try {
            const fs = g.world.getState(v.x + f[0], v.y, v.z + f[1]);
            const want = kind === "attached_melon" ? FRUIT_ST.melon : FRUIT_ST.pumpkin;
            if (fs !== want) g.world.setState(v.x, v.y, v.z, (kind === "attached_melon" ? CROP_LO.melon_stem : CROP_LO.pumpkin_stem) + 7);
          } catch (e) {}
          continue;
        }
      } catch (e) {}
    }
  } catch (e) {}
}
/* ---------------------------------------------------------- v1.10.0 bees
 * ("Buzzy Bees": entity models backfilled from the pinned 1.15.2 client.jar.
 *  The engine renders bee/fox/panda/cat
 *  natively from bundles/entity-models.json; the sim below is ours.)
 *
 *  Hive records (SV.hives: key -> {x,y,z,nest,bees:[{t,nectar,baby}]}).
 *  Honey level lives in the blockstate (world diffs persist it); only the
 *  inside-bee rosters need saving (rec.hives). Inside bees are abstract —
 *  no hidden entities — and materialize on exit via spawnHiveBee.
 *  JE rules implemented: nectar after ~20s circling a flower, pollination
 *  (+1 stage, 10 blooms/trip, bee_growables crops), night/rain shelter
 *  (overworld only), 120s minimum stay, +1 honey on nectar exit (1% +2),
 *  harvest at 5 (shears: 3 comb; bottle: honey bottle), smoke calming
 *  (lit campfire <=5 below, <=1 solid block in the smoke path), break rules
 *  (silk: carry bees in the dropped item; else nest drops nothing, hive
 *  drops itself empty, everyone in 16 blocks swarms — even empty hives),
 *  one poison sting (I 0:10 E/N, 0:18 H) then death within a minute,
 *  peaceful = passive, campfire burn (1/sec mobs + player), natural nests
 *  (oak/birch trunks: plains 5%, else 0.5% — this worldgen has no
 *  forest/flower/birch biomes, so JE's 5/2/0.2 split is approximated).
 *  Simplifications (documented): carried bees re-home on the next hive you
 *  place (no item NBT offline); campfire cooking is out (light/extinguish/
 *  burn only); dispenser lights campfires (uncertain vanilla, harmless);
 *  outside bees don't persist across reloads (no mobs do).
 */
const BEE_CALM_MS = 25000;   // anger window (wolf/polar use 10s; bees hold grudges)
const BEE_NECTAR_T = 20;     // seconds circling one bloom to fill the sac
const HIVE_STAY = 120;       // seconds inside before exiting (vanilla 2400 ticks)
const HIVE_MAXBEES = 3;      // vanilla hive capacity
function hiveKindOf(st) {
  try {
    const d = defOf(st);
    if (!d) return null;
    if (d.name === "beehive") return "hive";
    if (d.name === "bee_nest") return "nest";
    return null;
  } catch (e) { return null; }
}
function hiveKey(x, y, z) { return (x | 0) + "," + (y | 0) + "," + (z | 0); }
function hivesMap() { try { if (!SV.hives) SV.hives = new Map(); return SV.hives; } catch (e) { return null; } }
function hiveAtKey(k) { try { const m = hivesMap(); return m ? m.get(k) : null; } catch (e) { return null; } }
// watch-set maintenance from the setState wrapper (same pattern as crops):
// registers hives/nests as they stream in or get placed. Never deletes —
// break handling owns deletion (onPlayerBreak for players, hiveTick's
// gone-block check for blasts), so a record always outlives its block.
function trackHive(x, y, z, s) {
  try {
    if (!hiveKindOf(s)) return;
    const m = hivesMap(); if (!m) return;
    const key = hiveKey(x, y, z);
    if (m.has(key)) return;
    if (m.size > 80) {
      // prune far hives first (static hives past the cap stop simulating
      // until a block change near them re-registers — farms are small)
      try {
        const p = game().player;
        let worst = null, wd = -1;
        m.forEach((h, k) => {
          const dx = h.x - p.x, dz = h.z - p.z, d2 = dx * dx + dz * dz;
          if (d2 > wd) { wd = d2; worst = k; }
        });
        if (worst) m.delete(worst);
      } catch (e) {}
    }
    m.set(key, { x: x | 0, y: y | 0, z: z | 0, nest: hiveKindOf(s) === "nest", bees: [] });
  } catch (e) {}
}
const HIVE_FACE_VEC = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
function hiveFront(h) {
  // the cell just outside the hive mouth (vanilla exit side)
  try {
    const f = stProp(game().world.getState(h.x, h.y, h.z), "facing");
    const v = HIVE_FACE_VEC[f] || HIVE_FACE_VEC.north;
    return { x: h.x + 0.5 + v[0], y: h.y + 0.6, z: h.z + 0.5 + v[1], dx: v[0], dz: v[1] };
  } catch (e) { return { x: h.x + 0.5, y: h.y + 0.6, z: h.z + 0.5, dx: 0, dz: 0 }; }
}
function enterHive(h, m) {
  try {
    if (!h || !m) return false;
    h.bees = h.bees || [];
    if (h.bees.length >= HIVE_MAXBEES) return false; // full (vanilla)
    h.bees.push({ t: HIVE_STAY, nectar: m.hasNectar ? 1 : 0, baby: m.baby ? 1 : 0 });
    removeMob(m.id);
    return true;
  } catch (e) { return false; }
}
function spawnHiveBee(h, angry, baby) {
  try {
    const fr = hiveFront(h);
    const m = spawnMob("bee", fr.x, fr.y, fr.z);
    if (!m) return null;
    m.homeHive = hiveKey(h.x, h.y, h.z);
    m.hasNectar = false; m.pollens = 0; m.flowerT = 0;
    try { m.e.hasNectar = false; m.e.hasStung = false; } catch (e) {}
    if (baby) { m.baby = true; m.growT = GROW_T; setBabyScale(m, true); }
    if (angry) provoke(m);
    return m;
  } catch (e) { return null; }
}
function releaseHiveBees(h, angry) {
  // inside bees exit (and swarm when angry); returns count released
  let n = 0;
  try {
    const bees = (h && h.bees) || [];
    h.bees = [];
    for (const b of bees) { try { if (spawnHiveBee(h, angry, b.baby)) n++; } catch (e) {} }
  } catch (e) {}
  return n;
}
function angerBeesNear(x, y, z, r) {
  try {
    const r2 = (r || 16) * (r || 16);
    SV.mobs.forEach((m) => {
      if (!m || m.species !== "bee" || m.hp <= 0) return;
      const dx = m.x - x, dz = m.z - z;
      if (dx * dx + dz * dz <= r2) provoke(m);
    });
  } catch (e) {}
}
function hiveHoney(h) {
  try { return stProp(game().world.getState(h.x, h.y, h.z), "honey_level") | 0 || 0; } catch (e) { return 0; }
}
function setHiveHoney(h, n) {
  try {
    const w = game().world;
    const st = w.getState(h.x, h.y, h.z);
    if (!hiveKindOf(st)) return false;
    w.setState(h.x, h.y, h.z, stWith(st, "honey_level", String(Math.max(0, Math.min(5, n | 0)))));
    return true;
  } catch (e) { return false; }
}
function hiveCalmed(h) {
  // lit campfire within 5 below + clear smoke path (vanilla: at most one
  // solid block between the campfire top and the hive). The engine smokes
  // lit campfires natively (tile-renderer), so no particles here.
  try {
    const w = game().world;
    for (let dy = 1; dy <= 5; dy++) {
      const st = w.getState(h.x, h.y - dy, h.z);
      const d = defOf(st);
      if (!d || d.name !== "campfire") continue;
      if (stProp(st, "lit") !== "true") continue;
      let solid = 0;
      for (let y = h.y - dy + 1; y < h.y; y++) {
        try { if (isSolidXYZ(h.x, y, h.z)) { solid++; if (solid > 1) break; } } catch (e) {}
      }
      if (solid <= 1) return true;
    }
    return false;
  } catch (e) { return false; }
}
function flowerAt(x, y, z) {
  // a 1.15 bee flower at the feet or 1-2 below (tall flowers share the name;
  // the column covers bees hovering over the bloom, vanilla-style)
  try {
    const bf = BREED_FOOD.bee;
    for (let dy = 0; dy <= 2; dy++) {
      const n = blockNameAt(x, y - dy, z);
      if (n && bf.indexOf(n) >= 0) return n;
    }
    return null;
  } catch (e) { return null; }
}
// nearest 1.15 flower block within maxR (spiral-square, center first),
// scanned at the bee's level and 1-3 below (blooms sit on the ground)
function nearestFlower(x, y, z, maxR) {
  try {
    const bf = BREED_FOOD.bee;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const R = maxR | 0 || 12;
    for (let r = 0; r <= R; r++) {
      for (let ox = -r; ox <= r; ox++) for (let oz = -r; oz <= r; oz++) {
        if (r > 0 && Math.max(Math.abs(ox), Math.abs(oz)) !== r) continue; // ring only
        const cx = bx + ox, cz = bz + oz;
        if (!chunkLoaded(cx + 0.5, cz + 0.5)) continue;
        for (let dy = 0; dy <= 3; dy++) {
          let nm = "";
          try { nm = blockNameAt(cx, by - dy, cz); } catch (e) {}
          if (nm && bf.indexOf(nm) >= 0) return { x: cx, y: by - dy, z: cz };
        }
      }
    }
    return null;
  } catch (e) { return null; }
}
function cropBelowBee(m) {  // {x,y,z,state} of a growable, immature crop 1-2 below the bee (stems
  // included; farmland/cane/cactus/attached fruit excluded)
  try {
    for (let dy = 1; dy <= 2; dy++) {
      const bx = Math.floor(m.x), by = Math.floor(m.y) - dy, bz = Math.floor(m.z);
      const st = game().world.getState(bx, by, bz);
      const kind = cropKindOf(st);
      if (!kind || kind === "farmland" || kind === "sugar_cane" || kind === "cactus") continue;
      if (kind === "attached_melon" || kind === "attached_pumpkin") continue;
      const max = CROP_MAXAGE[kind];
      if (max == null) continue;
      if (((st | 0) - (CROP_LO[kind] | 0)) < max) return { x: bx, y: by, z: bz, state: st };
    }
    return null;
  } catch (e) { return null; }
}
function heldHasSilk() {
  try {
    const hs = heldStack();
    if (!hs || !hs.id) return false;
    const list = game().items.enchantments(hs) || [];
    for (const e of list) {
      const n = Array.isArray(e) ? e[0] : (e && (e.id || e.name));
      if (String(n).replace(/^minecraft:/, "") === "silk_touch") return true;
    }
    return false;
  } catch (e) { return false; }
}
// player break of a hive/nest: silk carries the bees + drops the block,
// otherwise the nest drops nothing, the hive drops itself empty, and every
// bee in 16 blocks swarms (even for empty hives — vanilla). Returns true
// when handled (the caller then skips the generic drop table).
function hiveBreak(x, y, z, oldState) {
  try {
    const key = hiveKey(x, y, z);
    const h = hiveAtKey(key);
    let nest = false;
    try { nest = defOf(oldState).name === "bee_nest"; } catch (e) {}
    if (heldHasSilk()) {
      // carried in the item (no item NBT offline): re-homed on next place
      const bees = (h && h.bees) || [];
      SV.hiveCarry = bees.slice(0, HIVE_MAXBEES);
      try {
        const id = itemIdByName(nest ? "bee_nest" : "beehive");
        if (id != null) spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1);
      } catch (e) {}
      try { hivesMap().delete(key); } catch (e) {}
      return true; // no anger (vanilla)
    }
    if (!nest) {
      try {
        const id = itemIdByName("beehive");
        if (id != null) spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1);
      } catch (e) {}
    }
    try { if (h) releaseHiveBees(h, true); } catch (e) {}
    try { hivesMap().delete(key); } catch (e) {}
    try { angerBeesNear(x + 0.5, y, z + 0.5, 16); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// player break of a campfire: silk drops the block, else 2 charcoal (vanilla)
function campfireBreak(x, y, z) {
  try {
    if (heldHasSilk()) {
      try {
        const id = itemIdByName("campfire");
        if (id != null) spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1);
      } catch (e) {}
    } else {
      try {
        const id = itemIdByName("charcoal");
        if (id != null) {
          spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1);
          spawnItemEntity(x + 0.5, y + 0.5, z + 0.5, id, 1);
        }
      } catch (e) {}
    }
    return true;
  } catch (e) { return false; }
}
// silk-carried bees move back into a freshly placed hive (no item NBT offline)
function hiveCarryIn(x, y, z) {
  try {
    const key = hiveKey(x, y, z);
    let h = hiveAtKey(key);
    if (!h) { try { trackHive(x, y, z, game().world.getState(x | 0, y | 0, z | 0)); } catch (e) {} h = hiveAtKey(key); }
    if (!h) return;
    h.bees = h.bees || [];
    while (SV.hiveCarry && SV.hiveCarry.length && h.bees.length < HIVE_MAXBEES) h.bees.push(SV.hiveCarry.shift());
    if (SV.hiveCarry && !SV.hiveCarry.length) SV.hiveCarry = null;
    // overflow stays carried (place another hive for the rest)
  } catch (e) {}
}
// hand harvest at honey 5: shears take 3 comb, bottles take 1 honey bottle.
// Uncalmed harvests (no lit campfire smoke) swarm the hive (vanilla).
function handleHiveUse(t, hand) {
  if (!survives() || SV.dead) return false;
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    if (!hiveKindOf(st)) return false;
    const s = handStack(hand);
    const hn = stackName(s);
    if (hn !== "shears" && hn !== "glass_bottle") return false;
    if (((stProp(st, "honey_level") | 0) || 0) < 5) return false; // not full
    const key = hiveKey(t.x, t.y, t.z);
    let h = hiveAtKey(key);
    if (!h) { try { trackHive(t.x, t.y, t.z, st); } catch (e) {} h = hiveAtKey(key); }
    const calm = hiveCalmed({ x: t.x | 0, y: t.y | 0, z: t.z | 0 });
    if (hn === "shears") {
      if (hand === 1) wearOff(1); else wearMain(1);
      try {
        const id = itemIdByName("honeycomb");
        if (id != null) for (let i = 0; i < 3; i++) spawnItemEntity(t.x + 0.5, t.y + 0.7, t.z + 0.5, id, 1);
      } catch (e) {}
      sfx("entity.sheep.shear");
    } else {
      if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
      else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
      try {
        const id = itemIdByName("honey_bottle");
        if (id != null) {
          const v = inv();
          if (v && typeof v.addToInventory === "function") v.addToInventory({ id, damage: 0, count: 1 });
          else spawnItemEntity(t.x + 0.5, t.y + 0.7, t.z + 0.5, id, 1);
        }
      } catch (e) {}
      try { game().sound.play("item.bottle.fill"); } catch (e) {}
    }
    setHiveHoney({ x: t.x | 0, y: t.y | 0, z: t.z | 0 }, 0);
    if (!calm) {
      try { if (h) releaseHiveBees(h, true); } catch (e) {}
      try { angerBeesNear(t.x + 0.5, t.y, t.z + 0.5, 16); } catch (e) {}
    }
    return true;
  } catch (e) { return false; }
}
// campfires: flint & steel lights, shovel/water puts out (punch does
// nothing — vanilla). Cooking is out of scope (documented gap).
function handleCampfireUse(t, hand) {
  if (!survives() || SV.dead) return false;
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const d = defOf(st);
    if (!d || d.name !== "campfire") return false;
    const hn = stackName(handStack(hand));
    const lit = stProp(st, "lit") === "true";
    if (hn === "flint_and_steel" && !lit && stProp(st, "waterlogged") !== "true") {
      g.world.setState(t.x, t.y, t.z, stWith(st, "lit", "true"));
      if (hand === 1) wearOff(1); else wearMain(1);
      sfx("item.flintandsteel.use");
      return true;
    }
    if (!lit) return false;
    if ((hn && hn.slice(-7) === "_shovel") || hn === "water_bucket") {
      g.world.setState(t.x, t.y, t.z, stWith(st, "lit", "false"));
      try { game().sound.play("block.fire.extinguish"); } catch (e) {}
      return true;
    }
    return false;
  } catch (e) { return false; }
}
let hiveAcc = 0;
function hiveTick(dt) {
  // 1 Hz: inside-bee stay timers + staggered exits (one/hive/sec), and
  // gone-block reconciliation for non-player breaks (blasts): inside bees
  // escape, no drops (explosions drop nothing anywhere in this sim).
  if (!survives()) return;
  hiveAcc += dt;
  if (hiveAcc < 1) return;
  hiveAcc = 0;
  try {
    const m = hivesMap(); if (!m || m.size === 0) return;
    const g = game();
    m.forEach((h, key) => {
      try {
        if (!hiveKindOf(g.world.getState(h.x, h.y, h.z))) {
          try { releaseHiveBees(h, false); } catch (e) {}
          try { m.delete(key); } catch (e) {}
          return;
        }
        const bees = h.bees || (h.bees = []);
        if (!bees.length) return;
        const b = bees[0];
        b.t -= 1;
        if (b.t > 0) return;
        bees.shift();
        if (b.nectar) {
          try {
            const honey = hiveHoney(h);
            if (honey < 5) setHiveHoney(h, honey + (Math.random() < 0.01 ? 2 : 1));
          } catch (e) {}
        }
        try { spawnHiveBee(h, false, b.baby); } catch (e) {}
      } catch (e) {}
    });
  } catch (e) {}
}
var B_SEED = { done: new Set(), count: 0 };
function seedNests(force) {
  // natural bee nests on oak/birch trunks near the player (villages pattern:
  // only loaded columns, per-column once-flags, explored-area retry).
  try {
    if (B_SEED.count >= 10) return;
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0) return;
    if ((g.dimension | 0) !== 0) return;
    const mc = globalThis.__mcSingleplayer;
    if (!mc || typeof mc.treeInfo !== "function") return;
    const p = g.player;
    if (!p) return;
    void force;
    if (B_SEED.done.size > 3000) B_SEED.done.clear();
    for (let i = 0; i < 12; i++) {
      const cx = Math.floor(p.x) + ((Math.random() * 129) | 0) - 64;
      const cz = Math.floor(p.z) + ((Math.random() * 129) | 0) - 64;
      const key = cx + "," + cz;
      if (B_SEED.done.has(key)) continue;
      let ti = null;
      try { ti = mc.treeInfo(cx, cz); } catch (e) {}
      if (!ti || !ti.trunk || (ti.wood | 0) !== 0) continue; // oak/birch only (vanilla)
      B_SEED.done.add(key);
      // plains 5%; other tree biomes 0.5% (no forest/flower/birch biomes in
      // this worldgen — documented approximation of JE's 5/2/0.2 split)
      const rate = ti.biome === "plains" ? 0.05 : 0.005;
      if (Math.random() >= rate || B_SEED.count >= 10) continue;
      if (!chunkLoaded(cx + 0.5, cz + 0.5)) continue;
      const ny = (ti.gy | 0) + 2;
      const dirs = [[1, 0, "east"], [-1, 0, "west"], [0, 1, "south"], [0, -1, "north"]];
      const d = dirs[(Math.random() * dirs.length) | 0];
      const nx = cx + d[0], nz = cz + d[1];
      try {
        if (g.world.getState(nx, ny, nz) !== 0) continue;
        if (hiveAtKey(hiveKey(nx, ny, nz))) continue;
        let nst = -1;
        try {
          const L = blkLayout("bee_nest");
          if (L) {
            const fi = ["north", "south", "west", "east"].indexOf(d[2]);
            nst = L.min + (fi < 0 ? 0 : fi) * 6;
          }
        } catch (e) {}
        if (nst < 0) continue;
        SV.grief = true;
        try { g.world.setState(nx, ny, nz, nst); } finally { SV.grief = false; }
      } catch (e) { continue; }
      // 2-3 residents, homed (vanilla)
      try {
        const n = 2 + ((Math.random() * 2) | 0);
        for (let b = 0; b < n; b++) {
          const rec = spawnMob("bee", nx + 0.5, ny + 0.6, nz + 0.5);
          if (rec) rec.homeHive = hiveKey(nx, ny, nz);
        }
      } catch (e) {}
      B_SEED.count++;
    }
  } catch (e) {}
}
function persistHives(rec) {
  try {
    const arr = [];
    const m = hivesMap();
    if (m) m.forEach((h) => {
      if (!h || arr.length > 80) return;
      arr.push({
        x: h.x | 0, y: h.y | 0, z: h.z | 0,
        bees: (h.bees || []).slice(0, 3).map((b) => ({ t: Math.round(b.t || 0), n: b.nectar ? 1 : 0, b: b.baby ? 1 : 0 })),
      });
    });
    rec.hives = arr;
  } catch (e) {}
}
function restoreHives(rec) {
  try {
    const m = hivesMap();
    if (m) m.clear();
    SV.hiveCarry = null;
    for (const r of (rec.hives || []).slice(0, 80)) {
      if (!r) continue;
      try {
        const st = game().world.getState(r.x | 0, r.y | 0, r.z | 0);
        if (!hiveKindOf(st)) continue; // hive gone: drop it
        let nest = false;
        try { nest = defOf(st).name === "bee_nest"; } catch (e) {}
        hivesMap().set(hiveKey(r.x, r.y, r.z), {
          x: r.x | 0, y: r.y | 0, z: r.z | 0, nest,
          bees: (r.bees || []).slice(0, 3).map((b) => ({ t: b.t | 0 || HIVE_STAY, nectar: b.n ? 1 : 0, baby: b.b ? 1 : 0 })),
        });
      } catch (e) {}
    }
  } catch (e) {}
}

function handleBlockUse(t, hand) {
  const g = game();
  const st = g.world.getState(t.x, t.y, t.z);
  const def = defOf(st);
  if (!def) return false;
  const nm = def.name;
  const s = handStack(hand);
  const hn = stackName(s);
  // main-hand block placement keeps priority (engine predicts it natively):
  // our offhand use only fires when main isn't holding a placeable block.
  if (hand === 1) {
    try {
      const m = mainHeld(), md = m && m.id ? g.items.def(m.id) : null;
      if (md && g.interaction._itemBlock && g.interaction._itemBlock(m)) return false;
    } catch (e) {}
  }
  // spawn eggs: use on a block face to spawn the mob in the adjacent cell
  // (vanilla; only for mobs we simulate — others need their mob first)
  if (hn && hn.slice(-10) === "_spawn_egg") {
    const sp = EGG_SPECIES[hn];
    if (!sp || t.face == null) return false;
    try {
      const d = FACE_D[t.face | 0] || FACE_D[1];
      const ax = t.x + d[0] + 0.5, ay = t.y + d[1], az = t.z + d[2] + 0.5;
      let occ = -1;
      try { occ = g.world.getState(Math.floor(ax), Math.floor(ay), Math.floor(az)); } catch (e) {}
      if (occ !== 0) return false; // no room (vanilla puffs and refuses)
      const m = HORSE_DEFS[sp] ? spawnHorse(sp, ax, ay, az) : spawnMob(sp, ax, ay, az);
      if (m == null) return false;
      if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
      else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
      try { g.sound.play("entity.chicken.egg"); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }
  // leads: right-click a fence post to tie/untie the hitch (v1.14 Phase D)
  try { if (handleLeadKnot(t, hand)) return true; } catch (e) {}
  // boats: right-click water (or shore ground) with a boat item
  try { if (handleBoatPlace(t, hand)) return true; } catch (e) {}
  // armor stands: right-click a solid top face with the stand item
  try { if (handleStandPlace(t, hand)) return true; } catch (e) {}
  // rails: place with auto-shape; minecarts: used on a rail
  try { if (handleRailPlace(t, hand)) return true; } catch (e) {}
  try { if (handleCartPlace(t, hand)) return true; } catch (e) {}
  // v1.11: repeaters cycle delay 1-4, comparators toggle compare/subtract
  // (plain use, any hand — vanilla; sneaking falls through to placement)
  try {
    const tn2 = blockNameAt(t.x, t.y, t.z);
    if ((tn2 === "repeater" || tn2 === "comparator") && !(g.player && g.player.sneaking)) {
      const st2 = g.world.getState(t.x, t.y, t.z);
      if (tn2 === "repeater") {
        const nx = String(((parseInt(stProp(st2, "delay"), 10) || 1) % 4) + 1);
        SV.grief = true;
        try { g.world.setState(t.x, t.y, t.z, stWith(st2, "delay", nx)); }
        finally { try { SV.grief = false; } catch (e) {} }
      } else {
        const nx = stProp(st2, "mode") === "subtract" ? "compare" : "subtract";
        SV.grief = true;
        try { g.world.setState(t.x, t.y, t.z, stWith(st2, "mode", nx)); }
        finally { try { SV.grief = false; } catch (e) {} }
      }
      try { g.sound.play("block.lever.click"); } catch (e) {}
      return true;
    }
  } catch (e) {}
  // oriented blocks: hopper/dispenser/dropper/lever/buttons place with
  // facing (engine only predicts default states)
  try { if (handleOrientedPlace(t, hand)) return true; } catch (e) {}
  // farming: hoe tills, seeds/cane/cactus plant, bone meal grows
  try { if (handleHoeUse(t, hand)) return true; } catch (e) {}
  try { if (handlePlantUse(t, hand)) return true; } catch (e) {}
  try { if (handleBoneUse(t, hand)) return true; } catch (e) {}
  // hives/nests: shear/bottle harvest at honey 5 (before flint & steel: a
  // campfire takes the lighter, everything else falls through to it)
  try { if (handleHiveUse(t, hand)) return true; } catch (e) {}
  try { if (handleCampfireUse(t, hand)) return true; } catch (e) {}
  // flint & steel: TNT first, else ignite adjacent air
  if (hn === "flint_and_steel") {
    if (nm === "tnt") {
      try {
        SV.grief = true;
        g.world.setState(t.x, t.y, t.z, 0);
      } finally { SV.grief = false; }
      spawnPrimedTNT(t.x + 0.5, t.y, t.z + 0.5);
      if (hand === 1) wearOff(1); else wearMain(1);
      return true;
    }
    try {
      const d = FACE_D[t.face | 0] || FACE_D[1];
      const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
      if (g.world.getState(ax, ay, az) === 0) {
        let below = null;
        try { below = defOf(g.world.getState(ax, ay - 1, az)); } catch (e) {}
        if (below && below.id !== 0) {
          SV.grief = true;
          try { g.world.setState(ax, ay, az, FIRE_ST); } finally { SV.grief = false; }
          if (hand === 1) wearOff(1); else wearMain(1);
          try { g.sound.play("item.flintandsteel.use"); } catch (e) {}
          return true;
        }
      }
    } catch (e) {}
    return false;
  }
  // cake: 7 slices, 2 hunger + 0.4 sat each (states 3507-3513)
  if (nm === "cake") {
    const bites = st - 3507;
    if (bites < 0 || bites > 6 || getFood() >= 20) return false;
    setFood(getFood() + 2);
    try { setSat(Math.min(20, getSat() + 0.4)); } catch (e) {}
    try { g.sound.play("entity.generic.eat"); } catch (e) {}
    try {
      SV.grief = true;
      g.world.setState(t.x, t.y, t.z, bites >= 6 ? 0 : st + 1);
    } finally { SV.grief = false; }
    return true;
  }
  // beds: sleep at night (skip to morning + set spawn), refuse by day/monsters
  if (nm.length > 4 && nm.slice(-4) === "_bed") {
    try {
      if ((game().dimension | 0) !== 0) {
        // vanilla: beds detonate in the Nether AND the End (power 5,
        // consumes the bed)
        SV.grief = true;
        try { g.world.setState(t.x, t.y, t.z, 0); } finally { SV.grief = false; }
        try { explode({ x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 }, 5); } catch (e) {}
        chat("§eThat bed exploded! (Beds detonate in the Nether and the End)");
        return true;
      }
    } catch (e) {}
    let night = false;
    try { night = (g.world.timeOfDay % 24000) >= 12542; } catch (e) {}
    if (!night) { chat("§eYou can only sleep at night"); return true; }
    let danger = false;
    try {
      const p = g.player;
      SV.mobs.forEach((m) => {
        if (!m.def.hostile || m.hp <= 0) return;
        const dx = m.x - p.x, dz = m.z - p.z;
        if (dx * dx + dz * dz < 64 && Math.abs(m.y - p.y) < 5) danger = true;
      });
    } catch (e) {}
    if (danger) { chat("§eYou may not rest now, there are monsters nearby"); return true; }
    try {
      const sp = SP();
      if (sp) {
        sp.spawn = { x: t.x + 0.5, y: t.y + 1, z: t.z + 0.5 };
        sp.dirty = true;
      }
    } catch (e) {}
    try { g.world.timeOfDay = Math.floor(g.world.timeOfDay / 24000) * 24000; } catch (e) {}
    try { setHP(20); } catch (e) {}
    SV.noSleep = 0; // a full night's sleep resets the phantom clock (vanilla)
    try { clearWeatherOnSleep(); } catch (e) {} // vanilla: sleep clears rain/thunder
    return true;
  }
  // wooden doors: toggle open bit (lower + upper halves)
  if (nm.length > 5 && nm.slice(-5) === "_door" && nm.indexOf("iron") < 0) {
    try {
      const base = def.minStateId;
      let bx = t.x, by = t.y, bz = t.z, st0 = st;
      const half0 = ((st - base) >> 3) & 1; // 0 upper, 1 lower
      if (half0 === 0) { by = t.y - 1; st0 = g.world.getState(bx, by, bz); }
      const d0 = defOf(st0);
      if (!d0 || d0.name !== nm) return false;
      const off = st0 - d0.minStateId;
      const facing = off >> 4, hinge = (off >> 2) & 1, open = (off >> 1) & 1, pow = off & 1;
      const nopen = open ^ 1;
      const lower = d0.minStateId + (facing << 4) + (1 << 3) + (hinge << 2) + (nopen << 1) + pow;
      const upper = d0.minStateId + (facing << 4) + (0 << 3) + (hinge << 2) + (nopen << 1) + pow;
      SV.grief = true;
      try {
        g.world.setState(bx, by, bz, lower);
        const up = defOf(g.world.getState(bx, by + 1, bz));
        if (up && up.name === nm) g.world.setState(bx, by + 1, bz, upper);
      } finally { SV.grief = false; }
      try { g.sound.play(nopen === 0 ? "block.wooden_door.open" : "block.wooden_door.close"); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }
  // crafting table: the engine's native 3x3 window (recipes.js patches its
  // matcher to 1.13 ids); no tile store — the grid lives in the window.
  if (nm === "crafting_table") {
    openWorkbench();
    return true;
  }
  // enchanting table: native window + survival server half (see openEnchant)
  if (nm === "enchanting_table") {
    openEnchant(t.x, t.y, t.z);
    return true;
  }
  // anvil: native window + survival server half (see openAnvil).
  // 1.15 has three blocks, all opening the same container.
  if (nm === "anvil" || nm === "chipped_anvil" || nm === "damaged_anvil") {
    openAnvil(t.x, t.y, t.z);
    return true;
  }
  // brewing stand: tile-backed window (see openTile "brewing" + tilesTick)
  if (nm === "brewing_stand") {
    openTile(t.x, t.y, t.z, "brewing");
    return true;
  }
  // hopper/dispenser/dropper: tile-backed native windows (see openTile).
  // Sneaking with a block in hand places instead (vanilla), so step aside.
  if (nm === "hopper" || nm === "dispenser" || nm === "dropper") {
    try {
      const p = game().player;
      if (p && p.sneaking) {
        const hs = handStack(hand), hd = hs && hs.id ? game().items.def(hs.id) : null;
        if (hd && game().interaction._itemBlock && game().interaction._itemBlock(hs)) return false;
      }
    } catch (e) {}
    openTile(t.x, t.y, t.z, nm);
    return true;
  }
  // lever + buttons: flip the powered bit (engine never predicts these).
  // Sneaking with a block in hand places instead (vanilla), so step aside.
  if (nm === "lever" || nm.slice(-7) === "_button") {
    try {
      const p = game().player;
      if (p && p.sneaking) {
        const hs = handStack(hand), hd = hs && hs.id ? game().items.def(hs.id) : null;
        if (hd && game().interaction._itemBlock && game().interaction._itemBlock(hs)) return false;
      }
    } catch (e) {}
    if (togglePowerBit(t)) return true;
    return false;
  }
  // daylight detector: right-click toggles inverted mode (vanilla).
  // Sneaking with a block in hand places instead (same rule as levers).
  if (nm === "daylight_detector") {
    try {
      const p = game().player;
      if (p && p.sneaking) {
        const hs = handStack(hand), hd = hs && hs.id ? game().items.def(hs.id) : null;
        if (hd && game().interaction._itemBlock && game().interaction._itemBlock(hs)) return false;
      }
    } catch (e) {}
    try {
      const cur = stProp(st, "inverted");
      if (cur == null) return false; // no such property in this registry
      SV.grief = true;
      try { g.world.setState(t.x, t.y, t.z, stWith(st, "inverted", cur === "true" ? "false" : "true")); }
      finally { SV.grief = false; }
      return true;
    } catch (e) { return false; }
  }
  // Phase C inc 4 (v1.4.0): blast furnace + smoker (fast furnace tiles),
  // barrel (27-slot tile), grindstone + stonecutter (window-only server
  // halves, anvil pattern), composter + bell (stateless use handlers).
  if (nm === "blast_furnace") {
    openTile(t.x, t.y, t.z, "blast");
    return true;
  }
  if (nm === "smoker") {
    openTile(t.x, t.y, t.z, "smoker");
    return true;
  }
  if (nm === "barrel") {
    openTile(t.x, t.y, t.z, "barrel");
    try { sfx("block.barrel.open"); } catch (e) {}
    return true;
  }
  if (nm === "grindstone") {
    openGrd(t.x, t.y, t.z);
    return true;
  }
  if (nm === "stonecutter") {
    openStone(t.x, t.y, t.z);
    return true;
  }
  if (nm === "composter") {
    return useComposter(t);
  }
  if (nm === "bell") {
    return ringBell(t);
  }
  // furnace + chest: native container screens bound to our tile store
  if (nm === "furnace" || nm === "chest" || nm === "trapped_chest" || nm === "ender_chest") {
    const type = nm === "furnace" ? "furnace" : nm === "ender_chest" ? "ender" : nm === "trapped_chest" ? "trap" : "chest";
    if (type === "chest") {
      // double chests (joined pairs) open as their own 27 slots for now
      try {
        const st = g.world.getState(t.x, t.y, t.z);
        const def = defOf(st);
      } catch (e) {}
    }
    openTile(t.x, t.y, t.z, type);
    return true;
  }
  if (nm === "shulker_box" || nm.slice(-12) === "_shulker_box") {
    openTile(t.x, t.y, t.z, "shulker");
    return true;
  }
  // buckets: fill from water/lava, place into air
  if (hn === "bucket" && (nm === "water" || nm === "lava")) {
    const v = inv(); if (!v) return false;
    if ((s.count | 0) === 1) { s.id = nm === "water" ? 543 : 544; }
    else {
      s.count = (s.count | 0) - 1;
      addPlayerItem(nm === "water" ? 543 : 544, 1);
    }
    try { SV.grief = true; g.world.setState(t.x, t.y, t.z, 0); } finally { SV.grief = false; }
    try { g.sound.play("item.bucket.fill"); } catch (e) {}
    return true;
  }
  // glass bottles: fill from a water source (source kept, vanilla). The
  // brewing increment needs this; potion bottles otherwise only come from
  // loot/trades.
  if (hn === "glass_bottle" && nm === "water") {
    const v = inv(); if (!v) return false;
    const wid = itemIdByName("potion");
    if (wid == null) return false;
    const wbn = { t: 10, v: { Potion: { t: 8, v: "minecraft:water" } } };
    if ((s.count | 0) === 1) { s.id = wid; s.nbt = wbn; }
    else {
      s.count = (s.count | 0) - 1;
      const wb = { id: wid, count: 1, nbt: wbn };
      try {
        if (typeof v.addToInventory === "function") v.addToInventory(wb);
        if ((wb.count | 0) > 0) {
          const p = game().player;
          const id = spawnItemEntity(p.x, p.y + 1, p.z, wb.id, wb.count | 0);
          if (id != null) {
            try { const e = game().entities.get(id); if (e && e.item) e.item.nbt = wb.nbt; } catch (e) {}
          }
        }
      } catch (e) {}
    }
    try { g.sound.play("item.bottle.fill"); } catch (e) {}
    return true;
  }
  if (hn === "axolotl_bucket" && t.face != null) {
    try {
      const d = FACE_D[t.face | 0];
      if (!d) return false;
      const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
      if (g.world.getState(ax, ay, az) !== 0) return false;
      SV.grief = true;
      try { g.world.setState(ax, ay, az, 34); } finally { SV.grief = false; }
      try { spawnMob("axolotl", ax + 0.5, ay + 0.2, az + 0.5); } catch (e) {}
      s.id = itemIdByName("bucket");
      try { game().sound.play("item.bucket.empty_axolotl"); } catch (e2) {}
      return true;
    } catch (e) { return false; }
  }
  // P4: tadpole bucket empties like the axolotl bucket.
  if (hn === "tadpole_bucket" && t.face != null) {
    try {
      const d = FACE_D[t.face | 0];
      if (!d) return false;
      const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
      if (g.world.getState(ax, ay, az) !== 0) return false;
      SV.grief = true;
      try { g.world.setState(ax, ay, az, 34); } finally { SV.grief = false; }
      try { spawnMob("tadpole", ax + 0.5, ay + 0.2, az + 0.5); } catch (e) {}
      s.id = itemIdByName("bucket");
      try { game().sound.play("item.bucket.empty_tadpole"); } catch (e2) {}
      return true;
    } catch (e) { return false; }
  }
  if ((hn === "water_bucket" || hn === "lava_bucket") && t.face != null) {
    try {
      // vanilla: water placed in the Nether evaporates with a hiss
      if (hn === "water_bucket" && (game().dimension | 0) === -1) {
        try { g.sound.play("block.fire.extinguish"); } catch (e2) {}
        chat("§eWater evaporates in the Nether");
        return true;
      }
    } catch (e) {}
    try {
      const d = FACE_D[t.face | 0];
      if (!d) return false;
      const ax = t.x + d[0], ay = t.y + d[1], az = t.z + d[2];
      if (g.world.getState(ax, ay, az) !== 0) return false;
      SV.grief = true;
      try { g.world.setState(ax, ay, az, hn === "water_bucket" ? 34 : 50); } finally { SV.grief = false; }
      s.id = itemIdByName("bucket");
      try { g.sound.play("item.bucket.empty"); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }
  return false;
}

/* ---------------------------------------------------------- tiles: furnace + chest (native UIs) */

// fuel item name -> burn seconds (wiki Smelting page: lava 100 items, coal
// block 80, kelp block 20, blaze rod 12, coal/charcoal 8, boat 1 in 1.13)
const FUEL_SECS = {
  lava_bucket: 1000, coal_block: 800, dried_kelp_block: 200, blaze_rod: 120,
  coal: 80, charcoal: 80, boat: 10, oak_boat: 10, spruce_boat: 10,
  birch_boat: 10, jungle_boat: 10, acacia_boat: 10, dark_oak_boat: 10,
  oak_chest_boat: 10, spruce_chest_boat: 10, birch_chest_boat: 10,
  jungle_chest_boat: 10, acacia_chest_boat: 10, dark_oak_chest_boat: 10,
  oak_log: 15, spruce_log: 15, birch_log: 15, jungle_log: 15, acacia_log: 15, dark_oak_log: 15,
  oak_planks: 15, spruce_planks: 15, birch_planks: 15, jungle_planks: 15, acacia_planks: 15, dark_oak_planks: 15,
  stick: 5, oak_sapling: 5, spruce_sapling: 5, birch_sapling: 5, jungle_sapling: 5, acacia_sapling: 5, dark_oak_sapling: 5,
  ladder: 15, sign: 10, bowl: 5, oak_door: 10, spruce_door: 10, birch_door: 10, jungle_door: 10, acacia_door: 10, dark_oak_door: 10,
  bow: 10, fishing_rod: 15, wool: 5, white_wool: 5, carpet: 5, white_carpet: 5, wooden_button: 5, oak_button: 5,
  bookshelf: 15, chest: 15, trapped_chest: 15, jukebox: 15, noteblock: 15, wooden_pressure_plate: 15, oak_pressure_plate: 15,
  trapdoor: 15, oak_trapdoor: 15, fence: 15, oak_fence: 15, fence_gate: 15, oak_fence_gate: 15,
  wooden_stairs: 15, oak_stairs: 15, wooden_slab: 7.5, oak_slab: 7.5,
  wooden_pickaxe: 10, wooden_shovel: 10, wooden_axe: 10, wooden_hoe: 10, wooden_sword: 10,
  crafting_table: 15, hay_block: 10, wheat: 5, blaze_powder: 0,
};
// smelt input name -> {out, xp} (wiki values; resolved at runtime, skipped if absent)
const SMELT = {
  iron_ore: { out: "iron_ingot", xp: 0.7 }, gold_ore: { out: "gold_ingot", xp: 1.0 },
  coal_ore: { out: "coal", xp: 0.1 }, diamond_ore: { out: "diamond", xp: 1.0 },
  emerald_ore: { out: "emerald", xp: 1.0 }, lapis_ore: { out: "lapis_lazuli", xp: 0.2 },
  copper_ore: { out: "copper_ingot", xp: 0.7 },
  raw_iron: { out: "iron_ingot", xp: 0.7 }, raw_gold: { out: "gold_ingot", xp: 1.0 },
  raw_copper: { out: "copper_ingot", xp: 0.7 },
  deepslate_coal_ore: { out: "coal", xp: 0.1 }, deepslate_iron_ore: { out: "iron_ingot", xp: 0.7 },
  deepslate_copper_ore: { out: "copper_ingot", xp: 0.7 }, deepslate_gold_ore: { out: "gold_ingot", xp: 1.0 },
  deepslate_diamond_ore: { out: "diamond", xp: 1.0 }, deepslate_emerald_ore: { out: "emerald", xp: 1.0 },
  deepslate_lapis_ore: { out: "lapis_lazuli", xp: 0.2 }, deepslate_redstone_ore: { out: "redstone", xp: 0.7 },
  redstone_ore: { out: "redstone", xp: 0.7 }, quartz_ore: { out: "quartz", xp: 0.2 },
  netherrack: { out: "nether_brick", xp: 0.1 },
  sand: { out: "glass", xp: 0.1 }, red_sand: { out: "glass", xp: 0.1 },
  cobblestone: { out: "stone", xp: 0.1 }, clay_ball: { out: "brick", xp: 0.3 },
  clay: { out: "terracotta", xp: 0.35 }, cactus: { out: "cactus_green", xp: 0.2 },
  oak_log: { out: "charcoal", xp: 0.15 }, spruce_log: { out: "charcoal", xp: 0.15 },
  birch_log: { out: "charcoal", xp: 0.15 }, jungle_log: { out: "charcoal", xp: 0.15 },
  acacia_log: { out: "charcoal", xp: 0.15 }, dark_oak_log: { out: "charcoal", xp: 0.15 },
  beef: { out: "cooked_beef", xp: 0.35 }, porkchop: { out: "cooked_porkchop", xp: 0.35 },
  chicken: { out: "cooked_chicken", xp: 0.35 }, mutton: { out: "cooked_mutton", xp: 0.35 },
  rabbit: { out: "cooked_rabbit", xp: 0.35 }, cod: { out: "cooked_cod", xp: 0.35 },
  salmon: { out: "cooked_salmon", xp: 0.35 }, potato: { out: "baked_potato", xp: 0.1 },
  kelp: { out: "dried_kelp", xp: 0.1 }, chorus_fruit: { out: "popped_chorus_fruit", xp: 0.1 },
  wet_sponge: { out: "sponge", xp: 0.15 },
  white_terracotta: { out: "white_glazed_terracotta", xp: 0.1 },
  orange_terracotta: { out: "orange_glazed_terracotta", xp: 0.1 },
  magenta_terracotta: { out: "magenta_glazed_terracotta", xp: 0.1 },
  light_blue_terracotta: { out: "light_blue_glazed_terracotta", xp: 0.1 },
  yellow_terracotta: { out: "yellow_glazed_terracotta", xp: 0.1 },
  lime_terracotta: { out: "lime_glazed_terracotta", xp: 0.1 },
  pink_terracotta: { out: "pink_glazed_terracotta", xp: 0.1 },
  gray_terracotta: { out: "gray_glazed_terracotta", xp: 0.1 },
  light_gray_terracotta: { out: "light_gray_glazed_terracotta", xp: 0.1 },
  cyan_terracotta: { out: "cyan_glazed_terracotta", xp: 0.1 },
  purple_terracotta: { out: "purple_glazed_terracotta", xp: 0.1 },
  blue_terracotta: { out: "blue_glazed_terracotta", xp: 0.1 },
  brown_terracotta: { out: "brown_glazed_terracotta", xp: 0.1 },
  green_terracotta: { out: "green_glazed_terracotta", xp: 0.1 },
  red_terracotta: { out: "red_glazed_terracotta", xp: 0.1 },
  black_terracotta: { out: "black_glazed_terracotta", xp: 0.1 },
};
function tileKey(x, y, z) { return x + "," + y + "," + z; }
function furnaceLike(ty) { return ty === "furnace" || ty === "blast" || ty === "smoker"; }
function getTile(x, y, z) {
  try { SV.tiles = SV.tiles || new Map(); } catch (e) { return null; }
  return SV.tiles.get(tileKey(x, y, z)) || null;
}
function setTile(x, y, z, t) {
  try {
    SV.tiles = SV.tiles || new Map();
    if (t) SV.tiles.set(tileKey(x, y, z), t);
    else SV.tiles.delete(tileKey(x, y, z));
  } catch (e) {}
}
function smeltOf(name) {
  if (!name || !SMELT[name]) return null;
  try {
    const r = SMELT[name];
    const inId = itemIdByName(name), outId = itemIdByName(r.out);
    if (inId == null || outId == null) return null;
    return { inId, outId, xp: r.xp };
  } catch (e) { return null; }
}
function fuelSecs(name) {
  if (!name) return 0;
  try {
    if (FUEL_SECS[name] != null) return FUEL_SECS[name];
    // any wool/carpet color, any boat: fall back by suffix
    if (name.slice(-5) === "_wool") return 5;
    if (name.slice(-7) === "_carpet") return 5;
    if (name.slice(-5) === "_boat") return 10;
    if (name.slice(-4) === "_log") return 15;
    if (name.slice(-7) === "_planks") return 15;
  } catch (e) {}
  return 0;
}
// Phase C inc 4: blast/smoker input gates (JE blasting.json = ores + iron/
// gold/chainmail gear; smoking.json = foods). Everything else rides SMELT.
function blastOk(nm) {
  if (!nm) return false;
  if (nm === "iron_ore" || nm === "gold_ore" || nm === "copper_ore" ||
      nm === "raw_iron" || nm === "raw_gold" || nm === "raw_copper" ||
      nm === "deepslate_iron_ore" || nm === "deepslate_gold_ore" || nm === "deepslate_copper_ore" ||
      nm === "deepslate_coal_ore" || nm === "deepslate_diamond_ore" || nm === "deepslate_emerald_ore" ||
      nm === "deepslate_lapis_ore" || nm === "deepslate_redstone_ore") return true;
  if (/^(iron|golden|chainmail)_/.test(nm) && /(helmet|chestplate|leggings|boots|sword|pickaxe|axe|shovel|hoe)$/.test(nm)) return true;
  return false;
}
function smokeOk(nm) {
  if (!nm) return false;
  switch (nm) {
    case "beef": case "porkchop": case "chicken": case "mutton": case "rabbit":
    case "cod": case "salmon": case "potato": case "kelp":
      return true;
    default: return false;
  }
}
function smeltOfKind(name, type) {
  const sm = smeltOf(name);
  if (!sm) return null;
  if (type === "blast" && !blastOk(name)) return null;
  if (type === "smoker" && !smokeOk(name)) return null;
  return sm;
}
// open a native container screen bound to a tile (engine renders + clicks)
/* ---------------------------------------------------------- enchanting table (Phase C inc 1):
 * JE 1.15.2 enchanting over the native enchanting window. The engine renders
 * offers from container.properties (p[0..2] costs, p[3] xpSeed, p[4..6] ench
 * ids, p[7..9] levels) and dead-sends C.enchantItem on row click; survival is
 * the server half: bookshelf-scaled costs, weighted random enchantments (JE
 * getEnchantmentDatas, no treasure/curses), XP-level + lapis deduction, NBT
 * apply, reseed. Wired per-window (screen.tick wrapper refreshes offers,
 * extraMouseDown wrapper commits, onClose wrapper salvages), so it also runs
 * in creative (no costs) with no masterTick changes. */
function JRand(seed) { this.s = 0n; this.setSeed(seed); }
JRand.MULT = 0x5DEECE66Dn; JRand.MASK = (1n << 48n) - 1n;
JRand.prototype.setSeed = function (seed) { try { this.s = (BigInt.asIntN(64, BigInt(seed | 0)) ^ JRand.MULT) & JRand.MASK; } catch (e) { this.s = 0n; } };
JRand.prototype.next = function (bits) { this.s = (this.s * JRand.MULT + 11n) & JRand.MASK; return Number(BigInt.asIntN(32, this.s >> BigInt(48 - bits))); };
JRand.prototype.nextInt = function (bound) {
  if (bound === undefined) return this.next(32);
  bound = bound | 0;
  if (bound <= 0) return 0;
  if ((bound & -bound) === bound) return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
  let bits = 0, val = 0;
  do { bits = this.next(31); val = bits % bound; } while (bits - val + (bound - 1) < 0 || bits - val + (bound - 1) > 2147483647);
  return val;
};
JRand.prototype.nextFloat = function () { return this.next(24) / 16777216; };
function itemDefByName(nm) {
  try {
    const g = game();
    if (g && g.items && g.items.byName && typeof g.items.byName.get === "function") return g.items.byName.get(nm) || null;
  } catch (e) {}
  return null;
}
function enchReg() {
  if (SV.enchReg) return SV.enchReg;
  const out = [], byName = {};
  try {
    for (const e of (game().assets.data.enchantments || [])) {
      if (!e || !e.name) continue;
      const r = { num: e.id | 0, name: String(e.name).replace(/^minecraft:/, ""), max: e.maxLevel | 0 || 1, wt: e.weight | 0 || 1, cat: e.category || "", minA: +((e.minCost || {}).a) || 0, minB: +((e.minCost || {}).b) || 0, maxA: +((e.maxCost || {}).a) || 0, maxB: +((e.maxCost || {}).b) || 0, treasure: !!e.treasureOnly, curse: !!e.curse, excl: ((e.exclude || []).map((s) => String(s).replace(/^minecraft:/, ""))) };
      out.push(r); byName[r.name] = r;
    }
  } catch (e) {}
  SV.enchReg = { list: out, byName: byName };
  return SV.enchReg;
}
function enchAbility(nm) {
  // JE item enchantability (books handled by the caller)
  try {
    const m = /^(wooden|leather|stone|chainmail|iron|golden|diamond|turtle)_/.exec(nm || "");
    const armor = /helmet|chestplate|leggings|boots/.test(nm || "");
    if (m) {
      const mat = m[1];
      if (mat === "golden") return armor ? 25 : 22;
      if (mat === "iron") return armor ? 9 : 14;
      if (mat === "diamond") return 10;
      if (mat === "leather") return 15;
      if (mat === "chainmail") return 12;
      if (mat === "wooden") return 15;
      if (mat === "stone") return 5;
      if (mat === "turtle") return 9;
    }
  } catch (e) {}
  return 1;
}
function enchExisting(stack) {
  try {
    const list = game().items.enchantments(stack);
    if (Array.isArray(list)) return list.map((e) => String(e.id || "").replace(/^minecraft:/, "")).filter(Boolean);
  } catch (e) {}
  return [];
}
function enchOkTable(e, cats, isBook, existing) {
  if (!e || e.treasure || e.curse) return false;
  if (existing.indexOf(e.name) >= 0) return false;
  try {
    const reg = enchReg().byName;
    for (const x of existing) {
      const d = reg[x];
      if (d && (d.excl.indexOf(e.name) >= 0 || e.excl.indexOf(x) >= 0)) return false;
    }
  } catch (err) {}
  if (isBook) return true;
  if (!cats || !cats.length) return false;
  if (e.cat === "undefined") return cats.indexOf("crossbow") >= 0;
  return cats.indexOf(e.cat) >= 0;
}
function enchPickWeighted(rand, pool) {
  let tot = 0;
  for (const c of pool) tot += c.wt;
  let r = rand.nextFloat() * tot;
  for (const c of pool) { r -= c.wt; if (r < 0) return c; }
  return pool[pool.length - 1] || null;
}
function enchRollList(rand, stack, cats, isBook, level) {
  const out = [];
  try {
    const existing = enchExisting(stack);
    const pool = [];
    for (const e of enchReg().list) {
      if (!enchOkTable(e, cats, isBook, existing)) continue;
      for (let l = e.max; l >= 1; l--) {
        if (level >= e.minA * l + e.minB && level <= e.maxA * l + e.maxB) { pool.push({ e: e, l: l, wt: e.wt }); break; }
      }
    }
    if (!pool.length) return out;
    out.push(enchPickWeighted(rand, pool));
    let lvl = level | 0;
    let guard = 8;
    while (rand.nextInt(50) <= lvl && guard-- > 0) {
      const last = out[out.length - 1];
      for (let i = pool.length - 1; i >= 0; i--) {
        const c = pool[i];
        if (c.e.name === last.e.name || c.e.excl.indexOf(last.e.name) >= 0 || last.e.excl.indexOf(c.e.name) >= 0) pool.splice(i, 1);
      }
      if (!pool.length) break;
      out.push(enchPickWeighted(rand, pool));
      lvl = Math.floor(lvl / 2);
    }
  } catch (e) {}
  return out;
}
function enchModLevel(rand, base, ability) {
  // JE modified enchantment level from the slot cost + item enchantability
  try {
    const j = Math.floor(ability / 4) + 1, h = Math.floor(j / 2) + 1;
    let k = base + rand.nextInt(h) + rand.nextInt(h);
    const f = (rand.nextFloat() + rand.nextFloat() - 1) * 0.15;
    k = Math.round(k * (1 + f));
    return Math.max(1, k);
  } catch (e) { return Math.max(1, base | 0); }
}
function enchShelves(x, y, z) {
  // vanilla: 8 shelf spots (distance-2 ring), each gated on air at the inner cell
  let n = 0;
  try {
    const g = game();
    const air = (bx, by, bz) => { try { return g.world.getState(bx, by, bz) === 0; } catch (e) { return false; } };
    const shelf = (bx, by, bz) => { try { const d = defOf(g.world.getState(bx, by, bz)); return !!(d && d.name === "bookshelf"); } catch (e) { return false; } };
    for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      if (!j && !k) continue;
      if (air(x + k, y, z + j) && air(x + k, y + 1, z + j)) {
        if (shelf(x + k * 2, y, z + j * 2)) n++;
        if (shelf(x + k * 2, y + 1, z + j * 2)) n++;
      }
    }
  } catch (e) {}
  return Math.min(15, n);
}
function enchSlotCosts(base, shelves) {
  const s = Math.min(15, shelves | 0);
  return [Math.max(Math.floor(base / 3), 1), Math.floor(base * 2 / 3) + 1, Math.max(base, s * 2)];
}
function enchRefresh(rec) {
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:enchanting_table" || !rec) return;
    const item = w.get(0);
    const nm = (item && item.id) ? stackName(item) : null;
    const key = (item && item.id) ? JSON.stringify([item.id, item.damage | 0, item.count | 0, item.nbt || null]) : "";
    rec.frame = (rec.frame | 0) + 1;
    if (key === rec.key && (rec.frame % 30) !== 0) return;
    rec.key = key;
    rec.shelves = enchShelves(rec.x, rec.y, rec.z);
    const def = nm ? itemDefByName(nm) : null;
    const cats = (def && def.enchantCategories) || [];
    const isBook = nm === "book";
    const ability = !nm ? 0 : isBook ? 1 : (cats.length ? enchAbility(nm) : 0);
    let costs = [0, 0, 0], clue = [[-1, -1], [-1, -1], [-1, -1]];
    if (nm && ability > 0) {
      const r0 = new JRand(rec.seed ^ 0x9e3779b9);
      const base = r0.nextInt(8) + 1 + ((Math.min(15, rec.shelves)) >> 1) + r0.nextInt(Math.min(15, rec.shelves) + 1);
      costs = enchSlotCosts(base, rec.shelves);
      for (let l = 0; l < 3; l++) {
        const r = new JRand((rec.seed + l) | 0);
        const mod = enchModLevel(r, costs[l], ability);
        const list = enchRollList(r, item, cats, isBook, mod);
        if (list.length) clue[l] = [list[0].e.num, list[0].l];
      }
    }
    rec.costs = costs; rec.clue = clue;
    try {
      w.properties = w.properties || {};
      for (let i = 0; i < 3; i++) w.properties[i] = costs[i];
      w.properties[3] = rec.seed;
      for (let i = 0; i < 3; i++) { w.properties[4 + i] = clue[i][0]; w.properties[7 + i] = clue[i][1]; }
    } catch (e) {}
  } catch (e) {}
}
function enchCommit(rec, l) {
  // run the row-l click the engine would have sent to a server
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:enchanting_table" || !rec) return false;
    const creative = !!(g.player && g.player.creative);
    const cost = (w.properties && w.properties[l]) | 0;
    const item = w.get(0), lapis = w.get(1);
    const k = l + 1;
    if (!(item && item.id) || !(cost > 0)) return true;
    if (!creative) {
      if (!lapis || stackName(lapis) !== "lapis_lazuli" || (lapis.count | 0) < k) return true;
      if ((SV.xpLevel | 0) < k || (SV.xpLevel | 0) < cost) return true;
    }
    const nm = stackName(item);
    const def = nm ? itemDefByName(nm) : null;
    const cats = (def && def.enchantCategories) || [];
    const isBook = nm === "book";
    const ability = !nm ? 0 : isBook ? 1 : (cats.length ? enchAbility(nm) : 0);
    if (!(ability > 0)) return true;
    const r = new JRand((rec.seed + l) | 0);
    const list = enchRollList(r, item, cats, isBook, enchModLevel(r, cost, ability));
    if (!list.length) return true; // vanilla: nothing happens, nothing consumed
    if (isBook) {
      const bid = itemIdByName("enchanted_book");
      if (bid == null) return true;
      w.put(0, { id: bid, count: 1, nbt: vtNbtEnch(list.map((p) => [p.e.name, p.l]), true) });
    } else {
      const pairs = enchExisting(item).map((n) => {
        let lvl = 0;
        try {
          for (const e of (game().items.enchantments(item) || [])) {
            if (String(e.id || "").replace(/^minecraft:/, "") === n) { lvl = e.lvl | 0; break; }
          }
        } catch (e) {}
        return [n, lvl];
      });
      for (const p of list) pairs.push([p.e.name, p.l]);
      let nbt = null;
      try { nbt = item.nbt ? JSON.parse(JSON.stringify(item.nbt)) : { t: 10, v: {} }; } catch (e) { nbt = { t: 10, v: {} }; }
      try {
        const add = vtNbtEnch(pairs, false);
        nbt.v = nbt.v || {};
        nbt.v.Enchantments = add.v.Enchantments;
      } catch (e) { return true; }
      const out = { id: item.id, count: item.count | 0 };
      if (item.damage) out.damage = item.damage | 0;
      out.nbt = nbt;
      w.put(0, out);
    }
    if (!creative) {
      try {
        const lc = (lapis.count | 0) - k;
        const lp = lc > 0 ? { id: lapis.id, count: lc } : null;
        if (lp && lapis.nbt) lp.nbt = lapis.nbt;
        w.put(1, lp);
      } catch (e) {}
      try { deductXPLevels(k); } catch (e) {}
    }
    try { rec.seed = (Math.random() * 2147483647) | 0; rec.key = null; } catch (e) {}
    try { sfx("block.enchantment_table.use"); } catch (e) {}
    return true;
  } catch (e) { return false; }
}
function enchSalvage() {
  // return the table item + lapis to the player (workbench/merchant precedent)
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:enchanting_table" || w._enchSalvaged) return;
    w._enchSalvaged = true;
    for (let i = 0; i <= 1; i++) {
      let s = null;
      try { s = w.get(i); } catch (e) {}
      if (!s || !s.id) continue;
      try { w.put(i, null); } catch (e) {}
      const cp = { id: s.id, count: s.count | 0 || 1 };
      if (s.damage) cp.damage = s.damage | 0;
      if (s.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(s.nbt)); } catch (e) { try { cp.nbt = s.nbt; } catch (e2) {} } }
      let left = cp.count;
      try {
        const v = inv();
        if (v && typeof v.addToInventory === "function") { v.addToInventory(cp); left = cp.count | 0; }
      } catch (e) {}
      if (left > 0) {
        try {
          const v = inv();
          let placed = false;
          if (v && v.main) {
            for (let j = 0; j < v.main.length && !placed; j++) {
              if (!v.main[j]) { v.main[j] = { id: cp.id, count: left }; if (cp.damage) v.main[j].damage = cp.damage; if (cp.nbt) v.main[j].nbt = cp.nbt; placed = true; }
            }
          }
          if (!placed) {
            const p = game().player;
            const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
            if (id != null && cp.nbt) {
              try {
                const e = game().entities.get(id);
                if (e && e.item) e.item.nbt = cp.nbt;
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}
function enchClose() {
  try {
    SV.openEnch = null;
    const g = game(), w = g && g.window;
    if (w && w.type === "minecraft:enchanting_table") {
      try { enchSalvage(); } catch (e) {}
      try { g.on_close_window({ windowId: w.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
  } catch (e) { try { SV.openEnch = null; } catch (e2) {} }
}
function enchTickWindow() {
  try {
    const rec = SV.openEnch;
    if (!rec) return;
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:enchanting_table" || (w.windowId | 0) !== (rec.wid | 0)) { SV.openEnch = null; return; }
    let ok = true;
    try {
      const p = g.player;
      const dx = p.x - (rec.x + 0.5), dy = p.y - (rec.y + 0.5), dz = p.z - (rec.z + 0.5);
      if (dx * dx + dy * dy + dz * dz > 64) ok = false;
    } catch (e) {}
    try { if (blockNameAt(rec.x, rec.y, rec.z) !== "enchanting_table") ok = false; } catch (e) {}
    if (!ok) { enchClose(); return; }
    enchRefresh(rec);
  } catch (e) {}
}
function openEnchant(x, y, z) {
  try {
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:enchanting_table", windowTitle: { text: "Enchanting Table" }, slotCount: 2, entityId: 0 });
    const w = g.window;
    if (!w || w.type !== "minecraft:enchanting_table") return false;
    const rec = SV.openEnch = { x: x | 0, y: y | 0, z: z | 0, wid: 1, seed: (Math.random() * 2147483647) | 0, key: null, shelves: 0, costs: [0, 0, 0], clue: [[-1, -1], [-1, -1], [-1, -1]], frame: 0 };
    w.properties = w.properties || {};
    try {
      const scr = g.screens && g.screens.current;
      if (scr && !scr._enchWrapped) {
        scr._enchWrapped = true;
        if (typeof scr.tick === "function" && !scr.tick._enchWrapped) {
          const origTick = scr.tick.bind(scr);
          const tickFn = function () { try { origTick(); } catch (e) {} try { enchTickWindow(); } catch (e) {} };
          tickFn._enchWrapped = true; scr.tick = tickFn;
        }
        if (typeof scr.extraMouseDown === "function" && !scr.extraMouseDown._enchWrapped) {
          const origMouse = scr.extraMouseDown.bind(scr);
          const mouseFn = function (mx, my, button) {
            try {
              if (button === 0) {
                const gl = this.guiLeft, gt = this.guiTop;
                for (let l = 0; l < 3; l++) {
                  const rx = gl + 60, ry = gt + 14 + 19 * l;
                  if (mx >= rx && my >= ry && mx < rx + 108 && my < ry + 19) {
                    let done = false;
                    try { done = enchCommit(SV.openEnch, l); } catch (e) { done = true; }
                    if (done) return true;
                  }
                }
              }
            } catch (e) {}
            return origMouse(mx, my, button);
          };
          mouseFn._enchWrapped = true; scr.extraMouseDown = mouseFn;
        }
        const wraps = ["onClose", "close"];
        for (const kk of wraps) {
          try {
            if (typeof scr[kk] === "function" && !scr[kk]._enchWrapped) {
              const orig = scr[kk].bind(scr);
              const fn = function () {
                try { enchSalvage(); } catch (e) {}
                return orig();
              };
              fn._enchWrapped = true; scr[kk] = fn;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    enchRefresh(rec);
    return true;
  } catch (e) { return false; }
}

// ---- anvil (Phase C inc 2): JE 1.15.2 ContainerRepair rules over the
// native window. The engine renders + clicks client-side (send is dead
// offline) but never fills slot 2 or consumes inputs, so survival
// recomputes the output every tick and intercepts result takes.
// JE rarity cost weights (the registry only carries table weights).
const ANV_RARITY = { protection: 1, fire_protection: 2, feather_falling: 2, blast_protection: 4, projectile_protection: 2, respiration: 4, aqua_affinity: 4, thorns: 8, depth_strider: 4, frost_walker: 4, binding_curse: 8, sharpness: 1, smite: 2, bane_of_arthropods: 2, knockback: 2, fire_aspect: 4, looting: 4, sweeping: 4, efficiency: 1, silk_touch: 8, unbreaking: 2, fortune: 4, power: 1, punch: 4, flame: 4, infinity: 8, luck_of_the_sea: 4, lure: 4, loyalty: 2, impaling: 4, riptide: 4, channeling: 8, multishot: 4, quick_charge: 2, piercing: 1, mending: 4, vanishing_curse: 8 };
function anvRepairMat(nm) {
  // vanilla ToolItem/ArmorItem repair ingredients (+shield/elytra/bow/rod)
  if (!nm) return null;
  if (nm === "shield" || /^wooden_/.test(nm) || /_planks$/.test(nm)) return "ANY_PLANKS";
  if (/^stone_/.test(nm)) return "cobblestone";
  if (/^iron_/.test(nm) || /^chainmail_/.test(nm) || nm === "shears") return "iron_ingot";
  if (/^golden_/.test(nm)) return "gold_ingot";
  if (/^diamond_/.test(nm)) return "diamond";
  if (/^leather_/.test(nm)) return "leather";
  if (nm === "turtle_helmet") return "scute";
  if (nm === "elytra") return "phantom_membrane";
  if (nm === "bow" || nm === "fishing_rod") return "string";
  return null;
}
function anvReadRepair(st) {
  // prior-work penalty NBT (engine ignores it; only we read/write it)
  try {
    const tag = game().items.nbt(st);
    const v = tag && tag.RepairCost;
    if (typeof v === "number") return v | 0;
    if (v && typeof v.v === "number") return v.v | 0;
  } catch (e) {}
  return 0;
}
function anvEnchPairs(stack) {
  // [[name, lvl]] from Enchantments, or StoredEnchantments on books
  try {
    const tag = game().items.nbt(stack);
    if (!tag) return [];
    let list = tag.Enchantments;
    if ((!Array.isArray(list) || !list.length) && stackName(stack) === "enchanted_book") list = tag.StoredEnchantments;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
      const id = String((e && e.id) || "").replace(/^minecraft:/, "");
      const lvl = (e && e.lvl) | 0;
      if (id && lvl > 0) out.push([id, lvl]);
    }
    return out;
  } catch (e) { return []; }
}
function anvCanApply(eDef, cats, targetIsBook, creative) {
  // vanilla Enchantment.canApply through our category table
  if (creative || targetIsBook) return true;
  if (!eDef) return false;
  const cat = eDef.cat || "";
  if (!cat) return cats.indexOf("crossbow") >= 0;
  return cats.indexOf(cat) >= 0;
}
function anvCompute(item0, item1, newName, creative) {
  // faithful ContainerRepair.updateRepairOutput: {cost, mat, out}
  const none = { cost: 0, mat: 0, out: null };
  try {
    if (!item0 || !item0.id) return none;
    const nm0 = stackName(item0);
    const def0 = itemDefByName(nm0);
    const maxDmg = (def0 && def0.maxDurability) | 0;
    const dmg0 = item0.damage | 0;
    const damageable = maxDmg > 0;
    const cats = (def0 && def0.enchantCategories) || [];
    const isBookTarget = nm0 === "enchanted_book";
    const out = { id: item0.id, count: item0.count | 0 || 1 };
    if (dmg0) out.damage = dmg0;
    let nbt = null;
    try { nbt = item0.nbt ? JSON.parse(JSON.stringify(item0.nbt)) : { t: 10, v: {} }; }
    catch (e) { nbt = { t: 10, v: {} }; }
    nbt.v = nbt.v || {};
    const penL = anvReadRepair(item0);
    const penR = item1 && item1.id ? anvReadRepair(item1) : 0;
    let j = penL + penR, i = 0, k = 0, mat = 0;
    const curMap = {};
    for (const p of anvEnchPairs(item0)) curMap[p[0]] = p[1] | 0;
    if (item1 && item1.id) {
      const nm1 = stackName(item1);
      const sacPairs = anvEnchPairs(item1);
      const flag = nm1 === "enchanted_book" && sacPairs.length > 0;
      const repMat = anvRepairMat(nm0);
      const isMat = repMat === "ANY_PLANKS" ? /_planks$/.test(nm1) : (!!repMat && nm1 === repMat);
      if (damageable && isMat) {
        const unit = Math.max(1, Math.floor(maxDmg / 4));
        let dmg = dmg0, used = 0, l2 = Math.min(dmg, unit);
        const have = (item1.count | 0) || 1;
        while (l2 > 0 && used < have) { dmg -= l2; i++; used++; l2 = Math.min(dmg, unit); }
        if (i <= 0) return none; // already full: no output, no cost
        if (dmg > 0) out.damage = dmg; else delete out.damage;
        mat = used;
      } else {
        if (!flag && (nm1 !== nm0 || !damageable)) return none;
        if (damageable && !flag) {
          const def1 = itemDefByName(nm1);
          const max1 = ((def1 && def1.maxDurability) | 0) || maxDmg;
          const dmg1 = item1.damage | 0;
          let l1 = maxDmg - ((maxDmg - dmg0) + (max1 - dmg1) + Math.floor(maxDmg * 12 / 100));
          if (l1 < 0) l1 = 0;
          if (l1 < dmg0) { if (l1 > 0) out.damage = l1; else delete out.damage; i += 2; }
        }
        const reg = enchReg().byName;
        let flag2 = false, flag3 = false;
        for (const sp of sacPairs) {
          const en = sp[0], sl = sp[1] | 0;
          const eDef = reg[en];
          const has = curMap[en] | 0;
          let nl = has === sl ? sl + 1 : Math.max(has, sl);
          let ok = anvCanApply(eDef, cats, isBookTarget, creative);
          if (ok) {
            for (const ck in curMap) {
              if (ck !== en) {
                const cd = reg[ck];
                if ((cd && cd.excl.indexOf(en) >= 0) || (eDef && eDef.excl.indexOf(ck) >= 0)) { ok = false; i++; }
              }
            }
          }
          if (!ok) { flag3 = true; continue; }
          flag2 = true;
          if (eDef && nl > eDef.max) nl = eDef.max;
          curMap[en] = nl;
          let rar = (eDef && ANV_RARITY[en]) || 1;
          if (flag) rar = Math.max(1, Math.floor(rar / 2));
          i += rar * nl;
          if ((item0.count | 0) > 1) i = 40;
        }
        if (flag3 && !flag2) return none;
      }
    }
    // rename (blank field clears a custom name)
    let curName = "";
    try { curName = String(game().items.displayName(item0) || "").replace(/§./g, ""); } catch (e) {}
    let hasCustom = false;
    try { const tg = game().items.nbt(item0); hasCustom = !!(tg && tg.display && typeof tg.display.Name === "string"); } catch (e) {}
    if (!newName) {
      if (hasCustom) {
        k = 1; i += k;
        try { if (nbt.v.display && nbt.v.display.v) { delete nbt.v.display.v.Name; if (!Object.keys(nbt.v.display.v).length) delete nbt.v.display; } } catch (e) {}
      }
    } else if (newName !== curName) {
      k = 1; i += k;
      try {
        nbt.v.display = nbt.v.display || { t: 10, v: {} };
        nbt.v.display.v = nbt.v.display.v || {};
        nbt.v.display.v.Name = { t: 8, v: '{"text":' + JSON.stringify(newName) + '}' };
      } catch (e) {}
    }
    const cost = j + i;
    if (i <= 0) return { cost: 0, mat: 0, out: null };
    if (!creative && cost >= 40) return { cost: cost, mat: 0, out: null }; // "Too expensive!"
    let k2 = penL;
    if (item1 && item1.id && penR > k2) k2 = penR;
    if (k !== i || k === 0) k2 = k2 * 2 + 1; // rename-only keeps its penalty
    const pairs = [];
    for (const kn in curMap) pairs.push([kn, curMap[kn]]);
    try {
      if (!pairs.length) {
        if (isBookTarget) delete nbt.v.StoredEnchantments;
        else delete nbt.v.Enchantments;
      } else {
        const add = vtNbtEnch(pairs, isBookTarget);
        if (isBookTarget) { nbt.v.StoredEnchantments = add.v.StoredEnchantments; delete nbt.v.Enchantments; }
        else { nbt.v.Enchantments = add.v.Enchantments; delete nbt.v.StoredEnchantments; }
      }
    } catch (e) { return { cost: 0, mat: 0, out: null }; }
    nbt.v.RepairCost = { t: 3, v: k2 | 0 };
    out.nbt = nbt;
    if (!out.damage) delete out.damage;
    return { cost: cost, mat: mat, out: out };
  } catch (e) { return none; }
}
function anvStageMin(name) {
  // block minStateId for an anvil stage (cached asset scan)
  try {
    SV.anvStages = SV.anvStages || {};
    if (!(name in SV.anvStages)) {
      let m = -1;
      try {
        const all = game().assets.data.blocks || [];
        for (const b of all) { if (b && b.name === name) { m = b.minStateId | 0; break; } }
      } catch (e) {}
      SV.anvStages[name] = m;
    }
    return SV.anvStages[name];
  } catch (e) { return -1; }
}
function anvRefresh(rec) {
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:anvil" || !rec) return;
    const creative = !!(g.player && g.player.creative);
    const item0 = w.get(0), item1 = w.get(1);
    const snap = (s) => (s && s.id) ? [s.id, s.damage | 0, s.count | 0, s.nbt || null] : null;
    const key = JSON.stringify([snap(item0), snap(item1), rec.name || "", creative]);
    rec.frame = (rec.frame | 0) + 1;
    if (key === rec.key && (rec.frame % 30) !== 0) return;
    rec.key = key;
    const r = anvCompute(item0, item1, rec.name || "", creative);
    rec.cost = r.cost; rec.materialCost = r.mat;
    try { w.put(2, r.out); } catch (e) {}
    try { w.properties = w.properties || {}; w.properties[0] = r.cost; } catch (e) {}
  } catch (e) {}
}
function anvFits(v, out) {
  // whole result must fit the player inventory, else vanilla refuses
  try {
    const g = game();
    let mx = 64;
    try { mx = (g.items.maxStack(out.id)) | 0 || 64; } catch (e) {}
    let need = out.count | 0 || 1;
    const main = v.main || [];
    for (let j = 0; j < main.length && need > 0; j++) {
      const s = main[j];
      if (!s || !s.id) { need -= mx; continue; }
      if (s.id === out.id && (s.damage | 0) === (out.damage | 0)) {
        try {
          if (JSON.stringify(s.nbt || null) === JSON.stringify(out.nbt || null)) need -= Math.max(0, mx - (s.count | 0));
        } catch (e) {}
      }
    }
    return need <= 0;
  } catch (e) { return false; }
}
function anvTake(rec, mode) {
  // run the result-take the engine would have sent to a server. Always
  // swallows the click (returns true) so the engine can never dupe.
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:anvil" || !rec) return true;
    try { anvRefresh(rec); } catch (e) {}
    const out = w.get(2);
    const cost = (w.properties && w.properties[0]) | 0;
    if (!out || !out.id || !(cost > 0)) return true;
    const creative = !!(g.player && g.player.creative);
    if (!creative && (SV.xpLevel | 0) < cost) return true;
    const v = inv();
    if (!v) return true;
    if ((mode | 0) === 1) {
      if (!anvFits(v, out)) return true;
    } else if (v.cursor && v.cursor.id) {
      return true; // occupied cursor: vanilla does nothing
    }
    try { w.put(0, null); } catch (e) {}
    try {
      const s1 = w.get(1);
      if (s1 && s1.id) {
        const used = rec.materialCost | 0;
        if (used > 0 && (s1.count | 0) > used) { s1.count = (s1.count | 0) - used; try { w.put(1, s1); } catch (e) {} }
        else { try { w.put(1, null); } catch (e) {} }
      }
    } catch (e) { try { w.put(1, null); } catch (e2) {} }
    if (!creative) { try { deductXPLevels(cost); } catch (e) {} }
    const cp = { id: out.id, count: out.count | 0 || 1 };
    if (out.damage) cp.damage = out.damage | 0;
    if (out.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(out.nbt)); } catch (e) { try { cp.nbt = out.nbt; } catch (e2) {} } }
    if ((mode | 0) === 1) {
      try { v.addToInventory(cp); } catch (e) {}
      let left = cp.count | 0;
      if (left > 0) { // fits() said room; spill any impossible leftover
        try {
          const p = game().player;
          const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
          if (id != null && cp.nbt) {
            try { const e = game().entities.get(id); if (e && e.item) e.item.nbt = cp.nbt; } catch (e) {}
          }
        } catch (e) {}
      }
    } else {
      try { v.cursor = cp; } catch (e) { return true; }
    }
    try { w.put(2, null); } catch (e) {}
    if (!creative && Math.random() < 0.12) {
      // anvil degrades a stage (intact -> chipped -> damaged -> break)
      try {
        const stages = ["anvil", "chipped_anvil", "damaged_anvil"];
        const st = g.world.getState(rec.x | 0, rec.y | 0, rec.z | 0);
        const d = defOf(st);
        const si = d ? stages.indexOf(d.name) : -1;
        if (d && si >= 0) {
          const facing = (st | 0) - (d.minStateId | 0);
          const nmin = anvStageMin(stages[si + 1]);
          const next = nmin >= 0 ? nmin + facing : (d.minStateId | 0) + 4 + facing;
          const broke = si >= 2;
          SV.grief = true;
          try { g.world.setState(rec.x | 0, rec.y | 0, rec.z | 0, broke ? 0 : next); }
          finally { SV.grief = false; }
          if (broke) {
            try { chat("§eYour anvil broke!"); } catch (e) {}
            try { sfx("block.anvil.destroy"); } catch (e) {}
          }
        }
      } catch (e) { try { SV.grief = false; } catch (e2) {} }
    }
    try { sfx("block.anvil.use"); } catch (e) {}
    rec.key = null;
    try { anvRefresh(rec); } catch (e) {}
    return true;
  } catch (e) { return true; }
}
function anvSalvage() {
  // return both input slots to the player (enchanting salvage precedent)
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:anvil" || w._anvSalvaged) return;
    w._anvSalvaged = true;
    for (let i = 0; i <= 1; i++) {
      let s = null;
      try { s = w.get(i); } catch (e) {}
      if (!s || !s.id) continue;
      try { w.put(i, null); } catch (e) {}
      const cp = { id: s.id, count: s.count | 0 || 1 };
      if (s.damage) cp.damage = s.damage | 0;
      if (s.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(s.nbt)); } catch (e) { try { cp.nbt = s.nbt; } catch (e2) {} } }
      let left = cp.count;
      try {
        const v = inv();
        if (v && typeof v.addToInventory === "function") { v.addToInventory(cp); left = cp.count | 0; }
      } catch (e) {}
      if (left > 0) {
        try {
          const v = inv();
          let placed = false;
          if (v && v.main) {
            for (let j = 0; j < v.main.length && !placed; j++) {
              if (!v.main[j]) { v.main[j] = { id: cp.id, count: left }; if (cp.damage) v.main[j].damage = cp.damage; if (cp.nbt) v.main[j].nbt = cp.nbt; placed = true; }
            }
          }
          if (!placed) {
            const p = game().player;
            const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
            if (id != null && cp.nbt) {
              try {
                const e = game().entities.get(id);
                if (e && e.item) e.item.nbt = cp.nbt;
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}
function anvClose() {
  try {
    SV.openAnv = null;
    const g = game(), w = g && g.window;
    if (w && w.type === "minecraft:anvil") {
      try { anvSalvage(); } catch (e) {}
      try { g.on_close_window({ windowId: w.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
  } catch (e) { try { SV.openAnv = null; } catch (e2) {} }
}
function anvTickWindow() {
  try {
    const rec = SV.openAnv;
    if (!rec) return;
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:anvil" || (w.windowId | 0) !== (rec.wid | 0)) { SV.openAnv = null; return; }
    let ok = true;
    try {
      const p = g.player;
      const dx = p.x - (rec.x + 0.5), dy = p.y - (rec.y + 0.5), dz = p.z - (rec.z + 0.5);
      if (dx * dx + dy * dy + dz * dz > 64) ok = false;
    } catch (e) {}
    try {
      const bn = blockNameAt(rec.x, rec.y, rec.z);
      if (bn !== "anvil" && bn !== "chipped_anvil" && bn !== "damaged_anvil") ok = false;
    } catch (e) {}
    if (!ok) { anvClose(); return; }
    try {
      const scr = g.screens && g.screens.current;
      if (scr && scr.nameField && typeof scr.nameField.text === "string") rec.name = scr.nameField.text;
    } catch (e) {}
    anvRefresh(rec);
  } catch (e) {}
}
function openAnvil(x, y, z) {
  try {
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (SV.openAnv) { try { anvClose(); } catch (e) {} }
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:anvil", windowTitle: { text: "Anvil" }, slotCount: 3, entityId: 0 });
    const w = g.window;
    if (!w || w.type !== "minecraft:anvil") return false;
    const rec = SV.openAnv = { x: x | 0, y: y | 0, z: z | 0, wid: 1, name: "", key: null, cost: 0, materialCost: 0, frame: 0 };
    w.properties = w.properties || {};
    try {
      const scr = g.screens && g.screens.current;
      if (scr && !scr._anvWrapped) {
        scr._anvWrapped = true;
        if (typeof scr.tick === "function" && !scr.tick._anvWrapped) {
          const origTick = scr.tick.bind(scr);
          const tickFn = function () { try { origTick(); } catch (e) {} try { anvTickWindow(); } catch (e) {} };
          tickFn._anvWrapped = true; scr.tick = tickFn;
        }
        if (typeof w.slotClick === "function" && !w.slotClick._anvWrapped) {
          const origSC = w.slotClick.bind(w);
          const scFn = function (slotId, button, mode) {
            try {
              if ((slotId | 0) === 2 && (mode | 0) !== 5) {
                // result slot: normal click / shift-click take; every other
                // mode is swallowed (vanilla has no hotbar-swap/drop/collect
                // take on result slots — never let the engine move it).
                const m = mode | 0;
                if (m === 0 || m === 1) {
                  let done = true;
                  try { done = anvTake(SV.openAnv, m); } catch (e) { done = true; }
                  if (done) return null;
                } else {
                  return null;
                }
              }
            } catch (e) {}
            return origSC(slotId, button, mode);
          };
          scFn._anvWrapped = true; w.slotClick = scFn;
        }
        const wraps = ["onClose", "close"];
        for (const kk of wraps) {
          try {
            if (typeof scr[kk] === "function" && !scr[kk]._anvWrapped) {
              const orig = scr[kk].bind(scr);
              const fn = function () {
                try { anvSalvage(); } catch (e) {}
                return orig();
              };
              fn._anvWrapped = true; scr[kk] = fn;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    anvRefresh(rec);
    return true;
  } catch (e) { return false; }
}

function openWorkbench() {  // The engine ships a full vanilla crafting_table window (10 slots: result
  // + 3x3, recipe-book button); it just never opens offline. recipes.js
  // patches the live window's matcher to 1.13 ids (see patchBench).
  const g = game();
  if (!g || typeof g.on_open_window !== "function") return false;
  try {
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:crafting_table", windowTitle: { text: "Crafting Table" }, slotCount: 10, entityId: 0 });
  } catch (e) { return false; }
  try {
    const w = g.window;
    if (!w || w.type !== "minecraft:crafting_table") return false;
    try {
      if (globalThis.__mcRecipes && typeof globalThis.__mcRecipes.patchBench === "function") {
        globalThis.__mcRecipes.patchBench(w);
      }
    } catch (e) {}
    // The engine's close path clears the cursor + grid (items would vanish).
    // Salvage both back to the player first (vanilla drops them; returning
    // to the inventory is friendlier and pickup is a tap away if it spills).
    try {
      const scr = g.screens && g.screens.current;
      if (scr && !scr._wbSalvageWrapped) {
        scr._wbSalvageWrapped = true;
        const wraps = ["onClose", "close"];
        for (const k of wraps) {
          try {
            if (typeof scr[k] === "function" && !scr[k]._wbWrapped) {
              const orig = scr[k].bind(scr);
              const fn = function () {
                try {
                  if (!scr._wbSalvaged) { scr._wbSalvaged = true; salvageWorkbench(); }
                } catch (e) {}
                return orig();
              };
              fn._wbWrapped = true;
              scr[k] = fn;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  } catch (e) {}
  return true;
}
function salvageWorkbench() {
  // return the workbench grid + cursor stack to the player (overflow spills
  // as item entities, like a broken container)
  try {
    const g = game(), w = g && g.window, inv = g && g.inventory;
    if (!w || w.type !== "minecraft:crafting_table") return;
    const putBack = (s) => {
      if (!s || !s.id) return;
      try {
        const cp = { id: s.id, count: s.count | 0, damage: s.damage | 0 };
        if (s.nbt) { try { cp.nbt = s.nbt; } catch (e) {} }
        let leftover = 0;
        try {
          if (inv && typeof inv.addToInventory === "function") {
            inv.addToInventory(cp);
            leftover = cp.count | 0;
          } else leftover = cp.count | 0;
        } catch (e) { leftover = cp.count | 0; }
        if (leftover > 0) {
          try {
            const p = g.player;
            const did = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, leftover);
            try {
              const e = g.entities && g.entities.get(did);
              if (e && e.item) { e.item.damage = cp.damage | 0; if (cp.nbt) e.item.nbt = cp.nbt; }
            } catch (_) {}
          } catch (e) {}
        }
      } catch (e) {}
    };
    try { if (inv && inv.cursor && inv.cursor.id) putBack(inv.cursor); } catch (e) {}
    for (let i = 1; i <= 9; i++) {
      try {
        const s = w.container && w.container[i];
        if (s && s.id) putBack(s);
      } catch (e) {}
    }
  } catch (e) {}
}
function openTile(x, y, z, type) {
  const g = game();
  const titles = { furnace: "Furnace", blast: "Blast Furnace", smoker: "Smoker", barrel: "Barrel", chest: "Chest", ender: "Ender Chest", trap: "Trapped Chest", brewing: "Brewing Stand", hopper: "Hopper", dispenser: "Dispenser", dropper: "Dropper", shulker: "Shulker Box" };
  const counts = { furnace: 3, blast: 3, smoker: 3, barrel: 27, chest: 27, ender: 27, trap: 27, brewing: 5, hopper: 5, dispenser: 9, dropper: 9, shulker: 27 };
  const wtype = type === "brewing" ? "minecraft:brewing_stand"
    : type === "barrel" ? "minecraft:container"
    : type === "blast" ? "minecraft:blast_furnace"
    : type === "smoker" ? "minecraft:smoker"
    : type === "hopper" ? "minecraft:hopper"
    : type === "dispenser" ? "minecraft:dispenser"
    : type === "dropper" ? "minecraft:dropper"
    : type === "shulker" ? "minecraft:shulker_box"
    : "minecraft:" + (type === "ender" || type === "trap" ? "chest" : type);
  let tile = getTile(x, y, z);
  if (!tile) {
    tile = { type, x, y, z, items: new Array(counts[type] || 27).fill(null), burn: 0, burnTotal: 0, cook: 0, xp: 0, fuel: 0, time: 0, ing: null, cd: 0, pow: false };
    setTile(x, y, z, tile);
  }
  SV.openTile = { key: tileKey(x, y, z), wid: 1 };
  try {
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: wtype, windowTitle: { text: titles[type] || type }, slotCount: counts[type] || 27, entityId: 0 });
  } catch (e) { SV.openTile = null; return false; }
  try {
    const w = g.window;
    if (!w || w.type !== wtype) { SV.openTile = null; return false; }
    for (let i = 0; i < (counts[type] || 27); i++) {
      const s = tile.items[i];
      w.container[i] = s ? { id: s.id, count: s.count, nbt: s.nbt || undefined } : null;
    }
    w.properties = tileProps(tile);
  } catch (e) {}
  return true;
}
function tileProps(tile) {
  if (furnaceLike(tile.type)) return [tile.burn, tile.burnTotal, tile.cook, tile.type === "furnace" ? 10 : 5];
  if (tile.type === "brewing") return [(tile.time | 0), (tile.fuel | 0)]; // stand: [brewTime, fuel]
  return [];
}
function pullWindowToTile(tile) {
  // player clicks mutate the engine window; capture them into the tile.
  // Also detects output-taken (vanilla: releases banked smelt XP).
  try {
    const w = game().window;
    if (!w || !SV.openTile) return;
    if (furnaceLike(tile.type) && (tile.xp | 0) > 0) {
      const before = tile.lastOut | 0, now = (w.container[2] && w.container[2].count | 0) || 0;
      if (now < before && tile.xp > 0) {
        let n = Math.floor(tile.xp);
        if (Math.random() < tile.xp - n) n++;
        tile.xp = 0;
        if (n > 0) {
          try {
            const p = game().player;
            for (const v of orbSplit(n)) spawnXPOrb(p.x, p.y + 0.5, p.z, v);
          } catch (e) {}
        }
      }
    }
    for (let i = 0; i < tile.items.length && i < w.container.length; i++) {
      const s = w.container[i];
      tile.items[i] = s ? { id: s.id, count: s.count | 0, nbt: s.nbt || null } : null;
    }
    if (furnaceLike(tile.type)) tile.lastOut = (w.container[2] && w.container[2].count | 0) || 0;
  } catch (e) {}
}
function pushTileToWindow(tile) {
  // furnace progress -> engine window (output appears, flame/arrow animate)
  try {
    const w = game().window;
    if (!w || !SV.openTile) return;
    for (let i = 0; i < tile.items.length && i < w.container.length; i++) {
      const s = tile.items[i];
      w.container[i] = s ? { id: s.id, count: s.count, nbt: s.nbt || undefined } : null;
    }
    if (furnaceLike(tile.type)) tile.lastOut = (tile.items[2] && tile.items[2].count | 0) || 0;
    w.properties = tileProps(tile);
  } catch (e) {}
}
function syncTileToWindow(tile) {
  // legacy entry: pull user edits, then push (kept for save path compat)
  try { pullWindowToTile(tile); } catch (e) {}
  try { pushTileToWindow(tile); } catch (e) {}
}
function saveOpenTile() {
  try {
    if (!SV.openTile || !game().window) { SV.openTile = null; return; }
    if (game().window.windowId !== SV.openTile.wid) { SV.openTile = null; return; }
    if (SV.openTile.horse) { try { saveHorseWindow(); } catch (e) {} SV.openTile = null; return; }
    const t = SV.tiles && SV.tiles.get(SV.openTile.key);
    if (!t) { SV.openTile = null; return; }
    pullWindowToTile(t);
  } catch (e) { try { SV.openTile = null; } catch (e2) {} }
}
function furnaceTick(t, dt) {
  // t: {items:[in,fuel,out], burn, burnTotal, cook, xp}. Blast/smoker cook
  // twice as fast but burn fuel twice as fast (vanilla: same items per
  // fuel, half the time), and only take their JE recipe sets.
  const fast = t.type === "blast" || t.type === "smoker";
  const COOK_MAX = fast ? 5 : 10;
  const inp = t.items[0], fuel = t.items[1], out = t.items[2];
  const sm = inp && inp.id ? smeltOfKind(stackName(inp), t.type) : null;
  let outRoom = false;
  if (sm) {
    if (!out) outRoom = true;
    else if (out.id === sm.outId) {
      try {
        const max = game().items.maxStack(sm.outId) | 0 || 64;
        outRoom = (out.count | 0) < max;
      } catch (e) { outRoom = (out.count | 0) < 64; }
    }
  }
  const burning = t.burn > 0;
  if (burning) t.burn = Math.max(0, t.burn - (fast ? 2 : 1) * dt);
  if (sm && outRoom) {
    if (t.burn <= 0) {
      // need fuel
      const fs = fuel && fuel.id ? fuelSecs(stackName(fuel)) : 0;
      if (fs > 0) {
        t.burn = t.burnTotal = fs;
        // consume one fuel (lava bucket leaves its bucket behind)
        const fn = stackName(fuel);
        if (fn === "lava_bucket") {
          t.items[1] = { id: itemIdByName("bucket"), count: 1 };
        } else {
          fuel.count = (fuel.count | 0) - 1;
          if (fuel.count <= 0) t.items[1] = null;
        }
        setFurnaceLit(t, true);
      } else {
        // out of fuel: progress rewinds at double speed (vanilla 1.8+)
        t.cook = Math.max(0, t.cook - 2 * dt);
      }
    }
    if (t.burn > 0) {
      t.cook += dt;
      if (t.cook >= COOK_MAX) {
        t.cook = 0;
        inp.count = (inp.count | 0) - 1;
        if (inp.count <= 0) t.items[0] = null;
        if (!t.items[2]) t.items[2] = { id: sm.outId, count: 1 };
        else t.items[2].count = (t.items[2].count | 0) + 1;
        t.xp = (t.xp || 0) + sm.xp;
      }
    }
  } else if (t.cook > 0 && t.burn <= 0) {
    t.cook = Math.max(0, t.cook - 2 * dt); // rewind when idle
  }
  if (t.burn <= 0 && t.burnTotal !== 0) { t.burnTotal = 0; setFurnaceLit(t, false); }
}
function setFurnaceLit(t, lit) {
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const def = defOf(st);
    if (!def || (def.name !== "furnace" && def.name !== "blast_furnace" && def.name !== "smoker")) return;
    const base = def.minStateId, off = st - base;
    const want = (base + (off & ~1) + (lit ? 1 : 0));
    if (want !== st) {
      SV.grief = true;
      try { g.world.setState(t.x, t.y, t.z, want); } finally { SV.grief = false; }
    }
  } catch (e) {}
}
// ---- brewing stand (Phase C inc 3): JE 1.15.2 PotionBrewing rules over a
// tile (furnace/chest precedent), so it keeps brewing with the UI closed
// and persists. Full mix table + fuel + 400-tick batches.
// ingredient -> { inputPotion: outputPotion } (container type preserved;
// gunpowder / dragon breath change the container instead — see brewOutput)
const BREW_MIX = {
  nether_wart: { water: "awkward" },
  redstone: { night_vision: "long_night_vision", invisibility: "long_invisibility", leaping: "long_leaping", fire_resistance: "long_fire_resistance", swiftness: "long_swiftness", slowness: "long_slowness", water_breathing: "long_water_breathing", poison: "long_poison", weakness: "long_weakness", regeneration: "long_regeneration", strength: "long_strength", awkward: "mundane" },
  glowstone_dust: { healing: "strong_healing", harming: "strong_harming", poison: "strong_poison", regeneration: "strong_regeneration", strength: "strong_strength", swiftness: "strong_swiftness", leaping: "strong_leaping", slowness: "strong_slowness", awkward: "thick", water: "thick" },
  fermented_spider_eye: { awkward: "weakness", water: "weakness", healing: "harming", poison: "harming", night_vision: "invisibility", swiftness: "slowness", leaping: "slowness" },
  sugar: { awkward: "swiftness" },
  rabbit_foot: { awkward: "leaping" },
  glistering_melon_slice: { awkward: "healing" },
  spider_eye: { awkward: "poison" },
  magma_cream: { awkward: "fire_resistance" },
  blaze_powder: { awkward: "strength" },
  ghast_tear: { awkward: "regeneration" },
  phantom_membrane: { awkward: "slow_falling" },
  turtle_helmet: { awkward: "turtle_master" },
  pufferfish: { awkward: "water_breathing" },
  golden_carrot: { awkward: "night_vision" },
};
function brewOutput(stack, ing) {
  // transformed bottle ({id, potion}) or null. Mirrors PotionBrewing:
  // gunpowder upgrades the container, dragon breath only works on splash.
  try {
    if (!stack || !stack.id || !ing) return null;
    const inId = stack.id;
    const potionId = itemIdByName("potion"), splashId = itemIdByName("splash_potion"), lingId = itemIdByName("lingering_potion");
    if (inId !== potionId && inId !== splashId && inId !== lingId) return null;
    let ptype = null;
    try { const tg = game().items.nbt(stack); if (tg && typeof tg.Potion === "string") ptype = tg.Potion.replace(/^minecraft:/, ""); } catch (e) {}
    if (!ptype) return null;
    if (ing === "gunpowder") {
      if (inId !== potionId) return null;
      return { id: splashId, potion: ptype };
    }
    if (ing === "dragon_breath") {
      if (inId !== splashId) return null;
      return { id: lingId, potion: ptype };
    }
    const mix = BREW_MIX[ing];
    if (!mix) return null;
    const out = mix[ptype];
    if (!out || out === ptype) return null;
    return { id: inId, potion: out };
  } catch (e) { return null; }
}
function brewComplete(t, ingName) {
  // one finished batch: transform every convertible bottle, eat 1 ingredient
  try {
    const items = t.items;
    for (let i = 0; i < 3; i++) {
      const b = items[i];
      if (!b || !b.id) continue;
      const r = brewOutput(b, ingName);
      if (!r) continue;
      const keep = { id: r.id, count: 1 };
      let nbt = null;
      try { nbt = b.nbt ? JSON.parse(JSON.stringify(b.nbt)) : { t: 10, v: {} }; }
      catch (e) { nbt = { t: 10, v: {} }; }
      nbt.v = nbt.v || {};
      nbt.v.Potion = { t: 8, v: "minecraft:" + r.potion };
      keep.nbt = nbt;
      items[i] = keep;
    }
    const ing = items[3];
    if (ing && ing.id) {
      ing.count = (ing.count | 0) - 1;
      if (ing.count <= 0) items[3] = null;
    }
    try { sfx("block.brewing_stand.brew"); } catch (e) {}
  } catch (e) {}
}
function brewTileTick(t, dt) {
  // vanilla TileEntityBrewingStand.tick: fuel refill, 400-tick batches at
  // 20 ticks/sec, ingredient swap cancels, empty slots cancel.
  try {
    const items = t.items;
    const fuelStack = items[4];
    if ((t.fuel | 0) <= 0 && fuelStack && fuelStack.id && stackName(fuelStack) === "blaze_powder") {
      t.fuel = 20;
      fuelStack.count = (fuelStack.count | 0) - 1;
      if (fuelStack.count <= 0) items[4] = null;
    }
    const ing = items[3];
    const ingName = ing && ing.id ? stackName(ing) : null;
    let brewable = false;
    if (ingName) {
      for (let i = 0; i < 3; i++) {
        const b = items[i];
        if (b && b.id && brewOutput(b, ingName)) { brewable = true; break; }
      }
    }
    if ((t.time | 0) > 0) {
      t.time = (t.time | 0) - Math.max(1, Math.round(20 * (dt || 0.1)));
      if ((t.time | 0) <= 0) {
        t.time = 0;
        if (brewable) brewComplete(t, ingName);
      } else if (!brewable) {
        t.time = 0;
      } else if (ingName !== t.ing) {
        t.time = 0;
      }
    } else if (brewable && (t.fuel | 0) > 0) {
      t.fuel = (t.fuel | 0) - 1;
      t.time = 400;
      t.ing = ingName;
    }
    if ((t.time | 0) < 0) t.time = 0;
  } catch (e) {}
}
function tilesTick(dt) {
  try {
    if (!SV.tiles || SV.tiles.size === 0) return;
    let dirtyWindow = false;
    SV.tiles.forEach((t) => {
      if (!t) return;
      const tk = t.key || tileKey(t.x, t.y, t.z);
      const isOpen = !!(SV.openTile && SV.openTile.key === tk);
      if (!furnaceLike(t.type)) {
        // chests/ender chests/barrels: no simulation, but keep the open window live
        // (horse tack windows save on close via saveHorseWindow, never here —
        // a raw pull would bypass saddle/armor slot validation)
        if (t.type === "horse") return;
        if (t.type === "brewing") {
          if (isOpen) { try { pullWindowToTile(t); } catch (e) {} }
          try { brewTileTick(t, dt); } catch (e) {}
          if (isOpen) {
            try { pushTileToWindow(t); } catch (e) {}
            dirtyWindow = true;
          }
          return;
        }
        if (t.type === "hopper" || t.type === "dispenser" || t.type === "dropper") {
          if (isOpen) { try { pullWindowToTile(t); } catch (e) {} }
          try {
            // tiles carry their block type; a swapped block (mined + replaced
            // by another container) must not run the old sim
            const bn = tileBlockName(t);
            if ((t.type === "hopper" && bn === "hopper") ||
                ((t.type === "dispenser" || t.type === "dropper") && (bn === "dispenser" || bn === "dropper"))) {
              if (t.type === "hopper") hopperTileTick(t);
              else dispenseTileTick(t);
            }
          } catch (e) {}
          if (isOpen) {
            try { pushTileToWindow(t); } catch (e) {}
            dirtyWindow = true;
          }
          return;
        }
        if (isOpen) { try { pullWindowToTile(t); } catch (e) {} }
        return;
      }
      // 1) capture player edits from the open window BEFORE simulating,
      //    so user-placed ore/fuel isn't clobbered by stale tile state
      if (isOpen) { try { pullWindowToTile(t); } catch (e) {} }
      const before = (t.items[2] && t.items[2].count | 0) || 0;
      furnaceTick(t, dt);
      // 2) push simulation results back so output/flame/arrow show live
      if (isOpen) {
        try { pushTileToWindow(t); } catch (e) {}
        dirtyWindow = true;
      }
      // persist light-touch: mark world dirty occasionally via exhaust field
      if (before !== ((t.items[2] && t.items[2].count | 0) || 0)) { try { SV.exh += 0; } catch (e) {} }
    });
    if (!dirtyWindow) { /* closed tiles tick silently */ }
  } catch (e) {}
}
function persistTiles(rec) {
  try {
    const arr = [];
    if (SV.tiles) SV.tiles.forEach((t, k) => {
      if (!t || arr.length > 200) return;
      if (t.cart != null) return; // chest/hopper-cart tiles persist with the cart
      if (t.horse != null || String(k).slice(0, 6) === "horse:") return; // horse tack persists with the horse
      arr.push({ k, type: t.type, items: (t.items || []).map((s) => s ? { id: s.id, c: s.count | 0, n: s.nbt || null } : null), xp: t.xp || 0, burn: t.burn || 0, burnTotal: t.burnTotal || 0, cook: t.cook || 0, fuel: t.fuel || 0, time: t.time || 0, ing: t.ing || null, cd: t.cd | 0, pow: !!t.pow });
    });
    rec.tiles = arr;
  } catch (e) {}
}
function restoreTiles(rec) {
  try {
    SV.tiles = new Map();
    for (const r of (rec.tiles || []).slice(0, 200)) {
      if (!r || !r.k) continue;
      if (String(r.k).slice(0, 5) === "cart:") continue; // chest/hopper carts restore with the cart
      if (String(r.k).slice(0, 6) === "horse:") continue; // horse tack restores with the horse
      SV.tiles.set(r.k, {
        type: r.type, x: 0, y: -999, z: 0,
        items: (r.items || []).map((s) => s ? { id: s.id, count: s.c | 0, nbt: s.n || null } : null),
        burn: r.burn || 0, burnTotal: r.burnTotal || 0, cook: r.cook || 0, xp: r.xp || 0, lastOut: 0,
        fuel: r.fuel || 0, time: r.time || 0, ing: r.ing || null, cd: r.cd | 0, pow: !!r.pow,
      });
      const parts = String(r.k).split(",");
      const t = SV.tiles.get(r.k);
      t.x = +parts[0]; t.y = +parts[1]; t.z = +parts[2];
    }
  } catch (e) { try { SV.tiles = new Map(); } catch (e2) {} }
}

/* ---------------------------------------------------------- Phase C inc (v1.6.0):
 * hopper/dispenser/dropper server halves + redstone-source power.
 *
 * Engine gives us the registries, native windows (minecraft:hopper 5 slots,
 * dispenser/dropper through the generic_3x3 9-slot alias), placement of
 * default states, and item/projectile rendering. Survival owns the rest:
 * oriented placement (hopper output aims at the clicked face, dispensers
 * face the placer, levers/buttons mount on the clicked face), lever/button
 * toggles + button auto-release, the hopper transfer sim (push/pull/suck,
 * 8-tick cooldown, redstone lock), dispenser/dropper power-edge firing with
 * the JE dispense table, and break-spill (rides the generic tile path).
 *
 * Power model (v1.11: full 0-15 signal sim). A block cell carries the max
 * emission of its 6 neighbors: redstone block / lever+button ON / pressed
 * plate / lit torch at 15, daylight detector at its computed daylight
 * level, repeater at 15 and comparator at 0-15 out of the FRONT face only
 * (diodes: no sideways/backward output). Dust runs a fixpoint: each wire
 * takes the max of (neighbor emission, connected-wire level minus 1) with
 * same-level, one-up and one-down neighbors conducting, and renders
 * side/up/none connections. Torches invert their attachment block with a
 * 2-tick delay and burn out after 8 toggles in 60 ticks (revived by a
 * nearby change); repeaters delay 4 ticks per delay step and freeze while
 * locked from either side; comparators read the container behind (or the
 * signal there) in compare/subtract mode with a 2-tick delay. Pistons
 * (v1.13) edge-trigger block events with a 1-tick delay + dropout on removal
 * (12-block limit, tile-entity refusal and slime/honey stickiness ride the
 * engine; QC-lite powers through the cell above); observers (v1.13) pulse
 * 2 ticks on neighbor changes with back-only output. Dust states live in the
 * world diffs, so circuits persist across reloads; only the watch-set and
 * delay queue are runtime. Out of scope: doors/trapdoors/
 * fence gates (no door sim yet), mob animations (v1.12.0).
 * Sided hopper rules are simplified: furnace-likes pull from the result slot
 * and take input/fuel by side; other containers are first-slot-first.
 * Dispenser gaps (eject as plain items, noted inline): honey bottles fill
 * at full hives (v1.10), armor onto armor stands: stands placed from the armor_stand item, hand-
  * dressed (swap) + dispenser-dressed (empty slot only), name-tagged,
  * one-punch break with stand + gear drops, gravity fall, per-world
  * persist. No arms/poses in survival (vanilla: commands only), so no
  * held items; stands ignore fire/lava/cactus. The wither
 * skips vanilla's strafe/regen phases; its skulls burst on terrain hits
 * and strike directly otherwise (no always-explode, so a direct hit
 * never double-dips); dispenser-dressed mob gear drops plain (no NBT).
 * Dropper inserts into our tiles, else ejects. Weighted plates read as
 * binary ON (no signal strength). Shulker boxes open as 27-slot tiles
 * but break spilling contents (vanilla keeps them boxed — needs item
 * NBT, out of scope).
 */

/* ---- flattened-state property codec (runtime layouts from assets data) */
let BLKLAY = null;
function blkLayout(name) {
  try {
    if (!BLKLAY) {
      BLKLAY = {};
      const arr = (game() && game().assets && game().assets.data && game().assets.data.blocks) || [];
      for (const b of arr) {
        if (!b || !b.name) continue;
        const props = [];
        for (const p of (b.states || [])) {
          let vals = p.values;
          if (!vals) {
            if (p.type === "bool") vals = ["true", "false"]; // verified vs defaults
            else if (p.type === "int") { vals = []; for (let i = 0; i < (p.num_values | 0); i++) vals.push(String(i)); }
            else vals = [];
          }
          props.push({ name: p.name, vals: vals.map(String) });
        }
        BLKLAY[b.name] = { min: b.minStateId | 0, props };
      }
    }
    return BLKLAY[name] || null;
  } catch (e) { return null; }
}
function stProp(state, name) {
  try {
    const d = defOf(state);
    if (!d) return null;
    const L = blkLayout(d.name);
    if (!L) return null;
    let off = (state | 0) - L.min;
    const got = {};
    for (let i = L.props.length - 1; i >= 0; i--) {
      const pr = L.props[i], n = pr.vals.length || 1;
      const vi = ((off % n) + n) % n;
      got[pr.name] = pr.vals[vi];
      off = Math.floor(off / n);
    }
    return (name == null) ? got : (got[name] !== undefined ? got[name] : null);
  } catch (e) { return null; }
}
function stWith(state, name, value) {
  try {
    const d = defOf(state);
    if (!d) return state;
    const L = blkLayout(d.name);
    if (!L) return state;
    const cur = stProp(state, null) || {};
    cur[name] = String(value);
    let off = 0;
    for (let i = 0; i < L.props.length; i++) {
      const pr = L.props[i];
      let vi = pr.vals.indexOf(String(cur[pr.name]));
      if (vi < 0) vi = 0;
      off = off * pr.vals.length + vi;
    }
    return L.min + off;
  } catch (e) { return state; }
}

/* ---- redstone-source power (no wire propagation — see header) */
const HOP_FACE = ["down", "north", "south", "west", "east"]; // hopper facing idx
const DISP_FACE = ["north", "east", "south", "west", "up", "down"];
const DISP_VEC = [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
function dispFacingIdx(state) {
  try {
    const v = stProp(state, "facing");
    const i = DISP_FACE.indexOf(v);
    return i < 0 ? 0 : i;
  } catch (e) { return 0; }
}
function hopFacingIdx(state) {
  try {
    const v = stProp(state, "facing");
    const i = HOP_FACE.indexOf(v);
    return i < 0 ? 0 : i;
  } catch (e) { return 0; }
}
function playerLookName() {
  // horizontal look direction of the player (south when yaw = 0)
  try {
    const p = game().player;
    const yr = (p.yaw || 0) * Math.PI / 180, cp = Math.cos((p.pitch || 0) * Math.PI / 180);
    const lx = -Math.sin(yr) * cp, lz = Math.cos(yr) * cp;
    if (Math.abs(lx) > Math.abs(lz)) return lx > 0 ? "east" : "west";
    return lz > 0 ? "south" : "north";
  } catch (e) { return "south"; }
}
function platePressed(x, y, z) {
  // stone: mobs + player. Wooden (and weighted, binary here): all entities,
  // items/arrows included (vanilla). Weighted signal strength is out of
  // scope — any entity reads as ON.
  try {
    const g = game();
    const box = [x + 0.0625, y, z + 0.0625, x + 0.9375, y + 0.25, z + 0.9375];
    const hit = (ex, ey, ez, w, h) => (ex + w / 2 > box[0] && ex - w / 2 < box[3] && ey + h > box[1] && ey < box[4] && ez + w / 2 > box[2] && ez - w / 2 < box[5]);
    const p = g.player;
    if (p && !SV.dead && hit(p.x, p.y, p.z, 0.6, 1.8)) return true;
    let found = false;
    SV.mobs.forEach((m) => {
      if (found || !m || (m.hp | 0) <= 0) return;
      if (hit(m.x, m.y, m.z, m.w || 0.6, m.h || 1.8)) found = true;
    });
    if (found) return true;
    // wooden plates hear everything else too
    let wood = false;
    try {
      const d = defOf(g.world.getState(x | 0, y | 0, z | 0));
      wood = !!d && d.name !== "stone_pressure_plate";
    } catch (e) {}
    if (!wood) return false;
    try {
      SV.items.forEach((it) => {
        if (found || !it || !it.e || !it.e.item || !it.e.item.id) return;
        if (hit(it.e.x, it.e.y, it.e.z, 0.3, 0.3)) found = true;
      });
    } catch (e) {}
    if (!found) try {
      SV.arrows.forEach((a) => {
        if (found || !a) return;
        if (hit(a.x, a.y, a.z, 0.3, 0.3)) found = true;
      });
    } catch (e) {}
    return found;
  } catch (e) { return false; }
}
function detectorPower(x, y, z, state) {
  // daylight curve, scaled by real sky exposure (roofs shade to 0) and
  // dulled by weather (rain -2, thunder -2 more). Curve shape stays an
  // approximation.
  try {
    const inv = stProp(state, "inverted") === "true";
    const t = (((game().world.timeOfDay | 0) % 24000) + 24000) % 24000;
    let p = 0;
    if (t < 12000) p = Math.round(15 * Math.sin(Math.PI * t / 12000));
    try {
      const sky = skyAt(x | 0, (y | 0) + 1, z | 0);
      p = Math.round(p * Math.max(0, Math.min(15, sky)) / 15);
    } catch (e) {}
    try { if (isRaining()) p -= 2; } catch (e) {}
    try { if (isThundering()) p -= 2; } catch (e) {}
    p = Math.max(0, Math.min(15, p));
    return inv ? 15 - p : p;
  } catch (e) { return 0; }
}
function sourcePowerAt(x, y, z) {
  // emission of the single block at x,y,z (0/15-ish: any >0 counts)
  try {
    const st = game().world.getState(x | 0, y | 0, z | 0);
    const d = defOf(st);
    if (!d || d.id === 0) return 0;
    const nm = d.name;
    if (nm === "redstone_block") return 15;
    if (nm === "redstone_torch" || nm === "redstone_wall_torch") return stProp(st, "lit") === "true" ? 15 : 0;
    if (nm === "lever" || nm.slice(-7) === "_button") return stProp(st, "powered") === "true" ? 15 : 0;
    if (nm.slice(-14) === "pressure_plate") {
      const on = platePressed(x, y, z);
      const want = on ? "true" : "false";
      if (stProp(st, "powered") !== want) {
        try { SV.grief = true; game().world.setState(x | 0, y | 0, z | 0, stWith(st, "powered", want)); } finally { SV.grief = false; }
      }
      return on ? 15 : 0;
    }
    if (nm === "daylight_detector" || nm === "daylight_detector_inverted") return detectorPower(x, y, z, st);
    return 0;
  } catch (e) { return 0; }
}
function redstonePowered(x, y, z) {
  // v1.11: devices read strong neighbor emission plus adjacent live dust
  // (dust weak-powers mechanisms directly). Hopper lock, dispenser edges
  // and rail mirroring all ride this, so dust feeds them with no changes.
  try { if (rsBlockLevel(x, y, z) > 0) return true; } catch (e) {}
  try {
    const g = game(), w = g.world;
    for (const d of FACE_D) {
      try {
        const st = w.getState((x | 0) + d[0], (y | 0) + d[1], (z | 0) + d[2]);
        const bd = defOf(st);
        if (bd && bd.name === "redstone_wire" && ((stProp(st, "power") | 0) || 0) > 0) return true;
      } catch (e) {}
    }
  } catch (e) {}
  return false;
}

/* ---- v1.11 redstone signal sim (dust + torches + repeaters + comparators) */
const RS_FACE_VEC = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
function rsKey(x, y, z) { return (x | 0) + "," + (y | 0) + "," + (z | 0); }
function rsSolid(x, y, z) {
  // full-cube support test (same derivation as the lever fix: survival defs
  // carry no opaque flag, so opaque = full cube that isn't transparent)
  try {
    const d = defOf(game().world.getState(x | 0, y | 0, z | 0));
    return !!(d && (d.opaque || (d.transparent === false && d.boundingBox === "block")));
  } catch (e) { return false; }
}
function rsWrite(x, y, z, s) {
  // our own state edits: no drops (still saved as world diffs)
  try { SV.grief = true; game().world.setState(x | 0, y | 0, z | 0, s); }
  catch (e) {} finally { try { SV.grief = false; } catch (e2) {} }
}
function rsTrack(x, y, z, s) {
  // watch-set maintenance from the setState wrapper (every write, even
  // grief ones — our own dust updates must register too). Neighbor cells
  // go dirty; burnt-out torches nearby get a second chance (vanilla).
  try {
    let nm = "";
    try { nm = s != null && (s | 0) !== 0 ? defOf(s).name : ""; } catch (e) {}
    if (!nm) { try { nm = blockNameAt(x, y, z); } catch (e) {} }
    const k = rsKey(x, y, z);
    if (nm === "redstone_wire" || nm === "redstone_torch" || nm === "redstone_wall_torch" ||
        nm === "repeater" || nm === "comparator" || nm === "daylight_detector" ||
        nm === "redstone_lamp" || nm === "note_block" || nm === "tnt" ||
        nm === "piston" || nm === "sticky_piston" || nm === "observer") {
      if (!SV.wires.has(k)) SV.wires.set(k, { x: x | 0, y: y | 0, z: z | 0, kind: nm });
      else SV.wires.get(k).kind = nm;
      if (nm === "observer") SV.obsOn = true;
    } else if (SV.wires.has(k)) {
      SV.wires.delete(k);
      try { SV.compLvl.delete(k); SV.notePrev.delete(k); SV.obsPulse.delete(k); } catch (e) {}
    }
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++)
      SV.rsDirty.add(rsKey(x + dx, y + dy, z + dz));
    if (SV.torchOut.size) {
      for (const tk of Array.from(SV.torchOut)) {
        try {
          const c = tk.split(",");
          if (Math.abs((c[0] | 0) - x) <= 2 && Math.abs((c[1] | 0) - y) <= 2 && Math.abs((c[2] | 0) - z) <= 2)
            SV.torchOut.delete(tk);
        } catch (e) {}
      }
    }
  } catch (e) {}
}
function rsEmitInto(fx, fy, fz, tx, ty, tz) {
  // signal level the block at F pushes into cell T (0-15). Plain sources
  // push every way; repeater/comparator only out the front (diode).
  try {
    const g = game(), w = g.world;
    const st = w.getState(fx | 0, fy | 0, fz | 0);
    const d = defOf(st);
    if (!d || d.id === 0) return 0;
    const nm = d.name;
    if (nm === "redstone_block" || nm === "lever" || nm.slice(-7) === "_button" ||
        nm.slice(-14) === "pressure_plate" ||
        nm === "daylight_detector" || nm === "daylight_detector_inverted") {
      // plain sources push every way (this also refreshes the plate
      // pressed-bit mirror and the computed detector level as a side effect)
      try { return sourcePowerAt(fx | 0, fy | 0, fz | 0); } catch (e) { return 0; }
    }
    if (nm === "redstone_torch" || nm === "redstone_wall_torch") {
      // torches push everywhere EXCEPT back into their own attachment
      // (vanilla: a torch never powers the block it sits on, or it would
      // switch itself straight back off)
      if (nm === "redstone_torch") {
        if ((tx | 0) === (fx | 0) && (ty | 0) === ((fy | 0) - 1) && (tz | 0) === (fz | 0)) return 0;
      } else {
        const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
        if (((fx | 0) - v[0]) === (tx | 0) && (fy | 0) === (ty | 0) && ((fz | 0) - v[2]) === (tz | 0)) return 0;
      }
      try { return sourcePowerAt(fx | 0, fy | 0, fz | 0); } catch (e) { return 0; }
    }
    if (nm === "repeater" || nm === "comparator") {
      const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
      if (((fx | 0) + v[0]) !== (tx | 0) || (fy | 0) !== (ty | 0) || ((fz | 0) + v[2]) !== (tz | 0)) return 0;
      if (stProp(st, "powered") !== "true") return 0;
      if (nm === "repeater") return 15;
      const l = SV.compLvl.get(rsKey(fx, fy, fz));
      return l == null ? 15 : Math.max(0, Math.min(15, l | 0));
    }
    if (nm === "observer") {
      // output only out the back (opposite the facing eye), while the pulse holds
      const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
      if (((fx | 0) - v[0]) !== (tx | 0) || ((fy | 0) - v[1]) !== (ty | 0) || ((fz | 0) - v[2]) !== (tz | 0)) return 0;
      return stProp(st, "powered") === "true" ? 15 : 0;
    }
    return 0;
  } catch (e) { return 0; }
}
function rsBlockLevel(x, y, z) {
  // max emission the 6 neighbors push into this cell (dust beside a cell
  // does NOT count here — dust only weak-powers, never re-feeds the net)
  let m = 0;
  try {
    for (const d of FACE_D) {
      const v = rsEmitInto((x | 0) + d[0], (y | 0) + d[1], (z | 0) + d[2], x, y, z);
      if (v > m) { m = v; if (m >= 15) break; }
    }
  } catch (e) {}
  return m;
}
function rsBlockWeak(x, y, z) {
  // weak power: strong emission plus adjacent live dust (dust turns off
  // torches and opens doors, but never re-feeds the dust net — the dust
  // fixpoint only reads rsBlockLevel, so no feedback loop)
  let m = rsBlockLevel(x, y, z);
  if (m >= 15) return 15;
  try {
    const g = game(), w = g.world;
    for (const d of FACE_D) {
      try {
        const st = w.getState((x | 0) + d[0], (y | 0) + d[1], (z | 0) + d[2]);
        const bd = defOf(st);
        if (bd && bd.name === "redstone_wire") {
          const v = (stProp(st, "power") | 0) || 0;
          if (v > m) { m = v; if (m >= 15) break; }
        }
      } catch (e) {}
    }
  } catch (e) {}
  return m;
}
function rsDustLevel(x, y, z) {
  try { return (stProp(game().world.getState(x | 0, y | 0, z | 0), "power") | 0) || 0; }
  catch (e) { return 0; }
}
function rsDustWant(x, y, z) {
  // JE conduction: neighbor emission at full strength, connected dust at
  // level minus 1. Same-level, one-up and one-down neighbors conduct.
  let m = rsBlockLevel(x, y, z);
  if (m >= 15) return 15;
  try {
    const g = game(), w = g.world;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const dd of dirs) {
      for (let dy = -1; dy <= 1; dy++) {
        let st = 0;
        try { st = w.getState((x | 0) + dd[0], (y | 0) + dy, (z | 0) + dd[1]); } catch (e) { continue; }
        const bd = defOf(st);
        if (bd && bd.name === "redstone_wire") {
          const v = ((stProp(st, "power") | 0) || 0) - 1;
          if (v > m) { m = v; if (m >= 15) return 15; }
        }
      }
    }
  } catch (e) {}
  return Math.max(0, Math.min(15, m));
}
function rsWireConn(x, y, z) {
  // connection rendering per arm (JE: side to same-level dust or up a
  // step, up the face of a solid block carrying dust, else none)
  const out = {};
  try {
    const g = game(), w = g.world;
    const dirs = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };
    for (const k in dirs) {
      const dd = dirs[k];
      const nx = (x | 0) + dd[0], nz = (z | 0) + dd[1];
      let v = "none";
      try {
        const same = w.getState(nx, y | 0, nz);
        const sd = defOf(same);
        if (sd && sd.name === "redstone_wire") v = "side";
        else if (rsSolid(nx, y | 0, nz)) {
          const up = w.getState(nx, (y | 0) + 1, nz);
          const ud = defOf(up);
          if (ud && ud.name === "redstone_wire") v = "up";
        } else {
          const up = w.getState(nx, (y | 0) + 1, nz);
          const ud = defOf(up);
          if (ud && ud.name === "redstone_wire") v = "side";
          else {
            const dn = w.getState(nx, (y | 0) - 1, nz);
            const dd2 = defOf(dn);
            if (dd2 && dd2.name === "redstone_wire") v = "side";
          }
        }
      } catch (e) {}
      out[k] = v;
    }
  } catch (e) {}
  return out;
}
function rsSupported(w) {
  // wire + floor components + detectors + note blocks need a solid floor;
  // wall torches hang on the block behind them (lamps/tnt sit free)
  try {
    if (w.kind === "redstone_wire" || w.kind === "repeater" || w.kind === "comparator" ||
        w.kind === "redstone_torch" || w.kind === "daylight_detector" || w.kind === "note_block")
      return rsSolid(w.x, w.y - 1, w.z);
    if (w.kind === "redstone_wall_torch") {
      const st = game().world.getState(w.x, w.y, w.z);
      const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
      return rsSolid(w.x - v[0], w.y, w.z - v[2]);
    }
    return true;
  } catch (e) { return true; }
}
function rsPop(w) {
  // support gone (vanilla): drop the item and clear the cell
  try {
    const g = game(), wld = g.world;
    const old = wld.getState(w.x, w.y, w.z);
    const ids = dropIdForState(old);
    rsWrite(w.x, w.y, w.z, 0);
    if (ids && ids.length) for (const id of ids) {
      try { spawnItemEntity(w.x + 0.5, w.y + 0.5, w.z + 0.5, id, 1); } catch (e) {}
    }
    rsTrack(w.x, w.y, w.z, 0);
  } catch (e) {}
}
function rsContainerLevel(x, y, z) {
  // comparator readout: -1 = no container behind, else 0-15 by fullness
  try {
    let slots = 0, fill = 0;
    const t = getTile(x | 0, y | 0, z | 0);
    if (t && t.items) {
      slots = t.items.length;
      for (const s of t.items) {
        if (s && s.id) fill += Math.min(1, ((s.count | 0) || 1) / Math.max(1, maxStackOf(s.id)));
      }
    } else {
      slots = containerSlots(blockNameAt(x, y, z)) | 0;
      if (!slots) return -1;
    }
    if (!slots) return -1;
    if (fill <= 0) return 0;
    return Math.min(15, Math.max(1, Math.floor(fill / slots * 15)));
  } catch (e) { return -1; }
}
function rsSideSig(x, y, z, dx, dz) {
  // max signal readable from the cell at (x+dx, z+dz): live dust there,
  // emission pushed into it, or a source sitting in it (a lever beside a
  // repeater locks it directly — vanilla)
  try {
    const sx = (x | 0) + dx, sz = (z | 0) + dz;
    let m = rsEmitInto(sx, y | 0, sz, x | 0, y | 0, z | 0);
    try {
      const st = game().world.getState(sx, y | 0, sz);
      const d = defOf(st);
      if (d && d.name === "redstone_wire") {
        const dl = (stProp(st, "power") | 0) || 0;
        if (dl > m) m = dl;
      }
    } catch (e) {}
    const b = rsBlockLevel(sx, y | 0, sz);
    return b > m ? b : m;
  } catch (e) { return 0; }
}
function rsSchedule(x, y, z, delay) {
  try {
    SV.rsQueue.push({ x: x | 0, y: y | 0, z: z | 0, until: (SV.tickN | 0) + Math.max(1, delay | 0) });
  } catch (e) {}
}
function rsTorchWant(w) {
  // ON unless the attachment block is powered (weak power counts — dust
  // beside the support turns the torch off, vanilla). Burnt-out stays off.
  try {
    const k = rsKey(w.x, w.y, w.z);
    if (SV.torchOut.has(k)) return false;
    if (w.kind === "redstone_wall_torch") {
      const st = game().world.getState(w.x, w.y, w.z);
      const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
      return rsBlockWeak(w.x - v[0], w.y, w.z - v[2]) <= 0;
    }
    return rsBlockWeak(w.x, w.y - 1, w.z) <= 0;
  } catch (e) { return false; }
}
function rsTorchLit(w) {
  try { return stProp(game().world.getState(w.x, w.y, w.z), "lit") === "true"; }
  catch (e) { return false; }
}
function rsNoteToggle(w, rec) {
  try {
    const st = game().world.getState(w.x, w.y, w.z);
    const d = defOf(st);
    if (!d || d.name !== w.kind) return;
    if (w.kind === "redstone_torch" || w.kind === "redstone_wall_torch") {
      const k = rsKey(w.x, w.y, w.z);
      const arr = SV.torchTog.get(k) || [];
      arr.push(SV.tickN | 0);
      while (arr.length && arr[0] <= ((SV.tickN | 0) - 60)) arr.shift();
      SV.torchTog.set(k, arr);
      if (arr.length > 8) { // burnout (vanilla 8 toggles / 60 ticks)
        try { SV.torchOut.add(k); } catch (e) {}
        if (rsTorchLit(w)) rsWrite(w.x, w.y, w.z, stWith(st, "lit", "false"));
        return;
      }
    }
    rsWrite(w.x, w.y, w.z, stWith(st, rec.prop, rec.val));
  } catch (e) {}
}
function rsFire(q) {
  // scheduled component update: re-read the world first (inputs may have
  // moved on while the delay ran), apply only on a real change
  try {
    const g = game(), wld = g.world;
    const st = wld.getState(q.x | 0, q.y | 0, q.z | 0);
    const d = defOf(st);
    if (!d || d.id === 0) return;
    const nm = d.name, k = rsKey(q.x, q.y, q.z);
    // v1.13: piston power edges + observer pulse-off ride the component queue
    if (nm === "piston" || nm === "sticky_piston") { try { pistFire(q.x | 0, q.y | 0, q.z | 0); } catch (e2) {} return; }
    if (nm === "observer") { try { pistObsOff(q.x | 0, q.y | 0, q.z | 0); } catch (e2) {} return; }
    if ((nm === "redstone_torch" || nm === "redstone_wall_torch") && !SV.torchOut.has(k)) {
      const want = rsTorchWant({ x: q.x | 0, y: q.y | 0, z: q.z | 0, kind: nm });
      const lit = stProp(st, "lit") === "true";
      if (want !== lit) rsNoteToggle({ x: q.x | 0, y: q.y | 0, z: q.z | 0, kind: nm }, { prop: "lit", val: want ? "true" : "false" });
      return;
    }
    if (nm === "repeater") {
      const r = rsRepeaterOut(q.x | 0, q.y | 0, q.z | 0);
      const pw = stProp(st, "powered") === "true";
      const lk = stProp(st, "locked") === "true";
      if (r.lock !== lk) { rsWrite(q.x, q.y, q.z, stWith(st, "locked", r.lock ? "true" : "false")); return; }
      if (!r.lock && (r.on !== pw)) rsWrite(q.x, q.y, q.z, stWith(st, "powered", r.on ? "true" : "false"));
      return;
    }
    if (nm === "comparator") {
      const r = rsComparatorOut(q.x | 0, q.y | 0, q.z | 0);
      const pw = stProp(st, "powered") === "true";
      if ((r.lvl > 0) !== pw) rsWrite(q.x, q.y, q.z, stWith(st, "powered", r.lvl > 0 ? "true" : "false"));
      try {
        if ((SV.compLvl.get(k) | 0) !== (r.lvl | 0)) SV.compLvl.set(k, r.lvl | 0);
      } catch (e) {}
      return;
    }
  } catch (e) {}
}
function rsRepeaterOut(x, y, z) {
  // {on, lock} from the current world (input behind, lock from the sides)
  try {
    const st = game().world.getState(x | 0, y | 0, z | 0);
    const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
    const bx = (x | 0) - v[0], bz = (z | 0) - v[2];
    let input = rsBlockLevel(bx, y | 0, bz);
    // a source sitting right behind the repeater feeds it directly
    try {
      const be = rsEmitInto(bx, y | 0, bz, x | 0, y | 0, z | 0);
      if (be > input) input = be;
    } catch (e) {}
    try {
      const bst = game().world.getState(bx, y | 0, bz);
      const bd = defOf(bst);
      if (bd && bd.name === "redstone_wire") {
        const dl = (stProp(bst, "power") | 0) || 0;
        if (dl > input) input = dl;
      }
    } catch (e) {}
    const lx = v[2], lz = -v[0];
    const lock = rsSideSig(x, y, z, lx, lz) > 0 || rsSideSig(x, y, z, -lx, -lz) > 0;
    return { on: input > 0, lock };
  } catch (e) { return { on: false, lock: false }; }
}
function rsComparatorOut(x, y, z) {
  // {lvl}: container fullness (or back signal) vs the strongest side
  try {
    const st = game().world.getState(x | 0, y | 0, z | 0);
    const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
    const mode = stProp(st, "mode");
    const bx = (x | 0) - v[0], bz = (z | 0) - v[2];
    let back = rsContainerLevel(bx, y | 0, bz);
    if (back < 0) {
      back = rsBlockLevel(bx, y | 0, bz);
      // a source sitting right behind the comparator feeds it directly
      try {
        const be = rsEmitInto(bx, y | 0, bz, x | 0, y | 0, z | 0);
        if (be > back) back = be;
      } catch (e) {}
      try {
        const bst = game().world.getState(bx, y | 0, bz);
        const bd = defOf(bst);
        if (bd && bd.name === "redstone_wire") {
          const dl = (stProp(bst, "power") | 0) || 0;
          if (dl > back) back = dl;
        }
      } catch (e) {}
    }
    const lx = v[2], lz = -v[0];
    const side = Math.max(rsSideSig(x, y, z, lx, lz), rsSideSig(x, y, z, -lx, -lz));
    const lvl = mode === "subtract" ? Math.max(0, back - side) : (side > back ? 0 : back);
    return { lvl: Math.max(0, Math.min(15, lvl | 0)) };
  } catch (e) { return { lvl: 0 }; }
}
function rsPropagate() {
  // one full pass: dust fixpoint, then components + consumers, then pops.
  // Writes only land on real change, so the loop always terminates.
  try {
    if (!SV.wires.size) return;
    const g = game(), p = g.player;
    let list = Array.from(SV.wires.values());
    if (list.length > 600) {
      const px = p ? p.x : 0, pz = p ? p.z : 0;
      list.sort((a, b) => ((a.x - px) * (a.x - px) + (a.z - pz) * (a.z - pz)) -
        ((b.x - px) * (b.x - px) + (b.z - pz) * (b.z - pz)));
      list = list.slice(0, 600);
    }
    for (let round = 0; round < 24; round++) {
      let changed = false;
      for (const w of list) {
        if (w.kind !== "redstone_wire") continue;
        try {
          const st = g.world.getState(w.x, w.y, w.z);
          const d = defOf(st);
          if (!d || d.name !== "redstone_wire") continue;
          const want = rsDustWant(w.x, w.y, w.z);
          const cur = (stProp(st, "power") | 0) || 0;
          const conn = rsWireConn(w.x, w.y, w.z);
          const curC = { north: stProp(st, "north"), south: stProp(st, "south"), east: stProp(st, "east"), west: stProp(st, "west") };
          if (want !== cur || conn.north !== curC.north || conn.south !== curC.south ||
              conn.east !== curC.east || conn.west !== curC.west) {
            let ns = stWith(st, "power", String(want));
            for (const k of ["north", "south", "east", "west"])
              if (conn[k] !== curC[k]) ns = stWith(ns, k, conn[k]);
            rsWrite(w.x, w.y, w.z, ns);
            changed = true;
          }
        } catch (e) {}
      }
      if (!changed) break;
    }
    for (const w of list) {
      try {
        const st = g.world.getState(w.x, w.y, w.z);
        const d = defOf(st);
        if (!d || d.name !== w.kind) continue;
        if (w.kind === "redstone_torch" || w.kind === "redstone_wall_torch") {
          const k = rsKey(w.x, w.y, w.z);
          if (SV.torchOut.has(k)) { if (rsTorchLit(w)) rsWrite(w.x, w.y, w.z, stWith(st, "lit", "false")); continue; }
          const want = rsTorchWant(w), lit = stProp(st, "lit") === "true";
          if (want !== lit) rsSchedule(w.x, w.y, w.z, 2);
        } else if (w.kind === "repeater") {
          const r = rsRepeaterOut(w.x, w.y, w.z);
          const pw = stProp(st, "powered") === "true", lk = stProp(st, "locked") === "true";
          if (r.lock !== lk) rsWrite(w.x, w.y, w.z, stWith(st, "locked", r.lock ? "true" : "false"));
          else if (!r.lock && (r.on !== pw)) {
            const dl = stProp(st, "delay") || "1";
            rsSchedule(w.x, w.y, w.z, 4 * Math.max(1, Math.min(4, parseInt(dl, 10) || 1)));
          }
        } else if (w.kind === "comparator") {
          const r = rsComparatorOut(w.x, w.y, w.z);
          const pw = stProp(st, "powered") === "true";
          const k = rsKey(w.x, w.y, w.z);
          // prime the runtime level map on first sight (entry restore has
          // the state bit but the map starts empty every session)
          if (!SV.compLvl.has(k)) { try { SV.compLvl.set(k, r.lvl | 0); } catch (e) {} }
          if ((r.lvl > 0) !== pw || (SV.compLvl.get(k) | 0) !== (r.lvl | 0)) rsSchedule(w.x, w.y, w.z, 2);
        } else if (w.kind === "piston" || w.kind === "sticky_piston") {
          // v1.13: power vs arm state edge → schedule the block event (1-tick delay + dropout)
          try {
            const st = g.world.getState(w.x, w.y, w.z);
            const d = defOf(st);
            if (d && (d.name === "piston" || d.name === "sticky_piston") && !pistBusy(w.x, w.y, w.z)) {
              const ext = stProp(st, "extended") === "true";
              if (pistonPowered(w.x, w.y, w.z) !== ext) pistSchedule(w.x, w.y, w.z);
            }
          } catch (e) {}
        } else if (w.kind === "observer") {
          // v1.13: powered with no live pulse (moved/stale entry) → schedule off (self-heal)
          try {
            const st = g.world.getState(w.x, w.y, w.z);
            if (defOf(st) && defOf(st).name === "observer" && stProp(st, "powered") === "true") {
              const k = rsKey(w.x, w.y, w.z);
              const until = SV.obsPulse.get(k);
              if (until == null || (SV.tickN | 0) >= (until | 0)) rsSchedule(w.x, w.y, w.z, 1);
            }
          } catch (e) {}
        } else if (w.kind === "redstone_lamp") {
          const want = redstonePowered(w.x, w.y, w.z);
          const lit = stProp(st, "lit") === "true";
          if (want !== lit) rsWrite(w.x, w.y, w.z, stWith(st, "lit", want ? "true" : "false"));
        } else if (w.kind === "daylight_detector") {
          const want = detectorPower(w.x, w.y, w.z, st);
          const cur = (stProp(st, "power") | 0) || 0;
          if (want !== cur) rsWrite(w.x, w.y, w.z, stWith(st, "power", String(want)));
        } else if (w.kind === "tnt") {
          if (redstonePowered(w.x, w.y, w.z)) {
            rsWrite(w.x, w.y, w.z, 0);
            try { spawnPrimedTNT(w.x + 0.5, w.y, w.z + 0.5); } catch (e) {}
            try { g.sound.play("entity.tnt.primed"); } catch (e) {}
          }
        } else if (w.kind === "note_block") {
          const on = redstonePowered(w.x, w.y, w.z);
          const k = rsKey(w.x, w.y, w.z);
          // prime the edge tracker on first sight (no phantom note on entry)
          if (!SV.notePrev.has(k)) {
            try { SV.notePrev.set(k, on); } catch (e) {}
            const pw0 = stProp(st, "powered") === "true";
            if (on !== pw0) rsWrite(w.x, w.y, w.z, stWith(st, "powered", on ? "true" : "false"));
            continue;
          }
          const was = !!SV.notePrev.get(k);
          if (on !== was) {
            try { SV.notePrev.set(k, on); } catch (e) {}
            const pw = stProp(st, "powered") === "true";
            if (on !== pw) rsWrite(w.x, w.y, w.z, stWith(st, "powered", on ? "true" : "false"));
            if (on && !was) {
              try { g.sound.play("block.note_block.harp"); } catch (e) {}
              try { g.particles.note(w.x + 0.5, w.y + 1.2, w.z + 0.5); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }
    for (const w of list) {
      try {
        const st = g.world.getState(w.x, w.y, w.z);
        const d = defOf(st);
        if (!d || d.name !== w.kind) continue;
        if (!rsSupported(w)) rsPop(w);
      } catch (e) {}
    }
  } catch (e) {}
}
function rescanWiresFromOverrides() {
  // Rebuild the redstone watch-set from saved player edits (blocks persist
  // as world diffs; SV.wires is runtime-only and starts empty every entry
  // because chunk streaming bypasses the setState wrapper). Same pattern
  // as rescanCropsFromOverrides. Overrides carry state ids, so no world
  // reads are needed — unstreamed chunks register fine.
  try {
    const sp = SP();
    if (!sp) return 0;
    const ov = ((sp.dim | 0) === -1 ? sp.nether : ((sp.dim | 0) === 1 ? sp.end : sp.overrides));
    if (!ov) return 0;
    let n = 0;
    for (const k in ov) {
      try {
        const c = String(k).split(",");
        if (c.length !== 3) continue;
        const d = defOf(ov[k] | 0);
        if (!d) continue;
        const nm = d.name;
        if (nm === "redstone_wire" || nm === "redstone_torch" || nm === "redstone_wall_torch" ||
            nm === "repeater" || nm === "comparator" || nm === "daylight_detector" ||
            nm === "redstone_lamp" || nm === "note_block" || nm === "tnt" ||
            nm === "piston" || nm === "sticky_piston" || nm === "observer") {
          const x = c[0] | 0, y = c[1] | 0, z = c[2] | 0;
          const kk = rsKey(x, y, z);
          if (!SV.wires.has(kk)) { SV.wires.set(kk, { x, y, z, kind: nm }); n++; }
          else SV.wires.get(kk).kind = nm;
          if (nm === "observer") SV.obsOn = true;
          SV.rsDirty.add(kk);
        }
      } catch (e) {}
    }
    return n;
  } catch (e) { return 0; }
}
function rsTick() {
  // scheduled component updates, then a propagate pass when dirty (block
  // changes) or every 10 ticks (daylight drift on detectors, plates)
  try {
    const now = SV.tickN | 0;
    if (SV.rsQueue.length) {
      const keep = [];
      for (const q of SV.rsQueue) {
        if ((q.until | 0) > now) { keep.push(q); continue; }
        try { rsFire(q); } catch (e) {}
      }
      SV.rsQueue = keep;
    }
    SV.rsAcc = (SV.rsAcc | 0) + 1;
    if (SV.rsDirty.size || (SV.wires.size && SV.rsAcc >= 10)) {
      SV.rsAcc = 0;
      SV.rsDirty.clear();
      rsPropagate();
    }
  } catch (e) {}
}

/* ---- v1.13 pistons + observers (server half; the engine owns animation) ----
 * The engine's Pistons class already slides moving_piston carriers, refuses
 * tile entities, caps at 12 and renders arms (game.pistons.tick runs in the
 * engine loop; block events arrive via on_block_action like server packets).
 * Survival is the server: edge-trigger power→event for piston bases (1-tick
 * delay + dropout on removal), 2-tick observer pulses on neighbor changes,
 * watch-set reconciliation + popped-fragile drops after each move, and entry
 * repair of moving_piston ghosts (autosaves can land mid-animation).
 */
// engine mobility tables, mirrored verbatim from src/mc1152/js/game/pistons.js
// (old 1.12 names included: the engine classifies with these, so the settle
// drops must match the engine's destroy decision, quirks and all)
const PIST_DESTROY = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava', 'leaves', 'leaves2', 'sapling', 'tallgrass', 'deadbush', 'yellow_flower',
  'red_flower', 'brown_mushroom', 'red_mushroom', 'wheat', 'reeds', 'pumpkin_stem', 'melon_stem', 'waterlily', 'nether_wart',
  'cocoa', 'carrots', 'potatoes', 'beetroots', 'vine', 'double_plant', 'chorus_plant', 'chorus_flower', 'torch', 'redstone_wire',
  'lever', 'unlit_redstone_torch', 'redstone_torch', 'stone_button', 'wooden_button', 'unpowered_repeater', 'powered_repeater',
  'unpowered_comparator', 'powered_comparator', 'tripwire_hook', 'tripwire', 'golden_rail', 'detector_rail', 'rail',
  'activator_rail', 'flower_pot', 'skull', 'ladder', 'end_rod', 'stone_pressure_plate', 'wooden_pressure_plate',
  'light_weighted_pressure_plate', 'heavy_weighted_pressure_plate', 'wooden_door', 'iron_door', 'spruce_door', 'birch_door',
  'jungle_door', 'acacia_door', 'dark_oak_door', 'bed', 'snow_layer', 'cactus', 'pumpkin', 'lit_pumpkin', 'melon_block',
  'dragon_egg', 'cake', 'web', 'fire', 'structure_void',
]);
const PIST_BLOCK = new Set(['obsidian', 'barrier', 'nether_portal', 'piston_head', 'moving_piston', 'end_portal', 'end_gateway']);
function pistMobility(n) {
  if (!n) return "normal";
  if (n.endsWith("_shulker_box") || PIST_DESTROY.has(n)) return "destroy";
  if (PIST_BLOCK.has(n)) return "block";
  if (n.endsWith("_glazed_terracotta")) return "push_only";
  return "normal";
}
const PIST_FACE = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const PIST_FIDX = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const PIST_DIRV = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const PIST_OPP = [1, 0, 3, 2, 5, 4];
const PIST_ENUM = { north: 0, east: 1, south: 2, west: 3, up: 4, down: 5 }; // registry enum order (blocks.json)
function pistonPowered(x, y, z) {
  // direct power, or QC-lite: weak power in the cell above (vanilla powers
  // pistons through the block above them — dust/buttons on top work)
  try { if (redstonePowered(x | 0, y | 0, z | 0)) return true; } catch (e) {}
  try { if (rsBlockWeak(x | 0, (y | 0) + 1, z | 0) > 0) return true; } catch (e) {}
  return false;
}
function pistBusy(x, y, z) {
  // base cell currently a resolving retract tile (engine clears it in ~2 ticks)
  try {
    const g = game();
    const d = defOf(g.world.getState(x | 0, y | 0, z | 0));
    if (!d || d.name !== "moving_piston") return false;
    return !!(g.pistons && g.pistons.moving && g.pistons.moving.has((x | 0) + "," + (y | 0) + "," + (z | 0)));
  } catch (e) { return false; }
}
function pistSchedule(x, y, z) {
  // one pending event per cell (the fire re-reads power, so dupes are pure spam)
  try {
    for (const q of SV.rsQueue) if ((q.x | 0) === (x | 0) && (q.y | 0) === (y | 0) && (q.z | 0) === (z | 0)) return;
    rsSchedule(x | 0, y | 0, z | 0, 1);
  } catch (e) {}
}
function pistFire(x, y, z) {
  try {
    const g = game(), w = g.world;
    const st = w.getState(x | 0, y | 0, z | 0);
    const d = defOf(st);
    if (!d) return;
    const nm = d.name;
    if (nm !== "piston" && nm !== "sticky_piston") return;
    if (pistBusy(x | 0, y | 0, z | 0)) return;
    const ext = stProp(st, "extended") === "true";
    const want = pistonPowered(x | 0, y | 0, z | 0);
    if (want === ext) return; // dropout: power left before the delay elapsed
    const face = stProp(st, "facing");
    const fv = PIST_FIDX[face];
    if (fv == null) return;
    const sticky = nm === "sticky_piston";
    const v = PIST_FACE[face] || PIST_FACE.north;
    SV.pistonMove = { writes: {} };
    try {
      // same packet shape as a server block action: engine animates + sounds
      g.on_block_action({ blockId: d.id, location: { x: x | 0, y: y | 0, z: z | 0 }, byte1: want ? 0 : 1, byte2: fv });
    } finally {
      try {
        const mv = SV.pistonMove;
        SV.pistonMove = null;
        if (mv && mv.writes) {
          SV.pistJ.push({ face, dx: v[0], dy: v[1], dz: v[2], ext: want, sticky, px: x | 0, py: y | 0, pz: z | 0, writes: mv.writes });
          if (SV.pistJ.length > 8) SV.pistJ.splice(0, SV.pistJ.length - 8);
        }
      } catch (e2) {}
    }
    SV.pistSettleAt = (SV.tickN | 0) + 4;
  } catch (e) {}
}
function obsTrigger(x, y, z) {
  try {
    const g = game();
    const st = g.world.getState(x | 0, y | 0, z | 0);
    const d = defOf(st);
    if (!d || d.name !== "observer") return;
    if (stProp(st, "powered") === "true") return; // pulse already running (debounce)
    rsWrite(x | 0, y | 0, z | 0, stWith(st, "powered", "true"));
    SV.obsPulse.set(rsKey(x, y, z), (SV.tickN | 0) + 2);
    try { g.sound.play("block.stone_button.click_on"); } catch (e) {}
  } catch (e) {}
}
function pistObsOff(x, y, z) {
  try {
    const g = game();
    const k = rsKey(x, y, z);
    const st = g.world.getState(x | 0, y | 0, z | 0);
    const d = defOf(st);
    if (!d || d.name !== "observer") { try { SV.obsPulse.delete(k); } catch (e) {} return; }
    if (stProp(st, "powered") !== "true") { try { SV.obsPulse.delete(k); } catch (e) {} return; }
    const until = SV.obsPulse.get(k);
    if (until != null && (SV.tickN | 0) < (until | 0)) { rsSchedule(x | 0, y | 0, z | 0, 1); return; }
    rsWrite(x | 0, y | 0, z | 0, stWith(st, "powered", "false"));
    try { SV.obsPulse.delete(k); } catch (e) {}
    try { g.sound.play("block.stone_button.click_off"); } catch (e) {}
  } catch (e) {}
}
function pistNotifyObservers(x, y, z, live) {
  // pulse every live observer whose front face watches (x,y,z). The resolve
  // writes already pulse through the wrapper's live path, so the settle pass
  // skips any cell+state the live path notified within the last 10 ticks
  // (keyed by state so real re-changes, e.g. observer-clock off-edges, pass).
  try {
    if (!SV.obsOn || !SV.on) return;
    const g = game();
    let cur = -1;
    try { cur = g.world.getState(x | 0, y | 0, z | 0); } catch (e) { return; }
    const seenK = (x | 0) + "," + (y | 0) + "," + (z | 0) + ">" + (cur | 0);
    if (!live) {
      try {
        const t = SV.obsSeen.get(seenK);
        if (t != null && ((SV.tickN | 0) - t) < 10) return;
      } catch (e) {}
    }
    let pulsed = false;
    for (let f = 0; f < 6; f++) {
      const nx = (x | 0) + FACE_D[f][0], ny = (y | 0) + FACE_D[f][1], nz = (z | 0) + FACE_D[f][2];
      let ost = -1;
      try { ost = g.world.getState(nx, ny, nz); } catch (e) { continue; }
      const od = defOf(ost);
      if (!od || od.name !== "observer") continue;
      const fv = RS_FACE_VEC[stProp(ost, "facing")] || RS_FACE_VEC.north;
      if (nx + fv[0] === (x | 0) && ny + fv[1] === (y | 0) && nz + fv[2] === (z | 0)) {
        try { obsTrigger(nx, ny, nz); pulsed = true; } catch (e) {}
      }
    }
    if (live && pulsed) {
      try {
        SV.obsSeen.set(seenK, SV.tickN | 0);
        if (SV.obsSeen.size > 60) {
          const ks = Array.from(SV.obsSeen.keys());
          for (let i = 0; i < ks.length - 60; i++) SV.obsSeen.delete(ks[i]);
        }
      } catch (e) {}
    }
  } catch (e) {}
}
function pistPopCheck(x, y, z) {
  // riding attachables the slide left floating (the engine only pops in-line
  // fragiles): pop with drops like a support loss
  try {
    const g = game();
    const st = g.world.getState(x | 0, y | 0, z | 0);
    const d = defOf(st);
    if (!d || d.id === 0) return;
    const nm = d.name;
    if (nm === "redstone_wire" || nm === "repeater" || nm === "comparator" ||
        nm === "redstone_torch" || nm === "daylight_detector" || nm === "note_block") {
      try {
        const w = { x: x | 0, y: y | 0, z: z | 0, kind: nm };
        if (!rsSupported(w)) rsPop(w);
      } catch (e) {}
      return;
    }
    if (nm !== "torch" && nm !== "redstone_wall_torch" && nm !== "lever" &&
        nm.slice(-7) !== "_button" && nm !== "ladder") return;
    let ok = true;
    if (nm === "torch") ok = rsSolid(x, y - 1, z);
    else if (nm === "redstone_wall_torch" || nm === "ladder") {
      const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
      ok = rsSolid((x | 0) - v[0], y | 0, (z | 0) - v[2]);
    } else {
      const fc = stProp(st, "face") || "floor";
      if (fc === "floor") ok = rsSolid(x, y - 1, z);
      else if (fc === "ceiling") ok = rsSolid(x, y + 1, z);
      else {
        const v = RS_FACE_VEC[stProp(st, "facing")] || RS_FACE_VEC.north;
        ok = rsSolid((x | 0) - v[0], y | 0, (z | 0) - v[2]);
      }
    }
    if (!ok) {
      const ids = dropIdForState(st);
      rsWrite(x | 0, y | 0, z | 0, 0);
      if (ids && ids.length) for (const id of ids) {
        try { spawnItemEntity((x | 0) + 0.5, (y | 0) + 0.5, (z | 0) + 0.5, id, 1); } catch (e) {}
      }
    }
  } catch (e) {}
}
function pistHeadState(face, sticky) {
  try {
    const L = blkLayout("piston_head");
    if (!L) return 0;
    const fi = PIST_ENUM[face];
    if (fi == null) return 0;
    return L.min + fi * 4 + 1 * 2 + (sticky ? 1 : 0);
  } catch (e) { return 0; }
}
function pistBaseState(name, face) {
  try {
    const L = blkLayout(name);
    if (!L) return 0;
    const fi = PIST_ENUM[face];
    if (fi == null) return 0;
    return L.min + 1 * 6 + fi;
  } catch (e) { return 0; }
}
function pistSettle() {
  // drops for engine-destroyed fragiles, pops for riding attachables, and
  // vanilla-style observer notification on truly-changed cells
  try {
    if (!SV.pistJ.length) return;
    if ((SV.tickN | 0) < (SV.pistSettleAt | 0)) return;
    const g = game(), w = g.world;
    const movingActive = !!(g.pistons && g.pistons.moving && g.pistons.moving.size);
    for (const ev of SV.pistJ) {
      const wr = ev.writes || {};
      for (const k in wr) {
        try {
          const c = k.split(",");
          if (c.length !== 3) continue;
          const cx = +c[0], cy = +c[1], cz = +c[2];
          const od = defOf(wr[k] | 0);
          if (!od || pistMobility(od.name) !== "destroy") continue; // vacated source, not a pop
          if ((w.getState(cx, cy, cz) | 0) === (wr[k] | 0)) continue;
          // destroyed: reads air — or the head/moving arm when the fragile
          // stood in the head cell (engine reoccupies it in the same event)
          let gone = false;
          try {
            const cur = w.getState(cx, cy, cz) | 0;
            if (cur === 0) gone = true;
            else { const cd = defOf(cur); gone = !!(cd && (cd.name === "piston_head" || cd.name === "moving_piston")); }
          } catch (e) {}
          if (!gone) continue;
          const ids = dropIdForState(wr[k] | 0);
          if (ids && ids.length) for (const id of ids) {
            try { spawnItemEntity(cx + 0.5, cy + 0.5, cz + 0.5, id, 1); } catch (e) {}
          }
        } catch (e) {}
      }
    }
    const seen = {};
    for (const ev of SV.pistJ) {
      const wr = ev.writes || {};
      for (const k in wr) {
        const c = k.split(",");
        if (c.length !== 3) continue;
        for (const dd of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const kk = (+c[0] + dd[0]) + "," + (+c[1] + dd[1]) + "," + (+c[2] + dd[2]);
          if (seen[kk]) continue;
          seen[kk] = 1;
          try { pistPopCheck(+c[0] + dd[0], +c[1] + dd[1], +c[2] + dd[2]); } catch (e) {}
        }
      }
    }
    for (const ev of SV.pistJ) {
      const wr = ev.writes || {};
      for (const k in wr) {
        try {
          const c = k.split(",");
          if (c.length !== 3) continue;
          const cx = +c[0], cy = +c[1], cz = +c[2];
          let cur = -1;
          try { cur = w.getState(cx, cy, cz); } catch (e) { continue; }
          if ((cur | 0) === (wr[k] | 0)) continue;
          if ((cur | 0) !== 0) {
            try { const dd = defOf(cur); if (dd && dd.name === "moving_piston") continue; } catch (e) {}
          }
          pistNotifyObservers(cx, cy, cz, false);
        } catch (e) {}
      }
    }
    if (!movingActive) {
      SV.pistJ.length = 0;
      try {
        const sp = SP();
        if (sp && sp.id) {
          const rec = loadWorldRecSv(sp.id);
          if (rec) { rec.pistJ = []; saveWorldRecSv(sp.id, rec); }
        }
      } catch (e) {}
    }
  } catch (e) {}
}
function pistRepairTick() {
  // entry repair: a save that landed mid-animation left moving_piston cells
  // with no live tiles. Live tiles (in game.pistons.moving) resolve on their
  // own; only orphaned ghosts are reconstructed from the journal.
  try {
    if (!SV.pistJ.length) return;
    const g = game();
    if (!g || !g.world) return;
    const mv = (g.pistons && g.pistons.moving) || null;
    for (const ev of SV.pistJ) {
      const wr = ev.writes || {};
      const d = [(ev.dx | 0), (ev.dy | 0), (ev.dz | 0)];
      const md = ev.ext ? d : [-d[0], -d[1], -d[2]];
      for (const k in wr) {
        let cur = -1;
        try {
          const c = k.split(",");
          cur = g.world.getState(+c[0], +c[1], +c[2]);
        } catch (e) { continue; } // chunk not streamed yet: retry next tick
        let nm = "";
        try { const dd = defOf(cur); nm = dd ? dd.name : ""; } catch (e) {}
        if (nm !== "moving_piston") continue;
        if (mv && mv.has(k)) continue; // live tile resolves itself
        let final = 0;
        try {
          const c = k.split(",");
          const cx = +c[0], cy = +c[1], cz = +c[2];
          if (ev.ext && cx === ev.px + d[0] && cy === ev.py + d[1] && cz === ev.pz + d[2]) {
            final = pistHeadState(ev.face, !!ev.sticky); // extend head cell
          } else if (!ev.ext && cx === ev.px && cy === ev.py && cz === ev.pz) {
            final = pistBaseState(ev.sticky ? "sticky_piston" : "piston", ev.face); // retract base
          } else {
            const sk = (cx - md[0]) + "," + (cy - md[1]) + "," + (cz - md[2]);
            final = wr[sk] != null ? (wr[sk] | 0) : 0;
          }
        } catch (e) { final = 0; }
        try { SV.grief = true; g.world.setState(+k.split(",")[0], +k.split(",")[1], +k.split(",")[2], final | 0); }
        finally { try { SV.grief = false; } catch (e) {} }
      }
    }
  } catch (e) {}
}
function pistWatchdog() {
  // hidden tabs stall the engine loop (rAF): snap tiles whose progress froze
  try {
    const g = game();
    const mv = g.pistons && g.pistons.moving;
    if (!mv || !mv.size) { if (SV.pistProg.size) SV.pistProg.clear(); return; }
    const now = SV.tickN | 0;
    for (const entry of mv) {
      const k = entry[0], t = entry[1];
      const rec = SV.pistProg.get(k);
      if (!rec) SV.pistProg.set(k, { prog: t.progress, at: now });
      else if (t.progress !== rec.prog) { rec.prog = t.progress; rec.at = now; }
      else if (now - rec.at > 30) {
        try { g.pistons._clearTile(t); } catch (e) {}
        try { SV.pistProg.delete(k); } catch (e) {}
      }
    }
    try { for (const k of Array.from(SV.pistProg.keys())) if (!mv.has(k)) SV.pistProg.delete(k); } catch (e) {}
  } catch (e) {}
}
function pistShove() {
  // vanilla carries entities with the slide; the engine only shoves the
  // player, so translate our mobs/items/orbs out along the move dir too
  // (their own physics clamps the rest via the moving colliders)
  try {
    const g = game();
    const mv = g.pistons && g.pistons.moving;
    if (!mv || !mv.size) return;
    for (const t of mv.values()) {
      const dir = t.extending ? t.facing : PIST_OPP[t.facing];
      const v = PIST_DIRV[dir];
      if (!v) continue;
      const x0 = Math.min(t.x, t.x + v[0]), x1 = Math.max(t.x + 1, t.x + 1 + v[0]);
      const y0 = Math.min(t.y, t.y + v[1]), y1 = Math.max(t.y + 1, t.y + 1 + v[1]);
      const z0 = Math.min(t.z, t.z + v[2]), z1 = Math.max(t.z + 1, t.z + 1 + v[2]);
      const push = (o, w, h) => {
        try {
          if (!o || o.x == null) return;
          const e = 0.01;
          if (o.x + w / 2 > x0 + e && o.x - w / 2 < x1 - e && o.y + h > y0 && o.y < y1 && o.z + w / 2 > z0 + e && o.z - w / 2 < z1 - e) {
            if (v[0] > 0) o.x = x1 + w / 2 + 0.01;
            else if (v[0] < 0) o.x = x0 - w / 2 - 0.01;
            else if (v[1] > 0) o.y = y1 + 0.01;
            else if (v[1] < 0) o.y = y0 - h - 0.01;
            else if (v[2] > 0) o.z = z1 + w / 2 + 0.01;
            else if (v[2] < 0) o.z = z0 - w / 2 - 0.01;
            if (o.e && o.e !== o) { try { o.e.x = o.x; o.e.y = o.y; o.e.z = o.z; } catch (e2) {} }
          }
        } catch (e) {}
      };
      try { SV.mobs.forEach((m) => push(m, m.w || 0.6, m.h || 1.8)); } catch (e) {}
      try { SV.items.forEach((it) => { if (it && it.e) push(it.e, 0.4, 0.4); }); } catch (e) {}
      try { SV.orbs.forEach((o) => { if (o && o.e) push(o.e, 0.4, 0.4); }); } catch (e) {}
    }
  } catch (e) {}
}
function pistTick() {
  try {
    pistShove();
    pistRepairTick();
    pistWatchdog();
    pistSettle();
  } catch (e) {}
}

/* ---- placement with orientation (engine only places default states) */
const ORIENTED_HELD = { hopper: 1, dispenser: 1, dropper: 1, lever: 1, beehive: 1, bee_nest: 1, campfire: 1, redstone: 1, redstone_torch: 1, repeater: 1, comparator: 1, piston: 1, sticky_piston: 1, observer: 1 };
function orientedHeld(nm) {
  if (!nm) return false;
  if (ORIENTED_HELD[nm]) return true;
  return nm.slice(-7) === "_button";
}
const OPENABLE_USE = {
  chest: 1, trapped_chest: 1, ender_chest: 1, barrel: 1, furnace: 1, lit_furnace: 1,
  blast_furnace: 1, smoker: 1, brewing_stand: 1, hopper: 1, dispenser: 1, dropper: 1,
  enchanting_table: 1, anvil: 1, chipped_anvil: 1, damaged_anvil: 1, crafting_table: 1,
  grindstone: 1, stonecutter: 1, loom: 1, cartography_table: 1, lectern: 1, beacon: 1,
};
function replaceableForPlace(st) {
  if ((st | 0) === 0) return true;
  try {
    const d = defOf(st);
    if (!d) return false;
    if (d.isLiquid) return true;
    if (d.boundingBox === "empty") return true;
    if (d.material === "plant" || d.material === "web") return true;
    return /^(tall_grass|dead_bush|vine|fire|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(d.name);
  } catch (e) { return false; }
}
function orientedPlaceState(hnm, t) {
  // state id with vanilla-ish orientation, or -1 to refuse
  try {
    const g = game();
    const L = blkLayout(hnm);
    if (!L) return -1;
    if (hnm === "hopper") {
      const f = (t.face | 0) === 0 ? 0 : (t.face | 0) === 1 ? 0 : { 2: 1, 3: 2, 4: 3, 5: 4 }[t.face | 0];
      return L.min + 0 * 5 + (f == null ? 0 : f); // enabled=true is idx 0
    }
    if (hnm === "dispenser" || hnm === "dropper") {
      // face the placer: dominant axis of (player - placement)
      const p = g.player;
      const dx = p.x - (t.px + 0.5), dy = (p.y + 1.5) - (t.py + 0.5), dz = p.z - (t.pz + 0.5);
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
      let fi;
      if (ay >= ax && ay >= az) fi = dy > 0 ? 4 : 5;
      else if (ax >= az) fi = dx > 0 ? 1 : 3;
      else fi = dz > 0 ? 2 : 0;
      return L.min + fi * 2 + 1; // triggered=false is idx 1
    }
    // hives face the placer (vanilla); honey starts at 0
    if (hnm === "beehive" || hnm === "bee_nest") {
      const p = g.player;
      const dx = p.x - (t.px + 0.5), dz = p.z - (t.pz + 0.5);
      const facing = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? "east" : "west") : (dz > 0 ? "south" : "north");
      return L.min + ["north", "south", "west", "east"].indexOf(facing) * 6;
    }
    // campfires place unlit (vanilla); hay below makes a signal fire
    if (hnm === "campfire") {
      let hay = false;
      try { hay = blockNameAt(t.px, t.py - 1, t.pz) === "hay_block"; } catch (e) {}
      const st = { facing: playerLookName(), lit: "false", signal_fire: hay ? "true" : "false", waterlogged: "false" };
      let off = 0;
      for (const pr of L.props) {
        let vi = pr.vals.indexOf(st[pr.name] !== undefined ? st[pr.name] : pr.vals[0]);
        if (vi < 0) vi = 0;
        off = off * pr.vals.length + vi;
      }
      return L.min + off;
    }
    // v1.11 redstone: dust (item `redstone`), torches, repeaters,
    // comparators place oriented (engine only predicts defaults)
    if (hnm === "redstone") {
      // dust on a solid floor, unpowered, unconnected (links render next tick)
      const L2 = blkLayout("redstone_wire");
      if (!L2) return -1;
      let off = 0;
      for (const pr of L2.props) {
        let vi = pr.name === "power" ? pr.vals.indexOf("0") : pr.vals.indexOf("none");
        if (vi < 0) vi = 0;
        off = off * pr.vals.length + vi;
      }
      return L2.min + off;
    }
    if (hnm === "redstone_torch") {
      const face = t.face | 0;
      if (face === 0) return -1; // no ceiling mount (vanilla)
      if (face === 1) {
        const L2 = blkLayout("redstone_torch");
        if (!L2) return -1;
        let off = 0;
        for (const pr of L2.props) {
          let vi = pr.vals.indexOf(pr.name === "lit" ? "true" : pr.vals[0]);
          if (vi < 0) vi = 0;
          off = off * pr.vals.length + vi;
        }
        return L2.min + off;
      }
      // wall torch: faces away from the clicked face (toward the player)
      const L2 = blkLayout("redstone_wall_torch");
      if (!L2) return -1;
      const fname = { 2: "north", 3: "south", 4: "west", 5: "east" }[face];
      if (!fname) return -1;
      let off = 0;
      for (const pr of L2.props) {
        let want = pr.vals[0];
        if (pr.name === "facing") want = fname;
        if (pr.name === "lit") want = "true";
        let vi = pr.vals.indexOf(want);
        if (vi < 0) vi = 0;
        off = off * pr.vals.length + vi;
      }
      return L2.min + off;
    }
    if (hnm === "repeater" || hnm === "comparator") {
      // signal flows away from the placer; delay 1 / compare mode
      const L2 = blkLayout(hnm);
      if (!L2) return -1;
      const look = playerLookName();
      let off = 0;
      for (const pr of L2.props) {
        let want = pr.vals[0];
        if (pr.name === "facing") want = look;
        if (pr.name === "powered" || pr.name === "locked") want = "false";
        if (pr.name === "delay") want = "1";
        if (pr.name === "mode") want = "compare";
        let vi = pr.vals.indexOf(want);
        if (vi < 0) vi = 0;
        off = off * pr.vals.length + vi;
      }
      return L2.min + off;
    }
    // v1.13: pistons + observers face the placer (vanilla); unextended / unpowered
    if (hnm === "piston" || hnm === "sticky_piston" || hnm === "observer") {
      const p = game().player;
      const dx = p.x - (t.px + 0.5), dy = (p.y + 1.5) - (t.py + 0.5), dz = p.z - (t.pz + 0.5);
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
      let face;
      if (ay >= ax && ay >= az) face = dy > 0 ? "up" : "down";
      else if (ax >= az) face = dx > 0 ? "east" : "west";
      else face = dz > 0 ? "south" : "north";
      const L2 = blkLayout(hnm);
      if (!L2) return -1;
      let off = 0;
      for (const pr of L2.props) {
        let want2 = pr.vals[0];
        if (pr.name === "facing") want2 = face;
        if (pr.name === "extended" || pr.name === "powered") want2 = "false";
        let vi = pr.vals.indexOf(want2);
        if (vi < 0) vi = 0;
        off = off * pr.vals.length + vi;
      }
      return L2.min + off;
    }
    // lever + buttons mount on the clicked face, toggle axis faces the player
    const face = t.face | 0;
    const look = playerLookName();
    const st = { powered: "false", facing: look };
    st.face = face === 1 ? "floor" : face === 0 ? "ceiling" : "wall";
    let off = 0;
    for (const pr of L.props) {
      let vi = pr.vals.indexOf(st[pr.name] !== undefined ? st[pr.name] : pr.vals[0]);
      if (vi < 0) vi = 0;
      off = off * pr.vals.length + vi;
    }
    return L.min + off;
  } catch (e) { return -1; }
}
function handleOrientedPlace(t, hand) {
  try {
    const s = handStack(hand);
    const hn = stackName(s);
    if (!orientedHeld(hn)) return false;
    if (t == null || t.face == null) return false;
    const g = game();
    // clicking an openable container (not sneaking) opens it — never place
    try {
      const tn = blockNameAt(t.x, t.y, t.z);
      if (tn && (OPENABLE_USE[tn] || tn === "shulker_box" || tn.slice(-12) === "_shulker_box") && !(g.player && g.player.sneaking)) return false;
    } catch (e) {}
    // main-hand block keeps priority (same rule as the top of handleBlockUse)
    if (hand === 1) {
      try {
        const m = mainHeld(), md = m && m.id ? g.items.def(m.id) : null;
        if (md && g.interaction._itemBlock && g.interaction._itemBlock(m)) return false;
      } catch (e) {}
    }
    const cur = g.world.getState(t.x, t.y, t.z);
    let px = t.x, py = t.y, pz = t.z;
    if (!replaceableForPlace(cur)) {
      const d = FACE_D[t.face | 0] || FACE_D[1];
      px += d[0]; py += d[1]; pz += d[2];
      if (py < -64 || py > 319) return false;
      if (!replaceableForPlace(g.world.getState(px, py, pz))) return false;
    }
    // support for wall/floor/ceiling mounts (mirror of the engine rule,
    // plus the vanilla hopper-top exception: levers/buttons mount on top
    // of hoppers though hoppers aren't opaque). NOTE: survival defs carry
    // no `opaque` flag (the engine registry does), so derive it here:
    // opaque = full cube that isn't transparent.
    if (hn === "lever" || hn.slice(-7) === "_button") {
      const d = FACE_D[t.face | 0] || [0, 1, 0];
      const sup = defOf(g.world.getState(px - d[0], py - d[1], pz - d[2]));
      const hopperTop = (t.face | 0) === 1 && sup && sup.name === "hopper";
      const solidSup = sup && (sup.opaque || (sup.transparent === false && sup.boundingBox === "block"));
      if (!(solidSup || hopperTop)) return false;
    }
    // v1.11 redstone mounts: dust/repeaters/comparators/floor torches need
    // a solid floor; wall torches hang on the block behind them
    if (hn === "redstone" || hn === "repeater" || hn === "comparator" ||
        (hn === "redstone_torch" && (t.face | 0) === 1)) {
      if (!rsSolid(px, py - 1, pz)) return false;
    } else if (hn === "redstone_torch") {
      const d = FACE_D[t.face | 0] || [0, 0, -1];
      if (!rsSolid(px - d[0], py - d[1], pz - d[2])) return false;
    }
    // entity collision (mirror of the engine rule for solid blocks)
    try {
      const probe = orientedPlaceState(hn, { face: t.face, px, py, pz });
      if (probe < 0) return false;
      const boxes = staticBoxesFor(probe);
      if (boxes && boxes.length) {
        const p = g.player;
        const hw = 0.3;
        const pb = [p.x - hw, p.y, p.z - hw, p.x + hw, p.y + 1.8, p.z + hw];
        for (const b of boxes) {
          if (px + b[3] > pb[0] && px + b[0] < pb[3] && py + b[4] > pb[1] && py + b[1] < pb[4] && pz + b[5] > pb[2] && pz + b[2] < pb[5]) return false;
        }
      }
      try { SV.grief = false; g.world.setState(px, py, pz, probe); } catch (e) { g.world.setState(px, py, pz, probe); }
      // materialize the block-entity now (vanilla always has one; the sim
      // needs no window ever opened)
      try {
        const n0 = containerSlots(hn);
        if (n0 > 0) getOrCreateTile(px, py, pz, tileTypeFor(hn), n0);
      } catch (e) {}
      // silk-carried bees move back into a placed hive (no item NBT offline)
      try { if ((hn === "beehive" || hn === "bee_nest") && SV.hiveCarry && SV.hiveCarry.length) hiveCarryIn(px, py, pz); } catch (e) {}
      if (hand === 1) consumeOne(() => offHeld(), (x) => { inv().offhand[0] = x; });
      else consumeOne(() => mainHeld(), (x) => { inv().main[game().heldSlot | 0] = x; });
      try { g.sound.play("block.stone.place"); } catch (e2) {}
      return true;
    } catch (e) { return false; }
  } catch (e) { return false; }
}
function staticBoxesFor(state) {
  // collision boxes without importing the engine module (approximate the
  // registry path: full block unless the def says otherwise)
  try {
    const d = defOf(state);
    if (!d || d.id === 0) return [];
    if (d.boundingBox === "block") return [[0, 0, 0, 1, 1, 1]];
    return [];
  } catch (e) { return [[0, 0, 0, 1, 1, 1]]; }
}
function togglePowerBit(t) {
  // lever + buttons flip on right-click (engine never predicts these)
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const d = defOf(st);
    if (!d) return false;
    const nm = d.name;
    const isBtn = nm.slice(-7) === "_button";
    if (nm !== "lever" && !isBtn) return false;
    const on = stProp(st, "powered") === "true";
    try { g.world.setState(t.x, t.y, t.z, stWith(st, "powered", on ? "false" : "true")); } catch (e) { return false; }
    const wood = nm !== "stone_button" && nm !== "lever" && /wood|oak|spruce|birch|jungle|acacia|dark_oak/.test(nm);
    try { g.sound.play("block." + (nm === "lever" ? "lever" : (wood ? "wooden" : "stone") + "_button") + ".click_" + (on ? "off" : "on")); } catch (e) {}
    if (!on && isBtn) {
      // momentary: stone 10 masterTicks (1 s), wood 15 (1.5 s)
      SV.presses = SV.presses || [];
      SV.presses.push({ x: t.x, y: t.y, z: t.z, until: (SV.tickN | 0) + (wood ? 15 : 10), wood });
    }
    return true;
  } catch (e) { return false; }
}
function pressTick() {
  try {
    if (!SV.presses || !SV.presses.length) return;
    const now = SV.tickN | 0;
    const keep = [];
    for (const pr of SV.presses) {
      if ((pr.until | 0) > now) { keep.push(pr); continue; }
      try {
        const g = game();
        const st = g.world.getState(pr.x, pr.y, pr.z);
        const d = defOf(st);
        if (d && (d.name === "lever" || d.name.slice(-7) === "_button") && stProp(st, "powered") === "true") {
          g.world.setState(pr.x, pr.y, pr.z, stWith(st, "powered", "false"));
          try { g.sound.play("block." + (pr.wood ? "wooden" : "stone") + "_button.click_off"); } catch (e) {}
        }
      } catch (e) {}
    }
    SV.presses = keep;
  } catch (e) {}
}

/* ---- hopper + dispenser/dropper tile sim (ticks with the window closed) */
function maxStackOf(id) {
  try { const m = game().items.maxStack(id) | 0; if (m > 0) return m; } catch (e) {}
  return 64;
}
function eqStack(a, b) {
  if (!a || !b || a.id !== b.id) return false;
  try {
    const na = a.nbt ? JSON.stringify(a.nbt) : "", nb = b.nbt ? JSON.stringify(b.nbt) : "";
    return na === nb;
  } catch (e) { return false; }
}
function tileRoom(tile, id, nbt, maxAdd) {
  // total room for (id,nbt) across the tile, up to maxAdd
  let room = 0;
  try {
    const max = maxStackOf(id);
    for (const s of (tile.items || [])) {
      if (room >= maxAdd) break;
      if (!s || !s.id) room += Math.min(max, maxAdd - room);
      else if (s.id === id && eqNbt(s.nbt, nbt)) room += Math.min(max - (s.count | 0), maxAdd - room);
    }
  } catch (e) {}
  return Math.max(0, room);
}
function eqNbt(a, b) {
  try {
    const na = a ? JSON.stringify(a) : "", nb = b ? JSON.stringify(b) : "";
    return na === nb;
  } catch (e) { return false; }
}
function tileDeposit(tile, id, count, nbt) {
  // returns leftover count that did not fit
  let n = count | 0;
  if (!(id > 0) || n <= 0) return 0;
  try {
    const max = maxStackOf(id);
    for (const s of (tile.items || [])) {
      if (n <= 0) break;
      if (s && s.id === id && eqNbt(s.nbt, nbt) && (s.count | 0) < max) {
        const mv = Math.min(max - (s.count | 0), n);
        s.count = (s.count | 0) + mv; n -= mv;
      }
    }
    for (let i = 0; i < tile.items.length && n > 0; i++) {
      if (!tile.items[i]) { const mv = Math.min(max, n); tile.items[i] = { id, count: mv, nbt: nbt || null }; n -= mv; }
    }
  } catch (e) {}
  return n;
}
function tileTakeFirst(tile, slots) {
  // removes 1 item from the first non-empty of slots (or all slots); returns {id,count:1,nbt} or null
  try {
    const items = tile.items || [];
    const order = slots || items.map((_, i) => i);
    for (const i of order) {
      const s = items[i];
      if (s && s.id && (s.count | 0) > 0) {
        const out = { id: s.id, count: 1, nbt: s.nbt || null };
        s.count = (s.count | 0) - 1;
        if (s.count <= 0) items[i] = null;
        return out;
      }
    }
  } catch (e) {}
  return null;
}
function isFurnaceTile(t) { const n = tileBlockName(t); return n === "furnace" || n === "lit_furnace" || n === "blast_furnace" || n === "smoker"; }
function tileBlockName(t) {
  try {
    if (t.x == null || t.y == null || t.z == null) return "";
    return blockNameAt(t.x | 0, t.y | 0, t.z | 0);
  } catch (e) { return ""; }
}
function pushSlotsFor(tile, fromDir) {
  // fromDir: direction the hopper pushes toward (its facing): which slots
  // of the destination may receive (furnace sidedness; brewing ingredient/
  // fuel; everything else: all slots in order)
  try {
    const nm = tileBlockName(tile);
    if (nm === "brewing_stand") return "brew";
    if (nm.indexOf("furnace") >= 0 || nm === "smoker") {
      if (fromDir === 0) return [0]; // hopper above pushing down: smelt slot
      if (fromDir === 1) return []; // pushing up into the bottom: extract-only side
      return [1]; // sides: fuel slot
    }
    return null; // all slots
  } catch (e) { return null; }
}
function containerSlots(nm) {
  if (!nm) return 0;
  if (nm === "hopper") return 5;
  if (nm === "dispenser" || nm === "dropper") return 9;
  if (nm === "shulker_box" || nm.slice(-12) === "_shulker_box") return 27;
  if (nm === "brewing_stand") return 5;
  if (nm.indexOf("furnace") >= 0 || nm === "smoker") return 3;
  if (nm === "chest" || nm === "trapped_chest" || nm === "barrel") return 27;
  return 0;
}
function tryPushOne(tile, fi) {
  // hopper pushes 1 item into the container it faces. Returns true if moved.
  try {
    const dirs = [[0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
    const d = dirs[fi] || dirs[0];
    const dx = (tile.x | 0) + d[0], dy = (tile.y | 0) + d[1], dz = (tile.z | 0) + d[2];
    let dst = getTile(dx, dy, dz);
    if (!dst) {
      // lazily materialize the destination block-entity (vanilla always has one)
      const nm0 = tileBlockName({ x: dx, y: dy, z: dz });
      const n0 = containerSlots(nm0);
      if (n0 > 0) dst = getOrCreateTile(dx, dy, dz, tileTypeFor(nm0), n0);
    }
    if (!dst || dst.type === "ender") return false;
    const rule = pushSlotsFor(dst, fi);
    const one = tileTakeFirst(tile);
    if (!one) return false;
    let ok = false;
    if (rule === "brew") {
      if (stackName({ id: one.id }) === "blaze_powder") {
        const slot4 = dst.items[4];
        if (!slot4) { dst.items[4] = { id: one.id, count: 1, nbt: one.nbt }; ok = true; }
        else if (slot4.id === one.id && eqNbt(slot4.nbt, one.nbt) && (slot4.count | 0) < maxStackOf(one.id)) { slot4.count = (slot4.count | 0) + 1; ok = true; }
      } else {
        // bottles into 1-3 first, else ingredient slot 0
        const order = [1, 2, 3, 0];
        for (const i of order) {
          const s = dst.items[i];
          if (!s) { dst.items[i] = { id: one.id, count: 1, nbt: one.nbt }; ok = true; break; }
          if (s.id === one.id && eqNbt(s.nbt, one.nbt) && (s.count | 0) < maxStackOf(one.id)) { s.count = (s.count | 0) + 1; ok = true; break; }
        }
      }
    } else if (rule && rule.length === 0) {
      ok = false;
    } else {
      const left = tileDepositInto(dst, one, rule);
      ok = left <= 0;
    }
    if (!ok) {
      // put it back (front of own first slot order — vanilla keeps order)
      tileDeposit(tile, one.id, 1, one.nbt);
      return false;
    }
    return true;
  } catch (e) { return false; }
}
function tileDepositInto(tile, one, slots) {
  // deposit 1 unit into dst restricted to slots (null = all); returns leftover
  try {
    const items = tile.items || [];
    const order = slots || items.map((_, i) => i);
    const max = maxStackOf(one.id);
    for (const i of order) {
      const s = items[i];
      if (s && s.id === one.id && eqNbt(s.nbt, one.nbt) && (s.count | 0) < max) {
        s.count = (s.count | 0) + 1;
        return 0;
      }
    }
    for (const i of order) {
      if (!items[i]) { items[i] = { id: one.id, count: 1, nbt: one.nbt || null }; return 0; }
    }
  } catch (e) {}
  return 1;
}
function tileTypeFor(nm) {
  if (nm === "brewing_stand") return "brewing";
  if (nm.indexOf("furnace") >= 0 || nm === "smoker") {
    if (nm.indexOf("blast") >= 0) return "blast";
    if (nm === "smoker") return "smoker";
    return "furnace";
  }
  if (nm === "hopper" || nm === "dispenser" || nm === "dropper") return nm;
  if (nm === "shulker_box" || nm.slice(-12) === "_shulker_box") return "shulker";
  return "chest";
}
function tryPullOne(tile) {
  // hopper pulls 1 item from the container above. Returns true if moved.
  try {
    let src = getTile(tile.x | 0, (tile.y | 0) + 1, tile.z | 0);
    if (!src) {
      // lazily materialize the source block-entity (vanilla always has one)
      const nm0 = tileBlockName({ x: tile.x | 0, y: (tile.y | 0) + 1, z: tile.z | 0 });
      const n0 = containerSlots(nm0);
      if (n0 > 0) src = getOrCreateTile(tile.x | 0, (tile.y | 0) + 1, tile.z | 0, tileTypeFor(nm0), n0);
    }
    if (!src || src.type === "ender") return false;
    const nm = tileBlockName(src);
    let slots = null;
    if (nm.indexOf("furnace") >= 0 || nm === "smoker") slots = [2]; // result only
    else if (nm === "brewing_stand") slots = [1, 2, 3]; // bottles only
    const one = tileTakeFirst(src, slots);
    if (!one) return false;
    const left = tileDeposit(tile, one.id, 1, one.nbt);
    if (left > 0) {
      // own full: put it back where it came from
      tileDepositInto(src, one, slots);
      return false;
    }
    return true;
  } catch (e) { return false; }
}
function trySuckOne(tile) {
  // collect item entities above the hopper (whole stacks, vanilla)
  try {
    const x = (tile.x | 0) + 0.5, y = tile.y | 0, z = (tile.z | 0) + 0.5;
    let moved = false;
    const cands = [];
    SV.items.forEach((it) => {
      if (!it || !it.e || !it.e.item || !it.e.item.id) return;
      if ((it.pickupDelay || 0) > 0) return;
      const dx = it.e.x - x, dy = it.e.y - y, dz = it.e.z - z;
      if (Math.abs(dx) < 0.6 && dy > -0.4 && dy < 1.6 && Math.abs(dz) < 0.6) cands.push(it);
    });
    cands.sort((a, b) => (a.e.y - b.e.y) || (a.id - b.id));
    for (const it of cands) {
      const id = it.e.item.id, n = it.e.item.count | 0 || 1;
      const room = tileRoom(tile, id, it.e.item.nbt || null, n);
      if (room <= 0) continue;
      const mv = Math.min(room, n);
      tileDeposit(tile, id, mv, it.e.item.nbt || null);
      it.e.item.count = n - mv;
      if (it.e.item.count <= 0) { try { removeItem(it.id); } catch (e) {} }
      moved = true;
    }
    return moved;
  } catch (e) { return false; }
}
function hopperTileTick(t) {
  try {
    t.cd = Math.max(0, (t.cd | 0) - (t.cd > 0 ? 1 : 0));
    const locked = redstonePowered(t.x | 0, t.y | 0, t.z | 0);
    // enabled bit mirrors lock (model doesn't change, keeps saves honest)
    try {
      const st = game().world.getState(t.x | 0, t.y | 0, t.z | 0);
      if (defOf(st) && defOf(st).name === "hopper") {
        const want = locked ? "false" : "true";
        if (stProp(st, "enabled") !== want) game().world.setState(t.x | 0, t.y | 0, t.z | 0, stWith(st, "enabled", want));
      }
    } catch (e) {}
    if (locked || (t.cd | 0) > 0) return;
    const fi = hopFacingIdx(game().world.getState(t.x | 0, t.y | 0, t.z | 0));
    if (tryPushOne(t, fi)) { t.cd = 4; return; }
    if (tryPullOne(t)) { t.cd = 4; return; }
    if (trySuckOne(t)) t.cd = 4;
  } catch (e) {}
}
function getOrCreateTile(x, y, z, type, n) {
  try {
    let t = getTile(x, y, z);
    if (!t) {
      t = { type, x, y, z, items: new Array(n).fill(null), burn: 0, burnTotal: 0, cook: 0, xp: 0, fuel: 0, time: 0, ing: null, cd: 0, pow: false };
      setTile(x, y, z, t);
    }
    t.cd = t.cd | 0;
    return t;
  } catch (e) { return null; }
}

function wearTileStack(t, i, n) {
  // durability on a dispenser slot stack; returns false if it broke
  try {
    const s = t.items[i];
    if (!s || !s.id) return true;
    let max = 0;
    try { max = game().items.maxDurability(s.id) | 0; } catch (e) {}
    if (!max) return true;
    const d = stackDmg(s) + (n | 0);
    if (d >= max) { t.items[i] = null; return false; }
    setStackDmg(s, d);
    return true;
  } catch (e) { return true; }
}
/* ---- dispenser / dropper firing */
function dispenseTileTick(t) {
  try {
    const g = game();
    const st = g.world.getState(t.x | 0, t.y | 0, t.z | 0);
    const d = defOf(st);
    if (!d || (d.name !== "dispenser" && d.name !== "dropper")) return;
    const pow = redstonePowered(t.x | 0, t.y | 0, t.z | 0);
    if (pow && !t.pow) {
      // rising edge: schedule the shot ~2 redstone ticks out (vanilla delay)
      if ((t.cd | 0) <= 0) t.cd = 2;
    }
    t.pow = pow;
    // triggered bit mirrors power (clears when the signal drops)
    try {
      const want = pow ? "true" : "false";
      if (stProp(st, "triggered") !== want) g.world.setState(t.x | 0, t.y | 0, t.z | 0, stWith(st, "triggered", want));
    } catch (e) {}
    if ((t.cd | 0) > 0) {
      t.cd = (t.cd | 0) - 1;
      if ((t.cd | 0) <= 0 && t.type === d.name) {
        try { dispenseOnce(t, d.name); } catch (e) {}
      }
    }
  } catch (e) {}
}
function dispensePickSlot(t) {
  // vanilla fires a random non-empty slot
  try {
    const items = t.items || [];
    const full = [];
    for (let i = 0; i < items.length; i++) if (items[i] && items[i].id && (items[i].count | 0) > 0) full.push(i);
    if (!full.length) return -1;
    return full[(Math.random() * full.length) | 0];
  } catch (e) { return -1; }
}
function dispArmorSlot(nm) {
  // engine armorType order: 0 head .. 3 feet; the player armor array is
  // [boots, legs, chest, helmet], so the slot index is 3 - type.
  try {
    if (!nm) return -1;
    if (nm === "turtle_helmet" || nm === "carved_pumpkin" ||
        nm === "skeleton_skull" || nm === "wither_skeleton_skull" ||
        nm === "zombie_head" || nm === "creeper_head" ||
        nm === "dragon_head" || nm === "player_head" ||
        /_helmet$/.test(nm)) return 3;
    if (nm === "elytra" || /_chestplate$/.test(nm)) return 2;
    if (/_leggings$/.test(nm)) return 1;
    if (/_boots$/.test(nm)) return 0;
  } catch (e) {}
  return -1;
}
// zombies, husks, skeletons and strays wear armor in vanilla (and take it
// from dispensers); our other mobs have no equip slots.
const MOB_WEAR = { zombie: 1, husk: 1, skeleton: 1, stray: 1 };
function mobGearArmor(m) {
  let A = 0, T = 0;
  try {
    for (const s of (m.gear || [])) {
      if (!s || !s.id) continue;
      let nm = null;
      try { const dd = game().items.def(s.id); nm = dd && dd.name; } catch (e) {}
      if (!nm) continue;
      const mt = nm.match(/^(leather|gold|chainmail|iron|diamond|chain)_?(helmet|chestplate|leggings|boots)$/);
      if (!mt) continue; // skulls/pumpkins: worn but 0 points
      const mat = mt[1] === "chain" ? "chainmail" : mt[1];
      A += (ARMOR_PTS[mt[2]] && ARMOR_PTS[mt[2]][mat]) || 0;
      if (mat === "diamond") T += 2;
    }
  } catch (e) {}
  return { A: A, T: T };
}
function dispenseTarget(x, y, z) {
  // who stands in the faced cell: player, mob, horse, or armor stand.
  try {
    const g = game();
    const inCell = (ex, ey, ez, w, h) => (
      ex + w / 2 > x && ex - w / 2 < x + 1 && ez + w / 2 > z && ez - w / 2 < z + 1 &&
      ey + h > y && ey < y + 1);
    const p = g.player;
    if (p && !SV.dead && inCell(p.x, p.y, p.z, 0.6, 1.8)) return { kind: "player" };
    let out = null;
    try {
      SV.mobs.forEach((m) => {
        if (out || !m || (m.hp | 0) <= 0 || m.x == null) return;
        if (inCell(m.x, m.y, m.z, m.w || 0.6, m.h || 1.8)) out = { kind: "mob", m };
      });
    } catch (e) {}
    if (out) return out;
    try {
      SV.horses.forEach((h) => {
        if (out || !h || !h.e) return;
        const ex = h.e.x != null ? h.e.x : h.x, ey = h.e.y != null ? h.e.y : (h.y || 0), ez = h.e.z != null ? h.e.z : h.z;
        if (ex == null || ez == null) return;
        if (inCell(ex, ey, ez, 1.0, 1.6)) out = { kind: "horse", h };
      });
    } catch (e) {}
    if (out) return out;
    try {
      SV.stands.forEach((s) => {
        if (out || !s || s.x == null) return;
        if (inCell(s.x, s.y, s.z, 0.5, 1.975)) out = { kind: "stand", s };
      });
    } catch (e) {}
    return out;
  } catch (e) { return null; }
}
function dispenseFailAt(x, y, z) {  try { game().sound.play("block.dispenser.fail"); } catch (e) {}
  try { game().particles.smoke(x, y + 0.4, z, 0, 0.05, 0); } catch (e2) {}
}
function dispenseConsume(t, i) {
  try {
    const s = t.items[i];
    if (!s) return null;
    const out = { id: s.id, count: 1, nbt: s.nbt || null };
    s.count = (s.count | 0) - 1;
    if (s.count <= 0) t.items[i] = null;
    return out;
  } catch (e) { return null; }
}
function dispenseEject(t, one, fi, spread) {
  // dropper-style toss (also the fallback for unhandled dispenser items)
  try {
    const g = game(), v = DISP_VEC[fi] || DISP_VEC[2];
    const sx = (t.x | 0) + 0.5 + v[0] * 0.7, sy = (t.y | 0) + 0.5 + v[1] * 0.7, sz = (t.z | 0) + 0.5 + v[2] * 0.7;
    const id = spawnItemEntity(sx, sy, sz, one.id, 1);
    if (id != null) {
      try {
        const rec = SV.items.get(id);
        if (rec) {
          const sp = spread == null ? 1.2 : spread;
          rec.vx = v[0] * 3 + (Math.random() - 0.5) * sp;
          rec.vy = v[1] * 3 + 2 + (Math.random() - 0.5) * sp * 0.5;
          rec.vz = v[2] * 3 + (Math.random() - 0.5) * sp;
          rec.pickupDelay = Math.max(rec.pickupDelay || 0, 0.5);
          if (one.nbt) { try { const e = g.entities.get(id); if (e && e.item) e.item.nbt = one.nbt; } catch (e) {} }
        }
      } catch (e) {}
    }
    try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
    return true;
  } catch (e) { return false; }
}
function dispenseShoot(t, one, fi, proj) {
  // arrows, snowballs, eggs, pearls, potions, fire charges along facing
  try {
    const g = game(), v = DISP_VEC[fi] || DISP_VEC[2];
    const sx = (t.x | 0) + 0.5 + v[0] * 0.8, sy = (t.y | 0) + 0.5 + v[1] * 0.8, sz = (t.z | 0) + 0.5 + v[2] * 0.8;
    const id = SV.eidSeq++;
    g.entities.spawnObject({
      entityId: id, x: sx, y: sy, z: sz, yaw: 0, pitch: 0, type: proj.type,
      objectUUID: "00000000-0000-4000-8000-" + String(id % 1000000000000).padStart(12, "0"),
      velocity: { x: 0, y: 0, z: 0 }, metadata: {},
    });
    const e = g.entities.get(id);
    if (!e) return false;
    const sp = proj.sp;
    const rec = {
      id, e, x: sx, y: sy, z: sz, w: 0.3, h: 0.3,
      vx: v[0] * sp + (Math.random() - 0.5) * 1.2, vy: v[1] * sp + 1 + (Math.random() - 0.5) * 1.2, vz: v[2] * sp + (Math.random() - 0.5) * 1.2,
      age: 0, fromMob: false, neutral: true, from: "dispenser",
      kind: proj.kind, dmg: proj.dmg || 0, thrown: !!proj.thrown, potion: proj.potion || null,
    };
    if (proj.noTeleport) rec.noTeleport = true;
    SV.arrows.set(id, rec);
    syncEnt(e);
    try { g.sound.play(proj.sound || "block.dispenser.launch"); } catch (err) {}
    return true;
  } catch (err) { return false; }
}
function fluidStillState(name) {
  try {
    const L = blkLayout(name);
    if (!L) return -1;
    let off = 0;
    for (const pr of L.props) {
      const vi = pr.name === "level" ? pr.vals.indexOf("0") : 0;
      off = off * pr.vals.length + (vi < 0 ? 0 : vi);
    }
    return L.min + off;
  } catch (e) { return -1; }
}
function canPlaceFluidAt(x, y, z) {
  try {
    const st = game().world.getState(x | 0, y | 0, z | 0);
    if ((st | 0) === 0) return true;
    const d = defOf(st);
    if (!d) return false;
    if (d.isLiquid) return true;
    return d.boundingBox === "empty";
  } catch (e) { return false; }
}
function fluidLevel(st) {
  try {
    const v = stProp(st, "level");
    return v == null ? 0 : parseInt(v, 10) | 0;
  } catch (e) { return 0; }
}
function dispenseOnce(t, blockName) {
  const g = game();
  const st = g.world.getState(t.x | 0, t.y | 0, t.z | 0);
  const fi = dispFacingIdx(st);
  const v = DISP_VEC[fi] || DISP_VEC[2];
  const fx = (t.x | 0) + v[0], fy = (t.y | 0) + v[1], fz = (t.z | 0) + v[2];
  const si = dispensePickSlot(t);
  const cx = (t.x | 0) + 0.5 + v[0] * 0.7, cy = (t.y | 0) + 0.5 + v[1] * 0.7, cz = (t.z | 0) + 0.5 + v[2] * 0.7;
  if (si < 0) { dispenseFailAt(cx, cy, cz); return; }
  const peek = t.items[si];
  const nm = stackName(peek);
  if (blockName === "dropper") {
    // insert into the faced container, else eject
    let dst = getTile(fx, fy, fz);
    if (!dst) {
      try {
        const nm0 = blockNameAt(fx | 0, fy | 0, fz | 0);
        const n0 = containerSlots(nm0);
        if (n0 > 0) dst = getOrCreateTile(fx | 0, fy | 0, fz | 0, tileTypeFor(nm0), n0);
      } catch (e) {}
    }
    if (dst && dst.type !== "ender") {
      const one = dispenseConsume(t, si);
      if (one && tileDeposit(dst, one.id, 1, one.nbt) <= 0) {
        try { g.sound.play("block.dispenser.dispense"); } catch (e) {}
        return;
      }
      if (one) tileDeposit(t, one.id, 1, one.nbt); // dst full: keep it
      dispenseFailAt(cx, cy, cz);
      return;
    }
    const one = dispenseConsume(t, si);
    if (one) dispenseEject(t, one, fi);
    else dispenseFailAt(cx, cy, cz);
    return;
  }
  // ---- dispenser behaviors (JE table, gaps noted in the header)
  const done = (ok) => { if (!ok) dispenseFailAt(cx, cy, cz); };
  if (nm === "arrow" || nm === "spectral_arrow" || nm === "tipped_arrow") {
    const one = dispenseConsume(t, si);
    done(one && dispenseShoot(t, one, fi, { type: 60, kind: "arrow", dmg: 4, sp: 20, sound: "block.dispenser.launch" }));
    return;
  }
  if (nm === "snowball" || nm === "egg" || nm === "ender_pearl" || nm === "splash_potion" || nm === "lingering_potion") {
    const one = dispenseConsume(t, si);
    const kind = nm === "snowball" ? "snow" : nm === "egg" ? "egg" : nm === "ender_pearl" ? "pearl" : nm === "splash_potion" ? "splash" : "linger";
    let potion = null;
    try { if (one && one.nbt) potion = (g.items.nbt({ id: one.id, nbt: one.nbt }) || {}).Potion || null; } catch (e) {}
    const type = kind === "snow" ? 61 : kind === "egg" ? 62 : kind === "pearl" ? 80 : 82;
    done(one && dispenseShoot(t, one, fi, {
      type, kind, thrown: true, dmg: 0, sp: kind === "pearl" ? 20 : 16,
      sound: kind === "pearl" ? "entity.enderman.teleport" : "block.dispenser.launch",
      potion, noTeleport: kind === "pearl",
    }));
    return;
  }
  if (nm === "fire_charge") {
    const one = dispenseConsume(t, si);
    done(one && dispenseShoot(t, one, fi, { type: 69, kind: "fire", thrown: true, dmg: 5, sp: 16, sound: "block.dispenser.launch" }));
    return;
  }
  if (nm === "water_bucket" || nm === "lava_bucket") {
    const fluid = nm === "water_bucket" ? "water" : "lava";
    if (canPlaceFluidAt(fx, fy, fz)) {
      const fs = fluidStillState(fluid);
      if (fs >= 0) {
        const one = dispenseConsume(t, si);
        if (one) {
          try { SV.grief = true; g.world.setState(fx, fy, fz, fs); } finally { SV.grief = false; }
          tileDeposit(t, itemIdByName("bucket"), 1, null);
          try { g.sound.play("block.dispenser.dispense"); } catch (e) {}
          return;
        }
      }
    }
    done(false);
    return;
  }
  if (nm === "bucket") {
    const fst = g.world.getState(fx, fy, fz);
    const fd = defOf(fst);
    if (fd && (fd.name === "water" || fd.name === "lava") && fluidLevel(fst) === 0) {
      const one = dispenseConsume(t, si);
      if (one) {
        try { SV.grief = true; g.world.setState(fx, fy, fz, 0); } finally { SV.grief = false; }
        tileDeposit(t, itemIdByName(fd.name === "water" ? "water_bucket" : "lava_bucket"), 1, null);
        try { g.sound.play("block.dispenser.dispense"); } catch (e) {}
        return;
      }
    }
    done(false);
    return;
  }
  if (nm === "flint_and_steel") {
    // facing campfire: light it (unlit + dry only)
    try {
      const cf = g.world.getState(fx, fy, fz);
      if (defOf(cf) && defOf(cf).name === "campfire" && stProp(cf, "lit") !== "true" && stProp(cf, "waterlogged") !== "true") {
        g.world.setState(fx, fy, fz, stWith(cf, "lit", "true"));
        wearTileStack(t, si, 1);
        try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
        return;
      }
    } catch (e) {}
    const fd = defOf(g.world.getState(fx, fy, fz));
    if (fd && fd.name === "tnt") {
      try { SV.grief = true; g.world.setState(fx, fy, fz, 0); } finally { SV.grief = false; }
      wearTileStack(t, si, 1);
      spawnPrimedTNT(fx + 0.5, fy, fz + 0.5);
      try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
      return;
    }
    if ((g.world.getState(fx, fy, fz) | 0) === 0) {
      const below = defOf(g.world.getState(fx, fy - 1, fz));
      if (below && below.id !== 0) {
        // fire base state (age 0, no connections) from the registry —
        // never hardcode: raw ids shift with the asset set
        let fs = -1;
        try {
          const L = blkLayout("fire");
          if (L) {
            let off = 0;
            for (const pr of L.props) off = off * pr.vals.length;
            fs = L.min + off;
          }
        } catch (e) {}
        if (fs < 0) { done(false); return; }
        try { SV.grief = true; g.world.setState(fx, fy, fz, fs); } finally { SV.grief = false; }
        wearTileStack(t, si, 1);
        try { g.sound.play("item.flintandsteel.use"); } catch (e2) {}
        return;
      }
    }
    done(false);
    return;
  }
  if (nm === "tnt") {
    const one = dispenseConsume(t, si);
    if (one) {
      spawnPrimedTNT(fx + 0.5, fy, fz + 0.5);
      try { g.sound.play("block.dispenser.dispense"); } catch (e) {}
      return;
    }
    done(false);
    return;
  }
  if (nm === "bone_meal") {
    let grew = false;
    try { grew = !!applyBoneMeal(fx | 0, fy | 0, fz | 0); } catch (e) {}
    if (grew) {
      dispenseConsume(t, si);
      try { g.sound.play("block.dispenser.dispense"); } catch (e) {}
      return;
    }
    done(false);
    return;
  }
  if (nm.slice(-5) === "_boat") {
    const fd = defOf(g.world.getState(fx, fy, fz));
    if (fd && (fd.name === "water" || fd.isLiquid)) {
      const one = dispenseConsume(t, si);
      if (one) {
        try { spawnBoat(BOAT_VARIANT[nm] | 0, fx + 0.5, fy + 0.6, fz + 0.5, boatChestOf(nm)); } catch (e) {}
        try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
        return;
      }
    }
    done(false);
    return;
  }
  // facing hive/nest at honey 5: harvest with our smoke rules (shears take
  // 3 comb, bottles fill) — uncalmed harvests swarm, same as by hand.
  // Falls through to the sheep/eject paths when not a full hive.
  if ((nm === "shears" || nm === "glass_bottle") && hiveKindOf(g.world.getState(fx, fy, fz)) &&
      ((((stProp(g.world.getState(fx, fy, fz), "honey_level") | 0) || 0) >= 5))) {
    try {
      const fst = g.world.getState(fx, fy, fz);
      const key = hiveKey(fx, fy, fz);
      let h = hiveAtKey(key);
      if (!h) { trackHive(fx, fy, fz, fst); h = hiveAtKey(key); }
      const calm = hiveCalmed({ x: fx | 0, y: fy | 0, z: fz | 0 });
      if (nm === "shears") {
        wearTileStack(t, si, 1);
        const id = itemIdByName("honeycomb");
        if (id != null) for (let i = 0; i < 3; i++) spawnItemEntity(fx + 0.5, fy + 0.7, fz + 0.5, id, 1);
        try { g.sound.play("entity.sheep.shear"); } catch (e) {}
      } else {
        const one = dispenseConsume(t, si);
        if (one) tileDeposit(t, itemIdByName("honey_bottle"), 1, null);
        try { g.sound.play("item.bottle.fill"); } catch (e) {}
      }
      setHiveHoney({ x: fx | 0, y: fy | 0, z: fz | 0 }, 0);
      if (!calm) {
        try { if (h) releaseHiveBees(h, true); } catch (e2) {}
        try { angerBeesNear(fx + 0.5, fy, fz + 0.5, 16); } catch (e2) {}
      } else { try { g.sound.play("block.dispenser.dispense"); } catch (e2) {} }
    } catch (e) {}
    return;
  }
  if (nm === "shears") {
    // sheep in front: 1-3 wool, bare coat (mirrors hand shearing).
    // Shears wear, they are never consumed.
    const tgt = dispenseTarget(fx, fy, fz);
    if (tgt && tgt.kind === "mob" && tgt.m && tgt.m.species === "sheep" && !tgt.m.sheared) {
      const m = tgt.m;
      const id = itemIdByName((m.color || "white") + "_wool");
      if (id != null) {
        const n = 1 + ((Math.random() * 3) | 0);
        for (let i = 0; i < n; i++) spawnItemEntity(m.x, m.y + 0.8, m.z, id, 1);
      }
      m.sheared = true; m.regrow = 0;
      try { m.e.sheared = true; } catch (e) {}
      wearTileStack(t, si, 1);
      try { g.sound.play("entity.sheep.shear"); } catch (e2) {}
      return;
    }
    done(false);
    return;
  }
  if (nm === "saddle" || nm === "leather_horse_armor" || nm === "iron_horse_armor" || nm === "golden_horse_armor" || nm === "diamond_horse_armor") {
    // tack onto the horse in front (adults; armor horses only, vanilla)
    const tgt = dispenseTarget(fx, fy, fz);
    if (tgt && tgt.kind === "horse" && tgt.h && !(tgt.h.growT > 0)) {
      const h = tgt.h;
      if (nm === "saddle" && !h.saddle) {
        const one = dispenseConsume(t, si);
        if (one) {
          h.saddle = true;
          try { syncHorseLook(h); } catch (e) {}
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      } else if (nm !== "saddle" && h.species === "horse" && !h.armor) {
        const one = dispenseConsume(t, si);
        if (one) {
          h.armor = nm;
          try { syncHorseLook(h); } catch (e) {}
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
    }
    done(false);
    return;
  }
  if (dispArmorSlot(nm) >= 0) {
    // dress the player standing in front (empty slot only — never swaps)
    const tgt = dispenseTarget(fx, fy, fz);
    if (tgt && tgt.kind === "player") {
      try {
        const inv = g.inventory, worn = (inv && inv.armor) || [];
        const slot = dispArmorSlot(nm);
        if (!worn[slot] || !worn[slot].id) {
          const one = dispenseConsume(t, si);
          if (one) {
            worn[slot] = { id: one.id, count: 1, nbt: one.nbt || undefined };
            try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
            return;
          }
        }
      } catch (e) {}
      done(false);
      return;
    }
    if (tgt && tgt.kind === "mob" && tgt.m && MOB_WEAR[tgt.m.species]) {
      // armor onto zombies/husks/skeletons/strays: empty slot only, vanilla
      const m = tgt.m, slot = dispArmorSlot(nm);
      m.gear = m.gear || [null, null, null, null];
      if (!m.gear[slot]) {
        const one = dispenseConsume(t, si);
        if (one) {
          m.gear[slot] = { id: one.id, count: 1, nbt: one.nbt || undefined };
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
      done(false);
      return;
    }
    if (tgt && tgt.kind === "stand" && tgt.s) {
      // armor onto stands (empty slot only, vanilla dispenser rule)
      const st2 = tgt.s, slot2 = dispArmorSlot(nm);
      st2.gear = st2.gear || [null, null, null, null];
      if (!st2.gear[slot2]) {
        const one = dispenseConsume(t, si);
        if (one) {
          st2.gear[slot2] = { id: one.id, count: 1, nbt: one.nbt || undefined };
          try { syncStandLook(st2); } catch (e) {}
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
      done(false);
      return;
    }
    if (tgt) { done(false); return; } // horse or bare mob in the way
    // no one in front: skulls/pumpkins fall through to placement below;
    // other armor just fails
    if (nm !== "skeleton_skull" && nm !== "wither_skeleton_skull" &&
        nm !== "pumpkin" && nm !== "carved_pumpkin" && nm !== "jack_o_lantern") {
      done(false);
      return;
    }
  }
  // skulls place as floor blocks (rotation from the ejection direction);
  // a completed soul-sand T raises the wither (hand or dispenser alike)
  if (nm === "skeleton_skull" || nm === "wither_skeleton_skull") {
    if (canPlaceFluidAt(fx, fy, fz) && isSolidXYZ(fx, fy - 1, fz)) {
      let fs = -1;
      try {
        const L = blkLayout(nm);
        if (L) {
          const rm = { north: 8, east: 12, south: 0, west: 4 };
          fs = stWith(L.min, "rotation", String(rm[DISP_FACE[fi]] || 0));
        }
      } catch (e) {}
      if (fs >= 0) {
        const one = dispenseConsume(t, si);
        if (one) {
          try { SV.grief = true; g.world.setState(fx, fy, fz, fs); } finally { SV.grief = false; }
          try { checkWither(fx, fy, fz); } catch (e2) {}
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
    }
    done(false);
    return;
  }
  // pumpkins place facing the ejection direction and can complete golems
  if (nm === "pumpkin" || nm === "carved_pumpkin" || nm === "jack_o_lantern") {
    if (canPlaceFluidAt(fx, fy, fz) && isSolidXYZ(fx, fy - 1, fz)) {
      let fs = -1;
      try {
        const L = blkLayout(nm);
        if (L) {
          fs = L.min;
          if (nm !== "pumpkin") {
            let want = DISP_FACE[fi] || "south";
            if (want !== "north" && want !== "south" && want !== "west" && want !== "east") want = playerLookName();
            fs = stWith(L.min, "facing", want);
          }
        }
      } catch (e) {}
      if (fs >= 0) {
        const one = dispenseConsume(t, si);
        if (one) {
          try { SV.grief = true; g.world.setState(fx, fy, fz, fs); } finally { SV.grief = false; }
          try { checkGolem(fx, fy, fz, fs); } catch (e2) {}
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
    }
    done(false);
    return;
  }
  if (nm === "shulker_box" || nm.slice(-12) === "_shulker_box") {
    // place facing the ejection direction; opens as a 27-slot tile
    if (canPlaceFluidAt(fx, fy, fz)) {
      let fs = -1;
      try {
        const L = blkLayout(nm);
        if (L) {
          const want = DISP_FACE[fi] || "north";
          let off = 0;
          for (const pr of L.props) {
            const vi = pr.name === "facing" ? pr.vals.indexOf(want) : 0;
            off = off * pr.vals.length + (vi < 0 ? 0 : vi);
          }
          fs = L.min + off;
        }
      } catch (e) {}
      if (fs >= 0) {
        const one = dispenseConsume(t, si);
        if (one) {
          try { SV.grief = true; g.world.setState(fx, fy, fz, fs); } finally { SV.grief = false; }
          getOrCreateTile(fx, fy, fz, "shulker", 27);
          try { g.sound.play("block.dispenser.dispense"); } catch (e2) {}
          return;
        }
      }
    }
    done(false);
    return;
  }
  // default: eject as a plain item (dropper behavior)
  const one = dispenseConsume(t, si);
  if (one) dispenseEject(t, one, fi);
  else dispenseFailAt(cx, cy, cz);
}

/* ---------------------------------------------------------- Phase C inc 4 (v1.4.0):
 * blast/smoker tiles ride the furnace code above (fast cook, gated inputs);
 * barrel rides the chest tile path (27 slots, no sim). Below: grindstone +
 * stonecutter (window-only server halves, anvil pattern: per-tick refresh,
 * intercepted result takes, salvage on close), composter + bell
 * (stateless use handlers, no tile/window).
 *
 * Grindstone mirrors GrindstoneMenu 1:1: two same-type damageables merge
 * durability (+5% bonus, cf. anvil's +12%), everything else strips down to
 * curses only (a lone enchanted book comes back as a plain book), and each
 * removed enchantment pays XP from its registry min-cost. Single items
 * pass through (stripped copy, possibly 0 XP) so the slot is a usable
 * disenchanter. Stacked inputs are refused (vanilla slots hold 1).
 */
function grdCompute(item0, item1, creative) {
  const none = { out: null, xp: 0 };
  try {
    let base = (item0 && item0.id) ? item0 : null;
    let other = (item1 && item1.id) ? item1 : null;
    if (!base && !other) return none;
    if (!base) { base = other; other = null; }
    const nm = stackName(base);
    const def = itemDefByName(nm);
    const maxDmg = (def && def.maxDurability) | 0;
    const isBook = nm === "enchanted_book";
    if (other) {
      // pairs only combine same-type damageables; books never pair
      // (vanilla: mismatched pairs + book pairs give no output)
      if (isBook) return none;
      const nm1 = stackName(other);
      if (nm1 !== nm || !(maxDmg > 0)) return none;
      if (((base.count | 0) > 1) || ((other.count | 0) > 1)) return none;
    } else {
      if ((base.count | 0) > 1) return none;
    }
    const out = { id: base.id, count: 1 };
    if (base.damage) out.damage = base.damage | 0;
    let nbt = null;
    try { nbt = base.nbt ? JSON.parse(JSON.stringify(base.nbt)) : { t: 10, v: {} }; }
    catch (e) { nbt = { t: 10, v: {} }; }
    nbt.v = nbt.v || {};
    if (other && maxDmg > 0) {
      const d0 = maxDmg - (base.damage | 0), d1 = maxDmg - (other.damage | 0);
      let rem = d0 + d1 + Math.floor(maxDmg / 20); // +5% grindstone bonus
      if (rem > maxDmg) rem = maxDmg;
      const nd = maxDmg - rem;
      if (nd > 0) out.damage = nd; else delete out.damage;
    }
    const reg = enchReg().byName;
    let xp = 0;
    const keep = [];
    for (const p of anvEnchPairs(base)) {
      const ed = reg[p[0]];
      if (ed && ed.curse) { keep.push([p[0], p[1] | 0]); continue; }
      // JE GrindstoneMenu XP: min-cost of each removed enchantment
      xp += ((ed && ed.minA) | 0) + ((ed && ed.minB) | 0) * (p[1] | 0);
    }
    try {
      if (!keep.length) {
        if (isBook) delete nbt.v.StoredEnchantments;
        else delete nbt.v.Enchantments;
      } else {
        const add = vtNbtEnch(keep, isBook);
        if (isBook) { nbt.v.StoredEnchantments = add.v.StoredEnchantments; delete nbt.v.Enchantments; }
        else { nbt.v.Enchantments = add.v.Enchantments; delete nbt.v.StoredEnchantments; }
      }
    } catch (e) { return none; }
    if (isBook && !keep.length) {
      const bookId = itemIdByName("book");
      if (bookId != null) out.id = bookId;
    }
    out.nbt = nbt;
    if (!out.damage) delete out.damage;
    return { out: out, xp: xp };
  } catch (e) { return none; }
}
function grdRefresh(rec) {
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:grindstone" || !rec) return;
    const item0 = w.get(0), item1 = w.get(1);
    const snap = (s) => (s && s.id) ? [s.id, s.damage | 0, s.count | 0, s.nbt || null] : null;
    const key = JSON.stringify([snap(item0), snap(item1)]);
    rec.frame = (rec.frame | 0) + 1;
    if (key === rec.key && (rec.frame % 30) !== 0) return;
    rec.key = key;
    const r = grdCompute(item0, item1, !!(g.player && g.player.creative));
    rec.xp = r.xp;
    try { w.put(2, r.out); } catch (e) {}
  } catch (e) {}
}
function grdTake(rec, mode) {
  // manual result take (engine has no grindstone result logic to predict):
  // swallow the click so the engine can never dupe.
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:grindstone" || !rec) return true;
    try { grdRefresh(rec); } catch (e) {}
    const out = w.get(2);
    if (!out || !out.id) return true;
    const creative = !!(g.player && g.player.creative);
    const v = inv();
    if (!v) return true;
    if ((mode | 0) === 1) {
      if (!anvFits(v, out)) return true;
    } else if (v.cursor && v.cursor.id) {
      return true; // occupied cursor: vanilla does nothing
    }
    try { w.put(0, null); } catch (e) {}
    try { w.put(1, null); } catch (e) {}
    if (!creative && (rec.xp | 0) > 0) {
      try {
        let n = rec.xp | 0;
        const p = g.player;
        for (const s of orbSplit(n)) spawnXPOrb(p.x, p.y + 0.5, p.z, s);
      } catch (e) {}
    }
    const cp = { id: out.id, count: 1 };
    if (out.damage) cp.damage = out.damage | 0;
    if (out.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(out.nbt)); } catch (e) { try { cp.nbt = out.nbt; } catch (e2) {} } }
    if ((mode | 0) === 1) {
      try { v.addToInventory(cp); } catch (e) {}
      let left = cp.count | 0;
      if (left > 0) { // fits() said room; spill any impossible leftover
        try {
          const p = game().player;
          const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
          if (id != null && cp.nbt) {
            try { const e = game().entities.get(id); if (e && e.item) e.item.nbt = cp.nbt; } catch (e) {}
          }
        } catch (e) {}
      }
    } else {
      try { v.cursor = cp; } catch (e) { return true; }
    }
    try { w.put(2, null); } catch (e) {}
    try { sfx("block.grindstone.use"); } catch (e) {}
    rec.key = null;
    try { grdRefresh(rec); } catch (e) {}
    return true;
  } catch (e) { return true; }
}
function grdSalvage() {
  // return both input slots to the player (anvil salvage precedent)
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:grindstone" || w._grdSalvaged) return;
    w._grdSalvaged = true;
    for (let i = 0; i <= 1; i++) {
      let s = null;
      try { s = w.get(i); } catch (e) {}
      if (!s || !s.id) continue;
      try { w.put(i, null); } catch (e) {}
      const cp = { id: s.id, count: s.count | 0 || 1 };
      if (s.damage) cp.damage = s.damage | 0;
      if (s.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(s.nbt)); } catch (e) { try { cp.nbt = s.nbt; } catch (e2) {} } }
      let left = cp.count;
      try {
        const v = inv();
        if (v && typeof v.addToInventory === "function") { v.addToInventory(cp); left = cp.count | 0; }
      } catch (e) {}
      if (left > 0) {
        try {
          const v = inv();
          let placed = false;
          if (v && v.main) {
            for (let j = 0; j < v.main.length && !placed; j++) {
              if (!v.main[j]) { v.main[j] = { id: cp.id, count: left }; if (cp.damage) v.main[j].damage = cp.damage; if (cp.nbt) v.main[j].nbt = cp.nbt; placed = true; }
            }
          }
          if (!placed) {
            const p = game().player;
            const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
            if (id != null && cp.nbt) {
              try {
                const e = game().entities.get(id);
                if (e && e.item) e.item.nbt = cp.nbt;
              } catch (e) {}
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}
function grdClose() {
  try {
    SV.openGrd = null;
    const g = game(), w = g && g.window;
    if (w && w.type === "minecraft:grindstone") {
      try { grdSalvage(); } catch (e) {}
      try { g.on_close_window({ windowId: w.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
  } catch (e) { try { SV.openGrd = null; } catch (e2) {} }
}
function grdTickWindow() {
  try {
    const rec = SV.openGrd;
    if (!rec) return;
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:grindstone" || (w.windowId | 0) !== (rec.wid | 0)) { SV.openGrd = null; return; }
    let ok = true;
    try {
      const p = g.player;
      const dx = p.x - (rec.x + 0.5), dy = p.y - (rec.y + 0.5), dz = p.z - (rec.z + 0.5);
      if (dx * dx + dy * dy + dz * dz > 64) ok = false;
    } catch (e) {}
    try {
      if (blockNameAt(rec.x, rec.y, rec.z) !== "grindstone") ok = false;
    } catch (e) {}
    if (!ok) { grdClose(); return; }
    grdRefresh(rec);
  } catch (e) {}
}
function openGrd(x, y, z) {
  try {
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (SV.openGrd) { try { grdClose(); } catch (e) {} }
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:grindstone", windowTitle: { text: "Grindstone" }, slotCount: 3, entityId: 0 });
    const w = g.window;
    if (!w || w.type !== "minecraft:grindstone") return false;
    const rec = SV.openGrd = { x: x | 0, y: y | 0, z: z | 0, wid: 1, key: null, xp: 0, frame: 0 };
    w.properties = w.properties || {};
    try {
      const scr = g.screens && g.screens.current;
      if (scr && !scr._grdWrapped) {
        scr._grdWrapped = true;
        if (typeof scr.tick === "function" && !scr.tick._grdWrapped) {
          const origTick = scr.tick.bind(scr);
          const tickFn = function () { try { origTick(); } catch (e) {} try { grdTickWindow(); } catch (e) {} };
          tickFn._grdWrapped = true; scr.tick = tickFn;
        }
        if (typeof w.slotClick === "function" && !w.slotClick._grdWrapped) {
          const origSC = w.slotClick.bind(w);
          const scFn = function (slotId, button, mode) {
            try {
              if ((slotId | 0) === 2 && (mode | 0) !== 5) {
                const m = mode | 0;
                if (m === 0 || m === 1) {
                  let done = true;
                  try { done = grdTake(SV.openGrd, m); } catch (e) { done = true; }
                  if (done) return null;
                } else {
                  return null;
                }
              }
            } catch (e) {}
            return origSC(slotId, button, mode);
          };
          scFn._grdWrapped = true; w.slotClick = scFn;
        }
        const wraps = ["onClose", "close"];
        for (const kk of wraps) {
          try {
            if (typeof scr[kk] === "function" && !scr[kk]._grdWrapped) {
              const orig = scr[kk].bind(scr);
              const fn = function () {
                try { grdSalvage(); } catch (e) {}
                return orig();
              };
              fn._grdWrapped = true; scr[kk] = fn;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    grdRefresh(rec);
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- stonecutter (Phase C inc 4):
 * JE 1.15 stonecutting over the native window. The engine renders the
 * recipe grid from stonecutterRecipes(game, input), which reads
 * game.serverRecipes — null offline — so survival drives everything: a
 * wrapped scr.recipes() serves our JE table, selection clicks are captured
 * off the screen's own grid math, and result takes are manual (the
 * engine's offline take path would eat the input with no result).
 * 1 input -> 1 output, slabs x2 (vanilla counts).
 */
const STONE_CUT = {
  stone: [["stone_stairs", 1], ["stone_slab", 2], ["stone_bricks", 1], ["stone_brick_stairs", 1], ["stone_brick_slab", 2], ["stone_brick_wall", 1], ["chiseled_stone_bricks", 1]],
  granite: [["polished_granite", 1], ["granite_stairs", 1], ["granite_slab", 2], ["granite_wall", 1]],
  polished_granite: [["polished_granite_stairs", 1], ["polished_granite_slab", 2]],
  diorite: [["polished_diorite", 1], ["diorite_stairs", 1], ["diorite_slab", 2], ["diorite_wall", 1]],
  polished_diorite: [["polished_diorite_stairs", 1], ["polished_diorite_slab", 2]],
  andesite: [["polished_andesite", 1], ["andesite_stairs", 1], ["andesite_slab", 2], ["andesite_wall", 1]],
  polished_andesite: [["polished_andesite_stairs", 1], ["polished_andesite_slab", 2]],
  cobblestone: [["cobblestone_stairs", 1], ["cobblestone_slab", 2], ["cobblestone_wall", 1]],
  mossy_cobblestone: [["mossy_cobblestone_stairs", 1], ["mossy_cobblestone_slab", 2], ["mossy_cobblestone_wall", 1]],
  stone_bricks: [["stone_brick_stairs", 1], ["stone_brick_slab", 2], ["stone_brick_wall", 1], ["chiseled_stone_bricks", 1]],
  mossy_stone_bricks: [["mossy_stone_brick_stairs", 1], ["mossy_stone_brick_slab", 2], ["mossy_stone_brick_wall", 1]],
  sandstone: [["sandstone_stairs", 1], ["sandstone_slab", 2], ["sandstone_wall", 1], ["chiseled_sandstone", 1], ["cut_sandstone", 1]],
  cut_sandstone: [["cut_sandstone_slab", 2]],
  red_sandstone: [["red_sandstone_stairs", 1], ["red_sandstone_slab", 2], ["red_sandstone_wall", 1], ["chiseled_red_sandstone", 1], ["cut_red_sandstone", 1]],
  cut_red_sandstone: [["cut_red_sandstone_slab", 2]],
  smooth_stone: [["smooth_stone_slab", 2]],
  smooth_sandstone: [["smooth_sandstone_stairs", 1], ["smooth_sandstone_slab", 2]],
  smooth_red_sandstone: [["smooth_red_sandstone_stairs", 1], ["smooth_red_sandstone_slab", 2]],
  smooth_quartz: [["smooth_quartz_stairs", 1], ["smooth_quartz_slab", 2]],
  bricks: [["brick_stairs", 1], ["brick_slab", 2], ["brick_wall", 1]],
  prismarine: [["prismarine_stairs", 1], ["prismarine_slab", 2]],
  prismarine_bricks: [["prismarine_brick_stairs", 1], ["prismarine_brick_slab", 2]],
  dark_prismarine: [["dark_prismarine_stairs", 1], ["dark_prismarine_slab", 2]],
  nether_bricks: [["nether_brick_stairs", 1], ["nether_brick_slab", 2], ["nether_brick_wall", 1], ["nether_brick_fence", 1]],
  red_nether_bricks: [["red_nether_brick_stairs", 1], ["red_nether_brick_slab", 2], ["red_nether_brick_wall", 1]],
  end_stone_bricks: [["end_stone_brick_stairs", 1], ["end_stone_brick_slab", 2], ["end_stone_brick_wall", 1]],
  quartz_block: [["quartz_stairs", 1], ["quartz_slab", 2], ["chiseled_quartz_block", 1], ["quartz_pillar", 1]],
  purpur_block: [["purpur_stairs", 1], ["purpur_slab", 2], ["purpur_pillar", 1]],
};
function stoneEntries(inputName) {
  // engine-shaped entries ({data:{result:{id,count}}}) sorted like the
  // engine sorts (by result translation key ~ result name here)
  try {
    const rows = STONE_CUT[inputName];
    if (!rows) return [];
    const out = [];
    for (const r of rows) {
      const id = itemIdByName(r[0]);
      if (id == null) continue;
      out.push({ data: { result: { id: id, count: r[1] | 0 || 1 } } });
    }
    out.sort((a, b) => {
      try {
        const na = stackName({ id: a.data.result.id }), nb = stackName({ id: b.data.result.id });
        return na < nb ? -1 : na > nb ? 1 : a.data.result.count - b.data.result.count;
      } catch (e) { return 0; }
    });
    return out;
  } catch (e) { return []; }
}
function stoneRefresh(rec) {
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:stonecutter" || !rec) return;
    const inp = w.get(0);
    const nm = inp && inp.id ? stackName(inp) : null;
    const key = JSON.stringify([inp && inp.id ? [inp.id, inp.count | 0] : null, rec.sel | 0]);
    rec.frame = (rec.frame | 0) + 1;
    if (key === rec.key && (rec.frame % 30) !== 0) return;
    rec.key = key;
    rec.entries = stoneEntries(nm);
    if ((rec.sel | 0) >= rec.entries.length) rec.sel = 0;
    if (!rec.entries.length) rec.sel = 0;
    w.properties = w.properties || {};
    try { w.properties[0] = rec.sel | 0; } catch (e) {}
    const pick = rec.entries[rec.sel | 0];
    try { w.put(1, pick ? { id: pick.data.result.id, count: pick.data.result.count | 0 || 1 } : null); } catch (e) {}
  } catch (e) {}
}
function stoneTake(rec, mode) {
  // manual result take (the engine's offline take eats the input and clears
  // the result): swallow the click so the engine can never run it.
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:stonecutter" || !rec) return true;
    try { stoneRefresh(rec); } catch (e) {}
    const out = w.get(1);
    if (!out || !out.id) return true;
    const v = inv();
    if (!v) return true;
    if ((mode | 0) === 1) {
      if (!anvFits(v, out)) return true;
    } else if (v.cursor && v.cursor.id) {
      return true; // occupied cursor: vanilla does nothing
    }
    try {
      const inp = w.get(0);
      if (inp && inp.id) {
        inp.count = (inp.count | 0) - 1;
        if (inp.count <= 0) { try { w.put(0, null); } catch (e) {} }
      }
    } catch (e) {}
    const cp = { id: out.id, count: out.count | 0 || 1 };
    if ((mode | 0) === 1) {
      try { v.addToInventory(cp); } catch (e) {}
      let left = cp.count | 0;
      if (left > 0) {
        try {
          const p = game().player;
          const id = spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
          if (id != null && cp.nbt) {
            try { const e = game().entities.get(id); if (e && e.item) e.item.nbt = cp.nbt; } catch (e) {}
          }
        } catch (e) {}
      }
    } else {
      try { v.cursor = cp; } catch (e) { return true; }
    }
    rec.key = null;
    try { stoneRefresh(rec); } catch (e) {}
    try { sfx("ui.stonecutter.take_result"); } catch (e) {}
    return true;
  } catch (e) { return true; }
}
function stoneSalvage() {
  // return the input slot to the player (grindstone salvage precedent)
  try {
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:stonecutter" || w._stoneSalvaged) return;
    w._stoneSalvaged = true;
    let s = null;
    try { s = w.get(0); } catch (e) {}
    if (!s || !s.id) return;
    try { w.put(0, null); } catch (e) {}
    const cp = { id: s.id, count: s.count | 0 || 1 };
    if (s.damage) cp.damage = s.damage | 0;
    if (s.nbt) { try { cp.nbt = JSON.parse(JSON.stringify(s.nbt)); } catch (e) { try { cp.nbt = s.nbt; } catch (e2) {} } }
    let left = cp.count;
    try {
      const v = inv();
      if (v && typeof v.addToInventory === "function") { v.addToInventory(cp); left = cp.count | 0; }
    } catch (e) {}
    if (left > 0) {
      try {
        const p = game().player;
        spawnItemEntity(p.x, p.y + 1, p.z, cp.id, left);
      } catch (e) {}
    }
  } catch (e) {}
}
function stoneClose() {
  try {
    SV.openStone = null;
    const g = game(), w = g && g.window;
    if (w && w.type === "minecraft:stonecutter") {
      try { stoneSalvage(); } catch (e) {}
      try { g.on_close_window({ windowId: w.windowId }); } catch (e) {}
      try { g.window = null; } catch (e) {}
    }
  } catch (e) { try { SV.openStone = null; } catch (e2) {} }
}
function stoneTickWindow() {
  try {
    const rec = SV.openStone;
    if (!rec) return;
    const g = game(), w = g && g.window;
    if (!w || w.type !== "minecraft:stonecutter" || (w.windowId | 0) !== (rec.wid | 0)) { SV.openStone = null; return; }
    let ok = true;
    try {
      const p = g.player;
      const dx = p.x - (rec.x + 0.5), dy = p.y - (rec.y + 0.5), dz = p.z - (rec.z + 0.5);
      if (dx * dx + dy * dy + dz * dz > 64) ok = false;
    } catch (e) {}
    try {
      if (blockNameAt(rec.x, rec.y, rec.z) !== "stonecutter") ok = false;
    } catch (e) {}
    if (!ok) { stoneClose(); return; }
    stoneRefresh(rec);
  } catch (e) {}
}
function openStone(x, y, z) {
  try {
    const g = game();
    if (!g || typeof g.on_open_window !== "function") return false;
    if (SV.openStone) { try { stoneClose(); } catch (e) {} }
    if (g.window) { try { g.on_close_window({ windowId: g.window.windowId }); } catch (e) {} try { g.window = null; } catch (e) {} }
    g.on_open_window({ windowId: 1, inventoryType: "minecraft:stonecutter", windowTitle: { text: "Stonecutter" }, slotCount: 2, entityId: 0 });
    const w = g.window;
    if (!w || w.type !== "minecraft:stonecutter") return false;
    const rec = SV.openStone = { x: x | 0, y: y | 0, z: z | 0, wid: 1, key: null, sel: 0, entries: [], frame: 0 };
    w.properties = w.properties || {};
    try {
      const scr = g.screens && g.screens.current;
      if (scr && !scr._stoneWrapped) {
        scr._stoneWrapped = true;
        // serve our JE table to the engine's recipe grid (serverRecipes
        // is null offline, so the grid would otherwise stay empty)
        try {
          scr.recipes = function () {
            try {
              const ww = game().window;
              const inp = ww && ww.get(0);
              const r2 = SV.openStone;
              const nm2 = inp && inp.id ? stackName(inp) : null;
              if (!r2 || r2.inputName !== nm2) {
                const list = stoneEntries(nm2);
                if (r2) { r2.entries = list; r2.inputName = nm2; }
                return list;
              }
              return r2.entries || [];
            } catch (e) { return []; }
          };
        } catch (e) {}
        if (typeof scr.tick === "function" && !scr.tick._stoneWrapped) {
          const origTick = scr.tick.bind(scr);
          const tickFn = function () { try { origTick(); } catch (e) {} try { stoneTickWindow(); } catch (e) {} };
          tickFn._stoneWrapped = true; scr.tick = tickFn;
        }
        if (typeof w.slotClick === "function" && !w.slotClick._stoneWrapped) {
          const origSC = w.slotClick.bind(w);
          const scFn = function (slotId, button, mode) {
            try {
              if ((slotId | 0) === 1 && (mode | 0) !== 5) {
                const m = mode | 0;
                if (m === 0 || m === 1) {
                  let done = true;
                  try { done = stoneTake(SV.openStone, m); } catch (e) { done = true; }
                  if (done) return null;
                } else {
                  return null;
                }
              }
            } catch (e) {}
            return origSC(slotId, button, mode);
          };
          scFn._stoneWrapped = true; w.slotClick = scFn;
        }
        // capture recipe selection off the screen's own grid math (the
        // engine's handler dead-sends C.menuButton; we record locally)
        try {
          if (typeof scr.extraMouseDown === "function" && !scr.extraMouseDown._stoneWrapped) {
            const origEMD = scr.extraMouseDown.bind(scr);
            const emdFn = function (mx, my, button) {
              let r = false;
              try { r = origEMD(mx, my, button); } catch (e) {}
              try {
                const r2 = SV.openStone;
                if (r2 && (button | 0) === 0 && typeof scr.grid === "function") {
                  const gr = scr.grid();
                  if (gr && gr.stone) {
                    const lx = mx - scr.guiLeft, ly = my - scr.guiTop;
                    const inside = (vx, vy, vw, vh) => vx >= 0 && vy >= 0 && vx < vw && vy < vh;
                    if (inside(lx - gr.x, ly - gr.y, gr.w * 4, gr.h * gr.rows)) {
                      const idx = (scr.row | 0) * 4 + Math.floor((lx - gr.x) / gr.w) + Math.floor((ly - gr.y) / gr.h) * 4;
                      if (idx >= 0 && idx < (r2.entries || []).length) {
                        r2.sel = idx; r2.key = null;
                        try { stoneRefresh(r2); } catch (e) {}
                      }
                    }
                  }
                }
              } catch (e) {}
              return r;
            };
            emdFn._stoneWrapped = true; scr.extraMouseDown = emdFn;
          }
        } catch (e) {}
        const wraps = ["onClose", "close"];
        for (const kk of wraps) {
          try {
            if (typeof scr[kk] === "function" && !scr[kk]._stoneWrapped) {
              const orig = scr[kk].bind(scr);
              const fn = function () {
                try { stoneSalvage(); } catch (e) {}
                return orig();
              };
              fn._stoneWrapped = true; scr[kk] = fn;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    stoneRefresh(rec);
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- composter + bell (Phase C inc 4):
 * stateless: levels live in the block state itself (minStateId + level),
 * so no tile, no persist changes, nothing to spill on break.
 */
const COMPOST = {
  // JE ComposterBlock chances (wiki): 0.3 scraps, 0.5 plants, 0.65 crops,
  // 0.85 rich foods, 1.0 always (cake/pumpkin pie).
  wheat_seeds: 0.3, beetroot_seeds: 0.3, melon_seeds: 0.3, pumpkin_seeds: 0.3,
  grass: 0.3, tall_grass: 0.3, fern: 0.3, large_fern: 0.3, seagrass: 0.3,
  oak_sapling: 0.3, spruce_sapling: 0.3, birch_sapling: 0.3, jungle_sapling: 0.3, acacia_sapling: 0.3, dark_oak_sapling: 0.3,
  cactus: 0.5, sugar_cane: 0.5, vine: 0.5, lily_pad: 0.5, melon_slice: 0.5, kelp: 0.5, dried_kelp: 0.5,
  dandelion: 0.65, poppy: 0.65, blue_orchid: 0.65, allium: 0.65, azure_bluet: 0.65,
  red_tulip: 0.65, orange_tulip: 0.65, white_tulip: 0.65, pink_tulip: 0.65,
  oxeye_daisy: 0.65, cornflower: 0.65, lily_of_the_valley: 0.65, wither_rose: 0.65,
  sunflower: 0.65, lilac: 0.65, rose_bush: 0.65, peony: 0.65,
  red_mushroom: 0.65, brown_mushroom: 0.65, carrot: 0.65, apple: 0.65,
  wheat: 0.85, hay_block: 0.85, cookie: 0.85, mossy_cobblestone: 0.85, mossy_stone_bricks: 0.85,
  cake: 1.0, pumpkin_pie: 1.0, bread: 1.0,
};
function compostChance(nm) {
  if (!nm) return 0;
  if (COMPOST[nm] != null) return COMPOST[nm];
  try {
    if (nm.slice(-7) === "_leaves" || nm.slice(-8) === "_sapling") return 0.3; // any leaf/sapling
    if (nm.slice(-7) === "_flower" || nm.slice(-6) === "_tulip") return 0.65; // modded-ish names
  } catch (e) {}
  return 0;
}
function useComposter(t) {
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const def = defOf(st);
    if (!def || def.name !== "composter") return false;
    const n = (def.maxStateId | 0) - (def.minStateId | 0) + 1;
    if (n !== 9) return false; // not the level-0..8 block we know
    let lvl = (st | 0) - (def.minStateId | 0);
    if (lvl >= 8) {
      // ready: dispense one bone meal, empty back to 0 (vanilla)
      const boneId = itemIdByName("bone_meal");
      if (boneId == null) return false;
      SV.grief = true;
      try { g.world.setState(t.x, t.y, t.z, def.minStateId | 0); } finally { SV.grief = false; }
      try { spawnItemEntity(t.x + 0.5, t.y + 1.1, t.z + 0.5, boneId, 1); } catch (e) {}
      try { sfx("block.composter.empty"); } catch (e) {}
      return true;
    }
    const ch = compostChance(heldName());
    if (!(ch > 0)) return false; // not compostable: pass through
    const creative = !!(g.player && g.player.creative);
    if (!creative) { try { consumeHeld(1); } catch (e) {} }
    if (Math.random() < ch) {
      lvl = Math.min(8, lvl + 1);
      SV.grief = true;
      try { g.world.setState(t.x, t.y, t.z, (def.minStateId | 0) + lvl); } finally { SV.grief = false; }
      try { sfx("block.composter.fill_success"); } catch (e) {}
    } else {
      try { sfx("block.composter.fill"); } catch (e) {}
    }
    return true;
  } catch (e) { return false; }
}
function ringBell(t) {
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const def = defOf(st);
    if (!def || def.name !== "bell") return false;
    try { sfx("block.bell.use"); } catch (e) {}
    // villagers startle (shared hurt-flee path, radius 24 — vanilla hides
    // them indoors; ours have no indoor AI yet, so flee doubles as cover)
    try {
      const bx = t.x + 0.5, by = t.y + 0.5, bz = t.z + 0.5;
      SV.mobs.forEach((m) => {
        try {
          if (!m || !m.def || (m.def.name !== "villager" && m.def.type !== 85)) return;
          const dx = m.x - bx, dy = (m.y || by) - by, dz = m.z - bz;
          if (dx * dx + dy * dy + dz * dz < 576) m.flee = Date.now();
        } catch (e) {}
      });
    } catch (e) {}
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- nether portals + dimension travel (Phase A)
 *
 * Lighting: flint-and-steel (or any fire) placed inside a complete 4x5
 * obsidian frame fills the 2x3 interior with nether_portal (vanilla shape,
 * both orientations). Decay: a portal block whose frame lost an obsidian
 * block is flood-removed. Travel: the singleplayer looper calls portalTick()
 * in ANY mode (creative included) when engine portalTime fills; we 8:1 the
 * coords, jump dimensions, and land in (or build + link) a return portal.
 * Per-dimension entity stashes keep each side's items/boats/carts/horses/
 * tiles: the shared flat rec fields always describe the CURRENT dimension.
 */
const PORTAL_D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
let SV_portalIds = null;
function portalIds() {
  if (SV_portalIds) return SV_portalIds;
  try {
    const out = { obs: 0, px: 0, pz: 0 };
    for (const b of game().assets.data.blocks) {
      if (!b) continue;
      if (b.name === "obsidian") out.obs = b.defaultState;
      else if (b.name === "nether_portal") {
        out.px = b.defaultState;
        out.pz = (b.maxStateId > b.defaultState) ? b.defaultState + 1 : b.defaultState;
      }
    }
    if (out.obs && out.px) SV_portalIds = out;
    return out.obs && out.px ? out : null;
  } catch (e) { return null; }
}
function lightPortalAt(x, y, z) {
  const g = game(), ids = portalIds();
  if (!ids || !ids.obs) return false;
  const st = (bx, by, bz) => { try { return g.world.getState(bx, by, bz); } catch (e) { return -1; } };
  const isOpen = (v) => {
    if (v === 0) return true;
    try { return defOf(v).name === "fire"; } catch (e) { return false; }
  };
  const at = (axis, a, yy, f) => axis === "x" ? st(a, yy, f) : st(f, yy, a);
  const put = (axis, a, yy, f, v) => {
    SV.grief = true;
    try { if (axis === "x") g.world.setState(a, yy, f, v); else g.world.setState(f, yy, a, v); }
    finally { SV.grief = false; }
  };
  for (const axis of ["x", "z"]) {
    const pst = axis === "x" ? ids.px : ids.pz;
    if (!pst) continue;
    const a = axis === "x" ? x : z, f = axis === "x" ? z : x;
    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 3; iy++) {
        const a0 = a - 1 - ix, y0 = y - 1 - iy;
        let ok = true;
        for (let da = 0; da < 4 && ok; da++) {
          for (let dy = 0; dy < 5 && ok; dy++) {
            const edge = da === 0 || da === 3 || dy === 0 || dy === 4;
            const v = at(axis, a0 + da, y0 + dy, f);
            if (v === -1) { ok = false; break; }
            if (edge) { if (v !== ids.obs) ok = false; }
            else if (!isOpen(v)) ok = false;
          }
        }
        if (!ok) continue;
        for (let da = 1; da <= 2; da++)
          for (let dy = 1; dy <= 3; dy++) put(axis, a0 + da, y0 + dy, f, pst);
        try { g.sound.play("block.portal.trigger"); } catch (e) {}
        return true;
      }
    }
  }
  return false;
}
// true = some placement of the 4x5 frame around (bx,by,bz) is still complete
// (missing chunks read as -1 and count as "can't tell" -> valid, no decay)
function portalFrameValid(bx, by, bz, pst) {
  const g = game(), ids = portalIds();
  if (!ids || !ids.obs) return true;
  const axis = (pst === ids.pz) ? "z" : "x";
  const a = axis === "x" ? bx : bz, f = axis === "x" ? bz : bx;
  const st = (aa, yy) => {
    try { return axis === "x" ? g.world.getState(aa, yy, f) : g.world.getState(f, yy, aa); }
    catch (e) { return -1; }
  };
  for (let ix = 0; ix < 2; ix++) {
    for (let iy = 0; iy < 3; iy++) {
      const a0 = a - 1 - ix, y0 = by - 1 - iy;
      let ok = true;
      for (let da = 0; da < 4 && ok; da++) {
        for (let dy = 0; dy < 5 && ok; dy++) {
          if (da > 0 && da < 3 && dy > 0 && dy < 4) continue; // interior, don't care
          const v = st(a0 + da, y0 + dy);
          if (v === -1) return true;
          if (v !== ids.obs) ok = false;
        }
      }
      if (ok) return true;
    }
  }
  return false;
}
function portalDecayTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld) return;
    const p = g.player;
    if (!p) return;
    const ids = portalIds();
    if (!ids || !ids.obs) return;
    const R = 6, bx0 = Math.floor(p.x), by0 = Math.floor(p.y), bz0 = Math.floor(p.z);
    const seen = new Set();
    for (let ox = -R; ox <= R; ox++) {
      for (let oy = -R; oy <= R; oy++) {
        for (let oz = -R; oz <= R; oz++) {
          const bx = bx0 + ox, by = by0 + oy, bz = bz0 + oz;
          const k = bx + "," + by + "," + bz;
          if (seen.has(k)) continue;
          let v = 0;
          try { v = g.world.getState(bx, by, bz); } catch (e) { continue; }
          if (v !== ids.px && v !== ids.pz) continue;
          if (portalFrameValid(bx, by, bz, v)) continue;
          // frame broken: flood-remove the connected portal blob
          seen.add(k);
          const stack = [[bx, by, bz]];
          let n = 0;
          SV.grief = true;
          try {
            while (stack.length && n < 40) {
              const c = stack.pop();
              n++;
              for (const o of PORTAL_D) {
                const nx = c[0] + o[0], ny = c[1] + o[1], nz = c[2] + o[2];
                const k2 = nx + "," + ny + "," + nz;
                if (seen.has(k2)) continue;
                let vv = 0;
                try { vv = g.world.getState(nx, ny, nz); } catch (e) { continue; }
                if (vv === ids.px || vv === ids.pz) { seen.add(k2); stack.push([nx, ny, nz]); }
              }
            }
            for (const k2 of seen) {
              const c = k2.split(",");
              try { g.world.setState(+c[0], +c[1], +c[2], 0); } catch (e) {}
            }
          } finally { SV.grief = false; }
        }
      }
    }
  } catch (e) {}
}
// water touching lava (either side placed) -> the lava becomes obsidian.
// This is the survival path to portal frames: lava pit + water bucket.
function lavaMixAt(x, y, z, old, s) {
  const sp = SP();
  if (!sp || !sp.active || sp.gen) return; // never during worldgen fills
  let nm = "";
  try { const d = defOf(s); nm = d ? d.name : ""; } catch (e) {}
  if (nm !== "water" && nm !== "lava") return;
  const g = game();
  let obs = 0;
  try {
    for (const b of g.assets.data.blocks) {
      if (b && b.name === "obsidian") { obs = b.defaultState; break; }
    }
  } catch (e) {}
  if (!obs) return;
  const hit = (bx, by, bz) => {
    SV.grief = true;
    try { g.world.setState(bx, by, bz, obs); } finally { SV.grief = false; }
    try { g.sound.play("block.lava.extinguish"); } catch (e) {}
    try { sp.dirty = true; } catch (e) {}
  };
  if (nm === "lava") {
    for (const o of PORTAL_D) {
      let nn = "";
      try { nn = blockNameAt(x + o[0], y + o[1], z + o[2]); } catch (e) {}
      if (nn === "water") { hit(x, y, z); return; }
    }
    return;
  }
  for (const o of PORTAL_D) {
    let nn = "";
    try { nn = blockNameAt(x + o[0], y + o[1], z + o[2]); } catch (e) {}
    if (nn === "lava") hit(x + o[0], y + o[1], z + o[2]);
  }
}
// v1.15.0: dry sponge soaks up nearby water (vanilla: BFS through connected
// water, soaked blocks become air, sponge -> wet_sponge). Cap 65 blocks at
// taxicab distance <= 7 from the sponge. Writes ride the SV.grief path like
// lavaMixAt (no journal/place recursion); wet sponge + sfx when soaked.
function spongeSoakAt(x, y, z, s) {
  const sp = SP();
  if (!sp || !sp.active || sp.gen) return;
  let nm = "";
  try { const d = defOf(s); nm = d ? d.name : ""; } catch (e) {}
  if (nm !== "sponge") return;
  const g = game();
  const seen = new Set(), found = [];
  const key = (bx, by, bz) => bx + "," + by + "," + bz;
  let frontier = [[x, y, z]];
  seen.add(key(x, y, z));
  while (frontier.length && found.length < 65) {
    const next = [];
    for (const [cx, cy, cz] of frontier) {
      const md = Math.abs(cx - x) + Math.abs(cy - y) + Math.abs(cz - z);
      if (md > 7) continue;
      for (const o of PORTAL_D) {
        const bx = cx + o[0], by = cy + o[1], bz = cz + o[2];
        const k = key(bx, by, bz);
        if (seen.has(k)) continue;
        seen.add(k);
        if (Math.abs(bx - x) + Math.abs(by - y) + Math.abs(bz - z) > 7) continue;
        let wn = "";
        try { wn = blockNameAt(bx, by, bz); } catch (e) {}
        if (wn === "water") {
          found.push([bx, by, bz]);
          if (found.length >= 65) break;
          next.push([bx, by, bz]);
        }
      }
      if (found.length >= 65) break;
    }
    frontier = next;
  }
  if (!found.length) return;
  let wet = 0;
  try {
    for (const b of g.assets.data.blocks) {
      if (b && b.name === "wet_sponge") { wet = b.defaultState; break; }
    }
  } catch (e) {}
  if (!wet) return;
  SV.grief = true;
  try {
    for (const [bx, by, bz] of found) {
      try { g.world.setState(bx, by, bz, 0); } catch (e) {}
    }
    try { g.world.setState(x | 0, y | 0, z | 0, wet); } catch (e) {}
  } finally { SV.grief = false; }
  try { g.sound.play("block.sponge.absorb"); } catch (e) {}
  try { sp.dirty = true; } catch (e) {}
}
// v1.15.0 conduits: placed conduit blocks register in SV.conduits (frame
// validated live by conduitTick — no stale-frame bugs). Frame = vanilla
// 5x5x5 shell rings (42 valid cells across the 3 axis planes); 16 = minimal
// ring. Active conduits in water (or rain) grant Conduit Power in radius
// (16->32, 28->64, 42->96 blocks) with water-oxygen, and a full 42-frame
// zaps hostiles within 8 blocks like vanilla.
function conduitIsFrame(name) {
  return name === "prismarine" || name === "prismarine_bricks" ||
    name === "dark_prismarine" || name === "sea_lantern";
}
function conduitFrameCount(x, y, z) {
  let n = 0;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      if (Math.max(Math.abs(a), Math.abs(b)) !== 2) continue;
      let n1 = "", n2 = "", n3 = "";
      try { n1 = blockNameAt(x + a, y, z + b); } catch (e) {}
      try { n2 = blockNameAt(x + a, y + b, z); } catch (e) {}
      try { n3 = blockNameAt(x, y + a, z + b); } catch (e) {}
      if (conduitIsFrame(n1)) n++;
      if (conduitIsFrame(n2)) n++;
      if (conduitIsFrame(n3)) n++;
    }
  }
  return n;
}
function conduitTrack(x, y, z, state) {
  // place (new state) + break (old state) share this: only conduit blocks
  // register/unregister; frame blocks are validated live, never stored.
  try {
    const sp = SP();
    if (!sp || !sp.active || sp.gen) return;
    const d = defOf(state);
    if (!d || d.name !== "conduit") return;
    SV.conduits = SV.conduits || new Map();
    const k = (x | 0) + "," + (y | 0) + "," + (z | 0);
    try {
      const cur = blockNameAt(x, y, z);
      if (cur === "conduit") SV.conduits.set(k, { x: x | 0, y: y | 0, z: z | 0 });
      else SV.conduits.delete(k);
    } catch (e) {}
  } catch (e) {}
}
function conduitTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0 || SV.dead) return;
    if (!SV.conduits || !SV.conduits.size) return;
    const p = g.player;
    if (!p) return;
    const wetHere = (x, y, z) => {
      // the conduit cell itself holds the conduit block (our engine has no
      // waterlogging), so "in water" reads as water on any of the 6
      // neighbors — the frame ring always qualifies when submerged.
      try {
        for (const o of PORTAL_D) {
          try { if (liquidAt(x + o[0], y + o[1], z + o[2]) === "water") return true; } catch (e) {}
        }
      } catch (e) {}
      try { if (isRainingAt(x, y, z)) return true; } catch (e) {}
      return false;
    };
    for (const [k, c] of Array.from(SV.conduits.entries())) {
      let nm = "";
      try { nm = blockNameAt(c.x, c.y, c.z); } catch (e) {}
      if (nm !== "conduit") { try { SV.conduits.delete(k); } catch (e) {} continue; }
      if (!wetHere(c.x, c.y, c.z)) continue;
      let frame = 0;
      try { frame = conduitFrameCount(c.x, c.y, c.z); } catch (e) {}
      if (frame < 16) continue;
      const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
      const R = frame >= 42 ? 96 : frame >= 28 ? 64 : 32;
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      // durations cover several tick periods so a slow sim (streaming /
      // night-horde contention can stretch the 2s cadence wall-clock) never
      // lets the effect lapse while the player stays in radius
      addFx("conduit_power", 1, 400); // refreshed every 2s tick
      try { SV.air = 15; } catch (e) {} // conduit oxygen (vanilla)
      try { g.effects.set(29, { amplifier: 0, duration: 400, hideParticles: false, ambient: false, showIcon: true, start: g.ticks }); } catch (e) {}
      if (frame >= 42) {
        // full frame zaps hostiles within 8 (vanilla 4 dmg)
        try {
          SV.mobs.forEach((m) => {
            if (!m || !m.def.hostile || m.hp <= 0) return;
            const hx = m.x - c.x, hy = m.y - c.y, hz = m.z - c.z;
            if (hx * hx + hy * hy + hz * hz <= 64) {
              try { damageMob(m.id, 4, hx, hz, {}); } catch (e) {}
            }
          });
        } catch (e) {}
      }
    }
  } catch (e) {}
}
// P4: sculk shriekers warn then summon a warden (vanilla: 4 warnings in
// 10 min escalate; we compress to rapid warnings while the player makes
// noise nearby). Cap 1 warden within 48 blocks. Darkness closes in.
function shriekerTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0 || SV.dead) return;
    if ((g.dimension | 0) !== 0) return;
    if (difficulty() === 0) return;
    const p = g.player;
    if (!p) return;
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
    // player noise: moved since last check or falling/jumping
    const moved = (SV.shriekPX == null) ||
      Math.abs(p.x - SV.shriekPX) + Math.abs(p.z - SV.shriekPZ) > 0.3 ||
      Math.abs((p.motionY || 0)) > 0.5;
    SV.shriekPX = p.x; SV.shriekPZ = p.z;
    if (!moved) return;
    // sample positions in 16r for a live shrieker block
    let found = null;
    for (let i = 0; i < 40; i++) {
      const ox = (Math.random() * 32 - 16) | 0, oz = (Math.random() * 32 - 16) | 0;
      const oy = ((Math.random() * 9 - 4) | 0);
      if (blockNameAt(px + ox, py + oy, pz + oz) === "sculk_shrieker") {
        found = [px + ox, py + oy, pz + oz];
        break;
      }
    }
    if (!found) return;
    const now = Date.now();
    if ((SV.shriekUntil || 0) < now) SV.shriekLvl = 0;
    SV.shriekLvl = (SV.shriekLvl | 0) + 1;
    SV.shriekUntil = now + 600000;
    try { sfx("block.sculk_shrieker.shriek"); } catch (e) {}
    try { game().particles.nativeParticle("sculk_soul", found[0] + 0.5, found[1] + 1.2, found[2] + 0.5); } catch (e2) {}
    // darkness closes in from the second warning (vanilla effect 33).
    if (SV.shriekLvl >= 2) {
      try { g.effects.set(33, { amplifier: 0, duration: 400, hideParticles: false, ambient: false, showIcon: true, start: g.ticks }); } catch (e3) {}
    }
    if (SV.shriekLvl >= 4) {
      SV.shriekLvl = 0;
      // cap: no second warden within 48m
      let near = false;
      try {
        SV.mobs.forEach((m) => {
          if (m.species !== "warden" || m.hp <= 0) return;
          const dx = m.x - p.x, dz = m.z - p.z;
          if (dx * dx + dz * dz < 48 * 48) near = true;
        });
      } catch (e4) {}
      if (near) return;
      // emerge beside the shrieker (vanilla digs out of the ground).
      const gy = groundAt(found[0] + 0.5, found[2] + 0.5, found[1] + 1);
      const m = spawnMob("warden", found[0] + 0.5, (gy == null ? found[1] + 1 : gy + 0.1), found[2] + 0.5);
      if (m) {
        try { sfx("entity.warden.emerge"); } catch (e5) {}
        try { if (m.e) m.e.wildAnimationStart = m.e.ticks | 0; } catch (e6) {}
        m.angerLevel = 60;
      }
    }
  } catch (e) {}
}
// P4: frogspawn hatches into 2-4 tadpoles (vanilla) after ~5 min. Runs on the
// same 2s cadence as conduitTick; blocks persist as world diffs.
function frogspawnTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld || (sp.mode | 0) !== 0 || SV.dead) return;
    if (!SV.frogspawn || !SV.frogspawn.size) return;
    const now = Date.now();
    for (const [k, c] of Array.from(SV.frogspawn.entries())) {
      let nm = "";
      try { nm = blockNameAt(c.x, c.y, c.z); } catch (e) {}
      if (nm !== "frogspawn") { try { SV.frogspawn.delete(k); } catch (e) {} continue; }
      if ((c.until | 0) > now) continue;
      try { SV.frogspawn.delete(k); } catch (e) {}
      try { g.world.setState(c.x, c.y, c.z, 0); } catch (e) {}
      try { sfx("block.frogspawn.hatch"); } catch (e2) {}
      const n = 2 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) {
        try { spawnMob("tadpole", c.x + 0.5, c.y + 0.2, c.z + 0.5); } catch (e3) {}
      }
    }
  } catch (e) {}
}
// called from the singleplayer looper (every 400ms, any mode) once the
// engine's portalTime fills: jump + throttled decay scan.
function portalTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld) return;
    SV.portalScan = (SV.portalScan | 0) + 1;
    if (SV.portalScan % 12 === 0 || SV.portalCheck) {
      SV.portalCheck = 0;
      portalDecayTick();
    }
    if (SV.dead) return;
    if (Date.now() < (sp.portalCdUntil || 0)) return;
    if ((g.portalTime || 0) < 1) return;
    doPortalJump();
  } catch (e) {}
}
function doPortalJump() {
  const sp = SP(), g = game(), p = g.player;
  if (!sp || !g || !p) return;
  // engine dimension is truth (SP.dim can lag it across an exception);
  // switchDim reconciles all three
  const from = (g.dimension | 0) === -1 ? -1 : 0;
  const mc = globalThis.__mcSingleplayer;
  if (!mc || typeof mc.portalTarget !== "function") return;
  // the portal block we're standing in becomes the link source
  let src = { x: p.x, y: p.y, z: p.z };
  try {
    outer: for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -2; oy <= 2; oy++) {
        for (let oz = -2; oz <= 2; oz++) {
          if (blockNameAt(Math.floor(p.x) + ox, Math.floor(p.y) + oy, Math.floor(p.z) + oz) === "nether_portal") {
            src = { x: Math.floor(p.x) + ox + 0.5, y: Math.floor(p.y) + oy + 0.5, z: Math.floor(p.z) + oz + 0.5 };
            break outer;
          }
        }
      }
    }
  } catch (e) {}
  const t = mc.portalTarget(from, src.x, src.z);
  if (!t) return;
  try { dismountBoat(); } catch (e) {}
  try { dismountCart(); } catch (e) {}
  try { dismountHorse(); } catch (e) {}
  try { mc.switchDim(t.to, t.x, t.y, t.z, { portal: true, link: src }); } catch (e) { return; }
  try { chat(from === 0 ? "§eEntering the Nether..." : "§eLeaving the Nether..."); } catch (e) {}
}
// stash this dimension's loose entities + tiles into the world record and
// wipe the runtime tables (the world chunks are about to be swapped out).
function stashDim(dim) {
  if (!SV.on) return;
  try { persistAcc = 99; persistSurvState(); } catch (e) {}
  try {
    const sp = SP();
    if (!sp || !sp.id) return;
    const rec = loadWorldRecSv(sp.id);
    if (!rec) return;
    rec.dimEnt = rec.dimEnt || {};
    rec.dimEnt[dim] = {
      items: rec.items || null, boats: rec.boats || null,
      carts: rec.carts || null, horses: rec.horses || null,
      stands: rec.stands || null, tiles: rec.tiles || null,
    };
    try {
      // v1.15.0: conduits ride the dimension stash like tiles
      const cd = [];
      if (SV.conduits) SV.conduits.forEach((c) => {
        if (c && cd.length < 20) cd.push({ x: c.x | 0, y: c.y | 0, z: c.z | 0 });
      });
      rec.dimEnt[dim].conduits = cd;
    } catch (e) {}
    rec.items = null; rec.boats = null; rec.carts = null; rec.horses = null; rec.stands = null; rec.tiles = null;
    try { rec.conduits = null; } catch (e) {}
    saveWorldRecSv(sp.id, rec);
  } catch (e) {}
  try {
    const ids = [];
    SV.mobs.forEach((m) => ids.push(m.id));
    SV.items.forEach((it) => ids.push(it.id));
    SV.arrows.forEach((a) => ids.push(a.id));
    SV.orbs.forEach((o) => ids.push(o.id));
    if (SV.tnt) SV.tnt.forEach((r) => ids.push(r.id));
    if (SV.bobber) ids.push(SV.bobber.id);
    SV.boats.forEach((b) => ids.push(b.id));
    SV.carts.forEach((c) => ids.push(c.id));
    SV.horses.forEach((h) => ids.push(h.id));
    SV.stands.forEach((s) => ids.push(s.id));
    if (ids.length) game().entities.destroy(ids);
  } catch (e) {}
  try {
    SV.mobs.clear(); SV.items.clear(); SV.arrows.clear(); SV.orbs.clear();
    SV.boats.clear(); SV.rideBoat = -1;
    SV.carts.clear(); SV.rideCart = -1;
    SV.horses.clear(); SV.rideHorse = -1;
    SV.stands.clear();
    SV.eyes = [];
    SV.tiles = new Map();
    try { V_SEED.done.clear(); V_SEED.slots.clear(); } catch (e2) {}
    SV.crops.clear();
    if (SV.tnt) SV.tnt.clear();
    SV.bobber = null; SV.bowDraw = null;
    if (SV.trackedArrows) SV.trackedArrows.clear();
    // v1.16.0: crystals + clouds are dimension-local (End only) — destroy
    // their engine objects with the rest; the dragon re-seeds fresh
    try { if (SV.crystals) { SV.crystals.forEach((c) => { try { game().entities.destroy([c.id]); } catch (e) {} }); SV.crystals.clear(); } } catch (e) {}
    try { if (SV.clouds) { SV.clouds.forEach((c) => { try { game().entities.destroy([c.id]); } catch (e) {} }); SV.clouds.clear(); } } catch (e) {}
    try { SV.dragon = 0; } catch (e) {}
  } catch (e) {}
}
// restore a dimension's stashed entities + tiles (flat rec fields always
// describe the CURRENT dimension — see stashDim).
function unstashDim(dim) {
  if (!SV.on) return;
  try {
    const sp = SP();
    if (!sp || !sp.id) return;
    const rec = loadWorldRecSv(sp.id);
    const st = rec && rec.dimEnt && rec.dimEnt[dim];
    if (!st) { try { SV.tiles = new Map(); } catch (e) {} return; }
    rec.items = st.items || null; rec.boats = st.boats || null;
    rec.carts = st.carts || null; rec.horses = st.horses || null;
    rec.stands = st.stands || null; rec.tiles = st.tiles || null;
    try { rec.conduits = st.conduits || null; } catch (e) {}
    try { delete rec.dimEnt[dim]; } catch (e) {}
    saveWorldRecSv(sp.id, rec);
    try { restoreTiles(rec); } catch (e) {}
    try {
      SV.conduits = new Map();
      if (Array.isArray(rec.conduits)) for (const c of rec.conduits.slice(0, 20)) {
        if (c && isFinite(c.x) && isFinite(c.y) && isFinite(c.z)) {
          SV.conduits.set((c.x | 0) + "," + (c.y | 0) + "," + (c.z | 0), { x: c.x | 0, y: c.y | 0, z: c.z | 0 });
        }
      }
    } catch (e) { try { SV.conduits = new Map(); } catch (e2) {} }
    try {
      SV.frogspawn = new Map();
      if (Array.isArray(rec.frogspawn)) for (const c of rec.frogspawn.slice(0, 40)) {
        if (c && isFinite(c.x) && isFinite(c.y) && isFinite(c.z)) {
          SV.frogspawn.set((c.x | 0) + "," + (c.y | 0) + "," + (c.z | 0),
            { x: c.x | 0, y: c.y | 0, z: c.z | 0, until: c.until | 0 || Date.now() + 300000 });
        }
      }
    } catch (e) { try { SV.frogspawn = new Map(); } catch (e2) {} }
    SV.savedItems = rec.items; SV.savedBoats = rec.boats;
    SV.savedCarts = rec.carts; SV.savedHorses = rec.horses;
    SV.savedStands = rec.stands || null;
    try { rescanCropsFromOverrides(); } catch (e) {}
    setTimeout(() => {
      try { respawnSavedItems(); } catch (e) {}
      try { respawnSavedBoats(); } catch (e) {}
      try { respawnSavedCarts(); } catch (e) {}
      try { respawnSavedHorses(); } catch (e) {}
      try { respawnSavedStands(); } catch (e) {}
    }, 1500);
  } catch (e) {}
}

/* ---------------------------------------------------------- the End (Phase A)
 *
 * Stronghold portal rooms generate in the overworld (see singleplayer);
 * eyes of ender (item ender_eye) throw-and-fly toward them, slot into
 * frames, and a completed 12-eye ring fills with end_portal. Touching
 * end_portal jumps overworld<->End (fixed points, no 8:1 scaling); the
 * End-side touch returns to the overworld spawn (TEMP until the Phase E
 * exit portal). Per-dimension stashes already key by dim number, so the
 * shared flat rec fields keep describing the CURRENT dimension.
 */
let SV_endIds = null;
function endIds() {
  if (SV_endIds) return SV_endIds;
  try {
    const out = { portal: 0, gateway: 0, frameMin: 0, stride: 0, faces: ["north", "south", "west", "east"] };
    for (const b of game().assets.data.blocks) {
      if (!b) continue;
      if (b.name === "end_portal") out.portal = b.defaultState;
      else if (b.name === "end_gateway") out.gateway = b.defaultState; // v1.16.0
      else if (b.name === "end_portal_frame" && Array.isArray(b.states)) {
        const eyeI = b.states.findIndex((s) => s.name === "eye");
        let stride = 1;
        for (let i = eyeI + 1; i < b.states.length; i++) stride *= b.states[i].num_values;
        const face = b.states.find((s) => s.name === "facing");
        out.frameMin = b.minStateId; out.stride = stride;
        if (face && face.values) out.faces = face.values.slice();
      }
    }
    if (out.portal) SV_endIds = out;
    return out.portal ? out : null;
  } catch (e) { return null; }
}
function endEyeAt(st) {
  const E = endIds();
  if (!E) return false;
  return st >= E.frameMin + E.stride && st < E.frameMin + E.stride + E.faces.length;
}
function endFacingAt(st) {
  const E = endIds();
  if (!E) return "north";
  const n = E.faces.length;
  return E.faces[(((st - E.frameMin) % n) + n) % n] || "north";
}
function endFrameOf(facing, eye) {
  const E = endIds();
  if (!E) return 0;
  let fi = E.faces.indexOf(facing);
  if (fi < 0) fi = 0;
  return E.frameMin + (eye ? E.stride : 0) + fi;
}
// a complete 12-eye ring fills its 3x3 interior with end_portal (any
// orientation in the XZ plane; facing-agnostic since creators can't aim
// frames precisely offline). Missing chunks read as -1 and veto lighting.
function lightEndPortalAt(x, y, z) {
  const g = game(), E = endIds();
  if (!E) return false;
  const st = (bx, by, bz) => { try { return g.world.getState(bx, by, bz); } catch (e) { return -1; } };
  for (let ccx = x - 2; ccx <= x + 2; ccx++) {
    for (let ccz = z - 2; ccz <= z + 2; ccz++) {
      const ex = x - ccx, ez = z - ccz;
      if (Math.abs(ex) !== 2 && Math.abs(ez) !== 2) continue;
      if (Math.abs(ex) === 2 && Math.abs(ez) === 2) continue;
      let ok = true;
      for (let i = -2; i <= 2 && ok; i++) {
        for (let j = -2; j <= 2 && ok; j++) {
          const edge = Math.abs(i) === 2 || Math.abs(j) === 2;
          const corner = Math.abs(i) === 2 && Math.abs(j) === 2;
          if (!edge || corner) continue;
          const v = st(ccx + i, y, ccz + j);
          if (v === -1 || !endEyeAt(v)) ok = false;
        }
      }
      if (!ok) continue;
      SV.grief = true;
      try {
        for (let i = -1; i <= 1; i++)
          for (let j = -1; j <= 1; j++) g.world.setState(ccx + i, y, ccz + j, E.portal);
      } finally { SV.grief = false; }
      return true;
    }
  }
  return false;
}
// eye of ender into an empty frame (any mode; consumed in survival only).
// The completing eye lights the portal with the vanilla sound + message.
function handleEndUse(t, hand) {
  try {
    const g = game();
    const st = g.world.getState(t.x, t.y, t.z);
    const d = defOf(st);
    if (!d || d.name !== "end_portal_frame") return false;
    if (endEyeAt(st)) return false;
    const s = handStack(hand);
    if (stackName(s) !== "ender_eye") return false;
    SV.grief = true;
    try { g.world.setState(t.x, t.y, t.z, endFrameOf(endFacingAt(st), true)); }
    finally { SV.grief = false; }
    if (survives()) {
      if (hand === 1) consumeOne(() => offHeld(), (s2) => { inv().offhand[0] = s2; });
      else consumeOne(() => mainHeld(), (s2) => { inv().main[game().heldSlot | 0] = s2; });
    }
    try { g.sound.play("block.end_portal_frame.fill"); } catch (e) {}
    try {
      if (lightEndPortalAt(t.x, t.y, t.z)) {
        try { g.sound.play("block.end_portal.spawn"); } catch (e) {}
        try { chat("§eThe End portal hums to life..."); } catch (e) {}
      }
    } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// thrown eye: flies toward the stronghold portal, then drops (80%) or
// shatters (20%, vanilla). Overworld only; elsewhere it fizzles unconsumed.
function eyeThrow(hand, consume) {
  const g = game(), sp = SP();
  if (!sp || !sp.active || !g || !g.inWorld) return false;
  let tgt = null;
  try {
    const mc = globalThis.__mcSingleplayer;
    tgt = mc && typeof mc.findStronghold === "function" ? mc.findStronghold() : null;
  } catch (e) {}
  if ((sp.dim | 0) !== 0 || !tgt) {
    try { chat(!tgt ? "§eThe eye drifts nowhere — no stronghold in this world" : "§eThe eye fizzles out (eyes only point in the Overworld)"); } catch (e) {}
    return true;
  }
  if (consume) {
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
  }
  try {
    const p = g.player;
    SV.eyes = SV.eyes || [];
    if (SV.eyes.length > 3) SV.eyes.shift();
    SV.eyes.push({ x: p.x, y: p.y + 1.6, z: p.z, vx: 0, vy: 6, vz: 0, age: 0, tx: tgt.x, ty: tgt.y + 5, tz: tgt.z });
    try { g.sound.play("entity.ender_eye.launch"); } catch (e) {}
  } catch (e) {}
  return true;
}
function eyeTick(dt) {
  try {
    if (!SV.eyes || !SV.eyes.length) return;
    const g = game();
    if (!g || !g.inWorld) return;
    for (let i = SV.eyes.length - 1; i >= 0; i--) {
      const e = SV.eyes[i];
      e.age += dt;
      const dx = e.tx - e.x, dy = e.ty - e.y, dz = e.tz - e.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const vag = 12;
      const k = Math.min(1, dt * 3);
      e.vx += (dx / d * vag - e.vx) * k;
      e.vy += (dy / d * vag * 0.6 + 2 - e.vy) * k;
      e.vz += (dz / d * vag - e.vz) * k;
      e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      try { g.particles.portal(e.x, e.y, e.z, 2); } catch (err) {}
      if (e.age > 5 || d < 2) {
        SV.eyes.splice(i, 1);
        try {
          // creative eyes always shatter (no pickup sim runs there);
          // survival drops 80% like vanilla (20% break)
          if (survivesLoose() && Math.random() < 0.8) {
            spawnItemEntity(e.x, e.y, e.z, itemIdByName("ender_eye"), 1);
          } else {
            try { g.particles.portal(e.x, e.y, e.z, 20); } catch (err2) {}
            try { g.sound.play("entity.ender_eye.death"); } catch (err2) {}
          }
        } catch (err) {}
      }
    }
  } catch (e) {}
}
// end touch-travel (called from the singleplayer looper in any mode):
// overworld portal -> fixed End platform; the exit fountain's portal blocks
// in the End -> overworld spawn; exit gateways -> outer cities (and back).
function endPortalTick() {
  try {
    const sp = SP(), g = game();
    if (!sp || !sp.active || !g || !g.inWorld) return;
    if (SV.dead) return;
    if (Date.now() < (sp.portalCdUntil || 0)) return;
    // v1.16.0: exit gateways teleport to the outer islands (and back)
    try {
      const p = g.player, E = endIds();
      if (E && g.world.getState(Math.floor(p.x), Math.floor(p.y + 0.3), Math.floor(p.z)) === E.gateway) {
        doGatewayJump();
        return;
      }
    } catch (e) {}
    // only when actually standing in an end portal (the looper pre-checks;
    // this keeps direct/test calls safe too)
    try {
      const p = g.player, E = endIds();
      if (!E || g.world.getState(Math.floor(p.x), Math.floor(p.y + 0.3), Math.floor(p.z)) !== E.portal) return;
    } catch (e) { return; }
    doEndJump();
  } catch (e) {}
}
function doEndJump() {
  const sp = SP(), g = game(), p = g.player;
  if (!sp || !g || !p) return;
  const from = (g.dimension | 0) === 1 ? 1 : 0;
  const mc = globalThis.__mcSingleplayer;
  if (!mc || typeof mc.switchDim !== "function") return;
  try { dismountBoat(); } catch (e) {}
  try { dismountCart(); } catch (e) {}
  try { dismountHorse(); } catch (e) {}
  if (from === 0) {
    try { mc.switchDim(1, 100.5, 49.1, 0.5); } catch (e) { return; }
    try { chat("§eEntering the End..."); } catch (e) {}
  } else {
    const s = sp.spawn || { x: 8.5, y: 80, z: 8.5 };
    try { mc.switchDim(0, s.x, s.y, s.z); } catch (e) { return; }
    try { chat("§eLeaving the End..."); } catch (e) {}
  }
}
// v1.16.0: exit-gateway travel. Rim gateways (< 200 blocks out) jump to the
// nearest End city; far gateways (placed at destinations) jump back to the
// stored rim gateway (or the main-island spawn platform as fallback).
function doGatewayJump() {
  const sp = SP(), g = game(), p = g.player;
  if (!sp || !g || !p) return;
  if ((g.dimension | 0) !== 1) return;
  const mc = globalThis.__mcSingleplayer;
  try { dismountBoat(); } catch (e) {}
  try { dismountCart(); } catch (e) {}
  try { dismountHorse(); } catch (e) {}
  const gx = Math.floor(p.x), gz = Math.floor(p.z);
  const far = Math.abs(gx) > 200 || Math.abs(gz) > 200;
  let tx = null, ty = null, tz = null;
  if (!far) {
    // outbound: nearest city to this gateway. Arrival pad is offset 4
    // east of the tower (open air above the base floor disc — the center
    // column is the solid tower pillar), with a self-supporting
    // bedrock + gateway pedestal journaled as overrides (the chunks are
    // usually unloaded, so live setState alone would drop the write).
    try {
      const list = (mc.citiesNear && mc.citiesNear(gx, gz, 4000, 4000)) || [];
      const c = list[0];
      if (c) {
        let top = c.top | 0 || 70;
        try { top = mc.endTopAt(c.x + 4, c.z); } catch (e) {}
        const px = (c.x | 0) + 4, pz = c.z | 0;
        // v1.16.0: arrive one block EAST of the pedestal (open ground),
        // never inside the gateway block — arriving inside re-triggers
        // the trip and ping-pongs while standing still
        tx = px + 1.5; ty = top + 2.1; tz = pz + 0.5;
        try { SV.gatewayReturn = { x: gx + 0.5, y: p.y, z: gz + 0.5 }; } catch (e) {}
        try {
          const E = endIds();
          if (E && E.gateway && mc.stFor) {
            const rock = mc.stFor("bedrock", {}), gw = E.gateway;
            try { if (typeof mc.setOv === "function") { mc.setOv(1, px, top, pz, rock); mc.setOv(1, px, top + 1, pz, gw); } } catch (e) {}
            SV.grief = true;
            try {
              g.world.setState(px, top, pz, rock);
              g.world.setState(px, top + 1, pz, gw);
            } finally { SV.grief = false; }
          }
        } catch (e) {}
      }
    } catch (e) {}
    if (tx == null) return;
    try { chat("§5The gateway carries you to the outer islands..."); } catch (e) {}
  } else {
    // v1.16.0: returns always land on the End spawn platform (obsidian,
    // always safe and always generated). Landing beside the floating rim
    // gateway was tried — it's over void past the island edge, so arrivals
    // fell through while chunks streamed. The platform is the vanilla-style
    // "home" arrival; the rim gateways remain the outbound path.
    tx = 100.5; ty = 49.1; tz = 0.5;
    try { chat("§5The gateway carries you home..."); } catch (e) {}
  }
  try {
    try { g.particles.portal(p.x, p.y + 1, p.z, 0, 0, 0); } catch (e) {}
    p.setPosition(tx, ty, tz);
    p.prevX = tx; p.prevY = ty; p.prevZ = tz;
    p.motionX = p.motionY = p.motionZ = 0;
    try { g.particles.portal(tx, ty + 1, tz, 0, 0, 0); } catch (e) {}
    g.sound.play("entity.enderman.teleport");
  } catch (e) {}
  try { sp.portalCdUntil = Date.now() + 1500; } catch (e) {}
}

/* ---------------------------------------------------------- taming
 * Wolves (bone), ocelots (raw cod/salmon) and parrots (seeds) tame on use
 * (vanilla 1/3 per item; the item is eaten either way). Tamed wolves follow
 * and maul anything that hurts you; ocelots (tame or wild) scatter creepers;
 * feeding a parrot a cookie kills it (vanilla's nastiest joke). Tamed pets
 * never despawn. Sit/stay orders, collars, breeding and name tags are out.
 * Routing: the engine's entity-use path offline is unknown, so tame attempts
 * are accepted from both item-use routes (block-right-click wrapper and the
 * _onItemUse wrapper below); either may carry the entity — resolution tries
 * every id shape, then the nearest tameable in front. If the engine never
 * calls either for entities, taming stays inert (see README).
 */
const TAME_FOOD = {
  wolf: ["bone"],
  ocelot: ["cod", "salmon"],
  parrot: ["wheat_seeds", "melon_seeds", "pumpkin_seeds", "beetroot_seeds"],
};
// breeding food per species (vanilla 1.13 love-mode items). Wolf meat doubles
// as healing (untamed wolves only take bones); turtle eggs are skipped — the
// baby hatches directly (no home-beach pathing offline, see parity doc).
const BREED_FOOD = {
  cow: ["wheat"], sheep: ["wheat"], goat: ["wheat"],
  pig: ["carrot", "potato", "beetroot"],
  chicken: ["wheat_seeds", "melon_seeds", "pumpkin_seeds", "beetroot_seeds"],
  rabbit: ["carrot", "golden_carrot", "dandelion"],
  wolf: ["porkchop", "cooked_porkchop", "beef", "cooked_beef",
          "chicken", "cooked_chicken", "rotten_flesh", "rabbit",
          "cooked_rabbit", "mutton", "cooked_mutton"],
  ocelot: ["cod", "salmon"],
  turtle: ["seagrass"], axolotl: ["tropical_fish"],
  frog: ["slime_ball"], // vanilla: slime balls put frogs in love (tadpole from breed)
  camel: ["cactus"], // vanilla: cactus feeds camels, heals + love
  sniffer: ["torchflower_seeds"], // vanilla: torchflower seeds feed-sniffers
  allay: ["amethyst_shard"], // not breeding: duplication handled in allayTick (dance + shard)
  // bees take any 1.15 flower (breed + nectar forage share this list)
  bee: ["dandelion", "poppy", "blue_orchid", "allium", "azure_bluet",
    "red_tulip", "orange_tulip", "white_tulip", "pink_tulip", "oxeye_daisy",
    "cornflower", "lily_of_the_valley", "wither_rose", "sunflower",
    "lilac", "rose_bush", "peony"],
};
const LOVE_WINDOW = 30 * 1000, BREED_CD = 5 * 60 * 1000, GROW_T = 1200; // 20 min
function isAdult(m) { return !m.baby; }
function nearestAdult(m, range) {
  let best = null, bd = range * range;
  try {
    SV.mobs.forEach((o) => {
      if (o === m || o.species !== m.species || o.baby || o.hp <= 0) return;
      const dx = o.x - m.x, dz = o.z - m.z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = o; }
    });
  } catch (e) {}
  return best;
}
// slime/magma_cube size lives on the engine entity (the renderer scales by
// e.size natively, same values the multiplayer packets carry) — keep the
// logic record and the entity in sync whenever we set it
function syncSlimeSize(rec) {
  try {
    if (!rec || !rec.e) return;
    const s = rec.size | 0 || 1;
    rec.e.size = s;
    const w = 0.51000005 * s;
    rec.e.width = w; rec.e.height = w; rec.e.eyeHeight = w * 0.625;
  } catch (e) {}
}
// shrink a mob to baby size: logic hitbox now; the engine renders babies
// natively (its per-frame living render multiplies scaleGroup by 0.5 when
// the ENTITY has .child set), so just flag it — no visual-map writes, which
// the render loop would overwrite every frame anyway
function setBabyScale(m, baby) {
  const s = !!baby;
  try {
    if (s && m.adultW == null) { m.adultW = m.w; m.adultH = m.h; }
    if (!s && m.adultW != null) {
      m.w = m.adultW; m.h = m.adultH;
      try { m.e.width = m.adultW; m.e.height = m.adultH; } catch (e) {}
    } else if (s) {
      m.w = (m.adultW || m.w) * 0.5; m.h = (m.adultH || m.h) * 0.5;
      try { m.e.width = m.w; m.e.height = m.h; } catch (e) {}
    }
  } catch (e) {}
  try { m.e.child = s; m.scaledVis = s; } catch (e) {}
}
function spawnBaby(species, x, y, z) {
  const m = spawnMob(species, x, y, z);
  if (!m) return null;
  m.baby = true; m.growT = GROW_T; m.loveUntil = 0; m.breedCd = Date.now() + BREED_CD;
  setBabyScale(m, true);
  return m;
}
function growUp(m) {
  m.baby = false; m.growT = 0;
  setBabyScale(m, false);
  // P4: tadpoles grow into frogs (vanilla). Morph in place so the same
  // record keeps ticking; variant rerolls like a natural spawn.
  if (m.species === "tadpole") {
    try {
      m.species = "frog"; m.def = MOB_DEFS.frog;
      m.hp = m.maxHp = MOB_DEFS.frog.hp;
      m.w = 0.5; m.h = 0.5;
      if (m.e) { m.e.width = 0.5; m.e.height = 0.5; m.e.child = false; }
      const gb = blockNameAt(m.x, m.y - 0.5, m.z);
      let v = 0;
      if (gb === "snow" || gb === "snow_block" || gb === "ice") v = 2;
      else if (gb === "sand" || gb === "sandstone" || gb === "red_sand") v = 1;
      m.frogVariant = v;
      if (m.e) m.e.frogVariant = v;
      game().particles.heart(m.x, m.y + 1, m.z);
    } catch (e) {}
    return;
  }
  try { game().particles.heart(m.x, m.y + 1, m.z); } catch (e) {}
}
// two adults in love within 8 blocks make a baby (vanilla: hearts, 1-7 XP,
// 5-min cooldown both; sheep coat from a random parent)
function breedPair(a, b) {
  a.loveUntil = 0; b.loveUntil = 0;
  const now = Date.now();
  a.breedCd = now + BREED_CD; b.breedCd = now + BREED_CD;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  // P4: frogs lay frogspawn on nearby water (vanilla) instead of a live baby.
  if (a.species === "frog") {
    try {
      let fsState = null;
      try {
        for (const b of game().assets.data.blocks) {
          if (b && b.name === "frogspawn") { fsState = b.defaultState; break; }
        }
      } catch (e0) {}
      let placed = false;
      if (fsState != null) {
        for (let ox = -3; ox <= 3 && !placed; ox++) {
          for (let oz = -3; oz <= 3 && !placed; oz++) {
            const wx = Math.floor(mx) + ox, wz = Math.floor(mz) + oz;
            let wy = Math.floor(a.y) + 1;
            for (let yy = Math.floor(a.y) + 1; yy >= Math.floor(a.y) - 3; yy--) {
              if (blockNameAt(wx, yy, wz) === "water" && blockNameAt(wx, yy + 1, wz) === "") {
                wy = yy + 1; break;
              }
            }
            if (blockNameAt(wx, wy, wz) === "" && blockNameAt(wx, wy - 1, wz) === "water") {
              try {
                game().world.setState(wx, wy, wz, fsState);
                try {
                  SV.frogspawn = SV.frogspawn || new Map();
                  SV.frogspawn.set(wx + "," + wy + "," + wz,
                    { x: wx, y: wy, z: wz, until: Date.now() + 300000 });
                } catch (e3) {}
                placed = true;
              } catch (e2) {}
            }
          }
        }
      }
      if (!placed) spawnBaby("tadpole", mx, a.y, mz);
    } catch (e) { try { spawnBaby("tadpole", mx, a.y, mz); } catch (e2) {} }
    try {
      game().particles.heart(mx, a.y + 1.5, mz);
    } catch (e3) {}
    sfx("entity.chicken.egg");
    return;
  }
  const baby = spawnBaby(a.species, mx, a.y, mz);
  if (baby && a.species === "sheep") {
    const c = Math.random() < 0.5 ? (a.color || "white") : (b.color || "white");
    paintSheep(baby, c);
  }
  // tamed parents make tamed babies (vanilla: pups trust the breeder)
  if (baby && (a.species === "wolf" || a.species === "ocelot") && a.tame && b.tame) {
    baby.tame = true;
  }
  try {
    game().particles.heart(mx, a.y + 1.5, mz);
    game().particles.heart(a.x, a.y + 1.5, a.z);
    game().particles.heart(b.x, b.y + 1.5, b.z);
  } catch (e) {}
  sfx("entity.chicken.egg");
  try {
    for (const v of orbSplit(1 + ((Math.random() * 7) | 0))) spawnXPOrb(mx, a.y + 0.5, mz, v);
  } catch (e) {}
}
function resolveMobTarget(t) {
  // the engine may pass an entity, an id, or a wrapper — try everything,
  // then fall back to the nearest tameable mob (3.5 blocks).
  try {
    const ids = [];
    if (t == null) return null;
    if (typeof t === "number") ids.push(t);
    else {
      if (t.id != null && SV.mobs.has(t.id)) return SV.mobs.get(t.id);
      for (const k of ["entityId", "target", "entity", "mob", "victim"]) {
        const v = t[k];
        if (typeof v === "number" && SV.mobs.has(v)) return SV.mobs.get(v);
        if (v && typeof v === "object" && v.id != null && SV.mobs.has(v.id)) return SV.mobs.get(v.id);
      }
    }
    for (const id of ids) if (SV.mobs.has(id)) return SV.mobs.get(id);
    // proximity fallback (only when a real use-target arrived, never air).
    // null already returned above; item-stack-shaped targets ({id, count}:
    // the eaten stack echoed back) are not entities either — without this,
    // every fish eaten near your ocelot would become a tame roll. Entity
    // interaction targets never carry a numeric .count.
    if (typeof t === "object" && typeof t.count === "number") return null;
    if (t.type === "block" || t.x != null) return null;
    let best = null, bd = 3.5 * 3.5;
    try {
      const p = game().player;
      SV.mobs.forEach((m) => {
        if (!TAME_FOOD[m.species] && !(m.species === "parrot")) return;
        const dx = m.x - p.x, dz = m.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd && Math.abs(m.y - p.y) < 3) { bd = d2; best = m; }
      });
    } catch (e) {}
    return best;
  } catch (e) { return null; }
}
function handleMobUse(t, hand) {
  if (!survives() || SV.dead) return false;
  const m = resolveMobTarget(t);
  if (!m) return false;
  // wandering trader: merchant window (same route as the click dispatch)
  if (m.species === "wandering_trader") return openTraderTrade(m);
  const hs = hand === 1 ? offHeld() : mainHeld();
  const hn = hs && hs.id ? stackName(hs) : null;
  // v1.12: empty-hand wolf-sit is handled below (after the dup guard), so
  // only bail here for everything else. Empty hand + led mob unclips first:
  // your own lead drops it free (refunded), anyone else's joins you.
  if (!hn && m.lead) {
    if (dup) return true;
    markTame();
    if (m.lead.to === "player") releaseLead(m, true);
    else attachLead(m, { to: "player" });
    return true;
  }
  // P4: empty-hand camel mount + allay take-back arrive below, so they
  // skip the bail (wolf-sit keeps its own path).
  if (!hn && !(m.species === "wolf" && m.tame) && m.species !== "camel" &&
      !(m.species === "allay" && m.heldName)) return false;
  // the engine may route one click through BOTH use wrappers (right-click +
  // item-use); the second arrival lands within a tick, so swallow it instead
  // of eating a second item for the same click. Only stamps on real consumes.
  let dup = false;
  try { dup = SV.lastTameMob === m.id && Date.now() - (SV.lastTameAt || 0) < 200; } catch (e) {}
  const markTame = () => { try { SV.lastTameMob = m.id; SV.lastTameAt = Date.now(); } catch (e) {} };
  // v1.12: empty hand + tame wolf toggles sit (vanilla). Sitting dogs hold
  // still and skip bodyguard duty until stood again. (Placed after the
  // dup-guard declarations above — TDZ.)
  if (!hn && m.species === "wolf" && m.tame) {
    if (dup) return true;
    markTame();
    m.sitting = !m.sitting;
    try { if (m.e) m.e.sitting = !!m.sitting; } catch (e) {}
    return true;
  }
  // cookie + parrot = instant death (vanilla)
  // name tag + mob: floating name (v1.14; naming a vindicator Johnny
  // turns it on almost everything — vanilla easter egg)
  if (hn === "name_tag") {
    let nm = null;
    try {
      const tg = game().items.nbt(hs);
      const raw = tg && tg.display && tg.display.Name;
      if (typeof raw === "string") {
        try { const j = JSON.parse(raw); nm = (j && j.text) || raw; } catch (e2) { nm = raw; }
      }
    } catch (e) {}
    if (!nm) return false;
    if (dup) return true;
    markTame();
    m.name = String(nm).slice(0, 32);
    try { m.e.customName = m.name; m.e.nameVisible = true; } catch (e) {}
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    return true;
  }
  // leads (v1.14 Phase D): lead in hand clips onto leashable mobs (consumes
  // one); a knot-tied mob transfers to you instead (no extra consume)
  if (hn === "lead") {
    if (!LEASHABLE[m.species]) return false;
    if (m.lead && m.lead.to === "player") return false;
    if (dup) return true;
    markTame();
    const fresh = !m.lead;
    attachLead(m, { to: "player" });
    if (fresh) {
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    }
    try { sfx("entity.leash_knot.place"); } catch (e) {}
    return true;
  }
  // cookie + parrot = instant death (vanilla)
  if (m.species === "parrot" && hn === "cookie") {
    if (dup) return true;
    markTame();
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try { game().particles.poison(m.x, m.y + 1, m.z); } catch (e) {}
    sfx("entity.parrot.death");
    mobDie(m, true);
    return true;
  }
  // shears + sheep: 1-3 wool, sheep goes bare (vanilla; regrows by grazing)
  if (m.species === "sheep" && hn === "shears") {
    if (m.sheared) return false;
    if (dup) return true;
    markTame();
    const id = itemIdByName((m.color || "white") + "_wool");
    if (id != null) {
      const n = 1 + ((Math.random() * 3) | 0);
      for (let i = 0; i < n; i++) spawnItemEntity(m.x, m.y + 0.8, m.z, id, 1);
    }
    m.sheared = true; m.regrow = 0;
    try { m.e.sheared = true; } catch (e) {}
    if (hand === 1) wearOff(1); else wearMain(1);
    sfx("entity.sheep.shear");
    return true;
  }
  // dye + sheep: recolor the coat (vanilla; works on sheared sheep too)
  if (m.species === "sheep" && DYE_COLOR[hn]) {
    if (dup) return true;
    markTame();
    const c = DYE_COLOR[hn];
    if (m.color !== c) {
      paintSheep(m, c);
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      try { game().particles.entityEffect(m.x, m.y + 1, m.z, 6); } catch (e) {}
    }
    return true;
  }
  // hurt tamed wolves eat meat to heal (vanilla); only full-HP wolves
  // enter love mode below. Checked first: meat is also breeding food.
  if (m.species === "wolf" && m.tame && m.hp < (m.maxHp || m.def.hp || 20)) {
    const MEAT = BREED_FOOD.wolf;
    if (hn && MEAT.indexOf(hn) >= 0) {
      if (dup) return true;
      markTame();
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      try { m.hp = Math.min(m.maxHp || m.def.hp || 20, m.hp + 4); } catch (e) {}
      try { game().particles.heart(m.x, m.y + 1, m.z); } catch (e) {}
      return true;
    }
  }
  // bucket + cow/goat: milking (vanilla); water bucket + axolotl: scoop
  // it up into an axolotl bucket (vanilla; variant is rerolled on place)
  if (hn === "bucket" && (m.species === "cow" || m.species === "goat")) {
    if (dup) return true;
    markTame();
    const mid = itemIdByName("milk_bucket");
    if (mid == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try {
      const v = inv();
      if (v && typeof v.addToInventory === "function") v.addToInventory({ id: mid, count: 1 });
    } catch (e) {}
    sfx(m.species === "goat" ? "entity.goat.milk" : "entity.cow.milk");
    return true;
  }
  if (hn === "water_bucket" && m.species === "axolotl") {
    if (dup) return true;
    markTame();
    const aid = itemIdByName("axolotl_bucket");
    if (aid == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try {
      const v = inv();
      if (v && typeof v.addToInventory === "function") v.addToInventory({ id: aid, count: 1 });
    } catch (e) {}
    try { game().sound.play("item.bucket.fill_axolotl"); } catch (e2) {}
    try { removeMob(m.id); } catch (e3) {}
    return true;
  }
  // P4: water bucket + tadpole = scoop it up (axolotl idiom; variant rerolls
  // on place like the axolotl bucket).
  if (hn === "water_bucket" && m.species === "tadpole") {
    if (dup) return true;
    markTame();
    const tid = itemIdByName("tadpole_bucket");
    if (tid == null) return false;
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try {
      const v = inv();
      if (v && typeof v.addToInventory === "function") v.addToInventory({ id: tid, count: 1 });
    } catch (e) {}
    try { game().sound.play("item.bucket.fill_tadpole"); } catch (e2) {}
    try { removeMob(m.id); } catch (e3) {}
    return true;
  }
  // P4: saddle + unsaddled adult camel = saddled (vanilla; consumed).
  if (hn === "saddle" && m.species === "camel" && !m.baby && !m.saddled) {
    if (dup) return true;
    markTame();
    m.saddled = true;
    try { if (m.e) m.e.saddled = true; } catch (e) {}
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    try { game().particles.heart(m.x, m.y + 1, m.z); } catch (e2) {}
    sfx("entity.camel.saddle");
    return true;
  }
  // P4: right-click a saddled adult camel = mount (vanilla).
  if (!hn && m.species === "camel" && m.saddled && !m.baby) {
    if (dup) return true;
    markTame();
    try { if (mountCamel(m.id)) return true; } catch (e) {}
  }
  // P4: allay item gifts (vanilla): empty hand takes its item back; offering
  // the SAME item it holds (or any item when empty-handed-held... no: any
  // item when it holds nothing) gives it one. Amethyst while dancing dupes.
  if (m.species === "allay") {
    if (!hn && m.heldName) {
      // take the item back (vanilla)
      if (dup) return true;
      markTame();
      try {
        const gid = itemIdByName(m.heldName);
        if (gid != null) {
          const v = inv();
          if (v && typeof v.addToInventory === "function") v.addToInventory({ id: gid, count: 1 });
        }
      } catch (e) {}
      m.heldName = null;
      try { sfx("entity.allay.item_taken"); } catch (e2) {}
      return true;
    }
    if (hn === "amethyst_shard" && m.dancing && (m.dupeCd || 0) <= Date.now()) {
      // duplication (vanilla: shard + dancing + 5-min cooldown both)
      if (dup) return true;
      markTame();
      m.dupeCd = Date.now() + 300000;
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      try {
        const nm = spawnMob("allay", m.x + 0.5, m.y + 0.5, m.z + 0.5);
        if (nm) nm.dupeCd = Date.now() + 300000;
        game().particles.heart(m.x, m.y + 1.5, m.z);
        sfx("entity.allay.ambient_with_item");
      } catch (e) {}
      return true;
    }
    if (hn && !m.heldName) {
      // offer any item: it holds one (vanilla takes one from the hand)
      if (dup) return true;
      markTame();
      m.heldName = hn;
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      try { sfx("entity.allay.item_given"); } catch (e) {}
      return true;
    }
  }
  const bf = BREED_FOOD[m.species];
  if (bf && bf.indexOf(hn) >= 0) {
    // babies eat to grow (10% off remaining, vanilla); adults need taming
    // first where taming exists (wolf/ocelot), else enter love mode
    if (m.baby) {
      if (dup) return true;
      markTame();
      m.growT = Math.max(1, (m.growT || GROW_T) * 0.9);
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      try { game().particles.happy_villager(m.x, m.y + 1, m.z); } catch (e) {}
      return true;
    }
    if ((m.species === "wolf" || m.species === "ocelot") && !m.tame) {
      if (m.species === "wolf") return false; // untamed wolves take only bones
      // untamed ocelot: skip love handling, tame roll below
    } else {
    if (Date.now() < (m.breedCd || 0)) {
      // cooling down: eats but no hearts (vanilla no-inbreeding rule)
      if (dup) return true;
      markTame();
      if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
      else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
      return true;
    }
    if (dup) return true;
    markTame();
    if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
    else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
    m.loveUntil = Date.now() + LOVE_WINDOW;
    try { game().particles.heart(m.x, m.y + 1.5, m.z); } catch (e) {}
    // find a partner already in love nearby (vanilla 8-block scan)
    try {
      let best = null, bd = 64;
      SV.mobs.forEach((o) => {
        if (o === m || o.species !== m.species || o.baby || o.hp <= 0) return;
        if ((m.species === "wolf" || m.species === "ocelot") && !o.tame) return;
        if (!o.loveUntil || Date.now() > o.loveUntil) return;
        const dx = o.x - m.x, dz = o.z - m.z, d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; best = o; }
      });
      if (best) breedPair(m, best);
    } catch (e) {}
    return true;
    }
  }
  const foods = TAME_FOOD[m.species];
  if (!foods || m.tame || foods.indexOf(hn) < 0) return false;
  if (dup) return true;
  markTame();
  if (hand === 1) consumeOne(() => offHeld(), (s) => { inv().offhand[0] = s; });
  else consumeOne(() => mainHeld(), (s) => { inv().main[game().heldSlot | 0] = s; });
  addExhaustion(0.1);
  if (Math.random() < 1 / 3) {
    m.tame = true;
    try { game().particles.heart(m.x, m.y + 1.5, m.z); } catch (e) {}
    sfx(m.species === "wolf" ? "entity.wolf.whine" : "entity.ocelot.ambient");
    chat("§e" + (m.species === "wolf" ? "The wolf trusts you now" : m.species === "ocelot" ? "The ocelot trusts you now" : "The parrot likes you now"));
  } else {
    try { game().particles.smoke(m.x, m.y + 1.5, m.z); } catch (e) {}
  }
  return true;
}
// tamed wolves answer your pain: anything that hurts you marks every nearby
// pet for retaliation (called from damagePlayer's mob/arrow branch)
function rallyPets() {
  try {
    SV.mobs.forEach((m) => {
      if ((m.species === "wolf" || m.species === "parrot") && m.tame) m.provokedAt = Date.now();
    });
  } catch (e) {}
}
function nearestTameOcelot(x, z, range) {
  let best = null, bd = range * range;
  try {
    SV.mobs.forEach((m) => {
      if ((m.species !== "ocelot" && m.species !== "cat") || m.hp <= 0) return;
      const dx = m.x - x, dz = m.z - z, d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = m; }
    });
  } catch (e) {}
  return best;
}

/* ---------------------------------------------------------- golem building
 * Vanilla patterns, detected on the completing placement (any of the shape's
 * blocks may be placed last — we check the neighborhood on every relevant
 * placement). Blocks are consumed (vanilla pops them) and the golem spawns.
 *   snow golem: snow_block, snow_block, pumpkin (vertical column, head last)
 *   iron golem: pumpkin atop 2 iron, arms iron on the sides (x or z axis)
 */
function isPumpkinHead(nm) {
  return nm === "pumpkin" || nm === "carved_pumpkin" || nm === "jack_o_lantern";
}
function clearBlock(x, y, z) {
  try {
    SV.grief = true;
    game().world.setState(x | 0, y | 0, z | 0, 0);
  } finally { try { SV.grief = false; } catch (e) {} }
}
function checkGolem(x, y, z, s) {
  if (!survives()) return;
  let nm = null;
  try { const d = defOf(s); nm = d && d.name; } catch (e) {}
  if (!nm) return;
  const relevant = isPumpkinHead(nm) || nm === "snow_block" || nm === "iron_block";
  if (!relevant) return;
  x |= 0; y |= 0; z |= 0;
  const at = (ax, ay, az) => { try { return blockNameAt(ax, ay, az); } catch (e) { return null; } };
  // snow golem: head at (x,y,z), snow at y-1 and y-2
  if (isPumpkinHead(nm)) {
    if (at(x, y - 1, z) === "snow_block" && at(x, y - 2, z) === "snow_block") {
      clearBlock(x, y, z); clearBlock(x, y - 1, z); clearBlock(x, y - 2, z);
      try { spawnMob("snow_golem", x + 0.5, y - 1, z + 0.5); } catch (e) {}
      sfx("entity.snowman.ambient");
      return;
    }
    // iron golem: head at (x,y,z); body column y-1, y-2; arms at y-1 on x or z
    if (at(x, y - 1, z) === "iron_block" && at(x, y - 2, z) === "iron_block" &&
        ((at(x - 1, y - 1, z) === "iron_block" && at(x + 1, y - 1, z) === "iron_block") ||
         (at(x, y - 1, z - 1) === "iron_block" && at(x, y - 1, z + 1) === "iron_block"))) {
      clearBlock(x, y, z); clearBlock(x, y - 1, z); clearBlock(x, y - 2, z);
      clearBlock(x - 1, y - 1, z); clearBlock(x + 1, y - 1, z);
      clearBlock(x, y - 1, z - 1); clearBlock(x, y - 1, z + 1);
      try { spawnMob("iron_golem", x + 0.5, y - 1, z + 0.5); } catch (e) {}
      sfx("entity.irongolem.hurt");
      return;
    }
  }
  // snow body completed under an existing head (head placed first, body after)
  if (nm === "snow_block") {
    if (isPumpkinHead(at(x, y + 1, z)) && at(x, y - 1, z) === "snow_block") {
      clearBlock(x, y + 1, z); clearBlock(x, y, z); clearBlock(x, y - 1, z);
      try { spawnMob("snow_golem", x + 0.5, y, z + 0.5); } catch (e) {}
      sfx("entity.snowman.ambient");
    } else if (isPumpkinHead(at(x, y + 2, z)) && at(x, y + 1, z) === "snow_block") {
      clearBlock(x, y + 2, z); clearBlock(x, y + 1, z); clearBlock(x, y, z);
      try { spawnMob("snow_golem", x + 0.5, y + 1, z + 0.5); } catch (e) {}
      sfx("entity.snowman.ambient");
    }
  }
  // iron body completed under an existing head
  if (nm === "iron_block") {
    if (isPumpkinHead(at(x, y + 1, z)) && at(x, y - 1, z) === "iron_block" &&
        ((at(x - 1, y, z) === "iron_block" && at(x + 1, y, z) === "iron_block") ||
         (at(x, y, z - 1) === "iron_block" && at(x, y, z + 1) === "iron_block"))) {
      clearBlock(x, y + 1, z); clearBlock(x, y, z); clearBlock(x, y - 1, z);
      clearBlock(x - 1, y, z); clearBlock(x + 1, y, z);
      clearBlock(x, y, z - 1); clearBlock(x, y, z + 1);
      try { spawnMob("iron_golem", x + 0.5, y, z + 0.5); } catch (e) {}
      sfx("entity.irongolem.hurt");
    }
  }
}

/* ---------------------------------------------------------- wither building
 * Soul-sand T (3 across + stem below the center) with 3 wither skulls on
 * top raises the wither, whether the last piece lands by hand (via the
 * world hook) or from a dispenser. Blocks are consumed, the boss spawns
 * where the skulls stood. Other heads just sit.
 */
function checkWither(x, y, z) {
  if (!survives()) return;
  x |= 0; y |= 0; z |= 0;
  const at = (ax, ay, az) => { try { return blockNameAt(ax, ay, az); } catch (e) { return null; } };
  const isSkull = (n) => n === "wither_skeleton_skull" || n === "wither_skeleton_wall_skull";
  for (const [ox, oz] of [[1, 0], [0, 1]]) {
    for (let ix = -2; ix <= 2; ix++) for (let iy = -3; iy <= 1; iy++) for (let iz = -2; iz <= 2; iz++) {
      const cx = x + ix, cy = y + iy, cz = z + iz;
      if (at(cx, cy, cz) !== "soul_sand") continue;
      const ax = cx + ox, az = cz + oz, bx = cx - ox, bz = cz - oz;
      if (at(ax, cy, az) !== "soul_sand" || at(bx, cy, bz) !== "soul_sand") continue;
      if (at(cx, cy - 1, cz) !== "soul_sand") continue;
      if (!isSkull(at(cx, cy + 1, cz)) || !isSkull(at(ax, cy + 1, az)) || !isSkull(at(bx, cy + 1, bz))) continue;
      clearBlock(cx, cy + 1, cz); clearBlock(ax, cy + 1, az); clearBlock(bx, cy + 1, bz);
      clearBlock(cx, cy, cz); clearBlock(ax, cy, az); clearBlock(bx, cy, bz);
      clearBlock(cx, cy - 1, cz);
      try { spawnMob("wither", cx + 0.5, cy + 1, cz + 0.5); } catch (e) {}
      sfx("entity.wither.spawn");
      try { game().particles.explosion(cx + 0.5, cy + 1.5, cz + 0.5, 1); } catch (e2) {}
      return;
    }
  }
}

/* ---------------------------------------------------------- engine hooks */

function ensureWorldHook() {
  // game.reset() swaps the world object, dropping our setState wrapper while
  // g._svPatched stays true — so re-wrap whenever the live world is bare.
  // Idempotent: the wrapper marks itself via _svWrapped.
  try {
    const g = game();
    const w = g && g.world;
    if (!w || typeof w.setState !== "function") return;
    // Re-assert, don't re-wrap: the engine rebinds world methods on world
    // entry, producing fresh function objects that lose the fn mark — a
    // pure fn-mark guard then stacks a second wrapper and every break
    // drops loot twice. The wrapper reference lives on the world object
    // itself, so rebinding is detected and repaired with one layer.
    if (w._svWrapFn) {
      try { if (w.setState !== w._svWrapFn) w.setState = w._svWrapFn; } catch (e) {}
      return;
    }
    if (w.setState._svWrapped) return;
    const prevSet = w.setState.bind(w);
    const wrapped = function svWrap(x, y, z, s) {
      let old = null, want = false, placed = false, placedWet = false;
      // end portal blocks + frames are unbreakable (vanilla, even in
      // creative): swallow breaks here. Gen fills (sp.gen) and our own
      // lights (SV.grief) bypass. Placed frames also normalize to eyeless —
      // the engine predictor seats the dataset default (eyed), but eyes only
      // enter via handleEndUse.
      try {
        if (!SV.grief) {
          const sp0 = SP();
          if (!(sp0 && sp0.gen)) {
            if ((s | 0) === 0) {
              let nm0 = "";
              try { nm0 = defOf(w.getState(x, y, z)).name; } catch (e) {}
              if (nm0 === "end_portal" || nm0 === "end_portal_frame") {
                try { return w.getState(x, y, z); } catch (e) { return 0; }
              }
            } else {
              let nm1 = "";
              try { nm1 = defOf(s).name; } catch (e) {}
              if (nm1 === "end_portal_frame" && endEyeAt(s)) {
                const bare = endFrameOf(endFacingAt(s), false);
                SV.grief = true;
                try { return w.setState(x, y, z, bare); }
                finally { SV.grief = false; }
              }
            }
          }
        }
      } catch (e) {}
      try {
        const sp = SP();
        if (SV.on && sp && sp.active && (sp.mode | 0) === 0 && !sp.gen && !SV.grief &&
            y >= -64 && y <= 319 && g.inWorld) {
          old = w.getState(x, y, z);
          want = !SV.pistonMove && old !== 0 && (s | 0) === 0;
          placed = !SV.pistonMove && old === 0 && (s | 0) !== 0;
          // v1.15.0: building INTO water (sponge/conduit placed to replace a
          // water cell) still counts for soak/track, but NOT for golems/
          // wither/portals (those keep the air-placement path, as before) —
          // so this stays a separate flag, not an extension of placed.
          try {
            placedWet = !SV.pistonMove && old !== 0 && (s | 0) !== 0 &&
              (() => { try { const dn = defOf(old); return !!dn && (dn.name === "water" || dn.name === "lava"); } catch (e) { return false; } })();
          } catch (e) { placedWet = false; }
          // v1.13: journal every engine piston write (first-write wins per cell)
          if (SV.pistonMove && old != null) {
            try {
              const kk = (x | 0) + "," + (y | 0) + "," + (z | 0);
              if (SV.pistonMove.writes[kk] == null) SV.pistonMove.writes[kk] = old | 0;
            } catch (e2) {}
          }
        }
      } catch (e) {}
      const r = prevSet(x, y, z, s);
      try { trackCrop(x, y, z, s); } catch (e) {}
      try { trackHive(x, y, z, s); } catch (e) {}
      try { rsTrack(x, y, z, s); } catch (e) {}
      // v1.13: observers pulse on neighbor changes (streaming bypasses the
      // wrapper, so loads never pulse — vanilla-correct; piston slides journal
      // instead and notify once at settle, not per animation frame)
      try {
        if (SV.obsOn && !SV.pistonMove && SV.on) pistNotifyObservers(x | 0, y | 0, z | 0, true);
      } catch (e) {}
      try { if (want && old != null) onPlayerBreak(x, y, z, old, s); } catch (e) {}
      try { if (placed) checkGolem(x, y, z, s); } catch (e) {}
      try { if (placed) checkWither(x | 0, y | 0, z | 0); } catch (e) {}
      // v1.15.0: dry sponge soaks nearby water on place
      try { if (placed || placedWet) spongeSoakAt(x | 0, y | 0, z | 0, s); } catch (e) {}
      // v1.15.0: conduit place/break tracking (frame validated live)
      try { if (placed || placedWet) conduitTrack(x | 0, y | 0, z | 0, s); } catch (e) {}
      // nether loop: water + lava adjacencies become obsidian (both modes;
      // gated inside on generator writes so worldgen lava stays lava).
      // v1.13: piston slides move through their own journal, not lava mixing.
      try { if (!SV.pistonMove) lavaMixAt(x, y, z, old, s); } catch (e) {}
      // portal frame completed (fire/obsidian placed) -> try lighting it;
      // frame broken (obsidian/portal removed) -> schedule a decay scan
      try {
        if (placed) {
          let nm = "";
          try { nm = defOf(s).name; } catch (e) {}
          if (nm === "fire" || nm === "obsidian") lightPortalAt(x, y, z);
        } else if (want && old != null) {
          let nm = "";
          try { nm = defOf(old).name; } catch (e) {}
          if (nm === "obsidian" || nm === "nether_portal") SV.portalCheck = 1;
        }
      } catch (e) {}
      return r;
    };
    wrapped._svWrapped = true;
    try { w._svWrapFn = wrapped; } catch (e) {}
    w.setState = wrapped;
  } catch (e) {}
}

function rescanCropsFromOverrides() {
  // Rebuild the crop watch-set from saved player edits (blocks persist as
  // world diffs; SV.crops is runtime-only and starts empty every entry).
  // Overrides are the complete record of player-placed crop/farmland blocks
  // (worldgen plants none), so this catches everything the wrapper missed
  // while it was unwrapped or before chunks streamed in.
  try {
    const sp = SP();
    const ov = sp && ((sp.dim | 0) === -1 ? sp.nether : (sp.dim | 0) === 1 ? sp.end : sp.overrides);
    if (!ov || !SV.crops) return 0;
    let n = 0;
    for (const k in ov) {
      try {
        const c = String(k).split(",");
        if (c.length !== 3) continue;
        if (cropKindOf(ov[k] | 0)) {
          SV.crops.set(k, { x: c[0] | 0, y: c[1] | 0, z: c[2] | 0 });
          n++;
        }
      } catch (e) {}
    }
    return n;
  } catch (e) { return 0; }
}

function installHooks() {
  const g = game();
  if (!g) return;
  ensureWorldHook();
  if (g._svPatched) return;
  g._svPatched = true;
  // 1) break detection lives in ensureWorldHook (world object is swapped by
  //    game.reset(), so the wrapper must follow it — see above).
  //    Placements of pumpkin/snow/iron are also screened for golem builds.
  // 2) player attacks: engine swings; we apply survival damage to our mobs
  try {
    const inter = g.interaction;
    if (inter && !inter._svPatched && typeof inter.attackEntity === "function") {
      inter._svPatched = true;
      const orig = inter.attackEntity.bind(inter);
      inter.attackEntity = function (t) {
        const r = orig(t);
        try {
          if (survives() && t && t.id != null && SV.stands.has(t.id)) {
            // punched armor stand: one hit breaks it (vanilla),
            // dropping the stand + its gear
            breakStand(t.id | 0);
            try { if (survives()) wearMain(1); } catch (e2) {}
            addExhaustion(0.1);
          } else if (survives() && t && t.id != null && SV.boats.has(t.id)) {
            // punched boat: wobble, then break into its boat item (vanilla)
            boatBreakHit(t.id | 0);
            try { if (survives()) wearMain(1); } catch (e2) {}
            addExhaustion(0.1); // attacking exhausts
          } else if (survives() && t && t.id != null && SV.carts.has(t.id)) {
            // punched cart: wobble, then break into the cart item (vanilla)
            cartBreakHit(t.id | 0);
            try { if (survives()) wearMain(1); } catch (e2) {}
            addExhaustion(0.1);
          } else if (survives() && t && t.id != null && SV.horses.has(t.id)) {
            // punched horse: hurts it (hit cooldown inside horseDamage;
            // horses flee / llamas spit back). Can't punch your own seat.
            if (t.id !== SV.rideHorse) {
              const h = SV.horses.get(t.id);
              let kx = 0, kz = 0;
              try { const pp = g.player; kx = h.x - pp.x; kz = h.z - pp.z; } catch (e) {}
              horseDamage(t.id, weaponStats(heldName()).dmg || 1, kx, kz, { byPlayer: true });
            }
            try { if (survives()) wearMain(1); } catch (e2) {}
            addExhaustion(0.1);
          } else if (survives() && t && t.id != null && SV.crystals && SV.crystals.has(t.id)) {
            // v1.16.0: punching an end crystal detonates it (vanilla)
            try { explodeCrystal(t.id | 0); } catch (e) {}
            try { if (survives()) wearMain(1); } catch (e2) {}
            addExhaustion(0.1);
          } else if (survives() && t && t.id != null && SV.mobs.has(t.id)) {
            const p = g.player;
            const ws = weaponStats(heldName());
            const charge = clamp((Date.now() - (SV.atkAt || 0)) / 1000 / ws.period, 0, 1);
            SV.atkAt = Date.now();
            // vanilla cooldown: 0.2 + 0.8*charge^2 damage when spamming
            let dmg = ws.dmg * (0.2 + 0.8 * charge * charge);
            // vanilla crit: airborne + falling (fall speed passes 0.2 within
            // ~half a block of falling; jump peak velocity is 0.42)
            const falling = !p.onGround && (p.motionY || 0) < -0.2 && !p.inWater;
            const crit = falling && !p.sprinting;
            let kx = 0, kz = 0;
            try {
              const m = SV.mobs.get(t.id);
              kx = m.x - p.x; kz = m.z - p.z;
            } catch (e) {}
            damageMob(t.id, dmg, kx, kz, { byPlayer: true, crit, sprintKnock: !!p.sprinting });
          // vanilla: the used weapon takes 1 durability per hit
          try { if (survives()) wearMain(1); } catch (e) {}
            addExhaustion(0.1); // attacking exhausts
            // sweeping-edge: full-charge sword hit on the ground sweeps
            // nearby mobs for 1 damage (no Sweeping enchant here, so base 1)
            if (charge >= 1 && heldName() && heldName().endsWith("_sword") && p.onGround) {
              try {
                SV.mobs.forEach((m2) => {
                  if (m2.id === t.id) return;
                  const ddx = m2.x - p.x, ddz = m2.z - p.z;
                  if (ddx * ddx + ddz * ddz < 9 && Math.abs(m2.y - p.y) < 2) {
                    damageMob(m2.id, 1, ddx, ddz, { byPlayer: true });
                  }
                });
              } catch (e) {}
              try { g.sound.play("entity.player.attack.sweep"); } catch (e2) {}
            }
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}
  // 2b) engine-shot player arrows: track them so they can hurt our mobs
  // (the visual stays engine-owned; see trackPlayerArrows)
  try {
    const ents = g.entities;
    if (ents && !ents._svArrowPatched && typeof ents.spawnObject === "function") {
      ents._svArrowPatched = true;
      const origSpawn = ents.spawnObject.bind(ents);
      ents.spawnObject = function (o) {
        const r = origSpawn(o);
        try {
          if (o && o.type === 2 && o.objectData !== 1 && SV.on && !ents._svNoTrack) {
            const p = g.player;
            if (p && SV.trackedArrows && SV.trackedArrows.size < 12) {
              const dx = (o.x || 0) - p.x, dz = (o.z || 0) - p.z;
              if (dx * dx + dz * dz < 9) {
                SV.trackedArrows.set(o.entityId, { id: o.entityId, age: 0, lx: null, ly: null, lz: null });
              }
            }
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}
  // 2b2) particle-compat: the 1.15.2 Particles class renamed/reshaped several
  // calls survival uses (heart/poison/happy_villager/totem are gone; splash,
  // portal, rain, entityEffect, potionSwirl and deathPoof take new shapes).
  // Patch the instance once so every call site keeps working unmodified.
  try {
    const pt = g.particles;
    if (pt && !g._svParticlesPatched) {
      g._svParticlesPatched = true;
      const R = Math.random;
      if (typeof pt.heart !== "function") pt.heart = (x, y, z) => { try { pt.simpleRising(x, y, z, 80, { my: 0.1 }); } catch (e) {} };
      if (typeof pt.poison !== "function") pt.poison = (x, y, z) => { try { pt.spell(x, y, z, 0, 0.1, 0, 0.35, 0.75, 0.25); } catch (e) {} };
      if (typeof pt.happy_villager !== "function") pt.happy_villager = (x, y, z) => { try { pt.simpleRising(x, y, z, 82, { my: 0.05 }); } catch (e) {} };
      if (typeof pt.totem !== "function") pt.totem = (x, y, z, n) => { try { n = Math.max(1, Math.min(n | 0 || 30, 40)); for (let i = 0; i < n; i++) pt.simpleRising(x + (R() - 0.5), y + R() * 1.5, z + (R() - 0.5), 82, { my: 0.25 }); } catch (e) {} };
      if (typeof pt.smoke === "function" && !pt._svSmoke) {
        pt._svSmoke = pt.smoke.bind(pt);
        pt.smoke = (x, y, z, mx, my, mz, s) => pt._svSmoke(x, y, z, mx == null ? 0 : mx, my == null ? 0.02 : my, mz == null ? 0 : mz, s);
      }
      if (typeof pt.splash === "function" && !pt._svSplash) {
        pt._svSplash = pt.splash.bind(pt);
        pt.splash = (x, y, z, n) => { try { n = (n == null || n <= 1) ? 1 : Math.min(n | 0, 12); for (let i = 0; i < n; i++) pt._svSplash(x + (R() - 0.5) * 0.5, y, z + (R() - 0.5) * 0.5, 0, 0.12, 0); } catch (e) {} };
      }
      if (typeof pt.portal === "function" && !pt._svPortal) {
        pt._svPortal = pt.portal.bind(pt);
        pt.portal = (x, y, z, a, b, c) => { try { if (c == null && b == null) { const n = Math.max(1, Math.min(a | 0 || 1, 40)); for (let i = 0; i < n; i++) pt._svPortal(x + (R() - 0.5), y + (R() - 0.5), z + (R() - 0.5), (R() - 0.5) * 0.3, (R() - 0.5) * 0.3, (R() - 0.5) * 0.3); } else pt._svPortal(x, y, z, a || 0, b || 0, c || 0); } catch (e) {} };
      }
      if (typeof pt.rain === "function" && !pt._svRain) {
        pt._svRain = pt.rain.bind(pt);
        pt.rain = (x, y, z, n) => { try { n = Math.max(1, Math.min(n | 0 || 1, 60)); for (let i = 0; i < n; i++) pt._svRain(x + (R() - 0.5) * 2, y, z + (R() - 0.5) * 2); } catch (e) {} };
      }
      if (typeof pt.entityEffect === "function" && !pt._svEE) {
        pt._svEE = pt.entityEffect.bind(pt);
        pt.entityEffect = (x, y, z, n) => { try { if (x && typeof x.x === "number") return pt._svEE(x, y); n = Math.max(1, Math.min(n | 0 || 6, 12)); for (let i = 0; i < n; i++) pt.spell(x + (R() - 0.5) * 0.6, y + (R() - 0.5) * 0.6, z + (R() - 0.5) * 0.6, 0, 0.08, 0, 0.55, 0.4, 0.85, false, true); } catch (e) {} };
      }
      if (typeof pt.potionSwirl === "function" && !pt._svPS) {
        pt._svPS = pt.potionSwirl.bind(pt);
        pt.potionSwirl = (x, y, z, n) => { try { if (x && typeof x.x === "number") return pt._svPS(x, y, z); n = Math.max(1, Math.min(n | 0 || 6, 12)); for (let i = 0; i < n; i++) pt._svPS({ x: x + (R() - 0.5), y, z: z + (R() - 0.5), width: 0.6, height: 0.8 }, 0x6a1fb0, false); } catch (e) {} };
      }
      if (typeof pt.deathPoof === "function" && !pt._svDP) {
        pt._svDP = pt.deathPoof.bind(pt);
        pt.deathPoof = (x, y, z) => { try { if (x && typeof x.x === "number") return pt._svDP(x); pt._svDP({ x, y, z, width: 0.6, height: 1.8 }); } catch (e) {} };
      }
    }
  } catch (e) {}
  // 2c) horse tack windows save on close (EntityHorse). Chest tiles survive a
  // close because tilesTick pulls them every tick while open, but horse tiles
  // are deliberately skipped there (raw pulls would bypass saddle/armor slot
  // validation), so the validated save must run inside the close event itself
  // — by the next masterTick game().window is already null and saveOpenTile
  // can no longer read the slots.
  try {
    if (typeof g.on_close_window === "function" && !g._svHorseClosePatched) {
      g._svHorseClosePatched = true;
      const origClose = g.on_close_window.bind(g);
      g.on_close_window = function (o) {
        try { if (SV.openTile && SV.openTile.horse) saveHorseWindow(); } catch (e) {}
        try { SV.openTile = null; } catch (e2) {}
        // B2: merchant windows commit + salvage inputs on close (the engine
        // clears the cursor server-side; our slots 0/1 would vanish).
        // Silent here: the engine already closed it (Esc etc.) — closeTrade
        // with silent=true salvages without re-closing.
        try { if (SV.openTrade) closeTradeWindow(true); } catch (e3) {}
        return origClose(o);
      };
    }
  } catch (e) {}
  // 3a) RMB tracker for shield blocking (engine usingItem never engages
  // for shields offline). Throwables/rods are owned here too: vanilla throws
  // instantly on RMB (even aimed at blocks), and the engine has no offline
  // throw — so we spawn ours and swallow the click (capture runs first).
  try {
    if (!g._svRmbHooked) {
      g._svRmbHooked = true;
      const down = (e) => {
        try {
          if (e && e.button === 2) {
            SV.rmb = true;
            try { if (throwFastPath()) { e.stopPropagation(); e.preventDefault(); } } catch (ee) {}
          }
        } catch (ee) {}
      };
      const up = (e) => { try { if (!e || e.button === 2) SV.rmb = false; } catch (ee) {} };
      document.addEventListener("mousedown", down, true);
      document.addEventListener("mouseup", up, true);
      document.addEventListener("contextmenu", up, true);
      window.addEventListener("blur", up, true);
    }
  } catch (e) {}
  // 3b) block right-click: cake/beds/doors/TNT/flint/buckets (engine send()
  // is dead offline, so containers/uses need us). Runs before the engine.
  try {
    const inter = g.interaction;
    if (inter && !inter._svUsePatched && typeof inter.onPlayerRightClick === "function") {
      inter._svUsePatched = true;
      const origR = inter.onPlayerRightClick.bind(inter);
      inter.onPlayerRightClick = function (t, hand) {
        try {
          // end portal frames take eyes in any mode (creative: no consume)
          try { if (t && (t.type === "block" || t.x != null) && handleEndUse(t, hand | 0)) return true; } catch (ee) {}
          if (survives() && t) {
            // boats mount on right-click (engine vehicle takes over after)
            try { if (handleBoatMount(t)) return true; } catch (ee) {}
            // carts: ride (empty), open (chest/hopper), fuel (furnace)
            try { if (handleCartUse(t, hand | 0)) return true; } catch (ee) {}
            // horses: feed / chest / tack window / tame / mount
            try { if (handleHorseUse(t, hand | 0)) return true; } catch (ee) {}
            // villagers: merchant window (employed) or headshake (others)
            try { if (handleVillagerUse(t)) return true; } catch (ee) {}
            // entity use first: tame attempts (bone/wolf, fish/ocelot,
            // seeds-or-cookie/parrot). handleMobUse ignores block clicks.
            try { if (handleMobUse(t, hand | 0)) return true; } catch (ee) {}
            // armor stands: dress / name-tag on right-click
            try { if (handleStandUse(t, hand | 0)) return true; } catch (ee) {}
            if ((t.type === "block" || t.x != null) && handleBlockUse(t, hand | 0)) return true;
          }
        } catch (e) {}
        return origR(t, hand);
      };
    }
  } catch (e) {}
  // 3) eating via the item-use path (food only; everything else untouched)
  try {
    const inter = g.interaction;
    if (inter && !inter._svEatPatched && typeof inter._onItemUse === "function") {
      inter._svEatPatched = true;
      const origUse = inter._onItemUse.bind(inter);
      inter._onItemUse = function (t, e) {
        try {
          // entity/item-use route: tame attempts ride here when the engine
          // targets an entity instead of a block (hand inferred from stacks;
          // handleMobUse ignores block clicks and wrong items). Runs before
          // eating so fish/seeds tame instead of being eaten near a pet.
          if (survives() && t) {
            try {
              let h = 0;
              try {
                const mh = mainHeld(), oh = offHeld();
                if (e && oh && e.id === oh.id && !(mh && e.id === mh.id)) h = 1;
              } catch (ee) {}
              try { if (handleVillagerUse(t)) return true; } catch (ee) {}
              try { if (handleHorseUse(t, h)) return true; } catch (ee) {}
              if (handleMobUse(t, h)) return true;
              try { if (tryDragonRitual(t, h)) return true; } catch (ee) {}
              try { if (handleStandUse(t, h)) return true; } catch (ee) {}
            } catch (ee) {}
          }
          if (survives() && e && e.id) {
            const def = g.items && g.items.def ? g.items.def(e.id) : null;
            const nm = def ? def.name : null;
            // P4: goat horn blow (7s cooldown, random call variant) + recovery
            // compass reading (reports last death point + distance).
            if (nm === "goat_horn") {
              if ((SV.hornCd || 0) <= Date.now()) {
                SV.hornCd = Date.now() + 7000;
                try { sfx("item.goat_horn.sound." + ((Math.random() * 8) | 0)); } catch (eH) {}
              }
              return true;
            }
            if (nm === "recovery_compass") {
              try {
                const dp = SV.deathPos;
                if (!dp) chat("§eNo death to recover from yet.");
                else {
                  const p0 = g.player;
                  const d = Math.hypot(p0.x - dp.x, p0.z - dp.z) | 0;
                  chat("§eLast death: " + (dp.x | 0) + ", " + (dp.y | 0) + ", " + (dp.z | 0) +
                    " (" + d + "m away" + (dp.dim === -1 ? ", Nether" : dp.dim === 1 ? ", End" : "") + ")");
                }
              } catch (eC) {}
              return true;
            }
            if (nm === "potion") {
              if (tryDrinkPotion(e)) return true;
            } else if (nm && (foodNutri(nm) || nm === "milk_bucket" || nm === "honey_bottle")) {
              const fx = FOOD_FX[nm];
              if (getFood() < 20 || (fx && fx.always) || nm === "milk_bucket" || nm === "honey_bottle") {
                if (tryEat(e)) {
                  try { if (typeof origUse === "function" && e.count > 0) { /* consumed above */ } } catch (ee) {}
                  return true;
                }
              }
            } else if (nm === "glass_bottle") {
              // v1.16.0: scoop dragon's breath from a lingering cloud
              if (scoopBreath(e)) return true;
            }
          }
        } catch (err) {}
        return origUse(t, e);
      };
    }
  } catch (e) {}
}

/* ---------------------------------------------------------- boot */

function boot(g0) {
  // game handle may be passed directly (boot1194 wires us explicitly);
  // otherwise wait for the engine + singleplayer to publish their globals
  if (g0 && !globalThis.game) { try { globalThis.game = g0; } catch (e) {} }
  if (!globalThis.game || !globalThis.__mcSingleplayer || !globalThis.__mcSingleplayer.state) {
    setTimeout(() => boot(), 300);
    return;
  }
  try { installHooks(); } catch (e) { console.error("[survival] patch failed", e); }
  try { initStateIds(); } catch (e) { console.warn("[survival] state-id resolve failed", e); }
  // world-entry watcher: (re)arm survival when a world goes live
  if (!SV.watcher) {
    SV.watcher = setInterval(() => {
      try {
        const sp = SP(), g = game();
        try { ensureWorldHook(); } catch (e) {}
        const live = !!(sp && sp.active && g && g.inWorld);
        const mode0 = live && (sp.mode | 0) === 0;
        if (live && mode0 && !SV.on) {
          SV.on = true;
          SV.dead = false;
          SV.air = 15;
          SV.exh = 0;
          SV.fx = {}; SV.absorb = 0;
          SV.burnUntil = 0; SV.burnAcc = 0;
          SV.atkAt = 0;
          SV.peakY = null;
          SV.mobs.clear();
          SV.corpses = []; // v1.12: death anims are session-only
          SV.items.clear(); SV.arrows.clear(); SV.orbs.clear();
          SV.trackedArrows = new Map();
          SV.boats.clear(); SV.rideBoat = -1;
          SV.carts.clear(); SV.rideCart = -1;
          SV.horses.clear(); SV.rideHorse = -1;
          SV.rideCamel = -1; // P4
          SV.stands.clear();
          SV.crops.clear(); SV.cropAcc = 0;
          try {
            const p = g.player;
            SV.lastX = p.x; SV.lastZ = p.z;
          } catch (e) {}
          restoreSurvState();
          try { rescanCropsFromOverrides(); } catch (e) {}
          setTimeout(() => { try { respawnSavedItems(); } catch (e) {} try { respawnSavedBoats(); } catch (e) {} try { respawnSavedCarts(); } catch (e) {} try { respawnSavedHorses(); } catch (e) {} try { respawnSavedStands(); } catch (e) {} }, 3000);
          try { V_SEED.done.clear(); V_SEED.slots.clear(); } catch (e2) {}
          setTimeout(() => { try { seedVillages(true); } catch (e) {} }, 5000);
          chat("§eSurvival mode: damage, hunger, drops and mobs are ON");
        } else if ((!live || !mode0) && SV.on) {
          SV.on = false;
          SV.dead = false;
          hideDeath();
          // destroy our entities so creative worlds stay clean
          try {
            const ids = [];
            SV.mobs.forEach((m) => ids.push(m.id));
            SV.items.forEach((it) => ids.push(it.id));
            SV.arrows.forEach((a) => ids.push(a.id));
            SV.orbs.forEach((o) => ids.push(o.id));
            if (SV.tnt) SV.tnt.forEach((r) => ids.push(r.id));
            if (SV.bobber) ids.push(SV.bobber.id);
            SV.boats.forEach((b) => ids.push(b.id));
            SV.carts.forEach((c) => ids.push(c.id));
            SV.horses.forEach((h) => ids.push(h.id));
            SV.stands.forEach((s) => ids.push(s.id));
            if (SV.corpses) for (const c of SV.corpses) ids.push(c.id); // v1.12 death anims
            if (ids.length) g.entities.destroy(ids);
          } catch (e) {}
          SV.mobs.clear(); SV.items.clear(); SV.arrows.clear(); SV.orbs.clear();
          SV.boats.clear(); SV.rideBoat = -1;
          try { V_SEED.done.clear(); V_SEED.slots.clear(); } catch (e2) {}
          SV.carts.clear(); SV.rideCart = -1;
          SV.horses.clear(); SV.rideHorse = -1;
          SV.rideCamel = -1; // P4
          SV.stands.clear();
          SV.crops.clear(); SV.cropAcc = 0;
          try { SV.tiles && Array.from(SV.tiles.keys()).forEach((k) => { if (String(k).slice(0, 5) === "cart:") SV.tiles.delete(k); }); } catch (e2) {}
          try { SV.tiles && Array.from(SV.tiles.keys()).forEach((k) => { if (String(k).slice(0, 6) === "horse:") SV.tiles.delete(k); }); } catch (e2) {}
          if (SV.tnt) SV.tnt.clear();
          SV.bobber = null; SV.bowDraw = null;
          if (SV.trackedArrows) SV.trackedArrows.clear();
        }
      } catch (e) {}
    }, 1000);
  }
  if (!SV.tickTimer) {
    SV.tickTimer = setInterval(() => {
      try { if (survivesLoose()) masterTick(); } catch (e) {}
      try { weatherTick(0.1); } catch (e) {} // world weather runs in any mode
    }, 100);
  }
  globalThis.__mcSurvival = {
    get on() { return survivesLoose(); },
    get state() { return SV; },
    damage: (n, cause, o) => damagePlayer(n, cause, o),
    respawn: () => respawn(), // test hook: revive the player after death
    spawn: (species, x, y, z) => spawnMob(species, x, y, z),
    mobs: () => Array.from(SV.mobs.keys()),
    mobTypes: () => Object.fromEntries(Object.entries(MOB_DEFS).map(([k, v]) => [k, v.type])), // registry-check: static sim species→type snapshot (read-only copy)
    explorerMap: (kind) => ((kind | 0) === 2 ? allocOceanMap() : allocExplorerMap()), // v1.15.0 test hook: allocate an explorer survey (1 woodland, 2 ocean)
    orbs: () => Array.from(SV.orbs.keys()),
    xp: (n) => addXP(n),
    fx: (name, lvl, ticks) => addFx(name, lvl, ticks),
    nutri: (n) => foodNutri(n),
    eatId: (id) => tryEat({ id, count: 1 }),
    hurtMob: (id, n, o) => damageMob(id, n, 1, 0, o),
    killMob: (id, byPlayer) => { const m = SV.mobs.get(id); if (m) mobDie(m, byPlayer); },
    orb: (x, y, z, v) => spawnXPOrb(x, y, z, v),
    cloud: (x, y, z, r, t) => spawnCloud(x, y, z, r, t), // v1.16.0 test hook: breath cloud for the bottle scoop
    boomAt: (x, y, z) => explode({ x, y, z }),
    use: (x, y, z, face, hand) => handleBlockUse({ x, y, z, face: face == null ? 1 : face, hit: [x + 0.5, y + 0.5, z + 0.5], type: "block" }, hand | 0),
    // P4: singleplayer's mansion warmer seeds the sanctum chest through here
    // (tiles live in the SURVIVAL record, not singleplayer's — restoreTiles
    // only reads loadWorldRecSv). Idempotent: never overwrites a live tile
    // (so player-looted chests stay looted), persists to the SV rec so a
    // warmer that runs before restore still lands correctly on restore.
    giveTile: (key, tile) => {
      try {
        SV.tiles = SV.tiles || new Map();
        if (!SV.tiles.get(key)) SV.tiles.set(key, tile);
        const sp = SP();
        if (sp && sp.id) {
          const rec = loadWorldRecSv(sp.id) || {};
          rec.tiles = rec.tiles || [];
          let has = false;
          for (const t of rec.tiles) { if (t && t.k === key) { has = true; break; } }
          if (!has) {
            rec.tiles.push({
              k: key, type: tile.type,
              items: (tile.items || []).map((s) => s ? { id: s.id, c: s.count | 0, n: s.nbt || null } : null),
            });
            rec.svIds = 1152; // native-id stamp (matches the save path; skips remapSvIds)
            saveWorldRecSv(sp.id, rec);
          }
        }
        return true;
      } catch (e) { return false; }
    },
    tame: (t, hand) => handleMobUse(t, hand | 0),
    tnt: (x, y, z) => spawnPrimedTNT(x, y, z),
    throw: (kind, hand, potion) => spawnThrown(kind, hand | 0, potion || null),
    rod: (hand) => rodUse(hand | 0),
    bowFire: (secs, hand) => fireBow({ t: secs || 1, hand: hand ? "off" : "main" }),
    tridentFire: (secs, hand) => fireTrident({ t: secs || 1, hand: hand ? "off" : "main" }), // v1.15.0 test hook: throw without the RMB hold
    weather: () => ({ rain: isRaining(), thunder: isThundering() }),
    setWeather: (kind, secs) => setWeather(kind, secs),
    strike: () => lightningStrike(),
    drink: (stack) => tryDrinkPotion(stack),
    potionFx: (suffix) => potionFxFor(suffix),
    splash: (suffix, x, y, z) => splashPotionFx(suffix, x, y, z),
    dyeOf: (item) => DYE_COLOR[item] || null,
    eggOf: (item) => EGG_SPECIES[item] || null,
    bonus: (name, held) => bonusDrops(name, Math.random, held || null),
    boat: (v, x, y, z) => spawnBoat(v | 0, x, y, z),
    mount: (id) => mountBoat(id | 0),
    dismount: () => dismountBoat(),
    boats: () => Array.from(SV.boats.keys()),
    ride: () => SV.rideBoat,
    cart: (v, x, y, z) => spawnCart(v | 0, x, y, z),
    cmount: (id) => mountCart(id | 0),
    cride: () => SV.rideCart,
    carts: () => Array.from(SV.carts.keys()),
    villagers: () => Array.from(SV.mobs.values()).filter((m) => m.species === "villager" || m.species === "iron_golem").map((m) => ({ id: m.id, species: m.species, x: Math.round(m.x * 10) / 10, y: Math.round(m.y * 10) / 10, z: Math.round(m.z * 10) / 10, hp: Math.round(m.hp), home: m.village || null })),
    seedVillages: (f) => seedVillages(!!f),
    // B2 trade inspection/control
    vtrade: () => Array.from(SV.mobs.values()).filter((m) => m.species === "villager" && m.trade).map((m) => ({ id: m.id, prof: vtProfName(m), lvl: m.trade.lvl, xp: m.trade.xp, rep: m.trade.rep, offers: m.trade.offers.map((o) => ({ w: o.a && o.a.id, q: o.a && o.a.count, g: o.out && o.out.id, gq: o.out && o.out.count, uses: o.uses, max: o.max, dis: !!o.disabled, dem: o.demand, sp: o.specialPrice, xp: o.xp })) })),
    openTrade: (id) => { const m = SV.mobs.get(id | 0); return m ? openTrade(m) : false; },
    closeTrade: () => closeTradeWindow(false),
    vtUnlock: (id, lvl) => { const m = SV.mobs.get(id | 0); if (!m) return false; try { vtUnlock(m, lvl | 0); return true; } catch (e) { return false; } },
    horse: (sp, x, y, z) => spawnHorse(sp, x, y, z),
    hmount: (id) => mountHorse(id | 0),
    hdismount: () => dismountHorse(),
    hride: () => SV.rideHorse,
    horses: () => Array.from(SV.horses.keys()),
    stands: () => Array.from(SV.stands.keys()),
    suse: (t, hand) => handleStandUse(t, hand | 0),
    huse: (t, hand) => handleHorseUse(t, hand | 0),
    till: (x, y, z) => tillSoil(x | 0, y | 0, z | 0),
    rpow: (x, y, z) => redstonePowered(x | 0, y | 0, z | 0),
    pist: (x, y, z) => pistFire(x | 0, y | 0, z | 0), // v1.13 test hook: force a piston edge check
    pistonPowered: (x, y, z) => pistonPowered(x | 0, y | 0, z | 0),
    obs: (x, y, z) => obsTrigger(x | 0, y | 0, z | 0),
    pistJ: () => SV.pistJ.length,
    rsig: (x, y, z) => { // v1.11 test hook: dust power 0-15 at a cell
      try {
        const st = game().world.getState(x | 0, y | 0, z | 0);
        return (defOf(st) && defOf(st).name === "redstone_wire") ? ((stProp(st, "power") | 0) || 0) : null;
      } catch (e) { return null; }
    },
    tiles: () => { const o = []; try { SV.tiles.forEach((t, k) => o.push({ k, type: t.type, cd: t.cd | 0, pow: !!t.pow, items: (t.items || []).map((s) => s ? { id: s.id, c: s.count | 0, n: s.nbt || null } : null) })); } catch (e) {} return o; },
    wipeTiles: () => { try { SV.tiles.clear(); } catch (e) {} return true; },
    setTileItems: (x, y, z, items) => { const t = getTile(x | 0, y | 0, z | 0); if (!t) return false; t.items = items.map((s) => s ? { id: s.id, count: s.count | 0, nbt: s.nbt || null } : null); return true; },
    sow: (name, x, y, z) => plantCrop(name, x | 0, y | 0, z | 0),
    boneAt: (x, y, z) => applyBoneMeal(x | 0, y | 0, z | 0),
    hives: () => { const o = []; try { hivesMap().forEach((h, k) => o.push({ k, x: h.x, y: h.y, z: h.z, nest: !!h.nest, honey: hiveHoney(h), bees: (h.bees || []).length })); } catch (e) {} return o; },
    hiveAt: (x, y, z) => { try { const h = hiveAtKey(hiveKey(x | 0, y | 0, z | 0)); return h ? { x: h.x, y: h.y, z: h.z, nest: !!h.nest, honey: hiveHoney(h), bees: (h.bees || []).map((b) => ({ t: Math.round(b.t || 0), nectar: !!b.nectar, baby: !!b.baby })) } : null; } catch (e) { return null; } },
    seedNests: (f) => seedNests(!!f),
    crops: () => (SV.crops ? SV.crops.size : 0),
    rescan: () => rescanCropsFromOverrides(),
    // nether travel (called from the singleplayer looper in any mode)
    portalTick: () => portalTick(),
    // end travel + eye flight (looper calls these in any mode)
    endPortalTick: () => endPortalTick(),
    eyeTick: (dt) => eyeTick(dt == null ? 0.4 : dt),
    enderEye: (hand, consume) => eyeThrow(hand | 0, consume !== false),
    fillEnd: (x, y, z) => lightEndPortalAt(x | 0, y | 0, z | 0),
    stashDim: (dim) => stashDim(dim | 0),
    unstashDim: (dim) => unstashDim(dim | 0),
    // run n real master ticks synchronously (10/second game time). The live
    // 100ms timer is throttled in background tabs, so wall-clock waits can't
    // drive the sim — this hook steps the exact production path on demand.
    tick: (n) => {
      n = Math.max(1, Math.min(n | 0 || 1, 500));
      for (let i = 0; i < n; i++) { try { masterTick(); } catch (e) {} }
      return n;
    },
  };
  console.log("[survival] ready");
}

// Wired explicitly by boot1194 (side-effect import runs this IIFE, then the
// boot module calls the handle below). No DOMContentLoaded auto-boot: the
// engine may still be loading assets at that point, and double-boot is
// pointless — the watcher + guards inside boot() are idempotent anyway.
try { globalThis.__mcBootSurvival = boot; } catch (e) {}

})();
