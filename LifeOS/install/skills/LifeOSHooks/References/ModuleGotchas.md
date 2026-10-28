# ModuleGotchas

Verified facts about writing and changing the LifeOSHooks hooks module (`hooks/LifeOSHooks.ts`) and how the engine draws what it returns, each with its provenance. The diagnosis rules and the reload behaviour stay in `SKILL.md` § Anti-criteria and § Gotchas.

## Engine API

- Since Claude Code 2.1.280 `$.model.complete` resolves a `ModelCompleteResult` (`{ isAnswered, text, usage }` or an unanswered arm with `reason`), never a bare string, and never rejects for what the provider did. The model-call path reads `.text` and rejects the unanswered arm itself; the test fake returns the same shape.
- Since Claude Code 2.1.273 `$.clock.now()` resolves a number instead of returning one. Every call site awaits it (11 sites, `turnStart` became async) and the test fake mirrors the real engine; a bare `$.clock.now()` in arithmetic is a Promise and the typecheck is what catches it, not the tests.
- A model call planned by a command hook (session naming, the spend audit) runs in the plugin with `$.model.complete` inside `$.clock.after(0, …)`, never awaited inside the dispatch: a dispatch has a budget and `next.signal` aborts what belongs to it. The reply goes back through `HookBridge model-result` to the hook's own `finish()`.
- `$.session.id()` equals the `session_id` the command hooks receive on stdin, so a per-session bridge file keyed on it is shared by both halves.
- Command-hook `additionalContext` is not visible in the plugin's `next(e)` result on `prompt.submit`.

## Registration and loading

- A hooks module cannot import anything outside its folder, symlinks included; that is why the cores are copied, not imported.
- Every hook passed to `on` must be a named function; property access (`h.hook`) fails validation.
- `userConfig` entries need a `title`.
- No hook may be able to see a finished `AssistantMessage`, not even a pass-through: when the answer settles the engine repaints the live turn, and on the main screen a turn taller than the terminal prints twice. A matcher-less `ui.render` hook and a `*` hook both see it (most rows doubled live, none with neither, 2026-10-07). So `ui.render` is registered once per component the hook draws, and the event logger hooks `!ui.*`. The loader refuses a second matcher-less hook on one event and a hook that is not a function literal or a name, so the logger cannot be split into per-event registrations or wrapped.

## Drawing, scrollback and repaint

- In the scrollback layout a `ToolUse` row is printed the first time it draws, before `tool.call` has run, and a printed row never changes; anything decided during the call goes on the `ToolResult` instead, which draws after the call returns (live probes, 2026-10-02). Auto mode mostly allows or denies without a dialog, so a `$.ui.notice` line is rarely seen there; the same reason also belongs on the result's mark.
- The band (`AbovePrompt`) is one instance, terminal only, and content taller than `maxRows` is clipped with its hotkeys disarmed, so the band keeps to two rows and withholds the buttons while a turn runs. `$.prompt.submit` from the plugin skips the plugin's own `prompt.submit` hook (no origin note on a button press) and reaches the command hooks as usual.
- A hook that answers a tool call itself (X and YouTube WebFetch, ISC-43/44) skips the after-hook and every command hook beneath it, so the answering path tags and taint-marks itself. WebFetch's output shape is `{bytes, code, codeText, result, durationMs, url}` (probed live, not in the declarations).
- Never repaint a final answer taller than the transcript area: `$.ui.invalidate("ui.render")` at `turn.complete` re-renders the answer block, and a block that has scrolled above the area comes back smeared (lines from two rows below painted over it, character-interleaved; kitty, 2026-09-05). `repaintFits` skips the invalidate, so a tall answer keeps its text and loses the banner. Band buttons use `columnGap`, never `gap` (a row gap puts blank rows between wrapped buttons).
