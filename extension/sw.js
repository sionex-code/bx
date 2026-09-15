'use strict';
// bx service worker: WebSocket client to the local bridge, batch runner,
// tab plumbing, and the CDP escalation path.

const PORTS = [8787, 8788, 8789];
const CFG = { speed: 'fast', trusted: false, timeout: 8000, shot_format: 'jpeg', shot_quality: 72 };

let sock = null;
let portIdx = 0;
let backoff = 200;
let retryTimer = null;

// ── connection ───────────────────────────────────────────────────────────
function connect() {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  clearTimeout(retryTimer); retryTimer = null;
  const port = PORTS[portIdx % PORTS.length];
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/ext`); }
  catch { return schedule(); }
  sock = ws;
  let opened = false;

  // A socket that hangs in CONNECTING used to wedge the extension for good:
  // connect() bails out while one is pending, so nothing ever retried. Two
  // seconds is generous for a loopback handshake.
  const stuck = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 2000);

  ws.onopen = () => {
    opened = true;
    clearTimeout(stuck);
    backoff = 200;
    ws.send(JSON.stringify({ t: 'hi', ua: navigator.userAgent, chrome: navigator.userAgentData?.brands }));
  };
  ws.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'ka') { ws.send('{"t":"ka"}'); return; }
    if (m.t === 'hello' || m.t === 'cfg') { Object.assign(CFG, m.cfg || {}); return; }
    // Escape hatch: restarts the worker from a clean slate after an edit, or
    // when it has wedged badly enough that reconnecting is not enough.
    if (m.t === 'reload') { chrome.runtime.reload(); return; }
    if (m.t !== 'run') return;
    try {
      const r = await runBatch(m);
      ws.send(JSON.stringify({ id: m.id, r }));
    } catch (err) {
      ws.send(JSON.stringify({ id: m.id, error: String((err && err.message) || err) }));
    }
  };
  ws.onclose = () => {
    clearTimeout(stuck);
    if (sock === ws) sock = null;
    // Only walk to the next port when this one never answered. Advancing on
    // every close sent us hunting through 8788/8789 — ports the bridge never
    // binds — after any ordinary bridge restart, which is what made bx sit at
    // "not connected" for a minute at a time.
    if (opened) { portIdx = 0; backoff = 200; } else portIdx++;
    schedule();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function schedule() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff + Math.random() * 120);
  backoff = Math.min(Math.round(backoff * 1.6), 3000);
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.create('bx-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!sock || sock.readyState > 1) connect(); });
// Ordinary browsing wakes a dormant worker far sooner than the alarm would,
// so the bridge is reachable within a keystroke of the browser starting.
const wake = () => { if (!sock || sock.readyState > 1) connect(); };
chrome.tabs.onActivated.addListener(wake);
chrome.tabs.onUpdated.addListener(wake);
chrome.windows.onFocusChanged.addListener(wake);
connect();

// ── helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what || 'action'} timed out after ${ms}ms`)), ms); })
  ]);
}

async function resolveTab(spec) {
  if (typeof spec === 'number') return spec;
  if (spec && spec !== 'active' && spec !== 'current') {
    const all = await chrome.tabs.query({});
    const hit = all.find((t) => (t.url || '').includes(String(spec)) || (t.title || '').toLowerCase().includes(String(spec).toLowerCase()));
    if (hit) return hit.id;
    throw new Error(`no tab matching "${spec}"`);
  }
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true });
  if (!t) throw new Error('no active tab');
  return t.id;
}

async function inject(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId ?? 0] },
    files: ['content/core.js', 'content/mouse.js', 'content/keyboard.js', 'content/actions.js'],
    injectImmediately: true
  });
}

function ask(tabId, frameId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, frameId === undefined ? {} : { frameId }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error('no response from page'));
      if (res.ok) return resolve(res.r);
      reject(new Error(res.e));
    });
  });
}

