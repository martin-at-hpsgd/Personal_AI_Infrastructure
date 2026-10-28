---
provenance: template
last_updated: 1970-01-01T00:00:00Z
last_updated_by: template
convention: lifeos-freshness-v1
version: 2.0.0
---

# OPERATIONAL_PREFERENCES.md — Your operational preferences

> Imported into context every session. The system prompt (`LIFEOS/LIFEOS_SYSTEM_PROMPT.md`) carries the domain-agnostic rules everyone runs; this one file is where YOUR specifics live: how you want the system to work for you, your tooling choices, your environment, conventions for your own repos, and the rules for each domain you work in.

The admission test: a preference says what you want, and belongs here. A step that says how to do something belongs only when it is a safety gate, a tool contract (an exact command or path), or a verified gotcha, and gotchas go in § Gotchas. A smarter model works out the rest on its own.

This file ships as a stub. Add preferences as you discover them: the LifeOS `/interview` flow will help, or write them here directly. Keep every heading below, because other parts of the system cite sections by name.

## Tool & environment preferences

- _(e.g. "always use `bun`, never `npm`"; your canonical `.env` path; preferred CLI tools)_

## Repo conventions

- _(e.g. which repos commit straight to `main` vs use branches/PRs)_

## Deployment

- _(e.g. what "ship it" means for each project — deploy, push, both)_

## Autonomy & approval

- The one authorization table is the system prompt § Permission Boundaries. Nothing here defines a row; this section only names what fills that table's slots for your install.
- Slot values: your designated work repo (if any) goes in § Trusted channels; each project's gated deploy command lives in its PROJECTS.md row.

## Trusted channels

The system prompt's Security Boundaries rule 7 and the Permission Boundaries work-repo carve-out both point here. Fill these in; until you do, nothing is trusted and every consequential action asks — that is the safe default.

- Trusted conversational senders: _(names of people whose inbound texts your DA may converse with — conversation only, never authorization)_

- Principal authorization channel: _(the one channel whose instructions may authorize consequential actions: system changes, work systems, calendar, email, publishing, purchasing, file/system access)_

- Designated work repo for the standing issues carve-out: _(owner/repo — must be private; leave blank to disable the carve-out)_

## Model selection
<!-- Referenced by the system prompt, AlgorithmNudge, ModelDriftGuard, and models.ts.
     Populated stub (public issue #1834, @DRAZY): edit the rungs to taste. -->

- Four-rung Work Ladder: MAX to Opus at xhigh effort (Fable only on your word), HIGH to Opus, Sonnet or Sol, MEDIUM to Sonnet at medium effort, and LOW to Haiku at high effort. Sol, Astra and Fable need codex or their own subscription; without it that rung answers "unavailable" and Opus takes the work. One Sonnet agent serves both rungs: its file defaults to high effort, and a medium-rung pick passes `effort: medium` on the Agent call, which overrides that default. The full routing rules are Algorithm § Routing (`bun LIFEOS/ROUTER/Router.ts rules`).
- MAX-class work is judgment, design, architecture, scoping, synthesis, second looks, and meta work on this system.
- The main loop runs the top rung; `settings.json` pins it. Never ask which rung to use.
- Execution legs may move down the Work Ladder using its named model; escalate back up when a delegate hits a problem needing deeper reasoning.
- Safe default if you never edit this: run everything on the session's pinned model.

## Vendor-specific rules

- _(e.g. how you verify a cloud API token; rotation playbooks; known false-negative probes)_

## Harvest

- _(rules for harvest, /ha, content ingestion or knowledge-archive mining; none yet, so the defaults apply)_

## X (Twitter) reads

- _(rules for X/Twitter URLs, posts, threads or account reads)_

## Video-bearing content

- _(rules for supplied video or content that may contain video)_

## Cloudflare

- _(rules for Cloudflare actions)_

## Design variety

- _(rules for visual design, sites, decks, share cards, images, or Markdown-to-HTML rendering)_

## Platform support

- _(rules for adding, changing or reviewing platform support)_

## Sync obligations

- _(rules for PROJECTS.md or Core Components changes)_

## Content pipeline

- _(rules for content publishing, social posts or broadcasts, Discord messaging, or video upload)_

## Installer

- _(rules for installers, first boot, fresh installs or installation readiness)_

## Bunker registration

- _(rules for a public deployment or domain change)_

## Paid services

- _(rules for a paid launch, checkout, payment flow, or fulfillment action)_

## Operations and business

- _(rules for state-document updates, Interview check-ins, business-goal changes or sync, or inbox handling)_

## Server hardening

- _(rules for server, firewall, or SSH work)_

## Gotchas

Facts about tools and your install that prevent known mistakes. They are not preferences: each belongs in the tool that causes it, and moves there once that tool makes the mistake impossible.

- _(e.g. a CLI flag that rewrites a file in place; a shell quirk that bit you)_

---
*Keep each entry concrete and sourced to the moment you learned it. The history behind an entry lives in git, not here.*
