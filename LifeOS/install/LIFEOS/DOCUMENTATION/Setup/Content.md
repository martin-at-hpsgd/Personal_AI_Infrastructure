---
version: 1.0.0
---

# Content and publishing

Status: `bun LIFEOS/TOOLS/SetupInventory.ts status` · optional

## What it does

This is the settings layer for everything you publish. It holds your editorial themes, the look of the emails LifeOS sends, your YouTube and Google Ads preferences, your favorite-books list, and a catalog of your video types.

- **Themes** tell the idea sweep, blog discovery and feed scoring what you write about, so they can rank things by fit.
- **Email brand** sets the banner name, logo and footer on every email LifeOS sends.
- **YouTube** upload, thumbnail, description and publish commands, plus an optional rule that blocks chapter timestamps.
- **Google Ads** can start a small paid promotion for each video that goes public. It is off until you turn it on.
- **Books** regenerates a public favorite-books file from your Cortex book notes, using only the fields that are safe to publish.
- **Video types** is your own catalog of the kinds of video you make. The content pipeline gives each recording a type and points at one section of the catalog by name.

Every piece is optional and independent. A piece you leave alone stays in a clean not-configured state.

## Fill in

**Themes: `LIFEOS/USER/CONFIG/content-themes.json`.** Four lists of short phrases: `primary` (what you return to again and again), `secondary` (still yours, less often), `tertiary` (adjacent interests) and `offTheme` (what you avoid). It ships with all four empty, and while `primary` is empty the tools judge ideas on merit alone. If you would rather keep your themes in `LIFEOS/USER/CANONICAL_CONTENT.md` (as headings or bullets under Primary Themes and Secondary Themes), delete `content-themes.json` instead. The tools use the JSON file whenever it exists, even empty, and fall back to the markdown only when it is gone.

**Email brand: `LIFEOS/USER/CONFIG/email-brand.json`.** Any key you leave out keeps its default.

| Key | Meaning |
|---|---|
| `name` | The wordmark in the email banner. |
| `logoUrl` | A hosted image address (`https://...`) for the banner mark. Never a file path. Empty hides the logo. |
| `company` | The company line in the footer. |
| `supportEmail` | The contact address in the footer. Empty hides it. |
| `footerBrand` | The "Sent by" line. |

**YouTube: `LIFEOS/USER/CONFIG/youtube.json`.** One setting, `noChapterMarkers`. Set it to `true` and an upload is refused when its description has three or more timestamp lines starting at 00:00, which YouTube would turn into chapters. `--allow-chapters` overrides it for one upload.

The upload tool is `bun LIFEOS/TOOLS/YouTubeUpload.ts`. Its subcommands are `upload`, `thumbnail`, `status`, `list`, `set-description`, `set-title` and `publish`; the file header lists every flag. Every upload runs a scan for personal information in the video first and refuses until you have read the findings. Publishing a video as public also triggers the Ads rule below, unless you pass `--no-promote`.

**Google Ads: `LIFEOS/USER/CONFIG/google-ads.json`.** Ships with promotion switched off.

| Key | Meaning |
|---|---|
| `customerId`, `loginCustomerId` | Your advertising account number (digits only), and a manager account if your access comes through one. Account numbers are not secrets. A `GOOGLE_ADS_CUSTOMER_ID` or `GOOGLE_ADS_LOGIN_CUSTOMER_ID` set in the environment wins over this file, and this file wins over `.env`. |
| `logoPath` | A square PNG for the ad, either an absolute path or one relative to the `LIFEOS` folder. |
| `autoPromote.enabled` | `false` keeps it off. |
| `autoPromote.budgetDollars` | Daily budget, above 0 and at most 50. |
| `autoPromote.days` | How long it runs, 1 to 7. |
| `autoPromote.countries` | A list of two-letter country codes from the tool's supported list (`GEO_TARGETS` in `YouTubePromote.ts`, which includes US, CA and GB). |
| `autoPromote.businessName`, `autoPromote.description` | Ad text. |

