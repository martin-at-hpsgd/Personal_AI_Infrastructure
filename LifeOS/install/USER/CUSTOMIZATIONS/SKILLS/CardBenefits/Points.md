---
provenance: template
version: 1.0.0
---

# Points

Balances, valuations, transfer partners, and standing preferences. **UpdatePoints** overwrites a balance row in place with today's date in `As of` and source `principal` (or `statement` when you point at one). **PlanRedemption** reads valuations and transfer partners first and asks for current numbers when a balance is `UNKNOWN` or stale.

## Balances

| Program | Balance | As of | Source |
|---------|---------|-------|--------|
| Acme Points | 85,000 | 2026-01-15 | principal |

## Redemption valuations

Planning heuristics in cents per point, not facts. Verify live award pricing before booking.

| Program | Portal (¢/pt) | Transfer sweet spot (¢/pt) | Notes |
|---------|---------------|----------------------------|-------|
| Acme Points | 1.25 | 1.8 | Heuristic only |

## Transfer partners

| Program | Partner | Ratio | Transfer time | Notes |
|---------|---------|-------|---------------|-------|
| Acme Points | Example Air | 1:1 | instant | |

## Standing preferences

Durable travel preferences the skill learns from you (regions, cabin, hotel taste). PlanRedemption plans for the default travel party below unless a request says otherwise, and appends new preferences here.

- Default travel party: 2 seats, 1 room.
