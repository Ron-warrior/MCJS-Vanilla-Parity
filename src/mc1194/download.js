/* MinecraftJS Download: title-screen button + in-tab single-file builder.
 *
 * Builds the complete game (bundled code, data files, asset zips, mesh worker)
 * into one .html that boots from file:// with zero network for the full
 * client. Online-only pieces stay remote by design (music streams, mesh
 * intro, external-server sockets) and work whenever the device is online —
 * same as the site. Imported for side effects by boot1194.js. Hidden in file
 * builds (the button would have nothing to build — v1.3.1 lesson).
 *
 * UI lives in the built-in UI pipeline: a normal engine Screen (dirt
 * background, Buttons, gui.textCentered/gui.rect) opened over the title
 * screen — no DOM elements, no CSS. The finished file is delivered by a real
 * "Save file" Button tap, so the download always starts inside a fresh user
 * gesture (the old auto-click fired minutes after the tap with no activation
 * left and was silently blocked).
 *
 * v2.3.2 lessons:
 *  - 0-byte files: buildSingleFile() used to writer.close() internally AND
 *    runBuild closed again — the second close snapshotted an emptied parts
 *    array. The builder no longer closes; the caller owns the writer.
 */

import { Button } from "./js/gui/widgets.js";
import { Screen } from "./js/gui/screens/manager.js";
import { buildSingleFile, buildFileName } from "../tools/offline/build.js";

(function () {
"use strict";

if (globalThis.__mcOffline) return;

var BUILD_URL = "https://esm.sh/esbuild-wasm@0.21.5?bundle";
var WASM_URL = "https://esm.sh/esbuild-wasm@0.21.5/esbuild.wasm";

function game() { try { return globalThis.game; } catch (e) { return null; } }

/* ---------------- page io (fetch against the live site) ---------------- */

function pageIo(onFile) {
  return {
    async readText(path) {
      try { if (onFile) onFile(path); } catch (e) {}
      const r = await fetch(path);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
      return r.text();
    },
    async openStream(path) {
      const r = await fetch(path);
      if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
      if (!r.body) {
        const b = new Uint8Array(await r.arrayBuffer());
        return { total: b.length, chunks: (async function *() { yield b; })() };
      }
      let total = null;
      try { total = +r.headers.get("Content-Length") || null; } catch (e) {}
      const rd = r.body.getReader();
      const chunks = (async function *() {
        try {
          for (;;) {
            const out = await rd.read();
            if (out.done) break;
            yield out.value;
          }
        } finally { try { rd.releaseLock(); } catch (e) {} }
      })();
      return { total, chunks };
    },
  };
}

/* Writer: File System Access streams to disk (desktop Chrome/Edge), else we
 * accumulate parts and finish with a blob download. createWriter() starts the
 * picker SYNCHRONOUSLY — call it directly in the tap handler, before the
 * first await, or the picker throws "must be handling a user gesture".
 * close() resolves to null (file path) or {url,name,bytes} (blob path).
 * Lifecycle: the CALLER closes exactly once (buildSingleFile never closes). */
function createWriter(suggestedName, signal) {
  if (window.showSaveFilePicker) {
    const picked = (async () => {
      const h = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: "HTML file", accept: { "text/html": [".html"] } }],
      });
      if (signal && signal.aborted) throw new Error("cancelled");
      return h.createWritable();
    })();
    let w = null;
    return {
      write: async (s) => { if (!w) w = await picked; return w.write(s); },
      close: async () => { if (!w) w = await picked; await w.close(); return null; },
      abort: async () => { try { const x = await picked; await x.abort(); } catch (e) {} },
    };
  }
  const parts = [];
  return {
    write: (s) => { parts.push(s); return Promise.resolve(); },
    close: async () => {
      if (signal && signal.aborted) return null;
      const blob = new Blob(parts, { type: "text/html" });
      parts.length = 0;
      const url = URL.createObjectURL(blob);
      return { url, name: suggestedName, bytes: blob.size };
    },
    abort: async () => { parts.length = 0; },
  };
}

