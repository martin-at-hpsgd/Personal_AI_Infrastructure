---
provenance: template
version: 1.0.1
---

# CONFIG — the structured config files, one by one

`README.md` in this directory explains the split between config and credentials.
This page is the per-file reference for the JSON/TOML files here, since JSON
cannot carry comments (files that can carry comments document themselves).

| File | Read by | Shape | Fresh-install value |
|------|---------|-------|---------------------|
| `services.json` | `LIFEOS/TOOLS/Services.ts` (`loadUserServices`), `LIFEOS/TOOLS/InstallAgentJobs.ts` | JSON array of `{label, title, purpose, category, optIn, install, uninstall?}`; entries missing a string `label` and `install` are ignored | one ignored `_docs` entry |
| `repos.json` | the maintainer's private-repo sync tool (not shipped; harmless to leave as placeholders) | `{claude_remote, user_remote, public_forbidden[]}`; all required, substring-matched against your git remotes | placeholder slugs; nothing in this build reads them |
| `skill-hygiene-allowlist.json` | `LIFEOS/TOOLS/SkillHygieneGate.ts`, `hooks/lib/system-file-guard-core.ts` | JSON array of `{path, reason, added, scope?}`; `path` repo-relative, trailing `/` = prefix; `scope` `all` or `names` | one non-matching `_docs` entry |
| `release-audit-strings.json` | `LIFEOS/PULSE/Tools/ReleaseAudit.ts` | JSON array of strings that must never appear in a release staging tree (surname, partner names, phonetic spellings) | `[]` — add yours; anything listed here is flagged wherever it appears in a staged release, so never put a string here that also lives in a file you ship |
| `agent-jobs.json` | `LIFEOS/TOOLS/AgentJob.ts`, `LIFEOS/TOOLS/InstallAgentJobs.ts` | `{jobs: [...]}`, non-empty; see the `_docs` key inside | two disabled example jobs |
| `heartbeat.json` | `LIFEOS/TOOLS/AgentJob.ts`, `LIFEOS/HERMES/Heartbeat/Tick.ts`, `LIFEOS/HERMES/Heartbeat/ArtistScan.ts` | `{quietHours, calendar, mail, location, artistScan}`; every key optional, defaults inside each reader | defaults, no VIPs, artist scan off |
| `hermes-trusted-domains.json` | `LIFEOS/HERMES/Mount.ts` | `{domains: string[]}` | `[]` (loopback only) |
| `add-bg.json` | `LIFEOS/TOOLS/AddBg.ts` (`--brand`) | `{brandColor: "#RRGGBB"}`; a missing file or key exits 1 naming it | neutral `#F5F5F0` |
| `achilles.json` | `LIFEOS/TOOLS/Achilles.ts` (`achillesConfig`; `ACHILLES_CONFIG_PATH` overrides) | `{source_aliases: {old: current}, source_ref_prefix_aliases: [[old, current]], stack_terms: string[]}`; every key optional, a missing file is empty config, `gen-stack` warns when `stack_terms` is absent | no aliases, example stack terms |
| `lifeos-repo.json` | `LIFEOS/TOOLS/UpstreamRepo.ts` (for `Banner.ts`, `Credits.ts`), `LIFEOS/TOOLS/GenerateStarHistory.ts` | `{repo: "owner/name"}`; read only when `LIFEOS_REPO` is unset and the installer carries no release-stamped repo; a missing file or `""` is unset (Credits then uses its documented default), while malformed JSON or a missing, non-string or non-owner/name `repo` is an error naming the file and key | `""` (a release install uses the stamped repo) |
| `email-brand.json` | `LIFEOS/TOOLS/EmailTemplate.ts` | `{name, bannerBg, logoUrl, company, supportEmail, footerBrand}`, spread over defaults | neutral brand |
| `PULSE.user.toml` | `LIFEOS/PULSE/lib.ts`, `LIFEOS/PULSE/pulse.ts` | `[modules]`, `[syslog]`, `[[job]]` overrides layered over the shipped `PULSE.toml` | everything commented except syslog off |
| `STANDING_FACTS.md` | `hooks/LoadMemory.hook.ts`, `LIFEOS/TOOLS/StandingFacts.ts` | bullets between `<!-- FACTS BEGIN -->` and `<!-- FACTS END -->`, injected every turn | four generic facts |
| `memory-review.json` | the autonomic memory reviewer | cadence thresholds | conservative defaults |
| `LIFEOS_CONFIG.toml` | `LIFEOS/TOOLS/LifeosConfig.ts` and most skills | identity, paths, integration toggles | written by the installer |
| `settings.user.json` | `LIFEOS/TOOLS/MergeSettings.ts`, `LIFEOS/TOOLS/SettingsBackport.ts` | the overlay half of the settings layer: every SessionStart regenerates `settings.json` from the root `settings.system.json` plus this file, and this file wins conflicts; merge rules in `LIFEOS/DOCUMENTATION/Setup/CoreConfig.md` | `{}`, which adds nothing to the system layer; put your own settings here, never in the generated `settings.json` |
| `LocalPatches.json` | `LIFEOS/TOOLS/UpgradeVerify.ts` (check 4, local-delta) | `{patches: [...]}`, a registry of local patches you keep on shipped files | `{"patches": []}`; empty means you keep none, and most installs never add one |
| `denyhash-allowlist.txt` | `LIFEOS/TOOLS/DeriveDenyHashes.ts` | one lowercase token per line (`#` comments) exempted from the hashed deny set | comments only, so only the generic exemptions apply |

## Files that are deliberately absent on a fresh install

- `WORK/work_repo.json` — create as `{"repo":"<owner/repo>"}` when enabling the
  work system. On first load, `work-config.ts` calls `gh repo view` and enables
  the system only after confirming the repo is private; it then records its own
  cached privacy attestation in this file.
