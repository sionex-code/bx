'use strict';
// Isolated world. Nothing here touches the page's global scope, and no
// attributes are ever written to the DOM — element identity is held in a
// WeakRef map so a page can never fingerprint us by walking its own tree.
var BX = (typeof BX !== 'undefined' && BX) || {};

BX.cfg = { speed: 'fast', trusted: false, timeout: 8000 };

BX.PROFILES = {
  instant: { px: 1e9, maxSteps: 1, curve: 0,    dur: () => 0,                       press: () => 0,  key: () => 0,               overshoot: false, think: false },
  fast:    { px: 22,  maxSteps: 14, curve: 0.06, dur: (d) => 18 + Math.sqrt(d) * 2.2, press: () => 6 + Math.random() * 10, key: () => 3 + Math.random() * 6,  overshoot: false, think: false },
  human:   { px: 8,   maxSteps: 48, curve: 0.14, dur: (d) => 90 + Math.sqrt(d) * 9,   press: () => 45 + Math.random() * 70, key: () => 55 + Math.random() * 110, overshoot: true,  think: true }
};
// Chrome throttles timers to ~1Hz in hidden tabs, which would turn a curved
// mouse path into a 30-second crawl. Nothing is watching a background tab
// anyway, so drop to instant there.
BX.prof = (s) => {
  if (document.visibilityState === 'hidden') return BX.PROFILES.instant;
  return BX.PROFILES[s || BX.cfg.speed] || BX.PROFILES.fast;
};

BX.sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
BX.gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) / 3;
  return Math.max(-1, Math.min(1, g));
};

BX.fail = (msg) => { const e = new Error(msg); e.bx = true; throw e; };
BX.notfound = (t) => BX.fail(`BX_NOTFOUND ${typeof t === 'string' ? t : JSON.stringify(t)}`);

// ── refs ─────────────────────────────────────────────────────────────────
BX.refs = new Map();      // ref -> WeakRef(el)
BX.refOf = new WeakMap();  // el -> ref. Without this, describing 150 elements
BX.refN = 0;               // meant 150 linear scans of the whole ref table.
BX.ref = (el) => {
  const known = BX.refOf.get(el);
  if (known && BX.refs.has(known)) return known;
  const k = 'e' + ++BX.refN;
  BX.refs.set(k, new WeakRef(el));
  BX.refOf.set(el, k);
  if (BX.refs.size > 3000) BX.refs.delete(BX.refs.keys().next().value);
  return k;
};
BX.deref = (k) => {
  const w = BX.refs.get(k);
  const el = w && w.deref();
  return el && el.isConnected ? el : null;
};

// ── visibility ───────────────────────────────────────────────────────────
// getComputedStyle per element is the single most expensive thing a page-wide
// scan can do. checkVisibility (Chrome 105+) answers display/visibility/opacity
// /content-visibility in one native call, so a scan that used to cost hundreds
// of milliseconds costs a few.
BX.visible = (el) => {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  if (el.checkVisibility) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return !el.closest('[inert]');
  }
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.visibility === 'collapse' || s.display === 'none') return false;
  if (parseFloat(s.opacity) === 0) return false;
  if (el.closest('[inert]')) return false;
  return true;
};

// A control that is disabled cannot be clicked, so it is not a candidate while
// a live one is on the page. aria-disabled counts as much as the property:
// design systems (LinkedIn's artdeco, MUI, Ant) keep the button focusable and
// mark it only in ARIA, so a property-only check silently picks the dead one.
BX.actionable = (el) => {
  if (!el || el.nodeType !== 1) return false;
  // :disabled is the browser's own answer. The .disabled property only
  // reflects the attribute, so it reads false for a control that is disabled
  // by an ancestor <fieldset disabled> — which the page still refuses to click.
  if (el.disabled || el.matches?.(':disabled')) return false;
  if (el.getAttribute?.('aria-disabled') === 'true') return false;
  return !el.closest?.('[aria-disabled="true"],[inert],fieldset[disabled]');
};

