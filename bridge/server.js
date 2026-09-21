'use strict';
// bx bridge — loopback HTTP/CLI front door for agents, WebSocket back door
// for the extension. Single process, no dependencies, no state on disk beyond
// config + screenshots.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { handleUpgrade } = require('./ws');
const mem = require('./memory');
const jev = require('./jev');
const agent = require('./agent');

const HOME = process.env.BX_HOME || path.join(os.homedir(), '.bx');
const CFG_PATH = path.join(HOME, 'config.json');
const SHOTS = path.join(HOME, 'shots');

const DEFAULTS = {
  port: 8787,
  token: null,
  extension_id: null,
  speed: 'fast',        // instant | fast | human
  trusted: false,       // force CDP-trusted input for every click/type
  timeout: 8000,
  log_max: 400,
  shot_format: 'jpeg',
  shot_quality: 72,
  // The fast brain. On by default — bx's whole agent mode is built around it,
  // and without a key it simply reports itself as off instead of breaking.
  jev: {
    enabled: true,
    api_key: null,
    base: 'https://api.codiv.ai',
    model: 'openjev-latest',
    timeout: 15000,
    steps: 1,               // denoise iterations, 1-8: more is steadier, slower
    samples: 1,             // repeated reads averaged, 1-32
    min_confidence: 0.55,   // below this the agent stops and escalates
    max_steps: 12,
    max_elements: 55,
    // Screenshots for jev. 'auto' asks from the page text first and retries
    // with a screenshot only when the answer is below the floor — seeing the
    // page costs ~2.5s more a call, and text settles most decisions alone.
    // 'always' attaches one every time; 'off' never does.
    see: 'auto'
  }
};

function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SHOTS, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch {}
  cfg = Object.assign({}, DEFAULTS, cfg);
  cfg.jev = Object.assign({}, DEFAULTS.jev, cfg.jev || {});
  if (!cfg.token) cfg.token = crypto.randomBytes(24).toString('base64url');
  saveConfig(cfg);
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

const CFG = loadConfig();

// ── state ────────────────────────────────────────────────────────────────
let ext = null;                 // live extension socket
let extMeta = { id: null, since: 0, ua: null };
let lastBeat = 0;               // last keepalive echo from the extension
const pending = new Map();      // id -> {resolve, reject, timer, t0}
const log = [];
let seq = 0;
let lastHost = null;           // whatever the last batch was mostly about

function note(kind, data) {
  log.push({ t: Date.now(), kind, ...data });
  if (log.length > CFG.log_max) log.splice(0, log.length - CFG.log_max);
}

// Chrome may have torn the extension's service worker down for being idle; it
// dials back in a moment after any browser event wakes it. Waiting 2.5s at 60ms
// resolution was often just short enough to report "not connected" on a browser
// that was about to be perfectly usable.
function waitForExt(ms) {
  if (ext) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (ext || Date.now() - t0 > ms) { clearInterval(tick); resolve(!!ext); }
    }, 20);
  });
}

function call(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!ext) return reject(new Error('extension not connected'));
    const id = ++seq;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, t0 });
    ext.send(JSON.stringify({ ...payload, id }));
  });
}

