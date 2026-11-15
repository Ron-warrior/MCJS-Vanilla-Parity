/* Native GUI foundation for the 1.15.2 engine (port of
 * src/mc1132/native-gui.js): engine-rendered screens (real dirt background +
 * MC buttons/font) built by subclassing the engine's own screen base class,
 * harvested at runtime from the live title screen. The 1.15.2 Screen/Button
 * APIs match what this needs (Screen base with render/mouseDown + buttons/
 * fields arrays, Button(id,x,y,w,h,label,onClick) with .enabled/.visible,
 * gui helpers blit/drawImage/textCentered/rect/text/font/scissor).
 *
 * 1.15.2 difference: Button.render delegates to gui.button(), which has the
 * same <=400px half-blit limitation, so the wide-button tiling is patched at
 * the gui.button level (fixes engine screens too) in addition to the
 * button-prototype patch.
 *
 * across minified renames because nothing is referenced by minified name —
 * the base is found by walking the static inheritance chain to the top, and
 * the button class is found from a live button instance.
 *
 * No `import` statements here (offline blob-module constraint). Exposes
 * `globalThis.__mcNativeGui` with: confirm(), showDeath(), dismiss(),
 * open()/closeScreen() + base()/button() for feature screens, List (scrollable
 * text list) and Field (single-line text entry) widget classes, harvest().
 * Migration order: confirms -> death screen -> download builder ->
 * realms configure -> welcome/profile -> singleplayer list/create.
 * Touch-device caveat: canvas screens can't summon the phone OS keyboard,
 * so field-heavy screens stay HTML on touch until a keyboard solution exists.
 */

// Screen base + button ctors, harvested lazily from the live game.
let NGScreen = null;
let NGButton = null;
let NGame = null;

// The engine's t.button() only handles widths up to ~400px: it draws two
// half-blits from the 200px-wide widgets.png, so past 400 the source rect
// goes negative and a white bar appears down the button's center. Patch
// once so wider menu buttons tile a 1px center column instead.
let _ngWidePatched = null;
function ngPatchWideButtons(Btn) {
  if (_ngWidePatched === Btn) return;
  _ngWidePatched = Btn;
  try {
    const P = Btn && Btn.prototype;
    if (!P || P._ngWide || typeof P.render !== "function") return;
    const orig = P.render;
    P._ngWide = true;
    P.render = function (t, e, s) {
      try {
        if (this.visible !== false && t && typeof t.blit === "function" &&
            typeof t.drawImage === "function" && typeof t.textCentered === "function" &&
            (this.w | 0) > 400) {
          const label = typeof this.label === "function" ? this.label() : this.label;
          const hov = !!(this.enabled && this.hovered && this.hovered(e, s));
          const c = this.enabled ? (hov ? 86 : 66) : 46;
          const x = Math.floor(this.x), y = Math.floor(this.y);
          const w = Math.floor(this.w), h = Math.floor(this.h);
          const cap = 100;
          t.blit("gui/widgets.png", x, y, 0, c, cap, h);
          t.blit("gui/widgets.png", x + w - cap, y, 200 - cap, c, cap, h);
          const midW = w - 2 * cap;
          if (midW > 0) t.drawImage("gui/widgets.png", 100, c, 1, h, x + cap, y, midW, h);
          const col = this.enabled ? (hov ? 16777120 : 14737632) : 10526880;
          t.textCentered(label, x + Math.floor(w / 2), y + Math.floor((h - 8) / 2), col, true);
          return;
        }
      } catch (err) {}
      return orig.call(this, t, e, s);
    };
  } catch (e) {}
}

let _ngGuiPatched = null;
function ngPatchGuiButton(g) {
  try {
    const gui = g && g.gui;
    if (!gui || _ngGuiPatched === gui) return;
    const orig = gui.button;
    if (typeof orig !== "function" || orig._ngWide) return;
    const patched = function (x, y, w, h, label, hovered, enabled = true) {
      try {
        if ((w | 0) > 400 && typeof this.blit === "function" &&
            typeof this.drawImage === "function" && typeof this.textCentered === "function") {
          const c = enabled ? (hovered ? 86 : 66) : 46;
          const xx = Math.floor(x), yy = Math.floor(y);
          const ww = Math.floor(w), hh = Math.floor(h);
          const cap = 100;
          this.blit("gui/widgets.png", xx, yy, 0, c, cap, hh);
          this.blit("gui/widgets.png", xx + ww - cap, yy, 200 - cap, c, cap, hh);
          const midW = ww - 2 * cap;
          if (midW > 0) this.drawImage("gui/widgets.png", 100, c, 1, hh, xx + cap, yy, midW, hh);
          const col = enabled ? (hovered ? 16777120 : 14737632) : 10526880;
          this.textCentered(label, xx + Math.floor(ww / 2), yy + Math.floor((hh - 8) / 2), col, true);
          return;
        }
      } catch (err) {}
      return orig.call(this, x, y, w, h, label, hovered, enabled);
    };
    patched._ngWide = true;
    gui.button = patched;
    _ngGuiPatched = gui;
  } catch (e) {}
}

