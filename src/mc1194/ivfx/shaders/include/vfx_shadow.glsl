#ifndef IMMERSIVEVFX_SHADOW_GLSL
#define IMMERSIVEVFX_SHADOW_GLSL

#include <immersivevfx:vfx_shadow_sky.glsl>
#define VFX_NO_TEXTURE_MAT
#include <immersivevfx:vfx_realistic.glsl>
#include <immersivevfx:vfx_night_grade.glsl>
#include <immersivevfx:vfx_grade.glsl>

uniform sampler2D VfxShadowMap;
uniform sampler2D VfxShadowMapPrev;
uniform sampler2D VfxSceneDepth;
uniform sampler2D VfxSceneColor;
float vfxMaterialValue = 0.0;
bool vfxMaterialKnown = false;

float vfx_atlas_value(vec2 uv) {
    return vfxMaterialValue;
}

float vfx_atlas_band(vec2 uv) {
    return floor(vfx_atlas_value(uv) / 16.0) * 16.0 / 255.0;
}

bool vfx_foliage(vec2 uv) {
    return mod(vfx_atlas_value(uv), 16.0) > 7.5;
}

float vfx_emissive_alpha(vec2 uv, vec3 albedo) {
    float glow = vfx_atlas_band(uv);
    if (glow > 0.75 || glow > 0.25 && max(albedo.r, max(albedo.g, albedo.b)) > 0.63) {
        return 0.625;
    }
    if (abs(glow - 0.439) < 0.02 || abs(glow - 0.565) < 0.02) {
        return 0.525;
    }
    return 0.5;
}

bool vfx_self_lit(vec2 uv, vec3 albedo) {
    float glow = vfx_atlas_band(uv);
    if (glow > 0.75 || abs(glow - 0.439) < 0.02 || abs(glow - 0.565) < 0.02) {
        return true;
    }
    return glow > 0.25 && max(albedo.r, max(albedo.g, albedo.b)) > 0.63;
}

#include <immersivevfx:vfx_reflect_block.glsl>

void vfx_set_material(uint id) {
    uint m = id & 255u;
    vfxMaterialKnown = (m & 64u) != 0u;
    if (!vfxMaterialKnown) {
        vfxMaterialValue = 0.0;
        return;
    }
    if ((m & 128u) != 0u) {
        vfxMaterialValue = 8.0;
        return;
    }
    uint kind = (m >> 4u) & 3u;
    float band = kind == 3u ? 240.0 : kind == 2u ? (HandLevels.z > 0.5 ? 144.0 : 112.0) : kind == 1u ? (HandLevels.z > 0.5 ? 128.0 : 96.0) : 0.0;
    vfxMaterialValue = band + float(m & 15u);
}

bool vfxBelowActive = false;
vec3 vfxWaterSpec = vec3(0.0);
vec3 vfxBelowColor = vec3(0.0);
void vfx_water_below(vec3 textured, vec3 tint, vec3 pos);

bool vfx_water_realistic() {
    return WaterParams.w > 0.0 && WaterLook.x > 0.5;
}

vec3 vfx_water_saturate(vec3 color) {
    return color * 1.15 - vec3((color.r + color.g + color.b) / 3.0 * 0.15);
}

vec3 vfx_water_block_grade(vec3 color) {
    vec3 graded = mix(vec3((color.r + color.g + color.b) / 3.0), color, 0.8);
    graded.g *= 0.85;
    return graded;
}

vec3 vfx_emissive_color(vec2 uv, vec3 albedo, vec3 color) {
    float glow = vfx_atlas_band(uv);
    if (glow < 0.45 || glow > 0.75) {
        return color;
    }
    float bright = smoothstep(0.625, 0.66, max(albedo.r, max(albedo.g, albedo.b)));
    float warm = clamp((albedo.r - albedo.b) * 2.0, 0.0, 1.0);
    float heat = smoothstep(0.35, 0.85, albedo.g);
    vec3 hot = mix(color * (1.0 - 0.2 * warm * (1.0 - heat)), vec3(max(color.r, max(color.g, color.b))), 0.5 * heat * warm);
    return mix(color * 0.6, hot, bright);
}

#if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY)
#ifndef VFX_LOC_INVERSE
#define VFX_LOC_INVERSE 10
#endif
layout(location = VFX_LOC_INVERSE) flat in mat4 vfxFlatInverse;

mat4 vfx_inverse_view_proj(mat4 viewProj) {
    return vfxFlatInverse;
}
#else
mat4 vfx_inverse_view_proj(mat4 viewProj) {
    return inverse(viewProj);
}
#endif

