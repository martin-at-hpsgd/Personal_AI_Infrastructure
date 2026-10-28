# BuildShortcut

A macOS Shortcut built once under its exact name and proven by running it, so every later call is plain CLI.

## Ideal State

- The shortcut exists under the exact name consumers expect: `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts exists "<exact name>"` exits 0.
- It is verified by running, not looking: `run "<exact name>" --input "<test>"` returns output that matches the spec, because existence is not correctness.
- A shortcut that takes input reads its first action from Shortcut Input, the stdin the CLI pipes in, so `--input` is honoured and nothing hangs on a dialog.
- A shortcut that should return text ends with a "Show Result" or explicit output action returning the value wanted on stdout.
- The saved action chain matches the spec (Home actions such as Control [accessory] and Set state for Home control), and the editor is closed so the shortcut is saved.
- A shell-script body arrives through the signed-plist import with no GUI authoring; any other body is authored through `Skill("ComputerUse", "Drive")` with `--app Shortcuts`, a task ending on the observable end condition, and the `Shortcuts.ts run` verifier.

## Anti-criteria

- Nothing in this intent drives pixels by hand; GUI authoring goes through the ComputerUse skill.
- An input shortcut never uses "Ask Each Time" or a prompt action for its input.
- Never declares done when the run output does not match the spec; the wiring is fixed in the editor first.

## Inputs

A capability with no API or CLI that lives behind Shortcuts.app's GUI-only editor: HomeKit/Home actions, native system actions, app intents.

- **Exact name** the shortcut must have (consumers match it exactly).
- **Input type**: none, Number, or Text (what the CLI will pipe on stdin).
- **Action spec**: what the shortcut does, step by step.
- **Output**: what its final action should return on stdout (if anything).

## Tool contract

### GUI authoring through ComputerUse

Create the shortcut through the **ComputerUse** skill: its supervised vision leg drives Shortcuts.app, and Interceptor or the `shortcuts` CLI reads the result back. The task ends on the observable end condition ("the shortcut named <exact name> exists in All Shortcuts with <actions>") with the verifier `bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<exact name>" --input "<test>" | rg -q "<expected>"`. The runner owns the deny scan, Focus, caps, and the read-back.

The spec briefed to the vision leg is this intent's Ideal State: a new shortcut named the **exact** target string as soon as it is created, Shortcut Input wired first when it takes input, the action chain, the output action when it returns text, and the editor closed.

### Shell-script body: the plist import path

It covers any shortcut whose body is "run a CLI" (for example a pair of shortcuts, "Example Scene On" and "Example Scene Off", that each run one CLI command); GUI-only actions (Home/HomeKit etc.) still need GUI authoring.

1. Author the unsigned `.shortcut` plist yourself. Minimal working plist: `WFWorkflowActions` array with one `is.workflow.actions.runshellscript` action (params `Script`, `Shell` = `/bin/zsh`, `InputMode` = `to stdin`), plus `WFWorkflowClientVersion`, `WFWorkflowMinimumClientVersion(+String)`, `WFWorkflowIcon`, `WFWorkflowTypes`, `WFWorkflowInputContentItemClasses`, `WFWorkflowImportQuestions`.
2. `shortcuts sign -m anyone -i in.shortcut -o out.shortcut`, signing into a subdirectory under the final name (`signed/Example Scene On.shortcut`).
3. `open out.shortcut`.
4. Click "Add Shortcut" in the import dialog (a plain left-click): `interceptor macos find "Add Shortcut" --app Shortcuts` then `act`. This step needs the Interceptor skill; without it, the user clicks the button.

### Verify

```bash
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts exists "<exact name>"   # exit 0
bun ~/.claude/skills/Shortcuts/Tools/Shortcuts.ts run "<exact name>" --input "<test>"
```

## Gotchas

- **Imported name = the file name, minus extension.** Sign straight to the final name, never a `-signed` suffix: a `-signed` file imports as a stray "<name>-signed" shortcut that then needs manual deletion. Sign into a subdirectory to avoid clobbering the unsigned source.
- **The one bridge-routed click ("Add Shortcut" on import) is Interceptor, never `osascript`.** Driving Shortcuts.app through AppleScript or System Events is forbidden. The ComputerUse skill's runner owns the deny scan, caps, Focus, and the Interceptor or CLI read-back.
- **Deletion needs right-click or the Delete key; the Shortcut menu only has Run/Stop.** A mis-named import is a 2-second right-click → Delete for the user.
- **Treat an import as possibly running the shortcut.** Import only shortcuts you wrote or have read, never one from an untrusted source, and after an import session read the state of any device the shortcut touches before assuming the import had no side effects.
- **Use absolute binary paths in Run Shell Script** (the output of `which bun`, never bare `bun`): the Shortcuts shell doesn't load your PATH.
- **Siri phrase = the shortcut name** (the import dialog literally says `Say "Siri, <name>" to run`). But shortcuts iCloud-sync to iPhone/iPad, where a mac-only Run Shell Script action fails, so script shortcuts are Mac-Siri only.
