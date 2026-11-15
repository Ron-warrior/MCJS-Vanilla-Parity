#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:globals.glsl>
#include <minecraft:oit.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in float cylindricalVertexDistance;
layout(location = 2) in vec2 texCoord0;
layout(location = 3) in vec4 vertexColor;
#ifdef FOAM
layout(location = 4) in float foamFade;
layout(location = 5) in float foamKind;
#endif

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;
#endif

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

float cells(vec2 p, float t) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 o = 0.5 + 0.4 * sin(t + 6.2831853 * hash2(i + g));
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

void main() {
    vec2 p = (floor(texCoord0 * 16.0) + 0.5) / 16.0;
    float t = GameTime * 1200.0;
    float fog = linear_fog_value(sphericalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd) * FogColor.a;
#ifdef CAUSTICS
    float c = cells(p * 0.75, t * 0.7) * 0.65 + cells(p * 1.35 + vec2(7.3, 2.9), t * 1.05) * 0.35;
    c = c * c * 1.3 + c * 0.15;
    vec3 light = vertexColor.rgb * vertexColor.a * c * (1.0 - fog);
    float strength = max(light.r, max(light.g, light.b));
    if (strength < 0.002) {
        discard;
    }
#ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, strength);
#elif defined(OIT_ACCUMULATE)
    fragColor = sampleColorForAccumulation(vec4(light, 1.0));
#else
    fragColor = vec4(light, 1.0);
#endif
#else
    int mask = int(vertexColor.a * 255.0 + 0.5);
    vec2 local = floor(fract(texCoord0) * 16.0);
    float lx = local.x;
    float ly = local.y;
    float d = 99.0;
    if ((mask & 1) != 0) d = min(d, ly);
    if ((mask & 2) != 0) d = min(d, 15.0 - lx);
    if ((mask & 4) != 0) d = min(d, 15.0 - ly);
    if ((mask & 8) != 0) d = min(d, lx);
    if ((mask & 16) != 0) d = min(d, max(15.0 - lx, ly));
    if ((mask & 32) != 0) d = min(d, max(15.0 - lx, 15.0 - ly));
    if ((mask & 64) != 0) d = min(d, max(lx, 15.0 - ly));
    if ((mask & 128) != 0) d = min(d, max(lx, ly));
    vec2 texel = floor(texCoord0 * 16.0);
    float along = (texel.x + texel.y) * 0.045;
    float phase = t * 1.25 + along;
    float wave = 0.5 + 0.5 * sin(phase);
    float jitter = step(0.55, fract(sin(floor((texel.x + texel.y) / 4.0) * 12.9898 + 1.7 * 78.233) * 43758.5453));
    float front = floor(2.0 + 4.0 * wave + jitter);
    float white = max(1.0, front - 2.0);
    vec3 color;
    float alpha;
    if (foamKind < 0.75) {
        float lavaWave = 0.5 + 0.5 * sin(t * 0.35 + along);
        float crust = floor(1.0 + 2.0 * lavaWave + jitter);
        float rim = crust + 1.0 + floor(lavaWave + 0.5);
        if (d < crust) {
            color = vec3(1.0, 0.96, 0.70);
            alpha = 0.95;
        } else if (d < rim) {
            color = vec3(1.0, 0.70, 0.18);
            alpha = 0.85;
        } else if (d < rim + 3.0 && fract(sin((texel.x + floor(t * 2.0) * 7.1) * 12.9898 + texel.y * 78.233) * 43758.5453) > 0.97) {
            color = vec3(1.0, 0.92, 0.55);
            alpha = 0.95;
        } else {
            discard;
        }
    } else if (d < white) {
        color = vec3(0.949, 0.980, 1.0);
        alpha = 0.85;
    } else if (d < front) {
        color = vec3(0.659, 0.847, 0.933);
        alpha = 0.62;
    } else if (cos(phase) < 0.0 && d >= 6.0 && d < 7.0
            && fract(sin(texel.x * 0.37 * 12.9898 + texel.y * 0.11 * 78.233 + 3.0) * 43758.5453) > (1.0 - wave) * 0.9 + 0.1) {
        color = vec3(0.847, 0.933, 0.973);
        alpha = 0.55;
    } else if (d < front + 3.0 && fract(sin((texel.x + floor(t * 3.0) * 7.1) * 12.9898 + texel.y * 78.233) * 43758.5453) > 0.965) {
        color = vec3(0.949, 0.980, 1.0);
        alpha = 0.8;
    } else {
        discard;
    }
    alpha *= foamFade;
    if (alpha < 0.004) {
        discard;
    }
#ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, alpha);
#else
    vec4 result = vec4(mix(foamKind > 0.75 ? color * vertexColor.rgb : color, FogColor.rgb, fog), alpha);
#ifdef OIT_ACCUMULATE
    fragColor = sampleColorForAccumulation(result);
#else
    fragColor = result;
#endif
#endif
#endif
}
