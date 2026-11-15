/* MCJS Voice: proximity voice chat on EXTERNAL multiplayer servers.
 * (1.15.2 port of the 1.13.2 layer — protocol touchpoints adapted, see
 * notes on EV_PKT_ID and evHookGame below; all signaling/WebRTC unchanged.)
 *
 * Eaglercraft-style push-to-talk walkie-talkie between players running THIS
 * client, PLUS an Eagler-compatible mode: when the server runs a backend
 * that speaks Eagler's V1 voice RPC on the vanilla plugin channel
 * ("eagler:1-8-voice-rpc"), we announce ourselves (register + INIT Capable),
 * join the server's voice channel and trade standard WebRTC/Opus audio with
 * Eagler players on that channel. Audio is peer-to-peer either way; only
 * the tiny SDP/ICE signaling notes go through a server.
 *
 * Two transports, one panel:
 *   (a) MCJS rooms (default): our server-plugin relays signaling for the
 *       room "v1:<host>:<port>". Works on ANY external server, no server
 *       changes needed — but only between THIS client's players.
 *   (b) Eagler V1 (when detected): signaling rides the game connection
 *       itself as plugin messages, so Eagler players on the same backend
 *       server and voice channel show up in the panel like anyone else.
 *       Stock Eagler backends only track Eagler-protocol connections, so a
 *       small bridge plugin is needed server-side to include vanilla 1.13.2
 *       clients — see src/eagler-bridge/. Without one, (b) quietly stays
 *       idle and (a) works as before.
 * Bridge tab: opening this generator with ?voicebridge=<host>:<port>&name=X
 * boots voice ONLY (no game). An Eagler player on that same server opens
 * the link on any device, taps JOIN, and talks with our players (matched
 * by name for proximity). No protocol interop needed — pure WebRTC.
 *
 * How it works: when you join someone else's server, a small voice panel
 * appears. Press JOIN (a browser mic prompt follows — nothing is recorded
 * before you approve). Everyone in the panel who is also on that server
 * connects browser-to-browser (WebRTC, Opus audio). You hear players near
 * you in the game world (<= VOICE_RANGE blocks, louder when closer); far
 * players fade out.
 *
 * Controls: hold V (or hold the MIC button) to talk in PTT mode, or switch
 * to OPEN mic. Click a peer's speaker to mute just them.
 */
