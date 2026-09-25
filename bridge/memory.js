'use strict';
// Per-site memory.
//
// The bridge already sees every action and every outcome, so learning costs the
// agent nothing: it struggles through a login once, and the next time it lands
// on that host the working selectors, the traps it hit, and the whole flow come
// back to it unasked. Nothing here is load-bearing — an unwritable memory
// directory degrades silently to plain bx.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.BX_HOME || path.join(os.homedir(), '.bx');
const DIR = path.join(HOME, 'memory');

const CAP = { notes: 40, traces: 14, traps: 24, sel: 240, recipes: 60, steps: 40, tail: 40 };

// Actions that move the tab: their result names the host everything after them
// belongs to.
const NAV = new Set(['nav', 'newtab', 'tab', 'back', 'forward', 'reload']);
// Actions that change something. A batch of pure reads is not a "solution".
const WORTH = new Set(['click', 'dblclick', 'rclick', 'type', 'fill', 'select', 'check', 'uncheck', 'press', 'upload', 'drag', 'setval']);
// What is worth keeping inside a stored flow — drops shots, reads, els, info.
const KEEP = new Set([...WORTH, 'nav', 'newtab', 'tab', 'back', 'forward', 'reload', 'wait', 'scroll', 'hover', 'focus', 'clear', 'sleep', 'eval']);
// Element actions whose target is worth scoring.
const TARGETED = new Set(['click', 'dblclick', 'rclick', 'hover', 'type', 'setval', 'clear', 'focus', 'select', 'check', 'uncheck', 'upload', 'drag', 'scroll']);

const SECRETISH = /pass|pwd|secret|token|otp|code|cvv|card|ssn|pin|auth|key|session|bearer/i;

// ── paths / hosts ────────────────────────────────────────────────────────
const hostOf = (u) => {
  try {
    const x = new URL(String(u));
    if (!/^https?:$/.test(x.protocol)) return null;
    return x.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch { return null; }
};

const pathOf = (u) => {
  try { const p = new URL(String(u)).pathname.replace(/\/+$/, '') || '/'; return p.slice(0, 60); }
  catch { return undefined; }
};

const fileFor = (host) => path.join(DIR, host.replace(/[^a-z0-9.\-_]/gi, '_') + '.json');

// A parent domain answers for a subdomain it has never seen. Writes always go
// to the exact host, so this only ever widens a lookup.
function resolveHost(host) {
  if (!host) return null;
  // Writes are debounced, so the cache is the newer truth — a batch that just
  // learned something must be able to recall it in the same request.
  const known = (h) => cache.has(h) || fs.existsSync(fileFor(h));
  if (known(host)) return host;
  const parts = host.split('.');
  for (let i = 1; parts.length - i >= 2 && i <= 2; i++) {
    const up = parts.slice(i).join('.');
    if (known(up)) return up;
  }
  return null;
}

// ── store ────────────────────────────────────────────────────────────────
const cache = new Map();
const dirty = new Set();
let flushTimer = null;

const blank = (host) => ({ host, first: Date.now(), updated: Date.now(), runs: 0, sel: {}, fixes: {}, traps: [], notes: [], recipes: {}, traces: [], urls: {}, tail: [] });

function load(host, create) {
  if (!host) return null;
  if (cache.has(host)) return cache.get(host);
  let m = null;
  try { m = JSON.parse(fs.readFileSync(fileFor(host), 'utf8')); } catch {}
  if (!m && !create) return null;
  m = Object.assign(blank(host), m || {});
  for (const k of ['sel', 'fixes', 'recipes', 'urls']) if (!m[k] || typeof m[k] !== 'object') m[k] = {};
  for (const k of ['traps', 'notes', 'traces', 'tail']) if (!Array.isArray(m[k])) m[k] = [];
  cache.set(host, m);
  return m;
}

function touch(m) {
  if (!m) return;
  m.updated = Date.now();
  dirty.add(m.host);
  if (!flushTimer) flushTimer = setTimeout(flush, 400).unref?.() || setTimeout(flush, 400);
}

function flush() {
  flushTimer = null;
  if (!dirty.size) return;
  try { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } catch { dirty.clear(); return; }
  for (const host of dirty) {
    const m = cache.get(host);
    if (!m) continue;
    try { fs.writeFileSync(fileFor(host), JSON.stringify(m, null, 1) + '\n', { mode: 0o600 }); } catch {}
  }
  dirty.clear();
}
process.on('exit', flush);

function hosts() {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
      let m = {};
      try { m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch {}
      return {
        host: m.host || f.replace(/\.json$/, ''),
        runs: m.runs || 0,
        recipes: Object.keys(m.recipes || {}).length,
        notes: (m.notes || []).length,
        traces: (m.traces || []).length,
        updated: m.updated || 0
      };
    }).sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}

