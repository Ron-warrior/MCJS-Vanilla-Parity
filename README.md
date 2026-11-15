# MCJS-Vanilla-Parity

Fork of [Reb0rnEnder/MinecraftJS](https://github.com/Reb0rnEnder/MinecraftJS)
working toward full parity with vanilla Minecraft.

**This branch tracks the 1.19.4 engine line — MinecraftJS v2.3.2.**
The `1.15.2` branch keeps the older 1.15.2 documentation, and `1.18.2`
keeps the v1.14.0 1.18.2 docs this branch previously carried.

## What it is

The full 1.19.4 game in the browser: singleplayer survival on a −64..319
deep world, villages under illager threat (patrols, raids, the wandering
trader), Nether and End, the dragon fight, ocean monuments, villager
trading, crafting, tab co-op Realms, touch controls, Skyblock, and
resource packs. No install, no account — open the page and play.

## Get it

Play it on the generator page — no download, no install, no account. Hit
**Singleplayer** on the title screen. Saves live in the browser's
localStorage; installed resource packs use IndexedDB.

Or hit **Download…** (bottom-left of the title screen) to save the
complete game as one file:

- **Full** (~190 MB) — everything, including all sound effects.
- **Lite** (~45 MB) — same game but silent, recommended on phones.

Either builds in a few minutes and is playable offline from a
double-click. The file keeps 100% of the features (Lite is the same game
without bundled sounds): singleplayer, survival, crafting, touch,
Skyblock, resource packs, external-server joins and voice all work from
the file whenever the device is online. Realms rooms and voice run over
the same-computer tab mesh fully offline, and over the cross-device mesh
when online.

- **No internet needed**: everything except the 28 long music/ambience
  tracks, which stream on demand (all sound effects are bundled).
- **Needs internet**: loading the page, joining external multiplayer
  servers, server-list pings, cross-device Realms/voice mesh.
- **Not in the file**: the site's durable server rooms (file rooms live
  while a host tab is open) and the global public room browser.

## Starting it

Open the page → title screen (Mojang splash → 1.19 "Wild Update"
panorama): **Singleplayer**, **Multiplayer**, **Minecraft Realms**,
Options (incl. accessibility, language, resource packs, shaders),
Quit-to-title. Native engine-rendered dialogs throughout:
confirm/prompt/keyboard widgets, native death screen ("You died!" +
Respawn, Enter respawns), loading veils, status toasts. URL extras:
`?connect=<server>`, `?touch=1/0`, `#realm=<code>` invite links.

## The client (1.19.4 engine)

Full 1.19.4 client: chunk rendering (WebGL2/WebGPU/CPU fallback), entity
models, particles, sky/weather visuals, day/night, HUD (hearts, hunger,
armor, XP bar, hotbar, crosshair, boss bars), inventory + container
screens, chat, pause/death/options/pack/shader/stats/advancements/book/
sign/command-block/structure screens, narrator, spectator, demo mode,
credits.

Ships native 1.19.4 registries and assets: **998 blocks / 1,228 items /
935+8 recipes / 124 entity types**, real 1.19 textures, models, sounds
and languages. The Overworld spans Y −64 (bedrock) to the 319 build
limit; the Nether keeps its 0..127 floor/ceiling and the End 0..255.
Multiplayer joins 1.19.4 servers over **protocol 762**. Audio covers the
full 1.19.4 sound set (1,462 events); effects decode in-file while long
tracks stream on demand, and all disc events (including 5, otherside and
pigstep) resolve to audio.

Visuals go further than vanilla through the in-file **ImmersiveVFX**
port (Video Settings → ImmersiveVFX…: 7 presets + Custom, fog/sky/cloud/
light grading, aurora, meteors, light shafts, mist, bloom halos, GPU
grass, ambient particles) with a master ON/OFF toggle that returns
rendering to plain vanilla. Alongside it runs the native **Built-in
shader**: a fullscreen post chain inside the engine, so it works on every
backend (WebGL 2, WebGPU, CPU) — bright-pass bloom, adaptive
auto-exposure, ACES tonemap, dimension-aware grading, FXAA 3.11, lens
distortion, light shafts, sun flares, vignette and film grain, plus waving
leaves/plants/water on WebGL 2. Not included (needs G-buffer passes this
forward renderer does not have): sun shadows, SSAO, screen-space
reflections, PBR reflections.

## Singleplayer

Engine-rendered world menu: list with **thumbnail screenshots**, search,
Play/Create/Delete/Rename; Enter or double-click plays. Create form: name,
seed, 6 world types — **Tectonic** (default), Terralith, Classic hills,
Superflat, Void, Skyblock — gamemode, difficulty, structures toggle,
cheats toggle, **bonus-chest** toggle. Seeded deterministic terrain (only
your edits are saved); autosaves while playing. Chat commands: `/time
/gamemode /tp /spawn /give /difficulty (peaceful|easy|hard) /weather`.
Void rescue, creative placement fixes, starter chest on bonus worlds.

