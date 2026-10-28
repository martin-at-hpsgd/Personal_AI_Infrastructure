---
name: ri
description: Read it — read content aloud in the DA's Fish voice. A URL, a file, pasted text, or bare "ri" for the last thing the DA wrote. Shortcut for the ReadIt skill. Bare "ri" means the same thing.
argument-hint: "[url | file | text | stop | pause | resume | status]"
version: 1.0.2
---

# ri — Read it

The principal typing `/ri` (or a bare `ri`) means **"Read it to me."** Alias for the **ReadIt** skill.

- `/ri` → read the most recent substantive thing in the conversation (the write-up I just produced, or the source we were looking at; ask one question if it could be either)
- `/ri <url>` → fetch the page and read its prose
- `/ri <file>` → read the file
- `/ri <pasted text>` → read the text
- `/ri stop` · `/ri pause` · `/ri resume` · `/ri status` → control the running read

**Invoke the skill directly:**

```
Skill("ReadIt", "Read — $ARGUMENTS")
```

If `$ARGUMENTS` is `stop`, `pause`, `resume`, or `status`, route to the skill's Control table instead of starting a new read.
