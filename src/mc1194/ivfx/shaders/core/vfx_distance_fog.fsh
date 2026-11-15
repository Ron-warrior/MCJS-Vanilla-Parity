#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
#include <immersivevfx:vfx_realistic.glsl>

uniform sampler2D Sampler0;
uniform sampler2D FogDepth;
uniform sampler2D FogSky;
uniform sampler2D FogClouds;
uniform sampler2D FogBefore;
uniform sampler2D FogBeforeDepth;
uniform sampler2D FogMid;
uniform sampler2D FogLate;

layout(location = 0) in vec2 texCoord;
layout(location = 1) flat in vec4 vfxAtmo0;
layout(location = 2) flat in vec4 vfxAtmo1;
layout(location = 3) flat in vec4 vfxAtmo2;
layout(location = 4) flat in vec4 vfxAtmo3;
layout(location = 5) flat in vec4 vfxAtmo4;
layout(location = 6) flat in vec4 vfxAtmo5;
layout(location = 7) flat in vec4 vfxAtmo6;

layout(location = 0) out vec4 fragColor;

layout(std140) uniform VfxFogExtra {
    mat4 FogExtraView;
    mat4 FogExtraTexture;
    vec4 FogExtraParams;
    vec3 FogExtraOffset;
};

float linearFog(float distance, float start, float end) {
    if (distance <= start) {
        return 0.0;
    }
    if (distance >= end) {
        return 1.0;
    }
    return (distance - start) / (end - start);
}

float atmosphericAltitude(float altitude, float range) {
    float factor = 1.0 - clamp(altitude - 63.1, 0.0, range) / range;
    return factor * factor;
}

float atmosphericAmount(vec3 position, float dist, float cameraY, float eyeBrightness, float rainFactor, float renderDistance, bool near,
                        float atmDistance, float heavy, out float altitudeFactorRaw) {
    float rainFactor2 = rainFactor * rainFactor;
    float invRainFactor = 1.0 - rainFactor;
    float altitudeRange = near ? 90.0 : 60.0;
    float fog;
    if (near) {
        fog = 1.0 - exp2(-max(dist - 40.0, 0.0) * (0.4 + 0.4 * rainFactor) / atmDistance);
    } else {
        float renDisFactor = min(1.0, 192.0 / renderDistance) * 100.0 / atmDistance;
        fog = 1.0 - exp(-pow(dist * (0.001 - 0.0007 * rainFactor), 2.0 - rainFactor2) * dist * renDisFactor);
    }
    float rawFog = fog;
    altitudeFactorRaw = atmosphericAltitude(position.y + cameraY, altitudeRange);
    float altitudeFactor = altitudeFactorRaw * 0.9 + 0.1;
    if (near) {
        float fog2 = fog * fog;
        altitudeFactor = mix(altitudeFactor, 1.0, fog2 * fog2);
    }
    fog *= 0.95 - 0.1 - 0.15 * invRainFactor;
    float cameraAltitudeFactor = atmosphericAltitude(cameraY + 0.25 * altitudeRange, altitudeRange);
    altitudeFactor = mix(altitudeFactor, 1.0, 0.8 * cameraAltitudeFactor);
    altitudeFactor *= 1.0 - 0.5 * cameraAltitudeFactor * invRainFactor;
    float caveFactor = clamp(1.0 - cameraY / 61.9, 0.0, 1.0 - eyeBrightness);
    float indoor = (0.2 + 0.8 * sqrt2(eyeBrightness)) * (1.0 - caveFactor);
    fog *= indoor;
    fog *= altitudeFactor;
    return mix(fog, rawFog * 0.97 * indoor, heavy);
}

vec3 biomeLit(vec3 reference) {
    vec3 luma = vec3(0.2126, 0.7152, 0.0722);
    return FogExtraOffset * clamp(dot(reference, luma) / max(dot(FogExtraOffset, luma), 0.02), 0.35, 1.25);
}

vec3 dynamicSky(vec3 color, vec3 dir) {
    float tint = FogExtraTexture[0][0];
    if (tint <= 0.0) {
        return color;
    }
    float heavy = FogExtraTexture[0][1];
    float band = 1.0 - smoothstep(-0.02, mix(0.12, 0.35, heavy), dir.y);
    return mix(color, biomeLit(color), tint * band * mix(0.55, 0.97, heavy) * 0.85);
}