function fmtMB(n) {
  if (!(n > 0)) return "?";
  return (n / 1048576).toFixed(n > 104857600 ? 0 : 1) + " MB";
}

function wrapLines(gui, s, maxW) {
  try {
    if (gui && gui.font && gui.font.wrap) {
      const rows = gui.font.wrap(String(s), maxW);
      if (rows && rows.length) return rows.slice(0, 10);
    }
  } catch (e) {}
  const words = String(s).split(/\s+/);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur.length + 1 + w.length) * 6 > maxW) { out.push(cur); cur = w; }
    else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  return out.slice(0, 10);
}

/* ---------------- native download screen ---------------- */

class DlScreen extends Screen {
  constructor(g) {
    super(g);
    this.background = "dirt";
    this._isDlMenu = true;
    this._mode = "menu"; // menu | building | done
    this._status = "";
    this._bar = null; // [done,total] or null
    this._job = null; // {sig} while building
    this._res = null; // {kind:"blob",url,name,bytes} | {kind:"file",name}
    this._gone = false;
  }
  onClose() {
    this._gone = true;
    try { if (this._res && this._res.url) URL.revokeObjectURL(this._res.url); } catch (e) {}
    this._res = null;
  }
  key(e) {
    if (e && e.code === "Escape") {
      if (this._mode === "building" && this._job) {
        try { this._job.sig.aborted = true; } catch (err) {}
        this._status = "cancelling…";
        return true;
      }
      this.close();
      return true;
    }
    return super.key(e);
  }
  refresh() {
    try { this.buttons = []; this.fields = []; this.init(); } catch (e) {}
  }
  init() {
    this.buttons = [];
    const cx = Math.floor(this.width / 2);
    const mk = (id, x, y, w, label, fn, en) => {
      const b = new Button(id, x, y, w, 20, label, () => { try { fn(); } catch (e) {} });
      if (en === false) b.enabled = false;
      this.buttons.push(b);
      return b;
    };
    if (this._mode === "menu") {
      const bw = Math.min(200, Math.floor((this.width - 24) / 2));
      const y = this.height - 64;
      mk(1, cx - bw - 4, y, bw, "Full (~190 MB)", () => this.start(false));
      mk(2, cx + 4, y, bw, "Lite (~45 MB)", () => this.start(true));
      mk(0, cx - 100, y + 26, 200, "Close", () => this.close());
    } else if (this._mode === "building") {
      mk(0, cx - 100, this.height - 38, 200, "Cancel", () => {
        try { if (this._job) this._job.sig.aborted = true; } catch (e) {}
        this._status = "cancelling…";
      });
    } else {
      if (this._res && this._res.kind === "blob") {
        mk(1, cx - 104, this.height - 64, 200, "Save file", () => this.save());
        mk(0, cx - 104, this.height - 38, 200, "Back", () => this.close());
      } else {
        if (this._err) mk(1, cx - 104, this.height - 64, 200, "Try again", () => {
          this._err = null; this._mode = "menu"; this._status = ""; this.refresh();
        });
        mk(0, cx - 104, this.height - 38, 200, "Back", () => this.close());
      }
    }
  }
  infoText() {
    return "Full: everything, incl. all sounds. Lite: same game, no sounds (silent) — recommended on phones. " +
      "Singleplayer works fully offline; multiplayer/mesh needs internet, same as the site. " +
      (window.showSaveFilePicker
        ? "You will pick the save location first, then the game builds into it."
        : "This device can't pick a save location: tap Save file when it is ready and it lands in your downloads — keep this tab open until it arrives.") +
      " Your worlds stay in this browser.";
  }
  renderContent(gui) {
    const cx = Math.floor(this.width / 2);
    try { gui.textCentered("Download offline copy", cx, 24, 16777215); } catch (e) {}
    const maxW = Math.max(200, this.width - 40);
    let y = 44;
    try {
      const rows = wrapLines(gui, this.infoText(), maxW);
      for (const r of rows) { gui.textCentered(r, cx, y, 10526880); y += 11; }
    } catch (e) {}
    y += 8;
    if (this._err) {
      try {
        const rows = wrapLines(gui, "Failed: " + this._err, maxW);
        for (const r of rows) { gui.textCentered(r, cx, y, 16733525); y += 11; }
      } catch (e) {}
    } else if (this._status) {
      try {
        const rows = wrapLines(gui, this._status, maxW);
        for (const r of rows) { gui.textCentered(r, cx, y, 16777045); y += 11; }
      } catch (e) {}
      y += 4;
    }
    if (this._bar) {
      try {
        const w = Math.min(300, this.width - 40);
        const x0 = cx - Math.floor(w / 2);
        const done = this._bar[0], total = this._bar[1];
        const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
        gui.rect(x0 - 1, y - 1, x0 + w + 1, y + 9, 0xff000000);
        gui.rect(x0, y, x0 + w, y + 8, 0xff222222);
        gui.rect(x0, y, x0 + Math.floor(w * pct), y + 8, 0xff55bb55);
      } catch (e) {}
    }
  }
  save() {
    // Real button tap = fresh user gesture, so the download reliably starts.
    const r = this._res;
    if (!r || r.kind !== "blob" || !r.url) return;
    try {
      const a = document.createElement("a");
      a.href = r.url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { a.remove(); } catch (e) {} }, 5000);
      this._status = "Saving " + r.name + " (" + fmtMB(r.bytes) + ") — check your downloads. Keep this tab open until it finishes.";
    } catch (e) {
      this._status = "Save failed: " + ((e && e.message) || e);
    }
  }
  start(lite) {
    if (this._mode === "building") return;
    this._mode = "building";
    this._status = "";
    this._bar = null;
    this._res = null;
    this._err = null;
    const sig = { aborted: false };
    this._job = { sig };
    this.refresh();
    // Capture the tap gesture NOW: the save picker must open inside user
    // activation, before any await (import/init) expires it.
    const fname = buildFileName(!!lite);
    let writerP = null;
    let writerError = null;
    try {
      writerP = createWriter(fname, sig);
    } catch (e) { writerP = null; writerError = e; }
    runBuild(this, !!lite, writerP, writerError).then(
      () => { this._job = null; if (!this._gone) { this._mode = "done"; this.refresh(); } },
      (e) => {
        this._job = null;
        if (this._gone) return;
        if (sig.aborted || (e && e.message === "cancelled")) {
          this._mode = "menu";
          this._status = "cancelled";
        } else {
          this._mode = "done";
          this._err = String((e && e.message) || e);
          this._status = "";
          this._bar = null;
        }
        this.refresh();
      }
    );
  }
}