vec3 vfx_project(mat4 viewProj, vec3 p) {
    vec4 clip = viewProj * vec4(p, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    return vec3(ndc.xy * 0.5 + 0.5, WaterParams.y > 0.5 ? ndc.z : ndc.z * 0.5 + 0.5);
}

vec3 vfx_unproject(mat4 inverseViewProj, vec3 screen) {
    vec4 p = inverseViewProj * vec4(screen.xy * 2.0 - 1.0, WaterParams.y > 0.5 ? screen.z : screen.z * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
}

bool vfx_is_fluid(vec2 uv) {
    return int(mod(vfx_atlas_value(uv), 8.0) + 0.5) == 7;
}

bool vfx_is_water(vec3 tint, vec2 uv) {
    return vfx_is_fluid(uv) && (tint.b - tint.r >= 0.06 || tint.g - tint.r >= 0.06);
}

vec4 vfx_water_color(vec4 color, vec3 tint, vec2 uv, vec3 pos, vec3 normal, mat4 viewProj) {
    if (!vfx_is_water(tint, uv)) {
        return color;
    }
    vec3 view = normalize(pos);
    vec3 facing = dot(normal, view) > 0.0 ? -normal : normal;
    float fresnel = clamp(1.0 + dot(facing, view), 0.0, 1.0);
    float fresnel2 = fresnel * fresnel;
    if (WaterParams.w > 0.0) {
        vfx_water_below(color.rgb, tint, pos);
        return vec4(color.rgb, mix(color.a, 1.0, fresnel2 * fresnel2));
    }
    if (WaterParams.x < 0.5) {
        return color;
    }
    vec3 water = tint;
    water.g = max(water.g, 0.39);
    water = sqrt(water) * vec3(1.0, 0.85, 0.8) * 0.375;
    water = WaterLook.x > 0.5 ? vfx_water_saturate(water) : water;
    float texel = dot(color.rgb / max(tint, vec3(0.001)), vec3(0.299, 0.587, 0.114));
    water *= clamp(texel / 0.62, 0.0, 2.0);
    float waterFog = 1.0;
    if (WaterParams.z > 0.5) {
        float depthT = texelFetch(VfxSceneDepth, ivec2(gl_FragCoord.xy), 0).r;
        if (depthT > 0.0) {
            vec2 uv = gl_FragCoord.xy / vec2(textureSize(VfxSceneDepth, 0));
            vec3 floorPos = vfx_unproject(vfx_inverse_view_proj(viewProj), vec3(uv, depthT));
            waterFog = max(1.0 - exp((length(pos) - length(floorPos)) * 0.075), 0.0);
        }
    }
    float alpha = 0.98 * (0.6 + 0.4 * waterFog);
    return vec4(water, mix(alpha, 1.0, fresnel2 * fresnel2));
}

bool vfx_is_ice(vec2 uv) {
    return HandLevels.w > 0.5 && int(mod(vfxMaterialValue, 8.0) + 0.5) == 4;
}

vec3 vfx_reflection_sky(vec3 direction, vec3 color, vec3 fogColor, float skyLight) {
    if (skyLight <= 0.0) {
        return color * 0.5;
    }
    vec3 sky = fogColor;
    if (ReflectSun.w > 0.5) {
        sky = realisticTonemap(realisticSky(atmosphereUnpack(ReflectSun, ReflectFactors, ReflectSky, ReflectAtmo[0], ReflectAtmo[1], ReflectAtmo[2],
                ReflectAtmo[3], ReflectAtmo[4], ReflectAtmo[5], ReflectAtmo[6]), direction));
    }
    return mix(color * 0.5, sky, skyLight);
}

vec3 vfx_reflection(vec3 color, vec3 pos, vec3 normal, vec3 fogColor, vec3 tint, vec2 uv, vec2 lm, mat4 viewProj) {
    bool water = vfx_is_water(tint, uv);
    float strength = water ? ReflectParams.z : ReflectParams.w;
    if (strength <= 0.0 || !water && !vfx_is_ice(uv)) {
        return color;
    }
    mat4 inverseViewProj = vfx_inverse_view_proj(viewProj);
    vec4 eye = inverseViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    vec3 eyePos = eye.xyz / eye.w;
    vec3 viewPos = pos - eyePos;
    float lViewPos = length(viewPos);
    vec3 nViewPos = viewPos / max(lViewPos, 0.0001);
    vec3 normalM = dot(normal, nViewPos) > 0.0 ? -normal : normal;
    if (water && normalM.y < -0.5) {
        return color;
    }
    float fresnel = clamp(1.0 + dot(normalM, nViewPos), 0.0, 1.0);
    float reflectMult = water ? 1.0 : 0.7;
    float fresnelM = (fresnel * fresnel * fresnel * 0.85 + 0.15) * reflectMult * strength;
    vec3 nViewPosR = reflect(nViewPos, normalM);
    vec4 reflection = vec4(0.0);
    if (WaterParams.z > 0.5) {
        vec2 rEdge = vec2(0.6, 0.55);
        vec3 start = pos + normalM * (lViewPos * 0.025 * (1.0 - fresnel) + 0.05);
        vec3 vector = nViewPosR * 0.5;
        vec3 viewPosRT = pos + vector;
        vec3 tvector = vector;
        int sampleCount = int(ReflectParams.x);
        int refinementCount = int(ReflectParams.y);
        int sr = 0;
        float err = 9999999.0;
        float sampleDepth = 0.0;
        vec3 refPos = vec3(0.0);
        vec3 rfragpos = vec3(0.0);
        for (int i = 0; i < 38; i++) {
            if (i >= sampleCount) {
                break;
            }
            refPos = vfx_project(viewProj, viewPosRT);
            if (abs(refPos.x - 0.5) > rEdge.x || abs(refPos.y - 0.5) > rEdge.y) {
                break;
            }
            sampleDepth = textureLod(VfxSceneDepth, refPos.xy, 0.0).r;
            rfragpos = vfx_unproject(inverseViewProj, vec3(refPos.xy, sampleDepth));
            err = length(viewPosRT - rfragpos);
            if (err * 0.33333 < length(vector)) {
                sr++;
                if (sr >= refinementCount) {
                    break;
                }
                tvector -= vector;
                vector *= 0.1;
            }
            vector *= 2.0;
            tvector += vector;
            viewPosRT = start + tvector;
        }
        float lViewPosRT = length(rfragpos - eyePos);
        bool possible = dot(normalize(rfragpos - start), normalM) > 0.0;
        if (sampleDepth > 0.0 && possible && err * (1.0 - fresnel) < 1.0 + lViewPosRT * 0.2) {
            vec2 cdist = abs(refPos.xy - 0.5) / rEdge;
            reflection.a = clamp(1.0 - pow(max(cdist.x, cdist.y), 50.0), 0.0, 1.0);
            if (reflection.a > 0.001) {
                vec2 edgeFactor = cdist * cdist;
                edgeFactor *= edgeFactor;
                edgeFactor *= edgeFactor;
                reflection.rgb = textureLod(VfxSceneColor, refPos.xy, 0.0).rgb;
                edgeFactor.x *= edgeFactor.x;
                edgeFactor = max(1.0 - edgeFactor, vec2(0.0));
                reflection.a *= pow(edgeFactor.x * edgeFactor.y, 2.0 + 3.0 * dot(reflection.rgb, vec3(0.2125, 0.7154, 0.0721)));
            }
            reflection.a *= clamp(lViewPosRT - lViewPos + 3.0, 0.0, 1.0);
        }
    }
    float skyLight = max(lm.y - 0.7, 0.0) * 3.33333;
    vec3 reflected = reflection.a >= 1.0 ? reflection.rgb : mix(vfx_reflection_sky(nViewPosR, color, fogColor, skyLight * skyLight) + vfxWaterSpec * skyLight * skyLight, reflection.rgb, reflection.a);
    return mix(color, reflected, fresnelM);
}

layout(std140) uniform VfxShadow {
    mat4 ShadowMat;
    mat4 ShadowMatPrev;
    vec4 ShadowLight;
    vec4 ShadowRange;
    vec4 ShadowSun;
    vec4 ShadowAmbient;
};

float vfxCastShade = 0.0;

float vfx_shade_fraction(float shade) {
    return ShadowLight.w > 0.00001 ? clamp(shade / ShadowLight.w, 0.0, 1.0) : 0.0;
}

float vfx_shadow_boost(float shade, float weight) {
    return 1.0 - 0.5 * LookExtra.y * vfx_shade_fraction(shade) * clamp(weight, 0.0, 1.0);
}

vec4 vfx_shadow_light(vec4 lit, vec4 shaded, float shade, float skyWeight, float upness) {
    if (ShadowSun.w < 0.5) {
        vec3 luma = vec3(0.2126, 0.7152, 0.0722);
        vec4 result = mix(lit, shaded, shade);
        result.rgb *= vfx_shadow_boost(min(vfxCastShade, shade), (1.0 - dot(shaded.rgb, luma) / max(dot(lit.rgb, luma), 0.001)) * 5.0);
        return result;
    }
    vec3 total = ShadowSun.rgb + ShadowAmbient.rgb;
    float norm = max(dot(total, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
    vec3 scene = max(ShadowSun.rgb * (1.0 - vfx_shade_fraction(shade)) + ShadowAmbient.rgb, vec3(0.0)) / norm;
    vec3 light = mix(vec3(1.0), pow(scene, vec3(1.0 / 2.2)), clamp(skyWeight, 0.0, 1.0)) * vfx_shadow_boost(shade, skyWeight);
    return lit * vec4(light, 1.0);
}

vec4 vfx_shadow_light(vec4 lit, vec4 shaded, float shade, float skyWeight) {
    return vfx_shadow_light(lit, shaded, shade, skyWeight, 1.0);
}

float vfx_vanilla_unshade(vec3 normal) {
    vec3 a = abs(normal);
    if (a.y > 0.99) {
        return normal.y > 0.0 ? 1.0 : 2.0;
    }
    if (a.z > 0.99) {
        return 1.25;
    }
    if (a.x > 0.99) {
        return 1.6667;
    }
    return 1.0;
}

float vfx_mesh_unshade(vec3 normal) {
    return ShadowSun.w > 0.5 ? 1.0 : vfx_vanilla_unshade(normal);
}

float vfx_water_face(vec3 normal) {
    return ShadowSun.w > 0.5 ? 1.0 / vfx_vanilla_unshade(normal) : 1.0;
}

float vfx_vanilla_unshade(vec3 normal, float shade) {
    if (ShadowSun.w < -0.5) {
        return 1.0;
    }
    return mix(1.0, vfx_vanilla_unshade(normal), 1.0 - vfx_shade_fraction(shade));
}

bool vfxBelowSurface = true;
bool vfxFoliageLight = false;
bool vfxBodyLight = false;
vec3 vfxBelowPos = vec3(0.0);
float vfx_water_foliage_visibility(vec3 pos, vec3 normal, float skyLight);

void vfx_water_shadow(vec3 pos, bool foliage) {
    if (WaterParams.w > 0.0) {
        vfxBelowSurface = pos.y < WaterParams.w;
        vfxFoliageLight = foliage;
        vfxBelowPos = pos;
    }
}

vec3 vfx_lottes(vec3 x) {
    vec3 xa = pow(max(x, vec3(0.0)), vec3(1.05));
    return xa / (xa * 0.9190 + 0.7188);
}

vec3 vfx_linear_to_srgb(vec3 c) {
    return mix(1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, 12.92 * c, lessThan(c, vec3(0.0031308)));
}

void vfx_water_below(vec3 textured, vec3 tint, vec3 pos) {
    vec3 texel = textured / max(tint, vec3(0.001));
    if (WaterLook.x < 0.5) {
        vec3 water = textured;
        if (WaterParams.x > 0.5) {
            water = tint;
            water.g = max(water.g, 0.39);
            water = sqrt(water) * vec3(1.0, 0.85, 0.8) * 0.375;
            water *= clamp(dot(texel, vec3(0.299, 0.587, 0.114)) / 0.62, 0.0, 2.0);
        }
        water = mix(vec3((water.r + water.g + water.b) / 3.0), water, 0.8) * 0.8;
        vfxBelowColor = clamp(water * WaterLook.y, 0.0, 1.0);
        vfxBelowActive = true;
        return;
    }
    vec3 glass = tint;
    glass.g = max(glass.g, 0.39);
    glass = glass * (2.0 - glass) * vec3(1.0, 0.85, 0.8);
    vec3 light = ShadowSun.rgb * max(0.4 - ShadowLight.y, 0.0) * 0.714 * WaterOrigin.w + ShadowAmbient.rgb;
    float fogDistance = length(pos) / max(WaterFogColor.a, 1.0);
    vec3 surface = mix(vfx_water_saturate(texel * texel * glass * light), WaterFogColor.rgb, 1.0 - exp(-fogDistance * fogDistance));
    vfxBelowColor = clamp(vfx_linear_to_srgb(vfx_lottes(pow(max(surface, vec3(0.0)), vec3(2.2)))), 0.0, 1.0);
    vfxBelowActive = true;
}

vec3 vfxGlint = vec3(0.0);

float vfx_glint_half(float radiusTan, float NoL, float NoV, float VoL) {
    float radiusCos = 1.0 / sqrt(1.0 + radiusTan * radiusTan);
    float RoL = 2.0 * NoL * NoV - VoL;
    if (RoL >= radiusCos) {
        return 1.0;
    }
    float rOverLengthT = radiusCos * radiusTan / sqrt(max(1.0 - RoL * RoL, 0.000001));
    float NoTr = rOverLengthT * (NoV - RoL * NoL);
    float VoTr = rOverLengthT * (2.0 * NoV * NoV - 1.0 - RoL * VoL);
    float triple = sqrt(clamp(1.0 - NoL * NoL - NoV * NoV - VoL * VoL + 2.0 * NoL * NoV * VoL, 0.0, 1.0));
    float NoBr = rOverLengthT * triple;
    float VoBr = rOverLengthT * (2.0 * triple * NoV);
    float NoLVTr = NoL * radiusCos + NoV + NoTr;
    float VoLVTr = VoL * radiusCos + 1.0 + VoTr;
    float p = NoBr * VoLVTr;
    float q = NoLVTr * VoLVTr;
    float s = VoBr * NoLVTr;
    float xNum = q * (-0.5 * p + 0.25 * VoBr * NoLVTr);
    float xDenom = p * p + s * (s - 2.0 * p) + NoLVTr * ((NoL * radiusCos + NoV) * VoLVTr * VoLVTr + q * (-0.5 * (VoLVTr + VoL * radiusCos) - 0.5));
    float twoX1 = 2.0 * xNum / (xDenom * xDenom + xNum * xNum);
    float sinTheta = twoX1 * xDenom;
    float cosTheta = 1.0 - twoX1 * xNum;
    NoTr = cosTheta * NoTr + sinTheta * NoBr;
    VoTr = cosTheta * VoTr + sinTheta * VoBr;
    float newNoL = NoL * radiusCos + NoTr;
    float newVoL = VoL * radiusCos + VoTr;
    float NoH = NoV + newNoL;
    float HoH = 2.0 * newVoL + 2.0;
    return clamp(NoH * NoH / HoH, 0.0, 1.0);
}

float vfx_glint_specular(vec3 normal, vec3 view, vec3 light, float NdotL, float smoothness, bool exact) {
    float smooth1 = smoothness * 0.9 + 0.1;
    smooth1 = smooth1 * (2.0 - smooth1);
    float roughness = 1.35 - smooth1;
    roughness *= roughness;
    roughness *= roughness;
    vec3 halfVec = normalize(light - view);
    float dotLH = clamp(dot(halfVec, light), 0.0, 1.0);
    float dotNV = dot(normal, -view);
    float VoL = dot(-view, light);
    float NdotLV = NdotL + dotNV;
    float dotNH = exact ? vfx_glint_half(0.01, NdotL, dotNV, VoL) : clamp(NdotLV * NdotLV / max(2.0 + 2.0 * VoL, 0.0001), 0.0, 1.0);
    float denom = dotNH * roughness - dotNH + 1.0;
    float D = roughness / (3.141592653589793 * denom * denom);
    float F = exp2((-5.55473 * dotLH - 6.98316) * dotLH) * 0.95 + 0.05;
    float facing = 1.0 - NdotL * NdotL;
    facing *= facing;
    facing *= facing;
    facing *= facing;
    float specular = max((1.0 - facing) * D * F / max(dotLH * dotLH, 0.0001), 0.0);
    return specular / (0.125 * specular + 1.0);
}

float vfx_glint_sun(float shade, float skyLight) {
    bool useMap = ShadowLight.w > 0.00001;
    return (useMap ? 1.0 - vfx_shade_fraction(shade) : pow(skyLight, 8.0)) * WaterOrigin.w;
}

vec3 vfx_glint_tint() {
    if (WaterParams.w <= 0.0) {
        return WaterGlint.rgb;
    }
    vec3 water = max(WaterTint.rgb, vec3(0.0));
    float peak = max(water.r, max(water.g, water.b));
    return peak > 0.0001 ? WaterGlint.rgb * mix(vec3(1.0), water / peak, 0.5) : WaterGlint.rgb;
}

float vfx_glint_amount(float sun) {
    return WaterParams.w > 0.0 ? pow(sun, 0.25) * 0.35 : sun;
}

void vfx_block_glint(sampler2D atlas, vec2 uv, vec3 texel, vec3 tint, vec3 pos, vec3 normal, float shade, float skyLight) {
    if (WaterGlint.w < 0.5) {
        return;
    }
    vec3 light = ShadowLight.xyz;
    vec3 view = normalize(pos);
    float NdotL = dot(normal, light);
    if (NdotL <= 0.0 || dot(normal, view) >= 0.0) {
        return;
    }
    float sun = vfx_glint_sun(shade, skyLight);
    if (WaterParams.w <= 0.0) {
        float open = skyLight * skyLight;
        open *= open;
        open *= open;
        sun *= open * open * smoothstep(0.0, 0.35, dot(view, light));
    }
    if (sun <= 0.0) {
        return;
    }
    vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    vec3 t = mix(texel, textureLod(atlas, uv, 4.0).rgb, WaterLook.w);
    int material = int(mod(vfx_atlas_value(uv), 8.0) + 0.5);
    if (material > 0 && material < 7) {
        float smoothness;
        float mult;
        if (material == 1 || material == 3) {
            float red2 = t.r * t.r;
            float factor = mix(0.75, 1.0, red2 * red2);
            smoothness = material == 1 ? pow(t.g, 16.0) * 2.0 : (1.0 - pow(t.g, 64.0) * 0.3) * 0.4;
            mult = 2.0 / factor;
            sun *= factor;
        } else if (material == 2) {
            smoothness = pow(t.r, 10.0);
            mult = 2.0;
        } else if (material == 4) {
            float g2 = t.g * t.g;
            float factor = min(g2 * 1.5, 1.0);
            smoothness = g2 * t.g;
            mult = factor * factor * 3.5;
        } else {
            float factor = t.g * t.g;
            if (material == 6) {
                factor = min(factor * 1.38, 1.0);
            }
            smoothness = 1.0 - 0.5 * factor;
            mult = factor * factor * 3.5;
        }
        vfxGlint = vfx_glint_amount(sun) * vfx_glint_specular(normal, view, light, NdotL, min(smoothness, 1.0), true) * mult * vfx_glint_tint();
        return;
    }
    float brightness = clamp(dot(t, luma) * min(dot(tint, luma), 1.0), 0.0, 1.0);
    float map = brightness * brightness;
    float specular = vfx_glint_specular(normal, view, light, NdotL, map * 0.65, false) * map * 2.0;
    float boost = 1.0 + 0.5 * smoothstep(0.5, 0.85, brightness);
    vfxGlint = vfx_glint_amount(sun) * specular / (1.0 + specular) * boost * vfx_glint_tint();
}

void vfx_water_surface_glint(vec3 texel, vec3 mean, vec3 pos, vec3 normal, float shade, float skyLight) {
    vec3 light = ShadowLight.xyz;
    vec3 view = normalize(pos);
    float NdotL = dot(normal, light);
    if (NdotL <= 0.0 || dot(normal, view) >= 0.0) {
        return;
    }
    float sun = vfx_glint_sun(shade, skyLight);
    if (sun <= 0.0) {
        return;
    }
    vec3 t = mix(texel, mean, WaterLook.w);
    float fresnel = clamp(1.0 + dot(normal, view), 0.0, 1.0);
    float power = dot(t, t) * 0.4;
    power *= power;
    power *= power;
    float mult = min(power, 0.5) * (16.0 - 15.0 * fresnel * fresnel) * WaterLook.z;
    float specular = vfx_glint_specular(normal, view, light, NdotL, 0.5, true) * mult;
    vfxGlint = vfx_glint_amount(sun) * specular * vfx_glint_tint();
    vfxWaterSpec = sun * specular * WaterGlint.rgb;
}

vec3 vfx_water_plain_grade(vec3 color, vec3 pos, bool selfLit) {
    if (vfx_water_realistic() && pos.y < WaterParams.w && !selfLit) {
        return vfx_water_block_grade(color);
    }
    return color;
}

vec3 vfx_glint_add(vec3 lit) {
    if (vfxGlint.r + vfxGlint.g + vfxGlint.b <= 0.0) {
        return lit;
    }
    if (WaterParams.w > 0.0) {
        return lit + vfxGlint;
    }
    return pow(pow(max(lit, vec3(0.0)), vec3(2.2)) + vfxGlint, vec3(1.0 / 2.2));
}

vec3 vfx_glint_display(vec3 color) {
    if (vfxGlint.r + vfxGlint.g + vfxGlint.b <= 0.0) {
        return color;
    }
    if (WaterParams.w <= 0.0) {
        return clamp(vfx_glint_add(color), 0.0, 1.0);
    }
    vec3 c = clamp(color, 0.0, 1.0);
    vec3 linear = mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, lessThan(c, vec3(0.04045)));
    vec3 powered = 0.7188 * linear / max(1.0 - 0.9190 * linear, vec3(0.001));
    vec3 lit = pow(powered, vec3(1.0 / (1.05 * 2.2))) + vfxGlint;
    return clamp(vfx_linear_to_srgb(vfx_lottes(pow(lit, vec3(2.2)))), 0.0, 1.0);
}

vec3 vfx_enhanced_color(vec3 albedo, vec2 lm, vec3 normal, float shade, bool selfLit) {
    float bright = ShadowAmbient.w;
    float ym = lm.y * lm.y * (3.0 - 2.0 * lm.y);
    float x4 = lm.x * lm.x * lm.x * lm.x;
    float xm = lm.x > 0.0 ? pow(x4 * x4 * (3.8 - 0.6 * bright) + lm.x * (1.8 + 0.6 * bright), 2.25) : 0.0;
    vec3 block = xm * vec3(0.1775, 0.104, 0.077);
    if (vfx_water_realistic() && vfxFoliageLight) {
        block = lm.x * lm.x * lm.x * 10.0 * vec3(0.1775, 0.104, 0.077);
    } else if (selfLit) {
        block = min(block, vec3(1.44));
    }
    bool plainFace = !(vfx_water_realistic() && vfxFoliageLight);
    float e2 = normal.x * normal.x;
    vec3 sun = ShadowSun.rgb * (plainFace ? 1.0 + e2 * 0.75 : 1.0);
    float lm2 = lm.y * lm.y;
    vec3 skyOpen = vec3(1.0);
    bool inWater = vfx_water_realistic();
    float inverseSky = 1.0 - lm.y;
    float strength = 2.5 + 5.5 * (inWater ? lm.y - lm.y * inverseSky * inverseSky : lm.y * sqrt(lm.y)) + 2.0 * lm2;
    vec3 ambient = ShadowAmbient.rgb;
    if (inWater) {
        if (plainFace) {
            float north = abs(normal.z);
            ambient = mix(ambient, sun, 0.05 * north * lm2);
            sun *= 1.0 + pow(max(ReflectFactors.z, 0.0), 20.0) * (north * north * 0.8 - e2 * 0.2);
        }
        if (vfxBelowSurface) {
            vec3 waterColor = pow(0.401 * WaterTint.rgb * vec3(0.6, 0.8, 1.1), vec3(0.75)) * 0.5;
            skyOpen = pow(waterColor * strength, vec3(mix(1.5, 0.5, lm2 * lm2)));
        }
    } else if (lm.y < 0.9999) {
        skyOpen = mix(vec3(pow(0.06 * strength, mix(2.0, 0.5, lm2 * lm2))), vec3(1.0), smoothstep(0.86, 1.0, lm.y));
    }
    float sunShade = WaterParams.w > 0.0 && WaterTint.a < 0.5 ? 0.0 : shade;
    float castShade = inWater ? sunShade : min(vfxCastShade, sunShade);
    float sunAmount = inWater
            ? (vfxFoliageLight && WaterTint.a > 0.5 ? vfx_water_foliage_visibility(vfxBelowPos, normal, lm.y) : 1.0 - vfx_shade_fraction(sunShade)) * WaterOrigin.w
            : max(ShadowLight.w - sunShade, 0.0);
    vec3 sunlit = sunAmount * skyOpen;
    vec3 scene = (sun * sunlit + ambient * (inWater ? mix(ym, ym * ym * ym, ReflectSky.w) : ym * (1.0 - 0.5 * castShade))) * vfx_shadow_boost(castShade, 1.0);
    vec3 minimum = (0.005625 + bright * 0.043) * vec3(0.45, 0.475, 0.6) * (1.0 - ym);
    float direction = plainFace ? (0.75 + normal.y * 0.25) * (1.0 - 0.1 * e2) * (1.0 + 0.075 * abs(normal.z)) : 1.0;
    vec3 diffuse = sqrt(max(direction * direction * (block + scene * scene + minimum), vec3(0.0)));
    vec3 lit = max(albedo * diffuse, vec3(0.0));
    if (inWater && vfxBelowSurface && !selfLit && !vfxBodyLight) {
        lit = vfx_water_block_grade(lit);
    }
    lit = vfx_glint_add(lit);
    vec3 standard = clamp(lit * 1.25 / (1.0 + 0.25 * lit), 0.0, 1.0);
    vec3 linear = pow(lit, vec3(2.2));
    if (inWater && !selfLit) {
        return clamp(vfx_linear_to_srgb(vfx_lottes(linear)), 0.0, 1.0);
    }
    float luminance = dot(linear, vec3(0.2125, 0.7154, 0.0721));
    vec3 mapped = vfx_linear_to_srgb(vfx_lottes(linear));
    if (luminance < 0.1) {
        float low = smoothstep(0.1, 0.0, luminance);
        mapped = mix(mapped, lit, low * 0.5625);
        float gray = dot(mapped, vec3(0.2125, 0.7154, 0.0721));
        mapped = mix(mapped, vec3(gray), low * 0.25);
    }
    return mix(standard, clamp(mapped, 0.0, 1.0), 0.8);
}

vec3 vfx_enhanced_color(vec3 albedo, vec2 lm, vec3 normal, float shade) {
    return vfx_enhanced_color(albedo, lm, normal, shade, false);
}

bool vfxHandGlow = false;

#ifdef VFX_HAND
vec2 vfx_hand_hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

float vfx_hand_cells(vec2 p, float t) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 o = 0.5 + 0.4 * sin(t + 6.2831853 * vfx_hand_hash(i + g));
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < d1) {
                d2 = d1;
                d1 = d;
            } else if (d < d2) {
                d2 = d;
            }
        }
    }
    return 1.0 - smoothstep(0.0, 0.2, sqrt(d2) - sqrt(d1));
}

