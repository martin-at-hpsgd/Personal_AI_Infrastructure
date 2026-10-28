# CodingProject

**Contents:** Ideal State · Anti-criteria · Evals · Inputs · Tool contract · Gotchas · Output format · References

A complete starter project for a coding idea: what it is, how it works, its file tree, every file's code, a setup script that builds it, and the takeaways and next steps, in nine fixed sections.

Our ideal-state port of Fabric's `create_coding_project`. The upstream pattern stays in `Patterns/` for reference; this intent replaces it whenever a request asks for that pattern, so the old prompt never runs.

## Ideal State

- The project is the one the principal wants from this input, inferred before a line is written and never asked for. A bare idea or topic ("a CLI that resizes new images in a folder") means the smallest project that does that job end to end. A bare question ("how would I build a URL shortener with an API") means that project built, with the design choice the question turns on answered in SUMMARY. A pasted artifact or a file means: a spec, issue or README is the requirements list and the project implements every requirement in it; an existing script or code is the behavior to keep, restructured into a project around it. A URL means the same once fetched: a spec or issue page is the requirements, an API's documentation is the service the project is built against. "This" or "that" means the project idea already in the conversation. A hint typed with the input (a language, a framework, "no dependencies", "just the backend", "minimal") overrides the default read and wins over every default below.
- The language and stack are the ones the input names; otherwise the one that best fits the job, named in SUMMARY with the reason in one clause. Dependencies are the current stable releases at their current APIs, pinned in the project's manifest, and as few as the job allows.
- The project runs. Every file in CODE is complete: no stub function, placeholder body, elided `...` block or "TODO: implement". Every import resolves to a file in the project or a dependency the manifest declares. Following SETUP and then the run command in README.md gives a working program for the requested job.
- The project is secure by default: secrets and endpoints come from environment variables documented in a `.env.example` or the README and never sit in code; input from users, files and the network is validated where it enters; queries are parameterized; no shell command is built by string interpolation of input; errors are handled where they happen and never swallowed.
- The project is composable: each module has one job, the core logic is separate from I/O so it can be called and tested on its own, and at least one test file exercises the core logic with the project's test runner.
- A choice the input leaves open (which storage, which port, which image size) is made with a sensible default, stated in SUMMARY with how to change it, and never turned into a question. An external API is used only as far as its public documentation supports; a call whose endpoint or field names are uncertain sits in one adapter module with a comment naming what to confirm.
- The sections agree with each other. STRUCTURE, DETAILED EXPLANATION and CODE list exactly the same files, SETUP creates every one of them with the same content CODE shows, and STEPS, SUMMARY and README.md describe the project that the code actually is.
- PROJECT is one sentence of at most 20 words. STEPS is a numbered list of the order to build and run the project, each step at most 16 words. DETAILED EXPLANATION gives each file's purpose in at most 16 words. TAKEAWAYS is a numbered list and SUGGESTIONS a bulleted list, both specific to this project: a takeaway names a design decision, risk or lesson of this build, and a suggestion names a next feature or hardening step for it.
- Comments in the code say why on each step that is not self-evident; no comment restates the line it sits on. README.md is one of the files and covers prerequisites, configuration, running and testing.
- A follow-up asking for a change ("use Postgres instead", "add auth") returns all nine sections again with every affected file in full, so the revised output stands on its own.
- A source is read in full before anything is written (`Intents/ExecutePattern.md` § Tool contract covers fetching URLs and YouTube links).
- The words are plain and exact, specific to this project: a sentence in SUMMARY, TAKEAWAYS or SUGGESTIONS could not be moved to a different project and stay true.
- `bun skills/Fabric/Tools/CodingProjectCheck.ts` passed on the exact output before it was delivered. Where no shell is available, the shape is checked by hand and nothing about the check appears in the output.

## Anti-criteria

- Never a file named in STRUCTURE with no code in CODE, a file in CODE missing from STRUCTURE, or a generated artifact (a log file, a build output, `node_modules`) listed as if it were authored.
- Never a requirement from a supplied spec left out of the project, and never existing code's behavior changed when the ask was to restructure it.
- Never a hard-coded secret, token or password, a `curl … | sh` install in SETUP, or a deprecated API where a current one exists.
- Never an enterprise skeleton for a small job: no empty directories, layers or config files the project does not use.
- Never a question back to the principal about the language, the scope or what was meant, when the input and the defaults above settle it.
- No preamble, persona, reasoning narration, closing offer, or free-standing "Note:" and "Warning:" lines: the output is the nine sections and nothing else.
- Never the old Fabric pattern text run as the prompt for this request.

