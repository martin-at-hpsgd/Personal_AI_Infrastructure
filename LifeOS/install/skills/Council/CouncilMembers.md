# Council Members

Council members are personas you write inline, tailored to the topic, then run as direct model calls split across vendors (§ Launch).

## Why inline briefs

A model called with no persona has no stake in the topic and produces bland agreement. Council needs members who disagree on the merits. The friction comes from each member having a distinct role, expertise, and stance — which you supply in the brief.

## How to Create Council Members

### Choosing perspectives

Design the roles around the perspectives that create the most productive friction for this specific debate, not from a generic list.

**Example — "Should we use WebSockets or SSE?"**
- Real-time systems architect who defends push-first bidirectional transport
- Frontend-DX advocate who wants the simplest thing that ships
- Ops/reliability skeptic who distrusts long-lived connections
- Industry researcher who weighs precedent and adoption data

**Example — "Is AI overhyped?"**
- AI infrastructure builder who ships with these tools daily
- Security practitioner skeptic who has seen the failure modes
- Pragmatic engineer focused on real-world trade-offs
- Evidence-based researcher who wants the numbers

### The brief

Each member gets 2–4 sentences: a name, their role/expertise, the stance they hold, and what they'll push on and attack. That paragraph is the whole persona.

Example brief:
> **Mara — real-time systems architect.** Believes push-first. Will defend WebSocket bidirectionality and attack SSE's connection-count limits and reconnection story. Speaks precisely, cites protocol behavior.

### Launch: one direct call per member, split across vendors

A council member is text in, text out: it needs no tools, and every round already carries the prior transcript in its prompt. Run each member as one `Inference.ts` call, all members of a round in parallel, and split the council across vendors so the members do not share one lineage's blind spots:

```bash
bun ~/.claude/LIFEOS/TOOLS/Inference.ts --level <level> --vendor <openai|anthropic> --no-fallback --timeout 180000 \
  "<member brief>" "<topic context + round instructions + prior transcript>"
```

- **No fallback:** always pass `--no-fallback`. Without it an openai member that fails is answered by anthropic and the council quietly loses its second lineage. With it the call exits 1; report the missing member in the transcript and re-run it or proceed without it.
- **Vendor:** alternate members between `openai` and `anthropic`. When the topic is judged by taste (naming, voice, visual or creative direction), give the majority to `anthropic`; when it is judged by correctness (does it work, is it true), give the majority to `openai`.
- **Level:** `medium` for Quick, `high` for Debate, `max` when the principal asked for depth or the decision is expensive to get wrong. Levels resolve to models in `LIFEOS/TOOLS/models.ts`; never name a model here.
- **Lookups:** a member who must fetch something live (a current number, a doc) is an `Agent` spawn instead, with the brief as its prompt and no `model:` pin, because the direct call has no tools.

The tool prints the model it executed on stderr. A member that did not run on the requested vendor is reported in the transcript, never silently kept. Do not send members to the Sol worker or the Haiku agents; those exist for code tasks.

Paired probe, 2026-09-18: four member briefs on a Claude subagent and on one direct call. The direct call held persona, length and structure on all four, while one subagent member wrapped its answer in a report about itself and each cost about 100k tokens of injected context.

## Default Perspective Slots

When the user doesn't specify members, cover these four perspectives — but write each one tailored to the topic, not as a generic role:

| Slot | Purpose |
|------|---------|
| **Builder** | Has built things in this domain; argues from what actually ships |
| **Skeptic** | Challenges assumptions, finds the flaws and failure modes |
| **Pragmatist** | Implementation reality, cost, and trade-offs |
| **Analyst** | Data, precedent, and external evidence |

The slots are a starting guide. Adjust the mix to the topic — a pure design question may want two builders and a user advocate instead.
