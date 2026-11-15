import {FINAL_UNIFORMS,shaderFrameUniforms} from '../render/shader-frame.js';
// WebGL 2 implementation of the graphics device contract (see device.js).
import { DEFAULT_PARAMS, PIPELINE_FORMAT, quadIndices, buildMips, vertexLayout } from './device.js';

const HEADER = `#version 300 es
precision highp float;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
uniform vec4 uP[4];
uniform vec4 uFog;       // start, end, density, mode (0 linear, 1 exp, 2 none)
uniform vec3 uFogColor;
uniform sampler2D uTex0;
uniform sampler2D uLightmap;
float fogFactor(float d) {
  if (uFog.w > 1.5 && uFog.w < 2.5) return 0.0;
  if (uFog.w > 2.5) return 1.0 - clamp(exp(-pow(uFog.z * d, 2.0)), 0.0, 1.0);
  if (uFog.w < 0.5) return clamp((d - uFog.x) / max(0.0001, uFog.y - uFog.x), 0.0, 1.0);
  return 1.0 - clamp(exp(-uFog.z * d), 0.0, 1.0);
}
vec3 lightmap(vec2 l) { return texture(uLightmap, vec2((l.y + 0.5) / 16.0, (l.x + 0.5) / 16.0)).rgb; }
`;

