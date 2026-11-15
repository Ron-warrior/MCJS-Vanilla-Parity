// The built-in shader: a native fullscreen look shipped with the game, not an
// OptiFine/Iris pack. Because it lives in the engine it gets what packs can't:
// real game state every frame (time of day, rain, sun position, water/lava
// eyes, hurt flash, dimension), native options in the menus, and the same look
// on all three graphics backends (post-pipeline programs 17/18/19 in gfx/*, so
// WebGL 2, WebGPU and the CPU rasteriser all run it — packs need WebGL 2 only).
//
// Chain: scene -> bright-pass (17, half res) -> blur H (4) -> blur V (4) ->
// grade (18, bloom + adaptive exposure + ACES + water/lava/hurt, fullscreen
// into finalA) -> finish (19, FXAA + lens distortion/CA + light shafts + lens
// flares + vignette + film grain, finalA -> screen). External packs and entity
// post shaders take precedence; when one is active this stands down (and
// ImmersiveVFX keeps running — the built-in grade composes with it).
//
// EaglercraftX parity ("High Performance PBR" built-in pack v1.4.2, u53 source):
// FXAA (exact u53 algorithm, luma passed through the grade alpha channel),
// adaptive exposure + ACES, lens distortion, lens flares, light shafts
// and waving blocks are implemented here.
// MakeUp UltraFast look (javiergcim/MakeUpUltraFast, LGPL-3.0 — formulas
// reimplemented for this engine, not copied): custom_sigmoid tonemap,
// vibrance, sunset warmth + night blue + rain cool + nether/end dimension
// grade, moon glow, underwater wobble + shimmer, stronger warm bloom. Those
// additions are WebGL2-only; WebGPU/CPU keep the earlier Eagler-style grade
// (they ignore the new param slots).
// Sun shadows / SSAO / SSR / PBR env reflections / realistic water need
// depth + G-buffer + geometry passes, which this forward renderer does not
// have — those stay on the roadmap.
import { FORMAT } from '../gfx/device.js';
import { isPointInFluid } from '../world/fluids.js';
import { celestialAngle, sunBrightness } from './sky.js';
import { getBlock, getStateProperties } from '../world/blocks.js';
import { animationLookup } from './glsl-functions.js';

// PostChain's single full-screen quad: clip space, uv (0,0) at the top left.
// Clip-space fullscreen quad, FORMAT.color layout (x,y,z, u,v, r,g,b,a) per
// vertex — the same four vertices as PostChain's quad in render/post.js.
const QUAD = new Float32Array([
  -1, 1, 0, 0, 0, 1, 1, 1, 1,
  -1, -1, 0, 0, 1, 1, 1, 1, 1,
  1, -1, 0, 1, 1, 1, 1, 1, 1,
  1, 1, 0, 1, 0, 1, 1, 1, 1,
]);
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const STATE = { blend: 'none', depthTest: false, depthWrite: false };

function brightParams() {
  const p = new Float32Array(16);
  p[0] = 17; p[1] = 0.65; p[2] = 0.3; p[4] = 1.0;
  return p;
}

function blurParams(horizontal) {
  const p = new Float32Array(16);
  p[0] = 4; p[4] = horizontal ? 1 : 0; p[5] = horizontal ? 0 : 1; p[6] = 7;
  return p;
}

// Built-in waving-blocks vertex hook (WebGL2 only — createTerrainAnimation is
// a WebGL2 device hook; packs are WebGL2-only too). Categories mirror
// EaglercraftX's waving_blocks.glsl: 1 = leaves sway, 2 = plants/crops ripple
// (bottom-anchored via the tip flag), 3 = water bob.
const WAVE_SOURCE = `
uniform vec4 uWaveFrame;
uniform vec3 cameraPosition;
uniform vec3 relativeEyePosition;
vec3 WavingBlocks(vec3 rel, int category, float tip) {
  float t = uWaveFrame.x;
  vec3 wp = rel + cameraPosition;
  float s1 = sin(t * 1.4 + wp.x * 0.5 + wp.z * 0.3) + 0.5 * sin(t * 2.7 + wp.z * 0.9 + wp.y * 0.4);
  if (category == 1) return rel + vec3(s1 * 0.05, s1 * 0.015, s1 * 0.045);
  if (category == 3) return rel + vec3(0.0, sin(t * 1.1 + wp.x * 0.4 + wp.z * 0.5) * 0.03, 0.0);
  float s2 = sin(t * 2.0 + wp.x * 0.9 + wp.z * 0.7) + 0.5 * sin(t * 3.1 + wp.z * 1.3);
  return rel + vec3(s2 * 0.08 * tip, 0.0, s2 * 0.05 * tip);
}
`;

