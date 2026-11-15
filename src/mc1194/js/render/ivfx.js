// ImmersiveVFX 2.0.0 port (fabric + neoforge editions, by Shinyflvres).
//
// Port of the mod's client systems to this engine's WebGL2 forward renderer:
//   VfxClient / VfxRenderer / VfxHooks / VfxDynamicFog / BiomeBlend / FogTable
//   VfxSky / RealisticSky / VfxClouds / VfxAurora / SkyAnimations / SkyEvents
//   VfxBloom / VfxTonemap(+vfx_grade/vfx_night_grade) / VfxGrade / VfxColoredLight
//   VfxHeldLight / VfxFireLight / VfxShadows / VfxReflections / VfxUnderwater
//   (rays/caustics/dof/glint) / VfxWaterShafts / VfxOutlines / VfxEnchantOutlines
//   VfxGpuGrass / VfxGrass (moving foliage) / AmbientMotes / WaterfallMist /
//   LowFog / SurfaceEffects / DungeonsFire / SmoothBlockPlace / VfxWeatherPass
//   NaturalFoliage (foliage LUT softening) / Profiles (sky events).
//
// Method: every *visible* option from the mod's en_us.json is implemented with
// the mod's own data (vfx/fogs.json, sky.json, biome_tags.json, light_rays.json
// under src/mc1194/ivfx/) and its shader math ported to JS (grade/night-grade/
// realistic curves). Approximations forced by the forward renderer are marked
// HONEST below — no deferred pipeline (shadowmaps/planar reflections/full
// post chain) exists in this engine:
//   HONEST shadows: no shadowmaps; the whole Shadows page scales the
//     blob-shadow pass instead (strength/distance/boost/mode/mob/
//     underwater/depth-curve all live; resolution has no map to scale and
//     only softens alpha — documented placeholder).
//   HONEST reflections: no planar pass; sun/moon glitter + fresnel-ish shore
//     brightening on water/ice, scaled by quality/strength.
//   HONEST bloom: additive halo sprites on bright sources, not a mip chain.
//   HONEST grading/tonemap: applied to fog/sky/cloud/lightmap colors on CPU
//     (covers the whole scene since terrain is lightmap-lit) plus the torch
//     gamma path, not a post pass — HUD/hotbar stay ungraded.
//   HONEST moving foliage: static terrain can't sway without a shader-pack
//     vertex hook; sway is implemented on GPU-grass tufts, falling leaves,
//     pollen drift, mist and floating water leaves (all JS-animated).
//   HONEST water color mapping: underwater fog follows the biome table; the
//     surface tint lives in the mesher and is untouched.
//   HONEST mob outlines: marker ring on the targeted mob (no geometry pass).
//   HONEST aurora noise: scrolling noise-texture band pass, same placement
//     as the mod, additive (no volumetric raymarch).
// Per-dimension system gates (mod's allow.* page) are fully wired via
// vfxAllow<Dim><Cat> + the Dimensions sub-screens.
// useIrisShaders disables every renderer-affecting pass (like the mod); only
// ambient particles + weather extras stay on.

import { FORMAT, colorParams } from '../gfx/device.js';
import { decodePng } from '../util/png.js';
import { celestialAngle, sunBrightness, starBrightness, updateLightmap } from './sky.js';
import { biomeInfo, grassColor } from '../world/biomes.js';
import { getBlock } from '../world/blocks.js';
import { ensureVfx, vfxAllowed, defaultGrading } from './ivfx-settings.js';
import { ivfxData, hashStr, hexRgb, fogFor, skyProfileFor, lightRayColor, biomeTags } from './ivfx-data.js';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, f) => a + (b - a) * f;

// ---------------------------------------------------------------- textures

const TEX_FILES = {
  glow: 'textures/vfx/mote_glow.png',
  soft: 'textures/vfx/mote_soft.png',
  pixel: 'textures/vfx/pixel.png',
  lowfog: 'textures/vfx/low_fog.png',
  grass: 'textures/vfx/gpu_grass.png',
  cloudsModern: 'textures/clouds/modern.png',
  cloudsLegacy: 'textures/clouds/legacy.png',
  aurora: 'textures/sky/aurora_noise.png',
  waterNoise: 'textures/vfx/underwater_noise.png',
};

async function loadTex(device, name) {
  const r = await fetch('src/mc1194/ivfx/' + TEX_FILES[name]);
  if (!r.ok) throw new Error('ivfx tex ' + name);
  const img = decodePng(new Uint8Array(await r.arrayBuffer()));
  // Cloud layers tile their texture (rep=3 in _drawClouds) like the mod's
  // shader (GL_REPEAT); clamp would smear the texture edge across the sky.
  const wrap = name === 'cloudsModern' || name === 'cloudsLegacy' ? 'repeat' : 'clamp';
  return device.createTexture({ width: img.width, height: img.height, data: img.data, filter: 'linear', wrap });
}

// ---------------------------------------------------------------- grading
// CPU port of vfx_grade.glsl (vfx_user_grade) + vfx_night_grade.glsl.

function gradeParams(table) {
  const g = (k) => (Number(table[k]) || 0) / 100;
  return {
    exposure: Math.pow(2, (g('exposure') - 1) * 2), // 100% = x1, 200% = x4, 0% = x0.25
    contrast: g('contrast'), shadowLift: (g('shadows') - 1) * 0.35,
    gamma: 1 / Math.max(0.2, g('midtones')), gain: g('highlights'),
    sat: g('saturation'), vib: g('vibrance'), hue: (Number(table.hueShift) || 0) / 360,
    temp: (Number(table.temperature) || 0) / 100, tint: (Number(table.tint) || 0) / 100,
    band: [g('redStrength'), g('greenStrength'), g('blueStrength')],
    bandHue: [Number(table.redHue) || 0, Number(table.greenHue) || 0, Number(table.blueHue) || 0],
  };
}

function rgb2hsv(c) {
  const mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === c[0]) h = ((c[1] - c[2]) / d) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, mx < 1e-6 ? 0 : d / mx, mx];
}

function hsv2rgb(hsv) {
  const [h, s, v] = hsv;
  const p = (n) => v * (1 - s * clamp(Math.min(Math.max(-1, ((((n + h * 6) % 6) + 6) % 6) - 3), -1), 0, 1));
  // branchless-ish hsv->rgb
  const k = (n) => (n + h * 6) % 6;
  const f = (n) => v - v * s * clamp(Math.min(k(n), 4 - k(n), 1), 0, 1);
  return [f(5), f(3), f(1)];
}

function applyGradeTo(c, P) {
  let r = clamp(c[0] * P.exposure, 0, 4), g = clamp(c[1] * P.exposure, 0, 4), b = clamp(c[2] * P.exposure, 0, 4);
  // contrast around 0.46 pivot + shadow lift + gamma + gain
  r = clamp((r - 0.46) * (0.2 + P.contrast * 0.8) + 0.46 + P.shadowLift, 0, 4);
  g = clamp((g - 0.46) * (0.2 + P.contrast * 0.8) + 0.46 + P.shadowLift, 0, 4);
  b = clamp((b - 0.46) * (0.2 + P.contrast * 0.8) + 0.46 + P.shadowLift, 0, 4);
  r = Math.pow(Math.max(r, 0), P.gamma) * P.gain;
  g = Math.pow(Math.max(g, 0), P.gamma) * P.gain;
  b = Math.pow(Math.max(b, 0), P.gamma) * P.gain;
  // temperature / tint (white-balance-ish)
  r *= 1 + P.temp * 0.25; b *= 1 - P.temp * 0.25;
  r *= 1 + P.tint * 0.12; g *= 1 - P.tint * 0.06; b *= 1 + P.tint * 0.12;
  // per-channel strength + hue via hsv
  let hsv = rgb2hsv([clamp(r, 0, 2), clamp(g, 0, 2), clamp(b, 0, 2)]);
  const wR = clamp(1 - Math.abs(hsv[0] - 0.0) * 3, 0, 1) + clamp(1 - Math.abs(hsv[0] - 1.0) * 3, 0, 1);
  const wG = clamp(1 - Math.abs(hsv[0] - 1 / 3) * 3, 0, 1);
  const wB = clamp(1 - Math.abs(hsv[0] - 2 / 3) * 3, 0, 1);
  hsv[1] = clamp(hsv[1] * (wR * P.band[0] + wG * P.band[1] + wB * P.band[2]), 0, 1.5);
  hsv[0] = (hsv[0] + P.hue + (wR * P.bandHue[0] + wG * P.bandHue[1] + wB * P.bandHue[2]) / 360 + 1) % 1;
  let out = hsv2rgb(hsv);
  const luma = out[0] * 0.2126 + out[1] * 0.7152 + out[2] * 0.0722;
  const spread = clamp(Math.max(out[0], out[1], out[2]) - Math.min(out[0], out[1], out[2]), 0, 1);
  const sAmt = P.sat * (1 + P.vib * (1 - spread) * 2);
  out = [lerp(luma, out[0], sAmt), lerp(luma, out[1], sAmt), lerp(luma, out[2], sAmt)];
  return [clamp(out[0], 0, 1.5), clamp(out[1], 0, 1.5), clamp(out[2], 0, 1.5)];
}

function nightGrade(c, amount) {
  if (amount <= 0) return c;
  const warm = clamp((c[0] - c[2]) / 0.18, 0, 1) * clamp((Math.max(c[0], c[1], c[2]) - 0.3) / 0.3, 0, 1);
  const f = amount * (1 - warm);
  return [lerp(c[0], c[0] * 0.74, f), lerp(c[1], c[1] * 0.84, f), lerp(c[2], c[2] * 1.08, f)];
}

// ---------------------------------------------------------------- quad batch

const STATE_ALPHA = Object.freeze({ blend: 'alpha', depthWrite: false, cull: false });
const STATE_ADD = Object.freeze({ blend: 'add', depthWrite: false, cull: false });

