---
version: 1.0.2
---

# People (one record per person you know)

Status: `bun LIFEOS/PEOPLE/People.ts stats` · optional

## What it does

People keeps one local record for every person and organization you deal with, and answers "who is this?" in one command: whether they are personal or business, every email and meeting you have had with them, and whether they are or were a customer. It builds the records from your mail, calendar, Apple Contacts, Stripe and newsletter subscriber list, and rebuilds them hourly. Everything stays on your machine, in plain files under `LIFEOS/USER/CONTACTS/`. The design is in `LIFEOS/DOCUMENTATION/People/PeopleSystem.md`.

Other parts of LifeOS ask People when they need to know who someone is, so a fresh install works best with at least the mail source connected. You can run People with only some sources; each one is optional and a missing one is reported, not treated as an error.

## Fill in

There is no file to write by hand. The store (`CONTACTS/contacts.jsonl`, `interactions.jsonl`, `runs.jsonl`) is created by the first run of `tick` or `merge`; do not edit it by hand.

What you choose is which sources to connect, under Accounts and secrets below. One optional extra: `bun LIFEOS/PEOPLE/People.ts merge --curated <file.md>` folds a curated list (a short hot list of people you care about) into the rebuild.

## Accounts and secrets

Each source reads its own credentials. Put keys in `~/.claude/.env` (names only here), and check one exists without printing it with `bun LIFEOS/TOOLS/Secrets.ts has NAME`.

| Source | What it needs | In this release |
|---|---|---|
| Gmail | A Google OAuth credential file for the mailbox. Keep exactly one mailbox file in `LIFEOS/USER/CONFIG/CREDENTIALS/google/` so the scheduled job finds it, or point `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` at the file. | Works. |
| Stripe | `STRIPE_SECRET_KEY`, to mark customers. | Works. |
| Newsletter | `BEEHIIV_API_KEY` and `BEEHIIV_PUB_ID`, to mark subscribers. | Works. |
| Calendar | The calendar skill's `gcal.ts` tool. | Not in this release. The source reports `skipped` with "calendar tool not installed". |
| Apple Contacts | The Swift adapter in `LIFEOS/PEOPLE/ContactsCli.swift`, compiled by `swiftc` on first use, plus the macOS Contacts permission. | Works on macOS once the permission is granted. Without it the source reports `blocked`; off macOS it reports `failed`. |

So on this release People builds from Gmail, Stripe, your newsletter and, on macOS, Apple Contacts. The calendar row shows `skipped` in every run; one failed or skipped source never stops the rest. `sync apple` and `add` need the Contacts permission. If you have your own calendar source, the sources are plain functions in `LIFEOS/PEOPLE/tick.ts`.

Run the first build yourself, then schedule it. Both write to your own files only:

```bash
bun LIFEOS/PEOPLE/People.ts tick          # run every source once, then rebuild the store
bun LIFEOS/PEOPLE/InstallPeople.ts        # install the hourly launchd job com.lifeos.people
```

The installer does not run a tick at load, so installing never rewrites your store by surprise. `LIFEOS/TOOLS/Services.ts` lists the hourly job only on installs that have the private contacts-photos skill, so on this release check it with `bun LIFEOS/PEOPLE/InstallPeople.ts --status` instead.

People never sends your contacts anywhere. The only way a record can leave the machine is `people push`, which accepts a business-only projection and is not yet connected to anything.

## Prove it works

```bash
bun LIFEOS/PEOPLE/People.ts stats
```

On a fresh install this exits 0 and prints `people: 0` with every source marked `never` and `STALE`. After the first `tick`, the Gmail row should read `ok` with a recent time and `people:` should show a real count. A source marked `STALE` has not run successfully in 48 hours. Then look someone up:

```bash
bun LIFEOS/PEOPLE/People.ts who "<a name or email address>"
```

That prints each match with its class, interaction counts and customer state, or a not-found message and exit 1.
