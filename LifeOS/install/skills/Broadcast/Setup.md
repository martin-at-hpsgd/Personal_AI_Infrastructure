# Broadcast

**Contents:** What it does · Fill in · Accounts and secrets · Prove it works

Status: bun ~/.claude/skills/Broadcast/src/index.ts status · optional

## What it does

Broadcast posts one piece of content to X, LinkedIn, Bluesky and Instagram from one command, checking each platform's length and media limits first and previewing everything with `--dry-run`. It also publishes X Articles, publishes podcast episodes to Omny Studio, and shares a newsletter edition. It does not write copy; hand it finished text.

Each platform is optional. A platform you never set up shows `❌ Not configured` in `status` and is skipped, and the rest still post. X posting goes through the public `X` skill, so set that skill up first if you want X (its own `skills/X/Setup.md`).

It leans on three other parts of LifeOS. Every live post runs the send gate, which uses the `Assay` skill's code checks (`skills/Assay/Tools/Proof.ts`; § When a post is blocked below). Every video passes a PII scan on Google's Gemini API (`GOOGLE_API_KEY`, below). And LinkedIn's `ensure` posts its outcome to the Pulse dashboard when Pulse is running; Pulse is optional, and without it that notice is silently skipped.

## Fill in

First install the skill's packages, once, from the skill folder:

```bash
cd ~/.claude/skills/Broadcast && bun install
```

This installs the packages the code imports (`commander`, `@atproto/api`, `aws4fetch`, `probe-image-size`) into the skill's own `node_modules`. Skip it and a command can stop on a missing-package error.

Then create `~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/Config.md`. Only the podcast, newsletter-share and posting-preference features read it; posting to the four platforms needs no config file. Each value is one `key = value` line at the start of a line, anywhere in the file; the first match wins, so write each key once and start no other line with a key name.

A worked example, every value made up:

````markdown
# Broadcast config

## Podcast (Omny Studio)

omny_program_id = 00000000-0000-0000-0000-00000000a001
omny_playlist_ids = 00000000-0000-0000-0000-00000000b001, 00000000-0000-0000-0000-00000000b002
omny_rss_container_id = 00000000-0000-0000-0000-00000000c001
omny_episode_type = Full
omny_include_intro_outro = true
omny_auto_level_audio = false

## Newsletter share

newsletter_name = Example Weekly
newsletter_url = https://news.example.com
edition_label = Issue
share_sponsor_thanks = true
share_card = true
share_card_spec = LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/ShareCard.md
share_file_prefix = EW
share_highlight_own_writing = false
share_writing_audit = false
newsletter_share_overlay = LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/ShareRules.md

## Posting preferences

house_style = false
video_followup = false

## Handles (reference only)

x_handle = example_writer
bluesky_handle = example-writer.bsky.social
````

| Key | Required | Meaning |
|-----|----------|---------|
| `omny_program_id` | for podcasts | The Omny program (show) episodes publish into: the `/programs/<id>` part of the program's URL in Omny Studio |
| `omny_playlist_ids` | for podcasts | Comma-separated playlists every episode joins, main RSS playlist first |
| `omny_rss_container_id` | no | First GUID in your public feed URL `https://www.omnycontent.com/d/playlist/<container>/<program>/<playlist>/podcast.rss`; only the Podcast intent's feed check uses it |
| `omny_episode_type` | no | `Full` (default), `Trailer` or `Bonus` |
| `omny_include_intro_outro` | no | `true` (default) inserts the program's intro and outro; `false` does not |
| `omny_auto_level_audio` | no | `false` (default) or `true` |
| `newsletter_name` | for shares | The newsletter's name as the hook line says it |
| `newsletter_url` | for shares | Base URL; an edition is `<newsletter_url>/p/<slug>` |
| `edition_label` | no | How editions are numbered in the hook: `No.` (default), `Issue`, `#` |
| `share_sponsor_thanks` | no | `true` adds one thank-you line per sponsor the edition credits, with that sponsor's link exactly as the edition printed it; `false` (default) omits the block |
| `share_card` | no | `true` makes a designed edition card in two sizes and runs it through the ArtDirection critique; `false` (default) posts without one |
| `share_card_spec` | when `share_card = true` | Your card's brand file, relative to `~/.claude`: mark image path, wordmark, fonts and weights, palette, layout notes. The share stops and names this key if it is missing |
| `share_file_prefix` | no | Prefix for the card files in `~/Downloads`, `<prefix><NNN>-share-card-{wide,4x5}.png` (default `edition-`) |
| `share_highlight_own_writing` | no | `true` requires one highlight line linking your own writing when the edition has some (default `false`) |
| `share_writing_audit` | no | `true` runs the `Writing` detect pass and a Pangram score before the draft is shown (default `false`) |
| `newsletter_share_overlay` | no | A file of your own further share rules, relative to `~/.claude`, applied on top of the ShareNewsletter intent |
| `house_style` | no | `false` (default) posts your text as written. `true` turns on the bundled style rules: `post` and `edit` refuse a LinkedIn post with no `**bold**` span or `# Header` line (pass `--linkedin-plain` to post plain text anyway), and the intents add their style preferences (no X or Bluesky hashtags except a `#sponsored` disclosure, X posts spaced hours apart, a bold hook and 0–2 emoji on LinkedIn) |
| `video_followup` | no | `false` (default) asks before following a video-anchored post with the video link (an X reply, a LinkedIn comment). `true` posts that follow-up without asking |
| `x_handle`, `bluesky_handle`, `instagram_handle`, `linkedin_profile_url` | no | Reference only; posting reads credentials, never these |

