'use strict';
// Action table + the single message listener. Every element action
// auto-waits, so agents rarely need an explicit wait step.
var BX = (typeof BX !== 'undefined' && BX) || {};

const A = {};
BX.A = A;

const opt = (a) => ({ speed: a.speed, timeout: a.timeout });

// What the action actually landed on: a ref for the rest of this batch, and a
// selector that will still mean the same thing next week. The bridge keys its
// per-site memory on the durable one, so acting through `ref=` still teaches it
// something.
// Six buttons can read "Comment"; only one of them submits. Acting on the
// best-ranked one and saying nothing about the other five is how a batch
// reports ok against the wrong element and the agent finds out from a
// screenshot. Say how many matched, and hand back refs for the runners-up so
// the correction is one `click ref=eN` rather than another discovery round.
const hit = (el) => {
  const h = { ref: BX.ref(el), sel: BX.durable(el) };
  if (!BX.actionable(el)) h.inert = true;
  const pool = BX.pool;
  if (pool && pool.length > 1 && pool[0] === el && !BX.deliberate) {
    h.n = pool.length;
    h.alt = pool.slice(1, 4).map((o) => ({
      ref: BX.ref(o), css: BX.cssPath(o), dis: BX.actionable(o) ? undefined : true
    }));
  }
  return h;
};

// ── pointer ──────────────────────────────────────────────────────────────
A.click = async (a) => {
  const el = await BX.want(a.target, opt(a));
  const r = await BX.clickAt(el, { speed: a.speed, button: a.button, clicks: a.clicks, mods: a.mods });
  return { ...hit(el), ...r };
};
A.dblclick = (a) => A.click({ ...a, clicks: 2 });
A.rclick = (a) => A.click({ ...a, button: 'right' });

A.hover = async (a) => {
  const el = await BX.want(a.target, opt(a));
  await BX.ensureVisible(el);
  const p = BX.pointIn(el);
  await BX.moveTo(p.x, p.y, a.speed);
  return { ...hit(el), at: [Math.round(p.x), Math.round(p.y)] };
};

A.move = async (a) => { await BX.moveTo(a.x, a.y, a.speed); return { at: [Math.round(BX.mouse.x), Math.round(BX.mouse.y)] }; };

A.clickAt = async (a) => {
  await BX.moveTo(a.x, a.y, a.speed);
  const el = BX.at(a.x, a.y);
  if (!el) BX.fail(`nothing at ${a.x},${a.y}`);
  return BX.clickAt(el, { speed: a.speed, point: { x: a.x, y: a.y }, button: a.button, clicks: a.clicks });
};

A.drag = async (a) => {
  const from = a.target ? await BX.want(a.target, opt(a)) : null;
  const p0 = from ? (await BX.ensureVisible(from), BX.pointIn(from)) : { x: a.x0, y: a.y0 };
  const to = a.to ? await BX.want(a.to, opt(a)) : null;
  const p1 = to ? (await BX.ensureVisible(to), BX.pointIn(to)) : { x: a.x1, y: a.y1 };
  await BX.moveTo(p0.x, p0.y, a.speed);
  const src = BX.at(p0.x, p0.y);
  BX.mouse.down = true;
  BX.fire(src, 'pointerdown', p0.x, p0.y, { buttons: 1 });
  BX.fire(src, 'mousedown', p0.x, p0.y, { buttons: 1, detail: 1 });
  await BX.sleep(30);
  await BX.moveTo(p1.x, p1.y, a.speed === 'instant' ? 'fast' : a.speed);
  const dst = BX.at(p1.x, p1.y);
  BX.mouse.down = false;
  BX.fire(dst, 'pointerup', p1.x, p1.y, { buttons: 0 });
  BX.fire(dst, 'mouseup', p1.x, p1.y, { buttons: 0, detail: 1 });
  return { from: [Math.round(p0.x), Math.round(p0.y)], to: [Math.round(p1.x), Math.round(p1.y)] };
};