vec3 groundFog(ivec2 pixel, vec2 ndc, vec3 own) {
    if (FogExtraParams.z < 0.5) {
        return ModelOffset;
    }
    float height = float(textureSize(FogSky, 0).y);
    float horizon = -(ModelViewMat[0][1] * ndc.x + ModelViewMat[2][1] + ModelViewMat[3][1]) / max(ModelViewMat[1][1], 0.00001);
    float row = (horizon * 0.5 + 0.5 - 0.03) * height;
    if (float(pixel.y) <= row) {
        return own;
    }
    if (row < 0.0) {
        return ModelOffset;
    }
    int spacing = max(int(0.02 * height), 1);
    vec3 first = texelFetch(FogSky, ivec2(pixel.x, int(row)), 0).rgb;
    vec3 second = texelFetch(FogSky, ivec2(pixel.x, max(int(row) - spacing, 0)), 0).rgb;
    vec3 third = texelFetch(FogSky, ivec2(pixel.x, max(int(row) - 2 * spacing, 0)), 0).rgb;
    vec3 ground = max(min(first, second), min(max(first, second), third));
    return mix(ModelOffset, ground, clamp(row / (0.04 * height), 0.0, 1.0));
}

float vanillaAmount(float dist, float cylindrical) {
    return max(linearFog(dist, ColorModulator.z, ColorModulator.w), linearFog(cylindrical, TextureMat[1].z, TextureMat[0].w)) * ColorModulator.y;
}

float borderAmount(float cylindrical, float renderDistance, bool lod) {
    float border = cylindrical / max(renderDistance, ColorModulator.x);
    border *= border;
    border *= border;
    if (!lod) {
        border *= border;
        border *= border;
    }
    return clamp((1.0 - exp(-3.0 * border)) / 0.95, 0.0, 1.0);
}

