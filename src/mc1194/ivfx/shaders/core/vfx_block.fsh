#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:oit.glsl>
#include <immersivevfx:vfx_shadow.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
layout(location = 2) in vec4 vertexColor;
layout(location = 3) in vec2 texCoord0;
layout(location = 4) in vec3 vfxPos;
layout(location = 5) in vec4 vfxLightLit;
layout(location = 6) in vec4 vfxLightShade;
layout(location = 7) in float vfxSkyWeight;
layout(location = 8) in vec2 vfxLm;
layout(location = 9) flat in uint vfxMaterial;

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
    #if defined(VFX_SHADOWS) && !defined(OIT_ALPHA_ONLY)
    vec3 normal = vfx_face_normal(vfxPos);
    vec3 snapped = vfx_texel_snap(vfxPos, texCoord0, vec2(textureSize(Sampler0, 0)));
    #if defined(ALPHA_CUTOUT) && defined(VFX_MARK)
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, vfx_foliage(texCoord0));
    #elif defined(ALPHA_CUTOUT)
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, true);
    #else
    float shade = vfx_shadow_amount(vfxPos, snapped, normal, false);
    #endif
    #endif
    vec4 color = texture(Sampler0, texCoord0);
    vec3 vfxTexel = color.rgb;
    #if defined(VFX_MARK) && !defined(OIT_ALPHA_ONLY)
    vec3 vfxAlbedo = color.rgb;
    #endif
    color *= vertexColor;
    #ifndef OIT_ALPHA_ONLY
    #ifdef VFX_SHADOWS
    vfx_block_glint(Sampler0, texCoord0, vfxTexel, vertexColor.rgb * vfx_mesh_unshade(normal), vfxPos, normal, shade, vfxLm.y);
    if (ShadowSun.w > 0.5) {
        color.rgb = vfx_enhanced_color(color.rgb * vfx_mesh_unshade(normal), vfxLm, normal, shade, vfx_self_lit(texCoord0, vfxTexel));
    } else {
        bool vfxGlow = WaterParams.w > 0.0 && vfx_self_lit(texCoord0, vfxTexel);
        color *= vfx_shadow_light(vfxLightLit, vfxLightShade, shade, vfxSkyWeight, normal.y);
        color.rgb *= vfx_vanilla_unshade(normal, shade);
        color.rgb = vfx_glint_display(vfx_water_plain_grade(color.rgb, vfxPos, vfxGlow));
    }
    #else
    color *= vfxLightLit;
    #endif
    #endif
    color *= ColorModulator;
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
