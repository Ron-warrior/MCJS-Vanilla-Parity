#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    ivec2 size = textureSize(Sampler0, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    int start = p.x * 16;
    int end = min(start + 16, size.x);
    float hit = 0.0;
    for (int x = start; x < end; x++) {
        if (texelFetch(Sampler0, ivec2(x, p.y), 0).a > 0.5) {
            hit = 1.0;
        }
    }
    fragColor = vec4(hit, 0.0, 0.0, 1.0);
}
