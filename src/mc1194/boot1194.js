// 1.19.4 engine boot. Native 1.19.4 assets live in ./assets-1194.zip plus
// ./assets-1194-sounds.zip (new sounds); unchanged legacy sounds fall
// through to ./assets-1194-legacy-sounds.zip via the chained fallback.
//
// Reduced boot of the upstream client/js/main.js: same stages, but the asset
// source is our zip instead of assets/ folder or embedded page element.
// Singleplayer below is our own offline layer (upstream has none): world
// menu, seeded terrain, saves, placement fixes, chat commands.
import { setPlatform, platform } from "./js/platform/platform.js";
import { BrowserPlatform } from "./js/platform/browser.js";
import { Assets } from "./js/assets.js";
import { ZipSource } from "./js/asset-source.js";
import { Settings } from "./js/game/settings.js";
import { Game } from "./js/game/game.js";
import { initRecipes } from "./js/game/crafting.js";
import { TitleScreen } from "./js/gui/screens/menus.js";
import { Splash } from "./js/render/splash.js";
import { ProxyList } from "./js/net/proxies.js";
import { parseAddress } from "./js/net/address.js";
import { buildCrashReport, showCrashScreen } from "./js/crash.js";
import { ShaderLibrary } from "./js/render/shader-library.js";
import { bootSingleplayer } from "./singleplayer.js";
import "./native-gui.js"; // side-effect: engine-rendered dialogs (confirm/death/prompt)
import "./survival.js"; // side-effect: publishes globalThis.__mcBootSurvival
import "./recipes.js"; // side-effect: offline book fill + container returns
import "./oneblock-ticker.js"; // side-effect: Skyblock pedestal ticker (self-boots)
import "./touch-controls.js"; // side-effect: native touch controls (engine-rendered, direct input), ?touch=1 to force
import "./voice.js"; // side-effect: proximity voice (N menu), external servers only
import "./realms.js"; // side-effect: Realms rooms (title button/menu/avatars/relay)
import "./download.js"; // side-effect: title-screen Download button (single-file offline build)
import "./oneblock-ui.js"; // side-effect: Skyblock welcome gate (name/skin), needs realms+ticker

