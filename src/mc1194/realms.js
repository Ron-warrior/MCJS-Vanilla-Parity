/* MinecraftJS Realms — same rooms protocol, avatars, relay;
 * local mirror worlds use the singleplayer v3 store (1.15.2 port).
 */
/* MinecraftJS Realms (online co-op rooms).
 *
 * A Realm is a room hosted on the generator's own server: everyone who
 * joins with the same code (or picks it from the public list) shares the same
 * deterministic singleplayer terrain (seed + type stored server-side), sees
 * each other's avatars, builds together (block edits relayed + replayed
 * from the room log), and chats.
 *
 * Imported by boot1194.js AFTER the engine + singleplayer. Uses only the
 * public client API plus singleplayer's world machinery (playWorld,
 * SP.gen-guarded setState) — the minified bundle is never modified.
 *
 * Flow: title "Minecraft Realms" button -> HTML menu (name/code/seed/type,
 * public flag, Create or Join, browse public rooms) -> join RPC at title
 * (server creates or validates) -> ensure a matching local world
 * ("Realm <code>") -> playWorld -> sync RPC replays the build log ->
 * live edit/transform/chat relay.
 * Offline copies (file://, __mcOffline) have no server: LocalSocket below
 * speaks the same protocol over BroadcastChannel + localStorage, so rooms
 * work between tabs on the same computer with no other changes.
 * In-world controls: /realm players | /realm invite | /realm publish |
 * /realm unpublish | /realm leave.
 * Invite links: https://perchance.org/<name>#realm=<code> (auto-opens menu).
 */