## World generation

- **Tectonic** (default): genuine density-function terrain — Tectonic
  v2.2.2's router over jar-verified noise, giving wide oceans, eroded
  peaks past Y 200, and climate-mapped biomes with trees, ores and
  dressing. Caves carve Tectonic only; villages and strongholds stay on
  Classic hills.
- **Villages** (Classic hills): deterministic lattice — plank houses with
  log corners, glass, doors and torches, a cobble well, wheat farms, fence
  lamps, gravel paths.
- **9 biomes** (Classic hills; Tectonic adds a treeless meadow above the
  tree line): plains, desert, jungle, swamp, ocean, river, beach, snow,
  rock — matching surfaces, trees, dressing and biome-gated spawns
  (jungle parrots, swamp slimes, snow polar bears, desert husks, meadow
  goats).
- **Nether**: bedrock floor and ceiling, **5 biomes** (wastes, soul-sand
  valley with basalt pillars, crimson and warped forests with fungi,
  basalt deltas), lava seas, quartz, glowstone, brick **fortresses** on a
  512 lattice with wart gardens and loot. Blaze volleys, wither skeletons,
  magma cubes, warped-forest endermen. 4×5 obsidian **portals** light with
  fire and link **8:1** both ways with return portals; beds explode, water
  evaporates.
- **End**: central island, 10 obsidian pillars with healing **end
  crystals**, outer chorus islands, kill-gated exit fountain, the
  **Ender Dragon** (circle/dive/perch, breath clouds, 12,000 XP first
  kill, one of 20 rim **gateways** per kill) with the 4-crystal respawn
  rite, lattice **End cities** with shulkers and 45% elytra ships, a
  buried **stronghold** with throwable **eyes of ender**.
- **1.19 ores**: depth-banded triangle distributions (diamond peaking at
  the floor), stone→deepslate blend across Y 0..−8 with rare tuff,
  deepslate variants, smelting and XP parity.
- **Caves** (Tectonic): spaghetti/noodle carving from the router's density
  fields, **lush** and **dripstone** cave biomes, and amethyst **geodes**.
- **Ocean**: prismarine **monuments** with seeded elder guardians, guardian
  and drowned spawns, **tridents** (melee and throwable, with loyalty,
  impaling and channeling that calls a real bolt in a thunderstorm),
  sponge, **conduit** power, and ocean explorer maps.
- **1.19 land**: swamp hollows run to **mud**; high meadows bloom into
  **cherry groves** with pink petals.
- **Sculk deeps** (Tectonic, below Y −16): sculk floors with **sensors**,
  **shriekers** and **catalysts**; shriekers warn, darken your vision from
  the second warning, and call a **warden** at the fourth.
- **Woodland mansion** (Tectonic): cobble hall with glass rhythm, dark-oak
  trim, floor torches and a diamond sanctum, deterministic residents,
  and L4 cartographer explorer maps.

## Survival simulation (10 Hz)

Health/hunger/exhaustion, difficulty scaling, fall/drown/lava/fire/void
damage, armor and toughness, weapon skills (cooldown, crit, sweep,
shields, totem), milk, and a full status-effect engine. **54 mob
species** with wiki-checked AI, taming, breeding and babies, pets that
follow and fight for you, golem building, magnet drops, XP orbs driving
the native bar, and a 40/10 spawn director with day/night and light
rules.

**1.19 mobs**: frogs (3 temperature variants, eat small slimes into
froglights, frogspawn → tadpoles), the allay (fetches matching drops,
dances at jukeboxes, amethyst-duplicates), rideable camels (saddle,
Space-dash), the sniffer (digs torchflower seeds), and the warden.

Blocks and workstations: TNT, buckets, furnaces with banked XP, chests,
workbench, throwables, bows, fishing, boats and **chest boats**, minecarts
and rails, horses, full farming (including torchflowers), weather and
lightning, potions, 37 spawn eggs, bed sleep/skip. Enchanting table,
anvil (repair/combine/rename with JE prior-work penalties and the
40-level cap), full JE brewing table, blast furnace and smoker at 2× with
2× fuel, barrel, grindstone, stonecutter, composter, bell, hopper,
dispenser and dropper, and elytra with firework boosts.

Redstone is a full 0-15 signal simulation: dust with side/up connection
rendering and popping, torches that invert and burn out after 8 fast
toggles, repeaters that delay and lock, comparators that read containers
in compare/subtract mode, daylight detectors mirroring their level and
following real sky exposure, plus pistons (12-block push, sticky pull,
slime and honey carry) and observers with edge pulses and
quasi-connectivity. Mobs animate through the engine interpolator rather
than sliding, and have hurt flash and a fall-over death animation.

