---
last_updated: 2026-10-08T07:00:00.000Z
last_updated_by: da
convention: lifeos-freshness-v1
version: 1.1.7
---

# Location

LifeOS knows where the principal is from their iPhone, and from any of their Macs running Seat when the phone goes quiet. Every location-aware part of the system reads that one answer. ISA: `LIFEOS/LOCATION/ISA.md` (not in the public release).

## How it works

```
iPhone (Overland) ─┐
Mac (Seat) ────────┴→ Location Worker + D1 → sync-location (every 5 min) → USER/LOCATION/current.json → here()
```

- **The phone.** [Overland](https://github.com/aaronpk/Overland-iOS), an open-source tracker, records location in the background and posts batches of GeoJSON points with a write-only bearer. It queues offline and sends when it can. It is the primary source.
- **A Mac.** Seat, the menu bar presence app, adds the Mac's own CoreLocation fix (Wi-Fi positioning, so coarser than the phone) to the presence post it already sends every two minutes, once the principal allows Location for it. Share Location in its menu turns this off. The Worker keeps these fixes in their own `device_points` table under the Mac's label, and `/latest` returns the newest fix from any device, so a Mac fix only wins once the phone has gone quiet; on a tie the phone wins. `current.json` `source` says which device it came from (`overland` or the label), and `Location.ts now` says "from the laptop" when it is not the phone. The statusline header shows the fix's age once it is over 30 minutes old, and STALE past the stale window.
- **A desktop at home.** A desktop Mac (no internal battery in `pmset -g batt`) never leaves home, so when the phone's fix is past the stale window (or the current fix is a plane's, since he cannot be on a flight and at his desk at once) and that Mac's keyboard was used in the last 10 minutes, the sync writes a fix at home stamped now (`source` `this-mac`). Everything place-aware (header, clock zone, weather, tides, watches) follows it within a minute. The phone's own fresh fix replaces it as soon as one arrives, and the stale alert and the receiving check still judge the phone alone, so a quiet phone still texts.
- **The Worker** (`LIFEOS/LOCATION/worker`, workers.dev, own D1). `POST /overland` takes the write bearer and answers `{"result":"ok"}`, which is what Overland needs before it drops a batch. `GET /latest` takes the read bearer and returns the newest fix by device time within an accuracy limit (3 km by default), so a coarse cell-tower fix never displaces a better recent one. Bearers are stored as hashes with a scope, so a leaked phone token can write but never read. No SSID, device id or unique id is stored. A daily cron deletes points older than seven days.
- **The sync** (`Location.ts sync`, the `sync-location` workflow). Reads the read bearer from the login Keychain, pulls the newest fix, and writes `USER/LOCATION/current.json` (mode 0600, atomic, git-ignored). That file holds the exact point, accuracy, fix time, city, region, country, timezone, distance from home and an at-home flag. City and zone come from Nominatim and Open-Meteo at two decimals, and only when the fix has moved more than 5 km.
- **The reader** (`Here.ts`). `here(home)` returns where he is, rounded to two decimals. A fix older than the stale window (6 hours by default) still gives the last known place, marked `stale: true` with its age, and `principalTimezone()` keeps that place's zone. Only a missing or corrupt fix gives the home with `fallback: true` and `at_home: null`. It never touches the network and never throws.

## Who reads it

