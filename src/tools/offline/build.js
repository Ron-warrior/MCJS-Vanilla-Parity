// Single-file offline builder (environment-agnostic).
//
// Produces a self-contained MinecraftJS .html that boots from file:// with
// zero network for the full client: bundled JS, embedded data files, embedded
// asset zips, inlined mesh worker. Online-only pieces stay remote by design
// (music streams, Trystero mesh intro, external-server sockets, proxy pings)
// and simply work whenever the device is online — same as the site.
//
// Runs in two hosts with the same code path:
//   page io  = fetch() against the live site (the real Download button)
//   worker io = fs reads (session verification via execute_js)
// io: {
//   readText(path) -> Promise<string>,
//   openStream(path) -> Promise<{ total:number|null, chunks:AsyncIterable<Uint8Array> }>,
// }
// writer: { write(string)->Promise<void>, close()->Promise<void> }
// Lifecycle: the CALLER creates and closes the writer exactly once.
// buildSingleFile never closes (a second close on an accumulative writer
// would snapshot an emptied buffer — v2.3.2 lesson).
// onProgress({phase, msg, done, total}) — advisory only. signal: {aborted:boolean}.

export const BUILD_VERSION = "2.3.2";
export const BUILD_FILE = "minecraftjs.1.19.4._v" + BUILD_VERSION + ".html";
export const BUILD_FILE_LITE = "minecraftjs.1.19.4._v" + BUILD_VERSION + ".lite.html";
export function buildFileName(lite) { return lite ? BUILD_FILE_LITE : BUILD_FILE; }

export const ZIP_DEFS = [
  { name: "assets-1194.zip", id: "mcjs-zip-main" },
  { name: "assets-1194-sounds.zip", id: "mcjs-zip-sounds" },
  { name: "assets-1194-legacy-sounds.zip", id: "mcjs-zip-legacy" },
];

// Small files the game fetches through the page fetch path at runtime
// (singleplayer compat + Terralith biomes, touch icons, IVFX tables/textures,
// extra entity models). Embedded as a JSON manifest; the loader's fetch
// override serves them from memory. Keep in sync with the fetch sites noted.
export const MANIFEST_TEXTS = [
  "src/mc1194/data/compat.json",
  "src/mc1194/vc-biomes.json",
  "src/mc1194/entity-models-extra.json",
  "src/mc1194/ivfx/vfx/fogs.json",
  "src/mc1194/ivfx/vfx/sky.json",
  "src/mc1194/ivfx/vfx/biome_tags.json",
  "src/mc1194/ivfx/vfx/light_rays.json",
];

const TOUCH_PNGS = [
  "up.png", "up_pressed.png", "down.png", "down_pressed.png",
  "left.png", "left_pressed.png", "right.png", "right_pressed.png",
  "jump_dpad.png", "jump_dpad_pressed.png", "sneak_dpad.png",
  "sneak_dpad_pressed.png", "flyingascend.png", "flyingascend_pressed.png",
  "flyingdescend.png", "flyingdescend_pressed.png", "dismount.png",
  "pause_icon.png", "comment.png", "elipses.png", "arrow_down.png",
  "keyboard_and_mouse_glyph.png", "chat_send.png",
];

const IVFX_PNGS = [
  "textures/vfx/mote_glow.png", "textures/vfx/mote_soft.png",
  "textures/vfx/pixel.png", "textures/vfx/low_fog.png",
  "textures/vfx/gpu_grass.png", "textures/clouds/modern.png",
  "textures/clouds/legacy.png", "textures/sky/aurora_noise.png",
  "textures/vfx/underwater_noise.png",
];

export const MANIFEST_BINS = TOUCH_PNGS.map((n) => "src/mc1194/touch-icons/" + n)
  .concat(IVFX_PNGS.map((n) => "src/mc1194/ivfx/" + n));

const B64CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Incremental base64 encoder (3-byte groups; push() returns text, flush() ends).
export function b64Stream() {
  let left = [];
  return {
    push(u8) {
      let s = "";
      const all = left.length ? (() => { const m = new Uint8Array(left.length + u8.length); m.set(left, 0); m.set(u8, left.length); left = []; return m; })() : u8;
      const n = all.length - (all.length % 3);
      for (let i = 0; i < n; i += 3) {
        const v = (all[i] << 16) | (all[i + 1] << 8) | all[i + 2];
        s += B64CH[(v >> 18) & 63] + B64CH[(v >> 12) & 63] + B64CH[(v >> 6) & 63] + B64CH[v & 63];
      }
      for (let i = n; i < all.length; i++) left.push(all[i]);
      return s;
    },
    flush() {
      let s = "";
      if (left.length === 1) {
        const v = left[0] << 16;
        s = B64CH[(v >> 18) & 63] + B64CH[(v >> 12) & 63] + "==";
      } else if (left.length === 2) {
        const v = (left[0] << 16) | (left[1] << 8);
        s = B64CH[(v >> 18) & 63] + B64CH[(v >> 12) & 63] + B64CH[(v >> 6) & 63] + "=";
      }
      left = [];
      return s;
    },
  };
}

