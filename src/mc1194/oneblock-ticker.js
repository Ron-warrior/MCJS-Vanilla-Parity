/* MinecraftJS Skyblock — one shared island for everyone (part 1: ticker).
 * See part 2 below for the welcome UI. Room `oneblock`, fixed seed, type 4.
 * (Internal/protocol name stays "oneblock"; players see "Skyblock".)
 * Survival mode: the island mirror runs gameMode 0, and every block mined
 * by hand drops something into the inventory (ores drop materials, leaves
 * drop saplings, everything else drops itself). 1.15.2 engine (port of the 1.13.2 ticker).
 */

(function () {
"use strict";

const OB_ROOM = "oneblock";
const OB_SEED = 20261025;
const OB_TYPE = 4;
const OB_LS_SKIN = "mcjs.oneblock.skin"; // shared with oneblock-ui.js
const OB = { x: 0, y: 61, z: 0 };
const OBKEY = "0,61,0";

const OB_PHASES = [
  { at: 0, name: "Meadow", blocks: ["grass_block", "dirt", "dirt", "oak_log", "oak_leaves", "oak_leaves", "sand", "gravel", "clay", "poppy", "dandelion"] },
  { at: 25, name: "Stone Age", blocks: ["stone", "stone", "cobblestone", "cobblestone", "coal_ore", "oak_log", "sand", "gravel", "clay", "glass"] },
  { at: 75, name: "Iron Depths", blocks: ["iron_ore", "iron_ore", "coal_ore", "stone", "cobblestone", "oak_log", "glass", "bricks", "white_wool", "pumpkin"] },
  { at: 150, name: "Gold Rush", blocks: ["gold_ore", "redstone_ore", "lapis_ore", "iron_ore", "stone", "obsidian", "bookshelf", "melon", "hay_block", "cactus"] },
  { at: 250, name: "Diamond Sky", blocks: ["diamond_ore", "diamond_ore", "gold_ore", "obsidian", "glowstone", "ice", "snow_block", "prismarine", "sea_lantern", "sponge"] },
  { at: 400, name: "The End?", blocks: ["end_stone", "netherrack", "soul_sand", "nether_quartz_ore", "obsidian", "glowstone", "diamond_ore", "oak_log", "melon"] },
];

const OBS = { mines: 0, syncDone: false, pendingUntil: 0, lastPhase: -1, last: null };

function obGame() { return globalThis.game; }
function obSP() { return globalThis.__mcSingleplayer && globalThis.__mcSingleplayer.state; }
function obR() { return globalThis.__mcRealms && globalThis.__mcRealms.state; }
function obOnline() {
  try { const R = obR(); return !!(R && R.on && R.code === OB_ROOM); } catch (e) { return false; }
}
function obChat(m) { try { obGame().hud.addChat(m); } catch (e) {} }

function obSrand(seed, n) {
  let h = Math.imul((n | 0) ^ (seed | 0), 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

let obStateCache = null;
function obBlockState(name) {
  try {
    if (!obStateCache) {
      obStateCache = {};
      const arr = obGame().assets.data.blocks;
      for (const b of arr) {
        if (b && typeof b.name === "string" && typeof b.defaultState === "number") {
          if (obStateCache[b.name] == null) obStateCache[b.name] = b.defaultState;
        }
      }
    }
    if (obStateCache[name] != null) return obStateCache[name];
    console.warn("[oneblock] unknown block, using stone:", name);
    return obStateCache.stone != null ? obStateCache.stone : 1;
  } catch (e) { return 1; }
}

function obCurSeed() {
  try {
    if (obOnline()) return obR().seed >>> 0;
    const sp = obSP();
    if (sp) return sp.seed >>> 0;
  } catch (e) {}
  return OB_SEED >>> 0;
}
function obPhaseIndex(mines) {
  let pi = 0;
  for (let i = 0; i < OB_PHASES.length; i++) {
    if (mines >= OB_PHASES[i].at) pi = i;
  }
  return pi;
}
function obNextBlock(mines) {
  if (mines < 1) return obBlockState("grass_block");
  const pool = OB_PHASES[obPhaseIndex(mines)].blocks;
  const pick = pool[Math.floor(obSrand(obCurSeed(), mines) * pool.length) % pool.length];
  return obBlockState(pick);
}

function obMinesKey() {
  try { return "mcjs.ob.mines." + (obSP() ? obSP().id || "x" : "x"); }
  catch (e) { return "mcjs.ob.mines.x"; }
}

function obOnSet(state, local) {
  const was = OBS.last;
  OBS.last = state;
  // Count only genuine non-air -> air transitions, so duplicate deliveries
  // (echoes, replays) can never inflate the mine count.
  if (state !== 0 || was === 0) {
    if (state !== 0) OBS.pendingUntil = 0;
    return;
  }
  OBS.mines++;
  if (!obOnline()) {
    try { localStorage.setItem(obMinesKey(), String(OBS.mines)); } catch (e) {}
  }
  if (local) {
    OBS.pendingUntil = Date.now() + 1500;
    setTimeout(obRespawn, 1300);
  } else if (OBS.syncDone) {
    setTimeout(obRespawn, 3500);
  }
  obCheckPhase();
}

function obCheckPhase() {
  if (!OBS.syncDone) return;
  const pi = obPhaseIndex(OBS.mines);
  if (pi !== OBS.lastPhase) {
    OBS.lastPhase = pi;
    obChat("§aSkyblock: Phase " + (pi + 1) + "/" + OB_PHASES.length + " — " + OB_PHASES[pi].name + " §7(" + OBS.mines + " mined)");
  }
}

/* ---------------------------------------------------------- survival drops */

// block -> [item, count]. Blocks not listed here drop themselves (when the
// item exists); blocks with no item form (tall grass tufts etc.) map here.
const OB_DROPS = {
  grass: ["wheat_seeds", 1],
  tall_grass: ["wheat_seeds", 1],
  fern: ["wheat_seeds", 1],
  stone: ["cobblestone", 1],
  oak_leaves: ["oak_sapling", 1],
  coal_ore: ["coal", 1],
  iron_ore: ["iron_ore", 1],
  gold_ore: ["gold_ore", 1],
  redstone_ore: ["redstone", 4],
  lapis_ore: ["lapis_lazuli", 4],
  diamond_ore: ["diamond", 1],
  nether_quartz_ore: ["quartz", 1],
  glass: ["glass", 1],
  bookshelf: ["bookshelf", 1],
  glowstone: ["glowstone", 1],
  sea_lantern: ["sea_lantern", 1],
  ice: ["ice", 1],
  snow: ["snowball", 1],
};

let obRevCache = null;
function obStateName(state) {
  try {
    if (!obRevCache) {
      obRevCache = {};
      const arr = obGame().assets.data.blocks;
      for (const b of arr) {
        if (!b || typeof b.name !== "string") continue;
        if (typeof b.defaultState === "number" && obRevCache[b.defaultState] == null) {
          obRevCache[b.defaultState] = b.name;
        }
        const lo = b.minStateId, hi = b.maxStateId;
        if (typeof lo === "number" && typeof hi === "number" && hi - lo < 2000) {
          for (let s = lo; s <= hi; s++) {
            if (obRevCache[s] == null) obRevCache[s] = b.name;
          }
        }
      }
    }
    return obRevCache[state] || null;
  } catch (e) { return null; }
}

function obDropFor(blockName) {
  if (!blockName || blockName === "air" || blockName === "cave_air" || blockName === "void_air") return null;
  const sp = OB_DROPS[blockName];
  if (sp) return { item: sp[0], count: sp[1] || 1 };
  // default: the block itself, if it exists as an item
  try {
    if (obGame().items.byName.has(blockName)) return { item: blockName, count: 1 };
  } catch (e) {}
  return null;
}

function obGiveDrop(prevState) {
  const g = obGame();
  let name = null;
  try { name = obStateName(prevState); } catch (e) {}
  const d = name && obDropFor(name);
  if (!d) return;
  try {
    const def = g.items.byName.get(d.item);
    if (!def) return;
    g.inventory.addToInventory({ id: def.id, damage: 0, count: d.count });
  } catch (e) {}
}

// one wooden pickaxe per island, so Stone Age+ ores don't take forever by hand
function obKit() {
  try {
    const sp = obSP();
    if (!sp || !sp.id) return;
    const k = "mcjs.ob.kit." + sp.id;
    try { if (localStorage.getItem(k)) return; } catch (e) {}
    const g = obGame();
    let hasPick = false;
    try {
      const main = g.inventory.main || [];
      for (const it of main) {
        if (it && /_pickaxe$/.test(g.items.name(it.id))) { hasPick = true; break; }
      }
    } catch (e) {}
    if (!hasPick) {
      const def = g.items.byName.get("wooden_pickaxe");
      if (def) g.inventory.addToInventory({ id: def.id, damage: 0, count: 1 });
      obChat("§eStarter kit: wooden pickaxe — every block you mine drops something!");
    }
    try { localStorage.setItem(k, "1"); } catch (e) {}
  } catch (e) {}
}

function obRespawn() {
  try {
    const sp = obSP();
    if (!sp || !sp.active || sp.type !== "oneblock") return;
    const g = obGame();
    if (!g || !g.inWorld) return;
    if (g.world.getState(OB.x, OB.y, OB.z) !== 0) return;
    g.world.setState(OB.x, OB.y, OB.z, obNextBlock(OBS.mines));
  } catch (e) {}
}

function obInstallHook() {
  const g = obGame();
  if (!g || !g.world || g.world._obPatched) return;
  g.world._obPatched = true;
  const orig = g.world.setState.bind(g.world);
  g.world.setState = function (x, y, z, state) {
    let prev = -1;
    try {
      const sp0 = obSP();
      if (sp0 && sp0.active && sp0.type === "oneblock" && !sp0.gen) {
        // remember what stood here, so a local break can drop it below
        try { prev = g.world.getState(x, y, z); } catch (e) {}
      }
    } catch (e) {}
    const r = orig(x, y, z, state);
    try {
      const sp = obSP();
      if (sp && sp.active && sp.type === "oneblock") {
        if (x === OB.x && y === OB.y && z === OB.z) {
          obOnSet(state | 0, !sp.gen);
        }
        // survival drops: a genuine local break (not terrain gen, not a
        // remote edit replay) gives the block — or its material — to the miner
        if (prev > 0 && (state | 0) === 0 && !sp.gen) {
          obGiveDrop(prev);
        }
      }
    } catch (e) {}
    return r;
  };
}

function obTick() {
  try {
    const sp = obSP();
    if (!sp || !sp.active || sp.type !== "oneblock") { OBS.syncDone = false; return; }
    try { delete sp.overrides[OBKEY]; } catch (e) {}
    const g = obGame();
    if (!g || !g.inWorld) return;
    const cur = g.world.getState(OB.x, OB.y, OB.z);
    if (!OBS.syncDone) {
      let ready = obOnline();
      if (!ready) {
        try {
          const R = obR();
          if (R && (R.on || R.socket)) return; // mid-join: wait for R.on
          ready = !!(g.inWorld && g.doneLoadingTerrain);
        } catch (e) { return; }
      }
      if (!ready) return;
      if (!obOnline()) {
        try { OBS.mines = parseInt(localStorage.getItem(obMinesKey()), 10) || 0; }
        catch (e) { OBS.mines = 0; }
      }
      OBS.syncDone = true;
      OBS.lastPhase = obPhaseIndex(OBS.mines);
      const nx = OB_PHASES[OBS.lastPhase + 1];
      obChat("§aSkyblock island §7— Phase " + (OBS.lastPhase + 1) + "/" + OB_PHASES.length +
        " " + OB_PHASES[OBS.lastPhase].name + " · " + OBS.mines + " mined by everyone" +
        (nx ? " · next phase at " + nx.at : " · final phase"));
      try { obKit(); } catch (e) {}
      return;
    }
    if (cur === 0 && Date.now() > OBS.pendingUntil + 2000) {
      OBS.pendingUntil = Date.now() + 4000;
      obRespawn();
    }
  } catch (e) {}
}

function obPurgeRec(id) {
  const keys = ["mcjs.sp.v3.world." + id, "mcjs.sp.v2.world." + id, "mcjs.sp.v1.world." + id];
  for (const k of keys) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      if (rec && rec.overrides && rec.overrides[OBKEY] !== undefined) {
        delete rec.overrides[OBKEY];
        localStorage.setItem(k, JSON.stringify(rec));
      }
    } catch (e) {}
  }
}

function obWrapPlay() {
  const api = globalThis.__mcSingleplayer;
  if (!api || api._obPlayPatched) return;
  api._obPlayPatched = true;
  const orig = api.play.bind(api);
  api.play = function (id) {
    OBS.mines = 0; OBS.syncDone = false; OBS.pendingUntil = 0; OBS.lastPhase = -1; OBS.last = null;
    try { obPurgeRec(id); } catch (e) {}
    return orig(id);
  };
}

function obCommand(rest) {
  const say = (t) => obChat(t);
  const parts = rest.split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || "").toLowerCase();
  const sp = obSP();
  const inOb = !!(sp && sp.active && sp.type === "oneblock");
  if (!cmd || cmd === "help") {
    say("§e/ob|/skyblock §7phase|spawn|repair — Skyblock island commands");
  } else if (cmd === "phase") {
    const pi = obPhaseIndex(OBS.mines);
    const nx = OB_PHASES[pi + 1];
    say("§aPhase " + (pi + 1) + "/" + OB_PHASES.length + " " + OB_PHASES[pi].name +
      " §7· " + OBS.mines + " mined" + (nx ? " · next at " + nx.at : " · final phase"));
  } else if (cmd === "spawn") {
    if (!inOb) { say("§cJoin the island first"); return; }
    try {
      obGame().player.setPosition(3.5, 63, 3.5);
      obGame().player.motionX = obGame().player.motionY = obGame().player.motionZ = 0;
    } catch (e) {}
  } else if (cmd === "repair") {
    if (!inOb) { say("§cJoin the island first"); return; }
    try {
      const w = obGame().world;
      const g = obBlockState("grass_block"), d = obBlockState("dirt"), s = obBlockState("stone");
      for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          w.setState(x, 60, z, (x === 0 && z === 0) ? s : g);
          w.setState(x, 59, z, d);
          if (Math.abs(x) <= 2 && Math.abs(z) <= 2) w.setState(x, 58, z, s);
        }
      }
    } catch (e) {}
    say("§aIsland repaired");
  } else {
    say("§cUnknown /ob command — try /ob help");
  }
}

