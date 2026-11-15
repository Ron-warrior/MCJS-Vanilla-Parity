/* Correct 1.15 crafting for singleplayer/offline play (port of
 * src/mc1132/recipes.js onto the 1.15.2 client modules).
 *
 * The engine's live matchers (container.js -> crafting.js craftResult over
 * the native data/recipes.json tables) are already correct offline, so —
 * unlike the 1.13.2 port — this module ships NO recipe table. It only fills
 * the gaps the engine leaves offline:
 *
 * 1. Recipe book: bundles/recipes.json is [] offline (the server sends
 *    recipes in multiplayer), so the book parses to nothing. Feed it the
 *    native data/recipes.json converted to vanilla JSON form and mark every
 *    recipe known, so the book browses + highlights craftables.
 * 2. Click-to-craft: the book's ghost-click sends placeRecipe, which dies
 *    offline (game.send drops everything). Intercept OUR book ids and
 *    arrange the ingredients locally like a server would; real connections
 *    pass through untouched. Shift-click crafts all.
 * 3. Container returns: crafting.js containerItem() uses 1.8 numeric ids
 *    (bucket 325 etc.), so milk/water/lava buckets poof on take. Override
 *    onPickupFromSlot on the 2x2 + workbench with name-resolved returns.
 * 4. Workbench close: the engine just nulls the grid offline (the server
 *    would return it). Spill grid + cursor back to the inventory instead.
 * 5. Tool repair in test/compute: same vanilla rule the engine uses.
 *
 * No `import` statements anywhere (offline blob-module constraint — the
 * offline copy injects this as a blob module, so relative imports would
 * break). Exposes globalThis.__mcRecipes = {stats, test, compute,
 * patchBench, placeRecipe, hooked}. survival.js calls patchBench(w) when a
 * workbench opens (guarded by typeof check).
 */

"use strict";

/* ------------------------------------------------------------ name <-> id */

function rcpByName(n) {
  try {
    const m = globalThis.game.items.byName;
    const d = m.get ? m.get(n) : m[n];
    const id = d && d.id != null ? d.id | 0 : null;
    return id;
  } catch (e) { return null; }
}

function rcpItemName(id) {
  try {
    const d = globalThis.game && globalThis.game.items && globalThis.game.items.def(id);
    return d ? d.name : null;
  } catch (e) { return null; }
}

/* ------------------------------------------------------------ local matcher
 * (mirrors the engine's crafting.js over the same native tables, for
 * test/compute without a container) */

let RCP_SHAPED = [], RCP_SHAPELESS = [], RCP_SKIPPED = 0, RCP_KNOWN_IDS = [];

function rcpCompile() {
  RCP_SHAPED = []; RCP_SHAPELESS = []; RCP_SKIPPED = 0;
  const g = globalThis.game;
  const data = g && g.assets && g.assets.data && g.assets.data.recipes;
  if (!data) return { shaped: 0, shapeless: 0, skipped: 0 };
  const valid = (id) => rcpItemName(id | 0) != null;
  for (const list of Object.values(data)) {
    for (const r of list) {
      if (!r || !r.result || !valid(r.result.id)) { RCP_SKIPPED++; continue; }
      if (r.inShape) {
        let bad = false;
        const grid = [];
        for (const row of r.inShape) {
          const gr = [];
          for (const cell of row) {
            if (cell == null) { gr.push(null); continue; }
            const id = cell | 0;
            if (!valid(id)) { bad = true; break; }
            gr.push([id]);
          }
          if (bad) break;
          grid.push(gr);
        }
        if (bad || !grid.length) { RCP_SKIPPED++; continue; }
        RCP_SHAPED.push({ grid, out: r.result.id | 0, n: r.result.count | 0 || 1 });
      } else if (r.ingredients) {
        const need = [];
        let bad = false;
        for (const ing of r.ingredients) {
          const id = ing | 0;
          if (!valid(id)) { bad = true; break; }
          need.push(id);
        }
        if (bad || !need.length) { RCP_SKIPPED++; continue; }
        RCP_SHAPELESS.push({ need, out: r.result.id | 0, n: r.result.count | 0 || 1 });
      } else { RCP_SKIPPED++; }
    }
  }
  return { shaped: RCP_SHAPED.length, shapeless: RCP_SHAPELESS.length, skipped: RCP_SKIPPED };
}