// Anything that only observes, so re-running it after the page moved under us
// costs nothing. A click is deliberately not on this list: if it navigated, it
// already did its job, and doing it again on the new page would not be a retry.
const REPEATABLE = new Set(['wait', 'exists', 'read', 'elements', 'info', 'box', 'path']);
const isGone = (e) => /Could not establish connection|Receiving end does not exist/i.test(String(e && e.message));
// A click that triggers navigation leaves the old document in bfcache with our
// message port still attached, and the port dies with it. The action was
// talking to a document that no longer exists — so ask the new one. Without
// this, every flow ending in "submit, then wait for the next page" reported a
// failure it had not actually had.
const isStaleDoc = (e) => /back\/forward cache|message channel is closed/i.test(String(e && e.message));

async function toFrame(tabId, frameId, action, cfg) {
  const payload = { __bx: 1, a: action, cfg };
  try { return await ask(tabId, frameId, payload); }
  catch (e) {
    const stale = isStaleDoc(e) && REPEATABLE.has(action.a);
    if (!isGone(e) && !stale) throw e;
    // The replacement document may still be arriving; its own content scripts
    // run at document_start, and inject() is idempotent either way.
    if (stale) { await waitForLoad(tabId, 5000).catch(() => {}); await sleep(60); }
    await inject(tabId, frameId);
    return ask(tabId, frameId, payload);
  }
}

const isMiss = (e) => /BX_NOTFOUND/.test(String((e && e.message) || e));
const isNoScript = (e) => /Could not establish|Receiving end|Frame with ID|cannot be scripted|Cannot access|chrome-error|The extensions gallery/i.test(String((e && e.message) || e));
const noScriptError = (url) => new Error(
  `this tab can't be scripted${url ? ` (${url.split('?')[0].slice(0, 60)})` : ''} — chrome:// pages, the Web Store, PDFs and error pages are off limits`
);

// Ask every frame at once which one holds the target, then act only in the
// winner. The old path polled frames in series with 120ms slices and looped
// until the deadline, so a page with a dozen ad iframes burned seconds of
// round trips — and ran the expensive search in each frame over and over —
// before it even reached the frame holding the element.
function probeFrames(tabId, frames, action, cfg, budget) {
  return new Promise((resolve) => {
    let left = frames.length, done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => finish(null), budget + 500);
    const miss = () => { if (--left <= 0) finish(null); };
    for (const fid of frames) {
      toFrame(tabId, fid, { a: 'exists', target: action.target, timeout: budget }, cfg)
        .then((r) => (r && r.exists ? finish(fid) : miss()), miss);
    }
  });
}

// How much of the budget the first attempt on the main frame gets. A short
// probe is right for a lookup — nearly every target is right there, and only a
// real miss should pay for enumerating frames. It is wrong for an action whose
// whole job is to wait: `wait` and `exists` were being handed 150ms and
// answering "timed out" / "no" long before their own deadline.
const MAIN_SHARE = { wait: 1, exists: 1, fill: 0.6 };

async function toContent(tabId, action, cfg) {
  const total = action.timeout ?? cfg.timeout ?? 8000;
  const deadline = Date.now() + total;
  const share = MAIN_SHARE[action.a];
  const first = share ? Math.round(total * share) : Math.min(200, total);

  try { return await toFrame(tabId, 0, { ...action, timeout: first }, cfg); }
  catch (e) {
    if (isNoScript(e)) { const tab = await chrome.tabs.get(tabId).catch(() => null); throw noScriptError(tab && tab.url); }
    if (action.frames === false || !isMiss(e)) throw e;
  }

  let others = [];
  try { others = ((await chrome.webNavigation.getAllFrames({ tabId })) || []).filter((f) => f.frameId !== 0).slice(0, 30); }
  catch {}

  const notFound = () => new Error(`BX_NOTFOUND ${JSON.stringify(action.target ?? action.a)}`);
  const left = () => deadline - Date.now();
  if (left() <= 0) throw notFound();

  // Actions with a target get a read-only probe race first, so a click can
  // never fire in two frames at once. Targetless ones (fill, read, elements)
  // get one pass, budget shared, instead of the old spin.
  if (action.target !== undefined && action.target !== null) {
    const budget = Math.max(300, left());
    const fid = await probeFrames(tabId, [0, ...others.map((f) => f.frameId)], action, cfg, budget);
    if (fid === null) throw notFound();
    return toFrame(tabId, fid, { ...action, timeout: Math.max(1500, left()), frames: false }, cfg);
  }

  for (const f of others) {
    const slice = Math.max(200, Math.floor(left() / Math.max(1, others.length)));
    try { return await toFrame(tabId, f.frameId, { ...action, timeout: slice }, cfg); }
    catch (e) { if (!isMiss(e) && !isNoScript(e)) throw e; }
    if (left() <= 0) break;
  }
  throw notFound();
}

