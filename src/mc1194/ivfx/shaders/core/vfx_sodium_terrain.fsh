#version 460 core

#include <immersivevfx:vfx_sodium_locations.glsl>
#include <sodium:globals.glsl>
#include <sodium:fog.glsl>
#include <sodium:chunk_material.glsl>
#include <minecraft:oit.glsl>
#ifndef VFX_CASTER
#include <immersivevfx:vfx_shadow.glsl>
#endif
#ifdef VFX_SWAY
#define VFX_GRASS_FRAGMENT
#include <immersivevfx:vfx_grass.glsl>
#endif

layout(location = 0) in vec4 v_Color;
layout(location = 1) in vec2 v_TexCoord;
layout(location = 2) in vec2 v_FragDistance;
layout(location = 3) in float fadeFactor;
#ifndef VFX_CASTER
layout(location = VFX_LOC_MATERIAL) flat in uint vfxMaterial;
#endif
#ifdef VFX_SWAY
layout(location = VFX_LOC_GRASS) flat in float vfxGrass;
layout(location = VFX_LOC_SKY) in float vfxGrassSky;
layout(location = VFX_LOC_SWAY) in vec2 vfxSwayCorner;
layout(location = VFX_LOC_SWAY_KIND) flat in float vfxSwayKind;
#endif
#if !defined(VFX_CASTER) && (defined(VFX_SHADOWS) || defined(VFX_REFLECT) || defined(VFX_SWAY))
layout(location = VFX_LOC_POS) in vec3 vfxPos;
layout(location = VFX_LOC_LM) in vec2 vfxLm;
layout(location = VFX_LOC_COLOR) in vec4 vfxVertexColor;
#endif
#if defined(VFX_SHADOWS) && !defined(VFX_ENHANCED) && !defined(VFX_CASTER)
layout(location = VFX_LOC_SHADE) in vec4 vfxShadeColor;
#endif

uniform sampler2D u_BlockTex;

#if !defined(OIT_ALPHA_ONLY) && !defined(VFX_CASTER) && !defined(VFX_DEPTH_ONLY)
layout(location = 0) out vec4 fragColor;
#endif
#ifdef ALPHA_CUTOUT
#define VFX_CUTOUT ALPHA_CUTOUT
#endif

vec4 calculateFinalColor(vec4 color) {
    #ifdef OIT_ACCUMULATE
        color = sampleColorForAccumulation(color);
        vec4 fogColor = vec4(u_FogColor.rgb * color.a, u_FogColor.a);
    #else
        vec4 fogColor = u_FogColor;
    #endif

    #ifdef OIT_ALPHA_ONLY
    float factor = 1.0;
    #else
    float factor = fadeFactor;
    #endif

    return _linearFog(color, v_FragDistance, fogColor, u_EnvironmentFog, u_RenderFog, factor);
}

vec4 sampleNearest(sampler2D source, vec2 uv, vec2 pixelSize, vec2 du, vec2 dv, vec2 texelScreenSize) {
    vec2 uvTexelCoords = uv / pixelSize;
    vec2 texelCenter = round(uvTexelCoords) - 0.5f;
    vec2 texelOffset = uvTexelCoords - texelCenter;
    texelOffset = (texelOffset - 0.5f) * pixelSize / texelScreenSize + 0.5f;
    texelOffset = clamp(texelOffset, 0.0f, 1.0f);
    uv = (texelCenter + texelOffset) * pixelSize;
    return textureGrad(source, uv, du, dv);
}

vec4 sampleNearest(sampler2D source, vec2 uv, vec2 pixelSize) {
    vec2 du = dFdx(uv);
    vec2 dv = dFdy(uv);
    vec2 texelScreenSize = sqrt(du * du + dv * dv);
    return sampleNearest(source, uv, pixelSize, du, dv, texelScreenSize);
}