float vfx_hand_glints(vec2 world, float time) {
    vec2 p = (floor(world * 16.0) + 0.5) / 16.0;
    float c = vfx_hand_cells(p * 0.75, time * 0.7) * 0.65 + vfx_hand_cells(p * 1.35 + vec2(7.3, 2.9), time * 1.05) * 0.35;
    return c * c * 1.3 + c * 0.15;
}

vec3 vfx_hand_look(vec3 color, vec3 pos, vec3 normal, float shade, float skyLight) {
    float vfxHandNight = HeldLight.w > 0.0 ? 0.0 : LookExtra.x;
    vec3 c = clamp(color, 0.0, 1.0);
    if (WaterParams.w <= 0.0 || vfxHandGlow) {
        return clamp(vfx_screen_grade(c, HandGrade.x, vfxHandNight), 0.0, 1.0);
    }
    bool realistic = WaterLook.x > 0.5;
    vec3 encoded = mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, lessThan(c, vec3(0.04045)));
    vec3 powered = 0.7188 * encoded / max(1.0 - 0.9190 * encoded, vec3(0.001));
    vec3 scene = pow(powered, vec3(1.0 / (1.05 * 2.2)));
    if (!realistic) {
        vec3 waterLight = sqrt(HandWater.rgb);
        waterLight /= max(dot(waterLight, vec3(0.2126, 0.7152, 0.0722)), 0.001);
        scene *= mix(vec3(1.0), waterLight, 0.5);
    }
    float above = max(WaterParams.w - pos.y, 0.0);
    if (above > 0.0 && HandGrade.y > 0.002) {
        float facing = smoothstep(0.0, 0.3, dot(normal, ShadowLight.xyz));
        float sun = facing * vfx_glint_sun(shade, skyLight);
        vec2 entry = pos.xz + HandGrade.zw + ShadowLight.xz / max(ShadowLight.y, 0.2) * above;
        float depthFade = pow(max(1.0 - above / 28.0, 0.0), 1.4);
        vec3 base = scene;
        scene *= 1.0 - 0.34 * HandGrade.y * exp(-above / 63.0) * facing * (1.0 - sun);
        scene += base * HandWater.rgb * sun * HandGrade.y * depthFade * vfx_hand_glints(entry, HandWater.w) * (realistic ? 1.875 : 1.5);
    }
    if (realistic) {
        scene *= vec3(0.80, 0.87, 0.97) * 0.85;
    }
    vec3 linear = pow(max(scene, vec3(0.0)), vec3(2.2));
    vec3 display = vfx_linear_to_srgb(vfx_lottes(linear));
    if (!realistic) {
        return clamp(vfx_night_grade(display, vfxHandNight), 0.0, 1.0);
    }
    float start = dot(linear, vec3(0.299, 0.587, 0.114));
    float dark = smoothstep(0.1, 0.0, start);
    display = mix(display, pow(linear, vec3(1.0 / 2.2)), dark * 0.75);
    display = mix(display, vec3(1.0), smoothstep(0.0, 16.0, start));
    display = clamp(mix(display, vec3(dot(display, vec3(0.299, 0.587, 0.114))), dark * 0.25), 0.0, 1.0);
    return clamp(vfx_night_grade(display * 1.07 - (display.r + display.g + display.b) / 3.0 * 0.07, vfxHandNight), 0.0, 1.0);
}