function waveCategory(name) {
  if (!name) return 0;
  if (name === 'water') return 3;
  if (name.indexOf('leaves') >= 0) return 1;
  if (/grass|fern|flower|tulip|daisy|poppy|orchid|allium|bluet|dandelion|wheat|carrot|potato|beetroot|sugar_cane|vine|lily_pad|seagrass|kelp|sweet_berry|bamboo|sprouts|fungus|roots|sapling|dead_bush|sunflower|lilac|rose_bush|peony|fire/.test(name)) return 2;
  return 0;
}

export class BuiltinFinal {
  constructor(game) {
    this.game = game;
    this.targets = new Map();
    this.main = null;
    this.quad = null;
    this.blank = null;
    this.W = 0; this.H = 0;
    this._bright = brightParams();
    this._blurH = blurParams(true);
    this._blurV = blurParams(false);
    this._expo = 1.0; // smoothed adaptive-exposure factor
    this._bias = 1.1;
    this._waterNow = false; // eyes-in-water latch for the finish wobble
    this._lastT = 0;
    this._wave = null; // device terrain animation (WebGL2 only)
    this._waveDevice = null;
    this._waveActive = false;
    console.log('[builtin] ready (MinecraftJS native shader: bloom + grade + finish)');
  }

  // Selected in the Shaders list as "Built-in" (id "(internal)"), stood down
  // while an external pack or an entity post shader owns the frame.
  get active() {
    const lib = this.game.shaderLibrary;
    const on = lib ? (lib.selected === '(internal)' && lib.enabled !== false) : true;
    return on && !(this.game.shaderPack && this.game.shaderPack.active) && !!this.game.device.createRenderTarget;
  }

  // World goes into the chain's target; the GUI is drawn over the screen after render().
  begin(clearColor) {
    this._resize();
    this.game.device.setRenderTarget(this.main, [clearColor[0], clearColor[1], clearColor[2], 1]);
  }

  render(restoreLightmap) {
    const d = this.game.device, g = this.game, s = g.settings || {};
    this._resize();
    const now = performance.now() / 1000;
    this._updateExposure(now);
    d.setGlobals({ view: IDENT, proj: IDENT, fogMode: 2 });
    const A = this.targets.get('bloomA'), B = this.targets.get('bloomB'), F = this.targets.get('finalA');
    const bloom = Math.max(0, Math.min(100, Number(s.builtinBloom ?? 35))) / 100;
    if (bloom > 0.001) {
      d.setRenderTarget(A, [0, 0, 0, 1]);
      d.setGlobals({ lightmap: A });
      d.draw({ mesh: this.quad, pipeline: 'post', textures: [this.main], params: this._bright, state: STATE });
      d.setRenderTarget(B, [0, 0, 0, 1]);
      d.setGlobals({ lightmap: B });
      d.draw({ mesh: this.quad, pipeline: 'post', textures: [A], params: this._blurH, state: STATE });
      d.setRenderTarget(A, [0, 0, 0, 1]);
      d.setGlobals({ lightmap: A });
      d.draw({ mesh: this.quad, pipeline: 'post', textures: [B], params: this._blurV, state: STATE });
    }
    // Grade the scene (bloom + adaptive exposure + ACES + fluid/hurt) into finalA.
    d.setRenderTarget(F, [0, 0, 0, 1]);
    d.setGlobals({ lightmap: bloom > 0.001 ? A : this.blank });
    d.draw({ mesh: this.quad, pipeline: 'post', textures: [this.main], params: this._gradeParams(bloom, now), state: STATE });
    // Finish pass: FXAA + lens + shafts + flares + vignette + grain to the screen.
    d.setRenderTarget(null);
    d.setGlobals({ lightmap: this.blank });
    d.draw({ mesh: this.quad, pipeline: 'post', textures: [F], params: this._finishParams(now), state: STATE });
    if (restoreLightmap) d.setGlobals({ lightmap: restoreLightmap });
  }

