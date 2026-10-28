---
provenance: template
version: 1.0.0
---

# Apple Health → LifeOS: Shortcut and ingest setup

`LIFEOS/TOOLS/HealthSync.ts` pulls Apple Health through the `apple` source
module (`LIFEOS/TOOLS/healthsync/apple.ts`). It has two transports and picks
one at run time:

1. **REST (preferred):** an ingest Worker that the Health Auto Export app posts
   to, drained over HTTPS. Used when both `HEALTH_INGEST_URL` and
   `HEALTH_DRAIN_TOKEN` are set in `~/.claude/.env`. See § E.
2. **File (fallback):** an iPhone Shortcut that writes one JSON file into iCloud
   Drive. Used when the two env keys are absent. See § A–D.

Until one of them delivers data, `HealthSync.ts` reports the source as
`awaiting-first-export` and points back to this file. The path and field
contract below is duplicated in `apple.ts`; keep the two in sync if you change
either.

## A. The export file (file transport)

The Shortcut must save to exactly this path on the Mac running LifeOS:

```text
~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/LifeOS/health-export.json
```

That is iCloud Drive → Shortcuts → `LifeOS/health-export.json`. Create the
`LifeOS` folder in the Shortcuts iCloud folder once; the Shortcut overwrites the
file on every run. If iCloud has evicted the file, the sync tool asks
`brctl download` for it before giving up.

## B. The JSON contract

One flat object. `exported_at` is an ISO timestamp used to pick the day the
numbers belong to; every other key is a number (strings with commas are
tolerated) and may be omitted when Health has nothing.

```json
{
  "exported_at": "2026-01-01T07:30:00-08:00",
  "steps": 8421,
  "active_energy_kcal": 512,
  "exercise_minutes": 34,
  "resting_hr": 56,
  "hrv_ms": 48,
  "weight_kg": 80.2,
  "sleep_hours": 7.4
}
```

`sleep_hours` is merged monotonically (the larger of two exports for the same
day wins); every other key is replaced by the latest export.

## C. Building the Shortcut (Shortcuts app on iPhone)

1. New Shortcut, name it `LifeOS Health Export`.
2. For each metric add **Find Health Samples** (today, the relevant type) →
   **Calculate Statistics** (Sum for steps, energy, exercise, sleep; Average
   for resting HR and HRV; Latest for weight).
3. **Get Current Date** → **Format Date** (ISO 8601) → this is `exported_at`.
4. **Dictionary** with the keys from § B, values from the steps above.
5. Pass the Dictionary straight to **Save File**, destination iCloud Drive →
   Shortcuts → `LifeOS/health-export.json`, Overwrite on.
6. Run it once by hand and confirm the file appears on the Mac at the § A path.

## D. Scheduling the Shortcut

Add a Personal Automation: **Time of Day**, daily, early morning, Run
Immediately, Notify off, action **Run Shortcut → LifeOS Health Export**.
A second run in the evening catches the day's steps and exercise.

Then let LifeOS pull on its own schedule (the health sync launchd job), or run
it by hand:

```bash
bun ~/.claude/LIFEOS/TOOLS/HealthSync.ts
```

## E. The ingest Worker (REST transport)

The REST transport replaces the Shortcut with the **Health Auto Export** app
posting to a small buffer Worker you deploy. The sync tool talks to it with a
Bearer token and two endpoints:

| Call | Sent by `apple.ts` | Expected |
|------|--------------------|----------|
| `POST <HEALTH_INGEST_URL>/drain` | `Authorization: Bearer <HEALTH_DRAIN_TOKEN>` | `{"payloads":[{"key":"...","body":{...}}]}` — every buffered export, NOT deleted yet |
| `POST <HEALTH_INGEST_URL>/ack` | same header, JSON `{"keys":[...]}` | 2xx; the Worker deletes those keys |

Drain is at-least-once: a failed ack just re-drains next run, and the day-file
merge is idempotent. Each drained body is spooled to disk before normalizing,
so a bad payload never loses data.

Setup:

1. Deploy a Worker (KV or D1 backed) that accepts the Health Auto Export POST,
   stores each payload under a sortable key, and serves `/drain` and `/ack` as
   above behind the Bearer token.
2. In `~/.claude/.env` set `HEALTH_INGEST_URL=https://your-worker.example.com`
   and `HEALTH_DRAIN_TOKEN=<the token>`.
3. In Health Auto Export, add an automation: REST API, your Worker's ingest URL,
   JSON, the metrics you want, daily.
4. Run `HealthSync.ts` and check the status line for `apple: ok`.

## Related

- `HEALTH/README.md` — how the curated health files here fit together.
- Oura and other sources are configured through their own env keys, not here.