export function b64encode(u8) {
  const st = b64Stream();
  let s = "";
  for (let i = 0; i < u8.length; i += 0x100000) s += st.push(u8.subarray(i, Math.min(i + 0x100000, u8.length)));
  return s + st.flush();
}

function ioPlugin(io) {
  return {
    name: "mcjs-io",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: args.path, namespace: "mcjs" };
        if (args.path.charAt(0) !== ".") return { path: args.path, external: true };
        const base = args.resolveDir ? args.resolveDir + "/" : "";
        const parts = (base + args.path).split("/");
        const out = [];
        for (const p of parts) {
          if (p === "" || p === ".") continue;
          if (p === "..") out.pop();
          else out.push(p);
        }
        return { path: out.join("/"), namespace: "mcjs" };
      });
      build.onLoad({ filter: /.*/, namespace: "mcjs" }, async (args) => {
        const cands = [args.path, args.path + ".js", args.path + ".mjs"];
        for (const c of cands) {
          try {
            const t = await io.readText(c);
            return { contents: t, loader: "js", resolveDir: c.split("/").slice(0, -1).join("/") };
          } catch (e) { /* try next */ }
        }
        return { errors: [{ text: "missing " + args.path }] };
      });
    },
  };
}

// Loader: runs first in the file. Serves embedded bytes through window.fetch,
// inlines the mesh worker via blob URL, asserts offline mode. No imports,
// no backticks-sensitive sequences: plain script, safe to inline raw.
const LOADER_JS = `
(function(){
window.__mcOffline = true;
try { globalThis.__mcOffline = true; } catch (e) {}
var B64A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var B64I = null;
function b64dec(s) {
  if (!B64I) { B64I = {}; for (var i = 0; i < 64; i++) B64I[B64A.charAt(i)] = i; }
  var n = s.length, pad = 0;
  if (n >= 1 && s.charAt(n - 1) === "=") pad++;
  if (n >= 2 && s.charAt(n - 2) === "=") pad++;
  var out = new Uint8Array((((n / 4) | 0) * 3) - pad), o = 0;
  for (var i = 0; i < n; i += 4) {
    var v = ((B64I[s.charAt(i)] || 0) << 18) | ((B64I[s.charAt(i + 1)] || 0) << 12) |
            ((B64I[s.charAt(i + 2)] || 0) << 6) | ((B64I[s.charAt(i + 3)] || 0));
    if (o < out.length) out[o++] = (v >> 16) & 255;
    if (o < out.length) out[o++] = (v >> 8) & 255;
    if (o < out.length) out[o++] = v & 255;
  }
  return out;
}
function elText(id) {
  var el = document.getElementById(id);
  if (!el) return "";
  var n = el.firstChild;
  return n ? (n.data || "") : "";
}
var MANIFEST = null;
try { MANIFEST = JSON.parse(elText("mcjs-manifest")); }
catch (e) { MANIFEST = { t: {}, b: {} }; }
var mCache = {};
function manifestBytes(key) {
  if (mCache[key]) return mCache[key];
  var u = null;
  try {
    if (MANIFEST.b && MANIFEST.b[key] != null) u = b64dec(MANIFEST.b[key]);
    else if (MANIFEST.t && MANIFEST.t[key] != null) u = new TextEncoder().encode(MANIFEST.t[key]);
  } catch (e) { u = null; }
  if (u) mCache[key] = u;
  return u;
}
var ZIPMAP = [
  ["assets-1194-legacy-sounds.zip", "mcjs-zip-legacy"],
  ["assets-1194-sounds.zip", "mcjs-zip-sounds"],
  ["assets-1194.zip", "mcjs-zip-main"]
];
var zCache = {};
function zipBytes(id) {
  if (zCache[id]) return zCache[id];
  var s = elText(id);
  if (!s) return null;
  var u = null;
  try { u = b64dec(s); } catch (e) { u = null; }
  if (u) zCache[id] = u;
  return u;
}
try {
  var wsrc = elText("mcjs-worker");
  if (wsrc) {
    var wb = b64dec(wsrc);
    window.__mcMeshWorkerUrl = URL.createObjectURL(new Blob([wb], { type: "text/javascript" }));
  }
} catch (e) {}
var mKeys = [];
try { mKeys = Object.keys(MANIFEST.b || {}).concat(Object.keys(MANIFEST.t || {})); }
catch (e) { mKeys = []; }
var origFetch = window.fetch.bind(window);
function mimeFor(k) {
  if (k.slice(-5) === ".json") return "application/json";
  if (k.slice(-4) === ".png") return "image/png";
  return "application/octet-stream";
}
window.fetch = function (input, init) {
  try {
    var urlStr = (typeof input === "string") ? input : ((input && input.url) || "");
    var abs = urlStr;
    try { abs = new URL(urlStr, document.baseURI).href; } catch (e) {}
    var clean = String(abs).split("#")[0].split("?")[0];
    var i, k;
    for (i = 0; i < ZIPMAP.length; i++) {
      if (clean === ZIPMAP[i][0] || clean.slice(-(ZIPMAP[i][0].length + 1)) === "/" + ZIPMAP[i][0]) {
        var zb = zipBytes(ZIPMAP[i][1]);
        if (zb) return Promise.resolve(new Response(zb.slice(0), { status: 200, headers: { "Content-Type": "application/zip" } }));
        break;
      }
    }
    for (i = 0; i < mKeys.length; i++) {
      k = mKeys[i];
      if (clean === k || clean.slice(-(k.length + 1)) === "/" + k) {
        var mb = manifestBytes(k);
        if (mb) return Promise.resolve(new Response(mb.slice(0), { status: 200, headers: { "Content-Type": mimeFor(k) } }));
        break;
      }
    }
  } catch (e) {}
  return origFetch(input, init);
};
})();
`;