// ── screenshot spill: results carrying {__img:{b64,ext}} become files ─────
function spill(node, inline) {
  if (!node || typeof node !== 'object') return node;
  if (node.__img) {
    const { b64, ext: e, w, h } = node.__img;
    const buf = Buffer.from(b64, 'base64');
    if (inline) return { inline: b64, bytes: buf.length, w, h, mime: `image/${e === 'jpg' ? 'jpeg' : e}` };
    const f = path.join(SHOTS, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.${e}`);
    fs.writeFileSync(f, buf);
    return { path: f, bytes: buf.length, w, h };
  }
  if (Array.isArray(node)) return node.map((n) => spill(n, inline));
  for (const k of Object.keys(node)) node[k] = spill(node[k], inline);
  return node;
}

// ── HTTP ─────────────────────────────────────────────────────────────────
function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!b.trim()) return resolve({});
      try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store'
  });
  res.end(s);
}

function localOnly(req) {
  const h = String(req.headers.host || '');
  const host = h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// ── screenshots for jev ──────────────────────────────────────────────────
// jev takes images as data URLs. Downscaled, because it answers the same from
// 1024px as from full size and the upload is on the critical path. Returns
// null when there is nothing to capture (a chrome:// page, a closed tab) —
// the caller carries on with text alone.
async function snap(tab) {
  try {
    const out = await runBatch({ tab: tab ?? 'active', memory: false, inline: true, stopOnError: false,
      actions: [{ a: 'shot', maxWidth: 1024, quality: 60 }] });
    const r = out.results?.[0]?.r;
    return r && r.inline ? `data:${r.mime || 'image/jpeg'};base64,${r.inline}` : null;
  } catch { return null; }
}

// Text carries no styling, and jev does not know that: asked "is the button
// outlined or filled" from text alone it answered a confident, wrong "no".
// Low confidence therefore cannot be the only trigger — a question that is
// plainly about appearance gets the screenshot up front.
const VISUAL = /\b(colou?rs?|red|green|blue|yellow|orange|grey|gray|black|white|dark|light|theme|looks?|appear(s|ance)?|visible|visually|icons?|images?|photos?|pictures?|logos?|avatar|charts?|graphs?|greyed|grayed|highlighted|bold|layout|overlaps?|overlay|modal|popup|pop-up|spinner|captcha|outlined|filled|font|screenshot|rendered|blank|empty page|broken)\b/i;

// Per call: an explicit see:true/false wins, otherwise the configured mode.
const seeMode = (b) => (b.see === true ? 'always' : b.see === false ? 'off' : (CFG.jev.see || 'auto'));

// Ask once from text; if the answer is not good enough and a screenshot is
// allowed, ask again with the page's picture attached. `weak` decides what
// "not good enough" means for this particular question set.
async function askSeeing(b, st, qs, over, weak, about) {
  const mode = seeMode(b);
  const upfront = mode === 'always' || (mode === 'auto' && VISUAL.test(about || ''));
  const img = upfront ? await snap(b.tab) : null;
  let out = await jev.ask(st, qs, CFG.jev, { ...over, images: img ? [img] : undefined });
  out.saw = !!img;
  if (!img && mode === 'auto' && weak(out)) {
    const shot = await snap(b.tab);
    if (shot) {
      const again = await jev.ask(st, qs, CFG.jev, { ...over, images: [shot] });
      again.ms += out.ms;
      again.saw = true;
      out = again;
    }
  }
  return out;
}

// ── lists across pages ───────────────────────────────────────────────────
// Read the list on this page, then follow "next" up to `pages` pages. Each
// page is handed to `onPage` the moment it is read, so a caller can judge
// page 1 while page 2 loads.
async function collect(b, onPage) {
  if (b.items) return [];
  const tab = b.tab ?? 'active';
  const want = Math.max(1, Math.min(Number(b.pages) || 1, 20));
  const out = [];
  const seen = new Set();
  const seenHref = new Set();
  let feed = false;
  for (let n = 1; n <= want; n++) {
    // On a feed every scroll leaves the earlier items in place, so the list
    // keeps growing; read enough of it to reach the new ones.
    const cap = (b.max || 40) * (feed ? n : 1);
    let look, r;
    // After a scroll the first thing to appear is a spinner; the real rows
    // land a moment later. Re-read a few times before calling the feed dry.
    for (let tries = 0; tries < (feed ? 4 : 1); tries++) {
      if (tries) await new Promise((ok) => setTimeout(ok, 700));
      look = await runBatch({ tab, memory: false, stopOnError: false, actions: [
        { a: 'wait', settle: true, timeout: 4000 },
        { a: 'items', target: b.target, max: cap, chars: b.chars || 400 },
        ...(n < want ? [{ a: 'nextpage' }] : [])
      ] });
      r = look.results[1];
      if (!feed || !r?.ok || (r.r.items || []).some((x) => x.href && !seenHref.has(x.href))) break;
    }
    if (!r?.ok) { if (n === 1) throw new HttpError(502, `could not read a list off this page: ${r?.error || 'no result'}`); break; }
    // A site that loops back to page one, or a "next" that did nothing.
    const key = (r.r.items || []).map((x) => x.href || x.text).join('|');
    if (!r.r.items?.length || seen.has(key)) break;
    seen.add(key);
    // Sites re-list the same entry on later pages (sponsored slots, a shifted
    // sort); one entry, one row.
    const fresh = r.r.items.filter((x) => !x.href || !seenHref.has(x.href));
    fresh.forEach((x) => x.href && seenHref.add(x.href));
    const page = { page: n, url: r.r.url, title: r.r.title, items: fresh.map((x) => ({ ...x, page: n })) };
    if (fresh.length) { out.push(page); if (onPage) onPage(page); }

    const nx = look.results[2]?.r;
    if (n >= want || !nx) break;
    if (!fresh.length && feed) break;          // scrolled and nothing new came in
    if (nx.none && !nx.feed) break;
    if (nx.none) feed = true;
    const step = feed ? { a: 'scrollend' } : nx.href ? { a: 'nav', url: nx.href } : { a: 'click', target: nx.sel };
    const moved = await runBatch({ tab, memory: false, stopOnError: false, actions: [step] });
    if (!moved.results[0]?.ok) break;
  }
  return out;
}

// One page of items, one jev call: a yes/no per item. The criterion lives in
// the state and each item's text lives in its own question — putting the list
// in the state as well sent every item twice, and made sift the slowest call.
async function judge(b, page) {
  const items = (page.items || []).map((x, i) => (typeof x === 'string' ? { i, text: x } : { i: x.i ?? i, ...x }));
  if (!items.length) return [];
  const st = `PAGE: ${page.title || ''} — ${page.url || ''}\n\nEACH QUESTION IS ONE ITEM FROM A LIST ON THIS PAGE, TO BE JUDGED AGAINST THIS CRITERION:\n${b.criterion}\n\nJudge only from the item's own text. Numbers matter: a rating or a count in the text is exact.`;
  const qs = {};
  for (const x of items) {
    qs[`i${x.i}`] = {
      type: 'noul',
      instructions: `This item meets the criterion. ITEM: ${x.text}`,
      criteria: { true: 'The item satisfies the criterion.', false: 'It does not, or its text does not show that it does.' }
    };
  }
  const img = b.see === true || CFG.jev.see === 'always' ? await snap(b.tab) : null;
  // Ten questions a call, the calls in parallel. Measured on 40 Fiverr gigs
  // against "an AI or machine learning gig": all 40 in one call got 24 wrong,
  // four calls of 10 got none wrong, and took the same ~1.3s.
  const size = CFG.jev.sift_batch || 10;
  const answers = {};
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  await Promise.all(chunks.map(async (chunk) => {
    const part = {};
    for (const x of chunk) part[`i${x.i}`] = qs[`i${x.i}`];
    const out = await jev.ask(st, part, CFG.jev, { sequential: false, images: img ? [img] : undefined });
    Object.assign(answers, out.answers);
  }));
  return items.map((x) => {
    const a = jev.read(answers[`i${x.i}`]);
    return { ...x, keep: !!a.value, p: a.p, saw: !!img };
  });
}

// ── one page, one set of yes/no questions, without touching the user's tab ─
// Network first: fetch the HTML from inside a tab already on that site. If the
// served page has real text, jev answers from that in well under a second of
// loading. If it is a JavaScript shell, or the question is about looks, open
// a background tab, let it render, read it, and close it. Hosts that turn out
// to serve shells are remembered, so the fetch is only wasted once per site.
const SHELL = new Set();
const PROBE = new Map();   // host -> the first fetch attempt, still in flight

// Is this text a page a person would read, or something a machine left
// lying around — serialized state, a bundle, a wall of ids? Length alone
// said yes to 6000 characters of LinkedIn API JSON.
function prose(text) {
  const t = String(text || '').trim();
  if (t.length < 200) return false;
  if (/^(\{|\[\s*[[{"\d])/.test(t)) return false;   // a JSON document, not a markdown link
  // Markdown links and bare URLs are ordinary page furniture; measure the rest.
  const sample = t.slice(0, 4000).replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
  if (sample.length < 150) return false;
  const code = (sample.match(/[{}"\\;<>=]/g) || []).length;
  const words = (sample.match(/[\p{L}]{2,}/gu) || []).join('').length;
  return code / sample.length < 0.06 && words / sample.length > 0.45;
}

// Get one page's text without the user's tab: fetch first when the site
// serves real HTML, else render it in a background tab. `need.shot` forces a
// tab (a fetch has no picture). The caller must call `done()`, which closes
// any tab this opened.
async function grab(url, b, need = {}) {
  const host = new URL(url).host;
  const noop = () => {};
  if (b.fetch !== false && !need.shot && PROBE.has(host)) { try { await PROBE.get(host); } catch {} }
  if (b.fetch !== false && !need.shot && !SHELL.has(host)) {
    let settle;
    if (!PROBE.has(host)) PROBE.set(host, new Promise((r) => { settle = r; }));
    try {
      const tabs = (await runBatch({ memory: false, actions: [{ a: 'tabs' }] })).results[0]?.r?.tabs || [];
      const home = tabs.find((t) => { try { return new URL(t.url).host === host; } catch { return false; } });
      if (home) {
        const f = (await runBatch({ tab: home.id, memory: false, stopOnError: false, actions: [{ a: 'fetchtext', url, max: need.max || 6000 }] })).results[0];
        const text = f?.ok && f.r.status < 400 ? f.r.text : '';
        if (text.length >= 600 && prose(text)) return { via: 'fetch', url: f.r.url, title: f.r.title, text, els: [], done: noop };
        if (f?.ok && f.r.status < 400) SHELL.add(host);   // a 404 says nothing about the site
      }
    } finally { if (settle) { settle(); PROBE.delete(host); } }
  }

  let id;
  const done = async () => { if (id !== undefined && !b.keep) { try { await runBatch({ memory: false, actions: [{ a: 'closetab', id }] }); } catch {} } };
  try {
    const look = await runBatch({ memory: false, stopOnError: false, inline: true, actions: [
      { a: 'newtab', url, active: false, timeout: 20000 },
      // Busy pages never go fully quiet; what one question needs is on screen
      // well before the last lazy widget stops moving.
      { a: 'wait', settle: true, quiet: 250, timeout: 2500 },
      { a: 'read', mode: need.mode || 'text', max: need.max || 6000 },
      { a: 'elements', max: 40 },
      ...(need.shot ? [{ a: 'shot', maxWidth: 1024, quality: 60 }] : [])
    ] });
    const r = look.results;
    id = r[0]?.r?.id ?? r[0]?.tab;
    if (!r[0]?.ok) throw new Error(r[0]?.error || 'could not open');
    const img = need.shot && r[4]?.r?.inline ? `data:${r[4].r.mime || 'image/jpeg'};base64,${r[4].r.inline}` : null;
    return { via: 'tab', id, url: r[0].r.url || url, title: r[2]?.r?.title, text: r[2]?.r?.text || '', els: r[3]?.r?.elements || [], img, done };
  } catch (e) { await done(); throw e; }
}

// Asked alongside every check, in the same call. A question about a page
// that did not render — a login wall, an error, a loading shell, raw data —
// still gets a confident answer, and it is almost always "no": the LinkedIn
// run got "no 100%" for "has the admin replied" on eleven threads it had
// never actually seen. So jev also says whether the page was readable at
// all, and an unreadable page answers "unknown" instead of "no".
const READABLE = {
  type: 'noul',
  instructions: 'The page text above shows this page\'s real content — not only a login or sign-up wall, an error or "not available" page, a loading placeholder, or raw code/data.',
  criteria: { true: 'Real, readable page content is present.', false: 'It is a wall, an error, a placeholder or raw data, or nearly empty.' }
};
// Its own call, run alongside the real one. Put in the same call it changed
// the other answers: measured on a test inbox, "has the admin replied" went
// from 0.99 to 0.06 just by sharing the request with this question.
function readable(st) {
  return jev.ask(st, { r: READABLE }, CFG.jev).then((o) => jev.read(o.answers.r)).catch(() => null);
}
function unreadable(r, text, saw) {
  if (!saw && String(text || '').trim().length < 40) return 'the page had no text';
  return r && r.value === false && r.confidence >= 0.5 ? 'the page did not show its content (a wall, error, placeholder or raw data)' : null;
}

async function checkOne(url, list, b) {
  const mode = seeMode(b);
  const visual = mode === 'always' || (mode === 'auto' && VISUAL.test(list.join(' ')));
  const qs = {};
  list.forEach((q, i) => { qs[`q${i}`] = { type: 'noul', instructions: String(q) }; });
  const answer = (o, why) => list.map((q, i) => {
    if (why) return { question: q, answer: null, unknown: true, p: null, confidence: 0 };
    const a = jev.read(o.answers[`q${i}`]); return { question: q, answer: a.value, p: a.p, confidence: a.confidence };
  });
  const weak = (o) => list.some((q, i) => jev.read(o.answers[`q${i}`]).confidence < CFG.jev.min_confidence);
  const t0 = Date.now();
  const stateOf = (g) => `URL: ${g.url}\nTITLE: ${g.title || ''}\n\nPAGE TEXT:\n${g.text}` +
    (g.els.length ? '\n\nELEMENTS:\n' + g.els.map((e) => `  ${agent.label(e)}`).join('\n') : '');

  let g = await grab(url, b, { shot: visual });
  try {
    let [o, rd] = await Promise.all([jev.ask(stateOf(g), qs, CFG.jev, { images: g.img ? [g.img] : undefined }), readable(stateOf(g))]);
    let saw = !!g.img;
    // Not sure from the fetched HTML, or the HTML was not the page: render
    // it properly and ask again.
    if (g.via === 'fetch' && (weak(o) || unreadable(rd, g.text))) {
      g = await grab(url, { ...b, fetch: false }, { shot: mode === 'auto' });
      [o, rd] = await Promise.all([jev.ask(stateOf(g), qs, CFG.jev, { images: g.img ? [g.img] : undefined }), readable(stateOf(g))]);
      saw = !!g.img;
    } else if (g.via === 'tab' && !g.img && mode === 'auto' && weak(o)) {
      const s2 = (await runBatch({ tab: g.id, memory: false, inline: true, stopOnError: false, actions: [{ a: 'shot', maxWidth: 1024, quality: 60 }] })).results[0]?.r;
      if (s2?.inline) { o = await jev.ask(stateOf(g), qs, CFG.jev, { images: [`data:${s2.mime || 'image/jpeg'};base64,${s2.inline}`] }); saw = true; }
    }
    const why = unreadable(rd, g.text, saw);
    return { url, title: g.title, via: g.via, saw, ...(why ? { unreadable: why } : {}), answers: answer(o, why), ms: Date.now() - t0 };
  } finally { await g.done(); }
}

// Yes/no questions about the page in the tab right now. Shared by
// `bx check` and by `bx each`, which asks it once per item it opens.
async function checkHere(b, list) {
  const look = await runBatch({ tab: b.tab ?? 'active', memory: false, stopOnError: false,
    actions: [{ a: 'wait', settle: true, timeout: 3000 }, { a: 'read', mode: 'text', max: b.max || 5000, skip: b.skip }, { a: 'elements', max: 40, skip: b.skip }] });
  look.results.shift();
  const page = look.results[0]?.r || {};
  const els = look.results[1]?.r?.elements || [];
  const st = `URL: ${look.url}\nTITLE: ${page.title || ''}\n` +
    // In a list-and-detail app the page also shows every other row; say
    // which one the question is about, or its neighbours answer for it.
    (b.about ? `\nTHE QUESTION IS ABOUT THE ITEM THAT IS OPEN NOW: ${b.about}\nOther items listed on the page are not it.\n` : '') +
    `\nPAGE TEXT:\n${page.text || ''}\n\nELEMENTS:\n` +
    els.map((e) => `  ${agent.label(e)}`).join('\n');
  const qs = {};
  list.forEach((q, i) => { qs[`q${i}`] = { type: 'noul', instructions: String(q) }; });
  // A yes/no near 0.5 is the text admitting it cannot tell — "did the
  // modal close", "is that button greyed out" are about how the page looks.
  const [out, rd] = await Promise.all([
    askSeeing(b, st, qs, {}, (o) => list.some((q, i) => jev.read(o.answers[`q${i}`]).confidence < CFG.jev.min_confidence), list.join(' ')),
    readable(st)
  ]);
  // With a screenshot attached jev saw the page itself, so thin text
  // alone is no reason to doubt it.
  const why = unreadable(out.saw ? null : rd, page.text, out.saw);
  const answers = list.map((q, i) => {
    if (why) return { question: q, answer: null, unknown: true, p: null, confidence: 0 };
    const a = jev.read(out.answers[`q${i}`]);
    return { question: q, answer: a.value, p: a.p, confidence: a.confidence };
  });
  return { ok: true, url: look.url, title: page.title, ...(why ? { unreadable: why } : {}), answers, ms: out.ms, model: out.model, saw: out.saw };
}

// ── each: one action per list item ───────────────────────────────────────
// Read the list, keep the rows that match --if (judged from their text, all
// at once), open each in turn, ask --check about the opened page, and run
// the --do batch with that row's values filled in. The list is re-read before
// every row, because apps re-sort it as you act on it, and rows are tracked
// by their link or leading text, so nothing is done twice or skipped.
const firstName = (name) => {
  const w = String(name || '').trim().split(/\s+/)[0] || '';
  // "LOVE PREET" reads as shouting in a greeting; "Love" does not.
  return w.length > 1 && w === w.toUpperCase() && /\p{L}/u.test(w) ? w[0] + w.slice(1).toLowerCase() : w;
};
const fillIn = (v, vars) => {
  if (typeof v === 'string') return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  if (Array.isArray(v)) return v.map((x) => fillIn(x, vars));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = fillIn(v[k], vars); return o; }
  return v;
};

async function each(b, emit) {
  const tab = b.tab ?? 'active';
  const max = Math.max(1, Math.min(Number(b.max) || 20, 100));
  const t0 = Date.now();
  const deadline = b.budget ? t0 + Number(b.budget) : Infinity;
  const seen = new Set();          // rows already opened or passed over
  const verdict = new Map();       // row key -> --if judgement
  let list = b.target || null, home = null, rows = 0, did = 0, skipped = 0, failed = 0;
  const keyOf = (x) => x.href || x.text.split(' · ')[0];
  // Rows a previous run already finished (the CLI keeps a journal).
  for (const k of [].concat(b.skip || [])) seen.add(String(k));

  while (rows < max) {
    if (Date.now() > deadline) return { ok: true, rows, did, skipped, failed, stopped: 'budget', ms: Date.now() - t0 };
    let look = await runBatch({ tab, memory: false, stopOnError: false, actions: [
      { a: 'wait', settle: true, quiet: 250, timeout: 2500 },
      { a: 'items', target: list || undefined, max: 80, chars: 300, timeout: 2500 }
    ] });
    let got = look.results[1];
    const empty = () => !got?.ok || !got.r.items?.length;
    // Opening a row went to another page and the list is not on it: go back.
    if (empty() && home && look.url !== home) {
      look = await runBatch({ tab, memory: false, stopOnError: false, actions: [
        { a: 'nav', url: home }, { a: 'wait', settle: true, quiet: 250, timeout: 2500 },
        { a: 'items', target: list || undefined, max: 80, chars: 300, timeout: 2500 }
      ] });
      got = look.results[2];
    }
    // The container found last time was rebuilt under a different path: find
    // the list afresh, unless the caller pinned it.
    if (empty() && list && !b.target) {
      look = await runBatch({ tab, memory: false, stopOnError: false, actions: [{ a: 'items', max: 80, chars: 300 }] });
      got = look.results[0];
      // Only if it is recognisably the same list: on a detail page the
      // biggest list is often something else, like the messages in a thread.
      if (!empty() && got.r.items.some((x) => seen.has(keyOf(x)))) list = got.r.list;
      else got = null;
    }
    if (!got?.ok || !got.r.items?.length) {
      if (!home) throw new Error(`no list found on this page${list ? ` at ${list}` : ''} — point bx each at it: bx each "<css of the list>" …`);
      break;
    }
    if (!list) list = got.r.list;
    if (!home) home = got.r.url;

    const fresh = got.r.items.filter((x) => !seen.has(keyOf(x)));
    if (!fresh.length) break;
    if (b.if) {
      const todo = fresh.filter((x) => !verdict.has(keyOf(x)));
      if (todo.length) {
        const judged = await judge({ criterion: b.if, tab, see: b.see }, { url: got.r.url, title: got.r.title, items: todo });
        for (const x of judged) verdict.set(keyOf(x), x);
      }
    }
    const next = fresh.find((x) => !b.if || verdict.get(keyOf(x))?.keep);
    // Rows that fail --if are reported once, then left alone.
    for (const x of fresh) {
      const v = verdict.get(keyOf(x));
      if (b.if && v && !v.keep && !seen.has(keyOf(x))) { seen.add(keyOf(x)); emit({ key: keyOf(x), name: x.text.split(' · ')[0], href: x.href, keep: false, p: v.p }); }
    }
    if (!next) break;
    seen.add(keyOf(next));
    rows++;

    const name = next.text.split(' · ')[0];
    const vars = { name, first: firstName(name), text: next.text, href: next.href || '', n: rows };
    const row = { key: keyOf(next), n: rows, name, href: next.href, keep: b.if ? true : undefined, p: b.if ? verdict.get(keyOf(next))?.p : undefined };
    const r0 = Date.now();

    // Nothing to look at and nothing to do: --if alone is a dry listing.
    if (!b.check && !b.do) { emit({ ...row, ms: 0 }); did++; continue; }

    const open = await runBatch({ tab, memory: false, stopOnError: false, actions: [
      { a: 'openitem', list, href: next.href, head: next.href ? undefined : name, timeout: 4000 },
      { a: 'wait', settle: true, quiet: 300, timeout: 3000 }
    ] });
    if (!open.results[0]?.ok) { failed++; emit({ ...row, error: `could not open it: ${open.results[0]?.error}`, ms: Date.now() - r0 }); continue; }

    if (b.check) {
      const c = await checkHere({ tab, see: b.see, about: next.text.slice(0, 200), skip: list }, [b.check]);
      const a = c.answers[0];
      row.check = { answer: a.answer, p: a.p, unknown: a.unknown || undefined, why: c.unreadable };
      if (a.unknown || !a.answer) { skipped++; emit({ ...row, skip: true, ms: Date.now() - r0 }); continue; }
    }
    if (!b.do || b.dry) { emit({ ...row, dry: !!b.do || undefined, ms: Date.now() - r0 }); if (!b.do) did++; continue; }

    const out = await runBatch({ tab, stopOnError: true, memory: false, actions: fillIn(b.do, vars) });
    const bad = out.results.find((x) => !x.ok);
    if (bad) { failed++; emit({ ...row, error: `${bad.a}: ${bad.error}`, ms: Date.now() - r0 }); if (b.stopOnError !== false) return { ok: false, rows, did, skipped, failed, stopped: 'error', ms: Date.now() - t0 }; continue; }
    did++;
    emit({ ...row, done: true, ms: Date.now() - r0 });
  }
  return { ok: true, rows, did, skipped, failed, stopped: rows >= max ? 'max' : 'list done', ms: Date.now() - t0 };
}

// Many pages, one pool: `fn` per URL, at most `n` at a time, results in order.
// `budget` is how long a caller can afford to wait. Agent harnesses kill a
// shell command after about two minutes, and a 570-page read killed at minute
// two used to return nothing at all. So: stop starting pages at the deadline,
// cap each page, and hand every page back the moment it is done (`onDone`),
// so whatever finished is never lost.
async function eachUrl(urls, n, fn, o = {}) {
  const out = new Array(urls.length);
  const deadline = o.budget ? Date.now() + o.budget : Infinity;
  const cap = o.perPage || 30000;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, urls.length) }, async () => {
    while (next < urls.length) {
      const i = next++;
      if (Date.now() > deadline) { out[i] = { url: urls[i], skipped: true }; continue; }
      let timer;
      const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`page took over ${Math.round(cap / 1000)}s`)), cap); });
      try { out[i] = await Promise.race([fn(urls[i]), late]); } catch (e) { out[i] = { url: urls[i], error: String(e.message || e) }; }
      finally { clearTimeout(timer); }
      if (o.onDone) o.onDone(out[i]);
    }
  }));
  return out;
}

// /many/read and /jev/many share this: plain JSON at the end, or one NDJSON
// line per page as it finishes when the caller streams.
async function manyReply(res, b, urls, fn) {
  const t0 = Date.now();
  const pool = Math.max(1, Math.min(Number(b.parallel) || 6, 12));
  const opts = { budget: Number(b.budget) || 0, perPage: Number(b.perPage) || 30000 };
  const end = (out) => ({ ok: true, n: urls.length, done: out.filter((x) => x && !x.skipped).length,
    skipped: out.filter((x) => x?.skipped).map((x) => x.url), ms: Date.now() - t0, parallel: pool });
  if (!b.stream) {
    const out = await eachUrl(urls, pool, fn, opts);
    return send(res, 200, { ...end(out), results: out });
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  const line = (x) => { try { res.write(JSON.stringify(x) + '\n'); } catch {} };
  const out = await eachUrl(urls, pool, fn, { ...opts, onDone: (x) => { if (!x.skipped) line({ t: 'page', ...x }); } });
  line({ t: 'end', ...end(out) });
  return res.end();
}

// ── batch executor ───────────────────────────────────────────────────────
// Lifted out of the /do route so the agent loop runs through exactly the same
// path an external caller does: same budget maths, same recipe expansion, same
// memory learning. An agent that quietly took a private shortcut here would
// learn nothing and teach nothing.
class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

async function runBatch(b) {
  let actions = Array.isArray(b) ? b : Array.isArray(b.actions) ? b.actions : b.a ? [b] : null;

  // A recipe is just a stored batch with the values left out. Expanding it
  // here means every client — CLI, curl, some other agent — replays the
  // same way, and the run is scored against the recipe afterwards.
  let recipe = null;
  if (b.recipe) {
    const host = b.host || (await hostNow());
    const x = mem.expand(host, b.recipe, b.vars || {}, b.force);
    if (x.error) throw new HttpError(404, x.error);
    actions = x.actions;
    recipe = { host: x.host, name: b.recipe };
  }
  if (!actions || !actions.length) throw new HttpError(400, 'no actions');
  if (!ext && !(await waitForExt(b.wait ?? 10000))) {
    throw new HttpError(503, 'extension not connected — load extension/ at chrome://extensions, or open any tab to wake it');
  }

  // Mirror the worker's own per-action budget, typing allowance included,
  // so the bridge never gives up on a batch the extension is still running.
  const perChar = { instant: 0, fast: 14, human: 190 }[b.speed || CFG.speed] ?? 14;
  const budget = actions.reduce((s, a) => {
    const chars = a.a === 'type' ? String(a.text ?? '').length
      : a.a === 'fill' && a.fields && !a.fast ? Object.values(a.fields).join('').length : 0;
    return s + (a.timeout || b.timeout || CFG.timeout) + 4000 + chars * perChar;
  }, 2000);
  const t0 = Date.now();
  const out = await call({
    t: 'run',
    tab: b.tab ?? 'active',
    actions,
    timeout: b.timeout || CFG.timeout,
    stopOnError: b.stopOnError !== false,
    speed: b.speed || CFG.speed,
    trusted: b.trusted ?? CFG.trusted
  }, budget);

  spill(out, b.inline === true);
  const ok = out.results.every((r) => r.ok);
  note('do', { n: actions.length, ms: Date.now() - t0, ok });

  // Learning is free — the bridge already has the actions and the outcomes.
  // Recall is deliberate: the digest rides back on arrival at a host and on
  // any failure, which is exactly when an agent needs to be told what
  // worked here last time.
  let memory;
  try {
    const info = mem.learn({ actions, results: out.results, url0: out.url0, url: out.url, internal: b.memory === false });
    if (info && info.host) {
      // Arriving means either the batch navigated here, or this session was
      // last working somewhere else — an agent that walks up to a tab
      // already sitting on a site needs the briefing just as much.
      const arrived = info.navigated || info.host !== lastHost;
      lastHost = info.host;
      if (recipe) mem.ran(recipe.host, recipe.name, ok, Date.now() - t0);
      if (b.memory !== false && (arrived || !ok)) memory = mem.digest(info.host);
    }
  } catch (e) { note('err', { error: 'memory: ' + String(e.message || e) }); }

  return { ok, ...out, ...(memory ? { memory } : {}) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;

  if (!localOnly(req)) return send(res, 403, { ok: false, error: 'loopback only' });
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // /health is the only unauthenticated route — used by the CLI to see if the
  // bridge is up before it bothers reading the token.
  if (route === '/health') return send(res, 200, { ok: true, up: true, ext: !!ext });

  const tok = req.headers['x-bx-token'] || url.searchParams.get('token');
  if (tok !== CFG.token) return send(res, 401, { ok: false, error: 'bad token' });

  try {
    if (route === '/status' && req.method === 'GET') {
      return send(res, 200, {
        ok: true,
        connected: !!ext,
        extension: extMeta,
        port: CFG.port,
        speed: CFG.speed,
        trusted: CFG.trusted,
        timeout: CFG.timeout,
        pending: pending.size,
        beat: lastBeat ? Date.now() - lastBeat : null,
        pid: process.pid,
        home: HOME,
        jev: { enabled: CFG.jev.enabled !== false, ready: jev.ready(CFG.jev), model: CFG.jev.model }
      });
    }

    if (route === '/log' && req.method === 'GET') {
      const n = Math.min(parseInt(url.searchParams.get('n') || '40', 10), CFG.log_max);
      return send(res, 200, { ok: true, log: log.slice(-n) });
    }

    if (route === '/config') {
      if (req.method === 'GET') return send(res, 200, { ok: true, config: { ...CFG, token: '••••' } });
      if (req.method === 'POST') {
        const patch = await body(req);
        for (const k of ['speed', 'trusted', 'timeout', 'shot_format', 'shot_quality']) {
          if (k in patch) CFG[k] = patch[k];
        }
        saveConfig(CFG);
        if (ext) ext.send(JSON.stringify({ t: 'cfg', cfg: pick(CFG) }));
        return send(res, 200, { ok: true, config: { ...CFG, token: '••••' } });
      }
    }

    if (route === '/do' && req.method === 'POST') {
      const out = await runBatch(await body(req));
      return send(res, 200, out);
    }

    // ── memory ───────────────────────────────────────────────────────────
    if (route === '/memory' && req.method === 'GET') {
      if (url.searchParams.get('all') !== null) return send(res, 200, { ok: true, hosts: mem.hosts() });
      const host = url.searchParams.get('host') || (await hostNow());
      if (!host) return send(res, 200, { ok: true, host: null, error: 'no site in view — pass a host' });
      const m = mem.full(host);
      return send(res, 200, { ok: true, host, memory: m || null, digest: m ? mem.digest(host) : null });
    }

    if (route === '/memory/note' && req.method === 'POST') {
      const b = await body(req);
      const host = b.host || (await hostNow());
      if (!host) return send(res, 400, { ok: false, error: 'no site in view — pass a host' });
      const r = mem.note(host, b.text);
      if (r && r.error) return send(res, 400, { ok: false, error: r.error });
      return send(res, r ? 200 : 400, r ? { ok: true, ...r } : { ok: false, error: 'empty note' });
    }

    if (route === '/memory/learn' && req.method === 'POST') {
      const b = await body(req);
      const host = b.host || (await hostNow());
      if (!host) return send(res, 400, { ok: false, error: 'no site in view — pass a host' });
      if (!b.name) return send(res, 400, { ok: false, error: 'learn needs a name' });
      const r = mem.promote(host, b.name, { index: b.index, steps: b.steps, last: b.last, note: b.note, path: b.path });
      return send(res, r.error ? 404 : 200, r.error ? { ok: false, ...r } : { ok: true, ...r });
    }

    if (route === '/memory/forget' && req.method === 'POST') {
      const b = await body(req);
      const host = b.host || (await hostNow());
      if (!host) return send(res, 400, { ok: false, error: 'no site in view — pass a host' });
      const r = mem.forget(host, b.what || 'all', b.name);
      return send(res, r.error ? 404 : 200, r.error ? { ok: false, ...r } : { ok: true, ...r });
    }

    if (route === '/reload' && req.method === 'POST') {
      if (!ext) return send(res, 503, { ok: false, error: 'extension not connected' });
      ext.send('{"t":"reload"}');
      return send(res, 200, { ok: true, reloading: true });
    }

    if (route === '/shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true, bye: true });
      setTimeout(() => process.exit(0), 40);
      return;
    }

    // ── jev: the fast brain ──────────────────────────────────────────────
    if (route === '/jev' && req.method === 'GET') {
      const k = jev.key(CFG.jev);
      const st = jev.stats;
      return send(res, 200, {
        ok: true,
        enabled: CFG.jev.enabled !== false,
        ready: !!k,
        key: k ? k.slice(0, 8) + '…' + k.slice(-4) : null,
        source: process.env.CODIV_API_KEY ? 'env CODIV_API_KEY' : process.env.TYPESAFE_API_KEY ? 'env TYPESAFE_API_KEY' : CFG.jev.api_key ? 'config' : null,
        model: CFG.jev.model,
        base: CFG.jev.base,
        min_confidence: CFG.jev.min_confidence,
        steps: CFG.jev.steps,
        samples: CFG.jev.samples,
        max_steps: CFG.jev.max_steps,
        see: CFG.jev.see || 'auto',
        usage: { calls: st.calls, failed: st.fails, avg_ms: st.calls ? Math.round(st.ms / st.calls) : 0, input_tokens: st.in }
      });
    }

    if (route === '/jev' && req.method === 'POST') {
      const patch = await body(req);
      for (const k of ['enabled', 'api_key', 'base', 'model', 'timeout', 'steps', 'samples', 'min_confidence', 'max_steps', 'max_elements', 'see', 'sift_batch']) {
        if (k in patch) CFG.jev[k] = patch[k];
      }
      saveConfig(CFG);
      return send(res, 200, { ok: true, jev: { ...CFG.jev, api_key: CFG.jev.api_key ? '••••' : null } });
    }

    // Raw passthrough. Any state, any questions — useful for anything on a
    // page that bx itself has no opinion about.
    if (route === '/jev/ask' && req.method === 'POST') {
      const b = await body(req);
      if (!b.questions) throw new HttpError(400, 'ask needs questions');
      let st = b.state;
      if (st === undefined || b.page) {
        const look = await runBatch({ tab: b.tab ?? 'active', memory: false, stopOnError: false,
          actions: [{ a: 'read', mode: 'text', max: b.max || 6000 }] });
        const r = look.results[0]?.r || {};
        st = `URL: ${look.url}\nTITLE: ${r.title || ''}\n\n${r.text || ''}` + (b.state ? `\n\n${b.state}` : '');
      }
      const img = b.see === true ? await snap(b.tab) : null;
      const images = b.images || (img ? [img] : undefined);
      const out = await jev.ask(st, b.questions, CFG.jev, { model: b.model, steps: b.steps, samples: b.samples, think: b.think, sequential: b.sequential, images });
      out.saw = !!(images && images.length);
      return send(res, 200, { ok: true, ...out });
    }

    // "Which thing on this page is the X?" — the single most common decision
    // in browser automation, and the one a selector cannot express.
    if (route === '/jev/pick' && req.method === 'POST') {
      const b = await body(req);
      if (!b.want) throw new HttpError(400, 'pick needs a description of what to find');
      const look = await runBatch({ tab: b.tab ?? 'active', memory: false, stopOnError: false,
        actions: [{ a: 'wait', settle: true, timeout: 3000 }, { a: 'elements', max: b.max || CFG.jev.max_elements }, { a: 'read', mode: 'text', max: 1200 }] });
      look.results.shift();
      const els = (look.results[0]?.r?.elements || []).filter((e) => b.disabled ? true : !e.dis);
      if (!els.length) return send(res, 200, { ok: false, error: 'no interactive elements on this page' });

      const criteria = { none: 'None of these is what was asked for.' };
      for (const e of els) criteria[e.ref] = agent.label(e);
      const st = `PAGE: ${look.results[0]?.r?.title || ''} — ${look.url}\n\nWHAT THE USER IS LOOKING FOR: ${b.want}\n\nPAGE TEXT:\n${(look.results[1]?.r?.text || '').slice(0, 1200)}\n\nELEMENTS:\n` +
        els.map((e) => `  ${e.ref}  ${agent.label(e)}`).join('\n');
      const out = await askSeeing(b, st, {
        target: { type: 'choice', instructions: `Which element is "${b.want}"? Pick the single best match.`, criteria }
      }, {}, (o) => { const x = jev.read(o.answers.target); return !x.value || x.value === 'none' || x.confidence < CFG.jev.min_confidence; }, b.want);
      const a = jev.read(out.answers.target);
      if (!a.value || a.value === 'none') return send(res, 200, { ok: false, error: `jev found nothing matching${out.saw ? ', even with a screenshot' : ''}`, confidence: a.confidence, ms: out.ms, saw: out.saw });

      const el = els.find((e) => e.ref === a.value);
      let sel;
      if (b.sel !== false) {
        try { sel = (await runBatch({ tab: b.tab ?? 'active', memory: false, actions: [{ a: 'path', target: `ref=${a.value}` }] })).results[0]?.r; } catch {}
      }
      return send(res, 200, {
        ok: true, ref: a.value, element: el, label: el && agent.label(el),
        sel: sel?.sel || sel?.css, css: sel?.css,
        confidence: a.confidence, alternatives: (a.ranked || []).filter((x) => x.label !== a.value).slice(0, 3),
        ms: out.ms, model: out.model, saw: out.saw
      });
    }

    // Yes/no about the page in front of us. "Am I logged in", "did that save",
    // "is this a captcha" — answered in one round trip, with a probability.
    if (route === '/jev/check' && req.method === 'POST') {
      const b = await body(req);
      const list = b.questions ? (Array.isArray(b.questions) ? b.questions : [b.questions]) : [b.question];
      if (!list[0]) throw new HttpError(400, 'check needs a question');
      return send(res, 200, await checkHere(b, list));
    }

    // "Do this to each of them": reply to every unread message, accept every
    // pending invite, fill the same form for each row. By hand that is five
    // model turns an item — open, look, decide, type, send — and it is how the
    // LinkedIn inbox run spent seven minutes on nine conversations.
    if (route === '/each' && req.method === 'POST') {
      const b = await body(req);
      if (!b.if && !b.check && !b.do) throw new HttpError(400, 'each needs something to do: --if, --check and/or --do');
      if (b.do && !Array.isArray(b.do)) throw new HttpError(400, 'each --do takes a JSON array of actions');
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const line = (x) => { try { res.write(JSON.stringify(x) + '\n'); } catch {} };
      try { line({ t: 'end', ...(await each(b, (x) => line({ t: 'item', ...x }))) }); }
      catch (e) { line({ t: 'end', ok: false, error: String(e.message || e) }); }
      return res.end();
    }

    // The page's repeated list, optionally across several result pages. bx
    // follows "next" itself: paging by hand is open, wait, read, one model
    // turn per page — the slowest way through a result set there is.
    if (route === '/items' && req.method === 'POST') {
      const b = await body(req);
      const pages = await collect(b);
      return send(res, 200, { ok: true, pages: pages.length, n: pages.reduce((n, p) => n + p.items.length, 0), results: pages });
    }

    // "Go through this list and keep the good ones." The step a research task
    // repeats most, and the one a chat model is slowest at: it has to read
    // every card and write out a verdict for each. jev judges a whole page of
    // results in one round trip, and while it does, bx is already loading the
    // next page.
    if (route === '/jev/sift' && req.method === 'POST') {
      const b = await body(req);
      if (!b.criterion) throw new HttpError(400, 'sift needs a criterion — what makes an item worth keeping');
      const t0 = Date.now();
      const judging = [];
      const pages = await collect(b, (page) => { judging.push(judge(b, page)); });
      if (b.items) judging.push(judge(b, { url: b.url, title: b.title, items: b.items }));
      const judged = (await Promise.all(judging)).flat();
      if (!judged.length) return send(res, 200, { ok: false, error: 'no repeated list found on this page — try `bx items <css of the list>`' });
      const kept = judged.filter((x) => x.keep).sort((x, y) => (y.p ?? 0) - (x.p ?? 0));
      return send(res, 200, {
        ok: true, criterion: b.criterion, pages: pages.length || 1,
        url: pages[0]?.url || b.url, title: pages[0]?.title || b.title,
        n: judged.length, kept: kept.length,
        items: b.all ? judged : kept, ms: Date.now() - t0, model: CFG.jev.model, saw: judged.some((x) => x.saw)
      });
    }

    // The same yes/no across many pages at once: "which of these 10 groups
    // allows anonymous posts". One page at a time is ~2s of loading plus a
    // turn of the caller's per page; here every page loads at once and every
    // question is in flight together, so ten pages cost about what two do.
    if (route === '/jev/many' && req.method === 'POST') {
      const b = await body(req);
      const urls = [...new Set((b.urls || []).map(String).filter((u) => /^https?:\/\//i.test(u)))];
      const list = b.questions ? [].concat(b.questions) : [b.question];
      if (!urls.length) throw new HttpError(400, 'many needs urls');
      if (!list[0]) throw new HttpError(400, 'many needs a question');
      return manyReply(res, b, urls, (u) => checkOne(u, list, b));
    }

    // The text of many pages at once, for when the answer is a value rather
    // than a yes/no ("the member count and the admin of each group"). The
    // caller still reads the text, but gets every page in one go instead of
    // an open/read round trip per page.
    if (route === '/many/read' && req.method === 'POST') {
      const b = await body(req);
      const urls = [...new Set((b.urls || []).map(String).filter((u) => /^https?:\/\//i.test(u)))];
      if (!urls.length) throw new HttpError(400, 'read needs urls');
      return manyReply(res, b, urls, async (u) => {
        const t1 = Date.now();
        const g = await grab(u, b, { mode: b.mode || 'md', max: b.max || 4000 });
        try { return { url: g.url, asked: u, title: g.title, via: g.via, text: g.text, ms: Date.now() - t1 }; } finally { await g.done(); }
      });
    }

    // ── agent: the whole loop ────────────────────────────────────────────
    if (route === '/agent' && req.method === 'POST') {
      const b = await body(req);
      const useJev = b.jev === false ? false : (CFG.jev.enabled !== false);
      const opts = {
        goal: b.goal, hint: b.hint, vars: b.vars, tab: b.tab ?? 'active',
        speed: b.speed, trusted: b.trusted, timeout: b.timeout, allow: !!b.allow,
        maxSteps: b.maxSteps || b.steps, dry: !!b.dry, open: b.open, read: b.read,
        jev: useJev,
        jevConfig: { ...CFG.jev, see: seeMode(b), ...(b.min_confidence ? { min_confidence: b.min_confidence } : {}) }
      };
      if (!b.goal) throw new HttpError(400, 'agent needs a goal');

      // What bx already learned about this site is free context for the brain.
      try { const h = await hostNow(); if (h) { const d = mem.digest(h); if (d) opts.memory = JSON.stringify(d).slice(0, 900); } } catch {}

      // Streaming exists because an agent run is seconds of silence otherwise,
      // and the one thing you want to watch is what it decided and why.
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        const line = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
        opts.onStep = (ev) => line({ t: 'step', ...ev });
        try {
          const out = await agent.run(opts, { exec: runBatch, snap: () => snap(opts.tab) });
          line({ t: 'end', ...out, steps: undefined });
        } catch (e) {
          line({ t: 'end', ok: false, reason: 'error', detail: String(e.message || e) });
        }
        return res.end();
      }

      const out = await agent.run(opts, { exec: runBatch, snap: () => snap(opts.tab) });
      note('agent', { goal: String(b.goal).slice(0, 80), reason: out.reason, steps: out.steps.length });
      return send(res, 200, out);
    }

    return send(res, 404, { ok: false, error: `no route ${req.method} ${route}` });
  } catch (e) {
    note('err', { error: String(e.message || e) });
    return send(res, e.code || 500, { ok: false, error: String(e.message || e) });
  }
});

// Which site are we talking about? The last batch usually answers it without a
// round trip; otherwise ask the live tab.
async function hostNow() {
  if (lastHost) return lastHost;
  if (!ext) return null;
  try {
    const out = await call({ t: 'run', tab: 'active', actions: [{ a: 'info' }], timeout: 3000, stopOnError: true, speed: 'instant', trusted: false }, 6000);
    const h = mem.hostOf(out && out.url);
    if (h) lastHost = h;
    return h;
  } catch { return null; }
}

function pick(c) {
  return { speed: c.speed, trusted: c.trusted, timeout: c.timeout, shot_format: c.shot_format, shot_quality: c.shot_quality };
}

// ── WebSocket: the extension dials in ────────────────────────────────────
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/ext') { try { sock.destroy(); } catch {} return; }

  const ws = handleUpgrade(req, sock, head, (r) => {
    const origin = String(r.headers.origin || '');
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
    if (!m) return false;
    // Trust-on-first-use: the first extension to connect owns this bridge.
    if (!CFG.extension_id) { CFG.extension_id = m[1]; saveConfig(CFG); }
    return CFG.extension_id === m[1];
  });
  if (!ws) return;

  if (ext) ext.close(1000);
  ext = ws;
  lastBeat = Date.now();
  extMeta = { id: CFG.extension_id, since: Date.now(), ua: null };
  note('ext', { event: 'connected' });
  ws.send(JSON.stringify({ t: 'hello', cfg: pick(CFG) }));

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    lastBeat = Date.now();
    if (m.t === 'ka') return;
    if (m.t === 'hi') { extMeta.ua = m.ua; extMeta.chrome = m.chrome; return; }
    if (m.t === 'ev') { note('ev', m.d || {}); return; }
    const p = pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.r);
  });

  ws.on('close', () => {
    if (ext === ws) { ext = null; extMeta = { id: CFG.extension_id, since: 0, ua: null }; }
    note('ext', { event: 'disconnected' });
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); pending.delete(id); }
  });
});

// A service worker killed mid-batch can leave the TCP side half-open, and the
// caller then sits on the full action budget for nothing. The extension echoes
// every keepalive, so a missed echo is a dead socket: drop it and fail fast
// with a real reason instead of a timeout thirty seconds later.
setInterval(() => {
  if (!ext) return;
  if (Date.now() - lastBeat > 26000) {
    note('ext', { event: 'stale' });
    try { ext.close(1001); } catch {}
    return;
  }
  ext.send('{"t":"ka"}');
}, 8000).unref();

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`bx: port ${CFG.port} already in use — bridge probably already running`);
    process.exit(3);
  }
  console.error('bx:', e.message);
  process.exit(1);
});

server.listen(CFG.port, '127.0.0.1', () => {
  if (process.env.BX_QUIET !== '1') {
    console.log(`bx bridge  http://127.0.0.1:${CFG.port}  ws /ext  pid ${process.pid}`);
    console.log(`config     ${CFG_PATH}`);
  }
  if (process.send) process.send('ready');
});
