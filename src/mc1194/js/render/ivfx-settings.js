// ImmersiveVFX port — settings, presets and color-grading tables.
//
// Port of com/shinyflvres/immersivevfx/config/ImmersiveVFXConfig.java +
// ImmersiveVFXPresets.java + GradingPresets.java + VfxSettings.java (enums).
// Every user-facing option from assets/immersivevfx/lang/en_us.json is a
// `vfx*` key here; ensureVfx() fills defaults into the game Settings object
// so they persist through the normal settings save path. Presets mirror the
// mod's 7 presets (Immersive / Insane / Enhanced / Vanilla Plus, each + a
// Toon variant except Custom).
//
// What maps where in this engine:
//   - fog/sky/cloud/water/weather/particle/vegetation/outline/grading options
//     are consumed by js/render/ivfx.js + ivfx-particles.js.
//   - shadows/reflections/bloom/depthCalculation are quality-gated
//     approximations (no deferred pipeline in this engine): shadow strength
//     scales the blob-shadow pass, reflections tint water/ice, bloom draws
//     additive halos. useIrisShaders disables all of them (like the mod).

export const VFX_PRESETS = ['immersive', 'immersive_toon', 'insane', 'insane_toon', 'enhanced', 'enhanced_toon', 'vanilla_plus', 'vanilla_plus_toon', 'custom'];

export const VFX_DEFAULTS = {
  vfxPreset: 'immersive',
  // general
  vfxEnabled: true, // master switch: OFF = fully vanilla rendering
  vfxParticleRate: 'maximum', // maximum|reduced|none
  vfxFogRenderingMode: 'immersive', // immersive|immersive_extended|chunk_distance|off
  vfxSnowSandStyle: 'hd', // hd|vanilla
  vfxSmoothBlockPlace: true,
  vfxTorchLight: true,
  vfxModdedBiomes: true,
  vfxUseIrisShaders: false,
  // sky
  vfxSkyMode: 'realistic', // vanilla|realistic
  vfxCustomSkies: true,
  vfxCloudRendering: 'fancy', // off|fancy|shaded|flat
  vfxCloudFormation: 'modern', // legacy|modern
  vfxMultiCloudLayers: true,
  vfxDoubleClouds: true,
  vfxLightRays: true,
  vfxLightRayIntensity: 60,
  vfxUnderwaterLightRays: true,
  vfxUnderwaterLightRayIntensity: 60,
  vfxAurora: true,
  vfxMeteorShower: true,
  vfxShootingStars: true,
  vfxFireworks: true,
  vfxSandWind: true,
  vfxSandStorm: true,
  vfxAlwaysWinter: false,
  // fog + mist
  vfxAtmosphericFog: true,
  vfxAtmosphericFogStrength: 60,
  vfxDynamicFog: true,
  vfxLowFog: true,
  vfxGroundMist: true,
  vfxWeatherMist: true,
  // lighting
  vfxBloom: true,
  vfxBloomIntensity: 60,
  vfxEnhancedLight: true,
  vfxColoredLight: true,
  vfxColoredLightIntensity: 60,
  vfxColoredLightRadius: 60,
  vfxDungeonsFire: true,
  vfxUnderwaterCaustics: true,
  vfxUnderwaterGlint: true,
  vfxTerrainGlint: true,
  vfxGlintSmoothness: 50,
  vfxUnderwaterDepthBlur: true,
  vfxUnderwaterShadows: true,
  vfxDynamicColorGrading: true,
  // water
  vfxWaterReflections: true,
  vfxIceReflections: true,
  vfxReflectionQuality: 'normal', // low|normal|high
  vfxReflectionStrength: 60,
  vfxWaterColorMapping: true,
  vfxWaterColors: 'realistic', // vanilla|realistic
  vfxShoreFoam: true,
  vfxLavaFoam: true,
  vfxWaterfallMist: true,
  vfxWaterLeaves: true,
  // vegetation
  vfxMovingGrass: true,
  vfxMovingPlants: true,
  vfxMovingLeaves: true,
  vfxGpuGrass: true,
  vfxGpuGrassDensity: 60,
  vfxGpuGrassHeight: 100,
  vfxGpuGrassDistance: 48,
  vfxNaturalFoliageColors: true,
  // particles
  vfxFireflies: true,
  vfxSpecks: true,
  vfxPollenAndSpores: true,
  vfxLeaves: true,
  vfxWindGusts: true,
  // weather
  vfxWeatherVisuals: 'enhanced', // vanilla|enhanced|custom
  // outlines
  vfxBlockOutlines: true,
  vfxBlockOutlineThickness: 50,
  vfxMobOutlines: false,
  vfxMobOutlineThickness: 50,
  vfxEnchantmentOutlines: true,
  vfxDynamicItemOutlines: true,
  vfxEnchantmentOutlineIntensity: 60,
  vfxEnchantmentOutlineThickness: 50,
  vfxEnchantmentOutlineHueShift: 0,
  vfxEnchantmentOutlineSaturation: 100,
  // shadows
  vfxShadows: true,
  vfxShadowMode: 'enhanced', // normal|enhanced
  vfxShadowResolution: 'medium', // low|medium|high
  vfxShadowDistance: 60,
  vfxShadowStrength: 60,
  vfxShadowBoost: 0,
  vfxMobShadows: true,
  vfxDepthCalculation: true,
  // end
  vfxEndColorGrading: true,
  vfxEndAura: true,
  // dimensions (moddedDimensions page analogue)
  vfxDimOverworld: true,
  vfxDimNether: true,
  vfxDimEnd: true,
  // per-dimension per-system allow lists (mod's allow.bloom/effects/
  // lightEngine/outlines/reflections/shadows/sky/weather). Flat keys so
  // ensureVfx/save/presets keep working with zero special-casing.
  // Defaults mirror the mod: Nether has no sky or weather systems, the
  // End has no weather system.
  vfxAllowOverworldBloom: true, vfxAllowOverworldEffects: true,
  vfxAllowOverworldLight: true, vfxAllowOverworldOutlines: true,
  vfxAllowOverworldReflections: true, vfxAllowOverworldShadows: true,
  vfxAllowOverworldSky: true, vfxAllowOverworldWeather: true,
  vfxAllowNetherBloom: true, vfxAllowNetherEffects: true,
  vfxAllowNetherLight: true, vfxAllowNetherOutlines: true,
  vfxAllowNetherReflections: true, vfxAllowNetherShadows: true,
  vfxAllowNetherSky: false, vfxAllowNetherWeather: false,
  vfxAllowEndBloom: true, vfxAllowEndEffects: true,
  vfxAllowEndLight: true, vfxAllowEndOutlines: true,
  vfxAllowEndReflections: true, vfxAllowEndShadows: true,
  vfxAllowEndSky: true, vfxAllowEndWeather: false,
  // color grading
  vfxGradingMode: 'enhanced', // off|vanilla|enhanced
  vfxGradingEditTime: 'noon', // dawn|noon|dusk|night
  // per-time grading tables are stored as vfxGrading = {dawn:{...},noon:{...},dusk:{...},night:{...}}
};

