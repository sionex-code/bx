'use strict';
// jev.js — the fast half of the brain.
//
// A System One model does not write prose. You hand it a state and a set of
// questions you defined up front — yes/no ("noul"), one of N labels
// ("choice"), a point on a scale ("score") — and it hands back a calibrated
// probability distribution over each one. No tokens to generate, so an answer
// lands in a fraction of the time a chat model needs to say the same thing in
// sentences.
//
// That happens to be the exact shape of every decision a browser agent makes:
// which of these 40 elements do I click, is the goal already done, is this a
// captcha wall. So bx asks jev, acts, and only escalates to a big model when
// jev says it is not sure.
//
// Two services answer the same POST /v1/systemone, each with its own keys:
// TypeSafe runs Jev, and codiv.ai runs OpenJev, an independent open copy of
// it. Any number of keys for either can be configured; calls rotate across a
// provider's keys and step past one that is rate-limited, out of credit or
// refused.
//
// Zero dependencies. Never logs a key.
const https = require('https');
const http = require('http');

// Measured on 20 bx-shaped tasks, 5 rounds each (Sep 2026): TypeSafe answered
// in ~420ms and got none of 295 wrong; codiv took ~980ms and missed 10, all
// of them at full confidence. But TypeSafe reads text only, and refuses (400)
// a request carrying images, steps, samples, think or sequential.
const PROVIDERS = {
  typesafe: { base: 'https://api.typesafe.ai', model: 'jev-latest', images: false, extras: false, site: 'https://console.typesafe.ai/keys' },
  codiv: { base: 'https://api.codiv.ai', model: 'openjev-latest', images: true, extras: true, site: 'https://codiv.ai/dashboard' }
};
const NAMES = Object.keys(PROVIDERS);

const DEFAULTS = {
  provider: 'auto', // auto | typesafe | codiv
  timeout: 15000,
  steps: 1,         // denoise iterations, 1-8 (codiv only)
  samples: 1,       // repeated reads, averaged, 1-32 (codiv only)
  think: 0,         // thought token budget, 0-4096 (codiv only)
  retries: 1,
  parallel: 16      // calls in flight at once, 1-64
};

const NO_KEY = 'no jev key — run `bx jev key <key>` (TypeSafe apikey_… or codiv sk-codiv-…), or add one in the bx toolbar popup';

// Pooled, kept-alive connections. The API sits a ~210ms round trip away, and
// a fresh TCP + TLS handshake on every decision cost ~250ms of each ~1.4s
// call. The pool is sized above any `parallel`, so the gate below decides.
const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64 })
};

// Rolling tally so `bx jev` can show what the fast brain has actually cost.
const stats = { calls: 0, fails: 0, ms: 0, in: 0, out: 0, peak: 0 };

