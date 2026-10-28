# BrandUpdate Intent

Bring the principal's public brand surfaces back into line with their current focus. Runs full-sweep by default; scope to named surfaces when asked.

## Ideal State

- Every in-scope surface states the principal's current focus as the source-of-truth files in `Surfaces.md` and the recent flagship posts in the blog feed put it at run time.
- Zero retired project names anywhere in scope; a name that `Surfaces.md` § Surface notes marks as retired (the redirects listed there remain) appearing as a primary name is an automatic drift finding, and old-name copy on any surface is drift by definition.
- Every link on every touched surface resolves (curl sweep, all 200/301→200).
- Each touched surface reached the principal as rendered-form evidence in the right modality (GitHub render for a README, Interceptor screenshot for a website) and was pushed only after their explicit approval of that surface.
- On a full sweep every row of the `Surfaces.md` inventory was audited; on a scoped run the named surfaces were swept and the rest are noted as unswept in the report.
- Authored prose for publication in the principal's voice (bio lines, README copy) passed the writing audit named in `Surfaces.md` § Writing audit before the principal saw it, or the report states that none is configured.

## Anti-criteria

- No surface is pushed without the principal's explicit approval for that surface, with no exceptions for "small" copy fixes.
- A surface marked generated or release-only in `Surfaces.md` § Surface notes (a repository generated from another source, a docs site that publishes only on release) is never edited directly; the change goes to its source or into its release path, because a direct edit is wiped or has no publish path.
- This intent never invents a new deploy path; each surface's inventory row (and the project row it names) decides how it ships.
- No star count is hardcoded in prose: star and follower counts use a live badge (for GitHub stars, a shields.io dynamic badge such as `img.shields.io/github/stars/...`), and a prose number is marked "as of <date>".

## Output format

Close with a drift table (surface → stale → changed → evidence → pushed/pending/unswept) in the run ISA.

## Inputs

Confirm scope: full sweep or named surfaces? If the principal named surfaces ("GitHub front page"), scope to those. If genuinely ambiguous what "current focus" means for a surface, ask up to 3 questions with a `proceed` override; otherwise flag the reasoned default inline and continue.

## Tool contract

- Config check: `bun ~/.claude/skills/Brand/Tools/Check.ts`.
- Link sweep: `curl -o /dev/null -s -m 10 -w '%{http_code}' -L <url>` per href.
- Current-truth reads: the files under `## Source-of-truth reads` in `Surfaces.md`, and the blog feed `$BLOG_FEED` for the freshest posts.
- Live star counts: the GitHub repos API for `$GITHUB_ORG` (`Surfaces.md` § Variables), for prioritization only; surfaces use dynamic badges.
- GitHub README render check: push to a draft branch and view, or `gh api markdown` for sanitization behavior.

## Gotchas

- Some profile bios cannot be updated through an API. Draft the copy, then either drive the Interceptor skill's test profile, signed in to that service, if it is installed (approval per surface), or hand the principal paste-ready text. The inventory's Update mechanism column says which applies. Interceptor drives only its pinned test context, never the principal's own Chrome windows (InterceptorContextGuard denies any other context).
