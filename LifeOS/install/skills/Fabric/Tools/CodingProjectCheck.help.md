# CodingProjectCheck

Checks a CodingProject output (`Intents/CodingProject.md`) against the parts of its contract that code can judge, and parses every file it has a parser for. Whether the code does the job, keeps every requirement and is secure in substance stays a judged check in the `fabric-codingproject` suite.

## Usage

```bash
bun skills/Fabric/Tools/CodingProjectCheck.ts <file|-> [--json]
```

| Flag | Meaning |
|------|---------|
| `<file\|->` | The saved output, or `-` for stdin |
| `--json` | Print `{ok, sections, files, validated, problems}`; `validated` lists each file and the parser that read it |
| `--help` | Print usage |

## Checks

- **Sections.** The nine sections PROJECT, SUMMARY, STEPS, STRUCTURE, DETAILED EXPLANATION, CODE, SETUP, TAKEAWAYS and SUGGESTIONS, each an H2 written exactly so (no trailing colon), once each, in that order, none empty. No H1, nothing before `## PROJECT`, and no free-standing `Note:`/`Warning:` line or closing offer outside a code block.
- **PROJECT** is one sentence of at most 20 words, not a list.
- **STEPS** is a numbered list from 1 with no gaps, at least two steps, each at most 16 words. **TAKEAWAYS** is a numbered list the same way. **SUGGESTIONS** is a bulleted list of at least two. No list repeats an item.
- **STRUCTURE** holds a fenced, drawn tree (`├──`, `└──`, `│`). Its first plain line is the project root. A leaf ending in `/` is an empty directory and fails.
- **DETAILED EXPLANATION** has one `path: purpose` entry per file, each purpose at most 16 words.
- **The file lists agree.** STRUCTURE's files, DETAILED EXPLANATION's entries and CODE's `###` headings name exactly the same paths (a leading `./` or the root directory name is ignored).
- **CODE** gives each file a `### path` heading, a one-line description and one fenced block that is not empty, with nothing after it. A top-level `README.md` is present. No line is a placeholder (`TODO`, `FIXME`, a bare `...`, "your code here", "rest of the code"). No file outside tests and `.env.example` holds a secret-shaped literal (cloud access keys, `sk-`/`ghp_` tokens, private-key blocks, a quoted value assigned to `password`, `token`, `secret` or `api_key`).
- **Parsers.** `.json` with `JSON.parse` (strict: no comments), `.yaml`/`.yml` with `Bun.YAML.parse`, `.toml` with `Bun.TOML.parse`, `.ts`/`.mts`/`.cts`/`.tsx`/`.js`/`.mjs`/`.cjs`/`.jsx` with `Bun.Transpiler`, `.sh`/`.bash` with `bash -n`. Other languages get the shape checks only.
- **SETUP** is one fenced script that passes `bash -n`. Every heredoc delimiter is quoted (`<<'EOF'`, `<<"EOF"` or `<<\EOF`), because an unquoted one expands `$` and backticks inside the file it writes. A heredoc that writes a CODE file writes exactly the content CODE shows (trailing whitespace ignored), and every CODE file is created somewhere in the script. No `curl`/`wget` piped into a shell.
- **Nested fences.** Text found after a file's block, or after the SETUP script, is reported as a block an inner fence closed early; the fix is an outer fence with more backticks.

## Exit codes

- `0` the shape holds
- `1` a rule failed; each failure prints as one `✗` line
- `2` bad usage or unreadable input
