---
provenance: template
version: 1.0.0
---

# Security Posture

Registry of threats, vulnerabilities, and the current state of countermeasures for your estate. Read by the Achilles system and the risk register.

## Critical risks register

One row per scenario. Tracks prevent / detect / respond state:

| Risk ID | Threat | Prevent | Detect | Respond | Owner |
|---------|--------|---------|--------|---------|-------|
| T1 | SSH key compromise | Key guard, file watch | Rotation alert | Incident response | you |

## Vulnerability registry

Link to your `SECURITY/Achilles` registry of known vulnerabilities in your stack:

- Path: `SECURITY/ACHILLES/registry.json`
- Maintained by: Achilles.ts
- Update frequency: Weekly via scheduled scan

## Trusted channels

Authorized operators and notification methods:

- Principal: direct session or iMessage (Relay)
- Trusted colleagues: email with TLS
- Vendors: only authenticated API channels

Never share secrets via chat, email, or public logs.
