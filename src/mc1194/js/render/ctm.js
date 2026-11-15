// OptiFine connected textures, method=ctm + method=horizontal
// (Continuity analogue — scope: the two connection methods in Continuity's
// default pack: glass/panes + bookshelves. emissive textures, custom block
// layers, and the other methods (ctm_compact, vertical, top, random, repeat,
// overlay) are NOT implemented).
//
// Format (OptiFine/MCPatcher): resource-pack files under
//   assets/<ns>/{optifine,mcpatcher}/ctm/**/*.properties
// with tiles resolved relative to the .properties directory:
//   method=ctm|horizontal   (others: skipped with a warning)
//   matchBlocks=a b ...     (plain block names; state syntax: skipped)
//   matchTiles=...           (not supported: rule skipped, fail-closed)
//   biomes=.../heights=...  (not supported: rule skipped, fail-closed)
//   tiles=0-46 | paths...   (ranges expand to <dir>/<n>.png; ./, ~/, / prefixes
//                           per OptiFine; <skip>/<default> keep the baked tile)
//   faces=all|sides|top...  (absent = all)
//   connect=block|state      (absent + matchBlocks = block; tile/material: skip)
//   innerSeams=true|false
// Higher-priority packs override by file path; first matching rule wins.
//
// Meshing: CTM tiles are packed into the terrain atlas as ctm/<rule>/<tile>
// and selected per face in the mesh worker from the 8 neighbours in the face
// plane (Continuity's SPRITE_INDEX_MAP + DirectionMaps orientation, derived
// here from vanilla EnumFaceDirection tables — verified against Continuity's
// maps entry-for-entry). The quad's baked UVs are remapped from its own
// sprite rect to the CTM tile rect (exact sprite swap for full-tile quads).
import { decodePng } from '../util/png.js';
import { decodeUtf8 } from '../util/utf8.js';
import { blocks, states, getBlock } from '../world/blocks.js';

// Bit layout (Continuity CTMSpriteProvider):
//   128 64  32
//   1   *   16
//   2   4   8
// edge[0]=left -> bit 0, edge[1]=down -> bit 2, edge[2]=right -> bit 4,
// edge[3]=up -> bit 6; diagonals (gated on both adjacent edges) fill odd bits.
export const SPRITE_INDEX_MAP = [
  0, 3, 0, 3, 12, 5, 12, 15, 0, 3, 0, 3, 12, 5, 12, 15,
  1, 2, 1, 2, 4, 7, 4, 29, 1, 2, 1, 2, 13, 31, 13, 14,
  0, 3, 0, 3, 12, 5, 12, 15, 0, 3, 0, 3, 12, 5, 12, 15,
  1, 2, 1, 2, 4, 7, 4, 29, 1, 2, 1, 2, 13, 31, 13, 14,
  36, 17, 36, 17, 24, 19, 24, 43, 36, 17, 36, 17, 24, 19, 24, 43,
  16, 18, 16, 18, 6, 46, 6, 21, 16, 18, 16, 18, 28, 9, 28, 22,
  36, 17, 36, 17, 24, 19, 24, 43, 36, 17, 36, 17, 24, 19, 24, 43,
  37, 40, 37, 40, 30, 8, 30, 34, 37, 40, 37, 40, 25, 23, 25, 45,
  0, 3, 0, 3, 12, 5, 12, 15, 0, 3, 0, 3, 12, 5, 12, 15,
  1, 2, 1, 2, 4, 7, 4, 29, 1, 2, 1, 2, 13, 31, 13, 14,
  0, 3, 0, 3, 12, 5, 12, 15, 0, 3, 0, 3, 12, 5, 12, 15,
  1, 2, 1, 2, 4, 7, 4, 29, 1, 2, 1, 2, 13, 31, 13, 14,
  36, 39, 36, 39, 24, 41, 24, 27, 36, 39, 36, 39, 24, 41, 24, 27,
  16, 42, 16, 42, 6, 20, 6, 10, 16, 42, 16, 42, 28, 35, 28, 44,
  36, 39, 36, 39, 24, 41, 24, 27, 36, 39, 36, 39, 24, 41, 24, 27,
  37, 38, 37, 38, 30, 11, 30, 32, 37, 38, 37, 38, 25, 33, 25, 26,
];

