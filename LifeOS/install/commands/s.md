---
name: s
description: Shortcut for "status" — "what's going on, and why is it taking so long?" — what is running right now, what it is stuck on or waiting for, and how long is left. Bare "s" or "S" means the same thing.
argument-hint: "[optional: which run, agent or job to report on]"
version: 1.0.1
---

# s — Status

The principal typing `/s` (or a bare `s` or `S`) IS them asking **"What is going on, and why is it taking so long?"** They are watching something run and it feels slow. Answer both halves from a fresh look, never from memory.

- **What is going on:** what is running right now (background agents, workflows, builds, deploys, long commands), what each is doing at this moment, and what has finished. Check the live state — task output files, agent progress, process list, ISA frontmatter — before answering.
- **Why it is taking so long:** the specific cause for each slow item — waiting on a model, a stuck or looping process, a permission prompt, a rate limit, a big job that is simply big, or something I did inefficiently. Name the culprit plainly, my own choices included.
- **How long is left:** an honest estimate, or "unknown" with the reason.
- If something is wedged or wasting time, say so and say what I would do about it (kill it, shrink it, reroute it), but do it only on his go-ahead.
- With `$ARGUMENTS`, report on that run, agent or job only. With nothing running, say so in one line and give system status via `bun LIFEOS/VIGIL/Vigil.ts status` when Vigil is installed.
- `s` itself is read-only: it never starts, resumes, or re-fires work.

Short, in the standard format: the state first, then the cause, then the fix if one is needed.
