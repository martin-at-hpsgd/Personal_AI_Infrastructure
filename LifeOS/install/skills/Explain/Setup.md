# Explain

Status: bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY · optional

## What it does

Explain teaches the topic in front of you, explains the fundamentals of any project or system you name, and quizzes you on them. Its Teach intent turns the topic your conversation has been working on into a live tutorial. Each beat is drawn as an ASCII diagram in the terminal, spoken aloud, and ends with one question for you; after the beats it quizzes you until the idea lands. The diagrams, the questions, the quizzes and the fundamentals explanations are text and need nothing; quiz results are kept on the STATVS record, which every install has. The spoken narration is the part that needs setup: each beat is posted to the voice server inside Pulse (`http://localhost:31337/notify`), which turns it into audio in your assistant's voice and plays it. If the voice server is down, muted or has no key, the lesson carries on as text.

## Fill in

Nothing to write for the skill. The voice comes from your assistant's voice profile in `LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` under your config root (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), the same profile every spoken reply uses. The identity interview normally sets it; a made-up example:

```toml
[da.voices.main]
fish_reference_id = "EXAMPLEfishreferenceid"
fish_speed = 1.0
```

`fish_reference_id` is the id of a voice model in your Fish Audio account. Pulse itself is the always-on local process the installer sets up; if it is not running, `LIFEOS/DOCUMENTATION/Pulse/PulseSystem.md` covers starting it.

## Accounts and secrets

- A Fish Audio account at <https://fish.audio> with a voice model you can use and credits for what is spoken. Create an API key in its dashboard and put it in `~/.claude/.env` as `FISH_API_KEY` (the name only is shown here). After editing `.env`, run `bun ~/.claude/LIFEOS/TOOLS/Secrets.ts seal`.
- Pulse running on port 31337, which also needs a speaker. On macOS playback uses the built-in `afplay`.
- Nothing is sent anywhere else. The narration text goes to the local Pulse process, and from there to Fish Audio.

## Prove it works

```bash
bun ~/.claude/LIFEOS/TOOLS/Secrets.ts has FISH_API_KEY
curl -s http://localhost:31337/voice/health
curl -s http://localhost:31337/voice/mute
```

The first prints `FISH_API_KEY yes` and exits 0, or `no` and exits 1. The second returns one JSON line from the running voice server; success has `"enabled":true`, and `configured_voices` lists `main`. No reply means Pulse is not running. The third returns `{"muted":false}`; `true` means the mute switch is on and the lesson will be silent until it is switched off. Then ask your assistant "teach me DNS resolution" and expect an ASCII diagram, a spoken beat and one question, then your answer driving the next beat.
