# USStats

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FRED_API_KEY >/dev/null && test -f ~/.claude/LIFEOS/USER/DATA/US-Common-Metrics/US-Common-Metrics.md && echo ok · optional

## What it does

USStats answers two kinds of question about the United States. The long-run almanac side ("is crime getting better or worse over decades?") reads a public JSON almanac whose address you set once as `data_url` (see Fill in). The live-economy side pulls about 66 current indicators from the Federal Reserve's FRED service, the EIA (gas price) and Treasury FiscalData (federal debt) into a local dataset, and builds the 10, 5, 2 and 1 year trend report. That second side needs one key and a one-time seeding of the dataset folder.

## Fill in

### Install config

`<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/USStats/Config.md` (the installer puts a starter there; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited), one `key: value` per line:

| Key | Required | Meaning |
|---|---|---|
| `data_url` | yes, for Analyze and SyncCheck | the almanac JSON endpoint, schema in SKILL.md § Data Contract; env `USSTATS_DATA_URL` overrides it |
| `site_name` | no | name shown in the CLI help |
| `seed_source` | no | where the seed files below come from, printed when the dataset is unseeded |
| `seed_checkout_hint` | no | the checkout path hint printed beside it |

### Dataset folder

One folder of three files, plus one methodology note. By default it is `~/.claude/LIFEOS/USER/DATA/US-Common-Metrics/`; set `USMETRICS_DATA_DIR` to use another folder.

```bash
mkdir -p ~/.claude/LIFEOS/USER/DATA/US-Common-Metrics
# copy these from the seed named by seed_source in your Config.md:
#   US-Common-Metrics.md  us-metrics-current.csv  us-metrics-historical.csv  source.md
```

The updater rewrites `US-Common-Metrics.md` in place and never invents it. A folder without that file stops with "dataset not seeded" before any fetch. If you keep a checkout of the seed dataset, you can skip the copy and point at it instead:

```bash
export USMETRICS_DATA_DIR=~/Projects/example-metrics/Data/US-Common-Metrics
```

| File | Role |
|---|---|
| `US-Common-Metrics.md` | The master document. Required before the first update. |
| `us-metrics-current.csv` | Overwritten on each update with the latest snapshot. |
| `us-metrics-historical.csv` | Appended to on each update; created with its header if missing. |
| `source.md` | Methodology. Not read by the updater. |

## Accounts and secrets

Add these to `~/.claude/.env`:

- `FRED_API_KEY` (required for the live side): a key from the FRED API key page at https://fred.stlouisfed.org/docs/api/api_key.html. FRED carries 64 of the 66 fetched indicators.
- `EIA_API_KEY` (optional): a key from the U.S. Energy Information Administration's open-data service. Without it the gas price is skipped with a warning and everything else still updates.

Treasury FiscalData and the almanac endpoint need no key. The tools read the process environment, and Bun loads `.env` from the directory you run it in, so run them from `~/.claude` or export the variables in your shell.

## Prove it works

```bash
cd ~/.claude
bun skills/USStats/Tools/UsStats.ts summary
bun skills/USStats/Tools/UpdateSubstrateMetrics.ts --dry-run
```

The first command needs no key and prints the almanac summary. The second fetches every live metric and writes nothing. Success is `Fetched 66/66 metrics` (fewer, with a `Failed:` line naming each one, if a key is missing or a source is down), followed by `[DRY RUN] Would write:` with byte counts for the three dataset files and a few sample CSV rows. If it prints `dataset not seeded`, finish the Fill in step; if it exits on a missing `FRED_API_KEY`, add the key.

Then ask your assistant "how is the economy?" for the trend report, or run the update without `--dry-run` to refresh the dataset files.
