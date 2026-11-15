#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>

uniform sampler2D Sampler0;
uniform sampler2D EndDepth;
uniform sampler2D EndNoise;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

const vec3 ATM_FOG = vec3(0.40, 0.263, 0.525);
const vec3 BEAM_PURPLE = vec3(0.247, 0.104, 0.964) * 2.5;
const vec3 END_PINK = vec3(1.0, 0.6, 0.9);
const float BEAM_CENTER = 68.0;
const float BEAM_DISTANCE = 1536.0;
const int BEAM_SAMPLES = 24;
const float BEAM_INTENSITY = 1.0;

vec3 lottes(vec3 x) {
    vec3 xa = pow(max(x, vec3(0.0)), vec3(1.05));
    return xa / (xa * 0.9190 + 0.7188);
}

float smooth1(float x) {
    return x * x * (3.0 - 2.0 * x);
}

vec3 enderBeams(vec3 dir, float rayEnd, vec3 camera, float wind, float dither) {
    vec3 sum = vec3(0.0);
    float last = 0.0;
    for (int i = 0; i < BEAM_SAMPLES; i++) {
        float next = BEAM_DISTANCE * pow((float(i) + dither) / float(BEAM_SAMPLES), 1.3);
        bool stop = next >= rayEnd;
        if (stop) {
            next = rayEnd;
        }
        float weight = smooth1(pow(next / BEAM_DISTANCE, 0.55)) - smooth1(pow(last / BEAM_DISTANCE, 0.55));
        last = next;
        vec3 p = dir * next;
        float lxz = length(p.xz);
        vec2 plane = (p.xz + camera.xz) * 0.0007;
        float noise = (texture(EndNoise, plane * 0.175 - wind).b * 0.5 + texture(EndNoise, plane * 0.04375 + wind * 0.5).b * 2.0
                + texture(EndNoise, plane * 0.7 - wind).b * 0.5) / 3.0;
        float fire = texture(EndNoise, abs(plane * 0.1) - wind).b;
        float spread = (2000.0 * noise * noise + 40.0 * fire) * 0.001 * (250.0 + 0.5 * lxz);
        float altitude = abs(p.y + camera.y - BEAM_CENTER);
        float altitudeFactor = 0.5 * smoothstep(spread, 0.0, altitude) + 0.5 * smoothstep(4.0 * spread, 0.0, altitude);
        float n = noise * noise * 0.7 + 0.3 * fire;
        float a2 = altitudeFactor * altitudeFactor;
        n = pow(n * a2 * a2, 1.75);
        float f2 = (fire - 0.5) * (fire - 0.5);
        vec3 color = BEAM_PURPLE + END_PINK * 300.0 * (0.0015 + 0.2 * smoothstep(0.0, 256.0, lxz) * f2 * f2);
        sum += weight * n * color * (1.0 + smoothstep(0.0, 128.0, lxz));
        if (stop) {
            break;
        }
    }
    return sum;
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 color = texelFetch(Sampler0, pixel, 0).rgb;
    float depth = texelFetch(EndDepth, pixel, 0).r;
    vec2 ndc = texCoord * 2.0 - 1.0;
    vec4 farPoint = ModelViewMat * vec4(ndc, 0.5, 1.0);
    vec3 dir = normalize(farPoint.xyz / farPoint.w);
    bool sky = depth <= 0.0;
    float renderDistance = TextureMat[0][0];
    float dist = BEAM_DISTANCE;
    if (!sky) {
        vec4 point = ModelViewMat * vec4(ndc, ColorModulator.z > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
        dist = length(point.xyz / point.w);
    }
    float border = 1.0;
    if (!sky) {
        float b = dist / renderDistance;
        b *= b;
        border = 1.0 - exp(-3.0 * b * b);
    }
    vec3 result = color;
    if (ColorModulator.w > 0.5 && !sky) {
        float renderFactor = min(1.0, 192.0 / renderDistance);
        float atm = 1.0 - exp(-(dist * 0.001) * (dist * 0.001) * dist * renderFactor);
        float altitude = dir.y * dist + ModelOffset.y;
        float above = 1.0 - clamp(altitude - 55.1, 0.0, 30.0) / 30.0;
        atm *= 0.35 * (above * above * 0.9 + 0.1);
        result = mix(color, ATM_FOG, clamp(atm, 0.0, 1.0));
        result = mix(result, ATM_FOG, clamp(border, 0.0, 1.0));
    }
    if (ColorModulator.x > 0.5) {
        float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        float rayEnd = sky ? BEAM_DISTANCE : mix(min(dist, BEAM_DISTANCE), BEAM_DISTANCE, border);
        vec3 beams = max(enderBeams(dir, rayEnd, ModelOffset, ColorModulator.y, dither), vec3(0.0)) * BEAM_INTENSITY;
        vec3 base = max(pow(max(result, vec3(0.0)), vec3(2.2)), vec3(0.001));
        vec3 linear = lottes(base + beams) * base / lottes(base);
        result = pow(clamp(linear, 0.0, 1.0), vec3(1.0 / 2.2));
    }
    fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
