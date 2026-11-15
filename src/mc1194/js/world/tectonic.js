// Tectonic worldgen facade: router evaluation, surface-height search,
// per-chunk height lattice, and climate sampling.
//
// Data: ./tectonic-data.js (Tectonic v2.2.2 density functions for the
// "overworld" (non-large-biomes) router + vanilla fill-ins).
//
// Reference semantics (all verified against primary sources):
//  - Noise (Xoroshiro/Normal/Blended) = vanilla 1.18.2. NormalNoise matches
//    deepslate@0.12.1 bit-exactly; BlendedNoise uses FULL octave masks
//    (16/16/8, all nonzero) with positional seeding, as proven by
//    disassembling the vanilla 1.18.2 server jar's BlendedNoise class
//    (dhz: rangeClosed(-15,0) x2, rangeClosed(-7,0), new/positional path).
//    (0.12.1's BlendedNoise uses reduced masks and does NOT match the jar.)
//  - shift_x/shift_z bare references = vanilla flat_cache(cache_2d(
//    shift_a/shift_b(noise "minecraft:offset"))), identical in the 1.18.2,
//    1.20.1, 1.20.4 and latest jars (checked). The bundle's
//    minecraft:shift_x/shift_z NOISES ({firstOctave:-3, amplitudes:[1]})
//    exist in no vanilla version and are ignored.
//  - "minecraft:y" = block Y (used by Tectonic source files).
//  - Cell size for `interpolated`: 4 x 8 (Tectonic noise_settings:
//    size_horizontal=1, size_vertical=2). Sea level 63 (same file).
//  - blend_alpha/offset/density = 1/0/passthrough (no old-chunk blending;
//    single-pass worldgen).
//  - 6 source noises didn't make the bundle; only
//    tectonic:hbridges/weathering is referenced, so only it was added back
//    (see tectonic-data.js). The 25 unbundled density functions are all
//    large-biomes variants / ore-vein router fields: out of scope.

import { buildDensityGraph } from "./tectonic-density.js";
import { TECTONIC_FUNCTIONS, TECTONIC_NOISES } from "./tectonic-data.js";
import { MIN_Y, MAX_Y } from "./dims.js";

export const TECTONIC_SEA = 63;
export const TECTONIC_MIN_Y = MIN_Y; // -64
export const TECTONIC_MAX_Y = MAX_Y; // 319

// Router root ids in the bundle.
const R_FINAL = "minecraft:overworld/noise_router/final_density";
const R_CONTINENTS = "minecraft:overworld/noise_router/continents";
const R_EROSION = "minecraft:overworld/noise_router/erosion";
const R_TEMPERATURE = "minecraft:overworld/noise_router/temperature";
const R_VEGETATION = "minecraft:overworld/noise_router/vegetation";
const R_RIDGES = "minecraft:overworld/noise_router/ridges";
const R_DEPTH = "minecraft:overworld/noise_router/depth";

const states = new Map(); // seedU32 -> router state

export function tectonicState(seed) {
  seed = seed >>> 0;
  let st = states.get(seed);
  if (st) return st;
  const g = buildDensityGraph(TECTONIC_FUNCTIONS, TECTONIC_NOISES, seed,
    { cellWidth: 4, cellHeight: 8 });
  st = {
    seed,
    finalDensity: g.get(R_FINAL),
    continents: g.get(R_CONTINENTS),
    erosion: g.get(R_EROSION),
    temperature: g.get(R_TEMPERATURE),
    vegetation: g.get(R_VEGETATION),
    ridges: g.get(R_RIDGES),
    depth: g.get(R_DEPTH),
    clearCaches: () => g.clearCaches(),
  };
  if (states.size > 8) {
    const first = states.keys().next().value;
    states.delete(first);
  }
  states.set(seed, st);
  return st;
}