// ── input ────────────────────────────────────────────────────────────────
A.type = async (a) => {
  const el = await BX.want(a.target, opt(a));
  if (a.focus !== 'direct') await BX.clickAt(el, { speed: a.speed });
  else { await BX.ensureVisible(el); try { el.focus({ preventScroll: true }); } catch {} }
  const r = await BX.typeInto(el, a.text, { speed: a.speed, clear: a.clear });
  if (a.enter) await BX.pressKey(el, 'Enter');
  return { ...hit(el), ...r };
};

A.setval = async (a) => { const el = await BX.want(a.target, opt(a)); BX.setValue(el, a.value); return hit(el); };
A.clear  = async (a) => { const el = await BX.want(a.target, opt(a)); BX.clearField(el); return hit(el); };
A.focus  = async (a) => { const el = await BX.want(a.target, opt(a)); await BX.ensureVisible(el); el.focus({ preventScroll: true }); return hit(el); };
A.press  = async (a) => {
  const el = a.target ? await BX.want(a.target, opt(a)) : document.activeElement;
  for (const k of [].concat(a.keys || a.key)) { await BX.pressKey(el, k); await BX.sleep(BX.prof(a.speed).key()); }
  return { keys: [].concat(a.keys || a.key) };
};

// One round trip for a whole form. Values are typed unless `fast` is set.
A.fill = async (a) => {
  const out = [];
  // A flat 3s per field meant a six-field form could sit for eighteen seconds
  // before reporting a single miss. Share the action's budget instead.
  const entries = Object.entries(a.fields);
  const per = Math.max(800, Math.floor((a.timeout ?? BX.cfg.timeout) / Math.max(1, entries.length)));
  for (const [sel, val] of entries) {
    try {
      const el = await BX.want(sel, { timeout: per });
      if (el.tagName === 'SELECT') { await A.select({ target: sel, value: val }); out.push({ sel, ok: true, as: 'select' }); continue; }
      if (el.type === 'checkbox' || el.type === 'radio') {
        const want = val === true || val === 'true' || val === 1;
        if (el.checked !== want) await BX.clickAt(el, { speed: a.speed });
        out.push({ sel, ok: true, as: 'check' }); continue;
      }
      if (a.fast) { try { el.focus({ preventScroll: true }); } catch {} BX.setValue(el, String(val)); }
      else await A.type({ target: sel, text: String(val), speed: a.speed, clear: true });
      out.push({ sel, ok: true });
    } catch (e) {
      out.push({ sel, ok: false, error: String(e.message || e) });
      if (a.stopOnError) break;
    }
  }
  const filled = out.filter((o) => o.ok).length;
  // Nothing matched here — let the worker try the other frames with the whole form.
  if (!filled && out.every((o) => /BX_NOTFOUND/.test(o.error || ''))) BX.notfound(Object.keys(a.fields)[0]);
  return { filled, of: out.length, detail: out };
};

A.select = async (a) => {
  const el = await BX.want(a.target, opt(a));
  if (el.tagName !== 'SELECT') BX.fail('not a <select>');
  const want = String(a.value);
  const o = [...el.options].find((x) => x.value === want)
        || [...el.options].find((x) => x.label === want || x.text.trim() === want)
        || [...el.options].find((x) => x.text.toLowerCase().includes(want.toLowerCase()));
  if (!o) BX.fail(`no option "${want}" in ${[...el.options].map((x) => x.text.trim()).slice(0, 12).join(' | ')}`);
  await BX.ensureVisible(el);
  el.focus({ preventScroll: true });
  el.value = o.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ...hit(el), value: o.value, text: o.text.trim() };
};

const setChecked = async (a, want) => {
  const el = await BX.want(a.target, opt(a));
  const cur = el.checked ?? el.getAttribute('aria-checked') === 'true';
  if (cur !== want) await BX.clickAt(el, { speed: a.speed });
  return { ...hit(el), checked: want };
};
A.check = (a) => setChecked(a, true);
A.uncheck = (a) => setChecked(a, false);

