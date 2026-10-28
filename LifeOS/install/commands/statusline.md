---
name: statusline
description: Switch the statusline on or off. It is the one always-visible status display. Bare "statusline" reports which is on.
argument-hint: [on | off | status]
version: 1.0.1
---

# statusline — the always-visible status display, on or off

The principal typing `/statusline on` means: bring the statusline back. `/statusline off` means: take it away for now; nothing else replaces it, because the statusline is the one status display. Bare `/statusline` asks which is on. The tool is `LIFEOS/TOOLS/StatusLine.ts`.

- `/statusline on` → `bun LIFEOS/TOOLS/StatusLine.ts on`. Puts the overlay's kept block back (or the stock one) and regenerates `settings.json`.
- `/statusline off` → `bun LIFEOS/TOOLS/StatusLine.ts off`. Sets `statusLine: { "__merge": "remove" }` in `USER/CONFIG/settings.user.json`, keeps the old block in `MEMORY/STATE/statusline-kept.json`, regenerates `settings.json`.
- `/statusline` or `/statusline status` → `bun LIFEOS/TOOLS/StatusLine.ts status`.

`settings.json` is generated at every SessionStart (settings.system.json ⊕ the overlay), so the switch lives in the overlay; editing `settings.json` by hand is undone by the next merge. Run it, commit the overlay line and `settings.json`, and say the change shows in new sessions; a running session keeps what it started with.