function rcpMatchShaped(craft, W, pat) {
  const ph = pat.length, pw = Math.max(...pat.map((r) => r.length));
  if (ph > W || pw > W) return false;
  for (let oy = 0; oy <= W - ph; oy++) {
    for (let ox = 0; ox <= W - pw; ox++) {
      for (let f = 0; f < 2; f++) {
        let ok = true;
        for (let y = 0; y < W && ok; y++) {
          for (let x = 0; x < W && ok; x++) {
            const inside = y >= oy && y < oy + ph && x >= ox && x < ox + pw;
            const row = inside ? pat[y - oy] : null;
            const cell = row ? (row[f ? pw - 1 - (x - ox) : x - ox] || null) : null;
            const have = craft[y * W + x];
            if (cell == null) { if (have) ok = false; }
            else if (!have || cell.indexOf(have.id) < 0) ok = false;
          }
        }
        if (ok) return true;
      }
    }
  }
  return false;
}

function rcpMatchShapeless(haveIds, need) {
  if (haveIds.length !== need.length) return false;
  const counts = new Map();
  for (const id of haveIds) counts.set(id, (counts.get(id) || 0) + 1);
  for (const id of need) {
    const left = (counts.get(id) || 0) - 1;
    if (left < 0) return false;
    counts.set(id, left);
  }
  return true;
}

function rcpCompute(craft, W) {
  const haveIds = [];
  for (const s of craft) if (s && s.id) haveIds.push(s.id | 0);
  if (!haveIds.length) return null;
  if (haveIds.length === 2) {
    try {
      const a = craft.find((s) => s && s.id), b = craft.filter((s) => s && s.id)[1];
      if (a && b && (a.id | 0) === (b.id | 0) && ((a.count | 0) || 1) === 1 && ((b.count | 0) || 1) === 1) {
        const g = globalThis.game;
        const m = g && g.items && typeof g.items.maxDurability === "function" ? g.items.maxDurability(a.id | 0) | 0 : 0;
        if (m > 0) {
          const da = a.damage | 0, db = b.damage | 0;
          if (da > 0 || db > 0) {
            const k = (m - da) + (m - db) + Math.floor(m * 5 / 100);
            return { id: a.id | 0, count: 1, damage: Math.max(0, m - k), nbt: null };
          }
        }
      }
    } catch (e) {}
  }
  for (const r of RCP_SHAPED) {
    if (rcpMatchShaped(craft, W, r.grid)) return { id: r.out, count: r.n, damage: 0, nbt: null };
  }
  for (const r of RCP_SHAPELESS) {
    if (rcpMatchShapeless(haveIds, r.need)) return { id: r.out, count: r.n, damage: 0, nbt: null };
  }
  return null;
}

/* ------------------------------------------------------------ book fill */

const RCP_BOOK_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function rcpBuildBook() {
  const g = globalThis.game;
  const data = g && g.assets && g.assets.data && g.assets.data.recipes;
  if (!data) return -1;
  const BOOK = [];
  let n = 0;
  for (const list of Object.values(data)) {
    for (const r of list) {
      if (!r || !r.result) continue;
      const outName = rcpItemName(r.result.id);
      if (!outName) continue;
      const name = "mcjs:" + outName + ":" + (n++);
      const result = { item: "minecraft:" + outName, count: r.result.count | 0 || 1 };
      if (r.inShape) {
        const W = Math.max(...r.inShape.map((row) => row.length));
        const key = {}, cmap = {}, pattern = [];
        let ci = 0;
        let bad = false;
        for (const row of r.inShape) {
          let pat = "";
          for (let x = 0; x < W; x++) {
            const cell = row[x];
            if (cell == null) { pat += " "; continue; }
            const nm = rcpItemName(cell | 0);
            if (!nm) { bad = true; break; }
            if (!(nm in cmap)) {
              cmap[nm] = RCP_BOOK_CHARS[ci++ % RCP_BOOK_CHARS.length];
              key[cmap[nm]] = [{ item: "minecraft:" + nm }];
            }
            pat += cmap[nm];
          }
          if (bad) break;
          pattern.push(pat);
        }
        if (bad || !pattern.length) continue;
        BOOK.push({ type: "crafting_shaped", name, group: "", pattern, key, result });
      } else if (r.ingredients) {
        const ingredients = [];
        let bad = false;
        for (const ing of r.ingredients) {
          const nm = rcpItemName(ing | 0);
          if (!nm) { bad = true; break; }
          ingredients.push([{ item: "minecraft:" + nm }]);
        }
        if (bad || !ingredients.length) continue;
        BOOK.push({ type: "crafting_shapeless", name, group: "", ingredients, result });
      }
    }
  }
  return BOOK;
}

