---
version: 1.0.3
last_updated: 2026-10-03
last_updated_by: da
convention: lifeos-freshness-v1
status: live
---

# Voice mode — talk with your DA inside the live session

> One keystroke turns a Claude Code session into a spoken conversation. The DA speaks a short version of each reply in its own voice while the full answer lands in the terminal. You answer by dictation, and pressing to talk cuts the DA off. The live session does all the thinking; voice is only how you talk to it.

Voice mode is built from pieces LifeOS already had: Dictation (the pedal and Right Ctrl+J driving your dictation app), the Pulse voice server, and the Stop hook that speaks the 🗣️ closer. It adds no app, no second agent and no new long-running process.

## F1 · Turning it on and off

| Way in | What it does |
|---|---|
| `/voice` (or `/voice on`, `/voice off`, `/voice status`) | Runs `bun LIFEOS/TOOLS/VoiceMode.ts toggle` for this session. |
| Shift+Cmd+V | A Hammerspoon hotkey in `~/.hammerspoon/init.lua` that types `/voice` and Enter. It is live only while kitty is frontmost, so the key keeps its normal meaning everywhere else. |

Voice mode is **per session**. State is one file per session under `MEMORY/STATE/voice-mode/<session-id>.json`, keyed by `CLAUDE_CODE_SESSION_ID`, so other sessions running beside it never change. Turning it on warns you if the voice server is muted (⇧⌘M) or unreachable, because otherwise you would sit waiting on silence.

## F2 · What the DA says

While voice mode is on, `hooks/VoiceMode.hook.ts` (UserPromptSubmit) adds an instruction to every prompt: end the reply with a `🎙️ SPOKEN:` field directly above the closer. The field is two to five plain sentences written for the ear, carrying the point and the one thing the DA needs from you, with no code, paths, tables or markdown. The system prompt's Output Format names the field as voice-mode only.

At Stop, the speech path (`hooks/VoiceCompletion.hook.ts`, and `speakAnswer` through `LIFEOS/TOOLS/HookBridge.ts` in plugin sessions) asks `VoiceMode.spokenLine` what to say:

- Voice mode off: exactly what the closer path said before voice mode existed.
- Voice mode on, field present: the field, stripped to plain speech and cut at a sentence end under 480 characters, because the voice server refuses anything over 500.
- Voice mode on, no field: the closer, never a fallback summary such as a CHANGE bullet.

The subagent and channel gates run first, so a subagent or a headless job never speaks a SPOKEN field.

## F3 · Cutting in

Voice-mode speech is sent as **interruptible**. The voice server (`LIFEOS/PULSE/VoiceServer/voice.ts`) then does three things differently:

- **It watches the talk mics while it plays.** Every 40 ms it asks CoreAudio whether a talk mic has opened (`LIFEOS/TOOLS/lib/MicActive.ts`). If one has, it stops. The talk mics come from `talkMicPaths` in `LIFEOS/USER/CUSTOMIZATIONS/DICTATION/App.ts`. When your dictation app records through the preroll bridge, the bridge is on that list, because it opens the mic at the press itself while the app opens its own half a second to 1.5 s later. Watching only the app would let the DA's voice leak into your dictation.
- **It answers once the clip is queued**, not when playback ends, so the hook never times out on a long reply.
- **`POST /voice/stop`** stops the playing clip and drops everything queued or still generating before the stop. The prompt hook calls it whenever you submit a prompt in voice mode, so typing works as a barge-in too.

A stop silences every session's queued audio, not just the voice-mode session's. When you start talking you want silence.

## F4 · The conversation works the ISA

When the session has an ISA (its active one, else the one it touched most recently in `MEMORY/STATE/work.json`), the instruction names it and switches the DA into the ISA skill's interview discipline, out loud:

- one question per turn about the ISA's open decisions or fog, recommendation first;
- never ask for what can be looked up;
- every answer goes into the ISA's `## Articulation Log` the same turn, quoting the question, your verbatim transcript, and the recommendation you were answering, because a mis-heard "don't" must stay checkable;
- settled decisions fold into the ladder, criteria or Decisions.

Dictated prompts carry transcription slips. The instruction tells the DA to read through them, but to ask before acting on a word that flips the meaning.

## Known gap

Your dictation app pastes into whatever window has focus. If you click elsewhere while the DA is talking, your answer goes there. This is recorded as fog in the feature's ISA.

## Files

| File | Role |
|---|---|
| `LIFEOS/TOOLS/VoiceMode.ts` | State, spoken-text extraction, the instruction, CLI (`on|off|toggle|status|bench`) |
| `hooks/VoiceMode.hook.ts` | Per-prompt stop and instruction |
| `hooks/VoiceCompletion.hook.ts`, `hooks/handlers/VoiceNotification.ts` | Speak the SPOKEN field interruptibly |
| `LIFEOS/PULSE/VoiceServer/voice.ts` | `/voice/stop`, queue flush, talk-mic watch |
| `LIFEOS/TOOLS/lib/MicActive.ts` | CoreAudio "is this app recording" probe |
| `commands/voice.md` | `/voice` |

Tests (maintainer-side; not in the public release): `bun test ./LIFEOS/TOOLS/VoiceMode.test.ts ./hooks/VoiceMode.hook.test.ts ./LIFEOS/PULSE/VoiceServer/voicemode.test.ts`. Timing: `bun LIFEOS/TOOLS/VoiceMode.ts bench`.

## Talk — a live conversation beside the working session

**Talk is off.** Its voice agent was hosted by ElevenLabs, which LifeOS no longer uses; Fish Audio is the only voice engine and has no hosted conversational agent. Talk stays off until it is rebuilt on another host. The description below is how it was built.

Voice mode above is turn by turn: the DA speaks when a turn ends, and you dictate the next prompt. **Talk** is the live version. A small always-on-top Pulse Desktop window holds a continuous spoken conversation with the DA while the session keeps working, and either side can cut in. What you settle out loud is handed into the session as a message, and the session's progress streams back so the voice side knows what is happening.

| Piece | Where | Job |
|---|---|---|
| The voice agent | A hosted voice agent, id in `LIFEOS/USER/CUSTOMIZATIONS/TALK/config.json` | The DA's own voice, an Anthropic model hosted by the voice platform, turn-taking and interruption handled by the platform, one client tool `hand_to_session`. `bun LIFEOS/TOOLS/Talk.ts setup` creates or updates it from the DA identity. |
| The window | Pulse Desktop, opened with `--talk=<session>` (`Talk.ts open`) | Loads `/talk` from Pulse. WebRTC in Chromium gives echo cancellation, so the DA never hears itself. The microphone is asked for once per app run. |
| The page and its routes | `LIFEOS/PULSE/modules/talk.ts`, `talk.html` | `/talk/token` (WebRTC token, the API key stays in Pulse), `/talk/context` (the session ISA's L3, open criteria and fog, and nothing else), `/talk/handoff`, `/talk/inbox` (SSE for the bridge), `/talk/progress` and `/talk/events` (SSE for the page), `/talk/end`. Loopback only. |
| The bridge into the session | the `talk` Claude Code mod | `/talk` opens the window and runs `Talk.ts bridge`. Each hand-off is submitted into the session through `$.prompt.submit`, which arrives mid-turn like a typed message and quotes your exact words. Each finished turn posts its SPOKEN field or closer as progress. |

**Data rule.** Only ISA lines and short progress summaries cross to the voice platform. File contents, secrets and transcripts of the working session never do (principal ruling, 2026-10-03).

**Hand-offs are delivered exactly once.** One made before the bridge connects waits in Pulse and goes to the first bridge that connects. Ending the talk closes the bridge.
