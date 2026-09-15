---
name: bx
description: Drive a real Chrome browser — navigate, click, type, fill forms, upload files, scroll, screenshot, switch tabs, read pages. Use when a task needs a logged-in browser, a page that only renders with JS, a form submitted, a file uploaded, or a screenshot of real UI. Trigger: /bx, "use the browser", "in Chrome", "fill this form", "upload to", "screenshot the page".
---

# bx — browser control

One command per line. Batch aggressively. Do not deliberate between steps.

```bash
bx status                     # is it connected?
bx open example.com
bx els                        # interactive elements, each with a ref
bx click "text=Sign in"
bx type "#email" you@x.com --enter
bx shot                       # → /home/you/.bx/shots/xxx.jpg
```

## Rule 1 — batch everything

Every action is a network round trip. Put the whole sequence in one `bx do`.
Actions run in order, share one tab, and stop at the first failure.

```bash
bx do '[
  {"a":"nav","url":"example.com/login"},
  {"a":"fill","fields":{"#user":"me","#pass":"secret"}},
  {"a":"click","target":"text=Log in"},
  {"a":"wait","for":"text=Dashboard"},
  {"a":"shot"}
]'
```

Add `--keepgoing` to continue past failures instead of stopping.

A batch is bounded: each action gets its timeout plus a few seconds, and typing
gets extra room proportional to the text. Nothing hangs indefinitely — if a
command has not returned, it is still working.

## Rule 2 — never wait manually

Every element action auto-waits for its target (default 8s). Do not insert
`wait` before a `click`. Only use `wait` for things that are not a target:
`{"a":"wait","for":"text=Done"}`, `{"a":"wait","gone":".spinner"}`,
`{"a":"wait","text":"Payment received"}`, `{"a":"wait","ms":400}`.

A miss costs the full 8s, so when you are probing rather than acting — checking
whether a banner is up, whether login already happened — pass a short timeout
and read the answer: `{"a":"exists","target":".cookie-banner","timeout":300}`.
`exists` never fails; it returns `{"exists":false}`.

## Rule 3 — orient with `els`, not screenshots

`bx els` returns a compact list of every visible interactive element with a
stable `ref`. It is far cheaper than an image and directly actionable.

```
e3    button   Sign in                       412,318
e4    input    Email address                 412,240
```

Then `bx click ref=e3`. Take a screenshot only when the *look* matters,
or when `els` and `read` leave you genuinely unsure what is on screen.

## Rule 4 — bx remembers each site; read what it hands you

Every batch teaches the bridge something about the host it ran on: which
selectors resolved, which missed, what the working sequence was. You get it
back **unasked** — a `memory` block prints when you arrive at a site and
whenever an action fails.

```
  ▸ memory duckduckgo.com
    recipe  search  3 steps · 1/1 ok · /  needs q
    works   [name="q"]
    avoid   input[name=q] (missed ×1)
    note    the search box is a <textarea>, not an <input>
```

Act on it before you probe. `works` is a selector that resolved here for real;
`avoid` already cost someone the full 8s timeout. A `recipe` is the whole flow
in one command.

```bash
bx memo [host]              # ask directly — everything known about a site
bx memo --all               # every site bx has driven
bx recipe search 'q=…'      # replay a stored flow
bx learn <name>             # name the flow you just ran, so it is one command next time
bx note "<what bit you>"    # anything a selector cannot express
bx forget [what] [host]     # all | notes | traces | traps | selectors | recipe <name>
```

**Do this:** the moment a flow that took real work finally succeeds — a login,
a multi-step form, a search that needed the right field — run `bx learn <name>`.
That is the whole point: struggle once, then never again.

Acting through `ref=e12` still teaches it something. Every element action
reports the durable selector it actually landed on (`sel` in the result), and
that is what gets stored — refs are per-snapshot and never remembered.

Typed text is never written to disk. A stored flow keeps the shape and leaves a
named hole where the value went, so `bx recipe login 'user=me' 'password=…'`
supplies them at replay time. Memory lives in `~/.bx/memory/<host>.json`.

## Targets

| form | example |
|---|---|
| CSS | `#email` · `.btn.primary` · `form input[type=submit]` |
| visible text | `text=Sign in` (exact match wins, else contains, innermost element) |
| ref from `els` | `ref=e12` |
| ARIA role | `role=button:Save` · `role=link:Docs` |
| form label | `label=Password` |
| placeholder | `placeholder=Search` |
| name attr | `name=q` |
| XPath | `xpath=//table//a[2]` |
| contains text | `{"sel":"button","has":"Save"}` |
| nearest to an anchor | `{"sel":"button","near":".ql-editor"}` |
| nth match | `{"sel":".row a","nth":2}` |

`has`, `near` and `nth` combine, and `--has` / `--near` / `--nth` are the same
thing on the plain commands: `bx click button --has Comment --near .ql-editor`.

Frames and open shadow roots are searched automatically when the main
document has no match.

### When a target matches more than one thing

Candidates are ranked — visible before hidden, **enabled before disabled**,
document order within a rank — and the action takes the first. A disabled
control never wins over a live one, and `aria-disabled="true"` counts as
disabled, which is how most design systems mark a dead submit button.

Ranking cannot break a tie between two *enabled* elements with the same text,
so the result says when there was one:

```
ok click        41ms  @ 132,107  · 7 matched
  also e2    #post1 > div:nth-of-type(2) > button
  also e3    #post1 > div:nth-of-type(3) > div > button:nth-of-type(2)
```

