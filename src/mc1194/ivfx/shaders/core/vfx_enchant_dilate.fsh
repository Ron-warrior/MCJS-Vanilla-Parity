#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    ivec2 size = textureSize(Sampler0, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 tileSize = textureSize(Sampler1, 0);
    ivec2 tile = ivec2(p.x / 16, p.y);
    float near = 0.0;
    for (int k = -1; k <= 1; k++) {
        near = max(near, texelFetch(Sampler1, clamp(tile + ivec2(k, 0), ivec2(0), tileSize - 1), 0).r);
    }
    if (near < 0.5) {
        fragColor = vec4(1.0, 0.0, 0.0, 1.0);
        return;
    }
    int reach = int(ColorModulator.x + 0.5) + 1;
    float best = 31.0;
    for (int dx = -16; dx <= 16; dx++) {
        if (abs(dx) > reach) {
            continue;
        }
        ivec2 q = clamp(p + ivec2(dx, 0), ivec2(0), size - 1);
        if (texelFetch(Sampler0, q, 0).a > 0.5) {
            best = min(best, float(abs(dx)));
        }
    }
    fragColor = vec4(best / 31.0, 0.0, 0.0, 1.0);
}