vec4 sampleRGSS(sampler2D source, vec2 uv, vec2 pixelSize, vec2 du, vec2 dv) {
    vec2 texelScreenSize = sqrt(du * du + dv * dv);
    float maxTexelSize = max(texelScreenSize.x, texelScreenSize.y);
    float minPixelSize = min(pixelSize.x, pixelSize.y);
    float blendFactor = smoothstep(minPixelSize, minPixelSize * 2.0, maxTexelSize);
    float duLength = length(du);
    float dvLength = length(dv);
    float effectiveDerivative = sqrt(min(duLength, dvLength) * max(duLength, dvLength));
    float mipLevelExact = max(0.0, log2(effectiveDerivative / minPixelSize));
    const vec2 offsets[4] = vec2[](vec2(0.125, 0.375), vec2(-0.125, -0.375), vec2(0.375, -0.125), vec2(-0.375, 0.125));
    vec4 rgssColor = vec4(0.0);
    for (int i = 0; i < 4; ++i) {
        rgssColor += textureLod(source, uv + offsets[i] * pixelSize, mipLevelExact);
    }
    rgssColor *= 0.25;
    vec4 nearestColor = sampleNearest(source, uv, pixelSize, du, dv, texelScreenSize);
    return mix(nearestColor, rgssColor, blendFactor);
}

