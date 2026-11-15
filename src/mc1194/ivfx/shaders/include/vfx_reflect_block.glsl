#ifndef IMMERSIVEVFX_REFLECT_BLOCK_GLSL
#define IMMERSIVEVFX_REFLECT_BLOCK_GLSL

layout(std140) uniform VfxReflect {
    vec4 WaterParams;
    vec4 ReflectParams;
    vec4 ReflectSun;
    vec4 ReflectFactors;
    vec4 ReflectSky;
    vec4 ReflectAtmo[7];
    vec4 WaterTint;
    vec4 WaterSprite;
    vec4 WaterOrigin;
    vec4 WaterFogColor;
    vec4 WaterGlint;
    vec4 WaterLook;
    vec4 HandGrade;
    vec4 HandWater;
    vec4 LookExtra;
    vec4 HeldLight;
    vec4 HandLevels;
    vec4 GradeTone;
    vec4 GradeBalance;
    vec4 GradeLevels;
    vec4 GradeBandStrength;
    vec4 GradeBandHue;
};

#endif