(function () {
"use strict";

const TYPES = { hills: 0, flat: 1, void: 2, voxel: 3, oneblock: 4 };
const TYPE_NAMES = ["hills", "flat", "void", "voxel", "oneblock"];
const LS_NAME = "mcjs.realms.name";
const LS_INDEX_V3 = "mcjs.sp.v3.index";
const LS_WORLD_V3 = (id) => "mcjs.sp.v3.world." + id;
// 1.15.2: singleplayer owns world storage (v3 keys + memFallback cache).
// Delegate to its helpers so realm mirrors stay consistent with the cache.
function SPapi() { try { return globalThis.__mcSingleplayer || null; } catch (e) { return null; } }
const REMOTE_BASE = -1000; // remote entity ids: REMOTE_BASE - sid (local self is -1)

const R = {
  on: false,          // relaying edits/transforms/chat
  entering: false,    // realm world loading (survives game.leaveWorld inside playWorld)
  socket: null,
  sid: -1,
  code: "",
  seed: 0,
  type: "hills",
  mode: 0, // room mode byte: 0 creative, 1 survival (chosen at creation)
  name: "webuser",
  members: new Map(), // sid -> {name, eid, lastMove}
  eids: new Set(),    // our remote entity ids (for teardown)
  pub: false,         // room is listed in the public browser
  moveTimer: 0,
  retries: 0,
  connected: false,
};

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function game() { return globalThis.game; }
function SP() { return globalThis.__mcSingleplayer && globalThis.__mcSingleplayer.state; }
function chat(msg) { try { game().hud.addChat(msg); } catch (e) {} }
function toast(msg) { chat("§eRealms: " + msg); }

function myName() {
  try {
    const n = (localStorage.getItem(LS_NAME) || "").trim();
    if (n) return n;
  } catch (e) {}
  try {
    const ac = game() && game().accounts && game().accounts.active && game().accounts.active();
    if (ac && ac.name && ac.name !== "WebPlayer") return String(ac.name).slice(0, 16);
  } catch (e) {}
  try {
    const u = game() && game().settings && game().settings.username;
    if (u && u !== "WebPlayer") return String(u).slice(0, 16);
  } catch (e) {}
  return "webuser";
}
function setMyName(n) { try { localStorage.setItem(LS_NAME, n); } catch (e) {} }

function uuidFor(sid, skin) {
  let base = ("0000000" + (sid >>> 0).toString(16)).slice(-8) + "0".repeat(24);
  if ((skin === "steve" || skin === "alex") && skinParityAlex(base) !== (skin === "alex")) {
    base = base.slice(0, 31) + (base[31] === "0" ? "1" : "0");
  }
  return base;
}
// The engine picks the steve/alex model from uuid parity; the Skyblock
// welcome screen stores its choice here, so avatars match it.
function skinParityAlex(uuid32) {
  try {
    const t = String(uuid32).replace(/-/g, "");
    const e = BigInt.asIntN(64, BigInt("0x" + t.slice(0, 16)));
    const s = BigInt.asIntN(64, BigInt("0x" + t.slice(16)));
    const i = e ^ s;
    const r = Number(BigInt.asIntN(32, i >> 32n)) ^ Number(BigInt.asIntN(32, i));
    return (r & 1) === 1;
  } catch (err) { return false; }
}
function mySkin() {
  try {
    const s = localStorage.getItem("mcjs.oneblock.skin");
    if (s === "steve" || s === "alex") return s;
  } catch (e) {}
  return null;
}

/* ---------------------------------------------------------- local worlds */

function loadIndex() {
  try { const a = SPapi(); if (a && typeof a.index === "function") return a.index(); } catch (e) {}
  try {
    const raw = localStorage.getItem(LS_INDEX_V3);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveI(idx) {
  try { const a = SPapi(); if (a && typeof a.saveIndex === "function") { a.saveIndex(idx); return true; } } catch (e) {}
  try { localStorage.setItem(LS_INDEX_V3, JSON.stringify(idx)); return true; }
  catch (e) { return false; }
}
function loadRec(id) {
  try { const a = SPapi(); if (a && typeof a.worldRec === "function") return a.worldRec(id); } catch (e) {}
  try { const raw = localStorage.getItem(LS_WORLD_V3(id)); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function saveWorldRec(id, rec) {
  try {
    const a = SPapi();
    if (a && typeof a.saveWorldRec === "function") {
      const ok = a.saveWorldRec(id, rec);
      try { if (a.dropCache) a.dropCache(id); } catch (e2) {}
      return ok;
    }
  } catch (e) {}
  try { localStorage.setItem(LS_WORLD_V3(id), JSON.stringify(rec)); return true; }
  catch (e) { return false; }
}
function newId() {
  try { const a = SPapi(); if (a && typeof a.newId === "function") return a.newId(); } catch (e) {}
  return "w" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// Room game mode. The room stores a mode byte (0 creative, 1 survival,
// chosen at creation); Skyblock islands are always survival. Every client
// enters the room's local mirror in the room's mode, which also arms the
// survival systems (SP.mode === 0 -> damage, hunger, drops, mobs).
function realmModeFor(type, serverMode) {
  if (type === "oneblock") return 0;
  return (serverMode | 0) === 1 ? 0 : 1;
}

// Find (or create) the local singleplayer world that mirrors a realm room.
// If a world for this code exists but was generated from a different seed
// (room was recycled), adopt the server seed only when the local copy is
// untouched; otherwise refuse to go online so local builds are never lost.
function ensureRealmWorld(code, seed, type, serverMode) {
  const wantMode = realmModeFor(type, serverMode);
  const idx = loadIndex();
  let e = idx.find((x) => x && x.realm === code);
  if (e) {
    if ((e.seed >>> 0) !== (seed >>> 0) || (e.type || "hills") !== type) {
      const hasEdits = e.edits > 0;
      if (hasEdits) return { ok: false, reason: "room was recreated with a new world; your local copy has builds in it — delete it from Singleplayer first, or create a different room" };
      e.seed = seed >>> 0;
      e.type = type;
      e.mode = wantMode;
      e.edits = 0;
      try { saveI(idx); } catch (err) {}
      const rec = { seed: seed >>> 0, type, mode: wantMode, realm: code, overrides: {} };
      saveWorldRec(e.id, rec);
    } else if ((e.mode | 0) !== wantMode) {
      // mode migration (e.g. a Realm skyblock world from when it was
      // creative): flip the mode, keep every block — safe, touches no edits.
      e.mode = wantMode;
      try { saveI(idx); } catch (err) {}
      try {
        const rec = loadRec(e.id);
        if (rec) { rec.mode = wantMode; saveWorldRec(e.id, rec); }
      } catch (err) {}
    }
    return { ok: true, id: e.id };
  }
  const id = newId();
  idx.unshift({
    id, name: "Realm " + code, seed: seed >>> 0, type, mode: wantMode,
    realm: code, edits: 0, modified: Date.now(), size: 0, shot: null,
  });
  if (!saveI(idx)) return { ok: false, reason: "browser storage is blocked" };
  saveWorldRec(id, { seed: seed >>> 0, type, mode: wantMode, realm: code, name: "Realm " + code, overrides: {} });
  return { ok: true, id };
}

/* ---------------------------------------------------------- socket */

function socketFactory() {
  if (globalThis.__mcOffline) return new LocalSocket();
  const r = globalThis.root || window.root;
  if (r && typeof r.createServerSocket === "function") return r.createServerSocket();
  if (typeof globalThis.createServerSocket === "function") return globalThis.createServerSocket();
  throw new Error("server plugin not available");
}

/* ---------------- offline backend (no server needed) ----------------
 * Downloaded offline copies have no server-plugin socket, so the hosted
 * internet rooms can't work. Instead, LocalSocket speaks the EXACT same
 * room protocol as the server script (same rpc names, same binary tags
 * 1/2/11/12/13/14, same join/create/members/pub semantics) on TWO
 * transports at once: BroadcastChannel + localStorage for same-machine
 * tabs, and peer-to-peer WebRTC (Trystero over public Nostr relays, no
 * accounts or keys) for cross-device play when both ends are online.
 * Receivers dedupe by message id, so local tabs keep working even if the
 * trackers are unreachable. Every device keeps a full replica
 * (seed/type/pub/edit log) and replicas exchange logs on hello, so late
 * joiners sync from whoever is around. The rest of this file runs
 * unchanged: same file + same code, here or on another device.
 */

const LOCAL_CH = "mcjs.realms.v1";
const LOCAL_REG = "mcjs.realms.rooms.v1";
const LOCAL_MAX_REC = 16384;
const LOCAL_PEER_MS = 12000;
const LOCAL_HB_MS = 5000;

const LPeers = {};   // room -> {sid: {name, tab, seen}} (shared presence)
const MemRooms = {}; // fallback registry when localStorage is unavailable

function lsGet(k) {
  try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); }
  catch (e) { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) { return false; }
}
function loadRooms() {
  const r = lsGet(LOCAL_REG);
  return r && typeof r === "object" ? r : null;
}
function normRoom(s) {
  s = String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}
function normName(s) {
  s = String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").trim();
  if (s.length > 16) s = s.slice(0, 16);
  return s || "webuser";
}
function livePeers(room) {
  const now = Date.now(), grp = LPeers[room] || {}, out = [];
  for (const k in grp) {
    if (now - grp[k].seen < LOCAL_PEER_MS) out.push([+k, grp[k].name]);
  }
  return out;
}
function touchPeer(room, sid, name, tab) {
  if (!room || !(sid >= 0)) return;
  const grp = LPeers[room] || (LPeers[room] = {});
  const prev = grp[sid];
  grp[sid] = {
    name: name || (prev && prev.name) || "webuser",
    tab: tab || (prev && prev.tab) || "",
    seen: Date.now(),
  };
}
function dropPeer(room, sid) {
  const grp = LPeers[room];
  if (grp) { try { delete grp[sid]; } catch (e) {} }
}
// Binary sync batch [11][count u32][x i32][z i32][y u16][id u16]... (server format)
function buildLogFrame(log) {
  const n = log ? log.length : 0;
  const out = new Uint8Array(5 + n * 12);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 11);
  dv.setUint32(1, n, true);
  for (let i = 0; i < n; i++) {
    const e = log[i], o = 5 + i * 12;
    dv.setInt32(o, e[0] | 0, true);
    dv.setInt32(o + 4, e[2] | 0, true);
    dv.setUint16(o + 8, e[1] & 0xFFFF, true);
    dv.setUint16(o + 10, e[3] & 0xFFFF, true);
  }
  return out;
}
// Relay edit frame [12][sid u16][x i32][z i32][y u16][id u16] (server format)
function buildEditFrame(sid, x, z, y, id) {
  const out = new Uint8Array(15);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 12);
  dv.setUint16(1, sid & 0xFFFF, true);
  dv.setInt32(3, x | 0, true);
  dv.setInt32(7, z | 0, true);
  dv.setUint16(11, y & 0xFFFF, true);
  dv.setUint16(13, id & 0xFFFF, true);
  return out;
}
function buildLeaveFrame(sid) {
  const out = new Uint8Array(3);
  new DataView(out.buffer).setUint16(1, sid & 0xFFFF, true);
  out[0] = 14;
  return out;
}

function logHash(log) {
  let h = 2166136261;
  const n = Math.min(log ? log.length : 0, 16384);
  for (let i = 0; i < n; i++) {
    const e = log[i];
    h ^= (e[0] | 0); h = Math.imul(h, 16777619);
    h ^= (e[1] & 0xFFFF); h = Math.imul(h, 16777619);
    h ^= (e[2] | 0); h = Math.imul(h, 16777619);
    h ^= (e[3] & 0xFFFF); h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// Replicas (tabs/devices) exchange logs: only the side with the shorter (or
// divergent) log acts, by requesting the other's — the longer side never
// pushes unprompted, so joins can't cause duplicate full-log streams.
function maybeSyncFrom(sock, m) {
  if (!sock._joined || m.room !== sock._room || m.sid === sock._sid) return;
  const myLen = sock._log ? sock._log.length : 0;
  const theirLen = m.logLen | 0;
  if (theirLen === myLen && (m.logHash >>> 0) === logHash(sock._log)) return;
  if (theirLen >= myLen) {
    const rid = sock._tab + "-" + Date.now().toString(36);
    try { sock._post({ k: "want-log", toTab: m.tab, rid, fromTab: sock._tab }); } catch (e) {}
  }
}

function LocalOnMsg(sock, m) {
  if (!m || typeof m !== "object" || typeof m.k !== "string") return;
  sock._stats = sock._stats || { bc: 0, p2p: 0, dup: 0 };
  if (m.via === "p2p") sock._stats.p2p++; else sock._stats.bc++;
  // dual-transport dedup: the same envelope arrives via BC and WebRTC
  if (m.mid) {
    sock._seen = sock._seen || {};
    if (sock._seen[m.mid]) { sock._stats.dup++; return; }
    sock._seen[m.mid] = 1;
    sock._seenN = (sock._seenN | 0) + 1;
    if (sock._seenN > 3000) { sock._seen = {}; sock._seenN = 0; }
  }
  if (m.sid > 0 && m.room) touchPeer(m.room, m.sid, m.name, m.tab); // sid 0 = unjoined prober (discover); never a roster member
  // sid collision: same sid, different tab — smaller tab id picks a new sid
  if (m.sid === sock._sid && m.tab && sock._tab && m.tab !== sock._tab && sock._joined) {
    if (sock._tab < m.tab) sock._reSid();
    return;
  }
  switch (m.k) {
    case "hello": {
      if (!m.sid || m.sid === sock._sid) return; // sid 0 = unjoined prober, never a roster member
      if (sock._waitHello && m.room === sock._waitHello.room) {
        // parked join (see LocalRpcJoin): the host showed up — adopt it
        sock._waitHello.found = { seed: m.seed >>> 0, type: m.type | 0, mode: m.mode | 0 };
        return;
      }
      if (!sock._joined || m.room !== sock._room) return;
      if (m.seed !== undefined && sock._seed !== m.seed) {
        sock._emit(JSON.stringify({ t: "error", msg: "room seed conflict — two tabs created “" + m.room + "” separately; leave and rejoin the same one" })); // string, like the server's direct reply
        return;
      }
      sock._emit(JSON.stringify({ t: "join", sid: m.sid, name: m.name })); // string, like the server's topic publish
      sock._sendHi(m.tab);
      maybeSyncFrom(sock, m);
      break;
    }
    case "hi": {
      if (m.toTab !== sock._tab) return;
      if (sock._hiCb) { try { sock._hiCb(m); } catch (e) {} }
      maybeSyncFrom(sock, m);
      break;
    }
    case "frame": {
      if (!sock._joined || m.room !== sock._room || m.sid === sock._sid) return;
      if (m.toTab && m.toTab !== sock._tab) return;
      if (m.rid && m.first) {
        // first chunk of a want-log stream: lock onto this sender
        sock._streams = sock._streams || {};
        if (sock._streams[m.rid] && sock._streams[m.rid] !== m.sid) return;
        sock._streams[m.rid] = m.sid;
      }
      if (m.rid && sock._streams && sock._streams[m.rid] && sock._streams[m.rid] !== m.sid) return;
      sock._emit(new Uint8Array(m.buf));
      break;
    }
    case "chat": {
      if (!sock._joined || m.room !== sock._room || m.sid === sock._sid) return;
      if (m.toTab && m.toTab !== sock._tab) return;
      sock._emit(JSON.stringify({ t: "chat", sid: m.sid, name: m.name, text: m.text }));
      break;
    }
    case "bye": {
      if (!sock._joined || m.room !== sock._room || m.sid === sock._sid) return;
      if (m.toTab && m.toTab !== sock._tab) return;
      dropPeer(m.room, m.sid);
      sock._emit(buildLeaveFrame(m.sid));
      break;
    }
    case "hb": break; // presence only (touched above)
    case "where-is": {
      if (!sock._joined || m.room !== sock._room || !m.fromTab || m.fromTab === sock._tab) return;
      sock._sendHi(m.fromTab);
      break;
    }
    case "want-log": {
      if (!sock._joined || m.room !== sock._room || m.sid === sock._sid) return;
      if (m.toTab && m.toTab !== sock._tab) return;
      if (!sock._needStreams) sock._needStreams = {};
      if (sock._needStreams[m.rid]) return; // another peer is already serving it
      if (!sock._log || !sock._log.length) return;
      sock._needStreams[m.rid] = Date.now();
      setTimeout(() => { try { delete sock._needStreams[m.rid]; } catch (e) {} }, 30000);
      sock._streamLog(m.fromTab, m.rid);
      break;
    }
  }
}

function LocalSocket() {
  const sock = this;
  sock._h = { open: [], close: [], message: [], error: [] };
  sock._tab = ((Math.random() * 0xFFFFFFFF) >>> 0).toString(16);
  sock._sid = 0;
  sock._room = "";
  sock._name = "";
  sock._seed = 0;
  sock._joined = false;
  sock._closed = false;
  sock._log = [];
  sock._solo = false;
  sock.readyState = 0;
  try {
    sock._ch = new BroadcastChannel(LOCAL_CH);
    sock._ch.onmessage = (ev) => { try { LocalOnMsg(sock, ev.data); } catch (e) {} };
  } catch (e) { sock._ch = null; sock._solo = true; }
  try {
    sock._pagehide = () => { try { sock._post({ k: "bye" }); } catch (e) {} };
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("pagehide", sock._pagehide);
    }
  } catch (e) {}
  sock._hbTimer = setInterval(() => { try { sock._tick(); } catch (e) {} }, LOCAL_HB_MS);

  sock.rpc = {
    join: async (data) => LocalRpcJoin(sock, data),
    list: async () => LocalRpcList(sock),
    publish: async (data) => LocalRpcPublish(sock, data),
    sync: async () => LocalRpcSync(sock),
    chat: async (data) => LocalRpcChat(sock, data),
    leave: async () => LocalRpcLeave(sock),
  };

  setTimeout(() => {
    if (sock._closed) return;
    sock.readyState = 1;
    sock._fire("open", {});
  }, 0);
}
LocalSocket.prototype._fire = function (kind, ev) {
  const hs = this._h[kind] || [];
  for (let i = 0; i < hs.length; i++) { try { hs[i](ev); } catch (e) {} }
};
LocalSocket.prototype._emit = function (data) {
  this._fire("message", { data });
};
LocalSocket.prototype.addEventListener = function (kind, fn) {
  if (this._h[kind]) this._h[kind].push(fn);
};
LocalSocket.prototype.removeEventListener = function (kind, fn) {
  const hs = this._h[kind];
  if (hs) { const i = hs.indexOf(fn); if (i >= 0) hs.splice(i, 1); }
};
LocalSocket.prototype._post = function (msg) {
  msg.room = msg.room || this._room;
  msg.sid = (msg.sid == null) ? this._sid : msg.sid;
  msg.tab = this._tab;
  msg.mid = this._tab + ":" + (((this._seq | 0) + 1) >>> 0);
  this._seq = (this._seq | 0) + 1;
  if (msg.k !== "hb" && !msg.name && this._name) msg.name = this._name;
  let ok = false;
  if (this._ch) {
    try { this._ch.postMessage(msg); ok = true; } catch (e) {}
  }
  // cross-device copy over WebRTC (no-op until a P2P room is entered)
  const p = this._p2p;
  if (p && p.send && msg.room && p.code === msg.room) {
    try {
      const m2 = {};
      for (const k in msg) m2[k] = msg[k];
      m2.via = "p2p";
      if (m2.buf) { m2.b64 = bufToB64(m2.buf); delete m2.buf; }
      const target = (msg.toTab && p.peerByTab[msg.toTab]) || null;
      if (target) p.send(m2, target); else p.send(m2);
      ok = true;
    } catch (e) {}
  }
  return ok;
};
LocalSocket.prototype._tick = function () {
  if (this._closed || !this._joined) return;
  this._post({ k: "hb", name: this._name });
  // expire silent peers (crashed tabs): feed the normal leave path
  const grp = LPeers[this._room] || {}, now = Date.now();
  for (const k in grp) {
    const sid = +k;
    if (sid !== this._sid && now - grp[sid].seen >= LOCAL_PEER_MS) {
      dropPeer(this._room, sid);
      this._emit(buildLeaveFrame(sid));
    }
  }
};
LocalSocket.prototype._announce = function () {
  if (!this._joined) return;
  try {
    this._post({
      k: "hello", name: this._name, seed: this._seed,
      type: this._type | 0, mode: this._mode | 0,
      logLen: this._log ? this._log.length : 0, logHash: logHash(this._log),
    });
  } catch (e) {}
};
LocalSocket.prototype._sendHi = function (toTab) {
  this._post({
    k: "hi", toTab, name: this._name,
    seed: this._seed, type: this._type || 0, mode: this._mode || 0,
    logLen: this._log ? this._log.length : 0, logHash: logHash(this._log),
  });
};
LocalSocket.prototype._reSid = function () {
  // lost a sid collision: say goodbye on the old sid, hello on a new one
  try { this._post({ k: "bye" }); } catch (e) {}
  dropPeer(this._room, this._sid);
  const taken = {};
  livePeers(this._room).forEach((p) => { taken[p[0]] = 1; });
  let sid = 0;
  for (let i = 0; i < 50 && !sid; i++) {
    const c = 1 + Math.floor(Math.random() * 0xFFFE);
    if (!taken[c]) sid = c;
  }
  if (!sid) return;
  this._sid = sid;
  touchPeer(this._room, sid, this._name, this._tab);
  this._announce();
};
LocalSocket.prototype._streamLog = function (toTab, rid) {
  const log = this._log || [];
  const CHUNK = 1500;
  let i = 0;
  const step = () => {
    if (this._closed || !this._joined) return;
    const end = Math.min(i + CHUNK, log.length);
    const parts = [];
    for (let j = i; j < end; j++) {
      const e = log[j];
      parts.push(buildEditFrame(this._sid, e[0], e[2], e[1], e[3]));
    }
    // one BroadcastChannel message per chunk: concatenate frames with lengths
    let total = 0;
    for (let j = 0; j < parts.length; j++) total += parts[j].length;
    const buf = new Uint8Array(total);
    let o = 0;
    for (let j = 0; j < parts.length; j++) { buf.set(parts[j], o); o += parts[j].length; }
    this._post({ k: "frame", toTab, rid, first: i === 0 ? 1 : 0, buf: buf.buffer });
    i = end;
    if (i < log.length) setTimeout(step, 100);
  };
  step();
};
/* ---------------- cross-device transport (WebRTC via Trystero) -------- *
 * The offline file has no server, but with internet access two devices can
 * still find each other: Trystero (public Nostr relays, no accounts/keys)
 * introduces the tabs, then everything rides peer-to-peer WebRTC data
 * channels. This reuses the whole LocalSocket protocol: _post duplicates
 * each envelope onto both transports and receivers dedupe by mid, so local
 * tabs keep working even if the trackers are unreachable, and remote peers
 * just work when they are. Loaded lazily (dynamic import) only when the
 * cross-device box is ticked — fully offline machines stay on BC+storage.
 */
const P2P_LIB_URL = "https://esm.sh/trystero@0.26.0";
const P2P_APP = "mcjs-realms-v1";
const P2P_NET_KEY = "mcjs.realms.net";
let P2PLib = null, P2PLibFailAt = 0, P2PLibError = "";
function netPrefOn() {
  try { return localStorage.getItem(P2P_NET_KEY) !== "0"; } catch (e) { return true; }
}
function setNetPref(on) { try { localStorage.setItem(P2P_NET_KEY, on ? "1" : "0"); } catch (e) {} }
async function ensureP2P() {
  if (P2PLib) return P2PLib;
  if (Date.now() - P2PLibFailAt < 120000) return null;
  try {
    P2PLib = await import(P2P_LIB_URL);
    if (!P2PLib || typeof P2PLib.joinRoom !== "function") throw new Error("bad lib");
    P2PLibError = "";
    return P2PLib;
  } catch (e) { P2PLib = null; P2PLibFailAt = Date.now(); P2PLibError = (e && e.message) || String(e); return null; }
}
function bufToB64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBuf(b64) {
  const s = atob(String(b64));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
async function p2pEnter(sock, code) {
  if (!netPrefOn()) return false;
  const T = await ensureP2P();
  if (!T) return false;
  try { if (sock._p2p && sock._p2p.code === code) return true; } catch (e) {}
  try { p2pExit(sock); } catch (e) {}
  try {
    const room = T.joinRoom({ appId: P2P_APP }, "mcjs-" + code);
    const st = (sock._p2p = { room, code, send: null, peerByTab: {}, tabByPeer: {} });
    const act = room.makeAction("m");
    if (act && typeof act.send === "function") {
      st.send = (d, target) => { try { act.send(d, target ? { target } : undefined); } catch (e) {} };
      act.onMessage = (d, meta) => p2pRecv(sock, d, meta && meta.peerId);
    } else if (act && typeof act[0] === "function") {
      st.send = (d, target) => { try { act[0](d, target); } catch (e) {} };
      act[1]((d, pid) => p2pRecv(sock, d, pid));
    } else throw new Error("action api");
    room.onPeerLeave = (pid) => p2pLeft(sock, pid);
    // A peer that just linked may have missed our earlier hello (slow
    // handshake both ways): greet it directly so parked joins complete.
    room.onPeerJoin = (pid) => { try { sock._announce(); } catch (e) {} };
    return true;
  } catch (e) { sock._p2p = null; return false; }
}
function p2pExit(sock) {
  const p = sock._p2p;
  sock._p2p = null;
  if (p && p.room) { try { p.room.leave(); } catch (e) {} }
}
function p2pRecv(sock, d, peerId) {
  if (!d || typeof d !== "object" || typeof d.k !== "string") return;
  if (sock._p2p && d.tab) {
    try {
      sock._p2p.peerByTab[d.tab] = peerId;
      sock._p2p.tabByPeer[peerId] = d.tab;
    } catch (e) {}
  }
  d.via = "p2p";
  if (typeof d.b64 === "string") {
    try { d.buf = b64ToBuf(d.b64); } catch (e) { return; }
    delete d.b64;
  }
  try { LocalOnMsg(sock, d); } catch (e) {}
}
function p2pLeft(sock, peerId) {
  const st = sock._p2p;
  const tab = st && st.tabByPeer[peerId];
  if (!st || !tab) return;
  try { delete st.tabByPeer[peerId]; delete st.peerByTab[tab]; } catch (e) {}
  if (!sock._joined || sock._closed) return;
  const grp = LPeers[sock._room] || {};
  for (const k in grp) {
    if (grp[k].tab === tab) {
      const sid = +k;
      dropPeer(sock._room, sid);
      try { sock._emit(buildLeaveFrame(sid)); } catch (e) {}
    }
  }
}

LocalSocket.prototype.send = function (data) {
  if (!this._joined) return;
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 1) return;
  const tag = u8[0];
  if (tag === 1) {
    // edit [1][x i32][z i32][y u16][id u16]
    if (u8.length !== 13) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const x = dv.getInt32(1, true), z = dv.getInt32(5, true);
    const y = dv.getUint16(9, true), id = dv.getUint16(11, true);
    if (y > 319) return; // 1.18 build limit (u16 wire format can't carry y < 0; those edits stay local)
    const rec = LocalGetRoom(this._room);
    if (!rec) return;
    if (rec.log.length >= LOCAL_MAX_REC) {
      this._emit(JSON.stringify({ t: "error", msg: "room build log is full" }));
      return;
    }
    const e = [x, y, z, id];
    rec.log.push(e);
    LocalPutRoom(this._room, rec);
    this._log = rec.log.slice();
    this._post({ k: "frame", buf: buildEditFrame(this._sid, x, z, y, id).buffer });
  } else if (tag === 2) {
    // move [2][x i32][y i32][z i32][yaw i16][pitch i16][nameLen][name][skin u8?]
    if (u8.length < 18 || u8.length > 67) return;
    const mnl = u8[17];
    if (mnl > 48) return;
    if (u8.length !== 18 + mnl && u8.length !== 19 + mnl) return;
    if (u8.length === 19 + mnl && u8[18 + mnl] > 1) return;
    const nb = u8.subarray(18, 18 + mnl);
    let nm = "webuser";
    try { nm = new TextDecoder().decode(nb) || "webuser"; } catch (e) {}
    const fwd = new Uint8Array(3 + u8.length - 1);
    fwd[0] = 13;
    fwd[1] = this._sid & 0xFF;
    fwd[2] = (this._sid >> 8) & 0xFF;
    for (let j = 1; j < u8.length; j++) fwd[2 + j] = u8[j];
    this._post({ k: "frame", buf: fwd.buffer });
    touchPeer(this._room, this._sid, this._name, this._tab);
  }
};
LocalSocket.prototype.close = function (code) {
  if (this._closed) return;
  this._closed = true;
  try { if (this._joined) this._post({ k: "bye" }); } catch (e) {}
  this._joined = false;
  try { if (this._hbTimer) clearInterval(this._hbTimer); } catch (e) {}
  try {
    if (typeof window !== "undefined" && window.removeEventListener && this._pagehide) {
      window.removeEventListener("pagehide", this._pagehide);
    }
  } catch (e) {}
  try { if (this._ch) this._ch.close(); } catch (e) {}
  try { p2pExit(this); } catch (e) {}
  this.readyState = 3;
  this._fire("close", { code: code || 1000, reason: "" });
};

function LocalGetRoom(room) {
  const rooms = loadRooms();
  if (rooms) return rooms[room] || null;
  return MemRooms[room] || null;
}
function LocalPutRoom(room, rec) {
  const rooms = loadRooms() || {};
  rooms[room] = rec;
  if (lsSet(LOCAL_REG, rooms)) return true;
  MemRooms[room] = rec; // storage blocked: same-tab only, plus peer want-log sync
  return false;
}

async function LocalRpcJoin(sock, data) {
  let info;
  try { info = JSON.parse(String(data)); } catch (e) { throw new Error("bad join"); }
  const room = normRoom(info.room);
  if (!room) throw new Error("bad room code (a-z, 0-9, -, max 24)");
  await p2pEnter(sock, room); // cross-device mesh (no-op if unticked/offline)
  const name0 = normName(info.name);
  let rec = LocalGetRoom(room);
  let created = false;
  if (!rec) {
    // Someone else may already host this code (another device on the mesh,
    // or a tab while storage is blocked). Adopt it instead of forking a
    // parallel room with a different seed — that was the classic "can't see
    // each other" trap when both ends tapped Create.
    const storageDead = loadRooms() === null;
    const mesh = !!(sock._p2p && sock._p2p.send);
    let found = null;
    if (livePeers(room).length || storageDead || mesh) {
      found = await LocalDiscover(room, sock, mesh ? 4000 : 1500);
    }
    if (found) {
      rec = { seed: found.seed >>> 0, type: found.type | 0, mode: found.mode | 0, pub: false, log: [] };
      LocalPutRoom(room, rec); // memory-only when storage is dead
    } else if (mesh && !sock._closed) {
      // WebRTC first-contact often takes longer than one search round: park
      // in the mesh and wait for the host to appear instead of failing fast.
      // (Its hello — prompted by our arrival — completes the join.)
      sock._waitHello = { room, found: null };
      const t0 = Date.now();
      try { setStatus("waiting for a host on code “" + room + "” — keep the other device IN the room…"); } catch (e) {}
      while (!sock._waitHello.found && !sock._closed && Date.now() - t0 < 60000) {
        await new Promise((r) => setTimeout(r, 5000));
        if (!sock._waitHello || sock._waitHello.found || sock._closed) break;
        try { setStatus("still waiting (" + Math.round((Date.now() - t0) / 1000) + "s) — host must be IN room " + room + " on the same file"); } catch (e) {}
        sock._waitHello.found = sock._waitHello.found || await LocalDiscover(room, sock, 4000);
      }
      found = (sock._waitHello && sock._waitHello.found) || null;
      sock._waitHello = null;
      if (found) {
        rec = { seed: found.seed >>> 0, type: found.type | 0, mode: found.mode | 0, pub: false, log: [] };
        LocalPutRoom(room, rec);
      }
    }
    if (!rec) {
      if (!info.create) throw new Error("room not found — nobody answered for “" + room + "” (same file + same code? both online? host still IN the room?)");
      let seed = info.seed;
      if (seed == null || seed !== (seed >>> 0)) seed = (Math.random() * 4294967296) >>> 0;
      let type = info.type | 0;
      if (!(type >= 0 && type <= 4)) type = 0;
      let mode = info.mode === 1 ? 1 : 0;
      if (type === 4) mode = 1; // oneblock (Skyblock) is always survival
      rec = { seed: seed >>> 0, type, mode, pub: !!info.pub, log: [] };
      LocalPutRoom(room, rec);
      created = true;
    }
    rec = LocalGetRoom(room) || rec;
  } else if (info.create) {
    throw new Error("room already exists — use join");
  }
  // unique sid + name among live peers (mirrors the server)
  const peers = livePeers(room);
  const takenSid = {};
  peers.forEach((p) => { takenSid[p[0]] = 1; });
  let sid = 0;
  for (let i = 0; i < 50 && !sid; i++) {
    const c = 1 + Math.floor(Math.random() * 0xFFFE);
    if (!takenSid[c]) sid = c;
  }
  if (!sid) throw new Error("room is full, try again");
  const takenNm = {};
  peers.forEach((p) => { takenNm[p[1]] = 1; });
  let nm = name0, n = 1;
  while (takenNm[nm] && n < 100) { n++; nm = name0 + n; }
  const members = peers.concat([[sid, nm]]);
  sock._room = room;
  sock._sid = sid;
  sock._name = nm;
  sock._seed = rec.seed >>> 0;
  sock._type = rec.type | 0;
  sock._mode = rec.mode | 0;
  sock._joined = true;
  sock._log = (rec.log || []).slice();
  touchPeer(room, sid, nm, sock._tab);
  sock._announce();
  return JSON.stringify({
    ok: 1, sid, seed: sock._seed, type: sock._type, mode: sock._mode,
    created: created ? 1 : 0, pub: rec.pub ? 1 : 0, members,
  });
}
// Ask live tabs/peers whether they host a room (mesh or storage-blocked case).
async function LocalDiscover(room, sock, ms) {
  if (!sock._ch && !(sock._p2p && sock._p2p.send)) return null;
  return new Promise((resolve) => {
    let done = false;
    const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms || 1200);
    sock._hiCb = (m) => {
      if (!done && m && m.room === room && m.seed !== undefined) {
        // hi echoes seed/type/mode/logLen
        done = true;
        clearTimeout(to);
        sock._hiCb = null;
        resolve({ seed: m.seed >>> 0, type: m.type | 0, mode: m.mode | 0 });
      }
    };
    try { sock._post({ k: "where-is", room, fromTab: sock._tab }); } catch (e) {}
    void room;
  });
}
async function LocalRpcList(sock) {
  const rooms = loadRooms() || {};
  for (const k in MemRooms) { if (!rooms[k]) rooms[k] = MemRooms[k]; }
  const out = [];
  for (const code in rooms) {
    const r = rooms[code];
    if (!r || !r.pub) continue;
    const selfSid = (sock._joined && sock._room === code) ? sock._sid : -1;
    let live = 0;
    const grp = LPeers[code] || {}, now = Date.now();
    for (const k in grp) {
      if (+k !== selfSid && now - grp[k].seen < LOCAL_PEER_MS) live++;
    }
    if (selfSid >= 0) live++;
    out.push({ code, type: r.type | 0, mode: r.mode | 0, players: live, builds: (r.log || []).length });
  }
  out.sort((a, b) => (b.players - a.players) || (b.builds - a.builds));
  return JSON.stringify(out.slice(0, 32));
}
async function LocalRpcPublish(sock, data) {
  if (!sock._joined) throw new Error("not in a room");
  let on = true;
  try { on = !!JSON.parse(String(data)).pub; } catch (e) {}
  const rec = LocalGetRoom(sock._room);
  if (!rec) throw new Error("not in a room");
  rec.pub = !!on;
  LocalPutRoom(sock._room, rec);
  return JSON.stringify({ ok: 1, pub: on ? 1 : 0 });
}
async function LocalRpcSync(sock) {
  if (!sock._joined) throw new Error("not in a room");
  const rec = LocalGetRoom(sock._room);
  const log = (rec && rec.log) || [];
  sock._log = log.slice();
  if (!log.length) {
    // nothing stored: ask live peers to stream what they have (storage-blocked case)
    const rid = sock._tab + "-" + Date.now().toString(36);
    try { sock._post({ k: "want-log", rid, fromTab: sock._tab }); } catch (e) {}
  }
  return buildLogFrame(log);
}
async function LocalRpcChat(sock, data) {
  if (!sock._joined) throw new Error("not in a room");
  let text;
  try { text = String(JSON.parse(String(data)).text || ""); } catch (e) { throw new Error("bad chat"); }
  text = text.replace(/[\u0000-\u001f]/g, "").trim();
  if (!text) throw new Error("empty");
  if (text.length > 200) text = text.slice(0, 200);
  sock._post({ k: "chat", name: sock._name, text });
  return "ok";
}
async function LocalRpcLeave(sock) {
  if (sock._joined) {
    try { sock._post({ k: "bye" }); } catch (e) {}
    dropPeer(sock._room, sock._sid);
  }
  try { p2pExit(sock); } catch (e) {}
  sock._joined = false;
  sock._room = "";
  sock._sid = -1;
  return "ok";
}

function closeSocket() {
  const s = R.socket;
  R.socket = null;
  R.connected = false;
  try { s && s.close(1000); } catch (e) {}
}

function teardown(reason) {
  if (R.moveTimer) { clearInterval(R.moveTimer); R.moveTimer = 0; }
  // destroy remote avatars
  try {
    if (R.eids.size && game() && game().entities) game().entities.destroy([...R.eids]);
  } catch (e) {}
  R.eids.clear();
  R.members.clear();
  R.on = false;
  R.sid = -1;
  R.pub = false;
  closeSocket();
  if (reason) toast(reason);
  refreshUI();
}

// incoming binary frame from the room topic
function onFrame(u8) {
  if (!u8 || u8.length < 1) return;
  const tag = u8[0];
  const g = game();
  if (!g || !g.entities) return;
  const sp = SP();
  if (tag === 12) {
    // edit [12][sid u16][x i32][z i32][y u16][id u16]
    if (u8.length !== 15 || !g.inWorld || !sp || !sp.active) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const x = dv.getInt32(3, true), z = dv.getInt32(7, true);
    const y = dv.getUint16(11, true), id = dv.getUint16(13, true);
    if (y > 319) return; // (see send path: u16 can't carry y < 0)
    try {
      sp.gen = true;
      g.world.setState(x, y, z, id);
    } catch (e) {} finally { try { sp.gen = false; } catch (e2) {} }
  } else if (tag === 13) {
    // move [13][sid u16][x i32][y i32][z i32][yaw i16][pitch i16][nameLen][name][skin?]
    // (skin: 0 = steve, 1 = alex; absent = legacy sender — keep parity-derived look)
    if (u8.length < 20 || u8.length > 69 || !g.inWorld) return;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sid = dv.getUint16(1, true);
    if (sid === R.sid) return; // own echo (shouldn't happen, but cheap)
    const x = dv.getInt32(3, true) / 32, y = dv.getInt32(7, true) / 32, z = dv.getInt32(11, true) / 32;
    const yaw = dv.getInt16(15, true), pitch = dv.getInt16(17, true);
    const nl = u8[19];
    let skin = null;
    if (nl === u8.length - 20) skin = null; // legacy sender
    else if (nl === u8.length - 21 && u8[20 + nl] <= 1) skin = u8[20 + nl] ? "alex" : "steve";
    else return;
    let name = "webuser";
    try { name = new TextDecoder().decode(u8.subarray(20, 20 + nl)) || "webuser"; } catch (e) {}
    upsertAvatar(sid, name, x, y, z, yaw, pitch, skin);
  } else if (tag === 14) {
    // leave [14][sid u16]
    if (u8.length !== 3) return;
    dropAvatar(new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint16(1, true), true);
  }
}

function upsertAvatar(sid, name, x, y, z, yaw, pitch, skin) {
  const g = game();
  let m = R.members.get(sid);
  if (!m || !m.eid) {
    // new sid, or a join-notice placeholder (eid 0) awaiting its first move
    const eid = REMOTE_BASE - (sid & 0xFFFF);
    try {
      g.entities.spawnPlayer({
        entityId: eid, x, y, z, yaw, pitch,
        playerUUID: uuidFor(sid, skin), currentItem: 0, metadata: {},
      });
    } catch (e) { return; }
    m = { name, eid, lastMove: 0, skin: skin || null };
    R.members.set(sid, m);
    R.eids.add(eid);
  } else if (skin && m.skin !== skin) {
    // sender changed skin mid-session: respawn so the model rebuilds
    m.skin = skin;
    try {
      g.entities.destroy([m.eid]);
      g.entities.spawnPlayer({
        entityId: m.eid, x, y, z, yaw, pitch,
        playerUUID: uuidFor(sid, skin), currentItem: 0, metadata: {},
      });
    } catch (e) {}
  }
  m.name = name;
  m.lastMove = Date.now();
  const e = g.entities.get(m.eid);
  if (!e) return;
  try {
    e.name = name;
    const dx = e.x - x, dy = e.y - y, dz = e.z - z;
    if (dx * dx + dy * dy + dz * dz > 64) {
      // teleported far: snap instead of lerping across the map
      e.x = e.newX = x; e.y = e.newY = y; e.z = e.newZ = z;
      e.prevX = x; e.prevY = y; e.prevZ = z;
    } else {
      e.newX = x; e.newY = y; e.newZ = z;
    }
    e.newYaw = yaw; e.newPitch = pitch;
    e.headYaw = yaw;
    e.inc = 4;
  } catch (err) {}
}

function dropAvatar(sid, announce) {
  const m = R.members.get(sid);
  if (!m) return;
  R.members.delete(sid);
  R.eids.delete(m.eid);
  try { game().entities.destroy([m.eid]); } catch (e) {}
  if (announce) chat("§7" + esc(m.name) + " left the realm");
  refreshUI();
}

function sendMove() {
  const g = game();
  const sp = SP();
  if (!R.on || !R.connected || !R.socket || !g || !g.inWorld || !sp || !sp.active) return;
  try {
    const p = g.player;
    if (!p) return;
    const nb0 = new TextEncoder().encode(R.name.slice(0, 24));
    const nb = nb0.length > 48 ? nb0.slice(0, 48) : nb0;
    const sk = mySkin();
    const out = new Uint8Array(19 + nb.length);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, 2);
    dv.setInt32(1, Math.round(p.x * 32), true);
    dv.setInt32(5, Math.round(p.y * 32), true);
    dv.setInt32(9, Math.round(p.z * 32), true);
    dv.setInt16(13, Math.round(p.yaw), true);
    dv.setInt16(15, Math.round(p.pitch), true);
    out[17] = nb.length;
    out.set(nb, 18);
    out[18 + nb.length] = sk === "alex" ? 1 : 0;
    R.socket.send(out);
  } catch (e) {}
}

function sendEdit(x, y, z, id) {
  if (!R.on || !R.connected || !R.socket) return;
  try {
    const out = new Uint8Array(13);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, 1);
    dv.setInt32(1, x | 0, true);
    dv.setInt32(5, z | 0, true);
    dv.setUint16(9, y & 0xFFFF, true);
    dv.setUint16(11, id & 0xFFFF, true);
    R.socket.send(out);
  } catch (e) {}
}

/* ---------------------------------------------------------- join flow */

async function withSocket(fn) {
  const s = socketFactory();
  R.socket = s;
  const fail = await new Promise((resolve) => {
    const to = setTimeout(() => resolve("connect timeout"), 15000);
    s.addEventListener("open", () => { clearTimeout(to); resolve(null); });
    s.addEventListener("close", (ev) => {
      clearTimeout(to);
      resolve("closed " + (ev.code || "") + " " + (ev.reason || ""));
    });
    s.addEventListener("error", () => {});
  });
  if (fail) {
    closeSocket();
    return { error: String(fail) };
  }
  R.connected = true;
  s.addEventListener("message", (ev) => {
    const d = ev.data;
    if (typeof d === "string") {
      let m = null;
      try { m = JSON.parse(d); } catch (e) {}
      if (!m) return;
      if (m.t === "chat" && m.sid !== R.sid) chat("§b" + esc(m.name) + "§f: " + esc(m.text));
      else if (m.t === "join" && m.sid !== R.sid && R.sid >= 0) {
        chat("§7" + esc(m.name) + " joined the realm");
        if (!R.members.has(m.sid)) R.members.set(m.sid, { name: m.name, eid: 0, lastMove: 0 });
        refreshUI();
      } else if (m.t === "leave" && m.sid !== R.sid) {
        dropAvatar(m.sid, true);
      } else if (m.t === "error") {
        toast(m.msg || "server error");
      }
    } else {
      const u8 = d instanceof Uint8Array ? d : new Uint8Array(d);
      onFrame(u8);
    }
  });
  s.addEventListener("close", (ev) => onSocketClose(ev));
  try {
    return { socket: s, value: await fn(s) };
  } catch (e) {
    return { socket: s, error: (e && e.message) || String(e) };
  }
}

function onSocketClose(ev) {
  if (!R.socket && !R.on) return; // intentional teardown
  const code = ev && ev.code;
  R.connected = false;
  if (code === 4403) {
    teardown("realms are unavailable on external sites — open this generator on perchance.org");
    return;
  }
  if (!R.on) { refreshUI(); return; }
  // unexpected drop while in a realm: try to rejoin a few times, then give up
  if (R.retries < 3 && R.code) {
    R.retries++;
    toast("connection lost, rejoining (" + R.retries + "/3)…");
    setTimeout(() => { if (R.on && R.code) rejoin(); }, 2000 * R.retries);
  } else {
    teardown("disconnected — use /realm join " + R.code + " to rejoin");
  }
}

async function rejoin() {
  const code = R.code;
  if (!code) return;
  const wasOn = R.on;
  R.on = false;
  if (R.moveTimer) { clearInterval(R.moveTimer); R.moveTimer = 0; }
  closeSocket();
  const r = await withSocket(async (s) => {
    const w = JSON.parse(await s.rpc.join(JSON.stringify({ room: code, name: R.name })));
    if (!w.ok) throw new Error(w.error || "rejoin failed");
    return w;
  });
  if (r.error || !r.value) {
    R.on = wasOn;
    toast("rejoin failed: " + (r.error || "unknown") + " — staying offline (builds are safe)");
    refreshUI();
    return;
  }
  R.sid = r.value.sid;
  R.pub = !!r.value.pub;
  R.mode = (r.value.mode | 0) === 1 ? 1 : 0;
  R.retries = 0;
  // the room may have been recreated with a different mode while we were
  // away: flip the local mirror to match (blocks untouched), mirroring the
  // entry-time migration in ensureRealmWorld.
  try {
    const wantMode = realmModeFor(R.type, R.mode);
    const sp = SP();
    if (sp && sp.active && (sp.mode | 0) !== wantMode) {
      sp.mode = wantMode;
      try { game().gameMode = wantMode; game().applyGameMode(); } catch (e) {}
      const idx = loadIndex();
      const me = idx.find((x) => x && x.realm === R.code);
      if (me) {
        me.mode = wantMode;
        try { saveI(idx); } catch (e2) {}
        try {
          const rec = loadRec(me.id);
          if (rec) { rec.mode = wantMode; saveWorldRec(me.id, rec); }
        } catch (e2) {}
      }
      toast("room mode is now " + (wantMode === 0 ? "Survival" : "Creative"));
    }
  } catch (e) {}
  await pullLog(r.socket);
  R.on = true;
  R.moveTimer = setInterval(sendMove, 100);
  toast("reconnected (" + (r.value.members ? r.value.members.length : 0) + " online)");
  refreshUI();
}

// Full build-log pull + replay (idempotent: same values re-applied).
async function pullLog(s) {
  const sp = SP();
  const g = game();
  if (!sp || !g || !g.inWorld) return;
  let batch;
  try {
    batch = await s.rpc.sync("");
  } catch (e) {
    toast("could not pull build log: " + (e && e.message));
    return 0;
  }
  const u8 = batch instanceof Uint8Array ? batch : new Uint8Array(batch);
  if (u8.length < 5 || u8[0] !== 11) return 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint32(1, true);
  let applied = 0;
  try {
    sp.gen = true;
    for (let i = 0; i < count; i++) {
      const o = 5 + i * 12;
      if (o + 12 > u8.length) break;
      const rd = new DataView(u8.buffer, u8.byteOffset + o, 12);
      const x = rd.getInt32(0, true), z = rd.getInt32(4, true);
      const y = rd.getUint16(8, true), id = rd.getUint16(10, true);
      if (y > 319) continue;
      try { g.world.setState(x, y, z, id); applied++; } catch (e) {}
    }
  } finally { try { sp.gen = false; } catch (e2) {} }
  return applied;
}

async function joinRoom(code, opts) {
  opts = opts || {};
  code = String(code || "").toLowerCase();
  if (!code) { setStatus("enter a room code"); return; }
  if (R.on || R.socket) { setStatus("already in a realm — leave first"); return; }
  setStatus("connecting…");
  R.name = myName();
  const r = await withSocket(async (s) => {
    const w = JSON.parse(await s.rpc.join(JSON.stringify({
      room: code, name: R.name,
      seed: opts.seed, type: opts.type, mode: opts.mode,
      create: !!opts.create, pub: !!opts.pub,
    })));
    if (!w.ok) throw new Error(w.error || "join failed");
    return w;
  });
  if (r.error || !r.value) {
    closeSocket();
    setStatus("join failed: " + (r.error || "unknown error"));
    toast("join failed: " + (r.error || "unknown error"));
    refreshUI();
    return;
  }
  const w = r.value;
  R.sid = w.sid;
  R.pub = !!w.pub;
  R.code = code;
  R.seed = w.seed >>> 0;
  R.type = TYPE_NAMES[w.type] || "hills";
  R.mode = (w.mode | 0) === 1 ? 1 : 0; // room mode byte: 0 creative, 1 survival
  R.retries = 0;
  const ens = ensureRealmWorld(code, R.seed, R.type, R.mode);
  if (!ens.ok) {
    closeSocket();
    R.sid = -1;
    setStatus(ens.reason);
    toast(ens.reason);
    refreshUI();
    return;
  }
  setStatus(w.created ? "room created! entering…" : "joined! entering…");
  hideUI();
  R.entering = true;
  globalThis.__mcSingleplayer.play(ens.id);
  // wait for the world, then go live
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (game() && game().inWorld && game().doneLoadingTerrain) break;
  }
  if (!game() || !game().inWorld) {
    R.entering = false;
    teardown("world failed to load — staying offline");
    return;
  }
  chat("§aRealm §f" + esc(code) + " §a— " + (R.mode === 1 ? "Survival" : "Creative") +
    ", " + w.members.length + " online. /realm invite for the link.");
  if (R.mode === 1) chat("§7Survival: no flying, watch your hunger, mobs come out at night!");
  const applied = await pullLog(r.socket);
  if (applied > 0) chat("§7replayed " + applied + " builds");
  R.on = true;
  R.entering = false;
  R.moveTimer = setInterval(sendMove, 100);
  if (globalThis.__mcOffline) {
    // say OUT LOUD which transports are up — silent fallback was undebuggable
    const mesh = R.socket && R.socket._p2p;
    if (!netPrefOn()) chat("§7cross-device is off — same-machine tabs only (tick the box in the Realms menu)");
    else if (mesh) chat("§7internet mesh on — open the same file on the other device (both online) and join §f" + esc(code));
    else chat("§cinternet mesh FAILED (" + esc(P2PLibError || "network blocked") + ") — same-machine tabs only");
  }
  refreshUI();
}