BX.textOf = (el) => {
  if (!el) return '';
  const t =
    el.getAttribute?.('aria-label') ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    (el.tagName === 'INPUT' && (el.value || el.placeholder)) ||
    el.innerText ||
    el.getAttribute?.('title') ||
    el.getAttribute?.('alt') ||
    el.getAttribute?.('placeholder') ||
    el.getAttribute?.('name') ||
    '';
  return String(t).replace(/\s+/g, ' ').trim();
};

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── deep query (pierces open shadow roots) ───────────────────────────────
// Walking every element looking for shadow roots is O(page). BX.want polls
// several times a second, so the result is cached for a beat — long enough to
// stop the poll loop from re-walking the document on every tick, short enough
// that a shadow root added by the page is picked up almost immediately.
let rootsCache = null, rootsAt = 0;
BX.roots = () => {
  const ttl = rootsCache && rootsCache.length === 1 ? 1200 : 400;
  if (rootsCache && Date.now() - rootsAt < ttl) return rootsCache;
  const out = [document];
  const walk = (root) => {
    let it;
    try { it = root.querySelectorAll('*'); } catch { return; }
    for (const el of it) if (el.shadowRoot) { out.push(el.shadowRoot); walk(el.shadowRoot); }
  };
  try { walk(document); } catch {}
  rootsCache = out; rootsAt = Date.now();
  return out;
};

BX.qsa = (sel, deep) => {
  const out = [];
  try { out.push(...document.querySelectorAll(sel)); }
  catch {
    // :has-text() and friends are Playwright, not CSS. Agents reach for them
    // constantly, and "bad selector" alone never told anyone what to do next.
    const pw = /:(has-text|text|nth-match|visible|is-visible)\b/.exec(sel);
    BX.fail(pw
      ? `bad selector: ${sel} — ${pw[0]} is Playwright syntax, not CSS. Use text=… or {"sel":"…","has":"…"}`
      : `bad selector: ${sel}`);
  }
  if (deep !== false && out.length === 0) {
    for (const r of BX.roots()) { if (r === document) continue; try { out.push(...r.querySelectorAll(sel)); } catch {} }
  }
  return out;
};

// Custom checkboxes and radios hide the real <input> (opacity 0, or a
// 1px box) and draw a styled <label> instead, so the input never passes the
// visibility check and the option vanishes from the list — Fiverr's "Seller
// lives in: Pakistan" was one. The label is what a person clicks; list it.
BX.INTERACTIVE = 'label:has(input[type=checkbox]),label:has(input[type=radio]),a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';

// ── text lookup ──────────────────────────────────────────────────────────
// This used to scan every div and span on the page, calling getComputedStyle
// and innerText on each. On a heavy app that is a few hundred milliseconds a
// pass, and BX.want repeats the pass until the deadline — enough to peg the
// page's main thread for the whole eight seconds and make the tab feel hung.
// Now: one cheap prefilter over the clickable set, then a single walk of the
// text nodes, and only real candidates pay for layout.
const TEXT_ATTRS = ['aria-label', 'title', 'alt', 'placeholder', 'name'];

const attrHit = (el, want) => {
  if (!el.getAttribute) return false;
  for (const a of TEXT_ATTRS) { const v = el.getAttribute(a); if (v && norm(v).includes(want)) return true; }
  if (el.tagName === 'INPUT' && el.value && norm(el.value).includes(want)) return true;
  return false;
};

