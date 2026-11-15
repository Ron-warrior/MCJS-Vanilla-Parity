import { tr } from '../gui/i18n.js';
// Sound engine: vanilla sounds.json (+ resource packs), played through the platform audio interface.
import { getBlock, getBlockById, getStateProperties } from '../world/blocks.js';
import { platform } from '../platform/platform.js';

// P4 streaming audio: the 28 long tracks (>600KB: new menu/game music,
// nether music, otherside/pigstep/5 discs, nether ambient beds/particles) are
// NOT in the assets zips — decodeAudioData would expand a 17MB ogg to ~180MB
// PCM and buffers cache forever. They are hosted (see upload URLs below) and
// streamed with HTMLAudio instead of WebAudio. Rebuild recipe: upload the 28
// files from scratch/1194-native/res/minecraft/sounds/ and refresh this map;
// the engine-side trigger code needs no other asset changes (sounds.json in
// the zip is the native 1.19 one, so stream:true flags resolve here).
const STREAM_URLS = {
  'music/game/wending': 'https://user.uploads.dev/file/c89a586f6e97f5d6a00c8476db5155c7.ogg',
  'music/game/left_to_bloom': 'https://user.uploads.dev/file/439b98f3e1e1c8679284b75bb56a02fb.ogg',
  'music/game/stand_tall': 'https://user.uploads.dev/file/57c0b8ea86f2074e0ad5efa0dac0f67b.ogg',
  'music/game/an_ordinary_day': 'https://user.uploads.dev/file/eec8c6752d2eb3a399a467f35752e9e7.ogg',
  'music/game/one_more_day': 'https://user.uploads.dev/file/5bd338bdec9392d70887171ad8ea823d.ogg',
  'music/game/infinite_amethyst': 'https://user.uploads.dev/file/0f31fd340b1932b940972e33078f3bc8.ogg',
  'music/game/comforting_memories': 'https://user.uploads.dev/file/edcb45ebeeff2923e3d4892fc4a4d6b9.ogg',
  'music/game/floating_dream': 'https://user.uploads.dev/file/b9c3db66ea0ebca5b97db35f2139dc95.ogg',
  'music/game/nether/soulsand_valley/so_below': 'https://user.uploads.dev/file/22e7d521918f94f9b621d6d56f3a376b.ogg',
  'music/game/nether/crimson_forest/chrysopoeia': 'https://user.uploads.dev/file/af53201b849b914b9ca51f4805997fde.ogg',
  'music/game/nether/nether_wastes/rubedo': 'https://user.uploads.dev/file/7ffca92368c2b11a24c302b024709d8f.ogg',
  'records/otherside': 'https://user.uploads.dev/file/491657ab492eb76598ccb815ae16d578.ogg',
  'records/pigstep': 'https://user.uploads.dev/file/7be89c4a047e2e2714df3e7101320a82.ogg',
  'ambient/nether/soulsand_valley/ambience': 'https://user.uploads.dev/file/0ebe8700fcd9b51e9f7582152bc5602d.ogg',
  'ambient/nether/basalt_deltas/ambience': 'https://user.uploads.dev/file/07755acf99b37417d423782423af85aa.ogg',
  'ambient/nether/warped_forest/ambience': 'https://user.uploads.dev/file/c113518238110c017be89b0c9abfeaea.ogg',
  'ambient/nether/crimson_forest/ambience': 'https://user.uploads.dev/file/c472e0b36bd809358fbc440611f1a6ea.ogg',
  'ambient/nether/nether_wastes/ambience': 'https://user.uploads.dev/file/6c7d960a1be384a98f2a37fc912b98f2.ogg',
  'ambient/nether/crimson_forest/particles1': 'https://user.uploads.dev/file/6a0a507dc6541f93bab79e3b97f7c361.ogg',
  'ambient/nether/crimson_forest/particles2': 'https://user.uploads.dev/file/bccac009cdf4eece1531a0a94a01167e.ogg',
  'ambient/nether/crimson_forest/particles3': 'https://user.uploads.dev/file/04955c36f0668efabae11a48c2a4c8ce.ogg',
  'ambient/nether/basalt_deltas/debris2': 'https://user.uploads.dev/file/f53ea976b927ae2ab3f418d0a08a6926.ogg',
  'ambient/nether/basalt_deltas/debris3': 'https://user.uploads.dev/file/8b71c8fcee9d54f2a445cc4e9d00b6f8.ogg',
  'music/game/ancestry': 'https://user.uploads.dev/file/05a1ad036d3abeb29028dc53c0da14f1.ogg',
  'music/game/swamp/labyrinthine': 'https://user.uploads.dev/file/1d5a1b98191a73f7644a0670e8b8c650.ogg',
  'music/game/swamp/firebugs': 'https://user.uploads.dev/file/028d7603fc50e27c75e0a57c87e3564b.ogg',
  'music/game/swamp/aerie': 'https://user.uploads.dev/file/ccb7bd12e7f165b395f8fc093c44c22d.ogg',
  'records/5': 'https://user.uploads.dev/file/e3cbc15e4fb773f8d950c5fd6e72892c.ogg',
};

