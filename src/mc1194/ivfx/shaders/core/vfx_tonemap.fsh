#version 330
#extension GL_ARB_separate_shader_objects : require

#include <minecraft:dynamictransforms.glsl>
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

uniform sampler2D Sampler0;

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

void main() {
    vec3 color = texelFetch(Sampler0, ivec2(gl_FragCoord.xy), 0).rgb;
    #ifdef VFX_COLORED_LIGHT
    color = vfx_colored_light(color, ivec2(gl_FragCoord.xy), texCoord);
    #endif
    vec3 graded = clamp(vfx_screen_grade(color, ColorModulator.x, ColorModulator.y), 0.0, 1.0);
    fragColor = vec4(vfx_user_grade(graded, GradeTone, GradeBalance, GradeLevels, GradeBandStrength, GradeBandHue), 1.0);
}
