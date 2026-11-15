// ImmersiveVFX port — in-game options screen.
//
// Mirrors the mod's MenuCatalog pages (General / Sky and Clouds / Fog and
// Mist / Lighting / Water / Vegetation / Particles / Weather and Events /
// Outlines / Shadows / Dimensions / Color Grading) + preset row + grading
// sliders per time-of-day. Opened from Video Settings ("ImmersiveVFX...").

import { Screen } from './manager.js';
import { Button, Slider } from '../widgets.js';
import { ListOf } from '../slot-list.js';
import { applyPreset, applyGradingPreset, presetValues, VFX_ALLOW_CATS, VFX_ALLOW_DIMS } from '../../render/ivfx-settings.js';

const PRESET_LABEL = {
  immersive: 'Immersive', immersive_toon: 'Immersive Toon', insane: 'Insane',
  'insane_toon': 'Insane (Toon)', enhanced: 'Enhanced', enhanced_toon: 'Enhanced Toon',
  vanilla_plus: 'Vanilla Plus', vanilla_plus_toon: 'Vanilla Plus Toon', custom: 'Custom',
};
const PRESET_ORDER = ['immersive', 'immersive_toon', 'insane', 'insane_toon', 'enhanced', 'enhanced_toon', 'vanilla_plus', 'vanilla_plus_toon'];

const onOff = (v) => v ? 'ON' : 'OFF';
const pct = (v) => Math.round(v) + '%';

function cyc(s, key, order) {
  const i = order.indexOf(s[key]);
  s[key] = order[(i + 1 + order.length) % order.length];
}

export class IvfxOptionsScreen extends Screen {
  constructor(game, parent) {
    super(game);
    this.parent = parent;
    this.background = game.inWorld ? 'world' : 'dirt';
  }
  get s() { return this.game.settings; }

  markCustom() {
    if (this.s.vfxPreset !== 'custom') { this.s.vfxPreset = 'custom'; }
  }
  changed() { this.markCustom(); this.s.save(); this.build(); }

  sec(label) { return { section: label }; }
  tog(key, label) {
    return { label: () => label + ': ' + onOff(this.s[key]), click: () => { this.s[key] = !this.s[key]; this.changed(); } };
  }
  choice(key, label, order, labels) {
    const L = labels || {};
    return {
      label: () => label + ': ' + (L[this.s[key]] || this.s[key]),
      click: () => { cyc(this.s, key, order); this.changed(); },
    };
  }
  slide(key, label, min = 0, max = 100) {
    return {
      slider: true,
      label: (v) => label + ': ' + pct(min + v * (max - min)),
      value: () => (clamp01(this.s[key], min, max) - min) / (max - min),
      set: (v) => { this.s[key] = Math.round(min + v * (max - min)); this.markCustom(); this.s.save(); },
    };
  }
  gradeSlide(param, label, min = 0, max = 200) {
    const t = () => this.s.vfxGrading[this.s.vfxGradingEditTime];
    return {
      slider: true,
      label: (v) => label + ': ' + (param === 'hueShift' || param.endsWith('Hue') ? Math.round(min + v * (max - min)) + '°' : pct(min + v * (max - min))),
      value: () => (clamp01(t()[param], min, max) - min) / (max - min),
      set: (v) => { t()[param] = Math.round(min + v * (max - min)); this.markCustom(); this.s.save(); },
    };
  }