(function () {
"use strict";

var VOICE_RANGE = 40;
var STUN_URLS = ["stun:stun.l.google.com:19302"];
var PTT_CODE = "KeyV";
var TICK_MS = 250;

var V = {
  mode: "off", // off | joining | on
  socket: null,
  sid: 0,
  name: "",
  room: "",
  peers: {}, // sid -> {sid,name,uuid,pc,gain,analyser,level,muted,state,stream}
  micStream: null,
  micTrack: null,
  audioCtx: null,
  micMuted: false,   // hard mute (MIC button)
  openMic: false,    // else push-to-talk
  pttHeld: false,
  ui: null,
  timers: [],
   retryAt: 0,
   status: "",
   fakeExt: null, // test hook: pretend this server is external
   bridgeName: "", // ?voicebridge name override (companion tab has no game)
   abText: "", abAt: 0, // action-bar speaker line state
   voiceScr: null, // open native voice menu screen
   _nAt: 0, // last engine-screen N/Escape handling (de-dupes window key path)
  ev: { // Eagler V1 backend-voice state (plugin-message transport)
    phase: "idle", // idle | wait | v1 | down
    room: "",      // "host:port" this detection belongs to
    noted: "",     // room already announced as eagler-capable (one notice each)
    synced: false,  // initial roster fill done (later names are real joins)
    timer: 0,       // wait-timeout id
    ice: null,      // [{urls,username,credential}] from server, or null
    overrideIce: false,
    peers: {},      // uuidKey -> {key,name,pc,gain,analyser,level,muted,state,stream,requested,pendIce,pendRemote}
    requested: {},  // uuidKey -> true (ConnectPeer sent)
    wantOn: false,  // JOIN was pressed while ev capable
  },
};

/* ---------------- environment ---------------- */

function gameObj() {
  try { return globalThis.game || null; } catch (e) { return null; }
}

// External multiplayer server (NOT singleplayer, NOT a realm/shared mirror:
// those all run through playWorldInner with host "singleplayer").
// File builds join external servers directly and use the mesh transport
// below, so there is intentionally no __mcOffline gate here.
function externalServer() {
  if (V.fakeExt) return V.fakeExt;
  try {
    var g = gameObj();
    if (!g || !g.inWorld) return null;
    var sa = g.serverAddress;
    if (!sa || !sa.host || sa.host === "singleplayer") return null;
    return { host: String(sa.host), port: sa.port | 0 };
  } catch (e) { return null; }
}

function roomKey(ext) {
  return "v1:" + ext.host + ":" + ext.port;
}

function socketFactory() {
  var r = null;
  try { r = globalThis.root || window.root; } catch (e) {}
  if (r && typeof r.createServerSocket === "function") return r.createServerSocket();
  if (typeof globalThis.createServerSocket === "function") return globalThis.createServerSocket();
  throw new Error("server plugin not available");
}

/* ---------------- mesh voice transport (file builds, no server) -----------
 * The production server-plugin socket only works on perchance.org (4403
 * elsewhere), so a downloaded file can never use voiceJoin/voiceLeave/vsig
 * through it. When socketFactory() throws we fall back to the same Trystero
 * WebRTC mesh the Realms file build uses for cross-device rooms: same room
 * key ("v1:<host>:<port>"), same roster + vsig envelopes, same Opus audio.
 * Needs internet for the tracker intro only; audio stays browser-to-browser.
 * Only THIS client's players meet here (like the server rooms); Eagler V1
 * backend voice above is untouched and still bridges Eagler players.
 *
 * Offer discipline (glare-free): for every peer pair exactly the LOWER sid
 * offers — at members processing and at late-hello time (see joinVoice and
 * onSocketMsg, both gated on V.mesh so the server path is unchanged).
 */

var MESH_VOICE_LIB_URL = "https://esm.sh/trystero@0.26.0";
var MESH_VOICE_APP = "mcjs-voice-v1";
var MESH_VOICE_WINDOW_MS = 2500;
var MeshVoiceLib = null, MeshVoiceLibFailAt = 0;

async function meshVoiceLib() {
  if (MeshVoiceLib) return MeshVoiceLib;
  if (Date.now() - MeshVoiceLibFailAt < 120000) return null;
  try {
    var L = await import(MESH_VOICE_LIB_URL);
    if (!L || typeof L.joinRoom !== "function") throw new Error("bad lib");
    MeshVoiceLib = L;
    return L;
  } catch (e) { MeshVoiceLib = null; MeshVoiceLibFailAt = Date.now(); return null; }
}

function meshVoiceRoomName(room) {
  return "vv-" + String(room || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 48);
}

// Socket-like facade speaking the server's voice shapes over the mesh:
// opened (Promise), rpc.voiceJoin/voiceLeave, send("{t:vsig,...}"), close().
// Incoming roster/signal events arrive as message events with the same
// string JSON the server would send: {t:vjoin/vleave/vsig,...}.
function meshVoiceSocket() {
  var L = MeshVoiceLib;
  var roomName = meshVoiceRoomName(V.room);
  var tab = ((Math.random() * 0xFFFFFFFF) >>> 0).toString(16);
  var listeners = { message: [], close: [] };
  var closed = false, joined = false;
  var mySid = 0, myName = "", myUuid = "";
  var peers = {};      // sid -> {name, uuid, tab}
  var tabPeer = {};    // tab -> trystero peerId
  var seenTabs = {};   // tab -> sid (latest)
  var joinResolve = null, joinTimer = 0;
  var sock = null;

  function fire(kind, ev) {
    var hs = listeners[kind] || [];
    for (var i = 0; i < hs.length; i++) { try { hs[i](ev); } catch (e) {} }
  }
  function emit(obj) { fire("message", { data: JSON.stringify(obj) }); }
  function pickSid() {
    var taken = {};
    for (var k in peers) taken[k] = 1;
    for (var i = 0; i < 50; i++) {
      var c = 1 + Math.floor(Math.random() * 0xFFFFFE);
      if (!taken[c] && c !== mySid) return c;
    }
    return 1 + Math.floor(Math.random() * 0xFFFFFE);
  }
  function sendAct(msg, toTab) {
    try {
      var st = sock._mesh;
      if (!st || !st.send) return;
      var target = null;
      if (toTab && st.tabPeer[toTab]) target = st.tabPeer[toTab];
      if (target) st.send(msg, { target: target });
      else st.send(msg);
    } catch (e) {}
  }
  function announce() {
    sendAct({ k: "hello", sid: mySid, name: myName, uuid: myUuid, tab: tab });
  }
  function onAction(d, peerId) {
    if (closed || !d || typeof d !== "object" || typeof d.k !== "string") return;
    if (d.tab) { try { tabPeer[d.tab] = peerId; } catch (e) {} }
    if (d.sid > 0) {
      seenTabs[d.tab] = d.sid;
      if (!peers[d.sid] || peers[d.sid].tab !== d.tab) {
        // sid collision: same sid, different tab — smaller tab re-picks
        if (d.sid === mySid && d.tab !== tab && tab < d.tab) {
          mySid = pickSid();
          announce();
          return;
        }
      }
    }
    if (d.k === "hello") {
      if (!d.sid || d.sid === mySid) return;
      var known = !!peers[d.sid];
      peers[d.sid] = { name: String(d.name || "webuser").slice(0, 16), uuid: String(d.uuid || "").slice(0, 36), tab: d.tab };
      // answer directly so the newcomer learns us even if it missed traffic
      try { sendAct({ k: "hi", toTab: d.tab, sid: mySid, name: myName, uuid: myUuid, tab: tab }, d.tab); } catch (e) {}
      if (joined && !known) emit({ t: "vjoin", sid: d.sid, name: peers[d.sid].name, uuid: peers[d.sid].uuid });
    } else if (d.k === "hi") {
      if (d.toTab !== tab || !d.sid || d.sid === mySid) return;
      if (!peers[d.sid]) peers[d.sid] = { name: String(d.name || "webuser").slice(0, 16), uuid: String(d.uuid || "").slice(0, 36), tab: d.tab };
    } else if (d.k === "vsig") {
      if (!joined || d.toSid !== mySid) return;
      if (String(d.data || "").length > 8192) return;
      if (!peers[d.fromSid]) peers[d.fromSid] = { name: "webuser", uuid: "", tab: "" };
      emit({ t: "vsig", from: d.fromSid, kind: String(d.kind || ""), data: String(d.data || "") });
    } else if (d.k === "bye") {
      if (!d.sid || d.sid === mySid) return;
      if (peers[d.sid]) {
        delete peers[d.sid];
        if (joined) emit({ t: "vleave", sid: d.sid });
      }
    }
  }

  // The room join runs after the facade exists (the executor below only
  // fills pendingMesh; wiring it here avoids touching sock mid-literal).
  var pendingMesh = null;

  sock = {
    _mesh: null,
    opened: null,
    rpc: {
      voiceJoin: async function (data) {
        var info = null;
        try { info = JSON.parse(String(data)); } catch (e) { throw new Error("bad join"); }
        myName = String(info.name || "webuser").slice(0, 16) || "webuser";
        myUuid = String(info.uuid || "").slice(0, 36);
        mySid = pickSid();
        announce();
        // collect roster from whoever answers, then report like the server
        var members = await new Promise(function (resolve) {
          joinTimer = setTimeout(function () {
            var out = [];
            for (var k in peers) {
              if (+k === mySid) continue;
              out.push([+k, peers[k].name, peers[k].uuid]);
            }
            joined = true;
            resolve(out);
          }, MESH_VOICE_WINDOW_MS);
        });
        joinTimer = 0;
        return JSON.stringify({ ok: 1, sid: mySid, name: myName, members: members });
      },
      voiceLeave: async function () {
        try { sendAct({ k: "bye", sid: mySid, tab: tab }); } catch (e) {}
        joined = false;
        return "ok";
      },
    },
    send: function (s) {
      if (!joined || closed) return;
      var m = null;
      try { m = JSON.parse(String(s)); } catch (e) { return; }
      if (!m || m.t !== "vsig") return;
      var to = m.to | 0;
      if (!(to > 0) || String(m.data || "").length > 8192) return;
      var kind = String(m.kind || "");
      if (kind !== "offer" && kind !== "answer" && kind !== "ice") return;
      var tab2 = peers[to] ? peers[to].tab : "";
      sendAct({ k: "vsig", toSid: to, fromSid: mySid, kind: kind, data: String(m.data || "") }, tab2 || undefined);
    },
    addEventListener: function (kind, fn) { if (listeners[kind]) listeners[kind].push(fn); },
    removeEventListener: function (kind, fn) {
      var hs = listeners[kind];
      if (hs) { var i = hs.indexOf(fn); if (i >= 0) hs.splice(i, 1); }
    },
    close: function () {
      if (closed) return;
      closed = true;
      joined = false;
      try { if (joinTimer) clearTimeout(joinTimer); } catch (e) {}
      try { sendAct({ k: "bye", sid: mySid, tab: tab }); } catch (e) {}
      try { if (sock._mesh && sock._mesh.room) sock._mesh.room.leave(); } catch (e) {}
      sock._mesh = null;
      fire("close", { code: 1000, reason: "" });
    },
  };

  sock.opened = new Promise(function (resolve, reject) {
    try {
      var room = L.joinRoom({ appId: MESH_VOICE_APP }, roomName);
      var st = (pendingMesh = { room: room, send: null, tabPeer: tabPeer });
      var act = room.makeAction("v");
      if (act && typeof act.send === "function") {
        st.send = function (d, target) { try { act.send(d, target ? { target: target } : undefined); } catch (e) {} };
        act.onMessage = function (d, meta) { onAction(d, meta && meta.peerId); };
      } else if (act && typeof act[0] === "function") {
        st.send = function (d, target) { try { act[0](d, target); } catch (e) {} };
        act[1](function (d, pid) { onAction(d, pid); });
      } else throw new Error("action api");
      room.onPeerJoin = function () { try { if (!closed) announce(); } catch (e) {} };
      room.onPeerLeave = function (pid) {
        if (closed || !joined) return;
        var tb = "";
        for (var k in tabPeer) { if (tabPeer[k] === pid) { tb = k; break; } }
        if (!tb) return;
        try { delete tabPeer[tb]; } catch (e) {}
        for (var s in peers) {
          if (peers[s].tab === tb) {
            var sid = +s;
            delete peers[s];
            emit({ t: "vleave", sid: sid });
          }
        }
      };
      resolve(true);
    } catch (e) { reject(e); }
  });
  try { if (pendingMesh) sock._mesh = pendingMesh; } catch (e) {}
  return sock;
}

function myName() {
  try {
    if (V.bridgeName) return V.bridgeName;
    var g = gameObj();
    var n = g && g.username ? String(g.username) : "webuser";
    return n.slice(0, 16) || "webuser";
  } catch (e) { return "webuser"; }
}

function myUuid() {
  try {
    var g = gameObj();
    return g && g.playerUuid ? String(g.playerUuid) : "";
  } catch (e) { return ""; }
}

/* ---------------- ui ---------------- */

var CSS = [
  "#voice-ui{position:fixed;left:8px;top:8px;z-index:40;pointer-events:auto;font-family:monospace,sans-serif;font-size:12px;color:#fff;text-shadow:1px 1px 0 #3f3f3f;background:rgba(0,0,0,.72);border:2px solid #000;border-radius:4px;min-width:172px;max-width:230px;display:none;user-select:none;-webkit-user-select:none}",
  "#voice-head{display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer}",
  "#voice-dot{width:9px;height:9px;border-radius:50%;background:#555;flex:none}",
  "#voice-dot.on{background:#5f5;box-shadow:0 0 4px #5f5}",
  "#voice-dot.joining{background:#ff5}",
  "#voice-title{flex:1}",
  "#voice-join{background:#6d6d6d linear-gradient(#8b8b8b,#5f5f5f);border:2px solid #000;border-radius:3px;color:#fff;font-size:11px;padding:1px 8px;cursor:pointer;text-shadow:1px 1px 0 #3f3f3f}",
  "#voice-body{padding:0 6px 6px 6px}",
  "#voice-ui.closed #voice-body{display:none}",
  "#voice-status{color:#ff5;font-size:11px;min-height:14px;margin:2px 0}",
  "#voice-controls{display:flex;gap:4px;margin:2px 0 4px 0}",
  "#voice-controls button{flex:1;background:#6d6d6d linear-gradient(#8b8b8b,#5f5f5f);border:2px solid #000;border-radius:3px;color:#fff;font-size:11px;padding:2px 0;cursor:pointer;text-shadow:1px 1px 0 #3f3f3f}",
  "#voice-controls button.warn{background:#7d3b3b linear-gradient(#9b4b4b,#5f2f2f)}",
  "#voice-peers{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow-y:auto}",
  ".vp-row{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.06);border-radius:3px;padding:2px 4px}",
  ".vp-row .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".vp-row.speaking .nm{color:#7fff7f}",
  ".vp-row.eagler .nm{color:#9cf}",
  "#voice-evstatus{color:#9cf;font-size:11px;min-height:14px;margin:2px 0}",
  "body.voice-bridge #voice-ui{min-width:270px;max-width:330px;font-size:15px;left:12px;top:12px}",
  "body.voice-bridge #voice-join{font-size:15px;padding:6px 14px}",
  "body.voice-bridge #voice-controls button{font-size:15px;padding:12px 0}",
  "body.voice-bridge #voice-peers{max-height:260px}",
  "body.voice-bridge .vp-mute{font-size:18px}",
  ".vp-lvl{width:34px;height:7px;background:#222;border:1px solid #000;flex:none}",
  ".vp-lvl i{display:block;height:100%;width:0;background:#5f5}",
  ".vp-mute{background:none;border:0;color:#fff;cursor:pointer;font-size:12px;padding:0 2px;flex:none}",
  ".vp-st{width:7px;height:7px;border-radius:50%;background:#fa0;flex:none}",
  ".vp-st.live{background:#5f5}.vp-st.failed{background:#f55}",
  "#voice-hint{color:#aaa;font-size:10px;margin-top:3px}",
].join("\n");

function el(tag, id, text) {
  var d = document.createElement(tag);
  if (id) d.id = id;
  if (text != null) d.textContent = text;
  return d;
}

function buildUi() {
  try {
    var old = document.querySelector("#voice-ui");
    if (old) old.remove();
    var st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
  } catch (e) {}
  var ui = el("div", "voice-ui");
  var head = el("div", "voice-head");
  var dot = el("span", "voice-dot");
  var title = el("span", "voice-title", "voice: off");
  var join = el("button", "voice-join", "join");
  head.appendChild(dot); head.appendChild(title); head.appendChild(join);
  var body = el("div", "voice-body");
  var status = el("div", "voice-status", "");
  var ctrls = el("div", "voice-controls");
  var micBtn = el("button", "voice-mic", "mic: off");
  var modeBtn = el("button", "voice-mode", "mode: PTT");
  var menuBtn = el("button", "voice-menu", "menu");
  menuBtn.title = "voice menu (N)";
  menuBtn.addEventListener("click", function () { voiceMenuToggle(); });
  ctrls.appendChild(micBtn); ctrls.appendChild(modeBtn); ctrls.appendChild(menuBtn);
  var peers = el("div", "voice-peers");
  var hint = el("div", "voice-hint", "hold V (or MIC) to talk · heard ≤ " + VOICE_RANGE + " blocks");
  var evStatus = el("div", "voice-evstatus", "");
  body.appendChild(status); body.appendChild(evStatus); body.appendChild(ctrls); body.appendChild(peers); body.appendChild(hint);
  ui.appendChild(head); ui.appendChild(body);
  document.body.appendChild(ui);
  head.addEventListener("click", function (e) {
    if (e.target === join) return;
    ui.classList.toggle("closed");
  });
  join.addEventListener("click", function (e) {
    e.stopPropagation();
    if (V.mode === "on" || V.mode === "joining" || V.ev.join || V.ev.wantOn) leaveVoice("left");
    else joinVoiceSafe();
  });
  micBtn.addEventListener("click", function () { toggleMic(); });
  modeBtn.addEventListener("click", function () {
    V.openMic = !V.openMic;
    applyMicGate();
    drawUi();
  });
  // touch PTT: hold the MIC button
  micBtn.addEventListener("pointerdown", function (e) {
    if (e.pointerType && e.pointerType !== "mouse") {
      e.preventDefault();
      V.pttHeld = true;
      applyMicGate();
    }
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
    micBtn.addEventListener(t, function () {
      if (V.pttHeld) { V.pttHeld = false; applyMicGate(); }
    });
  });
  V.ui = { root: ui, dot: dot, title: title, join: join, status: status, evStatus: evStatus, micBtn: micBtn, modeBtn: modeBtn, peers: peers };
  try { if (V.ev.note) evStatus.textContent = V.ev.note; } catch (e) {}
  drawUi();
}

function setStatus(s) {
  V.status = s || "";
  try { if (V.ui) V.ui.status.textContent = V.status; } catch (e) {}
}

function drawUi() {
  if (!V.ui) return;
  var u = V.ui;
  try {
    var active = V.mode === "on" || V.ev.join;
    var joining = V.mode === "joining";
    u.dot.className = active ? "on" : (joining ? "joining" : "");
    u.dot.id = "voice-dot";
    var evN = Object.keys(V.ev.peers).length;
    u.title.textContent = active ? ("voice: " + V.name + (evN ? " +" + evN + "E" : "")) : (joining ? "voice: joining…" : "voice: off");
    u.join.textContent = (!active && !joining && !V.ev.wantOn) ? "join" : "leave";
    u.micBtn.textContent = V.micMuted ? "mic: MUTED" : (micLive() ? "mic: LIVE" : "mic: off");
    u.micBtn.className = V.micMuted ? "warn" : "";
    u.modeBtn.textContent = V.openMic ? "mode: OPEN" : "mode: PTT";
    var ids = Object.keys(V.peers).map(Number).sort(function (a, b) { return a - b; });
    // rebuild rows (cheap at this scale)
    u.peers.innerHTML = "";
    var eks = Object.keys(V.ev.peers).sort();
    if (!ids.length && !eks.length && active) {
      var empty = el("div", null, "nobody else here yet");
      empty.style.color = "#aaa";
      u.peers.appendChild(empty);
    }
    ids.forEach(function (sid) {
      var p = V.peers[sid];
      var row = el("div", null);
      row.className = "vp-row" + (p.level > 0.08 ? " speaking" : "");
      var st = el("span", null);
      st.className = "vp-st" + (p.state === "live" ? " live" : (p.state === "failed" ? " failed" : ""));
      var nm = el("span", null, p.name + (p.muted ? " (muted)" : ""));
      nm.className = "nm";
      var lvl = el("span", null);
      lvl.className = "vp-lvl";
      var fill = el("i", null);
      fill.style.width = Math.round(Math.min(1, p.level) * 100) + "%";
      lvl.appendChild(fill);
      var mb = el("button", null, p.muted ? "🔇" : "🔊");
      mb.className = "vp-mute";
      mb.title = "mute/unmute";
      (function (s) {
        mb.addEventListener("click", function (ev) {
          ev.stopPropagation();
          V.peers[s].muted = !V.peers[s].muted;
          drawUi();
        });
      })(sid);
      row.appendChild(st); row.appendChild(nm); row.appendChild(lvl); row.appendChild(mb);
      u.peers.appendChild(row);
    });
    eks.forEach(function (key) {
      var p = V.ev.peers[key];
      if (!p) return;
      var row = el("div", null);
      row.className = "vp-row eagler" + (p.level > 0.08 ? " speaking" : "");
      var st = el("span", null);
      st.className = "vp-st" + (p.state === "live" ? " live" : (p.state === "failed" ? " failed" : ""));
      var nm = el("span", null, p.name + " Ⓔ" + (p.muted ? " (muted)" : ""));
      nm.className = "nm";
      nm.title = "Eagler voice peer";
      var lvl = el("span", null);
      lvl.className = "vp-lvl";
      var fill = el("i", null);
      fill.style.width = Math.round(Math.min(1, p.level) * 100) + "%";
      lvl.appendChild(fill);
      var mb = el("button", null, p.muted ? "🔇" : "🔊");
      mb.className = "vp-mute";
      mb.title = "mute/unmute";
      (function (k) {
        mb.addEventListener("click", function (ev) {
          ev.stopPropagation();
          if (V.ev.peers[k]) V.ev.peers[k].muted = !V.ev.peers[k].muted;
          drawUi();
        });
      })(key);
      row.appendChild(st); row.appendChild(nm); row.appendChild(lvl); row.appendChild(mb);
      u.peers.appendChild(row);
    });
  } catch (e) {}
}

/* ---------------- mic ---------------- */

function micLive() {
  return !!(V.micTrack && !V.micMuted && (V.openMic || V.pttHeld) && V.micTrack.enabled);
}

function applyMicGate() {
  try {
    if (V.micTrack) V.micTrack.enabled = !V.micMuted && (V.openMic || V.pttHeld);
  } catch (e) {}
  drawUi();
}

function toggleMic() {
  V.micMuted = !V.micMuted;
  applyMicGate();
}

async function ensureMic() {
  if (V.micStream) return true;
  if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("no microphone in this browser");
    return false;
  }
  try {
    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    V.micStream = stream;
    var tracks = stream.getAudioTracks();
    V.micTrack = tracks && tracks[0] ? tracks[0] : null;
    if (!V.audioCtx) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        V.audioCtx = AC ? new AC() : null;
        if (V.audioCtx && V.audioCtx.state === "suspended") { try { V.audioCtx.resume(); } catch (e) {} }
      } catch (e) { V.audioCtx = null; }
    }
    // mic arriving late: attach to existing peers + renegotiate
    if (V.micTrack) {
      var sids = Object.keys(V.peers);
      for (var i = 0; i < sids.length; i++) {
        try {
          var p = V.peers[sids[i]];
          var senders = p.pc.getSenders ? p.pc.getSenders() : [];
          var has = false;
          for (var s = 0; s < senders.length; s++) {
            if (senders[s].track === V.micTrack) { has = true; break; }
          }
          if (!has) { try { p.pc.addTrack(V.micTrack, V.micStream); } catch (e) {} }
        } catch (e) {}
      }
      if (sids.length) reofferAll();
      // eagler V1 peers share the same mic track
      var eks = Object.keys(V.ev.peers);
      for (var j = 0; j < eks.length; j++) {
        try {
          var q = V.ev.peers[eks[j]];
          if (!q.pc) continue;
          var senders2 = q.pc.getSenders ? q.pc.getSenders() : [];
          var has2 = false;
          for (var s2 = 0; s2 < senders2.length; s2++) {
            if (senders2[s2].track === V.micTrack) { has2 = true; break; }
          }
          if (!has2) { try { q.pc.addTrack(V.micTrack, V.micStream); } catch (e) {} }
        } catch (e) {}
      }
      if (eks.length) evReofferAll();
    }
    applyMicGate();
    return !!V.micTrack;
  } catch (e) {
    setStatus("mic blocked — listening only (" + (e && e.name ? e.name : "denied") + ")");
    return false;
  }
}

