#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>
#include <immersivevfx:vfx_shadow_sky.glsl>
#include <immersivevfx:vfx_held_light.glsl>

layout(std140) uniform VfxGpuGrass {
    mat4 GpuGrassView;
    vec4 GpuGrassCamera;
    vec4 GpuGrassParams;
};

uniform sampler2D GpuGrassData;
uniform sampler2D GpuGrassTint;
uniform sampler2D GpuGrassLight;

layout(location = 0) out vec2 vfxGrassUv;
layout(location = 1) flat out vec3 vfxGrassBase;
layout(location = 2) flat out vec3 vfxGrassTintColor;
layout(location = 3) flat out vec2 vfxGrassLm;
layout(location = 4) flat out vec4 vfxGrassLit;
layout(location = 5) flat out vec4 vfxGrassShaded;
layout(location = 6) flat out float vfxGrassVariant;
layout(location = 7) out vec3 vfxPos;

const vec2 VFX_CORNERS[6] = vec2[](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
const float VFX_SPRITES = 4.0;

uint vfx_grass_seed(int x, int z, int blade) {
    uint h = uint(x) * 73856093u ^ uint(z) * 19349663u ^ uint(blade) * 83492791u;
    h ^= h >> 13u;
    h *= 1274126177u;
    h ^= h >> 16u;
    return h;
}

void vfx_hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vfxGrassUv = vec2(0.0);
    vfxGrassBase = vec3(0.0);
    vfxGrassTintColor = vec3(0.0);
    vfxGrassLm = vec2(0.0);
    vfxGrassLit = vec4(0.0);
    vfxGrassShaded = vec4(0.0);
    vfxGrassVariant = 0.0;
    vfxPos = vec3(0.0);
}

void main() {
    int radius = int(GpuGrassParams.x);
    int density = int(GpuGrassParams.y);
    int side = radius * 2 + 1;
    int cell = gl_InstanceIndex / density;
    int blade = gl_InstanceIndex % density;
    int offsetX = cell % side - radius;
    int offsetZ = cell / side - radius;
    float distance2 = float(offsetX * offsetX + offsetZ * offsetZ);
    if (distance2 > float(radius * radius)) {
        vfx_hide();
        return;
    }
    int worldX = int(GpuGrassCamera.x) + offsetX;
    int worldZ = int(GpuGrassCamera.y) + offsetZ;
    ivec2 texel = ivec2(worldX & 127, worldZ & 127);
    vec4 tint = texelFetch(GpuGrassTint, texel, 0);
    if (tint.a < 0.5) {
        vfx_hide();
        return;
    }
    float fade = 1.0 - smoothstep(float(radius) * 0.7, float(radius), sqrt(distance2));
    if (fade <= 0.01) {
        vfx_hide();
        return;
    }
    vec4 data = texelFetch(GpuGrassData, texel, 0);
    int surface = int(data.r * 255.0 + 0.5) + int(data.g * 255.0 + 0.5) * 256 - 2048;
    uint seed = vfx_grass_seed(worldX, worldZ, blade);
    float jitterX = float(seed & 255u) / 255.0;
    float jitterZ = float(seed >> 8u & 255u) / 255.0;
    float yaw = float(seed >> 16u & 255u) / 255.0 * 3.14159265;
    float size = float(seed >> 26u & 63u) / 63.0;
    float variant = float(seed >> 24u & 3u);
    vec3 base = vec3(float(offsetX) + 0.5 + (jitterX - 0.5) * 0.85 - GpuGrassCamera.z, float(surface) - GpuGrassParams.w, float(offsetZ) + 0.5 + (jitterZ - 0.5) * 0.85 - GpuGrassCamera.w);
    float scale = GpuGrassParams.z * (0.75 + 0.25 * size) * fade;
    vec2 corner = VFX_CORNERS[gl_VertexIndex];
    vec3 along = vec3(cos(yaw), 0.0, sin(yaw));
    vec3 position = base + along * (corner.x - 0.5) * scale + vec3(0.0, corner.y * scale, 0.0);
    gl_Position = ProjMat * GpuGrassView * vec4(position, 1.0);
    vfxGrassUv = vec2((variant + corner.x) / VFX_SPRITES, 1.0 - corner.y);
    vfxGrassBase = base + vec3(0.0, 0.5 * scale, 0.0);
    vfxGrassTintColor = tint.rgb;
    ivec2 light = ivec2(int(data.a * 255.0 + 0.5) / 17 * 16, int(data.b * 255.0 + 0.5) / 17 * 16);
    light = vfx_held_uv(light, base);
    vfxGrassLm = clamp(vec2(light) / 240.0, 0.0, 1.0);
    vfxGrassLit = sample_lightmap(GpuGrassLight, light);
    vfxGrassShaded = sample_lightmap(GpuGrassLight, vfx_shadow_sky(light));
    vfxGrassVariant = variant;
    vfxPos = position;
}
