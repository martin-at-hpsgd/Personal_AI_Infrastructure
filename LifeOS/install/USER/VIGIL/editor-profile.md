---
provenance: template
version: 1.0.0
---

# Vigil editor profile

What Vigil's editor knows about you when it decides whether an event below the text floor is still worth a text. The editor is off until `editor_enabled` is `true` in `policy.json`. This file is sent to the model lane on every tick it runs, so keep it to interests and decision triggers: never money amounts, holdings, addresses, health readings or other restricted data.

## Who you are

Alex Example runs a two-person studio that builds and hosts small web apps for local businesses. Mornings are client work; afternoons are building.

## Text me when

- A service I host goes down or comes back after being down.
- A client-facing deploy fails.
- Something I am waiting on arrives (a contract signed, a domain transfer done).

## Leave it for the morning summary

- Routine news in my field, unless it changes how one of my hosted services must run this week.
- Anything a scheduled job already reported once today.