Set the three episode settings to whatever your existing episodes use, so a new episode matches them; the tool verifies all three after publishing and exits 3 on a mismatch.

**Worked example of a share card brand file.** `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/ShareCard.md`, read when `share_card = true`:

```markdown
# Share card brand for Example Weekly

- Mark: LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/brand/example-mark-white.png
- Wordmark: EXAMPLE WEEKLY, caps
- Fonts: Inter Tight Bold for the wordmark and number, Inter for topics and date (installed in ~/Library/Fonts)
- Palette: ground #101820, accent #3B82F6 → #93C5FD
- Layout: thin grid at 6% opacity, corner ticks, oversized issue number
```

**Worked example of a share overlay.** The overlay is a plain markdown file of extra rules the ShareNewsletter intent reads before drafting. `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Broadcast/ShareRules.md`:

```markdown
# Share rules for Example Weekly

- End the LinkedIn share with "Reply with the story you liked most."
- Attach the edition's header image, saved as ~/Downloads/example-weekly-<NNN>.png.
- Never include more than five highlight lines.
```

## Accounts and secrets

Secrets go in `~/.claude/.env` as `NAME=value` lines (never in Config.md). After editing it, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal` if your install seals the env file. LinkedIn, Bluesky and Instagram sessions are written by the skill's own auth commands to `~/.broadcast/credentials.json`; keep that file out of any repo.

**X.** Follow `skills/X/Setup.md`: an X developer app, `TWITTER_CLIENT_ID`, `TWITTER_CLIENT_SECRET`, `X_BEARER_TOKEN`, an OAuth 2.0 token store in the X skill's Config.md, and `bun ~/.claude/skills/X/Tools/bookmarks.ts authorize`. Text and media then post through it. Without a token store, the four OAuth 1.0a keys (`TWITTER_API_KEY`, `TWITTER_API_KEY_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`) post text only.

**LinkedIn.** Create an app at developer.linkedin.com with the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products, and add `http://localhost:8917/callback` as an authorized redirect URL on its Auth tab. Put `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` in `.env`, then run `bun ~/.claude/skills/Broadcast/Tools/LinkedInAuth.ts login` once. Tokens last 60 days; `ensure` renews silently while you are logged in to linkedin.com in your browser. Every login and renewal also writes the token into `.env` as `LINKEDIN_ACCESS_TOKEN`, a mirror for outside tools; Broadcast itself reads only `credentials.json`. If you seal `.env`, the sealed copy keeps the old token until you seal again.

**Bluesky.** Create an app password at bsky.app/settings/app-passwords, then run:

```bash
bun ~/.claude/skills/Broadcast/Tools/Broadcast.ts auth bluesky --identifier example-writer.bsky.social --password <app-password>
```