/* ---------------- peers ---------------- */

function sendSig(to, kind, data) {
  try {
    if (V.socket) V.socket.send(JSON.stringify({ t: "vsig", to: to, kind: kind, data: data }));
  } catch (e) {}
}

async function makePeer(sid, name, uuid) {
  if (V.peers[sid]) return V.peers[sid];
  var p = { sid: sid, name: name, uuid: uuid || "", pc: null, gain: null, analyser: null, level: 0, muted: false, state: "new", stream: null };
  V.peers[sid] = p;
  try {
    if (typeof RTCPeerConnection === "undefined") { p.state = "failed"; return p; }
    var pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
    p.pc = pc;
    if (V.micTrack && V.micStream) {
      try { pc.addTrack(V.micTrack, V.micStream); } catch (e) {}
    }
    var self = V.sid;
    pc.onicecandidate = function (e) {
      try { if (e.candidate) sendSig(sid, "ice", JSON.stringify(e.candidate)); } catch (err) {}
    };
    pc.ontrack = function (e) {
      try { attachRemote(p, e.streams[0]); } catch (err) {}
    };
    pc.onconnectionstatechange = function () {
      try {
        var s = pc.connectionState;
        if (s === "connected") { p.state = "live"; }
        else if (s === "failed") { p.state = "failed"; }
        else if (s === "disconnected" || s === "closed") { if (p.state !== "failed") p.state = "new"; }
        drawUi();
      } catch (e) {}
    };
  } catch (e) { p.state = "failed"; }
  drawUi();
  return p;
}

function attachRemote(p, stream) {
  p.stream = stream;
  p.state = "live";
  try {
    if (!V.audioCtx) return;
    var src = V.audioCtx.createMediaStreamSource(stream);
    var gain = V.audioCtx.createGain();
    gain.gain.value = 0;
    var analyser = V.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(gain);
    gain.connect(analyser);
    analyser.connect(V.audioCtx.destination);
    p.gain = gain;
    p.analyser = analyser;
    p._lvlBuf = new Uint8Array(analyser.fftSize);
  } catch (e) {}
  drawUi();
}

async function offerTo(sid) {
  var p = V.peers[sid];
  if (!p || !p.pc) return;
  try {
    var offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    sendSig(sid, "offer", JSON.stringify(offer));
  } catch (e) { p.state = "failed"; drawUi(); }
}

async function reofferAll() {
  var sids = Object.keys(V.peers);
  for (var i = 0; i < sids.length; i++) {
    try { await offerTo(Number(sids[i])); } catch (e) {}
  }
}

