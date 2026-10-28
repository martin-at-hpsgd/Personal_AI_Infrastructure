# Webdesign

Status: command -v interceptor >/dev/null && grep -qE '^\s*(export\s+)?INTERCEPTOR_TEST_CONTEXT_ID=' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env && echo ok · optional

## What it does

Webdesign designs and builds web interfaces in two ways. DirectDesign writes the design as code straight into your project and needs nothing beyond the model. NativeDesign drives Claude Design (the `/design` artboards and `/design-sync`) so you can compare several looks side by side or sync a design system. Both paths expect the result to be looked at in a real browser before you see it, which is what the Interceptor skill does. Without Interceptor the design still gets written, and the result is reported as unverified.

## Fill in

Only the Interceptor test context, and only if you want the rendered check. Copy the example file and fill in the two values it asks for:

```bash
mkdir -p ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor
cp ~/.claude/skills/Interceptor/preferences.env.example \
   ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env
```

```
INTERCEPTOR_TEST_CONTEXT_ID="interceptor-test"
INTERCEPTOR_TEST_CHROME_PROFILE="Profile 2"
```

Optionally, design taste goes in `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Webdesign/PREFERENCES.md` (the installer puts a starter there; if it is missing, `bun ~/.claude/skills/LifeOS/Tools/ScaffoldUser.ts --apply` copies any missing starter file into place and never overwrites one you have edited): preferred register, palette, typography, spacing, animation timing, framework defaults, brand assets, `## Overrides of upstream` for a standing motion policy or default page ground, and `## Shipped sites`, a newest-first list of the sites you have shipped (URL plus register, typeface and ground) that the variety check reads so a new design does not repeat the last two or three. Every section is optional; with no file, upstream defaults stand, and with no shipped-sites list the variety check falls back to the most recent sites in your projects list.

| Field | Meaning |
|---|---|
| `INTERCEPTOR_TEST_CONTEXT_ID` | The friendly name you set once in the Interceptor browser extension's popup (Context ID field). The design check drives only this context and refuses to run without one, so it never touches your own browser window. |
| `INTERCEPTOR_TEST_CHROME_PROFILE` | The on-disk folder name of a dedicated Chrome profile for testing, such as `Profile 2`. Used to launch that profile automatically. |

Installing the Interceptor command and extension is covered by the Interceptor skill (`skills/Interceptor/SKILL.md`, its Update intent). The design check serves a local build over http, since the extension cannot capture a `file://` page.

## Accounts and secrets

No keys for DirectDesign. For NativeDesign you need a paid Claude subscription with Claude Design access (the free tier has none), a Claude Code build that carries the `/design` skill (run `/update` if the command is missing), and, for design-system sync, a claude.ai login with design scopes (`/design-login`). The skill stops with the missing step named instead of falling back.

## Prove it works

```bash
command -v interceptor
grep -E '^\s*(export\s+)?INTERCEPTOR_TEST_CONTEXT_ID=' ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Interceptor/preferences.env
bun ~/.claude/skills/Webdesign/Tools/VerifyDesign.ts
```

Success is a path for `interceptor`, the `INTERCEPTOR_TEST_CONTEXT_ID` line from your preferences (not empty), and the usage line `usage: VerifyDesign.ts <url-or-path> <out-dir> ...`, which shows the check script loads. To run the real check, start your local build, open Chrome on the test profile, and run `bun ~/.claude/skills/Webdesign/Tools/VerifyDesign.ts http://localhost:5173 ~/design-check`; it saves a screenshot in that folder and prints a JSON verdict with `pass`, `errors` and what it did not verify. Then ask your assistant "design a settings panel for this app".
