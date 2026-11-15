// Tectonic / 1.18.2 density-function interpreter (no dependencies except
// tectonic-noise.js).
//
// Supports exactly the op set used by the bundled Tectonic router plus the
// vanilla shift helpers. Semantics ported from deepslate@0.12.1
// (lib/worldgen/DensityFunction.js, lib/math/CubicSpline.js), which targets
// 1.18.2 — cross-checked against the vanilla 1.18.2/1.20.1 server jars.
//
// Bundle reference rules (see tectonic.js header for provenance):
//  - {"type": ...} objects: ops below (unknown type = build-time throw).
//  - numbers: constants.
//  - bare strings: named functions from the bundle; EXCEPT
//    "minecraft:shift_x"/"minecraft:shift_z", which vanilla defines as
//    flat_cache(cache_2d(shift_a/shift_b(noise "minecraft:offset"))) in every
//    version (1.18.2 code, 1.20.1 + 1.20.4 + latest jars). Those two density
//    functions were never copied into the bundle, so they are synthesized
//    here from the bundled "minecraft:offset" noise.

import {
  clamp, clampedMap, floatLerp,
  XoroshiroRandom, NormalNoise, BlendedNoise,
} from "./tectonic-noise.js";

// ------------------------------------------------------------- node types
// Every node implements compute(x, y, z). Nodes are synchronous and share
// nothing except their own last-value caches (single-threaded use).

class YCoord {
  compute(x, y, z) { return y; }
  sign(x, y, z) { return y > 0 ? 1 : y < 0 ? -1 : 0; }
}

class Constant {
  constructor(v) { this.v = v; this.s = v > 0 ? 1 : v < 0 ? -1 : 0; }
  compute() { return this.v; }
  sign() { return this.s; }
}