// ── scrolling ────────────────────────────────────────────────────────────
A.scroll = async (a) => {
  const box = a.target ? await BX.want(a.target, opt(a)) : null;
  if (a.into || (box && a.to === undefined && a.by === undefined)) {
    await BX.ensureVisible(box);
    return { scrolled: 'into-view', y: Math.round(scrollY) };
  }
  const scroller = box || document.scrollingElement || document.documentElement;
  const maxY = scroller.scrollHeight - scroller.clientHeight;
  let dx = 0, dy = 0;
  if (a.by) { dx = a.by[0] || 0; dy = a.by[1] ?? a.by; }
  else if (a.to === 'bottom') dy = maxY - scroller.scrollTop;
  else if (a.to === 'top') dy = -scroller.scrollTop;
  else if (typeof a.to === 'number') dy = a.to - scroller.scrollTop;
  else dy = Math.round((scroller.clientHeight || innerHeight) * 0.85);

  const target = BX.at(BX.mouse.x, BX.mouse.y) || scroller;
  const steps = a.speed === 'instant' ? 1 : Math.max(1, Math.min(14, Math.ceil(Math.abs(dy) / 220)));
  const chunk = dy / steps;
  for (let i = 0; i < steps; i++) {
    target.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view: window,
      deltaX: dx / steps, deltaY: chunk, deltaMode: 0,
      clientX: BX.mouse.x, clientY: BX.mouse.y
    }));
    scroller.scrollBy ? scroller.scrollBy(dx / steps, chunk) : (scroller.scrollTop += chunk);
    if (steps > 1) await BX.sleep(10 + Math.random() * 18);
  }
  await BX.sleep(a.settle ?? (a.speed === 'instant' ? 0 : 60));
  return { y: Math.round(scroller.scrollTop), max: Math.round(maxY), atBottom: scroller.scrollTop >= maxY - 2 };
};

// ── reading ──────────────────────────────────────────────────────────────
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME', 'CANVAS']);

const toMd = (root) => {
  const out = [];
  const walk = (n, depth) => {
    if (!n || depth > 40) return;
    if (n.nodeType === 3) { const t = n.textContent.replace(/\s+/g, ' '); if (t.trim()) out.push(t); return; }
    if (n.nodeType !== 1 || SKIP.has(n.tagName)) return;
    const st = n.ownerDocument.defaultView?.getComputedStyle(n);
    if (st && (st.display === 'none' || st.visibility === 'hidden')) return;
    const tag = n.tagName;
    if (/^H[1-6]$/.test(tag)) { out.push(`\n\n${'#'.repeat(+tag[1])} ${n.innerText.trim()}\n`); return; }
    if (tag === 'A' && n.href) { const t = n.innerText.trim(); if (t) out.push(`[${t}](${n.href})`); return; }
    if (tag === 'LI') { out.push(`\n- `); }
    if (tag === 'BR') { out.push('\n'); return; }
    if (tag === 'IMG') { if (n.alt) out.push(`![${n.alt}]`); return; }
    if (/^(P|DIV|SECTION|ARTICLE|UL|OL|TR|TABLE|HEADER|FOOTER|MAIN|NAV|FORM|BLOCKQUOTE)$/.test(tag)) out.push('\n');
    for (const c of n.childNodes) walk(c, depth + 1);
    if (/^(P|DIV|SECTION|ARTICLE|UL|OL|TR|TABLE|BLOCKQUOTE)$/.test(tag)) out.push('\n');
  };
  walk(root, 0);
  return out.join(' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

A.read = async (a) => {
  const el = a.target ? await BX.want(a.target, opt(a)) : (document.body || document.documentElement);
  const mode = a.mode || 'md';
  let text;
  if (mode === 'html') text = a.outer ? el.outerHTML : el.innerHTML;
  else if (mode === 'text') text = el.innerText || el.textContent || '';
  else if (mode === 'links') {
    return { links: BX.qsa('a[href]').filter(BX.visible).slice(0, a.max || 300).map((x) => ({ text: x.innerText.replace(/\s+/g, ' ').trim().slice(0, 80), href: x.href })) };
  } else text = toMd(el);
  const cap = a.max || 40000;
  return {
    title: document.title,
    url: location.href,
    len: text.length,
    truncated: text.length > cap || undefined,
    text: text.slice(0, cap)
  };
};

A.elements = async (a) => {
  const sel = a.filter || BX.INTERACTIVE;
  const seen = new Set();
  const out = [];
  let scanned = 0;
  for (const el of BX.qsa(sel)) {
    if (++scanned > 6000) break;   // pathological page — report what we have
    if (seen.has(el) || !BX.visible(el)) continue;
    seen.add(el);
    if (a.viewport !== false && !BX.inView(el)) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -400 || r.top > innerHeight + 1200) continue;
    }
    out.push(BX.describe(el));
    if (out.length >= (a.max || 150)) break;
  }
  return { url: location.href, title: document.title, n: out.length, elements: out };
};

