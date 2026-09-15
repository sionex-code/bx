'use strict';
// Keyboard. Full keydown/beforeinput/input/keyup sequence with correct
// key/code/keyCode triples, values written through the native setter so
// React/Vue/Svelte controlled inputs actually register the change.
var BX = (typeof BX !== 'undefined' && BX) || {};

const NAMED = {
  enter:      ['Enter', 'Enter', 13],
  tab:        ['Tab', 'Tab', 9],
  escape:     ['Escape', 'Escape', 27],
  esc:        ['Escape', 'Escape', 27],
  backspace:  ['Backspace', 'Backspace', 8],
  delete:     ['Delete', 'Delete', 46],
  space:      [' ', 'Space', 32],
  arrowup:    ['ArrowUp', 'ArrowUp', 38],
  arrowdown:  ['ArrowDown', 'ArrowDown', 40],
  arrowleft:  ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  up:         ['ArrowUp', 'ArrowUp', 38],
  down:       ['ArrowDown', 'ArrowDown', 40],
  left:       ['ArrowLeft', 'ArrowLeft', 37],
  right:      ['ArrowRight', 'ArrowRight', 39],
  home:       ['Home', 'Home', 36],
  end:        ['End', 'End', 35],
  pageup:     ['PageUp', 'PageUp', 33],
  pagedown:   ['PageDown', 'PageDown', 34]
};

const codeFor = (ch) => {
  if (/^[a-zA-Z]$/.test(ch)) return 'Key' + ch.toUpperCase();
  if (/^[0-9]$/.test(ch)) return 'Digit' + ch;
  const map = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote' };
  const shifted = { '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5', '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0', '_': 'Minus', '+': 'Equal', '{': 'BracketLeft', '}': 'BracketRight', '|': 'Backslash', ':': 'Semicolon', '"': 'Quote', '<': 'Comma', '>': 'Period', '?': 'Slash', '~': 'Backquote' };
  return map[ch] || shifted[ch] || '';
};
// Punctuation reports the keyCode of the physical key, not the character —
// a detail behavioural fingerprinters do check.
const PUNCT = { ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189,
  '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220,
  '|': 220, ']': 221, '}': 221, "'": 222, '"': 222, ' ': 32 };
const SHIFTED_DIGIT = { '!': 49, '@': 50, '#': 51, '$': 52, '%': 53, '^': 54, '&': 55, '*': 56, '(': 57, ')': 48 };
const keyCodeFor = (ch) => {
  if (/^[a-z]$/.test(ch)) return ch.toUpperCase().charCodeAt(0);
  if (/^[A-Z0-9]$/.test(ch)) return ch.charCodeAt(0);
  return PUNCT[ch] ?? SHIFTED_DIGIT[ch] ?? 0;
};

BX.parseKey = (spec) => {
  const parts = String(spec).split('+');
  const key = parts.pop();
  const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  for (const m of parts) {
    const k = m.toLowerCase();
    if (k === 'ctrl' || k === 'control') mods.ctrlKey = true;
    else if (k === 'alt') mods.altKey = true;
    else if (k === 'shift') mods.shiftKey = true;
    else if (k === 'meta' || k === 'cmd' || k === 'super') mods.metaKey = true;
  }
  const n = NAMED[key.toLowerCase()];
  if (n) return { key: n[0], code: n[1], keyCode: n[2], ...mods };
  if (/^F\d{1,2}$/i.test(key)) { const i = +key.slice(1); return { key: 'F' + i, code: 'F' + i, keyCode: 111 + i, ...mods }; }
  const ch = key.length === 1 ? key : key;
  if (/[A-Z]/.test(ch) || /["!@#$%^&*()_+{}|:<>?~]/.test(ch)) mods.shiftKey = true;
  return { key: ch, code: codeFor(ch), keyCode: keyCodeFor(ch), ...mods };
};

BX.kev = (el, type, k) => {
  const init = {
    bubbles: true, cancelable: true, composed: true, view: window,
    key: k.key, code: k.code, location: 0, repeat: false, isComposing: false,
    keyCode: k.keyCode, charCode: type === 'keypress' ? (k.key.length === 1 ? k.key.charCodeAt(0) : 0) : 0,
    which: k.keyCode,
    ctrlKey: !!k.ctrlKey, altKey: !!k.altKey, shiftKey: !!k.shiftKey, metaKey: !!k.metaKey
  };
  const ev = new KeyboardEvent(type, init);
  // KeyboardEvent ignores keyCode/which in its constructor; restore them so
  // legacy handlers that branch on e.keyCode still work.
  try { Object.defineProperty(ev, 'keyCode', { get: () => k.keyCode }); } catch {}
  try { Object.defineProperty(ev, 'which', { get: () => k.keyCode }); } catch {}
  return el.dispatchEvent(ev);
};

const nativeSet = (el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  if (d && d.set) d.set.call(el, v); else el.value = v;
};

BX.setValue = (el, v) => {
  if (el.isContentEditable) { el.textContent = v; }
  else nativeSet(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
};

BX.clearField = (el) => {
  if (el.isContentEditable) {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('delete');
    return;
  }
  try { el.setSelectionRange(0, el.value.length); } catch {}
  const k = BX.parseKey('ctrl+a');
  BX.kev(el, 'keydown', k); BX.kev(el, 'keyup', k);
  const bk = BX.parseKey('Backspace');
  BX.kev(el, 'keydown', bk);
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'deleteContentBackward', data: null }));
  nativeSet(el, '');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null }));
  BX.kev(el, 'keyup', bk);
};