**Instagram.** Needs a Creator or Business account and a Meta app with "API setup with Instagram login" (full steps in `Intents/Auth.md`). Put `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` and `INSTAGRAM_REDIRECT_URI` in `.env`. Meta fetches media from a public URL, so Instagram also needs a public Cloudflare R2 bucket: `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `BROADCAST_R2_BUCKET`, `BROADCAST_R2_PUBLIC_BASE`. Then `InstagramAuth.ts url`, open the URL, approve, and `InstagramAuth.ts exchange --code <code>`.

**Omny Studio (podcasts).** `OMNYSTUDIO_API_KEY` from Omny Studio's API settings. Episodes publish from a local audio file.

**Video PII scan (any post or Article with a video).** Every video is scanned for personal information on screen or in the audio before any platform sees it, dry runs included, through Google's Gemini API. Put `GOOGLE_API_KEY` in `.env`: create it at aistudio.google.com/apikey (Google AI Studio → Get API key). Without it a video post stops with `❌ PII gate could not scan <file>: GOOGLE_API_KEY missing from ~/.claude/.env`. Findings stop the post until you review them and re-run with `--pii-reviewed`. `--skip-pii` skips the scan and prints a loud warning; keep it for a Gemini outage, never routine use. Image and text posts need no key.

**Beehiiv (newsletter shares, optional).** `BEEHIIV_API_KEY` and `BEEHIIV_PUB_ID`, only if Beehiiv is where your newsletter lives; they let ShareNewsletter find the latest edition by itself. With any other newsletter platform, pass the published edition's URL instead.

**Worked example of the scheduled token renewal.** LinkedIn and Instagram tokens die after 60 days unless something renews them. Schedule both `ensure` commands once a day as a workflow named `social-auth`, saved in your workflows folder `~/.claude/LIFEOS/USER/WORKFLOWS/` as `social-auth.workflow.yaml`:

```yaml
version: 2
name: social-auth
description: "Renew the LinkedIn and Instagram tokens before they expire."
runs_on: local
destination: ~/.broadcast/credentials.json
triggers:
  - type: schedule
    cron: "30 5 * * *"
    timezone: Etc/UTC
  - type: manual
steps:
  run:
    kind: command
    side_effects: [ read, write, outbound ]
    recipient: principal
    description: "Run LinkedIn and Instagram ensure; each renews only when fewer than 14 days are left."
    argv: [ sh, -c, 'export LIFEOS_NOTIFICATION_CHANNEL=headless; bun "$HOME/.claude/skills/Broadcast/Tools/LinkedInAuth.ts" ensure && bun "$HOME/.claude/skills/Broadcast/Tools/InstagramAuth.ts" ensure' ]
    timeout_ms: 300000
```

Check it with `bun ~/.claude/LIFEOS/WORKFLOWS/workflow.ts validate social-auth` (it prints `valid: social-auth (<path>)`), then install the schedule with `bun ~/.claude/LIFEOS/WORKFLOWS/engine/schedule-install.ts install social-auth`. Drop the Instagram half if you only use LinkedIn.

### When a post is blocked

Every real post, edit and Article publish passes LifeOS's send gate (`LIFEOS/TOOLS/lib/SendGate.ts`) just before the platform call. It runs the `Assay` skill's code checks (`skills/Assay/Tools/Proof.ts`) on the exact text and every attached file, and stops that platform's post if a check finds a real secret, a private key or your own home-directory path, or if a file could not be read. Two LinkedIn cases sit outside those file checks: a video posted to LinkedIn gets LinkedIn's own format checks and the video PII scan instead, and a LinkedIn link card's title, description and image are fetched from the linked page at send time, so the gate never sees them (a URL-only LinkedIn post uses that fetched title as its text). A block prints `SEND BLOCKED (<platform>)`, the finding, a `Block <id>` line and `Nothing was sent.`; that platform is reported as failed, the other platforms still post, and the command exits 1. On a standard install there is no override: the override hook the message mentions is not part of the public release, so the line saying "Only the principal can override" does not apply to you. To post, remove what the finding names and run the same command again; the gate re-checks the new bytes. `--dry-run` previews length and format only and does not run the send gate (it does run the video PII scan).

## Prove it works

```bash
bun ~/.claude/skills/Broadcast/src/index.ts post --content "**Testing** my Broadcast setup" --platforms twitter --dry-run
```

This sends nothing and needs no credentials. Success is a `┌─ TWITTER (30/280 weighted chars)` preview box with your text, then `✅ Dry run complete. Use without --dry-run to post.` and exit code 0. Before X is set up, a `⚠️  TWITTER: Not configured (preview only; a live post skips it)` line comes first; that is expected.

```bash
bun ~/.claude/skills/Broadcast/src/index.ts status
```

Read-only. Each platform you set up shows `✅` with its account name; `⚠️` means credentials are present but the platform rejected them (re-run that platform's step above), and `❌ Not configured` means its step was not done.
