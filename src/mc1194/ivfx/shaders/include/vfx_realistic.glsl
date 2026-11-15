#ifndef IMMERSIVEVFX_REALISTIC_GLSL
#define IMMERSIVEVFX_REALISTIC_GLSL

float sqrt1(float x) {
    return x * (2.0 - x);
}

float sqrt2(float x) {
    x = 1.0 - x;
    x *= x;
    x *= x;
    return 1.0 - x;
}

float sqrt3(float x) {
    x = 1.0 - x;
    x *= x;
    x *= x;
    x *= x;
    return 1.0 - x;
}

struct Atmosphere {
    vec3 sunDir;
    float sunFactor;
    float sunVisibility;
    float noonFactor;
    float nightFactor;
    vec3 skyColor;
    float rainFactor;
    float shadowTime;
    vec3 dayUp;
    vec3 dayMiddle;
    vec3 dayDown;
    vec3 sunsetDownP;
    vec3 nightUp;
    vec3 nightMiddle;
    vec3 nightDown;
};

Atmosphere atmosphereFrom(vec4 sun, vec4 factors, vec4 skyRain) {
    Atmosphere a;
    a.sunDir = vec3(sun.xy, 0.0);
    a.sunFactor = factors.x;
    a.sunVisibility = factors.y;
    a.noonFactor = factors.z;
    a.nightFactor = factors.w;
    a.skyColor = skyRain.rgb;
    a.rainFactor = skyRain.w;
    float rainFactor2 = a.rainFactor * a.rainFactor;
    float invRainFactor = 1.0 - a.rainFactor;
    float invNoonFactor = 1.0 - a.noonFactor;
    float invNoonFactor2 = invNoonFactor * invNoonFactor;
    float shadowTimeVar = abs(a.sunVisibility - 0.5) * 2.0;
    shadowTimeVar *= shadowTimeVar;
    a.shadowTime = shadowTimeVar * shadowTimeVar;

    vec3 skyColorSqrt = sqrt(max(a.skyColor, vec3(0.0)));
    float invRainStrength2 = invRainFactor * invRainFactor;
    vec3 skyColorM = mix(max(skyColorSqrt, vec3(0.63, 0.67, 0.73)), skyColorSqrt, invRainStrength2);
    vec3 skyColorM2 = mix(max(a.skyColor, a.sunFactor * vec3(0.265, 0.295, 0.35)), a.skyColor, invRainStrength2);
    vec3 nuscWeatherM = vec3(0.1, 0.0, 0.1);
    vec3 nmscWeatherM = vec3(-0.1, -0.4, -0.6) + vec3(0.0, 0.06, 0.12) * a.noonFactor;
    vec3 ndscWeatherM = vec3(-0.15, -0.3, -0.42) + vec3(0.0, 0.02, 0.08) * a.noonFactor;
    bool below = sun.z > 0.5;
    vec3 noonUpSkyColor = pow(skyColorM, vec3(2.9)) * ((below ? vec3(0.85, 0.92, 0.81) : vec3(0.85, 0.768, 0.857)) + a.rainFactor * nuscWeatherM);
    vec3 noonMiddleSkyColor = skyColorM * ((below ? vec3(1.4, 1.3, 1.3) : vec3(1.4, 1.3, 1.58)) + a.rainFactor * nmscWeatherM) + noonUpSkyColor * 0.25;
    vec3 noonDownSkyColor = skyColorM * ((below ? vec3(0.9) : vec3(0.9, 0.9, 1.089)) + a.rainFactor * ndscWeatherM) + noonUpSkyColor * 0.25;
    vec3 sunsetUpSkyColor = skyColorM2 * (vec3(0.72, 0.522, 0.47) + vec3(0.1, 0.2, 0.35) * rainFactor2);
    vec3 sunsetMiddleSkyColor = skyColorM2 * ((below ? vec3(1.8, 1.3, 1.2) : vec3(1.8, 1.3, 1.473)) + vec3(0.15, 0.25, -0.05) * rainFactor2);
    a.sunsetDownP = vec3(1.45, 0.86, below ? 0.5 : a.sunDir.x > 0.0 ? 0.777 : 0.83) - vec3(0.8, 0.3, 0.0) * a.rainFactor;
    vec3 sunsetDownSkyColor = a.sunsetDownP * 0.5 + 0.25 * sunsetMiddleSkyColor;
    a.dayUp = mix(noonUpSkyColor, sunsetUpSkyColor, invNoonFactor2);
    a.dayMiddle = mix(noonMiddleSkyColor, sunsetMiddleSkyColor, invNoonFactor2);
    a.dayDown = mix(noonDownSkyColor, sunsetDownSkyColor, invNoonFactor2);
    vec3 nightColFactor = (below ? vec3(0.063, 0.126, 0.216) : vec3(0.045, 0.08, 0.232)) * (1.0 - 0.5 * a.rainFactor) + a.skyColor;
    a.nightUp = pow(max(nightColFactor, vec3(0.0)), vec3(0.90)) * (below ? 0.45 : 0.383);
    a.nightMiddle = sqrt(a.nightUp) * (below ? 0.65 : 0.636);
    a.nightDown = a.nightMiddle * vec3(0.82, 0.82, 0.88);
    return a;
}

