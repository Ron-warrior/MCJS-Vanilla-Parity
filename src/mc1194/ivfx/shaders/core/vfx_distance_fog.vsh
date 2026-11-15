#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <immersivevfx:vfx_realistic.glsl>

layout(location = 0) out vec2 texCoord;
layout(location = 1) flat out vec4 vfxAtmo0;
layout(location = 2) flat out vec4 vfxAtmo1;
layout(location = 3) flat out vec4 vfxAtmo2;
layout(location = 4) flat out vec4 vfxAtmo3;
layout(location = 5) flat out vec4 vfxAtmo4;
layout(location = 6) flat out vec4 vfxAtmo5;
layout(location = 7) flat out vec4 vfxAtmo6;

void main() {
    vec2 uv = vec2((gl_VertexIndex << 1) & 2, gl_VertexIndex & 2);
    vec4 pos = vec4(uv * vec2(2, 2) + vec2(-1, -1), 0, 1);

    gl_Position = pos;
    texCoord = uv;
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