function setBar(scr, done, total) {
  try { scr._bar = [done, total]; } catch (e) {}
}

async function runBuild(scr, lite, writerP, writerError) {
  const needAbort = () => { if (scr._job && scr._job.sig.aborted) throw new Error("cancelled"); };
  scr._status = "Loading builder… (~10 MB, once)";
  scr._bar = [0, 1];
  const { default: esbuild } = await import(BUILD_URL);
  needAbort();
  try { await esbuild.initialize({ wasmURL: WASM_URL }); }
  catch (e) { /* already initialized */ }
  needAbort();
  if (!writerP) {
    throw new Error("save picker blocked (" + ((writerError && writerError.message) || writerError) + ") — try Lite, or another browser");
  }
  const writer = await writerP;
  // Probe the picker NOW (before the expensive bundle): a dismissed picker
  // must cancel immediately, not after minutes of bundling. Harmless ("")
  // for both writer kinds.
  try {
    await writer.write("");
  } catch (e) {
    if (e && (e.name === "AbortError" || /cancel/i.test(e.message || "") || !e.message)) {
      try { await writer.abort(); } catch (e2) {}
      throw new Error("cancelled");
    }
    throw new Error("save picker failed (" + ((e && e.message) || e) + ") — try again or use another browser");
  }
  needAbort();
  // Live file counter: esbuild itself reports nothing while it pulls ~266
  // modules, which used to look frozen. The screen re-renders every frame,
  // so mutating fields is enough. Throttle to ~4/sec.
  let files = 0;
  let lastTick = 0;
  const onFile = () => {
    files++;
    const now = Date.now();
    if (now - lastTick > 250) {
      lastTick = now;
      scr._status = "Bundling game code… (" + files + " files)";
    }
  };
  const zipBase = new URL("./", import.meta.url).href;
  const t0 = Date.now();
  await buildSingleFile({
    io: pageIo(onFile),
    esbuild,
    writer,
    zipBase,
    signal: scr._job ? scr._job.sig : { aborted: true },
    lite,
    onProgress: (p) => {
      try {
        if (scr._job && scr._job.sig.aborted) return;
        if (p.phase === "zips" && p.total > 0) {
          setBar(scr, p.done, p.total);
          scr._status = p.msg + " " + fmtMB(p.done) + " / " + fmtMB(p.total);
        } else if (p.phase === "write") {
          setBar(scr, 1, 1);
          scr._status = p.msg;
        } else if (p.phase !== "bundle" || !/files\)$/.test(scr._status || "")) {
          // Bundle-phase messages come from the file counter above.
          scr._status = p.msg || p.phase;
        }
      } catch (e) {}
    },
  });
  needAbort();
  const secs = Math.round((Date.now() - t0) / 1000);
  // Single close — the writer's owner closes exactly once (buildSingleFile
  // never closes; a second close used to snapshot an emptied buffer).
  let res = null;
  try { res = await writer.close(); } catch (e) { throw new Error("couldn't finish the file: " + ((e && e.message) || e)); }
  scr._bar = null;
  if (res && res.url) {
    scr._res = { kind: "blob", url: res.url, name: res.name, bytes: res.bytes };
    scr._status = "Ready in " + secs + "s (" + fmtMB(res.bytes) + ") — tap Save file.";
  } else {
    scr._res = { kind: "file", name: buildFileName(lite) };
    scr._status = "Saved " + buildFileName(lite) + " in " + secs + "s — open it to play. Worlds stay in this browser.";
  }
}

