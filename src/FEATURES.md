# MinecraftJS v2.3.2 (Minecraft 1.19.4)

The full 1.19.4 game in the browser: singleplayer survival on a
−64..319 deep world, villages under illager threat (patrols, raids, the
wandering trader), Nether and End, villager trading, crafting, tab co-op
Realms, touch controls, Skyblock, and resource packs. No install, no
account — open the page and play.

## Get it

Play it right here on this page — no download, no install, no account.
Hit **Singleplayer** on the title screen. Saves live in the browser's
localStorage; installed resource packs use IndexedDB. Or hit **Download…**
(bottom-left of the title screen) to save the **complete game as one file**
— **Full** (~190 MB, everything incl. all sounds) or **Lite** (~45 MB,
same game but silent, recommended on phones). Either builds in a few
minutes: the same code, assets and worldgen, playable offline from a
double-click.

- **Runs in the browser**: everything below — singleplayer, Realms, voice,
  touch controls, Skyblock. The 28 long music/ambience tracks stream on
  demand (everything else, including all sound effects, is bundled with
  the page).
- **Needs internet**: loading the page, joining external multiplayer
  servers, server-list pings, cross-device Realms/voice mesh.
- **The downloaded file** keeps 100% of the features (Full; Lite is the
  same game but silent — no bundled sounds): singleplayer,
  survival, crafting, touch, Skyblock, resource packs, external-server joins
  and voice all work from the file whenever the device is online. Realms rooms
  and voice run over the same-computer tab mesh fully offline, and over the
  cross-device mesh (tick the box in the Realms menu) when online. The only
  things a file copy can't do: use the site's durable server rooms (rooms live
  while a host tab is open) or list them in a global public browser. Worlds
  stay in whichever browser holds them — localStorage is per-browser, so copy
  worlds between browsers via the world menu if you play in both.

## Starting it

Open the page → title screen (Mojang splash → 1.19 "Wild Update"
panorama): **Singleplayer**, **Multiplayer**, **Minecraft Realms**,
Options (incl. accessibility, language, resource
packs, shaders), Quit-to-title. Native engine-rendered dialogs throughout:
confirm/prompt/keyboard widgets, native death screen ("You died!" +
Respawn, Enter respawns), loading veils, status toasts. URL extras that
work on the page: `?connect=<server>`, `?touch=1/0`, `#realm=<code>`
invite links (open the Realms menu).

## The client (1.19.4 engine, in the file)

Full 1.19.4 client: chunk rendering (WebGL2/WebGPU/CPU fallback), entity
models, particles, sky/weather visuals, day/night, HUD (hearts, hunger,
armor, XP bar, hotbar, crosshair, boss bars), inventory + container
screens, chat, pause/death/options/pack/shader/stats/advancements/book/
sign/command-block/structure screens, narrator, spectator, demo mode,
credits. Ships native 1.19.4 registries + assets inside the file (998
blocks / 1,228 items / 935+8 recipes / 124 entity types,
real 1.19 textures, models, sounds, languages). The Overworld spans Y
−64 (bedrock) to the 319 build limit; the Nether keeps its 0..127
floor/ceiling and the End 0..255, matching vanilla dimensions.
Multiplayer joins 1.19.4 servers over protocol 762. Audio: full 1.19.4
sound set (1,462 events) — effects decode in-file while the long
tracks (menu/game/nether music, discs incl. 5, ambience) stream on
demand; the Nether gets its wastes music pool and
ambient bed plus additions/mood one-shots, and all disc events
(including 5 + otherside + pigstep) resolve to audio. Visuals go
 further than vanilla through the in-file **ImmersiveVFX** port (Video
 Settings → ImmersiveVFX…: 7 presets + Custom, fog/sky/cloud/light
 grading, aurora, meteors, light shafts, mist, bloom halos, GPU
 grass, ambient particles; a master **ImmersiveVFX: ON/OFF** toggle on
 the same screen returns rendering to plain vanilla, incl. the foliage
 tint LUTs); when OFF, the ImmersiveVFX… button and every IVFX
 option except the master switch grey out (disabled buttons ignore
 clicks); external E-LITE/BSL shader packs were
 removed as redundant with it. Alongside it runs the native
 Built-in shader (Shaders list → Built-in, on by default; Video
 Settings → Built-in Shader: ON/OFF + Built-in Shader…): a fullscreen
 post chain that lives in the engine, so it runs on every graphics
 backend (WebGL 2, WebGPU, CPU) with live game state — grade pass
 (half-res bright-pass bloom, adaptive auto-exposure + bias slider,
 ACES tonemap, water/lava/hurt eye tints, perceptual luma in alpha;
 on WebGL 2 the grade uses a MakeUp-UltraFast-style custom-sigmoid
 tonemap plus vibrance and world-light grading — sunset warmth, night
 blue, rain cool/desat, nether warmth, end cool, teal water tint)
 then a finish pass (FXAA 3.11 exactly as EaglercraftX u53 ships it,
 luma read back from the grade alpha channel; lens distortion +
 chromatic aberration, screen-space light shafts,
 procedural sun lens flares, vignette, animated film grain; on WebGL 2
 also moon glow + halo and underwater refraction wobble + shimmer), plus
 waving leaves/plants/water on WebGL 2. The post set mirrors
 EaglercraftX's built-in "High Performance PBR" pack (v1.4.2, u53
 ground truth) options, with the MakeUp look layered on top on WebGL 2
 (other backends keep the Eagler-style grade). Not
 included (needs depth + G-buffer + geometry passes this forward
 renderer does not have): sun shadows, SSAO, screen-space
 reflections, PBR environment reflections, planar realistic water,
 subsurface scattering, true dynamic lights (the IVFX held-torch halo
 covers the handheld feel). External packs and
 entity-view shaders take precedence when active; IVFX keeps running
 and composes with the grade.