// status:'complete' means every subresource landed — on an ad-heavy page or a
// long-polling app that can be ten seconds after the page is perfectly usable,
// and every element action auto-waits anyway. Resolve on whichever comes first:
// the main frame's DOMContentLoaded, or a real 'complete'.
function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v, err) => {
      if (done) return; done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      try { chrome.webNavigation.onDOMContentLoaded.removeListener(onDom); } catch {}
      clearTimeout(timer);
      err ? reject(err) : resolve(v);
    };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(true); };
    const onDom = (d) => { if (d.tabId === tabId && d.frameId === 0) finish(true); };
    const timer = setTimeout(() => finish(true), timeout); // soft: never fail a nav on slow assets
    chrome.tabs.onUpdated.addListener(onUpd);
    try { chrome.webNavigation.onDOMContentLoaded.addListener(onDom); } catch {}
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(true); }).catch((e) => finish(null, e));
  });
}

// ── CDP escalation ───────────────────────────────────────────────────────
const attached = new Set();

function cdp(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (res) => {
      const e = chrome.runtime.lastError;
      if (e) return reject(new Error(`${method}: ${e.message}`));
      resolve(res);
    });
  });
}

async function withCdp(tabId, fn) {
  const target = { tabId };
  let mine = false;
  if (!attached.has(tabId)) {
    try { await chrome.debugger.attach(target, '1.3'); attached.add(tabId); mine = true; }
    catch (e) {
      if (/already attached/i.test(e.message)) attached.add(tabId);
      else throw new Error(`debugger attach failed: ${e.message} (close DevTools on that tab)`);
    }
  }
  try { return await fn(target); }
  finally {
    if (mine) { attached.delete(tabId); try { await chrome.debugger.detach(target); } catch {} }
  }
}

chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

async function cdpClick(tabId, x, y, button = 'left', clicks = 1) {
  return withCdp(tabId, async (t) => {
    await cdp(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
    const mask = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    for (let i = 1; i <= clicks; i++) {
      await cdp(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: i, pointerType: 'mouse' });
      await sleep(20 + Math.random() * 40);
      await cdp(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, pointerType: 'mouse' });
      if (i < clicks) await sleep(50);
    }
    return { trusted: true, at: [Math.round(x), Math.round(y)] };
  });
}

async function cdpType(tabId, text) {
  return withCdp(tabId, async (t) => {
    for (const ch of String(text)) {
      if (ch === '\n') {
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      } else {
        await cdp(t, 'Input.insertText', { text: ch });
      }
      await sleep(CFG.speed === 'human' ? 50 + Math.random() * 90 : 6 + Math.random() * 10);
    }
    return { trusted: true, len: String(text).length };
  });
}

