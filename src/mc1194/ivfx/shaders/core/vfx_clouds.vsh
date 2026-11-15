#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#include <immersivevfx:vfx_realistic.glsl>

layout(location = 0) in vec3 Position;
layout(location = 1) in vec2 UV0;
layout(location = 2) in vec4 Color;
layout(location = 3) in vec4 Overlay;

layout(location = 0) out vec3 cloudPosition;
layout(location = 1) out vec2 cloudCell;
layout(location = 2) out vec4 cloudStyle;
layout(location = 3) flat out vec4 vfxAtmo0;
layout(location = 4) flat out vec4 vfxAtmo1;
layout(location = 5) flat out vec4 vfxAtmo2;
layout(location = 6) flat out vec4 vfxAtmo3;
layout(location = 7) flat out vec4 vfxAtmo4;
layout(location = 8) flat out vec4 vfxAtmo5;
layout(location = 9) flat out vec4 vfxAtmo6;

void main() {
    vec3 position = Position + ModelOffset;
    gl_Position = ProjMat * ModelViewMat * vec4(position, 1.0);
    cloudPosition = position;
    cloudCell = UV0 + ModelOffset.xz;
    cloudStyle = Color;
    vfxAtmo0 = vec4(0.0);
    vfxAtmo1 = vec4(0.0);
    vfxAtmo2 = vec4(0.0);
    vfxAtmo3 = vec4(0.0);
    vfxAtmo4 = vec4(0.0);
    vfxAtmo5 = vec4(0.0);
    vfxAtmo6 = vec4(0.0);
    if (TextureMat[1].w > 0.5) {
        Atmosphere a = atmosphere();
        vfxAtmo0 = vec4(a.dayUp, a.shadowTime);
        vfxAtmo1 = vec4(a.dayMiddle, 0.0);
        vfxAtmo2 = vec4(a.dayDown, 0.0);
        vfxAtmo3 = vec4(a.sunsetDownP, 0.0);
        vfxAtmo4 = vec4(a.nightUp, 0.0);
        vfxAtmo5 = vec4(a.nightMiddle, 0.0);
        vfxAtmo6 = vec4(a.nightDown, 0.0);
    }
}
