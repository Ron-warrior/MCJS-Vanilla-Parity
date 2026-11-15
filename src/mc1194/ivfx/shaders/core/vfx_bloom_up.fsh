#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    vec3 tile = texture(Sampler1, texCoord).rgb;
    float peak = max(tile.r, max(tile.g, tile.b));
    vec3 color = peak > 0.00001 ? tile * (BLOOM_CAP * (1.0 - exp(-peak * BLOOM_SCALE / BLOOM_CAP)) / peak) : vec3(0.0);
#ifndef BLOOM_LAST
    vec2 texel = 1.0 / vec2(textureSize(Sampler0, 0));
    vec3 wider = texture(Sampler0, texCoord + texel * vec2(-1.0, 0.0)).rgb;
    wider += texture(Sampler0, texCoord + texel * vec2(1.0, 0.0)).rgb;
    wider += texture(Sampler0, texCoord + texel * vec2(0.0, -1.0)).rgb;
    wider += texture(Sampler0, texCoord + texel * vec2(0.0, 1.0)).rgb;
    wider += (texture(Sampler0, texCoord + texel * vec2(-0.5, -0.5)).rgb + texture(Sampler0, texCoord + texel * vec2(0.5, -0.5)).rgb
        + texture(Sampler0, texCoord + texel * vec2(-0.5, 0.5)).rgb + texture(Sampler0, texCoord + texel * vec2(0.5, 0.5)).rgb) * 2.0;
    color += wider / 12.0;
#endif
    fragColor = vec4(color, 1.0);
}
