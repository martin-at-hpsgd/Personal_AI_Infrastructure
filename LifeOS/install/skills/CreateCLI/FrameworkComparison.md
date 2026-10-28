# CLI Framework Comparison

TypeScript CLI frameworks compared, for choosing and justifying a tier. The tier rule and the Tier 2 indicators are listed once, in SKILL.md § Tiers.

**Rule:** Default to Manual → escalate to Commander → reference oclif only. Every dependency is debt, so the best framework is no framework until a Tier 2 indicator proves otherwise.

| Framework | Stars | Bundle Size | TypeScript | Best For | Tier |
|-----------|-------|-------------|------------|----------|------|
| **Manual Parsing** | N/A | 0 KB | Native | API clients, file processors, simple automation (2-10 commands, ~80% of CLIs) | Tier 1 DEFAULT |
| **Commander.js** | 25K+ | ~100 KB, zero sub-dependencies | Built-in | Commands that group into categories (~15% of CLIs) | Tier 2 |
| **oclif** | 12K+ | 22+ MB | First-class | Heroku CLI scale: 50+ commands with topics, auto-update, multi-tenant (~5%) | Tier 3, reference only, never generated |
| **cleye** | N/A | Small | Schema inference | Modern TS CLIs wanting zero-boilerplate typed flags | Alternative |
| **citty** | N/A | Moderate | Discriminated unions | Complex command trees needing exhaustive type checks | Alternative |
| **Yargs** | 30K+ | Larger than Commander | @types | Not recommended: verbose, weaker TypeScript, async typing issues; escalate to Commander instead | — |
| **Ink** | N/A | Large (React) | — | Not recommended for general CLIs: interactive, non-deterministic UIs; only for dashboards and dev servers with live updates | — |

Trade-offs that decide the tier:

- **Manual (Tier 1):** zero dependencies, full control over parsing, 300-400 lines, under 100 KB. Help is written by hand, which keeps it good: auto-generated help is convenient but often poorer. No subcommand routing, which is what Tier 2 is for.
- **Commander (Tier 2):** auto-generated help, subcommand routing, a fluent API and bundled types, at the cost of a dependency and its opinionated structure; overkill for a simple CLI. The typical shape is grouped verbs: `data-cli convert json csv`, `data-cli analyze stats`.
- **cleye / citty:** stronger type inference than Tier 1 at the cost of a framework dependency and less control over parsing; acceptable when the user asks for them, never the default.

Sources: Commander.js 12.x and oclif core documentation; a 32-query framework survey; analysis of the tsx, vite, next and bun CLIs.
