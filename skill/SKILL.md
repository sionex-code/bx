---
name: bx
description: Drive a real Chrome browser — navigate, click, type, fill forms, upload files, scroll, screenshot, switch tabs, read pages. Its fast model jev replaces most of your own per-page reasoning — bx agent clicks through to a goal, bx sift judges a whole result list across pages in seconds, bx check answers a yes/no about one page or many pages at once, bx read <urls> pulls many pages in parallel; prefer those to opening, reading and screenshotting pages yourself one by one. Use when a task needs a logged-in browser, a JS-rendered page, a form submitted, a file uploaded, results collected from a site, or a screenshot of real UI. Trigger: /bx, "use the browser", "in Chrome", "fill this form", "upload to", "screenshot the page", "find X on <site>".
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

## Big jobs (50+ results): follow this exactly

"Find 200 Facebook groups that are X, with details, as a CSV" is five commands
of yours, not fifty. The same shape fits any site.

```bash
# 1. one search per phrase; --pages scrolls the feed for you (never bx do scroll loops)
bx open "https://www.facebook.com/groups/search/groups/?q=stock%20market%20pakistan"
bx sift "a group for Pakistani retail investors, not a trading-signals, betting or spam group" --pages 5 --json > s1.json
#    …repeat for each phrase (s2.json, s3.json …), then collect the kept hrefs into keep.txt with a short script
# 2. a question the list cannot answer: every kept page at once
bx check "the group is active and not full of spam posts" --file keep.txt
# 3. values (members, posts, created): read only the keepers
bx read --file keep.txt --max 2000 > about.txt
```

Rules that keep a big job from stalling:

- **Filter before you read.** jev judging a list costs ~1.5s a page of 40.
  Reading one Facebook page costs 5–14s. Reading 570 groups to keep 200 is
  twenty minutes you did not need to spend.
- **`read` and `check` with many URLs stop by themselves after 75s.** They print each
  page as it finishes and write every result into a journal. If the last
  line says `N left`, **run the exact same command again**: finished pages
  are skipped and failed ones retried. Keep going until it says `complete`.
  Never split the list into batch files, write a shell loop over it or add
  `2>/dev/null`: that hides the `left` line.
- The journal (path on the last line, `~/.bx/runs/*.jsonl`) holds one JSON
  object per page (`url`, `title`, `text` or `answers`). Parse that file for your CSV,
  not the terminal text.
- **Never view a screenshot to find out what is on a page.** It took one model
  95 seconds per image. `bx items`, `bx check "<q>"` and `bx check "<q>" --see`
  answer in 1–3s.
- Look at one page's text once (`bx read <one url> --max 3000`) before writing a
  parser. Do not re-read the whole batch to discover its format.
- Put the user's judgement words ("not spam", "Pakistani", "beginners") into
  the `sift` or `check` criterion. Do not rebuild them as keyword lists in
  Python: a keyword filter cannot tell a Pakistani group from one whose
  search query happened to say "pakistan".

## Rule 0 — every decision you make about a page, try jev first

Each of your own turns costs several seconds. A jev call costs about one. So
before you read a page and reason about it, ask whether the thing you are
about to decide is one of these, and if it is, hand it over:

| you are about to… | run this instead | cost |
|---|---|---|
| click and type your way to some page or state | `bx agent "<goal>"` | ~2s per step, no turns of yours |
| go through a list and keep the ones that fit | `bx sift "<criterion>" --pages N` | ~1–2s a page, bx turns the pages |
| read a list's items with their links | `bx items --pages N` | no model at all |
| work out which element is "the X" | `bx pick "the X"` | one call |
| confirm something about the page (did it save, am I logged in) | `bx check "<question>"` | one call |
| ask the same thing about several pages (which of these groups allow X) | `bx check "<question>" <url> <url> …` | all pages at once, ~15s for 10 |
| get values off several pages (member count, price, contact of each) | `bx read <url> <url> … --max 1500` | all pages at once, ~7s for 4 |

