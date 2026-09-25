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

**Many lists in one command.** Give `sift` the result URLs themselves and it
opens each, pages it, judges it and pools the keepers, a group found by two
searches counted once:

```bash
bx sift "<criterion>" "<search url 1>" "<search url 2>" … --pages 3 --save keep.txt
bx sift "<criterion>" --file searches.txt --save keep.txt
```

The lists load 6 at once in background tabs (`--parallel N`, up to 8), jev
judging each page as it arrives. A background tab reads pages and follows
"next" fine but loads no more of an infinite feed, so a feed that needs more
pages is moved to the front tab by itself and finished there.
`--parallel 1` runs them one after another in bx's tab. The call stops starting new lists after `--budget` seconds
(default 100) and names the ones left.

**Recent lists are reused.** A list `items` or `sift` opened by URL is kept
for 10 minutes, keyed by URL, `--pages`, target and `--chars`. Running either
command on the same URLs again judges or ranks the kept rows at once instead
of reloading and scrolling (`cached 40s ago` in the output), which also spares
the site repeat searches. `--fresh` reloads. The cache lives in the bridge and
is gone when it restarts.

**`--sort WORD`** (items and sift) ranks rows by the number in front of WORD:
`574.4K members`, `1,203 reviews`, `2.1M followers`. Rows with no such number
go last. With `--sort`, `--max N` means "show N" (`--top N` too).

**`--save FILE`** appends links to a file, one per line, never twice: the
kept rows for `sift`, every row for `items`, the pages answered yes for a
many-URL `check` (this call's and earlier ones'). Each prints the next
command to run on that file, so a whole research job chains
`sift --save keep.txt` → `check --file keep.txt --save yes.txt` →
`read --file yes.txt` without a script in between.

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
load at once (default 6, max 16; past about 6, Chrome itself is usually the limit).

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

jev is on by default and needs a key once. TypeSafe keys (`apikey_…`,
console.typesafe.ai/keys) read text only and were faster and more accurate;
codiv keys (`sk-codiv-…`, codiv.ai/dashboard) also read screenshots. Add any
number of either. Calls take turns across a service's keys and skip one that
is rate-limited, out of credit or refused.

```bash
bx jev key                   # asks for the key, hidden; or: … | bx jev key -   (--label NAME)
bx jev                       # where text and screenshots go, every key and its status
bx jev keys                  # just the keys
bx jev rm <label|id>         # remove one
bx jev use auto              # text → TypeSafe, screenshots → codiv, each falling back (default)
bx jev use typesafe|codiv    # one service only (screenshots always need codiv)
bx jev off                   # agent then runs on word-matching alone
```

Keys live in the bridge (`~/.bx/config.json`, 0600) and are shared by every
browser connected to it; the bx toolbar popup manages the same list. Never ask
the user to paste a key into the chat: point them to `bx jev key` or the popup.
With no codiv key, `--see` and the automatic screenshot retry are skipped and
jev answers from the text.

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
so jev does. Before the first acting step of a command runs, bx lists every
live match, each with the text of the post or row it sits in and whether it
shares a box with text typed but not sent, and jev picks the one meant (about
a second, only when there is a tie to break):

```
ok click        44ms  @ 812,640 → "Comment"  · jev chose 1 of 6  92%
```

That is the send button next to your unsent comment, not the first "Comment"
on the page. The pick is carried to later steps aimed at the same target
(`type --send`). For typing, jev must be 80% sure — text in the wrong box
lands under someone else's post — or bx refuses as before and says which box
jev leaned to. When jev is unsure about a click, the old rule applies and the
result says so:

```
ok click        41ms  @ 132,107  · 7 matched, jev unsure  48% — took the first
  also e2    #post1 > div:nth-of-type(2) > button
```

**Treat `jev unsure` and `N matched` as warnings**: click the ref it handed
you, or narrow the target with `has` / `near` / `--in`. Do not reach for `eval`
to hand-roll a `querySelectorAll(...).filter(...)` — filtering on `.disabled`
alone misses `aria-disabled` and picks the wrong button.

A target that matches nothing comes back with jev's closest match, which is
never clicked for you:

```
✗ click       8012ms  not found: text=Post
  ▸ jev closest match on the page: e41 button "Post comment"  91%  → bx click ref=e41
```

