#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:oit.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
layout(location = 2) in vec2 texCoord0;
layout(location = 3) in vec4 vertexColor;

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;
#endif

#ifdef VFX_PARTICLE_LIGHT
#include <immersivevfx:vfx_shadow.glsl>
layout(location = 6) in vec3 vfxPos;
layout(location = 7) in vec2 vfxLm;
layout(location = 8) in vec4 vfxRaw;
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
    vec4 color = texture(Sampler0, texCoord0) * vertexColor * ColorModulator;
    if (color.a < 0.1) {
        discard;
    }
    #if defined(VFX_PARTICLE_LIGHT) && !defined(OIT_ALPHA_ONLY)
    if (vfx_water_realistic()) {
        vec3 base = (texture(Sampler0, texCoord0) * vfxRaw * ColorModulator).rgb;
        if (abs(base.r - base.g) < 0.002 && base.r - 0.5 * base.b < 0.06) {
            vec3 inverted = 1.0 - base;
            inverted *= inverted;
            base = (1.0 - inverted * inverted) * 0.35;
            if (fract(vfxPos.y + WaterOrigin.z) > 0.25) {
                discard;
            }
        }
        vfxBelowSurface = vfxPos.y < WaterParams.w;
        float shade = vfx_shadow_amount(vfxPos, vfxPos, vec3(0.0, 1.0, 0.0), true);
        fragColor = vec4(vfx_enhanced_color(base, vfxLm, vec3(0.0, 1.0, 0.0), shade), 0.0);
        return;
    }
    #endif
    #ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
    #else
    fragColor = calculateFinalColor(color);
    #ifndef OIT_ACCUMULATE
    float peak = max(color.r, max(color.g, color.b));
    float low = min(color.r, min(color.g, color.b));
    fragColor.a = peak > 0.62 && peak - low > 0.3 ? 0.625 : 0.0;
    #endif
    #endif
}
