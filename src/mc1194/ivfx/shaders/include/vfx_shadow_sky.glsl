#ifndef IMMERSIVEVFX_SHADOW_SKY_GLSL
#define IMMERSIVEVFX_SHADOW_SKY_GLSL

#define VFX_SHADOW_SKY 0.4

float vfx_sky_weight(float block, float sky) {
    return clamp(sky, 0.0, 1.0) * (1.0 - 0.75 * clamp(block, 0.0, 1.0));
}

ivec2 vfx_shadow_sky(ivec2 uv) {
    return ivec2(uv.x, int(float(uv.y) * VFX_SHADOW_SKY));
}

#endif
