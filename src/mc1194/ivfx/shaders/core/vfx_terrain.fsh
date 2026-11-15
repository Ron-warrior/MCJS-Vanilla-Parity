#version 330
#extension GL_ARB_separate_shader_objects : require

#include <immersivevfx:vfx_terrain_locations.glsl>
#include <minecraft:fog.glsl>
#include <minecraft:globals.glsl>
#include <minecraft:texture_sampling.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:oit.glsl>
#include <minecraft:terrainglobals.glsl>
#include <immersivevfx:vfx_shadow.glsl>
#ifdef VFX_SWAY
#define VFX_GRASS_FRAGMENT
#include <immersivevfx:vfx_grass.glsl>
#endif
#ifndef MULTIDRAW_TERRAIN
    #include <minecraft:chunksection.glsl>
#endif

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
layout(location = 2) in vec4 vertexColor;
layout(location = 3) in vec2 texCoord0;
layout(location = 4) in float chunkVisibility;
layout(location = VFX_LOC_POS) in vec3 vfxPos;
layout(location = VFX_LOC_LIT) in vec4 vfxLightLit;
layout(location = VFX_LOC_SHADE) in vec4 vfxLightShade;
layout(location = VFX_LOC_MATERIAL) flat in uint vfxMaterial;
layout(location = VFX_LOC_LM) in vec2 vfxLm;
#ifdef VFX_SWAY
layout(location = VFX_LOC_GRASS) flat in float vfxGrass;
layout(location = VFX_LOC_SWAY) in vec2 vfxSwayCorner;
layout(location = VFX_LOC_SWAY_KIND) flat in float vfxSwayKind;
#endif

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;
#endif

vec4 calculateFinalColor(vec4 color) {
    #ifdef OIT_ACCUMULATE
    color = sampleColorForAccumulation(color);
    vec4 fogColor = vec4(FogColor.rgb * color.a, FogColor.a);
    #else
    vec4 fogColor = FogColor;
    #endif
    return apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, fogColor);
}

void main() {
    vfx_set_material(vfxMaterial);
    #ifdef VFX_REFLECT
    if (!vfxMaterialKnown) vfxMaterialValue = 7.0;
    #endif
    #if !defined(OIT_ALPHA_ONLY) && (defined(VFX_SHADOWS) || defined(VFX_REFLECT))
    vec3 normal = vfx_face_normal(vfxPos);
    #endif
    #if !defined(OIT_ALPHA_ONLY) && defined(VFX_SHADOWS)
    vec3 snapped = vfx_texel_snap(vfxPos, texCoord0, vec2(TextureSize));
    #endif
    #ifdef VFX_SWAY
    vec2 grassUv = texCoord0;
    if (vfxGrass > 0.5 && !vfx_grass_uv(texCoord0, int(vfxGrass) - 1, vfxLm.y, vfxPos, 1.0f / TextureSize, grassUv)) {
        discard;
    }
    if (vfxSwayKind > 0.5 && !vfx_sway_uv(texCoord0, int(vfxSwayKind), vfxSwayCorner, vfxLm.y, vfxPos, 1.0f / TextureSize, grassUv)) {
        discard;
    }
    vec2 grassDu = dFdx(texCoord0);
    vec2 grassDv = dFdy(texCoord0);
    vec4 color = (vfxGrass > 0.5 || vfxSwayKind > 0.5 ? sampleNearest(Sampler0, grassUv, 1.0f / TextureSize, grassDu, grassDv, sqrt(grassDu * grassDu + grassDv * grassDv))
            : UseRgss == 1 ? sampleRGSS(Sampler0, texCoord0, 1.0f / TextureSize) : sampleNearest(Sampler0, texCoord0, 1.0f / TextureSize)) * vertexColor;
    #else
    vec4 color = (UseRgss == 1 ? sampleRGSS(Sampler0, texCoord0, 1.0f / TextureSize) : sampleNearest(Sampler0, texCoord0, 1.0f / TextureSize)) * vertexColor;
    #endif
    vec3 vfxTexel = color.rgb / max(vertexColor.rgb, vec3(0.001));
    #if defined(VFX_MARK) && !defined(OIT_ALPHA_ONLY)
    vec3 vfxAlbedo = vfxTexel;
    #endif
    #if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY)
    vec3 vfxWaterTexel = color.rgb / max(vertexColor.rgb, vec3(0.001));
    #ifdef VFX_SHADOWS
    float vfxWaterFace = vfx_water_face(normal);
    #else
    float vfxWaterFace = 1.0;
    #endif
    vec3 vfxWaterTint = vertexColor.rgb * vfxWaterFace;
    vec4 vfxWaterIn = vec4(color.rgb * vfxWaterFace, color.a);
    vec4 vfxWaterOut = vfx_water_color(vfxWaterIn, vfxWaterTint, texCoord0, vfxPos, normal, ProjMat * ModelViewMat);
    if (vfxWaterOut != vfxWaterIn) {
        color = vec4(vfxWaterOut.rgb / vfxWaterFace, vfxWaterOut.a);
    }
    #endif
    #ifndef OIT_ALPHA_ONLY
    #ifdef VFX_SHADOWS
    #ifdef ALPHA_CUTOUT
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, vfx_foliage(texCoord0));
    #else
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, false);
    #endif
    #ifdef VFX_REFLECT
    if (WaterGlint.w > 0.5 && vfx_is_water(vertexColor.rgb, texCoord0)) {
        vfx_water_surface_glint(vfxWaterTexel, textureLod(Sampler0, texCoord0, 4.0).rgb, vfxPos, normal, shade, vfxLm.y);
    } else
    #endif
    vfx_block_glint(Sampler0, texCoord0, color.rgb / max(vertexColor.rgb, vec3(0.001)), vertexColor.rgb * vfx_mesh_unshade(normal), vfxPos, normal, shade, vfxLm.y);
    #ifdef VFX_ENHANCED
    #ifdef ALPHA_CUTOUT
    vfx_water_shadow(vfxPos, vfx_foliage(texCoord0));
    #else
    vfx_water_shadow(vfxPos, false);
    #endif
    color.rgb = vfx_enhanced_color(color.rgb * vfx_mesh_unshade(normal), vfxLm, normal, shade, vfx_self_lit(texCoord0, vfxTexel));
    #else
    bool vfxGlow = WaterParams.w > 0.0 && vfx_self_lit(texCoord0, vfxTexel);
    color *= vfx_shadow_light(vfxLightLit, vfxLightShade, shade, 0.0, normal.y);
    color.rgb *= vfx_vanilla_unshade(normal, shade);
    color.rgb = vfx_glint_display(vfx_water_plain_grade(color.rgb, vfxPos, vfxGlow));
    #endif
    #else
    color *= vfxLightLit;
    #endif
    #ifdef VFX_REFLECT
    color.rgb = vfx_reflection(color.rgb, vfxPos, normal, FogColor.rgb, vfxWaterTint, texCoord0, vfxLm, ProjMat * ModelViewMat);
    if (vfxBelowActive) {
        color.rgb = vfxBelowColor;
    }
    #endif
    color = mix(FogColor * vec4(1, 1, 1, color.a), color, chunkVisibility);
    #endif
    #ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) {
        discard;
    }
    #endif

    #ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
    #else
    fragColor = calculateFinalColor(color);
    #if defined(VFX_MARK) && !defined(OIT_ACCUMULATE)
    fragColor.rgb = vfx_emissive_color(texCoord0, vfxAlbedo, fragColor.rgb);
    fragColor.a = vfx_emissive_alpha(texCoord0, vfxAlbedo);
    #endif
    #endif
}
