// Engine version identity: the single source of truth for "which Minecraft
// is this line?". The next version jump (a 2.0.0 candidate) edits the three
// constants below, adds version-suffixed tables alongside the existing
// *-1.18.2.js files (entity registries, menus, protocol, metadata, block
// entities — never in place), swaps the native data zips, and re-runs the
// build scripts in scratch/1194-native (dl.js / assemble*.js), which already
// rebuild from pinned vanilla artifacts. User-visible strings follow
// automatically via ENGINE_LABEL / VERSION_LABEL; registry-check.js asserts
// the sim-vs-wire tables still agree after the swap.
export const MC_VERSION = '1.19.4';
export const MC_PROTOCOL = 762;
export const MC_PACK_FORMAT = 13;
export const VERSION_LABEL = `MinecraftJS ${MC_VERSION}`;
export const ENGINE_LABEL = `${VERSION_LABEL} (${MC_PROTOCOL}/vanilla)`;
