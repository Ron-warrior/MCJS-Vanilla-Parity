#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;

layout(std140) uniform VfxFireLights {
    mat4 FireClipToWorld;
    vec4 FireInfo;
    vec4 FireLights[96];
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    vec4 gathered = texture(Sampler0, texCoord);
#ifdef FIRE_HAZE
    float haze = (1.0 - exp(-gathered.a)) * FireInfo.y;
    if (haze < 0.002) {
        discard;
    }
    fragColor = vec4(vec3(1.0, 0.56, 0.24) * haze, 1.0);
#else
    float peak = max(gathered.r, max(gathered.g, gathered.b));
    if (peak < 0.002) {
        discard;
    }
    float amount = (1.0 - exp(-peak * 1.8)) * FireInfo.z;
    fragColor = vec4(mix(vec3(0.5), vec3(0.68, 0.46, 0.3), amount), 1.0);
#endif
}
