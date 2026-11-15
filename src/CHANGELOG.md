# MinecraftJS changelog

Each version section below is written to be used directly as that
release's description. Versioning: `vMAJOR.MINOR.PATCH` — MAJOR for
breaking changes (save wipes, engine swaps), MINOR for new features,
PATCH for fixes and small tweaks. Version history lives here; the readme
describes the current release without per-feature version tags.

## v2.3.2 — native download screen, real fix for empty files

**Files:** `minecraftjs.1.19.4._v2.3.2.html` (~190 MB, everything) and
`minecraftjs.1.19.4._v2.3.2.lite.html` (~45 MB, same game but silent —
recommended on phones).

The download panel is now a native engine screen (dirt background, buttons,
progress bar) instead of a DOM overlay. Root-caused the empty-file bug: the
builder closed the writer internally and the page closed it again, and the
second close snapshotted an emptied buffer — the builder no longer closes,
the page closes exactly once. The finished file is delivered by a real Save
file button tap (fresh user gesture, so the download reliably starts) rather
than a blocked automatic click.

## v2.3.1 — download fixes + Lite file

**Files:** `minecraftjs.1.19.4._v2.3.1.html` (~190 MB, everything) and
`minecraftjs.1.19.4._v2.3.1.lite.html` (~45 MB, same game but silent —
recommended on phones).

Fixes the v2.3.0 download flow: the save picker now opens inside the tap
(before it could silently expire during setup), bundling shows live file
progress instead of a frozen message, closing the panel no longer kills
the build, and the finished file gets a tappable retry link in case the
automatic download is blocked. New **Lite** option bundles only the main
asset zip for a ~45 MB phone-friendly file; the offline boot already
continues silently when the sound zips are absent.

## v2.3.0 — full offline download returns

**File:** `minecraftjs.1.19.4._v2.3.0.html` (~250 MB) — the complete game in one file, nothing cut.

The title-screen **Download…** button is back with a new in-tab builder: it
bundles the game code, embeds the data files, asset zips and mesh worker, and
saves a single HTML that boots from a double-click with zero network. The file
retains 100% of the site's features: singleplayer, survival, crafting, touch,
Skyblock, resource packs, external-server joins — and voice, which the old
file builds never had (same voice rooms over peer-to-peer mesh signaling when
online; same-computer tabs fully offline). Realms cross-device works through
the same mesh as before. The only things a file copy can't use are the site's
durable server rooms and global public browser (platform sockets only work on
perchance.org), so file rooms live while a host tab is open. Everything else
is untouched; saves stay in each browser's localStorage.

## v2.2.0 — offline download removed

The game now runs only on this page — no file to download, no
multi-minute first parse on phones.

The title-screen **Download** button and its in-tab single-file builder
(`src/mc1194/offline.js` + `src/tools/offline/loader.js`) are deleted, so
there is no `minecraftjs.1.19.4._v*.html` release file anymore. Everything
else is untouched: singleplayer saves, Realms rooms, and all v2.1.0
features carry over as-is.

## v2.1.0 — MakeUp look + trident/allay/channeling parity

**File:** `minecraftjs.1.19.4._v2.1.0.html` (~255 MB) — the complete game in one file, nothing cut.

The built-in shader gets the MakeUp-UltraFast look (WebGL 2):
custom-sigmoid tonemap, **vibrance** slider, warm bloom, world-light
grading (sunset warmth, night blue, rain cool/desat, nether warmth, end
cool, teal water), **moon glow** + halo at night, underwater refraction
wobble + shimmer — with new options rows (Vibrance, World grading, Moon
glow, Underwater FX, Tonemap (sigmoid)) next to the existing bloom,
exposure, FXAA, lens, flares, shafts, vignette and grain controls.
FXAA stays the exact EaglercraftX u53 algorithm, verified live to blend
silhouette edges and leave flat interiors alone.

Combat/mansion parity: player-thrown **tridents** get the full loop
(spear-draw charge gate, loyalty return including sky-throw age-out,
plain drops keep damage, death-in-flight drops the stash), woodland
mansions hold two caged **allays** with the evoker, **channeling** calls
a bolt on a channeling hit in thunder (creepers charge instead of taking
bolt damage), and mid-range swimming **drowned** hold station and hurl
tridents. Zero console errors; verified live.

