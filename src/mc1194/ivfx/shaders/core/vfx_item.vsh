#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:light.glsl>
#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>
#include <immersivevfx:vfx_shadow_sky.glsl>
#include <immersivevfx:vfx_held_light.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec4 Color;
layout(location = 2) in vec2 UV0;
layout(location = 3) in ivec2 UV1;
layout(location = 4) in ivec2 UV2;
#ifdef GLINT_SPECIAL
layout(location = 5) in vec2 UV3;
#endif
layout(location = 6) in vec4 Normal;

#ifndef OIT_ALPHA_ONLY
uniform sampler2D Sampler1;
uniform sampler2D Sampler2;

layout(location = 0) out float sphericalVertexDistance;
layout(location = 1) out float cylindricalVertexDistance;
#endif
layout(location = 2) out vec4 vertexColor;
#ifndef OIT_ALPHA_ONLY
layout(location = 3) out vec4 lightMapColor;
layout(location = 4) out vec4 overlayColor;
layout(location = 7) out vec4 vfxLightShade;
layout(location = 8) out float vfxSkyWeight;
layout(location = 9) out vec2 vfxLm;
layout(location = 10) out vec4 vfxRawColor;
layout(location = 11) out vec3 vfxPos;
layout(location = 12) out vec3 vfxNormal;
layout(location = 13) flat out uint vfxItemMaterial;
#endif

layout(location = 5) out vec2 texCoord0;
#ifdef GLINT
layout(location = 6) out vec2 texCoordGlint;
#endif

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);

    #ifndef OIT_ALPHA_ONLY
    sphericalVertexDistance = fog_spherical_distance(Position);
    cylindricalVertexDistance = fog_cylindrical_distance(Position);
    #endif
    vertexColor = minecraft_mix_light(Light0_Direction, Light1_Direction, Normal.xyz, Color);
    #ifndef OIT_ALPHA_ONLY
    ivec2 vfxUv = vfx_held_uv(UV2, Position);
    lightMapColor = sample_lightmap(Sampler2, vfxUv);
    overlayColor = texelFetch(Sampler1, UV1, 0);
    vfxLightShade = sample_lightmap(Sampler2, vfx_shadow_sky(vfxUv));
    vfxSkyWeight = vfx_sky_weight(float(vfxUv.x) / 240.0, float(vfxUv.y) / 240.0);
    vfxLm = clamp(vec2(vfxUv) / 240.0, 0.0, 1.0);
    vfxRawColor = Color;
    vfxPos = Position;
    vfxNormal = Normal.xyz;
    vfxItemMaterial = uint((int(round(Normal.w * 127.0)) + 256) & 255);
    #endif

    texCoord0 = UV0;
    #ifdef GLINT
    #ifdef GLINT_SPECIAL
    texCoordGlint = (TextureMat * vec4(UV3, 0.0, 1.0)).xy;
    #else
    texCoordGlint = (TextureMat * vec4(UV0, 0.0, 1.0)).xy;
    #endif
    #endif
}
