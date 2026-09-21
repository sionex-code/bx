# bx

**A browser your AI agent can use at the speed of a person who knows what
they're doing.** bx lets an AI agent (Claude, MiniMax, anything that can run a
shell command) drive your real, logged-in Chrome. A small fast model called
**jev** makes the tiny "which button?" decisions in about a second, so the big
model only plans and writes. Real jobs — posting to LinkedIn groups, researching
200 Facebook groups, filling forms, collecting results from a site — take
minutes, not the hour a model clicking one page at a time needs.

## In one minute

| | |
|---|---|
| **What it is** | A Chrome extension + a local bridge + one command, `bx`. Your agent runs `bx open`, `bx click`, `bx read`… and it happens in your own Chrome, with your logins. |
| **Why it's fast** | Two brains. The **big model** (Claude, MiniMax…) plans, writes posts, answers you. **jev**, a small fast model, answers narrow questions: *which element? did it save? which of these 40 results fit?* About 1 second each, and it can judge a whole list or many pages at once. |
| **Why it's not detected as a bot** | It is your normal Chrome: `navigator.webdriver` is `false`, same cookies, same fingerprint. |
| **What it's for** | Real tasks on real sites: LinkedIn and Facebook groups, comment/reply runs, deep research into groups or a YouTube niche, forms, uploads, scraping to CSV. |

### Why jev + a big model beats either alone

- **A big model alone is slow.** Every click costs a full turn: read the page,
  think, write the next command. Several seconds each, minutes for a task with
  a few dozen decisions, an hour for a few hundred.
- **A small fast model alone can't plan.** We tried it: jev-ultrafast and bx's
  own `bx agent` both stall or wander on goals that need several steps of
  thinking ahead (Alan Walker → Gujrat on Wikipedia, without the search box).
  Given a link list to choose from, jev says "blocked" or picks the wrong
  country.
- **Together:** the big model plans the route and writes the words; jev and bx
  do the clicking, judging and batch reading. On the same short tasks bx took
  about 4–5 s where jev-ultrafast, another jev-based agent, took 8–10 s, and on
  jobs with hundreds of items the batch commands (`sift`, `check`, `read`,
  `each`) replace hundreds of model turns with a handful.

### Which command, in plain words

| You want to… | Run |
|---|---|
| open a page, click, type, screenshot | `bx open` · `bx click` · `bx type` · `bx shot` |
| reach a page by clicking through a known flow | `bx agent "<goal>"` |
| keep only the results that fit a rule | `bx sift "<rule>" --pages 5` |
| ask yes/no about many pages at once | `bx check "<question>" <url> <url>…` |
| read many pages in parallel | `bx read <url> <url>…` |
| list every link on a page (link routes, wiki-walks) | `bx read --mode links --max 5000 "<url>"` |
| do the same thing to every item (reply, comment, message) | `bx each` |

Try it: `bx open "https://en.wikipedia.org/wiki/Alan_Walker"` then
`bx read --mode links --max 5000 | grep -i india`.

## How it works

```
agent --HTTP / bx CLI--> bridge (127.0.0.1:8787) --WebSocket--> extension --> tab
                            |
                            +--> jev (codiv.ai) — decides the next move
```

It can also drive itself. `bx agent "<goal>"` reads the page, asks **jev**
which element advances the goal, acts, and repeats until it is done or until
it is not confident enough to continue — about 1.2 seconds per decision.

## How jev makes agentic browsing faster

An LLM driving a browser spends almost all of its time on small decisions.
Which link is the next page? Did the save go through? Is this search result
one of the ones I want? Each one costs a full turn of the model: read the page
into context, think, write out an answer, pick the next command. That is
several seconds per decision at best. Some models take a minute and a half
to look at one screenshot. A task with a few hundred of these decisions takes
an hour, however fast the browser is.

**jev** (OpenJev, on codiv.ai) takes those decisions off the agent. It is a
*System One* model: it does not write text. It gets the page and a question
with a fixed set of answers (yes/no, one of these elements, keep/drop) and
returns a probability for each answer in about a second. bx turns what the
agent is about to decide into that shape and sends it:

