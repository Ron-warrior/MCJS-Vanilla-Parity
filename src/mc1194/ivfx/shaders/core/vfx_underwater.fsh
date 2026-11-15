#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D DepthSampler;
uniform sampler2D FrontDepth;
uniform sampler2D NoiseSampler;
uniform sampler2D VfxShadowMap;
uniform sampler2D VfxShadowMapPrev;
uniform sampler2D ShaftSampler;

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

vec3 displayToScene(vec3 color) {
    vec3 linear = mix(pow((color + 0.055) / 1.055, vec3(2.4)), color / 12.92, lessThan(color, vec3(0.04045)));
    vec3 powered = 0.7188 * linear / max(1.0 - 0.9190 * linear, vec3(0.001));
    return pow(powered, vec3(1.0 / (1.05 * 2.2)));
}

float sunLookup(sampler2D map, mat4 matrix, vec3 world) {
    vec3 pos = (matrix * vec4(world, 1.0)).xyz;
    if (any(lessThan(pos, vec3(0.0))) || any(greaterThan(pos, vec3(1.0)))) {
        return 1.0;
    }
    float texel = 1.5 / float(textureSize(map, 0).x);
    float c = 0.8253356 * texel;
    float s = 0.5646425 * texel;
    float sum = step(textureLod(map, pos.xy + vec2(c, s), 0.0).r, pos.z + 0.0005);
    sum += step(textureLod(map, pos.xy - vec2(c, s), 0.0).r, pos.z + 0.0005);
    sum += step(textureLod(map, pos.xy + vec2(-s, c), 0.0).r, pos.z + 0.0005);
    sum += step(textureLod(map, pos.xy + vec2(s, -c), 0.0).r, pos.z + 0.0005);
    return sum * 0.25;
}

float sunVisibility(vec3 p, vec3 normal) {
    if (WaterParams.z < 0.5) {
        return 1.0;
    }
    vec3 world = p + normal * 0.18;
    float visibility = sunLookup(VfxShadowMap, WaterShadowMat, world);
    if (WaterCamera.w < 0.999) {
        visibility = mix(sunLookup(VfxShadowMapPrev, WaterShadowPrev, world), visibility, WaterCamera.w);
    }
    return visibility;
}

float caustics(vec2 world) {
    if (WaterParams.w < 0.5) {
        return 0.0;
    }
    float time = WaterFog.a;
    float a = textureLod(NoiseSampler, world * 0.044 + vec2(time * 0.011, time * 0.006), 0.0).r;
    float b = textureLod(NoiseSampler, world * 0.058 - vec2(time * 0.008, -time * 0.010), 0.0).r;
    return smoothstep(0.22, 0.55, a * b);
}

vec2 glintHash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

float glintCells(vec2 p, float t) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 o = 0.5 + 0.4 * sin(t + 6.2831853 * glintHash(i + g));
            vec2 r = g + o - f;
            float d = dot(r, r);
            if (d < d1) {
                d2 = d1;
                d1 = d;
            } else if (d < d2) {
                d2 = d;
            }
        }
    }
    return 1.0 - smoothstep(0.0, 0.2, sqrt(d2) - sqrt(d1));
}

float bodyGlints(vec2 world, float time) {
    vec2 p = (floor(world * 16.0) + 0.5) / 16.0;
    float c = glintCells(p * 0.75, time * 0.7) * 0.65 + glintCells(p * 1.35 + vec2(7.3, 2.9), time * 1.05) * 0.35;
    return c * c * 1.3 + c * 0.15;
}

vec3 shaftAt(vec2 uv, float distance) {
    vec2 size = vec2(textureSize(ShaftSampler, 0));
    vec2 p = uv * size - 0.5;
    ivec2 base = ivec2(floor(p));
    vec2 f = p - floor(p);
    ivec2 limit = ivec2(size) - 1;
    float target = min(distance, 2048.0);
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 2; x++) {
            vec4 s = texelFetch(ShaftSampler, clamp(base + ivec2(x, y), ivec2(0), limit), 0);
            float w = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
            w *= 1.0 / (0.02 + abs(s.a - target) / max(target, 1.0));
            sum += s.rgb * w;
            total += w;
        }
    }
    return sum / max(total, 0.0001);
}