// One-button shared-room join for the Skyblock welcome screen: joins `code`
// if it exists, otherwise creates it (fixed seed/type, listed publicly).
// Throws on failure instead of writing to the Realms menu status line.
async function joinSharedRoom(code, seed, typeId) {
  code = String(code || "").toLowerCase();
  if (!code) throw new Error("missing room code");
  if (R.on || R.socket) throw new Error("already in a realm — leave first");
  R.name = myName();
  const attempt = async (create) => {
    const r = await withSocket(async (s) => {
      const w = JSON.parse(await s.rpc.join(JSON.stringify({
        room: code, name: R.name,
        seed: create ? seed : undefined, type: create ? typeId : undefined,
        mode: create ? 1 : undefined, create: !!create, pub: create ? true : undefined,
      })));
      if (!w.ok) throw new Error(w.error || "join failed");
      return w;
    });
    if (r.error || !r.value) throw new Error(r.error || "join failed");
    return r;
  };
  let r;
  try {
    r = await attempt(false);
  } catch (e) {
    if (!/room not found/i.test(String((e && e.message) || e))) throw e;
    closeSocket();
    r = await attempt(true);
  }
  const w = r.value;
  R.sid = w.sid;
  R.pub = !!w.pub;
  R.code = code;
  R.seed = w.seed >>> 0;
  R.type = TYPE_NAMES[w.type] || "hills";
  R.mode = (w.mode | 0) === 1 ? 1 : 0;
  R.retries = 0;
  const ens = ensureRealmWorld(code, R.seed, R.type, R.mode);
  if (!ens.ok) {
    closeSocket();
    R.sid = -1;
    throw new Error(ens.reason);
  }
  R.entering = true;
  globalThis.__mcSingleplayer.play(ens.id);
  for (let i = 0; i < 120; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (game() && game().inWorld && game().doneLoadingTerrain) break;
  }
  if (!game() || !game().inWorld) {
    R.entering = false;
    teardown("world failed to load — staying offline");
    throw new Error("world failed to load");
  }
  chat("§aSkyblock island §f" + esc(code) + " §a— " + w.members.length + " online. Survival: no flying — mine the block, don't fall off!");
  const applied = await pullLog(r.socket);
  if (applied > 0) chat("§7replayed " + applied + " builds");
  R.on = true;
  R.entering = false;
  R.moveTimer = setInterval(sendMove, 100);
  refreshUI();
}