vec3 vfx_hand_finish(vec3 color, vec3 pos, vec3 normal, float shade, float skyLight) {
    return vfx_user_grade(vfx_hand_look(color, pos, normal, shade, skyLight), GradeTone, GradeBalance, GradeLevels, GradeBandStrength, GradeBandHue);
}
#endif

vec3 vfx_face_normal(vec3 pos) {
    vec3 n = normalize(cross(dFdx(pos), dFdy(pos)));
    return dot(n, pos) > 0.0 ? -n : n;
}

vec3 vfx_texel_snap(vec3 pos, vec2 uv, vec2 texSize) {
    vec2 dUVdS = dFdx(uv);
    vec2 dUVdT = dFdy(uv);
    vec3 dPdS = dFdx(pos);
    vec3 dPdT = dFdy(pos);
    vec2 dUV = (floor(uv * texSize) + 0.5) / texSize - uv;
    float a = dot(dUVdS, dUVdS);
    float b = dot(dUVdS, dUVdT);
    float c = dot(dUVdT, dUVdT);
    float det = a * c - b * b;
    vec2 proj = vec2(dot(dUV, dUVdS), dot(dUV, dUVdT));
    vec2 offset = det > a * c * 0.01 ? vec2(c * proj.x - b * proj.y, a * proj.y - b * proj.x) / det : vec2(0.0);
    return pos + clamp(dPdS * offset.x + dPdT * offset.y, -1.0, 1.0);
}

