---
version: 1.0.2
---

# Identity (you and your assistant)

Status: `bun LIFEOS/TOOLS/SetupInventory.ts status` · required

## What it does

Identity is how every session knows who you are and who it is. Two files carry it. `LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md` is a short reference about you: name, location, timezone, how you like to work. `LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md` is your assistant (the DA): its name, voice, personality and the rules for how it writes to you. Once the install has switched on their imports, both load at the start of every session.

The name and timezone the code uses, and the DA's name and voice, are read first from `CONFIG/LIFEOS_CONFIG.toml` (see CoreConfig.md). The two markdown files carry the prose. Until you answer the interview, the shipped placeholders stand in: "Your Name", "Aria" and "LifeOS". The code treats those exact values as "not answered yet", so a fresh install behaves generically instead of failing.

Everything else in the identity area is optional and grows over time:

| File (under `LIFEOS/USER/`) | What it holds |
|---|---|
| `PRINCIPAL/PRINCIPAL_PRIVATE.md` | Private facts such as a home address and phone number. Read on demand, never loaded at startup. |
| `PRINCIPAL/PRINCIPAL_MEMORY.md`, `DIGITAL_ASSISTANT/DA_MEMORY.md` | One-line standing facts about you and about the DA, kept by the memory system. |
| `PRINCIPAL/PRONUNCIATIONS.json` | How the voice server should say names and terms. |
| `PRINCIPAL/RESUME.md`, `PRINCIPAL/WRITINGSTYLE.md` | Your career history and how you write. |
| `DIGITAL_ASSISTANT/_presets.yaml` | The five personality presets the DA wizard offers. Leave it alone. |
| `DEFINITIONS.md`, `CANONICAL_CONTENT.md`, `CONTACTS.md`, `GEAR.md`, `BOOKS.md`, `PROJECTS.md`, `PROJECTS_RETIRED.md`, `MUSIC/MusicReference.md` | Your vocabulary, themes, people, equipment, favorite books, project list and music taste. Skills read them when a task needs them. |
| `DIGITAL_ASSISTANT/diary.jsonl`, `growth.jsonl`, `opinions.yaml` | Written by the DA wizard and the growth tools. Do not create them by hand. |

## Fill in

Start with the interview, which does the first two steps for you. Ask your DA to run the LifeOS interview, or type `/LifeOS interview`. It asks, in this order: what to call your assistant and which voice it uses (the public default, or a Fish Audio voice model id you paste); then your name, how it is pronounced, your timezone and hometown. It writes those to `CONFIG/LIFEOS_CONFIG.toml` and `PRINCIPAL/PRINCIPAL_IDENTITY.md`, then continues into TELOS (see Telos.md). You can say `skip` to any question and `done` to stop; running it again later fills the gaps.

To shape the DA's personality, run the DA wizard. It is interactive and asks short questions:

```bash
bun LIFEOS/TOOLS/DAInterview.ts                    # quick: your name, the DA's name, a preset, formality 1 to 5
bun LIFEOS/TOOLS/DAInterview.ts --depth standard   # adds a one-line personality, what it must ask before doing, writing style
bun LIFEOS/TOOLS/DAInterview.ts --depth deep       # adds a companion, the relationship (peers, commander or mentor) and topics
bun LIFEOS/TOOLS/DAInterview.ts --update           # revisit an existing DA; Enter keeps the current value
```

The presets are `efficient`, `friendly`, `creative`, `mentor` and `worker`. The wizard writes its files into a folder named after the DA, `DIGITAL_ASSISTANT/<name>/`, and registers the DA in `LIFEOS_WORKERS/_registry.yaml`. The file a session loads is the one directly in `DIGITAL_ASSISTANT/`, so after the wizard, copy the parts you want from `<name>/DA_IDENTITY.md` into `DIGITAL_ASSISTANT/DA_IDENTITY.md`.

To do it by hand, open the two required files and replace every line marked `(interview)`. Keep `PRINCIPAL_IDENTITY.md` short, because it loads every session; put detail in the optional files above. The `## Writing Style` section of `DA_IDENTITY.md` is the only place the DA's voice is defined, so edit it until the DA sounds like someone you want to read. Private facts go in `PRINCIPAL/PRINCIPAL_PRIVATE.md`, one bullet each.

The identity files only load once `CLAUDE.md` imports them. Preview which imports would switch on, then apply:

```bash
bun skills/LifeOS/Tools/ActivateImports.ts            # dry run: lists the imports it would uncomment
bun skills/LifeOS/Tools/ActivateImports.ts --apply    # uncomments them in CLAUDE.md
```

## Accounts and secrets

The identity files hold no secrets. Do not put keys, tokens or passwords in them; `PRINCIPAL_PRIVATE.md` is for facts like an address, and it stays on your machine.

Speaking in the DA's voice is optional and runs on Fish Audio (Voice.md has the full setup). Store the key with echo off and check it without printing it:

```bash
bun LIFEOS/TOOLS/Secrets.ts set FISH_API_KEY
bun LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY   # prints "FISH_API_KEY yes" or "... no"
```

The DA's voice id is not a secret and lives in `CONFIG/LIFEOS_CONFIG.toml` under `[da.voices.main]`. A voice clone of yourself, if you make one, keeps its id in `.env` as `FISH_PRINCIPAL_VOICE_ID`, never in a file under `USER/`.

## Prove it works

```bash
bun LIFEOS/TOOLS/LifeosConfig.ts                # prints the config the code resolves; exit 0 means it parses
bun LIFEOS/TOOLS/SetupInventory.ts status       # the Identity row should read "ready"
```

In the printed config, `principal.name` and `da.name` should be yours, not "Your Name" and "Aria". If they still are, the interview has not written them yet. Then open a new session: the DA should know your name and its own without being told. If it does not, open `CLAUDE.md` in `~/.claude` and check that the two identity import lines (`PRINCIPAL_IDENTITY.md` and `DA_IDENTITY.md`) are no longer commented out; the `ActivateImports.ts --apply` step above does that.
