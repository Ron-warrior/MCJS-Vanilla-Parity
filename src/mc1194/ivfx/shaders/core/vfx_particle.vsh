#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:fog.glsl>
#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#include <minecraft:sample_lightmap.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec2 UV0;
layout(location = 2) in vec4 Color;
layout(location = 3) in ivec2 UV2;

uniform sampler2D Sampler2;

layout(location = 0) out float sphericalVertexDistance;
layout(location = 1) out float cylindricalVertexDistance;
layout(location = 2) out vec2 texCoord0;
layout(location = 3) out vec4 vertexColor;
#ifdef FOAM
layout(location = 4) out float foamFade;
layout(location = 5) out float foamKind;
#endif

#ifdef VFX_PARTICLE_LIGHT
layout(location = 6) out vec3 vfxPos;
layout(location = 7) out vec2 vfxLm;
layout(location = 8) out vec4 vfxRaw;
#endif

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
#ifdef VFX_PARTICLE_LIGHT
    vfxPos = Position;
    vfxLm = clamp(vec2(UV2) / 240.0, 0.0, 1.0);
    vfxRaw = Color;
#endif
    sphericalVertexDistance = fog_spherical_distance(Position);
    cylindricalVertexDistance = fog_cylindrical_distance(Position);
    texCoord0 = UV0;
#ifdef FOAM
    vertexColor = vec4(sample_lightmap(Sampler2, UV2).rgb, Color.a);
    foamFade = Color.r;
    foamKind = Color.g;
#else
    vertexColor = Color * sample_lightmap(Sampler2, UV2);
#endif
}
