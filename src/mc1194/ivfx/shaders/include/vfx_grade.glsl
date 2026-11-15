#ifndef IMMERSIVEVFX_GRADE_GLSL
#define IMMERSIVEVFX_GRADE_GLSL

vec3 vfx_grade_hsv(vec3 c) {
    vec4 k = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, k.wz), vec4(c.gb, k.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1.0e-6)), d / (q.x + 1.0e-6), q.x);
}

vec3 vfx_grade_rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

vec3 vfx_user_grade(vec3 color, vec4 tone, vec4 balance, vec4 levels, vec4 bandStrength, vec4 bandHue) {
    if (balance.w < 0.5) {
        return color;
    }
    vec3 c = clamp(color * tone.x * balance.rgb, 0.0, 1.0);
    c = pow(max(c * levels.z + levels.x * (1.0 - c), vec3(0.0)), vec3(1.0 / levels.y));
    c = max((c - 0.46) * tone.y + 0.46, vec3(0.0));
    if (bandStrength.w > 0.5) {
        vec3 hsv = vfx_grade_hsv(c);
        vec3 band = abs(fract(hsv.x - vec3(0.0, 1.0 / 3.0, 2.0 / 3.0) + 0.5) - 0.5);
        vec3 weight = clamp(1.0 - band * 3.0, 0.0, 1.0);
        hsv.x = fract(hsv.x + levels.w + dot(weight, bandHue.xyz));
        hsv.y = clamp(hsv.y * dot(weight, bandStrength.xyz), 0.0, 1.0);
        c = vfx_grade_rgb(hsv);
    }
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float spread = clamp(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), 0.0, 1.0);
    c = mix(vec3(luma), c, tone.z * (1.0 + tone.w * (1.0 - spread)));
    return clamp(c, 0.0, 1.0);
}

#endif
