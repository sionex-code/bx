'use strict';
// bx service worker: WebSocket client to the local bridge, batch runner,
// tab plumbing, and the CDP escalation path.

const PORTS = [8787, 8788, 8789];
const CFG = { speed: 'fast', trusted: false, timeout: 8000, shot_format: 'jpeg', shot_quality: 72 };

let sock = null;
let portIdx = 0;
let backoff = 200;
let retryTimer = null;

// Chrome runs one copy of this worker in every profile that has bx loaded,
// and every copy dials the same bridge. This id says which profile a socket
// is, so the bridge can let a restarted worker replace its own old socket
// without knocking another profile's off — two profiles doing exactly that
// every few seconds was the "no active tab" / "extension disconnected" loop.
let IID = null;
const iidReady = chrome.storage.local.get('iid').then(async (got) => {
  IID = got.iid || crypto.randomUUID();
  if (!got.iid) await chrome.storage.local.set({ iid: IID });
}).catch(() => { IID = IID || crypto.randomUUID(); });

// What the bridge needs to choose between profiles: whether the user has a
// window open in this one, and how recently they used it. bx's own window is
// left out — it says nothing about where the user is browsing.
async function presence() {
  const p = await place();
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const wins = all.filter((w) => w.id !== p.win);
  const tabs = (await chrome.tabs.query({}).catch(() => [])).filter((t) => t.windowId !== p.win);
  const used = tabs.reduce((m, t) => Math.max(m, t.lastAccessed || 0), 0);
  await modeReady;
  return {
    windows: wins.length, tabs: tabs.length, focused: wins.some((w) => w.focused), used: Math.round(used),
    own: MODE.own, bxWindow: all.some((w) => w.id === p.win)
  };
}
function report() {
  if (!sock || sock.readyState !== 1) return;
  const ws = sock;
  presence().then((p) => { try { ws.send(JSON.stringify({ t: 'st', ...p })); } catch {} });
}

// ── connection ───────────────────────────────────────────────────────────
function connect() {
  if (sock && (sock.readyState === 0 || sock.readyState === 1)) return;
  if (!IID) { iidReady.then(connect); return; }
  clearTimeout(retryTimer); retryTimer = null;
  const port = PORTS[portIdx % PORTS.length];
  let ws;
  try { ws = new WebSocket(`ws://127.0.0.1:${port}/ext?iid=${IID}`); }
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
    report();
  };
  ws.onmessage = async (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'ka') { ws.send('{"t":"ka"}'); return; }
    if (m.t === 'hello' || m.t === 'cfg') { Object.assign(CFG, m.cfg || {}); return; }
    if (m.t === 'rs') { const p = REQ.get(m.rid); if (p) { REQ.delete(m.rid); clearTimeout(p.timer); p.resolve(m.r); } return; }
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
    for (const [id, p] of REQ) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'bridge disconnected' }); REQ.delete(id); }
    // Only walk to the next port when this one never answered. Advancing on
    // every close sent us hunting through 8788/8789 — ports the bridge never
    // binds — after any ordinary bridge restart, which is what made bx sit at
    // "not connected" for a minute at a time.
    if (opened) { portIdx = 0; backoff = 200; } else portIdx++;
    schedule();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// The popup's questions for the bridge: jev keys and settings live there, on