  _updateExposure(now) {
    const g = this.game, s = g.settings || {};
    const bias = Math.max(0.2, Math.min(3, Number(s.builtinExposure ?? 110) / 100));
    this._bias = bias;
    let target = 1.0;
    if (s.builtinAutoExposure !== false && g.world && g.inWorld) {
      try {
        const t = g.world.timeOfDay || 0, rain = g.world.rainStrength || 0, th = g.world.thunderStrength || 0;
        const day = sunBrightness(celestialAngle(t, g.partial || 0), rain, th); // 0.2..1
        let sky = 15;
        const p = g.player;
        if (p && g.world.getSkyLight) {
          const v = g.world.getSkyLight(Math.floor(p.x), Math.floor((p.y || 0) + 1.6), Math.floor(p.z));
          if (typeof v === 'number') sky = v;
        }
        const dim = g.dimension === -1 ? 0.55 : g.dimension === 1 ? 0.45 : 1.0;
        const avg = dim * (0.12 + 0.88 * day) * (0.25 + 0.75 * Math.max(0, Math.min(15, sky)) / 15);
        target = Math.max(0.65, Math.min(1.5, 1.0 / Math.max(0.05, avg)));
      } catch (e) { target = 1.0; }
    }
    const dt = this._lastT > 0 ? Math.min(0.5, Math.max(0.001, now - this._lastT)) : 1;
    this._lastT = now;
    const k = Math.min(1, dt * 1.5); // ~2s adaptation, Eagler-style smoothing
    this._expo += (target - this._expo) * k;
  }

  _gradeParams(bloom, now) {
    const g = this.game, s = g.settings || {};
    const p = new Float32Array(16);
    let water = false, lava = false;
    try {
      const pl = g.player;
      water = !!(pl && pl.eyesInWater);
      if (pl && g.world) {
        const eye = g.eyePosition ? g.eyePosition(g.partial || 0) : [pl.x || 0, (pl.y || 0) + 1.62, pl.z || 0];
        lava = !!isPointInFluid(g.world, eye[0], eye[1], eye[2], true);
      }
    } catch (e) { /* title screen or teardown: no fluid tint */ }
    const hurt = Math.max(0, Math.min(1, (g.hurtTime || 0) / 10));
    const tonemap = s.builtinTonemap !== false;
    const lf = this._lightFactors();
    this._waterNow = s.builtinUnderwater !== false && water;
    p[0] = 18;
    p[1] = now % 3600;
    p[2] = bloom * 0.9;
    p[3] = this._bias * this._expo;
    p[4] = Math.max(0, Math.min(2, Number(s.builtinVibrance ?? 122) / 100)); // vibrance
    p[5] = 1.04; // contrast
    p[6] = lf.rain; // rain cool/desat (uP[1].z)
    // p[7] spare.
    p[8] = s.builtinWater === false ? 0 : (water ? 1 : 0);
    p[9] = s.builtinWater === false ? 0 : (lava ? 1 : 0);
    p[10] = hurt;
    p[11] = tonemap ? 1 : 0;
    p[12] = lf.nether; p[13] = lf.end; p[14] = lf.day; p[15] = lf.sunset;
    return p;
  }

  // MakeUp-style world light, all 0..1. Zeroed when the world grade is off or
  // there is no world (title screen stays neutral).
  _lightFactors() {
    const g = this.game, s = g.settings || {};
    const out = { rain: 0, nether: 0, end: 0, day: 1, sunset: 0 };
    try {
      if (!g.world || !g.inWorld) return out;
      if (s.builtinWorldGrade === false) return out;
      const dim = g.dimension || 0;
      const rain = Math.max(0, Math.min(1, g.world.rainStrength || 0));
      const thun = Math.max(0, Math.min(1, g.world.thunderStrength || 0));
      out.rain = Math.max(0, Math.min(1, rain + thun * 1.2));
      out.nether = dim === -1 ? 1 : 0;
      out.end = dim === 1 ? 1 : 0;
      if (dim !== 0) { out.day = dim === -1 ? 0.15 : 0.5; return out; }
      const th = celestialAngle(g.world.timeOfDay || 0, g.partial || 0) * Math.PI * 2;
      const el = Math.cos(th); // sun elevation: matches the sky sun quad
      out.day = Math.max(0, Math.min(1, (el + 0.06) / 0.28));
      out.sunset = Math.max(0, Math.min(1, 1 - Math.abs(el) * 2.8)) * (1 - out.rain * 0.7);
    } catch (e) { /* safe defaults */ }
    return out;
  }