  options() {
    const s = this.s;
    const O = [];
    const presetIdx = () => PRESET_ORDER.indexOf(s.vfxPreset) >= 0 ? PRESET_ORDER.indexOf(s.vfxPreset) : -1;
    O.push({
      wide: true,
      label: () => 'Preset: ' + (PRESET_LABEL[s.vfxPreset] || 'Custom'),
      click: () => {
        const cur = PRESET_ORDER.indexOf(s.vfxPreset);
        const next = PRESET_ORDER[(cur + 1 + PRESET_ORDER.length) % PRESET_ORDER.length];
        applyPreset(s, next);
        this.build();
      },
    });
    O.push(this.sec('General'));
    const masterTog = this.tog('vfxEnabled', 'Enable ImmersiveVFX');
    masterTog.master = true; // never greyed: this is the way back on
    O.push(masterTog);
    O.push(this.choice('vfxParticleRate', 'Particle Rate', ['maximum', 'reduced', 'none'], { maximum: 'Maximum', reduced: 'Reduced', none: 'None' }));
    O.push(this.choice('vfxFogRenderingMode', 'Fog Rendering', ['immersive', 'immersive_extended', 'chunk_distance', 'off'], { immersive: 'Immersive', immersive_extended: 'Immersive Extended', chunk_distance: 'Chunk Distance', off: 'Off' }));
    O.push(this.choice('vfxSnowSandStyle', 'Snow/Sand Style', ['hd', 'vanilla'], { hd: 'HD', vanilla: 'Vanilla' }));
    O.push(this.tog('vfxSmoothBlockPlace', 'Smooth Block Place'));
    O.push(this.tog('vfxTorchLight', 'Torch Light'));
    O.push(this.tog('vfxModdedBiomes', 'Modded Biomes'));
    O.push(this.tog('vfxUseIrisShaders', 'Use Iris Shaders'));
    O.push(this.sec('Sky and Clouds'));
    O.push(this.choice('vfxSkyMode', 'Sky Mode', ['vanilla', 'realistic'], { vanilla: 'IVFX Vanilla', realistic: 'IVFX Realistic' }));
    O.push(this.tog('vfxCustomSkies', 'Custom Skies'));
    O.push(this.choice('vfxCloudRendering', 'Cloud Rendering', ['off', 'fancy', 'shaded', 'flat'], { off: 'Off', fancy: 'Fancy', shaded: 'Shaded', flat: 'Flat' }));
    O.push(this.choice('vfxCloudFormation', 'Cloud Formation', ['legacy', 'modern'], { legacy: 'Legacy', modern: 'Modern' }));
    O.push(this.tog('vfxMultiCloudLayers', 'Multi Cloud Layers'));
    O.push(this.tog('vfxDoubleClouds', 'Double Clouds'));
    O.push(this.tog('vfxLightRays', 'Light Rays'));
    O.push(this.slide('vfxLightRayIntensity', 'Light Ray Intensity'));
    O.push(this.tog('vfxUnderwaterLightRays', 'Underwater Light Rays'));
    O.push(this.slide('vfxUnderwaterLightRayIntensity', 'Underwater Ray Intensity'));
    O.push(this.tog('vfxAurora', 'Aurora Borealis'));
    O.push(this.tog('vfxMeteorShower', 'Meteor Shower'));
    O.push(this.tog('vfxShootingStars', 'Shooting Stars'));
    O.push(this.tog('vfxFireworks', 'Fireworks'));
    O.push(this.tog('vfxSandWind', 'Sand Wind'));
    O.push(this.tog('vfxSandStorm', 'Sand Storm'));
    O.push(this.tog('vfxAlwaysWinter', 'Always Winter'));
    O.push(this.sec('Fog and Mist'));
    O.push(this.tog('vfxAtmosphericFog', 'Atmospheric Fog'));
    O.push(this.slide('vfxAtmosphericFogStrength', 'Fog Strength'));
    O.push(this.tog('vfxDynamicFog', 'Dynamic Fog'));
    O.push(this.tog('vfxLowFog', 'Low-Lying Fog'));
    O.push(this.tog('vfxGroundMist', 'Ground Mist'));
    O.push(this.tog('vfxWeatherMist', 'Weather Mist'));
    O.push(this.sec('Lighting'));
    O.push(this.tog('vfxBloom', 'Bloom'));
    O.push(this.slide('vfxBloomIntensity', 'Bloom Intensity'));
    O.push(this.tog('vfxEnhancedLight', 'Enhanced Light'));
    O.push(this.tog('vfxColoredLight', 'Colored Light'));
    O.push(this.slide('vfxColoredLightIntensity', 'Colored Light Intensity'));
    O.push(this.slide('vfxColoredLightRadius', 'Colored Light Radius'));
    O.push(this.tog('vfxDungeonsFire', 'Enhanced Fire'));
    O.push(this.tog('vfxDynamicColorGrading', 'Dynamic Color Grading'));
    O.push(this.sec('Water'));
    O.push(this.tog('vfxWaterReflections', 'Water Reflections'));
    O.push(this.tog('vfxIceReflections', 'Ice Reflections'));
    O.push(this.choice('vfxReflectionQuality', 'Reflection Quality', ['low', 'normal', 'high'], { low: 'Low', normal: 'Normal', high: 'High' }));
    O.push(this.slide('vfxReflectionStrength', 'Reflection Strength'));
    O.push(this.tog('vfxWaterColorMapping', 'Water Color Mapping'));
    O.push(this.choice('vfxWaterColors', 'Water Colors', ['vanilla', 'realistic'], { vanilla: 'IVFX Vanilla', realistic: 'IVFX Realistic' }));
    O.push(this.tog('vfxShoreFoam', 'Shore Foam'));
    O.push(this.tog('vfxLavaFoam', 'Lava Foam'));
    O.push(this.tog('vfxWaterfallMist', 'Enhanced Water'));
    O.push(this.tog('vfxWaterLeaves', 'Water Leaves'));
    O.push(this.tog('vfxUnderwaterCaustics', 'Underwater Caustics'));
    O.push(this.tog('vfxUnderwaterGlint', 'Underwater Glint'));
    O.push(this.tog('vfxTerrainGlint', 'Terrain Glint'));
    O.push(this.slide('vfxGlintSmoothness', 'Glint Smoothness'));
    O.push(this.tog('vfxUnderwaterDepthBlur', 'Underwater Depth Blur'));
    O.push(this.tog('vfxUnderwaterShadows', 'Underwater Shadows'));
    O.push(this.sec('Vegetation'));
    O.push(this.tog('vfxMovingGrass', 'Moving Grass'));
    O.push(this.tog('vfxMovingPlants', 'Moving Plants'));
    O.push(this.tog('vfxMovingLeaves', 'Moving Leaves'));
    O.push(this.tog('vfxGpuGrass', 'GPU Grass'));
    O.push(this.slide('vfxGpuGrassDensity', 'Grass Density'));
    O.push(this.slide('vfxGpuGrassHeight', 'Grass Height', 20, 200));
    O.push(this.slide('vfxGpuGrassDistance', 'Grass Distance', 8, 96));
    O.push(this.tog('vfxNaturalFoliageColors', 'Natural Foliage Colors'));
    O.push(this.sec('Particles'));
    O.push(this.tog('vfxFireflies', 'Fireflies'));
    O.push(this.tog('vfxSpecks', 'Specks'));
    O.push(this.tog('vfxPollenAndSpores', 'Pollen and Spores'));
    O.push(this.tog('vfxLeaves', 'Leaves'));
    O.push(this.tog('vfxWindGusts', 'Wind Gusts'));
    O.push(this.sec('Weather and Events'));
    O.push(this.choice('vfxWeatherVisuals', 'Weather Visuals', ['vanilla', 'enhanced', 'custom'], { vanilla: 'Vanilla', enhanced: 'Vanilla Enhanced', custom: 'Custom' }));
    O.push(this.sec('Outlines'));
    O.push(this.tog('vfxBlockOutlines', 'Block Outlines'));
    O.push(this.slide('vfxBlockOutlineThickness', 'Block Outline Thickness'));
    O.push(this.tog('vfxMobOutlines', 'Mob Outlines'));
    O.push(this.slide('vfxMobOutlineThickness', 'Mob Outline Thickness'));
    O.push(this.tog('vfxEnchantmentOutlines', 'Enchantment Outlines'));
    O.push(this.tog('vfxDynamicItemOutlines', 'Dynamic Item Outlines'));
    O.push(this.slide('vfxEnchantmentOutlineIntensity', 'Enchant Intensity'));
    O.push(this.slide('vfxEnchantmentOutlineThickness', 'Enchant Thickness'));
    O.push(this.slide('vfxEnchantmentOutlineHueShift', 'Enchant Hue Shift', -180, 180));
    O.push(this.slide('vfxEnchantmentOutlineSaturation', 'Enchant Saturation', 0, 200));
    O.push(this.sec('Shadows'));
    O.push(this.tog('vfxShadows', 'Shadows'));
    O.push(this.choice('vfxShadowMode', 'Shadow Mode', ['normal', 'enhanced'], { normal: 'Normal', enhanced: 'Enhanced' }));
    O.push(this.choice('vfxShadowResolution', 'Shadow Resolution', ['low', 'medium', 'high'], { low: 'Low', medium: 'Medium', high: 'High' }));
    O.push(this.slide('vfxShadowDistance', 'Shadow Distance'));
    O.push(this.slide('vfxShadowStrength', 'Shadow Strength'));
    O.push(this.slide('vfxShadowBoost', 'Shadow Boost'));
    O.push(this.tog('vfxMobShadows', 'Mob Shadows'));
    O.push(this.tog('vfxDepthCalculation', 'Depth Calculation'));
    O.push(this.sec('The End'));
    O.push(this.tog('vfxEndColorGrading', 'End Color Grading'));
    O.push(this.tog('vfxEndAura', 'End Aura'));
    O.push(this.sec('Dimensions'));
    O.push(this.tog('vfxDimOverworld', 'Overworld VFX'));
    O.push(this.tog('vfxDimNether', 'Nether VFX'));
    O.push(this.tog('vfxDimEnd', 'End VFX'));
    for (const dim of VFX_ALLOW_DIMS) {
      O.push({
        label: () => dim + ' Allows...',
        click: () => this.game.screens.open(new IvfxDimensionScreen(this.game, this, dim)),
      });
    }
    O.push(this.sec('Color Grading'));
    O.push(this.choice('vfxGradingMode', 'Grading Mode', ['off', 'vanilla', 'enhanced'], { off: 'Off', vanilla: 'IVFX Vanilla', enhanced: 'IVFX Enhanced' }));
    O.push(this.choice('vfxGradingEditTime', 'Edit Time of Day', ['dawn', 'noon', 'dusk', 'night'], { dawn: 'Dawn', noon: 'Midday', dusk: 'Dusk', night: 'Night' }));
    O.push({
      label: () => 'Grading Preset: apply...',
      click: () => {
        const order = ['vanilla', 'medieval', 'vintage'];
        const cur = order.indexOf(this._gradePreset || 'vanilla');
        this._gradePreset = order[(cur + 1) % order.length];
        applyGradingPreset(this.s.vfxGrading, this._gradePreset);
        this.changed();
      },
    });
    O.push(this.gradeSlide('exposure', 'Exposure'));
    O.push(this.gradeSlide('contrast', 'Contrast'));
    O.push(this.gradeSlide('shadows', 'Shadows'));
    O.push(this.gradeSlide('midtones', 'Midtones'));
    O.push(this.gradeSlide('highlights', 'Highlights'));
    O.push(this.gradeSlide('saturation', 'Saturation'));
    O.push(this.gradeSlide('vibrance', 'Vibrance', 0, 100));
    O.push(this.gradeSlide('hueShift', 'Hue Shift', -180, 180));
    O.push(this.gradeSlide('temperature', 'Temperature', -100, 100));
    O.push(this.gradeSlide('tint', 'Tint', -100, 100));
    O.push(this.gradeSlide('redStrength', 'Red Strength'));
    O.push(this.gradeSlide('greenStrength', 'Green Strength'));
    O.push(this.gradeSlide('blueStrength', 'Blue Strength'));
    O.push(this.gradeSlide('redHue', 'Red Hue', -180, 180));
    O.push(this.gradeSlide('greenHue', 'Green Hue', -180, 180));
    O.push(this.gradeSlide('blueHue', 'Blue Hue', -180, 180));
    return O;
  }

