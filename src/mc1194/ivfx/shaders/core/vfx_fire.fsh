#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:globals.glsl>
#include <minecraft:oit.glsl>

layout(location = 0) in float sphericalVertexDistance;
layout(location = 1) in vec2 texCoord0;
layout(location = 2) in vec4 vertexColor;
layout(location = 3) flat in ivec2 fireInfo;

#ifndef OIT_ALPHA_ONLY
layout(location = 0) out vec4 fragColor;
#endif

float fireHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float fireNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(fireHash(i), fireHash(i + vec2(1.0, 0.0)), f.x), mix(fireHash(i + vec2(0.0, 1.0)), fireHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec4 smoke(vec2 uv, float pixels, vec4 color) {
    vec2 c = (floor(uv) + 0.5) / pixels * 2.0 - 1.0;
    float d = dot(c, c);
    if (d > 1.0) {
        return vec4(0.0);
    }
    float shade = 1.0 - c.y * 0.2 - d * 0.12;
    return vec4(color.rgb * shade, color.a);
}

vec4 mist(vec2 uv, float pixels, vec4 color) {
    vec2 c = (floor(uv) + 0.5) / pixels * 2.0 - 1.0;
    float d = dot(c, c);
    if (d > 1.0) {
        return vec4(0.0);
    }
    float body = d < 0.6 ? 1.0 : 0.7;
    return vec4(color.rgb * (1.0 + c.y * 0.12), color.a * body);
}

vec4 texelValue(vec2 uv, vec2 cell, vec4 value) {
    vec2 dx = dFdx(uv);
    vec2 dy = dFdy(uv);
    float det = dx.x * dy.y - dx.y * dy.x;
    if (abs(det) < 0.000001) {
        return value;
    }
    vec4 du = (dFdx(value) * dy.y - dFdy(value) * dx.y) / det;
    vec4 dv = (dFdy(value) * dx.x - dFdx(value) * dy.x) / det;
    vec2 offset = cell + 0.5 - uv;
    return value + du * offset.x + dv * offset.y;
}

vec4 foam(vec2 uv, vec4 color, float t) {
    vec2 cell = floor(uv);
    vec4 flat_color = texelValue(uv, cell, color);
    float s = floor(t * 6.0) / 6.0 * 0.12;
    float value = fireNoise(cell / 9.0 + vec2(s, s * 0.6)) * 0.8 + fireNoise(cell / 4.0 + vec2(11.0 - s * 1.3, 5.0 + s)) * 0.2;
    float left = value - (1.0 - flat_color.a);
    if (left < 0.0) {
        return vec4(0.0);
    }
    if (left > 0.22) {
        return vec4(flat_color.rgb, 0.95);
    }
    return left > 0.08 ? vec4(flat_color.rgb * 0.88, 0.8) : vec4(flat_color.rgb * 0.76, 0.5);
}

vec4 pool(vec2 uv, vec4 color, float t) {
    vec2 cell = floor(uv);
    vec4 value = texelValue(uv, cell, color);
    float d = value.a;
    if (d >= 1.0) {
        return vec4(0.0);
    }
    float wave = fract(d * 6.0 - t * 0.55);
    if (wave < 0.11 && fireNoise(cell / 5.0) > 0.32) {
        return vec4(value.rgb * 0.92, 0.42 * smoothstep(0.0, 0.3, 1.0 - d));
    }
    return vec4(0.0);
}

vec4 sheet(vec2 uv, vec4 color, float t) {
    vec2 cell = floor(uv);
    float lane = fireHash(vec2(cell.x, 17.0));
    float y = cell.y + floor(t * (26.0 + lane * 18.0));
    float amount = fireNoise(vec2(cell.x / 1.6, y / 11.0)) * 0.75 + fireHash(vec2(cell.x, floor(y / 3.0))) * 0.25;
    float cut = 1.0 - color.a * 0.75;
    if (amount < cut) {
        return vec4(0.0);
    }
    return vec4(color.rgb, amount - cut > 0.08 ? 0.8 : 0.45);
}

vec4 burn(vec2 uv, float seed, vec4 color, float t) {
    vec2 cell = floor(uv);
    float s = seed * 0.73;
    float vein = 1.0 - abs(fireNoise(cell / 3.5 + vec2(s, s * 0.61)) * 2.0 - 1.0);
    float wide = fireNoise(cell / 7.0 + vec2(s * 0.37, s * 1.3));
    float detail = fireHash(cell + vec2(s * 1.9, s * 0.37));
    float pulse = 0.5 + 0.5 * sin(t * (1.2 + detail * 2.0) + detail * 40.0);
    float strength = color.a;
    bool onFire = strength < 0.3;
    float heat = vein * 0.62 + wide * 0.3 + detail * 0.12 + pulse * 0.05 + (onFire ? -0.14 : (strength - 1.0) * 0.4);
    if (heat > 0.93) {
        return vec4(1.0, 0.86, 0.46, 1.0);
    }
    if (heat > 0.85) {
        return vec4(1.0, 0.5, 0.1, 1.0);
    }
    if (heat > 0.78) {
        return vec4(0.72, 0.18, 0.04, 0.96);
    }
    if (onFire) {
        return vec4(0.0);
    }
    return vec4(0.045, 0.03, 0.025, (0.35 + wide * 0.35) * strength);
}

void main() {
    int kind = fireInfo.x;
    float seed = float(fireInfo.y);
    float t = GameTime * 1200.0;
    vec4 color;
    if (kind == 1) {
        color = smoke(texCoord0, seed, vertexColor);
    } else if (kind == 3) {
        color = burn(texCoord0, seed, vertexColor, t);
    } else if (kind == 4) {
        color = mist(texCoord0, seed, vertexColor);
    } else if (kind == 5) {
        color = pool(texCoord0, vertexColor, t);
    } else if (kind == 6) {
        color = sheet(texCoord0, vertexColor, t);
    } else if (kind == 7) {
        color = foam(texCoord0, vertexColor, t);
    } else {
        color = vertexColor;
    }
    if (color.a < 0.004) {
        discard;
    }
    float fog = linear_fog_value(sphericalVertexDistance, FogEnvironmentalStart, FogEnvironmentalEnd) * FogColor.a;
    color.rgb = mix(color.rgb, FogColor.rgb, fog);
#ifdef OIT_ALPHA_ONLY
    executeAlphaOnlyPhase(gl_FragCoord.z, color.a);
#elif defined(OIT_ACCUMULATE)
    fragColor = sampleColorForAccumulation(color);
#else
    fragColor = vec4(color.rgb * color.a, kind == 2 ? (color.a > 0.3 ? 0.625 : 0.0) : color.a);
#endif
}
