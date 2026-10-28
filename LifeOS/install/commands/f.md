---
name: f
description: Fast mode for this session — "/f" turns it on, "/f off" turns it off, through the built-in /fast. "ff" and "fff" stay parallel levels 2 and 3.
argument-hint: "[on|off]"
version: 4.0.0
---

# f — Fast mode for this session

`/f` turns fast mode on for this session only; `/f off` turns it off (principal, 2026-10-16; Router ISA F10). It is no longer a parallel level: `p` is level 1, and `ff` and `fff` stay levels 2 and 3 (see `/p`).

The LifeOSHooks plugin answers `/f` itself: it runs the built-in `/fast on` (or `/fast off`) for this session and prints one line. `settings.json` carries `fastModePerSessionOptIn: true`, so the change stays in this session. A bare `f`, `f on` or `f off` typed at the prompt does the same: the plugin queues `/fast` and adds a `FAST-TOGGLE:` line, and the reply is one line confirming it. When this file reaches the model, the plugin is not loaded, and the fallback is the built-in itself: tell the principal in one line to type `/fast on` (or `/fast off` for `off`), or `/f`, and do nothing else.

Never turn fast mode on any other way: no `FastMode.ts`, no write of `fastMode` to any settings file. A persisted `fastMode` billed usage credits in every session for days (2026-10-13).