The budget is per day, and Google may spend up to twice that on one day, so the real ceiling is budget times days times two. `bun LIFEOS/TOOLS/YouTubePromote.ts plan --video <id> --business "<name>"` prints the full plan with no network and no credentials, and `validate` checks it against your account without creating anything. Only `promote ... --yes`, `auto` and `enable ... --yes` spend money.

**Books: `LIFEOS/USER/CONFIG/books-sync.json`.** `endorsing_tags` maps a tag on a Cortex book note to the list name it appears under (for example `{ "favorites": "Favorites" }`). A note also counts when its `rating_key` field is at or above `rating_floor`, and those books appear under `rating_group_label`. It ships with no tags, so only rated books qualify. The tool writes `LIFEOS/USER/BOOKS.md` and needs that file to exist with a frontmatter block (`version` and `last_updated` are the keys it keeps current). The starter file in `LIFEOS/USER/` has one, so keep it. It reads book notes in `LIFEOS/MEMORY/KNOWLEDGE/Books`.

**Video types: `LIFEOS/USER/BUSINESS/YouTubeVideoTypes.md`.** Fill in each `## TYPE` section. Keep the type keys exactly as written.

**Statusline speeds row: `LIFEOS/USER/CONFIG/cosmos.json`.** `{ "url": "" }` keeps the row off. It needs a small Worker that is not part of this release.

## Accounts and secrets

Themes, email brand, books and video types need no account. YouTube and Ads do:

- A Google Cloud project with an OAuth client, and `client_secret.json` in place. `LIFEOS/DOCUMENTATION/Setup/Google.md` walks through it.
- `YOUTUBE_OAUTH_REFRESH_TOKEN` in `~/.claude/.env`, made by `bun LIFEOS/TOOLS/Conveyor/YouTubeAuth.ts`.
- For Ads: `GOOGLE_ADS_REFRESH_TOKEN` in `.env`, made by `bun LIFEOS/TOOLS/GoogleAdsAuth.ts`, and `GOOGLE_ADS_CUSTOMER_ID` in `.env` or `customerId` in `google-ads.json`. Developer tokens were retired on 2026-09-09; what your Cloud project may do with the Ads API now depends on its access level in the Cloud Console. The Test level cannot touch a real account.

Check any key with `bun LIFEOS/TOOLS/Secrets.ts has <NAME>`. It prints yes or no and never the value.

## Prove it works

Themes. This exits 0 only when at least one primary theme is configured:

```bash
bun -e 'import {contentThemes} from "./LIFEOS/TOOLS/lib/ContentThemes"; const t=contentThemes(); console.log(`themes from ${t.source}: ${t.primary.length} primary`); process.exit(t.primary.length ? 0 : 1)'
```

Run it from `~/.claude`. On the shipped empty file it prints `themes from config: 0 primary` and exits 1, the not-configured state.

YouTube and Ads. This reports whether the client file and each Ads key are present, and exits 1 if any is missing:

```bash
bun LIFEOS/TOOLS/YouTubePromote.ts probe
```

For a live read-only check of the channel, run `bun LIFEOS/TOOLS/YouTubeUpload.ts list --max 3`. To see that the Ads settings load without spending anything, run `bun LIFEOS/TOOLS/YouTubePromote.ts auto --video <id> --title "<title>"` with `autoPromote.enabled` still `false`; it prints that auto-promote is disabled and does nothing.

Books. `bun LIFEOS/TOOLS/BooksSync.ts --check` shows what would change and writes nothing.

The video production skill that cuts and assembles the videos is not part of this release. The upload, promotion, books, email and theme tools above are, and they work on their own. The satellite and speeds Workers behind `cosmos.json` are likewise separate projects.

For the whole-install view, run `bun LIFEOS/TOOLS/SetupInventory.ts status`.
