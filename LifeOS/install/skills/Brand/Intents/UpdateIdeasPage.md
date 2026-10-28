# UpdateIdeasPage Intent

Refresh the principal's Ideas page (`$IDEAS_URL`, `Surfaces.md` § Variables) so it reflects their latest captured ideas, not the snapshot it froze at.

## Ideal State

- The edit landed in the file that serves the live page at `$IDEAS_URL`, not in a similarly named file (`Surfaces.md` § Ideas page § Traps lists the known look-alikes).
- Every genuinely principal-original idea captured since the last page update is either on the page or explicitly rejected in the run report with a reason.
- Zero third-party content on the page: capture inboxes mix the principal's own ideas with harvested stories and other people's ideas that merely passed through, and none of those appear.
- Each added row is a one-line claim of what the referenced post's body actually argues, not a restatement of its title.
- Each added idea is written in the principal's voice (existing page entries are the exemplar) and passed the writing audit named in `Surfaces.md` § Writing audit before the principal saw it, or the report states that none is configured.
- The existing page prose and idea entries are untouched unless the principal approved changes to them.
- The page's last-updated markers (frontmatter and visible line, as `Surfaces.md` § Ideas page describes them) reflect the edit; the rendered page was Interceptor-verified at `$IDEAS_URL` after deploy.
- An ideas table (idea → source → added/rejected+reason → evidence) exists in the run ISA.

## Anti-criteria

- No deploy before the principal approves the final draft (public content under their name).
- No capture row that the ownership filter in `Surfaces.md` § Ideas page rejects ever goes on the page; when a row's source is ambiguous, ask or drop.
- No `status: draft` post is ever linked: its slug 404s or leaks unpublished work, so frontmatter status is checked on every referenced post.
- The appearance claim never closes on a curl 200; it closes only on a viewed screenshot of the live page.

## Output format

Close with an ideas table (idea → source → added/rejected+reason → evidence) in the run ISA.

## Inputs

`Check.ts` must pass and print `ideas page configured`; otherwise stop and tell the principal what is missing.

Confirm the window ("latest" since when? default: since the page's last-updated marker) and whether the principal wants a full-page restructure or additions only (default: additions only).

## Tool contract

Sources of "latest ideas" are the table under `Surfaces.md` § Ideas page § Idea sources, read in the order listed. A source whose tool is not installed is skipped and named as skipped in the run report. Recent blog posts come from `curl -s "$BLOG_FEED"`.

The page:

- Source file: `$IDEAS_SRC`. Live URL: `$IDEAS_URL`. Page structure, row format and body format are in `Surfaces.md` § Ideas page; match them exactly.
- Deploy: the deploy line in `Surfaces.md` § Ideas page, under the owning project's deploy doctrine.

## Gotchas

- A filename match proves nothing, and a curl 200 on the live URL proves nothing about which file produced it: SPA and static-site pages return 200 shells. Open the live page and compare it against `$IDEAS_SRC` before any edit. A look-alike legacy file can pass both checks; the install's own history of this is in `Surfaces.md` § Ideas page.
