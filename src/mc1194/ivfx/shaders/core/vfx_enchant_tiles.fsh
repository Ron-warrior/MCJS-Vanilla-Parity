#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    ivec2 size = textureSize(Sampler0, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    int start = p.y * 16;
    int end = min(start + 16, size.y);
    float hit = 0.0;
    for (int y = start; y < end; y++) {
        if (texelFetch(Sampler0, ivec2(p.x, y), 0).r > 0.5) {
            hit = 1.0;
        }
    }
    fragColor = vec4(hit, 0.0, 0.0, 1.0);
}