// Exact surface height for one column: first solid block scanning down.
// Returns MIN_Y-1 when the column is all air (deep ocean handled by caller
// via sea fill; height stays below sea so water fills it).
//
// The coarse top-down scan only needs each sample's SIGN, so it uses the
// pruning sign() evaluator (Min/Max skip whole subtrees once one side
// decides; sign() === Math.sign of compute() for every node by
// construction). The bisect and the peak check need exact values.
export function tectonicHeightExact(x, z, seed) {
  const st = tectonicState(seed);
  const fd = st.finalDensity;
  // Coarse top-down scan, then bisect. Most surfaces are far below the cap,
  // so start high but step coarsely.
  let y = TECTONIC_MAX_Y;
  if (fd.sign(x, y, z) > 0) return TECTONIC_MAX_Y; // peak above cap: clamp
  // scan down in steps of 8 for the first solid sample
  let ySolid = -1;
  for (y = TECTONIC_MAX_Y - 8; y >= MIN_Y; y -= 8) {
    if (fd.sign(x, y, z) > 0) { ySolid = y; break; }
  }
  if (ySolid < 0) {
    // never solid: check the floor itself (density at MIN_Y can be > 0 while
    // MIN_Y+8 is not, when the floor is thin)
    if (fd.compute(x, MIN_Y, z) > 0) return MIN_Y;
    return MIN_Y - 1;
  }
  // bisect between ySolid (solid) and ySolid+8 (air) for the top solid block
  let lo = ySolid, hi = Math.min(ySolid + 8, TECTONIC_MAX_Y);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fd.compute(x, mid, z) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function tectonicClimate(x, z, seed) {
  const st = tectonicState(seed);
  return {
    continents: st.continents.compute(x, 0, z),
    erosion: st.erosion.compute(x, 0, z),
    temperature: st.temperature.compute(x, 0, z),
    vegetation: st.vegetation.compute(x, 0, z),
    ridges: st.ridges.compute(x, 0, z),
    depth: st.depth.compute(x, 0, z),
  };
}

// Light variant for the per-column biome mapping (colInfo): only the three
// fields the mapping reads. The other three subtrees (continents/ridges/
// depth) are as expensive as these and would be pure waste per column;
// spawn search keeps the full variant (it gates on continents).
export function tectonicClimateLite(x, z, seed) {
  const st = tectonicState(seed);
  return {
    temperature: st.temperature.compute(x, 0, z),
    vegetation: st.vegetation.compute(x, 0, z),
    erosion: st.erosion.compute(x, 0, z),
  };
}

// Per-chunk lattice: heights sampled every 4 blocks (5x5), bilinearly
// interpolated per column. Sized for two working sets at once (1024): the
// streaming radius (~300 chunks) plus a far-field consumer like the mansion
// survey (a 32x32-chunk pixel span). With a small cache those two evict each
// other and every survey pixel rebuilds its whole lattice (~14ms); here both
// fit (~600KB). Records are pure in (seed,cx,cz) — capacity only affects hit
// rate, never values. Interpolated-node corner caches are still cleared on
// each lattice miss so their memory stays bounded.
const chunkCache = new Map(); // "seed,cx,cz" -> {h: Int16Array(256)}
const CHUNK_CACHE_MAX = 1024;

export function tectonicChunk(cx, cz, seed) {
  seed = seed >>> 0;
  const key = seed + "," + cx + "," + cz;
  let rec = chunkCache.get(key);
  if (rec) {
    // refresh LRU position
    chunkCache.delete(key);
    chunkCache.set(key, rec);
    return rec;
  }
  const st = tectonicState(seed);
  st.clearCaches();
  // 5x5 lattice at 4-block spacing (covers 0..16 inclusive)
  const lat = new Int16Array(25);
  for (let lz = 0; lz < 5; lz++) {
    for (let lx = 0; lx < 5; lx++) {
      lat[lz * 5 + lx] = tectonicHeightExact(cx * 16 + lx * 4, cz * 16 + lz * 4, seed);
    }
  }
  const h = new Int16Array(256);
  for (let lz = 0; lz < 16; lz++) {
    const gz = lz / 4, fz = lz % 4 / 4;
    const z0 = gz | 0;
    for (let lx = 0; lx < 16; lx++) {
      const gx = lx / 4, fx = lx % 4 / 4;
      const x0 = gx | 0;
      const a = lat[z0 * 5 + x0], b = lat[z0 * 5 + x0 + 1];
      const c = lat[(z0 + 1) * 5 + x0], d = lat[(z0 + 1) * 5 + x0 + 1];
      h[lz * 16 + lx] = Math.round(a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz);
    }
  }
  rec = { h };
  chunkCache.set(key, rec);
  if (chunkCache.size > CHUNK_CACHE_MAX) {
    const first = chunkCache.keys().next().value;
    chunkCache.delete(first);
  }
  return rec;
}

export function tectonicClearChunkCache() {
  chunkCache.clear();
}