const SHADERS = {
  terrain: {
    vs: `
layout(location=0) in vec4 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aCol; layout(location=3) in vec2 aLight;
out vec2 vUv; out vec3 vCol; out vec2 vLight; out float vDepth;
void main() {
  vUv = aUv; vCol = aCol.rgb; vLight = aLight * 15.0;
  vec3 p = aPos.xyz * (65535.0 / 2048.0) - 8.0;
  vec4 mv = uView * uModel * vec4(p, 1.0); vDepth = length(mv.xyz); gl_Position = uProj * mv;
}`,
    fs: `
in vec2 vUv; in vec3 vCol; in vec2 vLight; in float vDepth; out vec4 o;
void main() {
  vec4 t = texture(uTex0, vUv, uP[0].z); // uP[0].z: mip bias (far LOD sections sample a smaller mip)
  if (t.a < uP[0].x) discard;
  vec3 c = t.rgb * vCol * lightmap(vLight);
  o = vec4(mix(c, uFogColor, fogFactor(vDepth)), t.a * uP[0].y);
}`,
  },
  lit: {
    vs: `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aCol; layout(location=3) in vec2 aLight;
out vec2 vUv; out vec4 vCol; out vec2 vLight; out float vDepth;
void main() { vUv = aUv; vCol = aCol; vLight = aLight; vec4 mv = uView * uModel * vec4(aPos, 1.0); vDepth = length(mv.xyz); gl_Position = uProj * mv; }`,
    fs: `
in vec2 vUv; in vec4 vCol; in vec2 vLight; in float vDepth; out vec4 o;
void main() {
  vec4 t = texture(uTex0, vUv);
  if (t.a < uP[0].x) discard;
  vec3 lm = vLight.x < 0.0 ? vec3(1.0) : lightmap(vLight);
  vec3 c = t.rgb * vCol.rgb * lm;
  o = vec4(mix(c, uFogColor, fogFactor(vDepth)), t.a * vCol.a);
}`,
  },
  entity: {
    vs: `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec3 aNrm; layout(location=3) in vec3 aCol;
out vec2 vUv; out vec3 vCol; out float vShade; out float vDepth;
void main() {
  vUv = aUv * (uP[3].w > 0.0 ? uP[3].w : 1.0) + uP[3].yz; vCol = aCol;
  vec3 n = normalize(mat3(uModel) * aNrm);
  // lighting mode uP[2].w: 0 world item lighting, 1 none, 2 GUI item lighting (RenderHelper.enableGUIStandardItemLighting:
  // the same two lights turned -30 degrees about Y and 165 about X, in the y-down GUI space)
  bool gui = uP[2].w > 1.5;
  vec3 l0 = gui ? vec3(-0.237910, -0.634435, 0.735453) : normalize(vec3(0.2, 1.0, -0.7));
  vec3 l1 = gui ? vec3(0.028667, -0.927375, -0.373034) : normalize(vec3(-0.2, 1.0, 0.7));
  float d = 0.4 + 0.6 * (max(dot(n, l0), 0.0) + max(dot(n, l1), 0.0));
  vShade = (uP[2].w > 0.5 && !gui) ? 1.0 : min(1.0, d);
  vec4 mv = uView * uModel * vec4(aPos, 1.0); vDepth = length(mv.xyz); gl_Position = uProj * mv;
}`,
    fs: `
in vec2 vUv; in vec3 vCol; in float vShade; in float vDepth; out vec4 o;
void main() {
  vec4 t = texture(uTex0, vUv);
  if (t.a < uP[3].x) discard;
  vec3 lm = uP[2].z > 0.5 ? vec3(1.0) : lightmap(uP[2].xy);
  vec3 c = t.rgb * uP[0].rgb * vCol;
  c = mix(c, uP[1].rgb, uP[1].a);
  c *= vShade * lm;
  o = vec4(mix(c, uFogColor, fogFactor(vDepth)), t.a * uP[0].a);
}`,
  },
  color: {
    vs: `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aCol;
out vec2 vUv; out vec4 vCol; out float vDepth;
void main() { vUv = aUv; vCol = aCol; vec4 mv = uView * uModel * vec4(aPos, 1.0); vDepth = length(mv.xyz); gl_Position = uProj * mv; }`,
    fs: `
in vec2 vUv; in vec4 vCol; in float vDepth; out vec4 o;
void main() {
  vec4 t = texture(uTex0, vUv) * vCol * uP[0];
  if (t.a < uP[1].x) discard;
  vec3 c = uP[1].y > 0.5 ? mix(t.rgb, uFogColor, fogFactor(vDepth)) : t.rgb;
  o = vec4(c, t.a);
}`,
  },
  // TileEntityEndPortalRenderer layer: texgen EYE_LINEAR times projection * modelview = the fragment's NDC, then the
  // layer's scale, rotation and drift; uv = 0.5 + 0.5 * that
  endportal: {
    vs: `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aCol;
out float vDepth;
void main() { vec4 mv = uView * uModel * vec4(aPos, 1.0); vDepth = length(mv.xyz); gl_Position = uProj * mv; }`,
    fs: `
in float vDepth; out vec4 o;
void main() {
  vec2 ndc = gl_FragCoord.xy / uP[2].xy * 2.0 - 1.0;
  vec2 s = ndc * uP[1].x;
  float c = cos(uP[1].y), sn = sin(uP[1].y);
  vec2 r = vec2(s.x * c - s.y * sn, s.x * sn + s.y * c) + uP[1].zw;
  vec4 t = texture(uTex0, fract(0.5 + 0.5 * r));
  vec3 col = t.rgb * uP[0].rgb;
  float f = fogFactor(vDepth);
  // the sky pass blends with the scene; the portal passes add up, fogging towards black (setupFogColor(true))
  o = uP[0].w < 0.5 ? vec4(mix(col, uFogColor, f), t.a) : vec4(col * (1.0 - f), 1.0);
}`,
  },
  // Vanilla post-processing programs (see device.js); texCoord is vanilla's (origin bottom left), and render targets are
  // stored bottom-up here, so it addresses the texels directly
  post: {
    vs: `
layout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aCol;
out vec2 vTc;
void main() { vTc = vec2(aUv.x, 1.0 - aUv.y); gl_Position = vec4(aPos.xy, 0.0, 1.0); }`,
    fs: `
in vec2 vTc; out vec4 o;
vec4 fetch(sampler2D s, vec2 c) { ivec2 n = textureSize(s, 0); return texelFetch(s, clamp(ivec2(floor(c * vec2(n))), ivec2(0), n - 1), 0); }
vec4 fetchLin(sampler2D s, vec2 c) { return textureLod(s, clamp(c, vec2(0.0), vec2(1.0)), 0.0); }
void main() {
  int m = int(uP[0].x + 0.5);
  vec2 tc = vTc;
  vec2 inSize = vec2(textureSize(uTex0, 0));
  if (m == 0) { o = fetch(uTex0, tc) * uP[1]; }
  else if (m == 1) { vec4 d = fetch(uTex0, tc); o = vec4(mix(d, 1.0 - d, uP[0].y).rgb, 1.0); }
  else if (m == 2) {
    vec3 t = fetch(uTex0, tc).rgb;
    vec3 c = vec3(dot(t, uP[1].xyz), dot(t, uP[2].xyz), dot(t, uP[3].xyz));
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    o = vec4((c - l) * uP[0].y + l, 1.0);
  } else if (m == 3) {
    vec2 mis = inSize / uP[0].w;
    vec4 b = fetch(uTex0, tc - fract(tc * mis) / mis);
    vec3 f = b.rgb - fract(b.rgb * uP[0].y) / uP[0].y;
    float l = dot(f, vec3(0.3, 0.59, 0.11));
    o = vec4(l + (f - l) * uP[0].z, 1.0);
  } else if (m == 4) {
    vec2 one = 1.0 / inSize;
    float R = uP[1].z;
    vec4 acc = vec4(0.0); float ta = 0.0;
    for (float r = -R; r <= R; r += 1.0) { vec4 s = fetch(uTex0, tc + one * r * uP[1].xy); ta += s.a; acc += s; }
    o = vec4(acc.rgb / (R * 2.0 + 1.0), ta);
  } else if (m == 6) {
    vec2 one = 1.0 / inSize;
    vec4 c = fetch(uTex0, tc);
    vec4 t = (c - fetch(uTex0, tc - vec2(one.x, 0.0))) + (c - fetch(uTex0, tc + vec2(one.x, 0.0))) + (c - fetch(uTex0, tc - vec2(0.0, one.y))) + (c - fetch(uTex0, tc + vec2(0.0, one.y)));
    o = vec4(clamp(t, 0.0, 1.0).rgb, 1.0);
  } else if (m == 7) {
    vec2 one = 1.0 / inSize;
    vec3 rx = uP[3].xyz, ry = uP[0].yzw;
    vec3 cx = tc.x * rx + uP[1].xyz * one.x - (rx - 1.0) * 0.5;
    vec3 cy = tc.y * ry + uP[2].xyz * one.y - (ry - 1.0) * 0.5;
    o = vec4(fetch(uTex0, vec2(cx.x, cy.x)).r, fetch(uTex0, vec2(cx.y, cy.y)).g, fetch(uTex0, vec2(cx.z, cy.z)).b, 1.0);
  } else if (m == 8) {
    o = vec4(max(fetch(uLightmap, tc).rgb * uP[1].xyz, fetch(uTex0, tc).rgb), 1.0);
  } else if (m == 9) {
    vec2 one = 1.0 / inSize;
    vec4 c = fetch(uTex0, tc);
    vec4 nc = normalize(c);
    float du = dot(nc, normalize(fetch(uTex0, tc + vec2(0.0, -one.y)))), dd = dot(nc, normalize(fetch(uTex0, tc + vec2(0.0, one.y))));
    float dl = dot(nc, normalize(fetch(uTex0, tc + vec2(-one.x, 0.0)))), dr = dot(nc, normalize(fetch(uTex0, tc + vec2(one.x, 0.0))));
    float f = 1.0 + (du * 64.0 - dd * 64.0) + (dr * 64.0 - dl * 64.0);
    o = vec4((c * clamp(f, 0.5, 2.0)).rgb, 1.0);
  } else if (m == 10) {
    vec2 one = 1.0 / inSize;
    vec4 v = fetch(uTex0, tc);
    for (int i = 0; i < 12; i++) {
      vec2 k = i == 0 ? vec2(0, -1) : i == 1 ? vec2(0, 1) : i == 2 ? vec2(-1, 0) : i == 3 ? vec2(1, 0) : i == 4 ? vec2(-1, -1) : i == 5 ? vec2(1, 1)
        : i == 6 ? vec2(-1, 1) : i == 7 ? vec2(1, -1) : i == 8 ? vec2(0, -2) : i == 9 ? vec2(0, 2) : i == 10 ? vec2(-2, 0) : vec2(2, 0);
      v = min(v, fetch(uTex0, tc + k * one));
    }
    o = vec4(v.rgb, 1.0);
  } else if (m == 11) {
    vec2 one = 1.0 / inSize;
    float R = uP[0].y;
    vec4 mx = fetch(uTex0, tc);
    for (float u = 0.0; u <= R; u += 1.0) for (float v = 0.0; v <= R; v += 1.0) {
      float w = sqrt(u * u + v * v) / R > 1.0 ? 0.0 : 1.0;
      vec4 t = max(max(fetch(uTex0, tc + vec2(-u, -v) * one), fetch(uTex0, tc + vec2(u, v) * one)), max(fetch(uTex0, tc + vec2(-u, v) * one), fetch(uTex0, tc + vec2(u, -v) * one)));
      mx = mix(mx, max(mx, t), w);
    }
    o = vec4(mx.rgb, 1.0);
  } else if (m == 12) {
    vec2 one = 1.0 / inSize;
    vec4 c = fetch(uTex0, tc);
    vec4 v1 = mix(c, mix(fetch(uTex0, tc - vec2(one.x, 0.0)), fetch(uTex0, tc - vec2(one.x * 2.0, 0.0)), 0.667), 0.75);
    vec4 v2 = mix(c, mix(fetch(uTex0, tc + vec2(one.x, 0.0)), fetch(uTex0, tc + vec2(one.x * 2.0, 0.0)), 0.667), 0.75);
    vec4 v3 = mix(c, mix(fetch(uTex0, tc - vec2(0.0, one.y)), fetch(uTex0, tc - vec2(0.0, one.y * 2.0)), 0.667), 0.75);
    vec4 v4 = mix(c, mix(fetch(uTex0, tc + vec2(0.0, one.y)), fetch(uTex0, tc + vec2(0.0, one.y * 2.0)), 0.667), 0.75);
    o = vec4(mix(mix(v1, v2, 0.5), mix(v3, v4, 0.5), 0.5).rgb, 1.0);
  } else if (m == 13) {
    vec4 inT = fetch(uTex0, tc);
    vec2 pu = tc * 2.0 - 1.0;
    float r2 = pow(length(pu), 2.0);
    vec2 sc = tc * (1.0 - 0.02 * 0.2) + 0.02 * 0.1 + pu * 0.02 * r2;
    if (sc.x < 0.0 || sc.y < 0.0 || sc.x > 1.0 || sc.y > 1.0) discard;
    float bm = sin(sc.y * inSize.y * 0.25 * 3.1415926535);
    float br = mix(1.0, (bm * bm + 1.0) * 0.5, 0.8);
    vec3 t = vec3(0.05) + vec3(0.95) * (inT.rgb * br);
    o = vec4(pow(t, vec3(0.8)), 1.0);
  } else if (m == 14) {
    float T = uP[0].y;
    vec2 off = vec2(sin(tc.y * uP[1].x + T * 6.283185307) * uP[1].z, cos(tc.x * uP[1].y + T * 6.283185307) * uP[1].w);
    vec3 rgb = fetch(uTex0, tc + off).rgb;
    vec3 hsv = vec3(0.0, 0.0, max(rgb.r, max(rgb.g, rgb.b)));
    float c = hsv.z - min(rgb.r, min(rgb.g, rgb.b));
    if (c != 0.0) {
      hsv.y = c / hsv.z;
      vec3 d = (hsv.z - rgb) / c;
      d -= d.brg;
      d.rg += vec2(2.0, 4.0);
      hsv.x = fract((rgb.r >= hsv.z ? d.b : rgb.g >= hsv.z ? d.r : d.g) / 6.0);
    }
    hsv.x = fract(hsv.x + T);
    vec3 h = clamp(vec3(abs(hsv.x * 6.0 - 3.0) - 1.0, 2.0 - abs(hsv.x * 6.0 - 2.0), 2.0 - abs(hsv.x * 6.0 - 4.0)), 0.0, 1.0);
    o = vec4(((h - 1.0) * hsv.y + 1.0) * hsv.z, 1.0);
  } else if (m == 15) {
    vec2 one = 1.0 / inSize;
    vec4 c = fetch(uTex0, tc);
    vec4 sum = vec4(0.0);
    for (int i = 1; i <= 2; i++) {
      float k = float(i);
      sum += abs(c - fetch(uTex0, tc + vec2(0.0, -one.y) * k)) + abs(c - fetch(uTex0, tc + vec2(one.x, 0.0) * k))
        + abs(c - fetch(uTex0, tc + vec2(-one.x, 0.0) * k)) + abs(c - fetch(uTex0, tc + vec2(0.0, one.y) * k));
    }
    vec4 gray = vec4(0.3, 0.59, 0.11, 0.0);
    float sl = 1.0 - dot(clamp(sum, 0.0, 1.0), gray);
    float L = dot(c + (c - pow(c, vec4(uP[0].y))), gray);
    L = L - fract(L * uP[0].z) / uP[0].z;
    L = L * (uP[0].z / (uP[0].z - 1.0)) * sl;
    o = vec4(L, L, L, 1.0);
  } else if (m == 16) {
    o = fetch(uTex0, vec2(tc.x, 1.0 - tc.y)) * uP[1];
  } else if (m == 17) {
    // Built-in shader bright-pass: soft-thresholded highlights feed the bloom chain (uP[0].y = threshold,
    // uP[0].z = knee width, uP[1].x = gain). The chain runs at half resolution, so this is the cheap pass.
    vec3 c = fetch(uTex0, tc).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float w = smoothstep(uP[0].y, uP[0].y + uP[0].z, l);
    o = vec4(c * w * uP[1].x, 1.0);
  } else if (m == 18) {
    // Built-in shader grade. uTex0 = scene colour, uLightmap = blurred bright-pass (bloom).
    // uP[0] = (18, time, bloomStrength, exposure); uP[1] = (vibrance, contrast, rain, -);
    // uP[2] = (underwater, lava, hurt, tonemap on/off); uP[3] = (nether, end, day, sunset).
    // Vignette + grain live in the finish pass (19) so they apply after FXAA.
    vec3 c = fetch(uTex0, tc).rgb;
    c += fetch(uLightmap, tc).rgb * uP[0].z * vec3(1.0, 0.96, 0.90); // warm bloom (MakeUp-like)
    c *= uP[0].w;
    if (uP[2].w > 0.5) { // MakeUp custom_sigmoid (LGPL-3.0 javiergcim/MakeUpUltraFast, reimplemented)
      c = 1.4 * c;
      c = c / pow(pow(c, vec3(2.5)) + 1.0, vec3(0.4));
      c = pow(c, vec3(1.15));
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float smx = max(c.r, max(c.g, c.b)); float smn = min(c.r, min(c.g, c.b));
    float vib = 1.0 + (uP[1].x - 1.0) * (1.0 - 0.6 * clamp(smx - smn, 0.0, 1.0)); // vibrance: dull pixels gain most
    c = mix(vec3(l), c, vib);
    c = (c - 0.5) * uP[1].y + 0.5;
    // MakeUp-style world light: sunset warmth, night blue, rain cool, nether/end.
    c *= mix(vec3(1.0), vec3(1.07, 0.95, 0.82), uP[3].w);
    float nightF = 1.0 - uP[3].z;
    c = c * mix(vec3(1.0), vec3(0.90, 0.96, 1.10), nightF * 0.55) + vec3(0.0, 0.002, 0.008) * nightF;
    float rainF = uP[1].z;
    c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), rainF * 0.28);
    c *= mix(vec3(1.0), vec3(0.93, 0.97, 1.06), rainF * 0.7);
    c = c * mix(vec3(1.0), vec3(1.07, 0.93, 0.86), uP[3].x) + vec3(0.020, 0.002, 0.0) * uP[3].x; // nether
    c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), uP[3].y * 0.15);
    c *= mix(vec3(1.0), vec3(0.94, 0.98, 1.07), uP[3].y); // end
    if (uP[2].x > 0.5) c = mix(c, vec3(0.03, 0.11, 0.16) * (0.35 + 0.65 * l), 0.55); // water (MakeUp teal)
    if (uP[2].y > 0.5) { float pulse = 0.75 + 0.25 * sin(uP[0].y * 6.0); c = mix(c, vec3(0.9, 0.25, 0.05) * (0.3 + 0.7 * l) * pulse, 0.6); } // lava
    if (uP[2].z > 0.001) { vec2 q0 = tc - 0.5; float vg0 = smoothstep(0.35, 1.05, length(q0) * 1.4142); c = mix(c, vec3(0.6, 0.0, 0.0), uP[2].z * (0.35 + 0.65 * vg0)); } // hurt
    // Perceptual luma in alpha for the finish pass: EaglercraftX u53's tonemap
    // writes dot(color, (0.299, 0.587, 0.114)) into alpha and its FXAA reads it
    // back instead of recomputing luma. Same contract here (grade writes it).
    vec3 gc = clamp(c, 0.0, 1.0);
    o = vec4(gc, dot(gc, vec3(0.299, 0.587, 0.114)));
  } else if (m == 19) {
    // Built-in shader finish pass. uTex0 = graded scene (LDR, full res).
    // uP[0] = (19, time, sunU, sunV); uP[1] = (sunVis, fxaa, lens, flares);
    // uP[2] = (shafts, vignette, grain, -); uP[3] = (moonU, moonV, moonVis, underwater).
    vec2 one = 1.0 / inSize;
    float uw = uP[3].w;
    if (uw > 0.5) tc += vec2(sin(tc.y * 90.0 + uP[0].y * 2.2), cos(tc.x * 70.0 - uP[0].y * 1.7)) * 0.0035; // underwater refraction wobble
    vec3 c;
    if (uP[1].y > 0.5) {
      // FXAA 3.11 console, verbatim EaglercraftX u53 (post_fxaa.fsh): luma is
      // read from the grade pass's alpha channel (u53 dropped the green-as-luma
      // path and the precompiled-blob variant; sharpness 3.0, threshold 0.15,
      // threshold-min 0.05). Taps use texelFetch, matching Eagler's NEAREST
      // tonemap-output texture. The dir2 divide guard only covers inputs where
      // Eagler itself produces inf/NaN (unreachable past the early-out).
      vec2 screenSize05 = 0.5 * one;
      vec4 posPos; posPos.xy = tc; posPos.zw = tc + one;
      vec4 rcpFrameOpt; rcpFrameOpt.xy = -screenSize05; rcpFrameOpt.zw = screenSize05;
      vec4 rcpFrameOpt2 = rcpFrameOpt * 4.0;
      vec2 posM = tc + screenSize05;
      float lumaNW = fetch(uTex0, posPos.xy).a;
      float lumaSW = fetch(uTex0, posPos.xw).a;
      float lumaNE = fetch(uTex0, posPos.zy).a;
      float lumaSE = fetch(uTex0, posPos.zw).a;
      vec4 rgbyM = fetch(uTex0, posM);
      float lumaM = rgbyM.a;
      float lumaMaxNwSw = max(lumaNW, lumaSW);
      lumaNE += 1.0 / 384.0;
      float lumaMinNwSw = min(lumaNW, lumaSW);
      float lumaMaxNeSe = max(lumaNE, lumaSE);
      float lumaMinNeSe = min(lumaNE, lumaSE);
      float lumaMax = max(lumaMaxNeSe, lumaMaxNwSw);
      float lumaMin = min(lumaMinNeSe, lumaMinNwSw);
      float lumaMaxScaled = lumaMax * 0.15;
      float lumaMinM = min(lumaMin, lumaM);
      float lumaMaxScaledClamped = max(0.05, lumaMaxScaled);
      float lumaMaxM = max(lumaMax, lumaM);
      float dirSwMinusNe = lumaSW - lumaNE;
      float lumaMaxSubMinM = lumaMaxM - lumaMinM;
      float dirSeMinusNw = lumaSE - lumaNW;
      if (lumaMaxSubMinM < lumaMaxScaledClamped) c = rgbyM.rgb;
      else {
        vec2 dir = vec2(dirSwMinusNe + dirSeMinusNw, dirSwMinusNe - dirSeMinusNw);
        vec2 dir1 = normalize(dir);
        vec4 rgbyN1 = fetch(uTex0, posM - dir1 * rcpFrameOpt.zw);
        vec4 rgbyP1 = fetch(uTex0, posM + dir1 * rcpFrameOpt.zw);
        float dirAbsMinTimesC = min(abs(dir1.x), abs(dir1.y)) * 3.0;
        vec2 dir2 = clamp(dir1 / max(dirAbsMinTimesC, 1e-7), vec2(-2.0), vec2(2.0));
        vec2 dir2x = dir2 * rcpFrameOpt2.zw;
        vec4 rgbyN2 = fetch(uTex0, posM - dir2x);
        vec4 rgbyP2 = fetch(uTex0, posM + dir2x);
        vec4 rgbyA = rgbyN1 + rgbyP1;
        vec4 rgbyB = (rgbyN2 + rgbyP2) * 0.25 + rgbyA * 0.25;
        float lumaB = rgbyB.a;
        c = (lumaB < lumaMin || lumaB > lumaMax) ? rgbyA.rgb * 0.5 : rgbyB.rgb;
      }
    } else c = fetch(uTex0, tc).rgb;
    if (uP[1].z > 0.5) {
      // Lens distortion + chromatic aberration (EaglercraftX post_lens_distort).
      vec2 t = tc - 0.5;
      float r2 = dot(t, t);
      c = vec3(fetchLin(uTex0, t * (1.0 - 0.04 * r2) + 0.5).r,
               fetchLin(uTex0, t * (1.0 - 0.05 * r2) + 0.5).g,
               fetchLin(uTex0, t * (1.0 - 0.06 * r2) + 0.5).b);
    }
    vec2 sunUV = vec2(uP[0].z, uP[0].w);
    float sunVis = uP[1].x;
    if (uP[2].x > 0.001 && sunVis > 0.001) {
      // Screen-space light shafts: march toward the sun, decayed accumulation.
      vec2 stepV = (sunUV - tc) * 0.09;
      vec2 sp = tc;
      float illum = 0.0, w = 1.0;
      for (int i = 0; i < 10; i++) { sp += stepV; illum += dot(fetchLin(uTex0, sp).rgb, vec3(0.2126, 0.7152, 0.0722)) * w; w *= 0.92; }
      c += vec3(1.0, 0.9, 0.7) * illum * 0.02 * uP[2].x * sunVis;
    }
    if (uP[1].w > 0.5 && sunVis > 0.001) {
      // Lens flares: sun glow + reflected ghosts + horizontal streak.
      vec3 sunCol = fetchLin(uTex0, sunUV).rgb;
      float sd = length(tc - sunUV);
      c += vec3(1.0, 0.85, 0.6) * exp(-sd * 7.0) * 0.4 * sunVis;
      vec2 axis = vec2(0.5) - sunUV;
      c += sunCol * vec3(0.3, 0.7, 0.9) * (1.0 - smoothstep(0.0, 0.06, length(tc - (sunUV + axis * 0.45)))) * 0.26 * sunVis;
      c += sunCol * vec3(0.9, 0.4, 0.7) * (1.0 - smoothstep(0.0, 0.045, length(tc - (sunUV + axis * 0.9)))) * 0.22 * sunVis;
      c += sunCol * vec3(0.4, 0.5, 1.0) * (1.0 - smoothstep(0.0, 0.03, length(tc - (sunUV + axis * 1.4)))) * 0.19 * sunVis;
      c += sunCol * vec3(1.0, 0.6, 0.25) * (1.0 - smoothstep(0.0, 0.02, length(tc - (sunUV + axis * 1.9)))) * 0.15 * sunVis;
      c += sunCol * exp(-abs(tc.y - sunUV.y) * 160.0) * exp(-abs(tc.x - sunUV.x) * 3.5) * 0.3 * sunVis;
    }
    float moonVis = uP[3].z;
    if (moonVis > 0.003) {
      // Moon glow + halo (MakeUp-style bright nights). Moon UVs from the engine.
      vec2 muv = vec2(uP[3].x, uP[3].y);
      vec3 moonCol = fetchLin(uTex0, muv).rgb;
      float md = length(tc - muv);
      c += vec3(0.72, 0.83, 1.0) * exp(-md * 5.0) * 0.38 * moonVis;
      c += vec3(0.85, 0.90, 1.0) * (1.0 - smoothstep(0.0, 0.025, md)) * 0.85 * moonVis;
      c += moonCol * exp(-md * 28.0) * 0.9 * moonVis;
      c += vec3(0.72, 0.83, 1.0) * exp(-abs(tc.y - muv.y) * 90.0) * exp(-abs(tc.x - muv.x) * 4.0) * 0.18 * moonVis;
    }
    if (uw > 0.5) c += vec3(0.35, 0.55, 0.65) * 0.022 * (0.5 + 0.5 * sin(uP[0].y * 3.0 + tc.x * 40.0 + tc.y * 25.0)); // underwater shimmer
    vec2 q = tc - 0.5;
    float vg = smoothstep(0.35, 1.05, length(q) * 1.4142);
    c *= 1.0 - uP[2].y * vg;
    if (uP[2].z > 0.0) {
      float g = fract(sin(dot(tc * inSize + fract(uP[0].y) * 61.7, vec2(12.9898, 78.233))) * 43758.5453);
      c += (g - 0.5) * uP[2].z * 0.05;
    }
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
  } else {
    float a = uP[0].y * 0.0174532925; float cs = cos(a), sn = sin(a);
    vec2 sc = vec2(tc.x * cs - tc.y * sn, tc.y * cs + tc.x * sn) * uP[1].xy + uP[1].zw;
    vec4 S = uP[2], V = uP[3];
    vec4 B = fetch(uLightmap, tc), O = fetch(uTex0, sc);
    if (sc.x < S.x || sc.y < S.y || sc.x > S.z || sc.y > S.w) O = B;
    if (sc.x < V.x) O = mix(B, O, (S.x - sc.x) / (S.x - V.x));
    if (sc.y < V.y) O = mix(B, O, (S.y - sc.y) / (S.y - V.y));
    if (sc.x > V.z) O = mix(B, O, (S.z - sc.x) / (S.z - V.z));
    if (sc.y > V.w) O = mix(B, O, (S.w - sc.y) / (S.w - V.w));
    o = vec4(O.rgb, 1.0);
  }
}`,
  },
};