Atmosphere atmosphereUnpack(vec4 sun, vec4 factors, vec4 skyRain, vec4 p0, vec4 p1, vec4 p2, vec4 p3, vec4 p4, vec4 p5, vec4 p6) {
    Atmosphere a;
    a.sunDir = vec3(sun.xy, 0.0);
    a.sunFactor = factors.x;
    a.sunVisibility = factors.y;
    a.noonFactor = factors.z;
    a.nightFactor = factors.w;
    a.skyColor = skyRain.rgb;
    a.rainFactor = skyRain.w;
    a.shadowTime = p0.w;
    a.dayUp = p0.xyz;
    a.dayMiddle = p1.xyz;
    a.dayDown = p2.xyz;
    a.sunsetDownP = p3.xyz;
    a.nightUp = p4.xyz;
    a.nightMiddle = p5.xyz;
    a.nightDown = p6.xyz;
    return a;
}

#ifndef VFX_NO_TEXTURE_MAT
Atmosphere atmosphere() {
    return atmosphereFrom(TextureMat[1], TextureMat[2], TextureMat[3]);
}
#endif

vec3 realisticSkyBase(Atmosphere a, vec3 dir) {
    float rainFactor2 = a.rainFactor * a.rainFactor;
    float invRainFactor = 1.0 - a.rainFactor;
    float invNoonFactor = 1.0 - a.noonFactor;
    float VdotU = dir.y;
    float VdotS = dot(dir, a.sunDir);
    float nightFactorSqrt2 = sqrt2(a.nightFactor);
    float nightFactorM = sqrt2(nightFactorSqrt2) * 0.4;
    float VdotSM1 = max(VdotS, 0.0) * max(VdotS, 0.0);
    float VdotSM2 = VdotSM1 * VdotSM1;
    float VdotSM3 = max(-VdotS, 0.0);
    VdotSM3 *= VdotSM3;
    VdotSM3 *= VdotSM3;
    float VdotSML = a.sunVisibility > 0.5 ? VdotS : -VdotS;
    float VdotUmax0 = max(VdotU, 0.0);

    vec3 upColor = mix(a.nightUp * (1.5 - 0.5 * nightFactorSqrt2 + nightFactorM * VdotSM3 * 1.5), a.dayUp, a.sunFactor);
    vec3 middleColor = mix(a.nightMiddle * (3.0 - 2.0 * nightFactorSqrt2), a.dayMiddle * (1.0 + VdotSM2 * 0.3), a.sunFactor);
    vec3 downColor = mix(a.nightDown, a.dayDown, (a.sunFactor + a.sunVisibility) * 0.5);

    float VdotUM1 = (1.0 - VdotUmax0) * (1.0 - VdotUmax0);
    VdotUM1 = pow(VdotUM1, (1.0 - VdotSM2 * 0.4) * (1.15 - 0.15 * rainFactor2));
    VdotUM1 = mix(VdotUM1, 1.0, rainFactor2 * 0.15);
    vec3 finalSky = mix(upColor, middleColor, VdotUM1);

    float VdotUM2 = (1.0 - abs(VdotU)) * (1.0 - abs(VdotU));
    VdotUM2 = VdotUM2 * VdotUM2 * (3.0 - 2.0 * VdotUM2);
    VdotUM2 *= (0.7 - nightFactorM + VdotSM1 * (0.3 + nightFactorM)) * invNoonFactor * a.sunFactor;
    finalSky = mix(finalSky, a.sunsetDownP * (1.0 + VdotSM1 * 0.3), VdotUM2 * invRainFactor);

    float VdotUM3 = min(max(-VdotU + 0.08, 0.0) / 0.35, 1.0);
    VdotUM3 = VdotUM3 * VdotUM3 * (3.0 - 2.0 * VdotUM3);
    vec3 scatteredGroundMixer = vec3(VdotUM3 * VdotUM3, sqrt1(VdotUM3), sqrt3(VdotUM3));
    scatteredGroundMixer = mix(vec3(VdotUM3), scatteredGroundMixer, 0.75 - 0.5 * a.rainFactor);
    finalSky = mix(finalSky, downColor, scatteredGroundMixer);
    return finalSky;
}