Still out: doors, trapdoors and fence gates have no sim yet.

## Illagers, raids and the wandering trader

Pillagers, vindicators, evokers (+ vexes) and ravagers hunt players,
villagers, traders and golems. Patrols roam behind a banner-wearing
captain — kill the captain for Bad Omen, then enter a village to trigger a
multi-wave raid (victory earns Hero of the Village). The wandering trader
arrives with llamas and a trade list; leads clip onto leashable mobs and
tie to fence posts as knots that persist across reloads. Naming a
vindicator "Johnny" with a name tag does what you'd expect. Woodland
mansions generate on Tectonic terrain with deterministic residents, a
lootable sanctum and explorer maps.

## Villager trading (JE 1.15.2 rules)

13 employed professions plus nitwit/unemployed; up to 5 residents and 1
golem per village. Full JE 1.15.2 trade tables: novice pools, 2 unlocks
per level (thresholds 10/70/150/250), demand and reputation pricing,
max-uses lockout, **2×/day restock**, reputation on trade, golem
retaliation, per-village persistence. Special rolls include librarian
books, enchanted gear, tipped arrows, suspicious stew and dyed leather
armor; expert cartographers sell a Woodland Explorer Map.

## Crafting

Recipe book fed from the in-file registry (browsable, craftable
highlighting, ghost-click **click-to-craft**, shift-click crafts all);
bucket container returns; workbench close spills the grid and cursor back;
vanilla tool repair. 1.19 recipes included: **recovery compass**, **music
disc 5** from fragments, and **chest boats**. **Goat horns** sound from
the hand.

## Realms co-op

Online rooms on the page's own server: create or join by room code (or
pick from the public browser), with avatars, block-edit relay and log
replay, chat, `/realm` commands, `#realm=<code>` invite links and a
shared-Skyblock gate. Creative or survival per room; rooms persist
server-side. The downloaded file plays the same rooms over its tab mesh
instead (same-computer tabs always; cross-device when online with the
mesh box ticked) — those rooms live while a host tab is open.

## Voice

Proximity voice chat on external multiplayer servers: press JOIN in the
voice panel (or N for the native menu), hold V to talk. Heard within 40
blocks, louder when closer. Works from the downloaded file too. Also
bridges Eagler voice channels and ships a `?voicebridge=` companion tab
for talking with Eagler players.

## Everything else

- **Touch controls**: joystick, drag-look, buttons and hotbar tap-select,
  with `?touch=` force flags. Rendered inside the game canvas, not as DOM
  widgets, so mobile Safari works.
- **Skyblock**: shared island with a phased regenerating block, hand-mine
  drops, a starter kit and `/ob` commands.
- **Resource packs**: Faithful 64× and Dark-GUI embedded; enable in
  Options, live reload, vanilla default.
- **Multiplayer tab**: join external servers and ping the server list,
  on the page and from the downloaded file whenever the device is online.

## Parked

Mod loader — on hold until parity is 1:1.

## Source layout

The modular source is distributed as `mcjs-generator.zip` (~195 MB, 500
files, ~83.5k lines of JavaScript):

| Path | What it is |
|---|---|
| `main.pjs` | Perchance generator metadata (`$meta`, `createServerSocket`) |
| `index.html` | Page shell plus the Realms server plugin (`x-server-plugin`, QuickJS) |
| `src/boot.js` | Single-engine boot; `?voicebridge=` boots voice only |
| `src/mc1194/` | The 1.19.4 engine: protocol 762 client modules, native registries, `data/` |
| `src/mc1194/survival.js` | Server-half simulation — damage, hunger, mobs, tiles, redstone (~18k lines) |
| `src/mc1194/singleplayer.js` | World menu, saves, deterministic worldgen hooks |
| `src/mc1194/realms.js`, `voice.js`, `touch-controls.js`, `native-gui.js` | Feature ports |
| `src/eagler-bridge/` | Java plugin bridging Eagler voice channels |
| `src/tools/offline/build.js` | Single-file download builder (esbuild bundle, embedded assets) |
| `src/mc1194/assets-1194*.zip` | Native 1.19.4 assets: 27 MB + 63 MB + 88 MB, split to stay under the 100 MB/file cap |

It runs as a Perchance generator, so there is no `package.json` and no
build step — the generator page is the harness. The three asset zips are
Mojang's 1.19.4 client assets; check the Minecraft EULA before
redistributing them.

## Version history

v2.0.0 moved mainline to the 1.19.4 engine (1.18.2 saves do not transfer —
state ids changed). v2.3.0 brought back the full offline download, v2.3.1
added the Lite file and download fixes, v2.3.2 replaced the download panel
with a native screen and fixed empty-file builds.
