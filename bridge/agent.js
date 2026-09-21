'use strict';
// agent.js — perceive, decide, act, repeat.
//
// The decision in the middle is the whole point. A generative model has to
// write a paragraph of reasoning and a JSON blob before it can tell you to
// click a button; jev just reads the page and returns a probability over the
// refs that are actually on it. One round trip per step, no parsing, no
// hallucinated selector — the answer is constrained to elements that exist.
//
// When jev is not confident enough, the loop stops and hands its state back
// instead of guessing. That escalation is the design: the fast brain drives,
// the slow brain (whatever agent called bx) takes the hard corners.
const jev = require('./jev');

const MOVES = {
  element: 'Act on one of the elements listed below — click it, or type into it. This is the usual answer whenever the thing that advances the goal is on screen.',
  scroll:  'Scroll further down this page. The element or the answer is probably below the fold and is not in the list yet.',
  wait:    'Wait. The page is still loading, or a result is still coming back.',
  back:    'Go back to the previous page. This one is a dead end.',
  finish:  'Stop entirely. Either the goal is met, or nothing reachable from this page can advance it.'
};

const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const NOT_TEXT = new Set(['checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset', 'color', 'range']);

// The verb is not a question. What you do to an element is a property of the
// element: you type into a text field and you click a button. Asking a model
// to choose the verb separately from the target is asking it to contradict
// itself, and it will — it picked "click" on a textarea often enough to make
// the point. Pick the target, derive the verb.
function verbFor(el, hasText) {
  if (!el) return 'click';
  const t = String(el.type || '').toLowerCase();
  const role = String(el.role || '').toLowerCase();
  if (el.tag === 'select') return 'select';
  const textish = el.tag === 'textarea'
    || (el.tag === 'input' && !NOT_TEXT.has(t))
    || role === 'textbox' || role === 'searchbox' || role === 'combobox';
  return textish && hasText ? 'type' : 'click';
}

// Refs are per-snapshot, so "have I touched this before" needs an identity that
// survives a reload. Tag plus accessible name is crude and it is enough.
const idOf = (e) => `${e.tag}|${clean(e.name, 70).toLowerCase()}`;

// What an element looks like to jev. Tag, role and accessible name is enough
// to choose between forty of them; the box and the CSS path are noise here.
// The one extra thing it gets is a note when this element has already been
// acted on: without it the model happily retypes the same query into the same
// search box forever, because the box still looks like the most relevant thing
// on the page long after it has done its job.
function label(e, used, visited) {
  const kind = e.tag === 'input' ? `input[${e.type || 'text'}]` : (e.role && e.role !== e.tag ? `${e.tag}/${e.role}` : e.tag);
  const bits = [kind];
  if (e.name) bits.push(`"${clean(e.name, 70)}"`);
  if (e.value) bits.push(`(currently holds: ${clean(e.value, 30)})`);
  if (e.dis) bits.push('[disabled]');
  if (!e.vis) bits.push('[offscreen]');
  if (e.where) bits.push(`— in the page ${e.where}`);
  const d = used && used.get(idOf(e));
  if (d) bits.push(`[ALREADY DONE: ${d.what} — doing it again will not advance the goal]`);
  if (d && d.to && visited && visited.has(d.to)) bits.push('[GOES BACK TO A PAGE ALREADY SEEN — this is the loop we are stuck in]');
  return bits.join(' ');
}

