vec3 vfx_night_grade(vec3 color, float amount) {
    if (amount <= 0.0) {
        return color;
    }
    float warm = smoothstep(0.02, 0.2, color.r - color.b) * smoothstep(0.3, 0.6, max(color.r, max(color.g, color.b)));
    return mix(color, color * vec3(0.74, 0.84, 1.08), amount * (1.0 - warm));
}

vec3 vfx_screen_grade(vec3 color, float saturation, float night) {
    vec3 graded = color;
    if (saturation > 1.0001) {
        float gray = (color.r + color.g + color.b) / 3.0;
        graded = color * saturation - gray * (saturation - 1.0);
        if (min(color.r, min(color.g, color.b)) < 0.3514) {
            float luminance = dot(pow(color, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
            graded = mix(graded, vec3(dot(graded, vec3(0.2126, 0.7152, 0.0722))), smoothstep(0.1, 0.0, luminance) * 0.25);
        }
        float protect = smoothstep(0.9, 1.0, max(color.r, max(color.g, color.b)));
        graded = mix(graded, color, protect * 0.5);
    }
    return vfx_night_grade(graded, night);
}
