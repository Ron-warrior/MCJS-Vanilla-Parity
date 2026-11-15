#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;

layout(std140) uniform VfxBloom {
    mat4 BloomClipToWorld;
    vec4 BloomInfo;
    vec4 BloomWater;
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

bool marked(ivec2 pixel) {
#ifdef VFX_HAND_MASK
    if (texelFetch(Sampler1, pixel, 0).r <= 0.0) {
        return false;
    }
#endif
    float a = texelFetch(Sampler0, pixel, 0).a;
    return abs(a - 0.625) < 0.02 || abs(a - 0.3125) < 0.02;
}

void main() {
    ivec2 limit = textureSize(Sampler0, 0) - 1;
    ivec2 base = ivec2(gl_FragCoord.xy) * 4;
    ivec2 hit = ivec2(-1);
    float amount = 0.0;
#ifdef VFX_HAND_MASK
    bool covered = false;
#endif
    for (int y = 1; y < 4; y += 2) {
        for (int x = 1; x < 4; x += 2) {
            ivec2 pixel = min(base + ivec2(x, y), limit);
#ifdef VFX_HAND_MASK
            covered = covered || texelFetch(Sampler1, pixel, 0).r > 0.0;
#endif
            if (marked(pixel)) {
                amount += 0.25;
                hit = pixel;
            }
        }
    }
#ifdef VFX_HAND_MASK
    if (!covered) {
        discard;
    }
    fragColor = vec4(amount);
    return;
#endif
    if (amount <= 0.0) {
        discard;
    }
    float depth = texelFetch(Sampler1, hit, 0).r;
    vec4 point = BloomClipToWorld * vec4(texCoord * 2.0 - 1.0, BloomInfo.x > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    float dist = length(point.xyz / max(abs(point.w), 0.000001));
    float fog = clamp((dist - BloomInfo.y) / max(BloomInfo.z - BloomInfo.y, 1.0), 0.0, 1.0);
    if (BloomWater.x > 0.5) {
        vec3 dir = point.xyz / max(abs(point.w), 0.000001) / max(dist, 0.000001);
        float toSurface = BloomWater.z > 0.001 && dir.y > 0.001 ? BloomWater.z / dir.y : 1.0e6;
        float backFog = (BloomWater.w > 0.5 ? dist : min(dist, toSurface)) / max(BloomWater.y, 1.0);
        fog = max(fog, 1.0 - exp(-backFog * backFog));
    }
    fragColor = vec4(amount * (1.0 - fog));
}