`n` is how many matched and `alt` lists the runners-up as refs. **Treat
`N matched` as a warning**: the step reported ok, but on a page with six
"Comment" buttons the one it clicked may not be the one you meant. Either
click the ref it handed you, or narrow the target with `has` / `near`. Do not
reach for `eval` to hand-roll a `querySelectorAll(...).filter(...)` — filtering
on `.disabled` alone misses `aria-disabled` and picks the wrong button.

`inert: true` on a result means the element bx acted on was itself disabled —
the click dispatched and the page ignored it.

## Actions

**Navigate** `nav {url}` · `back` · `forward` · `reload {hard}` — all wait for load.

**Pointer** `click {target, button:"right", clicks:2, mods:{ctrl:true}}` · `dblclick` ·
`rclick` · `hover` · `move {x,y}` · `clickAt {x,y}` · `drag {target, to}`

**Keyboard** `type {target, text, enter, clear:false}` · `press {keys:["ctrl+a","Delete"]}` ·
`clear {target}` · `setval {target, value}` (instant, no keystrokes)

**Forms** `fill {fields:{sel:value}}` — one round trip for a whole form; handles
inputs, selects, checkboxes. `--fast` / `"fast":true` skips per-character typing.
Also `select {target,value}` · `check` · `uncheck` · `focus`

**Scroll** `scroll {to:"bottom"|"top"|1200}` · `scroll {by:[0,600]}` ·
`scroll {target:".list", to:"bottom"}` · `scroll {target, into:true}`

**Read** `read {mode:"md"|"text"|"html"|"links", target, max}` ·
`elements {filter, max}` · `exists {target}` · `box {target}` · `info`

**Capture** `shot {target, fullPage, format:"png", maxWidth, inline}`
Writes a file and returns its path. Pass `inline:true` for base64 instead.
`fullPage` and element crops cost more — plain `shot` is the fast path.

**Upload** `upload {target, files:["/abs/path"]}` — real files from disk.
For custom widgets with no reachable `<input type=file>`, use
`{"a":"upload","target":"text=Choose file","files":[...],"viaDialog":true}`
which intercepts the file chooser the click opens.

**Tabs** `tabs` · `tab {id}` (id, or a url/title substring) · `newtab {url, active:false}` ·
`closetab {id}`. A `newtab`/`tab` mid-batch redirects the rest of the batch to
that tab. Use `"active":false` to work in a background tab without stealing focus.

**Other** `eval {expr}` (returns the value; use for anything the actions miss) ·
`cookies {values:true}` · `sleep {ms}`

## Speed and stealth

Input is synthetic by default: a curved, jittered virtual mouse with a full
pointer/mouse event stream, and per-character key events written through the
native value setter so React and Vue register them. No page-visible globals,
no DOM attributes, no injected script tags, no `web_accessible_resources`.

- `--speed instant` — no motion, no key delays. Fastest. Use for scraping, for
  any site that is not scoring behaviour, and for long text: `instant` types a
  2000-character prompt in one write, `fast` takes several seconds.
- `--speed fast` — default. Curved motion, ~3-9ms/char.
- `--speed human` — overshoot, correction, think-pauses. Use when a site is
  scoring behaviour. Roughly 20× slower to type than `fast`; do not use it for
  a whole batch when only the one login click needs it — set it per action.

`--trusted` (or `"trusted":true`) routes clicks and typing through the Chrome
debugger so events carry `isTrusted:true`. Slower, and it shows a debugging
banner on that tab. Reach for it only when a synthetic click visibly does
nothing. `upload`, `eval`, and `shot --full` always use it internally.

## Reading results

Human output by default; `--json` for parsing.

```
✓ nav          412ms  https://example.com/login
✓ fill          88ms  2/2 fields
✗ click         31ms  not found: text=Log in
```

`covered` on a click result means something is on top of the target — usually
a cookie banner or modal. Dismiss it and retry.

## Things that will bite you

- `chrome://` pages, the Chrome Web Store, PDFs and error pages cannot be
  scripted at all. bx says so in ~20ms; do not retry.
- A bare `host:port` is treated as `http://` on loopback and `https://`
  elsewhere. Pass a full URL when you need the other one.
- Hidden tabs run at `instant` speed no matter what you ask for — Chrome
  throttles their timers to 1Hz, so a curved mouse path would take 30s.
- `covered` on a click means an overlay intercepted it. Dismiss the banner or
  modal and click again.
- A batch stops at the first failure unless you pass `"stopOnError":false`.

## When something stalls

Work the list in order; do not sit and retry the same command.

1. `bx status` — one line tells you which half is unhappy.
2. `extension not connected`: Chrome tears the extension's worker down when it
   has been idle. It dials back in within a second or two of any browser
   activity, and `/do` already waits 10s for it. If it is still not connected,
   the extension is not loaded — tell the user: chrome://extensions → Developer
   mode → Load unpacked → the `extension/` folder. The bridge auto-starts; it
   never needs launching by hand.
3. Actions time out on a page that looks fine: the tab is probably busy. Take
   one `bx shot` to see what is actually on screen — a modal, a consent wall,
   or a login you did not expect is the usual answer.
4. The extension answers but every action misbehaves: `bx reload-ext` restarts
   the worker. Use it after editing extension code, or once as a last resort.
5. `bx log 30` shows what the bridge saw, including disconnects.

And when a *page* is the problem rather than the plumbing: `bx memo` may
already hold the answer from the last time this site was difficult.

Never `bx stop` to fix a stall — the bridge is rarely the problem, and
restarting it drops the extension's socket too.

## Without the CLI

Any language, same contract. Token lives in `~/.bx/config.json`.

```bash
curl -s localhost:8787/do -H "x-bx-token: $(bx token)" \
  -d '{"actions":[{"a":"nav","url":"example.com"},{"a":"read"}]}'
```