float realisticGlare(Atmosphere a, vec3 dir) {
    float VdotS = dot(dir, a.sunDir);
    if (0.0 >= (a.sunVisibility > 0.5 ? VdotS : -VdotS)) {
        return 0.0;
    }
    float glareScatter = 3.0 * (2.0 - clamp(VdotS * 1000.0, 0.0, 1.0));
    glareScatter *= 1.0 - 0.75 * a.rainFactor * a.rainFactor;
    float VdotSM4 = pow(abs(VdotS), glareScatter);
    float visfactor = 0.075;
    return (visfactor / (1.0 - (1.0 - visfactor) * VdotSM4) - visfactor) * 0.7 * (1.0 - 0.8 * a.rainFactor);
}

vec3 realisticGlareColor(Atmosphere a) {
    vec3 glareColor = mix(vec3(0.38, 0.4, 0.5) * 0.3, vec3(1.5, 0.7, 0.3) + vec3(0.0, 0.5, 0.5) * a.noonFactor, a.sunVisibility);
    return mix(glareColor, vec3(dot(glareColor, vec3(0.2125, 0.7154, 0.0721))), 0.5 * a.rainFactor);
}

vec3 realisticSky(Atmosphere a, vec3 dir) {
    return realisticSkyBase(a, dir) + realisticGlareColor(a) * realisticGlare(a, dir) * a.shadowTime;
}

vec3 realisticSkyBelow(Atmosphere a, vec3 dir, vec3 water) {
    return mix(realisticSkyBase(a, dir) * 3.0, water, 1.0 - dir.y * dir.y) + (realisticGlareColor(a) + 7.0 * a.sunVisibility) * realisticGlare(a, dir) * a.shadowTime;
}

vec3 realisticTonemapEncoded(vec3 linear, vec3 encoded) {
    float luminance = dot(linear, vec3(0.2125, 0.7154, 0.0721));
    vec3 xa = pow(linear, vec3(1.05));
    vec3 mapped = xa / (xa * 0.9190 + 0.7188);
    vec3 colorOut = mix(1.055 * pow(mapped, vec3(1.0 / 2.4)) - 0.055, 12.92 * mapped, lessThan(mapped, vec3(0.0031308)));
    colorOut = mix(colorOut, encoded, smoothstep(0.1, 0.0, luminance) * 0.75);
    colorOut = mix(colorOut, vec3(1.0), smoothstep(0.0, 16.0, luminance));
    colorOut = mix(colorOut, vec3(dot(colorOut, vec3(0.2125, 0.7154, 0.0721))), smoothstep(0.1, 0.0, luminance) * 0.25);
    return clamp(colorOut, 0.0, 1.0);
}

vec3 realisticTonemapLinear(vec3 linear) {
    linear = max(linear, vec3(0.0));
    return realisticTonemapEncoded(linear, pow(linear, vec3(1.0 / 2.2)));
}

vec3 realisticTonemap(vec3 color) {
    vec3 encoded = max(color, vec3(0.0));
    return realisticTonemapEncoded(pow(encoded, vec3(2.2)), encoded);
}

#endif
