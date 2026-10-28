---
name: CreateCLI
evals:
  manual:
    reason: "the generated CLI must be reviewed against the requested command contract, including arguments, output, and documentation"
    falsifier: "the reviewer finds a requested command path, JSON/exit-code contract, or documented usage absent from the generated CLI"
metadata:
  short-description: "Build production TypeScript CLIs with argument parsing, JSON output, documentation, and exit-code contracts. Use CreateSkill for skill scaffolding."
version: 1.1.34
description: "Generates production-ready TypeScript CLIs via a 3-tier template system (manual arg parsing, Commander.js, oclif), each shipping full implementation, docs, package.json, strict config, JSON output, and exit-code compliance. USE WHEN create CLI, build CLI, command-line tool, wrap API, add command, upgrade tier, TypeScript CLI. NOT FOR LifeOS skill scaffolding (use CreateSkill)."
---

# CreateCLI

**Contents:** Ideal State · Intent Routing · Data & Config · Gotchas · Examples

Generates production-ready TypeScript CLIs, from agent-first CLIs for public web apps (API-key auth, browser device login) to personal and project tools. Every CLI ships with full implementation, README and QUICKSTART, a Bun package.json, strict tsconfig, JSON output, and correct exit codes. A three-tier template system picks the right complexity: Tier 1 manual arg parsing with zero deps (most cases), Tier 2 Commander.js for subcommands, Tier 3 oclif as a reference for enterprise scale.

Shared facts the intents rely on:

- **Tiers.** Tier 1 parses `process.argv` by hand with zero framework dependencies, Bun + TypeScript and type-safe interfaces in ~300-400 lines, in four sections: configuration, command functions, help documentation, main entry point. It fits API clients, data transformers and simple automation with 2-10 commands, simple arguments, JSON output and no subcommands. Tier 2 (Commander.js) is the escalation when any Tier 2 indicator holds, the same list for CreateCli and UpgradeTier: 10+ commands that need grouping, git-style subcommands (`cli convert json csv` / `cli convert csv json`), a plugin architecture, complex nested option combinations, or multiple output format engines (a `--format json` flag alone is standard Tier 1 output control). A long list of simple, ungrouped commands is not an indicator. Tier 3 (oclif) is reference only, documentation and no templates, for Heroku CLI or Salesforce CLI scale.
- **Stack.** Runtime and package manager are Bun, the language is TypeScript with a strict tsconfig, tests (when added) run under `bun test ./<path>`, output is deterministic JSON that pipes to jq and grep, and documentation is README + QUICKSTART.
- **Placement.** `~/.claude/LIFEOS/TOOLS/[cli-name]/` holds personal CLIs and `~/Projects/[project-name]/` project-specific ones. The two sit in different git repositories, so confirm which repository a CLI directory belongs to before any git operation in it.
- **CLI-First Architecture** (`LIFEOS/DOCUMENTATION/Tools/CliFirstArchitecture.md`): every generated CLI is deterministic (same input → same output), clean (single responsibility), composable (JSON output pipes to other tools), documented (comprehensive help and examples) and testable (predictable behavior).

## Ideal State

- Every CLI the skill creates or changes ships whole: typed source, README.md and QUICKSTART.md, a Bun package.json, a strict tsconfig.json, an .env.example, and `--help` that lists every command with real examples.
- Output follows one contract across intents: JSON to stdout, errors with context to stderr, exit code 0 on success and 1 on error, and strict `tsc` clean before the work is reported done.
- A CLI for a public-facing app meets the agent-first contract (OPERATIONAL_PREFERENCES § Deployment): a browser device login that mints a scoped, expiring API key; `--json` stdout and fixed exit codes; a `help --json` catalog; RateLimit headers with per-key and per-IP limits; `/docs/cli` rendered from the CLI's own catalog; and a self-hosted, SHA-checked install. `Intents/CreateCli.md` § Ideal State itemizes it, and Config.md names the reference implementation to match when one is configured. Where that contract and the output contract above differ, the agent-first contract governs.
- The tier fits the need: Tier 1 unless a Tier 2 indicator holds, oclif never generated, and a CLI moves up a tier only when it has outgrown the one it is on.
- A change to an existing CLI keeps every command it already had working.

## Intent Routing

| Intent | Trigger | File |
|--------|---------|------|
| **CreateCli** | "create CLI", "build a CLI", "wrap this API in a command-line tool" | `Intents/CreateCli.md` |
| **AddCommand** | "add a command to <cli>" | `Intents/AddCommand.md` |
| **UpgradeTier** | "upgrade tier", "move this CLI to Commander" | `Intents/UpgradeTier.md` |

| File | Read when |
|------|-----------|
| `FrameworkComparison.md` | choosing or justifying a framework: Manual vs Commander vs oclif, plus cleye, citty, Yargs and Ink |
| `Tools/CheckCli.ts` | proving a CLI meets the output contract: strict `tsc`, `--help` names every command, `--version`, unknown command exits 1, `--json-args` stdout parses as JSON |
| `Setup.md` | first-time setup: the optional `Reference CLI:` key in Config.md |

## Data & Config

User customizations live at `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/CreateCLI/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`). When that directory exists, its PREFERENCES.md, configurations and resources apply and override the defaults here; when it is absent, the defaults stand.

`Config.md` there holds one optional key, `Reference CLI:`, naming an existing CLI that already meets the public-app agent-first contract (its path and the criteria that define it). When it is set, a new public-app CLI matches that CLI's command catalog, device login, exit codes and install script; when it is unset, the contract as written here governs. First-time setup: [Setup.md](Setup.md).

## Gotchas

- **Bun, never npm or npx**, with no exceptions: the system prompt's tech stack names bun as the package manager.
- **TypeScript only, never Python.** Every CLI this skill generates is TypeScript on Bun, with no Python or other scripting-language helpers. The install's broader language preferences (for example, which compiled language to use when a binary is required) live in the USER `PREFERENCES.md` (§ Data & Config).
- **Env loading has one correct shape.** Read secrets from the canonical `~/.claude/.env`, never `${LIFEOS_DIR}/.env` (the `~/.claude/LIFEOS/.env` path public issue #1490 found dead) or `$LIFEOS_CONFIG_DIR/.env`, and slice past the first `=` instead of `.split('=')[1]`, which truncates values that contain '=' such as padded base64 keys. `Intents/CreateCli.md` § Output format carries the correct `loadConfig()`.

## Examples

### Example 1: API Client CLI (Tier 1)

**User Request:**
"Create a CLI for the GitHub API that can list repos, create issues, and search code"

**Generated Structure:**
```
~/.claude/LIFEOS/TOOLS/ghcli/  # generated example, not shipped
├── ghcli.ts              # 350 lines, complete implementation
├── package.json          # Bun + TypeScript
├── tsconfig.json         # Strict mode
├── .env.example          # GITHUB_TOKEN=your_token
├── README.md             # Full documentation
└── QUICKSTART.md         # Common use cases
```

**Usage:**
```bash
ghcli repos --user exampleuser
ghcli create-issue --repo myrepo --title "Bug fix"
ghcli search "typescript CLI"
ghcli --help
```

### Example 2: Add a command

```
User: "Add a search command to ghcli"
→ AddCommand intent
→ `ghcli search <query>` runs and exits 0, appears in --help and the README, and every existing command still works
```

### Example 3: Outgrown Tier 1

```
User: "notioncli has 18 commands in four groups now, move it to Commander"
→ UpgradeTier intent
→ A Commander.js CLI at 2.0.0 with every command and the help examples intact, and a Breaking Changes note in the README that names what changed for callers
```
