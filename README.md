# MCJS-Vanilla-Parity
Fork of https://github.com/Reb0rnEnder/MinecraftJS that attempts to eventually have full parity with vanilla mc.
# MinecraftJS v1.0.0 — complete feature list

This describes **`minecraftjs.1.15.2._v1.0.0.html** — the single-file build which is the released/shared
artifact (~150 MB, needs no install and no account). Everything
below ships inside that one file unless marked otherwise.
Version tags: each section header names the release that added it
(`added vX`); individual entries gain `modified vX` / `fixed vX` tags when
a later release changes or fixes them. See `CHANGELOG.md` for the
release-by-release history.

- **Fully offline** (no internet at all): the whole game below up to Realms.
- **Needs internet**: joining external multiplayer servers, server-list
  pings, cross-device Realms mesh.
- **Not in the file**: voice chat (disabled in code — see Voice),
  dead query params (`?engine=1132`, `?voicebridge=` — boot nothing, those
  stacks aren't in the file), dev sources (`src/tools/`,
  `src/eagler-bridge/`, `src/mc1132/`).

Saves live in the browser's localStorage (works on `file://` in
Chrome/Firefox; Safari may not persist them). IndexedDB holds installed
resource packs. No service worker needed.

## Starting it *(added v1.0.0)*

