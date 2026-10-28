# Probe

Prove the Astra leg exists on this machine before trusting it with a mission.

## Ideal State

- `codex features list` shows `computer_use` stable and enabled.
- The probe verdict comes from a real headless TextEdit run whose typed and saved file passes the verifier's `test -f`.
- The saved JSONL event stream shows at least one computer-use event and zero browser events. The event vocabulary observed is recorded in the ISA.
- If the run cannot start (Desktop-app-only, TCC refused, model unavailable), the report says so and the ISA records the Astra leg as unavailable.

## Anti-criteria

- No special path: the probe never skips the deny scan, caps, or verifier any mission runs under.
- No pretending: when the run cannot start, the Astra leg is never reported or recorded as available.
- The macOS Screen Recording or Accessibility approval for the `codex` process is never given by anyone but the principal; they are told before the probe starts, and it waits for their approval.

## Tool contract

```bash
cd ~/.claude && bun skills/ComputerUse/Tools/Probe.ts --app TextEdit \
  --task "type hello and save to ~/Downloads/cu-probe.txt"
```

`Probe.ts` wraps `Run.ts` with the TextEdit task, captures stdout JSONL to `~/Downloads/cu-probe.jsonl`, and verifies with `test -f ~/Downloads/cu-probe.txt`.
