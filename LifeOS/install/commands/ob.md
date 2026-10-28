---
name: ob
description: Toggle obfuscation, the stream-safe mode. While it is on, the statusline names subscription accounts by nickname instead of email and Pulse turns on Observer mode. OBS running turns it on by itself. Bare "ob" means the same thing.
argument-hint: [on | off | auto | status]
version: 1.0.0
---

# ob — obfuscation, on or off

The principal typing `/ob` or bare `ob` means: flip obfuscation now. The tool is `LIFEOS/TOOLS/Obfuscate.ts`; run it at once, before anything else, and answer with its one line.

- `/ob` or `ob` → `bun LIFEOS/TOOLS/Obfuscate.ts toggle`. On becomes off, off becomes on. An off chosen while OBS is running lasts for that OBS run only.
- `/ob on` / `/ob off` → `bun LIFEOS/TOOLS/Obfuscate.ts on|off`.
- `/ob auto` → `bun LIFEOS/TOOLS/Obfuscate.ts auto`: clears any choice, so OBS alone decides.
- `/ob status` → `bun LIFEOS/TOOLS/Obfuscate.ts status`.

Every statusline picks it up on its next draw and every open Pulse tab within about two seconds; nothing needs restarting. Pulse's OBSERVER button is the same switch.