#ifdef VFX_CASTER
void main() {
    #ifdef ALPHA_CUTOUT
    vec2 rawDu = dFdx(v_TexCoord);
    vec2 rawDv = dFdy(v_TexCoord);
    vec4 color = u_UseRGSS ? sampleRGSS(u_BlockTex, v_TexCoord, u_TexelSize, rawDu, rawDv) : sampleNearest(u_BlockTex, v_TexCoord, u_TexelSize);
    if (color.a * v_Color.a < ALPHA_CUTOUT) {
        discard;
    }
    #endif
}
#elif defined(VFX_DEPTH_ONLY)
void main() {
    vec2 blockUv = v_TexCoord;
    vec2 blockDu = dFdx(v_TexCoord);
    vec2 blockDv = dFdy(v_TexCoord);
    #ifdef VFX_SWAY
    if (vfxGrass > 0.5 && !vfx_grass_uv(v_TexCoord, int(vfxGrass) - 1, vfxGrassSky, vfxPos, u_TexelSize, blockUv)) {
        discard;
    }
    if (vfxSwayKind > 0.5 && !vfx_sway_uv(v_TexCoord, int(vfxSwayKind), vfxSwayCorner, vfxGrassSky, vfxPos, u_TexelSize, blockUv)) {
        discard;
    }
    #endif
    vec4 color = u_UseRGSS ? sampleRGSS(u_BlockTex, blockUv, u_TexelSize, blockDu, blockDv) : sampleNearest(u_BlockTex, blockUv, u_TexelSize, blockDu, blockDv, sqrt(blockDu * blockDu + blockDv * blockDv));
    if (color.a * vfxVertexColor.a < ALPHA_CUTOUT) {
        discard;
    }
}
#else
void main() {
    vfx_set_material(vfxMaterial);
    #if !defined(OIT_ALPHA_ONLY) && (defined(VFX_SHADOWS) || defined(VFX_REFLECT))
    vec3 normal = vfx_face_normal(vfxPos);
    #endif
    #if !defined(OIT_ALPHA_ONLY) && defined(VFX_SHADOWS)
    vec3 snapped = vfx_texel_snap(vfxPos, v_TexCoord, 1.0 / u_TexelSize);
    #endif
    vec2 blockUv = v_TexCoord;
    vec2 blockDu = dFdx(v_TexCoord);
    vec2 blockDv = dFdy(v_TexCoord);
    #ifdef VFX_SWAY
    if (vfxGrass > 0.5 && !vfx_grass_uv(v_TexCoord, int(vfxGrass) - 1, vfxGrassSky, vfxPos, u_TexelSize, blockUv)) {
        discard;
    }
    if (vfxSwayKind > 0.5 && !vfx_sway_uv(v_TexCoord, int(vfxSwayKind), vfxSwayCorner, vfxGrassSky, vfxPos, u_TexelSize, blockUv)) {
        discard;
    }
    #endif
    vec4 color = u_UseRGSS ? sampleRGSS(u_BlockTex, blockUv, u_TexelSize, blockDu, blockDv) : sampleNearest(u_BlockTex, blockUv, u_TexelSize, blockDu, blockDv, sqrt(blockDu * blockDu + blockDv * blockDv));
    #if defined(VFX_MARK) && !defined(OIT_ALPHA_ONLY)
    vec3 vfxAlbedo = color.rgb;
    #endif
    #if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY)
    vec3 vfxWaterTexel = color.rgb;
    #ifdef VFX_SHADOWS
    vec3 vfxWaterTint = vfxVertexColor.rgb * vfx_water_face(normal);
    #else
    vec3 vfxWaterTint = vfxVertexColor.rgb;
    #endif
    vec4 waterBase = vfx_water_color(color * vec4(vfxWaterTint, 1.0), vfxWaterTint, v_TexCoord, vfxPos, normal, u_ProjectionMatrix * u_ModelViewMatrix);
    if (waterBase != color * vec4(vfxWaterTint, 1.0)) {
        color = vec4(waterBase.rgb / max(vfxWaterTint, vec3(0.001)), waterBase.a);
    }
    #endif
    #if defined(ALPHA_CUTOUT) && !defined(OIT_ALPHA_ONLY) && !defined(VFX_REFLECT) && defined(VFX_SHADOWS)
    if (color.a * vfxVertexColor.a < VFX_CUTOUT) {
        discard;
    }
    #endif
    #ifndef OIT_ALPHA_ONLY
    #ifdef VFX_SHADOWS
    #ifdef ALPHA_CUTOUT
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, vfx_foliage(v_TexCoord));
    #else
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, false);
    #endif
    #ifdef VFX_REFLECT
    if (WaterGlint.w > 0.5 && vfx_is_water(vfxVertexColor.rgb, v_TexCoord)) {
        vfx_water_surface_glint(vfxWaterTexel, textureLod(u_BlockTex, v_TexCoord, 4.0).rgb, vfxPos, normal, shade, vfxLm.y);
    } else
    #endif
    vfx_block_glint(u_BlockTex, v_TexCoord, color.rgb, vfxVertexColor.rgb * vfx_mesh_unshade(normal), vfxPos, normal, shade, vfxLm.y);
    #ifdef VFX_ENHANCED
    #ifdef ALPHA_CUTOUT
    vfx_water_shadow(vfxPos, vfx_foliage(v_TexCoord));
    #else
    vfx_water_shadow(vfxPos, false);
    #endif
    color = vec4(vfx_enhanced_color(color.rgb * vfxVertexColor.rgb * vfx_mesh_unshade(normal), vfxLm, normal, shade, vfx_self_lit(v_TexCoord, color.rgb)), color.a * vfxVertexColor.a);
    #else
    bool vfxGlow = WaterParams.w > 0.0 && vfx_self_lit(v_TexCoord, color.rgb);
    color *= vfx_shadow_light(v_Color, vfxShadeColor, shade, 0.0, normal.y);
    color.rgb *= vfx_vanilla_unshade(normal, shade);
    color.rgb = vfx_glint_display(vfx_water_plain_grade(color.rgb, vfxPos, vfxGlow));
    #endif
    #else
    color *= v_Color;
    #endif
    #ifdef VFX_REFLECT
    color.rgb = vfx_reflection(color.rgb, vfxPos, normal, u_FogColor.rgb, vfxWaterTint, v_TexCoord, vfxLm, u_ProjectionMatrix * u_ModelViewMatrix);
    if (vfxBelowActive) {
        color.rgb = vfxBelowColor;
    }
    #endif
    #else
    color *= v_Color;
    #endif

#ifdef ALPHA_CUTOUT
    if (color.a < VFX_CUTOUT) {
        discard;
    }
#endif

    #ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
    #else
    fragColor = calculateFinalColor(color);
    #if defined(VFX_MARK) && !defined(OIT_ACCUMULATE)
    fragColor.rgb = vfx_emissive_color(v_TexCoord, vfxAlbedo, fragColor.rgb);
    fragColor.a = vfx_emissive_alpha(v_TexCoord, vfxAlbedo);
    #endif
    #endif
}
#endif