function ngHarvest() {
  const g = globalThis.game;
  if (!g || !g.screens) return false;
  if (NGScreen && NGButton && NGame === g) return true;
  try {
    const cur = g.screens.current;
    if (!cur || !cur.constructor) return false;
    // walk the static inheritance chain to the top = screen base (rt)
    let Base = cur.constructor;
    let guard = 0;
    while (Base && Object.getPrototypeOf(Base) !== Function.prototype && guard++ < 8) {
      Base = Object.getPrototypeOf(Base);
    }
    if (!Base || !Base.prototype ||
        typeof Base.prototype.render !== "function" ||
        typeof Base.prototype.mouseDown !== "function") return false;
    // button class from any live button on the current screen
    let Btn = null;
    const bs = cur.buttons || [];
    for (let i = 0; i < bs.length; i++) {
      const C = bs[i] && bs[i].constructor;
      if (C && C.prototype &&
          typeof C.prototype.render === "function" &&
          typeof C.prototype.mouseDown === "function") { Btn = C; break; }
    }
    if (!Btn) return false;
    // smoke-test both constructions before trusting them
    const t = new Base(g);
    if (!t || !t.buttons || !t.fields) return false;
    const b = new Btn(0, 0, 0, 10, 10, "x", null);
    if (!b || b.enabled !== true) return false;
    NGScreen = Base;
    NGButton = Btn;
    NGame = g;
    try { ngPatchWideButtons(Btn); } catch (e) {}
    try { ngPatchGuiButton(g); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

function ngConfirmClass() {
  const B = NGScreen;
  const Btn = NGButton;
  return class extends B {
    constructor(g, o) {
      super(g);
      this.background = "dirt"; // base render() paints dirt, then content + buttons
      this._co = o;
    }
    init() {
      const o = this._co;
      const bw = Math.min(200, Math.max(120, Math.floor((this.width - 28) / 2)));
      const cx = Math.floor(this.width / 2);
      const y = Math.floor(this.height / 2) + 28;
      this.buttons.push(new Btn(0, cx - bw - 4, y, bw, 20, o.okLabel,
        () => { o.done(true); }));
      this.buttons.push(new Btn(1, cx + 4, y, bw, 20, o.cancelLabel,
        () => { o.done(false); }));
    }
    renderContent(t) {
      const o = this._co;
      const cx = Math.floor(this.width / 2);
      const cy = Math.floor(this.height / 2);
      const maxW = Math.max(200, this.width - 40);
      const wrap = (s, n) => {
        let rows = null;
        try { rows = t.font ? t.font.wrap(String(s), maxW) : null; } catch (e) { rows = null; }
        if (!rows || !rows.length) rows = [String(s)];
        return rows.slice(0, n);
      };
      const titleRows = wrap(o.title, 2);
      for (let i = 0; i < titleRows.length; i++) {
        t.textCentered(titleRows[i], cx, cy - 64 + i * 12, 16777215);
      }
      let y = cy - 64 + titleRows.length * 12 + 8;
      let shown = 0;
      for (let i = 0; i < o.lines.length && shown < 5; i++) {
        const parts = wrap(o.lines[i], 5 - shown);
        for (let j = 0; j < parts.length && shown < 5; j++, shown++) {
          t.textCentered(parts[j], cx, y, 10526880);
          y += 12;
        }
      }
    }
    key(e) {
      if (!e) return super.key(e);
      if (e.code === "Escape") { this._co.done(false); return true; }
      if (e.code === "Enter" || e.code === "NumpadEnter") { this._co.done(true); return true; }
      return super.key(e);
    }
    close() {
      // engine-initiated close: resolve like a cancel so callers re-show UI
      try { this._co.done(false); } catch (e) {}
    }
  };
}

let ngStack = []; // [{screen, prev}] — nested native dialogs (confirms over menus)

// Push a screen and open it. prev is the fallback to restore when the stack
// empties (null for in-world dialogs like death: current goes back to null).
// Stale top records (their screen is no longer current) are dropped first.
function ngPush(scr) {
  const g = globalThis.game;
  if (!g || !g.screens || !scr) return null;
  try {
    while (ngStack.length && ngStack[ngStack.length - 1].screen !== g.screens.current) {
      const stale = ngStack.pop();
      try { stale.screen.onClose && stale.screen.onClose(); } catch (e) {}
    }
  } catch (e) {}
  const rec = { screen: scr, prev: g.screens.current || null };
  ngStack.push(rec);
  try {
    g.screens.open(scr);
  } catch (e) {
    ngStack.splice(ngStack.indexOf(rec), 1);
    return null;
  }
  return rec;
}
function ngTop() { return ngStack.length ? ngStack[ngStack.length - 1] : null; }
// Dismiss the top dialog. The new top (if any) is re-shown, else the popped
// record's prev is restored. Stale records are just dropped.
function ngDismiss() {
  const rec = ngStack.pop();
  if (!rec) return false;
  try { rec.screen.onClose && rec.screen.onClose(); } catch (e) {}
  try {
    const g = globalThis.game;
    const s = g && g.screens;
    if (s && s.current === rec.screen) {
      const top = ngTop();
      const target = top ? top.screen : rec.prev;
      if (target) {
        try { s.open(target); } catch (e) {
          try { s.current = null; } catch (ee) {}
        }
      } else {
        try { s.current = null; } catch (e) {}
      }
    }
  } catch (e) {}
  return true;
}
// Route a screen's close() through the stack so records never leak when the
// engine (or base key handling) closes a native screen directly.
function ngCloseScreen(scr) {
  for (let i = ngStack.length - 1; i >= 0; i--) {
    if (ngStack[i].screen === scr) {
      const rec = ngStack[i];
      ngStack.splice(i, 1);
      try { rec.screen.onClose && rec.screen.onClose(); } catch (e) {}
      if (i === ngStack.length) { // was the top: reveal the new top or prev
        try {
          const g = globalThis.game;
          const s = g && g.screens;
          if (s && s.current === scr) {
            const top = ngTop();
            const target = top ? top.screen : rec.prev;
            if (target) {
              try { s.open(target); } catch (e) {
                try { s.current = null; } catch (ee) {}
              }
            } else {
              try { s.current = null; } catch (e) {}
            }
          }
        } catch (e) {}
      }
      return true;
    }
  }
  return false;
}

// opts: {title, lines[], okLabel, cancelLabel} -> Promise<boolean> | null
function ngConfirm(opts) {
  opts = opts || {};
  const o = {
    title: String(opts.title != null ? opts.title : "Are you sure?"),
    lines: Array.isArray(opts.lines) ? opts.lines.map((x) => String(x)) : [],
    okLabel: String(opts.okLabel || "Yes"),
    cancelLabel: String(opts.cancelLabel || "No"),
    done: null,
  };
  if (!ngHarvest()) return null;
  const g = globalThis.game;
  const screens = g.screens;
  if (!screens || !screens.current) return null; // confirms need a screen underneath
  return new Promise((resolve) => {
    const Confirm = ngConfirmClass();
    const scr = new Confirm(g, o);
    const rec = ngPush(scr);
    if (!rec) { try { resolve(false); } catch (e) {} return; }
    o.done = (v) => {
      if (ngTop() === rec) ngDismiss();
      else {
        const i = ngStack.indexOf(rec);
        if (i >= 0) ngStack.splice(i, 1);
      }
      try { resolve(!!v); } catch (e) {}
    };
  });
}

function ngDeathClass() {
  const B = NGScreen;
  const Btn = NGButton;
  return class extends B {
    constructor(g, o) {
      super(g);
      this.background = "none"; // live world stays visible behind the tint
      this._o = o;
    }
    init() {
      const o = this._o;
      const cx = Math.floor(this.width / 2);
      const y = Math.floor(this.height / 2) + 36;
      this.buttons.push(new Btn(0, cx - 100, y, 200, 20, o.okLabel,
        () => { o.done(); }));
    }
    renderContent(t) {
      const o = this._o;
      const cx = Math.floor(this.width / 2);
      const cy = Math.floor(this.height / 2);
      t.rect(0, 0, this.width, this.height, 0x66FF0000); // red tint over world
      t.textCentered(o.title, cx, cy - 30, 0xFF5555);
      const maxW = Math.max(200, this.width - 40);
      let rows = [];
      try { rows = t.font ? t.font.wrap(String(o.message), maxW) : null; } catch (e) { rows = null; }
      if (!rows || !rows.length) rows = [String(o.message)];
      rows = rows.slice(0, 3);
      let y = cy - 8;
      for (let i = 0; i < rows.length; i++) {
        t.textCentered(rows[i], cx, y, 0xA0A0A0);
        y += 12;
      }
    }
    key(e) {
      // swallow everything (esp. Escape: the base would close without respawn)
      if (e && (e.code === "Enter" || e.code === "NumpadEnter")) this._o.done();
      return true;
    }
    close() {
      // engine-initiated close: respawn rather than strand a corpse-walker
      try { this._o.done(); } catch (e) {}
    }
  };
}

// opts: {title, message, okLabel}, onDone() -> opened boolean
function ngShowDeath(opts, onDone) {
  opts = opts || {};
  const o = {
    title: String(opts.title != null ? opts.title : "You died!"),
    message: String(opts.message != null ? opts.message : ""),
    okLabel: String(opts.okLabel || "Respawn"),
    done: null,
  };
  if (!ngHarvest()) return false;
  const g = globalThis.game;
  if (!g || !g.screens || !g.inWorld) return false;
  const Death = ngDeathClass();
  const scr = new Death(g, o);
  const rec = ngPush(scr);
  if (!rec) return false;
  try { document.exitPointerLock && document.exitPointerLock(); } catch (e) {}
  o.done = () => {
    if (ngTop() === rec) ngDismiss();
    else {
      const i = ngStack.indexOf(rec);
      if (i >= 0) ngStack.splice(i, 1);
    }
    try { onDone && onDone(); } catch (e) {}
  };
  return true;
}

// Generic hosting for feature-module native screens: base()/button() expose
// the harvested ctors; open(screen) records the previous screen and opens;
// dismiss() (above) restores it. Escape on a hosted screen falls back to the
// engine default (back to title) unless the screen overrides key().
function ngBase() { return ngHarvest() ? NGScreen : null; }
function ngButton() { return ngHarvest() ? NGButton : null; }
function ngOpenScreen(scr) {
  if (!ngHarvest() || !scr) return false;
  return !!ngPush(scr);
}

// Minimal scrollable text list for native menus: click selects,
// double-click activates, wheel/drag scrolls. rows(): array of strings or
// {text, color}. Host screens keep one instance per list, forward
// mouseDown/mouseUp/mouseMove/wheel, and call render() from renderContent.
class NgList {
  constructor(o) {
    o = o || {};
    this.x = o.x | 0; this.y = o.y | 0;
    this.w = Math.max(40, o.w | 0); this.h = Math.max(20, o.h | 0);
    this.rowH = Math.max(10, o.rowH | 0 || 16);
    this.rowsFn = typeof o.rows === "function" ? o.rows : () => [];
    this.selectedFn = typeof o.selected === "function" ? o.selected : () => false;
    this.onClick = typeof o.onClick === "function" ? o.onClick : () => {};
    this.emptyText = o.emptyText != null ? String(o.emptyText) : "";
    this.drawRow = typeof o.drawRow === "function" ? o.drawRow : null;
    this.scroll = 0;
    this.hover = -1;
    this.lastRow = -1;
    this.lastTime = 0;
    this.dragMode = null;
    this.dragY = 0;
  }
  rows() { try { const r = this.rowsFn(); return Array.isArray(r) ? r : []; } catch (e) { return []; } }
  maxScroll() { return Math.max(0, this.rows().length * this.rowH - this.h); }
  clamp() {
    const m = this.maxScroll();
    if (this.scroll < 0) this.scroll = 0;
    else if (this.scroll > m) this.scroll = m;
  }
  barW() { return this.maxScroll() > 0 ? 8 : 0; }
  inside(x, y) { return x >= this.x && x < this.x + this.w && y >= this.y && y < this.y + this.h; }
  rowAt(x, y) {
    if (!this.inside(x, y)) return -1;
    const i = Math.floor((y - this.y + this.scroll) / this.rowH);
    const n = this.rows().length;
    return (i >= 0 && i < n) ? i : -1;
  }
  render(t, mx, my) {
    this.clamp();
    this.hover = (mx == null || mx === undefined) ? -1 : this.rowAt(mx, my);
    const rows = this.rows();
    t.rect(this.x, this.y, this.x + this.w, this.y + this.h, 0x80000000);
    if (!rows.length) {
      if (this.emptyText) {
        let s = this.emptyText;
        try { s = t.font ? t.font.trimToWidth(s, this.w - 6) : s; } catch (e) {}
        try { t.text(s, this.x + 3, this.y + 3, 0x808080, false); } catch (e) {}
      }
    } else {
      let useScissor = false;
      try { if (t.scissor) { t.scissor(this.x, this.y, this.w, this.h); useScissor = true; } } catch (e) {}
      try {
        const start = Math.max(0, Math.floor(this.scroll / this.rowH));
        const tw = this.w - this.barW() - 6;
        for (let k = 0; k * this.rowH < this.h + this.rowH; k++) {
          const i = start + k;
          if (i >= rows.length) break;
          const ry = this.y - (this.scroll - start * this.rowH) + k * this.rowH;
          if (!useScissor && (ry < this.y || ry + this.rowH > this.y + this.h)) continue;
          const r = rows[i];
          let sel = false;
          try { sel = !!this.selectedFn(i); } catch (e) {}
          if (typeof this.drawRow === "function") {
            // custom row content (thumbnails, multi-line text, ...). The
            // hook draws its own selection/hover treatment.
            try { this.drawRow(t, r, i, this.x, ry, this.w - this.barW(), this.rowH, sel, i === this.hover); } catch (e) {}
            continue;
          }
          const label = (r && typeof r === "object") ? String(r.text) : String(r);
          const color = (r && typeof r === "object" && r.color != null) ? r.color : 0xFFFFFF;
          let txt = label;
          try { txt = t.font ? t.font.trimToWidth(label, Math.max(10, tw)) : label; } catch (e) {}
          if (sel) {
            const bx = this.x + this.w - this.barW();
            t.rect(this.x, ry, bx, ry + 1, 0xFFFFFFFF);
            t.rect(this.x, ry + this.rowH - 1, bx, ry + this.rowH, 0xFFFFFFFF);
            t.rect(this.x, ry, this.x + 1, ry + this.rowH, 0xFFFFFFFF);
            t.rect(bx - 1, ry, bx, ry + this.rowH, 0xFFFFFFFF);
          } else if (i === this.hover) {
            t.rect(this.x + 1, ry, this.x + this.w - this.barW() - 1, ry + this.rowH, 0x22FFFFFF);
          }
          try { t.text(txt, this.x + 3, ry + 3, color, false); } catch (e) {}
        }
      } catch (e) {}
      try { if (useScissor && t.clearScissor) t.clearScissor(); } catch (e) {}
    }
    if (this.maxScroll() > 0) {
      const bx = this.x + this.w - 8;
      t.rect(bx, this.y, bx + 8, this.y + this.h, 0xFF333333);
      const th = Math.max(12, Math.floor(this.h * this.h / Math.max(1, rows.length * this.rowH)));
      const ty = this.y + Math.floor((this.h - th) * this.scroll / this.maxScroll());
      t.rect(bx + 1, ty, bx + 7, ty + th, 0xFF888888);
    }
  }
  mouseDown(x, y, btn) {
    this.dragMode = null;
    if ((btn !== 0 && btn !== undefined) || !this.inside(x, y)) return false;
    if (this.maxScroll() > 0 && x >= this.x + this.w - 8) {
      this.dragMode = "bar";
      this.scroll = ((y - this.y) / this.h) * this.maxScroll();
      this.clamp();
      return true;
    }
    const i = this.rowAt(x, y);
    if (i >= 0) {
      let now = 0;
      try { now = Date.now(); } catch (e) {}
      const dbl = (i === this.lastRow && now - this.lastTime < 250);
      this.lastRow = i; this.lastTime = now;
      try { this.onClick(i, !!dbl, x, y); } catch (e) {}
    }
    this.dragMode = "rows";
    this.dragY = y;
    return true;
  }
  mouseUp() { this.dragMode = null; }
  mouseMove(x, y) {
    if (this.dragMode === "bar" && this.maxScroll() > 0) {
      this.scroll = ((y - this.y) / this.h) * this.maxScroll();
      this.clamp();
    } else if (this.dragMode === "rows") {
      this.scroll += (this.dragY - y);
      this.dragY = y;
      this.clamp();
    }
  }
  wheel(d, mx, my) {
    if (mx !== undefined && mx !== null && !this.inside(mx, my)) return false;
    this.scroll += d * this.rowH / 2;
    this.clamp();
    return true;
  }
}

// Single-line text entry matching the engine field protocol (mouseDown /
// key / char / tick / render + .focused for base Tab cycling), so host
// screens can just push instances into this.fields.
class NgField {
  constructor(x, y, w, h, o) {
    o = o || {};
    this.x = x | 0; this.y = y | 0;
    this.w = Math.max(40, w | 0); this.h = (h | 0) || 20;
    this.maxLength = Math.max(1, o.maxLength | 0 || 32);
    this.filter = typeof o.filter === "function" ? o.filter : null;
    this.placeholder = o.placeholder != null ? String(o.placeholder) : "";
    this.onChange = typeof o.onChange === "function" ? o.onChange : null;
    this.text = String(o.text != null ? o.text : "").slice(0, this.maxLength);
    this.cursor = this.text.length;
    this.view = 0;
    this.focused = !!o.focused;
    this.blink = 0;
    this._clip = 0;
  }
  setText(s, fire) {
    const t = String(s != null ? s : "").slice(0, this.maxLength);
    if (t === this.text) return;
    this.text = t;
    if (this.cursor > t.length) this.cursor = t.length;
    if (fire !== false && this.onChange) { try { this.onChange(t); } catch (e) {} }
  }
  inside(x, y) { return x >= this.x && x < this.x + this.w && y >= this.y && y < this.y + this.h; }
  mouseDown(x, y) {
    const h = this.inside(x, y);
    if (h && !this.focused) this.cursor = this.text.length; // tap to edit from the end
    this.focused = h;
    return h;
  }
  key(e) {
    if (!this.focused || !e) return false;
    const c = e.code;
    if (c === "Backspace") {
      if (this.cursor > 0) {
        const nc = this.cursor - 1; // setText clamps, so assign after
        this.setText(this.text.slice(0, nc) + this.text.slice(this.cursor));
        this.cursor = nc;
      }
      return true;
    }
    if (c === "Delete") {
      if (this.cursor < this.text.length) {
        this.setText(this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1));
      }
      return true;
    }
    if (c === "ArrowLeft") { if (this.cursor > 0) this.cursor--; return true; }
    if (c === "ArrowRight") { if (this.cursor < this.text.length) this.cursor++; return true; }
    if (c === "Home") { this.cursor = 0; return true; }
    if (c === "End") { this.cursor = this.text.length; return true; }
    if ((e.ctrlKey || e.metaKey) && c === "KeyV") { this._paste(); return true; }
    if (c === "Enter" || c === "NumpadEnter" || c === "Escape" || c === "Tab") return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return false; // printable keys arrive via char()
  }
  char(ch) {
    if (!this.focused) return false;
    if (typeof ch !== "string" || ch.length !== 1) return false;
    if (ch < " " || ch === "§") return false;
    if (this.filter && !this.filter(ch)) return false;
    if (this.text.length >= this.maxLength) return false;
    this.setText(this.text.slice(0, this.cursor) + ch + this.text.slice(this.cursor));
    this.cursor++;
    return true;
  }
  tick() { this.blink++; }
  _fixView(t) {
    try {
      const maxW = this.w - 10;
      if (this.cursor < this.view) this.view = this.cursor;
      while (this.view < this.cursor &&
          t.font.width(this.text.slice(this.view, this.cursor)) > maxW) this.view++;
      while (this.view > 0 &&
          t.font.width(this.text.slice(this.view)) <= maxW &&
          t.font.width(this.text.slice(this.view - 1, this.cursor)) <= maxW) this.view--;
    } catch (e) {}
  }
  render(t) {
    const x = this.x, y = this.y, w = this.w, h = this.h;
    t.rect(x, y, x + w, y + h, 0xFF000000);
    const bc = this.focused ? 0xFFFFFFFF : 0xFFA0A0A0;
    t.rect(x, y, x + w, y + 1, bc);
    t.rect(x, y + h - 1, x + w, y + h, bc);
    t.rect(x, y, x + 1, y + h, bc);
    t.rect(x + w - 1, y, x + w, y + h, bc);
    this._fixView(t);
    const maxW = Math.max(10, this.w - 10);
    const tx = x + 5, ty = y + Math.max(0, Math.floor((h - 9) / 2));
    if (!this.text && this.placeholder) {
      let ph = this.placeholder;
      try { ph = t.font ? t.font.trimToWidth(ph, maxW) : ph; } catch (e) {}
      try { t.text(ph, tx, ty, 0x707070, false); } catch (e) {}
    } else {
      let vis = this.text.slice(this.view);
      try { vis = t.font ? t.font.trimToWidth(vis, maxW) : vis; } catch (e) {}
      try { t.text(vis, tx, ty, 0xE0E0E0, false); } catch (e) {}
    }
    if (this.focused && Math.floor(this.blink / 6) % 2 === 0) {
      let cxp = tx;
      try { cxp = tx + t.font.width(this.text.slice(this.view, this.cursor)); } catch (e) {}
      t.rect(cxp, ty, cxp + 1, ty + 9, 0xFFFFFFFF);
    }
  }
  _paste() {
    const tok = ++this._clip;
    try {
      const p = navigator.clipboard && navigator.clipboard.readText && navigator.clipboard.readText();
      if (p && p.then) {
        p.then((s) => {
          if (tok !== this._clip || !this.focused) return;
          let ins = String(s || "").replace(/[\r\n\t]/g, "");
          if (this.filter) ins = ins.split("").filter(this.filter).join("");
          const room = Math.max(0, this.maxLength - this.text.length);
          ins = ins.slice(0, room);
          if (!ins) return;
          this.setText(this.text.slice(0, this.cursor) + ins + this.text.slice(this.cursor));
          this.cursor += ins.length;
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

// On-screen keyboard for touch players: canvas screens can't summon the OS
// keyboard, so screens that take text show this instead (always available,
// only auto-shown on touch). Letters/digits/space/_/-/., backspace, shift,
// Done (accept) and Hide. Host screens own one, forward mouseDown to it
// first, and render it last: kb.layout(W,H) each frame, then kb.render(t).
class NgKeyboard {
  constructor(o) {
    o = o || {};
    this.targetFn = typeof o.target === "function" ? o.target : () => null;
    this.onDone = typeof o.onDone === "function" ? o.onDone : null;
    this.visible = false;
    this.upper = false;
    this.keys = [];
  }
  rows() {
    const L = this.upper
      ? ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"]
      : ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
    return [
      ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
      L[0].split(""),
      L[1].split(""),
      ["⇪"].concat(L[2].split(""), ["⌫"]),
      ["_", "-", " ", ".", "Done", "Hide"],
    ];
  }
  layout(W, H) {
    this.keys = [];
    this._H = H;
    if (!this.visible) return;
    const gap = 4, margin = 8;
    const kh = Math.max(24, Math.min(34, Math.floor((H * 0.34) / 5)));
    const rows = this.rows();
    const maxN = Math.max.apply(null, rows.map((r) => r.length));
    const kw = Math.min(44, (W - margin * 2 + gap) / maxN - gap);
    const y0 = H - rows.length * (kh + gap) - 6;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      const rw = row.length * (kw + gap) - gap;
      let x = Math.floor((W - rw) / 2);
      const y = y0 + ri * (kh + gap);
      for (let ki = 0; ki < row.length; ki++) {
        let w = kw;
        const k = row[ki];
        if (k === " " || k === "Done") w = kw * 2 + gap; // wider space + done
        this.keys.push({ k, x, y, w, h: kh });
        x += w + gap;
      }
    }
  }
  render(t) {
    if (!this.visible || !this.keys.length) return;
    for (const k of this.keys) {
      try {
        const hi = (k.k === "Done");
        t.rect(k.x, k.y, k.x + k.w, k.y + k.h, hi ? 0xFF4A5A3A : 0xFF222222);
        const bc = hi ? 0xFF7CFC00 : 0xFFA0A0A0;
        t.rect(k.x, k.y, k.x + k.w, k.y + 1, bc);
        t.rect(k.x, k.y + k.h - 1, k.x + k.w, k.y + k.h, bc);
        t.rect(k.x, k.y, k.x + 1, k.y + k.h, bc);
        t.rect(k.x + k.w - 1, k.y, k.x + k.w, k.y + k.h, bc);
        const label = k.k === " " ? "space" : k.k;
        t.text(label, k.x + Math.floor(k.w / 2) - Math.floor(t.textWidth(label) / 2),
          k.y + Math.floor((k.h - 8) / 2), hi ? 0xFFFFFFFF : 0xE0E0E0, false);
      } catch (e) {}
    }
  }
  bounds() {
    let y = Infinity;
    for (const k of this.keys) if (k.y < y) y = k.y;
    return { y: y === Infinity ? 0 : y };
  }
  overlaps(x, y) {
    if (!this.visible) return false;
    for (const k of this.keys) {
      if (x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h) return true;
    }
    return false;
  }
  mouseDown(x, y) {
    if (!this.visible) return false;
    for (const k of this.keys) {
      if (x < k.x || x >= k.x + k.w || y < k.y || y >= k.y + k.h) continue;
      const f = this.targetFn();
      if (k.k === "Hide") { this.visible = false; return true; }
      if (k.k === "⇪") { this.upper = !this.upper; return true; }
      if (k.k === "Done") {
        try { this.onDone && this.onDone(); } catch (e) {}
        return true;
      }
      if (!f) return true;
      if (k.k === "⌫") { try { f.key({ code: "Backspace" }); } catch (e) {} return true; }
      try { f.char(k.k); } catch (e) {}
      return true;
    }
    return false;
  }
  // Rooms to shift up while the keyboard shows, so it never covers buttons:
  // regs = [{o, p: "y"|"h", base}]. Call applyTick() from the screen tick()
  // (after layout()) — returns the applied shift for nudging drawn text too.
  track(regs) { this._regs = Array.isArray(regs) ? regs : []; }
  shiftHeight() {
    try {
      if (!this.visible || !this.keys.length || !this._H) return 0;
      let maxB = 0;
      for (const k of this.keys) maxB = Math.max(maxB, k.y + k.h);
      return Math.max(0, this._H - maxB + 6);
    } catch (e) { return 0; }
  }
  // Shift needed to keep content ending at `bottom` fully above the keys.
  avoidShift(bottom) {
    try {
      if (!this.visible || !this.keys.length) return 0;
      let top = Infinity;
      for (const k of this.keys) top = Math.min(top, k.y);
      return Math.max(0, bottom - top + 4);
    } catch (e) { return 0; }
  }
  // Shift needed to keep the focused field visible, clamped so the
  // topmost tracked widget never leaves the top of the screen. Uniform
  // (relative layout is preserved, so widgets can't collide), and zero
  // when the keyboard is hidden — bottom action buttons may sit under the
  // keys while typing (standard mobile behavior; Done/Hide dismisses).
  fitShift(topFloor) {
    try {
      if (!this.visible) return 0;
      const f = this.targetFn && this.targetFn();
      if (!f) return 0;
      const top = this.bounds().y;
      if (!isFinite(top)) return 0;
      let baseB = null;
      let minBase = Infinity;
      for (const r of (this._regs || [])) {
        if (!r || !r.o) continue;
        if (typeof r.base === "number" && r.base < minBase) minBase = r.base;
        if (r.o === f && baseB == null && typeof r.base === "number") {
          baseB = r.base + (f.h || 20);
        }
      }
      if (baseB == null) baseB = (f.y || 0) + (this._lastS || 0) + (f.h || 20);
      let s = Math.max(0, baseB - top + 4);
      if (isFinite(minBase)) s = Math.min(s, Math.max(0, minBase - (topFloor == null ? 8 : topFloor)));
      this._lastS = s;
      return s;
    } catch (e) { return 0; }
  }
  // Hide bottom buttons the keyboard covers (restored on dismiss), so the
  // open keyboard never jumbles together with menu buttons. Buttons the
  // screen hides itself (e.g. Realms Leave) are left alone via _kbHide.
  hideCovered(btns) {
    try {
      if (!this.visible || !this.keys.length) {
        for (const b of (btns || [])) {
          if (b && b._kbHide) { b.visible = true; b._kbHide = false; }
        }
        return;
      }
      let top = Infinity;
      for (const k of this.keys) if (k.y < top) top = k.y;
      for (const b of (btns || [])) {
        if (!b) continue;
        const overlap = (b.y + (b.h || 20)) > top + 2;
        if (overlap && b.visible) { b.visible = false; b._kbHide = true; }
        else if (!overlap && b._kbHide) { b.visible = true; b._kbHide = false; }
      }
    } catch (e) {}
  }
  applyTick(s) {
    try { if (s == null) s = this.shiftHeight(); } catch (e) { s = 0; }
    try {
      for (const r of (this._regs || [])) {
        if (r && r.o) r.o[r.p] = r.base - s;
      }
    } catch (e) {}
    return s;
  }
  syncTouch(focused, x, y) {
    try {
      if (!globalThis.__mcTouchMode) return;
      if (focused) this.visible = true;
      else if (!this.overlaps(x, y)) this.visible = false;
    } catch (e) {}
  }
}

// Native text prompt (rename world, ...): field + OK/Cancel.
// opts: {title, initial, maxLength, filter, okLabel, cancelLabel}
// -> Promise<string|null> (null = cancelled), null when unharvestable.
function ngPromptClass() {
  const B = NGScreen;
  const Btn = NGButton;
  return class extends B {
    constructor(g, o) {
      super(g);
      this.background = "dirt";
      this._o = o;
    }
    init() {
      const o = this._o;
      const cx = Math.floor(this.width / 2);
      const y = Math.floor(this.height / 2);
      const w = Math.min(300, this.width - 32);
      const x = cx - Math.floor(w / 2);
      this._field = new NgField(x, y - 6, w, 20, {
        text: o.initial, maxLength: o.maxLength || 32, filter: o.filter || null,
      });
      this._field.focused = true;
      this.fields.push(this._field);
      const bw = Math.min(140, Math.floor((w - 8) / 2));
      this.buttons.push(new Btn(1, x, y + 26, bw, 20, o.okLabel,
        () => { o.done(this._field.text); }));
      this.buttons.push(new Btn(2, x + w - bw, y + 26, bw, 20, o.cancelLabel,
        () => { o.done(null); }));
    }
    key(e) {
      if (!e) return super.key(e);
      if (e.code === "Escape") { this._o.done(null); return true; }
      if (e.code === "Enter" || e.code === "NumpadEnter") {
        this._o.done(this._field.text); return true;
      }
      return super.key(e);
    }
    close() {
      try { this._o.done(null); } catch (e) {}
    }
  };
}
function ngPrompt(opts) {
  opts = opts || {};
  const o = {
    title: String(opts.title != null ? opts.title : ""),
    initial: String(opts.initial != null ? opts.initial : ""),
    maxLength: Math.max(1, opts.maxLength | 0 || 32),
    filter: typeof opts.filter === "function" ? opts.filter : null,
    okLabel: String(opts.okLabel || "OK"),
    cancelLabel: String(opts.cancelLabel || "Cancel"),
    done: null,
  };
  if (!ngHarvest()) return null;
  const g = globalThis.game;
  if (!g || !g.screens || !g.screens.current) return null;
  return new Promise((resolve) => {
    const P = ngPromptClass();
    const scr = new P(g, o);
    const rec = ngPush(scr);
    if (!rec) { try { resolve(null); } catch (e) {} return; }
    o.done = (v) => {
      if (ngTop() === rec) ngDismiss();
      else {
        const i = ngStack.indexOf(rec);
        if (i >= 0) ngStack.splice(i, 1);
      }
      try { resolve(v); } catch (e) {}
    };
  });
}

globalThis.__mcNativeGui = {
  confirm: ngConfirm,
  showDeath: ngShowDeath,
  dismiss: ngDismiss,
  closeScreen: ngCloseScreen,
  top: () => { try { const t = ngTop(); return t ? t.screen : null; } catch (e) { return null; } },
  open: ngOpenScreen,
  base: ngBase,
  button: ngButton,
  List: NgList,
  Field: NgField,
  Keyboard: NgKeyboard,
  prompt: ngPrompt,
  harvest: ngHarvest,
};
// Death can strike before any menu confirm ran, so harvest early: poll cheaply
// until the title screen is up (stops on its own once harvested).
if (!globalThis._ngHarvestPoll) {
  globalThis._ngHarvestPoll = setInterval(() => {
    try {
      if (ngHarvest()) {
        clearInterval(globalThis._ngHarvestPoll);
        globalThis._ngHarvestPoll = 0;
      }
    } catch (e) {}
  }, 500);
}
console.log("[native-gui] ready");
