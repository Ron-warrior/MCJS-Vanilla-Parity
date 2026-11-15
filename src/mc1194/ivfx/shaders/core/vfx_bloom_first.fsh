#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;
#ifdef VFX_HAND_FIRST
uniform sampler2D Sampler2;
#endif

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
#ifdef VFX_HAND_FIRST
    if (texture(Sampler2, texCoord).r <= 0.0) {
        discard;
    }
#endif
    vec2 texel = 1.0 / vec2(textureSize(Sampler0, 0));
    vec3 color = texture(Sampler0, texCoord + texel * vec2(-1.0, -1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(1.0, -1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(-1.0, 1.0)).rgb;
    color += texture(Sampler0, texCoord + texel * vec2(1.0, 1.0)).rgb;
    color *= 0.25;
    float peak = max(color.r, max(color.g, color.b));
    fragColor = vec4(color * peak * peak * peak * texture(Sampler1, texCoord).r, 1.0);
}
