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

const CAP = { notes: 40, traces: 14, traps: 24, sel: 240, recipes: 60, steps: 40 };

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

const blank = (host) => ({ host, first: Date.now(), updated: Date.now(), runs: 0, sel: {}, fixes: {}, traps: [], notes: [], recipes: {}, traces: [] });

function load(host, create) {
  if (!host) return null;
  if (cache.has(host)) return cache.get(host);
  let m = null;
  try { m = JSON.parse(fs.readFileSync(fileFor(host), 'utf8')); } catch {}
  if (!m && !create) return null;
  m = Object.assign(blank(host), m || {});
  for (const k of ['sel', 'fixes', 'recipes']) if (!m[k] || typeof m[k] !== 'object') m[k] = {};
  for (const k of ['traps', 'notes', 'traces']) if (!Array.isArray(m[k])) m[k] = [];
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
  const t = selOf(a.target);
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
function learn(batch) {
  const actions = batch.actions || [];
  const results = batch.results || [];
  if (!results.length) return null;

  let cur = hostOf(batch.url0) || hostOf(batch.url);
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

  for (const seg of segs) {
    const m = load(seg.host, true);
    if (!m) continue;
    m.runs = (m.runs || 0) + 1;

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
      if (!r.ok && /not found/.test(String(r.error))) trap(m, `${literal} is not on this page (${a.a})`);
      else if (!r.ok && r.error) trap(m, `${a.a} ${literal}: ${String(r.error).slice(0, 100)}`);
    }

    // The flow itself, when the whole segment worked and it did something.
    const allOk = seg.items.every((x) => x.r.ok);
    const worth = seg.items.some((x) => WORTH.has(x.a.a));
    const kept = seg.items.filter((x) => KEEP.has(x.a.a)).map((x) => x.a);
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
  return { host: main.host, hosts: segs.map((s) => s.host), navigated };
}

// ── recall ───────────────────────────────────────────────────────────────
function full(host) {
  const h = resolveHost(host);
  return h ? load(h, false) : null;
}

// The compact form that rides back on a /do response. Hard caps everywhere —
// this lands in an agent's context on every arrival, so it has to stay small.
function digest(host) {
  const m = full(host);
  if (!m) return null;
  const out = { host: m.host };
  if (m.host !== host) out.for = host;

  const recipes = Object.entries(m.recipes || {})
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 6)
    .map(([name, r]) => {
      const vars = (r.vars || []).map((v) => (typeof v === 'string' ? v : v.name));
      return { name, steps: (r.steps || []).length, ok: `${r.ok || 0}/${r.runs || 0}`, path: r.path, vars: vars.length ? vars : undefined, flow: sigOf(r.steps || []).slice(0, 200) };
    });
  if (recipes.length) out.recipes = recipes;

  // A DOM path is the fallback of last resort — it works, but it is the first
  // thing a redesign breaks, so never advertise one above a real selector.
  const isPath = (t) => t.includes(' > ') || t.length > 80;
  const works = Object.entries(m.sel).filter(([, s]) => s.ok > 0 && s.ok >= s.bad)
    .sort((a, b) => (isPath(a[0]) - isPath(b[0])) || b[1].ok - a[1].ok || (b[1].at || 0) - (a[1].at || 0))
    .slice(0, 8)
    .filter(([t], i, all) => !isPath(t) || all.length <= 3)
    .map(([t, s]) => (s.bad ? `${t} (${s.ok}✓/${s.bad}✗)` : t));
  if (works.length) out.works = works;

  const avoid = Object.entries(m.sel).filter(([, s]) => s.bad > 0 && s.ok === 0)
    .sort((a, b) => b[1].bad - a[1].bad).slice(0, 5)
    .map(([t, s]) => (m.fixes[t] ? `${t} → use ${m.fixes[t]}` : `${t} (missed ×${s.bad})`));
  if (avoid.length) out.avoid = avoid;

  const notes = m.notes.slice(-6).map((n) => n.t.slice(0, 200));
  if (notes.length) out.notes = notes;

  const traps = m.traps.filter((t) => (t.n || 1) >= 2).sort((a, b) => b.n - a.n).slice(0, 4).map((t) => `${t.t} (×${t.n})`);
  if (traps.length) out.traps = traps;

  // Flows are the point: what actually worked here, most recent first.
  const traces = m.traces.slice(-3).reverse().slice(0, 2)
    .map((t) => ({ path: t.path, ms: t.ms, ran: t.n, flow: t.sig.slice(0, 240) }));
  if (traces.length && !out.recipes) out.traces = traces;

  return Object.keys(out).length > 1 ? out : null;
}

// ── writes the agent asks for ────────────────────────────────────────────
function note(host, text) {
  const m = load(host, true);
  if (!m) return null;
  const t = String(text).trim().slice(0, 400);
  if (!t) return null;
  const norm = t.toLowerCase();
  const i = m.notes.findIndex((n) => n.t.toLowerCase() === norm);
  if (i >= 0) m.notes.splice(i, 1);
  m.notes.push({ t, at: Date.now() });
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
  return { host: m.host, name, steps: src.steps.length, vars: (src.vars || []).map((v) => (typeof v === 'string' ? v : v.name)), flow: sigOf(src.steps) };
}

// Fill the holes a recipe left where values used to be.
function expand(host, name, vars = {}) {
  const m = full(host);
  const r = m && m.recipes && m.recipes[name];
  if (!r) return { error: `no recipe "${name}" for ${host}${m ? '' : ' — nothing known about this host'}` };
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
  else if (what === 'traces') m.traces = [];
  else if (what === 'traps') { m.traps = []; m.fixes = {}; }
  else if (what === 'selectors') m.sel = {};
  else return { error: `forget what? all | notes | traces | traps | selectors | recipe <name>` };
  touch(m);
  return { forgot: what, host: h, name };
}

module.exports = { hostOf, pathOf, learn, digest, full, hosts, note, promote, expand, ran, forget, sigOf, brief, flush };