float vfx_shadow_lookup(sampler2D map, mat4 matrix, vec3 p, float spread) {
    vec3 shadowPos = (matrix * vec4(p, 1.0)).xyz;
    if (any(lessThanEqual(shadowPos, vec3(0.0))) || any(greaterThanEqual(shadowPos, vec3(1.0)))) {
        return 1.0;
    }
    float o = ShadowRange.x * 0.75 * spread;
    float depth = shadowPos.z + ShadowRange.z;
    float lit = step(textureLod(map, shadowPos.xy, 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy + vec2(o, 0.0), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy - vec2(o, 0.0), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy + vec2(0.0, o), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy - vec2(0.0, o), 0.0).r, depth);
    return lit * 0.2;
}

const vec2 VFX_FOLIAGE_TAPS[8] = vec2[](
    vec2(0.4619398, 0.1913417), vec2(0.3826834, 0.9238795), vec2(-0.1913417, 0.4619398), vec2(-0.9238795, 0.3826834),
    vec2(-0.4619398, -0.1913417), vec2(-0.3826834, -0.9238795), vec2(0.1913417, -0.4619398), vec2(0.9238795, -0.3826834));

float vfx_foliage_lookup(sampler2D map, mat4 matrix, vec3 p, float reach) {
    vec3 start = (matrix * vec4(p, 1.0)).xyz;
    vec3 stepPos = mat3(matrix) * ShadowLight.xyz * (0.06 * reach);
    vec3 end = start + stepPos * 7.0;
    vec3 low = min(start, end);
    vec3 high = max(start, end);
    float spread = ShadowRange.x * 4.0;
    float lit = 0.0;
    if (all(greaterThan(low, vec3(0.0))) && all(lessThan(high, vec3(1.0)))) {
        for (int i = 0; i < 8; i++) {
            vec3 shadowPos = start + stepPos * float(i);
            lit += step(textureLod(map, shadowPos.xy + VFX_FOLIAGE_TAPS[i] * spread, 0.0).r, shadowPos.z + ShadowRange.z);
        }
        return lit * 0.125;
    }
    for (int i = 0; i < 8; i++) {
        vec3 shadowPos = start + stepPos * float(i);
        if (any(lessThanEqual(shadowPos, vec3(0.0))) || any(greaterThanEqual(shadowPos, vec3(1.0)))) {
            lit += 1.0;
            continue;
        }
        lit += step(textureLod(map, shadowPos.xy + VFX_FOLIAGE_TAPS[i] * spread, 0.0).r, shadowPos.z + ShadowRange.z);
    }
    return lit * 0.125;
}