// SoundType (1.9+): [step, break, place, volume, pitch, hit, fall]
const T = (k, vol = 1, pitch = 1) => [`block.${k}.step`, `block.${k}.break`, `block.${k}.place`, vol, pitch, `block.${k}.hit`, `block.${k}.fall`];
const SOUND_TYPES = {
  stone: T('stone'), wood: T('wood'), gravel: T('gravel'), grass: T('grass'), metal: T('metal', 1, 1.5), glass: T('glass'),
  cloth: T('cloth'), sand: T('sand'), snow: T('snow'), ladder: T('ladder'), slime: T('slime'),
  anvil: ['block.anvil.step', 'block.anvil.break', 'block.anvil.place', 0.3, 1, 'block.anvil.hit', 'block.anvil.fall'],
};

function soundTypeOf(b) {
  if (!b) return SOUND_TYPES.stone;
  if (b.soundType) return b.soundType;
  const n = b.name;
  if (n === 'slime') return SOUND_TYPES.slime;
  if (n === 'anvil') return SOUND_TYPES.anvil;
  if (n === 'ladder') return SOUND_TYPES.ladder;
  if (/glass|^ice$|frosted_ice|packed_ice|glowstone|beacon|sea_lantern|redstone_lamp|portal|end_gateway/.test(n)) return SOUND_TYPES.glass;
  if (/wool|carpet|cactus|cake/.test(n)) return SOUND_TYPES.cloth;
  if (/^sand$|soul_sand|concrete_powder/.test(n)) return SOUND_TYPES.sand;
  if (/snow/.test(n)) return SOUND_TYPES.snow;
  if (/gravel|^dirt$|coarse_dirt|podzol|farmland|^clay$|dirt_path/.test(n)) return SOUND_TYPES.gravel;
  if (/^grass$|^grass_block$|mycelium|leaves|sapling|tallgrass|deadbush|dead_bush|flower|vine|reeds|sugar_cane|waterlily|lily_pad|hay_block|^tnt$|sponge|double_plant|wheat|carrots|potatoes|beetroots|nether_wart$|stem|mushroom$|cocoa/.test(n)) return SOUND_TYPES.grass;
  if (/iron|gold_block|diamond_block|emerald_block|lapis_block|redstone_block|rail|hopper|cauldron|brewing_stand|command_block|structure_block/.test(n) && !/ore$/.test(n)) return SOUND_TYPES.metal;
  if (b.material === 'wood' || /pumpkin|melon_block|bookshelf|chest|crafting|jukebox|note_block|noteblock|sign|_door|fence|trapdoor|log|planks|chorus/.test(n)) return SOUND_TYPES.wood;
  if (b.material === 'plant' || b.material === 'leaves') return SOUND_TYPES.grass;
  if (b.material === 'dirt') return SOUND_TYPES.gravel;
  if (b.material === 'wool') return SOUND_TYPES.cloth;
  return SOUND_TYPES.stone;
}

// Canonical identities, not native wire IDs or internal renderer family numbers.
const E = (k) => [`entity.${k}.hurt`, `entity.${k}.death`];
const SOUND_ALIASES = { cave_spider: 'spider', giant: 'hostile', mooshroom: 'cow', ocelot: 'cat', pufferfish: 'puffer_fish' };
const HOSTILE_TYPES = new Set(('elder_guardian wither_skeleton stray husk zombie_villager evoker vex vindicator illusioner '
  + 'creeper skeleton spider giant zombie slime ghast zombie_pigman enderman cave_spider silverfish blaze magma_cube '
  + 'ender_dragon wither witch endermite guardian shulker drowned phantom').split(' '));

// SPacketSoundEffect category ids
const CATEGORIES = ['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice'];