  // Sun position in finish-pass UV space + visibility, for flares and shafts.
  _sun() {
    const g = this.game, r = g.renderer;
    let angle = 0.3, cam = null, view = null, proj = null, dim = 0, rain = 0;
    try {
      if (g.world) { angle = celestialAngle(g.world.timeOfDay || 0, g.partial || 0); rain = g.world.rainStrength || 0; }
      dim = g.dimension || 0;
      if (r) { cam = r.camPos; view = r.view; proj = r.proj; }
      if (!cam && g.player) cam = [g.player.x, (g.player.y || 0) + 1.62, g.player.z];
    } catch (e) { /* fall through with safe defaults */ }
    const th = angle * Math.PI * 2;
    const dir = [-Math.sin(th), Math.cos(th), 0]; // matches the sky sun quad (rotateZ(angle*2π) of +Y)
    let u = 0.5, v = 0.5;
    let vis = dim === 0 ? Math.max(0, Math.min(1, dir[1] * 2.5 + 0.15)) * (1 - Math.min(1, rain) * 0.8) : 0;
    if (cam && view && proj && view.length >= 16 && proj.length >= 16) {
      const wx = cam[0] + dir[0] * 500, wy = cam[1] + dir[1] * 500, wz = cam[2] + dir[2] * 500;
      const t0 = view[0] * wx + view[4] * wy + view[8] * wz + view[12];
      const t1 = view[1] * wx + view[5] * wy + view[9] * wz + view[13];
      const t2 = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
      const t3 = view[3] * wx + view[7] * wy + view[11] * wz + view[15];
      const c0 = proj[0] * t0 + proj[4] * t1 + proj[8] * t2 + proj[12] * t3;
      const c1 = proj[1] * t0 + proj[5] * t1 + proj[9] * t2 + proj[13] * t3;
      const c3 = proj[3] * t0 + proj[7] * t1 + proj[11] * t2 + proj[15] * t3;
      if (c3 > 0.0001) { u = c0 / c3 * 0.5 + 0.5; v = c1 / c3 * 0.5 + 0.5; }
      else vis = 0; // sun behind the camera: no flares or shafts
    } else vis = 0;
    if (!g.inWorld) vis = 0;
    return { u, v, vis };
  }

  _finishParams(now) {
    const s = this.game.settings || {};
    const sun = this._sun();
    const moon = this._moon();
    const p = new Float32Array(16);
    p[0] = 19;
    p[1] = now % 3600;
    p[2] = sun.u; p[3] = sun.v;
    p[4] = sun.vis;
    p[5] = s.builtinFxaa === false ? 0 : 1;
    p[6] = s.builtinLens === true ? 1 : 0;
    p[7] = s.builtinFlares === false ? 0 : 1;
    p[8] = s.builtinShafts === true ? 1 : 0;
    p[9] = s.builtinVignette === false ? 0 : 0.32;
    p[10] = s.builtinGrain === false ? 0 : 1.0;
    // p[11] spare.
    p[12] = moon.u; p[13] = moon.v; p[14] = moon.vis;
    p[15] = this._waterNow === true ? 1 : 0; // underwater wobble + shimmer
    return p;
  }

  // Moon projection for the night glow: opposite the sun. Visible at night in
  // the overworld only, dimmed by rain like the sun flares.
  _moon() {
    const g = this.game, s = g.settings || {};
    let u = 0.5, v = 0.5, vis = 0;
    try {
      if (s.builtinMoon === false || !g.inWorld || (g.dimension || 0) !== 0) return { u, v, vis };
      const r = g.renderer;
      let angle = 0.3, cam = null, view = null, proj = null, rain = 0, day = 1;
      if (g.world) {
        angle = celestialAngle(g.world.timeOfDay || 0, g.partial || 0);
        rain = g.world.rainStrength || 0;
        const th0 = angle * Math.PI * 2;
        day = Math.max(0, Math.min(1, (Math.cos(th0) + 0.06) / 0.28));
      }
      if (r) { cam = r.camPos; view = r.view; proj = r.proj; }
      if (!cam && g.player) cam = [g.player.x, (g.player.y || 0) + 1.62, g.player.z];
      const night = 1 - day;
      vis = Math.max(0, Math.min(1, night * 1.4 - 0.15)) * (1 - Math.min(1, rain) * 0.85);
      if (!cam || !view || !proj || view.length < 16 || proj.length < 16) return { u, v, vis };
      const th = angle * Math.PI * 2;
      const dir = [Math.sin(th), -Math.cos(th), 0]; // opposite the sun quad
      const wx = cam[0] + dir[0] * 500, wy = cam[1] + dir[1] * 500, wz = cam[2] + dir[2] * 500;
      const t0 = view[0] * wx + view[4] * wy + view[8] * wz + view[12];
      const t1 = view[1] * wx + view[5] * wy + view[9] * wz + view[13];
      const t2 = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
      const t3 = view[3] * wx + view[7] * wy + view[11] * wz + view[15];
      const c0 = proj[0] * t0 + proj[4] * t1 + proj[8] * t2 + proj[12] * t3;
      const c1 = proj[1] * t0 + proj[5] * t1 + proj[9] * t2 + proj[13] * t3;
      const c3 = proj[3] * t0 + proj[7] * t1 + proj[11] * t2 + proj[15] * t3;
      if (c3 > 0.0001) { u = c0 / c3 * 0.5 + 0.5; v = c1 / c3 * 0.5 + 0.5; }
      else vis = 0; // moon behind the camera
    } catch (e) { vis = 0; }
    return { u, v, vis };
  }