## Singleplayer

Engine-rendered world menu: list with **thumbnail screenshots**, search,
Play/Create/Delete/Rename; Enter or double-click plays. Create form: name,
seed, 6 world types — **Tectonic** (default), Terralith, Classic hills, Superflat,
Void, Skyblock — gamemode, difficulty, structures toggle, cheats toggle,
**bonus-chest** toggle. Seeded deterministic terrain (only your edits are
saved); autosaves while playing. The Overworld spans Y −64 (bedrock) to
the 319 build limit; deep edits save and reload like any other. Chat
commands: `/time /gamemode /tp /spawn /give /difficulty
(peaceful|easy|hard) /weather`. Void rescue, creative placement fixes,
starter chest on bonus worlds.

## World generation (all in-file)

- **Tectonic** (Tectonic world type): genuine density-function
  terrain (Tectonic v2.2.2 router over jar-verified noise) — wide
  oceans, eroded peaks past Y 200, climate-mapped biomes with trees, ores
  and dressing. Villages/strongholds stay on Classic hills for now.
  (Caves carve Tectonic only; Classic hills stay solid.)
- **Villages** (Classic hills): deterministic lattice — plank houses (log
  corners, glass, doors, torches), cobble well, wheat farms, fence lamps,
  gravel paths.
- **9 biomes** (Classic hills; Tectonic adds a treeless **meadow** above
  the tree line): plains, desert (cactus/dead bush), jungle, swamp, ocean,
  river, beach, snow, rock — matching surfaces, trees, dressing, and
  biome-gated mob spawns (jungle parrots, swamp slimes, snow polar bears,
  desert husks, meadow goats).
- **Nether**: bedrock floor + ceiling, **5 biomes** (wastes, soul-sand
  valley with basalt pillars, crimson + warped forests with fungi, basalt
  deltas), lava seas, quartz ore, glowstone; brick **fortresses** on a
  512 lattice with a soul-sand wart garden + loot chest; blaze volleys,
  wither skeletons (Wither II), magma cubes and warped-forest endermen;
  nether wart plants on soul sand; 4×5 obsidian **portals** light with
  fire, **8:1 travel** both ways with return portals; beds explode, water
  evaporates; per-dimension saves.
- **End**: central island, 10 obsidian pillars with healing **end
  crystals**, outer chorus islands, kill-gated exit **fountain** (portal +
  egg + bedrock rite corners); the **Ender Dragon** (circle/dive/perch,
  fireball breath clouds, 12,000 XP first kill, 500 after, one of 20 rim
  **gateways** per kill — ride out, ride back) with the 4-crystal
  **respawn rite**; lattice **End cities** (tower + top room, 2 shulkers,
  loot chest, 45% ship with **elytra**), guided-bullet **shulkers**
  (levitation), shells → **shulker boxes**, plantable **chorus**
  (flower columns on end stone, fruit drops); buried **stronghold**
  (~1 km out, 12-frame ring with prefilled eyes + loot chest);
  throwable **eyes of ender** that fly toward it; eye-into-frame lighting;
  two-way portal travel plus gateway travel; endermen-only spawns;
  per-dimension saves.
