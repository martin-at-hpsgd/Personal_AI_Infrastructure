# Drive

Run one computer-use task through the router and, when it lands on a vision leg (Astra or Claude), through the supervised runner.

## Ideal State

- The route is stated before anything runs: intent, whether a handle exists, the backend, and why. A `verify` or `evidence` intent is Interceptor with no further discussion.
- Interceptor-routed work uses only the Interceptor skill's own verbs; this intent adds no step of its own to it.
- Vision-routed work names three things up front: the target app (the allowlist), the task's end condition, and the verifier (a CLI command or an Interceptor read that exits 0 only when the end state holds).
- Every vision run is a `Run.ts` run, so the deny scan, Focus, voice line, spawn, watcher, caps, verifier, record, Focus off and closing voice line all come from the runner, never from hand-run steps.
- The report quotes the verifier's result and the record path. The leg's own summary is quoted as "Astra reports…" (or "Claude reports…"), never as the verdict.

## Anti-criteria

- Send, buy, delete, publish, or confirm is never the end condition of a task unless the principal named that exact action.
- A refused run is never re-run with a shorter deny list to get past it.
- Never hide or move the principal's windows yourself.
- The leg's own summary is never quoted as the verdict, and no run starts without a verifier.

## Safety gates

- Without a named send, buy, delete, publish or confirm, the run stops and asks at that point. A refused run is reported as refused with its reason.
- On exit 2, tell the principal which app to hide (Cmd+H) or quit, then re-run.

## Tool contract

```bash
cd ~/.claude && bun skills/ComputerUse/Tools/Run.ts \
  --task "<what Astra should do, ending with the observable end condition>" \
  --app <TargetApp> [--app <SecondAllowedApp>] \
  --verify "<shell command; exit 0 = pass>" [--verify-kind cli|interceptor] \
  [--backend astra|claude] [--step-cap N] [--wall-clock SECONDS] [--dry-run]
```

Without `--backend`, the runner uses the Config `vision_pick` for the first `--app`.

Exit codes: 0 pass · 1 verifier failed · 2 deny list (message names the app or host) · 3 headless channel · 4 Interceptor preflight failed · 5 no verifier · 6 aborted (cap or watcher; verifier still ran).