Phone fix: the offline file is one complete build again (no cut-down
variant). It now boots in two phases — game code plus main assets first so
the title comes up fast, the 158 MB of sound packs decoding in the
background while the title is already up — with on-screen progress during
the long first parse, staged boot messages plus the boot stage in the tab
title, and a vibration pulse when the title opens (felt pulses on a blank
screen = rendering is the only thing broken).

## v2.0.0 (2026-11-08) — 1.19.4 engine + 1.19 content

**File:** `minecraftjs.1.19.4._v2.0.0.html` (~180 MB)

MAJOR: the engine moves to **Minecraft 1.19.4** (protocol 762, pack
format 13, 998 blocks / 1,228 items, native 1.19.4 assets + sounds).
**Old saves do NOT transfer** (state ids changed; 1.18.2 worlds stay on
their files). Everything from v1.16.0 carries over: dragon endgame,
Tectonic caves/geodes, ocean monuments, multi-biome Nether, mansions,
illagers/raids, streaming audio.

New 1.19 life: **frogs** (cold/warm/temperate variants that eat small
slimes for froglights, lay **frogspawn** that hatches **tadpoles** —
scoop them with a water bucket, they grow up on land at your peril),
the **allay** (give it an item to fetch more, dances by jukeboxes,
duplicates with amethyst while dancing), rideable **camels** (saddle up,
Space to dash), the **sniffer** (sniffs up torchflower seeds — plant
**torchflowers**, new crop), and the **warden** (shrieker warnings,
darkness, sonic boom; go quiet for a minute and it leaves). Swamps grow
**mud**, high meadows bloom into **cherry groves** (pink canopy, pink
petals), deep caves hold **sculk patches** (sensors, shriekers,
catalysts, veins). **Chest boats** carry 27 slots, the **recovery
compass** points at your last death, **goat horns** sound (and drop when
rams hit stone), music disc 5 assembles from 9 fragments, echo shards
and fragments stash in mansion chests until ancient cities arrive
(future). Zero console errors; verified live.

## v1.16.0 (2026-11-04) — Dragon endgame

**File:** `minecraftjs.1.18.2._v1.16.0.html` (~180 MB)

The End is a boss fight now. The **Ender Dragon** (200 HP, pillar-crystal
healing, circle/dive/perch AI, dragon fireballs bursting into lingering
breath clouds) guards the island; killing it earns 12,000 XP, lights the
exit portal, hatches the **dragon egg** (punch it and it teleports away
instead of dropping), and opens one of 20 **exit gateways** per kill —
step in to ride to the outer islands, step into the far gate to come
home. The four-corner **respawn rite** (end crystals on the bedrock rim)
draws the dragon back for rematches (500 XP). Outer islands hold End
**cities** (tower + top room, rods, loot chest, guided-bullet **shulkers**
with levitation, shells crafting **shulker boxes**), ships with an
**elytra** chest, and plantable **chorus** (flowers grow columns on end
stone); **elytra** flight works offline (jump mid-fall to deploy, landing
ends it, 1 durability/s, firework boosts), and glass bottles scoop
**dragon's breath** from breath clouds — completing the brewing loop
(wart planting arrived via v1.15.0 fortresses). Zero console errors;
saves carry over untouched.

## v1.15.0 (2026-11-04) — optimization + ocean and underground

**File:** `minecraftjs.1.18.2._v1.15.0.html` (~180 MB)

Speed first, then water and the deep dark below it. The speed half
changes nothing you can
see. The Tectonic router lattice builds 3–4× faster (fresh chunks ~9–17 ms
instead of ~31–55 ms): the coarse height scan now asks each density node
only for its *sign*, so Min/Max nodes skip whole subtrees (caves, rivers,
noodles) once one side decides, and the interpreter sheds its per-call
garbage (closure-free trilinear, object-free splines, compact octave
lists). Repeat column lookups are ~50× cheaper (a persistent column memo
covers biome sweeps and leaf-neighborhood sampling), per-column climate
does a third less work (only the three fields biome mapping reads), and
mansion locate drops from ~7 s cold to ~0.1 s. Chunk meshing is ~2–3×
faster too (typical sections ~56–68 ms of worker time down to ~20–25 ms;
deep-ocean sections ~400 ms to ~26 ms, underground ~45 ms to ~15 ms):
fully-buried blocks skip meshing entirely, water culls before its
expensive tint/height work, face tests read a pre-passed opacity map, and
lighting/tint reuse a sliding window instead of re-sampling. Meshes are
identical by construction (every skip provably emits zero vertices; every
fast path takes the same branches) and screenshot-verified. Worldgen
output is proven
bit-identical: a 119,000-point interpreter proof plus live determinism
hashes over mountains, meadow and ocean columns. Saves carry over
untouched.

