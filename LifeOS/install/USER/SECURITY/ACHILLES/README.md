---
provenance: template
---

# Achilles — your vulnerability registry

The Pulse `/achilles` page reads `registry.json` in this directory. Until it
exists the page shows an empty registry, which is correct for a fresh install.

## How it gets filled

You do not hand-write the registry. `bun ~/.claude/LIFEOS/TOOLS/Achilles.ts`
creates it on the first add, and the Synapse, Atlas, scanner, Socrates and
ThreatModel legs append to it as they find things. Run
`bun ~/.claude/LIFEOS/TOOLS/Achilles.ts --help` for the verbs.

## Format

`registry.json` is one JSON object:

```json
{
  "version": 1,
  "updated": "1970-01-01T00:00:00Z",
  "entries": [
    {
      "id": "ACH-<four digits>",
      "title": "<short description of the weakness>",
      "category": "technical",
      "severity": "medium",
      "source": "manual",
      "status": "open",
      "cves": [],
      "affected": ["<your-app-or-device>"],
      "first_seen": "1970-01-01T00:00:00Z",
      "evidence": ["<how you know>"],
      "links": ["https://example.com/advisory"]
    }
  ]
}
```

- `category`: technical, financial, reputational, legal, physical, operational
- `severity`: critical, high, medium, low
- `source`: synapse, pentest, atlas, workflows-scanner, threatmodel, vulnmanagement, socrates, manual
- `status`: open, in_progress, remediated, accepted, false_positive, informational
- Optional: `description`, `closed_at`, `work_issue` (the linked work-repo issue number), `risk_ref` (a ThreatModel `R-xxx` id), `fix_class` (auto, agent, human)

## Optional overrides

`fix-classes.json` maps a `source_ref` prefix to a fix class, for example
`{ "manual|": "human" }`. Keys starting with `_` are ignored.

## Privacy

This registry describes where you are exposed. It never ships in a release
and never leaves your machine.
