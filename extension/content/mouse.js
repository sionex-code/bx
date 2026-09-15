'use strict';
// Virtual mouse. Emits a full, correctly-ordered pointer+mouse event stream
// along a curved path with jitter, so behaviour-based detectors see motion
// that looks like a hand rather than a teleport.
var BX = (typeof BX !== 'undefined' && BX) || {};

BX.mouse = BX.mouse || { x: Math.round(innerWidth * 0.4), y: Math.round(innerHeight * 0.55), down: false, over: null };

const chain = (el) => { const c = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) c.push(n); return c; };

BX.mev = (x, y, extra) => Object.assign({
  bubbles: true,
  cancelable: true,
  composed: true,
  view: window,
  clientX: x, clientY: y,
  screenX: Math.round(x + (window.screenX || 0)),
  screenY: Math.round(y + (window.screenY || 0) + Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0))),
  ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
  detail: 0, button: 0,
  buttons: BX.mouse.down ? 1 : 0,
  relatedTarget: null
}, extra || {});

BX.pev = (x, y, extra) => Object.assign(BX.mev(x, y, extra), {
  pointerId: 1, pointerType: 'mouse', isPrimary: true,
  width: 1, height: 1,
  pressure: BX.mouse.down ? 0.5 : 0,
  tangentialPressure: 0, tiltX: 0, tiltY: 0, twist: 0
}, extra || {});

BX.fire = (el, type, x, y, extra) => {
  if (!el) return;
  const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
  const init = type.startsWith('pointer') ? BX.pev(x, y, extra) : BX.mev(x, y, extra);
  el.dispatchEvent(new Ctor(type, init));
};

// hover transitions: out/leave on the old chain, over/enter on the new one
BX.hoverTo = (el, x, y) => {
  const prev = BX.mouse.over;
  if (prev === el) return;
  const oldChain = prev ? chain(prev) : [];
  const newChain = el ? chain(el) : [];
  if (prev && prev.isConnected) {
    BX.fire(prev, 'pointerout', x, y, { relatedTarget: el });
    BX.fire(prev, 'mouseout', x, y, { relatedTarget: el });
    for (const n of oldChain) {
      if (newChain.includes(n)) break;
      n.dispatchEvent(new PointerEvent('pointerleave', BX.pev(x, y, { bubbles: false, relatedTarget: el })));
      n.dispatchEvent(new MouseEvent('mouseleave', BX.mev(x, y, { bubbles: false, relatedTarget: el })));
    }
  }
  BX.mouse.over = el;
  if (el) {
    BX.fire(el, 'pointerover', x, y, { relatedTarget: prev });
    BX.fire(el, 'mouseover', x, y, { relatedTarget: prev });
    for (const n of newChain.slice().reverse()) {
      if (oldChain.includes(n)) continue;
      n.dispatchEvent(new PointerEvent('pointerenter', BX.pev(x, y, { bubbles: false, relatedTarget: prev })));
      n.dispatchEvent(new MouseEvent('mouseenter', BX.mev(x, y, { bubbles: false, relatedTarget: prev })));
    }
  }
};

BX.at = (x, y) => {
  let el = document.elementFromPoint(x, y);
  // pierce open shadow roots so hover lands on the real leaf
  for (let i = 0; i < 6 && el && el.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
};

BX.step = (x, y) => {
  const dx = x - BX.mouse.x, dy = y - BX.mouse.y;
  BX.mouse.x = x; BX.mouse.y = y;
  const el = BX.at(x, y);
  BX.hoverTo(el, x, y);
  if (el) {
    BX.fire(el, 'pointermove', x, y, { movementX: Math.round(dx), movementY: Math.round(dy) });
    BX.fire(el, 'mousemove', x, y, { movementX: Math.round(dx), movementY: Math.round(dy) });
  }
  return el;
};

BX.path = (x0, y0, x1, y1, steps, curve) => {
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d, ny = dx / d;
  const bow = curve * d * (0.5 + Math.random() * 0.7) * (Math.random() < 0.5 ? -1 : 1);
  const c1x = x0 + dx * 0.30 + nx * bow,       c1y = y0 + dy * 0.30 + ny * bow;
  const c2x = x0 + dx * 0.72 + nx * bow * 0.55, c2y = y0 + dy * 0.72 + ny * bow * 0.55;
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const u = 1 - e;
    pts.push({
      x: u * u * u * x0 + 3 * u * u * e * c1x + 3 * u * e * e * c2x + e * e * e * x1 + (Math.random() - 0.5) * 0.7,
      y: u * u * u * y0 + 3 * u * u * e * c1y + 3 * u * e * e * c2y + e * e * e * y1 + (Math.random() - 0.5) * 0.7
    });
  }
  pts[pts.length - 1] = { x: x1, y: y1 };
  return pts;
};

