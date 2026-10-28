# Report

Tells the principal whether the intent's judge can be trusted on their taste.

## Ideal State

- The principal learns, in a few lines, whether the intent's judge can be trusted on their taste: agreement and Cohen's kappa against the shared floors (earned or not), the median cut-off that would best match their likes, per-vendor fit, and every disagreement with their own note beside it.
- Held-out numbers are reported as the result and in-sample numbers only as context, and the answer says whether its numbers come from `label-snapshot` scores (the judge when the output was produced) or `rescored` scores (the judge with a taste profile), citing the taste versions the tool prints.
- The report run matches what the principal asked for: overall, one session, with the taste, or raw numbers, per the Intent-to-Flag Mapping.

## Anti-criteria

- Never change a bar or promote a judge from this report on its own.
- Never present agreement on labels the current taste was distilled from as the result.

## Safety gates

- A better cut-off is a recommendation for the owning intent's bar, which is the principal's call.

## Tool contract

### Intent-to-Flag Mapping

| Principal says | Flag |
|---|---|
| "overall", "so far" | (none): every current label, judged by the snapshot taken when it was labeled |
| "last session", "that round" | `--session <id>` |
| "with the taste", "after calibration" | `--rescored` (adds the before line on the same labels) |
| "raw numbers" | `--json` |

```bash
bun skills/Calibrate/Tools/Calibrate.ts report --target <t> [--session <id>] [--rescored] [--json]
```