function leaveRealm(stayInWorld) {
  if (!R.on && !R.socket) return;
  // floating RPC: never let a close/disconnect rejection surface (cf. voice)
  try { const _lp = R.socket && R.socket.rpc.leave(""); if (_lp && _lp.catch) _lp.catch(function () {}); } catch (e) {}
  const code = R.code;
  R.code = "";
  teardown("left realm " + code + (stayInWorld === false ? "" : " (world stays open offline)"));
}

// Toggle the public flag on the room we're in (listed in the browser).
async function setPublic(on) {
  if (!R.socket || !R.connected) { toast("not connected to a realm"); return; }
  try {
    const r = JSON.parse(await R.socket.rpc.publish(JSON.stringify({ pub: !!on })));
    R.pub = !!r.pub;
    toast(R.pub ? "room is now listed publicly" : "room is now unlisted");
    refreshUI();
  } catch (e) { toast("publish failed: " + (e && e.message)); }
}

// Fetch the public room list on a throwaway socket (no join needed).
async function refreshPublicList() {
  pubListMsg = "loading…";
  pubListData = [];
  let s = null;
  try {
    s = socketFactory();
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("timeout")), 15000);
      s.addEventListener("open", () => { clearTimeout(to); res(); });
      s.addEventListener("close", () => { clearTimeout(to); rej(new Error("closed")); });
      s.addEventListener("error", () => {});
    });
    const list = JSON.parse(await s.rpc.list(""));
    renderPublicList(list);
  } catch (e) {
    pubListMsg = "browse failed: " + ((e && e.message) || e);
  }
  try { s && s.close(1000); } catch (e) {}
}

