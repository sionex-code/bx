# bx

bx lets an AI agent drive your real Chrome browser. Not a fresh, empty,
automation-flagged browser spun up by a script, but the actual Chrome you use
every day, with your logins, your cookies, your extensions, your fingerprint.
The agent clicks, types, scrolls, uploads files, and reads pages exactly as
you would, through a small extension sitting quietly in your browser.

```
agent --HTTP / bx CLI--> bridge (127.0.0.1:8787) --WebSocket--> extension --> tab
```

## What bx actually is

Most browser automation tools work by launching a *new* browser instance
through the Chrome DevTools Protocol (CDP). That new instance has no cookies,
no session, no history. To automate a site you are logged into, you either
have to log in again inside that throwaway browser, or fight with copying
profile data across. And because CDP attaches at a low level, many sites can
detect it: `navigator.webdriver` turns true, timing and event signatures look
robotic, and a debugger banner may appear.

bx flips that model. It is a regular Chrome extension, loaded the normal way,
running inside the browser window you already have open. A tiny local bridge
server (plain Node, zero dependencies) listens on `127.0.0.1:8787` and talks
to that extension over a WebSocket. An agent, or the `bx` CLI, sends one HTTP
request to the bridge, the bridge forwards it to the extension, the extension
acts on the page, and the result comes back. No new browser window, no fresh
profile, nothing that looks out of place.

## Why this is better than the usual approach

**It is your actual session.** If you are logged into Gmail, your bank,
Twitter, or an internal dashboard, bx is already logged in too, because it is
the same browser. Nothing to re-authenticate, no cookie exporting, no
two-factor prompts triggered by a "new device."

**It does not look like automation.** bx ships a virtual mouse that moves
along a curved path with natural jitter and, at higher fidelity, overshoot and
correction, the way a hand actually moves a cursor. Clicks fire the full real
event sequence in the right order: `pointerover`, `mouseover`, `mouseenter` up
the ancestor chain, `pointermove` and `mousemove` carrying genuine
`movementX/Y`, then the down and up events with correct `buttons`, `detail`,
and `pressure`. Typing fires real per-character `keydown`, `keypress`,
`beforeinput`, `input`, and `keyup` events with the physical key codes Chrome
itself reports, and values are written through the native input setter so
React, Vue, and Svelte controlled inputs actually register the change, not
just the raw DOM value. `navigator.webdriver` stays false. The page cannot
find the extension either: it declares no web-accessible resources, injects
no scripts into the page's global scope, adds no `data-*` markers, and never
enables `Runtime.enable`, so there is nothing for a fingerprinting script to
grab onto.

**It remembers every site it touches.** This is the part most automation
tools simply do not have. Every action and its outcome flows through the
bridge, so bx quietly builds a memory of what works on each site: which
selectors resolved, which ones burned a full timeout and should be avoided,
and what a whole successful flow looked like end to end. The next time you
arrive at that host, or the moment something fails, bx hands that memory back
to you unprompted. Name a flow once it works and it collapses into a single
replayable command. A login flow you fought with the first time becomes one
line forever after.

**It is fast because it does less unnecessary work.** Every element action
auto-waits for its target instead of forcing you to add manual delays before
every click. Content scripts are preloaded at `document_start` in every
frame, so there is no injection lag. Hidden tabs automatically drop to their
fastest mode, since Chrome throttles their timers anyway and nobody is
watching them. Text matching walks the document once instead of calling
`getComputedStyle` on every element, and the wait loop backs off based on how
expensive its own search actually is, so a target that never appears cannot
freeze the page for the full timeout.

**It batches.** A whole multi-step flow (navigate, fill a form, click submit,
wait for the result, screenshot) can be sent as one request instead of six
separate round trips, which matters a lot when every round trip has network
latency attached to it.

**Secrets stay out of storage.** Typed text is never written to disk. A saved
flow keeps its shape (which fields, in what order) and leaves a named hole
where the value went, so a stored login recipe asks for the password again at
replay time instead of keeping it around. Sensitive-looking query parameters
are stripped before a URL is ever saved.

## Install

```bash
./install.sh
```

Then, once, in Chrome: go to `chrome://extensions`, turn on **Developer
mode**, click **Load unpacked**, and select the `extension/` folder. Run
`bx status` to confirm it connected.

The bridge starts itself the first time any command runs. There is nothing to
launch by hand and nothing that needs to stay open in a terminal.

## Using it

```bash
bx open example.com
bx els                                  # every interactive element, with refs
bx click "text=Sign in"
bx type "#email" me@example.com --enter
bx shot                                 # saved to ~/.bx/shots/xxx.jpg
```

Batching, the way it should normally be used, one round trip instead of many:

