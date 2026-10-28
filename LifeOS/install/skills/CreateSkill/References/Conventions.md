# Skill Conventions

**Contents:** Naming — public vs private · Public-release readiness · Sellable bundles · Folder structure · SKILL.md shape and loading · Skill types · Writing guidance · Verification (evals) · Versioning

The declarative rules every CreateSkill intent holds a skill to, beyond the intent standard itself (`~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Intent anatomy). Intents point here by section; nothing in this file is a procedure.

## Naming — public vs private

A skill's name encodes where it ships. There are exactly two valid forms.

| Skill type | Directory format | Example | Allowed content |
|------------|------------------|---------|-----------------|
| **Public** | `TitleCase` | `Research`, `Interceptor`, `CreateSkill` | Templated, safe, generic, ready for public release |
| **Private** | `_ALLCAPS` (underscore prefix, all uppercase) | `_MYSKILL`, `_MYINBOX`, `_MYINFRA` | A core job whose data or behavior cannot move into `Config.md` (§ The decision rule); body publishable-clean, all sensitive data referenced from `LIFEOS/USER/` |

The leading underscore is the public-release boundary: release tooling skips `_*` skills entirely, so they never leave `~/.claude`. Public skills are mirrored into the LifeOS public release.

| Component | Format | Correct | Wrong |
|-----------|--------|---------|-------|
| Skill directory | TitleCase or `_ALLCAPS` | `CreateSkill`, `_ALLCAPS` (see the table above) | `createskill`, `create-skill`, `create_skill`, `CREATE_SKILL`, `CREATESKILL` |
| Intent files | `TitleCase.md` | `Create.md`, `UpdatePatterns.md`, `SyncRepo.md`, `CreateInfo.md`, `IntentName.md` | `create.md`, `CREATE.md`, `create-skill.md`, `create_skill.md`, `create-info.md`, `update-info.md`, `update-patterns.md`, `intent-name.md`, `UPDATE_INFO.md`, `SYNC_REPO.md` |
| Reference docs | `TitleCase.md` | `ProsodyGuide.md`, `SchemaSpec.md`, `ApiReference.md` | `prosody-guide.md`, `PROSODY_GUIDE.md`, `api-reference.md` |
| Tool files | `TitleCase.ts` | `ManageServer.ts`, `ToolName.ts` | `manage-server.ts`, `MANAGE_SERVER.ts`, `tool_name.ts` |
| Help files | `TitleCase.help.md` | `ManageServer.help.md`, `ToolName.help.md` | |

`SKILL.md` is the one exception: always uppercase. Routing-table intent names match file names exactly.

### The decision rule

The test and the table that decide it live in one place, `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Public vs Private Skills; this section does not restate the table. Ask: **"Could a stranger drop this skill into their `skills/` directory, fill in their own `Config.md`, and have it work?"** Yes → public (`TitleCase`), with user-specific data and config in `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/`. A skill is private (`_ALLCAPS`) only when its data or behavior cannot move into `Config.md`, which happens when its core job depends on one of the six things in that table: a product or business you own or sell, a specific customer or engagement, your own corpus or persona with no general version, offensive security or incident response or home security or surveillance, infrastructure whose shape discloses your security posture, or the release machinery. Names, accounts, paid API keys, domains, figures, tastes and exemplars can always move into `Config.md` or `.env`, so none of them makes a skill private on its own; they make its files need cleaning (§ Public-release readiness).

When in doubt, build it private first. Promoting a private skill to public later is easy; discovering a public skill leaks your life is permanent.

## Public-release readiness

Sensitivity is decided by skill name, not by per-file scrubbing at share time. Both kinds are written publishable-clean from the start.

**Public skill content rule:** only templated, safe, public, ready content.

- Allowed: generic instructions any LifeOS user could follow; templated patterns with placeholders; public API references and dependencies on public tools; generic `~/` paths (`~/.claude/skills/`, `~/Projects/<tool>/`); public repo URLs for dependencies; placeholder values (`<url>`, `<SESSION_ID>`, `test@example.com`); env var *names* (`STRIPE_API_KEY`, `OPENAI_API_KEY`).
- Forbidden: real names (people, products, companies, customers); real domains, hostnames, IPs, internal URLs; API keys, tokens, credentials, session cookies, OAuth secrets, even example-looking ones; private repo paths (`github.com/<org>/<private-repo>`); customer data or customer-specific intents; first-person war stories tied to an incident, project or person; user-specific paths (`/Users/<name>/...`, `/home/<name>/...`); identity-bound preferences (DA name, principal name, partner name, pet name, financial figures, health data).
- Framing is generic: "someone reports a bug", "your web project", "a common root cause".

**Private skill content rule (2026-07-23 separation directive):** the same publishable-clean standard. The underscore decides where a skill ships, not what its files may contain. A private skill's body holds only generic code and instructions; everything sensitive lives under `LIFEOS/USER/` and is read by path:

- Personal data (corpora, inventories, preferences, registries, state) → `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/`, unless a canonical USER home already owns it (`GEAR.md`, `FINANCES/`, `TELOS/`, the People store via `people who`; `CONTACTS.md` is the curated hot list only). Point there; never duplicate.
- Personal config (domains, account IDs, repo paths, endpoints) → a `Config.md`/`.yaml` in that same CUSTOMIZATIONS dir, loaded at run time.
- Credentials → env var names in the skill, values in `~/.claude/.env`. Never values, never tokens in URLs.
- Prose says "the principal", never a real name; no home-path literals.

Why: a private skill in this state is promotable to public with a rename, the whole tree passes one hygiene gate, and a leak of the skills tree leaks no life data. What makes a skill private is that its core job cannot move into `Config.md` (§ The decision rule), never the personal data it reads.

**Setup.md and promotion.** A skill that needs setup (an account, a key, config, a service behind it) carries `skills/<Name>/Setup.md` with the four parts SetupInventory checks: What it does, Fill in, Accounts and secrets, Prove it works. Setup.md teaches; it never ships the backend: a skill that needs a Worker, a database or a scheduled pipeline describes how to build one, and the working package stays under `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/` (SkillHygieneGate `shipped-backend` fails one tracked inside `skills/`). The full promotion checklist for a private skill going public lives in one place, `~/.claude/LIFEOS/DOCUMENTATION/Skills/SkillSystem.md` § Promoting a private skill.

**Personal layering for public skills.** `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/PREFERENCES.md` overlays per-user taste on a generic body. Do not use it to smuggle private content into a public skill: if the skill's core job cannot work from a `Config.md` the user fills in, it is a private skill (§ The decision rule).

**Enforcement.** `LIFEOS/TOOLS/SkillHygieneGate.ts` scans against `LIFEOS/USER/SECURITY/DENY_LIST.txt` (identity data, so it lives in the USER tree), the release scrub patterns `LIFEOS/USER/SECURITY/PublicScrubPatterns.txt` (merged in v1.2.0, so skill-clean ≡ release-clean by construction), home-path shapes, a gate-scoped name-literal set `LIFEOS/USER/SECURITY/SkillNamePatterns.txt` (v1.3.0: the principal's plain full name, which the release deny-list leaves out because it is sanctioned attribution in shipped content), and git-tracked vendored deps; it runs inside `/ic`. Since 2026-07-23 it has no private-skill exemption. The write-time SystemFileGuard scans deny-listed tokens only in public skills: `skills/_*/**` is the `private-skills` containment zone, which `classifyTarget` treats as USER, so for a private skill the hygiene gate is the only check. Neither pattern set carries the principal's or the partner's legal first name bare (the deny-list carries the partner's nickname; checked 2026-10-10), so the bare-name grep for those first names (taken from the identity files) covers that gap; a hit is genericized unless it is a public citation or a functional detection pattern. Never substitute a hand-rolled grep for the gate: a hardcoded pattern list rots and misses most of the deny-list.
- **Generic skills** — build skills to work for whoever runs them, not hardcoded to the principal's setup. Detect the provider, harness and environment at runtime, and keep per-install config separate from the skill logic. Use BitterLessonEngineering to find over-specific parts. <!-- applied: 2026-10-13T08:59:41.818Z -->
- For public skill releases, exclude skills with significant IP advantage or excessive principal-specific customization, and keep private, customer, and sensitive information out. Each releasable skill needs a concise Setup area with generic examples and the dependency/configuration guidance adopters need to recreate its integrations, without excessive documentation. Keep principal-specific workflows and monitors private. <!-- applied: 2026-10-13T08:59:41.290Z -->

## Sellable bundles

A sellable bundle ships only after three gates pass: a gate-1 identity/credential/secret-shape grep at zero hits, a fresh-context cross-vendor audit at zero findings, and a stranger test where an agent given only the bundle confirms it is self-contained and data-free. Never call a bundle clean before all three.

## Folder structure

Flat. Three subdirectories have fixed meanings, and any other directory is allowed when SKILL.md routes it once as `Dir/`, except `Workflows/` and `Procedures/`, which `/ic` blocks because routines live in `Intents/`.

```
skills/SkillName/SKILL.md                    # Skill root
skills/SkillName/Intents/Create.md           # Intent, directly inside Intents/
skills/SkillName/Tools/Manage.ts             # Tool
skills/SkillName/References/ApiReference.md  # Extended reference, routed by name
skills/SkillName/QuickStartGuide.md          # Context file in the root, routed by name
skills/SkillName/Templates/Report.md         # Another directory of .md files, routed once as Templates/

skills/SkillName/Intents/Category/File.md    # nested intent: IntentLint error (nested-intent)
skills/SkillName/backups/SKILL.md            # no backups inside a skill (not linted)
```

- `Intents/` holds intents only, each directly inside it; an `.md` deeper than that is the one depth rule IntentLint enforces (`nested-intent`). Flatten it with a clearer name: `Intents/<Category>/<Name>.md` becomes `Intents/<Category><Name>.md`.
- `Tools/` holds executable tools only, and exists only when the skill has tools; many compliant skills have none. It stays flat: `Tools/<Group>/<Tool>.ts` becomes `Tools/<Tool>.ts` (unenforced).
- `References/` holds extended reference material for a large skill.
- A single context file sits in the skill root or `References/`. A directory earns its place when it groups several files of one kind (templates, examples, pattern libraries, fixtures); SKILL.md names it once as `Dir/` or IntentLint reports `unrouted-file`. Prompting's `Templates/` is the model. A catch-all folder (`Docs/`, `Resources/`, `Context/`) is avoided in new skills, since its files belong in the root or `References/`; no gate checks this, and the existing ones stay until that skill is canonicalized. Two levels is the target, but a deeper folder outside `Intents/` (`Templates/Primitives/`) is not flagged.
- No `backups/` inside a skill. Backups go to `~/.claude/BACKUPS/`. No gate checks this.
- A tool lives in `skills/<X>/Tools/` only when that skill's intents are its sole consumers and the concern is domain-private; anything consumed across skills, by hooks, commands or services, or shipped publicly stays in `LIFEOS/TOOLS/` (the install's operational rules).