async function onSig(from, kind, data) {
  var p = V.peers[from];
  if (kind === "offer") {
    if (!p) {
      // roster learns names from vjoin; unknown offer -> ignore
      return;
    }
    try {
      await p.pc.setRemoteDescription(JSON.parse(data));
      var answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      sendSig(from, "answer", JSON.stringify(answer));
    } catch (e) {}
    return;
  }
  if (!p || !p.pc) return;
  try {
    if (kind === "answer") await p.pc.setRemoteDescription(JSON.parse(data));
    else if (kind === "ice") { try { await p.pc.addIceCandidate(JSON.parse(data)); } catch (e) {} }
  } catch (e) {}
}

function dropPeer(sid) {
  var p = V.peers[sid];
  if (!p) return;
  delete V.peers[sid];
  try { if (p.pc) p.pc.close(); } catch (e) {}
  drawUi();
}

/* ---------------- proximity ---------------- */

function findPlayerEntity(name, uuid) {
  try {
    var g = gameObj();
    if (!g || !g.entities || !g.entities.map) return null;
    var sb = null;
    try { sb = g.scoreboard && g.scoreboard.players ? g.scoreboard.players : null; } catch (e) {}
    var it = g.entities.map.values();
    var step = it.next();
    while (!step.done) {
      var v = step.value;
      if (v && v.kind === "player") {
        if (uuid && v.uuid && v.uuid === uuid) return v;
        var nm = v.name || v.username || "";
        if (!nm && sb && v.uuid) {
          try { var rec = sb.get(v.uuid); if (rec && rec.name) nm = rec.name; } catch (e) {}
        }
        if (nm && nm === name) return v;
      }
      step = it.next();
    }
  } catch (e) {}
  return null;
}

// Eagler V1 peers carry a canonical uuid key; match world entities by
// normalized uuid first (exact identity), then by roster name.
function evFindEntity(p) {
  try {
    var hit = findPlayerEntity(p.name, null);
    if (hit) return hit;
    var g = gameObj();
    if (!g || !g.entities || !g.entities.map) return null;
    var want = evNormUuid(p.key);
    if (!want) return null;
    var it = g.entities.map.values();
    var step = it.next();
    while (!step.done) {
      var v = step.value;
      if (v && v.kind === "player" && v.uuid && evNormUuid(v.uuid) === want) return v;
      step = it.next();
    }
  } catch (e) {}
  return null;
}

function gainFor(dist) {
  if (!(dist >= 0) || dist > VOICE_RANGE) return 0;
  var t = 1 - dist / VOICE_RANGE;
  return t * t;
}

function proximityTick() {
  if (V.mode !== "on" && !evAnyActive()) return;
  var me = null;
  try {
    var g = gameObj();
    if (g && g.player) me = { x: g.player.x, y: g.player.y, z: g.player.z };
  } catch (e) {}
  // vc-room peers + eagler V1 peers share one gain/level pass
  var all = [];
  var sids = Object.keys(V.peers);
  var eks = Object.keys(V.ev.peers);
  var ai;
  for (ai = 0; ai < sids.length; ai++) all.push(V.peers[sids[ai]]);
  for (ai = 0; ai < eks.length; ai++) { if (V.ev.peers[eks[ai]]) all.push(V.ev.peers[eks[ai]]); }
  for (var i = 0; i < all.length; i++) {
    var p = all[i];
    var target = 0;
    if (!p.muted) {
      if (!me) {
        target = 1; // companion tab has no game positions: hear everyone
      } else {
        var ent = p.eagler ? evFindEntity(p) : findPlayerEntity(p.name, p.uuid);
        if (ent) {
          var dx = ent.x - me.x, dy = ent.y - me.y, dz = ent.z - me.z;
          target = gainFor(Math.sqrt(dx * dx + dy * dy + dz * dz));
        }
      }
    }
    // smooth + measure speaking level
    var lv = 0;
    try {
      if (p.analyser && p._lvlBuf) {
        p.analyser.getByteTimeDomainData(p._lvlBuf);
        var sum = 0;
        for (var b = 0; b < p._lvlBuf.length; b += 4) {
          var v = (p._lvlBuf[b] - 128) / 128;
          sum += v * v;
        }
        lv = Math.sqrt(sum / (p._lvlBuf.length / 4));
      }
    } catch (e) {}
    p.level = p.level * 0.6 + lv * 0.4;
    try {
      if (p.gain) {
        var cur = p.gain.gain.value;
        var next = cur + (target - cur) * 0.4;
        if (Math.abs(next - cur) < 0.002) next = target;
        p.gain.gain.value = next;
      }
    } catch (e) {}
  }
  try { voiceHudSpeakers(); } catch (e) {} // native action-bar speaker line
  drawUi();
}

/* ---------------- Eagler V1 backend voice (plugin-message transport) -----
 *
 * Speaks Eagler's V1 voice RPC (EaglerVCProtocol.V1) over the VANILLA game
 * connection as plugin messages on "eagler:1-8-voice-rpc", exactly the bytes
 * a Bukkit backend's voice service uses:
 *   INIT:  C->S [0x00][count][vers...]  S->C [0x01][ver][flags][ice...]
 *   V1:    C->S 0x01 connect  0x02 connectPeer  0x03 disconnect
 *               0x04 disconnectPeer  0x05 description  0x06 iceCandidate
 *          S->C 0x01 allowed  0x02 playerList  0x03 announce
 *               0x04 connectPeer  0x05 disconnectPeer  0x06 description
 *               0x07 iceCandidate
 * All multi-byte integers are big-endian (Java DataOutput). UUIDs are 16
 * bytes (most,least). SDP/ICE bodies are UTF-8 JSON, forwarded opaquely.
 * Audio itself is standard WebRTC/Opus — wire-compatible with Eagler peers.
 */

var EV_CH = "eagler:1-8-voice-rpc";
var EV_REG = "minecraft:register";
var EV_PKT_ID = 11; // serverbound Plugin Message in 1.15.2 (protocol 578; was 10 in 1.13.2)
var EV_WAIT_MS = 5000;

function evRoom(ext) { return ext ? (ext.host + ":" + ext.port) : ""; }

/* ----- tiny binary helpers (big-endian) ----- */