vec3 fogged(vec3 color, vec3 position, float dist, float cylindrical, float vanillaFog, vec3 dir, vec3 background, bool realistic, Atmosphere a, float renderDistance, float cameraY,
           float eyeBrightness) {
    vec3 result = vanillaFog > 0.0 ? clamp(color + vanillaFog * (background - ModelOffset), 0.0, 1.0) : clamp(color, 0.0, 1.0);
    bool atmospheric = FogExtraParams.x > 0.5;
    if (!realistic) {
        float hazeDist = dist * FogExtraParams.w;
        if (atmospheric && hazeDist > 40.0) {
            float hazeAltitude;
            float haze = atmosphericAmount(position, hazeDist, cameraY, eyeBrightness, FogExtraParams.y, renderDistance, true, 50.0, FogExtraTexture[0][1], hazeAltitude);
            result = mix(result, ModelOffset, clamp(haze, 0.0, 1.0));
        }
        return result;
    }
    float rainFactor = a.rainFactor;
    float VdotS = dot(dir, a.sunDir);
    bool lod = ColorModulator.x > renderDistance + 16.0;
    bool near = lod || atmospheric;
    float altitudeFactorRaw = 0.0;
    float fogDist = atmospheric ? dist * FogExtraParams.w : dist;
    float fog = near && fogDist <= 40.0 ? 0.0 : atmosphericAmount(position, fogDist, cameraY, eyeBrightness, rainFactor, renderDistance, near, atmospheric ? 50.0 : max(TextureMat[1].w, 1.0),
                                  atmospheric ? FogExtraTexture[0][1] : 0.0, altitudeFactorRaw);
    if (fog > 0.0) {
        float altitudeFactorRaw2 = altitudeFactorRaw * altitudeFactorRaw;
        float nightFogMult = 2.5 - 0.625 * max(altitudeFactorRaw2 * altitudeFactorRaw2, rainFactor);
        float sunVisibility2 = a.sunVisibility * a.sunVisibility;
        float dayNightFogBlend = pow(1.0 - a.nightFactor, 4.0 - VdotS - 2.5 * sunVisibility2);
        vec3 dayFog = a.dayDown * (0.9 + 0.3 * a.noonFactor);
        if (near) {
            dayFog += a.dayUp * 0.2 * sqrt1(a.noonFactor);
        }
        vec3 atmosphericColor = mix(a.nightUp * (nightFogMult - dayNightFogBlend * nightFogMult), dayFog, dayNightFogBlend);
        vec3 realisticFog = realisticTonemap(atmosphericColor);
        vec3 fogColor = mix(realisticFog, biomeLit(realisticFog), FogExtraTexture[0][0] * 0.85);
        result = mix(result, fogColor, clamp(fog, 0.0, 1.0));
    }
    float border = borderAmount(cylindrical, renderDistance, lod);
    return border >= 0.0009765625 ? mix(result, background, border) : result;
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec3 finalColor = texelFetch(Sampler0, pixel, 0).rgb;
    float depth = texelFetch(FogDepth, pixel, 0).r;
    vec3 late = texelFetch(FogLate, pixel, 0).rgb;
    vec3 color = late;
    vec3 overlay = finalColor - late;
    if (depth == texelFetch(FogBeforeDepth, pixel, 0).r) {
        vec3 features = texelFetch(FogMid, pixel, 0).rgb - texelFetch(FogBefore, pixel, 0).rgb;
        color = max(late - features, vec3(0.0));
        overlay += features;
    }
    vec2 ndc = texCoord * 2.0 - 1.0;
    bool sky = depth <= 0.0;
    bool realistic = TextureMat[1].w > 0.5;
    float renderDistance = abs(TextureMat[0].x);
    bool zeroToOne = TextureMat[0].x > 0.0;
    float cameraY = TextureMat[0].y;
    float eyeBrightness = TextureMat[0].z;
    vec4 near = ModelViewMat * vec4(ndc, 1.0, 1.0);
    vec3 dir = normalize(near.xyz / near.w);
    vec3 position = dir * renderDistance;
    float dist = renderDistance;
    if (!sky) {
        vec4 point = ModelViewMat * vec4(ndc, zeroToOne ? depth : depth * 2.0 - 1.0, 1.0);
        position = point.xyz / point.w;
        dist = length(position);
        dir = position / max(dist, 0.0001);
    }
    float cylindrical = sky ? 0.0 : max(length(position.xz), abs(position.y));
    float vanillaFog = sky ? 0.0 : vanillaAmount(dist, cylindrical);
    bool wantBackground = !sky && vanillaFog > 0.0;
    if (!sky && realistic && !wantBackground) {
        wantBackground = borderAmount(cylindrical, renderDistance, ColorModulator.x > renderDistance + 16.0) >= 0.0009765625;
    }
    vec3 background = wantBackground ? texelFetch(FogSky, pixel, 0).rgb : vec3(0.0);
    Atmosphere a;
    if (realistic) {
        a = atmosphereUnpack(TextureMat[1], TextureMat[2], TextureMat[3], vfxAtmo0, vfxAtmo1, vfxAtmo2, vfxAtmo3, vfxAtmo4, vfxAtmo5, vfxAtmo6);
        if (sky || wantBackground) {
            float below = cameraY < 180.0 ? smoothstep(0.02, -0.02, dir.y) : 0.0;
            if (below > 0.0) {
                vec3 lowSky = mix(realisticTonemap(realisticSky(a, dir)), FogExtraTexture[1].rgb, FogExtraTexture[0][2]);
                background = mix(background, lowSky, below);
                if (sky) {
                    color = mix(color, lowSky, below);
                }
            }
        }
    }
    if (wantBackground && !realistic) {
        background = groundFog(pixel, ndc, background);
    }
    if (realistic) {
        if (sky) {
            color = dynamicSky(color, dir);
        } else if (wantBackground) {
            background = dynamicSky(background, dir);
        }
    }
    vec3 result = sky ? color : fogged(color, position, dist, cylindrical, vanillaFog, dir, background, realistic, a, renderDistance, cameraY, eyeBrightness);
    result = clamp(result, 0.0, 1.0);
    result += max(overlay, vec3(0.0)) * (1.0 - max(result - color, vec3(0.0)));
    result *= 1.0 + min(overlay, vec3(0.0)) / max(color, vec3(0.004));
    if (!sky && result != finalColor) {
        float cloud = textureLod(FogClouds, gl_FragCoord.xy / vec2(textureSize(Sampler0, 0)), 0.0).r;
        result = mix(result, finalColor, cloud);
    }
    fragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
}
