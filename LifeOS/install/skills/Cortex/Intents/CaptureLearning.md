# CaptureLearning

**Contents:** Ideal State · Anti-criteria · Inputs · Tool contract · Gotchas · Output format · Examples

A solved problem preserved by hand as a six-element learning narrative (Problem, Assumption, Reality, Journey, Solution, Takeaway) with its dead ends kept, written to `LEARNING/SYSTEM/YYYY-MM/` so the problem costs its hours only once.

## Ideal State

- The document tells all six elements: the problem, the initial assumption, the actual reality, the troubleshooting journey, the solution (with the commands, code or config that fixed it), and the takeaway for next time.
- The troubleshooting journey keeps what was tried and failed, why the wrong cause looked right, and the moment the real cause showed, so a future reader learns the path and not just the fix.
- When the principal says "capture this learning" right after the work, the narrative comes from the recent conversation (the last 20–30 messages), shown back as a one-line summary for their confirmation before the file is written.
- The file sits at the path and filename the Tool contract gives, with the frontmatter (`capture_type`, `timestamp`, `tags`, `problem_domain`) search depends on, and carries its source and date.
- Updating an existing learning edits that file and appends an `Updates` section with a timestamp; it never creates a second file.
- The confirmation names the absolute path written and how to find it again (CheckRecent, or `rg` over the LEARNING store).

## Anti-criteria

- Never makes the principal re-explain work that just happened in the conversation.
- Never records only the solution without the context, the dead ends, or why the fix works.
- Never writes outside `LIFEOS/MEMORY/LEARNING/`, and never into the KNOWLEDGE archive (that is `add` / `ingest`, with their schema and link rules).

## Inputs

- An optional brief problem description: it seeds the filename (sanitized to kebab-case) and the opening question.
- With no description and no recent problem-solving in the conversation, the six elements are drawn out conversationally, never as a form.

## Tool contract

Filename: `YYYY-MM-DD-brief-problem-description.md` (example: `2025-10-13-typescript-module-resolution-fix.md`): current date, kebab-case, 3-6 words that capture the essence, no special characters except hyphens.

Storage path, organized by month: `~/.claude/LIFEOS/MEMORY/LEARNING/SYSTEM/YYYY-MM/` for tooling and infrastructure lessons; `~/.claude/LIFEOS/MEMORY/LEARNING/ALGORITHM/YYYY-MM/` for lessons about how a task was approached. These are the stores the LifeOS learning hooks write and CheckRecent reads.

Timestamp: `date -Iseconds` (ISO 8601 with the machine's current UTC offset, so it is right in any zone and season).

## Gotchas

- **Learning capture includes source and date.** Undated learnings lose context over time.

## Output format

```markdown
---
capture_type: LEARNING
timestamp: [output of date -Iseconds, e.g. 2026-10-11T14:03:22-07:00]
tags: [relevant, technology, tags]
problem_domain: [e.g., "typescript", "deployment", "authentication"]
---

# Learning: [Title - What We Fixed/Learned]

**Date:** YYYY-MM-DD
**Domain:** [Technology/Area]

---

## The Full Story

### The Problem We Encountered
### What We Initially Thought
**Our assumption:** [...]
### What We Discovered Was Actually True
**The reality:** [...]
### The Journey: Troubleshooting Steps
1. **First attempt:** [what we tried and why it didn't work]
2. **Second attempt:** [next approach and results]
3. **Breakthrough moment:** [what finally revealed the truth]
4. **Verification:** [how we confirmed this was the real issue]
### The Solution That Worked
**Implementation:** [code, commands, or configuration]
**Why this works:** [the mechanism]

---

## The Lesson Learned

**So now we know:** [core insight]

### How to Do It Next Time
- ✅ Do this first
- ✅ Check this next
- ❌ Don't waste time on this
### Related Knowledge
### Warning Signs

---

## Technical Details

**Environment:** · **Files Modified:** · **Commands Used:** · **Resources:**

---

## Quick Reference

**TL;DR:** [one sentence]
**Keywords:** [comma-separated search terms]
```

The confirmation after the write:

```
✅ Learning captured successfully!

📁 Location: ~/.claude/LIFEOS/MEMORY/LEARNING/<SYSTEM|ALGORITHM>/<YYYY-MM>/<filename>.md

🔍 Find it later with CheckRecent, or rg over ~/.claude/LIFEOS/MEMORY/LEARNING/.
```

## Examples

- **Technical problem:** "TypeScript Module Resolution with Bundler Mode" — imports failing despite correct paths; the moduleResolution setting depends on the bundler.
- **Tool discovery:** "Kitty Terminal Remote Control API" — couldn't change tab titles programmatically; the remote control API needs a specific socket setup.
- **Approach lesson:** "Parallel Agent Research Pattern" — sequential research took 10 minutes; 10 parallel agents took under one. Filed under `ALGORITHM/`.
