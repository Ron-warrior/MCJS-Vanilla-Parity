// Tectonic / 1.18.2 noise primitives (no dependencies).
//
// Exact port of the vanilla 1.18.2 algorithms, verified against two oracles:
//  - deepslate@0.12.1 (the 1.18.2-era codebase): Xoroshiro/Improved/Perlin/
//    NormalNoise match it bit-exactly for the same inputs (oracle battery:
//    45 Tectonic noise params x many points, exact; BlendedNoise verified
//    against 0.12.1's class patched to the jar's full masks).
//  - the vanilla 1.18.2 server jar itself (scratch/vanilla1194/
//    server-1.18.2.jar), disassembled: PerlinNoise (did.class) has both the
//    "octave_" positional path (Z=false) and the sequential consume(262)
//    legacy path (Z=true); NormalNoise (dic.class) routes create->new(Z=false)
//    and createLegacy->legacy(Z=true); BlendedNoise (dhz.class) calls
//    rangeClosed(-15,0) x2 + rangeClosed(-7,0) through the NEW path — FULL
//    octave masks, positionally seeded. (deepslate@0.12.1's BlendedNoise uses
//    REDUCED masks and does NOT match the jar; deepslate@0.24 restored full
//    masks. The sample loop is identical everywhere.)
// Tectonic runs with legacy_random_source=false, so every router noise takes
// the positional path — which is what this file implements throughout.
//
// Not bit-exact vanilla by design (float32 rounding in CubicSpline is kept,
// double arithmetic matches Java doubles exactly).

// ------------------------------------------------------------- math utils

export function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

export function clampedLerp(a, b, c) {
  if (c < 0) return a;
  if (c > 1) return b;
  return lerp(c, a, b);
}

export function lerp(a, b, c) {
  return b + a * (c - b);
}

export function lerp2(a, b, c, d, e, f) {
  return lerp(b, lerp(a, c, d), lerp(a, e, f));
}

export function lerp3(a, b, c, d, e, f, g, h, i, j, k) {
  return lerp(c, lerp2(a, b, d, e, f, g), lerp2(a, b, h, i, j, k));
}

// Lazy trilinear: corner thunks run only when their weight is non-zero.
export function lazyLerp(a, b, c) {
  if (a === 0) return b();
  if (a === 1) return c();
  return b() + a * (c() - b());
}

export function lazyLerp2(a, b, c, d, e, f) {
  return lazyLerp(b, () => lazyLerp(a, c, d), () => lazyLerp(a, e, f));
}

export function lazyLerp3(a, b, c, d, e, f, g, h, i, j, k) {
  return lazyLerp(c, () => lazyLerp2(a, b, d, e, f, g), () => lazyLerp2(a, b, h, i, j, k));
}

export function inverseLerp(a, b, c) {
  return (a - b) / (c - b);
}

export function clampedMap(a, b, c, d, e) {
  return clampedLerp(d, e, inverseLerp(a, b, c));
}