// 1.13.2's protocol SoundEvent registry still contains several pre-flattening
// names, while the resource-pack sounds.json uses the flattened asset names.
const SOUND_EVENT_PREFIX_ALIASES = [
  ['block.cloth.', 'block.wool.'],
  ['block.enderchest.', 'block.ender_chest.'],
  ['block.metal_pressureplate.', 'block.metal_pressure_plate.'],
  ['block.note.', 'block.note_block.'],
  ['block.slime.', 'block.slime_block.'],
  ['block.stone_pressureplate.', 'block.stone_pressure_plate.'],
  ['block.waterlily.', 'block.lily_pad.'],
  ['block.wood_button.', 'block.wooden_button.'],
  ['block.wood_pressureplate.', 'block.wooden_pressure_plate.'],
  ['entity.armorstand.', 'entity.armor_stand.'],
  ['entity.bobber.', 'entity.fishing_bobber.'],
  ['entity.enderdragon_fireball.', 'entity.dragon_fireball.'],
  ['entity.enderdragon.', 'entity.ender_dragon.'],
  ['entity.endereye.', 'entity.ender_eye.'],
  ['entity.endermen.', 'entity.enderman.'],
  ['entity.enderpearl.', 'entity.ender_pearl.'],
  ['entity.evocation_fangs.', 'entity.evoker_fangs.'],
  ['entity.evocation_illager.', 'entity.evoker.'],
  ['entity.firework.', 'entity.firework_rocket.'],
  ['entity.illusion_illager.', 'entity.illusioner.'],
  ['entity.irongolem.', 'entity.iron_golem.'],
  ['entity.itemframe.', 'entity.item_frame.'],
  ['entity.leashknot.', 'entity.leash_knot.'],
  ['entity.lightning.', 'entity.lightning_bolt.'],
  ['entity.lingeringpotion.', 'entity.lingering_potion.'],
  ['entity.magmacube.', 'entity.magma_cube.'],
  ['entity.parrot.imitate.enderdragon', 'entity.parrot.imitate.ender_dragon'],
  ['entity.parrot.imitate.evocation_illager', 'entity.parrot.imitate.evoker'],
  ['entity.parrot.imitate.illusion_illager', 'entity.parrot.imitate.illusioner'],
  ['entity.parrot.imitate.magmacube', 'entity.parrot.imitate.magma_cube'],
  ['entity.parrot.imitate.vindication_illager', 'entity.parrot.imitate.vindicator'],
  ['entity.snowman.', 'entity.snow_golem.'],
  ['entity.vindication_illager.', 'entity.vindicator.'],
  ['entity.zombie_pig.', 'entity.zombie_pigman.'],
  ['record.', 'music_disc.'],
];

const SOUND_EVENT_ALIASES = new Map([
  ['entity.polar_bear.baby_ambient', 'entity.polar_bear.ambient_baby'],
  ['entity.villager.trading', 'entity.villager.trade'],
  ['entity.zombie.attack_door_wood', 'entity.zombie.attack_wooden_door'],
  ['entity.zombie.break_door_wood', 'entity.zombie.break_wooden_door'],
]);

function soundAssetName(name) {
  let n = String(name || '').replace(/^minecraft:/, '');
  if (SOUND_EVENT_ALIASES.has(n)) return SOUND_EVENT_ALIASES.get(n);
  const small = n.match(/^entity\.(small_(?:slime|magmacube))\.(death|hurt|jump|squish)$/);
  if (small) return `entity.${small[1] === 'small_slime' ? 'slime' : 'magma_cube'}.${small[2]}_small`;
  for (const [from, to] of SOUND_EVENT_PREFIX_ALIASES) if (n.startsWith(from)) return to + n.slice(from.length);
  return n;
}

// Category for client-played sounds without one: by the event name
const CATEGORY_OF = (name) => {
  if (name.startsWith('music.')) return 'music';
  if (name.startsWith('record.')) return 'record';
  if (name.startsWith('weather.')) return 'weather';
  if (name.startsWith('block.')) return 'block';
  if (name.startsWith('entity.player.')) return 'player';
  if (/^entity\.(zombie|husk|skeleton|stray|wither|spider|creeper|blaze|ghast|enderman|endermite|slime|small_slime|magma_cube|small_magma_cube|silverfish|witch|ender_dragon|guardian|elder_guardian|shulker|vex|evoker|vindicator|illusioner|zombie_pigman|zombie_villager|hostile|phantom|drowned)/.test(name)) return 'hostile';
  if (name.startsWith('entity.')) return 'neutral';
  if (name.startsWith('ambient.')) return 'ambient';
  return 'master';
};