// this computer, shared by every browser that has bx connected.
const REQ = new Map();
let rid = 0;
function bridge(op, args) {
  if (!sock || sock.readyState !== 1) return Promise.resolve({ ok: false, error: 'bridge not running — start it with bx status' });
  const id = ++rid;
  return new Promise((resolve) => {
    // Adding a key tries it against the provider first, which can take a while.
    const timer = setTimeout(() => { REQ.delete(id); resolve({ ok: false, error: 'the bridge did not answer' }); }, 20000);
    REQ.set(id, { resolve, timer });
    try { sock.send(JSON.stringify({ t: 'rq', rid: id, op, args })); }
    catch (e) { clearTimeout(timer); REQ.delete(id); resolve({ ok: false, error: String(e.message || e) }); }
  });
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
const wakeAndReport = () => { wake(); report(); };
chrome.tabs.onActivated.addListener(wakeAndReport);
chrome.tabs.onUpdated.addListener(wake);
chrome.windows.onFocusChanged.addListener(wakeAndReport);
chrome.windows.onCreated.addListener(wakeAndReport);
chrome.windows.onRemoved.addListener(wakeAndReport);
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
  if (typeof spec === 'number') {
    // Tab ids are unique across profiles, but each profile sees only its own.
    // Refuse the whole batch up front so the bridge asks the profile that has it.
    try { await chrome.tabs.get(spec); } catch { throw new Error(`No tab with id: ${spec}`); }
    return spec;
  }
  // --here: the tab the user is looking at, whatever the mode.
  if (spec === 'user') return userTab();
  if (spec && spec !== 'active' && spec !== 'current') {
    const all = await chrome.tabs.query({});
    const hit = all.find((t) => (t.url || '').includes(String(spec)) || (t.title || '').toLowerCase().includes(String(spec).toLowerCase()));
    if (hit) return hit.id;
    throw new Error(`no tab matching "${spec}"`);
  }
  await modeReady;
  return MODE.own ? ownTab() : userTab();
}

async function userTab() {
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true });
  // Every window in this profile is closed, so there is truly nothing to act
  // on. Open one rather than failing: whatever the batch does next (nav,
  // open) points the tab at the real URL anyway. The bridge only sends here
  // when no other connected profile has a window.
  if (!t) t = await openTab('about:blank', true);
  return t.id;
}

// ── where bx works ───────────────────────────────────────────────────────
// Own-window mode, on unless switched off in the toolbar popup: bx keeps a
// window of its own, its tabs in a "bx" tab group, and works only there.
// "The active tab" means bx's tab, so an agent can run while the user keeps
// browsing — nothing of theirs is navigated, switched or focused. A window
// and not a group in the user's window, because Chrome treats a background
// tab as hidden: it stops rendering it and slows its timers, and infinite
// feeds and lazy lists never fill in. Off: act on whatever tab is active.
const MODE = { own: true };
const modeReady = chrome.storage.local.get('ownWindow')
  .then((g) => { MODE.own = g.ownWindow !== false; }).catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.ownWindow) { MODE.own = ch.ownWindow.newValue !== false; report(); }
});

// bx's window, group and working tab. Session storage, because the worker is
// torn down whenever it idles. Chrome clears it when the extension reloads
// or the browser restarts; ownWindow() then finds the window by its group.
const place = () => chrome.storage.session.get('bx').then((g) => g.bx || {}).catch(() => ({}));
const setPlace = (p) => chrome.storage.session.set({ bx: p }).catch(() => {});

async function groupIn(win, tabIds, group) {
  try {
    if (group !== undefined) { try { return await chrome.tabs.group({ tabIds, groupId: group }); } catch {} }
    const g = await chrome.tabs.group({ tabIds, createProperties: { windowId: win } });
    await chrome.tabGroups.update(g, { title: 'bx', color: 'purple' });
    return g;
  } catch { return undefined; }   // cosmetic: a window without the group still works
}

