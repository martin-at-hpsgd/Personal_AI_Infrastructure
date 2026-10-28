# RefineDiagram

Read, reorganize, or extend an existing canvas or `.excalidraw` file — including structuring a human's rough idea dump into clustered, connected form.

## Ideal State

- The existing content existed and was checked before anything moved: every edited element `id` appears in `describe` output (and `get <id>` for detail) taken before the first change, and a file-based scene was `import`ed before that `describe`.
- Every change is addressed by element `id`, and bound arrows re-route themselves when endpoints move.
- The refined scene passes the same quality bar as SketchDiagram (no truncation, no overlap, clean routing, `Tools/ContrastCheck.ts` exit 0).
- The user's own elements survive the refinement: reorganized, not replaced.
- A human's rough idea dump comes out structured into clustered, connected form.

## Anti-criteria

- Never addresses a change by guessing coordinates; changes go by element `id`.
- Never replaces the user's own elements when the job is to reorganize them.

## Safety gates

- Risky restructures are snapshotted first (`snapshot save <name>`) so one command rolls back.

## Tool contract

All commands: `bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts <command>`. Full reference: `../References/Cheatsheet.md`.

```bash
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts import scene.excalidraw          # merge (or --replace)
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts describe                          # ids, positions, labels, connections
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts apply patch.json                  # {"create":[...],"update":[{"id","set":{...}}],"delete":[...]}
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts arrange align|distribute|group --ids a,b,c --to ...
bun ~/.claude/skills/Excalidraw/Tools/Canvas.ts export --out scene.excalidraw     # write back
```

- Locked element won't update → `arrange unlock --ids <id>` first.
- Clustering a rough canvas: group related items spatially (move into columns/zones), add frames or zone rectangles behind clusters, connect with bound arrows, label zones with free-standing text.
- Obsidian vaults: export as `.excalidraw.md` (the CLI detects the extension) — round-trips preserve block references.