// RenderGlobal.playEvent sounds: id -> [event, volume, pitch(rand)]
const r = Math.random;
const EVENT_SOUNDS = {
  1000: ['block.dispenser.dispense', 1, () => 1], 1001: ['block.dispenser.fail', 1, () => 1.2],
  1002: ['block.dispenser.launch', 1, () => 1.2], 1003: ['entity.endereye.launch', 1, () => 1.2],
  1004: ['entity.firework.shoot', 1, () => 1.2],
  1005: ['block.iron_door.open', 1, () => r() * 0.1 + 0.9], 1006: ['block.wooden_door.open', 1, () => r() * 0.1 + 0.9],
  1007: ['block.wooden_trapdoor.open', 1, () => r() * 0.1 + 0.9], 1008: ['block.fence_gate.open', 1, () => r() * 0.1 + 0.9],
  1009: ['block.fire.extinguish', 0.5, () => 2.6 + (r() - r()) * 0.8],
  1011: ['block.iron_door.close', 1, () => r() * 0.1 + 0.9], 1012: ['block.wooden_door.close', 1, () => r() * 0.1 + 0.9],
  1013: ['block.wooden_trapdoor.close', 1, () => r() * 0.1 + 0.9], 1014: ['block.fence_gate.close', 1, () => r() * 0.1 + 0.9],
  1015: ['entity.ghast.warn', 10, () => (r() - r()) * 0.2 + 1], 1016: ['entity.ghast.shoot', 10, () => (r() - r()) * 0.2 + 1],
  1017: ['entity.enderdragon.shoot', 10, () => (r() - r()) * 0.2 + 1], 1018: ['entity.blaze.shoot', 2, () => (r() - r()) * 0.2 + 1],
  1019: ['entity.zombie.attack_door_wood', 2, () => (r() - r()) * 0.2 + 1], 1020: ['entity.zombie.attack_iron_door', 2, () => (r() - r()) * 0.2 + 1],
  1021: ['entity.zombie.break_door_wood', 2, () => (r() - r()) * 0.2 + 1], 1022: ['entity.wither.break_block', 2, () => (r() - r()) * 0.2 + 1],
  1024: ['entity.wither.shoot', 2, () => (r() - r()) * 0.2 + 1], 1025: ['entity.bat.takeoff', 0.05, () => (r() - r()) * 0.2 + 1],
  1026: ['entity.zombie.infect', 2, () => (r() - r()) * 0.2 + 1], 1027: ['entity.zombie_villager.converted', 2, () => (r() - r()) * 0.2 + 1],
  1029: ['block.anvil.destroy', 1, () => r() * 0.1 + 0.9], 1030: ['block.anvil.use', 1, () => r() * 0.1 + 0.9],
  1031: ['block.anvil.land', 0.3, () => r() * 0.1 + 0.9], 1033: ['block.chorus_flower.grow', 1, () => 1],
  1034: ['block.chorus_flower.death', 1, () => 1], 1035: ['block.brewing_stand.brew', 1, () => 1],
  1036: ['block.iron_trapdoor.close', 1, () => r() * 0.1 + 0.9], 1037: ['block.iron_trapdoor.open', 1, () => r() * 0.1 + 0.9],
  2002: ['entity.splash_potion.break', 1, () => r() * 0.1 + 0.9], 2007: ['entity.splash_potion.break', 1, () => r() * 0.1 + 0.9],
};
// RenderGlobal.broadcastSound (heard from anywhere)
const GLOBAL_EVENTS = { 1023: 'entity.wither.spawn', 1028: 'entity.enderdragon.death', 1038: 'block.end_portal.spawn' };

export class SoundManager {
  constructor(game) {
    this.game = game;
    this.audio = platform().createAudio();
    this.defs = null;
    this.buffers = new Map();
    this.playing = new Set();
    this.musicTimer = 100;
    this.music = null;
    this.reload();
  }

  // (Re)load sound definitions, e.g. after resource packs change
  reload() {
    this.stopAll();
    this.buffers.clear();
    this.game.assets.loadSoundDefinitions().then((d) => { this.defs = d; }).catch(() => { this.defs = {}; });
  }

  // SoundHandler.playSound -> GuiSubtitleOverlay: events with a "subtitle" in sounds.json (global sounds at the player)
  _subtitle(name, x, y, z, opts) {
    const g = this.game;
    const d = this.defs && this.defs[name];
    if (!d || !d.subtitle || !g.settings.showSubtitles || !g.inWorld || !g.hud.addSubtitle) return;
    const p = g.player;
    if (opts.global || x === undefined) g.hud.addSubtitle(tr(d.subtitle), p.x, p.y, p.z);
    else g.hud.addSubtitle(tr(d.subtitle), x, y, z);
  }

  volumeFor(cat) {
    const s = this.game.settings;
    const v = cat === 'master' ? 1 : (s.soundVolumes[cat] !== undefined ? s.soundVolumes[cat] : 1);
    return s.masterVolume * v;
  }

  _weight(name, seen = new Set()) {
    name = soundAssetName(name);
    if (seen.has(name)) return 0;
    const next = new Set(seen).add(name);
    return (this.defs?.[name]?.sounds || []).reduce((sum, raw) => {
      const e = typeof raw === 'string' ? { name: raw } : raw;
      return sum + (e.type === 'event' ? this._weight(e.name, next) : e.weight ?? 1);
    }, 0);
  }

  _pick(name, seen = new Set()) {
    name = soundAssetName(name);
    if (seen.has(name)) return null;
    const entries = this.defs?.[name]?.sounds;
    if (!entries?.length) return null;
    const next = new Set(seen).add(name), weighted = entries.map(raw => {
      const e = typeof raw === 'string' ? { name: raw } : raw;
      return [e, e.type === 'event' ? this._weight(e.name, next) : e.weight ?? 1];
    });
    const total = weighted.reduce((sum, [, weight]) => sum + weight, 0);
    if (!total) return null;
    let choice = Math.random() * total, pick;
    for (const [entry, weight] of weighted) { choice -= weight; if (choice < 0) { pick = entry; break; } }
    if (!pick) return null;
    if (pick.type === 'event') {
      const sound = this._pick(pick.name, next);
      return sound ? { ...sound, volume: sound.volume * (pick.volume ?? 1), pitch: sound.pitch * (pick.pitch ?? 1), stream: sound.stream || !!pick.stream } : null;
    }
    return { file: pick.name, volume: pick.volume ?? 1, pitch: pick.pitch ?? 1, stream: !!pick.stream };
  }

  async _buffer(file) {
    let b = this.buffers.get(file);
    if (b) return b;
    b = this.game.assets.readSound(file + '.ogg').then((bytes) => (bytes ? this.audio.decode(bytes) : null)).catch(() => null);
    this.buffers.set(file, b);
    return b;
  }