// How many calls are in flight at once. This used to be the socket pool's
// maxSockets of 4, which quietly queued everything past the fourth: a
// six-page `bx check` asks twelve questions at once and had them answered
// four at a time, three round trips where one would do.
let inflight = 0;
const waiting = [];
function slot(n) {
  const cap = Math.max(1, Math.min(Number(n) || DEFAULTS.parallel, 64));
  if (inflight < cap) { inflight++; stats.peak = Math.max(stats.peak, inflight); return Promise.resolve(); }
  return new Promise((ok) => waiting.push(ok));
}
// A freed slot passes straight to the next caller in line, so the count only
// drops when nobody is waiting.
function free() {
  const next = waiting.shift();
  if (next) next(); else inflight--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── keys ─────────────────────────────────────────────────────────────────
// A key says who issued it: TypeSafe's start apikey_, codiv's sk-codiv-.
function providerOf(k) {
  const s = String(k || '').trim();
  if (/^apikey_/.test(s)) return 'typesafe';
  if (/^sk-/.test(s)) return 'codiv';
  return null;
}

const mask = (k) => (k ? `${k.slice(0, 8)}…${k.slice(-4)}` : null);

// Every usable key, env first. An env key is never written to disk, which is
// how a shell overrides the machine's keys. codiv's own docs tell people to
// put an sk-codiv key in TYPESAFE_API_KEY, so the prefix decides, not the name.
function keys(cfg) {
  const out = [];
  for (const [env, dflt] of [['TYPESAFE_API_KEY', 'typesafe'], ['CODIV_API_KEY', 'codiv']]) {
    const v = (process.env[env] || '').trim();
    if (v) out.push({ id: `env:${env}`, provider: providerOf(v) || dflt, label: `env ${env}`, key: v, source: 'env' });
  }
  for (const k of (cfg && cfg.keys) || []) {
    if (k && k.key) out.push({ ...k, provider: PROVIDERS[k.provider] ? k.provider : providerOf(k.key) || 'codiv', source: 'config' });
  }
  return out;
}

// What each key has done since the bridge started, and whether it can be used
// right now. In memory only: a restart gives a refused key another chance.
const health = new Map();
function hp(id) {
  let h = health.get(id);
  if (!h) health.set(id, (h = { calls: 0, fails: 0, ms: 0, in: 0, used: 0, until: 0, spent: 0, bad: null, last: null }));
  return h;
}
function statusOf(h, now = Date.now()) {
  if (h.bad) return h.bad;
  if (h.spent > now) return 'out of credit';
  if (h.until > now) return 'rate-limited';
  return 'ok';
}

// ── routing ──────────────────────────────────────────────────────────────
const mode = (cfg) => (cfg && PROVIDERS[cfg.provider] ? cfg.provider : 'auto');
const conf = (cfg, p) => ({ base: (cfg && cfg[p] && cfg[p].base) || PROVIDERS[p].base, model: (cfg && cfg[p] && cfg[p].model) || PROVIDERS[p].model });
const has = (cfg, p) => keys(cfg).some((k) => k.provider === p && !hp(k.id).bad);

// A versioned model name belongs to one service; the jev-latest and
// jev-preview aliases are answered by both.
function modelProvider(m) {
  if (/^(openjev|diffusiongemma)/.test(m || '')) return 'codiv';
  if (/^jev-\d/.test(m || '')) return 'typesafe';
  return null;
}

// The services a call goes to, in order of preference, keeping only those
// with a key. Text goes to TypeSafe first under auto, since it was faster and
// more accurate. A screenshot can only be read by codiv; with no codiv key the
// call goes to TypeSafe without it. Choosing codiv or TypeSafe outright means
// text never fails over to the other.
function route(cfg, images, force) {
  if (force) return PROVIDERS[force] && has(cfg, force) ? [force] : [];
  const m = mode(cfg);
  const order = m === 'codiv' ? ['codiv']
    : images ? ['codiv', 'typesafe']
    : m === 'typesafe' ? ['typesafe'] : ['typesafe', 'codiv'];
  return order.filter((p) => has(cfg, p));
}

const ready = (cfg) => route(cfg, false).length > 0;
// Whether a screenshot would actually reach the model. When it would not,
// callers skip taking one: it costs ~2.5s and would be dropped.
const canSee = (cfg) => route(cfg, true).some((p) => PROVIDERS[p].images);

// The least recently used key of this provider that is free to call. None
// free: how long until the first rate-limited one is, or null if every key is
// refused or out of credit.
function nextKey(cfg, p) {
  const now = Date.now();
  const mine = keys(cfg).filter((k) => k.provider === p && !hp(k.id).bad && hp(k.id).spent <= now);
  const free = mine.filter((k) => hp(k.id).until <= now);
  if (free.length) {
    const k = free.reduce((a, b) => (hp(a.id).used <= hp(b.id).used ? a : b));
    hp(k.id).used = now;
    return { key: k };
  }
  return { wait: mine.length ? Math.min(...mine.map((k) => hp(k.id).until)) - now : null };
}

// ── transport ────────────────────────────────────────────────────────────
function post(base, key, payload, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(base.replace(/\/+$/, '') + '/v1/systemone');
    const data = Buffer.from(JSON.stringify(payload));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname, method: 'POST', agent: AGENTS[u.protocol],
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
        'content-length': data.length,
        'user-agent': 'bx/jev'
      }
    }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j) return resolve(j);
        // codiv and TypeSafe both answer {"detail":{"error_type","message"}}.
        const d = j && typeof j.detail === 'object' ? j.detail : null;
        const msg = (d && d.message) || (j && (j.error?.message || j.error || j.message || j.detail)) || b.slice(0, 200) || 'no body';
        const e = new Error(`jev ${res.statusCode}: ${msg}`);
        e.status = res.statusCode;
        e.type = (d && d.error_type) || (j && j.error?.type) || null;
        e.retryAfter = Number(res.headers['retry-after']) || null;
        reject(e);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`jev timeout after ${timeout}ms`)));
    req.write(data);
    req.end();
  });
}

