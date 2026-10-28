# UpdatePoints

Record principal-reported points balances into `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Points.md`.

## Ideal State

- The balance row in `Points.md` is overwritten (never appended) with the new number, today's date in "As of", and source "principal".
- The recorded numbers are confirmed back in one line.
- A new program (e.g. a new card) gets a new row in `Points.md` and an inventory row in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CardBenefits/Cards.md`.

## Anti-criteria

- Never estimates or carries forward a balance: balances come only from the principal (or a statement pointed at).
- On a partial update (one program), no row but that program's is touched.