  // Streamed voice for the hosted long tracks: an HTMLAudioElement with the
  // WebAudio-compatible voice shape ({stop, ended, setVolume, setPitch,
  // setPosition}). No positional panning — distance attenuation is baked at
  // start. Autoplay-blocked plays report ended so tickers retry or advance
  // instead of hanging on a dead voice.
  _playStream(def, opts = {}) {
    const url = STREAM_URLS[def.file];
    if (!url) return null;
    try {
      const el = new Audio();
      // attached (hidden): detached media elements risk GC pauses, and it
      // makes the active streams inspectable
      try { el.style.display = 'none'; document.body.appendChild(el); } catch (e) {}
      const unmount = () => { try { document.body.removeChild(el); } catch (e) {} };
      el.src = url;
      el.preload = 'auto';
      el.loop = !!opts.loop;
      let vol = opts.volume === undefined ? 1 : opts.volume;
      vol *= def.volume ?? 1;
      if (opts.pos) {
        try {
          const p = this.game.player;
          const dx = p.x - opts.pos[0], dy = p.y - opts.pos[1], dz = p.z - opts.pos[2];
          vol *= Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(1, opts.maxDistance || 16));
        } catch (e) {}
      }
      el.volume = Math.max(0, Math.min(1, vol));
      if (opts.pitch && opts.pitch !== 1) { try { el.playbackRate = Math.max(0.5, Math.min(2, opts.pitch)); } catch (e) {} }
      const voice = {
        stop: () => { try { el.pause(); } catch (e) {} try { el.removeAttribute('src'); el.load(); } catch (e) {} unmount(); },
        ended: false,
        setVolume: (v) => { try { el.volume = Math.max(0, Math.min(1, v)); } catch (e) {} },
        setPitch: (v) => { try { el.playbackRate = Math.max(0.5, Math.min(2, v)); } catch (e) {} },
        setPosition: () => {},
      };
      const done = () => { voice.ended = true; unmount(); if (opts.onEnd) { try { opts.onEnd(); } catch (e) {} } };
      el.onended = done;
      el.onerror = done;
      const pr = el.play();
      if (pr && pr.catch) pr.catch(done);
      return voice;
    } catch (e) { return null; }
  }

  // Positional sound at world coordinates. opts: { global, category (name or SPacketSoundEffect id) }
  async play(name, x, y, z, volume = 1, pitch = 1, opts = {}) {
    if (!this.audio) return null;
    const assetName = soundAssetName(name);
    const def = this._pick(assetName);
    if (!def) return null;
    this._subtitle(assetName, x, y, z, opts);
    const cat = typeof opts.category === 'number' ? CATEGORIES[opts.category] || 'master' : opts.category || CATEGORY_OF(assetName);
    const catVol = this.volumeFor(cat);
    if (catVol <= 0) return null;
    const generation = this.generation;
    if (def.stream && STREAM_URLS[def.file]) {
      const voice = this._playStream(def, {
        volume: Math.min(1, volume) * catVol,
        pitch: Math.max(0.5, Math.min(2, pitch * def.pitch)),
        pos: !opts.global && x !== undefined ? [x, y, z] : null,
        maxDistance: Math.max(16, volume * 16),
        onEnd: () => { this.playing.delete(handle); if (handle.onEnd) handle.onEnd(); },
      });
      if (!voice || generation !== this.generation) { if (voice) voice.stop(); return null; }
      const handle = { name: assetName, category: cat, onEnd: null, entity: opts.entity };
      handle.voice = voice;
      this.playing.add(handle);
      return handle;
    }
    const buf = await this._buffer(def.file);
    if (!buf || generation !== this.generation) return null;
    const handle = { name: assetName, category: cat, onEnd: null, entity:opts.entity };
    const voice = this.audio.play(buf, {
      volume: Math.min(1, volume) * def.volume * catVol,
      pitch: Math.max(0.5, Math.min(2, pitch * def.pitch)),
      pos: !opts.global && x !== undefined ? [x, y, z] : null,
      maxDistance: Math.max(16, volume * 16),
      onEnd: () => { this.playing.delete(handle); if (handle.onEnd) handle.onEnd(); },
    });
    if (!voice) return null;
    handle.voice = voice;
    this.playing.add(handle);
    return handle;
  }

  playAtPlayer(name, volume = 1, pitch = 1) {
    return this.play(name, 0, 0, 0, volume, pitch, { global: true });
  }

  playUi(name, pitch = 1) { return this.play(name, 0, 0, 0, 0.25, pitch, { global: true, category: 'master' }); }

  // Explosion.finalizeExplosion: the explosion packet owns this client-local sound.
  playExplosion(x, y, z) {
    return this.play('entity.generic.explode', x, y, z, 4, (1 + (Math.random() - Math.random()) * .2) * .7, { category: 'block' });
  }

  // SoundHandler.stop (/stopsound): sounds of one category and/or one sound event; neither stops everything
  stop(sound, category) {
    if (!category && !sound) { this.stopAll(); return; }
    const id = (s) => String(s).toLowerCase().replace(/^minecraft:/, '');
    const want = sound ? id(soundAssetName(sound)) : null;
    for (const h of [...this.playing]) {
      if (category && h.category !== category) continue;
      if (want && id(soundAssetName(h.name)) !== want) continue;
      if (h.stop) h.stop(); else h.voice.stop();
      this.playing.delete(h);
    }
  }

  stopAll() {
    this.generation = (this.generation || 0) + 1;
    for (const h of this.playing) h.voice.stop();
    this.playing.clear();
    if (this.music) { this.music.voice.stop(); this.music = null; }
    if (this.netherLoop) { try { this.netherLoop.stop(); } catch (e) {} this.netherLoop = null; }
    this.netherPending = false;
  }

  // Footsteps (Entity.playStepSound)
  // Entity.playStepSound: block below (snow layer on top wins), volume * 0.15, played at the entity's feet
  playStep(x, y, z, state, at = null) {
    let b = getBlock(state);
    const above = getBlock(this.game.world.getState(x, y + 1, z));
    if (above && (above.name === 'snow_layer')) b = above;
    if (!b || b.id === 0 || b.isLiquid) return;
    const st = soundTypeOf(b);
    const p = at || [x + 0.5, y + 0.5, z + 0.5];
    this.play(st[0], p[0], p[1], p[2], st[3] * 0.15, st[4], { category: this._entityCategory() });
  }

  // Entity.getSoundCategory of the local player
  _entityCategory() { return 'player'; }

  // EntityLivingBase.fall (client side for the local player): fall thud, then the landing block's fall sound
  playFall(damage, x, y, z, state) {
    this.play(damage > 4 ? 'entity.player.big_fall' : 'entity.player.small_fall', x, y, z, 1, 1, { category: 'player' });
    const b = getBlock(state);
    if (b && b.id !== 0) {
      const st = soundTypeOf(b);
      this.play(st[6], x, y, z, st[3] * 0.5, st[4] * 0.75, { category: 'player' });
    }
  }

  // Looping sound whose volume / position the caller updates every tick (vanilla ITickableSound)
  async playLoop(name, x, y, z, opts = {}) {
    if (!this.audio) return null;
    const def = this._pick(name);
    if (!def) return null;
    const cat = opts.category || CATEGORY_OF(name);
    const generation = this.generation;
    if (def.stream && STREAM_URLS[def.file]) {
      const voice = this._playStream(def, { volume: 0, pitch: def.pitch, pos: opts.global ? null : [x, y, z], maxDistance: 16, loop: true });
      if (!voice || generation !== this.generation) { if (voice) voice.stop(); return null; }
      const base = def.volume * this.volumeFor(cat);
      const handle = { name, category: cat, voice, base, stop: () => { voice.stop(); this.playing.delete(handle); }, setVolume: (v) => voice.setVolume && voice.setVolume(Math.min(1, v) * base), setPosition: (p) => voice.setPosition && voice.setPosition(p), setPitch: (v) => voice.setPitch?.(Math.max(0.5, Math.min(2, v * def.pitch))) };
      this.playing.add(handle);
      return handle;
    }
    const buf = await this._buffer(def.file);
    if (!buf || generation !== this.generation) return null;
    const base = def.volume * this.volumeFor(cat);
    const voice = this.audio.play(buf, { volume: 0, pitch: def.pitch, pos: opts.global ? null : [x, y, z], maxDistance: 16, loop: true });
    if (!voice) return null;
    const handle = { name, category: cat, voice, base, stop: () => { voice.stop(); this.playing.delete(handle); }, setVolume: (v) => voice.setVolume && voice.setVolume(Math.min(1, v) * base), setPosition: (p) => voice.setPosition && voice.setPosition(p), setPitch: (v) => voice.setPitch?.(Math.max(0.5, Math.min(2, v * def.pitch))) };
    this.playing.add(handle);
    return handle;
  }

  // PlayerControllerMP.onPlayerDamageBlock: the hit sound, NEUTRAL
  playBlockHit(x, y, z, state) {
    const st = soundTypeOf(getBlock(state));
    this.play(st[5], x + 0.5, y + 0.5, z + 0.5, (st[3] + 1) / 8, st[4] * 0.5, { category: 'neutral' });
  }

  playBlockBreak(x, y, z, state) {
    const st = soundTypeOf(getBlock(state));
    this.play(st[1], x + 0.5, y + 0.5, z + 0.5, (st[3] + 1) / 2, st[4] * 0.8, { category: 'block' });
  }

  playBlockPlace(x, y, z, state) {
    const st = soundTypeOf(getBlock(state));
    this.play(st[2], x + 0.5, y + 0.5, z + 0.5, (st[3] + 1) / 2, st[4] * 0.8, { category: 'block' });
  }

  // EntityLiving.getHurtSound / getDeathSound (handleStatusUpdate 2 / 3)
  _mobSounds(e) {
    const name = e.entityName;
    if (name === 'armor_stand') return ['entity.armor_stand.hit', 'entity.armor_stand.break'];
    if (name === 'slime' || name === 'magma_cube') return E(name).map(s => (e.size || 1) > 1 ? s : s + '_small');
    return E(SOUND_ALIASES[name] || name || 'generic');
  }

  _mobCategory(e) {
    if (e.kind === 'player') return 'player';
    return HOSTILE_TYPES.has(e.entityName) ? 'hostile' : 'neutral';
  }

  playEntityHurt(e) {
    if (e.silent) return;
    if (e.kind === 'player') { this.play('entity.player.hurt', e.x, e.y, e.z, 1, (Math.random() - Math.random()) * 0.2 + 1, { category: 'player' }); return; }
    const s = this._mobSounds(e);
    if (s && s[0]) this.play(s[0], e.x, e.y, e.z, 1, (Math.random() - Math.random()) * 0.2 + (e.child ? 1.5 : 1), { category: this._mobCategory(e) });
  }

  playEntityDeath(e) {
    if (e.silent) return;
    if (e.kind === 'player') { this.play('entity.player.death', e.x, e.y, e.z, 1, (Math.random() - Math.random()) * 0.2 + 1, { category: 'player' }); return; }
    const s = this._mobSounds(e);
    if (s && s[1]) this.play(s[1], e.x, e.y, e.z, 1, (Math.random() - Math.random()) * 0.2 + (e.child ? 1.5 : 1), { category: this._mobCategory(e) });
  }

  // WorldClient.playMoodSoundAndCheckLight: now and then a cave sound in a dark, sky-less air block nearby
  _moodTick() {
    const g = this.game, w = g.world;
    if (!g.inWorld) return;
    if (this.ambientCountdown === undefined) this.ambientCountdown = Math.floor(Math.random() * 12000);
    if (this.ambientCountdown > 0) { this.ambientCountdown--; return; }
    const rd = Math.min(g.settings.renderDistance, 7);
    const pcx = Math.floor(g.player.x) >> 4, pcz = Math.floor(g.player.z) >> 4;
    this.lcg = this.lcg === undefined ? (Math.random() * 0x7fffffff) | 0 : this.lcg;
    for (let n = 0; n < 10; n++) {
      const cx = pcx + Math.floor(Math.random() * (rd * 2 + 1)) - rd, cz = pcz + Math.floor(Math.random() * (rd * 2 + 1)) - rd;
      if (!w.isLoaded(cx << 4, cz << 4)) continue;
      this.lcg = (Math.imul(this.lcg, 3) + 1013904223) | 0;
      const i = this.lcg >> 2;
      const x = (cx << 4) + (i & 15), z = (cz << 4) + ((i >> 8) & 15), y = (i >> 16) & 255;
      if (w.getState(x, y, z) !== 0) continue;
      const light = Math.max(w.getSkyLight(x, y, z), w.getBlockLight(x, y, z));
      if (light <= Math.floor(Math.random() * 8) && w.getSkyLight(x, y, z) <= 0) {
        const dx = g.player.x - x - 0.5, dy = g.player.y - y - 0.5, dz = g.player.z - z - 0.5;
        if (dx * dx + dy * dy + dz * dz > 4) {
          this.play('ambient.cave', x + 0.5, y + 0.5, z + 0.5, 0.7, 0.8 + Math.random() * 0.2, { category: 'ambient' });
          this.ambientCountdown = Math.floor(Math.random() * 12000) + 6000;
          return;
        }
      }
    }
  }

  onBlockAction(p) {
    const b = getBlockById(p.blockId);
    if (!b) return;
    const { x, y, z } = p.location;
    if (b.name === 'note_block') {
      // Since 1.13 the event is 0/0; both values belong to the synchronized block state.
      const props=getStateProperties(this.game.world.getState(x,y,z)), inst=props.instrument||'harp', note=Number(props.note||0);
      const pitch = Math.pow(2, (note - 12) / 12);
      this.play('block.note_block.' + inst, x + 0.5, y + 0.5, z + 0.5, 3, pitch, { category: 'record' });
      this.game.particles.note && this.game.particles.note(x, y, z, note);
    } else if (b.name === 'piston' || b.name === 'sticky_piston') {
      this.play(p.byte1 === 0 ? 'block.piston.extend' : 'block.piston.contract', x + 0.5, y + 0.5, z + 0.5, 0.5, Math.random() * 0.25 + 0.6, { category: 'block' });
    }
  }

  // RenderGlobal.playEvent / broadcastSound (1.12 event ids)
  onWorldEvent(p) {
    const { x, y, z } = p.location;
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    if (p.effectId === 1010) { this.playRecord(p.data, cx, cy, cz); return; }
    if (p.effectId === 1032) { this.play('block.portal.travel', 0, 0, 0, 0.25, Math.random() * 0.4 + 0.8, { global: true, category: 'master' }); return; }
    if (p.effectId === 2001) {
      this.playBlockBreak(x, y, z, p.data);
      return;
    }
    const gl = GLOBAL_EVENTS[p.effectId];
    if (gl) { this.play(gl, cx, cy, cz, p.effectId === 1028 ? 5 : 1, 1, { global: true }); return; }
    const e = EVENT_SOUNDS[p.effectId];
    if (e) this.play(e[0], cx, cy, cz, e[1], e[2]());
  }

  async playRecord(itemId, x, y, z) {
    if (this.record) { this.record.voice.stop(); this.record = null; }
    if (!itemId) return;
    // 1.18 item ids (data/items.json music_disc_* 1015-1028)
    const names = { 1015: '13', 1016: 'cat', 1017: 'blocks', 1018: 'chirp', 1019: 'far', 1020: 'mall', 1021: 'mellohi', 1022: 'stal', 1023: 'strad', 1024: 'ward', 1025: '11', 1026: 'wait', 1027: 'otherside', 1028: 'pigstep' };
    const n = names[itemId];
    if (!n) return;
    const composer = (n === 'otherside' || n === 'pigstep') ? 'Lena Raine' : 'C418';
    this.game.hud.setActionBar('§dNow playing: ' + composer + ' - ' + n);
    this.record = await this.play('music_disc.' + n, x, y, z, 4, 1, { category: 'record' });
  }

  // Minecraft.getAmbientMusicType: [event, minDelay, maxDelay]
  _musicType() {
    const g = this.game, scr = g.screens.current;
    if (scr && scr.isCredits) return ['music.credits', 2147483647, 2147483647];
    if (!g.inWorld) return ['music.menu', 20, 600];
    // P4: our nether is single-biome, so the wastes pool covers it (rubedo +
    // nether1-4; the other biome pools need multi-biome worldgen first).
    if (g.dimension === -1) return ['music.nether.nether_wastes', 1200, 3600];
    if (g.dimension === 1) return g.hud.bossFlag(2) ? ['music.dragon', 0, 0] : ['music.end', 6000, 24000]; // GuiBossOverlay.shouldPlayEndBossMusic
    if (g.player.creative && g.player.allowFlying) return ['music.creative', 1200, 3600];
    return ['music.game', 12000, 24000];
  }

  // MusicTicker.update
  _musicTick() {
    const [name, min, max] = this._musicType();
    const rand = (a, b) => (a >= b ? a : a + Math.floor(Math.random() * (b - a + 1)));
    if (this.music) {
      if (this.musicName !== name) {
        this.music.voice.stop();
        this.musicTimer = rand(0, Math.floor(min / 2));
      }
      if (this.music.voice.ended || this.musicName !== name) {
        this.music = null;
        this.musicTimer = Math.min(rand(min, max), this.musicTimer);
      }
    }
    if (!this.music && !this.musicPending && this.musicTimer-- <= 0) {
      this.musicPending = true;
      this.musicName = name;
      this.play(name, 0, 0, 0, 1, 1, { global: true }).then((h) => {
        this.musicPending = false;
        this.music = h;
        this.musicTimer = 2147483647;
        if (!h) this.musicTimer = rand(min, max);
      });
    }
  }

  // Nether ambience (P4): the wastes loop runs continuously in-dimension
  // (streamed, HTMLAudio loop) with additions/mood one-shots on a slow
  // cadence. Other nether biomes need multi-biome worldgen first.
  _netherTick() {
    const g = this.game;
    const inNether = !!(g.inWorld && g.dimension === -1);
    if (!inNether) {
      if (this.netherLoop) { try { this.netherLoop.stop(); } catch (e) {} this.netherLoop = null; }
      this.netherPending = false;
      return;
    }
    if ((!this.netherLoop || this.netherLoop.voice.ended) && !this.netherPending) {
      this.netherLoop = null;
      this.netherPending = true;
      this.playLoop('ambient.nether_wastes.loop', 0, 0, 0, { global: true, category: 'ambient' }).then((h) => {
        this.netherPending = false;
        if (h && g.inWorld && g.dimension === -1 && !h.voice.ended) {
          h.setVolume && h.setVolume(1);
          this.netherLoop = h;
        } else if (h) { try { h.stop(); } catch (e) {} }
      });
    }
    // additions + mood poissons, global at a random nearby offset
    if (this.netherAddT === undefined) this.netherAddT = 1200 + ((Math.random() * 2400) | 0);
    if (this.netherAddT-- <= 0) {
      this.netherAddT = 6000 + ((Math.random() * 12000) | 0);
      const ev = Math.random() < 0.5 ? 'ambient.nether_wastes.additions' : 'ambient.nether_wastes.mood';
      const p = g.player;
      const ox = (Math.random() - 0.5) * 32, oz = (Math.random() - 0.5) * 32;
      this.play(ev, p.x + ox, p.y, p.z + oz, 1, 0.9 + Math.random() * 0.2, { category: 'ambient' });
    }
  }

  tick() {
    const g = this.game;
    if (!this.audio) return;
    for(const h of this.playing)if(h.entity)h.voice.setPosition?.([h.entity.x,h.entity.y,h.entity.z]);
    this._moodTick();
    this._netherTick();
    // Listener follows camera
    const f = g.lookVector();
    this.audio.setListener(g.renderer.camPos, f, [0, 1, 0]);
    this._musicTick();

  }
}

export { soundAssetName, soundTypeOf };
