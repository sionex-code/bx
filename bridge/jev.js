'use strict';
// jev.js — the fast half of the brain.
//
// OpenJev (codiv.ai "System One") does not write prose. You hand it a state
// and a set of questions you defined up front — yes/no ("noul"), one of N
// labels ("choice"), a point on a scale ("score") — and it hands back a
// calibrated probability distribution over each one. No tokens to generate,
// so an answer lands in a fraction of the time a chat model needs to say the
// same thing in sentences.
//
// That happens to be the exact shape of every decision a browser agent makes:
// which of these 40 elements do I click, is the goal already done, is this a
// captcha wall. So bx asks jev, acts, and only escalates to a big model when
// jev says it is not sure.
//
// Zero dependencies. One endpoint. Never logs the key.
const https = require('https');
const http = require('http');

const DEFAULTS = {
  base: 'https://api.codiv.ai',
  model: 'openjev-latest',
  timeout: 15000,
  steps: 1,         // denoise iterations, 1-8
  samples: 1,       // repeated reads, averaged, 1-32
  think: 0,         // thought token budget, 0-4096
  retries: 1
};

// One pooled connection per protocol. The API sits a ~210ms round trip away,
// and a fresh TCP + TLS handshake on every decision cost ~250ms of each ~1.4s
// call. Steps come seconds apart, well inside the idle window.
const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 4 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 4 })
};

// Rolling tally so `bx jev` can show what the fast brain has actually cost.
const stats = { calls: 0, fails: 0, ms: 0, in: 0, out: 0 };

// Env wins over config so a shell can override a machine-wide key without
// rewriting it to disk. Both spellings exist in the wild: codiv issues the
// key, TypeSafe's own SDK reads TYPESAFE_API_KEY.
function key(cfg) {
  return process.env.CODIV_API_KEY || process.env.TYPESAFE_API_KEY || (cfg && cfg.api_key) || null;
}

const ready = (cfg) => !!key(cfg);

// Callers pass optional overrides straight through from an HTTP body, so most
// of them are undefined. Object.assign would happily use those to erase the
// defaults underneath — including the model, which the API then rejects.
function opts(cfg, over) {
  const o = Object.assign({}, DEFAULTS, cfg || {});
  for (const [k, v] of Object.entries(over || {})) if (v !== undefined) o[k] = v;
  return o;
}

function post(o, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(o.base.replace(/\/+$/, '') + '/v1/systemone');
    const data = Buffer.from(JSON.stringify(payload));
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname, method: 'POST', agent: AGENTS[u.protocol],
      headers: {
        'authorization': `Bearer ${o.key}`,
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
        const msg = (j && (j.error?.message || j.error || j.message)) || b.slice(0, 200) || 'no body';
        const e = new Error(`jev ${res.statusCode}: ${msg}`);
        e.status = res.statusCode;
        reject(e);
      });
    });
    req.on('error', reject);
    req.setTimeout(o.timeout, () => req.destroy(new Error(`jev timeout after ${o.timeout}ms`)));
    req.write(data);
    req.end();
  });
}

// One round trip, however many questions. Asking six things at once costs
// barely more than asking one, which is why the agent loop packs an entire
// step's reasoning into a single call.
async function ask(state, questions, cfg, over) {
  const o = opts(cfg, over);
  o.key = o.key || key(cfg);
  if (!o.key) throw new Error('no jev key — run `bx jev key sk-...` or set CODIV_API_KEY');
  if (!questions || !Object.keys(questions).length) throw new Error('jev needs at least one question');

  const payload = {
    model: o.model,
    state: typeof state === 'string' ? state : JSON.stringify(state),
    questions
  };
  if (o.steps > 1) payload.steps = o.steps;
  if (o.samples > 1) payload.samples = o.samples;
  if (o.think > 0) payload.think = o.think;
  // The API refuses sequential answering once an image is attached ("sequential
  // needs a text state"), so a picture wins: the questions are then answered
  // side by side, which costs a little consistency and nothing else.
  if (o.images && o.images.length) payload.images = o.images;
  else if (o.sequential) payload.sequential = true;

  const t0 = Date.now();
  let last;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    try {
      const r = await post(o, payload);
      const ms = Date.now() - t0;
      stats.calls++; stats.ms += ms;
      stats.in += r.usage?.input_tokens || 0;
      stats.out += r.usage?.output_tokens || 0;
      return { model: r.model, answers: r.answers || {}, usage: r.usage || {}, ms };
    } catch (e) {
      last = e;
      // 4xx other than rate limiting is our own bad request — retrying it
      // just burns another second on the same mistake.
      const retryable = !e.status || e.status === 429 || e.status >= 500;
      if (!retryable || attempt === o.retries) break;
      await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  stats.fails++;
  throw last;
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

module.exports = { ask, read, ready, key, stats, DEFAULTS };