export function smoothstep(x) {
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// Vanilla Mth.floor for bounded coords: identical to Math.floor here
// (all inputs are within int32 range; narrowing is a no-op).
export function intFloor(x) {
  return Math.floor(x);
}

export function longFloor(x) {
  return Math.floor(x);
}

export function floatLerp(d, s, e) {
  return s + d * (e - s);
}

export function binarySearch(n, n2, predicate) {
  let n3 = n2 - n;
  while (n3 > 0) {
    const n4 = Math.floor(n3 / 2);
    const n5 = n + n4;
    if (predicate(n5)) {
      n3 = n4;
      continue;
    }
    n = n5 + 1;
    n3 -= n4 + 1;
  }
  return n;
}

// ------------------------------------------------------------- md5 (RFC 1321, UTF-8 in, 16 bytes out)

function md5blk(s, i) {
  const b = new Array(16);
  for (let j = 0; j < 16; j++) {
    b[j] = (s.charCodeAt(i + j * 4) & 0xff) |
      ((s.charCodeAt(i + j * 4 + 1) & 0xff) << 8) |
      ((s.charCodeAt(i + j * 4 + 2) & 0xff) << 16) |
      ((s.charCodeAt(i + j * 4 + 3) & 0xff) << 24);
  }
  return b;
}

function md5round(func, a, b, c, d, x, s, t) {
  let n = (a + func(b, c, d) + x + t) | 0;
  n = ((n << s) | (n >>> (32 - s)));
  return (n + b) | 0;
}

export function md5bytes(str) {
  // UTF-8 encode (names hashed here are ASCII, but stay correct anyway)
  const s = unescape(encodeURIComponent(str));
  const len = s.length;
  const bitLen = len * 8;
  let padded = s + "\x80";
  while ((padded.length % 64) !== 56) padded += "\x00";
  // append 64-bit little-endian length (low word only matters here)
  const lo = bitLen >>> 0, hi = Math.floor(bitLen / 4294967296) >>> 0;
  padded += String.fromCharCode(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff,
    hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & z) | (y & ~z);
  const H = (x, y, z) => x ^ y ^ z;
  const I = (x, y, z) => y ^ (x | ~z);
  for (let i = 0; i < padded.length; i += 64) {
    const X = md5blk(padded, i);
    let A = a, B = b, C = c, D = d;
    A = md5round(F, A, B, C, D, X[0], 7, 0xd76aa478);
    D = md5round(F, D, A, B, C, X[1], 12, 0xe8c7b756);
    C = md5round(F, C, D, A, B, X[2], 17, 0x242070db);
    B = md5round(F, B, C, D, A, X[3], 22, 0xc1bdceee);
    A = md5round(F, A, B, C, D, X[4], 7, 0xf57c0faf);
    D = md5round(F, D, A, B, C, X[5], 12, 0x4787c62a);
    C = md5round(F, C, D, A, B, X[6], 17, 0xa8304613);
    B = md5round(F, B, C, D, A, X[7], 22, 0xfd469501);
    A = md5round(F, A, B, C, D, X[8], 7, 0x698098d8);
    D = md5round(F, D, A, B, C, X[9], 12, 0x8b44f7af);
    C = md5round(F, C, D, A, B, X[10], 17, 0xffff5bb1);
    B = md5round(F, B, C, D, A, X[11], 22, 0x895cd7be);
    A = md5round(F, A, B, C, D, X[12], 7, 0x6b901122);
    D = md5round(F, D, A, B, C, X[13], 12, 0xfd987193);
    C = md5round(F, C, D, A, B, X[14], 17, 0xa679438e);
    B = md5round(F, B, C, D, A, X[15], 22, 0x49b40821);
    A = md5round(G, A, B, C, D, X[1], 5, 0xf61e2562);
    D = md5round(G, D, A, B, C, X[6], 9, 0xc040b340);
    C = md5round(G, C, D, A, B, X[11], 14, 0x265e5a51);
    B = md5round(G, B, C, D, A, X[0], 20, 0xe9b6c7aa);
    A = md5round(G, A, B, C, D, X[5], 5, 0xd62f105d);
    D = md5round(G, D, A, B, C, X[10], 9, 0x02441453);
    C = md5round(G, C, D, A, B, X[15], 14, 0xd8a1e681);
    B = md5round(G, B, C, D, A, X[4], 20, 0xe7d3fbc8);
    A = md5round(G, A, B, C, D, X[9], 5, 0x21e1cde6);
    D = md5round(G, D, A, B, C, X[14], 9, 0xc33707d6);
    C = md5round(G, C, D, A, B, X[3], 14, 0xf4d50d87);
    B = md5round(G, B, C, D, A, X[8], 20, 0x455a14ed);
    A = md5round(G, A, B, C, D, X[13], 5, 0xa9e3e905);
    D = md5round(G, D, A, B, C, X[2], 9, 0xfcefa3f8);
    C = md5round(G, C, D, A, B, X[7], 14, 0x676f02d9);
    B = md5round(G, B, C, D, A, X[12], 20, 0x8d2a4c8a);
    A = md5round(H, A, B, C, D, X[5], 4, 0xfffa3942);
    D = md5round(H, D, A, B, C, X[8], 11, 0x8771f681);
    C = md5round(H, C, D, A, B, X[11], 16, 0x6d9d6122);
    B = md5round(H, B, C, D, A, X[14], 23, 0xfde5380c);
    A = md5round(H, A, B, C, D, X[1], 4, 0xa4beea44);
    D = md5round(H, D, A, B, C, X[4], 11, 0x4bdecfa9);
    C = md5round(H, C, D, A, B, X[7], 16, 0xf6bb4b60);
    B = md5round(H, B, C, D, A, X[10], 23, 0xbebfbc70);
    A = md5round(H, A, B, C, D, X[13], 4, 0x289b7ec6);
    D = md5round(H, D, A, B, C, X[0], 11, 0xeaa127fa);
    C = md5round(H, C, D, A, B, X[3], 16, 0xd4ef3085);
    B = md5round(H, B, C, D, A, X[6], 23, 0x04881d05);
    A = md5round(H, A, B, C, D, X[9], 4, 0xd9d4d039);
    D = md5round(H, D, A, B, C, X[12], 11, 0xe6db99e5);
    C = md5round(H, C, D, A, B, X[15], 16, 0x1fa27cf8);
    B = md5round(H, B, C, D, A, X[2], 23, 0xc4ac5665);
    A = md5round(I, A, B, C, D, X[0], 6, 0xf4292244);
    D = md5round(I, D, A, B, C, X[7], 10, 0x432aff97);
    C = md5round(I, C, D, A, B, X[14], 15, 0xab9423a7);
    B = md5round(I, B, C, D, A, X[5], 21, 0xfc93a039);
    A = md5round(I, A, B, C, D, X[12], 6, 0x655b59c3);
    D = md5round(I, D, A, B, C, X[3], 10, 0x8f0ccc92);
    C = md5round(I, C, D, A, B, X[10], 15, 0xffeff47d);
    B = md5round(I, B, C, D, A, X[1], 21, 0x85845dd1);
    A = md5round(I, A, B, C, D, X[8], 6, 0x6fa87e4f);
    D = md5round(I, D, A, B, C, X[15], 10, 0xfe2ce6e0);
    C = md5round(I, C, D, A, B, X[6], 15, 0xa3014314);
    B = md5round(I, B, C, D, A, X[13], 21, 0x4e0811a1);
    A = md5round(I, A, B, C, D, X[4], 6, 0xf7537e82);
    D = md5round(I, D, A, B, C, X[11], 10, 0xbd3af235);
    C = md5round(I, C, D, A, B, X[2], 15, 0x2ad7d2bb);
    B = md5round(I, B, C, D, A, X[9], 21, 0xeb86d391);
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  const out = new Array(16);
  for (let i = 0; i < 4; i++) {
    const w = [a, b, c, d][i];
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

// ------------------------------------------------------------- Xoroshiro128++

const U64 = (1n << 64n) - 1n;

export class XoroshiroRandom {
  constructor(seedLo, seedHi) {
    this.seed = [seedLo & U64, seedHi & U64];
  }
  static create(seed) {
    return new XoroshiroRandom(...XoroshiroRandom.upgradeSeedTo128bit(BigInt(seed)));
  }
  static mixStafford13(v) {
    v = (((v ^ (v >> 30n)) * -4658895280553007687n) & U64);
    v = (((v ^ (v >> 27n)) * -7723592293110705685n) & U64);
    return ((v ^ (v >> 31n)) & U64);
  }
  static upgradeSeedTo128bit(seed) {
    if (seed < 0) seed += (1n << 64n);
    const lo = (seed ^ 7640891576956012809n) & U64;
    const hi = (lo + (-7046029254386353131n)) & U64;
    return [XoroshiroRandom.mixStafford13(lo), XoroshiroRandom.mixStafford13(hi)];
  }
  static rotl(v, s) {
    return (((v << s) & U64) | (v >> (64n - s))) & U64;
  }
  fork() {
    return new XoroshiroRandom(this.next(), this.next());
  }
  forkPositional() {
    return new XoroshiroPositionalRandom(this.next(), this.next());
  }
  next() {
    const lo = this.seed[0];
    let hi = this.seed[1];
    const v = (XoroshiroRandom.rotl((lo + hi) & U64, 17n) + lo) & U64;
    hi ^= lo;
    this.seed = [
      XoroshiroRandom.rotl(lo, 49n) ^ hi ^ ((hi << 21n) & U64),
      XoroshiroRandom.rotl(hi, 28n),
    ];
    return v;
  }
  nextLong() {
    let v = this.next();
    if (v > (1n << 63n)) v -= (1n << 64n);
    return v;
  }
  consume(count) {
    let lo = this.seed[0], hi = this.seed[1];
    for (let i = 0; i < count; i++) {
      hi ^= lo;
      lo = XoroshiroRandom.rotl(lo, 49n) ^ hi ^ ((hi << 21n) & U64);
      hi = XoroshiroRandom.rotl(hi, 28n);
    }
    this.seed = [lo & U64, hi & U64];
  }
  nextBits(bits) {
    return this.next() >> BigInt(64 - bits);
  }
  nextInt(max) {
    let v = this.next() & 0xffffffffn;
    if (!max) {
      let r = Number(v);
      if (r >= 0x80000000) r -= 0x100000000;
      return r;
    }
    const mb = BigInt(max);
    let prod = v * mb;
    let prodLo = prod & 0xffffffffn;
    if (prodLo < mb) {
      const newMax = ((~mb & 0xffffffffn) + 1n) % mb;
      while (prodLo < newMax) {
        v = this.next() & 0xffffffffn;
        prod = v * mb;
        prodLo = prod & 0xffffffffn;
      }
    }
    return Number(prod >> 32n);
  }
  nextFloat() {
    return Number(this.nextBits(24)) * (1 / 16777216);
  }
  nextDouble() {
    return Number(this.nextBits(53)) * 1.1102230246251565e-16;
  }
}

export function longFromBytes(a, b, c, d, e, f, g, h) {
  return BigInt.asIntN(64,
    (BigInt(a) << 56n) | (BigInt(b) << 48n) | (BigInt(c) << 40n) | (BigInt(d) << 32n) |
    (BigInt(e) << 24n) | (BigInt(f) << 16n) | (BigInt(g) << 8n) | BigInt(h));
}

export function seedFromXZ(x, y, z) {
  // vanilla Mth.getSeed, Java-long semantics via BigInt.asIntN
  let s = BigInt.asIntN(64, BigInt(x * 3129871) ^ (BigInt(z) * 116129781n) ^ BigInt(y));
  s = BigInt.asIntN(64, s * s * 42317861n + s * 11n);
  return s >> 16n;
}

export class XoroshiroPositionalRandom {
  constructor(seedLo, seedHi) {
    this.seedLo = BigInt.asIntN(64, seedLo);
    this.seedHi = BigInt.asIntN(64, seedHi);
  }
  at(x, y, z) {
    const s = seedFromXZ(x, y, z);
    return new XoroshiroRandom((s ^ this.seedLo) & U64, this.seedHi & U64);
  }
  fromHashOf(name) {
    const h = md5bytes(name);
    const lo = longFromBytes(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
    const hi = longFromBytes(h[8], h[9], h[10], h[11], h[12], h[13], h[14], h[15]);
    return new XoroshiroRandom((lo ^ this.seedLo) & U64, (hi ^ this.seedHi) & U64);
  }
}

// ------------------------------------------------------------- gradient table (== vanilla simplex gradients)

const GRADIENT = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
  [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1],
];

export function gradDot(h, x, y, z) {
  const g = GRADIENT[h & 15];
  return g[0] * x + g[1] * y + g[2] * z;
}

// ------------------------------------------------------------- ImprovedNoise

export class ImprovedNoise {
  constructor(random) {
    this.xo = random.nextDouble() * 256;
    this.yo = random.nextDouble() * 256;
    this.zo = random.nextDouble() * 256;
    this.p = new Array(256);
    for (let i = 0; i < 256; i++) this.p[i] = i > 127 ? i - 256 : i;
    for (let i = 0; i < 256; i++) {
      const j = random.nextInt(256 - i);
      const b = this.p[i];
      this.p[i] = this.p[i + j];
      this.p[i + j] = b;
    }
  }
  sample(x, y, z, yScale, yLimit) {
    yScale = yScale || 0; yLimit = yLimit || 0;
    const x2 = x + this.xo, y2 = y + this.yo, z2 = z + this.zo;
    const x3 = Math.floor(x2), y3 = Math.floor(y2), z3 = Math.floor(z2);
    const x4 = x2 - x3, y4 = y2 - y3, z4 = z2 - z3;
    let y6 = 0;
    if (yScale !== 0) {
      const t = (yLimit >= 0 && yLimit < y4) ? yLimit : y4;
      y6 = Math.floor(t / yScale + 1e-7) * yScale;
    }
    return this.sampleAndLerp(x3, y3, z3, x4, y4 - y6, z4, y4);
  }
  sampleAndLerp(a, b, c, d, e, f, g) {
    const P = (i) => this.p[i & 0xff] & 0xff;
    const h = P(a), i = P(a + 1);
    const j = P(h + b), k = P(h + b + 1), l = P(i + b), m = P(i + b + 1);
    const n = gradDot(P(j + c), d, e, f);
    const o = gradDot(P(l + c), d - 1.0, e, f);
    const p = gradDot(P(k + c), d, e - 1.0, f);
    const q = gradDot(P(m + c), d - 1.0, e - 1.0, f);
    const r = gradDot(P(j + c + 1), d, e, f - 1.0);
    const s = gradDot(P(l + c + 1), d - 1.0, e, f - 1.0);
    const t = gradDot(P(k + c + 1), d, e - 1.0, f - 1.0);
    const u = gradDot(P(m + c + 1), d - 1.0, e - 1.0, f - 1.0);
    return lerp3(smoothstep(d), smoothstep(g), smoothstep(f), n, o, p, q, r, s, t, u);
  }
}

// ------------------------------------------------------------- PerlinNoise (1.18.2: positional octaves)

export class PerlinNoise {
  constructor(random, firstOctave, amplitudes) {
    const forked = random.forkPositional();
    this.noiseLevels = new Array(amplitudes.length);
    for (let i = 0; i < amplitudes.length; i++) {
      if (amplitudes[i] !== 0.0) {
        this.noiseLevels[i] = new ImprovedNoise(forked.fromHashOf("octave_" + (firstOctave + i)));
      }
    }
    this.firstOctave = firstOctave;
    this.amplitudes = amplitudes;
    this.lowestFreqInputFactor = Math.pow(2, firstOctave);
    this.lowestFreqValueFactor = Math.pow(2, amplitudes.length - 1) / (Math.pow(2, amplitudes.length) - 1);
    // Compact nonzero-octave list with precomputed per-octave factors, so
    // the sample loop skips zero-amplitude octaves without per-iteration
    // branching. Bit-identical to the open-coded loop: same factors
    // (low*2^i, lowV/2^i) and same left-to-right operation order.
    this.oct = [];
    for (let i = 0; i < amplitudes.length; i++) {
      if (this.noiseLevels[i]) {
        this.oct.push({
          n: this.noiseLevels[i], a: amplitudes[i],
          fi: this.lowestFreqInputFactor * Math.pow(2, i),
          fv: this.lowestFreqValueFactor / Math.pow(2, i),
        });
      }
    }
  }
  sample(x, y, z, yScale, yLimit, fixY) {
    yScale = yScale || 0; yLimit = yLimit || 0;
    let value = 0;
    for (let k = 0; k < this.oct.length; k++) {
      const o = this.oct[k];
      value += o.a * o.fv * o.n.sample(
        PerlinNoise.wrap(x * o.fi),
        fixY ? -o.n.yo : PerlinNoise.wrap(y * o.fi),
        PerlinNoise.wrap(z * o.fi),
        yScale * o.fi, yLimit * o.fi);
    }
    return value;
  }
  getOctaveNoise(i) {
    return this.noiseLevels[this.noiseLevels.length - 1 - i];
  }
  edgeValue(x) {
    let value = 0;
    let valueF = this.lowestFreqValueFactor;
    for (let i = 0; i < this.noiseLevels.length; i++) {
      if (this.noiseLevels[i]) value += this.amplitudes[i] * x * valueF;
      valueF /= 2;
    }
    return value;
  }
  static wrap(v) {
    return v - Math.floor(v / 3.3554432e7 + 0.5) * 3.3554432e7;
  }
}

// ------------------------------------------------------------- NormalNoise

export class NormalNoise {
  constructor(random, params) {
    const firstOctave = params.firstOctave, amplitudes = params.amplitudes;
    this.first = new PerlinNoise(random, firstOctave, amplitudes);
    this.second = new PerlinNoise(random, firstOctave, amplitudes);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < amplitudes.length; i++) {
      if (amplitudes[i] !== 0) {
        if (i < min) min = i;
        if (i > max) max = i;
      }
    }
    const expectedDeviation = 0.1 * (1 + 1 / (max - min + 1));
    this.valueFactor = (1 / 6) / expectedDeviation;
  }
  sample(x, y, z) {
    const F = NormalNoise.INPUT_FACTOR;
    return (this.first.sample(x, y, z) + this.second.sample(x * F, y * F, z * F)) * this.valueFactor;
  }
}
NormalNoise.INPUT_FACTOR = 1.0181268882175227;

// ------------------------------------------------------------- BlendedNoise (vanilla 1.18.2 shape, proven from the server jar)
//
// dhz.<init>(UnseededRandom, NoiseSettings-ish, int, int) disassembly:
//   minLimit = PerlinNoise.create(random, IntStream.rangeClosed(-15, 0))  // 16 octaves, ALL nonzero
//   maxLimit = PerlinNoise.create(random, IntStream.rangeClosed(-15, 0))  // 16 octaves, ALL nonzero
//   main     = PerlinNoise.create(random, IntStream.rangeClosed(-7, 0))   // 8 octaves, ALL nonzero
// where create = did.a(cun, IntStream) = `new PerlinNoise(random, pair, false)`:
// the Z=false (NEW positional) seeding path (forkPositional + md5("octave_"+N)).
// The legacy path (Z=true, sequential consume(262)) is did.b, used only by
// NormalNoise.createLegacy — never by the overworld router (legacy_random_source=false).
// (deepslate@0.12.1's BlendedNoise uses REDUCED masks — 9+7 of -15, 5+3 of -7 —
// which does NOT match the 1.18.2 jar; 0.24 restored the full masks. The sample
// loop itself is identical in all three and is unchanged here.)

export class BlendedNoise {
  constructor(random, xzScale, yScale, xzFactor, yFactor, smearScaleMultiplier) {
    this.xzScale = xzScale; this.yScale = yScale;
    this.xzFactor = xzFactor; this.yFactor = yFactor;
    this.smearScaleMultiplier = smearScaleMultiplier;
    // 1.18.2 octave masks: full ranges, every amplitude nonzero.
    const ONES16 = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const ONES8 = [1, 1, 1, 1, 1, 1, 1, 1];
    this.minLimitNoise = new PerlinNoise(random, -15, ONES16);
    this.maxLimitNoise = new PerlinNoise(random, -15, ONES16);
    this.mainNoise = new PerlinNoise(random, -7, ONES8);
    this.xzMultiplier = 684.412 * xzScale;
    this.yMultiplier = 684.412 * yScale;
  }
  sample(x, y, z) {
    const scaledX = x * this.xzMultiplier;
    const scaledY = y * this.yMultiplier;
    const scaledZ = z * this.xzMultiplier;
    const factoredX = scaledX / this.xzFactor;
    const factoredY = scaledY / this.yFactor;
    const factoredZ = scaledZ / this.xzFactor;
    const smear = this.yMultiplier * this.smearScaleMultiplier;
    const factoredSmear = smear / this.yFactor;
    let noise, value = 0, factor = 1;
    for (let i = 0; i < 8; i++) {
      noise = this.mainNoise.getOctaveNoise(i);
      if (noise) {
        value += noise.sample(
          PerlinNoise.wrap(factoredX * factor),
          PerlinNoise.wrap(factoredY * factor),
          PerlinNoise.wrap(factoredZ * factor),
          factoredSmear * factor, factoredY * factor) / factor;
      }
      factor /= 2;
    }
    value = (value / 10 + 1) / 2;
    factor = 1;
    let min = 0, max = 0;
    for (let i = 0; i < 16; i++) {
      const xx = PerlinNoise.wrap(scaledX * factor);
      const yy = PerlinNoise.wrap(scaledY * factor);
      const zz = PerlinNoise.wrap(scaledZ * factor);
      const sm = smear * factor;
      if (value < 1 && (noise = this.minLimitNoise.getOctaveNoise(i))) {
        min += noise.sample(xx, yy, zz, sm, scaledY * factor) / factor;
      }
      if (value > 0 && (noise = this.maxLimitNoise.getOctaveNoise(i))) {
        max += noise.sample(xx, yy, zz, sm, scaledY * factor) / factor;
      }
      factor /= 2;
    }
    return clampedLerp(min / 512, max / 512, value) / 128;
  }
}