/* ---------------- title-screen hook (realms/singleplayer pattern) ---------------- */

function patchTitle() {
  try {
    const g = game();
    if (!g || !g.screens) return;
    const cur = g.screens.current;
    if (!cur || !cur.buttons) return;
    if (cur._isDlMenu) return; // our own screen already has Full/Lite
    if (!cur._dlInitHooked) {
      cur._dlInitHooked = true;
      const origInit = cur.init;
      cur.init = function () {
        const r = origInit.call(this);
        try { patchTitle(); } catch (e) {}
        return r;
      };
    }
    const hasSP = cur.buttons.some((b) => b && b.id === 1);
    if (!hasSP) return;
    let b = cur.buttons.find((x) => x && x.id === 90);
    if (!b) {
      b = new Button(90, 2, 10, 110, 20, "Download…", () => {
        try {
          const gg = game();
          if (gg && gg.screens) gg.screens.open(new DlScreen(gg));
        } catch (e) {}
      });
      try { b.description = "Play offline: save the full game as one file"; } catch (e) {}
      cur.buttons.push(b);
    }
    try {
      b.x = 2;
      b.y = Math.max(30, cur.height - 32);
      b.visible = true;
      b.enabled = true;
    } catch (e) {}
  } catch (e) {}
}

function install() {
  try {
    const g = game();
    if (!g || !g.screens) { setTimeout(install, 2000); return; }
    const screens = g.screens;
    const origOpen = screens.open.bind(screens);
    screens.open = function (screen) {
      const r = origOpen(screen);
      try { patchTitle(); } catch (e) {}
      return r;
    };
  } catch (e) {}
  patchTitle();
  try {
    if (!globalThis._mcDlTitlePoll) {
      globalThis._mcDlTitlePoll = setInterval(() => { try { patchTitle(); } catch (e) {} }, 2000);
    }
  } catch (e) {}
}

try { install(); } catch (e) {}
try { setTimeout(install, 3000); } catch (e) {}

globalThis.__mcDownload = {
  open: () => {
    try {
      const g = game();
      if (g && g.screens) g.screens.open(new DlScreen(g));
    } catch (e) {}
  },
};
})();
