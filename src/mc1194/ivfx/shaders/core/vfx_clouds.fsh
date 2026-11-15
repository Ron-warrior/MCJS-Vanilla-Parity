#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <minecraft:fog.glsl>
#include <immersivevfx:vfx_realistic.glsl>

uniform sampler2D Sampler0;
uniform sampler2D SceneDepth;

layout(std140) uniform VfxClouds {
    vec4 CloudLut;
    vec4 CloudAdd;
    vec4 CloudShape;
    vec4 CloudLight;
};

layout(location = 0) in vec3 cloudPosition;
layout(location = 1) in vec2 cloudCell;
layout(location = 2) in vec4 cloudStyle;
layout(location = 3) flat in vec4 vfxAtmo0;
layout(location = 4) flat in vec4 vfxAtmo1;
layout(location = 5) flat in vec4 vfxAtmo2;
layout(location = 6) flat in vec4 vfxAtmo3;
layout(location = 7) flat in vec4 vfxAtmo4;
layout(location = 8) flat in vec4 vfxAtmo5;
layout(location = 9) flat in vec4 vfxAtmo6;

layout(location = 0) out vec4 fragColor;

Atmosphere vfxAtmosphere() {
    return atmosphereUnpack(TextureMat[1], TextureMat[2], TextureMat[3], vfxAtmo0, vfxAtmo1, vfxAtmo2, vfxAtmo3, vfxAtmo4, vfxAtmo5, vfxAtmo6);
}

vec3 cloudLight(Atmosphere a, vec3 dir, float shade) {
    float vsBrightness = CloudLight.x;
    float rainFactor = a.rainFactor;
    float noonFactor = a.noonFactor;
    float invNoonFactor = 1.0 - noonFactor;
    float sunVisibility2 = a.sunVisibility * a.sunVisibility;

    vec3 noonClearLightColor = vec3(0.65, 0.55, 0.375) * 2.05;
    vec3 noonClearAmbientColor = pow(max(a.skyColor, vec3(0.0)), vec3(0.75)) * 0.85;
    vec3 sunsetClearLightColor = pow(vec3(0.64, 0.45, 0.3), vec3(1.5 + invNoonFactor)) * 5.0;
    vec3 sunsetClearAmbientColor = noonClearAmbientColor * vec3(1.21, 0.92, 0.76) * 0.95;
    vec3 nightClearLightColor = 0.9 * vec3(0.11, 0.14, 0.20);
    vec3 nightClearAmbientColor = 0.9 * vec3(0.09, 0.12, 0.17) * (1.55 + vsBrightness * 0.77);
    vec3 dayRainLightColor = vec3(0.21, 0.16, 0.13) * 0.85 + noonFactor * vec3(0.0, 0.02, 0.06);
    vec3 dayRainAmbientColor = vec3(0.2, 0.2, 0.25) * (1.8 + 0.5 * vsBrightness);
    vec3 nightRainLightColor = vec3(0.03, 0.035, 0.05) * (0.5 + 0.5 * vsBrightness);
    vec3 nightRainAmbientColor = vec3(0.16, 0.20, 0.3) * (0.75 + 0.6 * vsBrightness);
    vec3 dayLightColor = mix(sunsetClearLightColor, noonClearLightColor, noonFactor);
    vec3 dayAmbientColor = mix(sunsetClearAmbientColor, noonClearAmbientColor, noonFactor);
    vec3 clearLightColor = mix(nightClearLightColor, dayLightColor, sunVisibility2);
    vec3 clearAmbientColor = mix(nightClearAmbientColor, dayAmbientColor, sunVisibility2);
    vec3 rainLightColor = mix(nightRainLightColor, dayRainLightColor, sunVisibility2) * 2.5;
    vec3 rainAmbientColor = mix(nightRainAmbientColor, dayRainAmbientColor, sunVisibility2);
    vec3 lightColor = mix(clearLightColor, rainLightColor, rainFactor);
    vec3 ambientColor = mix(clearAmbientColor, rainAmbientColor, rainFactor);

    vec3 cloudRainColor = mix(a.nightMiddle, a.dayMiddle, a.sunFactor);
    vec3 cloudAmbientColor = mix(ambientColor * (sunVisibility2 * (0.55 + vec3(0.2, 0.1, 0.0) * noonFactor) + 0.35), cloudRainColor * 0.5, rainFactor);
    vec3 cloudLightColor = mix(lightColor * 1.3, cloudRainColor * 0.45, noonFactor * rainFactor);
    cloudAmbientColor *= 1.0 - 0.25 * rainFactor;

    float VdotS = dot(dir, a.sunDir);
    float cloudShading = pow(clamp(shade, 0.0, 1.0), 0.8);
    float VdotSM1 = max(a.sunVisibility > 0.5 ? VdotS : -VdotS, 0.0);
    float light = 0.6 + 1.4 * cloudShading * cloudShading;
    float VdotSM2 = VdotSM1 * a.shadowTime * 0.25;
    VdotSM2 += 0.5 * cloudShading + 0.08;
    cloudShading = VdotSM2 * light;

    return cloudAmbientColor * 0.95 * (1.0 - 0.35 * cloudShading) + cloudLightColor * 0.9 * (0.1 + cloudShading);
}

