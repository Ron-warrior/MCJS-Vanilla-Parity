#ifndef IMMERSIVEVFX_HELD_LIGHT_GLSL
#define IMMERSIVEVFX_HELD_LIGHT_GLSL

#include <immersivevfx:vfx_reflect_block.glsl>

float vfx_held_block(vec3 pos) {
    if (HeldLight.w <= 0.0) {
        return 0.0;
    }
    float x = 1.23 * pow(HeldLight.w * 6.58 / (length(pos - HeldLight.xyz) + 6.0), 1.778);
    x /= 1.0 + 0.25 * x * x * x;
#ifdef VFX_HAND
    x *= 1.25;
#endif
    return min(x, 1.0);
}

ivec2 vfx_held_uv(ivec2 uv, vec3 pos) {
    return ivec2(max(uv.x, int(vfx_held_block(pos) * 240.0)), uv.y);
}

#endif
