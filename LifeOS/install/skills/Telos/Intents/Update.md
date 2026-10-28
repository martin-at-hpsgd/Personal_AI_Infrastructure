---
description: Update TELOS life context files with guided conversation and automatic backups
---

# Update

**Contents:** Ideal State · Anti-criteria · Output format · Inputs · Safety gates · Tool contract · Gotchas · Examples

A TELOS life context file updated through a guided conversation, with an automatic timestamped backup and a changelog entry.

## Ideal State

- The update is in the right TELOS file, written by `bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts` with three parameters: the exact file name, the content formatted for that file type (§ Output format), and a change description that accurately represents the change. When the target is a section of a section-structured TELOS.md (an ideal-state or current-state entry included), `--section` names that section so the entry sits under its heading.
- A timestamped backup of the file existed before it was modified, a hand-written entry was appended or inserted so existing content is preserved, updates.md logs the change with its description, and every timestamp is in the principal's timezone.
- A refresh of TELOS.md's machine-owned AUTOMATED `current` or `ideal` region is written by the same tool with `--region current|ideal --body-file <file>`, the only sanctioned writer for those regions (§ Tool contract). Only the bytes between that region's markers change, every byte outside them and every `<!-- updated -->` marker stays as it was, and an unchanged body writes nothing.
- Every Validation Rule held before the update executed: the target file and content were verified, the principal confirmed major changes, and the content makes sense for the file being modified.
- A change the tool cannot make is reported to the principal with the file and the reason, and is never reported as landed. Two such changes: a hand-written value replaced in place ("update the target from X to Y"), since outside the two AUTOMATED regions the tool only appends or inserts, and a file outside its list, such as a per-domain `IDEAL_STATE/` or `CURRENT_STATE/` file.
- After a successful update the principal is told what was added and that it was backed up, in a short conversational reply that asks whether there is anything else to add or update.

## Anti-criteria

- Never hand-edit a TELOS file; every change goes through the update-telos command.
- Never put principal-declared content in an AUTOMATED region, and never change a region's bytes with `--section` or by hand; a region holds only a machine-rendered projection, written with `--region`.
- No TELOS update while the backup system is failing: it is fixed before making any TELOS updates.
- TELOS is never committed to public repositories and its content is never shared publicly.

## Output format

Format the content for its file:
- Books: `- *Book Title* by Author Name`
- Lessons: `## Lesson Title\n\n[Description]`
- Beliefs: `## Belief Statement\n\n[Explanation]`
- Goals: `## Goal Title\n\n[Details]`
- Wisdom: `> Quote or wisdom statement\n\n[Context or attribution]`

The change description says what changed:
- "Added favorite book: Project Hail Mary"
- "Recorded lesson about prompt engineering"
- "Updated belief about AI consciousness"
- "Added new 2025 goal: Launch SaaS product"

## Inputs

TELOS is the principal's life framework stored in `~/.claude/LIFEOS/USER/TELOS/`. The valid file names are the taxonomy in SKILL.md § Data & Config, which the tool's `VALID_FILES` list matches; a valid file not yet present is created as a starter on first write. An install that keeps TELOS unified holds the categories as H2 sections of TELOS.md (Ideal State, Current State, Mission, Goals, Strategies, Wisdom, Wrong and so on), and its updates target TELOS.md with `--section`. `updates.md` is the change log and `Backups/` holds the timestamped backups.

## Safety gates

### Validation Rules

Before executing update:
- File name is in the valid list
- Content is not empty
- Description accurately represents the change
- Content format matches the file type
- User confirmed the update (for major changes)

### Backup Failed
**Error:** `❌ Failed to create backup: [error]`
**Fix:** Check directory permissions and backup folder
**Response:** "The backup system isn't working. This is critical - we need to fix this before making any TELOS updates."

### Company system sync (if configured)

Installs with a company-context gateway skill (a private skill, not in the public release payload) also push company-relevant slices of an update — business goals, work strategies, company state — to that tenant in the same motion, selectively; personal material never crosses. Installs without it skip this step.

## Tool contract

### Update TELOS File (Guided)
Three positional parameters: the file name (e.g., BOOKS.md, BELIEFS.md), the content to add, and the change description for the changelog. Optional `--section "<heading>"` inserts at the end of the section whose heading starts with that text (case-insensitive) instead of appending at end of file; it exists because TELOS.md is section-structured and an end-of-file append would file the entry under the wrong heading. Without it, content lands above a trailing italic footer when the file has one.

