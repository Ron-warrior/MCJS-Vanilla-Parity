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

vec4 finish(vec4 color) {
#ifdef OIT_ACCUMULATE
    return sampleColorForAccumulation(color);
#else
    return color;
#endif
}

void main() {
    vec4 color = texture(Sampler0, texCoord0) * vertexColor * ColorModulator;
    float fog = linear_fog_value(sphericalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd) * FogColor.a;
#ifdef OIT_ALPHA_ONLY
    if (color.a < 0.002) {
        discard;
    }
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
#elif defined(ADDITIVE)
    vec3 light = color.rgb * color.a * (1.0 - fog);
    if (max(light.r, max(light.g, light.b)) < 0.0004) {
        discard;
    }
#ifdef OIT_ACCUMULATE
    fragColor = finish(vec4(light, 1.0));
#elif defined(VFX_LIGHT_RAY)
    fragColor = vec4(light, color.a * (1.0 - fog));
#else
    fragColor = vec4(light, max(light.r, max(light.g, light.b)) > 0.5 ? 0.625 : 0.0);
#endif
#elif defined(CUTOUT)
    if (color.a < 0.5) {
        discard;
    }
    fragColor = vec4(mix(color.rgb, FogColor.rgb, fog), 1.0);
#else
    if (color.a < 0.002) {
        discard;
    }
    fragColor = finish(vec4(mix(color.rgb, FogColor.rgb, fog), color.a));
#endif
}
