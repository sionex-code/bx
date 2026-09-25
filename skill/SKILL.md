---
name: bx
description: Drive the user's real, logged-in browser (Chrome, Brave, Edge — any that has bx loaded) from the shell — open pages, click, type, fill forms, upload files, scroll, screenshot, read pages, list a page's links. Use it for real tasks on real sites: posting or commenting in LinkedIn/Facebook groups, researching many groups or a YouTube niche, filling and submitting forms, collecting results to CSV, walking links between pages. It is fast because jev, a small fast model, makes the small decisions (~1s each) so you only plan and write — `bx sift` filters whole result lists (many searches in one command), `bx check` answers yes/no about many pages at once, `bx read <urls>` reads many pages in parallel, `bx each` repeats an action over a list, `bx agent` clicks through a known flow. Prefer these over opening, reading and screenshotting pages one by one. jev cannot plan a multi-step route; you plan it and bx clicks. Trigger: /bx, "use the browser", "in Chrome", "in Brave", "fill this form", "upload to", "screenshot the page", "find X on <site>", "post in the group", "research these groups".
---

# bx — browser control

## How to work (read this first, every model)

1. **Pick the command from the table below, run it, read its output, move
   on.** Do not deliberate between steps. Do not plan in prose. One command
   per line, and batch aggressively.
2. **The output tells you the next step.** Lines starting `▸` say what to
   run next (`next: bx check … --file keep.txt`), what was saved, what bx
   already knows about the site. Follow them.
3. **jev decides, you don't.** Every "which of these", "is this one X",
   "did it work" is a jev call of ~1s. Your own turn costs 5–30s. If you are
   about to read a page and reason about it, there is a command for that.
4. **Never** take a screenshot to see what a click did, **never** `sleep`,
   **never** dig through the DOM with `bx eval`. `bx click` reports what
   changed, every read waits for the page by itself, `bx items`/`bx check`
   answer questions about the page.
5. **Many things → one command.** About to run the same command a third
   time with a different URL? Stop: `sift`, `check`, `read`, `each` and
   `recipe` take the whole list.
6. **Solved before?** `bx memo --find "<words>"` searches everything bx
   remembers on every site before you work something out again.