export class WebGL2Device {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available');
    this.name = 'WebGL 2';
    this.rtOriginBottom = true; // render targets are sampled bottom-up
    // GL_VENDOR / GL_RENDERER / GL_VERSION for the debug screen (unmasked when the browser allows it)
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.info = {
      vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
      renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      version: String(gl.getParameter(gl.VERSION)),
    };
    this.gl = gl;
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;
    // draw state cache (must exist before any texture / mesh is created)
    this.curState = '';
    this.curStateObj = null;
    this.curProgram = null;
    this.curVao = null;
    this.boundTex = [null, null];
    this.programs = {};
    for (const [name, src] of Object.entries(SHADERS)) this.programs[name] = this._program(name, src);
    this.quadBuffer = gl.createBuffer();
    this.quadCapacity = 0;
    this.quadGen = 0;
    this._ensureQuads(1 << 16);
    this.white = this.createTexture({ width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) });
    this.globals = { view: new Float32Array(16), proj: new Float32Array(16), fog: new Float32Array([0, 1, 0, 2]), fogColor: new Float32Array(3), lightmap: this.white };
    gl.frontFace(gl.CCW);
    gl.cullFace(gl.BACK);
    gl.depthFunc(gl.LEQUAL);
  }

  _program(name, src) {
    const gl = this.gl;
    const compile = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, HEADER + text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader ${name}: ` + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, src.vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, src.fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program ${name}: ` + gl.getProgramInfoLog(p));
    const u = (n) => gl.getUniformLocation(p, n);
    return {
      p, uView: u('uView'), uProj: u('uProj'), uModel: u('uModel'), uP: u('uP'), uFog: u('uFog'), uFogColor: u('uFogColor'),
      uTex0: u('uTex0'), uLightmap: u('uLightmap'), globalsVersion: -1,
      lastModel: new Float32Array(16).fill(NaN), lastParams: new Float32Array(16).fill(NaN),
    };
  }

  // Optional terrain position hook. Reuses the existing terrain program/format and its unused position.w.
  createTerrainAnimation(source,lookup,lighting=''){
    const ids=this.createTexture({...lookup||{width:1,height:1,data:new Uint8Array(4)},filter:'nearest'});let program;const programs={};
    try{
      const declaration=`
${source}
uniform sampler2D uWaveIds;
vec3 mcjsWave(vec3 p){
 int packed=int(aPos.w*65535.0+0.5);
 int state=packed&32767;
 vec2 id=texelFetch(uWaveIds,ivec2(state&255,state>>8),0).rg;
 int category=int(id.r*255.0+id.g*65280.0+0.5);
 if(category==0)return p;
 vec3 world=(uModel*vec4(p,1.0)).xyz;
 return p+WavingBlocks(world-cameraPosition,category,(packed&32768)!=0?1.0:0.0)-(world-cameraPosition);
}
`;
      const vs=source?SHADERS.terrain.vs.replace('void main() {',declaration+'void main() {').replace('  vec4 mv =','  p=mcjsWave(p);\n  vec4 mv ='):SHADERS.terrain.vs;
      program=this._program('pack terrain animation',{vs,fs:lighting?lighting+SHADERS.terrain.fs.replace('lightmap(vLight)','mcjsPackLight(vLight)'):SHADERS.terrain.fs});
      const gl=this.gl;programs.terrain=program;
      if(lighting)for(const name of ['entity','lit']){
        const shader=SHADERS[name],old=name==='entity'?'lightmap(uP[2].xy)':'lightmap(vLight)';
        programs[name]=this._program('pack '+name+' lighting',{vs:shader.vs,fs:lighting+shader.fs.replace(old,name==='entity'?'mcjsPackLight(uP[2].xy)':'mcjsPackLight(vLight)')});
      }
      for(const p of Object.values(programs))p.uLighting=['Ambient','Direct','Block','Minimum','Dimension'].map(n=>gl.getUniformLocation(p.p,'uPack'+n));
      return {program,programs,ids,frame:null,uIds:gl.getUniformLocation(program.p,'uWaveIds'),uFrame:gl.getUniformLocation(program.p,'uWaveFrame'),uCamera:gl.getUniformLocation(program.p,'cameraPosition'),uEye:gl.getUniformLocation(program.p,'relativeEyePosition'),destroy:()=>{if(this.terrainAnimation?.program===program)this.terrainAnimation=null;for(const p of Object.values(programs))gl.deleteProgram(p.p);this.destroyTexture(ids);}};
    }catch(e){for(const p of Object.values(programs))this.gl.deleteProgram(p.p);this.destroyTexture(ids);throw e;}
  }

  setTerrainAnimation(animation,frame){this.terrainAnimation=animation;if(animation)animation.frame=frame;}

  // Isolated GLSL ES final pass; regular scene pipelines and vertex formats stay intact.
  createFinalShaderPass(fragment,vertex,resources={}){
    const gl=this.gl,shaders=[];let program,noise,white;
    const compile=(type,source)=>{const shader=gl.createShader(type);shaders.push(shader);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error('Shader pack: '+gl.getShaderInfoLog(shader));return shader;};
    try{
      program=gl.createProgram();
      gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex||`#version 300 es
      out vec2 texCoord;out vec2 texcoord;
      void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));texCoord=p;texcoord=p;gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`));
      gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('Shader pack: '+gl.getProgramInfoLog(program));
      const uniforms=[];const supported=FINAL_UNIFORMS;
      for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){
        const u=gl.getActiveUniform(program,i);if(u.size!==1)throw Error('Final-pass uniform arrays are unsupported: '+u.name);
        if(u.type===gl.SAMPLER_2D){
          if(u.name==='noisetex')u.unit=1;
          else if(/^(?:colortex\d+|gaux[124]|gcolor|gdepth|gnormal|composite)$/.test(u.name))u.unit=0;
          else if(/^(?:depthtex\d*|shadowtex\d*|shadowcolor\d*|shadow|gaux3)$/.test(u.name)){if(!white)white=this.createTexture({width:1,height:1,data:new Uint8Array([255,255,255,255])});u.unit=2;}
          else throw Error('Final pass needs an unavailable scene buffer: '+u.name);
        }
        else if(!supported.has(u.name)||![gl.FLOAT,gl.INT,gl.BOOL,gl.INT_VEC2,gl.FLOAT_VEC2,gl.FLOAT_VEC3,gl.FLOAT_MAT4].includes(u.type))throw Error('Unsupported final-pass uniform: '+u.name);
        uniforms.push({name:u.name,type:u.type,location:gl.getUniformLocation(program,u.name),unit:u.unit||0});
      }
      if(uniforms.some(u=>u.name==='noisetex')){if(!resources.noise)throw Error('Final pass needs its pack noise texture');noise=this.createTexture({...resources.noise,filter:'linear',wrap:'repeat'});}
      const vao=gl.createVertexArray(),defaults=shaderFrameUniforms({});
      return {destroy:()=>{gl.deleteProgram(program);gl.deleteVertexArray(vao);if(noise)this.destroyTexture(noise);if(white)this.destroyTexture(white);},draw:(scene,frame)=>{
        gl.useProgram(program);gl.bindVertexArray(vao);gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.disable(gl.CULL_FACE);gl.disable(gl.BLEND);gl.disable(gl.SCISSOR_TEST);gl.colorMask(true,true,true,true);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,scene.tex);
        if(noise){gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,noise.tex);gl.activeTexture(gl.TEXTURE0);}
        if(white){gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,white.tex);gl.activeTexture(gl.TEXTURE0);}
        const dayT24=((frame.worldTime||0)%24000+24000)%24000,dayF=((dayT24/24000-0.25)+1)%1;
        const dayLight=Math.min(1,Math.max(0,Math.cos(dayF*Math.PI*2)*2+0.5)),frameMod=((frame.frame||0)%8+8)%8;
        const values={viewWidth:this.width,viewHeight:this.height,aspectRatio:this.width/this.height,frameTimeCounter:frame.time,frameTime:frame.delta,worldTime:frame.worldTime,frameCounter:frame.frame,isEyeInWater:frame.underwater?1:0,screenBrightness:frame.gamma,rainStrength:frame.rain||0,near:frame.near??0.05,far:frame.far??1000,pixelSizeX:1/this.width,pixelSizeY:1/this.height,hideGUI:frame.hideGui?1:0,day_moment:1-dayLight,day_mixer:dayLight,night_mixer:1-dayLight,frame_mod:frameMod,dither_shift:frameMod*0.1875};
        for(const u of uniforms){const v=u.type===gl.SAMPLER_2D?u.unit:(frame.uniforms?.[u.name]??values[u.name]??defaults[u.name]);if(u.type===gl.FLOAT)gl.uniform1f(u.location,v);else if(u.type===gl.INT_VEC2)gl.uniform2iv(u.location,v);else if(u.type===gl.FLOAT_VEC2)gl.uniform2fv(u.location,v);else if(u.type===gl.FLOAT_VEC3)gl.uniform3fv(u.location,v);else if(u.type===gl.FLOAT_MAT4)gl.uniformMatrix4fv(u.location,false,v);else gl.uniform1i(u.location,v);}
        gl.drawArrays(gl.TRIANGLES,0,3);
        this.curProgram=null;this.curVao=null;this.curState='';this.curStateObj=null;this.boundTex[0]=null;this.boundTex[1]=null;this.boundTex[2]=null;
      }};
    }catch(e){if(program)gl.deleteProgram(program);if(noise)this.destroyTexture(noise);if(white)this.destroyTexture(white);throw e;}
    finally{for(const shader of shaders)gl.deleteShader(shader);}
  }

  _ensureQuads(quads) {
    if (quads <= this.quadCapacity) return;
    const gl = this.gl;
    let cap = Math.max(this.quadCapacity * 2, 1024);
    while (cap < quads) cap *= 2;
    gl.bindVertexArray(null); this.curVao = null;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, quadIndices(cap), gl.STATIC_DRAW);
    this.quadCapacity = cap;
    this.quadGen++;
  }

  resize(w, h) {
    this.canvas.width = w; this.canvas.height = h;
    this.width = w; this.height = h;
  }

  // ---------------------------------------------------------------- textures

  createTexture(o) {
    const gl = this.gl;
    const mipLevels = o.mipmaps === true ? 4 : Math.max(0, o.mipmaps | 0);
    const t = { tex: gl.createTexture(), width: o.width, height: o.height, mipmaps: mipLevels > 0, mipLevels, filter: o.filter || 'nearest', wrap: o.wrap || 'clamp' };
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this.boundTex[0] = null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, o.width, o.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, o.data ? toU8(o.data) : null);
    const near = t.filter === 'nearest';
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, t.mipmaps ? (near ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR_MIPMAP_LINEAR) : (near ? gl.NEAREST : gl.LINEAR));
    const wrap = t.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (t.mipmaps && o.data) this._uploadMips(t, o.data);
    else if (t.mipmaps) gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    return t;
  }

  // Offscreen colour + depth target; the returned object is also a normal (linear, clamped) texture
  createRenderTarget(w, h) {
    const gl = this.gl;
    const t = this.createTexture({ width: w, height: h, filter: 'linear', wrap: 'clamp' });
    t.fbo = gl.createFramebuffer();
    t.depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target ? this.target.fbo : null);
    return t;
  }

  // Draw into a render target (null = the screen). clear = [r, g, b, a] clears colour + depth.
  setRenderTarget(t, clear) {
    const gl = this.gl;
    this.target = t || null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.width : this.width, t ? t.height : this.height);
    gl.disable(gl.SCISSOR_TEST);
    if (clear) {
      gl.clearColor(clear[0], clear[1], clear[2], clear[3] === undefined ? 1 : clear[3]);
      gl.depthMask(true);
      gl.colorMask(true, true, true, true);
      this.curState = '';
      this.curStateObj = null;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
  }

  // True while the GPU is more than a frame behind (used to pace uncapped frame rates)
  busy() {
    const gl = this.gl, f = this.fences || (this.fences = []);
    while (f.length) {
      const st = gl.clientWaitSync(f[0], 0, 0);
      if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) break;
      gl.deleteSync(f.shift());
    }
    return f.length >= 2;
  }

  _uploadMips(t, data) {
    const gl = this.gl;
    const mips = buildMips(t.width, t.height, toU8(data), t.mipLevels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mips.length);
    mips.forEach((m, i) => gl.texImage2D(gl.TEXTURE_2D, i + 1, gl.RGBA, m.width, m.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data));
  }

  updateTexture(t, data, x = 0, y = 0, w = t.width, h = t.height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    this.boundTex[0] = null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, toU8(data));
    if (t.mipmaps && x === 0 && y === 0 && w === t.width && h === t.height) this._uploadMips(t, data);
  }

  destroyTexture(t) { if (t && t.tex) this.gl.deleteTexture(t.tex); }

  // ---------------------------------------------------------------- meshes

  createMesh(format, vertices, opts = {}) {
    const gl = this.gl;
    const m = { format, vao: gl.createVertexArray(), vbo: gl.createBuffer(), ibo: null, vertexCount: 0, indexCount: 0, quads: !!opts.quads, dynamic: !!opts.dynamic, quadGen: -1 };
    gl.bindVertexArray(m.vao); this.curVao = m.vao;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    const L = vertexLayout(format);
    m.byteStride = L.byteStride;
    L.attrs.forEach((a, i) => {
      gl.enableVertexAttribArray(i);
      const type = a.type === 'unorm16' ? gl.UNSIGNED_SHORT : a.type === 'unorm8' ? gl.UNSIGNED_BYTE : gl.FLOAT;
      gl.vertexAttribPointer(i, a.size, type, a.type !== 'f32', L.byteStride, a.byteOffset);
    });
    gl.bindVertexArray(null); this.curVao = null;
    this.updateMesh(m, vertices, opts);
    return m;
  }

  updateMesh(m, vertices, opts = {}) {
    const gl = this.gl;
    gl.bindVertexArray(null); this.curVao = null;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, m.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    m.vertexCount = vertices.byteLength / m.byteStride;
    m.byteLength = vertices.byteLength;
    if (opts.quads !== undefined) m.quads = !!opts.quads;
    if (opts.indices) {
      if (!m.ibo) m.ibo = gl.createBuffer();
      gl.bindVertexArray(m.vao); this.curVao = m.vao;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, opts.indices instanceof Uint32Array ? opts.indices : new Uint32Array(opts.indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null); this.curVao = null;
      m.indexCount = opts.indices.length;
      m.quads = false;
    } else if (m.quads) {
      this._ensureQuads(m.vertexCount / 4);
      m.indexCount = (m.vertexCount / 4) * 6;
    } else m.indexCount = 0;
  }

  destroyMesh(m) {
    if (!m) return;
    const gl = this.gl;
    gl.deleteVertexArray(m.vao);
    gl.deleteBuffer(m.vbo);
    if (m.ibo) gl.deleteBuffer(m.ibo);
  }

  // ---------------------------------------------------------------- frame

  beginFrame(clear) {
    const gl = this.gl;
    if (this.target) { this.target = null; gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    this.curState = '';
    this.curStateObj = null;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  clearDepth() {
    const gl = this.gl;
    gl.depthMask(true);
    this.curState = '';
    gl.clear(gl.DEPTH_BUFFER_BIT);
  }

  setGlobals(g) {
    const G = this.globals;
    if (g.view) G.view.set(g.view);
    if (g.proj) G.proj.set(g.proj);
    if (g.fogColor) G.fogColor.set(g.fogColor);
    if (g.fogStart !== undefined) G.fog[0] = g.fogStart;
    if (g.fogEnd !== undefined) G.fog[1] = g.fogEnd;
    if (g.fogDensity !== undefined) G.fog[2] = g.fogDensity;
    if (g.fogMode !== undefined) G.fog[3] = g.fogMode;
    if (g.lightmap) G.lightmap = g.lightmap;
    this.globalsVersion = (this.globalsVersion || 0) + 1;
  }

  setScissor(r) {
    const gl = this.gl;
    if (!r) { gl.disable(gl.SCISSOR_TEST); return; }
    gl.enable(gl.SCISSOR_TEST);
    const th = this.target ? this.target.height : this.height;
    gl.scissor(Math.floor(r[0]), Math.floor(th - r[1] - r[3]), Math.ceil(r[2]), Math.ceil(r[3]));
  }

  _applyState(s) {
    if (s === this.curStateObj) return;
    this.curStateObj = s;
    const key = (s.blend || 'none') + (s.depthTest === false ? 0 : 1) + (s.depthWrite === false ? 0 : 1) + (s.cull ? 1 : 0) + (s.polygonOffset ? 1 : 0) + (s.depthFunc === 'equal' ? 'e' : '') + (s.colorWrite === false ? 'n' : '');
    if (key === this.curState) return;
    this.curState = key;
    const gl = this.gl;
    const b = s.blend || 'none';
    if (b === 'none') gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      switch (b) {
        case 'alpha': gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); break;
        case 'add': gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break;
        case 'invert': gl.blendFunc(gl.ONE_MINUS_DST_COLOR, gl.ONE_MINUS_SRC_COLOR); break;
        case 'darken': gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_COLOR); break;
        case 'multiply': gl.blendFunc(gl.DST_COLOR, gl.SRC_COLOR); break;
        default: gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
    }
    if (s.depthTest === false) gl.disable(gl.DEPTH_TEST); else gl.enable(gl.DEPTH_TEST);
    gl.depthMask(s.depthWrite !== false);
    gl.depthFunc(s.depthFunc === 'equal' ? gl.EQUAL : gl.LEQUAL);
    const cw = s.colorWrite !== false;
    gl.colorMask(cw, cw, cw, cw);
    if (s.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    if (s.polygonOffset) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1); } else gl.disable(gl.POLYGON_OFFSET_FILL);
  }

  draw(d) {
    const gl = this.gl;
    const m = d.mesh;
    if (!m || !m.vertexCount) return;
    const pack=this.terrainAnimation,params=d.params||DEFAULT_PARAMS[d.pipeline]||ZERO16;
    const animation=pack&&(d.pipeline==='terrain'||pack.programs?.[d.pipeline]&&(d.pipeline!=='entity'||params[11]<1.5))?pack:null;
    const prog = animation ? animation.programs?.[d.pipeline]||animation.program : this.programs[d.pipeline];
    if (this.curProgram !== prog) { gl.useProgram(prog.p); this.curProgram = prog; }
    if (prog.globalsVersion !== this.globalsVersion) {
      const G = this.globals;
      gl.uniformMatrix4fv(prog.uView, false, G.view);
      gl.uniformMatrix4fv(prog.uProj, false, G.proj);
      gl.uniform4fv(prog.uFog, G.fog);
      gl.uniform3fv(prog.uFogColor, G.fogColor);
      gl.uniform1i(prog.uTex0, 0);
      gl.uniform1i(prog.uLightmap, 1);
      prog.globalsVersion = this.globalsVersion;
    }
    // Skip uniform uploads / binds that would not change anything (draw state caching)
    const model = d.model || IDENTITY;
    if (!same16(prog.lastModel, model)) { gl.uniformMatrix4fv(prog.uModel, false, model); prog.lastModel.set(model); }
    if (!same16(prog.lastParams, params)) { gl.uniform4fv(prog.uP, params); prog.lastParams.set(params); }
    const t0 = ((d.textures && d.textures[0]) || this.white).tex;
    if (this.boundTex[0] !== t0) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t0); this.boundTex[0] = t0; }
    const lm = (this.globals.lightmap || this.white).tex;
    if (this.boundTex[1] !== lm) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, lm); gl.activeTexture(gl.TEXTURE0); this.boundTex[1] = lm; }
    if(animation){
      const f=animation.frame,c=f.camera,e=f.eye;
      if(f.lighting){const l=f.lighting;for(const [i,key]of ['ambient','direct','block','minimum'].entries())gl.uniform3fv(prog.uLighting[i],l[key]);gl.uniform1f(prog.uLighting[4],l.dimension);}
      if(d.pipeline==='terrain'){gl.uniform1i(animation.uIds,2);gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,animation.ids.tex);gl.activeTexture(gl.TEXTURE0);
      gl.uniform4f(animation.uFrame,f.time,f.worldTime,0,0);gl.uniform3fv(animation.uCamera,c);gl.uniform3f(animation.uEye,c[0]-e[0],c[1]-e[1],c[2]-e[2]);}
    }
    this._applyState(d.state || EMPTY_STATE);
    if (this.curVao !== m.vao) { gl.bindVertexArray(m.vao); this.curVao = m.vao; }
    const mode = d.primitive === 'lines' ? gl.LINES : gl.TRIANGLES;
    if (m.quads) {
      if (m.quadGen !== this.quadGen) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.quadBuffer); m.quadGen = this.quadGen; }
      const first = d.first || 0;
      const count = d.count !== undefined ? d.count : m.indexCount;
      if (count > 0) gl.drawElements(mode, count, gl.UNSIGNED_INT, first * 4);
    } else if (m.ibo) {
      const count = d.count !== undefined ? d.count : m.indexCount;
      if (count > 0) gl.drawElements(mode, count, gl.UNSIGNED_INT, (d.first || 0) * 4);
    } else {
      const count = d.count !== undefined ? d.count : m.vertexCount;
      if (count > 0) gl.drawArrays(mode, d.first || 0, count);
    }
  }

  endFrame() {
    if (this.captureWaiters && this.captureWaiters.length) {
      const px = this._readPixels();
      for (const r of this.captureWaiters.splice(0)) r(px);
    }
    const gl = this.gl;
    (this.fences || (this.fences = [])).push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    if (this.fences.length > 8) gl.deleteSync(this.fences.shift());
    gl.flush();
  }

  capture() { return new Promise((res) => { (this.captureWaiters ||= []).push(res); }); }

  _readPixels() {
    const gl = this.gl;
    const w = this.width, h = this.height;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }
}

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ZERO16 = new Float32Array(16);
const EMPTY_STATE = {};
function same16(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}
const toU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
export { PIPELINE_FORMAT };
