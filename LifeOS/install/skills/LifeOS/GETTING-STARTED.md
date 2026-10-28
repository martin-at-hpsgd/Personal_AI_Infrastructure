# Getting Started — after the install

**Contents:** codex — cross-vendor audit · Interceptor — real-browser verification · Cloudflare (cf) — scheduled cloud flows · Fish Audio — voice notifications · gh — the work system of record · Command-line tools · Smaller optional tools · How degradation works (so you can trust it)

You installed LifeOS. This page covers the part `INSTALL.md` couldn't: the **external tools** LifeOS's doctrine uses when they're available. Almost all of them are optional and degrade honestly when absent — each just unlocks a real capability. For each: what it powers, how to set it up, and how to prove it's live.

**The one command to remember:**

```
bun <configRoot>/LIFEOS/TOOLS/Doctor.ts
```

If Pulse or a core background service is not running, `bun <configRoot>/skills/LifeOS/Tools/InstallAll.ts --yes` brings the whole stack back up; it is the same one command the install ran, and running it again on a working install changes nothing.

**Updating later.** Ask your agent to "update LifeOS". Its Update intent fetches the newest release, runs `InstallAll.ts --yes` (which keeps your `USER/` data and backs up any system file it replaces), and finishes with Doctor. The bootstrap keeps the previous skill in `<configRoot>/.lifeos-skill-backups/`.

