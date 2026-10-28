# InjectionSurfaceMap

Map every place someone else's text reaches the agent, what it can borrow once it's there, and what actually stands in the way.

## Ideal State

- `InjectionSurfaceMap.md` exists in the private data dir with every part the Output format names.
- The model has both halves, ingestion surfaces and capabilities, and ranks surfaces by whether something blocks between them and the context or only watches, never by which surface reaches the most; untrusted + persistent + nothing blocking is the top of the list, always.
- The top findings are in the register with `--threat "prompt injection"`, each scored by the capability it can borrow, not the sensitivity of the surface, with likelihood from the three questions under Output format.

## Anti-criteria

- Never treats a detector as a control: pattern scanning and a model instructed to notice manipulation are recorded as advisory, never as coverage.
- Ungoverned surfaces are never reported as a count alone.
- Absence from the census is never reported as absence of exposure.
- A real exposure never leaves the census because a row was removed: the private overlay may add or amend a surface, never delete one.
- A hand-built census (no Atlas) is never presented without saying in the output that it is hand-built.

## Output format

`InjectionSurfaceMap.md` in the private data dir, containing:

1. **Census** — every ingestion surface with trust class, channel, persistence, and its control band (governed / advisory-only / ungoverned).
2. **Ungoverned list** — untrusted surfaces with no control at all between them and context, each named with its next control, not a shrug.
3. **Advisory-only list** — surfaces where the only thing standing there is a model-mediated rule or a fail-open hook, saying plainly that these do not stop anything.
4. **Persistence chains** — for each persistent surface, where the text lands and what later re-reads it. This is where one-shot injection becomes permanent.
5. **Capability gates** — the capabilities with no blocking or human gate on them, sorted irreversible-first.
6. **What the map cannot see** — surfaces not in the registry.
7. **Risks** — the register IDs and scores of the top findings.

Likelihood is anchored to three things: can anybody author into the surface without an identity check, is the surface read automatically without a human in the loop, and does the content persist. All three yes is likelihood 4+.

## Tool contract

```bash
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts sync injection   # refresh from the registry
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts injection        # surfaces + capabilities + control bands
bun ~/.claude/LIFEOS/ATLAS/Atlas.ts reach ingest:<id>  # what an injection there could drive
```

The registry behind it: `LIFEOS/ATLAS/collectors/injection-surfaces.ts` for structural surfaces, plus the optional private overlay at `LIFEOS/USER/SECURITY/injection-surfaces.ts` for instance specifics.

Without Atlas, enumerate surfaces by hand from the tools and integrations in use, and say in the output that the census is hand-built.

## Gotchas

The dangerous combination is the *lethal trifecta*: untrusted content, access to private data, and a way to send things out. Almost every surface in a personal AI system has all three, because they all converge on one context that holds every capability, which is why "which surface reaches the most" is a useless ranking.

- **An unauthenticated write path into a file the system later reads is an ingestion surface**, even when no model is anywhere near it at write time. Log files, ledgers, and datasets count.
- **Automatic reads outrank interactive ones.** A surface a human chose to open has a human in the loop. A poller, a cron sweep, or a background grader does not.
- **The narrowing question is the useful one.** For each surface, ask what capability it could be denied without losing the surface's value. A feed reader does not need publish. That is the remediation direction: narrow the deputy, not the text.