// One grading set (mirrors VfxSettings.GradeParam order).
export function defaultGrade() {
  return {
    exposure: 100, contrast: 100, shadows: 100, midtones: 100, highlights: 100,
    saturation: 100, vibrance: 0, hueShift: 0, temperature: 0, tint: 0,
    redStrength: 100, greenStrength: 100, blueStrength: 100,
    redHue: 0, greenHue: 0, blueHue: 0,
  };
}

export function defaultGrading() {
  return { dawn: defaultGrade(), noon: defaultGrade(), dusk: defaultGrade(), night: defaultGrade() };
}

// GradingPresets.java: IVFX Vanilla = identity; Medieval = muted warm olive;
// Vintage = soft faded.
const GRADING_PRESET_SETS = {
  vanilla: () => defaultGrade(),
  medieval: () => ({
    exposure: 96, contrast: 92, shadows: 110, midtones: 96, highlights: 92,
    saturation: 72, vibrance: 10, hueShift: 6, temperature: 14, tint: -4,
    redStrength: 88, greenStrength: 76, blueStrength: 84,
    redHue: 6, greenHue: -14, blueHue: 4,
  }),
  vintage: () => ({
    exposure: 104, contrast: 78, shadows: 128, midtones: 104, highlights: 88,
    saturation: 58, vibrance: 6, hueShift: -4, temperature: 8, tint: 6,
    redStrength: 92, greenStrength: 88, blueStrength: 82,
    redHue: 0, greenHue: 0, blueHue: 0,
  }),
};

export function applyGradingPreset(grading, name) {
  const make = GRADING_PRESET_SETS[name] || GRADING_PRESET_SETS.vanilla;
  for (const t of ['dawn', 'noon', 'dusk', 'night']) grading[t] = make();
}

