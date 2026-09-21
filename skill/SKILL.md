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
| "do X to each of them" (reply, accept, message, fill) | an action per item | `bx each` — one command for the whole list, see below |
| "post / apply / submit on each of these pages" | the same flow on page after page | do it by hand on two pages; bx saves it; then `bx recipe <name> <url> 'text=…'` per page |

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

### bx each — the same action on every item of a list

For "reply to every unread message", "accept each invite": one command walks
the list, opens each row, checks it and acts. `{{name}}`, `{{first}}`,
`{{text}}` and `{{href}}` fill in from the row.

```bash
bx each --without "Admin (You):"                     # list only, opens nothing, ~1s
bx each --without "Admin (You):" --check "we have not replied yet in the open conversation" \
  --do '[{"a":"type","target":"…","text":"Hi {{first}}, …"},{"a":"click","target":"text=Send"}]' --dry
```

Use `--with`/`--without` for literal text rules and `--if` only for
judgement. Run `--dry` first when `--do` sends anything. Running the same
command again continues where it stopped. Details: REFERENCE.md.

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

### bx agent — the whole loop

`bx agent "<goal>"` reads the page, has jev pick the element that advances
the goal, acts, and repeats. It stops rather than guesses: `unsure` (you
pick, `bx click ref=eN`, then continue), `needs-value` (re-run with `--var
k=v`), `confirm` (irreversible click; re-run with `--yes`), `blocked` (tell
the user). It never invents values: quote them in the goal or pass `--var`.
Flags and details: REFERENCE.md.

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

`bx check "<q>" <url>…` and `bx read <url>…` (or `--file F`) do every page at
once in background tabs. They stop after 75s; if the last line says `N
left`, run the same command again. A page bx could not read answers `??
unknown`, never `no`. Opening a page is a visit (an inbox thread is marked
read). Details: REFERENCE.md.

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

A ref names one element in one render. Apps like LinkedIn and Gmail rebuild
their lists after every action. When that happens bx re-finds the element
by its tag and text and says so (`ref e158 was stale, re-found by its text
as e170`). When it cannot be sure, it fails at once with the text to target
instead (`target it as text=…`). Either way you do not need another
`bx els` between clicks. `text=` targets survive re-renders, so prefer them
for anything you click more than once.

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

## Things that will bite you

- `chrome://` pages, the Chrome Web Store and PDFs cannot be scripted at
  all. bx says so in ~20ms; do not retry.
- `page failed to load (net::…)` means the tab shows Chrome's error page,
  whatever its URL says. If the site refused requests after a burst of
  activity it is rate-limiting you: wait ~30s, then `bx reload`. Reloading
  the extension, opening new tabs or retrying at once does not help.
- A bare `host:port` is treated as `http://` on loopback and `https://`
  elsewhere. Pass a full URL when you need the other one.
- Hidden tabs run at `instant` speed no matter what you ask for — Chrome
  throttles their timers to 1Hz, so a curved mouse path would take 30s.
- `covered` on a click means an overlay intercepted it. Dismiss the banner or
  modal and click again.
- A batch stops at the first failure unless you pass `"stopOnError":false`.

## More

`REFERENCE.md` next to this file has the rest: every action and its
options, the agent's flags, `items`/`sift`, `check --see`, speed and
stealth, targets that match several elements, what to do when something
stalls, and the HTTP API. Read the one section you need.