```bash
bx do '[
  {"a":"nav","url":"example.com/login"},
  {"a":"fill","fields":{"#user":"me","#pass":"secret"}},
  {"a":"click","target":"text=Log in"},
  {"a":"wait","for":"text=Dashboard"},
  {"a":"shot"}
]'
```

Run `bx help` for the full command list. `skill/SKILL.md` is the complete
contract, written for an agent to read directly.

## Memory in practice

```
$ bx open duckduckgo.com
ok nav        2608ms  https://duckduckgo.com/

  > memory duckduckgo.com
    recipe  search  3 steps . 1/1 ok . /  needs q
    works   [name="q"]
    avoid   input[name=q] (missed x1)
    note    the search box is a <textarea>, not an <input>
```

`works` and `avoid` are earned through actual use: a selector that resolved
here for real, and one that already cost a full 8 second timeout on this same
site. Once a flow works, name it and it becomes one command:

```bash
bx learn search              # names the flow you just ran
bx recipe search 'q=claude'  # replays it
```

Even clicking through a `ref=` from `bx els` still teaches bx something,
because every action reports the durable selector it actually landed on, and
that is what gets remembered. A ref only means something for the current
page snapshot; the selector behind it is what lasts.

```
memo [host]        everything known about a site   (--all lists every site)
learn <name>        name the flow you just ran      (--back N for an earlier one)
recipe <name>        replay it, sel=value for anything it needs
note <text>          remember something a selector cannot express
forget [what]        all | notes | traces | traps | selectors | recipe <name>
```

Memory lives in `~/.bx/memory/<host>.json`, permissioned `0600` inside a
`0700` directory, and `bx forget all <host>` deletes it entirely.

## From another agent or language

The CLI is a thin shell over one HTTP endpoint, so any language can drive bx
directly. The token lives in `~/.bx/config.json`.

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
`/bx`, or simply asking for the browser, loads the whole contract.

## Staying unnoticed, in detail

Input is synthetic by default, shaped to look like a hand:

- a virtual cursor traveling a cubic Bezier curve with per-step jitter,
  easing, and, at `human` speed, overshoot followed by correction
- the complete event stream in the correct order, from `pointerover` through
  `click`, with real coordinates and pressure values
- per-character keyboard events with the correct physical key codes, values
  written through the native setter so framework-controlled inputs register
  them properly
- occasional pauses that mimic thinking, longer gaps after spaces

And the extension leaves nothing for a page to detect:

- no `web_accessible_resources`, so a page cannot probe for the extension's ID
- nothing written to the page's global scope, no `data-*` attributes, no
  injected `<script>` tags; element identity lives in a `WeakRef` map instead
- `chrome.debugger` stays detached until an action genuinely needs it, and
  `Runtime.enable` is never called

Verified from inside the page itself: `navigator.webdriver` reads false,
`window.BX` is undefined, there are zero `bx` attributes anywhere in the DOM,
zero extension scripts, and extension URLs are unfetchable.

`--trusted` routes clicks and typing through the Chrome debugger to get
`isTrusted:true`, for the rare site that refuses synthetic events entirely.
It puts a visible debugging banner on that tab, so it is opt-in, per action.
`upload`, `eval`, and `shot --full` use it internally and only briefly.

## Speed

| mode | timing | when to use it |
|---|---|---|
| `--speed instant` | 19ms to type 9 characters, 24ms to click | scraping, bulk work |
| `--speed fast` (default) | about 300ms / 130ms | curved motion, still quick |
| `--speed human` | about 1.5s / 400ms | overshoot and pauses, for sites that score behavior |

## Layout

```
bridge/     zero-dependency HTTP + WebSocket server (node, no npm install)
  memory.js   per-site learning: selectors, traps, flows, recipes
extension/  MV3 extension: service worker, virtual mouse, keyboard, actions
cli/bx      the terminal client
skill/      the agent-facing contract
```

## Good to know

- `chrome://` pages, the Chrome Web Store, PDFs, and error pages cannot be
  scripted at all. That is a Chrome-level restriction, and bx reports it
  immediately instead of timing out.
- `eval` requires the debugger, because page CSP blocks every other path to
  running arbitrary JS in the main world.
- Screenshots of a background tab go through CDP so the tab is never pulled
  into focus.
- The first extension to connect claims the bridge, and its ID is pinned in
  `~/.bx/config.json`. Delete `extension_id` there to re-pair.
- Chrome suspends the extension's service worker when it sits idle. Any
  browser activity wakes it back up within about a second, and `/do` waits
  for that, so the first command after a quiet stretch may take a moment
  longer than usual.
- `bx reload-ext` restarts the extension's worker without a trip to
  `chrome://extensions`. Use it after editing anything under `extension/`.
