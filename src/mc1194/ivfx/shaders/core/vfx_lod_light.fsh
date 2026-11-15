#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <immersivevfx:vfx_shadow.glsl>

uniform sampler2D Sampler0;
uniform sampler2D LodDepth;
uniform sampler2D LodLightmap;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

bool lodPosition(ivec2 p, ivec2 size, out vec3 position) {
    p = clamp(p, ivec2(0), size - 1);
    float depth = texelFetch(LodDepth, p, 0).r;
    if (depth <= 0.0) {
        position = vec3(0.0);
        return false;
    }
    vec2 ndc = (vec2(p) + 0.5) / vec2(size) * 2.0 - 1.0;
    vec4 point = ModelViewMat * vec4(ndc, ColorModulator.y > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    position = point.xyz / point.w;
    return true;
}

vec3 lodEdge(vec3 center, vec3 plus, bool hasPlus, vec3 minus, bool hasMinus, out bool valid) {
    valid = hasPlus || hasMinus;
    if (hasPlus && (!hasMinus || length(plus - center) <= length(center - minus))) {
        return plus - center;
    }
    return center - minus;
}

void main() {
    ivec2 size = textureSize(LodDepth, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 source = texelFetch(Sampler0, p, 0);
    if (abs(source.a - ColorModulator.z) < 0.03 || abs(source.a - ColorModulator.z * 1.25) < 0.03 || abs(source.a - 0.988) < 0.006) {
        discard;
    }
    vec3 position;
    if (!lodPosition(p, size, position)) {
        discard;
    }
    float cylindrical = max(length(position.xz), abs(position.y));
    if (cylindrical < ColorModulator.x * 0.5) {
        discard;
    }
    float fog = total_fog_value(length(position), cylindrical, FogEnvironmentalStart, FogEnvironmentalEnd, FogRenderDistanceStart, FogRenderDistanceEnd) * FogColor.a;
    if (fog > 0.98) {
        discard;
    }
    vec3 right;
    vec3 left;
    vec3 up;
    vec3 down;
    bool hasRight = lodPosition(p + ivec2(1, 0), size, right);
    bool hasLeft = lodPosition(p - ivec2(1, 0), size, left);
    bool hasUp = lodPosition(p + ivec2(0, 1), size, up);
    bool hasDown = lodPosition(p - ivec2(0, 1), size, down);
    bool validX;
    bool validY;
    vec3 dx = lodEdge(position, right, hasRight, left, hasLeft, validX);
    vec3 dy = lodEdge(position, up, hasUp, down, hasDown, validY);
    if (!validX || !validY) {
        discard;
    }
    vec3 normal = cross(dx, dy);
    float normalLength = length(normal);
    if (normalLength < 1.0e-8) {
        discard;
    }
    normal /= normalLength;
    if (dot(normal, position) > 0.0) {
        normal = -normal;
    }
    vec3 axis = abs(normal);
    float dominant = max(axis.x, max(axis.y, axis.z));
    if (dominant < 0.9) {
        discard;
    }
    normal = axis.y == dominant ? vec3(0.0, sign(normal.y), 0.0) : axis.x == dominant ? vec3(sign(normal.x), 0.0, 0.0) : vec3(0.0, 0.0, sign(normal.z));
    vec3 lit = max((source.rgb - fog * FogColor.rgb) / (1.0 - fog), vec3(0.0));
    vec3 skyLight = texelFetch(LodLightmap, ivec2(0, 15), 0).rgb;
    vec3 base = lit / max(skyLight, vec3(0.02));
    if (any(greaterThan(base, vec3(1.02)))) {
        discard;
    }
    float shade = vfx_shadow_amount(position, position, normal, false);
    vec3 relit = vfx_enhanced_color(base * vfx_vanilla_unshade(normal), vec2(0.0, 1.0), normal, shade);
    fragColor = vec4(mix(relit, FogColor.rgb, fog), 1.0);
}
