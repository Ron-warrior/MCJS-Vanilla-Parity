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

float bloomNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
    float mask = texture(Sampler1, texCoord).r;
    if (BloomInfo.w < 0.0) {
        fragColor = vec4(0.0, mask, 0.0, 1.0);
        return;
    }
    vec3 glow = texture(Sampler0, texCoord).rgb * BloomInfo.w;
    float peak = max(glow.r, max(glow.g, glow.b));
    if (peak < 0.002) {
        discard;
    }
    float core = smoothstep(0.75, 1.0, mask);
    vec3 tint = glow / peak;
    float heat = core * clamp((tint.r - tint.b) * 1.5, 0.0, 1.0);
    vec3 soft = tint * tint;
    float cold = clamp(tint.b - tint.r, 0.0, 1.0);
    glow = peak * mix(soft * tint, soft, heat) * mix(1.0 - 0.5 * core, 0.8, heat) * (1.0 - 0.6 * cold);
    fragColor = vec4(max(glow + (bloomNoise(gl_FragCoord.xy) - 0.5) / 255.0, vec3(0.0)), 1.0);
}