function renderPublicList(list) {
  // data only: the native Browse tab renders pubListData/pubListMsg live
  pubListData = Array.isArray(list) ? list : [];
  pubListMsg = pubListData.length ? "" : "no public rooms right now \u2014 create one and tick \u201clist publicly\u201d!";
}
function buildUI() {
  try { syncNSTFromUI(); } catch (e) {}
}

function createOrJoin(code, seedRaw, type, create, opts) {
  if (!/^[a-z0-9-]{1,24}$/.test(code)) {
    setStatus("room code: a-z, 0-9, -, max 24 chars");
    return;
  }
  try { setMyName((((opts && opts.name != null) ? opts.name : (NST && NST.name)) || myName() || "").trim().slice(0, 16)); } catch (e) {}
  let seed = null;
  if (create && seedRaw) {
    if (/^-?\d+$/.test(seedRaw)) seed = parseInt(seedRaw, 10) >>> 0;
    else {
      let h = 2166136261;
      for (let i = 0; i < seedRaw.length; i++) { h ^= seedRaw.charCodeAt(i); h = Math.imul(h, 16777619); }
      seed = h >>> 0;
    }
  }
  let pub = false;
  try { pub = (opts && opts.pub != null) ? !!opts.pub : (create && !!((NST && NST.pub) || R.pub)); } catch (e) {}
  let mode = 0;
  try { mode = (opts && opts.mode != null) ? opts.mode : (create && NST && NST.mode === 1 ? 1 : 0); } catch (e) {}
  joinRoom(code, { seed, type: TYPES[type] != null ? TYPES[type] : 0, mode, create, pub });
}

