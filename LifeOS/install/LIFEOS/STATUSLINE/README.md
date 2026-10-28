# Statusline

The LifeOS status line, rendered by one Bun process. It replaced the 4,118-line bash script (`d4b212f2f:LIFEOS/LIFEOS_StatusLine.sh`), which is now a thin shim that execs `Render.ts`, so settings, the installer and the tests keep their entry point.

## Shape

- `Render.ts`: reads Claude Code's statusline JSON on stdin, builds one typed `State` (`State.ts`), admits the render (`Admission.ts`), draws every registered section into a `Frame`, clips it to the pane and promotes the finished frame (`Frame.ts`), then exits.
- `Registry.ts` with `registry/Middle.ts` and `registry/Bottom.ts`: the one table of rows. Each row declares the cache files it reads and its TTL; `Registry.test.ts` fails when a section reads an input it did not declare.
- `sections/`: one module per row or chip. `producers/`: typed views over the caches, plus the refresh jobs.
- Width: every row fits the pane on its own line. Informational rows list their forms fullest first and draw the first that fits (`fit()` in `Width.ts`), so a wide pane shows everything and a narrow one drops detail instead of wrapping; content caps at 100 columns (`LIFEOS_STATUSLINE_MAX_WIDTH`, 0 for the full pane) and is centered in a wider pane (`LIFEOS_STATUSLINE_ALIGN=left` turns that off). Every row scales down to phone width (about 28 columns) on its own, but the three-row compact layout takes over in a pane under 60 columns wide or under 30 lines tall, because the full layout is about 28 rows and would bury the prompt on a phone (`LIFEOS_STATUSLINE_COMPACT=1` or `0` forces either).
- `fast/`: `statusline-fast`, a small Rust binary the shim runs first. Most runs change nothing (the transcript and every wake input are older than a frame under 30 seconds old, the pane is the same size; a LifeOS root relocated by `CLAUDE_CONFIG_DIR` or `CLAUDE_PLUGIN_ROOT` always goes to Bun), and `Admission.enter()` replays the cached frame; the binary makes that same decision from the same files in ~3 ms instead of Bun's ~50 ms of boot, and hands every other run, with its stdin, to `Render.ts` by exec. It draws nothing itself, so every row still has one implementation. `Fast.test.ts` checks it makes Render.ts's call in each case. The shim runs the binary only while `statusline-fast.proven` is newer than the binary and every file in `fast/sources` (the Rust source and the TypeScript it mirrors); after any change to one of them, the refresher's `fast-proof` job (`producers/FastProof.ts`) rebuilds the binary, runs `Fast.test.ts`, and writes the stamp only on a pass. Until then, and in any install without the test or the binary, Bun renders every run. A file the binary comes to mirror goes in `fast/sources`.
- `Cache.ts`: the one cache API (parsed reads, atomic writes, TTLs from one clock). `Ansi.ts`, `Width.ts`, `Time.ts`, `UsageMeter.ts`, `ContextBar.ts`: shared helpers.

## Refresh

A render only reads caches; with every cache fresh it starts no process and makes no fetch. Shared data is refreshed by the `statusline-refresh` Workflow every minute (`Refresh.ts`). The herdr sidebar report runs from the same refresher: the render records each pane's values and herdr socket in a want file only when they change, and `Refresh.ts` reports changed panes, renews every pane every 300 seconds so herdr's 10-minute tokens never lapse, and prunes panes idle for 15 minutes. Why: Claude Code shows the line only when the command exits and cancels a run still going at the next update, and nothing here may detach.

## One statusline, two halves

The line is one system drawn by TypeScript and admitted by Rust, and every change keeps the two in step (principal directive, 2026-10-24):

- A change to what a row draws is TypeScript only; the binary never draws.
- An input that changes between turns while the transcript stays still (a background hook's result, like the docs chip's MicroIntegrity file or the doctrine mark's `MEMORY/STATE/doctrine-mark/<session>.json`) is declared `wake:<root-relative path>` in its section's `inputs` and listed in `fast/wake`. Both `Admission.enter()` and `statusline-fast` read that one file, so a new wake input needs no Rust change. `Registry.test.ts` fails while the registry and the file disagree, and `Fast.test.ts` generates a TS-against-Rust parity case for every line.
- A change to the replay decision itself goes into `Admission.ts` and `fast/src/main.rs` together, with a `Fast.test.ts` case. Every file the binary mirrors is in `fast/sources`, so until the proof job passes again, Bun renders every run and a disagreeing binary is never served.

## Checks

- The statusline tests live in the maintainer tree and are not part of the public release.
- Run the renderer by hand only with an isolated `XDG_CACHE_HOME`.