Open the file → title screen (Mojang splash → authentic 1.15 "Buzzy Bees"
panorama): **Singleplayer**, **Multiplayer**, **Minecraft Realms**,
**Offline copy** info, Options (incl. accessibility, language, resource
packs, shaders), Quit-to-title. Native engine-rendered dialogs throughout:
confirm/prompt/keyboard widgets, native death screen ("You died!" +
Respawn, Enter respawns), loading veils, status toasts. URL extras that
work in the file: `?connect=<server>`, `?touch=1/0`, `#realm=<code>`
invite links (open the Realms menu). (`?engine=1132` and `?voicebridge=`
do nothing offline — those stacks aren't in the file.)

## The client (vendored 1.15.2 engine, in the file) *(added v1.0.0)*

Full 1.15.2 client: chunk rendering (WebGL2/WebGPU/CPU fallback), entity
models, particles, sky/weather visuals, day/night, HUD (hearts, hunger,
armor, XP bar, hotbar, crosshair, boss bars), inventory + container
screens, chat, pause/death/options/pack/shader/stats/advancements/book/
sign/command-block/structure screens, narrator, spectator, demo mode,
credits. Ships native 1.15.2 registries + assets inside the file (680
blocks / 11,337 states / 884 items / 768 recipes / 103 entity types, real
1.15 textures, models, sounds, languages).

## Singleplayer (fully offline) *(added v1.0.0)*

Engine-rendered world menu: list with **thumbnail screenshots**, search,
Play/Create/Delete/Rename; Enter or double-click plays. Create form: name,
seed, 5 world types — **Terralith** (default), Classic hills, Superflat,
Void, Skyblock — gamemode, difficulty, structures toggle, cheats toggle,
**bonus-chest** toggle. Seeded deterministic terrain (only your edits are
saved); autosaves while playing; old 1.13.2 saves migrate on load. Offline
chat commands: `/time /gamemode /tp /spawn /give /difficulty
(peaceful|easy|hard) /weather`. Void rescue, creative placement fixes,
starter chest on bonus worlds.

## World generation (all in-file, all offline) *(added v1.0.0)*

- **Villages** (Classic hills): deterministic lattice — plank houses (log
  corners, glass, doors, torches), cobble well, wheat farms, fence lamps,
  gravel paths.
- **9 biomes**: plains, desert (cactus/dead bush), jungle, swamp, ocean,
  river, beach, snow, rock — matching surfaces, trees, dressing, and
  biome-gated mob spawns (jungle parrots, swamp slimes, snow polar bears,
  desert husks).
- **Nether**: bedrock floor + ceiling, netherrack, lava seas, soul sand,
  gravel, quartz ore, glowstone; 4×5 obsidian **portals** light with fire,
  **8:1 travel** both ways with return portals; beds explode, water
  evaporates; per-dimension saves.
- **End**: central island, 10 obsidian pillars, outer chorus islands,
  pre-built exit fountain; buried **stronghold** (~1 km out, 12-frame ring
  with prefilled eyes + loot chest); throwable **eyes of ender** that fly
  toward it; eye-into-frame lighting; two-way portal travel; endermen-only
  spawns; per-dimension saves.

## Survival simulation (10 Hz, fully offline) *(added v1.0.0)*

Health/hunger/exhaustion, difficulty scaling, fall/drown/lava/fire/void
damage, armor + toughness, weapon skills (cooldown/crit/sweep/shields/
totem), milk, full status-effect engine (poison/regeneration/fire
resistance/night vision/chorus teleport/suspicious-stew flower effects…).
**27 mob species** with wiki-checked AI (creeper fuses, skeleton archers,
enderman stare, slime splitting, witch potions, phantoms…), taming
(wolves, cats, parrots, horses…), breeding + babies, pets that follow and
fight for you, golem building, magnet drops, XP orbs driving the native XP
bar, 40/10 spawn director with day/night + light rules. Blocks: TNT,
buckets, furnaces (smelting + banked XP), chests, workbench, throwables,
bows, fishing, boats, minecarts + rails, horses, full farming, weather +
lightning, splash/lingering/drinkable potions, 26 spawn eggs, cake slices,
bed sleep/skip.

## Villager trading (JE 1.15.2 rules, fully offline) *(added v1.0.0)*

13 employed professions + nitwit/unemployed (headshake, no window); up to 5
residents + 1 golem per village with home tethers. Full JE 1.15.2 trade
tables: novice pools, 2 unlocks per level (thresholds 10/70/150/250),
demand + reputation pricing, max-uses lockout, **2×/day restock**, +rep per
trade, hit → −rep + window close + golem retaliation, 8-block range close,
input salvage, per-village persistence. Special rolls: librarian books,
enchanted gear (no treasure/curses), tipped arrows, suspicious stew, dyed
leather armor, color families; explorer maps withheld.

## Crafting (fully offline) *(added v1.0.0)*

Recipe book fed from the in-file registry (browsable, craftable-
highlighting, ghost-click **click-to-craft**, shift-click crafts all);
bucket container returns; workbench close spills grid + cursor back;
vanilla tool repair.

## Realms co-op (same-machine tabs; cross-device needs internet) *(added v1.0.0)*

Rooms run **between tabs on the same computer** (BroadcastChannel + localStorage, no setup) with the same
protocol: room codes, creative/survival, avatars, block-edit relay + log
replay, chat, `/realm` commands, invite links, shared-Skyblock gate. With
internet, an optional mesh mode (Trystero over public Nostr relays, tick
the box in the Realms menu) finds other devices running the same file.
Rooms last only while the tabs are open.

## Voice (not present) *(added v1.0.0)*

No voice chat in this build: the voice hooks are hard-disabled in code
(`externalServer()` returns null): no voice menu, no voice rooms, no
Eagler interop, and `?voicebridge=` boots nothing useful.

## Everything else (all in-file, offline) *(added v1.0.0)*

- **Touch controls**: joystick + drag-look + buttons, hotbar tap-select,
  `?touch=` force flags.
- **Skyblock**: shared one-tab-or-mesh island (phased regenerating block,
  hand-mine drops, starter kit, `/ob` commands) + welcome screen with
  name/skin picker.
- **Resource packs**: Faithful 64× + Dark-GUI embedded; enable in Options,
  live reload, vanilla default.
- **Multiplayer tab**: join external servers + server pings work from the
  file whenever the device itself is online (fully self-contained file).

## Parked (not in any build yet) *(added v1.0.0)*

Mod loader.
