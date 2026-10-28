---
version: 1.0.4
---

# Errata intake — the contract an app implements

> Your apps give their users one easy way to
> complain, ask for a feature, or say "I hate this", and every such signal
> reaches the LifeOS Errata ledger tagged with that user's context. The app
> stores; LifeOS pulls. No app ever writes to the LifeOS ledger directly and
> no LifeOS secret ever lives in an app.

## What the app stores

One row per signal in its own database (D1 table `errata`), a strict subset of
`LIFEOS/ERRATA/Schema.ts`:

```json
{
  "id": "ERR-20260917-181415-f927",
  "ts": "2026-09-17T18:14:15.000Z",
  "system": "your-app",
  "instance": "<tenant id>",
  "source": "customer",
  "channel": "app-widget",
  "kind": "complaint",
  "rating": null,
  "complaint": "verbatim words",
  "context": {
    "requested": "what the user was trying to do (page, query, action)",
    "doing": "what the app was doing (endpoint, job)",
    "response_preview": "what the app showed, if a response drew the complaint",
    "component": "page or feature name",
    "version": "app version",
    "session_id": "app session id"
  },
  "reporter": { "id": "<stable user id>", "role": "customer", "name": null, "contact": null },
  "tags": []
}
```

Rules:

- `id` uses the same `ERR-YYYYMMDD-HHMMSS-xxxx` shape so ids are unique across systems.
- `reporter.id` is a stable opaque user id, never an email or name in the clear.
  `contact` is filled only when the user explicitly asks to be followed up.
- `complaint` and every context field pass the app's own secret redaction before storage.
- Rows are append-only. Status and enrichment are LifeOS-side; the app never writes them.
- The widget is whatever fits the product: a typed box, a voice note transcribed
  client-side, or a one-click "this is wrong" on any answer. All three land as the same row.

## What the app exposes

`GET /api/errata?since=<ISO>&limit=<n>` behind the app's existing admin
authentication (Bearer header, never a token in the URL), returning
`{ rows: Erratum[], next: <cursor|null> }` ordered by `(ts, id)`, so two rows with the same `ts` have a fixed order. `next` is the opaque cursor of the last row returned (its `ts` and `id`), and `since` takes either an ISO timestamp (rows at or after it, for a first pull) or a cursor (rows strictly after that `(ts, id)`), so a page boundary inside a run of equal timestamps neither skips rows nor repeats a page. `next` is `null` when no rows remain.

## What LifeOS does

`bun LIFEOS/ERRATA/Errata.ts sync --system your-app` (M2, planned: `Errata.ts` has no `sync` command yet, so nothing is pulled today) is meant to pull new rows since the
last watermark, validate each against the schema, set `dedupe_key` to
`<system>:<id>` so a re-pull is idempotent, and append them to the ledger.
From there they are enriched and triaged like every other erratum, and a
cluster of customer complaints files an Upgrades record with the app as its
target surface.

## Order of adoption

Adopt the intake contract for your apps in the order that fits your rollout. Each app's ISA carries the intake criteria;
this contract does not change per app.
