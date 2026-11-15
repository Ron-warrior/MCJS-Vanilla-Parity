#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D DepthSampler;
uniform sampler2D FrontDepth;
uniform sampler2D ReferenceNoise;
uniform sampler2D VfxShadowMap;
uniform sampler2D VfxShadowMapPrev;

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

const vec3 UNDERWATER_MULT = vec3(0.80, 0.87, 0.97);
const float MAX_DISTANCE = 128.0;
const float GOLDEN_RATIO = 1.61803398875;

vec3 unproject(vec2 uv, float depth) {
    vec4 world = WaterInvViewProj * vec4(uv * 2.0 - 1.0, WaterParams.y > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    return world.xyz / world.w;
}

float rayLookup(sampler2D map, mat4 matrix, vec3 p) {
    vec3 pos = (matrix * vec4(p, 1.0)).xyz;
    if (any(lessThanEqual(pos, vec3(0.0))) || any(greaterThanEqual(pos, vec3(1.0)))) {
        return 1.0;
    }
    return step(textureLod(map, pos.xy, 0.0).r, pos.z + 0.0005);
}

float rayVisibility(vec3 p) {
    if (WaterView.y < 0.5) {
        return 1.0;
    }
    float now = rayLookup(VfxShadowMap, WaterShadowMat, p);
    if (WaterCamera.w < 0.999) {
        now = mix(rayLookup(VfxShadowMapPrev, WaterShadowPrev, p), now, WaterCamera.w);
    }
    return now;
}

float waterNoise(vec2 world, float horizontal) {
    vec2 wind = vec2(WaterFog.a * 0.01, 0.0);
    float noise = textureLod(ReferenceNoise, world * 0.012 - wind, 0.0).g;
    noise += textureLod(ReferenceNoise, world * 0.05 + wind, 0.0).g;
    float factor = max(2.5 - 0.025 * horizontal, 0.8333) * 1.3;
    return pow(noise * 0.5, factor) * factor * 1.3;
}

float sliceWeight(float distance) {
    float x = pow(distance / MAX_DISTANCE, WaterVlParams.z);
    return x * x * (3.0 - 2.0 * x);
}

vec3 volumetricLight(vec3 eye, vec3 dir, float viewFront, float viewBack, bool sky, float dither) {
    float far = max(WaterView.x, 1.0);
    float scene = WaterSun.w;
    float up = max(dir.y, 0.0);
    float towardLight = max((dot(dir, WaterSun.xyz) + 1.0) / 2.0, 0.0);
    float height = mix((1.0 - up) * (1.0 - up), 1.0, 0.5 * scene);
    height = height * height * (3.0 - 2.0 * height);
    height = pow(height, min(viewBack / far, 1.0) * (3.0 - 2.0 * scene));
    float mult = WaterVlMult.x * mix(height * towardLight, 1.0, 0.4 * WaterVlMult.y);
    if (scene < 0.5) {
        mult *= 0.3 + 0.4 * WaterVlMult.z + 0.5 * max(far - viewBack, 0.0) / far;
    }
    if (mult < 0.0001) {
        return vec3(0.0);
    }
    float rayEnd = sky ? MAX_DISTANCE : min(viewBack, MAX_DISTANCE);
    if (WaterSprite.y < 0.5) {
        rayEnd = min(rayEnd, viewFront);
    }
    float qualityThreshold = WaterVlParams.w;
    float activeThreshold = min(qualityThreshold, MAX_DISTANCE);
    int nearSamples = int(WaterVlParams.x);
    int totalSamples = rayEnd <= qualityThreshold ? nearSamples : nearSamples + 1;
    vec2 slope = WaterSun.xz / max(WaterSun.y, 0.02);
    vec3 translucentMult = vec3(1.0);
    if (viewFront < viewBack) {
        float grazing = 1.0 - up;
        grazing *= grazing;
        float fade = viewFront / far;
        fade *= fade;
        translucentMult = mix(WaterAir.rgb * (1.0 - grazing * grazing), vec3(1.0), min(fade * fade, 1.0));
    }
    vec3 volumetric = vec3(0.0);
    float lastWeight = sliceWeight(0.0);
    for (int i = 0; i <= totalSamples; i++) {
        float nextDistance;
        vec3 localDensity;
        if (i <= nearSamples) {
            float t = (float(i) + dither) / float(nearSamples);
            nextDistance = pow(t, WaterVlParams.y) * activeThreshold;
            if (nextDistance >= rayEnd) {
                break;
            }
            vec3 p = eye + dir * nextDistance;
            float visibility = rayVisibility(p);
            if (p.y < WaterParams.x) {
                vec2 entry = p.xz + slope * (WaterParams.x - p.y);
                float noise = waterNoise(entry + WaterCamera.xz, length(entry));
                localDensity = WaterVlDensity.rgb * noise * noise * visibility;
            } else {
                vec3 tinter = pow(translucentMult * 2.8, vec3(WaterVlColor.w * 3.0 * clamp(p.y * 0.03, 0.0, 1.0)));
                localDensity = mix(vec3(1.0), tinter, WaterAir.a) * visibility;
            }
        } else {
            float t = float(i - nearSamples) + dither;
            nextDistance = mix(activeThreshold, MAX_DISTANCE, pow(t, 2.5));
            if (nextDistance >= rayEnd) {
                nextDistance = rayEnd;
            }
            localDensity = vec3(WaterVlDensity.a);
        }
        float weight = sliceWeight(nextDistance);
        vec3 stepResult = localDensity * (weight - lastWeight);
        if (nextDistance > viewFront) {
            stepResult *= translucentMult;
        }
        volumetric += stepResult;
        lastWeight = weight;
    }
    vec3 tint = UNDERWATER_MULT * 0.55;
    return max(volumetric * WaterVlColor.rgb * mult, vec3(0.0)) * tint * tint;
}

float visibleDepth(ivec2 pixel, vec2 uv) {
    float back = texelFetch(DepthSampler, pixel, 0).r;
    float front = texelFetch(FrontDepth, pixel, 0).r;
    if (front == back) {
        return back;
    }
    return WaterParams.x > 0.001 && abs(unproject(uv, front).y - WaterParams.x) < 0.15 ? back : front;
}

void main() {
    float depth = visibleDepth(ivec2(texCoord * vec2(textureSize(DepthSampler, 0))), texCoord);
    vec4 eyeClip = WaterInvViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    vec3 eye = eyeClip.xyz / eyeClip.w;
    vec3 dir = normalize(unproject(texCoord, 0.5) - eye);
    bool sky = depth <= 0.0;
    float toSurface = WaterParams.x > 0.001 && dir.y > 0.001 ? WaterParams.x / dir.y : 1.0e6;
    float viewBack = sky ? 1.0e6 : length(unproject(texCoord, depth) - eye);
    float dither = textureLod(ReferenceNoise, gl_FragCoord.xy / 128.0, 0.0).b;
    dither = fract(dither + GOLDEN_RATIO * WaterSprite.x);
    fragColor = vec4(volumetricLight(eye, dir, min(viewBack, toSurface), viewBack, sky, dither), min(viewBack, 2048.0));
}