function evVarint(n) {
  n = n >>> 0;
  var out = [];
  do {
    var b = n & 127;
    n >>>= 7;
    if (n) b |= 128;
    out.push(b);
  } while (n);
  return out;
}
function evBytes(str) {
  try { return Array.prototype.slice.call(new TextEncoder().encode(str)); }
  catch (e) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
      else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return out;
  }
}
function evMcString(str) {
  var b = evBytes(String(str));
  return evVarint(b.length).concat(b);
}
function evPkt(channel, body) {
  return new Uint8Array(evVarint(EV_PKT_ID).concat(evMcString(channel)).concat(body));
}
function evReader(u8) {
  return { d: new DataView(u8.buffer, u8.byteOffset, u8.byteLength), o: 0, n: u8.length };
}
function evU8(r) {
  if (r.o + 1 > r.n) throw new Error("truncated");
  return r.d.getUint8(r.o++);
}
function evU16(r) {
  if (r.o + 2 > r.n) throw new Error("truncated");
  var v = r.d.getUint16(r.o); r.o += 2; return v;
}
function evI32(r) {
  if (r.o + 4 > r.n) throw new Error("truncated");
  var v = r.d.getInt32(r.o); r.o += 4; return v;
}
function evLong(r) {
  if (r.o + 8 > r.n) throw new Error("truncated");
  var v = r.d.getBigInt64(r.o); r.o += 8; return v;
}
function evTake(r, len) {
  if (len < 0 || r.o + len > r.n) throw new Error("truncated");
  var out = new Uint8Array(r.d.buffer, r.d.byteOffset + r.o, len);
  r.o += len;
  return out;
}
function evStr(r, len) {
  var b = evTake(r, len);
  try { return new TextDecoder("utf-8").decode(b); }
  catch (e) {
    var s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
}
function evPutLong(arr, v) {
  v = BigInt.asIntN(64, BigInt(v));
  for (var i = 7; i >= 0; i--) arr.push(Number((v >> BigInt(i * 8)) & BigInt(255)));
  return arr;
}

/* ----- UUID helpers ----- */

function evHexUuid() {
  try {
    var g = gameObj();
    var u = g && g.playerUuid ? String(g.playerUuid) : "";
    u = u.replace(/-/g, "").toLowerCase();
    if (/^[0-9a-f]{32}$/.test(u)) return u;
  } catch (e) {}
  return "";
}
function evSplitUuid(hex32) {
  hex32 = String(hex32 || "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex32)) return null;
  try {
    return {
      most: BigInt.asIntN(64, BigInt("0x" + hex32.slice(0, 16))),
      least: BigInt.asIntN(64, BigInt("0x" + hex32.slice(16))),
    };
  } catch (e) { return null; }
}
function evUuidKey(most, least) {
  function h(v) {
    var s = (v < 0 ? (BigInt("0x10000000000000000") + v) : v).toString(16);
    while (s.length < 16) s = "0" + s;
    return s;
  }
  var h32 = h(BigInt(most)) + h(BigInt(least));
  return h32.slice(0, 8) + "-" + h32.slice(8, 12) + "-" + h32.slice(12, 16) +
    "-" + h32.slice(16, 20) + "-" + h32.slice(20);
}
function evNormUuid(s) { return String(s || "").replace(/-/g, "").toLowerCase(); }

function evParseIce(list) {
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var parts = String(list[i]).split(";");
    if (!parts[0]) continue;
    var e = { urls: parts[0] };
    if (parts[1]) e.username = parts[1];
    if (parts[2]) e.credential = parts[2];
    out.push(e);
  }
  return out.length ? out : null;
}
function evIceConfig() {
  var rtc = null;
  try {
    rtc = evParseIce(V.ev.ice);
    if (!V.ev.overrideIce) {
      var extra = evParseIce(STUN_URLS);
      rtc = (rtc || []).concat(extra || []);
    }
  } catch (e) { rtc = null; }
  if (!rtc || !rtc.length) rtc = evParseIce(STUN_URLS);
  return { iceServers: rtc };
}

/* ----- builders (client -> server) ----- */

function evB_INIT() { return [0, 1, 1]; } // id 0x00, [v1]
function evB_Connect() { return [1]; }
function evB_Disconnect() { return [3]; }
function evB_ConnectPeer(most, least) {
  return evPutLong(evPutLong([2], most), least);
}
function evB_DisconnectPeer(most, least) {
  return evPutLong(evPutLong([4], most), least);
}
function evB_Desc(most, least, json) {
  var b = evBytes(json);
  var h = evPutLong(evPutLong([5], most), least);
  h.push((b.length >> 8) & 255, b.length & 255);
  return h.concat(b);
}
function evB_ICE(most, least, json) {
  var b = evBytes(json);
  var h = evPutLong(evPutLong([6], most), least);
  h.push((b.length >> 8) & 255, b.length & 255);
  return h.concat(b);
}

/* ----- parsers (server -> client) ----- */

function evP_Capable(u8) {
  var r = evReader(u8);
  var ver = evU8(r);
  var flags = evU8(r);
  var out = {
    version: ver,
    allowed: !!(flags & 128),
    overrideIce: !!(flags & 64),
    ice: [],
  };
  var n = flags & 63;
  for (var i = 0; i < n; i++) {
    var len = evU16(r);
    out.ice.push(evStr(r, len));
  }
  return out;
}
function evP_Allowed(u8) {
  if (u8.length < 1) throw new Error("truncated");
  return { allowed: !!u8[0] };
}
function evP_PlayerList(u8) {
  // stock backend writes a single 0x00 byte for an empty list (readInt
  // would overrun) — accept both framings.
  if (u8.length === 1 && u8[0] === 0) return [];
  var r = evReader(u8);
  var cnt = evI32(r);
  if (cnt < 0 || cnt > 256) throw new Error("bad player list");
  var ids = [];
  for (var i = 0; i < cnt; i++) ids.push([evLong(r), evLong(r)]);
  var out = [];
  for (var j = 0; j < cnt; j++) {
    var nl = evU8(r);
    out.push({ most: ids[j][0], least: ids[j][1], name: evStr(r, nl) });
  }
  return out;
}
function evP_UuidPair(u8) {
  var r = evReader(u8);
  return { most: evLong(r), least: evLong(r) };
}
function evP_ConnectPeer(u8) {
  var r = evReader(u8);
  var most = evLong(r), least = evLong(r);
  return { most: most, least: least, offer: !!evU8(r) };
}
function evP_Blob(u8) {
  var r = evReader(u8);
  var most = evLong(r), least = evLong(r);
  var len = evU16(r);
  return { most: most, least: least, text: evStr(r, len) };
}

/* ----- transport ----- */

function evSendRaw(channel, body) {
  try {
    var g = gameObj();
    if (!g || typeof g.send !== "function") return false;
    g.send(evPkt(channel, body));
    return true;
  } catch (e) { return false; }
}
function evSend(body) { return evSendRaw(EV_CH, body); }

function evReset() {
  var E = V.ev;
  if (E.timer) { try { clearTimeout(E.timer); } catch (e) {} E.timer = 0; }
  E.phase = "idle"; E.room = ""; E.join = false; E.wantOn = false;
  E.synced = false; // next roster fill is initial (quiet), later names notify
  E.ice = null; E.overrideIce = false; E.note = "";
  E.requested = {};
  evCloseAll();
}
function evNote(s) {
  V.ev.note = s || "";
  try { if (V.ui && V.ui.evStatus) V.ui.evStatus.textContent = V.ev.note; } catch (e) {}
}
function evDetect(ext) {
  var E = V.ev;
  var room = evRoom(ext);
  if (!room) { if (E.phase !== "idle") evReset(); return; }
  if (E.phase !== "idle" && E.room === room) return; // already on it
  evReset();
  E.room = room;
  if (!gameObj()) return; // bridge tab has no game conn; vc rooms only
  E.phase = "wait";
  evSendRaw(EV_REG, evBytes(EV_CH));
  evSend(evB_INIT());
  E.timer = setTimeout(function () {
    if (V.ev.phase === "wait" && V.ev.room === room) {
      V.ev.phase = "down"; // no Eagler backend here; vc rooms carry on
      V.ev.timer = 0;
    }
  }, EV_WAIT_MS);
}
function evHookGame() {
  try {
    var g = gameObj();
    if (!g || typeof g.on_custom_payload !== "function" || g._mcVoiceEvWrapped) return;
    var orig = g.on_custom_payload.bind(g);
    g._mcVoiceEvWrapped = true;
    // 1.15.2 dispatches {channel, data} with no packet name; the parsers
    // below expect the 1.13.2 {name, channel, data} shape, so synthesize it.
    g.on_custom_payload = function (pkt) {
      try { evOnPayload({ name: "custom_payload", channel: pkt && pkt.channel, data: pkt && pkt.data }); } catch (e) {}
      return orig(pkt);
    };
  } catch (e) {}
}
function evOnPayload(pkt) {
  if (!pkt || pkt.name !== "custom_payload") return;
  if (pkt.channel !== EV_CH) return;
  var E = V.ev;
  if (E.phase !== "wait" && E.phase !== "v1") return;
  var data = pkt.data;
  try {
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  } catch (e) { return; }
  if (!data.length) return;
  try {
    var id = data[0];
    var body = data.subarray(1);
    if (E.phase === "wait") {
      if (id !== 1) return;
      var cap = evP_Capable(body);
      if (E.timer) { try { clearTimeout(E.timer); } catch (e2) {} E.timer = 0; }
      if (cap.version !== 1 || !cap.allowed) {
        E.phase = "down";
        return;
      }
      E.phase = "v1";
      E.ice = cap.ice;
      E.overrideIce = !!cap.overrideIce;
      if (E.room && E.room !== E.noted) {
        E.noted = E.room; // first Eagler backend seen for this room: say so once
        try { voiceNotify("eagler voice available"); } catch (e2) {}
      }
      evNote("eagler voice: " + (E.ice && E.ice.length ? E.ice.length + " ICE" : "ready"));
      if ((E.wantOn || V.mode === "on") && !E.join) evConnectNow();
      drawUi();
      return;
    }
    // phase v1
    if (id === 1) {
      var al = evP_Allowed(body);
      if (!al.allowed) { evNote("eagler voice: not allowed"); evLeave(); E.phase = "down"; }
      else if ((E.wantOn || V.mode === "on") && !E.join) evConnectNow();
    } else if (id === 2) {
      var users = evP_PlayerList(body);
      evRoster(users);
    } else if (id === 3) {
      var an = evP_UuidPair(body);
      evRequest(an.most, an.least, null);
    } else if (id === 4) {
      var cp = evP_ConnectPeer(body);
      evPaired(cp.most, cp.least, cp.offer);
    } else if (id === 5) {
      var dp = evP_UuidPair(body);
      evDrop(evUuidKey(dp.most, dp.least));
    } else if (id === 6) {
      var dd = evP_Blob(body);
      evOnDesc(dd.most, dd.least, dd.text);
    } else if (id === 7) {
      var ii = evP_Blob(body);
      evOnIce(ii.most, ii.least, ii.text);
    }
    drawUi();
  } catch (e) {}
}

/* ----- V1 session ----- */

function evConnectNow() {
  var E = V.ev;
  if (E.phase !== "v1" || E.join) return;
  E.join = true;
  E.wantOn = false;
  evSend(evB_Connect());
  // roster (re)request: servers usually answer Connect with a PlayerList,
  // but re-ask for anyone we already know so a rejoin re-pairs fast.
  for (var k in E.peers) {
    try {
      var p = E.peers[k];
      evSend(evB_ConnectPeer(p.most, p.least));
      E.requested[k] = true;
    } catch (e) {}
  }
  evNote("eagler voice: on");
  drawUi();
}
function evJoin() {
  var E = V.ev;
  if (E.phase === "v1") { if (!E.join) evConnectNow(); return; }
  E.wantOn = true; // connect as soon as Capable lands
}
function evLeave() {
  var E = V.ev;
  E.wantOn = false;
  if (E.join) {
    E.join = false;
    try { evSend(evB_Disconnect()); } catch (e) {}
  }
  evCloseAll();
  if (E.phase === "v1") evNote("eagler voice: ready");
  drawUi();
}
function evRoster(users) {
  var E = V.ev;
  var seen = {};
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var key = evUuidKey(u.most, u.least);
    seen[key] = true;
    var p = E.peers[key];
    if (!p) {
      p = evMakePeer(u.most, u.least, u.name);
      E.peers[key] = p;
      if (u.name && E.join && E.synced) {
        try { voiceNotify(u.name + " joined voice"); } catch (e) {}
      }
    } else if (u.name) {
      var isNew = !p.named;
      p.name = u.name; p.named = true;
      if (isNew && E.join && E.synced) {
        try { voiceNotify(u.name + " joined voice"); } catch (e) {}
      }
    }
    if (E.join) evRequest(u.most, u.least, key);
  }
  // drop roster entries the server no longer lists (left), but keep
  // negotiated/live peers until DisconnectPeer tells us otherwise
  for (var k in E.peers) {
    if (!seen[k] && E.peers[k].state === "new" && !E.peers[k].requested) evDrop(k);
  }
  if (E.join) E.synced = true; // initial fill done quietly; later names are joins
}
function evRequest(most, least, key) {
  var E = V.ev;
  if (!E.join) return;
  key = key || evUuidKey(most, least);
  if (E.requested[key]) return;
  E.requested[key] = true;
  if (!E.peers[key]) E.peers[key] = evMakePeer(most, least, "");
  E.peers[key].requested = true;
  evSend(evB_ConnectPeer(most, least));
}

/* ----- V1 peers (WebRTC; same Opus audio as vc rooms) ----- */

