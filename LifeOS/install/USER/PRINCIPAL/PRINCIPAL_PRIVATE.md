---
provenance: template
version: 1.0.0
---

# Principal Private Details

Read on demand only. This file is never `@`-imported, so nothing here reaches the startup context of a session. Put the private facts your DA may need for a task here, one bullet each, such as a home address or a phone number. Two tools also read it to learn which strings must never appear in shared code: `LIFEOS/TOOLS/CodeDataBoundary.ts` and `LIFEOS/TOOLS/DeriveDenyHashes.ts`.

- **Home:** (your street address, city, region and postal code)
- **Phone:** (your phone number)
