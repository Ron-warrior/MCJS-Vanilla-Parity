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

#ifdef DISSOLVE
uniform sampler2D DissolveMaskSampler;
#endif

#ifdef GLINT
uniform sampler2D GlintSampler;
#endif

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
#ifdef PER_FACE_LIGHTING
layout(location = 2) in vec4 vertexPerFaceColorBack;
layout(location = 3) in vec4 vertexPerFaceColorFront;
#else
layout(location = 2) in vec4 vertexColor;
#endif

#ifndef EMISSIVE
layout(location = 4) in vec4 lightMapColor;
layout(location = 10) in vec4 vfxLightShade;
layout(location = 11) in float vfxSkyWeight;
layout(location = 12) in vec2 vfxLm;
layout(location = 13) in vec4 vfxRawColor;
#endif

#ifndef NO_OVERLAY
layout(location = 5) in vec4 overlayColor;
#endif

layout(location = 6) in vec2 texCoord0;
#ifdef GLINT
layout(location = 7) in vec2 texCoordGlint;
#endif
layout(location = 8) in vec3 vfxPos;
layout(location = 9) in vec3 vfxNormal;

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;
#endif

float vfxShade = 0.0;
vec3 vfxLitNormal = vec3(0.0, 1.0, 0.0);
vec3 vfxBodyAlbedo = vec3(1.0);

vec4 calculateFinalColor(vec4 color) {
    #ifndef NO_OVERLAY
    color.rgb = mix(overlayColor.rgb, color.rgb, overlayColor.a);
    #endif

    #ifndef EMISSIVE
    if (vfx_water_realistic() && ShadowSun.w > 0.5) {
        vec3 albedo = vfxBodyAlbedo;
        #ifndef NO_OVERLAY
        albedo = mix(overlayColor.rgb, albedo, overlayColor.a);
        #endif
        vfx_water_shadow(vfxPos, false);
        vfxBodyLight = true;
        color.rgb = vfx_enhanced_color(albedo, vfxLm, vfxLitNormal, vfxShade);
    } else {
        color *= vfx_shadow_light(lightMapColor, vfxLightShade, vfxShade, vfxSkyWeight);
    }
    #endif

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

void main() {
    #if !defined(EMISSIVE) && !defined(OIT_ALPHA_ONLY)
    vec3 snapped = vfx_texel_snap(vfxPos, texCoord0, vec2(textureSize(Sampler0, 0)));
    vec3 faceNormal = vfx_face_normal(vfxPos);
    vec3 normal = faceNormal;
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
    #if !defined(EMISSIVE) && !defined(OIT_ALPHA_ONLY)
    vfxBodyAlbedo = color.rgb * vfxRawColor.rgb * ColorModulator.rgb;
    #endif

    #ifdef OIT_ADDITIVE
    color.a = min(0.99, color.a);
    #endif

    #ifdef ALPHA_CUTOUT
    if (color.a < ALPHA_CUTOUT) {
        discard;
    }
    #endif

    #ifdef PER_FACE_LIGHTING
    vec4 faceVertexColor = gl_FrontFacing ? vertexPerFaceColorFront : vertexPerFaceColorBack;
    #else
    vec4 faceVertexColor = vertexColor;
    #endif

    #ifdef DISSOLVE
    if (faceVertexColor.a < texture(DissolveMaskSampler, texCoord0).a) {
        discard;
    }
    faceVertexColor.a = 1.0;
    #endif

    color *= faceVertexColor * ColorModulator;

    #ifdef GLINT
    color.a = max(color.a, GlintAlpha);
    #endif

    #ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
    #else
    fragColor = calculateFinalColor(color);
    #if defined(VFX_HAND) && !defined(EMISSIVE) && !defined(OIT_ACCUMULATE)
    fragColor.rgb = vfx_hand_finish(fragColor.rgb, vfxPos, vfxLitNormal, vfxShade, vfxLm.y);
    #endif
    #endif
}
