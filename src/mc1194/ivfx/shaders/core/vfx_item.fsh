#version 330
#extension GL_ARB_separate_shader_objects : require

#ifdef GLINT
#include <minecraft:globals.glsl>
#endif
#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:oit.glsl>
#include <immersivevfx:vfx_shadow.glsl>

uniform sampler2D Sampler0;

#ifdef GLINT
uniform sampler2D GlintSampler;
#endif

#ifndef OIT_ALPHA_ONLY
layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
#endif
layout(location = 2) in vec4 vertexColor;
#ifndef OIT_ALPHA_ONLY
layout(location = 3) in vec4 lightMapColor;
layout(location = 4) in vec4 overlayColor;
layout(location = 7) in vec4 vfxLightShade;
layout(location = 8) in float vfxSkyWeight;
layout(location = 9) in vec2 vfxLm;
layout(location = 10) in vec4 vfxRawColor;
layout(location = 11) in vec3 vfxPos;
layout(location = 12) in vec3 vfxNormal;
layout(location = 13) flat in uint vfxItemMaterial;
#endif
layout(location = 5) in vec2 texCoord0;
#ifdef GLINT
layout(location = 6) in vec2 texCoordGlint;
#endif

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;

float vfxShade = 0.0;
vec3 vfxLitNormal = vec3(0.0, 1.0, 0.0);
vec3 vfxBodyAlbedo = vec3(1.0);
vec3 vfxItemTexel = vec3(0.0);
bool vfxBlockAtlas = false;

vec4 calculateFinalColor(vec4 color) {
    color.rgb = mix(overlayColor.rgb, color.rgb, overlayColor.a);
    if (ShadowSun.w > 0.5) {
        vfx_water_shadow(vfxPos, false);
        vfxBodyLight = true;
        color.rgb = vfx_enhanced_color(mix(overlayColor.rgb, vfxBodyAlbedo, overlayColor.a), vfxHandGlow ? vec2(1.0, vfxLm.y) : vfxLm, vfxLitNormal, vfxShade, vfxHandGlow);
    } else if (vfxHandGlow) {
        color.rgb = vfxBodyAlbedo;
    } else {
        color *= vfx_shadow_light(lightMapColor, vfxLightShade, vfxShade, vfxSkyWeight);
    }

    #ifdef GLINT
    vec4 glintColor = GlintAlpha * texture(GlintSampler, texCoordGlint);
    color.rgb += glintColor.rgb * glintColor.rgb;
    #endif

    #ifdef OIT_ACCUMULATE
    color = sampleColorForAccumulation(color);
    vec4 fogColor = vec4(FogColor.rgb * color.a, FogColor.a);
    #else
    vec4 fogColor = FogColor;
    #endif

    return apply_fog(color, sphericalVertexDistance, cylindricalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd, fogColor);
}
#endif

void main() {
    #ifndef OIT_ALPHA_ONLY
    vfx_set_material(64u | (vfxItemMaterial & 48u));
    vec3 snapped = vfx_texel_snap(vfxPos, texCoord0, vec2(textureSize(Sampler0, 0)));
    vec3 normal = vfx_face_normal(vfxPos);
    if (dot(vfxNormal, vfxNormal) > 0.0001) {
        normal = gl_FrontFacing ? normalize(vfxNormal) : -normalize(vfxNormal);
    }
    #ifdef VFX_HAND
    snapped *= 0.2 + 0.8 * vfxLm.y;
    #endif
    vfxShade = vfx_shadow_amount(vfxPos, snapped, normal, false);
    vfxLitNormal = normal;
    #endif

    vec4 color = texture(Sampler0, texCoord0);
    #ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) {
        discard;
    }
    #endif

    #ifndef OIT_ALPHA_ONLY
    vfxBodyAlbedo = color.rgb * vfxRawColor.rgb * ColorModulator.rgb;
    vfxItemTexel = color.rgb;
    vfxBlockAtlas = (vfxItemMaterial & 1u) != 0u && LookExtra.z > 0.5;
    #ifdef VFX_HAND
    float vfxSideLevel = (ModelViewMat * vec4(vfxPos, 1.0)).x > 0.0 ? HandLevels.x : HandLevels.y;
    vfxHandGlow = vfxBlockAtlas ? vfx_self_lit(texCoord0, vfxItemTexel) : vfxSideLevel > 0.0 && max(vfxItemTexel.r, max(vfxItemTexel.g, vfxItemTexel.b)) > 0.63;
    #else
    vfxHandGlow = vfxBlockAtlas && vfx_self_lit(texCoord0, vfxItemTexel);
    #endif
    #endif

    color *= vertexColor * ColorModulator;

    #ifdef GLINT
    color.a = max(color.a, GlintAlpha);
    #endif

    #ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
    #else
    fragColor = calculateFinalColor(color);
    #ifndef OIT_ACCUMULATE
    if (vfxBlockAtlas) {
        fragColor.rgb = vfx_emissive_color(texCoord0, vfxItemTexel, fragColor.rgb);
    }
    #ifdef VFX_HAND
    fragColor.rgb = vfx_hand_finish(fragColor.rgb, vfxPos, vfxLitNormal, vfxShade, vfxLm.y);
    #endif
    #ifdef VFX_ITEM_MARK
    if (vfxBlockAtlas ? vfx_emissive_alpha(texCoord0, vfxItemTexel) > 0.51 : vfxHandGlow) {
        fragColor.a = vfxBlockAtlas ? vfx_emissive_alpha(texCoord0, vfxItemTexel) : 0.625;
    }
    #endif
    #endif
    #endif
}