- **1.19 ores**: depth-banded triangle distributions (diamond peaks at the
  floor, redstone/lapis/gold/copper/iron/coal/emerald each with their own
  band), stone→deepslate blend across Y 0..−8 with rare tuff, deepslate
  ore variants, smelting + XP parity.
- **Woodland mansion** (Tectonic): cobble hall with glass rhythm, dark-oak
  trim, log pillars, floor torches and a diamond sanctum; deterministic
  residents, sanctum loot chest (plus echo shards and disc fragments
  until ancient cities arrive), and L4 cartographer explorer maps.
- **Caves** (Tectonic): spaghetti/noodle carving from the router's own
  density fields (flooded near sea level, dry and walkable deeper),
  **lush** (moss, clay, rooted dirt, spore blossoms) and **dripstone**
  cave biomes, and amethyst **geodes** (smooth-basalt/calcite shells,
  budding amethyst, facing-correct buds).
- **Ocean**: prismarine **monuments** with 3 seeded elder guardians
  (Mining Fatigue aura), guardian + night-drowned spawns, **tridents**
  (melee, throwable with loyalty/impaling/**channeling** — a channeling
  hit in a thunderstorm calls down a real bolt that charges creepers,
  drowned throw theirs back at you in the water, drowned drops), sponge
  (absorbs water, smelts dry), **conduit** power (water breathing +
  haste + defense in range, 16/42-frame scaling), and cartographer
  ocean explorer maps.
- **1.19 land**: swamp hollows run to **mud**; high meadows bloom into
  **cherry groves** (pink canopy, cherry logs, **pink petals** carpeting
  the grass, goats wandering through).
- **Sculk deeps** (Tectonic, below Y −16): patchy **sculk** floors with
  **sensors**, **shriekers** and **catalysts** plus wall **veins**;
  shriekers warn (shriek + soul particles), darken your vision from the
  second warning, and call a **warden** at the fourth (one per 48 m).

## Survival simulation (10 Hz)

Health/hunger/exhaustion, difficulty scaling, fall/drown/lava/fire/void
damage, armor + toughness, weapon skills (cooldown/crit/sweep/shields/
totem), milk, full status-effect engine (poison/regeneration/fire
resistance/night vision/chorus teleport/suspicious-stew flower effects…).
**54 mob species** with wiki-checked AI (creeper fuses, skeleton archers,
enderman stare, slime splitting, witch potions, phantoms…), taming
(wolves, cats, parrots, horses…), breeding + babies, pets that follow and
fight for you, golem building, magnet drops, XP orbs driving the native XP
bar, 40/10 spawn director with day/night + light rules. **1.19 mobs**:
**frogs** (3 temperature variants, eat small slimes into froglights,
breed onto water as frogspawn → tadpoles → grow up; scoop tadpoles with
a bucket), the **allay** (hand it an item and it fetches matching drops,
dances at jukeboxes, amethyst-duplicates while dancing, two caged in
each woodland mansion), rideable
**camels** (saddle, steer, Space-dash, cactus breeding), the
**sniffer** (digs torchflower seeds on a ~1–2 min cycle),
warden-grade trouble (see Sculk deeps above). Blocks: TNT,
buckets, furnaces (smelting + banked XP), chests, workbench, throwables,
bows, fishing, boats + **chest boats** (27 slots, contents spill on
break, survive reloads), minecarts + rails, horses, full farming
(incl. **torchflowers** from sniffer seeds), weather +
lightning, splash/lingering/drinkable potions, 37 spawn eggs, cake slices,
bed sleep/skip. Enchanting table: bookshelf-scaled costs,
lapis + XP levels, weighted random enchantments (JE rules, no
treasure/curses), books become enchanted books. Anvil: repair with the
item's material, combine two items (durability + merged enchantments, JE
costs with prior-work penalties and the 40-level "Too expensive!" cap),
and renaming; anvils wear out and break with use. Brewing stand: fill
glass bottles from water, then brew the full JE table (extended and
level-II variants, corruptions, splash and lingering) with blaze-powder
fuel; batches keep going with the UI closed and persist across reloads.
Fortress gardens grow plantable nether wart (soul sand, any light).
Glass bottles scoop **dragon's breath** from dragon-breath clouds
(lingering potions need a dragon kill first). **Elytra**: equip in the
chest slot, jump mid-fall to deploy, steer the glide, landing ends
flight, 1 durability per second, **firework** boosts while gliding.
Blast furnace + smoker:
2×-speed smelting (ores/tools/armor vs. food only) with 2× fuel burn, lit
states, banked XP. Barrel: 27-slot silent storage. Grindstone: two-item
durability merge (+5%) or strip-to-curses with XP from removed
enchantments (books come back plain). Stonecutter: 1-block-in,
variant-out cutting list (slabs ×2). Composter: feed plants to fill
layers, harvest bone meal when full. Bell: rings and startles villagers.
Hopper: aims at the clicked face on placement, then pushes/pulls/sucks
one item per 4 masterTicks, stopping while powered (the enabled bit
mirrors the lock). Dispenser + dropper: face the placer and fire on
power edges after a 2-tick delay — arrows/snowballs/eggs/pearls/potions/
fire charges shoot straight and neutral (no player credit or anger),
buckets place and collect source blocks, flint & steel ignites and
primes TNT, TNT primes, bone meal grows crops, boats land on water;
droppers push into the faced container or eject otherwise. Switches:
levers, stone buttons (10-tick release) and wood buttons (15-tick)
mount on any block face, including hopper tops; daylight detectors
follow the sun curve and pressure plates read mobs + player. Power is a
full 0-15 signal sim: redstone dust carries up to 15 blocks with side/up
connection rendering, climbs steps, and pops (dropping redstone) without
a solid floor; torches invert with a 2-tick delay and burn out after 8
fast toggles (revived by the next change a minute later); repeaters
delay 1-4 ticks, lock from either side, never pass signal backward, and
step delay on right-click; comparators read the container behind them
(or the signal there) in compare/subtract modes, switching on
right-click; daylight detectors mirror their computed level into the
net. Dust, torches, repeaters and comparators place oriented. Pistons
and observers complete the set: both face the placer, pistons push up
to 12 blocks (sticky ones pull back) and refuse tile entities, arms
render through the slide, slime and honey carry their side blocks
(slimes and honey don't stick to each other), and fragile blocks in
the way pop as drops. Power edges fire after a 1-tick delay and drop
out if power leaves first; weak power in the cell above the base
counts too (quasi-connectivity), pushes shove mobs and items along,
and saves that land mid-slide repair themselves on entry. Observers
pulse 2 ticks on any neighbor change and output only out the back —
two face-to-face clock each other. Hoppers, dispensers, rails, lamps,
TNT and note blocks all answer to dust, and everything persists
across reloads. Mobs animate instead of sliding: walk/idle limb
swings through the engine interpolator (children swing 3x),
grounded/airborne wing and leg poses, sitting wolves (empty-hand
right-click toggles — sitters hold and skip bodyguard/teleport),
sheep grazing while the coat regrows, angry wolves/endermen/bees,
enderman scream, skeleton bow-aim with bows rendered, melee/ranged
attack swings, witch drink/throw tells, creeper swell with charged
flash, bee banking roll, horse rear/graze/nibble/tail-swish with
saddle and rider flags — plus hurt flash and a fall-over death
animation (bodies linger ~1s, then poof). Purely visual: no AI or
hitbox changes. Still out: doors/trapdoors/fence gates (no door sim
yet). All tiles run with the UI
closed, persist across reloads with cooldown/power state, and spill
their contents when broken. Dispensers also shear sheep (correct coat
color, wear not consume), saddle and armor horses, dress the player
standing in front (empty slots only — occupied slots refuse), and place
shulker boxes that open as 27-slot tiles. Wooden pressure plates hear
dropped items and arrows (stone stays mobs + player), and daylight
detectors follow real sky exposure — roofs shade them to zero — with
rain and thunder dulling the signal. Dispensers place skulls as floor
blocks and pumpkins facing the ejection direction (pumpkins complete
snow and iron golems through the dispenser), dress zombies, husks,
skeletons and strays in armor (empty slots only — gear protects and
drops on death), and raise the wither from a soul-sand T topped with 3
wither skulls, by hand or dispenser alike. The wither hovers, lobs
bursting skulls that inflict Wither, and hits hard up close. Armor
stands place from the armor_stand item onto a solid top face, dress by
hand (swap — the old piece pops back to you, skulls and pumpkins go on
the head, elytra on the chest) or by dispenser (empty slots only),
take anvil-renamed name tags, break in one punch dropping the stand
plus its gear, fall with gravity, and persist per world with gear and
names. Daylight detectors toggle inverted mode on right-click, and
leather horse armor finally fits the tack window. Bees forage flowers,
fill nectar, pollinate crops (+1 stage, 10 blooms a trip) and ferry
honey home to beehives or bee nests (crafted hives face the placer;
wild nests seed on oak/birch trunks), raising honey to 5. Harvest
honeycomb with shears or fill glass bottles at full hives — a lit
campfire within 5 below smokes them calm, otherwise the swarm stings
back with poison (one sting per bee, then it dies within a minute),
and bottled honey cures poison. Silk touch carries the colony inside
the block (placing it re-homes the bees); plain breaks release
everyone and anger the swarm, nests dropping nothing and hives
dropping themselves empty. Campfires light with flint and steel, burn
mobs standing in them, go out to shovels and water, and calm through
up to one solid block; dispensers harvest full hives and light
campfires too. Breed bees with flowers; night and rain send them home
to shelter.

## Illagers, raids and the wandering trader

Pillagers, vindicators, evokers (+ vexes) and ravagers with wiki-checked
AI: they hunt players, villagers, traders and golems. Patrols roam day
or night behind a banner-wearing captain — kill the captain for Bad
Omen, then enter a village to trigger a multi-wave raid (victory earns
Hero of the Village). The wandering trader wanders in on his own with
llamas and a trade list; leads clip onto leashable mobs and tie to
fence posts as knots that persist across reloads. Naming a vindicator
"Johnny" with a name tag does what you'd expect. Woodland mansions generate
on Tectonic terrain with deterministic residents (an evoker plus four
vindicators, vex summons, totem and emerald drops), a lootable sanctum
chest, and cartographer explorer maps that survey the mansion.

## Villager trading (JE 1.15.2 rules)

13 employed professions + nitwit/unemployed (headshake, no window); up to 5
residents + 1 golem per village with home tethers. Full JE 1.15.2 trade
tables: novice pools, 2 unlocks per level (thresholds 10/70/150/250),
demand + reputation pricing, max-uses lockout, **2×/day restock**, +rep per
trade, hit → −rep + window close + golem retaliation, 8-block range close,
input salvage, per-village persistence. Special rolls: librarian books,
enchanted gear (no treasure/curses), tipped arrows, suspicious stew, dyed
leather armor, color families; expert cartographers sell a Woodland
Explorer Map (13 emeralds + compass) with a pre-rendered mansion survey.

## Crafting

Recipe book fed from the in-file registry (browsable, craftable-
highlighting, ghost-click **click-to-craft**, shift-click crafts all);
bucket container returns; workbench close spills grid + cursor back;
vanilla tool repair. 1.19 recipes included: **recovery compass**
(compass + 8 echo shards, points at your last death), **music disc 5**
(9 fragments), **chest boats** (boat + chest). **Goat horns** sound
from the hand (7 s cooldown; ramming goats drop new ones on stone).

## Realms co-op

Online rooms on this page's own server: create or join by room code (or pick
from the public browser), with avatars, block-edit relay + log replay, chat,
`/realm` commands, invite links (`#realm=<code>`), and a shared-Skyblock gate.
Creative/survival per room; rooms persist server-side. The downloaded file
plays the same rooms over its tab mesh instead (same-computer tabs always;
cross-device when online with the mesh box ticked) — rooms live while a host
tab is open.

## Voice

Proximity voice chat on external multiplayer servers: press JOIN in the voice
panel (or N for the native menu), hold V to talk. Heard ≤ 40 blocks, louder
when closer. Works from the downloaded file too (same rooms, peer-to-peer
mesh signaling when online). Also bridges Eagler voice channels and the
`?voicebridge=` companion tab for talking with Eagler players.

## Everything else

- **Touch controls**: joystick + drag-look + buttons, hotbar tap-select,
  `?touch=` force flags.
- **Skyblock**: shared island (phased regenerating block,
  hand-mine drops, starter kit, `/ob` commands) + welcome screen with
  name/skin picker.
- **Resource packs**: Faithful 64× + Dark-GUI embedded; enable in Options,
  live reload, vanilla default.
- **Multiplayer tab**: join external servers + server pings, on this page
  and from the downloaded file whenever the device itself is online.

## Parked (not in any build yet)

Mod loader.