BX.moveTo = async (x, y, speed) => {
  const p = BX.prof(speed);
  const d = Math.hypot(x - BX.mouse.x, y - BX.mouse.y);
  if (d < 1) { BX.step(x, y); return; }
  if (p.maxSteps <= 1) { BX.step(x, y); return; }

  const steps = Math.max(3, Math.min(p.maxSteps, Math.round(d / p.px)));
  const dt = p.dur(d) / steps;

  if (p.overshoot && d > 90) {
    const ox = x + (x - BX.mouse.x) / d * (4 + Math.random() * 9);
    const oy = y + (y - BX.mouse.y) / d * (4 + Math.random() * 9);
    for (const pt of BX.path(BX.mouse.x, BX.mouse.y, ox, oy, steps, p.curve)) {
      BX.step(pt.x, pt.y);
      await BX.sleep(dt * (0.7 + Math.random() * 0.6));
    }
    await BX.sleep(12 + Math.random() * 30);
    for (const pt of BX.path(BX.mouse.x, BX.mouse.y, x, y, 4, 0)) { BX.step(pt.x, pt.y); await BX.sleep(8); }
    return;
  }

  for (const pt of BX.path(BX.mouse.x, BX.mouse.y, x, y, steps, p.curve)) {
    BX.step(pt.x, pt.y);
    if (dt > 0.4) await BX.sleep(dt * (0.7 + Math.random() * 0.6));
  }
};

// A point inside the element, gaussian-biased toward the centre — never the
// exact geometric centre, which is itself a bot tell.
BX.pointIn = (el) => {
  const r = el.getBoundingClientRect();
  const px = Math.min(3, r.width / 4), py = Math.min(3, r.height / 4);
  const x = r.left + r.width / 2 + BX.gauss() * (r.width / 2 - px) * 0.4;
  const y = r.top + r.height / 2 + BX.gauss() * (r.height / 2 - py) * 0.4;
  return {
    x: Math.max(r.left + 1, Math.min(r.right - 1, x)),
    y: Math.max(r.top + 1, Math.min(r.bottom - 1, y))
  };
};

BX.focusable = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.tabIndex >= 0 || /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(n.tagName) || n.isContentEditable) return n;
  }
  return null;
};

BX.clickAt = async (el, o = {}) => {
  await BX.ensureVisible(el);
  const p = o.point || BX.pointIn(el);
  await BX.moveTo(p.x, p.y, o.speed);

  const prof = BX.prof(o.speed);
  const hit = BX.at(p.x, p.y) || el;
  const covered = hit !== el && !el.contains(hit) && !hit.contains(el);
  const button = o.button === 'right' ? 2 : o.button === 'middle' ? 1 : 0;
  const bmask = button === 0 ? 1 : button === 1 ? 4 : 2;
  const clicks = o.clicks || 1;
  const mods = o.mods || {};
  const km = { ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta };

  for (let i = 1; i <= clicks; i++) {
    BX.mouse.down = true;
    BX.fire(hit, 'pointerdown', p.x, p.y, { ...km, button, buttons: bmask, detail: i });
    BX.fire(hit, 'mousedown', p.x, p.y, { ...km, button, buttons: bmask, detail: i });
    const f = BX.focusable(hit);
    if (f && button === 0) { try { f.focus({ preventScroll: true }); } catch {} }
    await BX.sleep(prof.press());
    BX.mouse.down = false;
    BX.fire(hit, 'pointerup', p.x, p.y, { ...km, button, buttons: 0, detail: i });
    BX.fire(hit, 'mouseup', p.x, p.y, { ...km, button, buttons: 0, detail: i });
    if (button === 0) BX.fire(hit, 'click', p.x, p.y, { ...km, button, buttons: 0, detail: i });
    if (i === 2) BX.fire(hit, 'dblclick', p.x, p.y, { ...km, button, buttons: 0, detail: 2 });
    if (i < clicks) await BX.sleep(40 + Math.random() * 50);
  }
  if (button === 2) BX.fire(hit, 'contextmenu', p.x, p.y, { ...km, button: 2, buttons: 0 });

  return { at: [Math.round(p.x), Math.round(p.y)], covered: covered || undefined, hit: hit.tagName?.toLowerCase() };
};
