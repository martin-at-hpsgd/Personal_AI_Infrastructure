---
version: 1.0.0
---

# Google credentials

Status: `bun LIFEOS/TOOLS/GoogleCreds.ts` · optional

## What it does

Several LifeOS tools talk to Google on your behalf: Gmail (read, search, label, draft and send mail, and the inbox triage and people tools that sit on it), YouTube (upload, thumbnails, descriptions, pinned comments) and Google Ads (the optional paid promotion of a new video). All of them sign in the same way. You create one OAuth client in your own Google Cloud project, and each tool then gets its own long-lived permission token from you, once, in a browser.

Everything stays on your machine, in `LIFEOS/USER/CONFIG/CREDENTIALS/google/`. Nothing is sent to anyone but Google.

## Fill in

**1. Create the Google Cloud project and OAuth client.** In the Google Cloud Console (console.cloud.google.com):

1. Create a project, or pick one you already have.
2. Under APIs & Services, then Library, enable the APIs for the tools you plan to use: **Gmail API** for mail, **YouTube Data API v3** for YouTube, **Google Ads API** for promotion.
3. Under Google Auth Platform (older consoles: OAuth consent screen), set the app up. Choose External unless you have a Google Workspace organization and only want its members. Add your own Google address as a test user.
4. Under Credentials, choose Create Credentials, then OAuth client ID, and set the application type to **Desktop app**.
5. Download the JSON file. Save it as `client_secret.json` in `LIFEOS/USER/CONFIG/CREDENTIALS/google/` (create the folder if it is missing). Its top-level key is `installed`, and the YouTube and Ads tools read it as it is.

Google's rule: while the consent screen is in Testing status, tokens for an External app stop working after 7 days. Move the app to In production (you can leave it unverified, since you are its only user) so the tokens last.

**2. Gmail needs one more file.** The mail tools read a mailbox file with three fields: `client_id`, `client_secret` and `refresh_token`. The minting tool, `GoogleMailboxAuth.ts`, copies the client id and secret from a flat file, and the file Google gave you is nested, so first write a flat copy. The name ends in `.oauth` so the tools never mistake it for a mailbox:

```bash
bun -e 'const d=JSON.parse(await Bun.file(process.argv[1]+"/client_secret.json").text()).installed; await Bun.write(process.argv[1]+"/seed.oauth.json", JSON.stringify({client_id:d.client_id, client_secret:d.client_secret}, null, 2)+"\n")' ~/.claude/LIFEOS/USER/CONFIG/CREDENTIALS/google
```

Then mint the mailbox file. Use a short name for `--account` (your domain or "personal") and your real address for `--login-hint`:

```bash
bun LIFEOS/TOOLS/GoogleMailboxAuth.ts --account personal --login-hint you@example.com --client-from seed.oauth
```

The tool prints `AUTH_URL:` and waits up to ten minutes. Open that address in a browser where you are signed in as that user, approve, and the tool writes `personal.json` next to the other files. It checks that the mailbox which approved is the one you named and writes nothing if it is not. The default permission is `gmail.modify`, which covers reading, labelling, drafts and sending. `--scopes` takes another list, and `--force` replaces an existing file.

With one mailbox file the tools find it on their own. With two or more, pass `--account <name>` to each Gmail command, or set `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` in `.env` to a full path. Scheduled jobs do not see your shell settings, so the variable has to be in the job itself.

**3. YouTube and Ads, only if you use them.** Each runs its own consent step with the same client:

```bash
bun LIFEOS/TOOLS/Conveyor/YouTubeAuth.ts     # YouTube: upload, metadata, comments
bun LIFEOS/TOOLS/GoogleAdsAuth.ts            # Google Ads: the adwords scope
```

Each prints a sign-in address, waits for the browser to come back to a local port, and adds its token to `~/.claude/.env` after saving a backup of the file. Neither prints the token. If you keep sealed secrets, run `bun LIFEOS/TOOLS/Secrets.ts seal` afterward. Ads also needs your advertising account number; see `LIFEOS/DOCUMENTATION/Setup/Content.md`.

## Accounts and secrets

You need a Google account, a Google Cloud project (free to create) and, for Ads, a Google Ads account. The files and keys involved:

| Where | What | Made by |
|---|---|---|
| `CREDENTIALS/google/client_secret.json` | The OAuth client you downloaded | You, from the console |
| `CREDENTIALS/google/seed.oauth.json` | Flat copy of the client id and secret | The command in step 2 |
| `CREDENTIALS/google/<account>.json` | One mailbox: client, secret and refresh token | `GoogleMailboxAuth.ts` |
| `.env`: `YOUTUBE_OAUTH_REFRESH_TOKEN` | YouTube permission | `YouTubeAuth.ts` |
| `.env`: `GOOGLE_ADS_REFRESH_TOKEN` | Ads permission | `GoogleAdsAuth.ts` |

Treat all of these as passwords. Never paste them into a chat, an issue or a commit. A key is present or not; check with `bun LIFEOS/TOOLS/Secrets.ts has YOUTUBE_OAUTH_REFRESH_TOKEN`. To revoke access, remove the app from the third-party access list in your Google Account settings and delete the file or `.env` line.

## Prove it works

Check which mailbox file the tools will use. This reads no network and prints a path, or the reason it found none:

```bash
bun LIFEOS/TOOLS/GoogleCreds.ts
```

It exits 0 with a path when one mailbox file is found or chosen. On a fresh install it exits 1 with `found no mailbox credentials`, which is the not-set-up state. The seed file does not count as a mailbox.

Then make one live, read-only call. It prints your mailbox address and message count:

```bash
bun LIFEOS/TOOLS/gmail.ts profile
```

Add `--account personal` if you have more than one mailbox file. For YouTube and Ads, `bun LIFEOS/TOOLS/YouTubePromote.ts probe` reports whether the client file and each Ads key are present and exits 1 if any is missing, and `bun LIFEOS/TOOLS/YouTubePromote.ts whoami` makes a read-only call that lists the advertising accounts your grant can reach.

For the whole-install view, run `bun LIFEOS/TOOLS/SetupInventory.ts status`. Google reads `ready` once `client_secret.json` is in place.