function copyInvite() {
  const code = ((NST && NST.code) || R.code || "").trim().toLowerCase();
  if (!code) { setStatus("enter a room code first"); return; }
  if (globalThis.__mcOffline) {
    const done = () => setStatus("room code copied — enter it on the other device (both online) or another tab here");
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done);
      else done();
    } catch (e) { done(); }
    return;
  }
  let url = "";
  try { url = "https://perchance.org/" + window.generatorName + "#realm=" + code; } catch (e) {}
  if (!url) { setStatus("could not build invite link"); return; }
  const done = () => setStatus("invite link copied — send it to your friends");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => setStatus(url));
    else setStatus(url);
  } catch (e) { setStatus(url); }
}

function setStatus(s) {
  // the native configure screen renders lastStatus live every frame
  try { lastStatus = String(s || ""); } catch (e) {}
}
// Live state mirrored for the native configure screen (which reads these
// directly every frame instead of touching the DOM).
let lastStatus = "";
let pubListData = [];
let pubListMsg = "";
function rosterNames() {
  try {
    const names = [...R.members.values()].map((m) => m.name);
    if (R.sid >= 0) names.unshift(R.name + " (you)");
    return names;
  } catch (e) { return []; }
}
function transportText() {
  try {
    if (!globalThis.__mcOffline) return "";
    if (!netPrefOn()) return "transport: local tabs only (cross-device off)";
    if (P2PLib) return "transport: internet mesh ready" + ((R.socket && R.socket._p2p) ? " (this room)" : " (not in a room)");
    return "transport: internet mesh " + (P2PLibError ? "FAILED: " + P2PLibError : "loading…");
  } catch (e) { return ""; }
}
function slotRooms() {
  try {
    return loadIndex().filter((x) => x && x.realm)
      .sort((a, b) => (b.modified || 0) - (a.modified || 0)).slice(0, 4);
  } catch (e) { return []; }
}
function showUI() {
  buildUI(); // seeds the shared native form state (hash + room)
  if (openNativeConfigure()) return;
  // No DOM fallback: the title button that opens this is engine-rendered,
  // so the engine is always harvestable here.
  try { console.error("[realms] native configure unavailable"); } catch (e) {}
}
function hideUI() {
  try {
    const ng = globalThis.__mcNativeGui;
    if (ng && rmNativeOpen()) ng.dismiss();
  } catch (e) {}
}
// Native engine confirm dialog (real dirt + MC buttons). Declines when
// the engine is not harvestable (no DOM fallback).
function nativeConfirm(o) {
  try {
    const ng = globalThis.__mcNativeGui;
    if (ng && typeof ng.confirm === "function") {
      const p = ng.confirm(o);
      if (p) return p;
    }
  } catch (e) {}
  // No DOM fallback: without a harvestable engine no native menu could
  // be open either, so decline (never reset anything blindly).
  return Promise.resolve(false);
}
// End of network churn: the native configure screen renders roster,
// status and slots live every frame, so there is nothing to repaint.
function refreshUI() {}

/* ---------------- native configure screen (desktop; touch keeps HTML) ---------------- */

let NST = null; // form state shared across rebuilds/reopens
// The live configure screen is identified by marker, not by reference: the
// engine calls onClose() on the outgoing screen for every nested open, so a
// saved reference would go stale the first time a confirm stacks over it.
function rmNativeOpen() {
  try {
    const ng = globalThis.__mcNativeGui;
    const t = ng && ng.top && ng.top();
    return !!(t && t._isRmConfigure);
  } catch (e) { return false; }
}
const NC_TYPES = ["voxel", "hills", "flat", "void", "oneblock"];
const NC_TYPE_LABEL = { voxel: "Terralith", hills: "Classic", flat: "Superflat", void: "Void", oneblock: "Skyblock" };

function nativeCapable() {
  try {
    const ng = globalThis.__mcNativeGui;
    return !!(ng && ng.base && ng.button && ng.List && ng.Field && ng.Keyboard && ng.open && ng.dismiss);
  } catch (e) { return false; }
}

function syncNSTFromUI() {
  // Seeds the shared native form state. No DOM: the native screen owns
  // every field, and NST persists across its rebuilds/reopens.
  const m = (location.hash || "").match(/realm=([a-z0-9-]{1,24})/i);
  let code = "";
  if (R.code) code = R.code;
  else if (m && !code) code = m[1].toLowerCase();
  if (!NST) {
    NST = { tab: "settings", name: "", code: "", seed: "", type: "voxel", mode: 1, pub: false, net: true };
  } else {
    if (R.code) NST.code = R.code;
  }
  NST.name = myName();
  if (!code && !NST.code) NST.code = "";
  else if (code) NST.code = code;
}
function doResetWorld() {
  try {
    const idx = loadIndex();
    const e = idx.find((x) => x && x.realm === R.code);
    if (e) {
      const rec = loadRec(e.id);
      if (rec) { rec.overrides = {}; saveWorldRec(e.id, rec); }
      e.edits = 0;
      try { saveI(idx); } catch (err) {}
      setStatus("local builds cleared — leave and rejoin to re-sync");
      toast("local builds cleared");
    } else setStatus("no local copy found");
  } catch (err) { setStatus("reset failed"); }
}

function resetFromNative() {
  if (!R.on && !R.socket) { setStatus("join a room first"); return; }
  // the dialog stack nests the confirm over the configure screen
  nativeConfirm({
    title: "Reset the local copy of this room?",
    lines: ["Your builds in it will be lost."],
    okLabel: "Reset", cancelLabel: "Cancel",
  }).then((ok) => { if (ok) doResetWorld(); });
}