/* ------------------------------------------------------------ take / close */

function rcpBucketId() { return rcpByName("bucket"); }

function rcpTakeWithReturns(cont, from, to) {
  for (let s = from; s <= to; s++) {
    try {
      const st = cont.get(s);
      if (!st) continue;
      let ret = null;
      try {
        const nm = rcpItemName(st.id);
        if (nm === "milk_bucket" || nm === "water_bucket" || nm === "lava_bucket") {
          const bid = rcpBucketId();
          if (bid != null) ret = { id: bid, count: 1, damage: 0, nbt: null };
        }
      } catch (_) {}
      cont.decr(s, 1);
      if (ret) {
        try {
          if (cont.get(s)) { try { cont.inv.addToInventory(ret); } catch (_) {} }
          else cont.put(s, ret);
        } catch (_) {}
      }
    } catch (_) {}
  }
}

// Patch a live crafting_table window: container returns on take (the
// engine's containerItem uses 1.8 ids, so buckets would poof).
function rcpPatchBench(w) {
  if (!w || w._mcBenchPatched || w.type !== "minecraft:crafting_table") return;
  w._mcBenchPatched = true;
  w.onSlotChanged = function (t) {
    try {
      if (t === undefined || (t >= 1 && t <= 9)) {
        const c9 = (this.container.slice(1, 10) || []).map((s) => (s && s.id ? s : null));
        this.container[0] = rcpCompute(c9, 3);
      }
    } catch (e) { try { this.container[0] = null; } catch (_) {} }
  };
  // Engine consume uses 1.8-id containerItem: redo the take with name-resolved
  // returns instead (milk/water/lava bucket -> bucket in-grid or inventory).
  w.onPickupFromSlot = function (t) {
    try { if (t === 0) rcpTakeWithReturns(this, 1, 9); } catch (_) {}
  };
  // Note: grid/cursor salvage on close is owned by survival.js
  // (salvageWorkbench wraps the screen close and can spill overflow as item
  // entities); this only patches take behavior.
  try { w.onSlotChanged(1); } catch (_) {}
}

function rcpPatchBenchCurrent() {
  try {
    const g = globalThis.game;
    const w = g && g.window;
    if (w && w.type === "minecraft:crafting_table" && w.container) rcpPatchBench(w);
  } catch (e) {}
}

// The persistent 2x2 gets container returns too (engine's are 1.8 ids).
function rcpPatchPlayer() {
  try {
    const inv = globalThis.game && globalThis.game.inventory;
    if (!inv || inv._mcRecipesPatched) return;
    inv._mcRecipesPatched = true;
    const orig = inv.onPickupFromSlot ? inv.onPickupFromSlot.bind(inv) : null;
    inv.onPickupFromSlot = function (i, taken) {
      // slots: 0 = result, 1..4 = the 2x2 grid (craft[0..3] proxies)
      try { if (i === 0) rcpTakeWithReturns(this, 1, 4); } catch (_) {}
      // note: the 2x2 grid lives in inv.craft (slots 1..4 map there via the
      // slot proxies), so take-with-returns on 0..3 covers it.
      try { if (orig && i !== 0) orig(i, taken); } catch (e) {}
      if (i === 0) { try { this.updateCraftResult(); } catch (e) {} }
    };
  } catch (e) {}
}

