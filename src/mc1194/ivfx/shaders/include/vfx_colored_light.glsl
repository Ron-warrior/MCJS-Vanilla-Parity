#ifndef IMMERSIVEVFX_COLORED_LIGHT_GLSL
#define IMMERSIVEVFX_COLORED_LIGHT_GLSL

layout(std140) uniform VfxLight {
    mat4 LightClipToWorld;
    vec4 LightCornerA;
    vec4 LightCornerB;
    vec4 LightParams;
    vec4 LightHeld;
    vec4 LightHeldPos;
    vec4 LightFarCornerA;
    vec4 LightFarCornerB;
};

uniform sampler2D LightDepth;
uniform sampler2D LightVolumeA;
uniform sampler2D LightVolumeB;
uniform sampler2D LightFarVolumeA;
uniform sampler2D LightFarVolumeB;

const vec3 VFX_LIGHT_SIZE = vec3(96.0, 48.0, 96.0);
const vec2 VFX_LIGHT_ATLAS = vec2(768.0, 576.0);
const vec3 VFX_LIGHT_LUMA = vec3(0.299, 0.587, 0.114);
const float VFX_LIGHT_FAR_CELL = 4.0;

vec3 vfx_light_position(vec2 uv, float depth) {
    vec4 point = LightClipToWorld * vec4(uv * 2.0 - 1.0, LightParams.w > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    return point.xyz / point.w;
}

vec3 vfx_light_neighbour(ivec2 pixel, ivec2 offset, vec2 uv, vec2 texel, float own) {
    float depth = texelFetch(LightDepth, pixel + offset, 0).r;
    return vfx_light_position(uv + vec2(offset) * texel, depth > 0.0 ? depth : own);
}

vec4 vfx_light_slice(sampler2D volume, float y, vec2 xz) {
    if (y < 0.0 || y > VFX_LIGHT_SIZE.y - 1.0) {
        return vec4(0.0);
    }
    vec2 tile = vec2(mod(y, 8.0), floor(y / 8.0)) * VFX_LIGHT_SIZE.xz;
    vec2 inside = clamp(xz, vec2(0.5), VFX_LIGHT_SIZE.xz - 0.5);
    return texture(volume, (tile + inside) / VFX_LIGHT_ATLAS);
}

bool vfx_light_source(sampler2D volume, vec3 local) {
    ivec3 own = ivec3(floor(local));
    if (any(lessThan(own, ivec3(0))) || any(greaterThanEqual(own, ivec3(VFX_LIGHT_SIZE)))) {
        return false;
    }
    ivec2 at = ivec2(own.y % 8, own.y / 8) * ivec2(VFX_LIGHT_SIZE.xz) + own.xz;
    return (int(texelFetch(volume, at, 0).a * 255.0 + 0.5) & 1) == 1;
}

float vfx_light_edge(vec3 cell) {
    vec3 border = min(cell, VFX_LIGHT_SIZE - cell);
    return smoothstep(0.0, 8.0, min(min(border.x, border.z), border.y * 2.0));
}

vec3 vfx_light_at(sampler2D volume, vec3 cell) {
    float y = cell.y - 0.5;
    float y0 = floor(y);
    vec4 light = mix(vfx_light_slice(volume, y0, cell.xz), vfx_light_slice(volume, y0 + 1.0, cell.xz), y - y0);
    float sky = clamp(light.a * 255.0 / 254.0, 0.0, 1.0);
    return light.rgb * (1.0 - 0.85 * sky * LightParams.x);
}

vec3 vfx_light_far(vec3 position, vec3 normal) {
    vec3 front = position + normal * 0.5 * VFX_LIGHT_FAR_CELL;
    float weightB = LightFarCornerB.w;
    vec3 light = vec3(0.0);
    if (weightB < 0.999) {
        vec3 cell = (front - LightFarCornerA.xyz) / VFX_LIGHT_FAR_CELL;
        light += vfx_light_at(LightFarVolumeA, cell) * vfx_light_edge(cell) * (1.0 - weightB);
    }
    if (weightB > 0.001) {
        vec3 cell = (front - LightFarCornerB.xyz) / VFX_LIGHT_FAR_CELL;
        light += vfx_light_at(LightFarVolumeB, cell) * vfx_light_edge(cell) * weightB;
    }
    return light;
}

vec3 vfx_colored_light(vec3 color, ivec2 pixel, vec2 uv) {
    float depth = texelFetch(LightDepth, pixel, 0).r;
    if (depth <= 0.0) {
        return color;
    }
    vec3 position = vfx_light_position(uv, depth);
    vec3 range = LightFarCornerA.w > 0.5 ? VFX_LIGHT_SIZE * VFX_LIGHT_FAR_CELL * 0.5 : vec3(60.0, 40.0, 60.0);
    if (any(greaterThan(abs(position), range))) {
        return color;
    }
    vec2 texel = 1.0 / vec2(textureSize(LightDepth, 0));
    vec3 left = vfx_light_neighbour(pixel, ivec2(-1, 0), uv, texel, depth);
    vec3 right = vfx_light_neighbour(pixel, ivec2(1, 0), uv, texel, depth);
    vec3 down = vfx_light_neighbour(pixel, ivec2(0, -1), uv, texel, depth);
    vec3 up = vfx_light_neighbour(pixel, ivec2(0, 1), uv, texel, depth);
    vec3 dx = distance(right, position) < distance(position, left) ? right - position : position - left;
    vec3 dy = distance(up, position) < distance(position, down) ? up - position : position - down;
    vec3 normal = cross(dx, dy);
    if (dot(normal, position) > 0.0) {
        normal = -normal;
    }
    vec3 a = abs(normal);
    normal = a.x > a.y && a.x > a.z ? vec3(sign(normal.x), 0.0, 0.0) : (a.y > a.z ? vec3(0.0, sign(normal.y), 0.0) : vec3(0.0, 0.0, sign(normal.z)));
    float weightB = LightCornerB.w;
    vec3 inside = position - normal * 0.05;
    if ((weightB < 0.99 && vfx_light_source(LightVolumeA, inside - LightCornerA.xyz)) || (weightB > 0.01 && vfx_light_source(LightVolumeB, inside - LightCornerB.xyz))) {
        return color;
    }
    vec3 front = position + normal * 0.5;
    vec3 light = vec3(0.0);
    float covered = 0.0;
    if (weightB < 0.999) {
        vec3 cell = front - LightCornerA.xyz;
        float edge = vfx_light_edge(cell) * (1.0 - weightB);
        if (edge > 0.0) {
            light += vfx_light_at(LightVolumeA, cell) * edge;
            covered += edge;
        }
    }
    if (weightB > 0.001) {
        vec3 cell = front - LightCornerB.xyz;
        float edge = vfx_light_edge(cell) * weightB;
        if (edge > 0.0) {
            light += vfx_light_at(LightVolumeB, cell) * edge;
            covered += edge;
        }
    }
    if (covered < 0.999 && LightFarCornerA.w > 0.5) {
        light += vfx_light_far(position, normal) * (1.0 - covered);
    }
    if (LightHeld.w > 0.0) {
        float near = 1.0 - clamp(length(front - LightHeldPos.xyz) / LightHeldPos.w, 0.0, 1.0);
        light = max(light, LightHeld.rgb * LightHeld.w * near);
    }
    float strength = max(light.r, max(light.g, light.b));
    if (strength <= 0.002) {
        return color;
    }
    vec3 hue = clamp(1.0 - (1.0 - light / strength) * 1.25 * LightParams.y, 0.0, 1.0);
    float luma = dot(color, VFX_LIGHT_LUMA);
    vec3 tinted = hue * (luma / max(dot(hue, VFX_LIGHT_LUMA), 0.3));
    float boost = strength * 1.25 * LightParams.z;
    color = mix(color, clamp(tinted, 0.0, 1.0), min(1.0, boost));
    color += color * hue * min(boost, 2.5) * 1.5 * (1.0 - color) + hue * boost * 0.03;
    return clamp(color, 0.0, 1.0);
}

#endif
