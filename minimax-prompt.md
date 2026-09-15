# Task: post 5 Onlano jobs to the Onlano LinkedIn page

Post 5 jobs from onlano.com to the **Onlano company page** on LinkedIn, in the page's existing format. **No India-based jobs.** Each job = one post + one first comment by Onlano.

You are already logged into LinkedIn and have posted to this page ~180 times. Do not verify the session. Do not read `bx memo` history looking for a recipe — there is no job-post recipe stored, only applicant-reply traces. Everything you need is in this prompt.

Work in batches (`bx do '[...]'`). Target: done in ~15 tool calls, not 60.

---

## 0. Once, before anything

```bash
bx reload-ext          # targeting fixes below need the extension restarted
```

## 1. Get the jobs (2 calls)

```bash
bx open onlano.com/jobs
bx read
```

Pick the **first 5 non-India jobs** off page 1. If page 1 has fewer than 5, use `bx scroll bottom` once and re-read.

- **Do not** try `?countries[]=` URL params — they are ignored.
- **Do not** open the Filters UI — the country control is a single-`<select>`, so it cannot exclude one country. Filtering is a dead end; just skip India rows by eye.
- The **category** (WordPress, Laravel, …) is a **badge on the listing card, next to the title**. Take it from there. Do **not** go looking in JSON-LD or `og:description` for it.

For each of the 5, open `onlano.com/jobs/<slug>` and `bx read` to collect: title · company · city/region/country · onsite|remote|hybrid · full-time|part-time|contract · seniority · salary · first ~400 chars of the role overview. Batch these five reads in one `bx do`.

## 2. Skip anything already posted

```bash
bx open linkedin.com/company/onlano/admin/page-posts/published/
bx read
```

One read, to check which of your 5 are already up. **"Web Developer with Security Clearance — Ardent Principles" was posted yesterday** — if it is still there, skip it and take the next non-India job instead. Note whether it is missing its first comment; if so, add just the comment (step 4).

## 3. Post body — use this format exactly

```
🚀 WE ARE HIRING: <Job Title> at <Company Name>

We are looking for a talented <Job Title> to join the team at <Company Name>. If you are looking for your next challenge and want to make a real impact, this is for you!

📍 Role Overview
📍 Location: <City, Region, Country>
💼 Arrangement: <Onsite|Remote|Hybrid> – <Full-time|Part-time|Contract> (<Mid level 2-4 years>)
💰 Compensation: <USD 84,621 / year>
📝 About the Role
<first ~400 chars of the role overview>
```

This is already confirmed to match the live posts. **Do not** go re-derive the format from existing posts, and **do not** open `~/Desktop/onlano job portal/linkedin-poster/` — that is a FastAPI daemon, it is infrastructure, it does not contain the template.

Flow per job:

```bash
bx click "text=Start a post"
bx type ".ql-editor" "<body>"
bx shot                      # confirm before publishing
bx click "text=Post"
```

## 4. First comment — the part that broke last time

```
https://onlano.com/jobs/<slug>
<Job Title> at <Company>
<Category> role · <Salary>
```

```bash
bx click "text=Comment"                                  # opens the composer
bx type '.ql-editor[data-placeholder="Comment as Onlano…"]' "<comment>"
bx shot                                                  # verify all 3 lines landed
bx click button --has Comment --near '.ql-editor[data-placeholder="Comment as Onlano…"]'
```

**Why that last line matters.** The page has ~6 buttons reading "Comment" — one per post, one per composer, one per loaded comment. A bare `bx click "text=Comment"` resolves all of them and clicks the first in document order, which is the *post-action* button — it just re-opens the composer, and the click still reports `ok`. `--near` anchors the pick to the composer you just typed into.

Rules for this step:

- **Do not** use `bx eval` with `querySelectorAll('button').filter(b => !b.disabled)` — LinkedIn marks dead buttons with `aria-disabled`, not `.disabled`, so that filter picks the wrong button and reports `"clicked"` while nothing happens. This is exactly what failed last time.
- **Do not** use `button:has-text(Comment)` — that is Playwright syntax, not CSS, and it throws.
- If a result line says **`· N matched`**, the click was ambiguous and may have hit the wrong element. It also prints the alternates as refs (`also e2 …`) — click the right one directly with `bx click ref=e2`.
- If typing the comment submits it early (Enter posting instead of newlining), retype it line by line with `bx press 'shift+Enter'` between lines.

Confirm each comment with `bx shot` — a closed composer with the comment visible below the post. An open composer means it did not submit.

---

## Done when

5 posts live on the Onlano page, each with the Onlano first comment attached, none of them India-based. Reply with the 5 titles and their post URLs.
