# CreateCLI

Status: `test -f ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CreateCLI/Config.md && echo ok` · optional

## What it does

CreateCLI generates TypeScript command-line tools on Bun: typed source, help text with real examples, JSON output and fixed exit codes, then proves the result with `Tools/CheckCli.ts`. A CLI for a public-facing app also meets an agent-first contract (device login, a `help --json` catalog, rate limits, a SHA-checked install). It works with no setup.

## Fill in

One optional file, `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CreateCLI/Config.md` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), with one key:

| Key | Meaning |
|---|---|
| `Reference CLI:` | an existing CLI of yours that already meets the public-app agent-first contract: where its source lives and which criteria define it. New public-app CLIs copy its command catalog, device login, exit codes and install script. Leave it out and the contract in SKILL.md governs on its own. |

A made-up example:

```markdown
- **Reference CLI:** the ExampleNet CLI, source at `~/Projects/examplenet/cli/`, contract in `~/Projects/examplenet/ISA.md` (the CLI criteria).
```

Optionally, `PREFERENCES.md` in the same folder records broader language taste (for example `- **Languages:** TypeScript for scripts and CLIs; Rust when a compiled binary is required.`). It never changes what CreateCLI generates, which is always TypeScript on Bun.

## Accounts and secrets

None. A generated CLI that calls an API lists its own keys in its `.env.example`; their values go in `~/.claude/.env`.

## Prove it works

```bash
bun skills/CreateCLI/Tools/CheckCli.ts --help
```

Success: the usage text prints and the command exits 0. Then ask your assistant "create a CLI that wraps the httpbin API" and expect a project with `--help`, JSON output and a passing `CheckCli.ts` run.