// ── redaction ────────────────────────────────────────────────────────────
// Typed text is never written to disk. A stored flow keeps the shape — which
// field, in which order — and leaves a named hole where the value went.
const HOLE = (name) => `{{${name}}}`;
const isHole = (v) => typeof v === 'string' && /^\{\{.+\}\}$/.test(v);
const holeName = (v) => String(v).slice(2, -2);

// `bx recipe login "[name=\"user\"]=me"` is a selector leaking into a command
// line, quotes and all. Holes get a plain name instead — the field's own,
// wherever the selector already carries one.
function friendly(sel) {
  let s = String(sel), m;
  if ((m = /^#([A-Za-z][\w-]*)$/.exec(s))) s = m[1];
  else if ((m = /\[(?:name|placeholder|aria-label|data-testid|id)=["']?([^"'\]]+)/i.exec(s))) s = m[1];
  else if ((m = /^(?:text|label|placeholder|name|role)=(.+)$/.exec(s))) s = m[1].split(':').pop();
  else if ((m = /([A-Za-z][\w-]+)\s*$/.exec(s.replace(/[[\]"'=.#>()]/g, ' ')))) s = m[1];
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  return s || 'value';
}

// One naming scope per stored flow, so two fields never collide on a hole.
function scope() {
  const list = [];
  const seen = new Map();
  return {
    list,
    of(target) {
      if (seen.has(target)) return seen.get(target);
      const base = friendly(target);
      let n = base;
      for (let i = 2; list.some((v) => v.name === n); i++) n = base + i;
      seen.set(target, n);
      list.push({ name: n, target });
      return n;
    }
  };
}

function safeUrl(u) {
  try {
    const x = new URL(String(u));
    for (const k of [...x.searchParams.keys()]) if (SECRETISH.test(k)) x.searchParams.set(k, 'REDACTED');
    return x.toString().slice(0, 300);
  } catch { return String(u || '').slice(0, 300); }
}

const selOf = (t) => (typeof t === 'string' ? t : t && typeof t === 'object' ? t.sel || JSON.stringify(t) : '');

function redact(a, vars) {
  const o = { a: a.a };
  const keep = (k) => { if (a[k] !== undefined) o[k] = a[k]; };
  if (a.target !== undefined) o.target = a.target;
  switch (a.a) {
    case 'nav': case 'newtab': o.url = safeUrl(a.url); if (a.active === false) o.active = false; break;
    case 'type': case 'setval': {
      o[a.a === 'type' ? 'text' : 'value'] = HOLE(vars.of(selOf(a.target) || 'value'));
      keep('enter'); keep('clear');
      break;
    }
    case 'fill': {
      o.fields = {};
      for (const k of Object.keys(a.fields || {})) o.fields[k] = HOLE(vars.of(k));
      keep('fast');
      break;
    }
    case 'select': keep('value'); break;
    case 'press': o.keys = [].concat(a.keys || a.key || []); break;
    case 'wait': for (const k of ['for', 'gone', 'text', 'ms', 'load']) keep(k); break;
    case 'scroll': for (const k of ['to', 'by', 'into']) keep(k); break;
    case 'click': case 'dblclick': case 'rclick': for (const k of ['button', 'clicks', 'mods']) keep(k); break;
    case 'upload': o.files = [].concat(a.files || a.file || []); keep('viaDialog'); break;
    case 'drag': keep('to'); break;
    case 'eval': o.expr = String(a.expr || a.code || '').slice(0, 400); break;
    case 'sleep': keep('ms'); break;
    case 'tab': keep('id'); break;
  }
  if (a.trusted) o.trusted = true;
  if (a.speed && a.speed !== 'fast') o.speed = a.speed;
  return o;
}

// One line per step, for a human or an agent skimming a flow.
function brief(a) {
  const t = a.target && typeof a.target === 'object' && a.target.has ? `"${a.target.has}"` : selOf(a.target);
  switch (a.a) {
    case 'nav': case 'newtab': { let s = a.url || ''; try { const u = new URL(s); s = u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname); } catch {} return `${a.a} ${s}`; }
    case 'fill': return `fill ${Object.keys(a.fields || {}).length} fields`;
    case 'type': return `type ${t}`;
    case 'press': return `press ${[].concat(a.keys || a.key || []).join('+')}`;
    case 'wait': return `wait ${a.for || a.gone || a.text || (a.ms ? a.ms + 'ms' : 'load')}`;
    case 'scroll': return `scroll ${a.to ?? (Array.isArray(a.by) ? a.by[1] : '') ?? ''}`.trim();
    case 'select': return `select ${t}=${a.value}`;
    case 'sleep': return `sleep ${a.ms}ms`;
    default: return t ? `${a.a} ${t}` : a.a;
  }
}
const sigOf = (steps) => steps.map(brief).join(' → ');

// A stored step must name its element in a way that survives the page.
// `ref=e120` means one node in one render; replayed tomorrow it matches
// nothing, or — worse — whatever got that number this time. The result of
// every element action carries the durable selector it actually hit, so the
// step is stored with that instead.
function lasting(a, r) {
  const t = selOf(a.target);
  if (!t.startsWith('ref=')) return a;
  const sel = r && r.ok && r.r && typeof r.r.sel === 'string' ? r.r.sel : null;
  return sel ? { ...a, target: sel } : null;
}

// `bx click` waits for the page to settle after every click. That wait is
// plumbing, not part of the flow — stored, it replays as a no-op, and it made
// every single click look like a two-step flow worth promoting.
const idle = (a) => a.a === 'wait' && !(a.for || a.gone || a.text || a.ms || a.load);

// The holes a list of stored steps leaves, as {name, target}, with one name
// per field. Steps from separate batches were redacted separately, so two
// fields can arrive under the same name; they get told apart here.
function holesOf(steps) {
  const vars = scope();
  const out = steps.map((st) => {
    const o = { ...st };
    const rename = (v, target) => (isHole(v) ? HOLE(vars.of(target || holeName(v))) : v);
    if (o.text !== undefined) o.text = rename(o.text, selOf(o.target));
    if (o.value !== undefined && o.a === 'setval') o.value = rename(o.value, selOf(o.target));
    if (o.fields) { o.fields = { ...o.fields }; for (const k of Object.keys(o.fields)) o.fields[k] = rename(o.fields[k], k); }
    return o;
  });
  return { steps: out, vars: vars.list };
}

// ── learning ─────────────────────────────────────────────────────────────
function bump(m, target, action, ok, err) {
  if (!target || typeof target !== 'string') return;
  if (target.startsWith('ref=')) return;          // per-snapshot, worthless later
  if (target.length > 160) return;
  const s = (m.sel[target] = m.sel[target] || { ok: 0, bad: 0 });
  s[ok ? 'ok' : 'bad']++;
  s.a = action;
  s.at = Date.now();
  if (!ok && err) s.err = String(err).slice(0, 90);
  const keys = Object.keys(m.sel);
  if (keys.length > CAP.sel) {
    keys.sort((a, b) => (m.sel[a].at || 0) - (m.sel[b].at || 0));
    for (const k of keys.slice(0, keys.length - CAP.sel)) delete m.sel[k];
  }
}

function trap(m, text) {
  const t = String(text).slice(0, 180);
  const hit = m.traps.find((x) => x.t === t);
  if (hit) { hit.n = (hit.n || 1) + 1; hit.at = Date.now(); return; }
  m.traps.push({ t, n: 1, at: Date.now() });
  if (m.traps.length > CAP.traps) m.traps.splice(0, m.traps.length - CAP.traps);
}

// Everything the bridge learns from one /do. Returns which host the batch was
// mostly about, and whether it arrived there fresh.
// ── what the URL says ────────────────────────────────────────────────────
// The most reusable thing an agent finds on a site is that a filter, a sort
// or a search is just a query parameter. Found by clicking, it costs a minute
// of dropdowns; known, it is one `bx open`. So when a click, a select or a
// typed search leaves the page on the same path with different parameters,
// keep the parameters that changed and what was clicked to change them. No
// model is asked to remember anything.
const NOISE = /^(utm_|source$|ref_ctx|search_id|context|fbclid|gclid|_|__|session|sid$|ts$|t$|pos$|position$|layout$|seller_page)/i;

function urlLesson(m, seg, batch) {
  const act = [...seg.items].reverse().find((x) => x.r.ok && ['click', 'select', 'check', 'uncheck', 'type', 'press', 'fill'].includes(x.a.a));
  if (!act) return;
  let u0, u1;
  try { u0 = new URL(batch.url0); u1 = new URL(batch.url); } catch { return; }
  if (u0.host !== u1.host || u0.pathname !== u1.pathname) return;
  const p0 = u0.searchParams, p1 = u1.searchParams;
  const changed = [...p1.keys()].filter((k) => !NOISE.test(k) && p1.get(k) !== p0.get(k));
  if (!changed.length) return;
  const via = act.a.a === 'type' ? `typed "${String(act.a.text || '').slice(0, 30)}"`
    : act.r.r?.name ? `"${act.r.r.name}"` : selOf(act.a.target);
  const path = u1.pathname;
  const box = (m.urls[path] = m.urls[path] || {});
  for (const k of changed) box[k] = { v: p1.get(k), via, at: Date.now() };
  // Small on purpose: the newest few parameters on the few busiest paths.
  const keys = Object.keys(box).sort((a, b) => box[b].at - box[a].at);
  for (const k of keys.slice(6)) delete box[k];
  const paths = Object.keys(m.urls).sort((a, b) => Math.max(...Object.values(m.urls[b]).map((x) => x.at)) - Math.max(...Object.values(m.urls[a]).map((x) => x.at)));
  for (const p of paths.slice(3)) delete m.urls[p];
}

function learn(batch) {
  const actions = batch.actions || [];
  const results = batch.results || [];
  if (!results.length) return null;

  // A tab that starts blank (a new tab, about:blank) has no host of its own.
  // Falling back to where the batch ended made a first visit look like
  // staying put, and the site's briefing never showed on the one call that
  // needs it most. Only a batch that never navigates takes the end URL.
  let cur = hostOf(batch.url0);
  if (!cur && !actions.some((a) => NAV.has(a.a))) cur = hostOf(batch.url);
  let navigated = false;
  const segs = [];
  const push = (host, item) => {
    if (!host) return;
    const last = segs[segs.length - 1];
    if (last && last.host === host) last.items.push(item);
    else segs.push({ host, items: [item], at: item.r && item.r.r && item.r.r.url });
  };

  for (let i = 0; i < results.length; i++) {
    const a = actions[i], r = results[i];
    if (!a) break;
    if (NAV.has(a.a) && r.ok && r.r && r.r.url) {
      const h = hostOf(r.r.url);
      if (h && h !== cur) navigated = true;
      if (h) cur = h;
    }
    push(cur, { a, r });
  }
  if (!segs.length) return null;

  let saved = null;
  for (const seg of segs) {
    // bx's own reads — a background tab opened for `bx read <urls>`, a check,
    // a sift — teach nothing about a site and used to leave a memory file
    // behind for every host they touched. Only an internal batch that acted
    // (bx each --do) is worth learning from.
    if (batch.internal && !seg.items.some((x) => WORTH.has(x.a.a))) continue;
    const m = load(seg.host, true);
    if (!m) continue;
    m.runs = (m.runs || 0) + 1;
    urlLesson(m, seg, batch);

    // Selector scoring, plus the correction the agent found the hard way.
    const failed = new Map();   // action -> last target that missed
    for (const { a, r } of seg.items) {
      if (!TARGETED.has(a.a) || a.target === undefined) continue;
      // A ref only teaches us something if the page told us what it resolved to.
      const durable = r.ok && r.r && typeof r.r.sel === 'string' ? r.r.sel : null;
      const literal = selOf(a.target);
      // An ambiguous hit is not evidence. The durable selector of whichever
      // element ranked first resolves to a crowd, so promoting it to "works"
      // teaches the site the wrong handle and recommends it on every arrival.
      const many = r.ok && r.r && r.r.n > 1;
      if (many) trap(m, `${literal} matches ${r.r.n} elements (${a.a}) — scope it or use a ref`);
      if (r.ok && !many) {
        bump(m, durable || literal, a.a, true);
        if (durable && literal && durable !== literal && !literal.startsWith('ref=')) bump(m, literal, a.a, true);
        const bad = failed.get(a.a);
        const good = durable || literal;
        if (bad && good && bad !== good && !good.startsWith('ref=')) { m.fixes[bad] = good; failed.delete(a.a); }
      } else if (!r.ok) {
        // An ambiguous hit is neither a win nor a miss, so it must not land
        // here either — scoring it as failed would file the selector under
        // avoid and send the next run away from a target that does resolve.
        bump(m, literal, a.a, false, r.error);
        if (literal && !literal.startsWith('ref=')) failed.set(a.a, literal);
      }
      if (r.ok && r.r && r.r.covered) trap(m, `${a.a} ${durable || literal} lands on an overlay — dismiss it first`);
      // A stale ref or a mistyped selector is the caller's slip, not something
      // about the site: kept as traps they pushed the real ones out.
      if (!r.ok && (literal.startsWith('ref=') || /bad selector|not a valid selector|invalid selector|SyntaxError/i.test(String(r.error)))) continue;
      if (!r.ok && /not found/.test(String(r.error))) trap(m, `${literal} is not on this page (${a.a})`);
      else if (!r.ok && r.error) trap(m, `${a.a} ${literal}: ${String(r.error).slice(0, 100)}`);
    }

    // Every step that worked, whichever command it came in. Agents drive a
    // flow one command at a time far more often than in one batch, and then
    // no single batch is the flow — `bx learn` used to promote whatever the
    // last two-step batch happened to be. `bx learn --last N` takes it from here.
    for (const x of seg.items) {
      if (batch.internal || !x.r.ok || !KEEP.has(x.a.a) || x.a.a === 'sleep' || idle(x.a)) continue;
      const a = lasting(x.a, x.r);
      if (!a) continue;
      m.tail.push({ at: Date.now(), step: redact(a, scope()), name: x.r.r && x.r.r.name ? String(x.r.r.name).slice(0, 60) : undefined });
    }
    if (m.tail.length > CAP.tail) m.tail.splice(0, m.tail.length - CAP.tail);
    if (!batch.internal && !saved) saved = repeated(m);

    // The flow itself, when the whole segment worked and it did something.
    const allOk = seg.items.every((x) => x.r.ok);
    const worth = seg.items.some((x) => WORTH.has(x.a.a));
    const kept = seg.items.filter((x) => KEEP.has(x.a.a) && !idle(x.a)).map((x) => lasting(x.a, x.r)).filter(Boolean);
    if (allOk && worth && kept.length >= 2) {
      const vars = scope();
      const steps = kept.slice(0, CAP.steps).map((a) => redact(a, vars));
      const sig = sigOf(steps);
      const ms = seg.items.reduce((s, x) => s + (x.r.ms || 0), 0);
      const at = seg.at || batch.url;
      const hit = m.traces.find((t) => t.sig === sig);
      if (hit) { hit.n = (hit.n || 1) + 1; hit.at = Date.now(); hit.ms = Math.round((hit.ms + ms) / 2); }
      else {
        m.traces.push({ at: Date.now(), ms, n: 1, path: pathOf(at), sig, vars: vars.list, steps });
        if (m.traces.length > CAP.traces) m.traces.splice(0, m.traces.length - CAP.traces);
      }
    }
    touch(m);
  }

  // The host the batch spent the most actions on is the one worth reporting.
  const main = segs.slice().sort((a, b) => b.items.length - a.items.length)[0];
  return { host: main.host, hosts: segs.map((s) => s.host), navigated, saved };
}

// ── flows repeated page after page ───────────────────────────────────────
// Posting in six LinkedIn groups was the same dozen steps six times over,
// each a model turn, and the agent never saved the flow even when asked to.
// So bx notices by itself: when what was done after opening one page matches
// what was done after opening the previous page of the same kind
// (/groups/123/ and /groups/456/), the steps both runs share become a recipe
// and the next page is one command. Steps only one run had — a toast
// dismissed once, a request withdrawn — are left out.
const PAGEVERB = new Set(['nav', 'newtab']);
const shapeOf = (u) => String(pathOf(u) || '').replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[\w-]{16,}(?=\/|$)/g, '/:id');
const textOf = (t) => { const x = selOf(t); return x.startsWith('text=') ? x.slice(5) : null; };
const words = (s) => String(s).split(/\s+/);

// Two steps are the same step when they do the same thing to the same
// control — or to the page's own copy of it: "Join US Stock Market…" and
// "Join Investment Hub…" are both the page's Join button.
function sameStep(a, b) {
  if (a.step.a !== b.step.a) return null;
  const ta = selOf(a.step.target), tb = selOf(b.step.target);
  if (ta === tb) return a.step;
  const xa = textOf(a.step.target) ?? a.name, xb = textOf(b.step.target) ?? b.name;
  if (!xa || !xb) return null;
  const wa = words(xa), wb = words(xb);
  let k = 0;
  while (k < wa.length && k < wb.length && wa[k].toLowerCase() === wb[k].toLowerCase()) k++;
  if (!k || k === wa.length || k === wb.length) return null;
  return { ...a.step, target: { sel: 'button, a, [role=button], [role=link]', has: wa.slice(0, k).join(' ') } };
}

// Longest common subsequence of the two runs, under sameStep.
function common(x, y) {
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = sameStep(x[i], y[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    const st = sameStep(x[i], y[j]);
    if (st && L[i][j] === L[i + 1][j + 1] + 1) { out.push(st); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return out;
}

function repeated(m) {
  const runs = [];
  for (const t of m.tail) {
    if (PAGEVERB.has(t.step.a)) runs.push({ nav: t.step, steps: [] });
    else if (runs.length) runs[runs.length - 1].steps.push(t);
  }
  if (runs.length < 2) return null;
  const cur = runs[runs.length - 1], prev = runs[runs.length - 2];
  if (!cur.nav.url || cur.nav.url === prev.nav.url || shapeOf(cur.nav.url) !== shapeOf(prev.nav.url)) return null;
  // A flow worth replaying writes something and then commits it.
  const wrote = (r) => r.steps.some((t) => t.step.a === 'type' || t.step.a === 'fill' || t.step.a === 'setval');
  if (!wrote(cur) || !wrote(prev)) return null;
  const last = cur.steps[cur.steps.length - 1];
  if (!last || !['click', 'press'].includes(last.step.a)) return null;
  const shared = common(cur.steps, prev.steps);
  if (!shared.some((st) => st.a === 'type' || st.a === 'fill' || st.a === 'setval') || shared.length < 2) return null;

  const { steps, vars } = holesOf([{ a: 'nav', url: cur.nav.url }, ...shared]);
  // One text field is the common case; call its hole what it is.
  if (vars.length === 1) {
    const old = HOLE(vars[0].name);
    for (const st of steps) { if (st.text === old) st.text = HOLE('text'); if (st.value === old) st.value = HOLE('text'); }
    vars[0].name = 'text';
  }
  const seg = (shapeOf(cur.nav.url).split('/').filter((x) => x && x !== ':id')[0] || 'page').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const name = `auto-${seg}`;
  const sig = sigOf(steps);
  const had = m.recipes[name];
  // Already known — say it once. The page it opens is not part of the flow.
  if (had && sigOf(had.steps.slice(1)) === sigOf(steps.slice(1))) return null;
  m.recipes[name] = { steps, vars, path: pathOf(cur.nav.url), ms: 0, runs: had ? had.runs : 0, ok: had ? had.ok : 0, at: Date.now(), auto: true };
  return { host: m.host, name, steps: steps.length, vars: vars.map((v) => v.name), flow: sig };
}

// A recipe that has failed every time it was tried. Replaying it costs a
// timeout per step and teaches nothing; it came up first in the LinkedIn
// run's briefing, and the agent spent ten seconds finding out.
const broken = (r) => (r.runs || 0) >= 2 && !(r.ok > 0) ? 1 : 0;

// ── recall ───────────────────────────────────────────────────────────────
function full(host) {
  const h = resolveHost(host);
  return h ? load(h, false) : null;
}

// The compact form that rides back on a /do response. Hard caps everywhere —
// this lands in an agent's context on every arrival, so it has to stay small.
function digest(host, url) {
  const m = full(host);
  if (!m) return null;
  const out = { host: m.host };
  if (m.host !== host) out.for = host;

  const recipes = Object.entries(m.recipes || {})
    .sort((a, b) => (broken(a[1]) - broken(b[1])) || (b[1].at || 0) - (a[1].at || 0)).slice(0, 6)
    .map(([name, r]) => {
      const vars = (r.vars || []).map((v) => (typeof v === 'string' ? v : v.name));
      return { name, steps: (r.steps || []).length, ok: `${r.ok || 0}/${r.runs || 0}`, broken: broken(r) || undefined, path: r.path, vars: vars.length ? vars : undefined, flow: sigOf(r.steps || []).slice(0, 200) };
    });
  if (recipes.length) out.recipes = recipes;

  // A DOM path is the fallback of last resort — it works, but it is the first
  // thing a redesign breaks, so never advertise one above a real selector.
  const isPath = (t) => t.includes(' > ') || t.length > 80;
  const works = Object.entries(m.sel).filter(([, s]) => s.ok > 0 && s.ok >= s.bad)
    .sort((a, b) => (isPath(a[0]) - isPath(b[0])) || b[1].ok - a[1].ok || (b[1].at || 0) - (a[1].at || 0))
    .slice(0, 4)
    .filter(([t], i, all) => !isPath(t) || all.length <= 3)
    .map(([t, s]) => (s.bad ? `${t} (${s.ok}✓/${s.bad}✗)` : t));
  if (works.length) out.works = works;

  const avoid = Object.entries(m.sel).filter(([, s]) => s.bad > 0 && s.ok === 0)
    .sort((a, b) => b[1].bad - a[1].bad).slice(0, 5)
    .map(([t, s]) => (m.fixes[t] ? `${t} → use ${m.fixes[t]}` : `${t} (missed ×${s.bad})`));
  if (avoid.length) out.avoid = avoid;

  // One line per path: the parameters that do things here, and what set them.
  const urls = Object.entries(m.urls || {}).map(([path, ps]) =>
    `${path}?` + Object.entries(ps).map(([k, x]) => `${k}=${encodeURIComponent(x.v)} (${x.via})`).join(' &'));
  if (urls.length) out.urls = urls;

  // Notes about this kind of page first (a note written on /groups/123 is
  // about every /groups/:id), then the newest of the rest. Showing only the
  // last four hid older notes that still mattered.
  const here = url ? shapeOf(url) : null;
  const local = here ? m.notes.filter((n) => n.path && n.path === here) : [];
  const notes = [...local.slice(-4).reverse(), ...m.notes.filter((n) => !local.includes(n)).reverse()]
    .slice(0, 6).map((n) => n.t.slice(0, 200));
  if (notes.length) out.notes = notes;

  const traps = m.traps.filter((t) => (t.n || 1) >= 2).sort((a, b) => b.n - a.n).slice(0, 4).map((t) => `${t.t} (×${t.n})`);
  if (traps.length) out.traps = traps;

  // Flows are the point: what actually worked here, most recent first.
  const traces = m.traces.slice(-3).reverse().slice(0, 1)
    .map((t) => ({ path: t.path, ms: t.ms, ran: t.n, flow: t.sig.slice(0, 160) }));
  if (traces.length && !out.recipes && !out.urls) out.traces = traces;

  return Object.keys(out).length > 1 ? out : null;
}

// ── writes the agent asks for ────────────────────────────────────────────
const NOTE_MAX = 160;

function note(host, text, url) {
  const m = load(host, true);
  if (!m) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  // Every note is read on every arrival, by every agent, forever. A paragraph
  // here is a tax on all future runs, so refuse it and ask for the one line.
  if (t.length > NOTE_MAX) return { error: `note is ${t.length} chars — keep it under ${NOTE_MAX}: the one fact the next run needs` };
  const norm = t.toLowerCase();
  const i = m.notes.findIndex((n) => n.t.toLowerCase() === norm);
  if (i >= 0) m.notes.splice(i, 1);
  m.notes.push({ t, at: Date.now(), ...(url && hostOf(url) ? { path: shapeOf(url) } : {}) });
  if (m.notes.length > CAP.notes) m.notes.splice(0, m.notes.length - CAP.notes);
  touch(m);
  return { host: m.host, notes: m.notes.length };
}

// Promote a trace the bridge already captured into a named, replayable recipe.
function promote(host, name, opts = {}) {
  const m = load(host, true);
  if (!m) return { error: 'no host' };
  let src;
  if (Array.isArray(opts.steps) && opts.steps.length) {
    const vars = scope();
    src = { steps: opts.steps.map((a) => redact(a, vars)), vars: vars.list, ms: 0, path: opts.path };
  } else if (opts.last) {
    const n = Math.max(1, Math.min(Number(opts.last) || 0, m.tail.length));
    if (!m.tail.length) return { error: `nothing done on ${m.host} yet — run the flow once, then learn it` };
    src = { ...holesOf(m.tail.slice(-n).map((t) => t.step)), ms: 0, path: opts.path };
  } else {
    const traces = m.traces;
    if (!traces.length) return { error: `nothing learned on ${m.host} yet — run the flow once, then learn it` };
    src = opts.index !== undefined ? traces[traces.length - 1 - opts.index] : traces[traces.length - 1];
    if (!src) return { error: `no trace #${opts.index} on ${m.host}` };
  }
  m.recipes[name] = {
    steps: src.steps, vars: src.vars || [], path: src.path,
    ms: src.ms || 0, runs: 0, ok: 0, at: Date.now(), note: opts.note
  };
  const names = Object.keys(m.recipes);
  if (names.length > CAP.recipes) delete m.recipes[names.sort((a, b) => (m.recipes[a].at || 0) - (m.recipes[b].at || 0))[0]];
  touch(m);
  return { host: m.host, name, steps: src.steps.length, vars: (src.vars || []).map((v) => (typeof v === 'string' ? v : v.name)), flow: sigOf(src.steps), recent: recent(m) };
}

// The last few things done on this site, oldest first, numbered from the
// end — the numbers `bx learn <name> --last N` takes.
function recent(m, n = 12) {
  const t = m.tail.slice(-n);
  return t.map((x, i) => `${t.length - i}  ${brief(x.step)}`);
}

// Fill the holes a recipe left where values used to be.
function expand(host, name, vars = {}, force, url) {
  const m = full(host);
  const r = m && m.recipes && m.recipes[name];
  if (!r) return { error: `no recipe "${name}" for ${host}${m ? '' : ' — nothing known about this host'}` };
  if (broken(r) && !force) return { error: `recipe "${name}" failed all ${r.runs} of its runs — it is out of date. Do the flow by hand, then bx learn ${name} --last N to replace it (bx recipe ${name} --force to run it anyway)` };
  // Old flows stored bare selectors as their hole names; accept either, and let
  // a caller who only knows the selector pass that instead of the short name.
  const byName = new Map();
  for (const v of r.vars || []) {
    const name = typeof v === 'string' ? v : v.name;
    const target = typeof v === 'string' ? v : v.target;
    byName.set(name, target);
  }
  const missing = [];
  const sub = (v) => {
    if (!isHole(v)) return v;
    const k = holeName(v);
    if (k in vars) return vars[k];
    const target = byName.get(k);
    if (target && target in vars) return vars[target];
    missing.push(k);
    return v;
  };
  const actions = r.steps.map((s) => {
    const o = { ...s };
    if (isHole(o.text)) o.text = sub(o.text);
    if (isHole(o.value)) o.value = sub(o.value);
    if (o.fields) { o.fields = { ...o.fields }; for (const k of Object.keys(o.fields)) o.fields[k] = sub(o.fields[k]); }
    return o;
  });
  if (missing.length) return { error: `recipe "${name}" needs values: ${[...new Set(missing)].map((k) => `"${k}=…"`).join(' ')}` };
  // The same flow on another page: the recipe's own opening nav goes there
  // instead, or one is put in front.
  if (url) {
    if (actions[0] && PAGEVERB.has(actions[0].a)) actions[0] = { ...actions[0], url };
    else actions.unshift({ a: 'nav', url });
  }
  return { host: m.host, name, actions };
}

function ran(host, name, ok, ms) {
  const m = full(host);
  const r = m && m.recipes && m.recipes[name];
  if (!r) return;
  r.runs = (r.runs || 0) + 1;
  if (ok) { r.ok = (r.ok || 0) + 1; r.ms = ms; }
  r.at = Date.now();
  touch(m);
}

// ── looking across every site ────────────────────────────────────────────
// "You may have a blueprint saved somewhere": the answer is usually a note or
// a recipe on some host, and nobody remembers which. Every word must appear.
function find(query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hit = (t) => { const l = String(t || '').toLowerCase(); return words.every((w) => l.includes(w)); };
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    const host = f.replace(/\.json$/, '');
    const m = cache.get(host) || (() => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return null; } })();
    if (!m) continue;
    for (const n of m.notes || []) if (hit(`${m.host} ${n.t}`)) out.push({ host: m.host, kind: 'note', text: n.t, at: n.at });
    for (const [name, r] of Object.entries(m.recipes || {})) {
      const flow = sigOf(r.steps || []);
      if (hit(`${m.host} ${name} ${flow} ${r.note || ''}`)) out.push({ host: m.host, kind: 'recipe', name, text: flow.slice(0, 200), at: r.at });
    }
    for (const [p, ps] of Object.entries(m.urls || {})) {
      const line = `${p}?` + Object.entries(ps).map(([k, x]) => `${k}=${x.v} (${x.via})`).join(' &');
      if (hit(`${m.host} ${line}`)) out.push({ host: m.host, kind: 'url', text: line, at: Math.max(...Object.values(ps).map((x) => x.at || 0)) });
    }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 30);
}

// Hosts bx only ever read, never learned anything from: no note, recipe,
// URL lesson or flow. Background reads used to leave one of these per site.
function prune(dry) {
  flush();
  const gone = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of files) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { continue; }
    const empty = !(m.notes || []).length && !Object.keys(m.recipes || {}).length && !Object.keys(m.urls || {}).length && !(m.traces || []).length;
    if (!empty || (m.runs || 0) >= 20) continue;
    gone.push(m.host || f.replace(/\.json$/, ''));
    if (!dry) { cache.delete(m.host); try { fs.unlinkSync(path.join(DIR, f)); } catch {} }
  }
  return gone;
}

function forget(host, what, name) {
  const h = resolveHost(host);
  if (!h) return { error: `nothing known about ${host}` };
  if (what === 'all') {
    cache.delete(h); dirty.delete(h);
    try { fs.unlinkSync(fileFor(h)); } catch {}
    return { forgot: h };
  }
  const m = load(h, false);
  if (!m) return { error: `nothing known about ${host}` };
  if (what === 'recipe') { if (!m.recipes[name]) return { error: `no recipe "${name}"` }; delete m.recipes[name]; }
  else if (what === 'notes') m.notes = [];
  else if (what === 'traces') { m.traces = []; m.tail = []; }
  else if (what === 'traps') { m.traps = []; m.fixes = {}; }
  else if (what === 'selectors') m.sel = {};
  else return { error: `forget what? all | notes | traces | traps | selectors | recipe <name>` };
  touch(m);
  return { forgot: what, host: h, name };
}

module.exports = { hostOf, pathOf, learn, digest, full, hosts, note, promote, expand, ran, forget, find, prune, sigOf, brief, flush };