float vfx_water_foliage_lookup(sampler2D map, mat4 matrix, vec3 p) {
    vec3 shadowPos = (matrix * vec4(p, 1.0)).xyz;
    if (any(lessThanEqual(shadowPos, vec3(0.0))) || any(greaterThanEqual(shadowPos, vec3(1.0)))) {
        return 1.0;
    }
    float spread = ShadowRange.x * 4.0;
    float depth = shadowPos.z + ShadowRange.z;
    float lit = step(textureLod(map, shadowPos.xy, 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy + vec2(spread, 0.0), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy + vec2(0.0, spread), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy - vec2(spread, 0.0), 0.0).r, depth);
    lit += step(textureLod(map, shadowPos.xy - vec2(0.0, spread), 0.0).r, depth);
    return lit * 0.2;
}

float vfx_water_foliage_visibility(vec3 pos, vec3 normal, float skyLight) {
    float skyCurve = skyLight * skyLight * (3.0 - 2.0 * skyLight);
    vec3 origin = WaterOrigin.xzy;
    vec3 center = floor(pos + origin + normal * 0.01) - origin + 0.5;
    vec3 p = mix(center, pos, 0.5 + 0.5 * skyCurve);
    float visibility = vfx_water_foliage_lookup(VfxShadowMap, ShadowMat, p);
    if (ShadowRange.w < 0.999) {
        visibility = mix(vfx_water_foliage_lookup(VfxShadowMapPrev, ShadowMatPrev, p), visibility, ShadowRange.w);
    }
    return visibility * mix(0.5, 1.0, smoothstep(0.0, 0.15, dot(normal, ShadowLight.xyz)));
}