vec3 lutColor(float w) {
    vec2 uv = vec2(CloudLut.x, (3.0 - w) * CloudLut.y + CloudLut.z);
    return texture(Sampler0, uv).rgb * CloudLut.w + CloudAdd.rgb;
}

vec3 cloudFloor(vec3 color) {
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return luma < 0.07 ? color * 0.07 / max(luma, 0.002) : color;
}

vec3 skyGrade(vec3 color, float up) {
    float haze = linear_fog_value(128.0, FogEnvironmentalStart, FogEnvironmentalEnd) * FogColor.a;
    float band = 1.0 - smoothstep(-0.05, 0.45, up);
    color = mix(color, FogColor.rgb, band * haze);
    vec4 tint = TextureMat[0];
    if (tint.w > 0.0) {
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        vec3 recolor = tint.rgb * luma / max(dot(tint.rgb, vec3(0.299, 0.587, 0.114)), 0.05);
        color = mix(color, recolor, tint.w);
    }
    float horizon = 1.0 - smoothstep(0.0, 0.15, up);
    return mix(color, FogColor.rgb, horizon * FogColor.a);
}

float cloudWeight() {
    float r = CloudLight.y * length(cloudCell) / CloudShape.y;
    float w;
    if (CloudShape.x > 0.5) {
        w = 1.079848 - 0.106653 * r;
    } else {
        float t = clamp((7.85 - r) / 6.35, 0.0, 1.0);
        w = t * sqrt(t);
    }
    float offset = (floor(cloudStyle.b * 255.0 + 0.5) - 128.0) / 255.0;
    return clamp(max(clamp(w, 0.0, 1.0) * cloudStyle.g + offset, cloudStyle.a), 0.0, 1.0);
}

vec4 cloudColor(float sceneDepth) {
    float distance = length(cloudPosition);
    vec3 dir = cloudPosition / max(distance, 0.0001);
    float horizontalDistance = length(cloudPosition.xz);
    float up = CloudShape.y / sqrt(CloudShape.y * CloudShape.y + horizontalDistance * horizontalDistance);
    float fade = CloudAdd.a * (1.0 - smoothstep(CloudShape.z, CloudShape.w, horizontalDistance));
    if (fade <= 0.0) {
        discard;
    }
    bool sky = sceneDepth <= 0.0;
    if (TextureMat[1].w > 0.5) {
        Atmosphere a = vfxAtmosphere();
        vec3 skyColor = TextureMat[1].z > 0.5 ? realisticSkyBelow(a, dir, FogColor.rgb) : realisticSky(a, dir);
        vec3 cloud = cloudLight(a, dir, cloudStyle.r);
        float ratio = clamp((4000.0 - horizontalDistance) / 4000.0, 0.0, 1.0);
        float haze = 1.0 - smoothstep(-0.05, 0.45, up);
        float horizon = 1.0 - smoothstep(0.0, 0.15, up);
        float alpha = ratio * ratio * 0.707 * 0.707;
        float distant = 1.0 - max(haze, horizon);
        if (sky) {
            return vec4(realisticTonemap(mix(skyColor, cloud, alpha * distant)), fade);
        }
        return vec4(realisticTonemap(mix(skyColor, cloud, alpha)), distant * fade);
    }
    float w = cloudWeight();
    vec3 cloud = skyGrade(cloudFloor(lutColor(1.0)), up);
    if (sky) {
        return vec4(mix(skyGrade(lutColor(0.0), dir.y), cloud, w), fade);
    }
    return vec4(cloud, w * fade);
}

void main() {
    float sceneDepth = texelFetch(SceneDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (gl_FragCoord.z < sceneDepth * 0.999) {
        discard;
    }
    vec4 color = cloudColor(sceneDepth);
#ifdef CLOUD_COVERAGE
    fragColor = vec4(color.a);
#else
    fragColor = color;
#endif
}
