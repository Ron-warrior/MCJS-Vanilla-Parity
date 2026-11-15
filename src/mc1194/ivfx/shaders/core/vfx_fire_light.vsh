#version 330
#extension GL_ARB_separate_shader_objects : require

layout(std140) uniform VfxFireLights {
    mat4 FireClipToWorld;
    vec4 FireInfo;
    vec4 FireLights[96];
};

layout(location = 0) out vec2 fireNdc;
layout(location = 1) flat out int fireIndex;

void main() {
    int index = gl_VertexIndex / 6;
    int corner = gl_VertexIndex % 6;
    vec2 local = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
    vec4 rect = FireLights[index * 3 + 2];
    vec2 ndc = mix(rect.xy, rect.zw, local);
    gl_Position = vec4(ndc, 0.0, 1.0);
    fireNdc = ndc;
    fireIndex = index;
}
