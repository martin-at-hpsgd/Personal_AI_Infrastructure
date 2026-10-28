---
name: y
description: Shortcut for yes — do the action just proposed. When that action is a deploy, it explicitly means “ship it.” Bare "y" means the same thing.
argument-hint: "[optional: which proposed action, if more than one is open]"
version: 1.2.0
---

# y — Yes, do it

The principal typing `/y` (or a bare `y`) IS them saying **"yes, do it"** to the action the DA just proposed. The approval is given; do not re-ask.

- When the proposed action is a deploy or ship, use the repo's sanctioned gated deploy command, commit only the intended paths, and include any required push in the same motion. Live claims require two evidence classes (an HTTP probe plus a real-browser or live-API check); with only one, report "deploy accepted." Public-repo, release, and high-risk gates still apply.
- When the DA asked several questions or proposed several actions, a bare `y` is yes to every one of them, each taken as the DA recommended (2026-10-10). `$ARGUMENTS` narrows it to one when given.
- When nothing was proposed but work stopped mid-flight, `y` means continue, exactly as `/c`: resume where it stopped and keep going until done or truly blocked.
- When nothing was proposed and nothing is in flight, say what you would do and proceed only if it is unambiguous.
- `y` never bypasses a gate. Public-repo pushes, releases, and high-risk infra keep their own workflows; `y` only removes the ask.
- `y` never starts a Workflow. A Claude Code Workflow takes `dw`, a time suffix, ultracode, or the principal's own words asking for one (Router ISA F5, 2026-10-10: a dictated stray "y" must not launch an expensive run).

Report done with the evidence, in the standard format.
