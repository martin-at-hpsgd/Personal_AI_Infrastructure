---
last_updated: 2026-09-20
last_updated_by: da
last_reviewed: 2026-09-20
last_reviewed_by: da
convention: lifeos-freshness-v1
version: 1.0.4
---

# Overage — the emergency API lane and its readout

> **Astra and Fable normally ride subscriptions.** Astra runs through `codex exec` on the ChatGPT plan; Fable runs on the Claude subscription. When a plan window caps, work stops. The emergency API lane makes that capped window a decision: the principal may explicitly arm a pay-per-token continuation, and every billed call is visible in dollars.

## The policy

The rule is plain:

- **Ask each time.** An arm belongs to one session, records the reason, and expires. Only an interactive session may arm it; unattended or headless arming is refused.
- **One monthly ceiling across both vendors.** The default ceiling is **$1,000 per month**, enforced before a call can bill. The lane refuses at the ceiling, even if an arm is still present.
- **Failover only.** This is the emergency road around a capped subscription window, never a cheaper road for routine work. Routine work stays on the subscription lanes and the normal work ladder.
- **No unattended arming.** A scheduled or headless process cannot turn the lane on, and a call without the current session's arm cannot bill.

## The pieces

| Piece | File | Role |
|---|---|---|
| Ledger and CLI | `LIFEOS/TOOLS/Overage.ts` | Records billed calls, computes month-to-date spend, ceiling and remaining headroom, manages the arm, and exposes the CLI. |
| Arm state | `LIFEOS/MEMORY/OBSERVABILITY/overage-state.json` (0600) | The expiring per-session decision: session, reason and expiry. |
| Derived summary cache | `LIFEOS/MEMORY/OBSERVABILITY/overage-summary.json` | Writes the cache that the statusline and Pulse can read without spawning Bun. |
| Ledger file | `LIFEOS/MEMORY/OBSERVABILITY/overage-ledger.jsonl` | Appends billed-call rows, including vendor, lane, token counts, cost, session and reason. |
| Price tables | `LIFEOS/TOOLS/vendor-pricing.json` and the Anthropic model-pricing table read by `LIFEOS/TOOLS/Overage.ts` | Per-million-token rates used to price calls; an unpriced model is refused. |
| Two lanes | `LIFEOS/TOOLS/ApiLane.ts` | Astra on OpenAI and Fable on Anthropic, gated first by the arm and ceiling, then by the appropriate API key. |

The two top lanes remain Astra and Fable. `ApiLane.ts` reads keys through the normal environment path, never prints them and never puts them in a URL. It sends only to `api.openai.com` and `api.anthropic.com` and refuses any other host, so a proxy base URL in the environment cannot redirect it, and no proxy carries these metered calls. A completed call is priced and appended to the ledger.

## The three read surfaces

### Statusline money line

The status line's money row (`LIFEOS/TOOLS/StatusLineMoney.ts`, drawn by `LIFEOS/STATUSLINE/Render.ts` through the `money` section (`LIFEOS/STATUSLINE/registry/Bottom.ts` registers `LIFEOS/STATUSLINE/sections/Money.ts`); `LIFEOS/LIFEOS_StatusLine.sh` is only the entry point) reads the derived summary cache and never touches the network. Its month group shows an `API Lane` entry with the month's emergency API spend against the ceiling whenever anything has billed or the lane is armed. While the lane is armed the entry ends in an orange `(Armed)` and the head of the row reads `Paying · Emergency API Lane Armed`, with the arm's expiry time. Anthropic's extra-usage credits pool is a separate `Credits` entry on the same row.

### Pulse

The Pulse usage page has an overage section with month-to-date dollars by vendor, the ceiling and recent billed calls. Its read-only endpoint is `GET /api/usage/overage`, implemented in `LIFEOS/PULSE/modules/usage.ts`; it returns the overage summary shape with `month`, `ceilingUsd`, `spentUsd`, `remainingUsd`, vendor rollups, arm state, recent calls and update time.

### CLI

`LIFEOS/TOOLS/Overage.ts status` is the state-of-record readout. It reports whether the emergency lane is armed, the month-to-date spend against the ceiling, the remaining amount, and billed calls by vendor, lane and model. `--json` emits the summary object for machine readers.

## Command reference

These command forms are copied from the tools' own usage blocks.

```text
bun LIFEOS/TOOLS/Overage.ts status [--json]
bun LIFEOS/TOOLS/Overage.ts arm --session <id> --reason "<why>" [--minutes 240]
bun LIFEOS/TOOLS/Overage.ts disarm
bun LIFEOS/TOOLS/Overage.ts check --session <id>          # exit 0 only when a call may bill
bun LIFEOS/TOOLS/Overage.ts record --vendor openai --lane astra --model <id> \
     --input N --output N [--cached N] [--session <id>]
```

```text
bun LIFEOS/TOOLS/ApiLane.ts astra --prompt "..." [--system "..."] [--session <id>]
bun LIFEOS/TOOLS/ApiLane.ts fable --prompt "..." [--max-tokens 4096]
bun LIFEOS/TOOLS/ApiLane.ts astra --prompt "reply OK" --probe   # smallest possible live call
```

`status`, `disarm`, and `check` are read-only or non-billing checks suitable for inspecting the lane. The `record` and `ApiLane` forms can create billed state; use them only when the policy and the explicit arm permit it.

## Current state

When `ANTHROPIC_API_KEY` is absent, the Fable lane refuses by name rather than silently falling back to the subscription. To enable Fable over the emergency API lane, the operator must add a Console key to the canonical environment and seal it with `bun LIFEOS/TOOLS/Secrets.ts seal`. The key itself is never written in this document or exposed by the lane.

## Cross-references

- Emergency API ledger and CLI: `LIFEOS/TOOLS/Overage.ts`
- Emergency API lanes: `LIFEOS/TOOLS/ApiLane.ts`
- Non-Anthropic price table: `LIFEOS/TOOLS/vendor-pricing.json`
- Pulse usage module: `LIFEOS/PULSE/modules/usage.ts`
- Statusline money row: `LIFEOS/TOOLS/StatusLineMoney.ts` (entry point `LIFEOS/LIFEOS_StatusLine.sh`, renderer `LIFEOS/STATUSLINE/Render.ts`, cache reader `LIFEOS/STATUSLINE/producers/Overage.ts`)
