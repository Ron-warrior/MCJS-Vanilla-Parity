/* MinecraftJS native touch controls (engine-integrated, Bedrock-style).
   No visible HTML elements: controls render inside the game canvas via the
   engine GUI (translucent thumb buttons, never grey PC-menu widgets) and
   drive game.input directly — no synthetic KeyboardEvent/MouseEvent, so
   mobile browsers (notably iOS Safari, which drops `code` on synthetic
   keys) work by construction.

    - Left D-pad cross (Bedrock-style): hold the UP/LEFT/RIGHT/DOWN squares
      to move; double-tap-and-hold UP to sprint; the center square toggles
      sneak. A held finger can slide between arrows without lifting.
   - Right-half drag = look (writes input.dx/dy; the engine's own per-frame
     sensitivity curve applies them exactly like a real mouse).
   - Tap right side = attack. Long-press right side (~480ms) = use.
   - Tap/slide on the hotbar = select slot (no arrows).
   - Right side: one JUMP square (up arrow; a DN square stacks above it
     while flying); LEAVE appears above it while riding. There are no
     ATK/USE buttons: tap the right side to attack, long-press to use.
   - Slim icon bar top-center: pause / inventory / chat / drop / keyboard;
     player Position readout top-left.
   - Menus: touches route to the open screen's mouse path (tap/drag/scroll
     via screens.onMouse/onMove + rawX/rawY), so inventory/chat/pause all
     work with fingers. SEND appears while a text field is open.
   - The only DOM left is one invisible <input> used solely to summon the
     OS keyboard on touch devices (canvas cannot do that); it has no
     visible UI. Text itself flows through the engine's screens/key path.

   Force on/off for testing: ?touch=1 / ?touch=0 (?touchdebug=1 draws a
   debug line in-canvas). Desktop mice never drive the touch UI; the
   __mcTouch test hooks below simulate fingers for verification. */
