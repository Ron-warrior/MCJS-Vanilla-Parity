#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

const int LAYERS = 16;

void main() {
    vec4 far = ModelViewMat * vec4(texCoord * 2.0 - 1.0, 0.5, 1.0);
    vec3 dir = normalize(far.xyz / far.w);
    float up = dir.y;
    float visibility = sqrt(clamp(up * 1.5 - 0.225, 0.0, 1.0)) * (1.0 - up * 0.9) * ColorModulator.x;
    if (visibility <= 0.001) {
        discard;
    }
    vec2 plane = dir.xz / up;
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 aurora = vec3(0.0);
    for (int i = 0; i < LAYERS; i++) {
        float layer = (float(i) + dither + 5.0) / float(LAYERS + 10);
        layer *= layer;
        vec2 p = (plane * (0.8 + layer) * 11.0 + ColorModulator.zw) * 0.0007;
        float ridge = 1.0 - 2.0 * abs(texture(Sampler0, p).r - 0.5);
        ridge *= ridge;
        ridge *= ridge;
        ridge *= ridge;
        ridge *= ridge;
        ridge *= texture(Sampler0, p * 3.0 + ColorModulator.y).b;
        ridge *= texture(Sampler0, p * 5.0 - ColorModulator.y).b;
        float low = 1.0 - layer;
        float low4 = low * low * low * low;
        aurora += ridge * low * mix(vec3(7.0, 2.2, 12.0), vec3(6.0, 16.0, 12.0), low4);
    }
    aurora *= 1.8 * visibility / float(LAYERS);
    fragColor = vec4(aurora, 1.0);
}