class QuadBatch {
  constructor(device, cap) {
    this.device = device;
    this.cap = cap;
    this.data = new Float32Array(cap * 4 * 9);
    this.n = 0;
    this.mesh = device.createMesh(FORMAT.color, new Float32Array(0), { quads: true, dynamic: true });
  }
  begin() { this.n = 0; }
  // corners: [x,y,z]*4, uv rect, rgba
  push(c, u0, v0, u1, v1, r, g, b, a) {
    if (this.n >= this.cap) return;
    let o = this.n++ * 36;
    const d = this.data;
    const us = [u0, u0, u1, u1], vs = [v1, v0, v0, v1];
    for (let k = 0; k < 4; k++) {
      d[o] = c[k * 3]; d[o + 1] = c[k * 3 + 1]; d[o + 2] = c[k * 3 + 2];
      d[o + 3] = us[k]; d[o + 4] = vs[k];
      d[o + 5] = r; d[o + 6] = g; d[o + 7] = b; d[o + 8] = a;
      o += 9;
    }
  }
  billboard(x, y, z, rx, ry, rz, ux, uy, uz, size, u0, v0, u1, v1, r, g, b, a) {
    this.push([x - rx - ux, y - ry - uy, z - rz - uz, x - rx + ux, y - ry + uy, z - rz + uz,
      x + rx + ux, y + ry + uy, z + rz + uz, x + rx - ux, y + ry - uy, z + rz - uz],
      u0, v0, u1, v1, r, g, b, a);
  }
  end() { if (this.n) this.device.updateMesh(this.mesh, this.data.subarray(0, this.n * 36), { quads: true }); }
  draw(d, tex, params, state) {
    if (!this.n || !tex) return;
    d.draw({ mesh: this.mesh, pipeline: 'color', textures: [tex], params, state: state || STATE_ALPHA, count: this.n * 6 });
  }
}

// ---------------------------------------------------------------- client

const LIGHT_SOURCE_BLOCKS = new Set(['torch', 'wall_torch', 'lantern', 'soul_lantern', 'glowstone', 'sea_lantern',
  'lava', 'fire', 'soul_fire', 'jack_o_lantern', 'redstone_torch', 'redstone_wall_torch', 'candle',
  'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight', 'shroomlight', 'glow_lichen',
  'crying_obsidian', 'respawn_anchor', 'enchanting_table', 'end_rod', 'ochre_froglight'.replace('x', 'x'),
  'magma_block', 'nether_portal', 'beacon', 'conduit', 'sculk_catalyst']);
const LIGHT_SOURCE_ITEMS = new Set(['torch', 'soul_torch', 'lantern', 'soul_lantern', 'glowstone_dust', 'glow_berries',
  'lava_bucket', 'glowstone', 'sea_lantern', 'shroomlight', 'end_rod', 'ochre_froglight', 'verdant_froglight',
  'pearlescent_froglight', 'redstone_torch', 'candle', 'magma_cream']);

function itemIsLight(game, stack) {
  if (!stack) return false;
  try {
    const n = game.items.name(stack.id);
    if (!n) return false;
    const base = String(n).split(':').pop().replace(/^(wall_|redstone_wall_)/, '');
    return LIGHT_SOURCE_ITEMS.has(base) || LIGHT_SOURCE_BLOCKS.has(base);
  } catch (e) { return false; }
}

export class VfxClient {
  constructor(game) {
    this.game = game;
    this.ready = false;
    this.data = null;
    this.tex = {};
    this.time = 0;
    this.envTick = 0;
    this.frame = null; // last post() snapshot for draws
    this.shells = []; // smooth block-place animations {x,y,z,t0}
    this.events = { nextStar: 8, stars: [], nextShower: 120, shower: [], fireworks: [], nextFirework: 200 };
    this.glowCache = { t: -99, list: [] }; // nearby bright sources
    this.edgeCache = { t: -99, water: [], lava: [] };
    this.causticT = 0;
    this.grassSeed = 1;
    this._params = colorParams(1, 1, 1, 1);
    const d = game.device;
    this.batchAdd = new QuadBatch(d, 768);
    this.batchAlpha = new QuadBatch(d, 768);
    this.cloudMesh = d.createMesh(FORMAT.color, new Float32Array(0), { quads: true, dynamic: true });
    this._cloudP = colorParams(1, 1, 1, 0.8);
  }

  async init() {
    const game = this.game;
    ensureVfx(game.settings);
    try { this.data = await ivfxData(); } catch (e) { console.warn('[ivfx] data unavailable', e); this.data = null; }
    for (const k of Object.keys(TEX_FILES)) {
      try { this.tex[k] = await loadTex(game.device, k); } catch (e) { this.tex[k] = null; }
    }
    this._wrapEnvironment();
    this._wrapPlacement();
    this._wrapShadows();
    this._softenFoliage();
    const r = game.renderer;
    const skyFx = (d) => this._drawSkyFx(d); skyFx.order = 2;
    const worldFx = (d) => this._drawWorldFx(d); worldFx.order = 8;
    const lateFx = (d) => this._drawLateFx(d); lateFx.order = 13;
    r.extraDraws.push(skyFx, worldFx, lateFx);
    this.ready = true;
    console.log('[ivfx] ready (ImmersiveVFX 2.0.0 port)');
  }

  get s() { return this.game.settings; }

  _dimKey(dim) {
    const d = dim === undefined ? this.game.dimension : dim;
    return d === -1 ? 'Nether' : d === 1 ? 'End' : 'Overworld';
  }

  // Mod's per-dimension per-system allow lists (allow.bloom/effects/
  // lightEngine/outlines/reflections/shadows/sky/weather). Missing keys
  // default to allowed (old saves predate the lists).
  //  category map: sky -> sky/clouds/aurora/meteors/rays/horizon/end-aura;
  //  weather -> mist/HD precipitation/sand/wind/custom weather rendering;
  //  effects -> ambient emitters/grass/smooth shells/waterfall+leaf mist;
  //  light -> lightmap grading/torch halo+gamma/colored/enhanced/dynamic;
  //  outlines -> block/mob/enchant passes; reflections -> glints/foam/
  //  caustics; shadows -> blob-shadow scaling; bloom -> halos.
  allow(cat) {
    try {
      const f = this.frame;
      const v = this.s['vfxAllow' + this._dimKey(f ? f.dim : undefined) + cat];
      return v !== false;
    } catch (e) { return true; }
  }

  // An external shader pack owns the frame when active — IVFX renderer passes
  // stand down exactly like the mod's "Use Iris Shaders" switch (ambient
  // particles + weather extras keep running, like the mod).
  _foreignPack() {
    try { const sp = this.game.shaderPack; return !!(sp && sp.active); } catch (e) { return false; }
  }

  enabled() {
    const s = this.s;
    if (!s || s.vfxPreset === undefined) return false;
    if (s.vfxEnabled === false) return false; // master OFF = vanilla
    return true;
  }

  // -- hooks --

  _wrapEnvironment() {
    const r = this.game.renderer;
    if (r._ivfxWrapped) return;
    r._ivfxWrapped = true;
    const orig = r.updateEnvironment.bind(r);
    r.updateEnvironment = (state) => { orig(state); try { this._post(state); } catch (e) { console.warn('[ivfx] env', e); } };
  }

  // Shadow sliders (mod's Shadows page): the engine has no shadowmaps, so
  // the sliders scale the blob-shadow pass instead — strength/alpha,
  // boost/size, distance fade, enhanced mode, per-mob gating, underwater
  // gating, and the distance-fade curve (depth calculation).
  _wrapShadows() {
    const er = this.game.entityRenderer;
    if (!er || er._ivfxShadowWrapped || typeof er._updateShadow !== 'function') return;
    er._ivfxShadowWrapped = true;
    const orig = er._updateShadow.bind(er);
    er._updateShadow = (e, v, p) => {
      orig(e, v, p);
      try { this._postShadow(e, v, p); } catch (err) {}
    };
  }