**Never take a screenshot to see what a click did.** `bx click` reports it:
the new URL if the page moved, and every element that appeared (a dropdown's
options, a dialog's buttons), each with a ref you can click next. A shot
followed by viewing it costs 5–8s of your time per click and tells you less.

**`bx info` prints the full URL.** After you set a filter once by clicking,
that URL is the filter. Copy it and change only the query from then on.

**Never `sleep`.** `bx read`, `els`, `shot`, `items`, `sift`, `pick` and
`check` wait on their own until the page has loaded and gone quiet (up to 4s),
and `bx open` returns once the page has loaded. `sleep 3 && bx read` just adds
three seconds.

### Which command for which task

Almost every browser task is some mix of these. Match the part you are on:

| the task says… | shape | do this |
|---|---|---|
| "log in", "go to settings and change X", "fill this form", "upload" | a path of clicks | `bx agent "<goal>"`; single commands only for a step you know exactly |
| "find N things on <site> that are X" | a list to filter | the recipe below: URL filters → `bx sift --pages N` |
| "…which of them has / allows / shows Y" | a yes/no per item | `bx check "<Y>" <url> …` on all of them at once |
| "…and tell me the Z of each" | a value per item | `bx read <url> … --max 1500`, then read off Z |
| "is the page / button / modal …" (how it looks) | visual | `bx check "<question>" --see` |
| "do X to each of them" (join, message, post) | an action per item | `bx agent "<goal>"` per item, one at a time; irreversible clicks stop for `--yes` |

If you notice you are about to run the same command for the fifth time with a
different URL, stop. There is almost always a single command for the batch.

### Collecting results from a site: the recipe

"Find 10 US fintech companies rated 3.8+ on Trustpilot" and "find LinkedIn
groups about X" are the same four moves, and none of them is reading pages:

1. **Get to the filtered results with a URL.** Search pages put their
   filters in the query string. Apply a filter by clicking once if you have
   to, read the URL it produces (`bx info`), and from then on build the URL
   yourself: `?query=fintech&trustscore=3.0&location=United+States`. Change
   the search terms or filters by editing the URL, never by clicking through
   the filter UI again. Filters with an autocomplete, like a location box,
   are where a clicking agent burns minutes.
2. **`bx sift "<criterion>" --pages 5`** reads the list, judges every item,
   clicks "next" and does it again: one command, a few seconds a page. Use
   `bx items --pages 5` when you only need the raw rows.
3. **Check exact numbers yourself.** sift is sound on judgement calls ("a
   fintech company", "US-based", "an actual business, not a blog") but is
   only about 90% right on number thresholds like "rated 3.8 or higher". Each
   row shows the numbers cleanly (`Fintech Crest · fintechcrest.org · 3.9 ·
   4 · reviews · …`), so read them off the kept rows. Put coarse number filters
   in the URL where the site has one (`trustscore=3.0`).
4. **For what the list does not show, check every item in one command:**
   `bx check "<question>" <url1> <url2> …`. Never open them one by one.

A task that needs 10 results is about 3 commands of yours, not 30.

**Report what the page says, under the page's own label.** If the user asks
for a field the site does not show (Fiverr publishes review counts, not order
counts), say it is not available and offer the nearest real field, labelled
as what it is. Never rename a nearby number to fill the column. When a number
in `bx items` output has no label, like `4.8 · ( · 26 · )`, check what it is
on one item's page (`bx read <url>`) before you name the column.

**Big tables: don't retype rows.** Writing out a 50-row table token by token
is slow. For large results, have a command produce it (`bx items --pages 2
--json` piped through `jq` or a short script into a file), then show the
file or the top rows.

Use `bx agent` for navigation hops you cannot express as a URL (add `--read`
to get the page it lands on). Going back to `bx read` and reading every card
yourself is the slow path, and it is exactly what jev exists to replace.

Drive by hand only when you already know the exact element, when the flow
is one action long, or when jev has handed a decision back to you.

### bx agent — the whole loop

`bx agent "<goal>"` reads the page, asks jev which element advances the goal,
acts, and repeats. jev returns a probability over the refs that are actually
on the page, so it cannot invent a selector.

```bash
bx agent 'search duckduckgo.com for "anthropic claude opus" and open the first result'
```
```
 1  type     "anthropic claude opus" → textarea "Search with DuckDuckGo"   98%   ok 266ms
 2  click    button "Search"                                              95%   ok 502ms
 3  click    a "Claude Opus \ Anthropic"                                  75%   ok 151ms
 4  done     goal already satisfied                                       78%
✓ done · 4 steps · brain jev · 4.8s deciding
```

Use it for anything multi-step and ordinary: find a page, run a search, fill a
form, get through a wizard — including the navigation legs of a bigger task.

**It stops rather than guesses.** Three endings need you:

| ending | what it means | what to do |
|---|---|---|
| `unsure` | jev's confidence fell below the floor (0.55) | it prints the page and the refs — you pick, `bx click ref=eN`, then `bx agent "<the rest>"` |
| `needs-value` | it wants to type somewhere but the goal never said what | re-run with `--var name=value` |
| `confirm` | the next click looks irreversible (submit, delete, send) and the goal never asked for it | decide, then re-run with `--yes` |
| `blocked` | captcha, 2FA, paywall, hard error | tell the user; do not try to route around it |

`stuck` and `max-steps` mean the loop was going nowhere — read the trace, then
drive the last bit by hand.

Flags: `--steps N` (default 12) · `--dry` decide but do not act · `--hint
"..."` extra context · `--var pass=hunter2` supply a value to type · `--yes`
allow irreversible clicks · `--confidence 0.7` raise the floor · `--read`
also return the final page as markdown when the goal is reached (`--read=20000`
for a longer cap) · `--json`.

**Values are never invented.** jev only ever picks from strings you supplied —
a quoted phrase in the goal, or a `--var`. There is no "type the whole goal"
fallback, so a goal with nothing quoted and no `--var` stops at `needs-value`
instead of typing your instruction into a search box.

**Say the constraint in the goal.** The element list tells jev which part of
the page each element sits in (main content, navigation, header, footer,
sidebar, form), and it is told that site furniture rarely advances a goal
about content. Links back to pages the run already visited, and footnote or
table-of-contents anchors that only scroll the current page, are removed
before jev ever sees them. Phrases like "by clicking links only" or "without
searching" are honoured, so write them down when they matter.

**It will not plan several hops ahead.** jev answers "which of these, right
now". A task whose next move only makes sense given a route three pages out —
a Wikipedia race, say — is the one to drive yourself, or to feed a route
through `--hint`.

### bx items and bx sift — lists

```bash
bx items                           # the page's main repeated list: text + link per item
bx items "ul.results" --max 100    # when it picks the wrong list, point it at the right one
bx sift "fintech companies based in the US" --pages 5
bx sift "remote jobs paying over 80k" --all   # show the dropped ones too
bx items --pages 3 --json                     # raw rows across pages
```
```
3 of 10 kept · 1.2s
keep 100%   9  Denmark/Pakistan IT start-ups and innovation program Public Group 1K members …
                https://www.linkedin.com/groups/12512168/
```

`items` finds the biggest block of same-shaped siblings on the page (search
results, cards, table rows), skips navigation, header, footer and sidebar,
and keeps each card's pieces apart with ` · ` so numbers stay readable.
`sift` runs `items` and has jev judge every item against your criterion, one
call per page. `--pages N` (up to 20) follows the page's "next" link or button
and judges each page while loading the next; entries a site repeats on a
later page are dropped. On sites without page links, which load more as you
scroll (Facebook, LinkedIn, X), each "page" is one scroll to the bottom and
the new rows it brings in. That only works in the visible tab, because Chrome
stops background tabs from loading more. It stops early when there is no
next page or a scroll brings nothing new. Put the
criterion the way you would say it to a person, and double-check number
thresholds yourself (see the recipe above).

### bx pick and bx check — one decision each

```bash
bx pick "the main search box"      # → ref + the durable selector, 93% confident
bx check "am I logged in"          # → yes/no with a probability
```

`pick` is the fast way out of a selector you cannot guess: it reads the live
element list and returns something you can act on immediately. `check` answers
a yes/no about the page in one round trip — far cheaper than a screenshot when
all you need is whether the save went through.

### Many pages at once

`bx check` and `bx read` both accept any number of URLs, or `--file` with one
per line:

```bash
bx check "the group lets members post anonymously" https://facebook.com/groups/a/ https://facebook.com/groups/b/ ...
bx check "the company still replies to reviews" --file urls.txt --parallel 6
bx read https://facebook.com/groups/a/ https://facebook.com/groups/b/ --max 1500   # text of each, for values
```
```
yes  100%  Investors Group Pakistan | Facebook                  tab 7.9s
no   100%  Investment Opportunities in Pakistan for Salaried…   tab 7.2s
8 of 10 yes · 10 pages in 15.3s · 6 at a time
```

Pages print as they finish. After 75s (`--budget N` to change it, `--budget 0`
for none) no new pages are started, and the last line says how many are left.
Run the same command again to continue. Everything done so far is in the
journal it names (`--out file.jsonl` to choose it, `--fresh` to start over).

Every page is loaded at the same time in its own background tab, which is
closed afterwards. Your tab and the user's tabs are never touched. For each
site, bx first tries fetching the HTML from inside a tab that is already on
that site, so the request carries the real session. When the server sends
real text, that answer comes back in about 2s with no tab at all (`fetch` in
the output). Sites that build the page in JavaScript, like Facebook, send an
empty shell, so bx remembers the site and renders pages in tabs instead
(`tab`). `--no-fetch` skips the fetch, and `--parallel N` sets how many pages
load at once (default 6, max 12; past about 6, Chrome itself is the limit).

### jev can see the page

Every jev command reads the page text first. When that is not enough to be
sure, bx takes a screenshot and asks again with the picture attached:

- `bx check` and `bx pick` retry with a screenshot when the text answer falls
  below the confidence floor.
- `bx agent` does the same before it would hand a step back to you as `unsure`.
- `bx sift` stays on text, because a list is text.

`--see` sends a screenshot every time, and `--no-see` never sends one. A
screenshot adds about 2.5s to a call, still well under one of your turns, so
`bx check "is the modal closed" --see` beats taking a `bx shot` and reading it
yourself. Output marked 👁 means jev looked. The machine-wide default is
`bx jev set see=auto` (the default), `see=always` or `see=off`.

## jev on and off

jev is on by default and needs a key once:

```bash
bx jev key sk-codiv-...      # or set CODIV_API_KEY
bx jev                       # model, key, confidence floor, what it has cost
bx jev off                   # agent then runs on word-matching alone
```

`bx agent --no-jev` runs the identical loop with a local word-overlap brain:
no network, no key, and noticeably worse — it wanders and gets stuck where jev
finishes in four steps. It is there so the difference is measurable, and so
the agent still does something when the key is missing. `pick` and `check`
need jev and say so plainly if it is off. `sift` does too; `items` never does.

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
  ▸ memory fiverr.com
    url     /search/gigs?ref=seller_location%3APK ("Apply")
    works   text=Seller details · text=Apply · text=Pakistan
    note    Seller country: ref=seller_location%3APK (ISO code); country=Pakistan does nothing.
```

Act on it before you probe. `url` is a filter, sort or search that a past
click turned into a URL parameter: put it straight into `bx open` and skip
the dropdowns. `works` is a selector that resolved here for real; `avoid`
already cost someone the full 8s timeout. A `recipe` is the whole flow in one
command.

**Save what you solved, in one line.** bx records `url` parameters and
working selectors by itself, so do not note those. The moment you work out
something bx cannot see, like a trap, a hidden rule, a field the site does not
publish, or the page that actually has the data, save it as a single line:

```bash
bx note "Orders are not public; the (N) on cards is reviews."
bx note "Search needs login; logged out it shows 10 results and stops."
```

Notes over 160 characters are refused. Every note is printed on every future
visit, so write the one fact, not the story. Save it when you solve it, not
at the end of the task.

```bash
bx memo [host]              # ask directly — everything known about a site
bx memo --all               # every site bx has driven
bx recipe search 'q=…'      # replay a stored flow
bx learn <name>             # name the flow you just ran, so it is one command next time
bx note "<one line>"        # a fact a selector or URL cannot express, ≤160 chars
bx forget <what> [host]     # all | notes | traces | traps | selectors | recipe <name>
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

The agent and jev are the same one endpoint each:

```bash
curl -s localhost:8787/agent -H "x-bx-token: $(bx token)" \
  -d '{"goal":"open the pricing page","maxSteps":6}'          # add "stream":true for NDJSON
curl -s localhost:8787/jev/pick  -d '{"want":"the login button"}'  -H "x-bx-token: $(bx token)"
curl -s localhost:8787/jev/check -d '{"question":"is there a cookie banner"}' -H "x-bx-token: $(bx token)"
curl -s localhost:8787/jev/sift  -d '{"criterion":"public groups over 1k members","all":true}' -H "x-bx-token: $(bx token)"
```

`/jev/ask` is the raw passthrough: send your own `questions` (`noul`, `choice`,
`score`) and, with `"page":true`, the current page arrives as the state.
