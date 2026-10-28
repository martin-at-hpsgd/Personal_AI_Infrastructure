# TelosCheckin — superseded by ContextCheckin

This intent has been generalized. See `ContextCheckin.md` for the active intent.

## Ideal State

- A request routed here (e.g., `/interview telos`) produces the `Intents/ContextCheckin.md` interview, and that interview's core is the per-section TELOS conversation.
- The principal sees one interview, ContextCheckin's, with no separate TELOS-only pass.

## Anti-criteria

- No interview is run from this stub's own text.

## References

ContextCheckin drives the per-section TELOS conversation plus the file-level review of the other constitutional files; its `## Inputs` lists all seven. The Interview skill's SKILL.md routing table maps both the default `/interview` and any `telos checkin` triggers to ContextCheckin.
