# Mine

A harvest report on one piece of content (analysis and what LifeOS should take from it, plus whatever the install's preferences add), with the source preserved in Cortex.

## Ideal State

- The report reads one piece of content properly and says what it is, what is good and weak about it, and what LifeOS should take from it.
- When `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Harvest/PREFERENCES.md` exists (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), the report follows its preferences on top of the default shape below, including any section it adds and any change to how much weight each section carries.
- The analysis rests on the whole content, fetched and read before any analysis was written: a YouTube transcript, an article body, a file, or the raw text provided.
- Every concrete, transferable element of the content appears as a candidate row naming the exact LifeOS surface it maps to, its prior status (checked before novelty is claimed), and one concrete sentence on how we would use it.
- Surviving candidates are ranked by usefulness × novelty × (inverse) effort, and DONE and REJECTED items drop to a short "already covered" note, not the main table.
- Every harvest ends with the source preserved in Cortex as a KNOWLEDGE note through `Tools/harvest.ts`, regardless of how thin the mining verdict was, and the report's final `**Cortex:**` line carries the note path or the failure.

## Anti-criteria

- System adoption is never done by the harvest: it is report-only, and adoption of any item is a separate step that needs the principal's explicit go-ahead.
- Never analyzes an empty transcript: if the fetch fails or returns almost nothing, the harvest stops and says so.
- No candidate without a nameable surface, and no vague candidate: "Be more rigorous" is not a candidate.
- Never writes to `MEMORY/KNOWLEDGE/` by hand.
- A harvest is never reported complete until the note is written or the failure is surfaced.

## Inputs

Input types:

- `youtu.be/…` or `youtube.com/…` → **YouTube**
- `x.com/…/status/…` or `twitter.com/…/status/…` → **X post**
- Any other `http(s)://…` → **Article/URL**
- A path that exists on disk → **File**
- Anything else → **Raw text**

## Tool contract

One run fetches the content once and ingests it; the analysis is written from the body file it leaves:

```bash
bun ~/.claude/skills/Harvest/Tools/harvest.ts "<original input>" --body-out <scratch>/body.txt
```

- `harvest.ts` detects the type, fetches the whole content (how each type is read, including how a YouTube transcript is made, is in SKILL.md § Gotchas), writes it to `--body-out` before any POST, then runs the canonical Workflows pipeline (the harvest classifier worker classifies → `HarvestExecutor.ts` writes). Delete the body file after the report.
- An X post is read through the X skill's read tool, under the install's X-reads rules when `LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md` carries them; a post carrying a video follows that file's Video-bearing content section when present.
- A thin article (the tool's "Body too short" refusal, a page that needs rendering) escalates to the BrightData skill for the raw page text, within that site's terms, never `WebFetch`, which returns a summary. A site that refuses automated access (a bot wall, a CAPTCHA, a 429) has said no: stop and report it. That text is then ingested on stdin: `harvest.ts - --type text --url "<url>" --body-out <scratch>/body.txt`.
- A local file whose extension has no handler is refused by the tool; `Read` it for the analysis and report the refusal on the `**Cortex:**` line.
- A `duplicate` result is success — the note already exists; say so.
- On failure (Workflows down, classifier error, dead API key), report the failure explicitly in the final response and name the blocked item id. The body file was written before the POST, so the analysis still runs.

## Output format

Output this default shape, adjusted by the install preferences named in § Ideal State. The **Commentary** section appears when those preferences ask for it.

```
## Harvest: <source>

<one line: what the content is, and the headline verdict — rich / thin / nothing>

**Analysis:** <what the thing actually argues or builds, its structure, where it is strong, where it is weak or unproven, how it sits against the state of the art — a few tight paragraphs or bullets, judged on its own terms first>

**Commentary:** <only when the install preferences ask for it; my own read, first person: do I buy it, what would I push back on, what it gets right that most people miss, what I would tell the author>

**LifeOS upgrades:**

| # | Candidate | Maps to | How we'd use it | Prior status | Recommended action |
|---|-----------|---------|-----------------|--------------|--------------------|
| 1 | …         | …       | …               | NEW/PARTIAL  | …                  |

**Already covered:** <one line each for DONE/REJECTED hits, if any>

**Verdict:** <the honest bottom line — what, if anything, is worth doing next>
```

The columns:

- **Candidate** — an idea or framing, a technique or pattern (algorithm, workflow shape, verification method, eval design), a tool (library, CLI, API, service), a prompt or phrasing that beats what we do now, or a warning (a failure mode or anti-pattern to guard against). A concrete candidate looks like "Use property-based tests where an ISC is a universal criterion".
- **Maps to** — the exact surface: an Algorithm phase or gate, a specific hook (`hooks/*.hook.ts`), a specific skill, the memory system, Pulse, routing / `EFFORT_MODEL`, ISA, or a doctrine file (system prompt, CLAUDE.md, OPERATIONAL_PREFERENCES).
- **How we'd use it** — one concrete sentence: the actual change we'd make.
- **Prior status** — **NEW** (LifeOS doesn't do this), **PARTIAL** (we have something close; this sharpens or extends it), **DONE** (already implemented; name where), or **REJECTED** (we've considered and declined this; name why, if known). Checked against the Upgrades store (`bun LIFEOS/TOOLS/Upgrades.ts list`: an `applied` or `verified` record is DONE, a `rejected` one is REJECTED), Cortex recall of prior sessions, and, when cheap, a grep of `skills/`, `hooks/`, and the Algorithm.

Rules for the report:

- Lead with the verdict. If nothing is worth adopting, the table can be empty and the verdict says so.
- For a candidate that would change existing system behavior (a prompt-shape swap, a doctrine rewrite, a routing change — not an additive tool or note), the recommendation may propose an offline eval against current behavior as part of the adoption step, with the decision rule stated up front (see `LIFEOS/ALGORITHM/eval-guide.md`). Elected, never mandatory — evals are a discretionary resource here, per OPERATIONAL_PREFERENCES; the standing gate on adoption remains the principal's go-ahead. (Idea credit: a community issue and pull request on the public LifeOS repo; the reference is in the USER extension's `History.md` when present.)
- Keep it tight. A harvest is a filter, not an essay.