  // Waving blocks (EaglercraftX WAVING_BLOCKS). Only when the built-in shader
  // owns the frame and no pack wave is active; WebGL2 only.
  prepareTerrain(camera, eye) {
    const g = this.game, d = g.device, s = g.settings || {};
    const want = this.active && s.builtinWave !== false && !!d.createTerrainAnimation &&
      !(g.shaderPack && g.shaderPack.active);
    if (!want) {
      if (this._waveActive) { try { d.setTerrainAnimation?.(null); } catch (e) {} this._waveActive = false; }
      return;
    }
    try {
      if (!this._wave || this._waveDevice !== d) {
        if (this._waveFailed || !this.game.assets?.data?.blocks) return;
        if (this._wave) { try { this._wave.destroy(); } catch (e) {} }
        const lookup = this._waveLookup();
        if (!lookup) { this._waveFailed = true; return; }
        this._wave = d.createTerrainAnimation(WAVE_SOURCE, lookup, '');
        this._waveDevice = d;
      }
      const now = performance.now() / 1000;
      d.setTerrainAnimation(this._wave, { time: now % 3600, worldTime: g.world ? g.world.timeOfDay : 0, camera, eye, lighting: null });
      this._waveActive = true;
    } catch (e) {
      if (this._wave) { try { this._wave.destroy(); } catch (e2) {} }
      this._wave = null; this._waveDevice = null; this._waveActive = false;
    }
  }

  _waveLookup() {
    try {
      const defs = this.game.assets?.data?.blocks;
      if (!defs || !defs.length) return null;
      const flat = defs.some((b) => b.minStateId !== undefined);
      const count = flat ? Math.max(...defs.map((b) => b.maxStateId)) + 1 : (Math.max(...defs.map((b) => b.id)) + 1) * 16;
      const states = Array.from({ length: count }, (_, id) => {
        let name = '';
        try { name = getBlock(id)?.name || ''; } catch (e) {}
        let properties = {};
        try { properties = getStateProperties(id) || {}; } catch (e) {}
        return { id, name, properties };
      });
      const rules = [];
      for (const st of states) {
        const c = waveCategory(st.name);
        if (c) rules.push({ id: c, name: st.name, properties: {} });
      }
      if (!rules.length) return null;
      return animationLookup(rules, states);
    } catch (e) { return null; }
  }

  _resize() {
    const d = this.game.device, W = d.width, H = d.height;
    if (W === this.W && H === this.H && this.main) return;
    this.W = W; this.H = H;
    for (const t of this.targets.values()) d.destroyTexture(t);
    this.targets.clear();
    if (this.main) d.destroyTexture(this.main);
    if (!this.quad) this.quad = d.createMesh(FORMAT.color, QUAD.slice(), { quads: true });
    if (!this.blank) this.blank = d.createTexture({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) });
    this.main = d.createRenderTarget(W, H);
    this.targets.set('bloomA', d.createRenderTarget(Math.max(1, W >> 1), Math.max(1, H >> 1)));
    this.targets.set('bloomB', d.createRenderTarget(Math.max(1, W >> 1), Math.max(1, H >> 1)));
    this.targets.set('finalA', d.createRenderTarget(W, H));
  }

  destroy() {
    const d = this.game.device;
    if (this._wave) { try { if (this._waveDevice === d) this._wave.destroy(); } catch (e) {} }
    this._wave = null; this._waveDevice = null; this._waveActive = false; this._waveFailed = false;
    for (const t of this.targets.values()) d.destroyTexture(t);
    this.targets.clear();
    if (this.main) d.destroyTexture(this.main);
    this.main = null;
    if (this.quad) d.destroyMesh(this.quad);
    this.quad = null;
    if (this.blank) d.destroyTexture(this.blank);
    this.blank = null;
    this.W = 0; this.H = 0;
  }
}
