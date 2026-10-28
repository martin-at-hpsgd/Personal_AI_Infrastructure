---
provenance: template
version: 1.0.0
---

# INBOX — sender taxonomy for mail triage

One file lives here: `senders.yaml`, the sender classification the inbox triage tool reads and rewrites. Its header comment documents the exact shape: top-level scalars, then three maps keyed by quoted lowercase strings, one entry per sender, domain, or pattern, each with a `class`.

## How it fills in

If the inbox skill is installed, its triage tool classifies senders as it sees mail and writes them back here with counts and a `last_updated` stamp. Without it, the mail gate (`LIFEOS/TOOLS/JobGate.ts`) only reads this file: every sender you have not classified counts as `unknown` and never wakes a job, so classify the senders that matter by hand, one entry each.

## The classes and what they mean

`human`, `financial`, `transactional`, `legal`, and `unknown` are never auto-archived. `marketing` and `notification` may be auto-archived once the tool's confidence passes its threshold. Keep the file's shape exactly as the header describes; the tool's parser is deliberately minimal.

Mailbox credentials live in `~/.claude/.env` (see `CONFIG/env.template`), never in this directory.
