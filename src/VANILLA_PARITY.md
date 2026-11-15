# Vanilla parity tracker (mainline is the 1.19.4 engine in
src/mc1194/; the 1.18.2 line was deleted 2026-11-06 at the 1.19.4 pivot
(1.18.2 saves do NOT transfer), and the 1.15.2 line 2026-10-31 after
parity was verified there. Tiers 0-3 below were written for the 1.13.2
quest — Tier 0 carries over via the ported survival.js.)

 Goal (user 2026-10-27, retargeted 2026-10-28): fully 1:1 with vanilla
1.19.4 before any mod loader. Mod loader is PARKED until this is done.

 ## How to use this file
 - Tier 0 = done and live-verified. Tier 1 = next up, roughly in build order.
 - Mark items DONE with date + verification note. Keep deviations honest.
 - Engine = the 1.19.4 engine (`src/mc1194/js/`, READ-ONLY — patch at runtime only).
 - `survival.js` = our offline "server half". Most parity work lands there.

 ## 1.15.2 parity plan (2026-10-28)

 What the engine already gives us (no work needed): native 1.15.2
 registries (680 blocks, 11,337 states, 884 items, 103 entities), ALL
 workstation windows rendered natively (enchant, anvil, brewing, merchant,
 beacon, loom, grindstone, stonecutter, blast/smoker, lectern,
 cartography, hopper, shulker — see js/game/menus-1.14.4.js +
 container.js), the dimension field + dimension switching
 (game.js/world.setDimension), merchant trade-cost logic
 (workstations-1.14.4.js). So every phase below is "server half" in
 `mc1194/survival.js` + worldgen in `mc1194/singleplayer.js`, opened via
 the proven `on_open_window` pattern (furnace/chest/bench precedent).
 Verification follows the Tier-0 recipe: live in-preview, `tick(n)`
 deterministic ticks, wiki cross-checks, screenshots for visuals.

 - Phase A — singleplayer foundations (M). World-list thumbnails +
   bonus-chest spawn: DONE 2026-10-28 (verified live: stocked chest +
   torches + tile, vanilla shot rows with hover/selection). Structures
   framework + villages (hills): DONE 2026-10-28 (verified live: lattice
   villages — plank houses with log corners/glass/doors/torch, cobble
   well with water, log-bordered farms with farmland+wheat, fence+torch
   lamps, gravel cross-paths; trees/tufts suppressed inside; zero-
   override saves; player hole persists as the lone override across
   reload). Real hills biomes: DONE 2026-10-28 (plains/desert/jungle/
   swamp/ocean/river/beach/snow/rock via moisture+temperature+river
   noise: sand/sandstone deserts with cacti+dead bushes, dense jungle
   wood, clay-patch swamps, sand riverbeds, ice water + snow cover in
   cold lands, jungle-only parrots, swamp-only slimes, snow-boosted
   polars, desert/snow husk/stray fallback — all verified live incl.
   screenshots and a 41/41 slime census on a boosted band + revert).
   Nether: DONE 2026-10-29 (bedrock floor+ceiling, netherrack, lava
   seas, soul sand/gravel, quartz, glowstone, surface fire; overworld
   lava pits; obsidian-frame portals both axes with decay + 8:1 linked
   travel + auto-built return portals; per-dimension diffs/saves with
   entity stashes; beds explode, water evaporates, no Nether
   spawns/weather - all verified live by block probes + cross-reload;
   screenshots blocked: preview tab hidden, captures read black).
   End: DONE 2026-10-29 (central end-stone island, 10 obsidian pillars with bedrock caps, arrival platform, outer chorus islands, kill-gated exit fountain (portal + egg + bedrock rite corners — replaced the TEMP pre-built fountain), dragon fight (circle/dive/perch, fireball breath clouds, 12,000 XP first kill, 500 after, 4-crystal respawn rite), one rim gateway per kill (20 slots, ride out + back), lattice End cities (tower + top room, rods, loot chest, 2 shulkers, 45% ship with elytra), guided-bullet shulkers (levitation, shells → shulker boxes), plantable chorus, bottle-scooped dragon's breath (completes brewing); buried stronghold portal room with 10%-each eyes + loot chest (TEMP blaze-rod bridge until blazes — blazes + fortresses shipped v1.15.0); eye-of-ender throw/fly/slot lighting; touch travel both ways; beds explode in the End, water works, endermen-only spawns; full ring persists across save/refresh/entry - all verified live by block probes + cross-reload).
 - Phase B — villagers + Village & Pillage (L, biggest AI chunk).
   Villager job sites/schedules/gossip, trading UI (server half over the
   native merchant window — DONE 2026-10-29: JE pools verified live), iron golems by village (DONE 2026-10-29), wandering trader,
   patrols, raids + bad omen / hero of the village. Needs Phase A
   villages. Drowned + tridents ride along (water mobs; trident is a
   1.13 item the sim never implemented).
 - Phase C — workstation server-halves (M, highly parallel, any order).
   Enchanting (XP + lapis + random enchants wired into combat/mining),
   anvil (repair/combine/rename + XP costs), brewing stand (wart + blaze
   powder fuel → all potion recipes; needs Phase A Nether), hopper/
   dispenser/dropper, piston/sticky + observer + full redstone sim
   (wire/torch/repeater/comparator), beacon + conduit buffs, grindstone/
   stonecutter/loom/cartography/composter/campfire behavior, blast
   furnace + smoker as fast furnaces, barrels, bells. Jukebox/note-blocks
   if cheap (needs Phase F sounds to matter).
 - Phase D — 1.14/1.15 mobs + items (M). Entity-model backfill FIRST
   (bee/fox/panda/cat are spawn-time throws today — extract from Mojave
   client like the 1.15 assets were, else they block everything below).
   Then: bees + hives/nests + honey/honeycomb + honey blocks (SHIPPED v1.10.0; fox/panda/cat models only, no sim yet), foxes,
   pandas, cats split from ocelots (strays), brown mooshroom, sweet
   berries + suspicious stew, bamboo + scaffolding, lanterns, crossbows
   (+ their enchantments), pillagers/vindicators/evokers/vexes/ravagers
   if not covered in Phase B.
 - Phase E — bosses + endgame (M-L). Wither summon + fight, dragon fight
   + elytra + chorus + End cities/shulkers (needs Phase A End), ocean
   monument + elder guardian (needs ocean from Phase A), woodland
   mansion (needs structure framework), advancements/statistics +
   recipe-unlock progression (cosmetic, last).
 - Phase F — presentation refresh (S-M). Witch real model (drop the
   zombie fallback + warn), 1.15 sound bytes for the 1406 unchanged
   paths (budget: full oggs are 166 MB and can't ship — second split zip
   like assets-1152-sounds.zip, or ship the most-heard subset), pack-art
   remap for 1.8-era packs, final panorama/screenshot
   pass.
  - Phase G — ship (S). Re-verify full Tier 0-3 checklist live on 1152,
    then unpark mod loader (needs explicit user confirmation per standing
    instructions). Hardcore/spectator/demo stay skipped (per Deliberately-out).

 Suggested build order: A (villages/biomes first, Nether/End second) →
 B → C (brewing after Nether; rest parallel) → D (models first) → E →
 F → G. Smallest shippable increments: thumbnails+bonus chest, then
 villages, then Nether, then each workstation.

 ## Tier 0 — done (live-verified in preview)
 - Damage/hunger/effects: fall, drown (15s+2/s), lava (4/0.5s+ignite), fire,
   burn 1/s, void below Y-64, starvation floors, peaceful fast-regen,
   exhaustion, saturation, 34 foods, gapple/god-apple fx, milk clear,
   absorption pool, full effect engine (see README for the table).
 - Combat: weapon damage halves + attack-speed cooldown + crit/sweep/
   sprint-knockback, 1.9+ armor formula + diamond toughness, difficulty
   scaling, shield block (both hands, arrows too), totem, durability (NBT
   Damage) + break, bow draw/power/crit + arrow consume.
 - Drops/XP: tool-gated drops, stone->cobble, item entities (magnet, merge,
   fire/lava burn, 5-min despawn, no-magnet overlap pickup), engine-native
   collect fly-in, death scatter, ore XP, orb sizes/merge/attract/claim/XP
   curve driving the native XP bar.
 - Mobs: zombie/husk/skeleton/stray/creeper/spider/enderman + cow/pig/sheep/
   chicken/rabbit/wolf/squid/bat/turtle/ocelot/parrot/polar/dolphin +
   slime/witch/silverfish/endermite/phantom/magma-cube + iron/snow golems;
   director (caps 40/10, 128/32-block despawn, light rules, husk/stray by
   biome, day burn), melee/ranged/creeper AI, spider climb/leap, enderman
   stare + damage-teleport, slime split, witch drink, golem build-detect,
   taming (wolf/ocelot/parrot, pets follow + teleport + bodyguard + creeper-
   flee-cats), phantom insomnia clock, squid beaching, NaN-hardened physics.
 - Blocks/use: cake 7 slices, beds (sleep-skip + spawn, monster check),
   wooden doors both-halves, TNT prime, flint fire, buckets, furnace (smelt,
   fuel, lit, XP-on-take, persist, spill) + chest tiles (27 slots, persist,
   spill), hopper? NO — see Tier 2. Crafting 2x2 + book + ghost-craft.
 - Fish/throw: fishing (85/10/5 loot, 1-6 XP, wear), snow/egg/pearl
   (hatch/teleport/endermite), snowman snowballs.
 - World: Terralith/Classic/Superflat/Void/Skyblock gen, streaming, saves,
   Realms mirrors + survival mode byte, cheats gate, /difficulty.
 - Voice/menus/mobile: native GUI everywhere, touch, voice chat (separate).

 ## Tier 1 — survival-behavior gaps (build now, in order)
 - [DONE 2026-10-27] Crafting 1:1 — all 430 vanilla 1.13 recipe outputs covered
  (350 shaped + 127 shapeless, book 477, 0 skipped): wood-variant sets,
  stone sets, 16 dye/wool/glass/terracotta/concrete colors, rails, utility.
  Shapes generated verbatim from the vanilla dataset; smelting adds the 16
  glazed terracottas. Spot-checked live (granite, wool, fence, chiseled).
  Behavior for redstone/dimension blocks stays Tier 2/3.
 - [DONE 2026-10-27] Weather: rain/thunder cycle, engine-native render
   (world.raining + rainStrength/thunderStrength + particles.rain,
   isRainingAt for sky exposure), no undead burn in rain, player-fire
   extinguish + open-fire put-out, faster fishing in rain, sleep clears
   weather, lightning (fire + damage + charged creepers 6-power + thunder
   sound), /weather (cheat-gated), persist per world. Verified live: state
   machine, engine flags, rain shelter (20hp held) + burn rate (~2.1/2.5s),
   bed sleep -> morning + clear, thunder fade to 1, strike no-errors.
 - [DONE 2026-10-27] Potions usable (drink + splash + lingering): all
   1.13 Potion-tag effects (healing/harming/poison/regen/strength/swiftness/
   slowness/leaping/fire_res/water_breathing/invisibility/night_vision/
   weakness/slow_falling/turtle_master + long/strong variants) apply to
   player AND mobs; drink returns glass bottle, water/mundane do nothing;
   thrown type-77 carries the tag (pre-consume capture so count-1 stacks
   keep it); lingering = same burst (no cloud offline). Verified live:
   drink 12->16 + bottle, splash heal/harm both sides, tag carriage.
   (Brewing stand UI to MAKE them stays Tier 2.)
 - [DONE 2026-10-27] Spawn eggs: all 26 mapped species usable on a block
   face (adjacent cell, occupied-cell refuse, consume 1). Verified live:
   zombie egg -> real zombie, stack 2->1. Unmapped mobs need their mob
   first (Tier 3).
 - [DONE 2026-10-27] Leaf/vine/cobweb/dead-bush drops: shears->leaf block,
   hand->5% sapling, vine shears-only, sword->string on web, dead_bush
   0-2 sticks. Verified live incl. distribution sampling (bush 75/150/75).
 - [DONE 2026-10-27] Effect hooks: invisibility 0.3x sense range (verified
   live: husk closed 11.9->10.2 visible, held 12.2->13.6 invisible),
   fire_res nullifies lava (verified live 20->16 vs 16->16), slow_falling
   no-fall-damage + water_breathing air-freeze stored truthy (fall/air ticks
   can't run in a hidden background tab — engine loop frozen — so those two
   are code+storage verified, same guard shape as the verified ones).
   Fixed in passing: potion levels stored 0-based (all L1 effects dead) ->
   1-based per engine convention; totem fireres 0->1.
 - [DONE 2026-10-27] Breeding + babies: wheat/carrots/seeds/fish love-mode
   foods per species (cow/sheep wheat, pig carrot/potato/beetroot, chicken
   seeds, rabbit carrot/golden/dandelion, wolf meat at full HP, tamed ocelot
   fish, turtle seagrass->direct baby), hearts + pair within 8 blocks, 1-7
   XP, 5-min cooldown (eats, no hearts), babies at half hitbox + engine
   .child half-scale flag, 20-min growth (feeding takes 10% off), babies
   trail adults, sheep coat inherited, tamed parents make tamed pups/
   kittens, wolf meat heals the hurt. Verified live: cow/wolf/ocelot/
   pig/chicken/rabbit/turtle babies, growth to adult, cooldown, heal,
   parrot still tame-only. Caveats: turtle skips egg-laying (no home-beach
   pathing offline); baby render confirmed via engine render-path hook
   (scaleGroup x-0.5 on flagged entities) but pixel screenshots were
   inconclusive (hidden tab serves frozen frames).
 - [DONE 2026-10-27] Boats: place 6 variants on water/shore (consume 1),
   right-click mount (native vehicle: paddle steering, sounds, rider seats),
   sneak dismount, 2-punch break drops the boat item, persist per world,
   death dismounts. Verified live: water + land place, mount (controlled +
   rider snap), dismount, wobble + item drop, save/reload restore. Caveats:
   crash-break loot is engine-side, paddle speed needs a real-input check
   (hidden tab has no pointer lock).
 - [DONE 2026-10-27] Shears + dyeing: shear sheep (1-3 wool, bare, regrow
   ~45s grazing on grass), dye any of 16 coats (consume 1), natural coats
   weighted (82% white ... 1% pink), colored wool drops. Verified live:
   shear 3 wool + bare, dye white->red, regrow on real grass, coat spread.
   Vine/leaf shear drops covered above.
 - [DONE 2026-10-27] Minecarts + rails: all 5 cart variants (ride/chest/
  furnace/tnt/hopper, 24-cap code-reviewed) on auto-shaped rails (plain +
  powered + detector + activator, slopes + curves, place + break reshape).
  Verified live (Realm survtest): place E-W + consume, curve/slope
  formation, real-click mount (rider snap) + sneak dismount, roll/coast/
  derail/ground-rest, slope roll-down + grade-following, detector flip +
  neighbor power mirror both directions, powered kick (1.2) + accel
  (5/s^2, 8 cap) + unpowered brake, furnace fuel-by-coal-click (consume 1,
  +1800, pushed away from the stoker, burns on/off rail, self-propels
  3/s^2), chest UI open (native 27-slot window) + contents persist across
  reload, hopper suck (1.2-block radius, 5 slots), 2-punch cart break
  (wobble, then variant item + chest spill), rail break drops (rail item)
  + empty-bbox drop fix (rails/torches/flowers/crops now drop — the shared
  dropIdForState path was gated on non-empty bbox), curve riding BOTH
  directions (momentum seeded through turns; fixed dead entry detection +
  furnace kick fighting the exit), activator eject (rider) + TNT ignite
  (fuse/boom/crater are Tier-0-verified paths; one live blast ate 3 test
  rails — vanilla-correct), CART_REST=0.3 screenshot (cart sits exactly on
  track), save/reload restore (pos/variant/fuel/contents). Fixed in
  passing: derailed carts never released their detector (stale ON +
  powered neighbors forever); load sweep clears stale-ON detectors AND
  refreshes neighbors; furnace burns fuel off-rail too. Test hooks:
  `tick(n)` (deterministic master ticks — background-tab throttle makes
  wall-clock waits useless) + `cart/cmount/cride/carts`. Caveats: 24-cap
  never hit live (6 lines, code-read); test litter remains in survtest
  (harmless); crash-break loot is engine-side.
 - [DONE 2026-10-27] Horses/donkeys/mules/llamas: tame (mount attempts raise
   temper to a per-horse 20-100 max, buck throws until tame) + feed
   (sugar/apple/wheat small, golden big; wheat+hay for llamas; feeding heals
   + grows foals 10% off) + ride (tamed + saddled steering from live input,
   5-9 b/s random per horse, space hop incl. standstill, llamas unsteerable)
   + armor (iron 5 / gold 7 / diamond 11 pts through the 1.9+ formula) +
   chests (donkey/mule 15 + llama 3-per-strength validated EntityHorse
   window: slot 0 saddle-only, slot 1 armor-only, invalid stacks bounce to
   the player; save runs inside on_close_window because game().window is
   already null by the next masterTick) + breed (golden foods on tamed
   adults, horse+horse / donkey+donkey / llama+llama + horse+donkey=mule,
   mules sterile, 20-min foals with engine .child flag, 5-min cooldown,
   1-7 XP) + herd spawns (plains herds 2-4, mixed species) + punch damage
   (hit cooldown, horses flee / llamas spit 1 dmg back within 16 blocks,
   own seat unhittable) + death (leather 0-2 + saddle/armor/chest pop +
   storage spill + XP) + persist/restore (stats/tack/contents, 20-cap).
   Verified live (Realm survtest): wander + body-yaw writeback, feed
   temper/heal/consume, 4-mount tame, sneak tack window + saddle/iron-armor
   equip, ridden steering 18.8 blocks/30 ticks + standstill hop, sneak
   dismount, fist 1 + sword-vs-armor soak (iron 2/hit, diamond 7->5),
   donkey 17-slot window + storage save, love->foal (child flag, growth to
   adult), mule cross + sterility, llama spit 20->19 + caravan trail,
   leather/gear/XP drops, save->reload restore (saddle/gold-armor/hp +
   chest contents [[513,7],[476,2]]). Test hooks: horse/hmount/hdismount/
   hride/horses/huse + egg routing (4 horse eggs). Caveats: engine renders
   horse models natively (spawnMob types); foal/baby visuals follow the
   .child hook (pixel screenshots inconclusive — hidden tab serves frozen
   frames); bred foals are born tame (chosen interpretation); llama spit
   hits the player directly (mob-attacker retaliation noted as gap).
 - [DONE 2026-10-27] Crops/stems: hoe dirt/grass->farmland (coarse dirt->dirt,
   1 durability, till sound), plant seeds/carrot/potato on farmland + cane on
   sand/dirt/grass/podzol near water + cactus on sand (validated cells,
   consume 1), 1 Hz watch-set sim (blocks persist as world diffs; SV.crops
   rebuilt by the setState wrapper, 1200-cap). Growth: 8/8/8/4 stages at
   ~17 min hydrated / ~70 min dry (moisture 0-7 from 4-block water sense,
   dry+bare reverts slowly, planted dry stays), light 9+ gate (sky+block),
   mature stems fruit onto adjacent dirt/grass/farmland then attach
   (N/S/W/E facing order), unattach on harvest, cane/cactus age 0-15 grow
   to 3 high, cactus pops when boxed + pricks player/mobs/horses (1 dmg),
   bone meal +2..5 (beetroot +1, stems +1..2, mature refused) and grass->
   tufts/flowers, trample on landing (fall>0.75 reverts + pops crop with
   loot), age-aware harvest (mature wheat 1+seeds, carrots 1-4, potatoes
   1-4+2% poison, beetroot 1+seeds, stems 0-3 seeds, melon 3-7 slices,
   farmland->dirt). Verified live (Realm survtest): real-path till+plant
   (all 5 seed kinds, consume), hydration to 7, growth ticks, bone meal
   +5/capped/consumed/refused + grass scatter (8 plants, consume 1),
   carrot harvest 2, potato/beet/wheat/stem tallies, mob-landing trample
   (soil->dirt + pop), stem fruit/attach/unattach/re-fruit, cane 2-high,
   cactus player/mob pricks, dry revert, farmland->dirt. Test hooks:
   till/sow/boneAt/crops + rescan. Post-entry tracking fix: game.reset()
   swaps the world object so the one-time setState wrapper died with it —
   ensureWorldHook() re-wraps any bare world (boot + 1s watcher), entry
   rescans SP.overrides into the watch-set, cropTick skips unloaded chunks
   (they read as air) instead of pruning. Fixed in passing: mob + HORSE FALL DAMAGE NEVER
   FIRED — both landing branches tested takeoff (m.ground && !res.ground)
   instead of landing, so peakY was set but never consumed except via
   flicker; now !m.ground && res.ground (player envTick was already
   correct). Caveats: player-trample/fall path is mob-tested (player
   physics frozen in hidden tabs — same class as jump/fall notes);
   bone-meal saplings refused (no tree builder); no cocoa/nether-wart/
   berries/kelp (no jungle/nether/water-planting); sweet berries are 1.14.
 - [ ] Villages + villagers + trading + iron-golem-by-village + raids?
   Biggest Tier-1 chunk: needs structure gen + villager AI + trade UI.

 ## Tier 2 — functional blocks / gear (custom screens like furnace/chest)
 - [DONE 2026-10-29 in v1.1.0] Enchanting table (XP + lapis + random
   enchants): native window + survival server half, verified live.
 - [DONE 2026-10-29 in v1.2.0] Anvil (repair + combine + rename, XP costs):
    native window + survival server half (anvCompute mirrors
    ContainerRepair: unit repair at 25%-per-material, durability combine +
    12%, book-halved rarity-weighted enchant merge with same-level bump +
    incompat +1s, rename/clear for 1, prior-work penalties doubling per
    real job, 40-level "Too expensive!" cap in survival, XP-level deduct,
    creative free + no wear, input consume on take, 12% wear per use
    across intact/chipped/damaged blocks then break). Verified live:
    rename 1 level, unit repair 1000->610 for 3 diamonds, sharp3+sharp3 ->
    sharp4 at 6 levels with RepairCost 1, book apply halved, incompat
    +1 / full-reject empty, 64-level combine empty in survival but open in
    creative (free take), intact->chipped->break with chat, range close,
    cursor-occupied + number-key + drop-key swallows, custom name +
    RepairCost across save/reload. Zero console errors.
 - [DONE 2026-10-29 in v1.3.0] Brewing stand + full JE potion table +
   glass bottles + fuel: tile-backed native window (furnace tile
   precedent — keeps brewing with the UI closed, persists fuel/time/ing
   across reloads). Recipe table mirrors PotionBrewing 1:1 (awkward +
   13 bases, redstone/glowstone/fermented lines, gunpowder->splash,
   breath->lingering, 20-fuels-per-powder, 400-tick batches, swap/yank
   cancels, in-flight finishes on empty fuel, no-fuel never starts).
   Bottle fill from water sources; wart via fortress gardens + planting
   (v1.15.0 — stronghold chest was the pre-fortress bridge), breath via
   dragon kill (v1.16.0). Verified live: fill->water bottle, wart->awkward
   x3, sugar/redstone/glowstone/fermented/splash/lingering chains at NBT
   level, fuel math, cancel paths, close-persist, save->reload tile
   restore + completion. Zero console errors.
 - [DONE 2026-10-29 in v1.4.0] Blast furnace + smoker (2x cook, JE input gates, 2x fuel burn, lit states, banked XP) + barrel (27 slots) + grindstone (merge +5% / strip-to-curses + XP, books come back plain) + stonecutter (full JE 1.15 list, slabs x2) + composter (JE fill chances, bone meal on full) + bell (ring + villager startle). All verified live (windows, gates, exact durability math, XP, persist + cross-reload, lit on/off, range-close + salvage). Zero console errors.
 - [ ] Hopper/dispenser/dropper (item movement/shooting), observer/piston/
   sticky (push), redstone wire/torch/repeater/comparator (signal sim).
 - [ ] Beacon/conduit (area buffs), jukebox/note-blocks, beds in Nether?
   (no Nether yet — see Tier 3).
 - [ ] Maps/clocks/compass behavior, leads, banners/shields patterns?
   Shields exist; patterns need loom? 1.13 has loom? No (1.14). Craft only.

 ## Tier 3 — dimensions / structures / bosses (largest)
 - [ ] Nether (portal, dimension, quartz/glowstone/soulsand, pigmen/ghasts/
   blazes/fortresses). Engine dimension field exists (world.dimension).
 - [DONE 2026-11-04 in v1.16.0] End (portal, dragon fight, kill-gated fountain/gateways, elytra flight, chorus, cities/shulkers, breath source).
 - [ ] Structures: dungeons/mineshafts/temples/witch-huts/monuments/
   mansions/shipwrecks/villages in worldgen.
 - [ ] Bosses: Wither summon + fight, Ender Dragon fight, ocean monument
   elder guardian.
 - [ ] Advancements/statistics/recipe unlock progression (cosmetic-ish).
 - [ ] Hardcore mode, spectator, demo? Likely skip.

 ## Deliberately out (not vanilla 1:1, do not build for parity)
 - Voice chat, Realms extras, Terralith/Skyblock types, packs
   UI, touch HUD — all ours, keep but don't confuse with vanilla.
