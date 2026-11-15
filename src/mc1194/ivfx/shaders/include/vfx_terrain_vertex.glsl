#include <immersivevfx:vfx_terrain_locations.glsl>
#include <immersivevfx:vfx_shadow_sky.glsl>
#include <immersivevfx:vfx_held_light.glsl>
#ifdef VFX_SWAY
#include <immersivevfx:vfx_grass.glsl>
#endif

#if !defined(VFX_SHADOWS) && !defined(VFX_MARK) && !defined(VFX_REFLECT) && !defined(VFX_SWAY)
#define VFX_PLAIN
#endif

layout(location = VFX_LOC_POS) out vec3 vfxPos;
layout(location = VFX_LOC_LIT) out vec4 vfxLightLit;
layout(location = VFX_LOC_SHADE) out vec4 vfxLightShade;
layout(location = VFX_LOC_MATERIAL) flat out uint vfxMaterial;
layout(location = VFX_LOC_LM) out vec2 vfxLm;
#ifdef VFX_SWAY
layout(location = VFX_LOC_GRASS) flat out float vfxGrass;
layout(location = VFX_LOC_SWAY) out vec2 vfxSwayCorner;
layout(location = VFX_LOC_SWAY_KIND) flat out float vfxSwayKind;
#endif
#if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY)
layout(location = VFX_LOC_INVERSE) flat out mat4 vfxFlatInverse;
#endif

void vfx_vertex_finish(vec3 pos, vec4 tint) {
    int m = (UV2.y >> 8) & 255;
    int ext = (UV2.x >> 8) & 255;
    ivec2 uv = UV2 & 255;
    vfxMaterial = uint(m);
    #ifdef VFX_PLAIN
    ivec2 vfxUv = uv;
    #else
    ivec2 vfxUv = vfx_held_uv(uv, pos);
    #endif
    vertexColor = tint;
    #ifdef OIT_ALPHA_ONLY
    vfxLightLit = vec4(1.0);
    vfxLightShade = vec4(1.0);
    #elif defined(VFX_ENHANCED)
    vfxLightLit = vec4(1.0);
    vfxLightShade = vec4(1.0);
    #elif defined(VFX_SHADOWS)
    vfxLightLit = sample_lightmap(Sampler2, vfxUv);
    vfxLightShade = sample_lightmap(Sampler2, vfx_shadow_sky(vfxUv));
    #else
    vfxLightLit = sample_lightmap(Sampler2, vfxUv);
    vfxLightShade = vfxLightLit;
    #ifdef VFX_PLAIN
    vertexColor = tint * vfxLightLit;
    vfxLightLit = vec4(1.0);
    vfxLightShade = vec4(1.0);
    #endif
    #endif
    vfxPos = pos;
    vfxLm = clamp(vec2(vfxUv) / 240.0, 0.0, 1.0);
    #ifdef VFX_SWAY
    vfxGrass = GrassKinds.w > 0.5 ? vfx_grass_kind(uint(m), uint(ext)) : 0.0;
    vfxSwayKind = vfx_sway_kind(uint(m), uint(ext));
    vfxSwayCorner = vec2(float((ext >> 4) & 1), float((ext >> 5) & 1));
    #endif
    #if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY)
    vfxFlatInverse = inverse(ProjMat * ModelViewMat);
    #endif
}
