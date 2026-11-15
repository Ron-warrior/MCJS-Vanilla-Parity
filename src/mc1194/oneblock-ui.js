/* MinecraftJS Skyblock — welcome screen (part 2: name + skin picker).
 * Native engine screen for all players (touch included, via the shared
 * on-screen keyboard). Loads after the ticker (see boot1194.js).
 * 1.15.2 port: verbatim — every touchpoint (assets.source.bytes,
 * makeTexture, t.tex/drawImage, accounts, ng.*) matches the 1152 engine.
 */

(function () {
"use strict";

const OB_ROOM = "oneblock";
const OB_SEED = 20261025;
const OB_TYPE = 4;
const OB_LS_NAME = "mcjs.oneblock.name";
const OB_LS_SKIN = "mcjs.oneblock.skin";

const OB_LS_ACCOUNTS = "mcjs.oneblock.accounts"; // JSON [{name, skin}], most-recent-first, cap 8

const OBU = { skin: "steve", entered: false };

// Known profiles, most-recent-first. Migrates the pre-accounts single
// profile (OB_LS_NAME) once, so existing players keep their name.
function obAccounts() {
  let list = [];
  try {
    const a = JSON.parse(localStorage.getItem(OB_LS_ACCOUNTS) || "[]");
    if (Array.isArray(a)) list = a.filter(x => x && typeof x.name === "string" && x.name.length >= 3);
  } catch (e) { list = []; }
  if (!list.length) {
    try {
      const n = (localStorage.getItem(OB_LS_NAME) || "").trim();
      if (n) {
        const s = localStorage.getItem(OB_LS_SKIN) === "alex" ? "alex" : "steve";
        list = [{ name: n, skin: s }];
        try { localStorage.setItem(OB_LS_ACCOUNTS, JSON.stringify(list)); } catch (e) {}
      }
    } catch (e) {}
  }
  return list;
}
function obTouchAccount(name, skin) {
  try {
    // names are case-insensitive (servers treat them that way): one entry
    const low = name.toLowerCase();
    const rest = obAccounts().filter(a => a && String(a.name).toLowerCase() !== low);
    rest.unshift({ name, skin });
    localStorage.setItem(OB_LS_ACCOUNTS, JSON.stringify(rest.slice(0, 8)));
  } catch (e) {}
}
// Make the engine use this profile (username + active offline account).
// Idempotent: skips the account add when it's already active.
function obEnsureEngineAccount(name) {
  try {
    const g = obGame();
    if (!g) return;
    try {
      if (g.settings && g.settings.username !== name) {
        g.settings.username = name;
        if (g.settings.save) g.settings.save();
      }
    } catch (e) {}
    try {
      const accs = g.accounts;
      let curName = null;
      try {
        const cur = accs && accs.active && accs.active();
        curName = cur && (cur.name || cur.username);
      } catch (e) {}
      if (curName === name) return;
      if (accs && accs.addOffline && accs.setActive) {
        const a = accs.addOffline(name);
        if (a && a.id !== undefined) accs.setActive(a.id);
      }
    } catch (e) {}
  } catch (e) {}
}
// Log a profile in: persist it, bump it to most-recent, sync the engine.
// Returns the name, or null when invalid (no UI side effects).
function obApplyProfile(name, skin) {
  name = obCleanName(name);
  if (name.length < 3) return null;
  skin = skin === "alex" ? "alex" : "steve";
  OBU.skin = skin;
  try {
    localStorage.setItem(OB_LS_NAME, name);
    localStorage.setItem(OB_LS_SKIN, skin);
    localStorage.setItem("mcjs.realms.name", name);
  } catch (e) {}
  obTouchAccount(name, skin);
  obEnsureEngineAccount(name);
  OBU.entered = true;
  return name;
}
// Silent login on reload: no gate. The engine's active account is the
// source of truth for identity — if it's a real name it wins (this also
// adopts engine-known profiles into our account list). Otherwise our
// most-recent profile is used. No saved profile anywhere -> full gate.
function obAutoLogin() {
  try {
    if (OBU.entered || obNativeOpen()) return true;
    const accs = obAccounts();
    let pick = null;
    try {
      const g = obGame();
      const cur = g && g.accounts && g.accounts.active && g.accounts.active();
      const cn = obCleanName(cur && (cur.name || cur.username));
      if (cn.length >= 3 && cn !== "WebPlayer") {
        pick = accs.find(a => a && String(a.name).toLowerCase() === cn.toLowerCase())
          || { name: cn, skin: OBU.skin };
      }
    } catch (e) { pick = null; }
    if (!pick) {
      if (!accs.length) return false;
      pick = accs[0];
    }
    if (!obApplyProfile(pick.name, pick.skin)) return false;
    try { OBN = { name: pick.name, skin: pick.skin, status: "" }; } catch (e) {}
    return true;
  } catch (e) { return false; }
}
// Forget the login (this browser): the gate returns on next title visit,
// listing every known account as a one-tap option.
function obLogout() {
  try { OBU.entered = false; } catch (e) {}
  try { obShow(); } catch (e) {}
}

function obGame() { return globalThis.game; }
function obCleanName(raw) {
  return String(raw || "").trim().replace(/[^A-Za-z0-9_]/g, "").slice(0, 16);
}

// Cached skin PNGs as <img> elements (for the native preview texture upload).
const OB_IMG = {};
function obSkinImage(kind) {
  if (OB_IMG[kind]) return OB_IMG[kind];
  const p = (async () => {
    try {
      const bytes = await obGame().assets.source.bytes("minecraft/textures/entity/" + kind + ".png");
      if (bytes && bytes.length > 100) {
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        try {
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
          if (img.width >= 64 && img.height >= 32) return img;
        } finally {
          try { URL.revokeObjectURL(url); } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  })();
  OB_IMG[kind] = p;
  return p;
}

function obSavedName() {
  try {
    const n = (localStorage.getItem(OB_LS_NAME) || "").trim();
    if (n) return n;
  } catch (e) {}
  try {
    const u = obGame() && obGame().settings && obGame().settings.username;
    if (u && u !== "WebPlayer") return String(u).slice(0, 16);
  } catch (e) {}
  return "";
}

function obSetStatus(s) {
  // Native screen owns its status line; nothing to do for headless callers.
  try { if (OBN) OBN.status = s || ""; } catch (e) {}
}

function obShow() {
  // Native only (all players, touch included — the screen owns an
  // on-screen keyboard). If the engine isn't harvestable yet, retry soon.
  try {
    if (openNativeWelcome()) return true;
  } catch (e) {}
  try {
    if (!OBU.entered && !obNativeOpen()) setTimeout(() => { try { obShow(); } catch (e2) {} }, 800);
  } catch (e) {}
  return false;
}
function obHide() {
  try {
    const ng = globalThis.__mcNativeGui;
    if (ng && obNativeOpen()) ng.dismiss();
  } catch (e) {}
}

// Profile source: the native screen state (the only UI now).
function obProfileName() {
  try {
    if (OBN) return obCleanName(OBN.name);
  } catch (e) {}
  return "";
}
function obProfileSkin() {
  try { if (OBN) return OBN.skin === "alex" ? "alex" : "steve"; } catch (e) {}
  return OBU.skin === "alex" ? "alex" : "steve";
}

// Validate + persist the name/skin profile. Returns the name, or null.
function obSaveProfile() {
  const name = obApplyProfile(obProfileName(), obProfileSkin());
  if (!name) {
    obSetStatus("Name needs 3–16 letters, numbers or _");
    try { if (OBN) OBN.status = "Name needs 3–16 letters, numbers or _"; } catch (e) {}
    return null;
  }
  return name;
}

// "Enter" button: save the profile and show the main menu (the title
// screen is underneath this overlay). The shared island is just one mode,
// so it gets the secondary link instead.
async function obEnter() {
  if (!obSaveProfile()) return;
  OBU.entered = true;
  obSetStatus("");
  obHide();
}

async function obPlay() {
  if (!obSaveProfile()) return;
  if (!globalThis.__mcRealms || !globalThis.__mcRealms.joinShared) {
    obSetStatus("Still loading — try again in a few seconds");
    return;
  }
  try { if (obGame().input && obGame().input.lock) obGame().input.lock(); } catch (e) {}
  obSetStatus("Entering…");
  obHide();
  try {
    await globalThis.__mcRealms.joinShared(OB_ROOM, OB_SEED, OB_TYPE);
    obSetStatus("");
  } catch (e) {
    obSetStatus("Couldn't join: " + ((e && e.message) || e));
    obShow();
  }
}

/* ---------------- native welcome screen (all players) ---------------- */

let OBN = null; // {name, skin, status} — form state for the native screen
const OB_TEX = {}; // kind -> engine texture object (null while loading/failed)

function nativeReady() {
  try {
    const ng = globalThis.__mcNativeGui;
    return !!(ng && ng.base && ng.button && ng.Field && ng.Keyboard && ng.open && ng.dismiss);
  } catch (e) { return false; }
}
function obNativeOpen() {
  try {
    const ng = globalThis.__mcNativeGui;
    const t = ng && ng.top && ng.top();
    return !!(t && t._isObWelcome);
  } catch (e) { return false; }
}

// Upload the skin PNG as an engine texture (nearest filter for crisp pixels).
function obEnsureTex(kind) {
  if (OB_TEX[kind] !== undefined) return;
  OB_TEX[kind] = null;
  (async () => {
    try {
      const img = await obSkinImage(kind);
      if (!img) return;
      const cv = document.createElement("canvas");
      cv.width = 64; cv.height = 64;
      const px = cv.getContext("2d");
      px.imageSmoothingEnabled = false;
      px.drawImage(img, 0, 0);
      const d = px.getImageData(0, 0, 64, 64);
      const g = obGame();
      try {
        OB_TEX[kind] = g.assets.makeTexture("mcjs-skin-" + kind, 64, 64, d.data, { filter: "nearest" });
      } catch (e) {
        OB_TEX[kind] = g.assets.makeTexture("mcjs-skin-" + kind, 64, 64, d.data);
      }
    } catch (e) {}
  })();
}

// Paper-doll body regions from the 64x64 skin layout: [sx,sy,sw,sh,dx,dy]
// in doll pixels (16 wide x 33 tall).
const OB_DOLL_PARTS = [
  [8, 8, 8, 8, 4, 0], [40, 8, 8, 8, 4, 0],
  [44, 20, 4, 12, 0, 8], [44, 20, 4, 12, 12, 8],
  [20, 20, 8, 12, 4, 8],
  [4, 20, 4, 12, 4, 20], [4, 20, 4, 12, 8, 20],
];

function openNativeWelcome() {
  try {
    const ng = globalThis.__mcNativeGui;
    if (obNativeOpen()) return true;
    if (!nativeReady()) return false;
    const Base = ng.base(), Btn = ng.button(), Field = ng.Field, Keyboard = ng.Keyboard;
    const g = obGame();
    if (!Base || !Btn || !Field || !Keyboard || !g) return false;
    if (!OBN) OBN = { name: "", skin: "steve", status: "" };
    try {
      const sv = obSavedName();
      if (sv) OBN.name = sv;
    } catch (e) {}
    try {
      const s = localStorage.getItem(OB_LS_SKIN);
      if (s === "alex" || s === "steve") OBN.skin = s;
    } catch (e) {}
    OBN.status = "";
    // known accounts (besides what's already typed) become one-tap options
    try {
      const sv2 = obCleanName(OBN.name).toLowerCase();
      OBN.accounts = obAccounts().filter(a => a && String(a.name).toLowerCase() !== sv2).slice(0, 3);
    } catch (e) { OBN.accounts = []; }
    OBN.subtitle = (OBN.accounts && OBN.accounts.length)
      ? "Welcome back — pick an account, or enter a new name"
      : "Choose your name and skin, then enter";
    obEnsureTex("steve");
    obEnsureTex("alex");
    const scr = new (class extends Base {
      constructor(gg) {
        super(gg);
        this.background = "dirt";
        this._isObWelcome = true;
      }
      onClose() {} // engine calls this on nested opens; obNativeOpen() is the live check
      close() { try { obHide(); } catch (e) {} }
      init() {
        this.buttons = []; this.fields = [];
        this._labels = [];
        this._kb = new Keyboard({
          target: () => (this._fName && this._fName.focused) ? this._fName : null,
          onDone: () => { try { this._doneCb && this._doneCb(); } catch (e) {} },
        });
        const W = this.width, H = this.height, cx = Math.floor(W / 2);
        const compact = H < 400;
        const colW = Math.min(360, W - 16);
        const px = cx - Math.floor(colW / 2);
        const prevW = 110, gap = 12;
        const rightW = colW - prevW - gap;
        const rx = px + prevW + gap;
        let y = compact ? 44 : 56;
        const mkBtn = (id, x, yy, w, label, cb) => {
          const b = new Btn(id, x, yy, w, 20, label, () => { try { cb(); } catch (e) {} });
          this.buttons.push(b); return b;
        };
        this._fName = new Field(rx, y + 12, rightW, 20, {
          text: OBN.name, maxLength: 16,
          onChange: (t) => { OBN.name = t; },
        });
        this.fields.push(this._fName);
        this._kb.track([{ o: this._fName, p: "y", base: this._fName.y }]);
        // touch players get the on-screen keyboard + a focused field
        try {
          if (globalThis.__mcTouchMode) {
            this._fName.focused = true;
            this._kb.visible = true;
          }
        } catch (e) {}
        mkBtn(30, rx, y + 58, rightW, () => (OBN.skin === "alex" ? "Alex — slim arms" : "Steve — classic arms"), () => {
          OBN.skin = OBN.skin === "alex" ? "steve" : "alex";
          try { localStorage.setItem(OB_LS_SKIN, OBN.skin); } catch (e) {}
        });
        const bw = colW;
        const bx = px;
        const by = y + 158;
        const tryDone = () => {
          const nm = obCleanName(OBN.name);
          if (nm.length < 3) { OBN.status = "Name needs 3–16 letters, numbers or _"; return; }
          OBN.name = nm;
          try { this._fName.setText(nm, false); } catch (e) {}
          obEnter();
        };
        this._doneCb = tryDone;
        const doneB = mkBtn(31, bx, by, bw, "Done", tryDone);
        const islB = mkBtn(32, bx, by + 26, bw, "Join the Skyblock island instead", () => { obPlay(); });
        // one-tap account options (only as many as fit above the bottom edge)
        try {
          const accs = (OBN.accounts || []).slice(0, 3);
          const room = H - (by + 52);
          const n = room >= 20 ? Math.min(accs.length, 1 + Math.floor((room - 20) / 26)) : 0;
          for (let ai = 0; ai < n; ai++) {
            const acc = accs[ai];
            mkBtn(40 + ai, bx, by + 52 + ai * 26, bw, "Play as " + acc.name, () => {
              OBN.name = acc.name; OBN.skin = acc.skin === "alex" ? "alex" : "steve";
              try { this._fName.setText(OBN.name, false); } catch (e) {}
              obEnter();
            });
          }
        } catch (e) {}
        this._kb.track(
          this.buttons.map((b) => ({ o: b, p: "y", base: b.y }))
            .concat([{ o: this._fName, p: "y", base: this._fName.y }])
        );
        this._layout = { px, rx, rightW, y, bx, bw, by };
      }
      key(e) {
        if (!e) return super.key(e);
        if (e.code === "Escape") return true; // the profile gate can't be skipped
        if (e.code === "Enter" || e.code === "NumpadEnter") {
          try { this._doneCb && this._doneCb(); } catch (err) {}
          return true;
        }
        return super.key(e);
      }
      mouseDown(x, y, b, i) {
        try { if (this._kb && this._kb.mouseDown(x, y)) return true; } catch (e) {}
        try { if (super.mouseDown(x, y, b)) { this._kb.syncTouch(this._fName && this._fName.focused, x, y); return true; } } catch (e) {}
        try { this._kb.syncTouch(false, x, y); } catch (e2) {}
        return false;
      }
      mouseUp() {
        try { super.mouseUp(); } catch (e) {}
      }
      tick() {
        try { super.tick(); } catch (e) {}
        try {
          this._kbS = this._kb.fitShift(8);
          this._kb.applyTick(this._kbS);
          this._kb.hideCovered(this.buttons);
        } catch (e) {}
      }
      renderContent(t) {
        const cx = Math.floor(this.width / 2);
        const L = this._layout || {};
        const sh = this._kbS || 0;
        t.textCentered("MinecraftJS", cx, 8, 16777215);
        t.textCentered(OBN.subtitle || "Choose your name and skin, then enter", cx, 22, 10526880);
        const px = L.px || 0, rx = L.rx || 0, y = (L.y || 56) - sh;
        // labels
        try {
          t.text("Username", rx, y, 8421504);
          t.text("Player Skin", rx, y + 46, 8421504);
        } catch (e) {}
        // preview panel + paper doll
        const S = 4, dw = 64, dh = 132;
        const ox = px + Math.floor((110 - dw) / 2), oy = y + 7;
        try {
          t.rect(px, y, px + 110, y + 146, 0xFF0B0B18);
          t.rect(px, y, px + 110, y + 1, 0xFFA0A0A0);
          t.rect(px, y + 145, px + 110, y + 146, 0xFFA0A0A0);
          t.rect(px, y, px + 1, y + 146, 0xFFA0A0A0);
          t.rect(px + 109, y, px + 110, y + 146, 0xFFA0A0A0);
        } catch (e) {}
        const tex = OB_TEX[OBN.skin];
        let T = null;
        try { T = tex ? t.tex(tex) : null; } catch (e) {}
        if (T) {
          for (const p of OB_DOLL_PARTS) {
            try { t.drawImage(T, p[0], p[1], p[2], p[3], ox + p[4] * S, oy + p[5] * S, p[2] * S, p[3] * S); } catch (e) {}
          }
        } else {
          try {
            t.rect(ox + 16, oy + 32, ox + 48, oy + 80, 0xFF3A3A3A);
            t.rect(ox + 16, oy, ox + 48, oy + 32, 0xFFC8915F);
          } catch (e) {}
        }
        // status + tip
        if (OBN.status) {
          try { t.textCentered(t.font ? t.font.trimToWidth(OBN.status, (L.bw || 200)) : OBN.status, cx, (L.by || 0) + 52 - (this._kbS || 0), 16777113); } catch (e) {}
        }
        try {
          if (!(this._kb && this._kb.visible)) {
            t.textCentered("SURVIVAL: no flying — bridge carefully, don't fall off!", cx, this.height - 24, 8421504);
          }
        } catch (e) {}
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

function obHookScreens() {
  const g = obGame();
  if (!g || !g.screens || g._obScreenPatched) return;
  g._obScreenPatched = true;
  const orig = g.screens.open.bind(g.screens);
  g.screens.open = function (screen) {
    const r = orig(screen);
    try {
      const cur = g.screens.current;
      if (cur && cur._isObWelcome) return r; // our own native screen: leave it alone
      const isTitle = !!(cur && cur.panorama === true);
      if (isTitle && !g.inWorld && !OBU.entered) {
        if (!obAutoLogin()) obShow();
      }
      else obHide();
    } catch (e) {}
    return r;
  };
}

function boot() {
  if (!globalThis.game || !globalThis.game.assets || !globalThis.game.assets.data ||
      !globalThis.game.assets.data.blocks ||
      !globalThis.__mcSingleplayer || !globalThis.__mcSingleplayer.state ||
      !globalThis.__mcRealms || !globalThis.__mcOneBlockTicker) {
    setTimeout(boot, 300);
    return;
  }
  try { globalThis.__mcOneBlockTicker.boot(); } catch (e) { console.error("[oneblock] ticker failed", e); }
  try { obHookScreens(); } catch (e) {}
  try {
    const g = globalThis.game;
    const invited = /realm=([a-z0-9-]{1,24})/i.test(location.hash || "");
    if (g.screens && g.screens.current && g.screens.current.panorama === true && !g.inWorld && !invited) {
      if (!obAutoLogin()) obShow();
    }
  } catch (e) {}
  globalThis.__mcOneBlock = { play: obPlay, enter: obEnter, ui: obShow, logout: obLogout, get skin() { return OBU.skin; } };
  globalThis.__mcOneBlock._test = {
    entered: () => OBU.entered,
    gateOpen: obNativeOpen,
    accounts: obAccounts,
    form: () => OBN,
    autoLogin: obAutoLogin,
    pick: (i) => { // same path as tapping the i-th "Play as" button
      const a = (OBN && OBN.accounts && OBN.accounts[i]) || null;
      if (!a) return false;
      OBN.name = a.name; OBN.skin = a.skin === "alex" ? "alex" : "steve";
      obEnter();
      return true;
    },
  };
  console.log("[oneblock] ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();