function evMakePeer(most, least, name) {
  var key = evUuidKey(most, least);
  var old = V.ev.peers[key];
  if (old) return old;
  var p = {
    key: key, most: most, least: least, name: name || key.slice(0, 8),
    named: !!name,
    eagler: true, pc: null, gain: null, analyser: null, level: 0,
    muted: false, state: "new", stream: null,
    pendIce: [], hasRemote: false, requested: false,
  };
  V.ev.peers[key] = p;
  try {
    if (typeof RTCPeerConnection === "undefined") { p.state = "failed"; return p; }
    var pc = new RTCPeerConnection(evIceConfig());
    p.pc = pc;
    if (V.micTrack && V.micStream) {
      try { pc.addTrack(V.micTrack, V.micStream); } catch (e) {}
    }
    var kk = key;
    pc.onicecandidate = function (e) {
      try {
        if (e.candidate) {
          var q = V.ev.peers[kk];
          var js = JSON.stringify(e.candidate);
          if (q && q.paired) evSend(evB_ICE(q.most, q.least, js));
          else if (q) q.pendIce.push(js);
        }
      } catch (err) {}
    };
    pc.ontrack = function (e) {
      try { attachRemote(V.ev.peers[kk], e.streams[0]); } catch (err) {}
    };
    pc.onconnectionstatechange = function () {
      try {
        var q = V.ev.peers[kk];
        if (!q) return;
        var s = pc.connectionState;
        if (s === "connected") q.state = "live";
        else if (s === "failed") q.state = "failed";
        else if (s === "disconnected" || s === "closed") { if (q.state !== "failed") q.state = "new"; }
        drawUi();
      } catch (e) {}
    };
  } catch (e) { p.state = "failed"; }
  drawUi();
  return p;
}
function evFlushIce(p) {
  if (!p || !p.paired || !p.pc) return;
  var out = p.pendIce;
  p.pendIce = [];
  for (var i = 0; i < out.length; i++) {
    try { evSend(evB_ICE(p.most, p.least, out[i])); } catch (e) {}
  }
}
function evPaired(most, least, offer) {
  var E = V.ev;
  var key = evUuidKey(most, least);
  var p = E.peers[key] || evMakePeer(most, least, "");
  E.peers[key] = p;
  p.paired = true;
  p.requested = true;
  E.requested[key] = true;
  evFlushIce(p);
  if (offer) evOffer(p);
  drawUi();
}
async function evOffer(p) {
  if (!p || !p.pc || p.offering) return;
  p.offering = true;
  try {
    var offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    evSend(evB_Desc(p.most, p.least, JSON.stringify(offer)));
  } catch (e) { p.state = "failed"; }
  p.offering = false;
  drawUi();
}
async function evOnDesc(most, least, text) {
  var key = evUuidKey(most, least);
  var p = V.ev.peers[key];
  if (!p) { p = evMakePeer(most, least, ""); }
  if (!p.pc) return;
  try {
    var obj = JSON.parse(text);
    await p.pc.setRemoteDescription(obj);
    p.hasRemote = true;
    // inbound ICE that arrived early was buffered on the pc? no — we
    // buffer it ourselves below, so flush it here.
    if (p.pendRemote) {
      var q = p.pendRemote;
      p.pendRemote = null;
      for (var i = 0; i < q.length; i++) {
        try { await p.pc.addIceCandidate(JSON.parse(q[i])); } catch (e) {}
      }
    }
    if (obj && obj.type === "offer") {
      var answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      evSend(evB_Desc(p.most, p.least, JSON.stringify(answer)));
    }
  } catch (e) {}
  drawUi();
}
async function evOnIce(most, least, text) {
  var key = evUuidKey(most, least);
  var p = V.ev.peers[key];
  if (!p || !p.pc) return;
  try {
    if (p.hasRemote) await p.pc.addIceCandidate(JSON.parse(text));
    else {
      p.pendRemote = p.pendRemote || [];
      p.pendRemote.push(text);
    }
  } catch (e) {}
}
function evDrop(key) {
  var p = V.ev.peers[key];
  if (!p) return;
  var nm = p.named ? p.name : null;
  delete V.ev.peers[key];
  delete V.ev.requested[key];
  try {
    if (p.pc) p.pc.close();
  } catch (e) {}
  try { evSend(evB_DisconnectPeer(p.most, p.least)); } catch (e) {}
  if (nm && V.ev.join) { try { voiceNotify(nm + " left voice"); } catch (e2) {} }
  drawUi();
}
function evCloseAll() {
  var E = V.ev;
  var keys = Object.keys(E.peers);
  for (var i = 0; i < keys.length; i++) {
    try { if (E.peers[keys[i]].pc) E.peers[keys[i]].pc.close(); } catch (e) {}
  }
  E.peers = {};
  E.requested = {};
}
function evReofferAll() {
  var E = V.ev;
  var keys = Object.keys(E.peers);
  for (var i = 0; i < keys.length; i++) {
    try {
      var p = E.peers[keys[i]];
      if (p.paired && p.pc && p.hasRemote) evOffer(p);
    } catch (e) {}
  }
}
function evAnyActive() { return !!(V.ev.join && V.ev.phase === "v1"); }


function closeSocket() {
  try { if (V.socket) V.socket.close(1000, "voice done"); } catch (e) {}
  V.socket = null;
}

function fullCleanup() {
  var sids = Object.keys(V.peers);
  for (var i = 0; i < sids.length; i++) {
    try { V.peers[sids[i]].pc.close(); } catch (e) {}
  }
  V.peers = {};
  try {
    if (V.micStream) {
      var tr = V.micStream.getTracks();
      for (var t = 0; t < tr.length; t++) { try { tr[t].stop(); } catch (e) {} }
    }
  } catch (e) {}
  V.micStream = null;
  V.micTrack = null;
  // keep AudioContext (page gesture already unlocked it)
  closeSocket();
}

// Every floating (un-awaited) joinVoice() call goes through here: an async
// function that throws becomes an unhandled rejection, which the engine
// surfaces as a scary error overlay. joinVoice is internally guarded, but
// this makes that guarantee structural.
function joinVoiceSafe() {
  try {
    var r = joinVoice();
    if (r && r.catch) r.catch(function () {});
  } catch (e) {}
}

async function joinVoice() {
  if (V.mode === "joining" || V.mode === "on") return;
  var ext = externalServer();
  if (!ext) { setStatus("join a multiplayer server first"); return; }
  V.mode = "joining";
  V.room = roomKey(ext);
  try { evJoin(); } catch (e) {}
  setStatus("connecting…");
  drawUi();
  var micOk = false;
  try { micOk = await ensureMic(); } catch (e) { micOk = false; }
  if (V.mode !== "joining") return; // left while asking
  var sock = null;
  V.mesh = false;
  try {
    sock = socketFactory();
  } catch (e) {
    sock = null;
  }
  if (!sock) {
    // Downloaded file: no server-plugin socket here (4403 off perchance.org).
    // Same voice room over the Trystero mesh instead — needs internet for the
    // tracker intro only; audio stays browser-to-browser like always.
    try {
      var ML = await meshVoiceLib();
      if (!ML) throw new Error("mesh lib unavailable");
      MeshVoiceLib = ML;
      sock = meshVoiceSocket();
      V.mesh = true;
    } catch (e2) {
      sock = null;
    }
  }
  if (!sock) {
    V.mode = "off";
    setStatus("voice unavailable (offline file needs internet for voice)");
    drawUi();
    return;
  }
  V.socket = sock;
  var opened = false;
  try {
    sock.addEventListener("message", onSocketMsg);
    sock.addEventListener("close", onSocketClose);
    await sock.opened;
    opened = true;
  } catch (e) { opened = false; }
  if (!opened || V.mode !== "joining") {
    if (V.mode === "joining") {
      V.mode = "off";
      setStatus("voice server unreachable");
      drawUi();
    }
    try { sock.close(1000, "abort"); } catch (e) {}
    if (V.socket === sock) V.socket = null;
    return;
  }
  var rep = null;
  try {
    rep = await sock.rpc.voiceJoin(JSON.stringify({ room: V.room, name: myName(), uuid: myUuid() }));
    rep = JSON.parse(rep);
  } catch (e) { rep = null; }
  if (!rep || !rep.ok) {
    V.mode = "off";
    setStatus("voice join refused");
    drawUi();
    closeSocket();
    return;
  }
  V.sid = rep.sid;
  V.name = rep.name;
  V.mode = "on";
  var liveMsg = micOk ? (V.openMic ? "live — open mic" : "live — hold V to talk") : "live — listening only";
  if (V.mesh) liveMsg += " (mesh)";
  setStatus(liveMsg);
  drawUi();
  var members = rep.members || [];
  for (var i = 0; i < members.length; i++) {
    try {
      var m = members[i];
      await makePeer(m[0], m[1], m[2]);
      // server path: the joiner offers to everyone. mesh path: exactly the
      // lower sid offers (late hellos are handled in onSocketMsg), so two
      // tabs joining at once never double-offer (glare).
      if (!V.mesh || V.sid < m[0]) await offerTo(m[0]);
    } catch (e) {}
  }
}

function leaveVoice(why) {
  try { evLeave(); } catch (e) {}
  if (V.mode === "off") return;
  V.mode = "off";
  V.mesh = false;
  V.retryAt = 0;
  V.sid = 0;
  V.name = "";
  V.room = "";
  try {
    if (V.socket) {
      // floating RPC: a sync try/catch can't catch its async rejection
      // (e.g. socket already closed) — swallow it explicitly.
      try { var _lp = V.socket.rpc.voiceLeave(""); if (_lp && _lp.catch) _lp.catch(function () {}); } catch (e) {}
    }
  } catch (e) {}
  fullCleanup();
  setStatus(why || "");
  drawUi();
}