// What a failure says about the key that made it.
function kind(e) {
  if (e.status === 401 || e.status === 403) return 'refused';
  if (e.status === 402 || /quota|insufficient|credit|balance|billing/i.test(`${e.type || ''} ${e.message || ''}`)) return 'spent';
  if (e.status === 429) return 'rate';
  if (e.status === 529 || e.status === 503 || /overloaded/i.test(e.message || '')) return 'busy';
  if (!e.status || e.status >= 500) return 'retry';
  return 'bad-request';
}

// Callers pass optional overrides straight through from an HTTP body, so most
// of them are undefined. Object.assign would happily use those to erase the
// defaults underneath.
function opts(cfg, over) {
  const o = Object.assign({}, DEFAULTS, cfg || {});
  for (const [k, v] of Object.entries(over || {})) if (v !== undefined) o[k] = v;
  // Each provider has its own model; only a per-call override replaces it.
  o.model = (over && over.model) || null;
  return o;
}

function payloadFor(p, cfg, o, state, questions, images) {
  const P = PROVIDERS[p];
  const payload = {
    model: o.model || conf(cfg, p).model,
    state: typeof state === 'string' ? state : JSON.stringify(state),
    questions
  };
  if (P.extras) {
    if (o.steps > 1) payload.steps = o.steps;
    if (o.samples > 1) payload.samples = o.samples;
    if (o.think > 0) payload.think = o.think;
  }
  // codiv refuses sequential answering once an image is attached ("sequential
  // needs a text state"), so a picture wins: the questions are then answered
  // side by side, which costs a little consistency and nothing else.
  if (images && P.images) payload.images = images;
  else if (o.sequential && P.extras) payload.sequential = true;
  return payload;
}

// One provider: rotate through its keys until one answers. A refused key is
// set aside for good, one out of credit for an hour, a rate-limited one until
// its window passes; the call moves straight on to the next key. With every
// key rate-limited, or the service overloaded, a call that has another
// provider to go to goes there at once; the last one in line waits for a key
// to come back, within the timeout, and backs off while overloaded.
async function askOn(p, cfg, o, state, questions, images, t0, last) {
  const base = conf(cfg, p).base;
  const payload = payloadFor(p, cfg, o, state, questions, images);
  let err = null, tries = 0, extra = 0, waited = 0;
  for (;;) {
    const pick = nextKey(cfg, p);
    if (!pick.key) {
      if (pick.wait === null || !last || pick.wait > o.timeout - waited) {
        throw err || new Error(`every ${p} key is ${pick.wait === null ? 'refused or out of credit' : 'rate-limited'} — bx jev keys`);
      }
      await sleep(pick.wait + 25);
      waited += pick.wait + 25;
      continue;
    }
    const k = pick.key, h = hp(k.id);
    try {
      // The slot is held for the request only, never across a retry's sleep.
      await slot(o.parallel);
      const t1 = Date.now();
      let r;
      try { r = await post(base, k.key, payload, o.timeout); } finally { free(); }
      const now = Date.now();
      h.calls++; h.ms += now - t1; h.in += r.usage?.input_tokens || 0; h.last = null;
      stats.calls++; stats.ms += now - t0;
      stats.in += r.usage?.input_tokens || 0;
      stats.out += r.usage?.output_tokens || 0;
      return { model: r.model, answers: r.answers || {}, usage: r.usage || {}, ms: now - t0, provider: p, key: k.label, saw: !!payload.images };
    } catch (e) {
      err = e;
      h.fails++; h.last = String(e.message || e).slice(0, 160);
      const kd = kind(e);
      if (kd === 'refused') { h.bad = `refused (${e.status})`; continue; }
      if (kd === 'spent') { h.spent = Date.now() + 3600e3; continue; }
      if (kd === 'rate') { h.until = Date.now() + Math.min(e.retryAfter || 10, 60) * 1000; continue; }
      if (kd === 'bad-request') throw e;
      // "Overloaded" (529, or 503) clears in seconds, not milliseconds: one
      // retry 350ms later failed twice in a row on a real run. Those get three
      // more tries at 1s, 2s and 4s; everything else keeps the short retry.
      const busy = kd === 'busy';
      if (busy && extra === 0) extra = 3;
      if (!last || tries >= o.retries + extra) throw e;
      await sleep(busy ? 1000 * 2 ** Math.min(tries, 2) : 350 * (tries + 1));
      tries++;
    }
  }
}

