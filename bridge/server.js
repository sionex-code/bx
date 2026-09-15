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
  shot_quality: 72
};

function loadConfig() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SHOTS, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch {}
  cfg = Object.assign({}, DEFAULTS, cfg);
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
        home: HOME
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
      const b = await body(req);
      let actions = Array.isArray(b) ? b : Array.isArray(b.actions) ? b.actions : b.a ? [b] : null;

      // A recipe is just a stored batch with the values left out. Expanding it
      // here means every client — CLI, curl, some other agent — replays the
      // same way, and the run is scored against the recipe afterwards.
      let recipe = null;
      if (b.recipe) {
        const host = b.host || (await hostNow());
        const x = mem.expand(host, b.recipe, b.vars || {});
        if (x.error) return send(res, 404, { ok: false, error: x.error });
        actions = x.actions;
        recipe = { host: x.host, name: b.recipe };
      }
      if (!actions || !actions.length) return send(res, 400, { ok: false, error: 'no actions' });
      if (!ext && !(await waitForExt(b.wait ?? 10000))) {
        return send(res, 503, { ok: false, error: 'extension not connected — load extension/ at chrome://extensions, or open any tab to wake it' });
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
        const info = mem.learn({ actions, results: out.results, url0: out.url0, url: out.url });
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

      return send(res, 200, { ok, ...out, ...(memory ? { memory } : {}) });
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
      return send(res, r ? 200 : 400, r ? { ok: true, ...r } : { ok: false, error: 'empty note' });
    }

    if (route === '/memory/learn' && req.method === 'POST') {
      const b = await body(req);
      const host = b.host || (await hostNow());
      if (!host) return send(res, 400, { ok: false, error: 'no site in view — pass a host' });
      if (!b.name) return send(res, 400, { ok: false, error: 'learn needs a name' });
      const r = mem.promote(host, b.name, { index: b.index, steps: b.steps, note: b.note, path: b.path });
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

    return send(res, 404, { ok: false, error: `no route ${req.method} ${route}` });
  } catch (e) {
    note('err', { error: String(e.message || e) });
    return send(res, 500, { ok: false, error: String(e.message || e) });
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