function ncPubRow(r) {
  const players = (r.players | 0) + " online";
  const builds = (r.builds | 0) + " builds";
  return r.code + " · " + (TYPE_NAMES[r.type] || "?") + " · " +
    (((r.mode | 0) === 1) ? "Survival" : "Creative") + " · " + players + " · " + builds;
}

function openNativeConfigure() {
  try {
    const ng = globalThis.__mcNativeGui;
    // never stack configures: drop the live one first (reopen refreshes it)
    try { if (rmNativeOpen()) ng.dismiss(); } catch (e) {}
    const Base = ng.base(), Btn = ng.button(), List = ng.List, Field = ng.Field, Keyboard = ng.Keyboard;
    const g = game();
    if (!Base || !Btn || !List || !Field || !Keyboard || !g) return false;
    syncNSTFromUI();
    const OFF = !!globalThis.__mcOffline;
    const scr = new (class extends Base {
      constructor(gg) {
        super(gg);
        this.background = "dirt";
        this._isRmConfigure = true;
        this._lists = [];
        this._mx = -1; this._my = -1;
      }
      onClose() {} // note: the engine also calls this on nested opens; rmNativeOpen() is the live check
      close() { try { hideUI(); } catch (e) {} }
      init() {
        this.buttons = []; this.fields = []; this._lists = [];
        this._labels = []; this._infoY = 0;
        this._fCode = null;
        this._kb = new Keyboard({
          target: () => {
            for (const f of [this._fName, this._fCode, this._fSeed]) {
              if (f && f.focused) return f;
            }
            return null;
          },
          onDone: () => { try { this._kb.visible = false; } catch (e) {} },
        });
        this._kbRegs = [];
        const W = this.width, H = this.height, cx = Math.floor(W / 2);
        const compact = H < 400;
        const panelW = Math.min(360, W - 16);
        const px = cx - Math.floor(panelW / 2);
        const self = this;
        const mkBtn = (id, x, y, w, label, cb) => {
          const b = new Btn(id, x, y, w, 20, label, () => { try { cb(); } catch (e) {} });
          this.buttons.push(b); return b;
        };
        // tabs
        const tabW = Math.min(120, Math.floor((panelW - 8) / 3));
        const tx0 = cx - Math.floor((3 * tabW + 8) / 2);
        ["players", "settings", "browse"].forEach((t, i) => {
          const names = { players: "Players", settings: "Settings", browse: "Browse" };
          const b = mkBtn(10 + i, tx0 + i * (tabW + 4), 34, tabW, names[t], () => {
            NST.tab = t; try { self.init(); } catch (e) {}
          });
          if (NST.tab === t) b.enabled = false; // active tab looks pressed
        });
        // worlds slots (hidden on the Settings tab on short screens: the
        // slots + the form can't both fit above the bottom bar there, and
        // the code field already selects the room)
        this._slotRows = slotRooms();
        const showSlots = NST.tab !== "settings" || !compact;
        this._showSlots = showSlots;
        const slotH = compact ? 44 : 84, rowH = 20;
        let PT;
        if (showSlots) {
          const slots = new List({
            x: px, y: 70, w: panelW, h: slotH, rowH: rowH,
          rows: () => this._slotRows.map((r) => {
            let s = r.realm || "?";
            if (r.mode === 1) s += " · Survival";
            else if (r.mode === 0) s += " · Creative";
            return s;
          }),
          emptyText: "No realms yet",
          selected: (i) => {
            const r = this._slotRows[i];
            return !!r && (r.realm || "") === (NST.code || "").trim().toLowerCase();
          },
          onClick: (i, dbl) => {
            const r = this._slotRows[i];
            if (!r) return;
            NST.code = r.realm || "";
            try { if (this._fCode) this._fCode.setText(NST.code); } catch (e) {}
            if (dbl && NST.code) joinRoom(NST.code.toLowerCase(), {});
          },
        });
          this._lists.push(slots);
          this._slotsList = slots;
          this._kbRegs.push({ o: slots, p: "y", base: 70 });
          PT = 70 + slotH + 12;
        } else {
          this._slotsList = null;
          PT = 64;
        }
        const bottomY = H - 32;
        if (NST.tab === "players") this._buildPlayers(px, panelW, PT, bottomY, mkBtn, List);
        else if (NST.tab === "browse") this._buildBrowse(px, panelW, PT, bottomY, mkBtn, List, OFF);
        else this._buildSettings(px, panelW, PT, bottomY, mkBtn, Field, List, OFF, compact);
        // bottom bar
        const bw = Math.min(104, Math.floor((panelW - 18) / 4));
        const bx0 = cx - Math.floor((4 * bw + 18) / 2);
        const bbY = bottomY;
        const bbBtns = [
          mkBtn(40, bx0, bbY, bw, "World options", () => {
            NST.tab = "settings"; try { self.init(); } catch (e) {}
          }),
          mkBtn(41, bx0 + bw + 6, bbY, bw, "World backups", () => {
            if (!R.socket || !R.connected) { setStatus("join a room first — backups publish it publicly"); return; }
            setPublic(!R.pub);
          }),
          mkBtn(42, bx0 + 2 * (bw + 6), bbY, bw, "Reset", () => resetFromNative()),
          mkBtn(43, bx0 + 3 * (bw + 6), bbY, bw, "Back", () => { try { hideUI(); } catch (e) {} }),
        ];
        for (const b of bbBtns) this._kbRegs.push({ o: b, p: "y", base: bbY });
        for (const b of this.buttons) this._kbRegs.push({ o: b, p: "y", base: b.y });
        for (const f of this.fields) this._kbRegs.push({ o: f, p: "y", base: f.y });
        this._kb.track(this._kbRegs);
      }
      _buildPlayers(px, panelW, PT, bottomY, mkBtn, List) {
        const self = this;
        const listY = PT + 4, btnY = bottomY - 30;
        const roster = new List({
          x: px, y: listY, w: panelW, h: Math.max(50, btnY - 6 - listY), rowH: 16,
          rows: () => rosterNames(),
          emptyText: "No one here yet",
          selected: () => false,
          onClick: () => {},
        });
        this._lists.push(roster);
        this._kbRegs.push({ o: roster, p: "y", base: listY });
        const bw = Math.floor((panelW - 6) / 2);
        this._inviteBtn = mkBtn(20, px, btnY, bw, "Invite", () => copyInvite());
        this._leaveBtn = mkBtn(21, px + bw + 6, btnY, panelW - bw - 6, "Leave", () => leaveRealm(true));
        this._playersGeom = { px, bw, full: panelW };
      }
      _buildBrowse(px, panelW, PT, bottomY, mkBtn, List, OFF) {
        const listY = PT + 30, hintY = bottomY - 12;
        mkBtn(22, px, PT, panelW, OFF ? "Browse (this computer)" : "Browse public rooms",
          () => refreshPublicList());
        const pub = new List({
          x: px, y: listY, w: panelW, h: Math.max(50, hintY - 12 - listY), rowH: 18,
          rows: () => (pubListData || []).map((r) => ncPubRow(r)),
          emptyText: pubListMsg || "press Browse",
          selected: (i) => {
            const r = (pubListData || [])[i];
            return !!r && (r.code || "") === (NST.code || "").trim().toLowerCase();
          },
          onClick: (i, dbl) => {
            const r = (pubListData || [])[i];
            if (!r) return;
            NST.code = r.code || "";
            try { if (this._fCode) this._fCode.setText(NST.code); } catch (e) {}
            if (dbl && NST.code) joinRoom(NST.code.toLowerCase(), {});
          },
        });
        this._lists.push(pub);
        this._kbRegs.push({ o: pub, p: "y", base: listY });
      }
      _buildSettings(px, panelW, PT, bottomY, mkBtn, Field, List, OFF, compact) {
        const self = this;
        let y = PT;
        const gap = compact ? 4 : 6;
        const lab = (s) => { this._labels = this._labels || []; this._labels.push({ s, y }); };
        const fld = (o) => {
          const f = new Field(px + (o.x || 0), o.y, o.w, 20, o.o);
          this.fields.push(f);
          this._kbRegs.push({ o: f, p: "y", base: o.y });
          return f;
        };
        if (!compact) { lab("Your name"); y += 10; }
        this._fName = fld({ y, w: panelW, o: {
          text: NST.name, maxLength: 16,
          placeholder: compact ? "Your name" : "",
          onChange: (t) => { NST.name = t; try { setMyName(t.trim()); } catch (e) {} },
        }});
        y += 20 + gap;
        if (!compact) { lab("Room code (share it with friends)"); y += 10; }
        this._fCode = fld({ y, w: panelW, o: {
          text: NST.code, maxLength: 24,
          placeholder: compact ? "Room code (share it)" : "",
          onChange: (t) => { NST.code = t; },
        }});
        y += 20 + gap;
        const hw = Math.floor((panelW - 8) / 2);
        if (!compact) { lab("Seed (create only)"); }
        else { this._labels = this._labels || []; this._labels.push({ s: "Seed", y }); }
        this._labels.push({ s: "World", y, right: true });
        this._fSeed = fld({ y: compact ? y + 10 : y + 10, w: hw, o: {
          text: NST.seed, maxLength: 32,
          placeholder: compact ? "blank = random" : "",
          onChange: (t) => { NST.seed = t; },
        }});
        const typeBtn = mkBtn(30, px + hw + 8, y + (compact ? 10 : 10), panelW - hw - 8,
          () => "World: " + (NC_TYPE_LABEL[NST.type] || NST.type), () => {
            const i = NC_TYPES.indexOf(NST.type);
            NST.type = NC_TYPES[(i + 1 + NC_TYPES.length) % NC_TYPES.length];
          });
        void typeBtn;
        y += 30 + gap;
        mkBtn(31, px, y, hw, () => "Mode: " + (NST.mode === 1 ? "Survival" : "Creative"), () => {
          NST.mode = NST.mode === 1 ? 0 : 1;
        });
        mkBtn(32, px + hw + 8, y, panelW - hw - 8, () => "List publicly: " + (NST.pub ? "ON" : "OFF"), () => {
          NST.pub = !NST.pub;
        });
        y += 20 + gap;
        if (OFF) {
          mkBtn(33, px, y, panelW, () => "Cross-device: " + (NST.net ? "ON" : "OFF"), () => {
            NST.net = !NST.net;
            try { setNetPref(NST.net); } catch (e) {}
          });
          y += 20 + gap;
        }
        const bw2 = Math.floor((panelW - 6) / 2);
        mkBtn(34, px, y, bw2, "Create room", () => {
          createOrJoin((NST.code || "").trim().toLowerCase(), (NST.seed || "").trim(),
            NST.type, true, { name: NST.name, mode: NST.mode, pub: NST.pub });
        });
        mkBtn(35, px + bw2 + 6, y, panelW - bw2 - 6, "Join room", () => {
          createOrJoin((NST.code || "").trim().toLowerCase(), "", "hills", false, { name: NST.name });
        });
        y += 20 + 6;
        this._infoY = y;
      }
      tick() {
        try { super.tick(); } catch (e) {}
        try {
          this._kbS = this._kb.fitShift(8);
          this._kb.applyTick(this._kbS);
        } catch (e) {}
        try {
          if (this._leaveBtn) this._leaveBtn.visible = !!(R.on || R.socket);
        } catch (e) {}
        // No room for a lone half-width Invite: stretch it full width when
        // Leave is hidden (not in a room).
        try {
          if (this._inviteBtn && this._leaveBtn && this._playersGeom) {
            const g = this._playersGeom;
            if (!this._leaveBtn.visible) {
              this._inviteBtn.x = g.px; this._inviteBtn.w = g.full;
            } else {
              this._inviteBtn.x = g.px; this._inviteBtn.w = g.bw;
            }
          }
        } catch (e) {}
        try { this._kb.hideCovered(this.buttons); } catch (e) {}
      }
      mouseDown(x, y, b, i) {
        try { if (this._kb && this._kb.mouseDown(x, y)) return true; } catch (e) {}
        try {
          if (super.mouseDown(x, y, b)) {
            this._kb.syncTouch(!!(this._kb.targetFn && this._kb.targetFn()), x, y);
            return true;
          }
        } catch (e) {}
        try {
          for (const L of this._lists) if (L.mouseDown(x, y, b)) { this._kb.syncTouch(false, x, y); return true; }
        } catch (e) {}
        try { this._kb.syncTouch(false, x, y); } catch (e2) {}
        return false;
      }
      mouseUp() {
        try { super.mouseUp(); } catch (e) {}
        try { for (const L of this._lists) L.mouseUp(); } catch (e) {}
      }
      mouseMove(x, y) {
        try { for (const L of this._lists) L.mouseMove(x, y); } catch (e) {}
      }
      wheel(d) {
        try {
          for (const L of this._lists) {
            if (L.inside(this._mx, this._my)) { L.wheel(d, this._mx, this._my); return true; }
          }
          if (this._lists.length) this._lists[0].wheel(d);
          return true;
        } catch (e) {}
        return false;
      }
      renderContent(t, mx, my) {
        this._mx = mx; this._my = my;
        const cx = Math.floor(this.width / 2);
        const panelW = Math.min(360, this.width - 16);
        const px = cx - Math.floor(panelW / 2);
        t.textCentered("Configure realm", cx, 8, 16777215);
        let head = "—";
        try { head = R.code ? R.code + (R.mode === 1 ? " · Survival" : " · Creative") : "—"; } catch (e) {}
        t.textCentered(head, cx, 20, 8173312);
        if (this._showSlots !== false) {
          t.text("Worlds", px, 58 - (this._kbS || 0), 8421504);
        }
        try {
          for (const L of this._lists) L.render(t, mx, my);
        } catch (e) {}
        if (this._labels) {
          for (const l of this._labels) {
            try {
              const lx = l.right ? px + panelW - t.textWidth(l.s) : px;
              t.text(l.s, lx, l.y - (this._kbS || 0), 8421504);
            } catch (e) {}
          }
        }
        if (NST.tab === "sub") {
          try {
            const rows = t.font ? t.font.wrap("Realm subscriptions are not used here — rooms on this generator are free.", panelW) : [""];
            let y = Math.floor(this.height / 2) - 10;
            for (const r of rows.slice(0, 4)) { t.textCentered(r, cx, y, 10526880); y += 12; }
          } catch (e) {}
        }
        if (NST.tab === "browse") {
          try { t.textCentered("double-click a room to join it", cx, this.height - 44 - (this._kbS || 0), 8421504); } catch (e) {}
        }
        if (this._infoY) {
          try {
            const compact = this.height < 400;
            const sh = this._kbS || 0;
            if (compact) {
              const msg = lastStatus || transportText();
              if (msg) t.textCentered(t.font ? t.font.trimToWidth(msg, panelW) : msg, cx, this._infoY - sh, 16777113);
            } else {
              if (lastStatus) t.textCentered(t.font ? t.font.trimToWidth(lastStatus, panelW) : lastStatus, cx, this._infoY - sh, 16777113);
              const tr = transportText();
              if (tr) t.textCentered(t.font ? t.font.trimToWidth(tr, panelW) : tr, cx, this._infoY + 12 - sh, 0xFF88AADD);
            }
          } catch (e) {}
        }
        try {
          this._kb.layout(this.width, this.height);
          this._kb.render(t);
        } catch (e) {}
      }
    })(g);
    if (!ng.open(scr)) return false;
    return true;
  } catch (e) { return false; }
}

