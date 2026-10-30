# MCJS-Vanilla-Parity
Fork of https://github.com/Reb0rnEnder/MinecraftJS that attempts to eventually have full parity with vanilla mc.

# MinecraftJS v1.5.0 (Minecraft 1.15.2)

The full 1.15.2 game in a single HTML file: singleplayer survival,
villages, Nether and End, villager trading, crafting, tab co-op Realms,
touch controls, Skyblock, and resource packs. No install, no account —
open the file and play.

## Get it

**`minecraftjs.1.15.2._v1.5.0.html`** (~150 MB). Open it in Chrome or
Firefox (works from `file://`; Safari may not persist saves) and hit
**Singleplayer**. Saves live in the browser's localStorage; installed
resource packs use IndexedDB. No service worker needed.

- **No internet needed**: the whole game below up to Realms.
- **Needs internet**: joining external multiplayer servers, server-list
  pings, cross-device Realms mesh.
- **Not in this build**: voice chat (see Voice).

## Starting it

Open the file → title screen (Mojang splash → authentic 1.15 "Buzzy Bees"
panorama): **Singleplayer**, **Multiplayer**, **Minecraft Realms**,
Options (incl. accessibility, language, resource
packs, shaders), Quit-to-title. Native engine-rendered dialogs throughout:
confirm/prompt/keyboard widgets, native death screen ("You died!" +
Respawn, Enter respawns), loading veils, status toasts. URL extras that
work in the file: `?connect=<server>`, `?touch=1/0`, `#realm=<code>`
invite links (open the Realms menu).

## The client (1.15.2 engine, in the file)

Full 1.15.2 client: chunk rendering (WebGL2/WebGPU/CPU fallback), entity
models, particles, sky/weather visuals, day/night, HUD (hearts, hunger,
armor, XP bar, hotbar, crosshair, boss bars), inventory + container
screens, chat, pause/death/options/pack/shader/stats/advancements/book/
sign/command-block/structure screens, narrator, spectator, demo mode,
credits. Ships native 1.15.2 registries + assets inside the file (680
blocks / 11,337 states / 884 items / 768 recipes / 103 entity types, real
1.15 textures, models, sounds, languages).

## Singleplayer

Engine-rendered world menu: list with **thumbnail screenshots**, search,
Play/Create/Delete/Rename; Enter or double-click plays. Create form: name,
seed, 5 world types — **Terralith** (default), Classic hills, Superflat,
Void, Skyblock — gamemode, difficulty, structures toggle, cheats toggle,
**bonus-chest** toggle. Seeded deterministic terrain (only your edits are
saved); autosaves while playing; old 1.13.2 saves migrate on load. Chat
commands: `/time /gamemode /tp /spawn /give /difficulty
(peaceful|easy|hard) /weather`. Void rescue, creative placement fixes,
starter chest on bonus worlds.

## World generation (all in-file)

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

## Survival simulation (10 Hz)

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
bed sleep/skip. Enchanting table: bookshelf-scaled costs,
lapis + XP levels, weighted random enchantments (JE rules, no
treasure/curses), books become enchanted books. Anvil: repair with the
item's material, combine two items (durability + merged enchantments, JE
costs with prior-work penalties and the 40-level "Too expensive!" cap),
and renaming; anvils wear out and break with use. Brewing stand: fill
glass bottles from water, then brew the full JE table (extended and
level-II variants, corruptions, splash and lingering) with blaze-powder
fuel; batches keep going with the UI closed and persist across reloads.
Nether wart rides the stronghold chest until fortresses grow it
(dragon's breath has no source until the dragon). Blast furnace + smoker:
2×-speed smelting (ores/tools/armor vs. food only) with 2× fuel burn, lit
states, banked XP. Barrel: 27-slot silent storage. Grindstone: two-item
durability merge (+5%) or strip-to-curses with XP from removed
enchantments (books come back plain). Stonecutter: 1-block-in,
variant-out cutting list (slabs ×2). Composter: feed plants to fill
layers, harvest bone meal when full. Bell: rings and startles villagers.

## Villager trading (JE 1.15.2 rules)

13 employed professions + nitwit/unemployed (headshake, no window); up to 5
residents + 1 golem per village with home tethers. Full JE 1.15.2 trade
tables: novice pools, 2 unlocks per level (thresholds 10/70/150/250),
demand + reputation pricing, max-uses lockout, **2×/day restock**, +rep per
trade, hit → −rep + window close + golem retaliation, 8-block range close,
input salvage, per-village persistence. Special rolls: librarian books,
enchanted gear (no treasure/curses), tipped arrows, suspicious stew, dyed
leather armor, color families; explorer maps withheld.

## Crafting

Recipe book fed from the in-file registry (browsable, craftable-
highlighting, ghost-click **click-to-craft**, shift-click crafts all);
bucket container returns; workbench close spills grid + cursor back;
vanilla tool repair.

## Realms co-op (same-machine tabs; cross-device needs internet)

Rooms run **between tabs on the same computer** (BroadcastChannel + localStorage, no setup) with the same
protocol: room codes, creative/survival, avatars, block-edit relay + log
replay, chat, `/realm` commands, invite links, shared-Skyblock gate. With
internet, an optional mesh mode (Trystero over public Nostr relays, tick
the box in the Realms menu) finds other devices running the same file.
Rooms last only while the tabs are open.

## Voice (not present)

No voice chat in this build: no voice menu, no voice rooms.

## Everything else (all in-file)

- **Touch controls**: joystick + drag-look + buttons, hotbar tap-select,
  `?touch=` force flags.
- **Skyblock**: shared one-tab-or-mesh island (phased regenerating block,
  hand-mine drops, starter kit, `/ob` commands) + welcome screen with
  name/skin picker.
- **Resource packs**: Faithful 64× + Dark-GUI embedded; enable in Options,
  live reload, vanilla default.
- **Multiplayer tab**: join external servers + server pings work from the
  file whenever the device itself is online (fully self-contained file).

## Parked (not in any build yet)

Mod loader.