| the agent would… | with jev | typical time |
|---|---|---|
| read a result list and judge every item itself | `bx sift "<criterion>" --pages N`: 10 items per call, calls in parallel, pages turned or feeds scrolled by bx | ~1.5s a page |
| open N pages one by one to answer the same question | `bx check "<question>" <url> …`: every page in a background tab at once | ~15s for 10 |
| work out which element to click | `bx pick "the X"` | ~1s |
| take a screenshot and look at it | `bx check "<question>" --see` | ~3s |
| click through a flow step by step | `bx agent "<goal>"` | ~1.2s a step |

The agent's own turns are left for the work that actually needs a big model:
planning the task, writing the script that builds the table, and answering
the user. A 200-row research job becomes a handful of agent turns plus a few
hundred one-second jev calls, instead of a few hundred agent turns.

jev also makes the result better, not only faster. On a list, an agent under
time pressure tends to fall back on keyword matching. In one run, a Python
filter kept every group whose *search query* said "pakistan", and kept a
"Forex Signal" group as a Pakistani investor community. `bx check "run for
Pakistani retail investors, not a trading-signals or spam group"` rejected
that group with 100% confidence, in 14.7s across three pages.

### Big jobs do not stall

Agent harnesses kill a shell command after about two minutes. Before, a
50-page `bx read` said nothing until its last page had loaded. When the
harness killed it, everything already read was lost. `read` and `check` with
many URLs now:

- print each page the moment it finishes,
- write every result to a journal (`~/.bx/runs/*.jsonl`, or `--out file`),
- cap each page at 30s, so one hung tab cannot hold up the rest,
- stop starting new pages after 75s (`--budget N`) and end with `N left — run
  the exact same command again`. The rerun skips finished pages and retries
  failed ones.

```
8 pages · 3 at a time
═══ Forex Signal | Facebook  tab 5.8s
…
4 pages in 18.9s · 4/8 done · journal ~/.bx/runs/read-444c2ed12cf0.jsonl
  ▸ 4 left — run the exact same command again; finished pages are skipped, failed ones retried
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

## The fast brain

jev (OpenJev, on codiv.ai) is a *System One* model. It does not write prose.
You give it a state and questions you defined — yes/no, pick one of N labels,
a point on a scale — and it returns a calibrated probability distribution over
each. Nothing is generated, so an answer lands in a fraction of the time a
chat model needs to say the same thing in sentences.

That is the exact shape of every decision a browser agent makes. bx builds one
question set per step and sends it in a single round trip:

- **done** — is the goal already satisfied by the page in front of us?
- **blocked** — captcha, 2FA, paywall, hard error?
- **move** — act on an element, scroll, wait, go back, navigate, or stop?
- **target** — *which* element, chosen from the refs actually on the page
- **text** — which of the strings the operator supplied should be typed
- **enter** — would Enter submit this field?

The verb is not a question. What you do to an element is a property of the
element: you type into a text field and you click a button. Asking a model to
choose the verb separately from the target is asking it to contradict itself,
and it does — early versions clicked textareas. bx picks the target and
derives the verb.

```bash
bx agent 'search duckduckgo.com for "anthropic claude opus" and open the first result'
```
```
 1  type     "anthropic claude opus" → textarea "Search with DuckDuckGo"   98%   ok 266ms
 2  click    button "Search"                                              95%   ok 502ms
 3  click    a "Claude Opus \ Anthropic"                                  75%   ok 151ms
 4  done     goal already satisfied                                       78%

✓ done  · 4 steps · brain jev · 4.8s deciding
```

The same goal with `--no-jev`, which swaps jev for plain word overlap and
nothing else:

```
 1  type     "anthropic claude opus" → textarea "Search with DuckDuckGo"  100%   ok 262ms
 2  click    a "Compare Privacy" [offscreen]                              73%   ok 140ms
 3  click    a "Go to DuckDuckGo homepage"                                82%   ok 117ms
 4  click    textarea "Search with DuckDuckGo"                           100%   ok  62ms
 5  stuck    same move three times, nothing changed
```

That fallback is not a fig leaf — it runs the identical loop, offline and with
no key, so the difference between having a brain and not having one is
something you can measure rather than assume.

### It stops instead of guessing

A confidence floor (0.55 by default) sits under every decision. Below it, bx
stops, prints the page as jev saw it, and hands back:

```
⊘ handing back  confidence 0.47 < 0.55

  ▸ over to you https://duckduckgo.com/?q=…
    e29   textarea  Search with DuckDuckGo
    e30   button    Search
    …
    decide, then continue:  bx click ref=eN  ·  bx agent "<the rest of the goal>"