If `bx sift`, `check`, `pick` or `agent` say "no jev key", tell the user to
get one (TypeSafe at https://console.typesafe.ai/keys, or codiv at
https://codiv.ai/dashboard) and add it with `bx jev key` or in the bx toolbar
popup. Never ask for the key in the chat, and never `cat ~/.bx/config.json`.

## The table

| you are about to… | run this | cost |
|---|---|---|
| go through a result list and keep what fits | `bx sift "<criterion>" --pages 5` | ~1–2s a page |
| do that for several searches | `bx sift "<criterion>" "<url1>" "<url2>" … --pages 3 --save keep.txt` | one command |
| ask the same yes/no about many pages | `bx check "<question>" --file keep.txt --save yes.txt` | ~15s for 10, in parallel |
| get values (members, price, contact) off many pages | `bx read --file yes.txt --max 1500` | ~7s for 4, in parallel |
| read a list's rows with their links, no judging | `bx items --pages 5 --save links.txt` | no model |
| find the biggest / most-X (members, reviews, followers) | `bx items "<search url 1>" "<search url 2>" --pages 3 --sort members` — ranked, biggest first; answer from the top row | one command, no model |
| click/type your way to a page or state | `bx agent "<goal>"` | ~2s a step |
| find which element is "the X" | `bx pick "the X"` | ~1s |
| confirm something (did it save, am I logged in) | `bx check "<question>"` | ~1s |
| how the page looks | `bx check "<question>" --see` | ~3s |
| do X to every row (reply, accept, message) | `bx each --if … --check … --do '[…]'` | one command |
| the same flow on page after page | do it twice by hand, then `bx recipe <name> <url> 'text=…'` | <1s a page |
| comment on posts in a feed | `bx items --chars 2000`, then `bx click text=Comment --in ref=eN` + `bx type … --in ref=eN --send` | 2 commands a post |

## Big jobs (50+ results): three commands

"Find 200 Facebook groups that are X, with details, as a CSV":

```bash
# 1. every search phrase in ONE command; kept links go into keep.txt
bx sift "a group for Pakistani retail investors, not signals, betting or spam" \
  "https://www.facebook.com/groups/search/groups/?q=stock%20market%20pakistan" \
  "https://www.facebook.com/groups/search/groups/?q=psx%20investors" --pages 5 --save keep.txt
# 2. what the list cannot show: every kept page at once; yes-pages into yes.txt
bx check "the group is active and not full of spam posts" --file keep.txt --save yes.txt
# 3. the values: read only those
bx read --file yes.txt --max 2000 > about.txt
```

- **Filter before you read.** Judging a list costs ~1.5s a page of 40;
  reading one Facebook page costs 5–14s.
- `sift` and `items` over many URLs read 6 lists at once in background tabs;
  feeds that need scrolling are finished in the front tab by themselves. No
  `--parallel` flag needed.
- **`read` and `check` with many URLs stop by themselves after 75s.** If the
  last line says `N left`, **run the exact same command again**: finished
  pages are skipped. Never split the list, loop over it in the shell, or add
  `2>/dev/null` (that hides the `left` line).
- Every page's result is in the journal named on the last line
  (`~/.bx/runs/*.jsonl`, one JSON object per line). Build CSVs from that
  file, not from terminal text. Look at one page's text once
  (`bx read <url> --max 3000`) before writing a parser.
- Put the user's judgement words ("not spam", "Pakistani", "beginners") into
  the criterion. Never rebuild them as keyword lists in Python.
- sift is sound on judgement calls and ~90% right on number thresholds
  ("rated 3.8+"): read numbers off the kept rows yourself, and put coarse
  number filters in the URL where the site has one.
- **Search results are personalised** to the user's country and history.
  For "overall" / "worldwide", pass several broad queries in one command
  (`?q=crypto`, `?q=bitcoin`, `?q=cryptocurrency`) with `--pages 3`, rather
  than trusting page 1 of one search.
- A value you already have in a list row is the answer. Don't open the page
  to confirm it.
- Lists opened by URL are remembered for 10 minutes: asking again (another
  criterion, `--sort`, a follow-up) answers in about a second
  (`cached 40s ago`). `--fresh` reloads them.
- **Use URLs for filters.** Set a filter by clicking once, `bx info` prints
  the URL it made; from then on edit the URL. Never click through filter UI
  twice.
- Report what the page says under the page's own label. A field the site
  does not show is "not available", never a nearby number renamed.

## Driving one page

```bash
bx open example.com
bx click "text=Sign in"          # prints where the page went and what appeared, with refs
bx type "#email" you@x.com --enter
bx fill "#user=me" "#pass=secret"
bx do '[{"a":"click","target":"text=Next"},{"a":"wait","for":"text=Done"}]'   # a whole sequence, one round trip
```

- `bx click` tells you what the click did: the new URL, and every element
  that appeared (a menu's options, a dialog's buttons) with a ref to click
  next. Don't screenshot, don't re-run `bx els`.
- Elements auto-wait for their target (8s). Probing whether something is
  there: `{"a":"exists","target":".banner","timeout":300}`.
- `bx els` lists what can be clicked with refs; `bx click ref=e12`. Prefer
  `text=` targets for anything clicked twice; they survive re-renders.
- Several matches: jev picks the one meant and says `jev chose 1 of 6`.
  `jev unsure` means it took the first: click the ref yourself.

### bx agent — the whole click-through

`bx agent "<goal>"` reads the page, has jev pick the move, acts, repeats.
Quote exact values in the goal (`search for "Alan Turing"`) or pass
`--var k=v`; it never invents text. It stops rather than guesses:

- `unsure` → it prints the candidates: `bx click ref=eN`, then run the agent
  again with the rest of the goal.
- `needs-value` → re-run with `--var name=value`. `confirm` → the next click
  is irreversible (post, delete, pay): re-run with `--yes` if the user asked
  for it. `blocked` → captcha or login wall: tell the user.
- `--read` also prints the final page. jev cannot plan a route through a
  site it has never seen: you give it the goal one leg at a time.

### Posting and commenting in a feed

A feed has dozens of identical Comment/Like/Post buttons. Never find the
right one with `eval` (one run spent 118 of 138 commands on that):

```bash
bx items --chars 2000 --max 15                  # each post's text, each with a ref (e5, e9 …)
bx click text=Comment --in ref=e5               # that post's comment box
bx type "[contenteditable]" "…" --in ref=e5 --send
```

`--send` presses the box's send button and confirms the text left the box
(`✓ sent`). That is the proof: no sleep, no grep, no `bx check` afterwards.
Text sitting in a box is not posted; bx shows it as `[unsent text in "…"]`
and says `▲ not sent:` when a click did not send it.

### The same flow on many pages

Posting in six groups, applying to five jobs: do it by hand on two pages.
bx notices and prints `▸ saved … recipe auto-groups`. Every page after is
one command: `bx recipe auto-groups <url> 'text=…'`. If a page differs, the
recipe stops at that step; do that page by hand and carry on.

## Browsers

bx can be loaded in several browsers and profiles at once (Chrome, Brave,
Edge…). `bx status` lists them when there is more than one.

```bash
bx browsers                    # numbered list, * = where commands go
bx use 2                       # all commands to browser 2 from now on (or: bx use brave)
bx open x.com --browser brave  # just this command
bx use auto                    # back to "the one last in use"
```

Use the browser the user names ("in Brave", "my work profile"). The user can
also pick it in the bx toolbar popup. Each browser has its own logins.

By default bx works in **its own window** (a "bx" tab group) and never
touches the user's tabs. `--here` acts on the tab the user is looking at;
use it only when they ask. Never minimize or close bx's window.

## Memory

bx remembers every site: working selectors, URL filters, traps, recipes,
notes. It prints a `▸ memory` block when you arrive and when something
fails. Act on it: `url` lines are filters you can put straight into
`bx open`, `works` are selectors that resolved, `avoid` cost someone 8s.

```bash
bx memo --find "post comment"   # search every site's notes and recipes
bx memo [host]                  # everything about one site
bx note "Orders are not public; the (N) on cards is reviews."   # one fact, ≤160 chars, when you solve it
bx learn <name> [--last N]      # name the flow you just did; replay: bx recipe <name>
```

Save a note the moment you work out something bx cannot see (a trap, a
hidden rule, the page that really has the data). Not at the end.

## Targets

| form | example |
|---|---|
| CSS | `#email` · `.btn.primary` |
| visible text | `text=Sign in` |
| ref from `els` | `ref=e12` |
| ARIA role / label / placeholder / name | `role=button:Save` · `label=Password` · `placeholder=Search` · `name=q` |
| narrowed | `bx click button --has Comment --near .ql-editor` · `--nth 2` · `--in ref=e5` |

## Things that will bite you

- Quote every URL: zsh treats `( ) ? *` as globs.
- `chrome://` pages, the Web Store and PDFs cannot be scripted. Don't retry.
- `page failed to load (net::…)` after a burst of requests is rate limiting:
  wait ~30s, then `bx reload`.
- `covered` on a click: an overlay took it. Dismiss it, click again.
- If the user asks how long it took, run `date` at start and end.
- A link to the user's own project comes from `git remote -v`, never a guess.
- Sites built from web components (Reddit) keep buttons in shadow roots:
  `els`, `text=` and CSS see into them. Don't fall back to `eval`.

## More

`REFERENCE.md` next to this file: every action and flag, `bx each` in full,
the agent's options, `items`/`sift`, `check --see`, link routes and
wiki-races, batching rules, memory in full, speed and stealth, what to do
when something stalls, and the HTTP API. Read only the section you need.