BX.byText = (want) => {
  if (!want) return [];
  const exact = [], part = [], seen = new Set();
  const consider = (el) => {
    if (!el || el.nodeType !== 1 || seen.has(el)) return;
    // Clicking <body> is never what anyone meant, and on a short page its own
    // text is small enough to slip past the length guard below.
    if (el === document.body || el === document.documentElement) return;
    seen.add(el);
    if (!BX.visible(el)) return;
    const n = norm(BX.textOf(el));
    if (!n) return;
    if (n === want) exact.push(el);
    else if (n.includes(want) && n.length < want.length + 90) part.push(el);
  };
  // textContent is layout-free and already concatenates inline children, so it
  // is a safe gate in front of the innerText + visibility check.
  const cheapHit = (el) => {
    const tc = el.textContent;
    return (tc && tc.length <= 4096 && norm(tc).includes(want)) || attrHit(el, want);
  };

  // 1 — the things a person actually clicks, plus nearby labels and cells.
  for (const el of BX.qsa(BX.INTERACTIVE + ',label,td,th,li,h1,h2,h3,h4,h5,h6', false)) {
    if (cheapHit(el)) consider(el);
  }

  // 2 — plain text anywhere else, from one pass over the document's text nodes.
  if (!exact.length) {
    const root = document.body || document.documentElement;
    const head = want.split(' ')[0];
    if (root) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n, guard = 0;
      while ((n = w.nextNode()) && guard++ < 60000) {
        const v = n.nodeValue;
        if (!v || v.length > 4096) continue;
        const nv = norm(v);
        if (!nv) continue;
        if (nv.includes(want)) { consider(n.parentElement); continue; }
        // Phrase split across inline children: no single node holds all of it,
        // so let the nearest few ancestors of a first-word hit answer for it.
        if (head && nv.includes(head)) {
          let p = n.parentElement;
          for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
            const tc = p.textContent;
            if (!tc || tc.length > want.length + 400) break;  // outgrown the phrase
            consider(p);
          }
        }
      }
    }
  }

  // 3 — shadow DOM, only once the light DOM has come up empty.
  if (!exact.length && !part.length) {
    for (const r of BX.roots()) {
      if (r === document) continue;
      let els; try { els = r.querySelectorAll('*'); } catch { continue; }
      for (const el of els) if (cheapHit(el)) consider(el);
    }
  }

  const pool = exact.length ? exact : part;
  // innermost match wins — avoids grabbing a wrapper <div> over its button
  return pool.filter((el) => !pool.some((o) => o !== el && el.contains(o)));
};

const OBJ_KEYS = new Set(['sel', 'nth', 'has', 'near']);

// Closest to an anchor first. Gap between rectangles rather than centre
// distance, so a small button sitting inside the anchor's own container beats
// a large one whose middle happens to be nearer.
// Set when the target itself chose the winner, so a deliberate pick is not
// reported as an ambiguous one. A warning that fires on a target the agent
// just disambiguated is the kind that gets ignored on the target where it
// actually matters.
BX.deliberate = false;
const nearest = (list, anchor) => {
  BX.deliberate = true;
  const a = BX.candidates(anchor).filter(BX.visible)[0];
  if (!a) BX.notfound(anchor);
  const r = a.getBoundingClientRect();
  const gap = (el) => {
    const b = el.getBoundingClientRect();
    const dx = Math.max(r.left - b.right, b.left - r.right, 0);
    const dy = Math.max(r.top - b.bottom, b.top - r.bottom, 0);
    return Math.hypot(dx, dy);
  };
  return list.filter((el) => el !== a)
    .map((el) => [el, gap(el)])
    .sort((x, y) => x[1] - y[1])
    .map((x) => x[0]);
};