/* ------------------------------------------------------------ click-to-craft
 * Offline the placeRecipe packet dies in game.send, so decode it here and
 * arrange the grid locally. Real connections pass through untouched. */

function rcpReadVarint(u8, o) {
  let v = 0, s = 0, b;
  do {
    if (o >= u8.length) return null;
    b = u8[o++];
    v |= (b & 0x7f) << s; s += 7;
  } while (b & 0x80);
  return { v, o };
}

function rcpParsePlaceRecipe(data) {
  try {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!u8.length) return null;
    const id = rcpReadVarint(u8, 0);
    if (!id) return null;
    let o = id.o;
    if (o >= u8.length) return null;
    const wid = u8[o++];
    const lr = rcpReadVarint(u8, o);
    if (!lr) return null;
    o = lr.o;
    if (o + lr.v + 1 !== u8.length) return null; // string + bool exactly
    let rid = "";
    for (let i = 0; i < lr.v; i++) rid += String.fromCharCode(u8[o + i]);
    const shift = (u8[o + lr.v] | 0) !== 0;
    return { wid, rid, shift };
  } catch (e) { return null; }
}

function rcpStackMatchesCell(cell, stack) {
  if (!stack || !stack.id) return false;
  for (const alt of cell) {
    if ((alt.id | 0) === (stack.id | 0) &&
        (alt.data === 32767 || (alt.data | 0) === (stack.damage | 0))) return true;
  }
  return false;
}

function rcpWantLayout(rec, W) {
  if (!rec || !rec.cells || (rec.width | 0) > W || (rec.height | 0) > W) return null;
  const want = new Array(W * W).fill(null);
  for (let y = 0; y < rec.height; y++) {
    for (let x = 0; x < rec.width; x++) {
      const cell = rec.cells[y * rec.width + x];
      if (cell && cell.length) want[y * W + x] = cell;
    }
  }
  return want;
}

