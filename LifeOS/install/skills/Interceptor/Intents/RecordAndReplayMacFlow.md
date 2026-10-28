# RecordAndReplayMacFlow

**Contents:** Ideal State · Anti-criteria · Inputs · Safety gates · Tool contract · Gotchas · Output format

A recorded macOS user workflow (AX events) exported as a replay plan, and a replay of such a plan through interceptor macos commands.

## Ideal State

- The recording's trace holds only the user's own input: control was handed to the user while the monitor ran.
- The `--plan` export exists and is reported by path or content, with the recording's `sid`, duration and event count.
- The session was stopped when the flow was done rather than left to the 24h auto-stop.
- TCC permissions were checked with `interceptor macos trust` before a long session, and any requirement not satisfied is reported with the deep link from `trust`.
- A replay maps each plan step's target app, ref and action to `interceptor macos` commands and runs background-first, foregrounding only where the plan says the user did.

## Anti-criteria

- Never issues synthesized input (`click`, `type`, `keys`, `drag`) during recording.
- Never relies on `--frames` across a Spaces switch without testing it first.

## Inputs

A native macOS workflow the user demonstrates (a multi-step Mail action, a Finder rearrange, a Cursor refactor), complex enough that observation beats step-by-step interaction, or one that needs a replay plan for regression testing or handoff to another agent. The browser counterpart is `RecordFlow.md`; this records AX events instead of DOM events.

## Safety gates

### Permissions

- Accessibility TCC — required (how the monitor sees AX events).
- Screen Recording — required only for `--frames`.
- Microphone — required only for `--include speech`.
- Input Monitoring — required for global keystroke capture in the monitor.

Check with `interceptor macos trust` before starting a long session.

## Tool contract

### Record

1. **Start the session.** Optionally include an instruction so the export carries intent.
   ```bash
   interceptor macos monitor start --instruction "Watch how the user files an email"
   ```

2. **Hand control to the user.** Tell them they can drive macOS normally now. **Do NOT issue synthesized input during recording** (`click`, `type`, `keys`, `drag`): synthesized events land in the trace and pollute it.

3. **Watch progress.**
   ```bash
   interceptor macos monitor status                       # Active sessions + counts
   interceptor macos monitor list                         # All sessions, active + ended
   interceptor macos monitor tail <sid>                   # Live pretty stream
   interceptor macos monitor tail <sid> --raw             # Raw JSONL
   ```

4. **Pause / resume / stop.**
   ```bash
   interceptor macos monitor pause <sid>
   interceptor macos monitor resume <sid>
   interceptor macos monitor stop <sid>
   ```

### Scope: which apps get recorded

The monitor records the frontmost app's events and switches with the user when they change frontmost mid-flow, because most real flows cross app boundaries (Mail → Finder → Slack).

Scope flags:
- `--app "X"` — record events from one specific app, ignore frontmost changes.
- `--apps "A,B,C"` — record events only when frontmost is one of these.
- `--all-apps` — record every app, no filter.

Optional event sources:
- `--include clipboard|files|network|log|notifications|speech` — add non-AX event channels.
- `--frames N` — capture N screenshots per second alongside events (requires Screen Recording TCC).
- `--vision-text` — OCR captured frames inline.
- `--watch-path <p>` — watch a filesystem path for changes.
- `--log-predicate "<NSPredicate>"` — pull OSLog entries matching the predicate.

### Export

```bash
interceptor macos monitor export <sid>                   # Aligned-text default, human-readable
interceptor macos monitor export <sid> --plan            # Replay-plan (highest-value artifact)
interceptor macos monitor export <sid> --with-bodies     # Include event bodies (clipboard content, file diffs)
interceptor macos monitor export <sid> --json            # Raw JSONL
```

**The `--plan` export is the most useful artifact.** It collapses raw events into the minimum steps needed to reproduce the flow — app activations, AX refs, keystrokes, waits — without mousemove tracks and intermediate AX read events.

### Replay

Replay is human-readable rather than fully automated: read the `--plan` output as a checklist, map each step's target app, ref and action to `interceptor macos` commands (`open`, `act`, `type`, `keys`, `scroll`, `intent dispatch`), and re-execute them in sequence.

### Sessions on disk

Sessions persist NDJSON to `${INTERCEPTOR_MONITOR_SESSIONS_DIR:-/tmp/interceptor-monitor-sessions}/<sid>/` and auto-stop after 24h with 100 MiB rotation. If you see runaway counts in `monitor status`, stop the orphan.

## Gotchas

- **Forgetting to stop.** Auto-stops are a safety net, not a workflow.
- **Re-using a sid.** Each `monitor start` gets a fresh `sid`. `resume` only works on `paused`, not `stopped`.
- **Cross-Space drift.** If the user switches Spaces mid-flow, AX continues recording — but `--frames` may capture the wrong Space's compositor output. Test before relying on it.

## Output format

Report:
- The `sid` of the recording
- Duration and event count
- The path or content of the `--plan` export
- Any TCC requirement that wasn't satisfied (with the deep link from `trust`)
