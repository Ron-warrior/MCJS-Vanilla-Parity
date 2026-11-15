# MinecraftJS (perchance generator)

> Readme + full feature list: [`FEATURES.md`](FEATURES.md) — everything
> v2.0.0 can do. Release history: [`CHANGELOG.md`](CHANGELOG.md).

Mainline is now the **1.19.4 engine** (`src/mc1194/`, v2.0.0: 998 blocks,
1,228 items, 124 entity types, protocol 762 to 1.19.4 servers): title /
multiplayer / direct-connect / options, singleplayer,
survival, recipes, native-gui, touch, voice, Realms, oneblock
(ticker+gate), resource packs and the single-file builder are all
carried over from the 1.18.2 line (removed 2026-11-06 once the 1.19.4
pivot was verified; its rebuild tools under `scratch/1194-native/` are
private). 1.18.2 saves do NOT transfer (state ids changed).
Parked per user: mod loader
(until 1:1 vanilla parity).

## Engine layout (`src/mc1194/`)

- `boot1194.js` — reduced boot of the upstream `client/js/main.js`: sets the
  `BrowserPlatform`, loads the asset zips as a layered `ZipSource`, creates the
  device, inits recipes, opens the title screen (or `?connect=` join).
  Loaded by `src/boot.js` (the only engine).
- `js/` — vendored client modules speaking protocol 762 with layered
  1.14.4→1.19.4 readers (each version's packet/codec tables retained, since
  each newer reader builds on the older one). Only `client/js/**` +
  `client/data/*.json` + `config.example.json` were vendored; build
  tools/proxy/docs were not.
- `data/` — native 1.19.4 registries: 998 blocks, 1,228 items,
  124 entity types, 935+8 recipes; plus the older wire tables the
  layered protocol readers still use.
- `assets-1194.zip` (~28 MB) + `assets-1194-sounds.zip` (~63 MB) +
  `assets-1194-legacy-sounds.zip` (~93 MB) — NATIVE 1.19.4 pack, split only
  because sounds alone exceed the 100 MB/file cap (`boot1194.js` fetches all
  three; `ZipSource` falls back through the chain). Byte-exact vanilla:
  client.jar `assets/minecraft/*` (blockstates, models, textures, font,
  particles, shaders, texts, `en_us.json`) + lang files + `sounds.json` +
  `pack.mcmeta`. Title panorama is the authentic 1.19 "Trails & Tales" art.
  Rebuild recipe: `scratch/1194-native/assemble-*.js` (private, may not survive
  sessions).
- Multiplayer needs a proxy for vanilla servers (none bundled) or direct
  `wss://` Eaglercraft servers; live join from this environment untested.
- Singleplayer PORTED 2026-10-28 (`singleplayer.js`, no engine imports —
  talks to `globalThis.game` like the 1.13.2 file): world menu (list/search/
  play/create/rename/delete/re-create), seeded hills/tectonic/flat/void/Skyblock +
  Terralith voxel terrain, streaming, v3 saves with v2→v3 migration through
  compat.json, creative placement fixes, chat commands, void rescue.
  Verified live: menu, migrated-world entry, flat + hills render, edits save
  + survive reload, create/delete. No gaps vs 1.13.2 remain: Skyblock ticker, world-list thumbnails and bonus-chest spawn all ported 2026-10-28 (vanilla-style shot rows; stocked starter chest near spawn). Villages (Phase A vanilla parity):
   deterministic lattice villages on hills — plank houses, cobble well,
   farms, lamps, gravel paths — verified live 2026-10-28. Real hills biomes (Phase A): moisture/temperature/river
   noise gives plains/desert/jungle/swamp/ocean/river/beach/snow/rock with matching
   surfaces, trees, dressing and biome-gated mob spawns — verified live 2026-10-28.
- Survival PORTED 2026-10-28 (`survival.js`, adapted from the 1.13.2 file:
  all entity/block/item ids re-keyed to native 1.15.2, object-entity spawns
  via spawnObject/spawnXpOrb, witch falls back to a zombie model with a
  one-time console warn because the texture pack is 1.13-era). Verified
  live: mob rendering (27 species), projectiles/TNT/XP orbs/drops, sheep
  shear+dye+regrow, crop till/plant/bone-meal/harvest, boat/minecart place/
  ride, horse tame/ride/dismount, donkey chest (17-slot tile), night director
  spawns, furnace smelt + chest/bench native windows, weather, full
  save→reload round-trip (tiles + markers + horses). Save-path fix: survival
  persists straight to LS while singleplayer caches records in memFallback,
  so any saveNow/autosave used to clobber the payload with the entry-time
  snapshot — survival now drops the cache after each write, plus a never-
  persist-before-restore (`SV.on`) guard. Screenshot:
  `scratch/shots/1152-survival-verify.png`.