## Evals

- suite: fabric-codingproject — code checks on the nine sections and the literal facts each case pins, plus judged checks on whether the code does the job, keeps every requirement, stays secure and matches across sections.
- compiled: Assay checks every output against the Ideal State and Anti-criteria above.

## Inputs

- The subject: a project idea or topic; a question about how to build something; a pasted spec, issue, README or existing code; a file path; a URL to a spec, issue or API doc; or "this"/"that" for the idea already in the conversation.
- Optional: a hint typed with it (language, framework, scope, dependency limits).
- Optional, on a follow-up: the change to make to the project already delivered.

## Tool contract

Run from `~/.claude`. Save the draft, check it, and deliver only on exit 0:

```bash
bun skills/Fabric/Tools/CodingProjectCheck.ts <file|-> [--json]
#   exit 0: shape holds; exit 1: prints each failed rule; exit 2: bad usage or unreadable input
```

### Intent-to-Flag Mapping

| The run has | Flag |
|---|---|
| a draft saved to a file | the file path |
| a draft piped in | `-` |
| a caller that wants the result as data | `--json` |

The checker parses what it can: SETUP and every `.sh` file with `bash -n`, `.json` files with `JSON.parse` (so a `tsconfig.json` is written as strict JSON, without comments), `.yaml`/`.yml` with `Bun.YAML.parse`, `.toml` with `Bun.TOML.parse`, and `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` with Bun's transpiler. Other languages get the shape checks only.

## Gotchas

- **An unquoted heredoc in SETUP rewrites the code it writes.** `cat > a.ts <<EOF` expands `${…}` and runs `$(…)` inside the body, so a TypeScript template literal comes out empty and a command substitution executes on the reader's machine (verified with bash, 2026-10-25). Every heredoc that writes a file uses a quoted delimiter (`<<'EOF'`), and the checker fails any that does not.

## Output format

All nine sections, in this order, each written as shown:

````markdown
## PROJECT

{one sentence, at most 20 words}

## SUMMARY

{how the project works, the stack and why, and each open choice with its default and how to change it}

## STEPS

1. {build or run step, at most 16 words}
2. …

## STRUCTURE

```text
project-name/
├── src/
│   └── core.ts
├── README.md
└── package.json
```

## DETAILED EXPLANATION

- `src/core.ts`: {purpose, at most 16 words}
- …

## CODE

### `src/core.ts`

{one line: what this file does}

```ts
{the complete file}
```

### `README.md`

…

## SETUP

```bash
{one script that creates the directory, writes every file with a quoted heredoc, installs dependencies and runs the tests}
```

## TAKEAWAYS

1. {a design decision, risk or lesson of this build}
2. …

## SUGGESTIONS

- {a next feature or hardening step for this project}
- …
````

Paths in DETAILED EXPLANATION and the `###` headings under CODE are relative to the project root shown on the first line of STRUCTURE. A fence that holds another fence (README.md in CODE, and the SETUP script that writes it) opens with more backticks than any fence inside it (` ```` `), so the inner one cannot close it. Nothing appears before `## PROJECT` or after the last suggestion.

## References

- Upstream: `Patterns/create_coding_project/system.md` (an "elite programmer" persona told to take a deep breath and think step by step; nine sections PROJECT, SUMMARY, STEPS, STRUCTURE, DETAILED EXPLANATION, CODE, SETUP, TAKEAWAYS and SUGGESTIONS, written with trailing colons; a 20-word PROJECT sentence, 16-word limits on STEPS and DETAILED EXPLANATION, numbered STEPS and TAKEAWAYS, a README.md, comments on every step, no deprecated features, and no warnings or notes).
- `Tools/CodingProjectCheck.help.md`: the checker's rules and exit codes.
- `Intents/ExecutePattern.md` § Tool contract: fetching URLs and YouTube transcripts.