async function boot() {
  setPlatform(new BrowserPlatform());
  const P = platform();
  // Diagnostic backdrop: dark purple, covered by the canvas the moment
  // anything renders. If a phone ever shows PURPLE, the canvas is empty/
  // zero-size (game may still run); if it shows WHITE, the canvas itself is
  // painting white. Report which one you see.
  try { document.body.style.background = "#103"; } catch (e) {}
  // Phone diagnosis: mirror every boot stage to the on-screen loading text
  // (mobile browsers have no devtools). Whatever the user last sees IS the
  // diagnosis — "stuck on X" tells us exactly which stage failed/hung.
  // All calls are try/catch: progress UI must never break the boot itself.
  const stage = (m) => {
    try { P.setLoading(m); } catch (e) {}
    try { console.log("[1194] " + m); } catch (e) {}
    // The tab title is visible even when the page paints nothing (white
    // screen): whatever stage it names IS where the boot stopped.
    try { document.title = "MC: " + String(m).slice(0, 60); } catch (e) {}
  };
  // Only auto-show errors on screen while booting. After the title is up,
  // late errors stay in the console — re-showing the overlay over a running
  // game would be worse than the error itself.
  let booted = false;
  try { window.__mcBooted = false; } catch (e) {}
  try {
    window.addEventListener("error", (ev) => {
      if (booted) return;
      try {
        const msg = (ev && ev.message) || (ev && ev.error && ev.error.message) || "unknown error";
        P.setLoadingError("Error: " + msg + " (screenshot this + send it)");
      } catch (e) {}
    });
    window.addEventListener("unhandledrejection", (ev) => {
      if (booted) return;
      try {
        const r = ev && ev.reason;
        P.setLoadingError("Error: " + ((r && r.message) || String(r)) + " (screenshot this + send it)");
      } catch (e) {}
    });
  } catch (e) {}
  let config = {};
  try { config = (await P.loadConfig()) || {}; } catch (e) { console.warn("Config unavailable", e); }
  const settings = new Settings(config);
  const proxies = new ProxyList(settings);
  try {
    stage("Loading game data… (phones: this can take a minute)");
    const BT0 = performance.now(); // mVUS launch profile: blocking bytes before title
    // ModernFix-mVUS launch: all three zips start fetching at once, but the
    // boot only BLOCKS on the main zip (19MB). The two sound zips (138MB,
    // ~87% of boot bytes) stream in the background; reads that miss the main
    // zip wait for them via the ZipSource gate instead of failing, so
    // steady-state resolution is identical — only arrival order changes.
    const zipBytes = (url, label) => fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(label + " missing: HTTP " + res.status);
      return new Uint8Array(await res.arrayBuffer());
    });
    const zipUrl = new URL("./assets-1194.zip", import.meta.url);
    // 1.19.4 sounds live in a second zip (single-file cap): new sounds plus
    // the bundled legacy zip for unchanged pre-1.18 sounds (chained fallback).
    const sndUrl = new URL("./assets-1194-sounds.zip", import.meta.url);
    const oldSndUrl = new URL("./assets-1194-legacy-sounds.zip", import.meta.url);
    const mainP = zipBytes(zipUrl, "1.19.4 assets");
    const sndP = zipBytes(sndUrl, "1.19.4 sounds");
    const oldP = zipBytes(oldSndUrl, "legacy sounds");
    const bytes = await mainP;
    console.log("[1194] zip fetch: main " + bytes.length + "B in " + Math.round(performance.now() - BT0) + "ms (sounds stream in background)");
    const assets = new Assets();
    assets.source = new ZipSource(bytes);
    assets.source.addFallbackBytes(sndP);
    assets.source.addFallbackBytes(oldP);
    sndP.then((b) => console.log("[1194] background sounds zip ready: " + b.length + "B")).catch(() => {});
    oldP.then((b) => console.log("[1194] background legacy sounds zip ready: " + b.length + "B")).catch(() => {});
    stage("Starting graphics… (trying WebGL2, then WebGPU, then software)");
    const device = await P.createGraphicsDevice(settings.graphicsApi);
    stage("Graphics ready: " + device.name + " — loading worlds…");
    if (P.setPotato) P.setPotato(!!settings.superPotato || device.name === "Software");
    assets.setDevice(device);
    assets.language = settings.language || "en_us";
    try { await assets.activatePacks(settings.resourcePacks || []); } catch (e) { console.warn("Resource packs unavailable", e); }
    const splash = new Splash(device);
    try { await splash.load(await assets.readBytes("textures/gui/title/mojang.png")); } catch (e) { /* no splash art */ }
    try { splash.start(); } catch (e) { /* headless */ }
    P.hideLoading();
    await assets.load((msg) => console.log("[1194]", msg));
    try { splash.stop(); } catch (e) {}
    if (assets.data.recipes) {
      try {
        // P4 (1.19.4): the native data table predates these recipes, so fill
        // them here (src/mc1194/data/recipes.json carries the same entries for
        // rebuilds): recovery compass, disc 5 from 9 fragments, chest boats.
        const R = assets.data.recipes;
        if (!R["885"]) R["885"] = [{ inShape: [[1210, 1210, 1210], [1210, 884, 1210], [1210, 1210, 1210]], result: { count: 1, id: 885 } }];
        if (!R["1130"]) R["1130"] = [{ inShape: [[1132, 1132, 1132], [1132, 1132, 1132], [1132, 1132, 1132]], result: { count: 1, id: 1130 } }];
        const chestPairs = [[732, 733], [734, 735], [736, 737], [738, 739], [740, 741], [744, 745]];
        for (const [boat, chestBoat] of chestPairs) {
          if (!R[String(chestBoat)]) R[String(chestBoat)] = [{ ingredients: [boat, 275], result: { count: 1, id: chestBoat } }];
        }
        initRecipes(assets.data.recipes);
      } catch (e) { console.warn("initRecipes", e); }
    }
    const game = new Game(assets, settings, device);
    game.proxies = proxies;
    game.shaderLibrary = new ShaderLibrary(game.shaderPack);
    try { await game.shaderLibrary.load(); } catch (e) { game.shaderPack.error = e.message; console.warn("Shader pack unavailable", e.message); }
    globalThis.game = game; // debugging handle
    globalThis.__mc1194 = game;
    try { await import("./voxelgen.js"); } catch (e) { console.warn("voxelgen unavailable", e); }
    try { bootSingleplayer(game); } catch (e) { console.error("[singleplayer] boot failed", e); }
    try {
      if (typeof globalThis.__mcBootSurvival === "function") globalThis.__mcBootSurvival(game);
      else console.warn("[survival] boot handle missing");
    } catch (e) { console.error("[survival] boot failed", e); }
    const params = P.launchParams ? P.launchParams() : {};
    if (params.connect) {
      const a = parseAddress(params.connect);
      if (a && a.kind === "eagler") game.connect(params.connect, 0, params.user || null);
      else game.connect(a ? a.host : "localhost", a ? a.port : 25565, params.user || null);
    } else {
      game.screens.open(new TitleScreen(game));
    }
    // Boot complete: the title is up. Mark it (stops the boot error
    // overlay) and make doubly sure the loading screen is gone — on some
    // phone builds it was observed lingering over the running game.
    booted = true;
    try { window.__mcBooted = true; } catch (e) {}
    try { P.hideLoading(); } catch (e) {}
    // Arrival beacon (phones only — vibrate() is undefined on desktop):
    // 3 pulses means the title screen actually opened. If the screen is
    // white AND you feel the pulses, rendering is the only thing broken;
    // if no pulses, the boot itself never finished.
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
    try { document.title = "MinecraftJS 1.19.4"; } catch (e) {}
    // Sound-zip failures: fatal online (same messages as the old blocking
    // fetch), but NON-fatal in the offline copy — Lite builds deliberately
    // omit the sound zips for phones (~45MB vs ~255MB), and a full build
    // opened without internet should still play silently.
    Promise.all([sndP, oldP]).catch((e) => {
      var offline = false;
      try { offline = !!globalThis.__mcOffline; } catch (err) { offline = false; }
      if (offline) {
        try { console.warn("[1194] offline sound zip missing, continuing silent: " + (e && e.message)); } catch (err) {}
        return;
      }
      console.error(e);
      try { P.setLoadingError("Failed to load: " + e.message); } catch (err) {}
      try { showCrashScreen(buildCrashReport(e, "Starting the game", globalThis.game || null)); } catch (err) {}
    });
  } catch (e) {
    console.error(e);
    try { P.setLoadingError("Failed to load: " + e.message); } catch (err) {}
    try { showCrashScreen(buildCrashReport(e, "Starting the game", globalThis.game || null)); } catch (err) {}
  }
}

boot();
