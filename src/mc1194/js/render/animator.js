// OptiFine/MCPatcher custom animations (Animatica analogue).
//
// Vanilla .mcmeta animation covers block and item textures (Atlas) — already
// animated every game tick. OptiFine fills the remaining gap: ANY rectangular
// area of any NON-block/item texture (GUI, entity/mob skins, armor, skies,
// ...), driven by `assets/minecraft/optifine/anim/**/*.properties` files in
// resource packs (doc: OptiFineDoc/doc/custom_animations.txt):
//
//   from=<animation strip PNG>   vertical filmstrip, width == w
//   to=<texture to animate>      e.g. textures/gui/widgets.png
//   x=<px> y=<px> w=<px> h=<px>  rect inside the target (multiples of 16 best)
//   duration=<ticks>             default frame duration (default 1)
//   interpolate=<true|false>     blend between frames (default false)
//   skip=<ticks>                 hold unblended this many ticks, then blend
//   tile.X=Y  duration.X=Z       display order / per-frame time (tiles 0-based)
//
// A part whose target lives in the terrain atlas is skipped (block/item
// textures must use Mojang's .mcmeta method instead — same rule as OptiFine).
// Multiple non-overlapping parts may share one target; overlapping parts are
// skipped. Tick timing is game ticks (20Hz), same site as Atlas.tick.
import { decodePng } from '../util/png.js';
import { decodeUtf8 } from '../util/utf8.js';

// Strip pack prefixes so `assets/minecraft/textures/...`, `./textures/...`
// and `~/textures/...` all resolve to the same `textures/...` asset path.
function normPath(p) {
  p = String(p || '').trim().replace(/^(assets\/minecraft\/)+/, '');
  p = p.replace(/^(\.\/|~\/|\/)+/, '');
  return p;
}

function intOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

export class Animator {
  constructor(assets) {
    this.assets = assets;
    this.parts = [];          // [{ target, x, y, w, h, frames, interpolate, skipN, frame, ticks, strip, blend }]
    this.targets = new Map(); // targetRel -> { rel, w, h, base, work, parts }
  }

  // properties-file parser, exposed for testing (last occurrence wins).
  static parseProps(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  }

  // Re-scan packs (low priority first so higher packs override by file path).
  async rebuild() {
    this.parts = [];
    this.targets = new Map();
    const A = this.assets;
    const packsLowFirst = [...A.packs].reverse();
    const files = new Map(); // rel -> pack
    for (const pack of packsLowFirst) {
      let names = null;
      try { names = pack.list('optifine/anim/'); } catch (e) { continue; }
      if (!names) continue;
      for (const n of names) if (n.endsWith('.properties')) files.set(n, pack);
    }
    if (!files.size) return;
    for (const [rel, pack] of files) {
      try {
        await this._addFile(rel, pack);
      } catch (e) { console.warn('[animator] skipping ' + rel + ': ' + (e && e.message || e)); }
    }
    if (this.parts.length) console.log('[animator] ' + this.parts.length + ' part(s) on ' + this.targets.size + ' texture(s)');
  }

  async _addFile(rel, pack) {
    const raw = pack.read(rel);
    if (!raw) return;
    const props = Animator.parseProps(decodeUtf8(raw));
    const fail = (m) => { console.warn('[animator] ' + rel + ': ' + m + ' — skipped'); };
    const from = normPath(props.from), to = normPath(props.to);
    const x = intOr(props.x, -1), y = intOr(props.y, -1);
    const w = intOr(props.w, 0), h = intOr(props.h, 0);
    if (!from.endsWith('.png') || !props.to) { fail('bad from/to'); return; }
    if (x < 0 || y < 0 || w < 1 || h < 1) { fail('bad x/y/w/h'); return; }
    if (!to.startsWith('textures/') || !to.endsWith('.png')) { fail('to must be a textures/*.png path'); return; }
    const A = this.assets;
    const stripBytes = await A.readBytes(from);
    if (!stripBytes) { fail('missing ' + from); return; }
    let strip = null;
    try { strip = decodePng(stripBytes); } catch (e) { fail('undecodable ' + from); return; }
    if (strip.width !== w) { fail('strip width ' + strip.width + ' != w ' + w); return; }
    const tiles = Math.floor(strip.height / h);
    if (tiles < 1) { fail('strip too short for h ' + h); return; }
    // Display order: tile.X=Y (+duration.X=Z), else the identity run.
    const order = [], durs = {};
    for (const k of Object.keys(props)) {
      let m = /^tile\.(\d+)$/.exec(k);
      if (m) order.push([+m[1], intOr(props[k], -1)]);
      else { m = /^duration\.(\d+)$/.exec(k); if (m) durs[+m[1]] = Math.max(1, intOr(props[k], 1)); }
    }
    const defaultDur = Math.max(1, intOr(props.duration, 1));
    let frames = null;
    if (order.length) {
      order.sort((a, b) => a[0] - b[0]);
      frames = [];
      for (const [idx, tile] of order) {
        if (tile < 0 || tile >= tiles) { fail('tile.' + idx + '=' + tile + ' out of range (0..' + (tiles - 1) + ')'); return; }
        frames.push({ tile, time: durs[idx] != null ? durs[idx] : defaultDur });
      }
    } else {
      frames = [];
      for (let i = 0; i < tiles; i++) frames.push({ tile: i, time: defaultDur });
    }
    const targetBytes = await A.readBytes(to);
    if (!targetBytes) { fail('missing ' + to); return; }
    let target = null;
    try { target = decodePng(targetBytes); } catch (e) { fail('undecodable ' + to); return; }
    this._addPart({ to, x, y, w, h, frames, interpolate: /^\s*true\s*$/i.test(props.interpolate || ''), skipN: Math.max(0, intOr(props.skip, 0)) }, strip, target, rel);
  }