const HEAD = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>MinecraftJS 1.19.4 (offline)</title>
<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
  user-select: none;
  -webkit-user-select: none;
}
canvas {
  position: fixed;
  left: 0;
  top: 0;
  display: block;
  image-rendering: pixelated;
}
#game-canvas { z-index: 0; outline: none; }
#loading {
  position: fixed;
  inset: 0;
  z-index: 10;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: monospace;
  color: #000;
}
#loading .loading-box { display: block; width: min(560px, 85vw); text-align: center; }
#loading.error { background: #1e1e1e; color: #fff; }
.loading-title { font-size: 28px; font-weight: bold; margin-bottom: 16px; }
.loading-track { display: none; }
#loading-text { font-size: 14px; color: #333; white-space: pre-wrap; }
</style></head>
<body>
  <div id="loading">
    <div class="loading-box">
      <div class="loading-title">MinecraftJS</div>
      <div class="loading-track"><div id="loading-bar"></div></div>
      <div id="loading-text">Starting...</div>
    </div>
  </div>
<script>window.__mcOffline=true;try{globalThis.__mcOffline=true;}catch(e){}</script>
`;

function escBundle(code) {
  return code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

export async function buildSingleFile(opts) {
  const { io, esbuild, writer, onProgress, signal, zipBase } = opts;
  const prog = (phase, msg, done, total) => {
    try { if (onProgress) onProgress({ phase, msg, done: done || 0, total: total || 0 }); } catch (e) {}
  };
  const abort = () => { if (signal && signal.aborted) throw new Error("cancelled"); };

  prog("bundle", "Bundling game code…");
  const plugin = ioPlugin(io);
  const main = await esbuild.build({
    entryPoints: ["src/boot.js"], bundle: true, format: "esm",
    platform: "browser", minify: false, write: false, plugins: [plugin],
  });
  abort();
  const mainCode = main.outputFiles[0].text;
  prog("bundle", "Bundling mesh worker… (" + (mainCode.length / 1048576).toFixed(1) + " MB code)");
  const worker = await esbuild.build({
    entryPoints: ["src/mc1194/js/render/mesh-worker.js"], bundle: true,
    format: "iife", platform: "browser", minify: false, write: false, plugins: [plugin],
  });
  abort();
  const workerCode = worker.outputFiles[0].text;
  const workerB64 = b64encode(new TextEncoder().encode(workerCode));

  prog("manifest", "Embedding data files…");
  const mt = {}, mb = {};
  for (const p of MANIFEST_TEXTS) {
    abort();
    mt[p] = await io.readText(p);
    prog("manifest", "Embedding data files… (" + p + ")");
  }
  for (const p of MANIFEST_BINS) {
    abort();
    const { chunks } = await io.openStream(p);
    const parts = [];
    for await (const c of chunks) parts.push(c);
    let n = 0;
    for (const c of parts) n += c.length;
    const u = new Uint8Array(n);
    let o = 0;
    for (const c of parts) { u.set(c, o); o += c.length; }
    mb[p] = b64encode(u);
  }
  const manifestJson = JSON.stringify({ t: mt, b: mb }).replace(/</g, "\\u003c");

  prog("write", "Writing file…");
  await writer.write(HEAD);
  await writer.write('<script id="mcjs-manifest" type="application/json">');
  await writer.write(manifestJson);
  await writer.write("</scr" + "ipt>\n");
  await writer.write("<script>" + LOADER_JS + "</scr" + "ipt>\n");

  for (const z of (opts.lite ? ZIP_DEFS.slice(0, 1) : ZIP_DEFS)) {
    abort();
    const path = (zipBase || "") + z.name;
    const { total, chunks } = await io.openStream(path);
    await writer.write('<div id="' + z.id + '" style="display:none">');
    const st = b64Stream();
    let done = 0;
    for await (const c of chunks) {
      abort();
      await writer.write(st.push(c));
      done += c.length;
      prog("zips", "Embedding " + z.name + "…", done, total || done);
    }
    await writer.write(st.flush());
    await writer.write("</div>\n");
  }

  await writer.write('<div id="mcjs-worker" style="display:none">');
  await writer.write(workerB64);
  await writer.write("</div>\n");

  prog("write", "Writing game code…");
  await writer.write('<script type="module">\n');
  await writer.write(escBundle(mainCode));
  await writer.write("\n</scr" + "ipt>\n</body></html>\n");
  prog("done", "Done");
  return { mainBytes: mainCode.length, workerBytes: workerCode.length };
}
