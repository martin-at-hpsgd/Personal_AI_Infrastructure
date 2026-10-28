---
provenance: template
version: 1.0.0
---

# INTEGRATIONS — non-secret device and service settings

One YAML file per integration, holding the **non-secret** half of a connection:
hostnames, IPs, site names, feature toggles. The secret half (tokens, passwords)
always lives in `~/.claude/.env` and is read from the environment by the tool
that needs it.

| File | Read by | Holds |
|------|---------|-------|
| `unifi.yaml` | network integration tools, when installed | `UNIFI:` block — controller URL, controller IP, site |

Skills that integrate a new device follow the same pattern: a `<vendor>.yaml`
here with connection details, and `<VENDOR>_*` keys in `.env` for credentials.

## Privacy

Everything here is part of your private USER tree. It never ships in a public
release, and the Pulse voice/full-access path refuses to read this directory on
purpose (it is classified as local device credentials).