  // Register one validated part (exposed for testing with synthetic images).
  // Returns the part, or null when skipped (reason warned).
  _addPart(def, strip, target, rel) {
    const fail = (m) => { console.warn('[animator] ' + (rel || def.to) + ': ' + m + ' — skipped'); return null; };
    const name = def.to.startsWith('textures/') && def.to.endsWith('.png') ? def.to.slice('textures/'.length, -'.png'.length) : null;
    if (!name) return fail('to must be a textures/*.png path');
    if (this.assets.atlas && this.assets.atlas.has(name)) return fail(def.to + ' is a block/item texture (use .mcmeta)');
    if (def.x + def.w > target.width || def.y + def.h > target.height) return fail('rect outside ' + target.width + 'x' + target.height);
    let t = this.targets.get(def.to);
    if (!t) {
      t = { rel: def.to, w: target.width, h: target.height, base: target.data, work: new Uint8Array(target.data.length), parts: [] };
      t.work.set(target.data);
      this.targets.set(def.to, t);
    }
    for (const p of t.parts) {
      if (def.x < p.x + p.w && p.x < def.x + def.w && def.y < p.y + p.h && p.y < def.y + def.h) return fail('overlaps another part of ' + def.to);
    }
    const part = { target: t, x: def.x, y: def.y, w: def.w, h: def.h, frames: def.frames, interpolate: !!def.interpolate, skipN: def.skipN || 0, frame: 0, ticks: 0, strip, blend: null };
    t.parts.push(part);
    this.parts.push(part);
    return part;
  }

  // Advance one game tick. Returns changed targets for upload:
  // [{ rel, data (full target RGBA), w, h }].
  tick() {
    const dirty = new Set();
    for (const p of this.parts) {
      p.ticks++;
      let advanced = false;
      if (p.ticks >= p.frames[p.frame].time) {
        p.ticks = 0;
        p.frame = (p.frame + 1) % p.frames.length;
        advanced = true;
      }
      const cur = p.frames[p.frame];
      if (!advanced && !(p.interpolate && p.ticks > p.skipN && (cur.time - p.skipN) > 0)) continue;
      dirty.add(p.target);
    }
    const out = [];
    for (const t of dirty) {
      t.work.set(t.base);
      for (const p of t.parts) this._render(p, t.work);
      out.push({ rel: t.rel, data: t.work, w: t.w, h: t.h });
    }
    return out;
  }

  // Compose one part's current frame into the target work buffer.
  _render(p, work) {
    const W = p.target.w;
    const src = p.strip.data, sRow = p.w * 4;
    const f = p.frames[p.frame];
    const tilePx = p.w * p.h * 4;
    let px = null;
    if (p.interpolate && p.ticks > p.skipN && (f.time - p.skipN) > 0) {
      const next = p.frames[(p.frame + 1) % p.frames.length];
      const mix = (p.ticks - p.skipN) / (f.time - p.skipN), inv = 1 - mix;
      const a0 = f.tile * tilePx, b0 = next.tile * tilePx;
      px = p.blend || (p.blend = new Uint8Array(tilePx));
      for (let i = 0, n = tilePx; i < n; i++) px[i] = src[a0 + i] * inv + src[b0 + i] * mix;
    } else {
      const o = f.tile * tilePx;
      px = src.subarray(o, o + tilePx);
    }
    for (let yy = 0; yy < p.h; yy++) work.set(px.subarray(yy * sRow, yy * sRow + sRow), ((p.y + yy) * W + p.x) * 4);
  }
}
