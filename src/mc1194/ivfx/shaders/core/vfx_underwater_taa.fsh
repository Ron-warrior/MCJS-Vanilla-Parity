#version 330
#extension GL_ARB_separate_shader_objects : require

uniform sampler2D Sampler0;
uniform sampler2D History;
uniform sampler2D DepthSampler;
uniform sampler2D FrontDepth;

layout(std140) uniform VfxUnderwaterTemporal {
    mat4 TemporalInvViewProj;
    mat4 TemporalPrevViewProj;
    vec4 TemporalCamera;
    vec4 TemporalView;
};

layout(location = 0) in vec2 texCoord;

layout(location = 0) out vec4 fragColor;

const float blendMinimum = 0.35;
const float blendVariable = 0.2;
const float blendConstant = 0.7;
const float regularEdge = 6.0;

const ivec2 neighbourhoodOffsets[8] = ivec2[8](
    ivec2( 1, 1),
    ivec2( 1,-1),
    ivec2(-1, 1),
    ivec2(-1,-1),
    ivec2( 1, 0),
    ivec2( 0, 1),
    ivec2(-1, 0),
    ivec2( 0,-1)
);

vec3 textureCatmullRom(vec2 texcoord, vec2 view) {
    vec2 position = texcoord * view;
    vec2 centerPosition = floor(position - 0.5) + 0.5;
    vec2 f = position - centerPosition;
    vec2 f2 = f * f;
    vec2 f3 = f * f2;

    float c = 0.7;
    vec2 w0 =        -c  * f3 +  2.0 * c         * f2 - c * f;
    vec2 w1 =  (2.0 - c) * f3 - (3.0 - c)        * f2         + 1.0;
    vec2 w2 = -(2.0 - c) * f3 + (3.0 -  2.0 * c) * f2 + c * f;
    vec2 w3 =         c  * f3 -                c * f2;

    vec2 w12 = w1 + w2;
    vec2 tc12 = (centerPosition + w2 / w12) / view;

    vec2 tc0 = (centerPosition - 1.0) / view;
    vec2 tc3 = (centerPosition + 2.0) / view;
    vec4 color = vec4(textureLod(History, vec2(tc12.x, tc0.y ), 0.0).rgb, 1.0) * (w12.x * w0.y ) +
                 vec4(textureLod(History, vec2(tc0.x,  tc12.y), 0.0).rgb, 1.0) * (w0.x  * w12.y) +
                 vec4(textureLod(History, vec2(tc12.x, tc12.y), 0.0).rgb, 1.0) * (w12.x * w12.y) +
                 vec4(textureLod(History, vec2(tc3.x,  tc12.y), 0.0).rgb, 1.0) * (w3.x  * w12.y) +
                 vec4(textureLod(History, vec2(tc12.x, tc3.y ), 0.0).rgb, 1.0) * (w12.x * w3.y );
    return color.rgb / color.a;
}

vec3 ClipAABB(vec3 q, vec3 aabb_min, vec3 aabb_max) {
    vec3 p_clip = 0.5 * (aabb_max + aabb_min);
    vec3 e_clip = 0.5 * (aabb_max - aabb_min) + 0.00000001;

    vec3 v_clip = q - p_clip;
    vec3 v_unit = v_clip / e_clip;
    vec3 a_unit = abs(v_unit);
    float ma_unit = max(a_unit.x, max(a_unit.y, a_unit.z));

    if (ma_unit > 1.0) {
        return p_clip + v_clip / ma_unit;
    }
    return q;
}

vec3 unproject(vec2 uv, float depth) {
    vec4 world = TemporalInvViewProj * vec4(uv * 2.0 - 1.0, TemporalView.y > 0.5 ? depth : depth * 2.0 - 1.0, 1.0);
    return world.xyz / world.w;
}

float visibleDepth(ivec2 pixel, vec2 uv) {
    float back = texelFetch(DepthSampler, pixel, 0).r;
    float front = texelFetch(FrontDepth, pixel, 0).r;
    if (front == back) {
        return back;
    }
    return TemporalView.w > 0.001 && abs(unproject(uv, front).y - TemporalView.w) < 0.15 ? back : front;
}

float linearDepth(ivec2 pixel, vec2 view, vec3 eye) {
    float depth = visibleDepth(pixel, (vec2(pixel) + 0.5) / view);
    if (depth <= 0.0) {
        return 1.0;
    }
    float t = min(length(unproject((vec2(pixel) + 0.5) / view, depth) - eye) / max(TemporalView.x, 1.0), 1.0);
    return 2.0 * t / (1.0 + t);
}

void main() {
    vec2 view = vec2(textureSize(Sampler0, 0));
    ivec2 texelCoord = ivec2(gl_FragCoord.xy);
    vec3 color = texelFetch(Sampler0, texelCoord, 0).rgb;
    if (TemporalCamera.w < 0.5) {
        fragColor = vec4(color, 1.0);
        return;
    }
    vec4 eyeClip = TemporalInvViewProj * vec4(0.0, 0.0, 1.0, 0.0);
    vec3 eye = eyeClip.xyz / eyeClip.w;
    float z1 = visibleDepth(texelCoord, texCoord);
    vec3 position = z1 <= 0.0
            ? eye + normalize(unproject(texCoord, 0.5) - eye) * max(TemporalView.x, 1.0)
            : unproject(texCoord, z1);
    vec4 previousPosition = TemporalPrevViewProj * vec4(position + TemporalCamera.xyz, 1.0);
    vec2 prvCoord = previousPosition.xy / previousPosition.w * 0.5 + 0.5;

    vec3 tempColor = textureCatmullRom(prvCoord, view);
    if (tempColor == vec3(0.0) || any(isnan(tempColor))) {
        fragColor = vec4(color, 1.0);
        return;
    }

    float edge = 0.0;
    vec3 minclr = color;
    vec3 maxclr = minclr;
    ivec2 texelCoordM1 = clamp(texelCoord, ivec2(2), ivec2(view) - 2);
    float z1Linear = linearDepth(texelCoord, view, eye);
    for (int i = 0; i < 8; i++) {
        ivec2 texelCoordM2 = texelCoordM1 + neighbourhoodOffsets[i];
        if (abs(linearDepth(texelCoordM2, view, eye) - z1Linear) > 0.09) {
            edge = regularEdge;
        }
        vec3 clr = texelFetch(Sampler0, texelCoordM2, 0).rgb;
        minclr = min(minclr, clr);
        maxclr = max(maxclr, clr);
    }
    tempColor = ClipAABB(tempColor, minclr, maxclr);

    vec2 velocity = (texCoord - prvCoord) * view;
    float blendFactor = float(prvCoord.x > 0.0 && prvCoord.x < 1.0 && prvCoord.y > 0.0 && prvCoord.y < 1.0);
    float velocityFactor = dot(velocity, velocity) * 10.0;
    blendFactor *= max(exp(-velocityFactor) * blendVariable + blendConstant - min(length(TemporalCamera.xyz), 0.05) * edge, blendMinimum);

    fragColor = vec4(mix(color, tempColor, blendFactor), 1.0);
}