  _postShadow(e, v, p) {
    const s = this.s;
    if (!this.enabled()) return;
    if (!s.vfxShadows || !vfxAllowed(s) || this._foreignPack()) return;
    if (!this.allow('Shadows')) return;
    if (!v || !v.shadow || !v.shadow.visible) return;
    if (!s.vfxMobShadows && e && e.kind === 'mob') { v.shadow.visible = false; return; }
    if (!s.vfxUnderwaterShadows) {
      try {
        const b = getBlock(this.game.world.getState(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)));
        if (b && b.isWater) { v.shadow.visible = false; return; }
      } catch (err) {}
    }
    // distance fade: engine hides past 256 (16 blocks); the slider rescales
    // the range and depthCalculation picks the falloff curve.
    const cam = (this.game.renderer && this.game.renderer.camPos) || [p.x, p.y, p.z];
    const dd = Math.sqrt((p.x - cam[0]) * (p.x - cam[0]) + (p.y - cam[1]) * (p.y - cam[1]) + (p.z - cam[2]) * (p.z - cam[2]));
    const maxD = 16 * clamp((Number(s.vfxShadowDistance) || 60) / 60, 0.2, 3);
    if (dd >= maxD) { v.shadow.visible = false; return; }
    const t = clamp(dd / maxD, 0, 1);
    const fade = s.vfxDepthCalculation ? (1 - t * t) : (1 - t);
    let a = v.shadowParams ? v.shadowParams[3] : 1;
    a *= ((Number(s.vfxShadowStrength) || 60) / 60) * (1 + (Number(s.vfxShadowBoost) || 0) / 100);
    if (s.vfxShadowMode === 'enhanced') a *= 1.25;
    // resolution has no shadowmap equivalent here; high keeps full alpha,
    // lower settings soften (documented approximation).
    if (s.vfxShadowResolution === 'low') a *= 0.8;
    else if (s.vfxShadowResolution === 'medium') a *= 0.9;
    if (v.shadowParams) v.shadowParams[3] = clamp(a, 0, 1) * fade;
  }

  _wrapPlacement() {    const g = this.game;
    const inter = g.interaction;
    if (!inter || inter._ivfxWrapped) return;
    inter._ivfxWrapped = true;
    const orig = inter.onPlayerRightClick.bind(inter);
    inter.onPlayerRightClick = (t, hand) => {
      const ok = orig(t, hand);
      try {
        if (ok && this.s.vfxSmoothBlockPlace && vfxAllowed(this.s)) {
          const d = (typeof FACE_DIR !== 'undefined' && FACE_DIR[t.face]) || [0, 1, 0];
          this.shells.push({ x: t.x + d[0], y: t.y + d[1], z: t.z + d[2], t0: this.time });
          if (this.shells.length > 24) this.shells.shift();
        }
      } catch (e) {}
      return ok;
    };
  }

  _softenFoliage() {
    // NaturalFoliageColors: mute the grass/foliage tint LUTs once at boot.
    // Keeps a backup so the master toggle can restore vanilla tints live.
    try {
      if (!this.s.vfxNaturalFoliageColors || !vfxAllowed(this.s)) return;
      const A = this.game.assets;
      for (const key of ['grassPixels', 'foliagePixels']) {
        const lut = A[key];
        if (!lut || lut._ivfxSoft) continue;
        const d = lut.data || lut;
        if (!d || !d.length) continue;
        if (!lut._ivfxOrig) { try { lut._ivfxOrig = d.slice(); } catch (e) {} }
        for (let i = 0; i + 2 < d.length; i += 4) {
          const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
          const luma = r * 0.3 + g * 0.55 + b * 0.15;
          const f = 0.82;
          d[i] = clamp(lerp(r, luma, 1 - f) * 0.96, 0, 1) * 255;
          d[i + 1] = clamp(lerp(g, luma, 1 - f), 0, 1) * 255;
          d[i + 2] = clamp(lerp(b, luma, 1 - f) * 1.04, 0, 1) * 255;
        }
        lut._ivfxSoft = true;
      }
    } catch (e) {}
  }

  // Master toggle OFF: put the vanilla tint LUTs back (CPU-side tables, so
  // this takes effect on the next meshed/tinted frame, no reload needed).
  _restoreFoliage() {
    try {
      const A = this.game.assets;
      for (const key of ['grassPixels', 'foliagePixels']) {
        const lut = A[key];
        if (!lut || !lut._ivfxSoft || !lut._ivfxOrig) continue;
        const d = lut.data || lut;
        try {
          if (d.set) d.set(lut._ivfxOrig);
          else for (let i = 0; i < lut._ivfxOrig.length; i++) d[i] = lut._ivfxOrig[i];
        } catch (e) {}
        lut._ivfxSoft = false;
      }
    } catch (e) {}
  }

  // -- per-frame --

  tick() {
    if (!this.ready) return;
    this.time += 1 / 20;
    // ambient emitters run at 20Hz tick; heavy scans throttled inside
    try { this._ambient(); } catch (e) {}
  }

  _playerPos() {
    const p = this.game.player;
    return p ? [p.x, p.y, p.z] : [0, 64, 0];
  }

  _biomeAt(x, y, z) {
    try {
      const id = this.game.world.getBiome(Math.floor(x), Math.floor(z), Math.floor(y));
      const info = biomeInfo(id) || {};
      const name = info.name || 'plains';
      // Modded Biomes off: unknown (unlisted) biomes fall back to vanilla
      // treatment instead of the custom sky/fog tables.
      if (!this.s.vfxModdedBiomes && this.data) {
        const table = this.data.biomeTags;
        if (!table['minecraft:' + name] && !table[name]) {
          return { id, name: 'plains', info };
        }
      }
      return { id, name, info };
    } catch (e) { return { id: 1, name: 'plains', info: {} }; }
  }

  // ---- environment post-process (runs right after vanilla updateEnvironment)

  _post(state) {
    const g = this.game, s = this.s, r = g.renderer;
    const dim = g.dimension;
    const [px, py, pz] = this._playerPos();
    const b = this._biomeAt(px, py, pz);
    const tags = this.data ? biomeTags(this.data, b.name) : [];
    const t = Number(g.world.timeOfDay) || 0;
    const angle = celestialAngle(t, state.partial || 0);
    const sun = sunBrightness(angle, state.rain || 0, state.thunder || 0);
    const night = clamp(starBrightness(angle) * 2.2, 0, 1);
    const rain = state.rain || 0;
    const iris = !vfxAllowed(s) || this._foreignPack(); // useIrisShaders or foreign pack owns the frame
    const f = {
      biome: b, tags, angle, sun, night, rain, dim,
      skyLightAtPlayer: 15,
    };
    try { f.skyLightAtPlayer = g.world.getSkyLight(Math.floor(px), Math.floor(py + 1), Math.floor(pz)); } catch (e) {}
    this.frame = f;

    if ((f.dim === 0 && !s.vfxDimOverworld) || (f.dim === -1 && !s.vfxDimNether) || (f.dim === 1 && !s.vfxDimEnd)) {
      f.dimOff = true;
      return;
    }

    if (!this.enabled()) { this._restoreFoliage(); return; }
    this._softenFoliage(); // idempotent; re-applies after an off-stint

    // -- fog --
    this._applyFog(state, f, iris);
    // -- sky / clouds --
    if (!iris && this.allow('Sky')) this._applySky(state, f);
    // -- grading + light --
    if (this.allow('Light')) this._applyLight(state, f, iris);

    // sky event timers
    this._events(f);
  }

  _applyFog(state, f, iris) {
    const s = this.s, r = this.game.renderer;
    if (state.underwater || state.inLava || state.blindness) {
      if (state.underwater && !iris && (s.vfxWaterColors === 'realistic' || s.vfxWaterColorMapping)) {
        // Realistic water colors: deep, dark teal gradient with depth.
        const depth = clamp((63 - state.camPos[1]) / 24, 0, 1);
        let wc = [0.16, 0.32, 0.36];
        try {
          const e = this.data && fogFor(this.data, f.biome.name);
          if (e && e.water) wc = hexRgb(e.water[2]);
        } catch (err) {}
        const k = 1 - depth * 0.55;
        r.fog.color = [wc[0] * k, wc[1] * k, wc[2] * k];
        if (s.vfxUnderwaterDepthBlur) r.fog.density = (r.fog.density || 0.1) * (1 + depth * 1.6);
      }
      return;
    }
    if (f.dim !== 0) {
      if (f.dim === 1 && s.vfxEndColorGrading && !iris) {
        r.fog.color = [r.fog.color[0] * 0.75 + 0.1, r.fog.color[1] * 0.7 + 0.02, r.fog.color[2] * 0.9 + 0.12];
      }
      return;
    }
    const mode = s.vfxFogRenderingMode;
    if (mode === 'off') { r.fog.mode = 2; return; }
    const rdBlocks = this.game.settings.renderDistance * 16;
    if (mode === 'chunk_distance') return; // vanilla distances already set
    const ext = mode === 'immersive_extended' ? 1.6 : 1.0;
    let fogC = null, startMul = 1, endMul = 1;
    if (s.vfxDynamicFog && this.data) {
      const layer = f.rain > 0.3 ? 'weather' : 'air';
      try {
        // Cave-dense entries (air end < 12) only apply underground — outdoors
        // they would wall the world off at ~15 blocks. Re-roll the stable
        // pick until a surface-sane entry comes up (still deterministic).
        let e = null;
        for (let k = 0; k < 8; k++) {
          const cand = this.data.fogs[this.data.fogKeys[hashStr((f.biome.name || 'plains') + '#' + k) % this.data.fogKeys.length]];
          if (!cand) break;
          e = cand;
          const L = (e && e[layer]) || (e && e.air);
          if (f.skyLightAtPlayer > 8) { if (L && Number(L[1]) >= 12) break; }
          else break;
        }
        const L = (e && e[layer]) || (e && e.air);
        if (L) {
          fogC = hexRgb(L[2]);
          // sqrt-compress the mod's wide end range (0.4..1028, median 32)
          // toward vanilla so clear biomes stay clear but not fogless.
          startMul = clamp(Math.sqrt(Math.max(Number(L[0]), 0.01) / 2), 0.35, 2);
          endMul = clamp(Math.sqrt(Math.max(Number(L[1]), 0.01) / 64), 0.35, 2);
        }
      } catch (err) {}
    }
    let start = rdBlocks * 0.75 * startMul * ext;
    let end = rdBlocks * endMul * ext;
    const str = (Number(s.vfxAtmosphericFogStrength) || 60) / 100;
    if (s.vfxAtmosphericFog && !iris) {
      // Atmospheric fog: pull distances closer + haze toward sky.
      end = lerp(end, end * 0.55, str * 0.8);
      start = lerp(start, start * 0.6, str * 0.8);
    }
    if (fogC && !iris) {
      const m = s.vfxDynamicFog ? 0.55 : 0;
      const haze = 0.25 * str;
      r.fog.color = [
        lerp(r.fog.color[0], fogC[0], m) * (1 - haze) + (r.env.sky ? r.env.sky[0] * haze : 0),
        lerp(r.fog.color[1], fogC[1], m) * (1 - haze) + (r.env.sky ? r.env.sky[1] * haze : 0),
        lerp(r.fog.color[2], fogC[2], m) * (1 - haze) + (r.env.sky ? r.env.sky[2] * haze : 0),
      ];
    }
    // sand storm tints the air
    if (s.vfxSandStorm && f.tags.includes('desert') && f.rain > 0.4) {
      r.fog.color = [lerp(r.fog.color[0], 0.72, 0.5), lerp(r.fog.color[1], 0.55, 0.5), lerp(r.fog.color[2], 0.32, 0.5)];
      end *= 0.45; start *= 0.5;
    }
    if (s.vfxAlwaysWinter) {
      r.fog.color = [lerp(r.fog.color[0], 0.82, 0.3), lerp(r.fog.color[1], 0.87, 0.3), lerp(r.fog.color[2], 0.94, 0.3)];
    }
    r.fog.start = start; r.fog.end = end;
  }

  _applySky(state, f) {
    const s = this.s, r = this.game.renderer;
    const sky = r.env.sky;
    if (!sky) return;
    // custom skies: mix toward the mod's per-biome sky LUT
    if (s.vfxCustomSkies && this.data && f.dim === 0) {
      try {
        const rows = skyProfileFor(this.data, f.biome.name, this.game.world.timeOfDay, f.tags);
        if (rows && rows[1]) {
          sky[0] = lerp(sky[0], rows[1][0], 0.35);
          sky[1] = lerp(sky[1], rows[1][1], 0.35);
          sky[2] = lerp(sky[2], rows[1][2], 0.35);
        }
      } catch (e) {}
    }
    if (s.vfxSkyMode === 'realistic' && f.dim === 0) {
      // realistic.glsl in JS: deepen zenith, warm the sun side via sunrise tint
      const noon = clamp(f.sun, 0, 1);
      sky[0] = sky[0] * (0.82 + noon * 0.18);
      sky[1] = sky[1] * (0.86 + noon * 0.14);
      sky[2] = sky[2] * (0.94 + (1 - noon) * 0.1);
    }
    // clouds: hide engine clouds when IVFX owns the layer
    if (f.dim === 0 && (s.vfxCloudRendering === 'off' || s.vfxCustomSkies)) {
      r.env.cloudsVisible = false;
      r.env.cloudMode = 0;
    }
    if (s.vfxCloudRendering === 'shaded') {
      const cc = r.env.cloudColor;
      cc[0] *= 0.72; cc[1] *= 0.76; cc[2] *= 0.84;
    }
  }

  _gradeTable(f) {
    const s = this.s;
    const mode = s.vfxGradingMode;
    if (mode === 'off') return null;
    const G = s.vfxGrading || defaultGrading();
    if (mode === 'vanilla') return gradeParams(G.noon);
    // enhanced: blend dawn/noon/dusk/night by sun position
    const t = f.angle; // 0..1
    const dayW = clamp((f.sun - 0.15) * 2.2, 0, 1);
    const nightW = clamp(f.night, 0, 1);
    const ddW = clamp(1 - dayW - nightW, 0, 1);
    const dawnW = ddW * (t < 0.5 ? 1 : 0.15);
    const duskW = ddW * (t < 0.5 ? 0.15 : 1);
    const tot = dayW + nightW + dawnW + duskW || 1;
    const tables = [G.noon, G.night, G.dawn, G.dusk].map(gradeParams);
    const ws = [dayW / tot, nightW / tot, dawnW / tot, duskW / tot];
    const out = {};
    for (const k of Object.keys(tables[0])) {
      const v = tables[0][k];
      out[k] = Array.isArray(v)
        ? v.map((_, i) => tables.reduce((a, T, j) => a + T[k][i] * ws[j], 0))
        : tables.reduce((a, T, j) => a + T[k] * ws[j], 0);
    }
    return out;
  }

  // Per-texel lightmap transform (enhanced/warm/colored light + color
  // grading + dynamic night grade). Shared by the main pass and the torch
  // gamma path so neither leaves a stale frame behind.
  _gradeLightmap(lm, P, dynNight, warmBoost, colored) {
    for (let i = 0; i < 256; i++) {
      const o = i * 4;
      let cr = lm[o] / 255, cg = lm[o + 1] / 255, cb = lm[o + 2] / 255;
      const blk = i & 15, sky = i >> 4;
      if (warmBoost && blk >= 10) {
        // hot emitters run hotter, dark joints darker (enhancedLight)
        const k = (blk - 9) / 6;
        cr = clamp(cr * (1 + k * 0.28), 0, 1.5);
        cg = clamp(cg * (1 + k * 0.1), 0, 1.5);
      }
      if (colored > 0 && blk > 0 && sky < 14) {
        // torch/lava warmth tint on block-lit texels
        const k = (blk / 15) * colored * 0.35;
        cr = clamp(cr + k * 0.5, 0, 1.5);
        cg = clamp(cg + k * 0.12, 0, 1.5);
        cb = clamp(cb - k * 0.18, 0, 1.5);
      }
      if (P) {
        // dim==1 uses the dusk table (endColorGrading gate handled by caller tint)
        const c = applyGradeTo([cr, cg, cb], P);
        cr = c[0]; cg = c[1]; cb = c[2];
      }
      if (dynNight > 0) {
        const c = nightGrade([cr, cg, cb], dynNight * 0.7);
        cr = c[0]; cg = c[1]; cb = c[2];
      }
      lm[o] = clamp(cr, 0, 1) * 255; lm[o + 1] = clamp(cg, 0, 1) * 255; lm[o + 2] = clamp(cb, 0, 1) * 255;
    }
  }

  _applyLight(state, f, iris) {
    const s = this.s, r = this.game.renderer;
    const P = iris ? null : this._gradeTable(f);
    const lm = r.lightmapData;
    const dynNight = s.vfxDynamicColorGrading && !iris && f.dim === 0
      ? clamp(f.night, 0, 1) * clamp(f.skyLightAtPlayer / 12, 0.15, 1)
      : 0;
    const warmBoost = s.vfxEnhancedLight && !iris ? 1 : 0;
    const colored = s.vfxColoredLight && !iris ? (Number(s.vfxColoredLightIntensity) || 60) / 100 : 0;
    if (lm) {
      this._gradeLightmap(lm, P, dynNight, warmBoost, colored);
      try { r.device.updateTexture(r.lightmap, lm); } catch (e) {}
    }
    // held torch light: halo is drawn in world fx; lift gamma a touch at night
    const holding = this._holdingLight();
    const want = s.vfxTorchLight && holding && f.dim === 0 && f.sun < 0.35 && f.skyLightAtPlayer < 10 && !iris;
    const target = want ? this.game.settings.gamma + 0.3 * (1 - f.sun) : this.game.settings.gamma;
    if (Math.abs((r.gamma || 0) - target) > 0.01) {
      r.gamma = target;
      try {
        updateLightmap(r.lightmapData, {
          sun: f.dim === 0 ? f.sun : 1, dimension: f.dim, torchFlicker: r.torchFlickerX,
          gamma: target, darkness: undefined, nightVision: 0, lightning: 0,
        });
        this._gradeLightmap(r.lightmapData, P, dynNight, warmBoost, colored);
        r.device.updateTexture(r.lightmap, r.lightmapData);
      } catch (e) {}
    }
  }

  _holdingLight() {
    try {
      const g = this.game;
      return itemIsLight(g, g.inventory.held && g.inventory.held()) || itemIsLight(g, g.inventory.offhand);
    } catch (e) { return false; }
  }

  _events(f) {
    const s = this.s, E = this.events;
    if (f.dim !== 0 || f.night < 0.4 || f.rain > 0.2 || !this.allow('Sky')) { E.stars.length = 0; E.shower.length = 0; return; }
    E.nextStar -= 1 / 20;
    if (E.nextStar <= 0 && s.vfxShootingStars) {
      E.nextStar = 15 + Math.random() * 50;
      E.stars.push({ t: 0, dur: 1.2 + Math.random(), x: Math.random() * 2 - 1, z: Math.random() * 2 - 1, hue: Math.random() });
    }
    for (const st of E.stars) st.t += 1 / 20;
    E.stars = E.stars.filter((st) => st.t < st.dur);
    // meteor shower nights: every ~4 min a burst night
    E.nextShower -= 1 / 20;
    if (E.nextShower <= 0) {
      E.nextShower = 200 + Math.random() * 240;
      if (s.vfxMeteorShower && Math.random() < 0.35) {
        for (let i = 0; i < 8; i++) E.shower.push({ t: -Math.random() * 3, dur: 1 + Math.random(), x: Math.random() * 2 - 1, z: Math.random() * 2 - 1 });
      }
      if (s.vfxFireworks && Math.random() < 0.3) {
        for (let i = 0; i < 3; i++) E.fireworks.push({ t: -i * 1.2 - Math.random(), x: (Math.random() * 2 - 1) * 0.7, z: (Math.random() * 2 - 1) * 0.7, hue: Math.random() });
      }
    }
    for (const m of E.shower) m.t += 1 / 20;
    for (const m of E.fireworks) m.t += 1 / 20;
    E.shower = E.shower.filter((m) => m.t < m.dur + 1);
    E.fireworks = E.fireworks.filter((m) => m.t < 3);
  }

  // ---------------------------------------------------------------- ambient
  // AmbientMotes + SurfaceEffects + WaterfallMist + LowFog + weather extras.
  // Particle visuals ride the engine particle system; large soft volumes
  // (mist banks, shafts, aurora) are billboards in the draw passes below.

  _ambient() {
    const g = this.game, s = this.s;
    if (!g.inWorld || !g.world) return;
    if (!this.enabled()) return;
    const rate = s.vfxParticleRate;
    if (rate === 'none') return;
    const mult = rate === 'reduced' ? 0.4 : 1;
    const f = this.frame;
    if (!f || f.dimOff) return;
    const [px, py, pz] = this._playerPos();
    const P = g.particles;
    const dim = f.dim;
    const rnd = Math.random;
    const tryAdd = (o) => { if (rnd() < mult) P.add(o); };

    // -- fireflies (night, overworld, vegetation biomes) --
    if (s.vfxFireflies && dim === 0 && f.night > 0.5 && f.rain < 0.5 && this.allow('Effects') && /forest|jungle|taiga|plains|meadow|swamp|grove/.test(f.biome.name)) {
      if (rnd() < 0.3 * mult) {
        tryAdd({
          x: px + (rnd() * 2 - 1) * 14, y: py + rnd() * 3 - 1, z: pz + (rnd() * 2 - 1) * 14,
          mx: (rnd() - 0.5) * 0.2, my: (rnd() - 0.5) * 0.1, mz: (rnd() - 0.5) * 0.2,
          r: 0.7, g: 1.0, b: 0.35, a: 0.9, scale: 0.45, maxAge: 60 + rnd() * 60, gravity: 0,
          sprite: 'glow', fullBright: true,
        });
      }
    }
    // -- specks (always, faint dust) --
    if (s.vfxSpecks && rnd() < 0.25 * mult && this.allow('Effects')) {
      tryAdd({
        x: px + (rnd() * 2 - 1) * 10, y: py + (rnd() * 2 - 1) * 4, z: pz + (rnd() * 2 - 1) * 10,
        mx: 0.05, my: -0.01, mz: 0.02, r: 1, g: 1, b: 1, a: 0.16, scale: 0.3,
        maxAge: 80 + rnd() * 40, gravity: 0, sprite: 'poof',
      });
    }
    // -- pollen / spores (plants sway with the wind when Moving Plants is on) --
    if (s.vfxPollenAndSpores && this.allow('Effects')) {
      const plantSway = s.vfxMovingPlants ? 1 : 0;
      const cave = f.skyLightAtPlayer < 3 && py < 55;
      if ((cave || /flower|meadow|forest|jungle|lush|mushroom/.test(f.biome.name)) && dim === 0 && rnd() < 0.2 * mult) {
        const spore = cave || /mushroom/.test(f.biome.name);
        tryAdd({
          x: px + (rnd() * 2 - 1) * 12, y: py + rnd() * 3, z: pz + (rnd() * 2 - 1) * 12,
          mx: (rnd() - 0.5) * (0.05 + 0.15 * plantSway) + Math.sin(this.time * 1.5 + px) * 0.08 * plantSway,
          my: -0.03, mz: (rnd() - 0.5) * (0.05 + 0.15 * plantSway),
          r: spore ? 0.5 : 1.0, g: spore ? 0.9 : 0.9, b: spore ? 0.6 : 0.4, a: 0.5,
          scale: 0.35, maxAge: 90, gravity: 0, sprite: 'poof',
        });
      }
    }
    // -- leaves falling (under leaf blocks; sway with Moving Leaves) --
    if (s.vfxLeaves && rnd() < 0.5 * mult && this.allow('Effects')) {
      const leafSway = s.vfxMovingLeaves ? 1 : 0;
      const lx = Math.floor(px + (rnd() * 2 - 1) * 8), lz = Math.floor(pz + (rnd() * 2 - 1) * 8);
      for (let y = Math.floor(py) + 4; y > py - 2; y--) {
        let st = 0;
        try { st = g.world.getState(lx, y, lz); } catch (e) { break; }
        const blk = getBlock(st);
        if (blk && /leaves/.test(blk.name || '')) {
          tryAdd({
            x: lx + 0.5, y: y - 0.2, z: lz + 0.5,
            mx: (rnd() - 0.5) * (0.1 + 0.35 * leafSway) + Math.sin(this.time * 2 + lx) * 0.25 * leafSway,
            my: -0.25, mz: (rnd() - 0.5) * (0.1 + 0.35 * leafSway),
            r: 0.35 + rnd() * 0.3, g: 0.55 + rnd() * 0.2, b: 0.15, a: 0.9, scale: 0.5,
            maxAge: 70, gravity: 0.12, sprite: 'poof',
          });
          break;
        }
        if (blk && blk.id !== 0 && !blk.isLiquid) break;
      }
    }
    // -- floating leaves on water surfaces (water leaves) --
    if (s.vfxWaterLeaves && dim === 0 && f.sun > 0.15 && rnd() < 0.3 * mult && this.allow('Effects')) {
      const lx = Math.floor(px + (rnd() * 2 - 1) * 12), lz = Math.floor(pz + (rnd() * 2 - 1) * 12);
      try {
        for (let y = Math.floor(py) + 2; y > Math.floor(py) - 4; y--) {
          const st = g.world.getState(lx, y, lz);
          const blk = getBlock(st);
          if (!blk || blk.id === 0) continue;
          if (blk.isWater) {
            tryAdd({
              x: lx + 0.5, y: y + 1.02, z: lz + 0.5,
              mx: Math.sin(this.time * 0.8 + lx * 2 + lz) * 0.08, my: 0, mz: Math.cos(this.time * 0.7 + lz * 2) * 0.08,
              r: 0.3 + rnd() * 0.25, g: 0.5 + rnd() * 0.2, b: 0.2, a: 0.85, scale: 0.45,
              maxAge: 120 + rnd() * 60, gravity: 0, sprite: 'poof',
            });
          }
          break;
        }
      } catch (e) {}
    }
    // -- waterfall mist (mist where water falls) --
    if (s.vfxWaterfallMist && dim === 0 && rnd() < 0.5 * mult && this.allow('Effects')) {
      const lx = Math.floor(px + (rnd() * 2 - 1) * 14), lz = Math.floor(pz + (rnd() * 2 - 1) * 14);
      try {
        for (let y = Math.floor(py) + 5; y > Math.floor(py) - 8; y--) {
          const st = g.world.getState(lx, y, lz);
          const blk = getBlock(st);
          if (!blk || blk.id === 0) continue;
          if (blk.isWater) {
            // falling water: water with at least 3 more water/air below
            let fall = 0;
            for (let yy = y - 1; yy > y - 6; yy--) {
              let bst = 0;
              try { bst = g.world.getState(lx, yy, lz); } catch (e) { break; }
              const bb = getBlock(bst);
              if (!bb || bb.id === 0 || bb.isWater) fall++;
              else break;
            }
            if (fall >= 3) {
              let gy = y - fall;
              tryAdd({
                x: lx + 0.5, y: gy + 0.6, z: lz + 0.5,
                mx: (rnd() - 0.5) * 0.4, my: 0.3 + rnd() * 0.3, mz: (rnd() - 0.5) * 0.4,
                r: 0.85, g: 0.92, b: 0.95, a: 0.4, scale: 0.9,
                maxAge: 40, gravity: -0.01, sprite: 'poof',
              });
            }
          }
          break;
        }
      } catch (e) {}
    }
    // -- wind gusts (streaks; stronger in storms / high up) --
    if (s.vfxWindGusts && dim === 0 && rnd() < (0.06 + f.rain * 0.25 + clamp((py - 90) / 60, 0, 0.2)) * mult && this.allow('Weather')) {
      tryAdd({
        x: px + (rnd() * 2 - 1) * 16, y: py + (rnd() * 2 - 1) * 5, z: pz + (rnd() * 2 - 1) * 16,
        mx: 3.5 + rnd() * 2, my: 0, mz: (rnd() - 0.5) * 1.2,
        r: 0.9, g: 0.95, b: 1, a: 0.28, scale: 2.2, maxAge: 22, gravity: 0, sprite: 'poof',
      });
    }
    // -- sand wind / sand storm (desert) --
    if ((s.vfxSandWind || s.vfxSandStorm) && dim === 0 && /desert|badlands|mesa/.test(f.biome.name) && this.allow('Weather')) {
      const storm = s.vfxSandStorm && f.rain > 0.4;
      if (rnd() < ((storm ? 0.9 : 0.25) * mult)) {
        const sand = storm || s.vfxSandWind;
        if (sand) tryAdd({
          x: px + (rnd() * 2 - 1) * 14, y: py + rnd() * 3 - 1, z: pz + (rnd() * 2 - 1) * 14,
          mx: 2.5 + rnd() * 2, my: (rnd() - 0.5) * 0.4, mz: (rnd() - 0.5) * 1.5,
          r: 0.85, g: 0.7, b: 0.45, a: storm ? 0.55 : 0.3, scale: storm ? 1.4 : 0.8,
          maxAge: 40, gravity: 0, sprite: 'poof',
        });
      }
    }
    // -- snow / sand HD style (soft round flakes around player) --
    // Weather Visuals: vanilla = engine precipitation only; enhanced adds
    // IVFX HD snowflakes on top; custom replaces engine streaks with full
    // IVFX precipitation (snow + visible rain). Engine streak suppression
    // for custom happens in game.renderFrame.
    if (f.rain > 0.3 && dim === 0 && (s.vfxWeatherVisuals || 'enhanced') !== 'vanilla' && this.allow('Weather')) {
      const snow = f.tags.includes('snowy') || f.tags.includes('frozen') || s.vfxAlwaysWinter || py > 90;
      const custom = (s.vfxWeatherVisuals || 'enhanced') === 'custom';
      if (s.vfxSnowSandStyle === 'hd' && rnd() < 0.7 * mult) {
        tryAdd({
          x: px + (rnd() * 2 - 1) * 12, y: py + 6 + rnd() * 3, z: pz + (rnd() * 2 - 1) * 12,
          mx: (rnd() - 0.5) * 0.3, my: snow ? -0.9 : -1.6, mz: (rnd() - 0.5) * 0.3,
          r: 1, g: 1, b: 1, a: snow ? 0.85 : (custom ? 0.4 : 0.0), scale: snow ? 0.4 : 0.3,
          maxAge: 90, gravity: 0, sprite: 'poof',
        });
      }
    }
    // -- lava embers (DungeonsFire: lit smoke + embers + warm light) --
    if (s.vfxDungeonsFire && rnd() < 0.4 * mult) {
      const src = this._nearBright('lava', px, py, pz, 10);
      if (src) tryAdd({
        x: src[0] + rnd(), y: src[1] + 1, z: src[2] + rnd(),
        mx: (rnd() - 0.5) * 0.4, my: 0.8 + rnd() * 0.6, mz: (rnd() - 0.5) * 0.4,
        r: 1, g: rnd() < 0.5 ? 0.5 : 0.75, b: 0.15, a: 0.9, scale: 0.4,
        maxAge: 40, gravity: -0.02, sprite: 'flame', fullBright: true,
      });
    }
  }

  // nearest bright block of a kind within r (uses the glow scan cache)
  _nearBright(kind, px, py, pz, r) {
    this._scanGlow(px, py, pz);
    let best = null, bd = r * r;
    for (const e of this.glowCache.list) {
      if (e.kind !== kind) continue;
      const d = (e.x - px) ** 2 + (e.y - py) ** 2 + (e.z - pz) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    return best ? [best.x, best.y, best.z] : null;
  }

  // scan for bright sources (lava/fire/torch-ish) around the player, 1Hz
  _scanGlow(px, py, pz) {
    const now = this.time;
    if (now - this.glowCache.t < 1) return;
    this.glowCache.t = now;
    const list = [];
    try {
      const R = 12;
      for (let i = 0; i < 90; i++) {
        const x = Math.floor(px + (Math.random() * 2 - 1) * R);
        const y = Math.floor(py + (Math.random() * 2 - 1) * 6);
        const z = Math.floor(pz + (Math.random() * 2 - 1) * R);
        const st = this.game.world.getState(x, y, z);
        const blk = getBlock(st);
        if (!blk || !blk.name) continue;
        const n = blk.name;
        let kind = null, col = null;
        if (n === 'lava') { kind = 'lava'; col = [1, 0.35, 0.05]; }
        else if (n === 'fire' || n === 'soul_fire') { kind = 'fire'; col = n === 'fire' ? [1, 0.55, 0.1] : [0.3, 0.7, 1]; }
        else if (LIGHT_SOURCE_BLOCKS.has(n.replace(/^wall_/, ''))) { kind = 'torch'; col = /soul/.test(n) ? [0.35, 0.7, 1] : [1, 0.7, 0.3]; }
        if (kind && list.length < 40) list.push({ x, y, z, kind, col });
      }
    } catch (e) {}
    this.glowCache.list = list;
  }

  // ---------------------------------------------------------------- draws

  _drawSkyFx(d) {
    if (!this.ready || !this.frame) return;
    const s = this.s, f = this.frame;
    if (!this.enabled() || !vfxAllowed(s) || this._foreignPack() || f.dimOff || !this.allow('Sky')) return;
    const g = this.game;
    const [px, py, pz] = this._playerPos();
    const cr = g.renderer.camRot;
    const rx = [cr[0], cr[1], cr[2]], ux = [cr[4], cr[5], cr[6]];
    this.batchAdd.begin();
    // -- aurora (cold biomes, night, clear) --
    if (s.vfxAurora && s.vfxCustomSkies && f.dim === 0 && f.night > 0.55 && f.rain < 0.25 &&
        (f.biome.info.temperature < 0.3 || /snow|frozen|ice|taiga/.test(f.biome.name))) {
      const tex = this.tex.aurora;
      const shimmer = 0.5 + 0.5 * Math.sin(this.time * 0.7);
      const a = 0.4 * f.night * (0.6 + 0.4 * shimmer);
      for (let i = 0; i < 3; i++) {
        const cx = px + (i - 1) * 160, cz = pz - 260;
        const w = 200, h = 90;
        this.batchAdd.push([cx - w, py + 170, cz, cx - w, py + 170 + h, cz, cx + w, py + 170 + h, cz, cx + w, py + 170, cz],
          i * 0.33, 0, i * 0.33 + 0.33, 1, 0.35, 1.0, 0.6, a * (1 - i * 0.22));
      }
      void tex;
    }
    // -- shooting stars / meteors / fireworks --
    const streak = (sx, sz, prog, len, r, gr, b, a) => {
      const bx = px + sx * 300, bz = pz + sz * 300, by = py + 190;
      const ex = bx - len * 60, ey = by - len * 22;
      const w = 1.6;
      this.batchAdd.push([bx - w, by, bz, bx + w, by, bz, ex + w, ey, bz, ex - w, ey, bz], 0, 0, 1, 1, r, gr, b, a);
    };
    for (const st of this.events.stars) {
      const p = st.t / st.dur;
      streak(st.x, st.z, p, 1 - p, 1, 1, 1, 0.8 * (1 - p));
    }
    for (const m of this.events.shower) {
      if (m.t < 0) continue;
      const p = m.t / m.dur;
      if (p > 1) continue;
      streak(m.x, m.z, p, 1 - p, 0.7, 0.85, 1, 0.7 * (1 - p));
    }
    for (const m of this.events.fireworks) {
      if (m.t < 0 || m.t > 2.2) continue;
      const c = hsv2rgb([m.hue, 0.8, 1]);
      for (let i = 0; i < 6; i++) {
        const an = (i / 6) * Math.PI * 2 + m.hue * 6;
        const rr = m.t * 22;
        this.batchAdd.push([px + m.x * 220 + Math.cos(an) * rr - 1, py + 150 - m.t * 8, pz + m.z * 220 + Math.sin(an) * rr,
          px + m.x * 220 + Math.cos(an) * rr + 1, py + 150 - m.t * 8, pz + m.z * 220 + Math.sin(an) * rr,
          px + m.x * 220 + Math.cos(an) * (rr + 2), py + 150 - m.t * 8 - 2, pz + m.z * 220 + Math.sin(an) * (rr + 2),
          px + m.x * 220 + Math.cos(an) * (rr + 2) - 2, py + 150 - m.t * 8 - 2, pz + m.z * 220 + Math.sin(an) * (rr + 2)],
          0, 0, 1, 1, c[0], c[1], c[2], clamp(1.4 - m.t, 0, 1) * 0.8);
      }
    }
    this.batchAdd.end();
    const tex = this.tex.glow;
    if (this.batchAdd.n && tex) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAdd.draw(d, tex, this._params, STATE_ADD);
    }
    // aurora band with its noise texture (second pass, scrolling UVs)
    if (s.vfxAurora && s.vfxCustomSkies && f.dim === 0 && f.night > 0.55 && f.rain < 0.25 &&
        (f.biome.info.temperature < 0.3 || /snow|frozen|ice|taiga/.test(f.biome.name)) &&
        this.tex.aurora && this.allow('Sky')) {
      const shimmer = 0.5 + 0.5 * Math.sin(this.time * 0.7);
      const scroll = (this.time * 0.008) % 1;
      this.batchAdd.begin();
      for (let i = 0; i < 3; i++) {
        const cx = px + (i - 1) * 160, cz = pz - 260;
        const w = 200, h = 90;
        const u0 = i * 0.33 + scroll, u1 = i * 0.33 + 0.33 + scroll;
        this.batchAdd.push([cx - w, py + 170, cz, cx - w, py + 170 + h, cz, cx + w, py + 170 + h, cz, cx + w, py + 170, cz],
          u0, 0, u1, 1, 0.35, 1.0, 0.6, 0.4 * f.night * (0.6 + 0.4 * shimmer) * (1 - i * 0.22));
      }
      this.batchAdd.end();
      if (this.batchAdd.n) {
        colorParams(1, 1, 1, 1, 0, 0, this._params);
        this.batchAdd.draw(d, this.tex.aurora, this._params, STATE_ADD);
      }
    }
  }

  _drawWorldFx(d) {
    if (!this.ready || !this.frame) return;
    const s = this.s, f = this.frame, g = this.game;
    if (!this.enabled() || !vfxAllowed(s) || this._foreignPack() || f.dimOff) return;
    const [px, py, pz] = this._playerPos();
    const cr = g.renderer.camRot;
    const R = [cr[0], cr[1], cr[2]], U = [cr[4], cr[5], cr[6]];
    this.batchAdd.begin();
    this.batchAlpha.begin();
    const rate = s.vfxParticleRate === 'none' ? 0 : s.vfxParticleRate === 'reduced' ? 0.5 : 1;

    // -- bloom halos on bright sources --
    if (s.vfxBloom && rate > 0 && this.allow('Bloom')) {
      this._scanGlow(px, py, pz);
      const inten = (Number(s.vfxBloomIntensity) || 60) / 100;
      for (const e of this.glowCache.list) {
        const dx = e.x + 0.5 - px, dy = e.y + 0.5 - py, dz = e.z + 0.5 - pz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 26) continue;
        const a = clamp(1 - dist / 26, 0, 1) * 0.5 * inten;
        const sz = (e.kind === 'lava' ? 2.6 : 1.7) * (0.7 + (Number(s.vfxColoredLightRadius) || 60) / 200);
        const flick = 0.9 + 0.1 * Math.sin(this.time * 11 + e.x * 3 + e.z * 5);
        this.batchAdd.billboard(e.x + 0.5, e.y + 0.6, e.z + 0.5,
          [R[0] * sz * flick, R[1] * sz * flick, R[2] * sz * flick],
          [U[0] * sz * flick, U[1] * sz * flick, U[2] * sz * flick],
          1, 0, 0, 1, e.col[0], e.col[1], e.col[2], a);
      }
    }
    // -- held torch halo --
    if (s.vfxTorchLight && this._holdingLight() && rate > 0 && this.allow('Light')) {
      const look = g.lookVector ? g.lookVector() : [0, 0, 1];
      const hx = px + look[0] * 0.7, hy = py + 1.4 + look[1] * 0.7, hz = pz + look[2] * 0.7;
      const sz = 1.1;
      this.batchAdd.billboard(hx, hy, hz, [R[0] * sz, R[1] * sz, R[2] * sz], [U[0] * sz, U[1] * sz, U[2] * sz],
        1, 0, 0, 1, 1, 0.72, 0.35, 0.5);
    }
    // -- GPU grass tufts --
    if (s.vfxGpuGrass && f.dim === 0 && rate > 0 && this.tex.grass && this.allow('Effects')) {
      this._drawGrass(px, py, pz, f, R, U);
    }
    // -- custom weather rendering: IVFX rain streaks (engine streaks off) --
    if (s.vfxWeatherVisuals === 'custom' && f.dim === 0 && f.rain > 0.3 && rate > 0 && this.allow('Weather')) {
      const n = Math.floor(10 + f.rain * 26);
      for (let i = 0; i < n; i++) {
        const x = px + (Math.random() * 2 - 1) * 14, y = py + (Math.random() * 2 - 1) * 6, z = pz + (Math.random() * 2 - 1) * 14;
        const len = 1.1 + Math.random() * 0.6, wdt = 0.05, slant = 0.35;
        this.batchAlpha.push([x - wdt, y, z, x - wdt, y + len, z, x + wdt + slant, y + len, z, x + wdt + slant, y, z],
          0, 0, 1, 1, 0.65, 0.75, 0.9, 0.35 * f.rain);
      }
    }
    // -- caustics / glints / foam (surface effects) --
    if (rate > 0 && this.allow('Reflections')) this._drawSurface(px, py, pz, f, R, U);
    // -- smooth block-place shells --
    if (s.vfxSmoothBlockPlace && this.allow('Effects')) {
      for (const sh of this.shells) {
        const age = this.time - sh.t0;
        if (age > 0.25) continue;
        const p = age / 0.25;
        const e = 0.02 + p * 0.06;
        const a = 0.5 * (1 - p);
        const x0 = sh.x - e, x1 = sh.x + 1 + e, y0 = sh.y - e, y1 = sh.y + 1 + e, z0 = sh.z - e, z1 = sh.z + 1 + e;
        // 6 faces, translucent white
        this.batchAlpha.push([x0, y0, z1, x0, y1, z1, x1, y1, z1, x1, y0, z1], 0, 0, 1, 1, 1, 1, 1, a);
        this.batchAlpha.push([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0], 0, 0, 1, 1, 1, 1, 1, a);
        this.batchAlpha.push([x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1], 0, 0, 1, 1, 1, 1, 1, a);
        this.batchAlpha.push([x0, y0, z0, x0, y0, z1, x1, y0, z1, x1, y0, z0], 0, 0, 1, 1, 1, 1, 1, a);
        this.batchAlpha.push([x0, y0, z0, x0, y1, z0, x0, y1, z1, x0, y0, z1], 0, 0, 1, 1, 1, 1, 1, a);
        this.batchAlpha.push([x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0], 0, 0, 1, 1, 1, 1, 1, a);
      }
      this.shells = this.shells.filter((sh) => this.time - sh.t0 <= 0.25);
    }
    // -- block outlines (thicker shell on selection; toon = bold) --
    const outline = g.renderer.outlineBox;
    if (s.vfxBlockOutlines && outline && this.allow('Outlines')) {
      const th = (Number(s.vfxBlockOutlineThickness) || 50) / 100;
      const a = 0.12 + th * 0.3;
      const e = 0.005 + th * 0.02;
      const [x0, y0, z0, x1, y1, z1] = [outline[0] - e, outline[1] - e, outline[2] - e, outline[3] + e, outline[4] + e, outline[5] + e];
      const dark = s.vfxPreset && s.vfxPreset.endsWith('_toon') ? 0.0 : 0.08;
      this.batchAlpha.push([x0, y0, z1, x0, y1, z1, x1, y1, z1, x1, y0, z1], 0, 0, 1, 1, dark, dark, dark, a);
      this.batchAlpha.push([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0], 0, 0, 1, 1, dark, dark, dark, a);
      this.batchAlpha.push([x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1], 0, 0, 1, 1, dark, dark, dark, a);
      this.batchAlpha.push([x0, y0, z0, x0, y0, z1, x1, y0, z1, x1, y0, z0], 0, 0, 1, 1, dark, dark, dark, a);
      this.batchAlpha.push([x0, y0, z0, x0, y1, z0, x0, y1, z1, x0, y0, z1], 0, 0, 1, 1, dark, dark, dark, a);
      this.batchAlpha.push([x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0], 0, 0, 1, 1, dark, dark, dark, a);
    }
    // -- targeted-mob marker ring (mob outline marker) --
    if (s.vfxMobOutlines && this.allow('Outlines')) {
      try {
        const t = g.interaction.target;
        if (t && t.type === 'entity' && t.entity) {
          const e = g.entities.interp(t.entity, 1) || t.entity;
          const th = (Number(s.vfxMobOutlineThickness) || 50) / 100;
          const rr = (t.entity.width || 0.6) * (0.8 + th * 0.5);
          const y = (e.y || py) + 0.03;
          const a = 0.35 + th * 0.3;
          const x = e.x, z = e.z;
          this.batchAlpha.push([x - rr, y, z - rr, x - rr, y, z + rr, x + rr, y, z + rr, x + rr, y, z - rr], 0, 0, 1, 1, 0.05, 0.05, 0.05, a);
        }
      } catch (err) {}
    }

    this.batchAdd.end();
    this.batchAlpha.end();
    if (this.batchAdd.n && this.tex.glow) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAdd.draw(d, this.tex.glow, this._params, STATE_ADD);
    }
    if (this.batchAlpha.n && this.tex.soft) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAlpha.draw(d, this.tex.soft, this._params, STATE_ALPHA);
    }
    // clouds (own layer, textured)
    if (f.dim === 0) this._drawClouds(d, px, pz, f);
    // enchantment glints on item entities
    if (s.vfxEnchantmentOutlines && rate > 0 && this.allow('Outlines')) this._drawEnchant(d, px, py, pz, R, U);
  }

  _drawGrass(px, py, pz, f, R, U) {
    const s = this.s;
    const density = (Number(s.vfxGpuGrassDensity) || 60) / 100;
    const dist = clamp(Number(s.vfxGpuGrassDistance) || 48, 8, 96);
    const hScale = (Number(s.vfxGpuGrassHeight) || 100) / 100;
    const n = Math.floor(26 * density) + 4;
    const sway = s.vfxMovingGrass ? 1 : 0;
    let tint = [0.45, 0.65, 0.3];
    try {
      const c = grassColor(f.biome.id, Math.floor(py));
      tint = [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
    } catch (e) {}
    const shade = clamp(0.4 + f.sun * 0.6, 0, 1);
    let placed = 0, guard = 0;
    while (placed < n && guard++ < n * 12) {
      const a = Math.random() * Math.PI * 2;
      const rr = 2 + Math.random() * dist;
      const x = Math.floor(px + Math.cos(a) * rr), z = Math.floor(pz + Math.sin(a) * rr);
      let gy = null;
      try {
        for (let y = Math.floor(py) + 3; y > Math.floor(py) - 6; y--) {
          const st = this.game.world.getState(x, y, z);
          const blk = getBlock(st);
          if (!blk || blk.id === 0 || blk.isLiquid) continue;
          if (blk.name === 'grass_block' || blk.name === 'grass') { gy = y + 1; break; }
          break;
        }
      } catch (e) { continue; }
      if (gy === null) continue;
      const fade = clamp(1 - (rr - dist * 0.6) / (dist * 0.4), 0.15, 1);
      const h = (0.35 + Math.random() * 0.25) * hScale;
      const wdt = h * 0.7;
      const sw = sway ? Math.sin(this.time * 2.2 + x * 0.7 + z * 0.9) * 0.08 * h : 0;
      const a2 = 0.9 * fade * shade;
      // crossed quads (static geometry in world space, cheap grass look)
      const x0 = x + 0.2 + Math.random() * 0.6, z0 = z + 0.2 + Math.random() * 0.6;
      this.batchAlpha.push([x0 - wdt, gy, z0, x0 - wdt + sw, gy + h, z0, x0 + wdt + sw, gy + h, z0, x0 + wdt, gy, z0],
        0, 0, 1, 1, tint[0] * shade + 0.05, tint[1] * shade + 0.05, tint[2] * shade, a2);
      placed++;
    }
  }

  _drawSurface(px, py, pz, f, R, U) {
    const s = this.s, g = this.game;
    // glitter on water/ice (reflections) + caustics + foam
    const day = f.sun > 0.25 && f.rain < 0.6;
    if ((s.vfxWaterReflections || s.vfxIceReflections) && day && f.dim === 0) {
      const strength = (Number(s.vfxReflectionStrength) || 60) / 100;
      const n = Math.floor(10 * strength * (s.vfxReflectionQuality === 'high' ? 1.6 : s.vfxReflectionQuality === 'low' ? 0.5 : 1));
      for (let i = 0; i < n; i++) {
        const x = px + (Math.random() * 2 - 1) * 22, z = pz + (Math.random() * 2 - 1) * 22;
        let wy = null, ice = false;
        try {
          for (let y = Math.floor(py) + 2; y > Math.floor(py) - 8; y--) {
            const st = g.world.getState(Math.floor(x), y, Math.floor(z));
            const blk = getBlock(st);
            if (!blk || blk.id === 0) continue;
            if (blk.isWater) { wy = y + 1; break; }
            if (/ice/.test(blk.name || '')) { if (s.vfxIceReflections) { wy = y + 1; ice = true; } break; }
            break;
          }
        } catch (e) { continue; }
        if (wy === null) continue;
        if (!s.vfxWaterReflections && !ice) continue;
        const tw = 0.6 + Math.random() * 1.4;
        this.batchAdd.billboard(x, wy + 0.05, z,
          [R[0] * tw, R[1] * tw, R[2] * tw], [U[0] * tw * 0.4, U[1] * tw * 0.4, U[2] * tw * 0.4],
          1, 0, 0, 1, 1, 0.98, 0.9, 0.35 * strength);
      }
    }
    // underwater caustics: dapple on the seabed
    if (s.vfxUnderwaterCaustics && day && this.tex.waterNoise) {
      try {
        const eyeWet = g.world.getState(Math.floor(px), Math.floor(py + 1), Math.floor(pz));
        const wet = getBlock(eyeWet);
        if (wet && wet.isWater) {
          for (let i = 0; i < 6; i++) {
            const x = Math.floor(px + (Math.random() * 2 - 1) * 10), z = Math.floor(pz + (Math.random() * 2 - 1) * 10);
            let gy = null;
            for (let y = Math.floor(py); y > Math.floor(py) - 12; y--) {
              const st = g.world.getState(x, y, z);
              const blk = getBlock(st);
              if (!blk || blk.id === 0 || blk.isLiquid) continue;
              gy = y + 1; break;
            }
            if (gy === null) continue;
            const tw = 1 + Math.random() * 1.5;
            const a = 0.22 * (0.6 + 0.4 * Math.sin(this.time * 2 + x + z));
            this.batchAdd.billboard(x + 0.5, gy + 0.06, z + 0.5,
              [R[0] * tw, R[1] * tw, R[2] * tw], [U[0] * tw, U[1] * tw, U[2] * tw],
              1, 0, 0, 1, 0.6, 0.9, 0.95, a);
          }
        }
      } catch (e) {}
    }
    // terrain glint: sparse sun sparkles on surfaces
    if (s.vfxTerrainGlint && day && f.dim === 0 && Math.random() < 0.5) {
      const x = Math.floor(px + (Math.random() * 2 - 1) * 14);
      const z = Math.floor(pz + (Math.random() * 2 - 1) * 14);
      try {
        for (let y = Math.floor(py) + 3; y > Math.floor(py) - 3; y--) {
          const st = g.world.getState(x, y, z);
          const blk = getBlock(st);
          if (!blk || blk.id === 0 || blk.isLiquid) continue;
          const sm = clamp(Number(s.vfxGlintSmoothness) || 50, 0, 100) / 100;
          this.batchAdd.billboard(x + 0.5, y + 1.02, z + 0.5,
            [R[0] * 0.3, R[1] * 0.3, R[2] * 0.3], [U[0] * 0.3, U[1] * 0.3, U[2] * 0.3],
            1, 0, 0, 1, 1, 1, 1, (1 - sm) * 0.5 + 0.1);
          break;
        }
      } catch (e) {}
    }
    // shore foam / lava foam edges (cached scan)
    if ((s.vfxShoreFoam || s.vfxLavaFoam) && this.time - this.edgeCache.t > 1.5) {
      this.edgeCache.t = this.time;
      const water = [], lava = [];
      try {
        for (let i = 0; i < 120 && (water.length < 24 || lava.length < 12); i++) {
          const x = Math.floor(px + (Math.random() * 2 - 1) * 12);
          const z = Math.floor(pz + (Math.random() * 2 - 1) * 12);
          const y = Math.floor(py);
          const st = g.world.getState(x, y, z);
          const blk = getBlock(st);
          if (!blk) continue;
          const n = blk.name || '';
          if ((n === 'water' || blk.isWater) && s.vfxShoreFoam) {
            // edge if a neighbor is solid ground
            const nb = getBlock(g.world.getState(x + 1, y, z));
            if (nb && nb.id !== 0 && !nb.isLiquid && !nb.isWater) water.push([x, y, z]);
          } else if (n === 'lava' && s.vfxLavaFoam) {
            lava.push([x, y, z]);
          }
        }
      } catch (e) {}
      this.edgeCache.water = water; this.edgeCache.lava = lava;
    }
    for (const [x, y, z] of this.edgeCache.water) {
      const a = 0.4 + 0.2 * Math.sin(this.time * 3 + x + z);
      this.batchAlpha.push([x, y + 1.02, z, x, y + 1.02, z + 1, x + 1, y + 1.02, z + 1, x + 1, y + 1.02, z],
        0, 0, 1, 1, 1, 1, 1, a);
    }
    for (const [x, y, z] of this.edgeCache.lava) {
      this.batchAdd.billboard(x + 0.5, y + 1.02, z + 0.5,
        [R[0] * 0.8, R[1] * 0.8, R[2] * 0.8], [U[0] * 0.8, U[1] * 0.8, U[2] * 0.8],
        1, 0, 0, 1, 1, 0.45, 0.08, 0.55);
    }
    // underwater glint sparkles
    if (s.vfxUnderwaterGlint && f.dim === 0 && Math.random() < 0.4) {
      try {
        const eyeWet = getBlock(g.world.getState(Math.floor(px), Math.floor(py), Math.floor(pz)));
        if (eyeWet && (eyeWet.isWater || f.rain > 0)) {
          this.batchAdd.billboard(px + (Math.random() * 2 - 1) * 8, py + (Math.random() * 2 - 1) * 4, pz + (Math.random() * 2 - 1) * 8,
            [R[0] * 0.25, R[1] * 0.25, R[2] * 0.25], [U[0] * 0.25, U[1] * 0.25, U[2] * 0.25],
            1, 0, 0, 1, 0.8, 0.95, 1, 0.5);
        }
      } catch (e) {}
    }
  }

  _drawClouds(d, px, pz, f) {
    const s = this.s;
    if (s.vfxCloudRendering === 'off' || f.dim !== 0 || !this.allow('Sky')) return;
    const tex = this.tex[s.vfxCloudFormation === 'legacy' ? 'cloudsLegacy' : 'cloudsModern'];
    if (!tex) return;
    const t = (this.game.world.timeOfDay || 0) / 20 + this.time * 0; // drift with world time
    const scroll = t * 0.03;
    const size = this.game.settings.renderDistance * 16 * 2;
    const h = size / 2;
    const cy = 128.33;
    const rep = 3;
    const u0 = (px + scroll) / 256, v0 = pz / 256;
    const cc = this.game.renderer.env.cloudColor || [1, 1, 1];
    const layers = [[cy, 0.75]];
    if (s.vfxMultiCloudLayers) layers.push([cy + 30, 0.5]);
    if (s.vfxDoubleClouds) layers.push([cy + 4, 0.4]);
    // Tessellated NxN per layer: vDepth is per-vertex and interpolated, so a
    // single giant quad would fog the whole layer by its far corners (fully
    // fogged even directly overhead). Cells keep depth error to ~cell size.
    const N = 8, cell = size / N, uvCell = rep / N;
    for (const [y, alpha] of layers) {
      const data = new Float32Array(N * N * 36);
      let o = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const x0 = -h + cell * i, x1 = x0 + cell, z0 = -h + cell * j, z1 = z0 + cell;
          const uu0 = u0 + uvCell * i, uu1 = uu0 + uvCell, vv0 = v0 + uvCell * j, vv1 = vv0 + uvCell;
          const vs = [[x0, z0, uu0, vv0], [x0, z1, uu0, vv1], [x1, z1, uu1, vv1], [x1, z0, uu1, vv0]];
          for (let k = 0; k < 4; k++) {
            data[o] = px + vs[k][0]; data[o + 1] = y; data[o + 2] = pz + vs[k][1];
            data[o + 3] = vs[k][2]; data[o + 4] = vs[k][3];
            data[o + 5] = cc[0]; data[o + 6] = cc[1]; data[o + 7] = cc[2]; data[o + 8] = alpha;
            o += 9;
          }
        }
      }
      this.game.device.updateMesh(this.cloudMesh, data, { quads: true });
      colorParams(1, 1, 1, 1, 0.004, 1, this._params);
      d.draw({ mesh: this.cloudMesh, pipeline: 'color', textures: [tex], params: this._params, state: STATE_ALPHA, count: N * N * 6 });
    }
  }

  _drawEnchant(d, px, py, pz, R, U) {
    const s = this.s;
    const inten = (Number(s.vfxEnchantmentOutlineIntensity) || 60) / 100;
    const th = (Number(s.vfxEnchantmentOutlineThickness) || 50) / 100;
    const hueShift = (Number(s.vfxEnchantmentOutlineHueShift) || 0) / 360;
    const sat = (Number(s.vfxEnchantmentOutlineSaturation) ?? 100) / 100;
    let col = [0.65, 0.25, 1.0];
    if (s.vfxDynamicItemOutlines) {
      try {
        const held = this.game.inventory.held && this.game.inventory.held();
        if (held) {
          const n = String(this.game.items.name(held.id) || '');
          if (/diamond/.test(n)) col = [0.35, 0.9, 0.95];
          else if (/gold/.test(n)) col = [1.0, 0.8, 0.2];
          else if (/iron/.test(n)) col = [0.85, 0.85, 0.9];
          else if (/netherite/.test(n)) col = [0.4, 0.35, 0.4];
          else if (/emerald/.test(n)) col = [0.2, 0.9, 0.4];
        }
      } catch (e) {}
    }
    const hsv = rgb2hsv(col);
    hsv[0] = (hsv[0] + hueShift + 1) % 1;
    hsv[1] = clamp(hsv[1] * sat, 0, 1.5);
    col = hsv2rgb(hsv);
    let n = 0;
    try {
      for (const [, e] of this.game.entities) {
        if (n > 6) break;
        if (!e || (e.kind !== 'item' && e.kind !== 'drops')) continue;
        const stack = e.item || e.stack;
        let ench = e.enchanted;
        try { ench = ench || (stack && this.game.items.isEnchanted && this.game.items.isEnchanted(stack)); } catch (err) {}
        if (!ench) continue;
        const p = this.game.entities.interp ? this.game.entities.interp(e, 1) : e;
        const dx = p.x - px, dy = p.y - py, dz = p.z - pz;
        if (dx * dx + dy * dy + dz * dz > 30 * 30) continue;
        const sz = 0.45 + th * 0.4;
        this.batchAdd.billboard(p.x, p.y + 0.3, p.z,
          [R[0] * sz, R[1] * sz, R[2] * sz], [U[0] * sz, U[1] * sz, U[2] * sz],
          1, 0, 0, 1, col[0], col[1], col[2], 0.55 * inten);
        n++;
      }
    } catch (e) {}
    if (n) {
      this.batchAdd.end();
      if (this.tex.glow) {
        colorParams(1, 1, 1, 1, 0, 0, this._params);
        // draw only the newly added quads: re-draw whole batch is fine (cap small here)
        this.batchAdd.draw(d, this.tex.glow, this._params, STATE_ADD);
        // reset so world pass doesn't double-draw
        this.batchAdd.begin(); this.batchAdd.end();
      }
    }
  }

  _drawLateFx(d) {
    if (!this.ready || !this.frame) return;
    const s = this.s, f = this.frame, g = this.game;
    if (!this.enabled() || !vfxAllowed(s) || this._foreignPack() || f.dimOff) return;
    const [px, py, pz] = this._playerPos();
    const cr = g.renderer.camRot;
    const R = [cr[0], cr[1], cr[2]], U = [cr[4], cr[5], cr[6]];
    this.batchAdd.begin();
    this.batchAlpha.begin();

    // -- light shafts (VfxWaterShafts / light rays) --
    const rayCol = this.data ? lightRayColor(this.data, f.biome.name) : [1, 0.9, 0.65];
    if (s.vfxLightRays && f.dim === 0 && f.sun > 0.3 && f.rain < 0.4 && f.skyLightAtPlayer > 8 && this.allow('Sky')) {
      const inten = (Number(s.vfxLightRayIntensity) || 60) / 100;
      const look0 = g.lookVector ? g.lookVector() : [0, 0, 1];
      let lx0 = look0[0], lz0 = look0[2];
      const ll0 = Math.hypot(lx0, lz0) || 1;
      lx0 /= ll0; lz0 /= ll0;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + this.time * 0.05;
        const rr = 14 + (i % 3) * 9;
        const x = px + Math.cos(a) * rr, z = pz + Math.sin(a) * rr;
        if ((x - px) * lx0 + (z - pz) * lz0 < 2) continue;
        const h = 26, w = 1.6 + (i % 3);
        const sway = Math.sin(this.time * 0.4 + i * 2) * 3;
        const qx = -lz0 * w + sway * 0.2, qz = lx0 * w;
        this.batchAdd.push([x - qx, py - 6, z - qz, x - qx, py - 6 + h, z - qz, x + qx, py - 6 + h, z + qz, x + qx, py - 6, z + qz],
          0, 0, 1, 1, rayCol[0], rayCol[1], rayCol[2], 0.10 * inten * f.sun);
      }
    }
    // -- underwater shafts --
    if (s.vfxUnderwaterLightRays && f.dim === 0 && f.sun > 0.2 && this.allow('Sky')) {
      try {
        const eye = getBlock(g.world.getState(Math.floor(px), Math.floor(py + 1), Math.floor(pz)));
        if (eye && eye.isWater) {
          const inten = (Number(s.vfxUnderwaterLightRayIntensity) || 60) / 100;
          for (let i = 0; i < 9; i++) {
            const x = px + (Math.random() * 2 - 1) * 18, z = pz + (Math.random() * 2 - 1) * 18;
            const h = 20, w = 1 + Math.random();
            this.batchAdd.push([x - w, py - 10, z, x - w, py - 10 + h, z, x + w, py - 10 + h, z, x + w, py - 10, z],
              0, 0, 1, 1, 0.55, 0.8, 0.9, 0.13 * inten * f.sun);
          }
        }
      } catch (e) {}
    }
    // -- low fog banks + ground/weather mist --
    if ((s.vfxLowFog || s.vfxGroundMist || s.vfxWeatherMist) && f.dim === 0 && this.allow('Weather')) {
      const misty = s.vfxWeatherMist && f.rain > 0.3;
      const n = (s.vfxLowFog ? 5 : 0) + (s.vfxGroundMist && f.night > 0.3 ? 4 : 0) + (misty ? 5 : 0);
      for (let i = 0; i < n && i < 10; i++) {
        const x = px + (Math.random() * 2 - 1) * 20, z = pz + (Math.random() * 2 - 1) * 20;
        // keep mist out of the camera's face (near quads accumulate opaque)
        const mdx = x - px, mdz = z - pz;
        if (mdx * mdx + mdz * mdz < 16) continue;
        let gy = Math.floor(py) - 1;
        try {
          for (let y = Math.floor(py) + 1; y > Math.floor(py) - 6; y--) {
            const st = g.world.getState(Math.floor(x), y, Math.floor(z));
            const blk = getBlock(st);
            if (!blk || blk.id === 0 || blk.isLiquid) continue;
            gy = y + 1; break;
          }
        } catch (e) { continue; }
        const w = 6 + Math.random() * 6;
        const drift = this.time * 0.35 % 12;
        const a = (s.vfxLowFog ? 0.10 : 0.06) + (misty ? 0.06 : 0);
        this.batchAlpha.billboard(x + drift - 6, gy + 0.7, z,
          [R[0] * w, R[1] * w, R[2] * w], [U[0] * w * 0.28, U[1] * w * 0.28, U[2] * w * 0.28],
          1, 0, 0, 1, 0.82, 0.87, 0.92, a);
      }
    }
    // -- End aura --
    if (f.dim === 1 && s.vfxEndAura && this.allow('Sky')) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + this.time * 0.1;
        const x = px + Math.cos(a) * 26, z = pz + Math.sin(a) * 26;
        this.batchAdd.billboard(x, py + 6 + Math.sin(this.time + i) * 4, z,
          [R[0] * 3, R[1] * 3, R[2] * 3], [U[0] * 3, U[1] * 3, U[2] * 3],
          1, 0, 0, 1, 0.6, 0.3, 1.0, 0.25);
      }
    }
    // -- horizon glow at sunrise/sunset (realistic sun side warmth) --
    if (f.dim === 0 && s.vfxSkyMode === 'realistic' && f.sun > 0.05 && f.sun < 0.6 && this.allow('Sky')) {
      const k = Math.max(0, 0.6 - f.sun) * 0.35;
      const w = 320;
      this.batchAdd.push([px - w, py - 40, pz - 300, px - w, py + 60, pz - 300, px + w, py + 60, pz - 300, px + w, py - 40, pz - 300],
        0, 0, 1, 1, 1.0, 0.55, 0.3, k * (1 - f.rain));
    }

    this.batchAdd.end();
    this.batchAlpha.end();
    if (this.batchAdd.n && this.tex.soft) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAdd.draw(d, this.tex.soft, this._params, STATE_ADD);
    }
    if (this.batchAlpha.n && this.tex.lowfog) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAlpha.draw(d, this.tex.lowfog, this._params, STATE_ALPHA);
    } else if (this.batchAlpha.n && this.tex.soft) {
      colorParams(1, 1, 1, 1, 0, 0, this._params);
      this.batchAlpha.draw(d, this.tex.soft, this._params, STATE_ALPHA);
    }
  }
}

let singleton = null;

// Attach to a live game (called from boot after world systems exist).
export function attachVfx(game) {
  if (singleton) return singleton;
  singleton = new VfxClient(game);
  singleton.init().catch((e) => console.warn('[ivfx] init failed', e));
  return singleton;
}