A.exists = async (a) => {
  try { const el = await BX.want(a.target, { timeout: a.timeout ?? 0 }); return { exists: true, ...BX.describe(el), ...hit(el) }; }
  catch { return { exists: false }; }
};

A.box = async (a) => {
  const el = await BX.want(a.target, opt(a));
  await BX.ensureVisible(el);
  const r = el.getBoundingClientRect();
  return { ref: BX.ref(el), x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio, css: BX.cssPath(el) };
};

A.path = async (a) => { const el = await BX.want(a.target, opt(a)); return { css: BX.cssPath(el), ...hit(el) }; };

A.info = async () => ({
  url: location.href, title: document.title,
  ready: document.readyState,
  scroll: [Math.round(scrollX), Math.round(scrollY)],
  size: [innerWidth, innerHeight],
  page: [Math.round(document.documentElement.scrollWidth), Math.round(document.documentElement.scrollHeight)],
  mouse: [Math.round(BX.mouse.x), Math.round(BX.mouse.y)]
});

// ── waiting ──────────────────────────────────────────────────────────────
A.wait = async (a) => {
  const t0 = Date.now();
  const deadline = t0 + (a.timeout ?? BX.cfg.timeout);
  if (a.ms) { await BX.sleep(a.ms); return { waited: a.ms }; }
  let gap = 20;
  for (;;) {
    const p0 = performance.now();
    if (a.for) { const el = BX.find(a.for); if (el) return { waited: Date.now() - t0, ...hit(el) }; }
    else if (a.gone) { if (!BX.find(a.gone)) return { waited: Date.now() - t0 }; }
    else if (a.text) { if ((document.body?.innerText || '').toLowerCase().includes(String(a.text).toLowerCase())) return { waited: Date.now() - t0 }; }
    else if (a.load) { if (document.readyState === 'complete') return { waited: Date.now() - t0 }; }
    else return { waited: 0 };
    const left = deadline - Date.now();
    if (left <= 0) BX.fail(`wait timed out after ${Date.now() - t0}ms`);
    // Back off in step with what the check costs, so waiting on a heavy page
    // leaves that page's main thread free to actually produce the thing.
    gap = Math.min(400, Math.max(gap * 1.3, performance.now() - p0));
    await BX.sleep(Math.min(gap, left));
  }
};

// ── listener ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (!msg || msg.__bx !== 1) return;
  if (msg.cfg) Object.assign(BX.cfg, msg.cfg);
  if (msg.ping) { respond({ ok: true, r: { alive: true, top: window === top, url: location.href } }); return true; }
  const fn = A[msg.a && msg.a.a];
  if (!fn) { respond({ ok: false, e: `unknown action: ${msg.a && msg.a.a}` }); return true; }
  Promise.resolve()
    .then(() => fn(msg.a))
    .then((r) => respond({ ok: true, r }))
    .catch((e) => respond({ ok: false, e: String((e && e.message) || e) }));
  return true;
});
