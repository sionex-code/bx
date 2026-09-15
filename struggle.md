# Session Struggle: Posting 5 Onlano Jobs to LinkedIn

## Task
Post 5 jobs from onlano.com to the Onlano LinkedIn page in the existing format. Exclude India jobs.

## Where I Got Stuck

### 1. Slow data gathering (most of the time)
- Started by re-confirming LinkedIn session via `bx memo linkedin.com`. **Unnecessary** — I had already posted to this page 181 times before. The memory file already had the working selectors (`.ql-editor`, `text=Send`, `text=Replying as Onlano…`).
- Paged through 181 lines of past selector traces to look for a job-post recipe. There is none in the LinkedIn memory — the past 181 runs were all applicant replies and inbox conversations, not job posts. The memory note even says "real messages live under sidebar Inbox."
- Should have gone straight to Page posts → screenshot → match the format from existing posts.

### 2. Wrong filter approach
- Tried `?countries[]=…` URL params. Ignored.
- Opened the Filters UI, found a single-select `<select>` (not multi-select), so I could not exclude India by filtering. Could not exclude one country.
- Spent time looking at `bx eval` for pagination, then for filter options, then for filter dropdown content. None of it moved the task forward.
- Should have just picked the 3 non-India jobs from page 1 (already visible) and scrolled the page to load more, instead of trying to filter the data.

### 3. Wrong directory for "blueprint"
- User hinted "you may have blue print saved somewhere." I jumped to `/home/yaser/Desktop/onlano job portal/linkedin-poster/` and read ~200 lines of FastAPI README looking for the post template. **Wrong layer** — that blueprint is for an automated poster daemon, not the format itself.
- The actual format blueprint is on the **published LinkedIn page itself** (Page posts → existing Onlano posts). Reading those 3 existing posts gave me everything: emoji header, "We are looking for a talented X to join the team at Y. If you are looking for your next challenge…" pitch, the 4 detail lines (📍 Role Overview / 📍 Location / 💼 Arrangement / 💰 Compensation / 📝 About the Role), and the first-comment block with `onlano.com/jobs/<slug>` + `<Title> at <Company>` + `<Category> role · <Salary>`.
- Cost: ~5 min reading the FastAPI README. User got frustrated and asked what I was doing.

### 4. og:description tag discovery (wasted time)
- Tried to read `description` from JSON-LD → got only the generic "Onlano is a fast job portal…" meta description. The real category was in `og:description` (`"WordPress role - USD 84,621 - 84,621 / year"`). Had to grep through meta tags to find it.
- Should have just looked at the **category badge** on the job listing card (visible in the first onlano.com/jobs read) — it sits right next to the job title as a small tag like `[WordPress]` or `[Laravel]`.

### 5. Comment button click failure (current blocker)
- Typed the comment into the `.ql-editor[data-placeholder="Comment as Onlano…"]` field correctly.
- Tried `bx click text=Comment` and `bx click button:has-text(Comment)` — both missed because there are ~6 "Comment" buttons on the admin posts page (one per post + one on each comment composer + one on each loaded comment), and `text=` is an exact-match fallback that picks the wrong one (it picks the post-action button, not the in-composer submit button).
- Workaround that worked: `bx eval` to grab `Array.from(document.querySelectorAll("button")).filter(b => b.innerText.trim()==="Comment" && !b.disabled)[0].click()`. The button IS the right one (in the composer, the only one that's not disabled once text is in the field), but bx's `text=` targeter doesn't pick the innermost enabled one reliably when several buttons share the text.
- The "Comment" click via `bx eval` returned `"clicked"`, but the post screenshot still shows the composer open. The click probably hit a different enabled Comment button (one of the post-action buttons, which would just re-open the comment composer). Need to retarget by location or by checking the disabled state in the same query.

## What the Format Actually Is (final reference)

**Main post body:**
```
🚀 WE ARE HIRING: <Job Title> at <Company Name>

We are looking for a talented <Job Title> to join the team at <Company Name>. If you are looking for your next challenge and want to make a real impact, this is for you!

📍 Role Overview
📍 Location: <City, Region, Country>
💼 Arrangement: <Onsite|Remote|Hybrid> – <Full-time|Part-time|Contract> (<Mid level 2-4 years>)
💰 Compensation: <USD X / year>
📝 About the Role
<First ~400 chars of role overview>
```

**First comment by Onlano (Author):**
```
https://onlano.com/jobs/<slug>
<Job Title> at <Company>
<Category> role · <Salary>
```

## The 5 Non-India Jobs I Picked

1. Web Developer with Security Clearance — Ardent Principles, Inc. — Pimmit, Fairfax County, US — WordPress — USD 84,621 / year — slug `web-developer-with-security-clearance-mtv4xuup` ✅ posted (post successful, comment stuck in composer)
2. Full Stack Developer — Stride Learning — US — WordPress — USD 66,379 - 105,000 / year — slug `full-stack-developer-mtv4x5r9`
3. PHP Developer - Laravel — Spectrum IT Recruitment Limited — Brighton, East Sussex, UK — Laravel — GBP 50,000 / year — slug `php-developer-laravel-mtv3bf7h`
4. Développeur Back Laravel F/H — AquisIT — Strasbourg, Strasbourg-Ville, France — Laravel — EUR 40,000 - 50,000 / year — slug `d-veloppeur-back-laravel-f-h-mtv2pnhg`
5. Senior Software Development Engineer — University System of Maryland Office — Adelphi, Prince George's County, US — WordPress — USD 145,000 - 160,000 / year — slug `senior-software-development-engineer-mtuleguh`

## Lessons (for next time)

1. **Format blueprint is on the destination page, not in source code.** The existing LinkedIn posts ARE the template. Screenshot first, read the existing posts, then post.
2. **Don't read FastAPI README / source code for content templates.** It's infrastructure.
3. **`bx memo` for the destination site is enough.** The 181-run history on linkedin.com already showed the working composer selectors.
4. **When `bx click text=X` fails with multiple matches, use `bx eval` to filter by `disabled` state or by location.** The button with the right text in the right place is usually the one that is currently actionable.
5. **Onlano category badges are on the listing card next to the title**, not in JSON-LD `description`. Read the listing card, not the head/meta tags.
6. **Stop after one confirmation round** when the user says "blue print saved somewhere." The user means: you already did this, just go. Don't go fishing.