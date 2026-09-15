# bx

Drive your real Chrome from any agent. No CDP launch flags, no fresh profile,
no automation banner — a normal extension in your everyday browser, with your
cookies and your fingerprint.

```
agent ──HTTP / bx CLI──► bridge 127.0.0.1:8787 ──WebSocket──► extension ──► tab
```

## Install

```bash
./install.sh
```

Then, once, in Chrome: `chrome://extensions` → **Developer mode** → **Load
unpacked** → pick the `extension/` folder. `bx status` should say connected.

The bridge starts itself the first time any command runs. Nothing to launch,
nothing to keep in a terminal.

## Use it

```bash
bx open example.com
bx els                                  # every interactive element, with refs
bx click "text=Sign in"
bx type "#email" me@example.com --enter
bx shot                                 # → ~/.bx/shots/xxx.jpg
```

Batch, always — one round trip instead of six:

```bash
bx do '[
  {"a":"nav","url":"example.com/login"},
  {"a":"fill","fields":{"#user":"me","#pass":"secret"}},
  {"a":"click","target":"text=Log in"},
  {"a":"wait","for":"text=Dashboard"},
  {"a":"shot"}
]'
```

`bx help` lists every command. `skill/SKILL.md` is the full contract, written
for an agent to read.

## It remembers sites

The bridge sees every action and its outcome, so learning is free. Drive a site
once and it keeps what worked, keyed by host — and hands it back when you next
arrive there, or the moment something fails.

```
$ bx open duckduckgo.com
ok nav        2608ms  https://duckduckgo.com/

  ▸ memory duckduckgo.com
    recipe  search  3 steps · 1/1 ok · /  needs q
    works   [name="q"]
    avoid   input[name=q] (missed ×1)
    note    the search box is a <textarea>, not an <input>
```

`works` and `avoid` are earned: a selector that resolved, and one that already
burned a full 8s timeout here. Name a flow once it works and it collapses to a
single command:

```bash
bx learn search              # names the flow you just ran
bx recipe search 'q=claude'  # replays it
```

```
memo [host]        everything known about a site   (--all lists every site)
learn <name>       name the flow you just ran      (--back N for an earlier one)
recipe <name>      replay it,  sel=value for anything it needs
note <text>        remember something a selector cannot express
forget [what]      all | notes | traces | traps | selectors | recipe <name>
```

Acting through a `ref=` still teaches it something: every element action
reports the durable selector it actually landed on, and that is what gets
stored — a ref means nothing an hour later.

**Typed text is never written to disk.** A stored flow keeps the shape and
leaves a named hole where the value went, so a login recipe records the fields
and their order and asks you for the password at replay time. Secret-looking
query parameters are stripped from stored URLs. Memory lives in
`~/.bx/memory/<host>.json`, `0600` in a `0700` directory, and
`bx forget all <host>` deletes it.

## From another agent or language

The CLI is a thin shell over one HTTP endpoint. Token lives in
`~/.bx/config.json`.

```bash
curl -s localhost:8787/do -H "x-bx-token: $(bx token)" \
  -d '{"actions":[{"a":"nav","url":"example.com"},{"a":"read"}]}'
```

```python
import json, urllib.request, pathlib
cfg = json.loads(pathlib.Path.home().joinpath('.bx/config.json').read_text())
def bx(*actions, tab='active'):
    r = urllib.request.Request(f"http://127.0.0.1:{cfg['port']}/do",
        data=json.dumps({'tab': tab, 'actions': list(actions)}).encode(),
        headers={'x-bx-token': cfg['token'], 'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(r))

bx({'a': 'nav', 'url': 'news.ycombinator.com'}, {'a': 'read', 'mode': 'links'})
```

For Claude Code, `install.sh` links `skill/` into `~/.claude/skills/bx`, so
`/bx` (or just asking for the browser) loads the whole contract.

## Staying unnoticed

