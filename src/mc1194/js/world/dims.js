// World vertical dimensions (1.18.2: Overworld Y -64..319, 24 sections).
// Single source of truth — every y-bound/section-index site uses these.
// Multiplayer protocol-578 servers still send 16 sections for 0..255;
// world.js maps those into sections SEC_OFF..SEC_OFF+15.
export const MIN_Y = -64;
export const MAX_Y = 319;
export const SEC_N = 24;
export const SEC_OFF = 4; // server section s <-> chunk.sections[s + SEC_OFF]
export const secIdx = (y) => ((y - MIN_Y) >> 4); // 0..SEC_N-1
export const secBase = (i) => i * 16 + MIN_Y;    // world y of section bottom
export const inY = (y) => y >= MIN_Y && y <= MAX_Y;

// Air-equivalent states (air, cave_air, void_air) — numeric ids are
// version-specific; blocks.js initBlocks() sets them from live tables.
// Defaults are the 1.18.2 ids (verified against data/blocks.json).
let _air = [0, 9915, 9916];
export function setAirStates(ids) { _air = Object.freeze(ids.slice()); }
export function airStates() { return _air; }
export function isAirState(s) { return _air.includes(s); }