function rcpArrangeGrid(benchW, rec, W) {
  const g = globalThis.game, inv = g && g.inventory;
  if (!inv || !inv.main) return null;
  const N = W * W;
  const getGrid = (i) => (benchW ? benchW.container[1 + i] : inv.craft[i]);
  const setGrid = (i, s) => {
    if (benchW) { try { benchW.put(1 + i, s); } catch (e) { benchW.container[1 + i] = s; } }
    else inv.craft[i] = s;
  };
  const want = rcpWantLayout(rec, W);
  if (!want) return null;
  const sim = inv.main.map((s) => (s && s.count | 0) || 0);
  const picks = [];
  for (let i = 0; i < want.length; i++) {
    const cell = want[i];
    if (!cell) continue;
    let found = -1;
    for (let m = 0; m < inv.main.length; m++) {
      const st = inv.main[m];
      if (sim[m] > 0 && rcpStackMatchesCell(cell, st)) { found = m; break; }
    }
    if (found < 0) return null;
    sim[found]--;
    picks.push([i, found]);
  }
  try {
    for (let i = 0; i < N; i++) {
      const cur = getGrid(i);
      if (cur && cur.id) {
        setGrid(i, null);
        try {
          if (benchW && typeof benchW.mergeItemStack === "function") {
            const cp = { id: cur.id, count: cur.count | 0, damage: cur.damage | 0 };
            if (cur.nbt) { try { cp.nbt = cur.nbt; } catch (e) {} }
            if (!benchW.mergeItemStack(cp, 10, 46, true) && (cp.count | 0) > 0) {
              try { inv.addToInventory(cp); } catch (e) {}
            }
          } else {
            try { inv.mergeItemStack(cur, 9, 45, true); }
            catch (e) { try { inv.addToInventory(cur); } catch (_) {} }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
  for (const [i, m] of picks) {
    const st = inv.main[m];
    const put = { id: st.id, count: 1, damage: st.damage | 0 };
    if (st.nbt) { try { put.nbt = st.nbt; } catch (e) {} }
    st.count -= 1;
    if (st.count <= 0) { try { inv.main[m] = null; } catch (e) { st.count = 0; } }
    setGrid(i, put);
  }
  return want;
}

function rcpRefillCell(benchW, inv, i, cell) {
  for (let m = 0; m < inv.main.length; m++) {
    const st = inv.main[m];
    if (st && (st.count | 0) > 0 && rcpStackMatchesCell(cell, st)) {
      const put = { id: st.id, count: 1, damage: st.damage | 0 };
      if (st.nbt) { try { put.nbt = st.nbt; } catch (e) {} }
      st.count -= 1;
      if (st.count <= 0) { try { inv.main[m] = null; } catch (e) { st.count = 0; } }
      if (benchW) { try { benchW.put(1 + i, put); } catch (e) { benchW.container[1 + i] = put; } }
      else inv.craft[i] = put;
      return true;
    }
  }
  return false;
}

function rcpMoveResultToInv(benchW, inv) {
  const res = benchW ? benchW.container[0] : inv.craftResult;
  if (!res || !res.id) return false;
  const cp = { id: res.id, count: res.count | 0, damage: res.damage | 0 };
  if (res.nbt) { try { cp.nbt = res.nbt; } catch (e) {} }
  try {
    const ok = benchW ? benchW.mergeItemStack(cp, 10, 46, true) : inv.mergeItemStack(cp, 9, 45, true);
    if (!ok || (cp.count | 0) > 0) { try { inv.addToInventory(cp); } catch (e) {} }
    if ((cp.count | 0) > 0) return false;
  } catch (e) { return false; }
  return true;
}

function rcpEmulatePlaceRecipe(rid, shift) {
  try {
    const g = globalThis.game, rb = g && g.recipeBook, inv = g && g.inventory;
    const rec = rb && rb.recipe(rid);
    if (!rec || !rec.cells || !inv || !inv.main) return false;
    const w = g.window;
    const onBench = !!(w && w.type === "minecraft:crafting_table" && w.container);
    const W = onBench ? 3 : 2;
    if ((rec.width | 0) > W || (rec.height | 0) > W) return false;
    if (onBench && (!w.container || w.container.length < 10)) return false;
    if (!onBench && (!inv.craft || inv.craft.length < 4)) return false;
    const benchW = onBench ? w : null;
    const want = rcpArrangeGrid(benchW, rec, W);
    if (!want) return false;
    const refresh = () => {
      try {
        if (benchW) { if (typeof benchW.onSlotChanged === "function") benchW.onSlotChanged(1); }
        else inv.updateCraftResult();
      } catch (e) {}
    };
    refresh();
    if (shift) {
      let n = 0;
      while (n++ < 64) {
        if (!rcpMoveResultToInv(benchW, inv)) break;
        try {
          if (benchW) { if (typeof benchW.onPickupFromSlot === "function") benchW.onPickupFromSlot(0); }
          else if (typeof inv.onPickupFromSlot === "function") inv.onPickupFromSlot(0);
        } catch (e) {}
        let ok = true;
        for (let i = 0; i < want.length; i++) {
          if (want[i] && !rcpRefillCell(benchW, inv, i, want[i])) { ok = false; break; }
        }
        refresh();
        if (!ok) break;
        const chk = benchW ? benchW.container[0] : inv.craftResult;
        if (!chk || !chk.id) break;
      }
    }
    return true;
  } catch (e) { return false; }
}

function rcpHookSend() {
  try {
    const g = globalThis.game;
    if (!g || g._mcPlacePatched || typeof g.send !== "function") return;
    g._mcPlacePatched = true;
    const origSend = g.send.bind(g);
    g.send = function (data) {
      try {
        if (!g.conn && data && data.length >= 5) {
          const p = rcpParsePlaceRecipe(data);
          if (p && /^\d+$/.test(String(p.wid)) &&
              (p.wid === 0 || (g.window && g.window.type === "minecraft:crafting_table"))) {
            const rec = g.recipeBook && g.recipeBook.recipe(p.rid);
            if (rec && rcpEmulatePlaceRecipe(p.rid, p.shift)) return;
          }
        }
      } catch (e) {}
      return origSend(data);
    };
  } catch (e) { console.error("[recipes] send hook failed", e); }
}

// world joins/leaves reset the book's known set; re-mark ours after.
function rcpRemark() {
  try {
    const rb = globalThis.game && globalThis.game.recipeBook;
    if (rb && rb.known && rb.known.size === 0 && RCP_KNOWN_IDS.length) {
      for (const id of RCP_KNOWN_IDS) rb.known.add(id);
      return true;
    }
  } catch (e) {}
  return false;
}

function rcpEnsureWraps() {
  try {
    const g = globalThis.game;
    if (!g || g._mcRecipesWrapped) { rcpRemark(); return; }
    g._mcRecipesWrapped = true;
    for (const m of ["leaveWorld", "on_login"]) {
      try {
        const orig = g[m];
        if (typeof orig === "function") {
          g[m] = function (...a) {
            const r = orig.apply(g, a);
            try { setTimeout(rcpRemark, 0); } catch (e) {}
            return r;
          };
        }
      } catch (e) {}
    }
  } catch (e) {}
  rcpRemark();
  try {
    if (!globalThis._rcpPoll) {
      globalThis._rcpPoll = setInterval(() => { try { rcpRemark(); } catch (e) {} }, 2000);
    }
  } catch (e) {}
}

/* ------------------------------------------------------------ install */

function rcpBoot() {
  if (!globalThis.game || !globalThis.game.items || !globalThis.game.items.byName ||
      !globalThis.game.screens || !globalThis.game.assets ||
      !globalThis.game.assets.data || !globalThis.game.assets.data.recipes) {
    setTimeout(rcpBoot, 300);
    return;
  }
  try {
    const st = rcpCompile();
    console.log("[recipes] " + st.shaped + " shaped + " + st.shapeless +
      " shapeless, skipped " + st.skipped);
  } catch (e) { console.error("[recipes] compile failed", e); }
  try {
    const g = globalThis.game;
    const BOOK = rcpBuildBook();
    if (BOOK && BOOK !== -1) {
      g.assets.recipes = BOOK;
      const rb = g.recipeBook;
      if (rb) {
        rb.recipes = null; rb.lists = null;
        try { rb.tabLists("search"); } catch (e) {}
        try {
          if (rb.recipes) {
            RCP_KNOWN_IDS = [];
            for (const r of Object.values(rb.recipes)) if (r) { rb.known.add(r.id); RCP_KNOWN_IDS.push(r.id); }
          }
          const cur = g.screens.current;
          if (cur && typeof cur.recipesUpdated === "function") cur.recipesUpdated();
        } catch (e) {}
      }
      console.log("[recipes] book: " + BOOK.length + " recipes known");
    }
  } catch (e) { console.error("[recipes] book fill failed", e); }
  try {
    rcpPatchPlayer();
    const screens = globalThis.game.screens;
    if (!screens._mcRecipesHooked) {
      screens._mcRecipesHooked = true;
      const origOpen = screens.open;
      let opens = 0;
      screens.open = function (s) {
        const r = origOpen.call(screens, s);
        try {
          rcpPatchBenchCurrent();
          rcpEnsureWraps();
          if (++opens > 200) {
            try { screens.open = origOpen; } catch (e) {}
            screens._mcRecipesHooked = false;
          }
        } catch (e) {}
        return r;
      };
    }
    rcpPatchBenchCurrent();
  } catch (e) { console.error("[recipes] hook failed", e); }
  try { rcpHookSend(); } catch (e) { console.error("[recipes] send hook failed", e); }
  globalThis.__mcRecipes = {
    stats: () => ({ shaped: RCP_SHAPED.length, shapeless: RCP_SHAPELESS.length, skipped: RCP_SKIPPED,
      book: (() => { try { return globalThis.game.recipeBook.known.size; } catch (e) { return -1; } })() }),
    test: (ids, W) => rcpCompute(ids.map((id) => id ? { id } : null), W || 2),
    compute: rcpCompute,
    patchBench: rcpPatchBench,
    placeRecipe: rcpEmulatePlaceRecipe,
    hooked: () => !!(globalThis.game && globalThis.game.screens && globalThis.game.screens._mcRecipesHooked),
  };
  console.log("[recipes] ready");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", rcpBoot);
} else {
  rcpBoot();
}
