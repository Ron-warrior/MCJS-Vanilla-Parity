#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;
uniform sampler2D Sampler2;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    ivec2 size = textureSize(Sampler1, 0);
    ivec2 p = ivec2(gl_FragCoord.xy);
    if (texelFetch(Sampler1, p, 0).a > 0.5) {
        discard;
    }
    ivec2 tileSize = textureSize(Sampler2, 0);
    ivec2 tile = p / 16;
    float near = 0.0;
    for (int ty = -1; ty <= 1; ty++) {
        for (int tx = -1; tx <= 1; tx++) {
            near = max(near, texelFetch(Sampler2, clamp(tile + ivec2(tx, ty), ivec2(0), tileSize - 1), 0).r);
        }
    }
    if (near < 0.5) {
        discard;
    }
    float radius = ModelOffset.x;
    int reach = int(radius + 0.5) + 1;
    float best = 1.0e4;
    for (int dy = -16; dy <= 16; dy++) {
        if (abs(dy) > reach) {
            continue;
        }
        ivec2 q = clamp(p + ivec2(0, dy), ivec2(0), size - 1);
        float dx = floor(texelFetch(Sampler0, q, 0).r * 31.0 + 0.5);
        if (dx < 30.5) {
            best = min(best, dx * dx + float(dy * dy));
        }
    }
    float alpha = clamp(radius + 0.5 - sqrt(best), 0.0, 1.0) * ColorModulator.a;
    if (alpha <= 0.003) {
        discard;
    }
    vec3 tint = p.x * 2 >= size.x ? ColorModulator.rgb : TextureMat[0].rgb;
    fragColor = vec4(tint, alpha);
}
