---
provenance: template
version: 1.0.0
---

# VIGIL — your monitoring settings

Vigil's engine ships in `LIFEOS/VIGIL/`; your settings live here and never ship.

- `policy.json`: how events are routed (text, morning digest, dashboard), daily text limits, per-source caps and expected cadences. Every key is optional; missing keys take the defaults in `LIFEOS/VIGIL/Policy.ts`.
- `worker.json`: the Cloudflare D1 database the optional store Worker binds to. Needed only to deploy `LIFEOS/VIGIL/worker`.
- `editor-profile.md`: what the optional model editor knows about you. Read only when `editor_enabled` is `true`.

Setting it up: follow `skills/Vigil/Setup.md`.