`ref=` and `nth` targets are taken as meant and skip all of this; `--no-jev`
turns it off for one command.

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

0. A page in bx's window that never loads its feed, or `bx info` saying
   `"visible": "hidden"`: the user minimized bx's window, and Chrome pauses
   pages there. Ask them to restore it; it can sit behind their windows.
1. `bx status` — one line tells you which half is unhappy. If it warns that
   the connected Chrome profile has no window open, stop: bx is answering
   from an idle profile, and the profile the user browses in has a bx that is
   not connected. Tell the user to reload bx at chrome://extensions in the
   profile they use. Retrying will not change which profile answers.
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

# Moved from SKILL.md

These sections used to be in SKILL.md. They are here in full; SKILL.md keeps the short version.

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


### The same flow on page after page

Posting in six groups, applying to five jobs, filling the same form on
several sites: the flow is identical and only the page and the text change.
Done by hand it is about twelve commands per page. A LinkedIn run spent 11
minutes posting in six groups that way.

Do it by hand on the first two pages. When the second one finishes, bx
compares the two and saves the steps they had in common as a recipe. It
leaves out steps only one page needed, like a popup, and treats buttons that
name the page ("Join US Stock Market…" and "Join Investment Hub…") as the
same button:

```
  ▸ saved  you did the same flow on two pages, so bx kept it as recipe auto-groups
    nav linkedin.com/groups/12274630 → click "Join" → click text=Start a public post → … → click text=Post
    every next page, one command: bx recipe auto-groups <url> 'text=…'
```

From then on each page is one command, under a second of browser time:

```bash
bx recipe auto-groups https://www.linkedin.com/groups/44059/ 'text=What is one investing idea you wish you had learned earlier?'
```

If a page differs (an extra welcome dialog, a join that needs approval), the
recipe stops at the step that failed and says which one. Handle that page by
hand and carry on with the recipe for the next.

Write each page's text yourself when it should differ. Passing a different
`text=` per page is the only thing the recipe needs from you.

**Some things a page cannot tell you before you act.** Whether a group lets
you join without approval only shows after you click Join ("request sent").
Do not spend `bx check` calls asking; click, and move on if it was a request.

**If the user asks how long it took, do not estimate.** Run `date` when you
start and when you finish, and report the difference.


### Link routes (wiki-walks, "how does A connect to B")

Finding a path of links between two pages is a search, not a puzzle to
solve in your head. One run spent 2½ minutes guessing bridges from memory
(Alan Walker → Faded → Sony Music → T-Series …), opened 11 pages, and never
arrived. Two reads found Alan Walker → Vishal Mishra → Atif Aslam in ~10s:

```bash
bx read --mode links --max 5000 "https://en.wikipedia.org/wiki/Alan_Walker" > out.txt   # every link on A
bx read --mode links --max 5000 "https://en.wikipedia.org/wiki/Special:WhatLinksHere/Atif_Aslam?limit=5000" > in.txt   # every page linking to B
# article names in both lists = a 2-hop route (A → X → B)
```

Extract the article names with a short script: keep the `/wiki/Name` part,
drop names containing `:` (Special:, File:, Help:…) and `Main_Page`. Then
intersect the two lists.

- No overlap: take A's out-links, then run
  `bx check "does this page link to <B>?" <url> <url> …` on them all at once.
  A yes gives you A → X → Y → B. Never open them one by one.
- `--mode links` stops at 300 links unless you pass `--max`. On Wikipedia,
  always pass `--max 5000`.
- `bx read --mode links --max 5000 <url> <url> …` lists the links of many
  pages at once, one level deeper in a single command.
- `bx read` (markdown) starts at the top of the page, which on Wikipedia
  means menus. Scrolling does not change that. Use `--mode links` to see
  what a page links to, not `read` + `eval`.

#### A live race (click in real time, no background reads)

When the user wants to watch the browser click through, walk it yourself.
You choose each hop. jev is poor at "which link is closer to B": asked
for that, `bx pick` returns `found nothing matching` or picks a citation
like `[8]`, and `bx agent` goes India → Maldives → Asia. Each hop is two
commands, about 3s in total:

```bash
bx read --mode links --max 5000 | grep -iE "pakistan|punjab|gujrat"   # what this page offers
bx click 'a[href$="/Punjab,_Pakistan"]'                               # exact link, found even if offscreen
```

