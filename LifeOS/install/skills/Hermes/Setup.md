# Hermes

Status: test -d "${HERMES_HOME:-$HOME/.hermes}" && echo ok · optional

## What it does

The Hermes skill answers questions about the Hermes sidecar: is it up, are its sessions loading your assistant's identity and rules, why a task failed, what happened inside one session, and whether an upstream update is waiting. It only reads the sidecar's own records (session store, cron history, error logs, guard audit trail). Without a sidecar it reports `absent`, which is a valid answer and not an error, so nothing else in LifeOS depends on it.

The sidecar is Hermes, a separate open-source agent that runs beside LifeOS and mounts it, so you can talk to the same assistant from a chat channel. It is not part of the LifeOS release. You install it from its own project, then mount LifeOS into it with the shipped `LIFEOS/HERMES/Mount.ts`. Skip this guide unless you want that second front door. The design is in `LIFEOS/DOCUMENTATION/Hermes/HermesSidecar.md`, and the full walkthrough for the mount, its two config files and the heartbeat is `LIFEOS/DOCUMENTATION/Setup/Hermes.md`.

## Fill in

The skill itself reads no file you write. The mount does, from `LIFEOS/USER/CONFIG/` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`):

- `hermes-trusted-domains.json` lists hosts you own that the sidecar's guard may call without treating the session as tainted. It starts empty, which allows loopback only. A made-up example:

```json
{ "domains": ["pulse.example.com"] }
```

- `heartbeat.json` configures the optional ten-minute heartbeat: quiet hours, calendar look-ahead, mail patterns. Every key is optional.

Re-run `bun ~/.claude/LIFEOS/HERMES/Mount.ts` after editing either file, your identity, or your TELOS.

By default Hermes lives in `~/.hermes`. If a Hermes agent you use for something else already lives there, do not mount into it: set `HERMES_HOME` to a separate directory for the sidecar, in the shell that runs the install, the mount and the skill's tools. `HERMES_WORKSPACE` (default `~/HermesWorkspace`) is the only folder the sidecar's file tools may write to.

## Accounts and secrets

No `~/.claude/.env` keys. The skill never reads Hermes' credential files; `.env` and `auth.json` show up in its reports only as a size and a modified time.

- Hermes itself, from its own project. Its installer is a script you download and read before running:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o install.sh
# read it, then:
bash install.sh --non-interactive --skip-setup --skip-browser --commit <the commit you reviewed>
```

- A sign-in for Hermes that belongs to Hermes alone: `hermes auth add openai-codex --type oauth --no-browser`. Never import another tool's tokens, because refresh tokens are single use and two clients break each other.
- Keys for any chat channel you add (iMessage or any other chat channel) go in Hermes' own home folder, per Hermes' instructions, never in LifeOS.
- Python 3, only for the guard test the Update intent runs (`LIFEOS/HERMES/plugin/test_guard.py`).

Then mount: `bun ~/.claude/LIFEOS/HERMES/Mount.ts`, and start Hermes through the launcher script in `LIFEOS/DOCUMENTATION/Setup/Hermes.md`, never as bare `hermes`.

## Prove it works

```bash
bun ~/.claude/LIFEOS/HERMES/Health.ts
bun ~/.claude/LIFEOS/HERMES/Observe.ts status
bun ~/.claude/LIFEOS/HERMES/Mount.ts --check
```

All three are read-only. With no sidecar installed, the first prints `⚪ Hermes — Hermes sidecar not installed` and exits 0, the second prints `hermes: absent  (~/.hermes)` and `sessions 24h: 0, soul-blocked: 0` and exits 0, and the third stops with `no Hermes install at ~/.hermes — install Hermes first`.

Once Hermes is installed and mounted, success is: `Health.ts` prints a status line starting `Hermes —` that names the state (`up` is the goal), `Observe.ts status` prints `hermes: up` with the 24-hour session count and `soul-blocked: 0`, and `Mount.ts --check` exits 0 reporting the identity file and Hermes' config as `current`. `STALE` means a source changed since the last mount: run `Mount.ts` again. A `soul-blocked` count above zero means sessions are running without your assistant's rules, and the Triage intent explains why. Then ask your assistant "is the Hermes sidecar healthy?" and expect a one-screen report with the process state, whether sessions load the soul, mount drift and the top failure classes.
