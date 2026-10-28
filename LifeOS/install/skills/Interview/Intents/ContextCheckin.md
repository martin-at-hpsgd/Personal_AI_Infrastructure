# ContextCheckin

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Output format · Gotchas · Examples

The default `/interview` on a populated system: a peer conversation that reviews every stale constitutional, TELOS and state item against what is written and what the data shows, lands only ratified edits, and clears the 🎤 chip.

## Ideal State

- Every item was read before it was asked about: the freshness readers, the evidence panel and, where the work-hub skill is installed, the open work-issue registry were loaded first, and each prompt quotes the file, section or entry it asks about (the source file for a derived one).
- Every interview question reaches the principal through the harness's question tool (`AskUserQuestion` in Claude Code), with the claim and evidence in the question, the drafted edit as the first option marked "(Recommended)", and keep/skip as the others; plain-text questions are only for channels with no such tool (principal directive, 2026-10-15).
- The interview opens on the sharpest claim-vs-evidence contradiction with dates on both sides, falls back to file age only when no live evidence exists, and says which claims are checkable and which rest on a dead source.
- Every file and TELOS section behind the `InterviewDue.ts` reasons is reviewed (edited, or read back and confirmed so its marker bumped) before the wrap, unless the principal gave a stop signal.
- Every approved edit keeps IDs stable (a typed ID is never renumbered, a drop leaves a tombstone, a new entry takes the next sequential ID) and bumps its review marker; a file reviewed and confirmed without an edit is bumped too.
- The quick state check-in is offered and each answered dimension logged, and the ideal-state leg is offered with the measured value beside each target.
- The wrap reports the reviewed and edited counts, and by then the derived summaries were regenerated, `InterviewDue.ts --mark-done` ran (`--partial` only after a stop signal) and the Pulse freshness cache was invalidated.

## Anti-criteria

- No generic "what's your mission?" or "describe your projects" prompt when the context files are populated.
- No claims file (TELOS.md, constitutional, CURRENT_STATE, IDEAL_STATE) is written without the principal approving that specific edit in this conversation.
- No auto-generated file (PRINCIPAL_TELOS, ARCHITECTURE_SUMMARY) is edited directly.
- No interview question is asked as plain text where a question tool exists; no question-tool call carries more than four questions, each one decision about one item; and "call it here" is never offered while agenda items remain.
- No claim is reported as verified when its only source is dead.
- No personal material (health, finances, relationships, private narratives) crosses to a company-context tenant.

## Inputs

The constitutional context files are the seven that load at session start: TELOS plus DA_IDENTITY, PRINCIPAL_IDENTITY, PROJECTS, LIFEOS_SYSTEM_PROMPT, PRINCIPAL_TELOS and ARCHITECTURE_SUMMARY. The CURRENT_STATE and IDEAL_STATE dimension files join them as state items.

For every stale item whose `domain` is non-null, the file's claims and the observed data go side by side before the question. The evidence panel (`StateEvidence.ts --markdown`) carries the observed side: sleep hours, efficiency, HRV, resting HR, steps (Oura); creation vs consumption minutes and top apps (Conduit); sessions and commit cadence (work registry + git); recurring burn (expenses).

Open work issues are candidates for the review. Goal-mirror issues (`goal:GN` labels) must agree with the TELOS Goals section: a goal marked achieved in the interview closes its mirror issue in the same motion, and an open mirror for a dead goal is a contradiction to surface. Sweep, decision and project-check issues show what is actually being worked on, so the "anything missing from Projects?" prompt argues from them instead of asking blind.

## Safety gates

Ratification is the write gate. Drafts are shown in full before landing. The cron path (`InterviewDue.ts --refresh`) writes caches only, never claims files; if a draft is declined, nothing lands and nothing is queued.

- **Constitutional files: surgical edits only.** Never rewrite identity, system prompt, or projects unilaterally — surface findings via ContextAudit, edit only with explicit per-edit approval. Back up first if an edit rewrites 50% or more of any section.
- **Migration must run once before a TELOS check-in works.** A TELOS without YAML frontmatter (no `last_updated:`) returns `fileUpdated: null` and every section reads as stale. Run `bun ~/.claude/LIFEOS/TOOLS/MigrateTelosFreshness.ts` once; idempotent and content-preserving (verifies sha256 of stripped content).

If `readContextFreshness()` reports a file with `why: "no frontmatter"`, the migration hasn't been run on that file. Stop and prompt: *"<file> doesn't have the freshness convention yet. Want me to run `bun ~/.claude/LIFEOS/TOOLS/MigrateContextFreshness.ts` first?"*

