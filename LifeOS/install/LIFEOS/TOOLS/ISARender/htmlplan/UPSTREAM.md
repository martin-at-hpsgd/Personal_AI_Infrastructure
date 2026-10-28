# Upstream: html-plan

This folder is a port of **html-plan** by **Thariq Shihipar** (Anthropic), the runtime behind his interactive HTML plans for Claude Code. ISARender uses it to draw exhibits, decisions and the Respond paste-back on ISA pages.

| | |
|---|---|
| Source | `github.com/anthropics/claude-plugins-community`, folder `html-plan/skills/html-plan/` |
| Commit | `f60f0454df3045f724c43c6346ec80bdcc3472b2` (`f60f045`, 2026-10-05) |
| Author | Thariq Shihipar |
| License | the repository's `LICENSE` is Apache-2.0 (the plugin's `plugin.json` declares MIT). We follow the stricter one: the Apache-2.0 text ships here as `LICENSE`, upstream has no `NOTICE` file, and each modified file (`htmlplan.js`, `pack.mjs`, `blocks.md`) opens with a notice that it was changed. `htmlplan.css` is unmodified. |
| Ported | 2026-10-06, as a port and not an install (OPERATIONAL_PREFERENCES § Skills) |

## Files

| Ours | Upstream |
|---|---|
| `htmlplan.js` | `runtime/htmlplan.js` plus the patches below |
| `htmlplan.css` | `runtime/htmlplan.css`, unchanged |
| `pack.mjs` | `runtime/pack.mjs` plus the patches below (runs under bun; imports the shared secret-shape inventory from the hooks library, so it needs the LifeOS tree) |
| `blocks.md` | `references/blocks.md` plus the patches below: the element reference |
| `bridge.css` | ours: maps the runtime's tokens onto the ISA template's LifeOS tokens |
| `LICENSE` | upstream's Apache-2.0 text, unmodified |
| `upstream-diff.ts` | ours: proves the copy equals upstream plus the patches |

## Local patches

`upstream-diff.ts` `PATCHES` is the exact list, each as the upstream text and our text. `bun upstream-diff.ts check` undoes them and compares the result to the upstream hash.

`htmlplan.js` (6): reader-visible words, plus the modification notice.

1. `## Struck from the plan` → `## Struck from the ISA`
2. `feedback on the plan` → `feedback on the ISA`
3. `claim N` → `criterion N` on the Respond sheet's decision rows
4. `(no claim)` → `(no criterion)`
5. `inside this claim` → `inside this criterion`
6. A one-line modification notice at the top.

`blocks.md` (3): one inserted line documenting ISARender's ask-lifecycle attributes, the `pack.mjs` command as it runs in this tree (`bun`, this folder's path), and the modification notice.

`pack.mjs` (17): a modification notice, `bun` in the shebang and usage lines, plus security changes made after the release audits. Packed pages carry a restrictive CSP as a `<meta>` first in `<head>`. Remote resources are lint errors. Git-backed embedding is scoped to the root's own folder with `./` paths. Stylesheets, scripts, media and code excerpts pass the shared credential inventory before anything is inlined, and media must be an allowed type with a matching signature.

## Upgrading

```bash
git clone --depth 1 https://github.com/anthropics/claude-plugins-community <scratch>/repo
bun upstream-diff.ts apply <scratch>/repo/html-plan/skills/html-plan
# update FILES sha256 values in upstream-diff.ts to the new upstream hashes, then:
bun upstream-diff.ts check
```

Before taking a new upstream, read the diff and scan it for network calls; ISA pages must stay offline.