- Plan the route from what you know (A → country → region → B), and grep
  each page for the next step's words. Don't scroll + `els | grep` to find
  links: `els` only lists what is near the screen, and `bx els "<a|b>"`
  takes CSS, not text.
- Click by the link's address, not `text=`. `text=India` matches "Warner
  Music India", and `text=Mumbai` hit the city's coat of arms and opened
  the image viewer.
- Wikipedia link text and the target differ. On Punjab, Pakistan, "Gujrat"
  goes to `/Gujrat_Division`, and "Gujarat" is the Indian state. Take the
  `href` from the grep line, and confirm the end page with
  `bx check "is this about <B>"`.
- Never type into the search box or click the logo in a race. `bx agent`
  with "link by link" or "no search" in the goal is limited to article
  links for the same reason.


### Rule 1 — batch everything

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

### Rule 2 — never wait manually

Every element action auto-waits for its target (default 8s). Do not insert
`wait` before a `click`. Only use `wait` for things that are not a target:
`{"a":"wait","for":"text=Done"}`, `{"a":"wait","gone":".spinner"}`,
`{"a":"wait","text":"Payment received"}`, `{"a":"wait","ms":400}`.

A miss costs the full 8s, so when you are probing rather than acting — checking
whether a banner is up, whether login already happened — pass a short timeout
and read the answer: `{"a":"exists","target":".cookie-banner","timeout":300}`.
`exists` never fails; it returns `{"exists":false}`.

### Rule 3 — orient with `els`, not screenshots

`bx els` returns a compact list of every visible interactive element with a
stable `ref`. It is far cheaper than an image and directly actionable.

```
e3    button   Sign in                       412,318
e4    input    Email address                 412,240
```

Then `bx click ref=e3`. Take a screenshot only when the *look* matters,
or when `els` and `read` leave you genuinely unsure what is on screen.

A ref names one element in one render. Apps like LinkedIn and Gmail rebuild
their lists after every action. When that happens bx re-finds the element
by its tag and text and says so (`ref e158 was stale, re-found by its text
as e170`). When it cannot be sure, it fails at once with the text to target
instead (`target it as text=…`). Either way you do not need another
`bx els` between clicks. `text=` targets survive re-renders, so prefer them
for anything you click more than once.


### Rule 4 — bx remembers each site; read what it hands you

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

bx saves a flow you repeat on two pages of the same kind by itself (see "The
same flow on page after page"). Everything else is up to you.

**Do this:** the moment a flow that took real work finally succeeds — a login,
a multi-step form, a search that needed the right field — run `bx learn <name>`.
That is the whole point: struggle once, then never again.

If you drove the flow one command at a time, no single batch holds it. `bx
learn` then prints your recent actions, numbered from the newest. Run `bx
learn <name> --last N` to keep the last N of them. Steps you took through a
`ref=` are stored under the durable selector they actually hit, so the
recipe still works after the page re-renders.

A recipe that has failed every run is marked `broken` in the memory block,
and `bx recipe` refuses to replay it (`--force` overrides). Redo the flow and
`bx learn` it again under the same name.

Acting through `ref=e12` still teaches it something. Every element action
reports the durable selector it actually landed on (`sel` in the result), and
that is what gets stored — refs are per-snapshot and never remembered.

Typed text is never written to disk. A stored flow keeps the shape and leaves a
named hole where the value went, so `bx recipe login 'user=me' 'password=…'`
supplies them at replay time. Memory lives in `~/.bx/memory/<host>.json`.

## Several browsers

bx loaded in Chrome, Brave, Edge or several profiles connects from each, all
to one bridge.

```bash
bx browsers                  # numbered: 1 Brave, 2 Chrome …   * = where commands go
bx use 2                     # from now on (also: bx use brave, bx use <profile id>)
bx use auto                  # the browser with a window, used most recently (the default)
bx open x.com --browser 1    # one command only; works on every command
bx browsers name 2 work      # a name for a profile: bx use work
```

Every request made by one command, including background reads and jev's page
looks, goes to the same browser. A chosen browser that is not connected right
now falls back to auto rather than failing. Over HTTP, send the header
`x-bx-browser: <n|name>` or `"browser"` in a `/do` body. The toolbar popup
shows a picker once two are connected.