  build() {
    const items = this.options();
    const on = this.s.vfxEnabled !== false;
    this.rows = [];
    let col = 0;
    items.forEach((it, i) => {
      if (it.section) {
        if (col === 1) { this.rows.push([null]); col = 0; }
        this.rows.push([{ section: it.section }]);
        return;
      }
      const w = it.wide ? 310 : 150;
      const b = it.slider
        ? new Slider(i, this.width / 2 - 155 + col * 160, 0, w, 20, it.label, it.value(), it.set)
        : new Button(i, this.width / 2 - 155 + col * 160, 0, w, 20, it.label, it.click);
      if (!it.master && !on) b.enabled = false; // master OFF: everything else greyed
      if (it.wide && col === 1) { this.rows.push([null]); col = 0; }
      b.optionKey = null;
      if (col === 0) this.rows.push([b]); else this.rows[this.rows.length - 1].push(b);
      col = (it.wide || it.slider) ? 0 : 1 - col;
    });
    this.buttons = [new Button(200, this.width / 2 - 100, this.height - 27, 200, 20, 'Done', () => this.done())];
    const old = this.list;
    this.list = new ListOf(this, 32, this.height - 32, 25, {
      size: () => this.rows.length,
      draw: (gui, i, x, y, h, mx, my, rmx, rmy) => {
        const row = this.rows[i];
        if (row[0] && row[0].section) { gui.textCentered('-- ' + row[0].section + ' --', this.width / 2, y + 8, 0xffffa0); return; }
        for (const b of row) { if (!b) continue; b.y = y; b.render(gui, b.dragging ? rmx : mx, b.dragging ? rmy : my); }
      },
      click: (i, dbl, mx, my) => (this.rows[i] || []).some((b) => b && b.mouseDown && b.mouseDown(mx, my, this.game)),
    }, { listWidth: 400, scrollBarOffset: 32, selectionBox: false });
    if (old) { this.list.amountScrolled = old.amountScrolled; this.list.clamp(); }
  }