If `readContextFreshness()` reports a file with `why: "source missing"`, the file's `derived_from:` source doesn't have a freshness signal — the derivative can't inherit one. Surface this to the principal: *"<file> derives from <source> which has no freshness frontmatter. Want me to add it?"* The usual case is `architecture_summary`, when `LifeosSystemArchitecture.md` has no `last_updated` frontmatter.

The principal can say "next", "skip", "enough", "stop", "later" at any prompt. Honor it immediately. State persists in the files themselves; there's no separate session to save.

## Tool contract

### Readers

```bash
bun ~/.claude/LIFEOS/TOOLS/TelosFreshness.ts --json          # per-section TELOS
bun ~/.claude/LIFEOS/TOOLS/TelosFreshness.ts --state         # CURRENT_STATE/ + IDEAL_STATE/ dimension files
bun -e "import { readContextFreshness } from '$HOME/.claude/LIFEOS/TOOLS/TelosFreshness.ts'; console.log(JSON.stringify(readContextFreshness(), null, 2))"
bun ~/.claude/LIFEOS/TOOLS/StateEvidence.ts --markdown       # observed reality per domain (also refreshes the cache)
```

If `StateEvidence` output is missing or its cache is older than a day, run `bun ~/.claude/LIFEOS/TOOLS/InterviewDue.ts --refresh` once and re-read, so the interview argues from today's data.

