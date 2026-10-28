---
provenance: template
version: 1.0.0
---

# Upgrade — USER config files

The Upgrade skill is public code; per-install source overrides are configured here when supported by a current intent.

| File | Read by | Parsed how |
|------|---------|------------|
| `EXTEND.yaml` | `LIFEOS/TOOLS/LoadSkillConfig.ts:116` (path), `:115` (`loadExtendManifest`) | YAML. `skill` and `extends` are required (`:127-130`); `enabled` defaults to `true` (`:133-135`); a parse failure warns and disables customization. |

## `EXTEND.yaml` keys (`LoadSkillConfig.ts:29-35`)

| Key | Type | Required | Meaning |
|-----|------|----------|---------|
| `skill` | `string` | yes | Must equal the skill directory name (`Upgrade`), which is how the loader finds this manifest (`:152`). |
| `extends` | `string[]` | yes | Config filenames in this directory that override the skill's base copies. Only files listed here are merged (`:185`). |
| `merge_strategy` | `append` / `override` / `deep_merge` | yes | `append` concatenates top-level arrays; `override` replaces the base wholesale; `deep_merge` recurses into objects. A JSON file can override this per file with a `_customization: {merge_strategy}` block (`:24-27`, `:84-87`). |
| `enabled` | `boolean` | no | `false` turns every customization off without deleting files. |
| `description` | `string` | no | Free text. |

`sources.json` is not listed in `extends`: `skills/Upgrade/Tools/Anthropic.ts` reads the base copy straight from the skill directory, so a user copy here would be inert.

## The other files shipped here

Every key is documented in `skills/Upgrade/Setup.md` § Fill in; the files below ship with empty or disabled placeholder values.

| File | Read by | Missing file means |
|------|---------|--------------------|
| `user-sources.json` | `github_repos[]`: `skills/Upgrade/Tools/Anthropic.ts` (`mergeUserRepos`), appended to the shipped `sources.json` list; a file that does not parse, is not a JSON object, or has a malformed `github_repos` stops the run naming the file and key. `blogs[]` and `github_trending`: the Upgrade intents (`SKILL.md` § Sources & Tools). | No user repos, no custom blogs, trending lane skipped. |
| `youtube-channels.json` | The YouTube lane of the Upgrade intents (`SKILL.md` § Sources & Tools). | No channels; create it as `{"channels": []}`. |
| `PREFERENCES.md` | The NewsDigest intent (`## News digest`: `story_items`, `link_separator`). | The defaults in `Setup.md` stand. |
