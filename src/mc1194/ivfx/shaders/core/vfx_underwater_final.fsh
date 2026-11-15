#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D RawScene;
uniform sampler2D DepthSampler;
uniform sampler2D FrontDepth;

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
    vec4 WaterFinal;
};

#include <immersivevfx:vfx_night_grade.glsl>
#include <immersivevfx:vfx_grade.glsl>
#ifdef VFX_COLORED_LIGHT
#include <immersivevfx:vfx_colored_light.glsl>
#endif

layout(std140) uniform VfxGrade {
    vec4 GradeTone;
    vec4 GradeBalance;
    vec4 GradeLevels;
    vec4 GradeBandStrength;
    vec4 GradeBandHue;
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

vec3 unproject(vec2 uv, float depth) {
    vec4 world = WaterInvViewProj * vec4(uv * 2.0 - 1.0, WaterParams.y > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    return world.xyz / world.w;
}

float visibleDepth(ivec2 pixel, vec2 uv) {
    float back = texelFetch(DepthSampler, pixel, 0).r;
    float front = texelFetch(FrontDepth, pixel, 0).r;
    if (front == back) {
        return back;
    }
    return WaterParams.x > 0.001 && abs(unproject(uv, front).y - WaterParams.x) < 0.15 ? back : front;
}

float waterFogAmount(ivec2 pixel, vec2 uv) {
    float depth = visibleDepth(pixel, uv);
    if (depth <= 0.0) {
        return 0.0;
    }
    vec4 eyeClip = WaterInvViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    vec3 eye = eyeClip.xyz / eyeClip.w;
    vec3 dir = normalize(unproject(uv, 0.5) - eye);
    float viewBack = length(unproject(uv, depth) - eye);
    float toSurface = WaterParams.x > 0.001 && dir.y > 0.001 ? WaterParams.x / dir.y : 1.0e6;
    float backFog = (WaterSprite.y > 0.5 ? viewBack : min(viewBack, toSurface)) / max(WaterView.z, 1.0);
    return 1.0 - exp(-backFog * backFog);
}

float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

vec3 sceneToDisplay(vec3 color) {
    float start = luminance(color);
    vec3 powered = pow(max(color, vec3(0.0)), vec3(1.05));
    vec3 mapped = powered / (powered * 0.9190385 + 0.7186597);
    mapped = mix(1.055 * pow(mapped, vec3(1.0 / 2.4)) - 0.055, 12.92 * mapped, lessThan(mapped, vec3(0.0031308)));
    float dark = smoothstep(0.1, 0.0, start);
    mapped = mix(mapped, pow(max(color, vec3(0.0)), vec3(1.0 / 2.2)), dark * 0.75);
    mapped = mix(mapped, vec3(1.0), smoothstep(0.0, 16.0, start));
    return mix(mapped, vec3(luminance(mapped)), dark * 0.25);
}

vec3 plainDisplay(vec3 color) {
    vec3 powered = pow(max(color, vec3(0.0)), vec3(1.05));
    vec3 mapped = powered / (powered * 0.9190385 + 0.7186597);
    return mix(1.055 * pow(mapped, vec3(1.0 / 2.4)) - 0.055, 12.92 * mapped, lessThan(mapped, vec3(0.0031308)));
}

void main() {
    vec4 hdr = textureLod(Sampler0, texCoord, 0.0);
    vec3 color = hdr.rgb / max(hdr.a, 1.0);
    vec3 display;
    if (WaterSprite.y < 0.5) {
        display = plainDisplay(color);
    } else {
        display = clamp(sceneToDisplay(color), 0.0, 1.0);
        display = display * 1.07 - (display.r + display.g + display.b) / 3.0 * 0.07;
    }
    display = vfx_night_grade(display, WaterSprite.w);
    vec4 raw = texelFetch(RawScene, ivec2(gl_FragCoord.xy), 0);
    if (abs(raw.a - 0.625) < 0.02 || abs(raw.a - 0.3125) < 0.02 || abs(raw.a - 0.525) < 0.012 || abs(raw.a - 0.2625) < 0.006) {
        display = mix(vfx_screen_grade(raw.rgb, WaterFinal.x, WaterSprite.w), display, waterFogAmount(ivec2(gl_FragCoord.xy), texCoord));
    }
    #ifdef VFX_COLORED_LIGHT
    display = vfx_colored_light(clamp(display, 0.0, 1.0), ivec2(gl_FragCoord.xy), texCoord);
    #endif
    fragColor = vec4(vfx_user_grade(clamp(display, 0.0, 1.0), GradeTone, GradeBalance, GradeLevels, GradeBandStrength, GradeBandHue), 1.0);
}
