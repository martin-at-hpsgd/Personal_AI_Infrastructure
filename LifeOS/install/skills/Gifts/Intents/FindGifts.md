# FindGifts

Research gift ideas for one recipient (or each recipient in a named group) from the registry.

## Ideal State

- A finished run for one recipient is a list the principal could buy from today without further searching; a named group gets one such list per recipient in it.
- No idea in the list repeats an item from the recipient's prior History files, which were read before researching.
- The list holds 8–12 ideas, ranked and grouped by interest.
- Each idea is something the buyer is unlikely to have seen in a big-box aisle: maker-made, small-press, specialty, limited, or an experience.
- Each interest section opens with one or two sentences on what is actually moving in that category this year for this age and group, with the source, and the ideas reflect it.
- Every idea is right for the recipient's age as of today, computed from the registry's as-of date.
- Every idea carries one line of quality evidence you can point to: materials, maker, award, or reviews.
- Every idea has name, maker/seller, approximate price, why it is special for this recipient, and a product URL confirmed live this run (or marked `unverified`).
- At least one idea is a wildcard: an experience, class, or custom/commissioned item.
- The run is saved to the recipient's History file and copied to `~/Downloads/`, in the shape under Output format.

## Anti-criteria

- No recipients, ages or interests are invented or guessed; a missing registry stops the run.
- No item already in the recipient's History files is re-proposed.
- No item that could not be confirmed buyable this run is presented as available; it is marked `unverified`.

## Output format

```markdown
# Gifts for <Name> — <YYYY-MM-DD>
Age now: <n> · Interests: <list> · Occasion: <occasion or "any">

## <Interest>
What's moving: <1–2 sentences, source link>

1. **<Item>** — <maker/seller> · ~$<price>
   Why: <one line, specific to this recipient>
   Quality: <one line of evidence>
   <URL> [verified | unverified]

## Wildcard
...
```

In the terminal reply, give the top three per recipient and the file path; the full list lives in the file.

## Safety gates

Resolve the recipient to a `## <id>` section of `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/Recipients.md` (a missing file stops the run, per SKILL.md § Data & Config). If the file exists but no section matches, route to AddRecipient first. If the occasion, budget or shipping region is unknown and would change the list, pick the registry default and flag it in one line (`⚠️ Picking X over Y because R; redirect if wrong`).

## Tool contract

- Research: `Skill("Research")` at standard depth, one query per interest (plus a cross-interest query when two interests combine well). Its researchers do the multi-source sweep; product pages are confirmed by fetching the page.
- Output: create the `History/` folder if it is absent, then write `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/History/<id>-<YYYY-MM-DD>.md` and copy it to `~/Downloads/gifts-<id>-<YYYY-MM-DD>.md`. Never overwrite an earlier run: when that History file already exists, add the next free suffix (`<id>-<YYYY-MM-DD>-2.md`, then `-3`) to both names.
- Check: from `~/.claude`, run `bun skills/Gifts/Tools/CheckHistory.ts LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Gifts/History/<id>-<YYYY-MM-DD>[-N].md` on the saved file before reporting. Exit 1 lists each failed check (idea count, an unmarked product URL, a repeated idea); fix the file and rerun until it exits 0, and the Downloads copy is the passing version. Details: `Tools/CheckHistory.help.md`.

### Intent-to-Flag Mapping

| Need | Command |
|---|---|
| check one run file | `bun skills/Gifts/Tools/CheckHistory.ts <file>` |
| machine-readable result | add `--json` |