(function () {
"use strict";

var qs = location.search || "";
var forceOn = /[?&]touch=1(?:&|$)/.test(qs);
var forceOff = /[?&]touch=0(?:&|$)/.test(qs);
var capable = false;
try { capable = !!(window.matchMedia && window.matchMedia("(pointer:coarse)").matches); } catch (e) {}
var enabled = forceOn ? true : forceOff ? false : capable;
if (enabled) { try { globalThis.__mcTouchMode = true; } catch (e) { window.__mcTouchMode = true; } }
/* touchscreen laptop: primary pointer is fine, so stay off until first real touch */
if (!enabled && !forceOff) {
  window.addEventListener("touchstart", function auto() {
    window.removeEventListener("touchstart", auto);
    enabled = true;
    try { globalThis.__mcTouchMode = true; } catch (e) {}
    applyCanvasFlags();
  }, { passive: true });
}
var wantDebug = /[?&]touchdebug=1(?:&|$)/.test(qs);

/* ---------- game access ---------- */
function G() { try { return globalThis.game || null; } catch (e) { return null; } }
function INP() { try { var g = G(); return (g && g.input) || null; } catch (e) { return null; } }
function GUI() { try { var g = G(); return (g && g.gui) || null; } catch (e) { return null; } }

/* menu vs game mode: in menus every touch drives the open screen */
var forceGame = false; /* test hook */
var sawTouchFinger = false;
function inGame() {
  if (forceGame) return true;
  try {
    var g = G();
    if (!g || !g.inWorld) return false;
    if (g.screens && g.screens.current) return false;
    return true;
  } catch (e) { return false; }
}
function inWorld() { try { var g = G(); return !!(g && g.inWorld); } catch (e) { return false; } }

/* The engine tick only reads movement keys while input.locked (pointer lock)
   is set. Touch devices never get pointer lock, so force it while finger
   play is active. Gated on real touch use so desktop mouse flow is untouched. */
var lockForced = false;
function forceTouchLock() {
  try {
    var g = G();
    var inp = g && g.input;
    if (!inp) return;
    if (enabled && sawTouchFinger && inGame()) {
      if (!inp.locked && !document.pointerLockElement) { inp.locked = true; lockForced = true; }
    } else if (lockForced && !document.pointerLockElement) {
      try { inp.locked = false; } catch (_) {}
      lockForced = false;
    }
  } catch (_) {}
}

/* ---------- direct input (no synthetic DOM events) ---------- */
function bindCode(name, fb) {
  try { var g = G(); if (g && g.settings && g.settings.keys && g.settings.keys[name]) return g.settings.keys[name]; } catch (e) {}
  return fb;
}
function pressCode(code) {
  try {
    var inp = INP();
    if (!inp) return;
    if (!inp.down.has(code)) { inp.down.add(code); if (inp.pressed && typeof inp.pressed.push === "function") inp.pressed.push(code); }
  } catch (e) {}
}
function releaseCode(code) {
  try { var inp = INP(); if (inp && inp.down) inp.down.delete(code); } catch (e) {}
}
function keyDown(e) { /* engine key path with a plain object (no KeyboardEvent) */
  try { var g = G(); if (g && typeof g.onKey === "function") g.onKey(e); } catch (_) {}
}
function keyUp(e) {
  try {
    var g = G();
    if (!g) return;
    if (g.screens && g.screens.current) { try { g.screens.onKeyUp(e); } catch (_) {} }
  } catch (_) {}
}
function tapGameKey(code) {
  keyDown({ code: code, down: true, repeat: false });
  setTimeout(function () { keyUp({ code: code, down: false }); }, 60);
}
var KEY_FB = { forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", jump: "Space", sneak: "ShiftLeft", sprint: "ControlLeft" };
function setHeld(name, down) {
  var code = bindCode(name, KEY_FB[name]);
  if (!code) return;
  if (down) pressCode(code); else releaseCode(code);
  forceTouchLock();
}
function setMouseBtn(btn, down) {
  var code = "mouse" + btn;
  if (down) pressCode(code); else releaseCode(code);
}
function selectHotbar(i) {
  try {
    var g = G();
    if (!g || !g.inWorld) return false;
    if (g.screens && g.screens.current) return false;
    if (typeof g.selectSlot === "function") { g.selectSlot(i); return true; }
    var k = g.settings && g.settings.keys ? g.settings.keys["hotbar" + (i + 1)] : null;
    if (k) { tapGameKey(k); return true; }
    return false;
  } catch (_) { return false; }
}

/* ---------- canvas flags (no visible DOM) ---------- */
function applyCanvasFlags() {
  try {
    var c = document.querySelector("#game-canvas") || document.querySelector("canvas");
    if (c && enabled) {
      try { c.style.touchAction = "none"; } catch (e) {}
    }
  } catch (e) {}
}
try { applyCanvasFlags(); } catch (e) {}
try { document.documentElement.style.setProperty("overscroll-behavior", "none"); } catch (e) {}

/* ---------- coordinate conversion (client px -> engine GUI px) ----------
   The canvas rect is cached (getBoundingClientRect forces a sync layout;
   during a drag it would run dozens of times per second). Invalidated on
   view changes and refreshed at most every ~750ms. */
var rectCache = null, rectCacheT = 0, rectCacheCanvas = null;
function invalidateRect() { rectCache = null; }
function canvasRect() {
  try {
    var now = Date.now();
    var c = document.querySelector("#game-canvas") || document.querySelector("canvas");
    if (!c) return rectCache;
    if (rectCache && rectCacheCanvas === c && now - rectCacheT < 750) return rectCache;
    var r = c.getBoundingClientRect();
    if (!r.width || !r.height) return rectCache;
    rectCache = { left: r.left, top: r.top, width: r.width, height: r.height, cw: c.width, ch: c.height };
    rectCacheCanvas = c; rectCacheT = now;
    return rectCache;
  } catch (e) { return rectCache; }
}
function toGui(x, y) {
  try {
    var gui = GUI();
    var r = canvasRect();
    if (!gui || !r || !r.width || !r.height) return null;
    return [ (x - r.left) * (gui.width / r.width), (y - r.top) * (gui.height / r.height) ];
  } catch (e) { return null; }
}
function setRaw(clientX, clientY) {
  try {
    var g = G(); if (!g || !g.input) return;
    var px = window.devicePixelRatio || 1;
    var r = canvasRect();
    if (r && r.width) px = r.cw / r.width;
    g.input.rawX = clientX * px;
    g.input.rawY = clientY * px;
    g.input.mouseX = g.input.rawX; g.input.mouseY = g.input.rawY;
  } catch (e) {}
}

/* ---------- layout (GUI coords, recomputed per frame) ----------
   Bedrock look: a slim icon bar top-center (clear of the position readout
   top-left and effect icons top-right), a D-pad cross of squares
   bottom-left (arrows + sneak in the middle), one JUMP square
   bottom-right (DN stacks above it while flying), SEND centered above the
   hotbar while typing. */
function layout() {
  var gui = GUI();
  if (!gui) return null;
  var W = gui.width, H = gui.height;
  var compact = H < 260;
  /* top-center icon bar: [II][INV][CHAT][DROP][KB] */
  var barH = compact ? 14 : 16, barY = 3, barGap = 3;
  var defs = [["II", 22], ["INV", 26], ["CHAT", 28], ["DROP", 26], ["KB", 22]];
  var total = -barGap, bi;
  for (bi = 0; bi < defs.length; bi++) total += defs[bi][1] + barGap;
  var bx = Math.floor((W - total) / 2), sys = [];
  for (bi = 0; bi < defs.length; bi++) {
    sys.push({ id: defs[bi][0], x: bx, y: barY, w: defs[bi][1], h: barH });
    bx += defs[bi][1] + barGap;
  }
  /* D-pad: 3x3 cross of squares, bottom-left, clear of the hotbar */
  var s = compact ? 26 : 32, gp = compact ? 4 : 6;
  var ox = 12, oy = H - 40 - (3 * s + 2 * gp);
  if (oy < barY + barH + 4) oy = barY + barH + 4;
  ox = Math.floor(ox); oy = Math.floor(oy);
  var dpad = {
    up: { id: "forward", x: ox + s + gp, y: oy, w: s, h: s },
    left: { id: "left", x: ox, y: oy + s + gp, w: s, h: s },
    snk: { id: "snk", x: ox + s + gp, y: oy + s + gp, w: s, h: s },
    right: { id: "right", x: ox + 2 * (s + gp), y: oy + s + gp, w: s, h: s },
    down: { id: "back", x: ox + s + gp, y: oy + 2 * (s + gp), w: s, h: s }
  };
  /* one JUMP square bottom-right; DN stacks above it while flying */
  var sJ = compact ? 40 : 48;
  var jx = Math.floor(W - 12 - sJ), jy = Math.floor(H - 40 - sJ);
  var L = {
    W: W, H: H, compact: compact, sys: sys, dpad: dpad,
    jump: { id: "JUMP", x: jx, y: jy, w: sJ, h: sJ },
    flydn: { id: "DN", x: jx, y: jy - sJ - 6, w: sJ, h: sJ },
    leave: { id: "LEAVE", x: W - 84, y: H - 188, w: 64, h: 26 },
    send: { id: "SEND", x: Math.floor(W / 2) - 40, y: H - 66, w: 80, h: 24 },
    prev: { id: "<", x: W - 176, y: H - 60, w: 40, h: 24 },
    next: { id: ">", x: W - 128, y: H - 60, w: 40, h: 24 },
    hotTop: H - 36, hotY0: H - 22, hotX0: W / 2 - 91, hotX1: W / 2 + 91
  };
  return L;
}
function sysRect(L, id) {
  for (var i = 0; i < L.sys.length; i++) if (L.sys[i].id === id) return L.sys[i];
  return null;
}
function hitRect(r, x, y) {
  return !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
function hotbarSlotAt(x, y) {
  try {
    var g = G();
    if (!g || !g.inWorld) return -1;
    if (g.screens && g.screens.current) return -1;
    if (g.gameMode === 3) return -1;
    if (g.settings && g.settings.hideGui) return -1;
    if (g.hideGui) return -1;
    var gui = GUI();
    if (!gui || gui.width < 182 || gui.height < 23) return -1;
    if (!isFinite(x) || !isFinite(y)) return -1;
    var x0 = gui.width / 2 - 91, x1 = gui.width / 2 + 91, yT = gui.height - 36, yB = gui.height;
    if (x < x0 || x > x1 || y < yT || y > yB) return -1;
    var i = Math.floor((x - x0) / ((x1 - x0) / 9));
    if (i < 0) i = 0; if (i > 8) i = 8;
    return i;
  } catch (e) { return -1; }
}
function spectatorActive() {
  try { var g = G(); return !!(g && g.gameMode === 3 && g.hud && g.hud.spectatorGui && g.hud.spectatorGui.active); }
  catch (e) { return false; }
}

/* ---------- gesture state ----------
   D-pad buttons are multi-touch: each direction holds a set of finger ids
   (forward+left strafe works), and a held finger may slide between arrows
   without lifting (tracked in fingerBtn). Double-tap-and-hold UP sprints. */
var dpadHolders = { forward: {}, back: {}, left: {}, right: {} };
var jumpHolders = {};
var fingerBtn = {};  /* touch id -> button id currently held */
var looks = {};      /* id -> {x,y,t,moved,long,timer,clientX,clientY} */
var hotIds = {};     /* touch id -> true while on the hotbar */
var menuTouch = {};  /* touch id -> true while driving a screen */
var toggle = { sneak: false, sprint: false };
var lastFwdEnd = 0;
var activeCount = 0;

function holdersEmpty(h) { for (var k in h) return false; return true; }
function dpadSync(name) { setHeld(name, !holdersEmpty(dpadHolders[name])); }
function dpadAdd(name, id) { dpadHolders[name][id] = true; dpadSync(name); }
function dpadRemove(name, id) {
  delete dpadHolders[name][id];
  dpadSync(name);
  if (name === "forward" && holdersEmpty(dpadHolders.forward)) {
    /* sprint only lives while UP is held: lifting UP always stops it */
    lastFwdEnd = Date.now();
    if (toggle.sprint) toggle.sprint = false;
  }
  updateSprint();
}
function jumpAdd(id) { jumpHolders[id] = true; setHeld("jump", true); }
function jumpRemove(id) {
  delete jumpHolders[id];
  if (holdersEmpty(jumpHolders)) setHeld("jump", false);
}
/* Bedrock feel: double-tap-and-hold UP sprints (there is no SPR button). */
function updateSprint() { setHeld("sprint", !!toggle.sprint); }
function releaseDpad() {
  for (var n in dpadHolders) {
    for (var k in dpadHolders[n]) delete dpadHolders[n][k];
    try { setHeld(n, false); } catch (e) {}
  }
  for (var j in jumpHolders) delete jumpHolders[j];
  try { setHeld("jump", false); } catch (e) {}
  for (var f in fingerBtn) delete fingerBtn[f];
  updateSprint();
}
function releaseAll() {
  releaseDpad();
  /* toggles persist (Sneak stays as the player left it) */
  for (var id in looks) { try { clearTimeout(looks[id].timer); } catch (_) {} delete looks[id]; }
  for (var h in hotIds) delete hotIds[h];
  for (var m in menuTouch) delete menuTouch[m];
  activeCount = 0;
}
window.addEventListener("blur", releaseAll);
window.addEventListener("pagehide", releaseAll);
document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
document.addEventListener("visibilitychange", function () {
  if (document.hidden) { releaseDpad(); for (var id in looks) { try { clearTimeout(looks[id].timer); } catch (_) {} delete looks[id]; } }
});
window.addEventListener("resize", function () { releaseDpad(); invalidateRect(); });
window.addEventListener("orientationchange", function () { releaseDpad(); invalidateRect(); });

/* ---------- screens bridging ---------- */
function screenDown(gx, gy, cx, cy) {
  try {
    var g = G();
    if (!g || !g.screens || !g.screens.current) return false;
    setRaw(cx, cy);
    g.screens.onMouse({ down: true, button: 0, shift: false });
    return true;
  } catch (e) { return false; }
}
function screenMove(gx, gy, cx, cy) {
  try {
    var g = G();
    if (!g || !g.screens || !g.screens.current) return;
    setRaw(cx, cy);
    if (g.screens.onMove) g.screens.onMove();
  } catch (e) {}
}
function screenUp(cx, cy) {
  try {
    var g = G();
    if (!g || !g.screens || !g.screens.current) return;
    setRaw(cx, cy);
    g.screens.onMouse({ down: false, button: 0, shift: false });
  } catch (e) {}
}
/* Cached per screen instance (a full property scan every frame is wasteful;
   re-scanned when the screen changes or at most every ~1s in case fields
   are added dynamically). */
var textFieldCache = { scr: null, val: false, t: 0 };
function screenHasTextField() {
  try {
    var g = G();
    var s = g && g.screens && g.screens.current;
    if (!s) { textFieldCache.scr = null; return false; }
    var now = Date.now();
    if (textFieldCache.scr === s && now - textFieldCache.t < 1000) return textFieldCache.val;
    var v = screenHasTextFieldScan(s);
    textFieldCache.scr = s; textFieldCache.val = v; textFieldCache.t = now;
    return v;
  } catch (e) { return false; }
}
function screenHasTextFieldScan(s) {
  try {
    if (!s) return false;
    if (s.input && (typeof s.input.setText === "function" || typeof s.input.text === "string")) return true;
    if (Array.isArray(s.fields) && s.fields.length) return true;
    for (var k in s) {
      try {
        var v = s[k];
        if (!v || typeof v !== "object" || v === s) continue;
        if (typeof v.text === "string" && typeof v.key === "function") return true;
        if (typeof v.setText === "function") return true;
      } catch (e) {}
    }
    return false;
  } catch (e) { return false; }
}

/* ---------- hidden keyboard bridge (invisible input, no UI) ---------- */
var chatInput = null;
var kbFocusT = 0;
var lastVal = "";
var recentReal = [];
function buildKbInput() {
  try {
    var old = document.querySelector("#tc-kb");
    if (old) old.remove();
    chatInput = document.createElement("input");
    chatInput.id = "tc-kb";
    chatInput.type = "text";
    chatInput.setAttribute("inputmode", "text");
    chatInput.setAttribute("enterkeyhint", "done");
    chatInput.setAttribute("autocomplete", "off");
    chatInput.setAttribute("autocapitalize", "none");
    chatInput.setAttribute("autocorrect", "off");
    chatInput.setAttribute("spellcheck", "false");
    chatInput.setAttribute("aria-label", "chat");
    chatInput.tabIndex = -1;
    chatInput.style.cssText = "position:fixed;left:0;bottom:0;width:4px;height:4px;opacity:0.01;border:0;padding:0;background:transparent;color:transparent;pointer-events:none;font-size:16px;";
    document.body.appendChild(chatInput);
    chatInput.addEventListener("keydown", function (e) {
      recentReal.push({ key: e.key, t: Date.now() });
      if (recentReal.length > 20) recentReal.shift();
      if (e.key === "Enter") {
        setTimeout(function () { try { chatInput.value = ""; lastVal = ""; chatInput.blur(); } catch (_) {} }, 150);
      }
    }, true);
    chatInput.addEventListener("input", function () {
      var v = chatInput.value;
      var i = 0;
      while (i < lastVal.length && i < v.length && lastVal[i] === v[i]) i++;
      var removed = lastVal.length - i;
      var added = v.slice(i);
      lastVal = v;
      for (var r = 0; r < removed; r++) tapGameKey("Backspace");
      for (var c = 0; c < added.length; c++) {
        var ch = added[c];
        /* route printable chars through the engine char path */
        try {
          var g = G();
          if (g && g.screens && g.screens.current) {
            var now = Date.now(), dup = false;
            for (var k = recentReal.length - 1; k >= 0; k--) {
              if (now - recentReal[k].t > 150) break;
              if (recentReal[k].key === ch) { dup = true; break; }
            }
            if (!dup && g.input && typeof g.input.emit === "function") g.input.emit("char", ch);
          }
        } catch (e) {}
      }
    });
  } catch (e) {}
}
function focusKb() {
  kbFocusT = Date.now();
  try {
    if (!chatInput) buildKbInput();
    if (document.activeElement !== chatInput) chatInput.focus({ preventDefault: true });
  } catch (_) { try { chatInput.focus(); } catch (__) {} }
}
function focusKbIfTextScreen() {
  try {
    var ng = globalThis.__mcNativeGui;
    if (ng && typeof ng.top === "function" && ng.top()) return;
  } catch (e) {}
  if (screenHasTextField()) focusKb();
}

/* ---------- button actions (engine paths, no synthetic events) ---------- */
function doMenu() { tapGameKey("Escape"); releaseAll(); }
function doInv() {
  try {
    var g = G(); if (!g) return;
    if (g.screens && g.screens.current) { tapGameKey("Escape"); return; }
    if (typeof g.openInventory === "function") g.openInventory();
    else tapGameKey(bindCode("inventory", "KeyE"));
  } catch (e) {}
}
function doChat() {
  try {
    focusKb();
    var g = G();
    var k = (g && g.settings && g.settings.keys && g.settings.keys.chat) || "KeyT";
    tapGameKey(k);
  } catch (e) {}
}
function doDrop() {
  try {
    var g = G();
    var k = (g && g.settings && g.settings.keys && g.settings.keys.drop) || "KeyQ";
    tapGameKey(k);
  } catch (e) {}
}
function doSend() {
  tapGameKey("Enter");
  setTimeout(function () {
    try {
      if (!screenHasTextField() && chatInput) { chatInput.value = ""; lastVal = ""; try { chatInput.blur(); } catch (e) {} }
    } catch (e) {}
  }, 80);
}
function doToggle(name) {
  if (name === "sneak") { toggle.sneak = !toggle.sneak; setHeld("sneak", toggle.sneak); }
  else { toggle.sprint = !toggle.sprint; updateSprint(); }
}
/* contextual player state */
function isRiding() {
  try { var g = G(); return !!(g && g.player && g.player.ridingEntity); }
  catch (e) { return false; }
}
function isFlying() {
  try { var g = G(); var pl = g && g.player; return !!(pl && (pl.flying || pl.elytraFlying)); }
  catch (e) { return false; }
}
/* dismount: a quick sneak pulse (a sticky toggle would fight remount) */
function doLeave() {
  var code = bindCode("sneak", KEY_FB.sneak);
  pressCode(code);
  setTimeout(function () { releaseCode(code); }, 150);
}

/* press routing for the rendered buttons; returns the button id when consumed */
function dpadPress(name, id) {
  if (name === "forward") {
    var now = Date.now();
    if (now - lastFwdEnd < 350) toggle.sprint = true; /* double-tap = sprint */
    updateSprint();
  }
  dpadAdd(name, id);
  fingerBtn[id] = name;
  sawTouchFinger = true;
}
function pressButtonAt(gx, gy, L, id) {
  if (!L) return false;
  var game = inGame(), world = inWorld();
  var g = G();
  var spec = spectatorActive();
  /* top system bar: in-world only (matches renderTouch, which draws nothing
     outside a world — title-screen taps belong to the title buttons) */
  if (world) {
    for (var i = 0; i < L.sys.length; i++) {
      if (!hitRect(L.sys[i], gx, gy)) continue;
      var b = L.sys[i].id;
      sawTouchFinger = true;
      if (b === "II") doMenu();
      else if (b === "INV") doInv();
      else if (b === "CHAT") doChat();
      else if (b === "DROP") doDrop();
      else if (b === "KB") { try { if (document.activeElement === chatInput) chatInput.blur(); else focusKb(); } catch (_) { focusKb(); } }
      return b;
    }
  }
  /* SEND while a text field is open (works in menus too) */
  if (screenHasTextField() && hitRect(L.send, gx, gy)) { doSend(); return "send"; }
  /* D-pad + jump only in game */
  if (game) {
    var flying = isFlying();
    if (hitRect(L.jump, gx, gy)) { jumpAdd(id); fingerBtn[id] = "jump"; sawTouchFinger = true; return "jump"; }
    if (flying && hitRect(L.flydn, gx, gy)) { doToggle("sneak"); fingerBtn[id] = "flydn"; sawTouchFinger = true; return "flydn"; }
    if (hitRect(L.dpad.up, gx, gy)) { dpadPress("forward", id); return "forward"; }
    if (hitRect(L.dpad.down, gx, gy)) { dpadPress("back", id); return "back"; }
    if (hitRect(L.dpad.left, gx, gy)) { dpadPress("left", id); return "left"; }
    if (hitRect(L.dpad.right, gx, gy)) { dpadPress("right", id); return "right"; }
    if (hitRect(L.dpad.snk, gx, gy)) { doToggle("sneak"); fingerBtn[id] = "snk"; sawTouchFinger = true; return "snk"; }
    if (isRiding() && hitRect(L.leave, gx, gy)) { doLeave(); return "leave"; }
    if (spec && (hitRect(L.prev, gx, gy) || hitRect(L.next, gx, gy))) {
      try {
        var d = hitRect(L.prev, gx, gy) ? -1 : 1;
        if (g.hud.spectatorGui.active) g.hud.spectatorGui.onMouseScroll(d);
        else g.selectSlot(((g.heldSlot + d) % 9 + 9) % 9);
      } catch (e) {}
      return "scroll";
    }
  }
  return false;
}
function releaseButtonKind(kind, id) {
  if (kind === "jump") jumpRemove(id);
  else if (kind === "forward" || kind === "back" || kind === "left" || kind === "right") dpadRemove(kind, id);
  if (id !== undefined) delete fingerBtn[id];
}
function dpadDirAt(gx, gy, L) {
  if (!L || !L.dpad) return null;
  if (hitRect(L.dpad.up, gx, gy)) return "forward";
  if (hitRect(L.dpad.down, gx, gy)) return "back";
  if (hitRect(L.dpad.left, gx, gy)) return "left";
  if (hitRect(L.dpad.right, gx, gy)) return "right";
  if (hitRect(L.dpad.snk, gx, gy)) return "snk";
  if (hitRect(L.jump, gx, gy)) return "jump";
  if (L.flydn && hitRect(L.flydn, gx, gy)) return "flydn";
  return null;
}
/* a finger held on a button may slide to a neighbour square without lifting;
   toggles (sneak/flydn) only fire on a fresh press, never on a slide */
function slideButton(id, gx, gy) {
  var cur = fingerBtn[id];
  if (!cur) return;
  var L = layout();
  var nd = dpadDirAt(gx, gy, L);
  if (nd === cur) return;
  if (cur === "jump") jumpRemove(id);
  else if (cur === "forward" || cur === "back" || cur === "left" || cur === "right") dpadRemove(cur, id);
  if (nd === "forward" || nd === "back" || nd === "left" || nd === "right") {
    dpadAdd(nd, id); fingerBtn[id] = nd;
    if (menuTouch[id]) menuTouch[id].btn = nd;
  } else if (nd === "jump") {
    jumpAdd(id); fingerBtn[id] = "jump";
    if (menuTouch[id]) menuTouch[id].btn = "jump";
  } else {
    delete fingerBtn[id];
    if (menuTouch[id]) menuTouch[id].btn = "none";
  }
}

/* ---------- core touch handlers (GUI coords + client px for raw) ---------- */
function handleStart(id, gx, gy, cx, cy) {
  if (!enabled) return false;
  sawTouchFinger = true;
  forceTouchLock();
  var g = G();
  var hasScreen = !!(g && g.screens && g.screens.current);
  var L = layout();
  /* buttons first */
  var btn = pressButtonAt(gx, gy, L, id);
  if (btn) { activeCount++; menuTouch[id] = { kind: "btn", btn: btn }; return true; }
  if (hasScreen) {
    /* taps fall through to the open screen (mouse path) */
    if (screenDown(gx, gy, cx, cy)) { activeCount++; menuTouch[id] = { kind: "screen" }; focusKbIfTextScreen(); return true; }
    return false;
  }
  if (!inWorld()) return false;
  /* hotbar direct select (Bedrock-style) */
  var slot = hotbarSlotAt(gx, gy);
  if (slot >= 0) { selectHotbar(slot); hotIds[id] = true; activeCount++; return true; }
  var W = L ? L.W : 400, H = L ? L.H : 400;
  /* lower-left outside the D-pad squares: swallow (no look/attack there) */
  if (gx < W * 0.44 && gy > H * 0.28) return true;
  /* look */
  if (looks[id]) return true;
  looks[id] = { x: gx, y: gy, t: Date.now(), moved: 0, long: false, timer: 0, cx: cx, cy: cy };
  (function (lid) {
    looks[lid].timer = setTimeout(function () {
      var cur = looks[lid];
      if (cur && cur.moved < 14 && !cur.long) {
        cur.long = true;
        setMouseBtn(2, true);
        setTimeout(function () { setMouseBtn(2, false); }, 130);
      }
    }, 480);
  })(id);
  activeCount++;
  return true;
}
function handleMove(id, gx, gy) {
  if (!enabled) return;
  if (menuTouch[id]) {
    if (menuTouch[id].kind === "screen") screenMove(gx, gy, gx, gy);
    else slideButton(id, gx, gy);
    return;
  }
  if (hotIds[id]) {
    var s = hotbarSlotAt(gx, gy);
    if (s >= 0) selectHotbar(s);
    return;
  }
  var cur = looks[id];
  if (!cur) return;
  var dx2 = gx - cur.x, dy2 = gy - cur.y;
  cur.x = gx; cur.y = gy;
  if (dx2 > 60) dx2 = 60; else if (dx2 < -60) dx2 = -60;
  if (dy2 > 60) dy2 = 60; else if (dy2 < -60) dy2 = -60;
  cur.moved += Math.abs(dx2) + Math.abs(dy2);
  if (cur.moved > 10 && inGame()) {
    try {
      var inp = INP();
      if (inp) { inp.dx += dx2 * 1.6; inp.dy += dy2 * 1.6; }
    } catch (e) {}
  }
}
function handleEnd(id, gx, gy, cx, cy) {
  if (!enabled) return;
  if (menuTouch[id]) {
    var k = menuTouch[id];
    delete menuTouch[id];
    activeCount = Math.max(0, activeCount - 1);
    if (k.kind === "btn") releaseButtonKind(k.btn, id);
    else screenUp(cx === undefined ? gx : cx, cy === undefined ? gy : cy);
    if (Object.keys(menuTouch).length === 0 && chatInput && document.activeElement === chatInput && !screenHasTextField() && Date.now() - kbFocusT > 2000) {
      try { chatInput.value = ""; lastVal = ""; chatInput.blur(); } catch (e) {}
    }
    return;
  }
  if (hotIds[id]) { delete hotIds[id]; activeCount = Math.max(0, activeCount - 1); return; }
  var cur = looks[id];
  if (!cur) return;
  try { clearTimeout(cur.timer); } catch (e) {}
  delete looks[id];
  activeCount = Math.max(0, activeCount - 1);
  if (!cur.long && Date.now() - cur.t < 350 && cur.moved < 14) {
    /* tap = attack */
    setMouseBtn(0, true);
    setTimeout(function () { setMouseBtn(0, false); }, 70);
    focusKbIfTextScreen();
  }
}

/* ---------- event wiring (TouchEvents carry fingers; PointerEvents cover
     touch/pen only — mouse keeps the normal desktop path untouched) ---------- */
function eachTouch(e, fn) {
  var out = [];
  try {
    var ts = e && e.changedTouches;
    if (ts && typeof ts.length === "number") {
      for (var i = 0; i < ts.length; i++) out.push(fn(ts[i]));
    }
  } catch (_) {}
  return out;
}
function bindNative() {
  window.addEventListener("touchstart", function (e) {
    if (!enabled) return;
    var g = G();
    var open = inWorld() || (g && g.screens && g.screens.current);
    if (!open) return;
    var any = false;
    eachTouch(e, function (t) {
      var p = toGui(t.clientX, t.clientY);
      if (!p) return;
      any = true;
      handleStart("t" + t.identifier, p[0], p[1], t.clientX, t.clientY);
    });
    if (any) { try { e.preventDefault(); } catch (_) {} }
  }, { passive: false });
  window.addEventListener("touchmove", function (e) {
    if (!enabled) return;
    var any = false;
    eachTouch(e, function (t) {
      var id = "t" + t.identifier;
      if (!looks[id] && !fingerBtn[id] && !hotIds[id] && !menuTouch[id]) return;
      var p = toGui(t.clientX, t.clientY);
      if (!p) return;
      any = true;
      handleMove(id, p[0], p[1]);
    });
    if (any) { try { e.preventDefault(); } catch (_) {} }
  }, { passive: false });
  var ender = function (e) {
    if (!enabled) return;
    eachTouch(e, function (t) {
      var id = "t" + t.identifier;
      if (!looks[id] && !fingerBtn[id] && !hotIds[id] && !menuTouch[id]) return;
      var p = toGui(t.clientX, t.clientY) || [t.clientX, t.clientY];
      handleEnd(id, p[0], p[1], t.clientX, t.clientY);
    });
  };
  window.addEventListener("touchend", ender);
  window.addEventListener("touchcancel", function (e) {
    if (!enabled) return;
    eachTouch(e, function (t) {
      var id = "t" + t.identifier;
      handleEnd(id, 0, 0, t.clientX, t.clientY);
    });
  });
  /* non-TouchEvent browsers (desktop touchscreens without TouchEvents):
     PointerEvents with touch/pen only. */
  window.addEventListener("pointerdown", function (e) {
    if (!enabled) return;
    if (!(e.pointerType === "touch" || e.pointerType === "pen")) return;
    try { if (("ontouchstart" in window) || navigator.maxTouchPoints > 0) return; } catch (_) {}
    var p = toGui(e.clientX, e.clientY);
    if (!p) return;
    handleStart("p" + e.pointerId, p[0], p[1], e.clientX, e.clientY);
  });
  window.addEventListener("pointermove", function (e) {
    if (!enabled) return;
    if (!(e.pointerType === "touch" || e.pointerType === "pen")) return;
    try { if (("ontouchstart" in window) || navigator.maxTouchPoints > 0) return; } catch (_) {}
    var id = "p" + e.pointerId;
    if (!looks[id] && !fingerBtn[id] && !hotIds[id] && !menuTouch[id]) return;
    var p = toGui(e.clientX, e.clientY);
    if (!p) return;
    handleMove(id, p[0], p[1]);
  }, { passive: true });
  window.addEventListener("pointerup", function (e) {
    if (!enabled) return;
    if (!(e.pointerType === "touch" || e.pointerType === "pen")) return;
    try { if (("ontouchstart" in window) || navigator.maxTouchPoints > 0) return; } catch (_) {}
    var p = toGui(e.clientX, e.clientY) || [e.clientX, e.clientY];
    handleEnd("p" + e.pointerId, p[0], p[1], e.clientX, e.clientY);
  });
  window.addEventListener("pointercancel", function (e) {
    if (!enabled) return;
    if (!(e.pointerType === "touch" || e.pointerType === "pen")) return;
    handleEnd("p" + e.pointerId, 0, 0, e.clientX, e.clientY);
  });
}

/* ---------- native rendering (patched onto the live screens renderer) ----------
   Drawn AFTER screens.render (screens draw after the HUD in game.js), so the
   system bar stays visible and tappable on top of open menus — it is the
   touch way out of inventory/pause/chat. One wrapper only (no HUD patch,
   so nothing draws twice). */
var patchedFor = null;
function patchHud() {
  try {
    var g = G();
    if (!g || !g.screens) return;
    if (patchedFor === g.screens) return;
    if (g.screens._touchPatched) { patchedFor = g.screens; return; }
    var orig = g.screens.render;
    if (typeof orig !== "function") return;
    var self = g.screens;
    g.screens.render = function (gui, partial) {
      var r = orig.call(self, gui, partial);
      try { renderTouch(gui); } catch (e) {}
      return r;
    };
    g.screens._touchPatched = true;
    patchedFor = g.screens;
  } catch (e) {}
}
/* Touch-styled button: translucent dark fill + hairline border + centered
   label. Deliberately NOT the grey PC-menu widget — these belong to thumbs. */
function actDraw(gui, r, label, active) {
  try {
    var fill = active ? 0x90FFFFFF : 0x50000000;
    gui.rect(r.x, r.y, r.x + r.w, r.y + r.h, fill);
    var bc = active ? 0xFFFFFFA0 : 0xFFA0A0A0;
    gui.rect(r.x, r.y, r.x + r.w, r.y + 1, bc);
    gui.rect(r.x, r.y + r.h - 1, r.x + r.w, r.y + r.h, bc);
    gui.rect(r.x, r.y, r.x + 1, r.y + r.h, bc);
    gui.rect(r.x + r.w - 1, r.y, r.x + r.w, r.y + r.h, bc);
    gui.textCentered(label, r.x + Math.floor(r.w / 2), r.y + Math.floor((r.h - 8) / 2), 0xFFFFFFFF, true);
  } catch (e) {}
}
/* ---------- real Bedrock icon art (vanilla touch textures, local files) ----------
   PNGs ship under src/mc1194/touch-icons/ and load through the page fetch
   path. Decoded once to raw RGBA, uploaded via gui.assets.makeTexture
   (nearest filter = crisp pixels), drawn with gui.quad so we control alpha
   (Bedrock buttons are translucent). Until a texture is ready, the legacy
   rect-art fallback below draws so controls never go blank. */
var ICON_FILES = {
  up: "up.png", up_pressed: "up_pressed.png",
  down: "down.png", down_pressed: "down_pressed.png",
  left: "left.png", left_pressed: "left_pressed.png",
  right: "right.png", right_pressed: "right_pressed.png",
  jump_dpad: "jump_dpad.png", jump_dpad_pressed: "jump_dpad_pressed.png",
  sneak_dpad: "sneak_dpad.png", sneak_dpad_pressed: "sneak_dpad_pressed.png",
  flyingascend: "flyingascend.png", flyingascend_pressed: "flyingascend_pressed.png",
  flyingdescend: "flyingdescend.png", flyingdescend_pressed: "flyingdescend_pressed.png",
  dismount: "dismount.png",
  pause_icon: "pause_icon.png", comment: "comment.png", elipses: "elipses.png",
  arrow_down: "arrow_down.png", keyboard_and_mouse_glyph: "keyboard_and_mouse_glyph.png",
  chat_send: "chat_send.png"
};
var SYS_ICON = { II: "pause_icon", INV: "elipses", CHAT: "comment", DROP: "arrow_down", KB: "keyboard_and_mouse_glyph" };
var iconPx = {};   /* name -> {w,h,data} once decoded */
var iconTex = {};  /* name -> {assets,tex} once uploaded */
var iconsWanted = false;
function wantIcons() {
  if (iconsWanted) return;
  iconsWanted = true;
  try {
    Object.keys(ICON_FILES).forEach(function (n) {
      fetch("src/mc1194/touch-icons/" + ICON_FILES[n]).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.arrayBuffer();
      }).then(function (buf) {
        return createImageBitmap(new Blob([buf], { type: "image/png" }));
      }).then(function (bmp) {
        var bw = bmp.width, bh = bmp.height;
        var cv = new OffscreenCanvas(bw, bh);
        var cx2 = cv.getContext("2d");
        cx2.drawImage(bmp, 0, 0);
        var id = cx2.getImageData(0, 0, bw, bh);
        try { if (bmp.close) bmp.close(); } catch (_) {}
        iconPx[n] = { w: bw, h: bh, data: new Uint8Array(id.data) };
      }).catch(function () {});
    });
  } catch (e) {}
}
function iconTexFor(gui, name) {
  try {
    var px = iconPx[name];
    if (!px || !gui || !gui.assets || typeof gui.assets.makeTexture !== "function") return null;
    var c = iconTex[name];
    if (c && c.assets === gui.assets && c.tex) return c.tex;
    var t = gui.assets.makeTexture("touchicon/" + name, px.w, px.h, px.data);
    if (!t) return null;
    iconTex[name] = { assets: gui.assets, tex: t };
    return t;
  } catch (e) { return null; }
}
/* stretch-fit (square buttons: source and rect are both square) */
function iconDraw(gui, r, name, alpha) {
  try {
    var t = iconTexFor(gui, name);
    if (!t) return false;
    gui.quad(t, r.x, r.y, r.x + r.w, r.y + r.h, 0, 0, 1, 1, [1, 1, 1, alpha == null ? 1 : alpha]);
    return true;
  } catch (e) {
    try { delete iconTex[name]; } catch (_) {}
    return false;
  }
}
/* jump_dpad/sneak_dpad (+pressed) carry almost no border in the vanilla
   art (transparent outer ring, only corner ticks — the D-pad arrows have a
   full 1px frame instead), so drawn full-bleed they look borderless next
   to the D-pad. Draw a matching black frame under the icon's transparent
   margin: thickness tracks the texture's own 1px/22 border proportion. */
function iconFrameBtn(gui, r, name, alpha) {
  try {
    if (!iconTexFor(gui, name)) return false;
    var t = Math.max(1, Math.round(r.w / 22));
    var fc = 0xCC000000; /* 0.8 black = the iconDraw alpha below */
    gui.rect(r.x, r.y, r.x + r.w, r.y + t, fc);
    gui.rect(r.x, r.y + r.h - t, r.x + r.w, r.y + r.h, fc);
    gui.rect(r.x, r.y, r.x + t, r.y + r.h, fc);
    gui.rect(r.x + r.w - t, r.y, r.x + r.w, r.y + r.h, fc);
  } catch (e) {}
  return iconDraw(gui, r, name, alpha);
}
/* aspect-fit centered (top-bar glyphs, SEND, LEAVE) */
function iconDrawFit(gui, r, name, alpha) {
  try {
    var px = iconPx[name];
    var t = iconTexFor(gui, name);
    if (!px || !t) return false;
    var dw = r.w, dh = Math.round(r.w * px.h / px.w);
    if (dh > r.h) { dh = r.h; dw = Math.round(r.h * px.w / px.h); }
    if (dw < 1) dw = 1; if (dh < 1) dh = 1;
    var dx = r.x + Math.floor((r.w - dw) / 2), dy = r.y + Math.floor((r.h - dh) / 2);
    gui.quad(t, dx, dy, dx + dw, dy + dh, 0, 0, 1, 1, [1, 1, 1, alpha == null ? 1 : alpha]);
    return true;
  } catch (e) {
    try { delete iconTex[name]; } catch (_) {}
    return false;
  }
}
function iconInfo() {
  try {
    var r = {};
    for (var k in iconPx) {
      var d = iconPx[k].data, s = 0;
      for (var i = 0; i < d.length; i += 401) s += d[i];
      r[k] = iconPx[k].w + "x" + iconPx[k].h + " sum" + s + (iconTex[k] ? "+tex" : "-tex");
    }
    return r;
  } catch (e) { return { err: String(e) }; }
}
/* Legacy rect-art fallback (used only until the real icons finish loading).
   Bedrock-style square button + triangle arrow drawn from rects
   (the engine font has no arrow glyphs, so text cannot draw them). */
function bedrockBtn(gui, r, active) {
  try {
    var fill = active ? 0x70FFFFFF : 0x48000000;
    gui.rect(r.x, r.y, r.x + r.w, r.y + r.h, fill);
    var bc = active ? 0xFFFFFFFF : 0xFFB0B0B0;
    gui.rect(r.x, r.y, r.x + r.w, r.y + 1, bc);
    gui.rect(r.x, r.y + r.h - 1, r.x + r.w, r.y + r.h, bc);
    gui.rect(r.x, r.y, r.x + 1, r.y + r.h, bc);
    gui.rect(r.x + r.w - 1, r.y, r.x + r.w, r.y + r.h, bc);
  } catch (e) {}
}
function triDraw(gui, cx, cy, dir, size, color) {
  try {
    var n = 5, i, w, hh = Math.floor(size / n) + 1;
    for (i = 0; i < n; i++) {
      w = Math.floor(size * (i + 1) / n / 2);
      if (dir === "up") gui.rect(cx - w, cy - Math.floor(size / 2) + Math.floor(size * i / n), cx + w, cy - Math.floor(size / 2) + Math.floor(size * i / n) + hh, color);
      else if (dir === "down") gui.rect(cx - w, cy + Math.floor(size / 2) - Math.floor(size * i / n) - hh, cx + w, cy + Math.floor(size / 2) - Math.floor(size * i / n), color);
      else if (dir === "left") gui.rect(cx - Math.floor(size / 2) + Math.floor(size * i / n), cy - w, cx - Math.floor(size / 2) + Math.floor(size * i / n) + hh, cy + w, color);
      else gui.rect(cx + Math.floor(size / 2) - Math.floor(size * i / n) - hh, cy - w, cx + Math.floor(size / 2) - Math.floor(size * i / n), cy + w, color);
    }
  } catch (e) {}
}
function arrowBtn(gui, r, dir, active, scale) {
  bedrockBtn(gui, r, active);
  triDraw(gui, r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2), dir,
    Math.floor(Math.min(r.w, r.h) * (scale || 0.45)), active ? 0xFFFFFFFF : 0xFFE8E8E8);
}
/* top-bar glyphs (rect primitives, Bedrock icon look) */
function sysIcon(gui, r, id, active) {
  bedrockBtn(gui, r, active);
  var c = 0xFFF0F0F0;
  var cx = r.x + Math.floor(r.w / 2), cy = r.y + Math.floor(r.h / 2);
  try {
    if (id === "II") {
      gui.rect(cx - 4, cy - 4, cx - 1, cy + 4, c);
      gui.rect(cx + 1, cy - 4, cx + 4, cy + 4, c);
    } else if (id === "INV") {
      var x0 = cx - 5, x1 = cx + 5, y0 = cy - 4, y1 = cy + 4;
      gui.rect(x0, y0, x1, y0 + 1, c); gui.rect(x0, y1 - 1, x1, y1, c);
      gui.rect(x0, y0, x0 + 1, y1, c); gui.rect(x1 - 1, y0, x1, y1, c);
      gui.rect(x0, cy - 1, x1, cy + 1, c);
    } else if (id === "CHAT") {
      gui.rect(cx - 5, cy - 3, cx + 5, cy + 3, c);
      gui.rect(cx - 3, cy + 3, cx - 1, cy + 5, c);
    } else if (id === "DROP") {
      triDraw(gui, cx, cy - 1, "down", 7, c);
      gui.rect(cx - 4, cy + 4, cx + 4, cy + 5, c);
    } else { /* KB */
      gui.rect(cx - 5, cy - 3, cx + 5, cy + 3, c);
      gui.rect(cx - 3, cy - 1, cx - 1, cy + 1, 0xFF000000);
      gui.rect(cx, cy - 1, cx + 2, cy + 1, 0xFF000000);
    }
  } catch (e) {}
}
function renderTouch(gui) {
  if (!enabled) return;
  var g = G();
  if (!g || !g.inWorld) return;
  if (!sawTouchFinger && !forceOn) return; /* laptop: stay invisible until a finger */
  if (g.settings && g.settings.hideGui) return;
  if (g.hideGui) return;
  var L = layout();
  if (!L) return;
  var game = inGame();
  var flying = game && isFlying();
  var riding = game && isRiding();
  /* Position readout top-left (Bedrock-style) */
  if (game) {
    try {
      var pl = g.player;
      if (pl && isFinite(pl.x) && isFinite(pl.y) && isFinite(pl.z)) {
        gui.text("Position: " + Math.floor(pl.x) + ", " + Math.floor(pl.y) + ", " + Math.floor(pl.z),
          4, 3, 0xFFFFFFFF, true);
      }
    } catch (e) {}
  }
  /* D-pad cross bottom-left + JUMP square bottom-right (real Bedrock art) */
  if (game) {
    wantIcons();
    if (!iconDraw(gui, L.dpad.up, !holdersEmpty(dpadHolders.forward) ? "up_pressed" : "up", 0.8))
      arrowBtn(gui, L.dpad.up, "up", !holdersEmpty(dpadHolders.forward));
    if (!iconDraw(gui, L.dpad.left, !holdersEmpty(dpadHolders.left) ? "left_pressed" : "left", 0.8))
      arrowBtn(gui, L.dpad.left, "left", !holdersEmpty(dpadHolders.left));
    if (!iconDraw(gui, L.dpad.right, !holdersEmpty(dpadHolders.right) ? "right_pressed" : "right", 0.8))
      arrowBtn(gui, L.dpad.right, "right", !holdersEmpty(dpadHolders.right));
    if (!iconDraw(gui, L.dpad.down, !holdersEmpty(dpadHolders.back) ? "down_pressed" : "down", 0.8))
      arrowBtn(gui, L.dpad.down, "down", !holdersEmpty(dpadHolders.back));
    var snkOn = toggle.sneak || (g.input && g.input.down && g.input.down.has(bindCode("sneak", "ShiftLeft")));
    if (!iconFrameBtn(gui, L.dpad.snk, snkOn ? "sneak_dpad_pressed" : "sneak_dpad", 0.8)) {
      bedrockBtn(gui, L.dpad.snk, !!snkOn);
      triDraw(gui, L.dpad.snk.x + Math.floor(L.dpad.snk.w / 2), L.dpad.snk.y + Math.floor(L.dpad.snk.h / 2),
        "down", Math.floor(Math.min(L.dpad.snk.w, L.dpad.snk.h) * 0.35), snkOn ? 0xFFFFFFFF : 0xFFE8E8E8);
    }
    var jumpHeld = !holdersEmpty(jumpHolders);
    if (flying) {
      if (!iconDraw(gui, L.jump, jumpHeld ? "flyingascend_pressed" : "flyingascend", 0.8))
        arrowBtn(gui, L.jump, "up", jumpHeld);
      if (!iconDraw(gui, L.flydn, snkOn ? "flyingdescend_pressed" : "flyingdescend", 0.8))
        arrowBtn(gui, L.flydn, "down", !!snkOn);
    } else {
      if (!iconFrameBtn(gui, L.jump, jumpHeld ? "jump_dpad_pressed" : "jump_dpad", 0.8))
        arrowBtn(gui, L.jump, "up", jumpHeld);
    }
    if (riding) {
      if (!iconDrawFit(gui, L.leave, "dismount", 0.9)) actDraw(gui, L.leave, "LEAVE", false);
    }
    if (spectatorActive()) { actDraw(gui, L.prev, "<", false); actDraw(gui, L.next, ">", false); }
  }
  /* SEND while typing */
  try {
    if (screenHasTextField()) {
      if (!iconDrawFit(gui, L.send, "chat_send", 1)) actDraw(gui, L.send, "SEND", false);
    }
  } catch (e) {}
  /* top icon bar (world + menus; the way out of screens on touch) */
  for (var i = 0; i < L.sys.length; i++) {
    var sr = L.sys[i];
    if (!iconDrawFit(gui, sr, SYS_ICON[sr.id] || "elipses", 1)) sysIcon(gui, sr, sr.id, false);
  }
  if (wantDebug) {
    try {
      var h = [];
      try { var inp = INP(); if (inp && inp.down) inp.down.forEach(function (c) { h.push(c); }); } catch (_) {}
      var nb = 0;
      for (var bi2 in fingerBtn) nb++;
      gui.text("touch n=" + activeCount + " btn=" + nb + " down=" + (h.join("+") || "-"),
        2, L.H - 10, 0xFF00FF00, false);
    } catch (e) {}
  }
}

/* ---------- boot ---------- */
buildKbInput();
bindNative();
wantIcons();
try { if (window.__mcPollTouch) clearInterval(window.__mcPollTouch); } catch (e) {}
window.__mcPollTouch = setInterval(function () {
  patchHud();
  applyCanvasFlags();
  try {
    var g = G();
    if (g && g.settings && !g.settings.touchscreen) { try { g.settings.touchscreen = true; } catch (e) {} }
  } catch (e) {}
  forceTouchLock();
}, 500);
/* iOS only honors focus() for the keyboard inside a raw touchend handler. */
(function () {
  window.addEventListener("touchend", function () {
    if (enabled) focusKbIfTextScreen();
  }, { passive: true });
})();

/* test / debug hooks (harness-compatible where names overlap) */
window.__mcTouch = {
  look: function (dx, dy) {
    try { var inp = INP(); if (inp) { inp.dx += dx; inp.dy += dy; } } catch (e) {}
  },
  key: function (code, key, down) { if (down) pressCode(code); else releaseCode(code); },
  tap: function (x, y) { setMouseBtn(0, true); setTimeout(function () { setMouseBtn(0, false); }, 70); },
  rtap: function (x, y) { setMouseBtn(2, true); setTimeout(function () { setMouseBtn(2, false); }, 130); },
  wheel: function (dir) {
    try {
      var g = G(); if (!g) return;
      if (spectatorActive()) g.hud.spectatorGui.onMouseScroll(dir > 0 ? 1 : -1);
      else g.selectSlot(((g.heldSlot + (dir > 0 ? 1 : -1)) % 9 + 9) % 9);
    } catch (e) {}
  },
  selectSlot: selectHotbar,
  hotbarAt: hotbarSlotAt,
  hotbarRect: function () {
    try {
      var gui = GUI(); if (!gui) return null;
      return { left: gui.width / 2 - 91, right: gui.width / 2 + 91, top: gui.height - 22, bottom: gui.height, slotW: 182 / 9 };
    } catch (e) { return null; }
  },
  setVisible: function (v) { enabled = !!v; if (enabled) { try { globalThis.__mcTouchMode = true; } catch (e) {} sawTouchFinger = true; } applyCanvasFlags(); },
  isEnabled: function () { return enabled; },
  state: function () {
    var h = [];
    try { var inp = INP(); if (inp && inp.down) inp.down.forEach(function (c) { h.push(c); }); } catch (e) {}
    return { touchMode: !!globalThis.__mcTouchMode, held: h, mode: inGame() ? "game" : "menu", native: true };
  },
  _test: {
    setForceGame: function (v) { forceGame = !!v; },
    dbgToggle: function () { wantDebug = !wantDebug; return wantDebug ? "on" : "off"; },
    counts: function () { var n = 0; for (var k in fingerBtn) n++; return { dpad: n, looks: Object.keys(looks).length, active: activeCount }; },
    /* finger simulation in GUI coords (drives the same paths as real touches) */
    finger: function (type, id, x, y) {
      id = String(id);
      if (type === "start") return handleStart(id, x, y, x, y);
      if (type === "move") return handleMove(id, x, y);
      return handleEnd(id, x, y, x, y);
    },
    layout: function () { return layout(); }
  },
  hasTextField: function () { return screenHasTextField(); },
  focusKb: function () { focusKb(); },
  inputPath: function () { return "native"; },
  debug: function () {
    var h = [];
    try { var inp = INP(); if (inp && inp.down) inp.down.forEach(function (c) { h.push(c); }); } catch (e) {}
    return { path: "native", dpad: fingerBtn, held: h, icons: iconInfo() };
  }
};
})();
