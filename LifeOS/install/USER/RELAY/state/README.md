---
provenance: template
version: 1.1.1
---

# Relay State Files

Runtime files for the Relay iMessage bridge. The directory is 0700 and every file in it is 0600. Never print their contents.

## Files

- **bridge-config.json**: who may text in, your own line, the salted countersign hash, and optional timeouts. You create it; `Countersign.ts set` adds the countersign fields. Every key, whether it is required, and every default are listed once, in `LIFEOS/USER/RELAY/README.md` § Set it up.
- **bridge-config.example.json**: a placeholder `bridge-config.json` with every optional key and made-up values. Nothing reads it; copy it to `bridge-config.json` and replace each value.
- **texting-auth.json**: the lock state of your line. Written by the bridge and by the Relay skill's unlock tool.
- **sessions.json**, **conversations/**: per-thread session ids and conversation history. Written by the bridge.
- **bridge.log**, **guard.log**: one JSON line per event, appended by the bridge and the texting guard. Rotated once a file passes 5 MB.

To read the end of the bridge log without exposing numbers:

```bash
tail -20 ~/.claude/LIFEOS/USER/RELAY/state/bridge.log | sed -E 's/\+?[0-9]{10,}/[NUM]/g' | cut -c1-160
```