| Reader | What follows him |
|---|---|
| Every prompt (`hooks/lib/presence-context.ts`) | When the principal is not at this Mac, a `<principal-reach>` block names the principal's device, place and `reachFor()` channels, so anything the principal must act on reaches them as a share link, a tailnet Pulse URL, the real public URL or a text, never as "do it on the desktop". Silent at this Mac. Composed by HookBridge `prompt-context`, or TimeContext when the plugin is not loaded. |
| `principalTimezone()` | The zone of a fresh fix wins over the configured zone; `LIFEOS_TIMEZONE` still wins over both. |
| Quiet hours (`TOOLS/QuietHours.ts`) | The window is read in `principalTimezone()`, so on a trip it follows his local clock. |
| Watches (`loadPlaces().here`) | Weather alerts, local quakes and near fire check his point as well as home when he is away. The darksky, ISS and aurora watches compute for his point. Home-bound watches (tides, power-utility outages, city notices, wastewater, highway incidents, aircraft, concerts) stay at the house. |
| Public profile (the optional daemon-profile skill, if installed) | Only on the principal's command, never on a schedule. Inside the home area the profile shows its default. Away, it shows the region, or the city when he asks. A public venue he names shows for six hours, and only if it is within 2 km of his fix. |

## Optional neighbours

`Here.ts`, `Location.ts` and the Worker import nothing outside this folder except the shared path and invariant helpers, so they work on an install without the rest (`pair` also loads `TOOLS/TextFormat.ts` and calls the Relay bridge's `send.ts` at run time). Vigil events, the sync heartbeat and the watches' home point load at run time when those parts are present. With no watches, the home point comes from `home` (`{ "lat", "lon", "timezone" }`) in `USER/LOCATION/config.json`. A test (ISC-51) fails if a static import into a private part comes back.

## Guards

- **Jumps.** A fix that implies more than 300 m/s from the last accepted one is held until a second fix within 5 km confirms it. A six-hour flight is not a jump.
- **Timezone flips.** The zone in `current.json` changes only after two consecutive syncs agree on it.
- **The receiving check** (`Location.ts receiving`, the `location-receiving` workflow, every 10 minutes). It watches the service from outside the sync, because a stopped sync cannot report its own silence. It raises `stale` when the newest fix is older than `stale_hours`, and `sync_down` when the sync has not written `state.json` for 10 minutes. Both are `high` events. It keeps its own record in `receiving.json` and never writes the sync's files. Its `stale` shares the sync's cooldown, so a quiet phone texts once, whichever one notices first.
- **Vigil events** (source `location`). The phone going stale is a `high` event, so it reaches the principal as a text; its threshold is `stale_hours`. The phone going stale, coming back, the Worker failing three syncs in a row, and the read bearer being refused are separate events, and each fires at most once per 12 hours. No event or log line carries a coordinate past two decimals.

## Commands

```bash
bun LIFEOS/LOCATION/Location.ts now [--json]     # "City, Region, 4 minutes ago, away from home, 3900 km out."
bun LIFEOS/LOCATION/Location.ts sync             # what the workflow runs
bun LIFEOS/LOCATION/Location.ts health           # the Worker's /health
bun LIFEOS/LOCATION/Location.ts pair             # new phone bearer; texts your own line a one-time setup link
bun LIFEOS/LOCATION/Location.ts rotate read      # new Mac bearer into the Keychain; old one revoked
bun LIFEOS/LOCATION/Location.ts rotate write     # new phone bearer; Overland setup link to the clipboard, never stdout
```

## Setting up the phone

1. Install Overland from the App Store and allow location **Always**.
2. Set `d1_tool` in `USER/LOCATION/config.json` to a CLI that runs as `<tool> d1 query <database-id> --sql <sql>` (no such tool ships with LifeOS; without it `pair` and `rotate` stop and name the setting), then run `Location.ts pair`. It mints a phone bearer and texts the principal's own line a one-time link (`/setup/<code>`, single use, 15 minutes). Opening it on the iPhone redirects to Overland's setup scheme, which fills in the URL and token. The bearer itself never enters a message. (`rotate write` does the same through the clipboard when the phone is next to the Mac.)
3. In Overland, set Continuous Tracking Mode to **Both** (significant changes plus visits), Desired Accuracy to **100 m**, and Send Interval to **5 minutes**. Turn tracking on.

## Lost phone or leaked token

Run `Location.ts rotate write` (the old phone bearer stops working at once) and, if the Mac is in doubt, `rotate read`. The trail on the Worker ages out within seven days.
