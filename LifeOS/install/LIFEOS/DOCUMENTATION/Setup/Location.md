---
version: 1.0.2
---

# Location (where you are, from your phone)

Status: `bun LIFEOS/LOCATION/Location.ts now` · optional

## What it does

Location gives LifeOS one answer to "where am I right now", read from your iPhone. Your timezone, quiet hours and any weather, quake or fire watches then follow you when you travel instead of staying at home. The answer is one small file on your Mac that everything reads, rounded to about a kilometre when it leaves that file. The design is in `LIFEOS/DOCUMENTATION/Location/LocationSystem.md`.

The path has four parts: the Overland app on your phone sends batches of positions to a small Cloudflare Worker you own; every five minutes your Mac asks the Worker for the newest position and writes `LIFEOS/USER/LOCATION/current.json`. If the phone goes quiet for six hours, readers fall back to your home point and say so.

## Fill in

Edit `LIFEOS/USER/LOCATION/config.json`. The template ships with a placeholder home at latitude 0, longitude 0.

| Key | Meaning |
|---|---|
| `home` | `{ "name", "lat", "lon", "timezone" }`. Your home point and its IANA timezone (for example `America/Chicago`). Replace the 0,0 placeholder before your first sync. |
| `url` | Your Worker's address, such as `https://your-worker.example.workers.dev`. Add it once the Worker is deployed; sync and health refuse to run without it. |
| `stale_hours` | How old a position may be before readers fall back to home. Default 6. |
| `home_radius_m` | How close counts as at home. Default 500. |

## Accounts and secrets

Location depends on pieces that live outside the LifeOS tree:

- Overland, an open-source iOS tracking app from the App Store. It is not part of LifeOS and has its own settings.
- A Cloudflare account and a Worker with its own D1 database, which you build and deploy in your own account. This release does not ship the Worker's code, so build it to the contract below with your own Cloudflare tooling. The `pair` and `rotate` commands in `Location.ts` call a Cloudflare skill that is not in this release, so those two do not work here.

  | Route | Key | What it does |
  |---|---|---|
  | `GET /health` | none | Answers 200. |
  | `POST /overland` | the write key, as `Authorization: Bearer <key>` | Takes Overland's batch of GeoJSON points, stores one row per fix (keyed on the phone's own fix time, so a replayed batch adds nothing), and answers `{"result":"ok"}`. Overland drops a batch only after that answer. |
  | `GET /latest` | the read key, as `Authorization: Bearer <key>` | Answers `{"point": {"fix_at", "lat", "lon", "accuracy_m", "motion", "battery"}}` for the newest fix by fix time within an accuracy limit (3 km by default), or `{"point": null}`. A missing or unknown key gets 401, and the write key gets 403. |

  The Worker never stores a key itself, only its SHA-256 hash with a scope, in a `tokens` table of name, token_hash and scope (`read` or `write`), so a phone key can write but never read. Store no SSID, device id or unique id, and delete points older than seven days. The design is in `LIFEOS/DOCUMENTATION/Location/LocationSystem.md`.
- Your Mac's Keychain, which holds the read key.

Setup, in order:

1. Create the D1 database with a table for points and the `tokens` table, build the Worker to the contract above, bind it to the database, and deploy it. Check `GET <your url>/health` answers 200.
2. Make two random keys, one to read from the Mac and one to write from the phone. The Worker stores only each key's SHA-256 hash in the `tokens` table, as a row of name, hash (lowercase hex) and scope (`read` or `write`). Insert both rows:

   ```sql
   INSERT INTO tokens (name, token_hash, scope) VALUES ('mac', '<sha256 hex of the read key>', 'read');
   INSERT INTO tokens (name, token_hash, scope) VALUES ('phone', '<sha256 hex of the write key>', 'write');
   ```

   A leaked phone key can write positions but never read them.
3. Store the read key in your login Keychain, where `Location.ts` looks for it (service `lifeos-location-read`, account `lifeos`), or export it as `LOCATION_READ_TOKEN`:

   ```bash
   security add-generic-password -U -s lifeos-location-read -a lifeos -w '<the read key>'
   ```

4. In Overland on the iPhone, set the receiver URL to `<your url>/overland`, the token to the write key, and the device id to `iphone`. Allow location **Always**. Set continuous tracking to **Both**, desired accuracy to 100 m and send interval to 5 minutes, then turn tracking on.
5. Add `url` to `config.json`, then schedule the sync. Scheduled work in LifeOS is a workflow (`LIFEOS/DOCUMENTATION/Workflows/WorkflowsSystem.md`; start with `bun LIFEOS/WORKFLOWS/workflow.ts help --json`). Make one that runs `bun LIFEOS/LOCATION/Location.ts sync` every five minutes. No ready-made definition ships.

Geocoding uses two public services without keys, Nominatim for the city and Open-Meteo for the timezone, and only at two decimal places and only when you have moved more than 5 km. No key goes in any file in this folder.

## Prove it works

```bash
bun LIFEOS/LOCATION/Location.ts health
bun LIFEOS/LOCATION/Location.ts sync
bun LIFEOS/LOCATION/Location.ts now
```

`health` prints your Worker's host and `/health 200` and exits 0; with no `url` it prints `no url in config.json` and exits 1. `sync` pulls the newest position and writes `current.json` (it also writes a sync heartbeat file, so it is not a pure read); on a working setup it prints JSON with `"state":"fresh"`. `now` then prints one sentence with the place, how long ago, and whether you are home, such as "Your City, Your Region, 3 minutes ago, at home." Before the first position arrives, `now` exits 0 and prints "I have no location from the iPhone yet.", so a good `now` after a sync, not the exit code, is the proof. `now` prints where you are, so do not paste its output anywhere public.