```

That escalation is the design. The fast brain drives; the slow one — whichever
agent or person called bx — takes the hard corners and hands control back.

Two more things it refuses to do on its own. It never invents a string to
type: values come from a quoted phrase in the goal or from `--var pass=…`, and
jev only ever *chooses* between them, so nothing hallucinated reaches a
password field. There is deliberately no "type the whole goal" fallback —
that reads as a safe default and is the opposite, since handed a navigation
goal with a search box on screen it typed the entire instruction into it. With
no value available, the run stops at `needs-value` and asks. And a click that
does not look undoable stops the loop:

```
 3  confirm  wants to click button "Submit order"   88%
⊘ confirm  that does not look undoable, and the goal never asked for it
```

Re-run with `--yes` once you have decided.

### What it sees, and what it is not shown

Half of deciding well is being handed the right options. Each element carries
the part of the page it sits in — main content, navigation, header, footer,
sidebar, form — because without that an agent reads Wikipedia's Read / Edit /
History tabs as interchangeable with the links in the article, and spends its
whole budget flipping between them. Furniture also gets a fixed quota of the
list, so on a long page the article's own links are never crowded out by fifty
sidebar entries before the model sees them.

Three kinds of element are removed before jev is asked at all, because no
amount of prompting reliably stops a model from taking a move that looks like
an ordinary link:

- a fragment on the page we are already on — footnote markers, "(Top)", table
  of contents entries. Clicking only scrolls, and `scroll` is already a move.
- a link back to a page this run has visited. That is the A → B → A ping-pong,
  and it burns the whole budget.
- a text field already filled with the value we were about to type.

What it will not do is plan several hops ahead. jev answers "which of these,
right now"; a task whose next move only makes sense given a route three pages
out is the slow brain's job, or one for `--hint`.

### jev on its own

Two decisions are useful far outside the agent loop:

```bash
bx pick "the main search box"     # ✓ e29  textarea "Search with DuckDuckGo"  93%
                                  #   selector [name="q"]
bx check "am I logged in"         # yes / no, with a probability
```

`pick` is the way out of a selector you cannot guess — it reads the live
element list and returns a durable selector you can use straight away.

Most real tasks are lists, and jev judges them a page at a time:

```bash
bx sift "an AI or machine learning gig" --pages 3      # 120 gigs judged in ~20s, pages turned by bx
bx items --pages 3 --json                              # the raw rows, no model at all
bx check "the group allows anonymous posts" <url> <url> ...   # many pages at once, in background tabs
bx read <url> <url> ... --max 1500                            # many pages' text at once
bx read --file urls.txt --max 2000                            # hundreds: time-boxed, journaled, rerun to continue
```

`sift` finds the page's repeated list (results, cards, rows), sends it to jev
ten items per call with the calls in parallel, and follows "next", or scrolls
on feeds that load more as you scroll. `check` and `read` with URLs open every
page at once in background tabs and close them afterwards. On sites that
serve real HTML they first try fetching the page from inside a tab already on
that site, which needs no tab at all.

jev also sees screenshots. `check` and `pick` add one when the text answer
is unsure or the question is about looks ("is the button greyed out"), and
`--see` forces it.

### Get a jev key (2 minutes)

jev is a hosted model, so bx needs an API key. It is separate from your Claude
or MiniMax key, and you only do this once.

1. Go to **https://codiv.ai** and sign up or log in. (codiv.ai and TypeSafe are
   the same service. `https://console.typesafe.ai/keys` is the console page
   the key comes from.)
2. Open the **API Console** from your account menu, then **Keys**, and create
   a new key. Copy it now; it starts with `sk-`.
3. Give it to bx:
   ```bash
   bx jev key sk-paste-your-key-here     # saved to ~/.bx/config.json, mode 0600
   bx jev                                # should say the key is set; jev on
   ```
   Or, without saving it to disk: `export CODIV_API_KEY=sk-...` before starting
   the bridge. `TYPESAFE_API_KEY` works too.
4. Check it works: `bx open example.com` then `bx check "is this the example.com page"`
   should answer `yes` in about a second.

Pricing and free credit are on https://codiv.ai/pricing; usage per call is
shown by `bx jev`. Without a key bx still drives your browser, but `sift`,
`pick`, `check` and `bx agent` need one. Never paste your key into a chat with
an agent or commit it: it is only stored on your machine.