Run Doctor whenever anything feels off. Every ❌ line carries its own fix command. `--network` adds end-to-end auth checks (only for tools you've configured). `decline <name>` turns a capability off permanently and silently — declining is a supported way to run LifeOS, not a defect.

**Your own systems.** Doctor checks tools. Your data is a separate question: many LifeOS systems (security guards, Location, Relay, finances, health) do nothing until you fill in your own files. One command shows where you stand:

```
bun <configRoot>/LIFEOS/TOOLS/SetupInventory.ts status
```

Each row says ready, needs setup, or optional and off, and names its guide under `LIFEOS/DOCUMENTATION/Setup/`. Each guide covers what the system does, what to fill in, which accounts and secrets it needs, and a command that proves it works. Add `--probe` to run those proving commands.

---

## codex — cross-vendor audit

**Powers:** an independent second-vendor review on high-impact work. Without it, audits still run — but same-vendor, and the output is labeled accordingly.

- **Install:** `bun install -g @openai/codex`
- **Auth:** `codex login` (needs an OpenAI account)
- **Verify:** `bun <configRoot>/LIFEOS/TOOLS/Doctor.ts` → codex ✅
- **Don't want it?** `Doctor.ts decline codex` — audits stay single-vendor, honestly labeled, and the MAX lane is disabled; prompts that would bind to MAX continue without that lane and log the capability-based degradation.

## Interceptor — real-browser verification

**Powers:** verification of anything web-facing through a real Chrome — screenshots, console logs, actual page loads. Doctrine treats "curl returned 200" as *not* verification; this is the tool that does it right.

- **Install:** the skill ships with LifeOS, but it needs a one-time setup before it works: a real browser (Google Chrome or Brave), the `interceptor` program, a dedicated test profile with the Interceptor extension loaded, and a `preferences.env` naming that profile's context ID. The steps are in `skills/Interceptor/Setup.md`.
- **Auth:** none beyond your own logins inside the test profile.
- **Verify:** `Doctor.ts` → interceptor ✅ only when the skill, a browser, the `interceptor` CLI and a pinned `INTERCEPTOR_TEST_CONTEXT_ID` are all present; then `bash <configRoot>/skills/Interceptor/Tools/PreflightIsolation.sh` exits 0 with the test profile open.

## Cloudflare (cf) — scheduled cloud flows

**Powers:** the "runs while you sleep" layer (Workflows) and Worker deploys.

- **Install:** `bun add -g cf`, Cloudflare's CLI. Projects carry `cloudflare.config.ts` and bundle through `@cloudflare/vite-plugin`, so no project needs Wrangler.
- **Auth:** create a Cloudflare API token (Workers permissions), add to `<configRoot>/.env` as `CLOUDFLARE_API_TOKEN=...`
- **Verify:** `Doctor.ts --network` → cloudflare ✅ (runs a real `cf auth whoami`).
- **Don't want it?** `Doctor.ts decline cloudflare`.

## Fish Audio — voice notifications

**Powers:** spoken notifications through the Pulse voice server. Fish Audio is the one voice engine. Full guide: `<configRoot>/LIFEOS/DOCUMENTATION/Setup/Voice.md`.

- **Install:** nothing — it's an API.
- **Auth:** `bun <configRoot>/LIFEOS/TOOLS/Secrets.ts set FISH_API_KEY` (reads the key with echo off, writes `.env` at mode 0600), then set `fish_reference_id` under `[da.voices.main]` in `LIFEOS_CONFIG.toml`.
- **Verify:** `Doctor.ts --network` → voice ✅ (runs a real short synthesis on the exact path notifications use).
- **No key?** Voice is `off`: notifications stay on-screen, no turn errors, and Doctor says `off` rather than broken. `Doctor.ts decline voice` silences the row for good.

## gh — the work system of record

**Powers:** work capture, the work and commitment sweeps, `TASKLIST.md` regeneration, and the Pulse Work tab. The Work System keeps its system of record in a private GitHub repo, and every reader reaches it through `gh`.

- **Install:** `brew install gh` (Linux: see [cli.github.com](https://cli.github.com))
- **Auth:** `gh auth login`
- **Verify:** `Doctor.ts` → gh ✅
- **Note:** the tools that use it spawn `gh` with **no fallback**, so without it work capture fails rather than degrading — this is the one entry on the page that breaks the "everything degrades" promise, and the one most worth installing first.

## Command-line tools

`Doctor.ts` checks each one; none needs auth. Linux installs are the same package names through `apt-get`.

| Tool | Powers | Install | Note |
|---|---|---|---|
| `rg` (ripgrep) | ContextSearch, the work sweep, the model-drift scan | `brew install ripgrep` | the built-in `Grep` tool is already ripgrep-backed; this is for tools that spawn `rg` themselves |
| ImageMagick | Interceptor's blank-frame guard and zoom, Art composition | `brew install imagemagick` | without it `Capture.sh` exits 14 (the content check cannot run); `--allow-unchecked` takes the capture unverified, so look at it yourself before citing it |
| `ffmpeg` | AudioEditor, transcript splitting, Conveyor renders, the zoom fallback | `brew install ffmpeg` | |
| `yt-dlp` | Feed's YouTube source, Upgrade's channel scan | `brew install yt-dlp` | |
| `fabric` | the Fabric skill's patterns and YouTube transcripts | see the fabric project | auth per fabric's own setup |
| `jq` | shell hooks that parse JSON | `brew install jq` | hooks skip silently without it, so absence costs the feature, never the tool call |

## Smaller optional tools

These are narrower — tied to one terminal, one platform, or one opt-in workflow — so the Doctor doesn't check them. Each is skipped cleanly when absent.

| Tool | Powers | Install |
|------|--------|---------|
| `rtk` | Transparent command compression on the Bash pre-tool hook — compresses what the model *watches* (git status, commit/push/pull output, gh metadata), never what it *reads* (`git diff`, `git log` and `git show` pass through untouched). Skips silently without it (also needs `jq`). | `brew install rtk`, or take the release binary. **Do not run `rtk init -g`**: that installs rtk's own global hook alongside LifeOS's `ContextReduction.hook.sh` and you get two rewriters on the same command. rtk also keeps a local `history.db` of proxied commands, and its telemetry is opt-in — `rtk telemetry disable` makes that explicit. |
| `kitten` | Terminal tab naming and the retro banner, on the kitty terminal only. | ships with kitty |
| `mkcert` | Local HTTPS certificates during Pulse setup. Pulse runs over HTTP without it. | `brew install mkcert` |
| Google OAuth credential | Gmail via `LIFEOS/TOOLS/gmail.ts` (refresh-token JSON under `USER/CONFIG/CREDENTIALS/google/`), plus the Conveyor YouTube OAuth client. Calendar tooling is not included in this payload. | Google Cloud console → OAuth Desktop client |

---

## How degradation works (so you can trust it)

- The Doctor writes an **advisory manifest** (`LIFEOS/MEMORY/STATE/capabilities.json`). It's a cache with TTLs, not truth — the runtime re-checks cheaply at the moment a capability is actually used.
- A **broken** capability warns once at the moment you'd have used it, with its fix command. Cooldowns prevent nagging.
- A **declined** capability is silent forever, everywhere.
- Output produced without a doctrine-relevant capability is **labeled** (e.g. "same-vendor audit only") — absence is never hidden inside a confident result.
- The manifest is tamper-evident: `Doctor.ts --verify` flags any edit made outside the Doctor.

That's the contract: nothing here scores you, nothing nags, and nothing pretends.
