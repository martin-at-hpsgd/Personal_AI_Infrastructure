# WastewaterCA

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: bun ~/.claude/skills/WastewaterCA/Tools/Wastewater.ts config · optional

## What it does

This skill answers "how much COVID, flu or RSV is going around in California right now" from wastewater, which tends to lead clinical testing by four to seven days. It reads two public sources each time you ask: CDC's National Wastewater Surveillance System, which gives every treatment plant a viral activity level (Very Low to Very High) for SARS-CoV-2, Influenza A and RSV, and the California Department of Public Health's sample-level data, which covers every pathogen CDPH tests for (including Influenza B, Mpox, Norovirus, H5 and Candida auris). It works statewide out of the box. Tell it which counties you live in and it also answers for that region.

How it is usually run: you ask the assistant in plain words ("COVID levels before my trip?", "how's flu looking in wastewater?") and it runs the bundled `Tools/Wastewater.ts`. Needs: Bun, which LifeOS already uses, and internet access to `data.cdc.gov` and `data.chhs.ca.gov`. No other skill is required. If you want a standing alert when a level jumps, wrap the same command in a scheduled workflow (example below).

## Fill in

Optional. Skip this and every answer is statewide. To add your region, create `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WastewaterCA/Config.md`; the folder under `SKILLS/` is always this skill's own folder name, and `Wastewater.ts config` prints the exact path it looks for. Smallest working example, with made-up choices:

```markdown
---
version: 1.0.0
---

# Wastewater region

- region: Sacramento area
- counties: Sacramento 06067; Yolo 06113; Placer 06061
- rpho region: Greater Sierra-Sacramento
```

| Field | Meaning |
|---|---|
| `region` | The name answers use for your area |
| `counties` | `Name FIPS` pairs separated by `;`. The name is matched against CDC's county text, the 5-digit FIPS code (California's all start `06`) against CDPH's. Look a code up in the US Census county FIPS list. |
| `rpho region` | Optional. Your public-health region in the CHHS Respiratory Virus Dashboard, for test positivity and hospital admissions: Bay Area, Central California, Greater Sierra-Sacramento, Los Angeles, Rural North or Southern California |

To keep a second region on hand, save another file in the same format anywhere and point one run at it with `WASTEWATER_CONFIG`. A made-up example:

```bash
printf -- '- region: Fresno area\n- counties: Fresno 06019; Madera 06039\n' > ~/wastewater-fresno.md
WASTEWATER_CONFIG=~/wastewater-fresno.md bun ~/.claude/skills/WastewaterCA/Tools/Wastewater.ts covid
```

Runs without the variable keep using your main Config.md.

### Extending it: a weekly alert

The skill only reads. If you want to hear about a jump without asking, schedule the read yourself. A generic starting point with made-up names: a small comparison script you own, and a Workflows definition that runs it every Saturday after CDC's Friday update.

`~/wastewater-alert.ts` keeps last week's summary next to itself. A workflow command step must print one JSON value on stdout every run, so the script always prints a summary object. Only when something moved does it also post to Vigil, which routes it to a text, the digest or the dashboard by severity:

```ts
const tool = `${process.env.HOME}/.claude/skills/WastewaterCA/Tools/Wastewater.ts`;
const run = Bun.spawnSync(["bun", tool, "covid", "--json"]);
if (run.exitCode !== 0) throw new Error(run.stderr.toString()); // a failed read fails the run
const now = JSON.parse(run.stdout.toString());
const file = Bun.file(`${import.meta.dir}/wastewater-last.json`);
const last = (await file.exists()) ? await file.json() : null;
await Bun.write(file, JSON.stringify(now));
const levels = ["Very Low", "Low", "Moderate", "High", "Very High"];
const up = last && levels.indexOf(now.mostCommon) > levels.indexOf(last.mostCommon);
const jump = last && now.highOrAbove - last.highOrAbove >= 3; // a first guess; tune it
const alerted = Boolean(up || jump);
if (alerted) {
  const vigil = `${process.env.HOME}/.claude/LIFEOS/VIGIL/Vigil.ts`;
  Bun.spawnSync(["bun", vigil, "emit", "--source", "wastewater-alert", "--kind", "health", "--severity", "medium", "--privacy", "public",
    "--title", `Wastewater levels rose in ${now.region}`, "--summary", `Most common CDC level is now ${now.mostCommon}, week ending ${now.week}.`]);
}
console.log(JSON.stringify({ alerted, region: now.region ?? null, mostCommon: now.mostCommon ?? null, highOrAbove: now.highOrAbove ?? null, week: now.week ?? null }));
```

Save this as `wastewater-weekly.workflow.yaml` in your USER `WORKFLOWS/` folder (`LIFEOS/USER/WORKFLOWS/<name>.workflow.yaml`):

```yaml
version: 2
name: wastewater-weekly
description: "Check California wastewater levels weekly and report a rise."
runs_on: local
destination: the run ledger
triggers:
  - type: schedule
    cron: "17 9 * * 6"
    timezone: UTC   # or your own IANA zone
  - type: manual
steps:
  check:
    kind: command
    side_effects: [ read, write, outbound ]
    recipient: principal
    env: [ VIGIL_STATE_DIR, LIFEOS_NOTIFICATION_CHANNEL ]
    description: "Compare this week's CDC levels with last week's."
    argv: [ sh, -c, 'exec bun "$HOME/wastewater-alert.ts"' ]
    timeout_ms: 120000
    output: { type: object, required: [ alerted ], properties: { alerted: { type: boolean }, region: { type: [ string, "null" ] }, mostCommon: { type: [ string, "null" ] }, highOrAbove: { type: [ number, "null" ] }, week: { type: [ string, "null" ] } } }
```

Check it with `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts validate wastewater-weekly`, then install its schedule with `bun ~/.claude/LIFEOS/WORKFLOWS/engine/schedule-install.ts install wastewater-weekly`. With Vigil's default policy, `medium` waits for the morning digest. A `high` event texts you only once `wastewater-alert` is listed in `text_trusted_sources` in your Vigil policy; until then it shows on the dashboard. To be told somewhere else, swap the `Vigil.ts emit` call for that channel's command.

## Accounts and secrets

None. Both sources are public open-data APIs with no sign-up, and nothing goes in `~/.claude/.env` for this skill.

## Prove it works

```bash
bun ~/.claude/skills/WastewaterCA/Tools/Wastewater.ts config
bun ~/.claude/skills/WastewaterCA/Tools/Wastewater.ts covid --dry-run
bun ~/.claude/skills/WastewaterCA/Tools/Wastewater.ts covid
```

Success: the first command prints your region, counties and the file it read. When it finds no file it prints `Source:  none: no file at <path>` and "none, so every command runs statewide"; if you did create a Config.md, move it to that exact path. The second prints the CDC request URL without touching the network. The third prints a line starting `SARS-CoV-2 wastewater viral activity —` with a week ending date no more than two weeks old and a count of sites at each CDC level. Exit 2 means a county in your Config.md has no valid `06xxx` code; exit 1 with "No ... WVAL rows" means none of your county names matched a CDC site.