Below the surface, **caves** carve Tectonic terrain from
the router's own density fields (flooded near sea level, dry and walkable
deeper), with **lush** (moss, clay, rooted dirt, spore blossoms) and
**dripstone** cave biomes plus amethyst **geodes** (calcite shells, budding
amethyst, facing-correct buds). The **ocean** gets prismarine **monuments**
with three seeded elder guardians (Mining Fatigue aura), guardian and
night-drowned spawns, throwable **tridents** (loyalty/impaling), water-
absorbing **sponge**, and frame-powered **conduits** (water breathing,
haste, defense; stronger with 42 frames). The **Nether** is five biomes
now (wastes, soul-sand valley, crimson + warped forests, basalt deltas)
with brick **fortresses**: a wart garden to start your own farm, a loot
chest, spawning blazes (fireball volleys) and wither skeletons (Wither
II, 2.5% skull drops for the wither). Fixed along the way: the whole
farming layer was silently writing 1.15.2 block ids (tillage made
redstone wire, bone meal made note blocks) — every crop, flower, fire
and bucket id now resolves by name at boot. Still open: overworld biome
music, map pixel persistence, the End dragon.

## v1.14.0 (2026-11-01) — 1.18.2 engine + Tectonic + mansions + streaming audio

**File:** `minecraftjs.1.18.2._v1.14.0.html` (~180 MB)

The 1.18.2 release. It carries the full village system — pillagers,
vindicators, evokers and ravagers with wiki-checked AI, day-or-night
patrols behind a banner captain, Bad Omen captain kills, multi-wave
raids with Hero of the Village, and the wandering trader with leads and
fence-knot hitching — plus the 1.18.2 engine swap. **Multiplayer** joins real 1.18.2 servers over
protocol 758 (swapped wire tables, dual-protocol-safe builders/decoders,
pong/equipment/package handling, squid + 1.18 metadata paths). **Tectonic**
terrain: a 1.18.2 density-function interpreter over jar-verified
positional noise (full-mask Blended + Normal, all 24 op types) driving
the Tectonic v2.2.2 router — continents, erosion, peaks past Y 200, sea
level, climate biomes — with a treeless meadow above the tree line and
depth-banded 1.18 ores (diamond peaks at the floor; redstone, lapis,
gold, copper, iron, coal and emerald each on their own band;
stone→deepslate across Y 0..−8 with rare tuff and matching deepslate
variants). **New mobs** with live-verified behaviors: ramming goats
(milkable), play-dead axolotls (bucketable) and glow squids (ink +
glow-ink drops). **Woodland mansions** on tectonic terrain: deterministic
evoker + vindicator residents (vex summons, totem/emerald/XP drops), a
lootable sanctum chest, and expert-cartographer explorer maps with a
pre-rendered mansion survey. **Audio**: the full 1.18.2 sound set (1,203
events); the 23 long tracks (new menu/game/nether music, otherside +
pigstep, nether ambience) stream on demand instead of ballooning RAM,
the Nether gets its wastes music pool plus ambient bed/additions, and
the default music volume now matches vanilla. Two audit-found gaps
closed along the way: sub-zero singleplayer edits now save and the
piston journal covers the full height range. Singleplayer saves live in
a fresh 1.18.2 store — old 1.15.2 worlds stay playable on the frozen
1.15.2 file. Still open: overworld biome music, engine map icons, map
pixel persistence across reloads, multi-biome nether and cave carving.

## v1.13.0 (2026-10-30) — pistons + observers

**File:** `minecraftjs.1.15.2._v1.13.0.html` (~150 MB)