// ── target resolution ────────────────────────────────────────────────────
// Accepts: "css", "text=Sign in", "ref=e12", "xpath=//div", "role=button:Save",
// "placeholder=Email", "label=Password", "name=q", or {sel, nth, has, near}.
BX.candidates = (target) => {
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    // A typo used to fall through as "no filter" and match the whole document,
    // which then clicked something arbitrary and called it a success.
    const bad = Object.keys(target).filter((k) => !OBJ_KEYS.has(k));
    if (bad.length) BX.fail(`unknown target key: ${bad.join(', ')} (use ${[...OBJ_KEYS].join(', ')})`);
    let list = target.sel ? BX.candidates(target.sel) : BX.qsa('*');
    if (target.has) list = list.filter((el) => norm(BX.textOf(el)).includes(norm(target.has)));
    if (target.near) list = nearest(list, target.near);
    if (typeof target.nth === 'number') list = list[target.nth] ? [list[target.nth]] : [];
    return list;
  }
  const t = String(target);
  const eq = t.indexOf('=');
  const kind = eq > 0 ? t.slice(0, eq) : '';
  const arg = eq > 0 ? t.slice(eq + 1) : t;

  switch (kind) {
    case 'ref': {
      const el = BX.deref(arg);
      return el ? [el] : [];
    }
    case 'xpath': {
      const out = [];
      const r = document.evaluate(arg, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
      return out;
    }
    case 'text': return BX.byText(norm(arg));
    case 'role': {
      const [role, name] = arg.split(':');
      const out = [];
      for (const el of BX.qsa(`[role="${role}"],${role === 'button' ? 'button,input[type=submit],input[type=button]' : role === 'link' ? 'a[href]' : role === 'textbox' ? 'input[type=text],input:not([type]),textarea' : role === 'checkbox' ? 'input[type=checkbox]' : ':not(*)'}`)) {
        if (!BX.visible(el)) continue;
        if (name && !norm(BX.textOf(el)).includes(norm(name))) continue;
        out.push(el);
      }
      return out;
    }
    case 'placeholder': return BX.qsa(`[placeholder]`).filter((el) => norm(el.getAttribute('placeholder')).includes(norm(arg)));
    case 'name':        return BX.qsa(`[name="${CSS.escape(arg)}"]`);
    case 'label': {
      const want = norm(arg);
      const out = [];
      for (const l of BX.qsa('label')) {
        if (!norm(l.innerText).includes(want)) continue;
        const c = (l.htmlFor && document.getElementById(l.htmlFor)) || l.querySelector('input,textarea,select');
        if (c) out.push(c);
      }
      for (const el of BX.qsa('[aria-label]')) if (norm(el.getAttribute('aria-label')).includes(want)) out.push(el);
      return out;
    }
    default: return BX.qsa(t);
  }
};

// Every candidate the target resolves to, best first: visible over hidden,
// actionable over inert, document order within a rank. A page that shows six
// "Comment" buttons keeps five of them disabled, and the live one is rarely
// the first in the tree — taking pool[0] off an unranked list is how an action
// reports success against the wrong element.
BX.matches = (target, opt = {}) => {
  const list = BX.candidates(target);
  const vis = list.filter(BX.visible);
  const pool = vis.length ? vis : opt.anyVisibility ? list : [];
  if (pool.length < 2) return pool;
  const live = pool.filter(BX.actionable);
  // Everything inert is a real answer worth returning — bx exists / box on a
  // disabled button has to keep working — so rank it, never drop it.
  if (!live.length || live.length === pool.length) return pool;
  const set = new Set(live);
  return live.concat(pool.filter((el) => !set.has(el)));
};

// The pool behind the last resolution, so an action can say what else matched.
BX.pool = [];
BX.find = (target, opt = {}) => {
  BX.deliberate = false;
  const pool = BX.matches(target, opt);
  BX.pool = pool;
  return pool[0] || null;
};

// Auto-wait: every element action polls until the node exists and is visible.
// The gap between polls grows with how long the search itself took, so a miss
// on a heavy page can never use more than about half the main thread — the old
// fixed 30ms gap meant back-to-back searches and a visibly frozen tab.
BX.want = async (target, opt = {}) => {
  const deadline = Date.now() + (opt.timeout ?? BX.cfg.timeout);
  let gap = 16;
  for (;;) {
    const t0 = performance.now();
    const el = BX.find(target, opt);
    if (el) return el;
    const cost = performance.now() - t0;
    const left = deadline - Date.now();
    if (left <= 0) BX.notfound(target);
    gap = Math.min(400, Math.max(gap * 1.3, cost));
    await BX.sleep(Math.min(gap, left));
  }
};

// ── geometry ─────────────────────────────────────────────────────────────
BX.inView = (el) => {
  const r = el.getBoundingClientRect();
  const h = innerHeight || document.documentElement.clientHeight;
  const w = innerWidth || document.documentElement.clientWidth;
  return r.top >= 0 && r.left >= 0 && r.bottom <= h && r.right <= w && r.width > 0 && r.height > 0;
};

BX.ensureVisible = async (el) => {
  if (BX.inView(el)) return;
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
  catch { el.scrollIntoView(true); }
  await BX.sleep(BX.cfg.speed === 'instant' ? 0 : 16);
};

