#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#ifdef HORIZON_FOG
#include <minecraft:fog.glsl>
#endif

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord0;
layout(location = 1) in vec4 vertexColor;
layout(location = 2) in vec4 overlayColor;
layout(location = 3) in vec3 skyPosition;

layout(location = 0) out vec4 fragColor;

#ifdef HORIZON_FOG
#include <immersivevfx:vfx_realistic.glsl>

layout(location = 4) flat in vec4 vfxAtmo0;
layout(location = 5) flat in vec4 vfxAtmo1;
layout(location = 6) flat in vec4 vfxAtmo2;
layout(location = 7) flat in vec4 vfxAtmo3;
layout(location = 8) flat in vec4 vfxAtmo4;
layout(location = 9) flat in vec4 vfxAtmo5;
layout(location = 10) flat in vec4 vfxAtmo6;

Atmosphere vfxAtmosphere() {
    return atmosphereUnpack(TextureMat[1], TextureMat[2], TextureMat[3], vfxAtmo0, vfxAtmo1, vfxAtmo2, vfxAtmo3, vfxAtmo4, vfxAtmo5, vfxAtmo6);
}

vec3 realisticCloud(Atmosphere a, vec3 dir, float shade) {
    float vsBrightness = ModelOffset.y;
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

    vec3 colorSample = cloudAmbientColor * 0.95 * (1.0 - 0.35 * cloudShading) + cloudLightColor * 0.9 * (0.1 + cloudShading);
    vec3 cloudSkyColor = TextureMat[1].z > 0.5 ? realisticSkyBelow(a, dir, FogColor.rgb) : realisticSky(a, dir);
    float horizontal = sqrt(max(1.0 - dir.y * dir.y, 0.0));
    float distanceXZ = abs(ModelOffset.x) * horizontal / max(abs(dir.y), 0.001);
    float distanceRatio = (4000.0 - distanceXZ) / 4000.0;
    float cloudFogFactor = clamp(distanceRatio, 0.0, 1.0);
    cloudFogFactor = cloudFogFactor * cloudFogFactor * 0.707;
    colorSample = mix(cloudSkyColor, colorSample, cloudFogFactor * 0.707);
    float haze = 1.0 - smoothstep(-0.05, 0.45, dir.y);
    float horizon = 1.0 - smoothstep(0.0, 0.15, dir.y);
    colorSample = mix(colorSample, cloudSkyColor, max(haze, horizon));
    return realisticTonemap(colorSample);
}
#endif

void main() {
    vec4 color = texture(Sampler0, texCoord0);
#ifdef ALPHA_TEST
    if (color.a * overlayColor.a < 0.5) {
        discard;
    }
#endif
#ifdef LUT
    fragColor = vec4(color.rgb * vertexColor.rgb + overlayColor.rgb, vertexColor.a) * ColorModulator;
#else
    fragColor = vec4(color.rgb * vertexColor.rgb + overlayColor.rgb, color.a * vertexColor.a) * ColorModulator;
#endif
#ifdef HORIZON_FOG
    vec3 dir = normalize(skyPosition);
    float up = dir.y;
    bool realistic = TextureMat[1].w > 0.5;
    if (realistic) {
#ifdef SKY_DEPTH
        fragColor.rgb = realisticCloud(vfxAtmosphere(), dir, vertexColor.r);
#else
        fragColor.rgb = realisticTonemap(TextureMat[1].z > 0.5 ? realisticSkyBelow(vfxAtmosphere(), dir, FogColor.rgb) : realisticSky(vfxAtmosphere(), dir));
#endif
        return;
    } else {
        float haze = linear_fog_value(128.0, FogEnvironmentalStart, FogEnvironmentalEnd) * FogColor.a;
        float band = 1.0 - smoothstep(-0.05, 0.45, up);
        fragColor.rgb = mix(fragColor.rgb, FogColor.rgb, band * haze);
    }
    vec4 tint = TextureMat[0];
    if (tint.w > 0.0) {
        float luma = dot(fragColor.rgb, vec3(0.299, 0.587, 0.114));
        vec3 recolor = tint.rgb * luma / max(dot(tint.rgb, vec3(0.299, 0.587, 0.114)), 0.05);
        fragColor.rgb = mix(fragColor.rgb, recolor, tint.w);
    }
    float horizon = 1.0 - smoothstep(0.0, 0.15, up);
    fragColor.rgb = mix(fragColor.rgb, FogColor.rgb, horizon * FogColor.a);
#endif
}
