'use strict';
const $ = (id) => document.getElementById(id);

// The worker owns the socket and bx's window; asking it also wakes it.
const ask = () => chrome.runtime.sendMessage({ t: 'popup' }).catch(() => null);
// jev keys and settings live in the bridge; the worker relays.
const jev = (op, args) => chrome.runtime.sendMessage({ t: 'jev', op, args }).catch((e) => ({ ok: false, error: String(e.message || e) }));

async function render() {
  const s = await ask();
  const own = s ? s.own : (await chrome.storage.local.get('ownWindow')).ownWindow !== false;
  $('own').checked = own;
  $('on').hidden = !own;
  $('off').hidden = own;
  $('foot').hidden = !own;
  $('dot').className = s && s.connected ? 'dot ok' : 'dot';
  $('conn').textContent = s && s.connected ? 'connected' : 'bridge not running';
  const w = s && s.win;
  $('show').hidden = !(own && w);
  if (w) $('show').textContent = `Show bx window · ${w.tabs} tab${w.tabs === 1 ? '' : 's'}`;
  $('min').hidden = !(own && w && w.state === 'minimized');
  if (s && s.connected) { const r = await jev('jev'); renderJev(r); renderBrowsers(r); }
}

// ── browsers ─────────────────────────────────────────────────────────────
const plural = (n, w) => `${n ?? '?'} ${w}${n === 1 ? '' : 's'}`;
// With bx in several browsers (or profiles), pick which one agents drive.
// Auto: the one used most recently.
function renderBrowsers(r) {
  const bs = (r && r.ok && r.ext && r.ext.browsers) || [];
  $('browsers').hidden = bs.length < 2;
  if (bs.length < 2) return;
  $('bcount').textContent = `${bs.length} connected`;
  const chosen = r.ext.chosen;
  const row = (value, title, sub, checked, here) => {
    const input = el('input', { type: 'radio', name: 'browser', value, checked });
    input.addEventListener('change', async () => {
      const x = await jev('browser.use', { browser: value });
      if (!x.ok) return say(x.error, true);
      renderBrowsers(await jev('jev'));
    });
    return el('li', {}, el('label', { className: 'pick' }, input,
      el('div', { className: 'k' }, el('b', { textContent: title }), el('span', { textContent: sub }))),
      here ? el('span', { className: 'here', textContent: 'active' }) : null);
  };
  const auto = bs.find((b) => b.primary);
  $('blist').replaceChildren(
    row('auto', 'Auto', `the one last in use${!chosen && auto ? ` · now ${auto.browser}` : ''}`, !chosen, false),
    ...bs.map((b) => row(b.iid, `${b.browser || 'Browser'}${b.label ? ` “${b.label}”` : ''}${b.you ? ' (this one)' : ''}`,
      `${plural(b.windows, 'window')} · ${plural(b.tabs, 'tab')} · ${b.iid}`, b.chosen, b.primary)));
}

// ── jev ──────────────────────────────────────────────────────────────────
const NAME = { typesafe: 'TypeSafe', codiv: 'codiv' };
const HINT = {
  auto: 'Text goes to TypeSafe and screenshots to codiv. If one fails, the other takes over.',
  typesafe: 'Text goes to TypeSafe only. Screenshots still need a codiv key; without one, jev answers from the text.',
  codiv: 'Everything goes to codiv, screenshots included.'
};

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function keyRow(k) {
  const cls = k.status === 'ok' ? 'dot ok' : /refused/.test(k.status) ? 'dot bad' : 'dot warn';
  const bits = [k.key, k.status === 'ok' ? null : k.status + (k.back_in_s ? ` · back in ${k.back_in_s}s` : ''), k.calls ? `${k.calls} call${k.calls === 1 ? '' : 's'}, ${k.avg_ms}ms` : null];
  const li = el('li', {}, el('span', { className: cls, title: k.last_error || k.status }),
    el('div', { className: 'k' }, el('b', { textContent: k.label }), el('span', { textContent: bits.filter(Boolean).join(' · ') })));
  if (k.source === 'env') li.append(el('span', { className: 'x', textContent: 'env', title: 'Set in the environment the bridge started with' }));
  else {
    const rm = el('button', { className: 'x', textContent: '✕', title: `Remove ${k.label}`, type: 'button' });
    rm.setAttribute('aria-label', `Remove key ${k.label}`);
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      const r = await jev('jev.rm', { id: k.id });
      if (!r.ok) return say(r.error, true);
      say(`Removed ${r.removed.label}.`);
      renderJev(await jev('jev'));
    });
    li.append(rm);
  }
  return li;
}