// Unique-ish CSS path, used to hand an element to CDP by selector.
BX.cssPath = (el) => {
  if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 12) {
    let p = n.tagName.toLowerCase();
    if (n.id && document.querySelectorAll(`#${CSS.escape(n.id)}`).length === 1) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
    const par = n.parentNode;
    if (par && par.children) {
      const same = [...par.children].filter((c) => c.tagName === n.tagName);
      if (same.length > 1) p += `:nth-of-type(${same.indexOf(n) + 1})`;
    }
    parts.unshift(p);
    n = par && par.nodeType === 1 ? par : null;
  }
  return parts.join(' > ');
};

// A ref is worth nothing tomorrow: it names a node in one snapshot of one
// page. When an agent acts on a ref, the memory layer still needs a handle it
// can hand back next session, so every element action reports the most durable
// selector that resolves to what it actually hit. Cheapest-first, and each
// candidate is confirmed unique before it is trusted.
const qval = (v) => String(v).replace(/["\\]/g, '\\$&');
const DATA_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-automation-id'];
// Framework-generated ids (React's :r3:, hash suffixes, long digit runs) look
// stable for exactly one page load.
const stableId = (v) => v && v.length < 40 && !/\d{4,}|[0-9a-f]{8,}|^:r[0-9a-z]+:$/i.test(v);

BX.durable = (el) => {
  if (!el || el.nodeType !== 1) return undefined;
  const one = (sel) => { try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch { return null; } };
  const at = (n) => el.getAttribute && el.getAttribute(n);

  if (el.id && stableId(el.id)) { const s = one('#' + CSS.escape(el.id)); if (s) return s; }
  for (const a of DATA_ATTRS) { const v = at(a); if (v) { const s = one(`[${a}="${qval(v)}"]`); if (s) return s; } }
  const nm = at('name');
  if (nm) {
    const s = one(`[name="${qval(nm)}"]`);
    if (s) return s;
    // Radios and checkboxes share a name by design; the value tells them apart.
    const v = at('value');
    if (v) { const s2 = one(`[name="${qval(nm)}"][value="${qval(v)}"]`); if (s2) return s2; }
  }
  const al = at('aria-label');
  if (al && al.length < 60) { const s = one(`[aria-label="${qval(al)}"]`); if (s) return s; }
  const ph = at('placeholder');
  if (ph && ph.length < 60) { const s = one(`[placeholder="${qval(ph)}"]`); if (s) return s; }
  // Visible text outlives every markup reshuffle a site ships.
  const tag = el.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
    const t = BX.textOf(el);
    if (t.length >= 2 && t.length <= 40) return 'text=' + t;
  }
  const href = tag === 'A' && at('href');
  if (href && href.length < 90) { const s = one(`a[href="${qval(href)}"]`); if (s) return s; }
  return BX.cssPath(el);
};

// Which part of the page an element lives in. Without this an agent sees
// Wikipedia's "Read" and "Edit" tabs as interchangeable with the links in the
// article, and spends its whole budget flipping between them. The walk goes
// innermost-first on purpose: a link in a <nav> inside <main> is navigation.
BX.region = (el) => {
  for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
    const tag = n.tagName;
    const role = (n.getAttribute && n.getAttribute('role') || '').toLowerCase();
    const id = n.id || '';
    if (tag === 'NAV' || role === 'navigation' || role === 'tablist' || role === 'menubar') return 'navigation';
    if (tag === 'HEADER' || role === 'banner') return 'header';
    if (tag === 'FOOTER' || role === 'contentinfo') return 'footer';
    if (tag === 'ASIDE' || role === 'complementary') return 'sidebar';
    if (tag === 'DIALOG' || role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (tag === 'FORM') return 'form';
    if (tag === 'MAIN' || tag === 'ARTICLE' || role === 'main' || id === 'content' || id === 'main' || id === 'mw-content-text') return 'main content';
  }
  return undefined;
};

BX.describe = (el) => ({
  ref: BX.ref(el),
  tag: el.tagName.toLowerCase(),
  type: el.getAttribute?.('type') || undefined,
  role: el.getAttribute?.('role') || undefined,
  name: BX.textOf(el).slice(0, 90) || undefined,
  value: 'value' in el && el.value !== undefined && el.type !== 'password' ? String(el.value).slice(0, 60) : undefined,
  box: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
  vis: BX.inView(el) || undefined,
  dis: BX.actionable(el) ? undefined : true
});