// Parallel reads open several tabs at once on a cold start; one window, not six.
let making = null;
async function ownWindow() {
  const p = await place();
  const w = p.win !== undefined ? await chrome.windows.get(p.win).catch(() => null) : null;
  if (w) {
    // Chrome pauses every page in a minimized window: feeds stop loading
    // when scrolled, timers stall. After a reboot bx's window came back
    // minimized and every list stopped at its first screen. Restore it,
    // without focus, so it sits behind whatever the user is doing.
    if (w.state === 'minimized') await chrome.windows.update(w.id, { state: 'normal', focused: false }).catch(() => {});
    return p;
  }
  if (!making) {
    making = (async () => {
      // Lost track of it, not lost it: a window holding a "bx" group is bx's.
      // Without this every extension reload opened another bx window.
      const [g] = await chrome.tabGroups.query({ title: 'bx' }).catch(() => []);
      if (g) {
        const [a] = await chrome.tabs.query({ active: true, windowId: g.windowId });
        const [t] = await chrome.tabs.query({ groupId: g.id });
        const np = { win: g.windowId, tab: (a && a.groupId === g.id ? a : t || a)?.id, group: g.id };
        await setPlace(np);
        return np;
      }
      // Unfocused, so it opens behind what the user is doing. Never minimized:
      // Chrome pauses pages in a minimized window just as in a background tab.
      const w = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'normal' });
      const np = { win: w.id, tab: w.tabs[0].id };
      np.group = await groupIn(w.id, [np.tab]);
      await setPlace(np);
      return np;
    })().finally(() => { making = null; });
  }
  return making;
}

async function ownTab() {
  const p = await ownWindow();
  if (p.tab !== undefined && await chrome.tabs.get(p.tab).catch(() => null)) return p.tab;
  // bx's tab was closed: the window's active tab is bx's now, or a fresh one.
  let [a] = await chrome.tabs.query({ active: true, windowId: p.win });
  if (!a) a = await chrome.tabs.create({ windowId: p.win, url: 'about:blank', active: true });
  await setPlace({ win: p.win, tab: a.id, group: p.group });
  return a.id;
}

// A new tab. In own-window mode it goes into bx's window and group, and a
// foreground one becomes bx's tab. Otherwise into the user's window — and a
// profile with every window closed still runs this worker, where tabs.create
// has no window to put the tab in.
async function openTab(url, active) {
  await modeReady;
  if (MODE.own) {
    const p = await ownWindow();
    // bx's tab still blank — the window was just opened for this — is used
    // rather than left behind empty. Only for a foreground tab: background
    // reads close their tabs when done, and closing that one would close the
    // whole window.
    if (active) {
      const cur = p.tab !== undefined ? await chrome.tabs.get(p.tab).catch(() => null) : null;
      if (cur && cur.windowId === p.win && (cur.url || cur.pendingUrl || 'about:blank') === 'about:blank') {
        return url ? chrome.tabs.update(cur.id, { url, active: true }) : cur;
      }
    }
    const t = await chrome.tabs.create({ windowId: p.win, url, active });
    const g = await groupIn(p.win, [t.id], p.group);
    const now = await place();
    await setPlace({ win: p.win, tab: active ? t.id : now.tab ?? p.tab, group: g ?? p.group });
    return t;
  }
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  if (wins.length) return chrome.tabs.create({ url, active });
  const w = await chrome.windows.create({ url, focused: active });
  return w.tabs[0];
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
const REPEATABLE = new Set(['wait', 'exists', 'read', 'elements', 'info', 'box', 'path', 'matches']);
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

// The last failed main-frame load per tab. A tab whose load failed shows
// Chrome's own error page under the site's URL, and that page cannot be
// scripted — which bx used to report as "this tab can't be scripted", an
// error that reads as permanent. On the LinkedIn inbox run it was the site
// refusing requests for half a minute after a burst of fetches, and the agent
// spent a minute reloading tabs and restarting the extension over it.
const loadErr = new Map();   // tabId -> {error, url, at}
try {
  chrome.webNavigation.onErrorOccurred.addListener((d) => {
    // ERR_ABORTED is a navigation replaced by another one, not a failure.
    if (d.frameId === 0 && !/ERR_ABORTED/.test(d.error || '')) loadErr.set(d.tabId, { error: d.error, url: d.url, at: Date.now() });
  });
  chrome.webNavigation.onCommitted.addListener((d) => { if (d.frameId === 0) loadErr.delete(d.tabId); });
  chrome.tabs.onRemoved.addListener((id) => loadErr.delete(id));
} catch {}

// Is the tab's main frame Chrome's error page? Returns a readable reason, or
// null for a page that loaded.
async function failedLoad(tabId) {
  let f = null;
  try { f = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }); } catch {}
  const rec = loadErr.get(tabId);
  const bad = (f && (f.errorOccurred || /^chrome-error:/.test(f.url || ''))) || (rec && Date.now() - rec.at < 120000);
  if (!bad) return null;
  const why = rec?.error || 'Chrome error page';
  const url = rec?.url || f?.url || '';
  const hint = /HTTP_RESPONSE_CODE|TOO_MANY|CONNECTION_(RESET|CLOSED)|EMPTY_RESPONSE|BLOCKED/i.test(why)
    ? 'the site refused the request — after many quick requests this is usually rate limiting: wait ~30s, then bx reload'
    : 'bx reload to try again';
  return `page failed to load (${why})${url ? ` at ${url.split('?')[0].slice(0, 70)}` : ''} — ${hint}`;
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
      toFrame(tabId, fid, { a: 'exists', target: action.target, in: action.in, timeout: budget }, cfg)
        .then((r) => (r && r.exists ? finish(fid) : miss()), miss);
    }
  });
}