// Values the agent is allowed to type. jev picks among them; it never invents
// one, which is exactly what keeps a hallucinated string out of a password
// field. Explicit beats inferred: if the operator passed a --var or put the
// phrase in quotes, that IS the value and there is nothing to choose, so the
// question never gets asked and a whole class of wrong answers disappears.
function candidates(goal, vars) {
  const out = [];
  const add = (v, why) => {
    v = clean(v, 120);
    if (v && !out.some((x) => x.v === v) && out.length < 8) out.push({ v, why });
  };
  for (const [k, v] of Object.entries(vars || {})) add(v, `the value the operator supplied for "${k}"`);
  for (const m of goal.matchAll(/["'“”]([^"'“”]{2,80})["'“”]/g)) add(m[1], 'the exact phrase the goal put in quotes');
  if (out.length) return out;

  // Nothing explicit. Fall back to the phrase after a typing verb, cut at the
  // first conjunction so "search X and open Y" does not try to type all of it.
  const m = goal.match(/\b(?:search(?:\s+for)?|look\s+up|find|type|enter|write|query)\s+(?:for\s+)?(.{2,80}?)(?:\s+(?:and|then|on|in|at|into|from|using|via|through)\b.*)?$/i);
  if (m) add(m[1], 'the phrase the goal asks to be entered');
  // Deliberately no "the whole goal" fallback. It reads as a safe default and
  // is the opposite: handed a navigation goal with a search box on screen, the
  // loop typed the entire instruction into it and went to a search results
  // page for its own prompt. With no candidate at all, text fields simply
  // stop being typeable and the run asks for the value instead.
  return out;
}

// A domain in the goal is only an address to go to when the sentence puts it
// in the position of one. "search duckduckgo.com for X" names a destination;
// "open the anthropic.com result" names a search result that happens to be a
// domain, and navigating straight there skips the entire task.
// Clicks you cannot take back. An autonomous loop that submits an order or
// deletes a row because the button was the most goal-relevant thing on screen
// is not a bug you get to fix afterwards, so bx stops and asks — unless the
// goal itself asked for it, or the caller passed --yes.
const RISKY = /\b(submit|buy|purchase|pay|checkout|place\s+order|order\s+now|delete|remove|discard|send|post|publish|confirm|transfer|withdraw|sign\s?out|log\s?out|unsubscribe|deactivate|close\s+account)\b/i;

const FURNITURE = new Set(['navigation', 'header', 'footer', 'sidebar']);

const bare = (u) => String(u || '').split('#')[0].replace(/\/$/, '');

// Two kinds of link are never a move forward, and no amount of prompting
// reliably stops a model from taking them when they sit in the list looking
// like ordinary links:
//
//   · a fragment on the page we are already on — footnote markers, "(Top)",
//     table-of-contents entries. Clicking scrolls; the agent already has a
//     scroll move for that, and a citation marker named "[a]" is catnip.
//   · a link back to a page this run has already been on. That is the
//     OpenAI -> Elon Musk -> OpenAI ping-pong, and it burns the whole budget.
//
// Dropping them is safe: `back` and `navigate` are separate moves, so nothing
// that genuinely needs a revisit loses its route.
function deadEnd(e, url, visited) {
  if (!e.href) return false;
  const to = bare(e.href);
  if (!to) return true;
  if (to === bare(url)) return true;
  return visited.has(to);
}

// A long page offers far more elements than are worth sending, and they are
// not equally worth sending. Wikipedia's first fifty interactive elements are
// all sidebar, tabs and table of contents — cap the list naively and the
// article's own links never make it in front of the model at all. So: keep a
// fixed quota for furniture, give the rest to content, and restore document
// order so positions still read naturally.
function shortlist(els, max) {
  const chrome = [], body = [];
  els.forEach((e, i) => { e.__i = i; (FURNITURE.has(e.where) ? chrome : body).push(e); });
  const quota = Math.min(chrome.length, Math.max(8, Math.round(max * 0.3)));
  return body.slice(0, Math.max(0, max - quota))
    .concat(chrome.slice(0, quota))
    .sort((a, b) => a.__i - b.__i)
    .map((e) => { delete e.__i; return e; });
}