class Add {
  constructor(a, b) { this.a = a; this.b = b; }
  compute(x, y, z) { return this.a.compute(x, y, z) + this.b.compute(x, y, z); }
  // Sums need exact values (no pruning); funnel through the exact result so
  // the sign always agrees with compute() (NaN -> 0 = air, same as `d > 0`).
  sign(x, y, z) {
    const v = this.a.compute(x, y, z) + this.b.compute(x, y, z);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class Mul {
  constructor(a, b) { this.a = a; this.b = b; }
  compute(x, y, z) {
    const a = this.a.compute(x, y, z);
    return a === 0 ? 0 : a * this.b.compute(x, y, z);
  }
  sign(x, y, z) {
    const sa = this.a.sign(x, y, z);
    if (sa === 0) return 0;
    const sb = this.b.sign(x, y, z);
    return sb === 0 ? 0 : sa * sb;
  }
}

class Min {
  constructor(a, b) { this.a = a; this.b = b; }
  compute(x, y, z) { return Math.min(this.a.compute(x, y, z), this.b.compute(x, y, z)); }
  // THE pruning workhorse: a negative left side decides the sign alone, so
  // whole subtrees (caves/rivers/noodles above terrain) are skipped. Exact:
  // min(a,b)<0 iff a<0 or b<0; =0 iff (a=0 or b=0) with neither negative.
  sign(x, y, z) {
    const sa = this.a.sign(x, y, z);
    if (sa < 0) return -1;
    const sb = this.b.sign(x, y, z);
    if (sb < 0) return -1;
    return (sa === 0 || sb === 0) ? 0 : 1;
  }
}

class Max {
  constructor(a, b) { this.a = a; this.b = b; }
  compute(x, y, z) { return Math.max(this.a.compute(x, y, z), this.b.compute(x, y, z)); }
  // Mirror of Min: a positive left side decides the sign alone.
  sign(x, y, z) {
    const sa = this.a.sign(x, y, z);
    if (sa > 0) return 1;
    const sb = this.b.sign(x, y, z);
    if (sb > 0) return 1;
    return (sa === 0 || sb === 0) ? 0 : -1;
  }
}

class Abs {
  constructor(a) { this.a = a; }
  compute(x, y, z) { return Math.abs(this.a.compute(x, y, z)); }
  sign(x, y, z) { return this.a.sign(x, y, z) === 0 ? 0 : 1; }
}

class Square {
  constructor(a) { this.a = a; }
  compute(x, y, z) { const d = this.a.compute(x, y, z); return d * d; }
  sign(x, y, z) { return this.a.sign(x, y, z) === 0 ? 0 : 1; }
}

class Cube {
  constructor(a) { this.a = a; }
  compute(x, y, z) { const d = this.a.compute(x, y, z); return d * d * d; }
  sign(x, y, z) { return this.a.sign(x, y, z); } // sign-preserving
}

class QuarterNegative {
  constructor(a) { this.a = a; }
  compute(x, y, z) { const d = this.a.compute(x, y, z); return d > 0 ? d : d * 0.25; }
  sign(x, y, z) { return this.a.sign(x, y, z); } // sign-preserving
}

class Squeeze {
  constructor(a) { this.a = a; }
  compute(x, y, z) {
    const c = clamp(this.a.compute(x, y, z), -1, 1);
    return c / 2 - (c * c * c) / 24;
  }
  // c/2-c^3/24 is strictly increasing on [-1,1] with its only zero at 0.
  sign(x, y, z) { return this.a.sign(x, y, z); }
}

class Clamp {
  constructor(input, min, max) { this.input = input; this.min = min; this.max = max; }
  compute(x, y, z) { return clamp(this.input.compute(x, y, z), this.min, this.max); }
  sign(x, y, z) {
    const sv = this.input.sign(x, y, z);
    if (sv < 0) return this.min > 0 ? 1 : this.min === 0 ? 0 : -1;
    if (sv === 0) return this.min > 0 ? 1 : this.max < 0 ? -1 : 0;
    return this.max < 0 ? -1 : this.max === 0 ? 0 : 1;
  }
}

class RangeChoice {
  constructor(input, minIn, maxEx, inR, outR) {
    this.input = input; this.minIn = minIn; this.maxEx = maxEx;
    this.inR = inR; this.outR = outR;
    this.inputIsY = (input === Y_NODE); // y-range gates need no subtree eval
  }
  compute(x, y, z) {
    const v = this.inputIsY ? y : this.input.compute(x, y, z);
    return (this.minIn <= v && v < this.maxEx)
      ? this.inR.compute(x, y, z)
      : this.outR.compute(x, y, z);
  }
  sign(x, y, z) {
    const v = this.inputIsY ? y : this.input.compute(x, y, z);
    return (this.minIn <= v && v < this.maxEx)
      ? this.inR.sign(x, y, z)
      : this.outR.sign(x, y, z);
  }
}

class YClampedGradient {
  constructor(fromY, toY, fromV, toV) {
    this.fromY = fromY; this.toY = toY; this.fromV = fromV; this.toV = toV;
  }
  compute(x, y, z) {
    return clampedMap(y, this.fromY, this.toY, this.fromV, this.toV);
  }
  sign(x, y, z) {
    const v = clampedMap(y, this.fromY, this.toY, this.fromV, this.toV);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class NoiseFn {
  constructor(xzScale, yScale, noise) {
    this.xz = xzScale; this.ys = yScale; this.noise = noise;
  }
  compute(x, y, z) {
    return this.noise.sample(x * this.xz, y * this.ys, z * this.xz);
  }
  // Noise has no cheaper sign than its value.
  sign(x, y, z) {
    const v = this.noise.sample(x * this.xz, y * this.ys, z * this.xz);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class ShiftedNoise {
  constructor(sx, sy, sz, xzScale, yScale, noise) {
    this.sx = sx; this.sy = sy; this.sz = sz;
    this.xz = xzScale; this.ys = yScale; this.noise = noise;
  }
  compute(x, y, z) {
    const xx = x * this.xz + this.sx.compute(x, y, z);
    const yy = y * this.ys + this.sy.compute(x, y, z);
    const zz = z * this.xz + this.sz.compute(x, y, z);
    return this.noise.sample(xx, yy, zz);
  }
  // Shifts feed sample coordinates, so they need exact values; only the
  // final sample funnels to a sign.
  sign(x, y, z) {
    const xx = x * this.xz + this.sx.compute(x, y, z);
    const yy = y * this.ys + this.sy.compute(x, y, z);
    const zz = z * this.xz + this.sz.compute(x, y, z);
    const v = this.noise.sample(xx, yy, zz);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

// ShiftA/B sample a noise at quarter XZ resolution on the y=0 plane,
// scaled by 4 (vanilla DensityFunctions.shiftA/shiftB).
class ShiftA {
  constructor(noise) { this.noise = noise; }
  compute(x, y, z) { return this.noise.sample(x * 0.25, 0, z * 0.25) * 4; }
  sign(x, y, z) {
    const v = this.noise.sample(x * 0.25, 0, z * 0.25) * 4;
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class ShiftB {
  constructor(noise) { this.noise = noise; }
  compute(x, y, z) { return this.noise.sample(z * 0.25, x * 0.25, 0) * 4; }
  sign(x, y, z) {
    const v = this.noise.sample(z * 0.25, x * 0.25, 0) * 4;
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

const RARITY_1 = (v) => (v < -0.5 ? 0.75 : v < 0 ? 1 : v < 0.5 ? 1.5 : 2);
const RARITY_2 = (v) => (v < -0.75 ? 0.5 : v < -0.5 ? 0.75 : v < 0.5 ? 1 : v < 0.75 ? 2 : 3);

class WeirdScaledSampler {
  constructor(input, mapper, noise) {
    this.input = input; this.mapper = mapper; this.noise = noise;
  }
  compute(x, y, z) {
    const rarity = this.mapper(this.input.compute(x, y, z));
    return rarity * Math.abs(this.noise.sample(x / rarity, y / rarity, z / rarity));
  }
  // Rarity needs the exact input value and the result needs the sample, so
  // no pruning here — but the result is always >= 0, and it is 0 only when
  // the sample is exactly 0 (rarity is never 0).
  sign(x, y, z) {
    const rarity = this.mapper(this.input.compute(x, y, z));
    const v = this.noise.sample(x / rarity, y / rarity, z / rarity);
    return v === 0 ? 0 : 1;
  }
}

class OldBlendedNoise {
  constructor(blended) { this.blended = blended; }
  compute(x, y, z) { return this.blended.sample(x, y, z); }
  sign(x, y, z) {
    const v = this.blended.sample(x, y, z);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class BlendDensity {
  constructor(input) { this.input = input; }
  compute(x, y, z) { return this.input.compute(x, y, z); } // no old chunks: passthrough
  sign(x, y, z) { return this.input.sign(x, y, z); }
}

class FlatCache {
  constructor(wrapped) {
    this.w = wrapped; this.qx = NaN; this.qz = NaN; this.v = 0;
    this.sqx = NaN; this.sqz = NaN; this.sv = 0; // sign slot (same key rule)
  }
  compute(x, y, z) {
    const qx = x >> 2, qz = z >> 2;
    if (qx !== this.qx || qz !== this.qz) {
      this.v = this.w.compute(qx << 2, 0, qz << 2);
      this.qx = qx; this.qz = qz;
    }
    return this.v;
  }
  sign(x, y, z) {
    const qx = x >> 2, qz = z >> 2;
    if (qx !== this.sqx || qz !== this.sqz) {
      this.sv = this.w.sign(qx << 2, 0, qz << 2);
      this.sqx = qx; this.sqz = qz;
    }
    return this.sv;
  }
}

class Cache2D {
  constructor(wrapped) {
    this.w = wrapped; this.bx = NaN; this.bz = NaN; this.v = 0;
    this.sbx = NaN; this.sbz = NaN; this.sv = 0; // sign slot (same key rule)
  }
  compute(x, y, z) {
    if (x !== this.bx || z !== this.bz) {
      this.v = this.w.compute(x, y, z);
      this.bx = x; this.bz = z;
    }
    return this.v;
  }
  sign(x, y, z) {
    if (x !== this.sbx || z !== this.sbz) {
      this.sv = this.w.sign(x, y, z);
      this.sbx = x; this.sbz = z;
    }
    return this.sv;
  }
}

class CacheOnce {
  constructor(wrapped) {
    this.w = wrapped; this.bx = NaN; this.by = NaN; this.bz = NaN; this.v = 0;
    this.sbx = NaN; this.sby = NaN; this.sbz = NaN; this.sv = 0;
  }
  compute(x, y, z) {
    if (x !== this.bx || y !== this.by || z !== this.bz) {
      this.v = this.w.compute(x, y, z);
      this.bx = x; this.by = y; this.bz = z;
    }
    return this.v;
  }
  sign(x, y, z) {
    if (x !== this.sbx || y !== this.sby || z !== this.sbz) {
      this.sv = this.w.sign(x, y, z);
      this.sbx = x; this.sby = y; this.sbz = z;
    }
    return this.sv;
  }
}

class Interpolated {
  constructor(wrapped, cellWidth, cellHeight) {
    this.w = wrapped; this.cw = cellWidth; this.ch = cellHeight;
    this.values = new Map();
    this.count = 0; // total corner entries (values is 3-level nested now)
  }
  clear() { this.values.clear(); this.count = 0; }
  // 3-level nested int/float maps instead of one string-keyed map: same
  // entries and same values, but no per-lookup string allocation. Raw
  // coords are the keys (exact for any numbers — no packing bounds to get
  // wrong), and the runaway guard counts entries just like .size did.
  corner(x, y, z) {
    let mx = this.values.get(x);
    if (mx === undefined) { mx = new Map(); this.values.set(x, mx); }
    let my = mx.get(y);
    if (my === undefined) { my = new Map(); mx.set(y, my); }
    let v = my.get(z);
    if (v === undefined) {
      v = this.w.compute(x, y, z);
      if (this.count > 65536) {
        this.values.clear(); this.count = 0;
        mx = new Map(); this.values.set(x, mx);
        my = new Map(); mx.set(y, my);
      }
      my.set(z, v);
      this.count++;
    }
    return v;
  }
  // Sign via the exact value: corners are Map-cached, so repeat samples are
  // nearly free, and writing a separate pruning lerp would risk divergence
  // from compute() for zero gain.
  sign(bx, by, bz) {
    const v = this.compute(bx, by, bz);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
  compute(bx, by, bz) {
    // Trilinear over the enclosing cell, fetching only corners with nonzero
    // weight (no closure/thunk allocation — the hot path; the coarse height
    // scan lands exactly on cell corners, and cell-corner values are shared
    // across columns via corner()). Bit-identical to the lazyLerp3 form:
    // FP nesting is z-outermost, then y, then x, with lerp(a,b,c) =
    // b+a*(c-b) — including in the partial-fraction fast paths (reordering
    // the lerp tree changes last-ulp rounding, so every branch keeps the
    // z(y(x)) association).
    const w = this.cw, h = this.ch;
    const fx = Math.floor(bx / w) * w;
    const fy = Math.floor(by / h) * h;
    const fz = Math.floor(bz / w) * w;
    const x = (bx - fx) / w, y = (by - fy) / h, z = (bz - fz) / w;
    if (x === 0) {
      if (y === 0) {
        if (z === 0) return this.corner(fx, fy, fz);
        const c0 = this.corner(fx, fy, fz), c1 = this.corner(fx, fy, fz + w);
        return c0 + z * (c1 - c0);
      }
      if (z === 0) {
        const c0 = this.corner(fx, fy, fz), c1 = this.corner(fx, fy + h, fz);
        return c0 + y * (c1 - c0);
      }
      const y0 = this.corner(fx, fy, fz) + y * (this.corner(fx, fy + h, fz) - this.corner(fx, fy, fz));
      const y1 = this.corner(fx, fy, fz + w) + y * (this.corner(fx, fy + h, fz + w) - this.corner(fx, fy, fz + w));
      return y0 + z * (y1 - y0);
    }
    if (y === 0) {
      if (z === 0) {
        const c0 = this.corner(fx, fy, fz), c1 = this.corner(fx + w, fy, fz);
        return c0 + x * (c1 - c0);
      }
      const x0 = this.corner(fx, fy, fz) + x * (this.corner(fx + w, fy, fz) - this.corner(fx, fy, fz));
      const x1 = this.corner(fx, fy, fz + w) + x * (this.corner(fx + w, fy, fz + w) - this.corner(fx, fy, fz + w));
      return x0 + z * (x1 - x0);
    }
    if (z === 0) {
      const x0 = this.corner(fx, fy, fz) + x * (this.corner(fx + w, fy, fz) - this.corner(fx, fy, fz));
      const x1 = this.corner(fx, fy + h, fz) + x * (this.corner(fx + w, fy + h, fz) - this.corner(fx, fy + h, fz));
      return x0 + y * (x1 - x0);
    }
    const c000 = this.corner(fx, fy, fz), c100 = this.corner(fx + w, fy, fz);
    const c010 = this.corner(fx, fy + h, fz), c110 = this.corner(fx + w, fy + h, fz);
    const c001 = this.corner(fx, fy, fz + w), c101 = this.corner(fx + w, fy, fz + w);
    const c011 = this.corner(fx, fy + h, fz + w), c111 = this.corner(fx + w, fy + h, fz + w);
    const x00 = c000 + x * (c100 - c000), x10 = c010 + x * (c110 - c010);
    const x01 = c001 + x * (c101 - c001), x11 = c011 + x * (c111 - c011);
    const y0 = x00 + y * (x10 - x00), y1 = x01 + y * (x11 - x01);
    return y0 + z * (y1 - y0);
  }
}

// ------------------------------------------------------------- cubic spline (vanilla float32 math)

class SplineConstant {
  constructor(v) { this.v = v; this.s = v > 0 ? 1 : v < 0 ? -1 : 0; }
  compute() { return this.v; }
  sign() { return this.s; }
}

class SplineMulti {
  constructor(coordinate) {
    this.coordinate = coordinate;
    this.locations = []; this.values = []; this.derivatives = [];
  }
  addPoint(location, value, derivative) {
    this.locations.push(Math.fround(location));
    this.values.push(typeof value === "number" ? new SplineConstant(Math.fround(value)) : value);
    this.derivatives.push(Math.fround(derivative));
  }
  // Inline lower-bound (was binarySearch with a per-call closure predicate).
  lowerBound(coordinate) {
    const locs = this.locations;
    let lo = 0, hi = locs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (coordinate < locs[m]) hi = m;
      else lo = m + 1;
    }
    return lo - 1;
  }
  compute(x, y, z) {
    const coordinate = this.coordinate.compute(x, y, z);
    const i = this.lowerBound(coordinate);
    const n = this.locations.length - 1;
    if (i < 0) {
      return Math.fround(this.values[0].compute(x, y, z) +
        Math.fround(this.derivatives[0] * Math.fround(coordinate - this.locations[0])));
    }
    if (i === n) {
      return Math.fround(this.values[n].compute(x, y, z) +
        Math.fround(this.derivatives[n] * Math.fround(coordinate - this.locations[n])));
    }
    const loc0 = this.locations[i], loc1 = this.locations[i + 1];
    const der0 = this.derivatives[i], der1 = this.derivatives[i + 1];
    const f = Math.fround(Math.fround(coordinate - loc0) / Math.fround(loc1 - loc0));
    const val0 = this.values[i].compute(x, y, z), val1 = this.values[i + 1].compute(x, y, z);
    const f8 = Math.fround(Math.fround(der0 * Math.fround(loc1 - loc0)) - Math.fround(val1 - val0));
    const f9 = Math.fround(Math.fround(-der1 * Math.fround(loc1 - loc0)) + Math.fround(val1 - val0));
    return Math.fround(floatLerp(f, val0, val1) +
      Math.fround(Math.fround(f * Math.fround(1.0 - f)) * floatLerp(f, f8, f9)));
  }
  // Spline values need exact evaluation (nested-spline segments flip sign
  // within a single span), so the sign funnels through the exact result.
  sign(x, y, z) {
    const v = this.compute(x, y, z);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  }
}

class SplineFn {
  constructor(spline) { this.spline = spline; }
  compute(x, y, z) {
    // Numeric args throughout (no {x,y,z} object allocation on the hot
    // path). Density parents always pass numbers; the object branch is kept
    // only as a defensive fallback for direct external callers.
    if (x !== null && typeof x === "object") return this.spline.compute(x.x, x.y, x.z);
    return this.spline.compute(x, y, z);
  }
  sign(x, y, z) {
    if (x !== null && typeof x === "object") return this.spline.sign(x.x, x.y, x.z);
    return this.spline.sign(x, y, z);
  }
}

function buildSpline(obj, build) {
  const coord = build(obj.coordinate);
  const sp = new SplineMulti(coord);
  const points = Array.isArray(obj.points) ? obj.points : [];
  if (points.length === 0) return new Constant(0);
  for (const p of points) {
    sp.addPoint(
      typeof p.location === "number" ? p.location : 0,
      buildSplineValue(p.value, build),
      typeof p.derivative === "number" ? p.derivative : 0);
  }
  return new SplineFn(sp);
}

function buildSplineValue(v, build) {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && !v.type && (v.coordinate || v.points)) {
    // nested spline object (no "type" wrapper in this bundle)
    return buildSpline(v, build);
  }
  return build(v);
}

// ------------------------------------------------------------- graph builder

const SHIFT_X = "minecraft:shift_x";
const SHIFT_Z = "minecraft:shift_z";
const Y_NODE = new YCoord(); // vanilla "minecraft:y" (used by Tectonic source)

export function buildDensityGraph(functions, noises, seedU32, opts) {
  opts = opts || {};
  const cellWidth = opts.cellWidth || 4;
  const cellHeight = opts.cellHeight || 8;
  const random = XoroshiroRandom.create(BigInt(seedU32 >>> 0)).forkPositional();

  // One NormalNoise per noise id (order-independent: positional seeding).
  const noiseCache = new Map();
  function noiseFor(id) {
    let n = noiseCache.get(id);
    if (n === undefined) {
      const params = noises[id];
      if (!params) throw new Error("[tectonic] unknown noise: " + id);
      n = new NormalNoise(random.fromHashOf(id), params);
      noiseCache.set(id, n);
    }
    return n;
  }

  const memo = new Map(); // function id -> node (shared like vanilla's mapped map)
  const interpolatedNodes = [];

  function build(v) {
    if (typeof v === "number") return new Constant(v);
    if (typeof v === "string") {
      if (v === SHIFT_X || v === SHIFT_Z) return buildShift(v);
      if (v === "minecraft:y") return Y_NODE;
      if (memo.has(v)) return memo.get(v);
      const def = functions[v];
      if (!def) throw new Error("[tectonic] unknown function: " + v);
      const node = buildObj(def);
      memo.set(v, node);
      return node;
    }
    return buildObj(v);
  }

  // Vanilla shift_x/shift_z (all versions): flat_cache(cache_2d(shift of offset)).
  function buildShift(id) {
    if (memo.has(id)) return memo.get(id);
    const node = new FlatCache(new Cache2D(
      id === SHIFT_X ? new ShiftA(noiseFor("minecraft:offset")) : new ShiftB(noiseFor("minecraft:offset"))));
    memo.set(id, node);
    return node;
  }

  function noiseParam(obj, key, dflt) {
    const v = obj && typeof obj[key] === "number" ? obj[key] : dflt;
    return v;
  }

  function buildObj(root) {
    if (!root || typeof root !== "object") throw new Error("[tectonic] bad node: " + JSON.stringify(root));
    const type = typeof root.type === "string" ? root.type.replace(/^minecraft:/, "") : null;
    switch (type) {
      case "constant": return new Constant(noiseParam(root, "argument", 0));
      case "add": return new Add(build(root.argument1), build(root.argument2));
      case "mul": return new Mul(build(root.argument1), build(root.argument2));
      case "min": return new Min(build(root.argument1), build(root.argument2));
      case "max": return new Max(build(root.argument1), build(root.argument2));
      case "abs": return new Abs(build(root.argument));
      case "square": return new Square(build(root.argument));
      case "cube": return new Cube(build(root.argument));
      case "quarter_negative": return new QuarterNegative(build(root.argument));
      case "squeeze": return new Squeeze(build(root.argument));
      case "clamp":
        return new Clamp(build(root.input), noiseParam(root, "min", 0), noiseParam(root, "max", 1));
      case "range_choice":
        return new RangeChoice(build(root.input),
          noiseParam(root, "min_inclusive", 0), noiseParam(root, "max_exclusive", 1),
          build(root.when_in_range), build(root.when_out_of_range));
      case "y_clamped_gradient":
        return new YClampedGradient(
          root.from_y | 0, root.to_y | 0,
          typeof root.from_value === "number" ? root.from_value : 0,
          typeof root.to_value === "number" ? root.to_value : 0);
      case "noise":
        return new NoiseFn(noiseParam(root, "xz_scale", 1), noiseParam(root, "y_scale", 1), noiseFor(root.noise));
      case "shifted_noise":
        return new ShiftedNoise(
          build(root.shift_x), build(root.shift_y), build(root.shift_z),
          noiseParam(root, "xz_scale", 1), noiseParam(root, "y_scale", 1), noiseFor(root.noise));
      case "weird_scaled_sampler": {
        const m = root.rarity_value_mapper === "type_2" ? RARITY_2 : RARITY_1;
        return new WeirdScaledSampler(build(root.input), m, noiseFor(root.noise));
      }
      case "old_blended_noise":
        return new OldBlendedNoise(new BlendedNoise(
          random.fromHashOf("minecraft:terrain"),
          noiseParam(root, "xz_scale", 1), noiseParam(root, "y_scale", 1),
          noiseParam(root, "xz_factor", 80), noiseParam(root, "y_factor", 160),
          noiseParam(root, "smear_scale_multiplier", 8)));
      case "blend_alpha": return new Constant(1);
      case "blend_offset": return new Constant(0);
      case "blend_density": return new BlendDensity(build(root.argument));
      case "flat_cache": return new FlatCache(build(root.argument));
      case "cache_2d": return new Cache2D(build(root.argument));
      case "cache_once": return new CacheOnce(build(root.argument));
      case "interpolated": {
        const n = new Interpolated(build(root.argument), cellWidth, cellHeight);
        interpolatedNodes.push(n);
        return n;
      }
      case "spline": return buildSpline(root.spline, build);
      // Vanilla compat (not present in this bundle, but harmless to support):
      case "shift_a": return new ShiftA(noiseFor(typeof root.argument === "string" ? root.argument : root.noise));
      case "shift_b": return new ShiftB(noiseFor(typeof root.argument === "string" ? root.argument : root.noise));
      case "shift": return new ShiftA(noiseFor(typeof root.argument === "string" ? root.argument : root.noise));
      case "cache": return new CacheOnce(build(root.input || root.argument));
      default:
        throw new Error("[tectonic] unsupported density type: " + (root.type || "(none)"));
    }
  }

  function get(id) { return build(id); }
  function clearCaches() {
    for (const n of interpolatedNodes) n.clear();
  }
  return { get, clearCaches };
}
