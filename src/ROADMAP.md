# Roadmap: v2.0.0 SHIPPED — next arc toward 3.0.0

v2.0.0 (2026-11-08) SHIPPED the 1.19.4 engine jump: single engine
(`src/mc1194/`), protocol 762 multiplayer, 998 blocks / 1,228 items /
124 entity types, native 1.19.4 assets + sounds, streaming long tracks —
plus the 1.19 content wave (frog/tadpole, allay, camel, sniffer,
warden + shrieker/sculk gameplay, mud, cherry groves + pink petals,
chest boats, recovery compass, goat horns, torchflowers, disc 5).
The 1.18.2 line is deleted; 1.18.2 saves do NOT transfer (state ids
changed).

3.0.0 candidates (breaking/foundational payload, picked later): next
engine jump, save-format migration, authoritative multiplayer, ancient
cities + archaeology (brush/suspicious blocks) + armor trims, sniffer
egg + pitcher plant (1.20), map pixel persistence, overworld biome
music events.

Every release ships under the standing rules: live in-preview
verification, deterministic `tick(n)` stepping, wiki cross-checks, zero
console errors, test-rig cleanup, FEATURES title/Get-it/bullet +
CHANGELOG entry + README version, saves carry over
untouched (within an engine line).

## Shipped (detail in CHANGELOG.md)

- v1.10.0 — Buzzy bees. SHIPPED 2026-10-30. Entity-model backfill (bee
  minimum; fox/panda/cat rode along on the same pipeline), hives/nests,
  honeycomb, honey bottles/blocks, smoke-calming, pollination/crop boost,
  stings, silk-touch nest moving.
- v1.11.0 — Redstone signal sim. SHIPPED 2026-10-30. Dust propagation +
  torches, repeaters, comparators (lever/button/plate/detector sources
  already existed).
- v1.12.0 — Mob animation pass. SHIPPED 2026-10-30. Walk/idle limb swings
  through the engine interpolator, grounded/airborne wing + leg poses,
  sitting wolves, sheep grazing, angry wolves/endermen/bees, skeleton
  bow-aim, creeper swell + charge flash, bee banking roll, horse
  rear/graze/nibble/tail-swish/saddle/rider flags, hurt flash + death
  fall-over. Purely visual: no AI or hitbox changes.
- v1.13.0 — Pistons + observers. SHIPPED 2026-10-30. Sticky/regular
  push/pull physics (12-block limit, tile-entity refusal, slime/honey
  stickiness), arm extension states, observer edge detection.
- v1.14.0 — 1.18.2 engine + Tectonic + mansions + streaming audio. SHIPPED
  2026-11-01 (stayed v1.14.0 per user: nothing new beyond the swap, then
  scope grew the same day): illager line A–D (species+AI, omen+patrols,
  raids+hero, trader+leads), 758 multiplayer, Tectonic worldgen with
  treeless meadow + depth-banded 1.18 ores, ramming goats (milkable),
  play-dead axolotls (bucketable), glow squids (ink + glow-ink drops),
  woodland mansions (residents, sanctum chest, explorer maps with survey),
  full 1.18.2 sound set with the 23 long tracks streaming.
- v1.15.0 — Optimization + ocean and underground. SHIPPED 2026-11-04
  (x.5 rule; the unplanned v1.16.0 folded in before publishing):
  router lattice 3–4×, repeat column lookups ~50×, mansion locate
  ~7 s → ~0.1 s, chunk meshing ~2–3× (identical meshes, proven);
  monument generation, elder guardian (Mining Fatigue), drowned,
  tridents, conduit + prismarine loop, Tectonic cave carving,
  lush/dripstone cave biomes, amethyst geodes, multi-biome Nether with
  fortresses (unblocked wart planting) — plus a found-and-fixed crop
  state-id conversion (1.15.2 literals writing wrong blocks, now
  name-resolved at boot). Note: carving changed worldgen — existing
  saves keep generated chunks, new ground gets caves.

## The arc (each line = one release)

- v1.16.0 — Dragon endgame. SHIPPED 2026-11-04: dragon fight, kill-gated
  exit fountain (replaced the TEMP pre-built fountain), one rim gateway
  per kill, elytra flight, plantable chorus, lattice End cities (tower +
  top room, shulkers, loot chest, 45% ship with elytra), guided-bullet
  shulkers + shells → shulker boxes, dragon's-breath source (completes
  the brewing loop; wart planting arrived via v1.15.0 fortresses).