float vfx_foliage_reach(vec3 pos, vec3 normal, float NdotL) {
    vec3 axis = step(vec3(0.99), abs(normal));
    if (NdotL > -0.001 || dot(axis, vec3(1.0)) < 0.5) {
        return 1.0;
    }
    vec3 inner = pos + WaterOrigin.xzy - normal * 0.01;
    float cell = dot(fract(inner), axis);
    float wall = (dot(normal, axis) > 0.0 ? cell : 1.0 - cell) + 0.01;
    if (wall > 0.1) {
        return 1.0;
    }
    return clamp(wall * 0.75 / (-NdotL * 0.42), 0.0, 1.0);
}

float vfx_shadow_amount(vec3 pos, vec3 snapped, vec3 normal, bool foliage) {
    vfxCastShade = 0.0;
    if (ShadowLight.w <= 0.0) {
        return 0.0;
    }
    float NdotL = dot(normal, ShadowLight.xyz);
    float direct = ShadowSun.w > 0.5 ? clamp((NdotL + 0.4) * 0.714, 0.0, 1.0) : clamp(NdotL * 2.5 + 0.35, 0.0, 1.0);
    if (foliage) {
        direct = 1.0;
    }
    float visibility = 1.0;
    if (direct > 0.001) {
        if (foliage) {
            float reach = vfx_foliage_reach(pos, normal, NdotL);
            visibility = vfx_foliage_lookup(VfxShadowMap, ShadowMat, snapped, reach);
            if (ShadowRange.w < 0.999) {
                visibility = mix(vfx_foliage_lookup(VfxShadowMapPrev, ShadowMatPrev, snapped, reach), visibility, ShadowRange.w);
            }
        } else {
            float bias = (0.12 + 0.0008 * pow(dot(pos, pos), 0.75)) * (2.0 - 0.95 * max(NdotL, 0.0));
            vec3 p = snapped + normal * bias;
            visibility = vfx_shadow_lookup(VfxShadowMap, ShadowMat, p, 1.0);
            if (ShadowRange.w < 0.999) {
                visibility = mix(vfx_shadow_lookup(VfxShadowMapPrev, ShadowMatPrev, p, 1.0), visibility, ShadowRange.w);
            }
        }
        float edge = max(max(abs(pos.x), abs(pos.z)), abs(pos.y));
        visibility = mix(visibility, 1.0, smoothstep(ShadowRange.y * 0.8, ShadowRange.y * 0.95, edge));
    }
    vfxCastShade = ShadowLight.w * (1.0 - visibility);
    return ShadowLight.w * (1.0 - visibility * direct);
}

#endif
