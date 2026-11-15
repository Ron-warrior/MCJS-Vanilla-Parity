#version 330
#extension GL_ARB_separate_shader_objects : require

#define VFX_GRASS_FRAGMENT
#include <immersivevfx:vfx_shadow.glsl>
#include <immersivevfx:vfx_grass.glsl>

uniform sampler2D GpuGrassSprite;

layout(location = 0) in vec2 vfxGrassUv;
layout(location = 1) flat in vec3 vfxGrassBase;
layout(location = 2) flat in vec3 vfxGrassTintColor;
layout(location = 3) flat in vec2 vfxGrassLm;
layout(location = 4) flat in vec4 vfxGrassLit;
layout(location = 5) flat in vec4 vfxGrassShaded;
layout(location = 6) flat in float vfxGrassVariant;
layout(location = 7) in vec3 vfxPos;

layout(location = 0) out vec4 fragColor;

const float VFX_SPRITES = 4.0;
const float VFX_SHEET_WIDTH = 64.0;
const float VFX_SPRITE_SIZE = 16.0;

float vfx_grass_visibility(sampler2D map, mat4 matrix, vec3 p) {
    vec3 shadowPos = (matrix * vec4(p, 1.0)).xyz;
    if (any(lessThanEqual(shadowPos, vec3(0.0))) || any(greaterThanEqual(shadowPos, vec3(1.0)))) {
        return 1.0;
    }
    return step(textureLod(map, shadowPos.xy, 0.0).r, shadowPos.z + ShadowRange.z);
}

void main() {
    vec2 uv = vfxGrassUv;
    if (GrassKinds.w > 0.5) {
        float wind = vfx_grass_wind(vfxGrassBase.xz, vfxGrassLm.y);
        float fromBottom = VFX_SPRITE_SIZE - 1.0 - floor(uv.y * VFX_SPRITE_SIZE);
        float bend = pow(clamp(fromBottom / 12.0, 0.0, 1.0), 0.7);
        uv.x -= round(3.0 * bend * wind) / VFX_SHEET_WIDTH;
        if (floor(uv.x * VFX_SPRITES) != vfxGrassVariant) {
            discard;
        }
    }
    vec4 sprite = textureLod(GpuGrassSprite, uv, 0.0);
    if (sprite.a < 0.5) {
        discard;
    }
    float visibility = 1.0;
    if (ShadowLight.w > 0.0) {
        visibility = vfx_grass_visibility(VfxShadowMap, ShadowMat, vfxGrassBase);
        if (ShadowRange.w < 0.999) {
            visibility = mix(vfx_grass_visibility(VfxShadowMapPrev, ShadowMatPrev, vfxGrassBase), visibility, ShadowRange.w);
        }
        float edge = max(max(abs(vfxGrassBase.x), abs(vfxGrassBase.z)), abs(vfxGrassBase.y));
        visibility = mix(visibility, 1.0, smoothstep(ShadowRange.y * 0.8, ShadowRange.y * 0.95, edge));
    }
    float direct = ShadowSun.w > 0.5 ? clamp((ShadowLight.y + 0.4) * 0.714, 0.0, 1.0) : clamp(ShadowLight.y * 2.5 + 0.35, 0.0, 1.0);
    float shade = ShadowLight.w > 0.0 ? ShadowLight.w * (1.0 - visibility * direct) : 0.0;
    vfxCastShade = ShadowLight.w > 0.0 ? ShadowLight.w * (1.0 - visibility) : 0.0;
    vec4 color = vec4(sprite.rgb * vfxGrassTintColor, 1.0);
    if (ShadowSun.w > 0.5) {
        vfx_water_shadow(vfxPos, false);
        color.rgb = vfx_enhanced_color(color.rgb, vfxGrassLm, vec3(0.0, 1.0, 0.0), shade, false);
    } else {
        color *= vfx_shadow_light(vfxGrassLit, vfxGrassShaded, shade, 0.0, 1.0);
        color.rgb = vfx_water_plain_grade(color.rgb, vfxPos, false);
    }
    fragColor = vec4(color.rgb, 0.5);
}