function onSocketMsg(ev) {
  var msg = null;
  try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch (e) { return; }
  if (!msg || V.mode !== "on") return;
  try {
    if (msg.t === "vjoin") {
      if (msg.sid === V.sid || V.peers[msg.sid]) return;
      // the newcomer offers to us (we are in their members list); just roster them
      makePeer(msg.sid, msg.name, msg.uuid);
      try { voiceNotify((msg.name || "someone") + " joined voice"); } catch (e2) {}
      if (V.mesh && V.sid < msg.sid) {
        // mesh late hello from a HIGHER sid: they are waiting (higher never
        // offers), so we offer. Lower-sid newcomers offer to us instead.
        try {
          var offerSid = msg.sid;
          makePeer(offerSid, msg.name, msg.uuid).then(function () {
            try { if (V.mesh && V.mode === "on" && V.peers[offerSid]) offerTo(offerSid); } catch (e3) {}
          });
        } catch (e4) {}
      }
    } else if (msg.t === "vleave") {
      var lv = V.peers[msg.sid];
      var lvName = lv ? lv.name : null;
      dropPeer(msg.sid);
      if (lvName) { try { voiceNotify(lvName + " left voice"); } catch (e2) {} }
    } else if (msg.t === "vsig") {
      onSig(msg.from, msg.kind, msg.data);
    }
  } catch (e) {}
}

function onSocketClose() {
  if (V.mode !== "on" && V.mode !== "joining") return;
  // one automatic retry if we are still on the same server
  var ext = externalServer();
  if (ext && roomKey(ext) === V.room && !V.retryAt) {
    V.retryAt = Date.now();
    V.mode = "joining";
    setStatus("reconnecting…");
    drawUi();
    var self = V.socket;
    closeSocket();
    setTimeout(function () {
      if (V.mode === "joining" && externalServer()) {
        V.retryAt = 0;
        joinVoiceSafe();
      } else if (V.mode === "joining") {
        V.mode = "off";
        setStatus("disconnected");
        drawUi();
      }
    }, 3000);
  } else {
    leaveVoice("disconnected");
  }
}

/* ---------------- presence + input ---------------- */

function presenceTick() {
  var ext = externalServer();
  // DOM panel lives on only where the engine cannot go: touch devices
  // (hold-to-talk is a DOM input-layer surface) and the game-less bridge
  // tab. Desktop in-game voice is the native menu (N) instead.
  var show = false;
  if (ext) {
    try {
      var g0 = gameObj();
      show = document.body.classList.contains("voice-bridge") ||
        !!globalThis.__mcTouchMode ||
        !!(g0 && g0.settings && g0.settings.touchscreen);
    } catch (e) { show = false; }
  }
  try {
    if (V.ui) V.ui.root.style.display = show ? "block" : "none";
  } catch (e) {}
  try { evHookGame(); } catch (e) {}
  if (!ext) {
    if (V.mode !== "off") leaveVoice("");
    try { voiceMenuClose(); } catch (e) {}
    evReset();
    return;
  }
  evDetect(ext);
  if (V.mode === "on" && roomKey(ext) !== V.room) {
    leaveVoice("server changed — rejoin voice");
    return;
  }
}

function bindKeys() {
  window.addEventListener("keydown", function (e) {
    try {
      if (!e || e.code !== PTT_CODE || e.repeat) return;
      if ((V.mode !== "on" && !V.ev.join) || V.openMic) return;
      var t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      var g = gameObj();
      // the native voice menu is transparent to PTT (it IS the voice UI);
      // any other open screen eats the key.
      if (g && g.screens && g.screens.current && g.screens.current !== V.voiceScr) return;
      V.pttHeld = true;
      applyMicGate();
    } catch (err) {}
  });
  window.addEventListener("keydown", function (e) {
    try {
      if (!e || e.code !== "KeyN" || e.repeat) return;
      // the engine screen path (Scr.key) handles N while the menu is open;
      // skip the echo so a real keypress can't toggle twice (same dispatch,
      // microseconds apart — far below this window; separate presses pass).
      if (Date.now() - (V._nAt || 0) < 50) return;
      var t2 = e.target;
      if (t2 && (t2.tagName === "INPUT" || t2.tagName === "TEXTAREA")) return;
      try {
        var ae = document.activeElement;
        if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
      } catch (ee) {}
      try {
        var g2 = gameObj();
        if (g2 && g2.screens && g2.screens.current) {
          var cur = g2.screens.current;
          if (cur.isChatScreen) return; // typing in chat
          if (cur.fields) {
            for (var fi = 0; fi < cur.fields.length; fi++) {
              if (cur.fields[fi] && cur.fields[fi].focused) return; // typing in a field
            }
          }
        }
      } catch (ee) {}
      if (!externalServer()) return;
      voiceMenuToggle();
    } catch (err) {}
  });
  window.addEventListener("keyup", function (e) {
    try {
      if (!e || e.code !== PTT_CODE) return;
      if (V.pttHeld) {
        V.pttHeld = false;
        applyMicGate();
      }
    } catch (err) {}
  });
  window.addEventListener("blur", function () {
    if (V.pttHeld) {
      V.pttHeld = false;
      try { applyMicGate(); } catch (e) {}
    }
  });
}

function startTimers() {
  stopTimers();
  V.timers.push(setInterval(presenceTick, 1000));
  V.timers.push(setInterval(proximityTick, TICK_MS));
  V.timers.push(setInterval(function () { try { voiceHudSpeakers(); } catch (e) {} }, 1000));
  try { presenceTick(); } catch (e) {}
}

function stopTimers() {
  for (var i = 0; i < V.timers.length; i++) {
    try { clearInterval(V.timers[i]); } catch (e) {}
  }
  V.timers = [];
}

/* ---------------- boot ---------------- */

/* ---------------- native voice menu + HUD (engine-rendered) -------------
 *
 * The voice panel used to be a DOM overlay. Desktop now uses the engine
 * itself, like every other menu: a native dirt-background voice screen
 * (roster with live levels, Join/Leave, mic/mode, mute-on-click) opened
 * with N, plus speaker names in the native action bar and join notices in
 * native chat. The DOM panel remains only where the engine cannot go:
 * touch hold-to-talk (multitouch lives in the DOM input layer by design)
 * and the game-less ?voicebridge companion tab.
 */