// method=horizontal: left -> bit 0, right -> bit 1 (Continuity).
export const H_SPRITE_INDEX_MAP = [3, 2, 0, 1];

// Face-plane [left, down, right, up] in world offsets per face dir
// (down/up/north/south/west/east). Derived from vanilla FaceBakery UV
// orientation (models.js FACE_CORNERS/defaultUV); entry-for-entry equal to
// Continuity's DirectionMaps map[0] (up faces use north-up, down faces
// south-up, sides up-up — verified against all six).
export const FACE_DIRS = [
  [[-1, 0, 0], [0, 0, -1], [1, 0, 0], [0, 0, 1]], // down
  [[-1, 0, 0], [0, 0, 1], [1, 0, 0], [0, 0, -1]], // up
  [[1, 0, 0], [0, -1, 0], [-1, 0, 0], [0, 1, 0]], // north
  [[-1, 0, 0], [0, -1, 0], [1, 0, 0], [0, 1, 0]], // south
  [[0, 0, -1], [0, -1, 0], [0, 0, 1], [0, 1, 0]], // west
  [[0, 0, 1], [0, -1, 0], [0, 0, -1], [0, 1, 0]], // east
];

const DIR_INDEX = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

// Face normal per dir (blocks.js DIR order).
const FACE_NORMAL = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

