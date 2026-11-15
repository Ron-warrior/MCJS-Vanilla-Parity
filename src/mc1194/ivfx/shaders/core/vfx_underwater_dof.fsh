#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;
uniform sampler2D DepthSampler;

layout(std140) uniform VfxUnderwater {
    mat4 WaterInvViewProj;
    mat4 WaterShadowMat;
    mat4 WaterShadowPrev;
    vec4 WaterLight;
    vec4 WaterFog;
    vec4 WaterParams;
    vec4 WaterView;
    vec4 WaterCamera;
    vec4 WaterSun;
    vec4 WaterVlColor;
    vec4 WaterVlDensity;
    vec4 WaterVlParams;
    vec4 WaterVlMult;
    vec4 WaterAir;
    vec4 WaterSurface;
    vec4 WaterSprite;
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

const vec2 OFFSETS[18] = vec2[18](
    vec2(0.0, 0.25), vec2(-0.2165, 0.125), vec2(-0.2165, -0.125), vec2(0.0, -0.25), vec2(0.2165, -0.125), vec2(0.2165, 0.125),
    vec2(0.0, 0.5), vec2(-0.25, 0.433), vec2(-0.433, 0.25), vec2(-0.5, 0.0), vec2(-0.433, -0.25), vec2(-0.25, -0.433),
    vec2(0.0, -0.5), vec2(0.25, -0.433), vec2(0.433, -0.2), vec2(0.5, 0.0), vec2(0.433, 0.25), vec2(0.25, 0.433));

vec3 unproject(vec2 uv, float depth) {
    vec4 world = WaterInvViewProj * vec4(uv * 2.0 - 1.0, WaterParams.y > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    return world.xyz / world.w;
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec4 center = texelFetch(Sampler0, pixel, 0);
    float depth = texelFetch(DepthSampler, pixel, 0).r;
    vec4 eyeClip = WaterInvViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    float distance = depth <= 0.0 ? 1.0e6 : length(unproject(texCoord, depth) - eyeClip.xyz / eyeClip.w);
    float coc = clamp((distance - 6.0) * 0.001, 0.0, 0.1) * 64.0 * 0.03;
    coc = coc / sqrt(coc * coc + 0.1);
    vec2 size = vec2(textureSize(Sampler0, 0));
    fragColor = center;
    if (coc * 0.5 > 1.0 / max(size.x, size.y)) {
        float lod = clamp(log2(size.x * coc * 0.75 / 320.0), 0.0, 1.0);
        vec2 scale = vec2(1.0, size.x / size.y);
        vec3 sum = vec3(0.0);
        for (int i = 0; i < 18; i++) {
            vec2 uv = texCoord + OFFSETS[i] * coc * 0.0085 * scale;
            vec4 fine = textureLod(Sampler0, uv, 0.0);
            vec4 coarse = textureLod(Sampler1, uv, 0.0);
            sum += mix(fine.rgb / max(fine.a, 1.0), coarse.rgb / max(coarse.a, 1.0), lod);
        }
        fragColor = vec4(sum / 18.0 * center.a, center.a);
    }
}