Pistons and observers complete the redstone set: both face the placer,
pistons push up to 12 blocks (sticky ones pull back) and refuse tile
entities, arms render through the slide, slime and honey carry their
side blocks (slime and honey don't stick to each other), and fragile
blocks in the way pop as drops. Power edges fire after a 1-tick delay
and drop out if power leaves first; weak power in the cell above the
base counts too (quasi-connectivity). Pushes shove mobs and items
along, and saves that land mid-slide repair themselves on entry.
Observers pulse 2 ticks on any neighbor change and output only out the
back — two face-to-face clock each other. Two real bugs fixed in
testing (observers double-pulsed from a journal write plus a settle
notify; ghost head cells reoccupied after a torch pop). Saves carry
over untouched. Still open: doors/trapdoors/fence gates (no door sim
yet), note pitch/instrument selection, jungle-temple worldgen wire,
and the 2.0.0 headline (to be announced).

## v1.12.0 (2026-10-30) — mob animation pass

**File:** included in `minecraftjs.1.15.2._v1.13.0.html` (no standalone
v1.12.0 file; code verified live 2026-10-30, docs shipped with v1.13.0)

Mobs animate instead of sliding: walk/idle limb swings through the
engine interpolator (children swing 3x), grounded/airborne wing and leg
poses, sitting wolves (empty-hand right-click toggles — sitters hold
and skip bodyguard/teleport), sheep grazing while the coat regrows,
angry wolves/endermen/bees, enderman scream, skeleton bow-aim with bows
rendered, melee/ranged attack swings, witch drink/throw tells, creeper
swell with charged flash, bee banking roll, horse rear/graze/nibble/
tail-swish with saddle and rider flags — plus hurt flash and a
fall-over death animation (bodies linger ~1s, then poof). Purely
visual: no AI or hitbox changes. Gaps (engine-side): magma-cube squish
and golem attack-timer poses need engine args the renderer hardcodes;
aquatic mobs keep their upright pose; parrot/ocelot sitting not simmed.
Saves carry over untouched.

## v1.11.0 (2026-10-30) — redstone signal sim

**File:** `minecraftjs.1.15.2._v1.11.0.html` (~150 MB)

Dust carries power now: a full 0-15 signal sim. Wire runs 15 blocks
with side/up connection rendering, climbs steps, and pops (dropping
redstone) when its floor goes. Torches invert with a 2-tick delay and
burn out after 8 fast toggles, reviving on the next change a minute
later. Repeaters delay 1-4 ticks, hold their output while locked from
either side, and never pass signal backward; comparators read the
container behind them (or the signal there) in compare/subtract mode.
Right-click a repeater to step its delay, a comparator to flip its
mode. Daylight detectors mirror their computed daylight level into the
net, and hoppers, dispensers, rails, lamps, TNT and note blocks all
answer to dust — one real bug fixed in testing (torches powered their
own attachment and switched themselves straight off). Saves carry over
untouched. Still open: doors/trapdoors/fence gates (no door sim yet),
note pitch/instrument selection, jungle-temple worldgen wire, and the
2.0.0 headline (to be announced).

## v1.10.0 (2026-10-30) — buzzy bees

**File:** `minecraftjs.1.15.2._v1.10.0.html` (~150 MB)

Bees arrive with the whole loop: entity models backfilled (bee, fox,
panda and cat all construct from the jar data), wild bees forage
flowers, fill nectar, pollinate crops and ferry honey home to
player-crafted beehives or oak/birch wild nests, raising honey to 5.
Harvest honeycomb with shears or fill glass bottles at full hives — a
lit campfire within 5 below smokes them calm, otherwise the swarm
stings back with poison (one sting per bee, then it dies). Bottled
honey cures poison. Silk touch carries the colony inside the block
(placing it re-homes the bees); plain breaks release everyone and
anger the swarm, nests dropping nothing and hives dropping themselves
empty. Campfires light with flint and steel, burn mobs standing in
them, go out to shovels and water, and calm through up to one solid
block; dispensers harvest full hives and light campfires too. Breed
bees with flowers; night and rain send them home to shelter. One bug
fixed during testing: levers and buttons could never be placed (the
support check read a registry flag the survival defs don't carry), so
they always refused. Saves carry over untouched. Still open: wire
propagation (Tier 2), and the 2.0.0 headline (to be announced).

## v1.9.0 (2026-10-30) — armor stands, detector toggle, leather barding

**File:** `minecraftjs.1.15.2._v1.9.0.html` (~150 MB)

Armor stands arrive: place them from the armor_stand item, dress them by
hand (swap, skulls/pumpkins on the head, elytra on the chest) or by
dispenser (empty slots only), tag them with renamed name tags, break
them in one punch for the stand plus its gear back. They fall with
gravity and persist per world with gear and names. Daylight detectors
toggle inverted mode on right-click, and leather horse armor fits the
tack window at last. Saves carry over untouched. Still open: honey (no
bees), wire propagation (Tier 2), and the 2.0.0 headline (to be
announced).

## v1.8.0 (2026-10-30) — dispenser dressing, skulls, and the wither

**File:** `minecraftjs.1.15.2._v1.8.0.html` (~150 MB)

Dispensers place skulls as floor blocks and pumpkins facing the
ejection direction (pumpkins complete snow and iron golems through the
dispenser), dress zombies, husks, skeletons and strays in armor — empty
slots only, gear protects and drops on death — and raise the wither
from a soul-sand T topped with 3 wither skulls (hand-built works too).
The wither hovers, lobs bursting skulls that inflict Wither, and hits
hard up close. Saves carry over untouched. Still open: honey (no bees),
armor stands, and wire propagation (Tier 2).

## v1.7.0 (2026-10-30) — dispenser completion, smarter plates + detectors

**File:** `minecraftjs.1.15.2._v1.7.0.html` (~150 MB)

Closes the documented v1.6.0 gaps. Dispensers shear sheep (right coat
color, shears wear instead of vanishing), saddle and armor horses,
equip armor onto the player standing in front (empty slots only,
occupied slots refuse without consuming), and place shulker boxes that
open as real 27-slot tiles. Wooden pressure plates now hear dropped
items and arrows (stone stays players + mobs; weighted plates read
binary); daylight detectors scale with true sky exposure so roofs
shade them to zero, with rain and thunder dulling the signal. One bug
fixed during testing: dispenser shears were consumed instead of worn.
Saves carry over untouched. Still open: skull/wither builds, honey
(no bees), armor onto mobs, and wire propagation (Tier 2).

## v1.6.1 (2026-10-30) — single-drop fix

**File:** `minecraftjs.1.15.2._v1.6.1.html` (~150 MB)

Every block break was dropping its loot twice: the world hook was
wrapping `setState` a second time on world entry (the engine rebinds
world methods, producing fresh function objects that lose the wrapper
mark), so the break handler fired twice per break. The hook now stores
its wrapper on the world object and re-asserts it instead of stacking a
new layer. Saves carry over untouched.

## v1.6.0 (2026-10-30) — hoppers, dispensers, droppers

**File:** `minecraftjs.1.15.2._v1.6.0.html` (~150 MB)

Redstone containers come online: hoppers chain chest-to-chest with
push/pull/suck on a 4-masterTick cooldown and redstone lock (lever on
top freezes the chain, lever off resumes it — verified item-exact over
dozens of ticks). Dispensers and droppers face the placer and fire on
power edges: arrows that hurt but never take player credit, water/lava
place-and-collect buckets, flint & steel that ignites and primes TNT,
primed TNT, bone meal, boats on water, dropper insert-or-eject, and a
plain-item fallback for everything else. Switches included: levers,
10-tick stone and 15-tick wood buttons, sun-curve daylight detectors,
mob-reading pressure plates — direct-source power only (dust
propagation is still Tier 2). Saves carry over untouched; tiles persist
across reloads with cooldown/power state and spill when broken. One
fix found live during testing: dispenser fire used a hardcoded state id
and placed beds — it now resolves the fire base state from the
registry.

## v1.5.0 (2026-10-29) — massive optimization update

**File:** `minecraftjs.1.15.2._v1.5.0.html` (~150 MB)

No new features — this one is all speed, and saves carry over untouched
(worldgen output is byte-identical: existing terrain, builds, and
overrides load exactly as before). Exploring used to grind the game to a
halt while new chunks generated; now streaming keeps up while you move:

- Chunk generation ~10x faster: hills terrain builds through a
  persistent per-column memo instead of recomputing noise per block, and
  the voxel (Terralith) default world fills column-wise instead of
  per-block — a fresh voxel world now opens in seconds instead of hanging
  the tab. Nether (18 ms/chunk) and End were already cheap; real biomes
  (desert/jungle/swamp/snow tint, rain/snow behavior) now fill chunk
  data instead of everything rendering as plains.
- Chunk writing ~10x faster: blocks go straight into section storage
  with the heightmap built in the same pass and a single lighting pass
  (identical blocks and light, verified over all 32,768 voxels of a
  chunk); mesh slices read biome arrays directly instead of 8,000 zoom
  lookups each; the mesh scheduler caches neighbour readiness instead of
  re-scanning the world per section.
- Streaming no longer hitches: small budgeted fill slices at 10 Hz with
  backpressure from the mesh queue (your own chunk and neighbours always
  fill first, so you never float over void), and the mesh worker is fed
  by free slots instead of starving at low frame rates.
- Long-played worlds stay fast: saved player edits are now indexed by
  chunk instead of rescanning the whole edit list on every chunk fill.

## v1.4.0 (2026-10-29) — six workstations

**File:** `minecraftjs.1.15.2._v1.4.0.html` (~150 MB)

Blast furnace + smoker: 2x-speed smelting with JE input gates (ores and
iron/gold/chainmail gear vs. food), double fuel burn, lit states, and
banked smelt XP — all on the furnace tile, so batches run closed and
persist across reloads. Barrel: 27-slot storage (chest tile, no
open-side restriction). Grindstone: two-item durability merge (+5% bonus)
or strip down to curses, with XP from every removed enchantment (books
come back plain); creative is free. Stonecutter: the full JE 1.15
cutting list over the native recipe grid (slabs x2), 1 block per cut.
Composter: feed plants by JE fill chance (cake always works), harvest one
bone meal when full. Bell: rings and startles nearby villagers.

## v1.3.1 (2026-10-29) — download-button fix

**File:** `minecraftjs.1.15.2._v1.3.1.html` (~150 MB)

Fix release: the downloaded file no longer shows a dead Download button
on the title screen (it is the file — there is nothing left to build,
and the button could never work there). The button still appears while
building the file, and now re-fires the download if the browser's
sandbox swallows the first click instead of rebuilding.

## v1.3.0 (2026-10-29) — brewing stand

**File:** `minecraftjs.1.15.2._v1.3.0.html` (~150 MB)

Brewing is in: fill glass bottles from any water source, then run the
native brewing-stand window — blaze-powder fuel, 400-tick batches, and
the full JE 1.15.2 recipe table (awkward/mundane/thick bases, extended
and level-II variants, fermented-spider-eye corruptions, gunpowder
splash). Batches keep going with the UI closed and persist across
reloads. Two temporary bridges until later phases: nether wart rides
the stronghold chest (no fortresses grow it yet), and dragon's breath
— hence lingering potions — has no source until the dragon.

## v1.2.0 (2026-10-29) — anvil

**File:** `minecraftjs.1.15.2._v1.2.0.html` (~150 MB)

The anvil works now: repair gear with its material, combine two items
(durability plus merged enchantments, same-level pairs stacking higher),
and rename anything — all under JE 1.15.2 rules, with prior-work
penalties, the 40-level "Too expensive!" cap, XP-level costs, and anvils
that wear down and break with use. Also works in creative (free, no wear).

## v1.1.0 (2026-10-29) — enchanting table

**File:** `minecraftjs.1.15.2._v1.1.0.html` (~150 MB)

Enchanting is in: right-click an enchanting table for the native window
with three JE-rule offers scaled by surrounding bookshelves. Pay lapis +
XP levels for weighted random enchantments (no treasure, no curses);
books become enchanted books. Also works in creative (free).

## v1.0.0 (2026-10-29) — first release

**File:** `minecraftjs.1.15.2._v1.0.0.html` (~150 MB)

MinecraftJS is the complete 1.15.2 game in a single
file — no install, no account, no internet needed to play. Open it in
Chrome or Firefox and hit Singleplayer: seeded worlds with villages,
a Nether and an End to conquer, full survival, JE-rule villager trading,
and tab co-op Realms on the same computer.

### In this release

- 1.15.2 client: chunk rendering, entity models, particles, sky and
  weather, day/night, HUD, inventory and container screens, chat, credits.
- Singleplayer: world list with screenshots, 5 world types (Terralith,
  Classic, Superflat, Void, Skyblock), seeds, difficulties, bonus-chest
  toggle, chat commands, 1.13.2 save migration.
- World generation: villages, 9 biomes, Nether (obsidian portals, 8:1
  travel), End (stronghold, throwable eyes, two-way portals),
  per-dimension saves.
- Survival: 27 mob species, taming and breeding, golems, XP, TNT,
  buckets, furnaces, chests, bows, fishing, boats, minecarts, horses,
  farming, weather and lightning, potions, spawn eggs, bed sleep/skip.
- Villager trading under JE 1.15.2 rules: 13 professions, restock,
  reputation, special rolls, per-village persistence.
- Crafting: recipe book, click-to-craft, shift-click batch, tool repair.
- Realms: same-computer tab co-op plus optional cross-device mesh, room
  codes, chat, `/realm` commands, invite links, shared Skyblock.
- Touch controls, Skyblock island, embedded resource packs (Faithful 64×,
  Dark-GUI), external-server joins from the file.

### Not in this build

- No voice chat. Mod loader parked until vanilla parity.
