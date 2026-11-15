#ifndef IMMERSIVEVFX_GRASS_GLSL
#define IMMERSIVEVFX_GRASS_GLSL

layout(std140) uniform VfxGrass {
    vec4 GrassUv[512];
    vec4 GrassWind;
    vec4 GrassCamera;
    vec4 GrassKinds;
    vec4 GrassSway;
};

float vfx_grass_kind(uint material, uint ext) {
    uint m = material & 255u;
    if ((m & 192u) != 192u) {
        return 0.0;
    }
    return float(((m & 7u) | ((m >> 4u) & 3u) << 3u | (ext & 15u) << 5u) + 1u);
}

float vfx_sway_kind(uint material, uint ext) {
    uint kind = ext & 15u;
    if ((material & 128u) != 0u || kind == 0u) {
        return 0.0;
    }
    return (kind == 3u ? GrassSway.y : GrassSway.x) > 0.5 ? float(kind) : 0.0;
}

#ifdef VFX_GRASS_FRAGMENT
float vfx_grass_hash(vec2 cell) {
    vec3 p = fract(vec3(cell.xyx) * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float vfx_grass_noise(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = p - cell;
    vec2 s = f * f * (3.0 - 2.0 * f);
    float low = mix(vfx_grass_hash(cell), vfx_grass_hash(cell + vec2(1.0, 0.0)), s.x);
    float high = mix(vfx_grass_hash(cell + vec2(0.0, 1.0)), vfx_grass_hash(cell + vec2(1.0, 1.0)), s.x);
    return mix(low, high, s.y);
}

float vfx_grass_wind(vec2 center, float sky) {
    float shelter = floor(clamp(sky * 3.0, 0.0, 1.0) * 4.0 + 0.5) * 0.25;
    if (shelter <= 0.0) {
        return 0.0;
    }
    vec2 plant = floor(center + GrassCamera.xz) + 0.5;
    vec2 wave = plant - vec2(0.8, 0.6) * GrassWind.x * 0.28;
    float gust = vfx_grass_noise(wave / 8.0) * 2.0 - 1.0;
    float slow = vfx_grass_noise(wave / 19.0 + 13.7) * 2.0 - 1.0;
    return (gust * 0.72 + slow * 0.28) * (1.0 + 0.8 * GrassWind.y) * shelter;
}

bool vfx_grass_uv(vec2 uv, int kind, float sky, vec3 pos, vec2 texel, out vec2 moved) {
    vec4 rect = GrassUv[kind];
    int part = kind < int(GrassKinds.x) ? 0 : kind < int(GrassKinds.y) ? 1 : 2;
    vec2 size = (rect.zw - rect.xy) / texel;
    vec2 local = (uv - rect.xy) / texel;
    float across = local.x / size.x;
    vec2 acrossGrad = vec2(dFdx(across), dFdy(across));
    vec2 along = (dFdx(pos.xz) * acrossGrad.x + dFdy(pos.xz) * acrossGrad.y) / max(dot(acrossGrad, acrossGrad), 1.0e-20);
    float wind = vfx_grass_wind(pos.xz + (0.5 - across) * along, sky);
    bool tall = part != 0;
    float rows = tall ? size.y * 2.0 : size.y;
    float fromTop = floor(local.y) + (part == 1 ? size.y : 0.0);
    float height = clamp(1.0 - fromTop / max(rows - 1.0, 1.0), 0.0, 1.0);
    float bend = pow(height, tall ? 0.7 : 0.35);
    float scale = size.x / 16.0;
    float sway = round((tall ? 8.0 : 5.0) * scale * bend * wind);
    float sag = round((tall ? 3.0 : 2.0) * scale * bend * abs(wind));
    vec2 shifted = vec2(local.x - sway, local.y - sag);
    if (part == 1) {
        shifted.y = max(shifted.y, 0.0);
    }
    if (shifted.x < 0.0 || shifted.x >= size.x || shifted.y < 0.0 || shifted.y >= size.y) {
        return false;
    }
    moved = rect.xy + shifted * texel;
    return true;
}

bool vfx_sway_uv(vec2 uv, int kind, vec2 corner, float sky, vec3 pos, vec2 texel, out vec2 moved) {
    vec2 gradU = vec2(dFdx(corner.x), dFdy(corner.x));
    vec2 gradV = vec2(dFdx(corner.y), dFdy(corner.y));
    float lenU = max(dot(gradU, gradU), 1.0e-20);
    float lenV = max(dot(gradV, gradV), 1.0e-20);
    vec2 uvU = vec2(dFdx(uv.x), dFdy(uv.x));
    vec2 uvV = vec2(dFdx(uv.y), dFdy(uv.y));
    vec2 size = max(round(vec2(sqrt(dot(uvU, uvU) / lenU), sqrt(dot(uvV, uvV) / lenV)) / texel), vec2(1.0));
    vec2 local = min(corner * size, size - vec2(0.001));
    float scale = size.x / 16.0;
    vec2 shifted;
    if (kind == 2 || kind == 3) {
        vec3 alongU = (dFdx(pos) * gradU.x + dFdy(pos) * gradU.y) / lenU;
        vec3 alongV = (dFdx(pos) * gradV.x + dFdy(pos) * gradV.y) / lenV;
        vec3 cell = floor(pos + (0.5 - corner.x) * alongU + (0.5 - corner.y) * alongV + GrassCamera.xyz + 0.25);
        float wave = sin(dot(cell, vec3(1.3, 0.7, 1.7)) + GrassWind.x * 0.1 + floor(local.y) * 0.6) * (1.0 + 0.8 * GrassWind.y);
        float sway = round(wave * (kind == 3 ? 0.8 : 1.4) * scale);
        shifted = vec2(mod(local.x - sway, size.x), local.y);
    } else {
        vec2 along = (dFdx(pos.xz) * gradU.x + dFdy(pos.xz) * gradU.y) / lenU;
        float wind = vfx_grass_wind(pos.xz + (0.5 - corner.x) * along, sky);
        bool tall = kind >= 4;
        float rows = tall ? size.y * 2.0 : size.y;
        float fromTop = floor(local.y) + (kind == 4 ? size.y : 0.0);
        float height = clamp(1.0 - fromTop / max(rows - 1.0, 1.0), 0.0, 1.0);
        float bend = pow(height, tall ? 0.7 : 0.35);
        float sway = round((tall ? 5.0 : 3.0) * scale * bend * wind);
        float sag = round((tall ? 2.0 : 1.0) * scale * bend * abs(wind));
        shifted = vec2(local.x - sway, local.y - sag);
        if (kind == 4) {
            shifted.y = max(shifted.y, 0.0);
        }
        if (shifted.x < 0.0 || shifted.x >= size.x || shifted.y < 0.0 || shifted.y >= size.y) {
            return false;
        }
    }
    moved = uv + (shifted - local) * texel;
    return true;
}
#endif

#endif