!`FILE="$1"; CONTENT="$2"; DESCRIPTION="$3"; bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts "$FILE" "$CONTENT" "$DESCRIPTION"`

### Refresh an AUTOMATED Region
`--region current|ideal` names the region inside `## Current State` or `## Ideal State`, and `--body-file` names a file holding the new region body. The optional positional after `TELOS.md` is the change description (default `refresh AUTOMATED <region> region`). It writes TELOS.md only.

The body may carry H4 (`####`) headings and plain lines. It may not carry any other heading level, a `---` divider, an AUTOMATED marker, an `<!-- updated -->` marker, or more than one stamp line; the tool adds its own stamp line. When the fence is absent, it is created at the end of its section.

A body whose content hash matches the stored one writes nothing, takes no backup and logs nothing. A real write backs up to `Backups/TELOS.region-<timestamp>.md`, a prefix the hand-edit backup prune never touches. It refuses when TELOS.md changed on disk mid-write, then logs one line to updates.md. The format and validation live in `LIFEOS/TOOLS/TelosRegions.ts`.

```bash
bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts TELOS.md --region ideal --body-file /path/to/ideal-body.md "Refreshed ideal-state projection"
```

Errors, each writing nothing: `❌ --region writes only TELOS.md`, `❌ --region needs one of: current, ideal`, `❌ --region needs --body-file <existing file>`, and `❌ <reason>` for a rejected body or malformed fences (for example `region body line 3: only H4 (####) headings are allowed`).

### View Recent TELOS Updates
!`head -50 ~/.claude/LIFEOS/USER/TELOS/updates.md`

### View Specific TELOS File
!`FILE="$1"; cat ~/.claude/LIFEOS/USER/TELOS/"$FILE"`

Examples:
```bash
bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts "BOOKS.md" "- *Project Hail Mary* by Andy Weir" "Added favorite book: Project Hail Mary"
bun ~/.claude/skills/Telos/Tools/UpdateTelos.ts "TELOS.md" "- Thought remote work would end mentorship; it did not" "Recorded a wrong belief" --section "Wrong"
```

### Backup System

The script (`~/.claude/skills/Telos/Tools/UpdateTelos.ts`) validates the file name against its allowed list, then:
1. Copies the file to `~/.claude/LIFEOS/USER/TELOS/Backups/` as `<NAME>-<timestamp>.md`, keeping the 3 newest backups per file (git is the durable history)
2. Writes the content (appended or into `--section`), preserving existing content; a `--section` insert lands above any AUTOMATED region in that section, and a heading inside a region never matches `--section`
3. Logs the change to `updates.md` (an older `Updates.md` is used when that casing already exists), with every timestamp in the principal's timezone

### Invalid File Name
**Error:** `❌ Invalid file: BOOK.md`
**Fix:** File names must be exact: "BOOKS.md" not "BOOK.md"

### Missing Content
**Error:** `❌ Usage: update-telos <file> "<content>" "<change-description>"`
**Fix:** Provide all three parameters

### Section Not Found
**Error:** `❌ Section not found in TELOS.md: "<heading>"`
**Fix:** Nothing was written (the backup remains); pass a heading that exists in the file

## Gotchas

- The content argument must be a single quoted shell argument, as in the tool usage `update-telos <file> "<content>" "<change-description>"`.
- The tool reaches TELOS.md and the split-file taxonomy only. A target that also lives in a per-domain `IDEAL_STATE/` or `CURRENT_STATE/` file is rejected there as `❌ Invalid file`, and the tool cannot replace a hand-written value in place; only the AUTOMATED regions are replaced, through `--region` (2026-10-01: a request to change one target named a value kept both in TELOS.md's Ideal State section and in an `IDEAL_STATE/` domain file).

## Examples

**Request:** "I just finished Project Hail Mary, add it to TELOS"
→ `- *Project Hail Mary* by Andy Weir` appended to BOOKS.md, described "Added favorite book: Project Hail Mary"; the reply says it was added and backed up and asks whether there is a lesson or insight to capture too.

**Request:** "Add three books: Dune, Foundation, and Neuromancer"
→ Three separate update commands, one per book, each with its own backup and changelog line.

**Request:** "Add to ideal state: publish one book a year"
→ The entry is inserted into TELOS.md with `--section` naming the ideal-state heading it belongs under, and updates.md records the section.

**Request:** "Refresh the ideal-state AUTOMATED region from the delta loop's output"
→ The rendered body is saved to a file and written with `UpdateTelos.ts TELOS.md --region ideal --body-file <file>`. Only the bytes between the `ideal` markers change, or nothing is written when the body is unchanged.