const URL_RE = /(?:^|\b(?:to|on|at|in|from|onto|open|visit|goto|go|navigate|browse|search|use)\s+)((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|co|app|gov|edu|uk|de|fr|nl|se|jp|cn|ru|br|au|ca|it|es|info|me|xyz|sh|to|ly)(?:\/[^\s"']*)?)(?!\s+(?:result|link|page\b))/i;

function navTarget(goal) {
  const m = goal.match(URL_RE);
  if (!m) return null;
  // Inside quotes it is a search term, not a destination.
  const i = goal.indexOf(m[1]);
  const before = goal.slice(0, i);
  if ((before.match(/["'“]/g) || []).length % 2 === 1) return null;
  if (/\bthe\s+$/i.test(before)) return null;
  return m[1];
}


function state(ctx) {
  const L = [];
  L.push(`GOAL: ${ctx.goal}`);
  if (ctx.hint) L.push(`OPERATOR HINT: ${ctx.hint}`);
  L.push(`STEP ${ctx.step} of ${ctx.maxSteps}`);
  L.push(`CURRENT URL: ${ctx.url}`);
  L.push(`PAGE TITLE: ${ctx.title}`);
  if (ctx.memory) L.push(`WHAT BX ALREADY KNOWS ABOUT THIS SITE: ${ctx.memory}`);
  if (ctx.visited && ctx.visited.size > 1) {
    L.push(`PAGES ALREADY VISITED (going back to one of these is going backwards): ${[...ctx.visited].slice(-8).join(' , ')}`);
  }
  if (ctx.history.length) {
    L.push('WHAT HAS ALREADY BEEN DONE, OLDEST FIRST:');
    for (const h of ctx.history.slice(-8)) L.push(`  ${h}`);
  } else {
    L.push('NOTHING HAS BEEN DONE YET — this is the first step.');
  }
  L.push('');
  L.push(`VISIBLE PAGE TEXT:\n${clean(ctx.text, 2400)}`);
  L.push('');
  L.push('ELEMENTS THAT CAN BE ACTED ON:');
  for (const e of ctx.elements) L.push(`  ${e.ref}  ${label(e, ctx.used, ctx.visited)}`);
  return L.join('\n');
}

function questions(ctx) {
  const q = {
    done: {
      type: 'noul',
      instructions: 'The goal has already been fully accomplished. The page in front of us right now IS the end state the goal asked for, and no further action is needed.',
      criteria: {
        true: 'The requested page is open, the form was submitted and confirmed, or the asked-for information is visible on this page right now.',
        false: 'Something still has to be clicked, typed, submitted or navigated to before the goal is met.'
      }
    },
    blocked: {
      type: 'noul',
      instructions: 'This page is a wall that cannot be passed without a human: a captcha, a two-factor prompt, a login needing credentials we were not given, a payment wall, or a hard error page.',
      criteria: { true: 'A person has to intervene before anything else can happen here.', false: 'This is an ordinary page that can be worked with.' }
    },
    move: { type: 'choice', instructions: 'Given the goal and what has already been done, what is the single best next move?', criteria: ctx.navUrl
      ? { ...MOVES, navigate: `Leave this page and go straight to ${ctx.navUrl}, the address the goal names. Only if we are not effectively there already.` }
      : MOVES }
  };
  if (ctx.elements.length) {
    // No "none of these" option on purpose. The move question already owns
    // that escape hatch, and offering it twice just splits the mass: asked
    // both ways at once, jev would answer "element" at 0.99 and then "none"
    // at 0.46 about the same page.
    const criteria = {};
    for (const e of ctx.elements) criteria[e.ref] = label(e, ctx.used, ctx.visited);
    q.target = {
      type: 'choice',
      instructions: 'Which single element most directly advances the goal from here? A text field means the next move is typing into it; a link or button means clicking it. Each element says which part of the page it sits in: links in the page navigation, header, footer or sidebar are site furniture (tabs like Read / Edit / History, menus, log-in links) and almost never advance a goal about content — prefer the main content unless the goal is plainly about the furniture itself. Anything marked ALREADY DONE has had its turn; anything marked as going back to a page already seen is the loop to break out of. If the goal states how to proceed — "by clicking links only", "without searching", "from the menu" — honour that strictly, even when another element looks like a faster route.',
      criteria
    };
  }
  if (ctx.candidates.length > 1) {
    const criteria = {};
    for (const c of ctx.candidates) criteria[c.v] = c.why;
    q.text = { type: 'choice', instructions: 'If the next move turns out to be typing, exactly which of these strings should be typed into the field?', criteria };
  }
  q.enter = {
    type: 'noul',
    instructions: 'If text is about to be typed into the chosen field, pressing Enter immediately afterwards would submit it (rather than a separate button needing to be clicked).',
    criteria: { true: 'It is a search box, or a single-field form where Enter submits.', false: 'There is a separate submit button, or this is one field among several still to fill.' }
  };
  return q;
}

// ── the fast brain ───────────────────────────────────────────────────────
async function jevBrain(ctx, cfg, image) {
  const s = state(ctx);
  const r = await jev.ask(s, questions(ctx), cfg, { sequential: cfg.sequential !== false, images: image ? [image] : undefined });
  const a = (k) => jev.read(r.answers[k]);
  const done = a('done'), blocked = a('blocked'), move = a('move'), target = a('target'), text = a('text'), enter = a('enter');

  const pick = ctx.candidates.find((c) => c.v === text.value) || ctx.candidates[0];
  const onElement = move.value === 'element' || !move.value;
  const ref = onElement && target.value && target.value !== 'none' ? target.value : null;
  const el = ref ? ctx.elements.find((e) => e.ref === ref) : null;

  // An element move with no element to act on is really a scroll: whatever is
  // needed is not in this list yet.
  const verb = !onElement ? move.value : el ? verbFor(el, !!pick) : 'scroll';

  return {
    brain: 'jev', model: r.model, ms: r.ms, usage: r.usage, state: s, saw: !!image,
    done: done.value && done.confidence >= cfg.min_confidence,
    donep: done.p,
    blocked: blocked.value && blocked.confidence >= cfg.min_confidence,
    verb, move: move.value, target: ref,
    verbConfidence: move.confidence, targetConfidence: target.confidence,
    alternatives: target.ranked,
    text: pick && pick.v,
    enter: enter.value,
    confidence: onElement && ctx.elements.length ? Math.min(move.confidence, target.confidence) : move.confidence
  };
}

// ── the brain with no model behind it ────────────────────────────────────
// --no-jev runs the identical loop on word overlap alone. It is dumb, it is
// free, it is offline, and having it here is the only honest way to see what
// jev is actually buying.
function localBrain(ctx, cfg) {
  const words = ctx.goal.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const stop = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'into', 'page', 'click', 'open', 'find', 'then', 'search', 'type']);
  const want = words.filter((w) => !stop.has(w));
  let best = null, bestScore = 0;
  for (const e of ctx.elements) {
    if (e.dis) continue;
    const hay = `${e.name || ''} ${e.tag} ${e.type || ''} ${e.role || ''}`.toLowerCase();
    let sc = want.reduce((s, w) => s + (hay.includes(w) ? 2 : 0), 0);
    if (/^(input|textarea)$/.test(e.tag) && !ctx.typed) sc += 1;
    if (e.vis) sc += 0.5;
    if (sc > bestScore) { bestScore = sc; best = e; }
  }
  const typing = best && verbFor(best, !!ctx.candidates.length) === 'type' && !ctx.typed;
  const hit = want.length && want.every((w) => ctx.text.toLowerCase().includes(w));
  return {
    brain: 'local', ms: 0, state: state(ctx),
    done: ctx.step > 1 && hit && !typing,
    blocked: false,
    verb: !best ? 'scroll' : typing ? 'type' : 'click',
    target: best ? best.ref : null,
    text: ctx.candidates[0] && ctx.candidates[0].v,
    enter: true,
    confidence: best ? Math.min(1, 0.4 + bestScore / 6) : 0.3,
    verbConfidence: 1, targetConfidence: best ? Math.min(1, bestScore / 6) : 0
  };
}

// ── the loop ─────────────────────────────────────────────────────────────
async function run(o, deps) {
  const cfg = Object.assign({ min_confidence: 0.55, max_steps: 12, max_elements: 55 }, o.jevConfig || {});
  const useJev = o.jev !== false && jev.ready(cfg);
  const maxSteps = o.maxSteps || cfg.max_steps;
  const goal = String(o.goal || '').trim();
  if (!goal) throw new Error('agent needs a goal');
  if (o.jev !== false && !useJev) throw new Error('jev is on but no key is set — run `bx jev key sk-...`, or pass --no-jev');

  const common = { tab: o.tab ?? 'active', speed: o.speed, trusted: o.trusted, timeout: o.timeout, memory: false };
  const vars = o.vars || {};
  const cands = candidates(goal, vars);
  const history = [];
  const steps = [];
  const seen = new Map();
  const used = new Map();      // element identity -> what was already done to it
  const visited = new Set();   // every URL this run has landed on
  let typed = false, stop = null, lastUrl = '';
  const emit = (ev) => { try { o.onStep && o.onStep(ev); } catch {} };

  // A goal that names a site starts by going there. No model needs to be
  // consulted about that, and skipping the call saves a whole round trip.
  const navUrl = navTarget(goal);
  const navHost = navUrl ? navUrl.replace(/^https?:\/\//, '').split('/')[0].toLowerCase() : '';
  if (o.open !== false) {
    const m = navUrl ? [null, navUrl] : null;
    if (m) {
      const here = await deps.exec({ ...common, actions: [{ a: 'info' }] });
      const url = here.results?.[0]?.r?.url || '';
      const want = m[1].replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      if (!url.toLowerCase().includes(want)) {
        const nav = await deps.exec({ ...common, actions: [{ a: 'nav', url: m[1] }] });
        const ok = !!nav.results?.[0]?.ok;
        history.push(`opened ${m[1]} -> ${ok ? 'ok' : 'failed'}`);
        steps.push({ n: 0, decided: { verb: 'navigate', target: m[1], brain: 'rule', confidence: 1 }, acted: nav.results?.[0], url: nav.url });
        emit(steps[steps.length - 1]);
      }
    }
  }

  for (let step = 1; step <= maxSteps && !stop; step++) {
    // Perceive. One batch: settle, then where are we, what can be touched,
    // what does it say. The settle matters more than it looks — a click on a
    // link returns the moment the click lands, so without it the next step
    // reads the page we just left and decides against a screen that is gone.
    const look = await deps.exec({
      ...common,
      actions: [
        { a: 'wait', settle: true, timeout: 4000 },
        { a: 'info' },
        { a: 'elements', max: cfg.scan_elements ?? 200, sel: true },
        { a: 'read', mode: 'text', max: 3000 }
      ],
      stopOnError: false
    });
    const info = look.results?.[1]?.r || {};
    const els = look.results?.[2]?.r?.elements || [];
    const page = look.results?.[3]?.r || {};
    const url = info.url || look.url || '';
    visited.add(bare(url));

    const usable = els.filter((e) => {
      if (e.dis) return false;
      const u = used.get(idOf(e));
      // A field we already filled and submitted is spent; leaving it in the
      // list is how a loop spends three steps retyping the same query.
      return !(u && u.enter && u.text && clean(e.value, 120) === clean(u.text, 120));
    });
    const fresh = usable.filter((e) => !deadEnd(e, url, visited));
    // If everything leads backwards, say so by leaving the list alone rather
    // than handing the model an empty page it cannot explain.
    const live = fresh.length ? fresh : usable;
    const ctx = {
      goal, hint: o.hint, step, maxSteps, url,
      title: info.title || page.title || '',
      text: page.text || '',
      // A text field we already filled AND submitted is spent. Leaving it in
      // the list is how a loop spends three steps retyping the same query into
      // the same search box: it stays the most goal-relevant-looking thing on
      // the page long after it has done its job.
      elements: shortlist(live, cfg.max_elements),
      history, candidates: cands, typed, used, visited,
      // Only offer "go to the address in the goal" while we have not been
      // there yet. Once the run has passed through that site, the option is
      // pure noise on every later page — and it competes with recognising
      // that the goal is finished.
      navUrl: navUrl && ![...visited].some((u) => u.includes(navHost)) ? navUrl : null,
      memory: o.memory
    };

    let d;
    try {
      if (!useJev) d = localBrain(ctx, cfg);
      else {
        const see = deps.snap ? cfg.see || 'auto' : 'off';
        d = await jevBrain(ctx, cfg, see === 'always' ? await deps.snap() : null);
        // Before handing a decision back, look at the page. Text misses what
        // only shows visually — a greyed-out button, an overlay, an icon with
        // no label — and one look is far cheaper than a turn of the caller's.
        if (see === 'auto' && !d.done && !d.blocked && d.confidence < cfg.min_confidence) {
          const img = await deps.snap();
          if (img) {
            const again = await jevBrain(ctx, cfg, img);
            again.ms += d.ms;
            d = again;
          }
        }
      }
    } catch (e) {
      stop = { reason: 'brain-error', detail: String(e.message || e) };
      break;
    }

    const byRef = new Map(ctx.elements.map((e) => [e.ref, e]));
    const el = d.target ? byRef.get(d.target) : null;

    const aim = el ? (el.sel || (el.name ? `text=${clean(el.name, 60)}` : `ref=${el.ref}`)) : null;
    const spare = el ? (el.sel && el.name ? `text=${clean(el.name, 60)}` : `ref=${el.ref}`) : null;

    // Already holds exactly what we were going to type: submit it instead of
    // typing it again, which is the shape most loops get stuck in.
    if (d.verb === 'type' && el && el.value && clean(el.value, 120) === clean(d.text, 120)) { d.verb = 'press'; d.retyped = true; }

    const rec = { n: step, url, title: ctx.title, decided: { ...d, state: undefined }, element: el ? label(el) : undefined };

    if (d.done) { stop = { reason: 'done' }; rec.stopped = 'done'; steps.push(rec); emit(rec); break; }
    if (d.blocked) { stop = { reason: 'blocked', detail: 'captcha, login wall or hard error — a human has to take this one' }; rec.stopped = 'blocked'; steps.push(rec); emit(rec); break; }
    // "Stop" and "we are there" are the same move seen from two sides. If the
    // done question leaned yes at all, this is an arrival, not a dead end —
    // reporting it as a failure because it missed the confidence floor by a
    // few points is just wrong.
    if (d.verb === 'finish') {
      const arrived = (d.donep ?? 0) >= 0.5;
      stop = arrived ? { reason: 'done' } : { reason: 'finished', detail: 'nothing on this page advances the goal' };
      rec.stopped = arrived ? 'done' : 'finish';
      steps.push(rec); emit(rec); break;
    }

    // The escalation hatch. Below the confidence floor bx stops and hands the
    // page back rather than clicking something plausible-looking.
    if (d.confidence < cfg.min_confidence) {
      stop = { reason: 'unsure', detail: `confidence ${d.confidence.toFixed(2)} < ${cfg.min_confidence}` };
      rec.stopped = 'unsure';
      rec.handoff = { state: d.state, elements: ctx.elements, url, title: ctx.title };
      steps.push(rec); emit(rec); break;
    }

    if (!o.allow && el && d.verb === 'click' && RISKY.test(el.name || '') && !RISKY.test(goal)) {
      stop = { reason: 'confirm', detail: `next move would click "${clean(el.name, 50)}" — that does not look undoable, and the goal never asked for it` };
      rec.stopped = 'confirm';
      rec.handoff = { state: d.state, elements: ctx.elements, url, title: ctx.title, proposed: { verb: d.verb, target: aim } };
      steps.push(rec); emit(rec); break;
    }

    // A text box and nothing legitimate to put in it. Ask; never improvise.
    if (el && !cands.length && /^(input|textarea)$/.test(el.tag) && verbFor(el, true) === 'type') {
      stop = { reason: 'needs-value', detail: `wants to type into ${label(el)} but the goal never said what — pass it with --var` };
      rec.stopped = 'needs-value';
      rec.handoff = { state: d.state, elements: ctx.elements, url, title: ctx.title, field: label(el) };
      steps.push(rec); emit(rec); break;
    }

    // Same decision, same page, three times running: it is not working.
    const sig = `${d.verb}:${d.target}:${url}`;
    seen.set(sig, (seen.get(sig) || 0) + 1);
    if (seen.get(sig) >= 3) {
      stop = { reason: 'stuck', detail: `repeated ${d.verb} on ${d.target} three times with nothing changing` };
      rec.stopped = 'stuck'; steps.push(rec); emit(rec); break;
    }

    // Act — on the durable selector, never on the ref. Between deciding and
    // acting the page may have re-rendered (a search result list does it
    // constantly), and a ref from the previous paint resolves to nothing.
    let actions;
    if (d.verb === 'type' && el) { actions = [{ a: 'type', target: aim, text: d.text, enter: !!d.enter }]; typed = true; }
    else if (d.verb === 'select' && el) actions = [{ a: 'select', target: aim, value: d.text }];
    else if (d.verb === 'click' && el) actions = [{ a: 'click', target: aim }];
    else if (d.verb === 'press') actions = [{ a: 'press', keys: ['Enter'], target: aim || undefined }];
    else if (d.verb === 'scroll') actions = [{ a: 'scroll' }];
    else if (d.verb === 'back') actions = [{ a: 'back' }];
    else if (d.verb === 'wait') actions = [{ a: 'wait', load: true, timeout: 3000 }];
    else if (d.verb === 'navigate' && ctx.navUrl) actions = [{ a: 'nav', url: ctx.navUrl }];
    else actions = [{ a: 'scroll' }];   // a verb that needed a target and got none

    if (o.dry) {
      rec.dry = actions; steps.push(rec); emit(rec);
      stop = { reason: 'dry-run' };
      break;
    }

    let out = await deps.exec({ ...common, actions, stopOnError: false });
    let r = out.results?.[0] || {};

    // One retry on the other handle before spending a whole decision on it.
    // "Not found" here nearly always means the page moved under us, not that
    // the choice was wrong.
    if (!r.ok && spare && spare !== aim && /not found|no match|no element/i.test(String(r.error || ''))) {
      const retry = actions.map((x) => (x.target === aim ? { ...x, target: spare } : x));
      out = await deps.exec({ ...common, actions: retry, stopOnError: false });
      r = out.results?.[0] || {};
      r.retried = spare;
    }
    rec.acted = { a: actions[0].a, ok: !!r.ok, ms: r.ms, error: r.error, sel: r.r?.sel, target: aim, retried: r.retried };
    rec.after = out.url;
    // Settle after anything that can navigate. A click resolves the instant
    // the event lands, well before the browser has decided to leave the page,
    // so without this the next perception reads the page we just left — and
    // then acts on elements that are already gone.
    if (r.ok && /^(click|press|navigate|back)$/.test(d.verb)) {
      try {
        const s1 = await deps.exec({ ...common, stopOnError: false, actions: [
          { a: 'wait', ms: cfg.settle_ms ?? 450 },
          { a: 'wait', load: true, timeout: 5000 },
          { a: 'info' }
        ] });
        if (s1.url) out.url = s1.url;
      } catch {}
    }

    if (el && r.ok) {
      used.set(idOf(el), {
        verb: d.verb, text: d.text, enter: !!d.enter, to: (out.url || '').split('#')[0],
        what: d.verb === 'type' ? `typed "${clean(d.text, 40)}" into it${d.enter ? ' and pressed Enter' : ''}` : `${d.verb}ed`
      });
    }
    const what = d.verb === 'type' ? `typed "${clean(d.text, 40)}" into ${el ? label(el) : '?'}` : `${d.verb} ${el ? label(el) : ''}`.trim();
    const moved = out.url && lastUrl && out.url !== lastUrl;
    history.push(`step ${step}: ${what} -> ${r.ok ? 'ok' : 'FAILED: ' + clean(r.error, 60)}${moved ? `, page changed to ${out.url}` : ''}`);
    lastUrl = out.url || url;
    steps.push(rec); emit(rec);
  }

  if (!stop) stop = { reason: 'max-steps', detail: `gave up after ${maxSteps} steps` };

  // Getting there is usually half the task — the other half is what the page
  // says once you are there. Hand it back in the same call, so the caller
  // does not spend a whole model turn asking for it.
  let page;
  if (o.read && stop.reason === 'done') {
    try {
      const r = await deps.exec({ ...common, stopOnError: false, actions: [{ a: 'read', mode: 'md', max: typeof o.read === 'number' ? o.read : 8000 }] });
      const p = r.results?.[0]?.r;
      if (p) page = { url: p.url, title: p.title, text: p.text, truncated: p.truncated };
    } catch {}
  }
  return {
    page,
    ok: stop.reason === 'done' || stop.reason === 'dry-run',
    goal, brain: useJev ? 'jev' : 'local',
    ...stop, steps, history,
    usage: useJev ? { calls: steps.filter((s) => s.decided?.brain === 'jev').length, tokens: jev.stats.in } : undefined
  };
}

module.exports = { run, state, label, candidates, verbFor, questions, navTarget, MOVES };
