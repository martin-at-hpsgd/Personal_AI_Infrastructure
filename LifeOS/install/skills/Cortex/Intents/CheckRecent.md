# CheckRecent

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Output format · Examples

A digest of the last N captured learnings and saved research files: what the recent work was, its themes, and the lessons in it.

## Ideal State

- The report covers the requested number of most recent files (20 by default), and says so plainly when fewer exist: "Analyzed all [X] available history files (requested [NUMBER])."
- It opens with the full absolute paths of the last 10 files analyzed (or all of them when fewer), so the principal can see exactly what was read.
- Every section of the Output format is filled from what the files actually say: work summary and period covered, themes, work items, lessons, technical insights, challenges and solutions, top takeaways, trajectory.
- Files are chosen by the date in their path or filename when the principal asks about a recent period, since modification time alone picks up old files that were recently touched.

## Anti-criteria

- Never reports a lesson, theme or work item that is not in the files read.
- Never treats prior sessions, ISAs or decisions as part of this store; those come from the `recall` bundle.

## Inputs

- A number sets how many files to analyze; default **20 files**.
- "all" analyzes every markdown file in the stores below, with no limit.
- "only learnings" or "only research" filters to that store.

## Tool contract

Stores (whichever exist): `~/.claude/LIFEOS/MEMORY/LEARNING/SYSTEM/` and `~/.claude/LIFEOS/MEMORY/LEARNING/ALGORITHM/` (captured learnings); `~/.claude/LIFEOS/MEMORY/RESEARCH/` (saved research).

Newest first by modification time, documentation files excluded:

```bash
find ~/.claude/LIFEOS/MEMORY/LEARNING/SYSTEM/ ~/.claude/LIFEOS/MEMORY/LEARNING/ALGORITHM/ ~/.claude/LIFEOS/MEMORY/RESEARCH/ -type f -name "*.md" -print0 2>/dev/null | \
  xargs -0 ls -lt | \
  grep -v "README.md\|CLAUDE.md\|COMPLETE.md" | \
  head -n [NUMBER] | awk '{print $NF}'
```

For a date window, filter before the `head`, for example only October 2025 files: `... | grep "2025-10" | head -n [NUMBER]`.

## Output format

```
📂 FILES ANALYZED (Last 10 shown):
1. /path/to/file1.md
…
10. /path/to/file10.md

## 📊 WORK SUMMARY
- Overall summary of recent work in 2-3 sentences
- Time period covered by these files

## 🎯 KEY THEMES
- Major themes and patterns, technologies and tools, types of problems, recurring topics

## 🔍 SPECIFIC WORK ITEMS
- [Item]: [Brief description]

## 💡 LESSONS LEARNED
- [Lesson]: [What was learned and why it matters]

## 🏗️ TECHNICAL INSIGHTS
- Architecture decisions, technical approaches, tools and frameworks adopted, integration patterns

## ⚠️ CHALLENGES & SOLUTIONS
- Problems encountered, how they were solved, what to avoid

## 🎓 KEY TAKEAWAYS
- Top 3-5 most important insights

## 📈 TRAJECTORY
- Where the work is heading, emerging directions, areas of growing focus
```

## Examples

```
"what did we learn recently"   -> last 20 files (default)
"check recent history 50"      -> last 50 files
"check recent history all"     -> everything in the stores above
"check recent learnings"       -> learnings only
```