Default input is synthetic, and shaped to look like a hand:

- a virtual cursor that travels a cubic Bézier with per-step jitter, easing,
  and (at `human` speed) overshoot plus correction
- the complete event stream in the right order — `pointerover`, `mouseover`,
  `mouseenter` up the ancestor chain, `pointermove`/`mousemove` carrying real
  `movementX/Y`, then down → focus → up → click with the right `buttons`,
  `detail` and `pressure`
- per-character `keydown`/`keypress`/`beforeinput`/`input`/`keyup` with correct
  `code` and `keyCode` (`@` reports 50, `.` reports 190 — the physical key,
  the way Chrome does it), values written through the native setter so React,
  Vue and Svelte controlled inputs register them
- occasional think-pauses, longer gaps after spaces

And the extension leaves no handle to grab:

- no `web_accessible_resources`, so a page cannot probe for the extension ID
- nothing written to the page's global scope, no `data-*` attributes, no
  injected `<script>` tags — element identity lives in a `WeakRef` map
- `chrome.debugger` stays detached until an action actually needs it, and
  `Runtime.enable` is never called

Verified from the page's side: `navigator.webdriver` false, `window.BX`
undefined, zero `bx` attributes in the DOM, zero extension scripts, extension
URLs unfetchable.

`--trusted` routes clicks and typing through the debugger for `isTrusted:true`
when a site refuses synthetic events. It costs a visible debugging banner on
that tab, so it is opt-in per action. `upload`, `eval` and `shot --full` use it
internally and briefly.

## Speed

| | |
|---|---|
| `--speed instant` | 19ms to type 9 chars, 24ms to click. Scraping. |
| `--speed fast` *(default)* | ~300ms / ~130ms. Curved motion, still quick. |
| `--speed human` | ~1.5s / ~400ms. Overshoot, pauses. For scored sites. |

Content scripts are preloaded at `document_start` in every frame, so there is
no injection latency. Every element action auto-waits for its target, which
removes the usual wait-then-act round trip. Hidden tabs drop to `instant`
automatically, since Chrome throttles their timers to 1Hz and nobody is
watching anyway.

What that costs on a page is the part that matters. `text=` resolution walks
the document's text nodes once instead of calling `getComputedStyle` on every
`div`; visibility is one native `checkVisibility` call; the shadow-root walk is
cached between polls; and refs are looked up through a `WeakMap` rather than
scanning the ref table. The auto-wait loop also backs off in proportion to what
its own search cost, so a target that never appears cannot pin the page's main
thread for the full timeout — which is what used to make a tab feel hung.

An element missing from the main document is looked for in every frame at once,
and the action then runs only in the frame that answered. `nav` returns on the
main frame's `DOMContentLoaded` rather than on `status: complete`, so a page
still pulling in trackers does not hold up the batch.

## Layout

```
bridge/     zero-dependency HTTP + WebSocket server (node, no npm install)
  memory.js   per-site learning: selectors, traps, flows, recipes
extension/  MV3 extension — service worker, virtual mouse, keyboard, actions
cli/bx      the terminal client
skill/      the agent-facing contract
```

## Notes

- `chrome://` pages, the Web Store, PDFs and error pages cannot be scripted —
  that is a Chrome rule, and bx says so immediately instead of timing out.
- `eval` needs the debugger, because page CSP blocks every other route to
  arbitrary JS in the main world.
- Screenshots of a background tab go through CDP so the tab is not pulled into
  focus.
- The first extension to connect claims the bridge; its ID is pinned in
  `~/.bx/config.json`. Delete `extension_id` there to re-pair.
- Chrome stops the extension's service worker when it is idle. Any browser
  activity wakes it, it reconnects within a second, and `/do` waits for it —
  so a first command after a quiet spell may take a moment longer.
- `bx reload-ext` restarts the extension worker without a trip to
  `chrome://extensions`. Use it after editing anything under `extension/`.