export function parseProps(text) {
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

function intOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// Expand a tiles element to {ns, path} list (Continuity BaseCTMProperties
// semantics). propsNs/propsDir locate the .properties file.
function expandTile(tileStr, propsNs, propsDir) {
  const range = tileStr.split('-');
  if (range.length === 2 && range[0] !== '' && range[1] !== '') {
    const a = intOr(range[0], -1), b = intOr(range[1], -2);
    if (a >= 0 && b >= a) {
      const out = [];
      for (let i = a; i <= b; i++) out.push({ ns: propsNs, path: propsDir + i + '.png' });
      return out;
    }
    return null; // invalid range
  }
  if (range.length !== 1) return null;
  let p = tileStr, ns = null;
  if (!p.endsWith('.png')) p += '.png';
  if (p.startsWith('./')) p = propsDir + p.slice(2);
  else if (p.startsWith('~/')) p = 'optifine/' + p.slice(2);
  else if (p.startsWith('/')) p = 'optifine/' + p.slice(1);
  else if (!p.startsWith('textures/') && !p.startsWith('optifine/')) p = propsDir + p;
  if (p.startsWith('optifine/') && ns === null) ns = propsNs;
  if (p.indexOf(':') >= 0) return null; // explicit namespaces: not supported
  return [{ ns, path: p }];
}

// Read one tile file: textures/* go through the pack-aware reader (pack
// overrides of vanilla textures work); optifine/* paths are looked up per
// namespace across packs, then vanilla (other namespaces never exist there).
async function readTileFile(packs, readBytes, ns, path) {
  if (path.startsWith('textures/')) return readBytes(path);
  const suffix = 'assets/' + ns + '/' + path;
  for (let i = 0; i < packs.length; i++) {
    const pack = packs[i];
    try {
      const full = pack.prefix + suffix;
      if (pack.zip.has(full)) return pack.zip.read(full);
    } catch (e) { /* next pack */ }
  }
  if (ns === 'minecraft') return readBytes(path);
  return null;
}

// Scan packs (highest priority first) for CTM .properties; first file wins.
function discoverFiles(packs) {
  const files = new Map();
  for (const pack of packs) {
    let names = null;
    try { names = pack.zip.list(pack.prefix + 'assets/'); } catch (e) { continue; }
    if (!names) continue;
    for (const n of names) {
      const rel = n.slice(pack.prefix.length);
      const m = /^assets\/([^/]+)\/(((?:optifine|mcpatcher)\/ctm\/.+)\.properties)$/.exec(rel);
      if (!m) continue;
      const key = m[1] + '/' + m[2];
      if (!files.has(key)) files.set(key, { pack, ns: m[1], rel: m[2] });
    }
  }
  return files;
}

// Full collection: discovery + parse + resolve + decode.
// blocksByName: engine registry (matchBlocks -> block ids).
// Returns { rules, tiles } where rules is worker-serializable and tiles is
// [{ name, image }] for the atlas build.
export async function collectCTMRules(packs, readBytes, blocksByName) {
  const rules = [], tiles = [];
  const files = discoverFiles(packs);
  if (!files.size) return { rules, tiles };
  let skippedMethods = 0;
  for (const [key, f] of files) {
    const fail = (m) => { console.warn('[ctm] ' + key + ': ' + m + ' — skipped'); };
    let props = null;
    try {
      const raw = f.pack.zip.read(f.pack.prefix + 'assets/' + f.ns + '/' + f.rel);
      if (!raw) { fail('unreadable'); continue; }
      props = parseProps(decodeUtf8(raw));
    } catch (e) { fail('bad properties'); continue; }
    const method = (props.method || '').trim().toLowerCase();
    if (method !== 'ctm' && method !== 'horizontal') { skippedMethods++; continue; }
    if (props.matchTiles || props.biomes || props.heights) { fail('matchTiles/biomes/heights not supported'); continue; }
    // matchBlocks: plain names only (no block-state syntax).
    const tokens = (props.matchBlocks || '').trim().split(/[\s,]+/).filter(Boolean);
    if (!tokens.length) {
      // Continuity falls back to block_<name>.properties filenames.
      const base = f.rel.slice(f.rel.lastIndexOf('/') + 1);
      if (base.startsWith('block_') && base.endsWith('.properties')) tokens.push(base.slice(6, -'.properties'.length));
    }
    if (!tokens.length) { fail('no matchBlocks'); continue; }
    const blockIds = [];
    let bad = false;
    for (let tok of tokens) {
      tok = tok.replace(/^minecraft:/, '');
      if (/[:\[]/.test(tok) || !blocksByName[tok]) { fail('unsupported matchBlocks token ' + tok); bad = true; break; }
      if (!blockIds.includes(blocksByName[tok].id)) blockIds.push(blocksByName[tok].id);
    }
    if (bad || !blockIds.length) continue;
    const connect = (props.connect || '').trim().toLowerCase();
    const connectState = connect === 'state';
    if (connect !== '' && connect !== 'block' && !connectState) { fail('connect=' + connect + ' not supported'); continue; }
    // faces
    let faces = null;
    if (props.faces !== undefined) {
      const set = new Set();
      for (const tok of props.faces.trim().split(/[\s,]+/).filter(Boolean)) {
        const t = tok.toLowerCase();
        if (t === 'all') { set.clear(); break; }
        else if (t === 'sides') { set.add(2); set.add(3); set.add(4); set.add(5); }
        else if (t === 'bottom') set.add(0);
        else if (t === 'top') set.add(1);
        else if (t in DIR_INDEX) set.add(DIR_INDEX[t]);
        else { fail('unknown faces element ' + tok); bad = true; break; }
      }
      if (bad) continue;
      faces = set.size === 6 ? null : (set.size ? [...set] : null);
      if (!faces) { fail('empty faces'); continue; }
    }
    // tiles
    const tileStrs = (props.tiles || '').trim().split(/[\s,]+/).filter(Boolean);
    if (!tileStrs.length) { fail('no tiles'); continue; }
    const propsDir = f.rel.slice(0, f.rel.lastIndexOf('/') + 1);
    const tileRefs = [];
    for (const ts of tileStrs) {
      if (/<skip>(\.png)?$/.test(ts) || /<default>(\.png)?$/.test(ts)) { tileRefs.push(null); continue; }
      const exp = expandTile(ts, f.ns, propsDir);
      if (!exp) { fail('bad tiles element ' + ts); bad = true; break; }
      for (const r of exp) tileRefs.push(r);
    }
    if (bad) continue;
    if (method === 'horizontal' && tileRefs.length !== 4) { fail('horizontal needs 4 tiles'); continue; }
    const resolved = [];
    for (const r of tileRefs) {
      if (r === null) { resolved.push(null); continue; }
      let bytes = null, img = null;
      try { bytes = await readTileFile(packs, readBytes, r.ns || 'minecraft', r.path); } catch (e) { bytes = null; }
      if (!bytes) { fail('missing tile ' + r.path); bad = true; break; }
      try { img = decodePng(bytes); } catch (e) { img = null; }
      if (!img) { fail('undecodable tile ' + r.path); bad = true; break; }
      resolved.push({ ref: r, img });
    }
    if (bad) continue;
    const ruleIdx = rules.length;
    const tileNames = resolved.map((r, i) => {
      if (!r) return null;
      const name = 'ctm/' + ruleIdx + '/' + i;
      tiles.push({ name, image: r.img });
      return name;
    });
    rules.push({
      blocks: blockIds, tiles: tileNames, connect: connectState ? 1 : 0,
      faces, innerSeams: /^\s*true\s*$/i.test(props.innerSeams || ''),
      method,
    });
  }
  if (skippedMethods) console.warn('[ctm] skipped ' + skippedMethods + ' non-ctm/horizontal file(s)');
  if (rules.length) console.log('[ctm] ' + rules.length + ' rule(s), ' + tiles.length + ' tile(s)');
  return { rules, tiles };
}

// Compile rules for the mesher: state id -> rule index (-1 = none).
// First rule wins (rules arrive highest-pack-priority first).
export function compileCTMRules(rules) {
  const map = new Int32Array(states.length).fill(-1);
  if (rules) {
    for (let i = 0; i < rules.length; i++) {
      for (const id of rules[i].blocks) {
        const b = blocks[id];
        if (!b) continue;
        for (let s = b.minStateId; s <= b.maxStateId; s++) if (map[s] < 0) map[s] = i;
      }
    }
  }
  return { map, rules: rules || [] };
}

// Connection test + 8-neighbour mask for one face (Continuity
// CTMSpriteProvider.getConnections, with our FACE_DIRS orientation).
export function computeCTMMask(world, state, selfId, x, y, z, dir, rule) {
  const D = FACE_DIRS[dir];
  const at = (dx, dy, dz) => world.getState(x + dx, y + dy, z + dz);
  const connects = (nx, ny, nz) => {
    const ns = at(nx, ny, nz);
    const ok = rule.connect === 1 ? ns === state : (ns !== 0 && getBlock(ns).id === selfId);
    if (!ok) return false;
    if (rule.innerSeams) {
      const o = FACE_NORMAL[dir];
      const bs = at(nx + o[0], ny + o[1], nz + o[2]);
      const beyond = rule.connect === 1 ? bs === state : (bs !== 0 && getBlock(bs).id === selfId);
      if (beyond) return false;
    }
    return true;
  };
  const e = [0, 1, 2, 3].map((i) => {
    const d = D[i];
    return connects(d[0], d[1], d[2]);
  });
  const diag = (a, b, i, j) => {
    if (!(e[a] && e[b])) return false;
    const d0 = D[i], d1 = D[j];
    return connects(d0[0] + d1[0], d0[1] + d1[1], d0[2] + d1[2]);
  };
  let mask = (e[0] ? 1 : 0) | (e[1] ? 4 : 0) | (e[2] ? 16 : 0) | (e[3] ? 64 : 0);
  if (diag(0, 1, 0, 1)) mask |= 2;
  if (diag(1, 2, 1, 2)) mask |= 8;
  if (diag(2, 3, 2, 3)) mask |= 32;
  if (diag(3, 0, 3, 0)) mask |= 128;
  return mask;
}

export function selectCTMTile(rule, mask) {
  const idx = rule.method === 'horizontal'
    ? H_SPRITE_INDEX_MAP[(mask & 1) | (mask & 16 ? 2 : 0)]
    : SPRITE_INDEX_MAP[mask & 255];
  return idx < rule.tiles.length ? rule.tiles[idx] : null;
}

// Proportional UV remap oldRect -> newRect (atlas space), per vertex.
export function remapUVRect(oldR, newR, uv, out) {
  let ou0 = Infinity, ov0 = Infinity, ou1 = -Infinity, ov1 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    if (u < ou0) ou0 = u; if (u > ou1) ou1 = u;
    if (v < ov0) ov0 = v; if (v > ov1) ov1 = v;
  }
  const su = (newR[2] - newR[0]) / ((ou1 - ou0) || 1);
  const sv = (newR[3] - newR[1]) / ((ov1 - ov0) || 1);
  for (let i = 0; i < 4; i++) {
    out[i * 2] = newR[0] + (uv[i * 2] - ou0) * su;
    out[i * 2 + 1] = newR[1] + (uv[i * 2 + 1] - ov0) * sv;
  }
  return out;
}