function renderJev(r) {
  if (!r || !r.ok) { $('jev').hidden = true; return; }
  const j = r.jev;
  $('jev').hidden = false;
  for (const i of document.querySelectorAll('input[name=prov]')) i.checked = i.value === j.provider;
  $('provhint').textContent = HINT[j.provider] || '';
  $('route').textContent = !j.keys.length ? 'no key yet'
    : !j.enabled ? 'off'
    : `text → ${NAME[j.route.text] || 'none'} · screenshots → ${NAME[j.route.images] || 'none'}`;
  for (const p of ['typesafe', 'codiv']) {
    const ks = j.keys.filter((k) => k.provider === p);
    $(p).replaceChildren(...(ks.length ? ks.map(keyRow) : [el('li', {}, el('span', { className: 'none', textContent: 'No keys' }))]));
  }
  // Keys are the bridge's, so every browser with bx connected shares them.
  const bs = (r.ext && r.ext.browsers) || [];
  const names = bs.map((b) => `${b.browser || 'browser'}${b.you ? ' (this one)' : ''}`);
  $('shared').textContent = 'Keys are stored by the bx bridge on this computer and shared by every browser connected to it'
    + (names.length > 1 ? `: ${names.join(', ')}.` : '.');
}

function say(text, bad) {
  $('addmsg').textContent = text;
  $('addmsg').className = bad ? 'msg err' : 'msg ok';
}

// Whose key it is shows as soon as it is pasted.
$('newkey').addEventListener('input', () => {
  const k = $('newkey').value.trim();
  if (!k) return say('');
  $('addmsg').className = 'msg';
  $('addmsg').textContent = /^apikey_/.test(k) ? 'TypeSafe key' : /^sk-/.test(k) ? 'codiv key' : 'Unrecognised: TypeSafe keys start apikey_, codiv keys sk-';
});

$('addform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('newkey').value.trim();
  if (!key) return;
  $('addbtn').disabled = true;
  $('addbtn').textContent = 'Testing…';
  const r = await jev('jev.add', { key, label: $('newlabel').value.trim() || undefined });
  $('addbtn').disabled = false;
  $('addbtn').textContent = 'Add key';
  if (!r.ok) return say(r.error, true);
  $('newkey').value = '';
  $('newlabel').value = '';
  if (r.existing) say(`Already added as ${r.label}.`);
  else if (r.test && !r.test.ok) say(`Added ${r.label}, but the test call failed: ${r.test.error}`, true);
  else say(`Added ${r.label} · works${r.test ? ` (${r.test.ms}ms)` : ''}.`);
  renderJev(await jev('jev'));
});

for (const i of document.querySelectorAll('input[name=prov]')) {
  i.addEventListener('change', async () => {
    const r = await jev('jev.set', { provider: i.value });
    if (!r.ok) return say(r.error, true);
    renderJev(await jev('jev'));
  });
}

for (const a of document.querySelectorAll('a[data-href]')) {
  a.addEventListener('click', () => chrome.tabs.create({ url: a.dataset.href }));
}

$('own').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ ownWindow: e.target.checked });
  render();
});

$('show').addEventListener('click', async () => {
  const s = await ask();
  if (s && s.win) await chrome.windows.update(s.win.id, { focused: true, state: 'normal' });
  window.close();
});

render();