// How much of the budget the first attempt on the main frame gets. A short
// probe is right for a lookup — nearly every target is right there, and only a
// real miss should pay for enumerating frames. It is wrong for an action whose
// whole job is to wait: `wait` and `exists` were being handed 150ms and
// answering "timed out" / "no" long before their own deadline.
const MAIN_SHARE = { wait: 1, exists: 1, matches: 1, fill: 0.6 };

async function toContent(tabId, action, cfg) {
  const total = action.timeout ?? cfg.timeout ?? 8000;
  const deadline = Date.now() + total;
  const share = MAIN_SHARE[action.a];
  const first = share ? Math.round(total * share) : Math.min(200, total);

  try { return await toFrame(tabId, 0, { ...action, timeout: first }, cfg); }
  catch (e) {
    if (isNoScript(e)) {
      const failed = await failedLoad(tabId);
      if (failed) throw new Error(failed);
      // Mid-navigation there is briefly no document to talk to. That is a
      // wait, not a wall: give the load a moment and ask once more.
      let tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === 'loading' && /^https?:/.test(tab.url || '')) {
        await waitForLoad(tabId, 6000).catch(() => {});
        try { return await toFrame(tabId, 0, { ...action, timeout: first }, cfg); }
        catch (e2) {
          if (!isNoScript(e2)) { if (action.frames === false || !isMiss(e2)) throw e2; e = e2; }
          else { const f2 = await failedLoad(tabId); if (f2) throw new Error(f2); tab = await chrome.tabs.get(tabId).catch(() => null); throw noScriptError(tab && tab.url); }
        }
      } else throw noScriptError(tab && tab.url);
    }
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
    const box = await toContent(tabId, { a: 'box', target: a.target, in: a.in, timeout: a.timeout }, cfg);
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

// A navigation that lands on Chrome's error page did not work, whatever the
// tab's URL says. Report it on the nav itself, not on the next action.
async function landed(tabId, a) {
  if (a.wait === false) return;
  const failed = await failedLoad(tabId);
  if (failed) throw new Error(failed);
}

W.nav = async (tabId, a) => {
  const url = toUrl(a.url);
  loadErr.delete(tabId);
  await chrome.tabs.update(tabId, { url });
  if (a.wait !== false) await waitForLoad(tabId, a.timeout ?? 15000);
  await landed(tabId, a);
  const t = await chrome.tabs.get(tabId);
  return { url: t.url, title: t.title, status: t.status };
};

// What did the last input set off? Wait a short grace for a navigation (or a
// same-document URL change) to start; if one does, wait for it to load, and
// if none does, return as soon as the grace is up. A flat sleep either wastes
// the whole wait on a click that changes nothing, or ends before a slow
// submit has begun and the next read sees the page that is about to vanish.
W.after = async (tabId, a) => {
  const t0 = Date.now();
  const tab = await chrome.tabs.get(tabId);
  let moved = tab.status === 'loading' ? 'loading' : a.from && tab.url !== a.from ? 'url' : null;
  if (!moved) {
    moved = await new Promise((res) => {
      const off = (v) => {
        clearTimeout(to);
        chrome.webNavigation.onBeforeNavigate.removeListener(nav);
        chrome.webNavigation.onHistoryStateUpdated.removeListener(hist);
        chrome.tabs.onUpdated.removeListener(upd);
        res(v);
      };
      const nav = (d) => { if (d.tabId === tabId && d.frameId === 0) off('navigate'); };
      const hist = (d) => { if (d.tabId === tabId && d.frameId === 0) off('history'); };
      const upd = (id, ch) => { if (id === tabId && (ch.status === 'loading' || ch.url)) off('loading'); };
      const to = setTimeout(() => off(null), a.ms ?? 250);
      chrome.webNavigation.onBeforeNavigate.addListener(nav);
      chrome.webNavigation.onHistoryStateUpdated.addListener(hist);
      chrome.tabs.onUpdated.addListener(upd);
    });
  }
  if (moved && moved !== 'history') await waitForLoad(tabId, a.timeout ?? 8000).catch(() => {});
  const t = await chrome.tabs.get(tabId);
  return { url: t.url, moved, waited: Date.now() - t0 };
};

W.back = async (tabId, a) => { loadErr.delete(tabId); await chrome.tabs.goBack(tabId); if (a.wait !== false) await waitForLoad(tabId, 15000); await landed(tabId, a); const t = await chrome.tabs.get(tabId); return { url: t.url }; };
W.forward = async (tabId, a) => { loadErr.delete(tabId); await chrome.tabs.goForward(tabId); if (a.wait !== false) await waitForLoad(tabId, 15000); await landed(tabId, a); const t = await chrome.tabs.get(tabId); return { url: t.url }; };
W.reload = async (tabId, a) => { loadErr.delete(tabId); await chrome.tabs.reload(tabId, { bypassCache: !!a.hard }); if (a.wait !== false) await waitForLoad(tabId, 20000); await landed(tabId, a); const t = await chrome.tabs.get(tabId); return { url: t.url }; };

W.tabs = async () => {
  const tabs = await chrome.tabs.query({});
  const p = await place();
  return { n: tabs.length, tabs: tabs.map((t) => ({
    id: t.id, active: t.active || undefined, title: (t.title || '').slice(0, 70), url: t.url, win: t.windowId, audible: t.audible || undefined,
    // Which tab "the active tab" means for bx right now, and which are bx's.
    bx: (MODE.own && t.windowId === p.win) || undefined, work: (MODE.own && t.id === p.tab) || undefined
  })) };
};

W.newtab = async (_t, a) => {
  const t = await openTab(a.url ? toUrl(a.url) : undefined, a.active !== false);
  if (a.url && a.wait !== false) await waitForLoad(t.id, a.timeout ?? 20000);
  if (a.url) {
    // The tab is left open either way: a caller that opened it owns closing
    // it, and it needs the id to do that.
    const failed = a.wait === false ? null : await failedLoad(t.id);
    if (failed) { const e = new Error(failed); e.tab = t.id; throw e; }
  }
  const fresh = await chrome.tabs.get(t.id);
  return { id: t.id, url: fresh.url, title: fresh.title };
};

W.tab = async (_t, a) => {
  const id = await resolveTab(a.id ?? a.target);
  await modeReady;
  if (MODE.own) {
    // Switching makes it the tab bx acts on. Inside bx's window it is also
    // brought forward there; a tab of the user's is used where it is, never
    // pulled to the front of their window.
    const t = await chrome.tabs.get(id);
    const p = await ownWindow();
    if (t.windowId === p.win) await chrome.tabs.update(id, { active: true });
    await setPlace({ ...p, tab: id });
    return { id, url: t.url, title: t.title };
  }
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

// The toolbar popup asks whether the bridge is reachable and where bx works.
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  // A hidden page's own timers run at 1Hz; the worker keeps time for it.
  if (m && m.t === 'bx-sleep') { setTimeout(() => respond(true), Math.max(0, Math.min(Number(m.ms) || 0, 30000))); return true; }
  // Keys and settings: from the popup page only. Content scripts run inside
  // every website and can message this worker too, so they are refused here.
  if (m && m.t === 'jev') {
    const fromPopup = sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL('popup.html'));
    if (!fromPopup || !['jev', 'jev.set', 'jev.add', 'jev.rm', 'browser.use'].includes(m.op)) return;
    bridge(m.op, m.args || {}).then(respond);
    return true;
  }
  if (!m || m.t !== 'popup') return;
  (async () => {
    await modeReady;
    const p = await place();
    const win = p.win !== undefined ? await chrome.windows.get(p.win, { populate: true }).catch(() => null) : null;
    respond({ connected: !!sock && sock.readyState === 1, own: MODE.own, win: win ? { id: win.id, tabs: win.tabs.length, state: win.state } : null });
  })();
  return true;
});

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
  const box = await toContent(tabId, { a: 'box', target: a.target, in: a.in, timeout: a.timeout }, cfg);
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
    const box = await toContent(tabId, { a: 'box', target: a.target, in: a.in, timeout: a.timeout }, cfg);
    return cdpClick(tabId, box.x + box.w / 2, box.y + box.h / 2, a.button === 'right' ? 'right' : 'left', a.a === 'dblclick' ? 2 : (a.clicks || 1));
  }
  if (trusted && a.a === 'type' && a.bulk) {
    // The whole value in one trusted insert, the way jev-ultrafast types:
    // focus, select what the field holds, replace it. Per-character input
    // races widgets that re-render as you type — Wikipedia's search box
    // submitted "Ala" for "Alan Turing" — and one insert cannot be raced.
    await toContent(tabId, { a: 'click', target: a.target, in: a.in, speed: 'instant' }, cfg);
    // Selected in the page first. Ctrl+A alone did not reach a field in bx's
    // unfocused window, so the insert went in front of the old text: the agent
    // typed "Alan Turing" into a box holding "go language google" three times
    // over, and searched for none of them.
    if (a.clear !== false) await toContent(tabId, { a: 'selectall', target: a.target, in: a.in }, cfg).catch(() => {});
    const r = await withCdp(tabId, async (t) => {
      if (a.clear !== false) {
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll'] });
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      }
      await cdp(t, 'Input.insertText', { text: String(a.text ?? '') });
      if (a.enter) {
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
        await cdp(t, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      }
      return { trusted: true, bulk: true, len: String(a.text ?? '').length };
    });
    return r;
  }
  if (trusted && a.a === 'type') {
    await toContent(tabId, { a: 'click', target: a.target, in: a.in, speed: a.speed }, cfg);
    if (a.clear !== false) await toContent(tabId, { a: 'clear', target: a.target, in: a.in }, cfg);
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
    // A nav's own load wait is soft and 15s by default (see waitForLoad); the
    // hard limit sat at 12s under it and failed slow pages that had loaded.
    const own = a.timeout ?? (a.a === 'nav' ? 15000 : m.timeout ?? CFG.timeout);
    const budget = own + 4000 + typingMs(a, cfg.speed);
    try {
      const r = await withTimeout(exec(tabId, { speed: cfg.speed, ...a }, cfg, m), budget, a.a);
      // let newtab/tab hand the rest of the batch its new tab
      if ((a.a === 'newtab' || a.a === 'tab') && r && r.id) tabId = r.id;
      results.push({ a: a.a, ok: true, ms: Math.round(performance.now() - s), r });
    } catch (e) {
      const msg = String((e && e.message) || e).replace(/^BX_NOTFOUND /, 'not found: ');
      results.push({ a: a.a, ok: false, ms: Math.round(performance.now() - s), error: msg, ...(e && e.tab ? { tab: e.tab } : {}) });
      if (m.stopOnError !== false) break;
    }
  }
  return { tab: tabId, ms: Math.round(performance.now() - t0), url0, url: await tabUrl(tabId), results };
}