// ── screenshots ──────────────────────────────────────────────────────────
async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function encode(bitmap, fmt, quality) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  c.getContext('2d').drawImage(bitmap, 0, 0);
  const blob = await c.convertToBlob({ type: `image/${fmt === 'jpg' ? 'jpeg' : fmt}`, quality: quality / 100 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { b64: btoa(s), w: bitmap.width, h: bitmap.height };
}

// Chrome caps captureVisibleTab at two calls a second; a batch that shoots
// twice in a row used to fail outright on the quota error.
async function captureVisible(windowId, opts) {
  for (let i = 0; ; i++) {
    try { return await chrome.tabs.captureVisibleTab(windowId, opts); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (i >= 3 || !/MAX_CAPTURE|per second|quota/i.test(msg)) throw e;
      await sleep(300);
    }
  }
}

async function shot(tabId, a, cfg) {
  const fmt = (a.format || CFG.shot_format) === 'png' ? 'png' : 'jpeg';
  const quality = a.quality ?? CFG.shot_quality;
  const ext = fmt === 'png' ? 'png' : 'jpg';

  if (a.fullPage) {
    return withCdp(tabId, async (t) => {
      const m = await cdp(t, 'Page.getLayoutMetrics');
      const s = m.cssContentSize || m.contentSize;
      const res = await cdp(t, 'Page.captureScreenshot', {
        format: fmt, quality: fmt === 'jpeg' ? quality : undefined,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: s.width, height: Math.min(s.height, a.maxHeight || 20000), scale: a.scale || 1 }
      });
      return { __img: { b64: res.data, ext, w: Math.round(s.width), h: Math.round(s.height) } };
    });
  }

  const tab = await chrome.tabs.get(tabId);
  let dataUrl;
  if (tab.active) {
    dataUrl = await captureVisible(tab.windowId, { format: fmt, quality });
  } else {
    // captureVisibleTab can only see the foreground tab; go through CDP rather
    // than yanking a background tab into focus.
    const b64 = await withCdp(tabId, async (t) => {
      const r = await cdp(t, 'Page.captureScreenshot', { format: fmt, quality: fmt === 'jpeg' ? quality : undefined });
      return r.data;
    });
    if (!a.target && !a.maxWidth) return { __img: { b64, ext } };
    dataUrl = `data:image/${fmt};base64,${b64}`;
  }

  if (!a.target && !a.maxWidth) {
    const head = dataUrl.indexOf(',') + 1;
    return { __img: { b64: dataUrl.slice(head), ext } };
  }

  let bmp = await dataUrlToBitmap(dataUrl);
  if (a.target) {
    const box = await toContent(tabId, { a: 'box', target: a.target, timeout: a.timeout }, cfg);
    const dpr = bmp.width / (await toContent(tabId, { a: 'info' }, cfg)).size[0];
    const pad = a.pad ?? 4;
    const crop = {
      x: Math.max(0, (box.x - pad) * dpr), y: Math.max(0, (box.y - pad) * dpr),
      w: Math.min(bmp.width, (box.w + pad * 2) * dpr), h: Math.min(bmp.height, (box.h + pad * 2) * dpr)
    };
    bmp = await createImageBitmap(bmp, crop.x, crop.y, Math.max(1, crop.w), Math.max(1, crop.h));
  }
  if (a.maxWidth && bmp.width > a.maxWidth) {
    bmp = await createImageBitmap(bmp, { resizeWidth: a.maxWidth, resizeQuality: 'medium' });
  }
  const img = await encode(bmp, ext, quality);
  return { __img: { ...img, ext } };
}

// ── actions that live in the worker ──────────────────────────────────────
const W = {};

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.local)(:|\/|$)/i;
const toUrl = (raw) => {
  const url = String(raw).trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;      // already has a scheme
  return (LOCAL.test(url) ? 'http://' : 'https://') + url;
};

W.nav = async (tabId, a) => {
  const url = toUrl(a.url);
  await chrome.tabs.update(tabId, { url });
  if (a.wait !== false) await waitForLoad(tabId, a.timeout ?? 15000);
  const t = await chrome.tabs.get(tabId);
  return { url: t.url, title: t.title, status: t.status };
};

W.back = async (tabId, a) => { await chrome.tabs.goBack(tabId); if (a.wait !== false) await waitForLoad(tabId, 15000); const t = await chrome.tabs.get(tabId); return { url: t.url }; };
W.forward = async (tabId, a) => { await chrome.tabs.goForward(tabId); if (a.wait !== false) await waitForLoad(tabId, 15000); const t = await chrome.tabs.get(tabId); return { url: t.url }; };
W.reload = async (tabId, a) => { await chrome.tabs.reload(tabId, { bypassCache: !!a.hard }); if (a.wait !== false) await waitForLoad(tabId, 20000); const t = await chrome.tabs.get(tabId); return { url: t.url }; };