BX.insertChar = (el, ch) => {
  if (el.isContentEditable) {
    document.execCommand('insertText', false, ch); // fires beforeinput/input natively
    return;
  }
  if (!('value' in el)) return;
  const ok = el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: ch }));
  if (!ok) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const v = el.value.slice(0, start) + ch + el.value.slice(end);
  nativeSet(el, v);
  try { el.setSelectionRange(start + 1, start + 1); } catch {}
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
};

BX.pressKey = async (el, spec) => {
  const k = BX.parseKey(spec);
  const t = el || document.activeElement || document.body;
  const notPrevented = BX.kev(t, 'keydown', k);
  if (k.key === 'Enter') {
    BX.kev(t, 'keypress', k);
    // Implicit form submission is a UA behaviour reserved for trusted events,
    // so replicate it explicitly when nothing swallowed the keydown.
    const form = t.form || t.closest?.('form');
    if (notPrevented && form && /^(INPUT)$/.test(t.tagName) && !/textarea/i.test(t.tagName)) {
      const submit = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
      if (submit) BX.fire(submit, 'click', BX.mouse.x, BX.mouse.y, { detail: 1 });
      else if (form.requestSubmit) form.requestSubmit();
    }
  } else if (k.key.length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey) {
    BX.insertChar(t, k.key);
  } else if (k.key === 'Backspace') {
    if ('value' in t && t.value) {
      const s = t.selectionStart ?? t.value.length;
      if (s > 0) {
        t.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'deleteContentBackward' }));
        nativeSet(t, t.value.slice(0, s - 1) + t.value.slice(t.selectionEnd ?? s));
        try { t.setSelectionRange(s - 1, s - 1); } catch {}
        t.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      }
    }
  }
  await BX.sleep(BX.prof().key() / 2);
  BX.kev(t, 'keyup', k);
};

BX.typeInto = async (el, text, o = {}) => {
  const prof = BX.prof(o.speed);
  if (o.clear !== false) BX.clearField(el);
  const s = String(text);
  if (o.speed === 'instant' || prof.key() === 0) {
    BX.setValue(el, (el.isContentEditable ? el.textContent : el.value) + s);
    return { len: s.length, mode: 'bulk' };
  }
  // Think-pauses belong to `human`. At `fast` they added ~7ms per character on
  // average, which on a long prompt is seconds of nothing — and they are only
  // worth paying for on a site that scores behaviour.
  // Long strings also taper: the cadence of the first hundred characters is
  // what a detector looks at, and nobody types 2000 characters at one speed.
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') { await BX.pressKey(el, 'Enter'); continue; }
    const k = BX.parseKey(ch);
    BX.kev(el, 'keydown', k);
    BX.kev(el, 'keypress', k);
    BX.insertChar(el, ch);
    BX.kev(el, 'keyup', k);
    let d = prof.key() * (i > 120 ? 0.45 : 1);
    if (prof.think && Math.random() < 0.04) d += 90 + Math.random() * 160;
    if (ch === ' ') d *= 1.25;
    await BX.sleep(d);
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  return { len: s.length, mode: 'keys' };
};