void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    float depth = visibleDepth(pixel, texCoord);
    vec4 eyeClip = WaterInvViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    vec3 eye = eyeClip.xyz / eyeClip.w;
    vec3 dir = normalize(unproject(texCoord, 0.5) - eye);
    vec4 raw = texelFetch(Sampler0, pixel, 0);
    bool sky = depth <= 0.0;
    float toSurface = WaterParams.x > 0.001 && dir.y > 0.001 ? WaterParams.x / dir.y : 1.0e6;
    float viewBack = 1.0e6;
    bool realistic = WaterSprite.y > 0.5;
    vec3 scene = realistic && sky && WaterView.w < 0.5 ? raw.rgb : displayToScene(raw.rgb);
    vec2 slopeBase = WaterLight.xz / max(WaterLight.y, 0.2);
    if (!sky) {
        vec3 p = unproject(texCoord, depth);
        viewBack = length(p - eye);
        vec3 normal = normalize(cross(dFdx(p), dFdy(p)));
        if (dot(normal, p) > 0.0) {
            normal = -normal;
        }
        bool emissive = abs(raw.a - 0.625) < 0.02 || abs(raw.a - 0.3125) < 0.02 || abs(raw.a - 0.525) < 0.012 || abs(raw.a - 0.2625) < 0.006;
        if (realistic && emissive) {
            scene /= UNDERWATER_MULT * 0.85;
        }
        float above = max(WaterParams.x - p.y, 0.0);
        bool body = raw.a > 0.9 && WaterView.y > 0.5 && !emissive && above > 0.0;
        if (body && !realistic) {
            vec3 waterLight = sqrt(WaterSurface.rgb);
            waterLight /= max(dot(waterLight, vec3(0.2126, 0.7152, 0.0722)), 0.001);
            scene *= mix(vec3(1.0), waterLight, 0.5);
        }
        float reach = WaterLight.w * exp(-viewBack * viewBack / 2200.0);
        float strength = reach * exp(-above / 63.0);
        if (!emissive && strength > 0.002 && above > 0.0) {
            float facing = smoothstep(0.0, 0.3, dot(normal, WaterLight.xyz));
            float sun = facing * sunVisibility(p, normal);
            vec2 entry = p.xz + WaterCamera.xz + slopeBase * above;
            float spots = caustics(entry);
            vec3 base = scene;
            scene = scene * (1.0 - 0.34 * strength * facing * (1.0 - sun)) + scene * WaterFog.rgb / max(max(WaterFog.r, max(WaterFog.g, WaterFog.b)), 0.001) * sun * strength * (realistic ? 0.80 : 0.64) * spots;
            if (body && WaterParams.w > 0.5) {
                float depthFade = pow(max(1.0 - above / 28.0, 0.0), 1.4);
                scene += base * WaterSurface.rgb * sun * reach * depthFade * bodyGlints(entry, WaterFog.a) * (realistic ? 1.875 : 1.5);
            }
        }
    }
    float viewFront = min(viewBack, toSurface);
    float backFog = (realistic ? viewBack : viewFront) / max(WaterView.z, 1.0);
    vec3 fogColor = realistic ? WaterFog.rgb : displayToScene(min(WaterFog.rgb, vec3(1.0)));
    vec3 color = realistic && sky ? scene : mix(scene, fogColor, 1.0 - exp(-backFog * backFog));
    if (realistic && sky && (toSurface >= 1.0e6 || toSurface > WaterView.x)) {
        color = fogColor;
    }
    if (realistic && sky && toSurface < 1.0e6 && WaterVlColor.w > 0.5) {
        float toSun = dot(dir, WaterSun.xyz);
        if (toSun > 0.0) {
            float across = abs(dir.x * WaterSun.y - dir.y * WaterSun.x) / toSun;
            float side = abs(dir.z) / toSun;
            float edge = max(across, side);
            float level = mix(0.48, 6.05, 1.0 - smoothstep(0.040, 0.044, edge)) * (1.0 - smoothstep(0.052, 0.056, edge));
            float horizon = clamp((dir.y + 0.1) * 10.0, 0.0, 1.0);
            horizon *= horizon;
            horizon = horizon * horizon * (3.0 - 2.0 * horizon);
            color += vec3(1.1, 0.55, 0.0) * 4.5 * WaterSurface.a * 0.25 * level * horizon * 0.3;
        }
    }
    if (realistic) {
        color *= UNDERWATER_MULT * 0.85;
    }
    color = pow(max(color, vec3(0.0)), vec3(2.2));
    vec3 shaft = shaftAt(texCoord, viewBack);
    if (realistic) {
        color += max(shaft * 1.15 - vec3((shaft.r + shaft.g + shaft.b) / 3.0 * 0.15), vec3(0.0));
    } else {
        vec3 hue = pow(max(WaterFog.rgb, vec3(0.0)), vec3(2.2));
        const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
        color += hue * dot(shaft, LUMA) / max(dot(hue, LUMA), 0.001) * 0.612;
    }
    float bloom = 1.0 - exp(-viewFront * 0.06);
    bloom *= bloom;
    bloom *= bloom;
    float bloomFog = 1.0 + 14.0 * bloom;
    fragColor = vec4(max(color, vec3(0.0)) * bloomFog, bloomFog);
}