// Preset overlays (ImmersiveVFXPresets.java): only non-default deltas listed.
// Toon variants add the outline/toon look on top of their base preset.
const PRESET_DELTAS = {
  immersive: {},
  insane: {
    vfxParticleRate: 'maximum', vfxFogRenderingMode: 'immersive_extended',
    vfxBloomIntensity: 85, vfxReflectionQuality: 'high', vfxReflectionStrength: 85,
    vfxShadowResolution: 'high', vfxShadowDistance: 85, vfxShadowStrength: 80,
    vfxColoredLightIntensity: 85, vfxColoredLightRadius: 85,
    vfxAtmosphericFogStrength: 80, vfxGpuGrassDensity: 85, vfxLightRayIntensity: 80,
    vfxUnderwaterLightRayIntensity: 80, vfxEnchantmentOutlineIntensity: 85,
  },
  enhanced: {
    vfxFogRenderingMode: 'immersive', vfxBloomIntensity: 45,
    vfxReflectionStrength: 45, vfxShadowStrength: 45, vfxShadowDistance: 45,
    vfxColoredLightIntensity: 45, vfxAtmosphericFogStrength: 45,
    vfxGpuGrassDensity: 45, vfxLightRayIntensity: 45, vfxMobOutlines: false,
    vfxEnchantmentOutlines: true,
  },
  vanilla_plus: {
    vfxFogRenderingMode: 'chunk_distance', vfxSkyMode: 'vanilla',
    vfxCustomSkies: false, vfxCloudFormation: 'legacy', vfxMultiCloudLayers: false,
    vfxDoubleClouds: false, vfxLightRays: false, vfxUnderwaterLightRays: false,
    vfxAurora: false, vfxMeteorShower: false, vfxFireworks: false,
    vfxBloom: false, vfxColoredLight: false, vfxEnhancedLight: false,
    vfxWaterReflections: false, vfxIceReflections: false, vfxShoreFoam: false,
    vfxLavaFoam: false, vfxWaterfallMist: false, vfxUnderwaterCaustics: false,
    vfxUnderwaterGlint: false, vfxTerrainGlint: false, vfxUnderwaterDepthBlur: false,
    vfxDynamicColorGrading: false, vfxShadows: false, vfxMobShadows: false,
    vfxBlockOutlines: false, vfxEnchantmentOutlines: false, vfxGpuGrass: false,
    vfxMovingGrass: false, vfxMovingPlants: false, vfxMovingLeaves: false,
    vfxGradingMode: 'off', vfxEndAura: false, vfxEndColorGrading: false,
    vfxGroundMist: false, vfxWeatherMist: false, vfxLowFog: false,
    vfxFireflies: true, vfxSpecks: true, vfxLeaves: true, vfxWindGusts: false,
    vfxPollenAndSpores: true, vfxWeatherVisuals: 'vanilla',
  },
};

function toonDelta() {
  return {
    vfxBlockOutlines: true, vfxBlockOutlineThickness: 85,
    vfxMobOutlines: true, vfxMobOutlineThickness: 70,
    vfxEnchantmentOutlines: true, vfxEnchantmentOutlineIntensity: 90,
    vfxEnchantmentOutlineSaturation: 100,
  };
}

export function presetValues(name) {
  const out = { ...VFX_DEFAULTS, vfxGrading: defaultGrading() };
  if (name === 'custom') return out;
  const base = name.replace(/_toon$/, '');
  Object.assign(out, PRESET_DELTAS[base] || {});
  if (name.endsWith('_toon')) Object.assign(out, toonDelta());
  out.vfxPreset = name;
  return out;
}

export function applyPreset(settings, name) {
  const v = presetValues(name);
  for (const k of Object.keys(v)) settings[k] = v[k] && typeof v[k] === 'object' ? JSON.parse(JSON.stringify(v[k])) : v[k];
  try { settings.save && settings.save(); } catch (e) {}
}

// Fill missing keys (old saves) — mirrors alignPresetDefaults/migrate.
export function ensureVfx(settings) {
  let touched = false;
  for (const [k, v] of Object.entries(VFX_DEFAULTS)) {
    if (settings[k] === undefined) { settings[k] = v; touched = true; }
  }
  if (!settings.vfxGrading || typeof settings.vfxGrading !== 'object') { settings.vfxGrading = defaultGrading(); touched = true; }
  else {
    for (const t of ['dawn', 'noon', 'dusk', 'night']) {
      if (!settings.vfxGrading[t]) { settings.vfxGrading[t] = defaultGrade(); touched = true; }
      else for (const [k, v] of Object.entries(defaultGrade())) {
        if (settings.vfxGrading[t][k] === undefined) { settings.vfxGrading[t][k] = v; touched = true; }
      }
    }
  }
  return touched;
}

// Allow-list axes (mod's allow.* categories x dimensions).
export const VFX_ALLOW_CATS = ['Bloom', 'Effects', 'Light', 'Outlines', 'Reflections', 'Shadows', 'Sky', 'Weather'];
export const VFX_ALLOW_DIMS = ['Overworld', 'Nether', 'End'];

// The mod gates everything behind allow.* + useIrisShaders.
export function vfxAllowed(settings, what) {
  if (settings.vfxUseIrisShaders) {
    // Only particle effects stay adjustable (see menu.about.useIrisShaders).
    return what === 'particles' || what === 'weather';
  }
  return true;
}
