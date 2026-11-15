#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D ReferenceNoise;

layout(std140) uniform VfxUnderwaterTemporal {
    mat4 TemporalInvViewProj;
    mat4 TemporalPrevViewProj;
    vec4 TemporalCamera;
    vec4 TemporalView;
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    vec2 uv = texCoord + 0.0007 * sin((texCoord.x + texCoord.y) * 25.0 + TemporalView.z * 3.0);
    vec3 color = textureLod(Sampler0, uv, 0.0).rgb;
    float pixel = 1.0 / float(textureSize(Sampler0, 0).x);
    color *= 1.25;
    color -= textureLod(Sampler0, uv + vec2(pixel, 0.0), 0.0).rgb * 0.0625;
    color -= textureLod(Sampler0, uv + vec2(0.0, pixel), 0.0).rgb * 0.0625;
    color -= textureLod(Sampler0, uv + vec2(-pixel, 0.0), 0.0).rgb * 0.0625;
    color -= textureLod(Sampler0, uv + vec2(0.0, -pixel), 0.0).rgb * 0.0625;
    vec2 centered = uv - 0.5;
    color *= 1.0 - dot(centered, centered) * (1.0 - dot(color, vec3(0.299, 0.587, 0.114)));
    float dither = textureLod(ReferenceNoise, gl_FragCoord.xy / 128.0, 0.0).b;
    color += vec3((dither - 0.25) / 128.0);
    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
