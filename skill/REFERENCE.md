# bx reference

The details behind SKILL.md. Read the section you need, not the whole file.

### bx each — the same action on every item of a list

"Reply to every unread message", "accept each pending invite", "fill this
form for every row": by hand that is open, look, decide, type, send, about
five of your turns per item. The LinkedIn inbox run spent seven minutes on
nine conversations that way. `bx each` does it in one command, a few
seconds per item:

```bash
# get the list on screen first (a filter, a search), then:
bx each --without "Admin (You):" \
  --check "we have not replied yet in the open conversation" \
  --do '[{"a":"type","target":"text=Write a message…","text":"Hi {{first}}, thanks for reaching out! Please follow our page for new openings.","speed":"instant"},
         {"a":"click","target":"text=Send"}]' --dry
```
```
would Amir Khan                                   check yes (99%)  3.3s
skip  Vijay Dhangar                               check said no (96%)  5.3s
```

It reads the page's list, then for each row:

1. **`--with TEXT` / `--without TEXT`** keep or drop rows by exact text in
   the row, and **`--if "<criterion>"`** judges the row's text with jev, all
   rows at once like `sift`. Rows that fail are passed over without being
   opened. **When the rule is literal text, use `--with`/`--without`, not
   `--if`.** Asked "is the newest message from them, not Admin (You)" on a
   real LinkedIn inbox, jev got 5 of 20 rows wrong and changed its mind
   between runs. `--without "Admin (You):"` got all 20 right. Keep `--if`
   for judgement ("a job applicant, not a sales pitch").
2. It **opens the row**, by clicking it in place.
3. **`--check "<question>"`** is asked about the opened row, with the list
   itself hidden from jev so other rows cannot answer for it. A `no` or an
   unknown answer skips the row.
4. **`--do '<batch>'`** runs with the row's values filled in: `{{name}}` (the
   row's leading text, e.g. the person), `{{first}}` (first word of it,
   de-capitalised if it was in all caps), `{{text}}`, `{{href}}`.

The list is re-read before every row, because apps re-sort it as you act,
and rows are tracked by their link, so none is done twice or skipped.

- With only `--with`/`--without`/`--if`, nothing is opened: it lists the
  matching rows in about a second. That is the safe first look.
- **Run it with `--dry` first** when `--do` sends, posts or deletes. `--dry`
  opens and checks every row but does not run `--do`. Opening can still mark
  a message as read.
- Pass the list's CSS as the first argument when bx picks the wrong list:
  `bx each "ul.conversations" …`.
- Keep `--check` short and plain. "We have not replied yet in the open
  conversation" works better than a sentence with two conditions.
- It stops at the first failed `--do` (`--keepgoing` to carry on), after
  `--max` rows (default 20), and after `--budget` seconds (default 90).
  Everything is journalled, so **running the exact same command again
  continues** where it stopped. Finished and skipped rows are not touched
  again. `--fresh` starts over.
- The message is a template. When each row needs its own wording, use
  `--dry` to list the rows that need it, then write those by hand.

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

A page bx could not actually read, such as a login wall, an error page, a
loading shell or raw data, answers **`??` unknown**, not `no`. Treat unknown
as "go and look", never as a no.

Opening a page counts as a visit, and some sites act on that. An inbox
thread opened this way is marked read, and fifty quick hits on one site can
get you rate-limited for a while. For items you have to open in an app,
`bx each` is usually the right tool anyway.

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