- Mobile PORTED 2026-10-28, NATIVIZED 2026-11-08 (`touch-controls.js`):
  no DOM overlay — Bedrock-style controls render in the game canvas
  (translucent thumb buttons, top-left II/INV/CHAT/DROP/KB bar, floating
  joystick with home base, contextual UP/DN while flying, LEAVE while
  riding, full-push sprint) and drive `game.input` directly, so mobile
  Safari (which drops `code` on synthetic KeyboardEvents) works by
  construction. Verified live: joystick KeyW, full-push sprint, look-drag
  yaw, Space hold, SNK/SPR toggles, hotbar tap select, II/INV/CHAT+SEND
  screens, UP/DN in flight, phone 390x844 layout.
- Crafting PORTED 2026-10-28 (`recipes.js`, re-keyed to 1.15.2 registries):
  2x2 + 3x3 matching, workbench window, recipe book, repair, ghost-craft.
- Native GUI PORTED 2026-10-28 (`native-gui.js`): confirm/prompt/keyboard/
  List widgets shared by the menus below.
- Realms PORTED 2026-10-28 (`realms.js`; world storage delegated to
  singleplayer's v3 store): online rooms + LocalSocket/WebRTC offline paths,
  shared oneblock island gate (`oneblock-ui.js`) included. Verified live:
  create/join/sync relay, avatars, configure screen.
- Voice PORTED 2026-10-28 (`voice.js`, adapted to the 1.15.2 custom-payload
  packet): proximity WebRTC voice on external servers, N menu. Verified
  live: codec handshake, chat notices, menu open/close.
- Resource packs REMOVED 2026-10-29: bundled zips (Faithful 64x,
  dark-gui) + installer (`resourcepacks.js`) deleted as redundant. The
  native `Options -> Resource Packs` screen still supports user-added packs.
- Single-file builder RETURNED 2026-11-14 (`src/mc1194/download.js` title
  button + `src/tools/offline/build.js` in-tab builder: esbuild bundle, embedded
  data/zips/worker, File System Access streaming or blob fallback) after the
  v2.2.0 removal — the download keeps 100% of site features.
  Voice-over-mesh added the same day (`voice.js`: Trystero signaling fallback
  with lower-sid-offers discipline when the server socket is unavailable), so
  the file build has voice for the first time; the `__mcOffline` gate in
  `externalServer()` is gone (file builds join external servers directly).

## Realms (`src/mc1194/realms.js` + server script in `index.html`)

Online co-op rooms on the generator's own server, modelled on
voxelcraft-servers (deterministic terrain + edit log + transform relay):

- Flow: title "Minecraft Realms" button -> HTML menu (name, room
  code, seed/type/mode for create, "list publicly" checkbox, Create/Join, invite,
  Browse public rooms) -> join RPC at title (server creates or validates) ->
  ensure a matching local world ("Realm \<code>", adopt-if-clean on seed
  mismatch) -> `playWorld` -> sync RPC replays the build log -> live
  edit/transform/chat relay (10 Hz moves, SP.gen-guarded setState for remote
  edits, chat wrap with server-stamped names). Transport: server socket when
  online; `LocalSocket` (BroadcastChannel + WebRTC) in the release file.
  Rooms carry a mode byte (creative/survival, chosen at creation; oneblock
  always survival). Joiners enter the local mirror in the room's mode, which
  arms the survival systems (damage, hunger, drops, mobs; per-client mobs and
  drops). The public browser shows each room's mode.
- In-world: `/realm players|invite|publish|unpublish|leave|join <code>`,
  invite links `https://perchance.org/<name>#realm=<code>` (hash auto-opens
  the menu). Remote avatars are entity ids `-(1000+sid)` with inline-name
  roster self-healing; join-notice placeholders (eid 0) are upgraded to real
  spawns on first move (`upsertAvatar` respawns when `!m.eid`).
- Server (QuickJS, public source): 32 rooms, durable seed+type+mode+pub per
  room (schema v2: dir entries + 24B code table + 32×16K edit-log arenas),
  RPC `join/sync/chat/leave/list/publish` + binary edit/move relay,
  token-bucket rate limits, idle-smallest eviction, full validation.
  Public rooms appear in everyone's Browse list (code/type/players/builds)
  and can be listed/unlisted at any time (menu Publish/Unlist button or
  `/realm publish|unpublish`); private code rooms are never listed.
- Verify in the server-plugin emulator (unsaved preview): rooms do NOT
  survive `page_refresh` — re-create after reload. Production `state` is
  durable.
- `page_refresh` stalls on the bundle's `beforeunload` dialog: always pass
  `preambleJs` that swallows `beforeunload` listener registration.

## Singleplayer (`src/mc1194/singleplayer.js`)

Hooks into the live client at runtime (no bundle edits):

- Title screen: the disabled "Singleplayer" button is enabled and opens a
  native engine-rendered world menu: world cards with JPEG thumbnail, CREATIVE/SURVIVAL badge,
  type, seed, blocks-built count, relative time, size; Play / Create /
  Delete / Back; Enter plays, double-click plays, first row auto-focused.
- Create form: name, seed (blank = random), type (Tectonic default, Terralith,
  Classic hills, Superflat, Void, Skyblock), gamemode (Creative / Survival).
- Worlds: deterministic seeded terrain (`genState` is a pure function of
  x/y/z/seed/type — only player edits are saved). Streaming follows the
  player (radius = renderDistance clamped, small per-tick budgets so the
  preview never looks frozen).
- Saves: localStorage world index + per-world records (seed/type/mode/spawn/
  player/time/inventory + `overrides` diff, incl. `heldSlot`). Autosaves
  every ~10 s when dirty, on pagehide/hidden-tab, on disconnect, and before
  joining multiplayer. Prunes edits that match the generator.
- Chat (offline): messages echo locally; commands `/help /time /gamemode /tp
  /spawn /give`. Void rescue teleports to spawn if y < −32.
- Test API: `globalThis.__mcSingleplayer` =
  `{state, play(id), save(), worlds(), chat(msg), genState(x,y,z)}`.

Inspiration notes: zardoy/minecraft-web-client runs a real local server
(flying-squid) — too heavy here, so this uses client-side prediction instead.
Borrowed from voxel-craft (perchance `voxel-craft` generator): diff-only
saves, world cards with preview thumbnails + mode badges + built-count,
deterministic-gen discipline.

## Terralith world type ("Terralith (voxel-craft biomes)")

Climate-noise terrain ported from voxel-craft's `src/js/worldgen.js`:
Perlin climate fields (continent/erosion/temperature/humidity/weirdness/
river/variant) → height field with ridged mountains → per-column biome pick
from the Terralith 26.2 table → surface rules, 3D-noise caves, ore bands,
tree/vegetation decoration (oak/birch/conifer/jungle/acacia/swamp/cactus/
mushroom/cherry/pale→oak), shores, frozen water/snow, seagrass/kelp/lily
pads, shoreline sugar cane. 1.14+ blocks fall back to 1.13.2 equivalents
(`VOXEL_FALLBACKS` in `singleplayer.js`: deepslate→stone, copper→stone,
mud→dirt, basalt→stone, cherry/pale→oak, …).

- Deterministic per (x,y,z,seed): `genState` branches to
  `VoxelGen.voxelStateAt` for prune + the test API; chunk fill uses
  `VoxelGen.generate` (same helpers, strict per-chunk clipping — tree roots
  sit on a global 4-block grid evaluated redundantly by neighbours, so chunks
  are order-independent). Streaming budget is 1 chunk/tick for voxel.
- Gotcha that bit once: the port's `clamp` had an inverted low-side ternary
  (`x < a ? x : …`), which made every ocean column explode — heights must
  stay within 4–122 (WORLD_H 128).

## Tectonic world type ("Tectonic")

Genuine density-function terrain: Tectonic v2.2.2's 53-function
router (`scratch/tectonic-full.json` bundle → `js/world/tectonic-data.js`)
evaluated per column by `js/world/tectonic-density.js` over
`js/world/tectonic-noise.js` (Xoroshiro/Improved/Perlin/Normal/Blended —
jar-verified shapes), facade `js/world/tectonic.js` (router state,
exact surface scan, 5x5-per-chunk height lattice, climate sampling).
`singleplayer.js` routes `type === "tectonic"` through the shared hills
fill path: heights from the lattice, climate→biome mapping onto the 0..9
ids (ocean/beach/snow/desert/jungle/swamp/rock/plains/meadow), so trees, cacti,
snow/ice, ores, water and tints all work unchanged. Sea stays the engine
SEA=62 (vanilla/Tectonic use 63 — one-block shoreline difference, noted in
code). Villages/strongholds stay hills-only (their guards return null);
caves carve Tectonic only (router's own density fields; flooded near sea
level, dry and walkable deeper), with lush/dripstone cave biomes,
amethyst geodes, and deep sculk patches.
Spawn: two-phase (cheap climate pre-filter for continents > −0.11, then
lattice heights on clustered candidates).

- Correctness: oracle `scratch/tectonic-oracle.js` (re-runnable via
  execute_js) — fromHashOf parity, full-mask Perlin batteries, all 45
  Tectonic NormalNoises, BlendedNoise vs 0.12.1-patched-to-jar-masks: ALL
  EXACT; interpreter ops reviewed line-by-line vs 0.12.1's
  DensityFunction/CubicSpline sources.
- Gotchas that bit during the build: (1) deepslate@0.12.1's BlendedNoise
  uses REDUCED octave masks which do NOT match the 1.18.2 jar (dhz calls
  rangeClosed(−15,0)×2 + rangeClosed(−7,0) via the positional path) —
  full masks now. (2) 0.12.1's ShiftNoise sample lacks vanilla's `*4`
  (ours has it). (3) Scattered colInfo/biomeAt on tectonic faults a ~66ms
  router lattice per new chunk — never sample wide grids on the live page
  (two page freezes); do censuses in execute_js, keep live queries local.

## Skyblock world type ("Skyblock (one-block island)")

7x7 grass island + dirt/stone core + stone pedestal with a regenerating
block at (0,61,0) (phase cycle in `oneblock-ticker.js`), spawn (3.5,63,3.5).
Singleplayer create form + Realms create menu both list it; realm mirrors
run survival (mode 0).
- Gotcha that bit during the port: `resolveIds` tried the raw 1.8 key
  before the 1.13.2 alias AND wrote alias spellings back unconditionally,
  so `I.grass` resolved to the "grass" plant (1041, non-solid) via the
  `tallgrass`→`grass` alias clobber — every classic/flat surface was
  plants, and the island was unwalkable. Aliases now resolve first and
  alias spellings never clobber a real key.
- Rebuild recipe for `vc-biomes.json`: unzip the Terralith datapack, resolve
  `data/*/tags/worldgen/biome/*.json` (following `#tag` refs), map new tags
  to the old classifier vocabulary (`c:is_beach→is_beach`,
  `c:is_mountain/peak→reference/mountain_peak`, `terralith:reference/*`
  kept, …), synthesize vanilla ocean/river/beach entries (the pack only
  ships `deep_warm_ocean` + `warm_river` + `gravel_beach`) and tag-less
  vanilla biomes by id; drop cave biomes. Source zip lives in
  `scratch/message-attachments/` (private, may not survive sessions).

## Texture notes (Faithful 64x + Dark Mode, 2026-10-25 — bundled zips REMOVED 2026-10-29 as redundant; notes kept for rebuild reference)

- Source packs (user-supplied, in `scratch/message-attachments/`, private):
  Faithful 64x Release 14 (pack_format 79–100, ~1.21), Default-Dark-Mode-1.8,
  Terralith 2.6.4, FreshAnimations 1.10.5. Only the first two were usable:
  - **Terralith** is a modern datapack (density-function worldgen JSON) —
    its successor Terralith 26.2 powers the 1.13.2 Terralith world type
    (see above).
  - **FreshAnimations** is OptiFine CEM `.jem` models + 64x64 skins — this
    client's entity renderer is 1.8-format (64x32 skins). Not usable.
- Mapping: `scratch/map-blocks.json` (366), `map-items.json` (214),
  `map-gui.json` (28 dark-mode files), `map-env.json` (13:
  sun/moon_phases/rain/snow 4x upscales, forcefield/underwater/pumpkinblur,
  6 panorama faces at 1024px). Beds kept vanilla (modern beds are entities,
  no block textures); banners/spawn eggs/quiver/ruby skipped (no
  equivalent); compass+clock were *composited* from modern per-frame files
  into filmstrips (clock 64x4096, compass 64x2048); animated water/lava/
  fire/portal/sea-lantern/prismarine frame counts verified equal.
- Atlas builder (in `game.js`) packs tiles at native
  size, so 64x tiles work — verified 60 fps in preview.
- Pack zips (`src/packs/`) were built from those staged PNGs with standard
  `assets/minecraft/...` paths + `pack.mcmeta` + pack.png
  icons — the client's native pack screen (`Options -> Resource Packs`)
  picked them up from its IndexedDB store, overrode base files, and
  live-reloaded on Done. Two zip lessons from the first attempt (which
  appended entries into the bin directly): the game's zip reader does
  `Map.set` in CD order so appended duplicates shadow originals — but you
  must **never copy the original trailing 22-byte EOCD into the middle**,
  the parser stops at the first EOCD-shaped record and never reaches
  appended entries.

## Gotchas (verified the hard way)

- `game.playerUuid` must be hex (skin renderer does `BigInt('0x'+uuid)`).
- Never `return canvas.toDataURL()` from a plain `page_eval` — the WebGL canvas
  (no `preserveDrawingBuffer`) often reads back blank; capture inside a double
  `requestAnimationFrame` and return the URL, or use the `snapshot.js` helper.
- `world.setState` on a non-existent chunk silently drops the write; the SP
  edit-recorder still records it, so it self-repairs when the chunk generates.
- Blocking the main thread with big sync chunk fills starves timers — keep
  streaming budgets small (see numbers above) or the preview looks frozen.
- Pointer lock needs a user gesture: `playWorld` locks synchronously before the
  (blocking) spawn-area generation to avoid landing in the pause menu.