// One round trip, however many questions. Asking six things at once costs
// barely more than asking one, which is why the agent loop packs an entire
// step's reasoning into a single call. When a provider fails outright, the
// next one in the route gets the same call.
async function ask(state, questions, cfg, over) {
  const o = opts(cfg, over);
  if (!questions || !Object.keys(questions).length) throw new Error('jev needs at least one question');
  const images = o.images && o.images.length ? o.images : null;
  const order = route(cfg, !!images, (over && over.provider) || modelProvider(o.model));
  if (!order.length) throw new Error(NO_KEY);
  const t0 = Date.now();
  let last;
  for (const [i, p] of order.entries()) {
    try { return await askOn(p, cfg, o, state, questions, images, t0, i === order.length - 1); }
    catch (e) { last = e; }
  }
  stats.fails++;
  throw last;
}

// One small call with this key alone, outside the rotation, so a key is known
// to work before it is saved.
async function test(key, provider, cfg) {
  const p = PROVIDERS[provider] ? provider : providerOf(key);
  if (!p) return { ok: false, error: 'cannot tell whose key this is — pass the provider (typesafe or codiv)' };
  const t0 = Date.now();
  try {
    const r = await post(conf(cfg, p).base, key, { model: conf(cfg, p).model, state: 'Order #1 is confirmed.', questions: { q: { type: 'noul', instructions: 'An order is confirmed.' } } }, 15000);
    return { ok: true, provider: p, model: r.model, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, provider: p, status: e.status || null, refused: kind(e) === 'refused', error: String(e.message || e).slice(0, 200) };
  }
}

// Everything `bx jev` and the popup show. Keys come back masked, never whole.
function describe(cfg) {
  const now = Date.now();
  const all = keys(cfg);
  return {
    provider: mode(cfg),
    route: { text: route(cfg, false)[0] || null, images: route(cfg, true).find((p) => PROVIDERS[p].images) || null },
    providers: Object.fromEntries(NAMES.map((p) => [p, { ...conf(cfg, p), images: PROVIDERS[p].images, site: PROVIDERS[p].site, keys: all.filter((k) => k.provider === p).length }])),
    keys: all.map((k) => {
      const h = hp(k.id);
      const wait = Math.max(h.until, h.spent) - now;
      return {
        id: k.id, provider: k.provider, label: k.label, key: mask(k.key), source: k.source, added: k.added || null,
        status: statusOf(h, now), ...(wait > 0 && !h.bad ? { back_in_s: Math.ceil(wait / 1000) } : {}),
        calls: h.calls, failed: h.fails, avg_ms: h.calls ? Math.round(h.ms / h.calls) : 0, input_tokens: h.in,
        ...(h.last ? { last_error: h.last } : {})
      };
    })
  };
}

// Flatten any answer type into {value, confidence, p} so callers can gate on
// one number. noul comes back as a bare probability with no confidence field,
// so derive it: 0.5 is a coin flip (0 confidence), 0 or 1 is certainty.
function read(ans) {
  if (!ans) return { value: null, confidence: 0 };
  if (ans.type === 'noul' || typeof ans.noul === 'number') {
    const p = ans.noul ?? 0;
    return { value: p >= 0.5, p, confidence: Math.abs(p - 0.5) * 2 };
  }
  if (ans.type === 'choice' || ans.choice !== undefined) {
    const probs = ans.probabilities || {};
    const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    return {
      value: ans.choice,
      p: probs[ans.choice] ?? null,
      confidence: ans.confidence ?? 0,
      ranked: ranked.slice(0, 5).map(([k, v]) => ({ label: k, p: v }))
    };
  }
  if (ans.type === 'score' || ans.score !== undefined) {
    return { value: ans.score, confidence: ans.confidence ?? 0, legend: ans.legend, p: null };
  }
  return { value: null, confidence: 0 };
}

const busy = () => ({ inflight, waiting: waiting.length });

module.exports = { ask, read, ready, canSee, route, keys, providerOf, modelProvider, mask, test, describe, stats, busy, PROVIDERS, DEFAULTS };
