---
name: voice
description: Voice mode — turn this session into a spoken conversation, or back to text. The assistant speaks a short spoken version of each reply, the terminal keeps the full answer, and the principal answers by dictation. Bare "voice" toggles; "voice on", "voice off", "voice status" set or report it.
argument-hint: "[on | off | status]"
version: 1.0.1
---

# voice — Voice mode

The principal typing `/voice` (or the voice-mode hotkey, which types it) toggles voice mode for **this session only**.

Run it, then report the result in one line:

```bash
bun ~/.claude/LIFEOS/TOOLS/VoiceMode.ts $ARGUMENTS
```

With no argument the tool toggles; `on`, `off` and `status` do what they say.

- **Turned on:** answer with a one-line confirmation, then end the reply with a `🎙️ SPOKEN:` field greeting him and asking what he wants to talk through. When the session has an ISA, name it and ask about its first open decision instead. Relay any `warning:` line the tool prints (muted, or the voice server unreachable), in the terminal and in the spoken field.
- **Turned off:** confirm in one line. The reply has no SPOKEN field, and only the closer is spoken, as before.

How it works: `LIFEOS/DOCUMENTATION/VoiceMode/VoiceMode.md`.
