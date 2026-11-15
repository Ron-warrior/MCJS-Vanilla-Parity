# STATUS — agent handoff (durable; survives chat resets)

- Maintainer rule (user instruction, always follow): `src/FEATURES.md`
  is the public readme — keep it newcomer-friendly (what it is, the file
  to download, how to play first, then the feature list). Whenever a
  feature is added, changed, or removed, update it to match in the same
  session.
- Release rule (user instruction, always follow): every shipped change gets
  an appropriate `vX.Y.Z` version (MAJOR = breaking, MINOR = new features,
  PATCH = fixes/tweaks): write the `src/CHANGELOG.md` entry as that
  release's description (blurb + what's new) and bump the
  `src/FEATURES.md` title version.
  (Per user: version history lives in the changelog only — FEATURES.md
  carries no per-entry version tags, just the current title version.)
- Release runway: v2.0.0 (1.19.4 engine + 1.19 content) SHIPPED 2026-11-08;
  v2.3.0 (full offline download + mesh voice) SHIPPED 2026-11-14;
  v2.3.1 (download flow fixes + Lite file) SHIPPED 2026-11-14;
  v2.3.2 (native download screen + empty-file root fix) SHIPPED 2026-11-14.
  Next arc (3.0.0 candidates): next engine jump, save-format migration,
  authoritative multiplayer, ancient cities + archaeology + armor trims,
  sniffer egg/pitcher plant (1.20), map pixel persistence. Pick the
  breaking payload when the time comes.

Generator `mcjs`: mainline is now the **1.19.4 engine** (`src/mc1194/`,
v2.0.0 feature set, default via `src/boot.js`). The 1.18.2 line
(`src/mc1182/`) was DELETED 2026-11-06 at the 1.19.4 pivot (1.18.2 saves
do NOT transfer — state ids changed). The 1.15.2 line
(`src/mc1152/`, `src/tools/1152/`) was deleted 2026-10-31 after parity was
verified live on the 1.18 line (zero `mc1152` runtime remains). The
`?mc=1152` hatch in `src/boot.js` went with it.
The 1.13.2 stack (`src/mc1132/`, `?engine=1132`) was retired and deleted
in v1.0.1. The user's 1.13.2 prebuilt
(`scratch/message-attachments/mcjs1132.html`, private) and 1.15.2 modular
source (`MinecraftJS-1.15.2.zip`, private) are NOT shipped.

## What is done and verified live (2026-10-28)

- v1.9.0 SHIPPED 2026-10-30 (armor stands + detector toggle + leather
  barding); v1.10.0 SHIPPED 2026-10-30 (buzzy bees: model backfill +
  hive/nest sim, honeycomb/bottles/blocks, smoke calming, pollination,
  stings, campfires, dispenser harvest, lever/button place fix);
  v1.11.0 SHIPPED 2026-10-30 (redstone signal sim: 0-15 dust + torches
  with burnout, repeaters with lock/diode/delay, comparators with
  container readout, detector mirroring, lamp/TNT/note consumers);
  v1.12.0 SHIPPED 2026-10-30 (mob animation pass: limb swings through
  the engine interpolator, sitting wolves, grazing sheep, bow-aim,
  attack swings, hurt flash + fall-over death; no standalone file —
  code verified live, docs shipped with v1.13.0); v1.13.0 SHIPPED
  2026-10-30 (pistons + observers: 12-block push/pull, tile refusal,
  slime/honey stickiness, QC-lite, 1-tick edge delay, mid-slide repair,
  observer edge pulses + clocks). Test world wmvrvxifj32cp left clean
  (rig removed, player healed at spawn, difficulty restored), zero
  console errors.
  Verification record: `scratch/CURRENT_TASK.md` (private, may be gone).

- Milestone 1: title / multiplayer (live server pings) / direct-connect /
  options. Shots: `scratch/shots/1152-{title,multiplayer,options2,direct2}.png`
  (scratch is private and may be gone — re-capture as needed).
- `src/mc1152/data/compat.json`: old→new id map, 0 unmapped states.
- Singleplayer ported (`singleplayer.js` + voxelgen/vc-biomes copies): v3
  saves, v2→v3 migration, edit→save→reload round-trip.
- Survival ported (`survival.js`): mobs (27 spp), projectiles/TNT/XP/drops,
  sheep shear+dye+regrow, crops, boats/carts, horses/donkey+chest, night
  director, furnace/chest/bench windows, weather, save→reload round-trip.
- Port batch 2026-10-28: recipes, native-gui, touch, voice, Realms
  (+ oneblock ticker + UI), resource packs, single-file builder — all verified
  live in-preview (see scratch/CURRENT_TASK.md for the per-feature record).
- Title panorama is authentic 1.15 "Buzzy Bees" art (baked into
  `assets-1152.zip`; the loose `vanilla-panorama/` source folder was removed
  as redundant).
- NATIVE 1.15.2 asset pack 2026-10-28 (user freed storage): `assets-1152.zip`
  (~12 MB) + `assets-1152-sounds.zip` (~88 MB). client.jar blockstates/models/
  textures/font/particles/shaders/texts/en_us + 121 lang + sounds.json +
  pack format 5; 424 new sounds exact, 1406 unchanged keep 1.13 bytes.
  Verified live: TitleScreen, Options (accessibility label fixed), Superflat
  world render (grass/cow/HUD), bee/honey textures + bee sounds resolve.
  Gap: entity models for bee/fox/panda/cat still missing (spawn-time only).
- Two real bugs found by verification and fixed in code:
  1. `saveNow`/autosave clobbered the survival payload via stale
     `memFallback` cache → fixed with `dropCache` hook + `SV.on` guard.
  2. Horse targeting order, witch-model fallback (one-time console warn).

## Test recipe (worlds live in browser localStorage — recreate after wipe)

1. `await __mcSingleplayer.play("<id>")`, poll `game.inWorld`.
2. Survival hooks: `__mcSurvival.spawn/tame/use/huse/horse/tick(n)/setWeather…`
   (`tick(n)` runs n real masterTicks synchronously; use it, not wall-clock).
3. Pace `tame`/`huse` calls ≥260 ms apart (200 ms echo guard).
4. If `S.state.dead`: respawn via the native Respawn button, never manual hp.
5. Peaceful (`game.difficulty=0`) + day for build tests; restore Easy after.
6. Item ids: `game.items.byName` is a Map (`get('chest').id`); blocks:
   furnace/ chest/bench default states are 3372/2033/3354.
7. Canvas capture: double-rAF `toDataURL` + `resultPath`, then view the file.

## Fully ported 2026-10-28 (nothing left except parked items)

Recipes, native-gui, touch controls, voice, Realms (+ oneblock ticker + UI),
resource packs, single-file builder — all ported to `src/mc1152/` and verified
live in-preview. Do not build a mod
loader (user parked it until 1:1 vanilla parity).

## Known issues / notes

- Editor "couldn't add files: 0 MiB available" (2026-10-28): contradicted by
  measurement (`src/` = 191 MB of 2 GB, browser 4.8 MB of 2 GB). Single
  files >100 MB can never ship (`100 MB/file` cap) regardless. Unresolved;
  if small uploads still fail it looks like a platform accounting glitch.
- Harmless console noise: `Could not read config.json`, witch fallback warn.
- Hidden-tab throttling (~1 Hz timers) slows the live sim: prefer `tick(n)`.
- `page_refresh` applies file edits; `page_eval` alone never does.
- This file + `src/README.md` are the durable record. `scratch/` (incl.
  `CURRENT_TASK.md`, shots, zips) may not survive.
