// Registry alignment check: the bug class that silently broke ALL sim mob
// spawns in P2 (a 1.15-vs-1.18 entity id shift — spawnMob resolved nothing)
// is table skew, and the next engine upgrade WILL re-skew every table.
// This runs once at singleplayer boot, is warn-only by design (it never
// throws and never blocks boot), and reports exactly which rows need
// attention. Deliberately import-light (entity tables only): the sim tables
// arrive as arguments so this module adds no edges to the boot graph.
import { ENTITY_TYPES, ENTITY_TYPES_762 } from './game/entity-types.js';

export function runRegistryCheck({ mobs, biomeIds, biomeNames }) {
  const problems = [];
  const notes = [];
  try {
    // 1. Every sim species resolves a sim entity definition (the P2 outage:
    //    spawnMob looked up def.type and got nothing). Faithful to the live
    //    path entities.spawnMob -> nativeEntityDefinition (index lookup).
    let simOk = 0, simTotal = 0;
    if (mobs == null) notes.push('sim mobs skipped (survival not loaded yet)');
    else {
    for (const [species, type] of Object.entries(mobs)) {
      simTotal++;
      const e = ENTITY_TYPES[type | 0];
      if (!e || e.id !== (type | 0)) problems.push(`sim species '${species}' type ${type} resolves nothing`);
      else simOk++;
    }
    notes.push(`sim mobs ${simOk}/${simTotal} resolve`);
    }
    // 2. Cross-version drift (informational: expected across versions, but
    //    the NEXT upgrade diffs this output to see what moved).
    const simNames = new Set(ENTITY_TYPES.map((e) => e.name));
    const wireNames = new Set(ENTITY_TYPES_762.map((e) => e.name));
    const wireOnly = [...wireNames].filter((n) => !simNames.has(n));
    const simOnly = [...simNames].filter((n) => !wireNames.has(n));
    const short = (a) => (a.length > 8 ? a.slice(0, 8).join(', ') + `, +${a.length - 8} more` : a.join(', '));
    if (wireOnly.length) notes.push(`wire-only +${wireOnly.length} (${short(wireOnly)})`);
    if (simOnly.length) notes.push(`sim-only -${simOnly.length} (${short(simOnly)})`);
    // 3. Every tectonic climate biome has a valid engine biome id. Meadow
    //    intentionally maps to plains (no 1.15 id exists) — length/shape is
    //    what this guards, not the aesthetic choice.
    const ids = biomeIds || [], names = biomeNames || [];
    if (ids.length !== names.length) problems.push(`biome table skew: ${ids.length} ids vs ${names.length} names`);
    else {
      let biomeOk = 0;
      for (let i = 0; i < ids.length; i++) {
        if (Number.isFinite(ids[i]) && ids[i] >= 0) biomeOk++;
        else problems.push(`biome '${names[i]}' (index ${i}) has invalid id ${ids[i]}`);
      }
      notes.push(`biomes ${biomeOk}/${ids.length} map`);
    }
  } catch (e) {
    problems.push(`check crashed: ${(e && e.message) || e}`);
  }
  if (problems.length) console.warn('[registry-check] PROBLEMS:', problems.join(' | '), '—', notes.join('; '));
  else console.log('[registry-check] OK:', notes.join('; '));
}
