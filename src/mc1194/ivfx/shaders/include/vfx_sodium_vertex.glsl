#include <immersivevfx:vfx_sodium_locations.glsl>
#include <immersivevfx:vfx_shadow_sky.glsl>
#ifndef VFX_CASTER
#include <immersivevfx:vfx_held_light.glsl>
#endif
#ifdef VFX_SWAY
#include <immersivevfx:vfx_grass.glsl>
#endif
#ifdef VFX_PREPASS
invariant gl_Position;
#endif

#ifdef VFX_SWAY
layout(location = VFX_LOC_GRASS) flat out float vfxGrass;
layout(location = VFX_LOC_SKY) out float vfxGrassSky;
layout(location = VFX_LOC_SWAY) out vec2 vfxSwayCorner;
layout(location = VFX_LOC_SWAY_KIND) flat out float vfxSwayKind;
#endif
#ifndef VFX_CASTER
layout(location = VFX_LOC_MATERIAL) flat out uint vfxMaterial;
#endif
#if !defined(VFX_CASTER) && (defined(VFX_SHADOWS) || defined(VFX_REFLECT) || defined(VFX_SWAY))
layout(location = VFX_LOC_POS) out vec3 vfxPos;
layout(location = VFX_LOC_LM) out vec2 vfxLm;
layout(location = VFX_LOC_COLOR) out vec4 vfxVertexColor;
#endif
#if defined(VFX_SHADOWS) && !defined(VFX_ENHANCED) && !defined(VFX_CASTER)
layout(location = VFX_LOC_SHADE) out vec4 vfxShadeColor;
#endif
#if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY) && !defined(VFX_CASTER)
layout(location = VFX_LOC_INVERSE) flat out mat4 vfxFlatInverse;
#endif

void vfx_vertex_finish(vec3 position) {
#ifdef VFX_SWAY
    uint vfxExt = ((a_Position.x >> 30u) & 3u) | ((a_Position.y >> 30u) & 3u) << 2u;
#endif
#ifndef VFX_CASTER
    vfxMaterial = _material_params;
#endif
    vec2 vfxLightCoord = _vert_tex_light_coord;
#ifndef VFX_CASTER
    vfxLightCoord.x = max(vfxLightCoord.x, 0.03125 + 0.9375 * vfx_held_block(position));
#endif

#if defined(OIT_ALPHA_ONLY) || defined(VFX_ENHANCED) || defined(VFX_CASTER)
    v_Color = _vert_color;
#else
    v_Color = _vert_color * texture(u_LightTex, vfxLightCoord);
#endif
#if defined(VFX_SHADOWS) && !defined(VFX_ENHANCED) && !defined(VFX_CASTER)
#ifdef OIT_ALPHA_ONLY
    vfxShadeColor = _vert_color;
#else
    vfxShadeColor = _vert_color * texture(u_LightTex, vec2(vfxLightCoord.x, vfxLightCoord.y * VFX_SHADOW_SKY));
#endif
#endif

#ifdef VFX_SWAY
    vfxGrass = GrassKinds.w > 0.5 ? vfx_grass_kind(_material_params, vfxExt) : 0.0;
    vfxSwayKind = vfx_sway_kind(_material_params, vfxExt);
    vfxSwayCorner = vec2(a_TexCoord >> 15u);
    vfxGrassSky = clamp((_vert_tex_light_coord.y - 0.03125) / 0.9375, 0.0, 1.0);
#endif
#if !defined(VFX_CASTER) && (defined(VFX_SHADOWS) || defined(VFX_REFLECT) || defined(VFX_SWAY))
    vfxPos = position;
    vfxLm = clamp((vfxLightCoord - 0.03125) / 0.9375, 0.0, 1.0);
    vfxVertexColor = _vert_color;
#endif
#if defined(VFX_REFLECT) && !defined(OIT_ALPHA_ONLY) && !defined(VFX_CASTER)
    vfxFlatInverse = inverse(u_ProjectionMatrix * u_ModelViewMatrix);
#endif
}