/* ---------------------------------------------------------- hooks */

function installPatches() {
  const g = game();
  // 1) enable the Realms title button
  const patchTitle = () => {
    try {
      const cur = g.screens.current;
      if (!cur || !cur.buttons) return;
      if (!cur._rmInitHooked) {
        // The render loop calls current.onResize() on resize, which wipes
        // buttons/fields and re-runs init() on the SAME object (fresh
        // disabled buttons). Wrapping init re-applies our wiring in the
        // same frame, so the button never flashes dark waiting for a poll.
        cur._rmInitHooked = true;
        const origInit = cur.init;
        cur.init = function () {
          const r = origInit.call(this);
          try { patchTitle(); } catch (e) {}
          return r;
        };
      }
      const b = cur.buttons.find((x) => x && (x.label || x.text) === "Minecraft Realms");
      if (b && b.enabled === false) {
        b.enabled = true;
        b.onClick = function () { showUI(); };
        b._rmWired = true;
      } else if (b && b._rmWired) {
        return;
      }
    } catch (e) {}
  };
  try {
    const screens = g.screens;
    const origOpen = screens.open.bind(screens);
    screens.open = function (screen) {
      const r = origOpen(screen);
      try { patchTitle(); } catch (e) {}
      return r;
    };
  } catch (e) {}
  patchTitle();
  // Fallback poll: brand-new title objects get wired by the hooks above
  // (screens.open + init wrap); this only catches anything that slipped
  // through, e.g. slower loads that rebuild the title later.
  if (!g._rmTitlePoll) {
    g._rmTitlePoll = setInterval(() => {
      try { patchTitle(); } catch (e) {}
    }, 2000);
  }

  // 2) broadcast local edits (SP's own wrapper records them; we only relay).
  //    SP.gen is true while streaming chunks or applying remote edits — never send those.
  try {
    const w = g.world;
    if (w && !w._rmPatched) {
      w._rmPatched = true;
      const orig = w.setState.bind(w);
      w.setState = function (x, y, z, state) {
        const r = orig(x, y, z, state);
        try {
          const sp = SP();
          if (R.on && sp && sp.active && !sp.gen && y >= 0 && y <= 319 && (state | 0) <= 0xFFFF) {
            sendEdit(x, y, z, state | 0);
          }
        } catch (e) {}
        return r;
      };
    }
  } catch (e) {}

  // 3) chat: /realm commands + relay plain messages; wrap SP's handler.
  try {
    const api = globalThis.__mcSingleplayer;
    if (api && !api._rmChatPatched) {
      api._rmChatPatched = true;
      const origChat = api.chat.bind(api);
      api.chat = function (msg) {
        const m = String(msg == null ? "" : msg);
        if (R.on && m[0] === "/" && m.slice(1, 6).toLowerCase() === "realm") {
          realmCommand(m.slice(6).trim());
          return;
        }
        if (R.on && m && m[0] !== "/") {
          // relay to room (+ local echo); server stamps names on relay,
          // we ignore our own sid coming back
          try { const _cp = R.socket.rpc.chat(JSON.stringify({ text: m.slice(0, 200) })); if (_cp && _cp.catch) _cp.catch(function () { toast("chat failed (offline?)"); }); } catch (e) { toast("chat failed (offline?)"); }
          chat("§b" + esc(R.name) + "§f: " + esc(m.slice(0, 200)));
          return;
        }
        return origChat(msg);
      };
    }
  } catch (e) {}

  // 4) leaving the world (pause Disconnect / MP join) ends the realm too
  try {
    if (!g._rmLeavePatched) {
      g._rmLeavePatched = true;
      const origLeave = g.leaveWorld.bind(g);
      g.leaveWorld = function () {
        try { if ((R.on || R.socket) && !R.entering) { R.code = ""; teardown(""); } } catch (e) {}
        return origLeave();
      };
    }
  } catch (e) {}
}

function realmCommand(rest) {
  const parts = rest.split(/\s+/).filter(Boolean);
  const cmd = (parts[0] || "help").toLowerCase();
  if (cmd === "leave") leaveRealm(true);
  else if (cmd === "players" || cmd === "list") {
    const names = [...R.members.values()].map((m) => m.name);
    names.unshift(R.name + " (you)");
    chat("§7Online (" + names.length + "): " + esc(names.join(", ")));
  } else if (cmd === "invite") {
    copyInvite();
    try { if (lastStatus) chat("§7" + esc(lastStatus)); } catch (e) {}
  } else if (cmd === "join" && parts[1]) {
    if (R.on) toast("already in a realm — /realm leave first");
    else joinRoom(parts[1].toLowerCase(), {});
  } else if (cmd === "publish") {
    setPublic(true);
  } else if (cmd === "unpublish" || cmd === "unlist") {
    setPublic(false);
  } else {
    chat("§7/realm players · /realm invite · /realm publish|unpublish · /realm leave · /realm join <code>");
  }
}

/* ---------------------------------------------------------- boot */

function boot() {
  // Title wiring (button enable + init-wrap) needs only game+screens, so
  // install it ASAP: a resize-driven title init() reset before the old
  // SP-gated boot left buttons dark until a 2s poll tick. Everything that
  // touches singleplayer state stays lazy/guarded (chat wrap checks the
  // api, join/chat paths resolve SP() at call time).
  if (!globalThis.game || !globalThis.game.screens || !globalThis.game.world) {
    setTimeout(boot, 100);
    return;
  }
  try { installPatches(); } catch (e) { console.error("[realms] patch failed", e); }
  try { buildUI(); } catch (e) {}
  // auto-open when arriving via an invite link
  try {
    if ((location.hash || "").match(/realm=([a-z0-9-]{1,24})/i)) showUI();
  } catch (e) {}
  globalThis.__mcRealms = {
    ui: showUI,
    join: (code) => joinRoom(String(code).toLowerCase(), {}),
    joinShared: (code, seed, typeId) => joinSharedRoom(String(code).toLowerCase(), seed, typeId),
    leave: () => leaveRealm(true),
    socket: () => socketFactory(),
    // test/diagnosis hooks for the offline transports (not used by the game)
    test: {
      enterP2P: (sock, code) => p2pEnter(sock, code),
      recvP2P: (sock, d, pid) => p2pRecv(sock, d, pid),
      b64: (buf) => bufToB64(buf),
      unb64: (b64) => b64ToBuf(b64),
      hash: (log) => logHash(log),
    },
    get state() { return R; },
  };
  console.log("[realms] ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();