function ngVoice() {
  try { return globalThis.__mcNativeGui || null; } catch (e) { return null; }
}
function voiceRows() {
  var out = [];
  var sids = Object.keys(V.peers).map(Number).sort(function (a, b) { return a - b; });
  var i;
  for (i = 0; i < sids.length; i++) {
    var p = V.peers[sids[i]];
    if (p) out.push({ kind: "vc", key: sids[i], name: p.name, level: p.level, muted: !!p.muted, state: p.state });
  }
  var eks = Object.keys(V.ev.peers).sort();
  for (i = 0; i < eks.length; i++) {
    var q = V.ev.peers[eks[i]];
    if (q) out.push({ kind: "ev", key: eks[i], name: q.name, level: q.level, muted: !!q.muted, state: q.state });
  }
  return out;
}
function voiceToggleMuteAt(scr, i) {
  try {
    var rows = (scr && scr._rows) || voiceRows();
    var r = rows[i];
    if (!r) return;
    if (r.kind === "ev") {
      if (V.ev.peers[r.key]) V.ev.peers[r.key].muted = !V.ev.peers[r.key].muted;
    } else {
      if (V.peers[r.key]) V.peers[r.key].muted = !V.peers[r.key].muted;
    }
    drawUi();
  } catch (e) {}
}
function voiceDrawRow(t, r, i, x, ry, w, rh, sel, hov) {
  try {
    if (r.level > 0.08) t.rect(x + 1, ry, x + w - 1, ry + rh, 0x1A33FF33);
    else if (sel) t.rect(x + 1, ry, x + w - 1, ry + rh, 0x22FFFFFF);
    else if (hov) t.rect(x + 1, ry, x + w - 1, ry + rh, 0x11FFFFFF);
    var dot = r.state === "live" ? 0xFF33DD33 : (r.state === "failed" ? 0xFFDD3333 : 0xFFFFBB33);
    t.rect(x + 5, ry + Math.floor(rh / 2) - 2, x + 9, ry + Math.floor(rh / 2) + 2, dot);
    var label = String(r.name || "?") + (r.kind === "ev" ? " (E)" : "") + (r.muted ? " [muted]" : "");
    try { label = t.font ? t.font.trimToWidth(label, Math.max(10, w - 80)) : label; } catch (e) {}
    t.text(label, x + 13, ry + Math.floor((rh - 9) / 2), r.muted ? 0x808080 : 0xFFFFFF, false);
    var bw = 46, bx = x + w - bw - 6, by = ry + Math.floor(rh / 2) - 3;
    t.rect(bx, by, bx + bw, by + 6, 0xFF222222);
    var fw = Math.round(Math.min(1, r.level) * bw);
    if (fw > 0) t.rect(bx, by, bx + fw, by + 6, 0xFF33DD33);
  } catch (e) {}
}
function voiceMenuOpen() {
  var ng = ngVoice();
  if (!ng) return false;
  var Base = null, Btn = null, List = null;
  try { Base = ng.base(); Btn = ng.button(); List = ng.List; } catch (e) {}
  if (!Base || !Btn || !List) return false;
  var g = gameObj();
  if (!g || !g.screens) return false;
  try {
    if (V.voiceScr && ng.top() === V.voiceScr) return true;
  } catch (e) { V.voiceScr = null; }
  var Scr = class extends Base {
    constructor(gg) {
      super(gg);
      this.background = "dirt";
      this._rows = [];
      this._list = null;
    }
    init() {
      var W = this.width, H = this.height;
      var lw = Math.min(440, W - 40), lx = Math.floor((W - lw) / 2);
      var listTop = 66, btnY = H - 34;
      var listH = Math.max(60, btnY - 8 - listTop);
      var self = this;
      this._list = new List({
        x: lx, y: listTop, w: lw, h: listH, rowH: 20,
        rows: function () { self._rows = voiceRows(); return self._rows; },
        emptyText: "no one else here yet",
        drawRow: function (t, r, i, x, ry, w, rh, sel, hov) { voiceDrawRow(t, r, i, x, ry, w, rh, sel, hov); },
        onClick: function (i) { voiceToggleMuteAt(self, i); },
      });
      var bw = Math.max(60, Math.min(130, Math.floor((lw - 24) / 4)));
      var gap = (lw - bw * 4) / 3;
      var y = btnY;
      this.buttons.push(new Btn(0, Math.round(lx), y, bw, 20,
        function () { return (V.mode === "on" || V.ev.join) ? "Leave" : "Join"; },
        function () {
          if (V.mode === "on" || V.mode === "joining" || V.ev.join || V.ev.wantOn) leaveVoice("left");
          else joinVoiceSafe();
        }));
      this.buttons.push(new Btn(1, Math.round(lx + (bw + gap)), y, bw, 20,
        function () { return V.micMuted ? "Mic: off" : (micLive() ? "Mic: live" : "Mic: idle"); },
        function () { toggleMic(); }));
      this.buttons.push(new Btn(2, Math.round(lx + (bw + gap) * 2), y, bw, 20,
        function () { return V.openMic ? "Mode: open" : "Mode: PTT"; },
        function () { V.openMic = !V.openMic; applyMicGate(); }));
      this.buttons.push(new Btn(3, Math.round(lx + (bw + gap) * 3), y, bw, 20, "Close",
        function () { voiceMenuClose(); }));
    }
    tick() {
      try {
        if (!externalServer()) { voiceMenuClose(); return; }
        try { if (super.tick) super.tick(); } catch (e) {}
      } catch (e) {}
    }
    renderContent(t) {
      var cx = Math.floor(this.width / 2);
      t.textCentered("Voice Chat", cx, 10, 16777215);
      var ext = externalServer();
      var l1 = !ext ? "join a multiplayer server first"
        : (V.mode === "on" ? ("on as " + V.name) : (V.mode === "joining" ? "joining..."
          : (V.ev.join ? "on - eagler voice" : "off - press Join")));
      t.textCentered(l1, cx, 26, 10526880);
      var l2 = V.ev.note || (V.ev.phase === "wait" ? "eagler voice: checking..." : "");
      if (l2) t.textCentered(l2.length > 60 ? l2.slice(0, 57) + "..." : l2, cx, 39, 10043519);
      t.textCentered("click a name to mute - M mic - O mode - N closes", cx, 52, 8421504);
      try { if (this._list) this._list.render(t); } catch (e) {}
    }
    mouseDown(x, y, b) {
      try { if (this._list && this._list.mouseDown(x, y, b)) return true; } catch (e) {}
      return super.mouseDown(x, y, b);
    }
    mouseUp(x, y) {
      try { if (this._list) this._list.mouseUp(x, y); } catch (e) {}
      return super.mouseUp(x, y);
    }
    mouseMove(x, y) {
      try { if (this._list) this._list.mouseMove(x, y); } catch (e) {}
      return super.mouseMove(x, y);
    }
    wheel(d) {
      try { if (this._list && this._list.wheel(d)) return true; } catch (e) {}
      return super.wheel(d);
    }
    key(e) {
      if (!e) return super.key(e);
      if (e.code === "Escape" || e.code === "KeyN") { V._nAt = Date.now(); voiceMenuClose(); return true; }
      if (e.code === "KeyM") { toggleMic(); return true; }
      if (e.code === "KeyO") { V.openMic = !V.openMic; applyMicGate(); return true; }
      return super.key(e);
    }
    close() {
      // engine-initiated close (another screen opened over us): pop the
      // stack record instead of falling back to the title
      try {
        var ng2 = ngVoice();
        if (ng2) ng2.closeScreen(this);
      } catch (e) {}
    }
    onClose() {
      try { if (V.voiceScr === this) V.voiceScr = null; } catch (e) {}
    }
  };
  var scr = new Scr(g);
  var opened = false;
  try { opened = !!ng.open(scr); } catch (e) { opened = false; }
  if (opened) V.voiceScr = scr;
  return opened;
}
function voiceMenuClose() {
  var scr = V.voiceScr;
  V.voiceScr = null;
  if (!scr) return false;
  try {
    var ng = ngVoice();
    if (ng) ng.closeScreen(scr);
  } catch (e) {}
  return true;
}
function voiceMenuToggle() {
  try {
    var ng = ngVoice();
    if (V.voiceScr && ng && ng.top() === V.voiceScr) { voiceMenuClose(); return true; }
  } catch (e) {}
  return voiceMenuOpen();
}

// Native chat notice (engine font, no DOM).
function voiceNotify(s) {
  try {
    var g = gameObj();
    if (g && g.hud && typeof g.hud.addChat === "function") {
      try { g.hud.addChat(String(s)); }
      catch (e) { try { g.hud.addChat(String(s), { text: String(s) }); } catch (e2) {} }
    }
  } catch (e) {}
}
// Native action-bar speaker line. Heartbeat while anyone is audible (the
// bar fades on its own), silent otherwise.
function voiceHudSpeakers() {
  var names = [];
  var i, p;
  try {
    var sids = Object.keys(V.peers);
    for (i = 0; i < sids.length; i++) {
      p = V.peers[sids[i]];
      if (p && !p.muted && p.level > 0.12) names.push(p.name);
    }
    var eks = Object.keys(V.ev.peers);
    for (i = 0; i < eks.length; i++) {
      p = V.ev.peers[eks[i]];
      if (p && !p.muted && p.level > 0.12) names.push(p.name + " (E)");
    }
  } catch (e) {}
  var txt = names.length ? ("Talking: " + names.join(", ")) : "";
  if (txt.length > 60) txt = txt.slice(0, 57) + "...";
  try {
    var g = gameObj();
    if (!g || !g.hud || typeof g.hud.setActionBar !== "function") return;
    var now = Date.now();
    if (txt) {
      if (txt !== V.abText || now - (V.abAt || 0) > 1500) {
        V.abText = txt; V.abAt = now;
        g.hud.setActionBar(txt);
      }
    } else if (V.abText) {
      V.abText = "";
      try { g.hud.setActionBar(""); } catch (e) {}
    }
  } catch (e) {}
}

// Companion ("voice bridge") tab: ?voicebridge=<host>[:<port>]&vname=<name>
// (or #voicebridge=...) boots voice ONLY — an Eagler player on that same
// server opens the link on any device, taps JOIN, and talks with our
// players (matched by name for proximity). No protocol interop needed.
function parseBridge() {
  try {
    var q = new URLSearchParams(location.search);
    var vb = q.get("voicebridge");
    var nm = q.get("vname") || q.get("name");
    if (vb == null) {
      var h = String(location.hash || "");
      var m = h.match(/voicebridge=([^&]+)/);
      if (m) vb = decodeURIComponent(m[1]);
      var m2 = h.match(/(?:vname|name)=([^&]+)/);
      if (m2 && !nm) nm = decodeURIComponent(m2[1]);
    }
    if (vb == null || vb === "") return null;
    var host = String(vb), port = 25565;
    var ci = host.lastIndexOf(":");
    if (ci > 0) {
      var pp = parseInt(host.slice(ci + 1), 10);
      if (pp > 0 && pp < 65536) { port = pp; host = host.slice(0, ci); }
    }
    host = host.trim();
    if (!host) return null;
    return { host: host, port: port, name: nm ? String(nm).slice(0, 16) : "" };
  } catch (e) { return null; }
}
try {
  var BRI = parseBridge();
  if (BRI) {
    V.fakeExt = { host: BRI.host, port: BRI.port };
    if (BRI.name) V.bridgeName = BRI.name;
    try { document.body.classList.add("voice-bridge"); } catch (e2) {}
  }
} catch (e) {}

buildUi();
bindKeys();
startTimers();

window.__mcVoice = {
  join: joinVoice,
  leave: function () { leaveVoice("left"); },
  toggleMic: toggleMic,
  setOpenMic: function (v) { V.openMic = !!v; applyMicGate(); },
  state: function () {
    return {
      mode: V.mode, sid: V.sid, name: V.name, room: V.room,
      peers: Object.keys(V.peers).length, mic: micLive(), status: V.status,
      external: (function () { var e = externalServer(); return e ? e.host + ":" + e.port : null; })(),
      ev: { phase: V.ev.phase, join: !!V.ev.join, peers: Object.keys(V.ev.peers).length, note: V.ev.note },
      bridge: !!V.bridgeName,
    };
  },
  _test: {
    gainFor: gainFor,
    setFakeExt: function (host, port) {
      if (!host) V.fakeExt = null;
      else V.fakeExt = { host: String(host), port: port | 0 };
      presenceTick();
    },
    peers: function () { return V.peers; },
    findEntity: findPlayerEntity,
    externalServer: externalServer,
    evPeers: function () { return V.ev.peers; },
    evState: function () {
      return { phase: V.ev.phase, room: V.ev.room, join: !!V.ev.join, wantOn: !!V.ev.wantOn };
    },
    evReset: evReset,
    evInject: function (channel, bytes) {
      evHookGame();
      evOnPayload({ name: "custom_payload", channel: channel, data: bytes });
    },
    evBuild: function (id, body) { return evPkt(EV_CH, [id].concat(body)); },
    evCodec: {
      init: evB_INIT, connect: evB_Connect, disconnect: evB_Disconnect,
      connectPeer: evB_ConnectPeer, disconnectPeer: evB_DisconnectPeer,
      desc: evB_Desc, ice: evB_ICE,
      pCapable: evP_Capable, pAllowed: evP_Allowed, pPlayerList: evP_PlayerList,
      pUuid: evP_UuidPair, pConnectPeer: evP_ConnectPeer, pBlob: evP_Blob,
      uuidKey: evUuidKey, split: evSplitUuid, norm: evNormUuid,
    },
    evJoin: evJoin,
    evLeave: evLeave,
    parseBridge: parseBridge,
    roomKey: roomKey,
    voiceMenuOpen: voiceMenuOpen,
    voiceMenuClose: voiceMenuClose,
    voiceMenuToggle: voiceMenuToggle,
    voiceScr: function () { return V.voiceScr; },
    voiceRows: voiceRows,
    voiceNotify: voiceNotify,
    hudSpeakers: voiceHudSpeakers,
  },
};

})();
