#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>
#include <immersivevfx:vfx_shadow_sky.glsl>
#include <immersivevfx:vfx_held_light.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec4 Color;
layout(location = 2) in vec2 UV0;
layout(location = 3) in ivec2 UV2;

#ifndef OIT_ALPHA_ONLY
uniform sampler2D Sampler2;
#endif

layout(location = 0) out float sphericalVertexDistance;
layout(location = 1) out float cylindricalVertexDistance;
layout(location = 2) out vec4 vertexColor;
layout(location = 3) out vec2 texCoord0;
layout(location = 4) out vec3 vfxPos;
layout(location = 5) out vec4 vfxLightLit;
layout(location = 6) out vec4 vfxLightShade;
layout(location = 7) out float vfxSkyWeight;
layout(location = 8) out vec2 vfxLm;
layout(location = 9) flat out uint vfxMaterial;

#if !defined(VFX_SHADOWS) && !defined(VFX_MARK)
#define VFX_PLAIN
#endif

void main() {
    vec3 pos = Position + ModelOffset;
    int m = (UV2.y >> 8) & 255;
    ivec2 uv = UV2 & 255;
    vfxMaterial = uint(m);
    #ifdef VFX_PLAIN
    ivec2 vfxUv = uv;
    #else
    ivec2 vfxUv = vfx_held_uv(uv, pos);
    #endif
    gl_Position = ProjMat * ModelViewMat * vec4(pos, 1.0);

    sphericalVertexDistance = fog_spherical_distance(pos);
    cylindricalVertexDistance = fog_cylindrical_distance(pos);
    vertexColor = Color;
    #ifndef OIT_ALPHA_ONLY
    vfxLightLit = sample_lightmap(Sampler2, vfxUv);
    vfxLightShade = sample_lightmap(Sampler2, vfx_shadow_sky(vfxUv));
    #ifdef VFX_PLAIN
    vertexColor = Color * vfxLightLit;
    vfxLightLit = vec4(1.0);
    vfxLightShade = vec4(1.0);
    #endif
    #else
    vfxLightLit = vec4(1.0);
    vfxLightShade = vec4(1.0);
    #endif
    texCoord0 = UV0;
    vfxPos = pos;
    vfxSkyWeight = vfx_sky_weight(float(vfxUv.x) / 240.0, float(vfxUv.y) / 240.0);
    vfxLm = clamp(vec2(vfxUv) / 240.0, 0.0, 1.0);
}
