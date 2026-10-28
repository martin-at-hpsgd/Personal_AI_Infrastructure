# SignalCheck.ts - Help Documentation

Deterministic checks for the SecurityMarketData skill. Read-only; prints one JSON line and never prints a secret value.

## Commands

### `setup`

Reports whether `signal-mcp` is configured for Claude Code (`~/.claude.json`, user or project scope) or Codex (`~/.codex/config.toml`), and whether `ROS_API_KEY` exists for the REST fallback.

```bash
bun skills/SecurityMarketData/Tools/SignalCheck.ts setup
bun skills/SecurityMarketData/Tools/SignalCheck.ts setup --claude-json <path> --codex-config <path>
```

Output: `{"ok":bool,"claude":bool,"codex":bool,"rest":bool,"ready":bool}`. It sees configuration only: a configured server whose 24-hour OAuth token has lapsed still reports `ready`, and the first live call is what proves authentication. Hermes keeps its own MCP list (`hermes mcp list`), which this probe does not read.

### `shape`

Checks that a delivered answer carries all six Output format parts: Scope, Observed, Analytical, Freshness, Caveats, Tools. A part counts when a line opens with its label, as a heading (`## Scope`), a bold label (`**Scope:**`), or a plain or listed `Scope:`.

```bash
bun skills/SecurityMarketData/Tools/SignalCheck.ts shape answer.md
pbpaste | bun skills/SecurityMarketData/Tools/SignalCheck.ts shape -
```

Output: `{"ok":bool,"missing":["Caveats", ...]}`. It checks structure only; whether figures match the returned records stays a manual check.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Check passed |
| 1 | Check failed (`ready` false, or parts missing) |
| 2 | Usage error |

## Tests

```bash
# Fixture tests live in the maintainer source tree and are not in the public release.
bun test ./skills/SecurityMarketData/Tools
```
