# Install

Register the Vigil monitoring tick in launchd.

## Ideal State

- `com.lifeos.vigil` is loaded in launchd and fires every five minutes with the headless notification channel.
- The Services registry shows it running.
- The evidence reported is the status output after install, not the installer's exit code alone, and the first tick's baseline line is reported once it has run.

## Anti-criteria

- Installing (calling `launchctl`) when the principal did not ask for the tick to be on.
- Installing before confirming the routing policy file exists at `LIFEOS/USER/VIGIL/policy.json` and that the daily text limit in force (SKILL.md § Data & Config: the interruption budget under `enforce`, `text_ceiling_per_24h` under `shadow`) is the number the principal wants.
- The plist edited by hand.

## Safety gates

- The policy check comes first because the first live tick after a baseline can text.
- The plist template under `LIFEOS/VIGIL/` is the source; the installer materializes it.

## Tool contract

```bash
bun ~/.claude/LIFEOS/VIGIL/InstallVigil.ts --status      # is it loaded
bun ~/.claude/LIFEOS/VIGIL/InstallVigil.ts               # install or reinstall (idempotent)
bun ~/.claude/LIFEOS/VIGIL/InstallVigil.ts --uninstall
bun ~/.claude/LIFEOS/TOOLS/Services.ts status | grep -i vigil
```
