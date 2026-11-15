#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <minecraft:projection.glsl>
#ifdef HORIZON_FOG
#include <immersivevfx:vfx_realistic.glsl>
#endif

layout(location = 0) in vec3 Position;
layout(location = 1) in vec2 UV0;
layout(location = 2) in vec4 Color;
layout(location = 3) in vec4 Overlay;

layout(location = 0) out vec2 texCoord0;
layout(location = 1) out vec4 vertexColor;
layout(location = 2) out vec4 overlayColor;
layout(location = 3) out vec3 skyPosition;
#ifdef HORIZON_FOG
layout(location = 4) flat out vec4 vfxAtmo0;
layout(location = 5) flat out vec4 vfxAtmo1;
layout(location = 6) flat out vec4 vfxAtmo2;
layout(location = 7) flat out vec4 vfxAtmo3;
layout(location = 8) flat out vec4 vfxAtmo4;
layout(location = 9) flat out vec4 vfxAtmo5;
layout(location = 10) flat out vec4 vfxAtmo6;
#endif

void main() {
    gl_Position = ProjMat * ModelViewMat * vec4(Position, 1.0);
    texCoord0 = UV0;
    vertexColor = Color;
    overlayColor = Overlay;
    skyPosition = Position;
#ifdef HORIZON_FOG
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
#endif
}