### Setup

```bash
bx jev key sk-codiv-...     # or export CODIV_API_KEY
bx jev                      # key, model, floor, and what it has cost so far
bx jev off                  # every agent run falls back to word matching
```

The key is stored in `~/.bx/config.json` (0600) and is never logged or sent
anywhere but codiv.ai. **No key ships with bx; bring your own from codiv.ai.**
Without one, everything that does not need a model still works: driving the
browser, `items`, multi-page collection, parallel `read`, site memory, and
`agent --no-jev`. `sift`, `pick`, `check` and the jev agent say plainly that
they need a key.

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

## Before and after: measured

Real tasks, driven by a separate agent (MiniMax-M3 in opencode) through the bx
skill, timed from its session logs. "Before" is the same agent with plain
browser commands (open, read, screenshot, click) doing the reasoning itself.

| task | before | after | what changed |
|---|---|---|---|
| 140 Pakistani Python AI gigs on Fiverr, as a table | 3m 39s for 48 gigs | **1m 33s for 144** | site memory knew the filter URL; `items --pages 3`; table built by script |
| the same, keeping only real AI gigs | the model reads every card | **+20s** for 120 gigs | `sift`, 119/120 agree with a keyword check |
| which of 10 Facebook groups allow anonymous posts | 2m 20s, one by one | **15s**, one command | `check "<q>" <10 urls>` in parallel background tabs |
| 10 Pakistani investment groups with 10k+ members | ~2.5–4 min (estimate) | **61s** | `sift` per search, ~1.5s each |
| US fintech companies rated 3.0+ on Trustpilot | 6.5 min, 80 commands | **~15s** for 3 pages | filters as URL params, `sift --pages` |

For scale, the Fiverr table by hand (set the filter, copy name, title, rating,
reviews, price and link for 140 gigs) is roughly 45–70 minutes. That is an
estimate, not a measurement.

Where the time went before, from the logs:

- `sleep 3 &&` in front of nearly every command, about 2 minutes a task. Every
  read now waits for the page to load and go quiet by itself.
- A screenshot after every click, which the model then had to view, 5–8s each.
  `bx click` now reports what changed: the new URL, and every element that
  appeared, with refs.
- Paging and reading results one page at a time. `--pages N` does it in one
  call.
- Hunting through filter dropdowns. Custom checkboxes were invisible to `els`,
  and `info` cut URLs off before the filter part. Both are fixed, and a filter
  set by clicking is now remembered as a URL parameter for next time.

### Case study: 200 Facebook investment groups

Task: "list 200 Facebook groups with potential Pakistani investors, no spam,
every detail in a CSV." MiniMax-M3 in opencode, timed from the session log.
In this run it used bx's parallel reads but **never called jev**. It filtered
with Python keyword lists instead, which makes it a clean baseline.

| phase | time |
|---|---|
| one screenshot, viewed by the model | 1.6 min |
| 19 searches, scrolled by hand, `bx items` | 4.4 min |
| re-reading the first 50 pages to learn the format | 3.8 min |
| reading all 570 group About pages (~2s each, 4–8 tabs) | ~19 min |
| batches killed by the 120s limit or hung | ~3 min |
| model API stall (no command running) | 16 min |
| **CSV delivered** | **49 min** (~30 without the stall) |

Of the 200 groups it chose, only 134 mention anything Pakistani in their own
name or description. The rest got in because the search phrase did.

The same job run the way the skill now prescribes: `sift` each search while
bx scrolls it, `check` the keepers, read only those, and rerun on `N left`.
That is expected to take **10–15 minutes**, with jev making the "Pakistani, not
spam" call on every group. This is an estimate from the phase times above,
not a measured run. By hand, with the same nine columns, it is roughly 7–10
hours: about 1.5–2 minutes to open and copy each of 200 groups, plus the
searching and skimming.

jev itself:

| | before | after |
|---|---|---|
| one decision | ~1.6s (new TLS connection per call) | ~1.0–1.2s (kept-alive connection) |
| `sift` on a 40-item page | 1 call, **24/40 wrong** | 4 parallel calls of 10, **0/40 wrong**, same ~1.3s |
| visual question from text alone | confident and wrong | screenshot attached automatically, correct |

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
  jev.js      the codiv.ai System One client
  agent.js    perceive, decide, act, repeat — and when to stop
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