  init() { this.build(); }
  done() { this.s.save(); this.game.screens.open(this.parent); }
  close() { this.done(); }

  render(gui, mx, my) {
    this.list.render(gui, mx, my);
    gui.textCentered('ImmersiveVFX', this.width / 2, 5, 0xffffff);
    for (const b of this.buttons) b.render(gui, mx, my);
  }
  mouseDown(mx, my, button, e) { return super.mouseDown(mx, my, button) || this.list.mouseDown(mx, my, button); }
  mouseUp(mx, my, button) {
    super.mouseUp(mx, my, button);
    for (const r of this.rows) for (const b of r) if (b && b.mouseUp) b.mouseUp();
    this.list.mouseUp();
  }
  mouseMove(mx, my) { this.list.mouseMove(mx, my); }
  wheel(d) { this.list.wheel(d); }
}

// Per-dimension system allow lists (mod's allow.* page): 8 toggles.
export class IvfxDimensionScreen extends Screen {
  constructor(game, parent, dim) {
    super(game);
    this.parent = parent;
    this.dim = dim;
    this.background = game.inWorld ? 'world' : 'dirt';
  }
  get s() { return this.game.settings; }
  key(cat) { return 'vfxAllow' + this.dim + cat; }
  init() {
    this.rows = [];
    const on = this.s.vfxEnabled !== false;
    for (const cat of VFX_ALLOW_CATS) {
      const k = this.key(cat);
      const b = new Button(this.rows.length, this.width / 2 - 155, 0, 310, 20,
        () => 'Allow ' + cat + ': ' + (this.s[k] !== false ? 'ON' : 'OFF'),
        () => { this.s[k] = !(this.s[k] !== false); this.s.save(); this.build(); });
      if (!on) b.enabled = false;
      this.rows.push([b]);
    }
    this.buttons = [new Button(200, this.width / 2 - 100, this.height - 27, 200, 20, 'Done', () => this.done())];
    const old = this.list;
    this.list = new ListOf(this, 32, this.height - 32, 25, {
      size: () => this.rows.length,
      draw: (gui, i, x, y, h, mx, my, rmx, rmy) => {
        const row = this.rows[i];
        for (const b of row) { if (!b) continue; b.y = y; b.render(gui, b.dragging ? rmx : mx, b.dragging ? rmy : my); }
      },
      click: (i, dbl, mx, my) => (this.rows[i] || []).some((b) => b && b.mouseDown && b.mouseDown(mx, my, this.game)),
    }, { listWidth: 400, scrollBarOffset: 32, selectionBox: false });
    if (old) this.list.amountScrolled = old.amountScrolled;
  }
  build() { this.init(); }
  done() { this.s.save(); this.game.screens.open(this.parent); }
  close() { this.done(); }
  render(gui, mx, my) {
    this.list.render(gui, mx, my);
    gui.textCentered('ImmersiveVFX: ' + this.dim, this.width / 2, 5, 0xffffff);
    for (const b of this.buttons) b.render(gui, mx, my);
  }
  mouseDown(mx, my, button, e) { return super.mouseDown(mx, my, button) || this.list.mouseDown(mx, my, button); }
  mouseUp(mx, my, button) {
    super.mouseUp(mx, my, button);
    for (const r of this.rows) for (const b of r) if (b && b.mouseUp) b.mouseUp();
    this.list.mouseUp();
  }
  mouseMove(mx, my) { this.list.mouseMove(mx, my); }
  wheel(d) { this.list.wheel(d); }
}

function clamp01(v, a, b) {
  const n = Number(v);
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, n));
}

export { PRESET_LABEL };
