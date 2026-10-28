# Update

Upstream Hermes updates checked, applied with a backup, and the LifeOS mount proven to have survived them.

## Ideal State

- The principal saw what `hermes update --check` reported as incoming before the update was applied, and a pre-update backup exists because the update was applied with `--backup` regardless of the config default.
- The report states the version/rev moved from → to, what the update changed (their changelog or a `git log old..new --oneline` summary), and the post-update battery result line by line.
- The update is called done only when every check passes: `Mount.ts --check` reports current, the guard suite passes, the gateway is `up`, no restarter job is loaded, and bunker rows are no worse than the before state captured ahead of the update.
- `Observe.ts status` numbers are compared against their pre-update capture, and a metric that suddenly improved is cross-checked against the raw store before it is treated as good news.
- A post-update session loads the soul (`--assert-lifeos` exit 0 once a session has run); exit 2 before one has is reported as unproven.
- On any failure that re-mounting cannot fix, Hermes is restored from the pre-update backup, pinned back to the previous rev, and what broke is reported.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

## Anti-criteria

- Never skips the post-update battery: an update that "worked" has proven nothing about the mount.
- A soul newly rejected by an updated threat pattern is treated as a finding to understand, never as a string to reword until the scanner passes. The report names the pattern that matched and the sentence it matched, and says whether the sentence really gives an instruction-injection shape (a command to override, ignore or hide instructions) or is a false positive of the pattern.
- A scanner is never weakened, bypassed or evaded: no loosened patterns, no disabled scan, and no rewording whose purpose is to stop the match.
- An `--assert-lifeos` exit 2 "unproven" is never reported as passing.

## Safety gates

- Never applies an update without the principal's go-ahead in this conversation, unless updating is what they asked for.

## Tool contract

```bash
hermes update --check                                  # what's available; current rev: git -C "$HERMES_HOME/hermes-agent" log --oneline -1
hermes update --backup --yes                           # apply, with full pre-update backup (their snapshot: state plus a HERMES_HOME zip)

# Post-update battery — all must pass before calling the update done:
bun ~/.claude/LIFEOS/HERMES/Mount.ts --check           # mount drift + the soul re-scanned by their (possibly new) scanner
python3 ~/.claude/LIFEOS/HERMES/plugin/test_guard.py   # guard plugin suite against the updated engine
bun ~/.claude/LIFEOS/HERMES/Health.ts --assert-live --strict    # gateway status is exactly up (plain --assert-live also passes degraded, absent and restarting)
bun ~/.claude/LIFEOS/HERMES/Health.ts --assert-no-restarter  # the KeepAlive restarter-loop regression
bun ~/.claude/LIFEOS/HERMES/Observe.ts status --assert-lifeos          # after the next session cycle: sessions still load the soul; exit 2 = unproven (no sessions in 2h or unreadable DB), which is not a pass
```

The guard plugin runs inside Hermes, which is a Python engine, so `test_guard.py` is Python by necessity. The TypeScript-only rule does not excuse skipping it; it is a required battery check.

If the Bunker CLI is installed (its reference implementation is private and not in the public release payload), also run `cd ~/.claude/LIFEOS/HERMES && bun ../PULSE/Bunker/bin/bunker.ts test` for the full probe rows.

## Gotchas

- The update itself is Hermes' own machinery; the value of this intent is the verification battery after it, because an upstream update can change the threat scanner (re-blocking a soul that scanned clean), rewrite config defaults, or restart the gateway into a bad state. The 2026-07/08 soul-block outage was invisible precisely because the engine looked healthy.
- `Mount.ts --check` reporting stale means the update regressed config; re-run `Mount.ts` (it reconciles), then re-check. If the mount's scanner gate now rejects the soul, read which pattern matched and which sentence. When the sentence really has an instruction-injection shape, the soul source is wrong on its merits and is changed for that reason, with the principal's approval. When it is a false positive, the soul stays as it is, the update is restored from the backup and pinned back (Ideal State), and the false positive is reported upstream to Hermes. Rewording a sentence only so the scanner stops flagging it is the failure, not the fix.
- A metric that suddenly improves (soul-blocked dropping to zero) is a migration suspect: the 2026-08-15 update moved session prompts into a `system_prompts` hash store and the old column read silently green.
- A working older Hermes beats a broken newer one, which is why restore-and-pin is the fallback.