- v1.17.0 — 1.14–1.16 life behaviors. The MODELS are already in (v1.10.0
  backfilled fox/panda/cat; goat/axolotl/glow squid shipped behaviors in
  v1.14.0) — this release is the missing AI/husbandry: fox + panda
  behaviors, cat/ocelot split (+ strays), brown mooshroom, sweet berries
  + suspicious stew, bamboo + scaffolding, lanterns (campfires shipped in
  v1.10.0).
- v1.18.0 — Gear & systems. Crossbows (+ multishot/quick charge/
  piercing), beacon buffs, jukebox + note blocks, maps/compass/clocks
  behavior (completes with map pixel persistence — survey pixels currently
  runtime-only), banners + shield patterns (loom half?), fletching/smithing
  tables if cheap, overworld biome music events (the last audio gap),
  advancements/statistics + recipe-unlock progression.
- v1.19.0 — Ship-shape plan (superseded by the 1.19.4 pivot — folded into
  v2.0.0 below). Phase F presentation + Tier 0–3 re-verify + "2.0.0-ready"
  sign-off became the 1.19.4 port + 1.19 content wave instead.
- v2.0.0 — 1.19.4 engine + 1.19 content. SHIPPED 2026-11-08. Breaking:
  single-engine move to 1.19.4 (protocol 762, pack format 13, 998 blocks
  / 1,228 items / 124 entity types, native 1.19.4 assets + sounds,
  streaming long tracks; 1.18.2 saves do NOT transfer). New life:
  frog/tadpole (+ frogspawn hatch, buckets, grow-up), allay
  (fetch/dance/dupe), rideable camel (saddle + dash), sniffer (digs
  torchflower seeds; torchflower crop), warden + shrieker warnings,
  darkness 33 and sonic boom, sculk patches in deep tectonic caves,
  swamp mud, cherry groves + pink petals, chest boats (27 slots, spill,
  persist, renderer chest), recovery compass (+ death-point persist),
  goat-horn blowing (+ wall-ram drops), disc-5-from-fragments and chest-
  boat recipes, echo-shard/fragment mansion stopgap. Fixed en route:
  sculk branch sat inside the carve block (open cells only — moved to
  solid cells), tadpole hatch sfx id, entity-models warden brace.
  slate. Not before. The bar (set 2026-11-01, raised same day to
  match-or-beat Sodium): on the same reference hardware and scene it must
  run FASTER than vanilla while looking BETTER by default. Measurement is
  already in place (F3 fps + Alt+F3 lagometer + F3 mS worker-mesh average +
  Shift+F3 profiler); the mesher is ~3× down already (v1.15.0), the frame
  loop shed its worst hogs the same day (visible-set cache: cull 5.6ms to
  ~0 static; rain collision bypass: tick 516ms to ~2ms; suspended-audio
  guards: 4500-voice leak plugged), and the look defaults are maxed
  (fancy graphics, max smooth lighting, blend radius 2, fancy clouds,
  entity shadows, 4× mipmaps, full particles). Sim side (Lithium pass,
  same day): resting entities reuse their last collision sweep instead of
  re-sweeping (world-gen counter invalidates on any edit; supported by a
  gravity-already-balanced skip), block display ticks run at vanilla's 20Hz
  instead of per-frame (~1ms/frame saved), entity iteration sheds its
  per-frame array copy — sim behavior bit-identical (support-break fall,
  fall damage, TNT rest+detonate, mansion still at -5078,-1417 verified).
  Block-entity side (Better Block Entities pass, same day, unreleased):
  static tiles cache brightest-neighbour light (refreshed 10Hz), skip
  redundant lid/book/beacon/campfire syncs, cold builds amortize 3/frame,
  static-camera occlusion reuses the cull cache — tile render ~5.6x down,
  behavior identical (lids animate, book spins, beacon fades, campfire
  smokes). Fixed while there: rain-sky flicker (prevRain never updated so
  the render interpolation ramped 0→full every tick; now mirrors vanilla
  prev=current-then-ease) and a _scheduleMeshes crash race (dirty section
  whose chunk unloaded before scheduling — now skipped). Entity side
  (Entity Culling pass, same day, unreleased): per-entity occlusion walks
  cached (frustum still per frame; re-test on >1-block move, camera cell
  change, world edit, or 120-frame age) — ~46x fewer culler walks
  (3.9/frame vs ~180 uncached for a 61-entity scene), identical visible set
  (fresh-vs-cached culled counts agree). Save side (FastQuit pass, same day,
  unreleased): quitting snapshots/unloads NOW and finishes the save in
  background slices (prune ≤8ms/slice, store write post-title) with
  re-entry/rename/delete guards, a pagehide flush, a world-list "saving…"
  badge, and incremental prune (untouched dims skip — also speeds autosaves):
  quit returns in ~30ms, a 2400-edit save lands exact a moment later, and
  world-switching now persists the outgoing world instead of dropping its
  dirty state. Memory side (FerriteCore pass, same day, unreleased):
  title-only decoded pixels evicted on world entry (~24MB JS; device
  textures stay for instant title), section blocks Uint32→Uint16
  (16KB→8KB/section) — prune verified exact on the new storage; the asset
  zips stay deliberately (runtime SFX/texture library). Submit side
  (ImmediatelyFast pass, same day, unreleased): prebuilt per-layer section
  draw descriptors (~1000 transient objects/frame eliminated), frozen
  sky/cloud/outline/break/GUI states (device cache hits by identity),
  scratch params/matrices — identical GL call sequence, verified live. Input side