The work system is the fifth reader. When the install has a work-hub skill (its repo is named in the install's private config, never in this file), read the open issue registry before reviewing Goals, Projects, or Ideas:

```bash
gh issue list -R <work-repo> --state open --limit 60
```

Or via Pulse (single round-trip):

```bash
curl -s http://localhost:31337/api/freshness | jq      # multi-file constitutional
curl -s http://localhost:31337/api/telos/freshness | jq # per-section TELOS
```

`bun ~/.claude/LIFEOS/TOOLS/InterviewScan.ts --json` produces the combined stale list (TELOS sections, constitutional files and state dimension files, most-stale-first by days over threshold) already prioritized — state targets carry `domain`, `evidence_live`, and `evidence_days_since_review`, and an evidence-backed stale file outranks everything else in its phase. Prefer it over hand-merging.

### Agenda and reading

**The agenda is the verdict.** `bun ~/.claude/LIFEOS/TOOLS/InterviewDue.ts` prints the reasons the 🎤 chip is on: N constitutional files, N state files, domains whose data ran past their claims. Every file and TELOS section behind those reasons is on the agenda (principal directive, 2026-09-06); `--mark-done` enforces it at the wrap.

- TELOS sections: pass the line range — start at `section.line + 2` (skip heading + marker), continue until the next `## ` heading.
- Constitutional files: read the full file (most are <300 lines).
- Derived files: read the SOURCE — `PRINCIPAL_TELOS` review goes to `TELOS.md`, `ARCHITECTURE_SUMMARY` review goes to `LifeosSystemArchitecture.md`. Update the source; the derivative regenerates.

### Writing and the review marker

Typed-ID entries keep their ID and change only the entry text. Prose sections and files are edited in place, preserving heading + marker line + frontmatter. A deletion leaves a tombstone: `- [ ] G3: [DROPPED — see Decisions YYYY-MM-DD]`.

`last_reviewed:` is the freshness clock — explicitly distinct from `last_updated:`, which migrations and auto-generators also bump. The statusline FRESH line and the A-F grade in `/api/freshness/summary` are computed from `last_reviewed:`, and no other path sets it, so a file this intent skips stays at grade F. Only this intent (and equivalent principal-driven review flows) should call it.

```bash
# TELOS section — section-level marker
bun ~/.claude/LIFEOS/TOOLS/TelosFreshness.ts --bump <slug>

# Constitutional file OR state dimension file — review marker
# (NOT bumpContextTimestamp; that's for writes)
bun -e "import { bumpReviewedTimestamp } from '$HOME/.claude/LIFEOS/TOOLS/TelosFreshness.ts'; console.log(bumpReviewedTimestamp('<absolute-path>', 'user'))"
```

Bump on every approved edit: `bumpTelosTimestamp` (the `--bump` CLI) for TELOS sections, `bumpReviewedTimestamp` for constitutional and state dimension files. A ratified-or-declined-with-review walk of a CURRENT_STATE/IDEAL_STATE file counts as a review even when no edit landed (the principal looked and said "still right"). `bumpContextTimestamp` is for file writes (auto-generators, migrations) and does not count as review.

### State check-in and ideal-state gap

One question, early in the wrap: the principal's current short-form state — the 1-5 journal, higher is better, 3 fine (H overall, M mood, S sleep, R relationships, F financial, CF creative freedom; principal directive 2026-08-16). If `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interview/PREFERENCES.md` § State check-in priority names a dimension, ask it first; without that file every dimension carries equal weight. If the statusline segment shows a `?` (stale >36h) on any dimension, lead with those.

Log each answered dimension through the state tool (never guess an unanswered one). A workout or walk mentioned anywhere in the conversation also earns a reset:

```bash
bun ~/.claude/LIFEOS/TOOLS/State.ts log "M2" --source interview
bun ~/.claude/LIFEOS/TOOLS/State.ts reset W     # or K
```

After the current-state pass — or immediately if the principal asks for it — offer the ideal-state review. Walk only IDEAL_STATE files that are cadence-expired (stale in `--state` output) or whose gap moved materially. Read the IDEAL_STATE file (or the TELOS `## Ideal State` section) and put the observed number from the evidence panel beside each metric target. For target rows that carry a `measure:` binding, `bun ~/.claude/LIFEOS/IDEALSTATE/IdealState.ts gap` gives the measured value and pace from the daily reconcile; unbound rows still need the evidence panel.

### Wrap

```bash
bun ~/.claude/LIFEOS/TOOLS/TelosFreshness.ts        # final TELOS state
bun ~/.claude/LIFEOS/TOOLS/ContextAudit.ts          # content quality findings (read-only)
```

Regenerate the auto-derived files so future sessions pick up source changes:

```bash
bun ~/.claude/LIFEOS/TOOLS/GenerateTelosSummary.ts 2>/dev/null || true
bun ~/.claude/LIFEOS/TOOLS/ArchitectureSummaryGenerator.ts generate 2>/dev/null || true
```

Record completion and refresh every cache the statusline and next session read — this is what silences the 🎤 chip. It refuses (exit 2) while agenda items remain; `--partial` is only for a principal stop signal and leaves the chip on:

```bash
bun ~/.claude/LIFEOS/TOOLS/InterviewDue.ts --mark-done            # agenda empty
bun ~/.claude/LIFEOS/TOOLS/InterviewDue.ts --mark-done --partial  # principal said stop
```

Invalidate the Pulse freshness cache:

```bash
curl -s -m 5 -X POST http://localhost:31337/api/freshness/invalidate > /dev/null 2>&1 &
```

**Company-context sync.** Installs with a company-context gateway skill (a private skill, not in the public release payload) push any ratified company-relevant slice — business goals, work strategies or projects, company state — to that tenant as a draft revision, selectively; personal material never crosses. Installs without it skip this step.

## Output format

Each quoted prompt below is the `question` text of an `AskUserQuestion` call; the reply around it carries the evidence table and any CHANGE/VERIFY from the last item. Options follow one shape: the drafted edit first as "(Recommended)" with the draft in its `preview`, then keep-as-written, then skip. Related items with no dependency between them (Mission and Narratives, say) go in one call, up to four.

```
AskUserQuestion({ questions: [{
  header: "Health",
  question: "CURRENT_STATE/HEALTH.md (reviewed {age}d ago) says sleep {claimed}h; Oura 30d through {date} says {observed}h over {n} nights. Take the corrected row?",
  options: [
    { label: "Take the draft (Recommended)", description: "Replace the sleep row and bump the review marker.", preview: "- **Sleep:** {observed}h avg … — status: partial" },
    { label: "Keep as written", description: "Bump the review marker, no text change." },
    { label: "Skip for now", description: "Leave it on the agenda." } ],
  multiSelect: false }] })
```

### Evidence lead

> "**CURRENT_STATE/HEALTH.md** (last reviewed {N}d ago) says: *'{claim}'*. The data since then: {metric} averaged {value} over the last 30d (through {date}). That row is wrong/confirmed — here's the corrected line: *'{draft}'*. Take it, edit it, or leave it?"

### Opening

> "I read your context. **<File or section>** hasn't been touched in **{N}d** (threshold {T}d). It says: *'{first 80–120 chars}'*. Still right? Want to update it?"

With several stale items, name the agenda once so the principal knows the length of the walk, then start at the top without asking which one; the order is the priority order:

> "Seven things overdue: Mission, Challenges, Narratives, Predictions, Frames, Wisdom, Ideal State. Starting with Mission — **M0** says …"

If everything is fresh:

> "All seven constitutional files within thresholds. Anything you want to revisit anyway, or pick a section to deepen?"

### Registers by file type

| Item | Register |
|------|----------|
| TELOS sections with typed IDs (Goals → G0+, Problems → P0+, Mission → M0+, Beliefs → B0+, Models → MO0+, Frames → FR0+, Narratives → N0+, Challenges → C0+, Traumas → TR0+) | Per-entry contextual prompts quoting the entry: "**G3** says: *'{first sentence}'*. Where are we on this?" |
| TELOS sections without typed IDs (Current State, Status, Sparks, Wisdom, preferences) | Section-level: quote the first lines, ask what is actually true today. |
| DA_IDENTITY.md | Personality, autonomy boundaries, anything new about the working dynamic. A changed DA name or voice goes to `LIFEOS_CONFIG.toml` `[da]` / `[da.voices.main]`, never this file, then `skills/LifeOS/Tools/RenderIdentity.ts --apply --strict`. |
| PRINCIPAL_IDENTITY.md | Role, focus, online presence, as the Quick Reference states them. A changed name, pronunciation or timezone goes to `LIFEOS_CONFIG.toml` `[principal]`, never this file. |
| PROJECTS.md | New projects to add, finished projects to retire, whether routing aliases still match how the principal refers to things. |
| LIFEOS_SYSTEM_PROMPT.md | Constitutional rules. Default to surfacing rather than editing: this is the most load-bearing file in the system. |
| PRINCIPAL_TELOS.md / ARCHITECTURE_SUMMARY.md (auto-generated) | Never edited directly; the review goes to the source file and says so: *"PRINCIPAL_TELOS derives from TELOS.md — going there. TELOS.md last touched {N}d ago."* |
| State files, evidence-mapped and populated (HEALTH, FINANCIAL, and the TELOS `## Current State` section) | Claim vs evidence in the Evidence lead shape. I draft the corrected text from the data; the principal ratifies, edits, or declines. Every landed edit updates any inline dates. |
| State files, evidence-backed but placeholder-dead (ACTIVITY, CONSUMPTION, SNAPSHOT — TBD since scaffolding) | A full draft generated from the evidence (Conduit for ACTIVITY/CONSUMPTION, the health cache for SNAPSHOT's sleep/energy rows) and **ratify or retire** per file. Adopting means I keep drafting it at each interview. Retiring means moving it to `TELOS/Backups/` and noting it in Decisions — never leaving a corpse that reads as claims. |
| State files, not evidence-mapped (SOCIAL, SIGNALS, RELATIONSHIPS, …) | Read, quote, ask "what's actually true today?" |
| IDEAL_STATE files | Only in the ideal-state leg, never as cold "review this file" prompts. |

### State check-in and ideal-state leg

> "Quick state check — mood, sleep, overall, creative freedom? 1-5, e.g. `M4 S2 H3 CF4`, or skip." (One question-tool call, one question per dimension, up to four, with options 2, 3, 4 and 5; the tool caps options at four, so a 1 or a note arrives through Other.)

> "**IDEAL_STATE/HEALTH.md** targets {metric} {target}. Measured: 30d average {v} (through {date}), flat. Still the target, or re-baseline — and if still, does anything in the plan change?"

Re-affirming without edits still bumps the review marker. Declining the whole leg ("later") is a stop signal like any other.

### Wrap summary

> "Reviewed {N} items, edited {M}. Chip is clear." — or, only after a stop signal: "Reviewed {N}, edited {M}. Stopped with {K} still due — top one is {name} at {age}d; the chip stays on until we finish."

## Gotchas

- **Dates on both sides, always.** A claim without its review date and a metric without its observation window can't be honestly compared.
- **Confirmation matters as much as contradiction.** "You wrote 'sleeping poorly'; the last 30d average is {h}h at {e}% efficiency" may CONFIRM the claim — then the prompt is "still true, want the numbers in the file?"
- **Metric identity matters.** Compare like with like: `rhr_avg_*` (Oura lowest sleeping HR) is the RHR comparator; `sleep_hr_avg_*` (average HR during sleep) runs higher and is NOT resting heart rate. Wrist HRV also reads lower than chest-strap numbers — name the instrument when the gap could be the sensor.
- **Single-timestamp sources understate their skew.** The expense ledger exposes one `meta.updated` date, so money's "unexamined data" figure reflects the last ledger write, not months of history behind it — say "ledger last updated {date}" rather than leaning on the day count.
- **Pulse not running.** Voice notifications fail silently; HTTP routes return connection errors. Conversation continues using the lib directly.
- **Slug not found by bumpTelosTimestamp.** Returns `sectionFound: false`. Re-check `sectionSlug(headingText)`.
- **Principal goes silent mid-section.** Treat the same as "stop" — wrap with the freshness summary and exit.

## Examples

Worked runs (a stale system prompt opening, an all-fresh opening on an audit finding, a per-entry Goals walk) are in `References/ContextCheckinExamples.md`; read it when shaping an opening or a per-entry prompt.
