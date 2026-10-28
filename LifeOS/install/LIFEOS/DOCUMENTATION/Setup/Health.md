---
version: 1.0.0
---

# Health

Status: `bun LIFEOS/TOOLS/HealthSync.ts status` · optional

## What it does

HealthSync collects your daily numbers from up to four places and writes them to `LIFEOS/USER/HEALTH/current.json`, plus one file per day under `LIFEOS/USER/HEALTH/DATA/`. Pulse's Health tab and the health score in your life dashboard read those files. The four sources are Oura, Eight Sleep, Apple Health and Function Health. Each is optional; a source you have not set up simply reports `unconfigured`.

Apple Health has a second tool, AppleHealthImport, for the one-time history. It reads the full export from the Health app and writes `APPLE_HEALTH.md` (the summary Pulse lists) and one day file per day of history.

The other files in `LIFEOS/USER/HEALTH/` (`HEALTH.md`, `METRICS.md`, `FITNESS.md`, `NUTRITION.md`, `CONDITIONS.md`, `MEDICATIONS.md`, `PROVIDERS.md`) are notes you write yourself. No tool overwrites them. The whole folder stays private: the public profile builder skips it, and it never ships in a release.

## Fill in

Start with one source and add the rest later.

**Apple Health, full history.** In the Health app on your iPhone, tap your picture, then Export All Health Data. Copy the zip to this Mac and run:

```bash
bun LIFEOS/TOOLS/AppleHealthImport.ts <path-to-export.zip> --days-out
```

`--days N` sets the summary window (default 90 days), `--days-out` also writes the per-day history, and `--dry-run` prints the markdown without writing anything. Exports can be several gigabytes; the tool streams them, so it stays small in memory.

**Apple Health, every day.** Two routes feed `HealthSync` after that: an iPhone Shortcut that saves one JSON file to iCloud Drive, or the Health Auto Export app posting to a small Worker you deploy. `LIFEOS/USER/HEALTH/SHORTCUT_SETUP.md` has the exact file path, the JSON fields, and the steps for both. HealthSync uses the Worker route when both `HEALTH_INGEST_URL` and `HEALTH_DRAIN_TOKEN` are set, and the file route otherwise.

**Oura.** Create an app in the Oura developer portal and register `http://localhost:8474/callback` as its redirect address. Put the client id and secret in `.env` (next section), then run `bun LIFEOS/TOOLS/HealthSync.ts auth oura`. A browser opens for consent and the tokens are saved for you.

**Eight Sleep and Function Health.** Set their keys in `.env`. There is no separate login step. Accounts that sign in through a third party (SSO) or need a second factor cannot use password login, so HealthSync pauses them after repeated failures and records the reason in `current.json`.

**Run it on a schedule.** HealthSync does nothing by itself. To pull every hour, install the opt-in job once: `bun LIFEOS/TOOLS/InstallHealthSync.ts` (`--status` checks it, `--uninstall` removes it).

## Accounts and secrets

Put these in `~/.claude/.env`. Set only the ones for sources you use:

| Source | Keys |
|---|---|
| Oura | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` |
| Eight Sleep | `EIGHTSLEEP_EMAIL`, `EIGHTSLEEP_PASSWORD`, `EIGHTSLEEP_CLIENT_ID`, `EIGHTSLEEP_CLIENT_SECRET` |
| Function Health | `FUNCTION_HEALTH_EMAIL`, `FUNCTION_HEALTH_PASSWORD` |
| Apple Health (Worker route) | `HEALTH_INGEST_URL`, `HEALTH_DRAIN_TOKEN` |

Check that a key is present without printing it: `bun LIFEOS/TOOLS/Secrets.ts has OURA_CLIENT_ID`. Oura and Eight Sleep tokens are written by the tool to `LIFEOS/MEMORY/STATE/healthsync-tokens.json` with owner-only permissions; do not copy or edit that file.

## Prove it works

Pull once, then check freshness:

```bash
bun LIFEOS/TOOLS/HealthSync.ts pull
bun LIFEOS/TOOLS/HealthSync.ts status
```

`status` prints one line per source. `ok; fresh=yes` means the source delivered data in the last 25 hours. `unconfigured` and `awaiting-first-export` mean you have not set that source up, and they do not count against the result. The command exits 0 when every configured source is fresh and 1 when one is stale or when `current.json` does not exist yet. Before your first `pull` it prints `current.json missing` and exits 1, which is expected. `bun LIFEOS/TOOLS/HealthSync.ts current` prints the file itself.

With Pulse running, the Health tab's data comes from this endpoint, which should print `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:31337/api/life/health
```

For the whole-install view, run `bun LIFEOS/TOOLS/SetupInventory.ts status`. Health reads `ready` once `current.json` exists.
