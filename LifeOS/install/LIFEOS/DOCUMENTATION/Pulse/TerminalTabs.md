---
version: 2.4.6
---

# Terminal Tab State System

## Overview

Every Kitty tab shows two orthogonal signals in one glyph plus one colour, both drawn from the ONE ascent table (`LIFEOS/TOOLS/ascent.ts`):

- **The tab COLOR is the run's ascent state** — the same staging the Pulse phase list uses (principal directive, 2026-08-12). Traverse is gray (off-scheme — no ISA), then the arc escalates blue → green: marking → ascending → anchoring → camped → cairn. Tabs wear the dark register of each hue (`tabBg`); Pulse wears the brights (`color`). Same table row, two registers.
- **The title carries exactly ONE glyph** (principal directive, 2026-08-19). `tabGlyph()` in `ascent.ts` picks it, in precedence order: `⏳` when a question or approval is pending, because "you are the blocker" outranks everything and the tab COLOR still carries the state; `⚡` for work with no ISA behind it; otherwise the run's own ascent icon (`📐 🧗 ⚓ ⛺ 🪨`). Done and quiet get no glyph of their own — 🪨 already means the cairn is set and ⛺ already means camped. `TAB_ACTIVITY` still names the four activities; it just no longer paints a second slot.

- **The text leads with the session, not the activity** (2026-08-19: a tab reading just `posture` doesn't say which session it belongs to). The session label — the first three words of the session name, verbatim — sits in front of a pipe.

Title shape: `{glyph} {SESSION LABEL} | {description}` — e.g. `🧗 TAB TITLES | Fixing tab colors.`, `⏳ TAB TITLES | APPROVE: Bash git push…`, `🪨 TAB TITLES | Fixed tab colors`. Sessions with no name yet fall back to the bare description. The label comes from `getSessionShortLabel` and is composed in `composeAscentTitle`, so every stamp path gets it; no caller builds its own prefix.

**Where the label comes from (2026-09-16):** it is the first three words of the canonical session name, upper-cased, with only punctuation-only tokens dropped (`shortenNameToLabel`). The name is the work.json row's `sessionName`, which is what the Pulse agent dashboard shows, so the three words on the tab, the status line's `LABEL · FULL NAME`, and the Pulse row are the same words (principal directive, 2026-09-16). "Rebuild Shadow Release Workflow" reads `REBUILD SHADOW RELEASE`; the leading verb stays because the label must read as the name. The earlier design (2026-08-19 to 2026-09-16) had the namer author a separate 1-2 word subject label and fell back to a verb-stripped, generic-word-stripped slice; both are retired because a curated label could drift from the name it stood for. The namer's `tab_label` field is gone from its prompts; the store (`MEMORY/STATE/session-labels.json`) remains, written only by `resolveLabel` from the name.

**One name, one state, both from work.json (2026-09-07).** The tab and the Pulse board both derive from the work.json row now — `getSessionShortLabel` reads the row's `sessionName` (via `resolveSessionRow`/`readCanonicalName`) before the first-prompt stores, and the tab color is the row's derived ascent. Before this, the tab drew its name from the frozen `session-labels.json`/`session-names.json` while Pulse drew from `sessionName`, so the instant a session became an ISA or was renamed the two disagreed (a climbing ISA showed its first-prompt name and `⚡`/`🪨` on the tab while Pulse showed the ISA name and `🧗`). The authored `tab_label` still wins, but only while every one of its words still appears in the canonical name (`authoredFitsCanonical`); once the name moves on, the label is stale and the tab re-slices the canonical name. `SessionRename` clears the stale label so a manual rename flows to the tab too.

**One writer for the name and the label (2026-09-11).** `hooks/lib/session-identity.ts` is the only code that writes a session's name or tab label. `setSessionName` moves `session-names.json`, `session-labels.json`, the native `work.json` row and the harness JSONL custom-title in one motion, then repaints the tab with the previous label stripped from the carried activity; `projectSessionIdentity` pushes an ISA row's `sessionName` (frontmatter task/title/H1) into the same projections. Callers: PromptProcessing (first-prompt name, floor name, slash-command name, name correction — and it now stores the name BEFORE it stamps the tab), ISASync (after every `syncToWorkJson`), SessionRename, WorkReconcile. The label is always stored, never computed at read time: the first three words of the name (since 2026-09-16). The status line reads the same two projection files with one `jq` and renders `LABEL · FULL NAME`; its per-session shell cache and the `sessions-index.json` lookup are gone (one global cache slot shared by every session, and a file current builds never write). Before this, the tab read work.json → labels → names and the status line read sessions-index → cache → names, so most sessions showed two different identities (a tab label that was a slice of one name beside a header carrying another; every ISA session kept its first-prompt name in the header). Diagnostics: `bun hooks/lib/session-identity.ts audit` (live tabs vs stores, exit 1 on drift) and `sync-all` (project + repaint every live session through its own kitty window). The per-window `tab-titles/{id}.json` now carries the painter's `sessionId`, which is the honest window→session map when a kitty window is reused.

**The 2026-08-12 fold:** the old generic color layer (working orange, thinking purple, native orange, question teal, blocked amber) is RETIRED. Every live stamp routes through `setAscentTab`, so a painted tab is always one of the six state colors; "waiting on you" is carried by the ⏳ glyph, not a special color. `TAB_COLORS` in `hooks/lib/tab-constants.ts` keeps the retired entries only for stale state files.

**Text Colors:**
- Active tab: White `#FFFFFF`
- Inactive tab: Gray `#A0A0A0`

**Active Tab Background:** Always Dark Blue `#002B80` (regardless of state)

**Key Design:** State colors only affect **inactive** tabs. The active tab always stays dark blue so you can quickly identify which tab you're in. When you switch away from a tab, you see its state color.

## How It Works

### Two-Hook Architecture

**1. UserPromptSubmit (Start of Work)**
- Hook: `PromptProcessing.hook.ts`
- Re-stamps a live run's ascent state, or `traverse` for un-ISA'd work (default `⚡`)
- Announces via voice server (desktop channel)

**2. Stop (End of Work)**
- Hook: `TabState.hook.ts` → `handlers/TabState.ts`
- A turn ending is not a run ending. A native turn (no ISA) stamps `cairn` (`🪨✅`) with a past-tense summary. An ISA whose criteria are still open keeps its live run state (`resolveSessionRow` reads the work.json row Pulse reads) — stamping cairn there painted a live climb green at every turn end and then wiped it to `⚡ traverse` on the next prompt (fixed 2026-09-07).
- Voice completion notification handled separately by `VoiceCompletion.hook.ts` (also registered on Stop)

`TabState.hook.ts` additionally handles the PreToolUse/PostToolUse `AskUserQuestion` legs and PermissionRequest: both stamp `⏳` ON THE RUN'S ASCENT COLOR (carrying `previousTitle`/`previousAscent` for the restore), and the PostToolUse leg restores the prior state. `SessionAnalysis.hook.ts`, named here in earlier versions of this doc, is retired — see `ObservabilitySystem.md` § Session State Tracking.

### State Detection Logic

```typescript
function detectResponseState(lastMessage, transcriptPath): ResponseState {
  // Check for AskUserQuestion tool → 'awaitingInput'
  // Check for error patterns in STATUS section → 'error'
  // Default → 'completed'
}
```

**Awaiting Input Detection:**
- Scans last 20 transcript entries for `AskUserQuestion` tool use

**Error Detection:**
- Checks `📊 STATUS:` section for: error, failed, broken, problem, issue
- Checks for error keywords + error emoji combination

## Examples

| Scenario | Tab Appearance | Inactive fill |
|----------|----------------|---------------|
| Untracked work in flight | `⚡ Researching pet stores.` | Traverse dark gray `#3B4048` |
| Run articulating done | `📐 Marking the summit.` | Marking dark blue `#1E3A6F` |
| Run building | `🧗 Fixing auth bug.` | Ascending dark cyan `#0F4666` |
| Probes running | `⚓ Testing the hold.` | Anchoring dark teal `#135247` |
| Question pending | `⏳ Auth method` | The run's own state color |
| Approval pending | `⏳ APPROVE: Bash git push…` | The run's own state color |
| Run gone quiet | `⛺ Fixing auth bug.` | Camped dim slate `#262B40` (off the gradient — a pause isn't progress) |
| Turn finished | `🪨 Fixed auth bug` | Cairn dark green `#0A4D33` |

**Note:** Active tab always shows dark blue (#002B80). State colors only visible when a tab is inactive — you see the whole hillside from whichever tab you're in: gray hasn't declared a route, blue-to-teal is climbing, ⏳ means you are the blocker, green is done.

### The state machine behind the paint

The color axis follows `deriveAscent()` — the same derivation the Pulse board uses, so a tab can never contradict a lane. The activity axis is stamped by whichever hook fired last: `PromptProcessing` (⚡ on submit), `TabState` PreToolUse/PermissionRequest (⏳) and PostToolUse (restore to ⚡), `handlers/TabState.ts` at Stop (✅ via cairn).

## Mode/Tier Token (title prefix) — RETIRED 2026-07-11

> **History only.** The mode/tier token was retired 2026-07-11 when mode/tier classification (MINIMAL/NATIVE/ALGORITHM, E1–E5) was abolished system-wide and `TheRouter.hook.ts` — the authoritative classifier described below — was deleted. No successor stamps an `E{tier}`/`N` token. The last token plumbing (`setModeToken`, `MODE_TOKEN_RE`) was deleted in the 2026-07-14 phase-machinery deep strip — nothing lingers in `tab-setter.ts`/`PromptProcessing.hook.ts` (stale claim flagged via public issue #1598, @anikinsasha). The Algorithm Phase Tab System below still runs (phase icons/colors), minus the tier-token prefix. The description below is kept for history.

Every tab title used to lead with a **mode/tier token** so you could see at a glance what kind of turn each tab was running:

- **`N`** — a NATIVE turn. Rendered in a lighter, brighter orange (`#C2660A`, the `native` state in `TAB_COLORS`) so native work is visually distinct from Algorithm's darker build/execute oranges.
- **`E1`–`E5`** — an ALGORITHM run at that effort tier.

Canonical title format: **`{TOKEN} {ICON} {summary}`** — e.g. `N ⚙️ Fixing tab titles.` or `E3 🔨 Building phase tabs.`

**Single authority — historical (2026-07-01 coordination fix; moot since the mode/tier system was deleted 2026-07-11).** The mode/tier token was owned by ONE writer — `TheRouter.hook.ts`, the authoritative classifier — so the tab, `work.json`, and the Pulse Agents/Lattice page all projected the SAME decision. Before this fix, `PromptProcessing.hook.ts` stamped the token from its own 8-verb `isNativeMode()` shadow-classifier, which diverged from TheRouter and showed `N` on ALGORITHM turns (e.g. a prompt like "analyze… and fix" has none of the 8 verbs); the correct tier token only appeared once an ISA existed and its phase advanced.

Where the token came from (all historical — TheRouter deleted 2026-07-11):

- **TheRouter (authority — historical, deleted 2026-07-11)** — the instant it classified, `TheRouter.hook.ts` calls `setModeToken(sessionId, token)` (`tab-setter.ts`): `E{tier}` for ALGORITHM, `N` for NATIVE (MINIMAL leaves the tab). `setModeToken` sets/replaces ONLY the leading token, preserves the live working description, and clears any prior-turn `✅ completed` state — so a stale "done" can't linger into live work, in EITHER direction (an ALGORITHM turn never shows `N`, a NATIVE turn after an ALGORITHM turn clears the stale `E{tier}`/`✅`). TheRouter also persists the tier into `work.json` (`markAlgorithmStarting(uuid, hint, tier)`) so the Agents page is tier-correct before any ISA exists.
- **PromptProcessing (description only)** — sets the working gerund description; it no longer classifies mode. It recovered the token TheRouter stamped (both deleted 2026-07-11) via `extractModeToken(readTabState())`, but ONLY when the tab shows live work — a stale completion/idle token is dropped (TheRouter re-stamps the authoritative one ~concurrently). This is the race contract: TheRouter owns the token, PromptProcessing owns the description, each preserves the other's field.
- **AlgoPhase + ISASync (phase)** *(historical — AlgoPhase retired 2026-07-14)* — both stamped `setPhaseTab(phase, sessionUUID, undefined, eLevel)` at transitions (idempotent, same `E{tier}`+phase-icon output): `AlgoPhase.ts` on the explicit CLI phase write (the SAME write that updates `work.json`, keeping tab ↔ Agents-page congruent), `ISASync.hook.ts` on the ISA-edit phase change (catches the scaffold and manual edits). `eLevel` comes from the row `effort` / ISA frontmatter via `effortToCanonicalELevel()`.
- **Completion** (historical, pre-2026-07-11) — `handlers/TabState.ts` calls `setPhaseTab('COMPLETE', …)` with no `eLevel`; `setPhaseTab` recovers the existing token (`extractModeToken`), so `N`/`E3` carries through to the green done state.

Historical symbol map (all deleted 2026-07-11): `stripPrefix()`, `extractModeToken()`, `setModeToken()` (all in `tab-setter.ts`) parse/mutate the token + icon; `MODE_TOKEN_RE` is the shared `^(N|E[1-5])\s+` matcher.

## Ascent Tab System (2026-07-27)

Separate from the State System above, **Algorithm runs** drive tab titles/colors via `setAscentTab()` in `hooks/lib/tab-setter.ts`. The title format is `{ICON} {description}` — for example `🧗 Fixing Algorithm state sync.`

**There are no phases and no per-surface icon tables.** Every glyph, label, colour and tab background comes from **`LIFEOS/TOOLS/ascent.ts`**, the one table also read by `work.json`, the status line, the Pulse board, and the ISA HTML mirror. Change an icon there and it changes on every surface at once — that is the point of the file. See `LIFEOS/DOCUMENTATION/Algorithm/AscentStates.md` for the state set and what each one means.

Two fidelities, one derivation (`deriveAscent`):

- **Hooks** pass what the ISA declares and get the **bracket** — Marking, Ascending, Cairn (plus Camped when a tracked run goes quiet).
- **Pulse** passes the live tool stream on top and gets the **in-flight detail** — Anchoring, when the stream is verification-dominated (the 2026-07-30 six-state fold merged the other detail states into Ascending).

Both agree on the bracket, so a tab can never contradict the board; the board is simply more precise. An unrecognised phase value resolves through `PHASE_TO_ASCENT` instead of falling off a `switch`, which is what let the vocabulary rot silently twice before (see below).

**Why this replaced `PHASE_TAB_CONFIG` / `setPhaseTab`:** the old design hand-listed valid phase names in four separate places. When the Algorithm's vocabulary moved in 8.x, three of those lists were never updated — so `ISASync` stopped repainting tabs mid-run, `PromptProcessing` wiped a run's tab on every follow-up prompt, and `ACTIVE_LOOKUP_PHASES` in `isa-utils.ts` stopped matching any current run at SessionEnd. All three were vocabulary-drift bugs of the same shape, and all three are structurally impossible now: the lists are derived from the table.

**`ISASync.hook.ts` is the driver for the run's ascent state** (the retired AlgoPhase phase CLI was removed 2026-07-14 in the agents-dashboard deep strip, and the Pulse voice-server phase capture path was removed 2026-04-27 — phase is written only via ISA frontmatter; there is no phase CLI). `PromptProcessing.hook.ts` and `TabState.hook.ts` also call it to restamp or restore a tab:

1. **`ISASync.hook.ts` (PostToolUse, Edit on ISA.md)** — the primary driver: fires when the Algorithm executor edits the ISA frontmatter `phase:` field (catches the scaffold write and manual phase edits), writes `work.json` (including the resolved `ascent` blob the status line reads) AND stamps the tab.
Out-of-process writers resolve the kitty socket via the per-session file at `MEMORY/STATE/kitty-sessions/{sessionUUID}.json` (written by `KittyEnvPersist.hook.ts` at SessionStart).

**Cross-process support details:**

- `tab-setter.ts::kittenBin()` resolves the `kitten` binary via `command -v`, falling back to `/Applications/kitty.app/Contents/MacOS/kitten` — required because the Pulse daemon runs under launchd with a restricted PATH that doesn't include `/Applications/*`.
- All `kitten @` invocations in `tab-setter.ts` pass `--match="id:{windowId}"` so the daemon (which has no focused kitty window) targets the correct tab instead of whichever tab happens to be focused.
- Fallback chain for socket discovery: process env (`KITTY_LISTEN_ON`) → per-session file → default `/tmp/kitty-$USER` socket.

## Terminal Compatibility

Pulse Desktop consumes the same `setAscentTab` and `setTabState` output through `hooks/lib/pulse-tabs.ts`. Its isolated tmux sessions carry title, ascent, waiting/restoration metadata and active/inactive colors in a session option. A per-session mapping supports background writers without terminal environment. The native sidebar and selected header refresh together. Codex enables the TabState hook specifically inside Pulse; other terminal routing is unchanged. Pulse lists only its own integrated terminals.

Herdr is the fourth backend (`hooks/lib/herdr-tabs.ts`, 2026-09-18). Inside herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`) the composed title is sent to the pane's herdr tab, and to the workspace when the pane is in the workspace's first tab; the kitty path is skipped because every herdr session shares the client's one hidden kitty window. For the same reason the `tab-titles/` state file is keyed by pane (`herdr-w6-p1.json`) rather than by kitty window id, and the stale-window sweep leaves `herdr-` files alone. Ascent colour does not reach herdr; the glyph carries the state. A writer with no pane env (the voice daemon's phase capture) does not paint herdr.

Two surfaces also report herdr's **sidebar tokens** — display-only values herdr renders inside a row, drawn only while something reports them. `hooks/ISASync.hook.ts` sends `isa` (the ISA's `done/total`) and `phase` (the derived ascent label, lower-cased, off the one ASCENT table) to the workspace the pane owns, so the spaces rows carry the run's progress; it reports on every ISA sync, because progress moves without the phase moving, and subagents never report. `LIFEOS/LIFEOS_StatusLine.sh` sends `model` (short model name plus the live effort level), `ctx` (the context percentage as digits, which the row colours by threshold) and the assistant's name as the pane's display agent, so the agents rows name the assistant instead of the launched binary; it spawns only when one of those values changes or the last successful report is over five minutes old, runs detached, and sets a ten-minute token TTL so a live session's row never expires while a dead session's row clears itself. The `doing` token (the live action of each tool call) was sent by `PreToolGuard` and went away with it on 2026-10-24; nothing reports it now, and the turn hooks clear it. The tab painter sends `session` only for a second session sharing a workspace, whose name appears on no space row. All of them go through `reportHerdrMetadata()` in `hooks/lib/herdr-tabs.ts`, which builds an argv array rather than a shell string, restricts token names to herdr's own `[a-z][a-z0-9_]*`, strips control characters, and caps values. The space rows also carry a one-line work state, with exactly one of seven tokens set at a time (`st_working`, `st_bg`, `st_done`, `st_failed`, or a wait tier `wait_new`, `wait`, `wait_late`). The turn hooks start and clear it. A wait, meaning blocked on an approval, asking a question, or finished with open items or a go-ahead question, reads like `⏳ needs you 6m` and turns amber after 5 minutes and red after 15. A herdr row only changes when something reports, so the statusline refresher runs `herdrWaitRefresh` once a minute (`LIFEOS/STATUSLINE/producers/Herdr.ts`, through `refreshHerdrWaits` in `hooks/lib/herdr-tabs.ts`). It moves the minutes, elapsed time and colour for each waiting or working pane, reports only labels that changed, and drops a wait older than 24 hours. Which tokens appear and where they sit in a row is the user's herdr config: LifeOS reports values and never edits the layout.

The Kitty backend requires remote control enabled:

```bash
# kitty.conf
allow_remote_control yes
listen_on unix:/tmp/kitty
```

## Implementation Details

### Kitty Commands Used

```bash
# Set tab title
kitty @ set-tab-title "Title here"

# Set tab colors
kitten @ set-tab-color --self \
  active_bg=#002B80 active_fg=#FFFFFF \
  inactive_bg=#0A4D33 inactive_fg=#A0A0A0
```

### Hook Files

Tab painting was consolidated into one hook, `TabState.hook.ts`, on 2026-07-10 — it dispatches on `hook_event_name`, merging the three former painters (`SetQuestionTab`, `QuestionAnswered`, `ResponseTabReset`, all deleted). Working-state on prompt submit stays in `PromptProcessing.hook.ts`.

| File | Event | Purpose |
|------|-------|---------|
| `PromptProcessing.hook.ts` | UserPromptSubmit | Set working state (italic text) |
| `TabState.hook.ts` (← `SetQuestionTab`) | PreToolUse (AskUserQuestion) | Set the question state (⏳, you are the blocker); save previousTitle for restore |
| `TabState.hook.ts` (← `QuestionAnswered`) | PostToolUse (AskUserQuestion) | Restore the prior state after the answer |
| `TabState.hook.ts` (← `ResponseTabReset`) → `handlers/TabState.ts` | Stop | Set final/completion state |

### Color Constants

ALL run-state colors and glyphs live in `LIFEOS/TOOLS/ascent.ts` — `ASCENT[state].tabBg/tabFg` (dark register) and `color` (Pulse brights), plus `TAB_ACTIVITY` for the ⚡/⏳/✅/💤 glyphs. Never restate the hex values in a consumer or in docs; `hooks/TabTitleComposition.test.ts` (not in the public release) pins the staging. `hooks/lib/tab-constants.ts` keeps only `ACTIVE_TAB_BG` (#002B80), the idle entry, and retired legacy entries for stale state files.

**Key Point:** `active_bg` is always set to `#002B80` (dark blue). State colors are applied to `inactive_bg` only.

## Debugging

### Check Current Tab Colors

```bash
kitty @ ls | jq '.[].tabs[] | {title, id}'
```

### Manually Reset All Tabs to Completed

```bash
kitten @ set-tab-color --match all \
  active_bg=#002B80 active_fg=#FFFFFF \
  inactive_bg=#0A4D33 inactive_fg=#A0A0A0
```

### Test State Colors

```bash
# Completed (green) - inactive only. Other states: take ASCENT[state].tabBg from LIFEOS/TOOLS/ascent.ts
kitten @ set-tab-color --self active_bg=#002B80 inactive_bg=#0A4D33
```

**Note:** Always set `active_bg=#002B80` to maintain consistent dark blue for active tabs.

## Benefits

- **Visual Task Tracking** - See state at a glance without reading titles
- **Multi-Session Management** - Quickly identify which tabs need attention
- **Color-Coded Priority** - A ⏳ glyph on a tab means it needs input, and green tabs are done
- **Automatic** - No manual updates needed, hooks handle everything

---

**Last Updated:** 2026-09-11
**Status:** Production - implemented via the hook system and out-of-process daemon phase updates. Tab colours are the ascent states in `LIFEOS/TOOLS/ascent.ts`; the mode/tier token was retired 2026-07-11.
