# Brand

Status: bun ~/.claude/skills/Brand/Tools/Check.ts · optional

## What it does

Keeps your public profiles and sites saying the same current thing. You list every public surface once (GitHub profile README, blog about page, company and product sites, repo READMEs, X, LinkedIn, YouTube) with how each one is updated and what approval it needs. A brand sweep then reads your current focus from files you keep, finds stale names, dead links and old claims on each surface, drafts the fixes, checks them in rendered form, and pushes only what you approve one surface at a time. A second intent refreshes an "ideas" page on your blog from the ideas you have captured.

It needs a personal-site and GitHub presence to sweep, the GitHub CLI for READMEs, a way to deploy each site you own, and one config file listing the surfaces.

## Fill in

One file: `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Brand/Surfaces.md`. The checker reads these sections by their exact headings. Smallest working example:

```markdown
# Brand Surfaces

## Source-of-truth reads

| Key | Value |
|-----|-------|
| Bio facts | `LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` |
| Freshest posts | blog feed, `$BLOG_FEED` below |

## Variables

| Variable | Value |
|----------|-------|
| `$BLOG_FEED` | `https://blog.example.com/rss.xml` |
| `$GITHUB_ORG` | `alex-example` |

## Surface inventory

| # | Surface | Where | Update mechanism | Gate | Project row |
|---|---------|-------|------------------|------|-------------|
| 1 | GitHub profile front page | `github.com/alex-example/alex-example` (README) | clone → edit → push | Approval before push | — |
```

| Section | Required | What goes in it |
|---------|----------|-----------------|
| `## Source-of-truth reads` | yes | The files that say what your brand is right now. Each backticked `.md` path must exist under your config root. |
| `## Surface inventory` | yes | A table whose header includes the columns `Surface`, `Update mechanism` and `Gate`. Every row needs a mechanism and a gate (a dash does not count). `Project row` names the row in `LIFEOS/USER/PROJECTS.md` whose deploy rules apply. |
| `## Variables` | needed for the ideas page | Table of `$NAME` and value. The ideas page needs `$BLOG_FEED`, `$IDEAS_SRC`, `$IDEAS_URL` and `$BLOG_REPO`. |
| `## Surface notes` | no | Bullets for rules tied to one surface or to your naming history: generated repos, release-only sites, retired names and their redirects. |
| `## Writing audit` | no | The check you run on prose published in your voice. Without it the intents report that no audit ran. |
| `## Ideas page` | only for UpdateIdeasPage | Source file, live URL, deploy command, page structure and row format, known look-alike files, idea sources and the filter for which captures are yours. |

## Accounts and secrets

- A GitHub account with the GitHub CLI signed in (`gh auth login`) for profile and repo READMEs.
- Whatever deploys each site you list (a Cloudflare, Vercel or Netlify account and its token, set the way that project already documents).
- X, LinkedIn and YouTube have no write path here: the skill drafts paste-ready text, or drives the Interceptor skill's separate Chrome test profile, where you sign in to each service once, with your approval per edit. It never drives your own Chrome windows.
- No env keys of its own go in `~/.claude/.env`.

## Prove it works

```bash
bun ~/.claude/skills/Brand/Tools/Check.ts
```

Success prints `OK: <n> surfaces in <path>` (plus `; ideas page configured` when you added that section) and exits 0. A missing file, missing section, inventory row without a mechanism or gate, or missing source-of-truth file prints what is wrong, points at this guide and exits 1. Then check your feed address resolves:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L "https://blog.example.com/rss.xml"
```

Replace the URL with your `$BLOG_FEED`; `200` means the sweep can read your freshest posts.