W.tabs = async () => {
  const tabs = await chrome.tabs.query({});
  return { n: tabs.length, tabs: tabs.map((t) => ({ id: t.id, active: t.active || undefined, title: (t.title || '').slice(0, 70), url: t.url, win: t.windowId, audible: t.audible || undefined })) };
};

W.newtab = async (_t, a) => {
  const t = await chrome.tabs.create({ url: a.url ? toUrl(a.url) : undefined, active: a.active !== false });
  if (a.url && a.wait !== false) await waitForLoad(t.id, a.timeout ?? 20000);
  const fresh = await chrome.tabs.get(t.id);
  return { id: t.id, url: fresh.url, title: fresh.title };
};

W.tab = async (_t, a) => {
  const id = await resolveTab(a.id ?? a.target);
  await chrome.tabs.update(id, { active: true });
  const t = await chrome.tabs.get(id);
  await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
  return { id, url: t.url, title: t.title };
};

W.closetab = async (tabId, a) => {
  const id = a.id !== undefined ? await resolveTab(a.id) : tabId;
  await chrome.tabs.remove(id);
  return { closed: id };
};

W.shot = (tabId, a, cfg) => shot(tabId, a, cfg);

W.eval = async (tabId, a) =>
  withCdp(tabId, async (t) => {
    const res = await cdp(t, 'Runtime.evaluate', {
      expression: a.expr ?? a.code,
      returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true, userGesture: !!a.gesture
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return { value: res.result?.value ?? null, type: res.result?.type };
  });

W.upload = async (tabId, a, cfg) => {
  const files = [].concat(a.files || a.file);
  if (!files.length) throw new Error('upload needs files:[absolute paths]');

  // Path A: the target is (or wraps) a real <input type=file>.
  if (!a.viaDialog) {
    const p = await toContent(tabId, { a: 'path', target: a.target, timeout: a.timeout }, cfg);
    return withCdp(tabId, async (t) => {
      const { root } = await cdp(t, 'DOM.getDocument', { depth: 0 });
      const { nodeId } = await cdp(t, 'DOM.querySelector', { nodeId: root.nodeId, selector: p.css });
      if (!nodeId) throw new Error(`could not address ${p.css} over CDP`);
      await cdp(t, 'DOM.setFileInputFiles', { files, nodeId });
      return { uploaded: files.length, files, via: 'input' };
    });
  }

  // Path B: a custom widget — intercept the chooser the click would open. The
  // click has to be trusted: a synthetic one carries no user activation, and
  // input.click() on a file input is a no-op without it.
  const box = await toContent(tabId, { a: 'box', target: a.target, timeout: a.timeout }, cfg);
  return withCdp(tabId, async (t) => {
    await cdp(t, 'Page.enable');
    await cdp(t, 'Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const got = new Promise((resolve, reject) => {
        const to = setTimeout(() => { chrome.debugger.onEvent.removeListener(h); reject(new Error('no file chooser opened')); }, a.timeout ?? 8000);
        const h = (src, method, params) => {
          if (src.tabId !== tabId || method !== 'Page.fileChooserOpened') return;
          clearTimeout(to); chrome.debugger.onEvent.removeListener(h); resolve(params);
        };
        chrome.debugger.onEvent.addListener(h);
      });
      const x = box.x + box.w / 2, y = box.y + box.h / 2;
      await cdp(t, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
      await cdp(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      await sleep(25);
      await cdp(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
      const ev = await got;
      if (ev.backendNodeId) await cdp(t, 'DOM.setFileInputFiles', { files, backendNodeId: ev.backendNodeId });
      else {
        const { root } = await cdp(t, 'DOM.getDocument', { depth: 0 });
        const { nodeId } = await cdp(t, 'DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
        if (!nodeId) throw new Error('file chooser opened but its input could not be addressed');
        await cdp(t, 'DOM.setFileInputFiles', { files, nodeId });
      }
      return { uploaded: files.length, files, via: 'dialog' };
    } finally {
      try { await cdp(t, 'Page.setInterceptFileChooserDialog', { enabled: false }); } catch {}
    }
  });
};

W.cookies = async (tabId, a) => {
  const t = await chrome.tabs.get(tabId);
  if (a.set) { const c = await chrome.cookies.set({ url: a.set.url || t.url, ...a.set }); return { set: !!c, cookie: c }; }
  if (a.remove) { await chrome.cookies.remove({ url: a.remove.url || t.url, name: a.remove.name }); return { removed: a.remove.name }; }
  const list = await chrome.cookies.getAll({ url: a.url || t.url });
  return { n: list.length, cookies: list.map((c) => ({ name: c.name, value: a.values ? c.value : undefined, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate })) };
};

W.sleep = async (_t, a) => { await sleep(a.ms || 200); return { slept: a.ms || 200 }; };

// ── batch runner ─────────────────────────────────────────────────────────
const PER_CHAR = { instant: 0, fast: 14, human: 190 };

function typingMs(a, speed) {
  const chars = a.a === 'type' ? String(a.text ?? '').length
    : a.a === 'fill' && a.fields && !a.fast ? Object.values(a.fields).join('').length
    : 0;
  return chars * (PER_CHAR[a.speed || speed] ?? PER_CHAR.fast);
}

async function exec(tabId, a, cfg, batch) {
  // trusted:true (per action, or globally) routes input through CDP
  const trusted = a.trusted ?? batch.trusted;
  if (trusted && (a.a === 'click' || a.a === 'dblclick')) {
    const box = await toContent(tabId, { a: 'box', target: a.target, timeout: a.timeout }, cfg);
    return cdpClick(tabId, box.x + box.w / 2, box.y + box.h / 2, a.button === 'right' ? 'right' : 'left', a.a === 'dblclick' ? 2 : (a.clicks || 1));
  }
  if (trusted && a.a === 'type') {
    await toContent(tabId, { a: 'click', target: a.target, speed: a.speed }, cfg);
    if (a.clear !== false) await toContent(tabId, { a: 'clear', target: a.target }, cfg);
    const r = await cdpType(tabId, a.text);
    if (a.enter) await withCdp(tabId, async (t) => {
      await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });
    return r;
  }
  if (W[a.a]) return W[a.a](tabId, a, cfg);
  return toContent(tabId, a, cfg);
}

// The bridge keys everything it learns on the site, so every batch says where
// it started and where it ended up. Two tab lookups, no page contact.
const tabUrl = async (id) => { try { return (await chrome.tabs.get(id)).url || null; } catch { return null; } };

async function runBatch(m) {
  const t0 = performance.now();
  const cfg = { speed: m.speed || CFG.speed, timeout: m.timeout || CFG.timeout, trusted: false };
  let tabId = await resolveTab(m.tab);
  const url0 = await tabUrl(tabId);
  const results = [];

  for (const a of m.actions) {
    const s = performance.now();
    // Typing is paced per character, so a long string legitimately outruns the
    // element-wait budget — a 1500-character prompt used to die on "type timed
    // out" after doing most of the work. Give the keystrokes their own room.
    const budget = (a.timeout ?? m.timeout ?? CFG.timeout) + 4000 + typingMs(a, cfg.speed);
    try {
      const r = await withTimeout(exec(tabId, { speed: cfg.speed, ...a }, cfg, m), budget, a.a);
      // let newtab/tab hand the rest of the batch its new tab
      if ((a.a === 'newtab' || a.a === 'tab') && r && r.id) tabId = r.id;
      results.push({ a: a.a, ok: true, ms: Math.round(performance.now() - s), r });
    } catch (e) {
      const msg = String((e && e.message) || e).replace(/^BX_NOTFOUND /, 'not found: ');
      results.push({ a: a.a, ok: false, ms: Math.round(performance.now() - s), error: msg });
      if (m.stopOnError !== false) break;
    }
  }
  return { tab: tabId, ms: Math.round(performance.now() - t0), url0, url: await tabUrl(tabId), results };
}
