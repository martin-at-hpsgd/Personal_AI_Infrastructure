# Visualize

Map how a system works, grounded in its files, as a console explanation and a timestamped HTML page in the target's directory.

## Ideal State

- The console answers "how does this work?" on its own. Someone who has never opened the repo can say, from the terminal output alone, what the system is, what its parts are, how its main flow moves, and what to worry about.
- The page is the full picture. Every component and connection that matters is on one diagram; each flow can be traced hop by hop; the risks are specific to this system, and each names the line that grounds it.
- Nothing is invented. Every component cites the files it lives in, and every connection, boundary and risk cites the `file` or `file:line` that proves it. What could not be confirmed goes in `unknowns`, never into a claim. Reading a README or a naming convention is not evidence that code does something; the code or config is.
- On a large target, a fresh reviewer checked every cited line before the final page was rendered, and each claim it found wrong was fixed or moved to `unknowns`.
- It is short where it can be. One-liner in one breath. Summary 2–5 sentences, in plain words. Component roles one sentence. Aim for 6–20 components: group repetitive parts ("25 adapters") rather than listing each.
- The first flow is the one that matters most (usually the main request or data path), because the console draws it as the chain.
- Reading order leads with where the risk or the load-bearing logic lives, not the conventional entry point, unless those are the same file.
- Coverage is honest. `sources` lists every file actually read. On a large target, read deliberately (entry points, routing, config, deploy, auth, data access, the ISA) and say in `unknowns` what was not examined.
- Before delivery the page was verified in a real browser through the Interceptor skill and captured, and one flow was clicked and confirmed to light up.
- A map that goes to a share host (for the principal and a friend) works there with scripts blocked, because the uploaded copy was baked with `Tools/Bake.ts`; when the ask names an earlier share, that share is updated in place at the same link rather than a new one created.

## Anti-criteria

- Never declines: when no code target resolves, the subject is not a codebase and is visualized through the route that fits.
- The model never hand-writes ASCII art or HTML; `Tools/Visualize.ts` prints the map and writes the page.
- A refusal from the tool is never routed around: the model is fixed (or more code is read) and the tool re-run.
- The page is never opened in the principal's own browser unless asked.

## Output format

1. Lead the reply with anything the map surfaced that needs action, such as a high risk, with its evidence. A security problem found while mapping goes in `risks` at the right severity and is also said plainly here.
2. Show the console output to the principal verbatim; it is the concise explanation.
3. Give the page's path.

## Inputs

Resolve the target first. A path is used as given; an ISA file means its directory; a project name resolves through the install's project routing table (for LifeOS, `LIFEOS/USER/PROJECTS.md`) before any path is guessed. If two targets fit the name, emit `⚠️ Picking X over Y because R; redirect if wrong.` and proceed.

## Safety gates

- Read-only on the target. The only write is the one HTML file the tool creates.
- No secret values, tokens or credentials anywhere in the model; the page sits in the repo and the tool refuses secret shapes.

## Tool contract

```bash
# 1. See the model shape
bun ~/.claude/skills/Visualize/Tools/Visualize.ts --schema

# 2. Write the model JSON to the session scratchpad, then validate it against the target
bun ~/.claude/skills/Visualize/Tools/Visualize.ts --check --model <scratch>/model.json --root <target dir>

# 3. Render: console map on stdout, page written to <target dir>/Visualize-<slug>-<YYYY-MM-DD-HHmmss>.html
bun ~/.claude/skills/Visualize/Tools/Visualize.ts --model <scratch>/model.json --root <target dir>
```

Exit 1 prints every refusal: a citation that does not resolve (a missing file, a line past the end, an unknown component). The tool checks that each citation exists, not that the cited line says what the claim does; reading it is the model's job. `--no-html`, `--out-dir` and `--width` are in SKILL.md § Split of work.

- Tiers run top to bottom in the order a request or event travels (for example: clients → edge → app → data → external). Use the kinds the tool accepts: `client`, `ui`, `service`, `worker`, `job`, `queue`, `store`, `external`, `library`, `config`.
- Every flow step must match an edge with the same `from`/`to`; the tool refuses otherwise.
- For a large target, fan the reading out (Explore agents or a Sol worker) and keep the synthesis here; the model JSON is written by the session that holds the whole picture.

## Gotchas

- **Past ~16 connections the full web is spaghetti, and a fact-check catches what a first read misses.** On a reader app (20 parts, 29 links) the all-connections view was unreadable, so pages with more than 16 edges open on the first flow. The same run had 4 wrong claims out of 48 (a nonexistent Apple sign-in, the wrong API auth header) until a fresh reviewer checked every cited line; on a large target, run that check before rendering the final page. (2026-09-22)
- **Evidence line numbers count `split("\n")`**, so a file with a trailing newline reports one more line than an editor shows. Cite the line where the thing happens; minified or one-line files make line cites coarse but still valid.
- **The page lands inside the target repo, untracked.** It will show in `git status` there. The skill never commits or gitignores it; that stays the principal's call per repo.
- **Paths outside the target root resolve relative to it** (`../OTHER/file.ts`). Citing them is fine when a component genuinely lives there; the coverage line counts only the target's own tracked files.

### When editing `Tools/Visualize.ts`

- **Any renderer but a live browser ignores CSS on SVG elements.** DOM-render screenshots painted every connection as a black blob and dropped `text-anchor`, and CSS-only highlight state was invisible. The fix is structural: presentation lives on SVG attributes, and the page's JS sets highlight state as attributes too, with CSS used only for transitions. Keep it that way when editing the renderer. (2026-09-22)
- **Same-row connections between non-adjacent boxes cut through the boxes between them** unless routed as arcs, and long connections crossing several tiers did the same until they were threaded through the gaps between boxes. `layout()` handles both; a change to row packing or port placement needs a visual re-check on a real map, not just the tests. (2026-09-22)
- **Reduced motion must still the fades, never the step-through.** macOS Reduce Motion made Play light every hop at once, so on an already-lit flow the button looked dead. Play is content the reader asked for; it always steps hop by hop, and only CSS transitions honor the preference. (2026-09-23)