function obWrapChat() {
  const api = globalThis.__mcSingleplayer;
  if (!api || api._obChatPatched) return;
  api._obChatPatched = true;
  const orig = api.chat.bind(api);
  api.chat = function (msg) {
    const m = String(msg == null ? "" : msg);
    if (m[0] === "/" && /^\/(ob|skyblock)\b/i.test(m)) { obCommand(m.replace(/^\/\S+/, "").trim()); return; }
    return orig(msg);
  };
}

if (!globalThis.__mcOneBlockBooted) {
  globalThis.__mcOneBlockBooted = true;
  (function obSelfBoot() {
    try {
      if (globalThis.game && globalThis.__mcSingleplayer && globalThis.__mcOneBlockTicker) {
        globalThis.__mcOneBlockTicker.boot();
        return;
      }
    } catch (e) {}
    setTimeout(obSelfBoot, 500);
  })();
}

globalThis.__mcOneBlockTicker = {
  boot: function () {
    try { obInstallHook(); } catch (e) { console.error("[oneblock] hook failed", e); }
    try { obWrapPlay(); } catch (e) {}
    try { obWrapChat(); } catch (e) {}
    setInterval(obTick, 700);
    try {
      const names = OB_PHASES.map((p) => p.blocks).reduce((a, b) => a.concat(b), []);
      const missing = [];
      for (const n of names) { try { obBlockState(n); } catch (e) { missing.push(n); } }
      if (missing.length) console.warn("[oneblock] missing blocks:", missing.join(","));
    } catch (e) {}
    console.log("[oneblock-ticker] ready");
  },
  get mines() { return OBS.mines; },
  get synced() { return OBS.syncDone; },
};

})();