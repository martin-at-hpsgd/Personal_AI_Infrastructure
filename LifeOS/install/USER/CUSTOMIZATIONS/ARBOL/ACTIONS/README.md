---
provenance: template
---

# ARBOL / ACTIONS

**Purpose:** Your own action modules for the fleet pipeline runner, taking priority over the system's actions of the same name.

**What lives here:** One folder per action, each with an `action.json` manifest and an `action.ts` implementation. A name found here wins over the system action with that name.

**How it gets populated:** By you, when a pipeline needs a piece of logic the system actions do not provide.

**Sample state for fresh installs:** Empty apart from this README.
