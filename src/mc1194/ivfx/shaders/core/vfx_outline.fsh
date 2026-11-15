#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <minecraft:fog.glsl>
#include <minecraft:projection.glsl>

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

float depthAt(ivec2 p, ivec2 size) {
    return texelFetch(Sampler0, clamp(p, ivec2(0), size - 1), 0).r;
}

void main() {
    ivec2 size = textureSize(Sampler0, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    float d0 = texelFetch(Sampler0, p, 0).r;
    if (d0 <= 0.0) {
        discard;
    }
    bool mob = texelFetch(Sampler1, p, 0).a > 0.98;
    int r = int((mob ? ColorModulator.y : ColorModulator.x) + 0.5);
    float strength = mob ? ColorModulator.w : ColorModulator.z;
    if (r <= 0 || strength <= 0.0) {
        discard;
    }
    float e = 2.0 * d0 - depthAt(p + ivec2(r, 0), size) - depthAt(p - ivec2(r, 0), size);
    e = max(e, 2.0 * d0 - depthAt(p + ivec2(0, r), size) - depthAt(p - ivec2(0, r), size));
    e = max(e, 2.0 * d0 - depthAt(p + ivec2(r, r), size) - depthAt(p - ivec2(r, r), size));
    e = max(e, 2.0 * d0 - depthAt(p + ivec2(r, -r), size) - depthAt(p - ivec2(r, -r), size));
    float forward = ProjMat[3][2] / (d0 + ProjMat[2][2]);
    vec2 ndc = texCoord * 2.0 - 1.0;
    float distance = length(vec3(ndc.x * forward / ProjMat[0][0], ndc.y * forward / ProjMat[1][1], forward));
    float fog = total_fog_value(distance, distance, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd) * FogColor.a;
    float k = smoothstep(0.02, 0.08, e / d0) * strength * (1.0 - smoothstep(64.0, 160.0, distance)) * (1.0 - fog);
    if (k < 0.004) {
        discard;
    }
    fragColor = vec4(0.0, 0.0, 0.0, k);
}
