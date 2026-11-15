#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D DepthSampler;

layout(std140) uniform VfxFireLights {
    mat4 FireClipToWorld;
    vec4 FireInfo;
    vec4 FireLights[96];
};

layout(location = 0) in vec2 fireNdc;
layout(location = 1) flat in int fireIndex;

layout(location = 0) out vec4 fragColor;

void main() {
    vec4 light = FireLights[fireIndex * 3];
    vec4 tint = FireLights[fireIndex * 3 + 1];
    ivec2 size = textureSize(DepthSampler, 0);
    ivec2 pixel = clamp(ivec2((fireNdc * 0.5 + 0.5) * vec2(size)), ivec2(0), size - 1);
    float depth = texelFetch(DepthSampler, pixel, 0).r;
    vec4 clip = vec4(fireNdc, FireInfo.x > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    vec4 far = FireClipToWorld * vec4(fireNdc, 1.0, 1.0);
    vec3 dir = normalize(far.xyz / far.w);
    vec4 point = FireClipToWorld * clip;
    vec3 world = point.xyz / max(abs(point.w), 0.000001);
    float scene = depth > 0.0 ? length(world) : 1000000.0;
    float along = clamp(dot(dir, light.xyz), 0.0, scene);
    vec3 offset = light.xyz - dir * along;
    float offset2 = dot(offset, offset);
    float wideRadius = light.w * 0.34;
    float tightRadius = light.w * 0.2;
    float wide = exp(-offset2 / (wideRadius * wideRadius));
    float tight = exp(-offset2 / (tightRadius * tightRadius));
    vec3 normal = cross(dFdx(world), dFdy(world));
    vec3 surface = vec3(0.0);
    if (depth > 0.0) {
        vec3 to = light.xyz - world;
        float dist2 = dot(to, to);
        if (dist2 < light.w * light.w) {
            float dist = sqrt(dist2);
            float falloff = 1.0 - dist / light.w;
            float len = length(normal);
            float facing = 0.6;
            if (len > 0.000001) {
                vec3 n = normal / len;
                if (dot(n, world) > 0.0) {
                    n = -n;
                }
                facing = max(dot(n, to / max(dist, 0.001)), 0.0) * 0.72 + 0.28;
            }
            surface = tint.rgb * tint.a * falloff * falloff * facing;
        }
    }
    fragColor = vec4(surface, tint.a * (0.6 * wide * wide + 2.0 * tight));
}