(Ixeris pass, same day, unreleased): mousemove staged into scratch scalars,
drained as one batched event per frame (spike guard kept per-sample) — 20k-event
flood 311ms→63ms with zero synchronous screen callbacks, camera yaw bit-exact,
spike rejection intact. Launch side (ModernFix-mVUS pass, same day,
unreleased): the sound zips (138MB, 87% of boot bytes) stream in background
instead of blocking the title — blocking fetch 2551ms→1017ms in-harness,
identical resolution through a fallback-arrival gate, failed fetch stays
fatal. Animation side (Animatica pass, same day, unreleased): OptiFine
optifine/anim custom animations for non-block/item textures (GUI/entity/...)
at the same tick site as the atlas — exact frame/interpolate/skip math,
atlas members stay .mcmeta-only. Connected-textures side (Continuity pass,
same day, unreleased): OptiFine method=ctm + method=horizontal (glass/panes
+ bookshelves scope; glass verified live 16/16 per-face tile predictions
from GPU-readback UVs, atlas pixels byte-checked) — worker-compiled rules,
first-match-wins, behavior-identical with no CTM pack. Shader-compat side
(E-LITE 5.1.3 pass, same day, unreleased): final-stage bridge hardened —
macros with trailing `//` option comments collected, line-mode splitting
restored (was whole-blob), function-scoped uint guards with
continuation-aware head detection (multi-line `#define` no longer blinds
later functions) — E-LITE compiles on all 3 dims (56 options) and renders
day/night/nether live, BSL still loads, vanilla restore pixel-correct. Cave side
(v1.15.0 pass, same day, folded in before publishing): Tectonic final_density sign() carve per
block below the surface (depth gate lives in the data: range_choice depth<0.1
keeps sloped_cheese, else caves; flooded at/below sea, deep caves dry) —
verified live as a ~40-wide flooded cavern with remnant pillars at
(4935,65,5008) seed 1, reload-exact (cave FNV 7f1d0527, spawn chunk ebcc0897,
mansion still -5078,-1417), zero console errors. Geode/biome side (same pass,
unreleased): amethyst geodes (cell-192 jittered lattice, basalt/calcite/
amethyst shells, facing-correct buds), lush/dripstone cave-biome blobs with
moss/clay/rooted floors + dripstone/spore/carpet decor, data-driven state
codec (bud-up hits the table default exactly), surface-based flood rule
(ocean caves flood, land caves walkable — aquifer approximation).
  Ocean-monument side (same pass, unreleased): monument worldgen was already
  in (lattice/O_CELL structures + treasure core); sim half landed —
  seedMonuments (3 persistent elders, loaded-chunk + headroom gates,
  re-seeds after the respawn wipe like villages), guardian natural spawns in
  monument water + night drowned in nearby water, hostile 3D swim AI (chase
  + bite; drowned walk on land; guardians/elders suffocate out of water),
  elder mining-fatigue aura (50m, MF III 5min, sim + engine effect both),
  drowned rare drops (trident 6%, shell 3%, player kills) + elder sponge.
  Verified live on seed 1 (survival, diff 2): elders seeded/persistent/
  swimming, guardian melee kill credited, aura MF III in sim + engine, drop
  census (22 flesh/3 trident/2 shell/4 shard/1 sponge), trio screenshot
  scratch/shots/v116-trio.png. M3 items side (same pass, unreleased): sponge
  absorb on place (radius-7 taxicab cap-65 water clear, wet_sponge via the
  placedWet water-placement path), conduit place/break watch-set (frame
  validated live: 16/28/42 → radius 32/64/96 + water oxygen; full 42 zaps
  hostiles 4 dmg in 8 blocks), reload persistence both halves (world diffs +
  rec.conduits, power re-applies), cartographer journeyman ocean map
  (13 emerald + compass, water-blue survey with brown monument blob + red
  heart at the true monument), player-thrown trident (spear-draw charge ≥0.5s,
  type-83 entity, 8 dmg + impaling, loyalty return incl. sky-throw age-out,
  plain drops keep damage, death-in-flight drops the stash, riptide defers to
  the engine). Verified live: throw/drop/pickup, 10→2 cow, loyalty sky return
  with enchants intact, charge gate, zap 20→8, reload-exact frame + power,
  conduit screenshot v116-conduit.png. 2026-11-10: channeling (bolt on a
  channeling hit in thunder, creepers charge instead of taking bolt damage),
  drowned ranged throws (mid-range swimmers hold station and hurl 8-dmg
  tridents — verified by two throwing kills on the tester), and 2 caged
  mansion allays all shipped + verified live (creeper 20→12 + charged,
  arrow consumed). Remaining gaps: laser/beam + thorns, trident ground-drop
  enchant NBT (engine
  tryPickup carries id/damage/count only), axolotl lush spawns, true
  aquifers/lava lakes.
  ImmersiveVFX side (2.0.0 port, same day, unreleased): the full mod
  (fog/sky/biome-tag/light-ray data + 65 GLSL sources ported to JS/CPU
  grading, hand-built ambient emitters covering the mod's mote set
  (generic sprites, not the 441 bedrock defs verbatim), aurora/meteors/
  fireworks/shafts/mist/caustics/foam/glints/bloom/halos/GPU grass/
  cloud layers/End aura/horizon glow, 95 settings + 7 presets + full
  options screen off Video Settings) with the E-LITE + BSL packs
  removed as redundant. 1:1 follow-up: per-dimension per-system allow
  lists (8 systems x Overworld/Nether/End, mod defaults), a working
  Shadows page (blob-shadow scaling), wired Weather visuals (vanilla /
  enhanced / custom rain streaks with engine streaks stood down),
  the menu hotkey (V), second aurora pass, waterfall/floating-leaf
  mist, Moving Plants/Leaves sway, modded-biome gating, torch-gamma
  regrade, and a master ON/OFF toggle (Video Settings + IVFX General;
  OFF restores vanilla live, foliage tints included). Built-in shader
 (same day, unreleased): native fullscreen post chain (new post programs
 17/18 in all three gfx backends + render/builtin-shader.js, driven from
 the frame loop ahead of external packs, stood down while a pack or
 entity-view shader owns the frame): half-res bright-pass bloom, ACES
 tonemap, vignette, animated grain, water/lava/hurt eye tints; Shaders
 list entry renamed Built-in (MinecraftJS) and defaulted on, Video
 Settings toggle + options screen. Verified live (noon vista ON vs OFF,
 options screens, toggle wiring; WebGPU/WGSL + CPU paths code-reviewed
 only). CAUGHT: my first fullscreen quad literal had 37 floats
 (vertexCount 4.11 — always count mesh literals: stride 9 means 36 floats
 = 4 verts), which scrambled the present into diagonal bands. Fixed en route: the cloud layer rendered as
  dark streaks — giant single quads inherit fog from their far corners
  (per-vertex vDepth interpolation), so each layer is tessellated 8x8
  and cloud textures tile with repeat wrap. Verified live day + night.
  Known blocked item: true
  world-space verts need 32-bit positions or region-relative packing first
  (the unorm16 format wraps past 24 blocks — attempted and reverted).
  Upgrade prep done so far: version manifest (`js/version.js` — F3/footer
  follow it), boot registry-check (`js/registry-check.js`, catches the P2
  id-shift outage class), version-suffixed table convention (never edit in
  place), native-asset build scripts rebuilding from pinned vanilla
  artifacts. Remaining before the jump: a reference FPS methodology
  (the dev harness cannot measure FPS reliably) and a same-scene vanilla
  baseline to beat.

## Dependencies (all satisfied by prior work on the 1.18.2 line)

Phase A done: villages, 9 biomes, Nether (portals, 8:1 travel),
End (pillars, chorus islands, stronghold ring, eyes). Wither done
(v1.8.0). Dispenser/hopper/workstation halves done (v1.4.0/v1.7.0).
Brewing complete: wart planting (v1.15.0 fortresses) + breath via dragon
kill (v1.16.0). Tectonic overworld terrain done (v1.14.0) except carving
(v1.15.0); 1.18 mobs done except the behaviors in v1.17.0 above.
Model technique: extract from the 1.18.2 client jar exactly like the
native assets-1182.zip was built (see the P1 staleness-audit notes in
scratch/CURRENT_TASK.md) — 1.15-era asset pipelines (Mojave client,
assets-1152) are retired with the deleted line.