## SKILL.md shape and loading

- Frontmatter, with the description in the form `description: <What it does>. USE WHEN <triggers>. NOT FOR <neighbor> (<OtherSkill>).` — `name` (TitleCase or `_ALLCAPS`), `version`, `metadata.short-description` (required: one plain line of at most 170 code points, the Codex catalog summary; IntentLint `summary-missing`, `summary-too-long`, `summary-malformed`), single-line `description` (never multi-line `|`) with a mandatory `USE WHEN` clause and intent-based triggers, a `NOT FOR` clause when the skill shares vocabulary with a neighbor (Council's `NOT FOR pure adversarial attack (use RedTeam).`), at most 1024 characters and as tight as it can be (every description costs context on every turn under the shared `skillListingBudgetFraction`); no separate `triggers:`, `workflows:` or `intents:` arrays; `evals:` per § Verification.
- Every skill runs one way: inline, through the Skill tool, in the conversation that invoked it. Frontmatter carries only keys that describe the skill: `name`, `description`, `version`, `metadata`, `evals`, and when wanted `argument-hint` and `license`. A key that changes how the harness runs one skill (`context`, `background`, `disable-model-invocation`, `allowed-tools`, `effort`, `model`, `user-invocable`, `hooks`, or any other key off that list) never appears; sub-agent work a skill needs is launched from the invoking conversation, and the body never says "you are a forked subagent" or "return your result to the parent". The one control key kept is `disallowed-tools`, and only to hold an analysis skill read-only (it must deny `Edit` and `Write`). `LIFEOS/TOOLS/SkillHygieneGate.ts` fails any other key, as an allowlist, and no allowlist entry suppresses it (SkillSystem.md § Frontmatter).
- Body, in this order: a one-paragraph purpose and the declarative facts the intents share; `## Ideal State` (2+ testable bullets for what a good use of the skill delivers, never a copy of an intent's); `## Intent Routing` (an Intent | Trigger | File table with names matching files, then a File | Read when table naming every `References/` and root `.md` file, and every other directory of `.md` files as `Dir/`); then `## Data & Config` when the skill reads USER data, `## Gotchas` (required; a placeholder line is fine until the first reproduced failure), `## Examples` (two or three concrete patterns). IntentLint's SKILL.md rules are listed in SkillSystem.md § SKILL.md anatomy; `## Gotchas`, `## Examples` and `## Data & Config` are not among them, so they are required here but unenforced. No `## Voice Notification` in SKILL.md or any intent (IntentLint `voice-section` in both): the intent voice (`hooks/lib/intent-voice.ts`, run from `hooks/EventLogger.hook.ts`) announces intent execution.
- A skill with no `Intents/` is its own single intent: SKILL.md carries `## Ideal State` then `## Anti-criteria` after the purpose paragraph, then `## Intent Routing` when it has reference files. Adding a second intent later moves the Anti-criteria and the deliverable bullets into `Intents/`, and SKILL.md keeps a skill-level Ideal State.
- One hop, and contents on long files: every intent and reference file is named in the routing section, so nothing is reachable only through another reference (Claude previews nested files with `head` and misses the rest). Any SKILL.md, intent, reference or skill-root `.md` over 100 lines with 2+ H2s opens with the `**Contents:**` line that `LIFEOS/TOOLS/SkillContents.ts --write` maintains. Files in a directory routed as `Dir/` are exempt from the contents line, because neither IntentLint nor `SkillContents.ts` reads them. IntentLint enforces both, checking that each path or `Dir/` appears in the routing section and that each named `Intents/` or `References/` path exists; table shape and name matching are unenforced (SkillSystem.md § SKILL.md anatomy).
- Under 500 lines (unenforced; no lint counts lines). Session start loads only frontmatter; invocation loads the SKILL.md body; root context files and `References/` load on demand when an intent points at them. Large skills keep SKILL.md as routing and move encyclopedic content (API signatures, long examples, troubleshooting) to root context files or `References/`.
- Customization: `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<SkillName>/` (`configRoot` is `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`) holds `Config.md`, `PREFERENCES.md` and other configs that override defaults; absent means defaults. An `EXTEND.yaml` manifest there is optional and matters only to a JSON config loaded through `LIFEOS/TOOLS/LoadSkillConfig.ts` (SkillSystem.md § Skill Customization System).

## Skill types

Name the type before building; it shapes structure and testing (Anthropic's internal taxonomy, Thariq Shihipar, Mar 2026).

| Type | Focus | Key structure | Example |
|------|-------|---------------|---------|
| 1. Library/API Reference | Gotchas, edge cases a model gets wrong | Lightweight, gotchas-heavy, reference snippets | a framework-reference skill (hypothetical) |
| 2. Product Validation | Test/verify code works | State assertions, browser automation, output recording | Interceptor |
| 3. Data Fetching | Connect to data systems | Credential refs, query patterns, dashboard pointers | USStats, a business-metrics skill |
| 4. Business Process | Automate repetitive workflows | Execution logs, consistency tracking | a task-tracker skill, a syndication skill |
| 5. Code Scaffolding | Generate framework boilerplate | Template files, project-aware scripts | CreateCLI, CreateSkill |
| 6. Code Quality | Enforce standards, review | Deterministic scripts, hook integration | /simplify, /code-review |
| 7. CI/CD & Deployment | Deploy with safety patterns | Pre-deploy checks, smoke tests, rollback | a Cloudflare deploy skill wrapping a project's gated deploy command |
| 8. Operations Runbooks | Map phenomena to diagnostics | Phenomenon → tool → query → report | a site-health skill |
| 9. Infrastructure Ops | Maintenance with safety guardrails | Safety gates, audit logging, orphan detection | a system-management skill, a dotfiles skill |

## Writing guidance

From Anthropic's skill-creator methodology and Thariq Shihipar's "Lessons from Building Claude Code" (Mar 2026), applied through the intent standard:

- **The smarter-model test decides every line.** "Would a smarter model make this unnecessary?" Anti-fragile and kept: verification harnesses, data pipelines, tool wrappers, accumulated gotchas, deterministic scripts. Fragile and questioned: chain-of-thought orchestrators, format parsers, retry cascades, reasoning scaffolding. A skill earns its place with knowledge a model cannot derive (failure modes, API quirks, decisions) or tools it cannot replicate (API calls, automation).
- **Deterministic Tools (`*.ts`) are exempt** from the cut: they do one fixed thing by design.
- **State the outcome; keep only four kinds of how.** Safety-gate, verified-gotcha (with provenance: a dated incident, failing test or reproduction), tool-contract, output-format-contract (`skills/Prompting/Standards.md`, `LIFEOS/RULES/Philosophy.md` § Ideal-State Prompting). Declarative facts, environment facts and worked examples are not methodology and stay.
- **Don't state the obvious.** Test: "Would the model do this wrong without being told?" If not, cut it.
- **Explain the why.** A reason generalizes; a rigid MUST does not. Cut intensifier-only lines (`MANDATORY`, `CRITICAL`, a third restatement) by the delete-test in `Prompting/Standards.md` § Signal-to-Noise; watch `## Best Practices` and `## Tips` for default-restating filler.
- **Generalize, don't overfit.** Fix the pattern behind a test failure, not the test.
- **Bundle repeated work.** When every run writes the same helper, it belongs in `Tools/`.
- **Match degrees of freedom to fragility.** Migrations need exact commands; reviews need direction.
- **Descriptions are for models.** Slightly pushy beats conservative because models undertrigger. Undertriggering shows as the skill not loading when it should or users invoking it by hand; overtriggering as loading on irrelevant queries or users disabling it.
- **Gotchas accumulate.** "The highest information density in any Skill comes from gotchas sections" (Thariq). Every reproduced failure adds a dated line: API quirks, common mistakes, non-obvious ordering, silent failures.
- **Testing levels.** Manual (run queries), scripted (TestSkill), programmatic (Assay suites). Define what "this skill working" looks like before building it; iterate on one hard task until it succeeds, then extract the winning approach.
- **On-demand hooks.** A skill can carry hooks active only once invoked. Hypothetical examples, since no LifeOS skill ships one: a careful mode that intercepts `rm -rf`, `DROP TABLE` and force-push, a freeze that blocks edits outside a directory, an audit mode that logs every tool call.
- **Skill quality** — When auditing or improving skills, judge substantive quality and fit to the work the skill does, not only structural compliance. Ideal State bullets describe observable, checkable properties of the deliverable, never process narration or vague judgments. Validate them against usage evidence, independently verify substantive rewrites, and keep skill-system documentation, creation tooling and lint rules aligned with enforcing code. <!-- applied: 2026-10-13T08:59:41.909Z -->

## Verification (evals)

A skill's evals and any judging its tools do run through Assay; a skill tool never carries its own judge prompt or grading loop, and `LIFEOS/ASSAY/tests/OneEvalSystem.test.ts` (not in the public release) fails one that does (`LIFEOS/DOCUMENTATION/Assay/AssaySystem.md` § One eval system).

Every skill names real verification in `evals:` frontmatter at create or update time:

```yaml
evals:
  suites: [my-skill-core]        # runnable suite names, resolved in the Assay roots
# OR
evals:
  deterministic:
    - command: "bun LIFEOS/TOOLS/MyCheck.ts --check"
      falsifier: "the command exits nonzero when the contract is broken"
# OR
evals:
  manual:
    reason: "a human must judge the visual composition"
    falsifier: "the named reviewer rejects the recorded artifact"
# OR, only while evidence is not ready
evals:
  pending: "awaiting a real failure case for the suite"
```

- **Suite:** named, existing, runnable, resolved in the same USER-first order the Assay runner uses. Never an intended-but-nonexistent suite. Suites seed from real usage (the hook-written run ledger `MEMORY/SKILLS/execution.jsonl` → the Assay skill's FailureToCase tool), never synthetic cases.
- **Deterministic command:** a command and the concrete failure it shows. Tool self-tests belong here when they are the verification.
- **Manual exception:** valid only when the reason a human must judge it and the rejection that falsifies it are both named. A bare decline or `n/a` is not verification.
- **Pending:** honest while evidence is being prepared; never counted as verified.
- **Legacy `declined:`:** advisory until the skill is next touched, then migrated to an explicit form.
- **Suite placement:** generic → the Assay skill's `Suites/{Capability,Regression}/`; identity-bound → `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Assay/Suites/`. Never a per-skill `Suites/`; the runner resolves exactly those two roots.
- **Running it:** `bunker test --skill <Name>` for fast commands, `--deep --asserts` for broader token-free checks, `--deep` for named suites after prerequisites. Slow commands declare `lane: integrity` or `lane: build`; an owning ISA holds per-intent stages and tournaments. Manual-only declarations remain observations owed, never executable coverage (`Assay/References/Progressive.md`).
- A declaration states how to verify; only a completed check is evidence. Verification attaches to the changed behavior or produced artifact, deterministic prerequisites first, judges only where a quality or selection claim needs them. A generic hygiene pass cannot certify intent behavior. Delegated calibration labels follow the Assay intent's provenance contract.
- The intent's own `## Ideal State` and `## Anti-criteria` are what Assay grades a run against (`Proof.ts run --intent`) and what a skill suite's rubric is built from, so they are written to be gradable.
> The Bunker CLI is maintainer-private and not in the public release; run code rows with `bun test ./<path>` and suite rows with `bun skills/Assay/Tools/EvalRunner.ts`.

This is the demand side of the eval system: Assay owns how to measure; CreateSkill owns making every skill name how it is verified.

## Versioning

Every skill carries its own `version:` (`Major.Feature.Patch`; the middle number is Feature, not "minor"), independent of the OS version and every other skill. The three-level form is unenforced: no lint checks it, and `BumpSkillVersions.ts` lists a changed skill whose `version:` is missing or not three levels as having no version and skips it without failing. A new skill scaffolds at `version: 1.0.0`. A skill change is also an OS change (`skills/` is core-file surface), but CreateSkill never edits `LIFEOS/VERSION`.

- **patch** — gotcha added, typo, description tweak, doc sync.
- **feature** — a new intent or tool. A brand-new skill starts at 1.0.0, not a feature bump on itself.
- **major** — renaming or removing the skill, or breaking its public contract or routing. Human-gated: stop and confirm; never decide major alone.

The per-skill bump fires at private-sync time: the maintainer's private-sync ship flow (not in the public release) runs `BumpSkillVersions.ts`, which, for every `skills/<name>/` that changed since the last OS tag, scopes `ClassifyChange --path skills/<name>`, bumps `version:` (major held for confirmation), and records each in the SYSTEMUPDATES registry, catching edits that never route through CreateSkill. So `version:` is never hand-bumped where that flow exists. On an installed system without that maintainer machinery, hand-bump `version:` per the rubric as part of the edit and leave `LIFEOS/VERSION` alone. A skill edit is a private-sync change, never a release cut (staging only) or publish (public repo). Public skills carry the private `version:` forward unchanged.
