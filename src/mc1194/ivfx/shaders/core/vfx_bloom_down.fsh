#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    vec2 texel = 1.0 / vec2(textureSize(Sampler0, 0));
    vec3 color = texture(Sampler0, texCoord).rgb * 4.0;
    color += texture(Sampler0, texCoord + texel * vec2(-1.0, -1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(1.0, -1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(-1.0, 1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(1.0, 1.0)).rgb;
    fragColor = vec4(color * 0.125, 1.0);
}
