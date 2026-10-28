---
version: 1.3.3
---

# Tex — texting your DA

> Tex is how you talk to your DA over iMessage. You text your own line and the
> real DA answers: the same identity, skills, memory and tools as the terminal,
> in replies that read like texts. It understands tapbacks, voice notes, photos
> and files, tells you it saw your message, reports progress on long work, and
> asks before anything consequential. It also texts you first, rarely, when
> something needs you now. Only your number drives it.

**Criteria live in the Tex ISA** (`LIFEOS/USER/RELAY/ISA.md`, private). This doc explains.

## Names

- **Tex** is the feature: everything texting your DA does.
- **Relay** is the bridge process that carries it. The code and launchd service keep that name. The `Relay` skill uses it too and ships in the public release payload.
- **The guard** is `hooks/TextingGuard.hook.ts`, the deterministic check every tool call from a text session passes through.

## Features

Each feature has a name so you can ask for it, change it, or complain about it by name.

| Feature | What happens |
|---|---|
| **The line** | You text your DA and it does the work the terminal would do: mail, calendar, research, files, skills. Replies are short texts with light formatting, never a banner, and the bridge strips any terminal colour codes before they send. |
| **Seen** | Every text you send gets a 👀 tapback and a read receipt the moment it lands, and the typing bubble stays up while the DA works. The 👀 stays after the reply, since removing a reaction would send you a notification. |
| **Progress** | A task that runs past about 45 seconds sends one short line naming what it is doing, then one every three minutes, at most eight. A second text sent mid-task gets no extra reply; its 👀 is the acknowledgement, and it steers the running task (see Steering). |
| **Stop** | Texting "stop" or "cancel" kills the running task right away, and so does a sentence that starts with one aimed at the work ("Stop the job, I am doing it myself") or repeats it ("I told you to stop"). |
| **Tapback answers** | A 👍 on the DA's newest message is a yes to what it asked; 👎 is a no. When the guard is holding an action for your yes ("Deploy the site to production?"), the 👍 approves exactly that action, once. |
| **Tapback thanks** | "Thanks", "ok cool", "perfect" after a reply that asked nothing gets a ❤️ tapback back instead of another text. |
| **Voice notes in** | Send a voice note and the DA hears it: the audio is transcribed and answered like a text. |
| **Voice notes out** | When you sent a voice note, or you ask for one ("send me a voice note"), the reply also comes back as a voice note in the DA's own voice. The voice note is a short spoken version (one or two sentences); the full answer arrives as text first. |
| **Photos and files** | Images (HEIC converted), PDFs and other files are saved privately and the DA looks at them. A caption and a photo sent together are one question. |
| **Ask first** | Deleting, deploying, publishing, spending, and service control get a one-line question in the thread. A "yes" text or a 👍 approves that one action. |
| **Sends with a yes** | A message to someone in your contacts is shown to you word for word with the recipient, and goes only after your yes. Addresses outside your contacts are refused. |
| **Contacts chat** | Ring 1 of Security Rings can chat with the DA, directly or in a group. Their texts are answered by a separate persona with no tools (`LIFEOS/RELAY/bridge/chat.ts`), whose prompt names it as your AI assistant rather than you. What it may help with and what it never shares come from the `answers` section of your Ring 1 file, read at every reply, so editing that file changes the rules with no code change. A broken ring file means no reply. They never reach tools or your private data. |
| **Herdr** | Say or type "Herder, …" at the start (a voice note or dictation works the same), or "do it in Herder" / "use Herder" anywhere, and the work also shows up live in a new herdr workspace on your Mac. The answer still comes back as a text, with a line naming the workspace. When the run ends, that pane becomes an interactive Claude session forked from the text conversation, so you can walk up and keep going. Every herdr text gets its own workspace. If herdr is not running, the text says so and the work still happens. |
| **Memory** | The DA remembers your whole thread, not just the last few hours. Each text sees a compact view of everything you have said to each other, recent messages in detail and older ones summarized, and it opens any line down to your exact words before it answers. Ask about something from weeks ago and it finds it. |
| **Urgent texts** | Anything you need to know right away (a failure, a deploy waiting on you, a security finding) is texted to your line from any session or scheduled job. |
| **One-pager** | Every text session you start carries a short page about you right now, under 4,000 tokens: focus, workstreams, the work board, and open loops. It is rebuilt every morning and hourly after that, only from stores that already exist, and every line names where it came from. It skips the model when nothing changed. Login codes and secret values never land on it. Contacts never see it. |
| **Open loops** | The part of the one-pager that lists what is still open: every follow-up the DA is watching and every question it asked you that you have not answered, with confirmation numbers, order numbers and issue numbers copied exactly. A loop drops off the next build once it closes. |
| **Heads-up** | Every 17 minutes the DA checks new mail, your calendar and follow-ups that are due, and calls no model when there is nothing. When something fires, it drafts a text with a reason, an urgency and the time it should land. Vigil, not the loop, decides whether it reaches you. A "not now" waits for its time and is judged again then. At most three non-critical heads-ups a day. A heads-up never does anything itself: an action comes as a question you answer. A 👎 on one files a miss so the bar gets sharper. |
| **Nightly fold** | Each night the DA reads the day's thread and writes memory proposals for People, Cortex and your workstreams. Every proposal cites the messages it came from, and a correction names the old fact and its date. Nothing is applied until you say yes. Codes, passwords and secrets are scrubbed. Text in the thread is read as data, never as instructions. |
| **Steering** | A text you send while the DA is working goes into the running task at its next step and changes what it is doing, instead of waiting in line. If the task has no step left, the text runs as the next turn. "Stop" still stops it, and tapbacks never steer. |
| **Watches** | Text "next time X happens, tell me" and the DA adds a standing watch on your mail or a public web page, then texts back one line naming it and how to stop it. "What are you watching" lists every watch, and "stop watching X" removes it. A watch is an entry in the same watch kit as every other watch, never calls a model, and reports only to you, through Vigil. A built-in watch is paused, never removed, by text. |
| **Second look** | Three checks guard the risky moves. When a send to someone else is held for your yes, the question adds a line naming any recipient or name the DA never saw in what it read. A mail search for a login or verification code is held for your yes. A code read from mail is masked in the thread log and the record. |
| **Self-check** | The line watches itself, so a break reaches you as a text and not as a reply that never comes. Two minutes after the bridge starts, then hourly, it runs one real text turn through its own spawn path (the same account, guard and code your texts use) and counts bridge processes; a failure is a high Vigil alert, sent once per break, with one more text when it recovers. Outside the bridge, the `relay-watch` workflow reads Relay status every 30 minutes and alerts when the service is down, when other than one bridge runs, or when the self-check has not run for two hours, which is how a dead or hung bridge is caught. A bridge whose host process dies exits by itself within a second, so a restart never leaves a second bridge answering the same texts. A text from your number over SMS is still dropped without a reply; only iMessage reaches the DA. |
| **Links away from home** | When your location service says you are away from home (an unknown or stale fix counts as away), a local-only link (localhost, 127.0.0.1, [::1]) in a text to your line is rewritten to this Mac's Tailscale address with the same port and path, so it opens on your phone. At home, or without Tailscale, the link goes out as written. Contacts never get the rewrite. |

## How tapbacks stay safe

A tapback carries very little, so the rules are strict and deterministic (`LIFEOS/RELAY/bridge/tapback.ts`):

- Only 👍 and 👎 mean anything. ❤️, 😂, ‼️, ❓ and custom emoji are noted and nothing runs.
- Only a tapback on the DA's **newest** reply counts. A 👍 on yesterday's question never approves today's held action.
- A 👍 on a reply that asked nothing is noted and nothing runs.
- Tapbacks from a contact, from a group thread, or over SMS are ignored, the same as their texts.
- One exception to the newest-reply rule: a 👍 or 👎 on a workflow approval text answers that workflow's waiting human step. It counts only when it comes from your own line and its target is a notification recorded in your thread that the Workflows engine has bound to a waiting step (`LIFEOS/RELAY/bridge/workflow-tapback.ts`). It can never approve a guard-held action.

## Sessions and the reply bar

Your own thread runs as one running thread (Tex ISA F18, ported from Victor Taelin's UniiChat design). Every message, reply, tool call and clipped tool result is appended to a log that is never edited, under `LIFEOS/USER/RELAY/thread/<hash>/`. Haiku summarizes each message into one line of at most 512 bytes, then merges neighbouring lines in pairs, so recent messages keep one line each and older ones share a line. Each of your texts starts a fresh session that reads this view of the whole thread, then the time and the text itself. The DA opens any line by reading its zoom file, down to the original message and its date. The bridge is the log's only writer; it waits up to 30 seconds for the last turn's summaries before sending. `--resume` is used only for a completion repair or when you text "continue" (or "c", "keep going") after a run stopped, and a resumed session is sent no view. Secrets in tool calls, tool results and texts are redacted before anything is logged; tool output is marked untrusted so it can never pass as your words, and code rejects a summary that tries. A Haiku outage backs off (60 s doubling to 30 min) and never turns a summary into a cut line; a line Haiku keeps answering unusably after five tries gets a plain code-written fallback that still zooms to the whole message. The thread directory is git-ignored and owner-only. `bun LIFEOS/RELAY/bridge/ThreadCli.ts status|view|backfill` reports counts or imports the old history once, and refuses to run while the bridge holds the thread; `verify-store` (every record is in the thread) and `compaction-transcripts` (leftover summary transcripts) only read and run any time.

The thread is the one long-term record of your own line (Tex ISA F19). The bridge copies every record into it the moment it is written and catches up on startup, and the transport mirror drops one of your records after 30 days only once the thread holds it. Summaries run with no session saved, so they leave no Claude Code transcript and Cortex never mistakes one for a conversation. A message is never rewritten, with one exception: when you unsend a text, its words are tombstoned out of the log, its zoom file and every summary above it, and the change is recorded in `tombstones.jsonl`. An edit appends the new text beside the old. Contact threads keep the delivered-history block below and never see the view.

Where the thread view is not in use (probes, evals, or while ThreadCli holds the lock), a thread resumes its own DA session, so a follow-up text has the earlier exchange in view. The session key also carries a fingerprint of what a text session may do (the texting prompt, the allowed tool list and the guard source, `policyFingerprint()` in `session.ts`). When any of those change, the next text starts a fresh session, so a refusal the DA gave under the old rules does not keep repeating after the rules allow the work. The delivered conversation context also tells the DA that an earlier "can't do that over text" reply is not evidence.

A text session carries LifeOS memory too. The bridge puts the hot layer, standing facts and corrections into the session's system prompt, and the prompt hook adds Cortex retrieval for each message; the memory status lines stay in the terminal. Your own thread is kept by the running thread, while a contact's thread still expires after 30 days. Every hook that reads a text (memory, Cortex retrieval, satisfaction capture) pulls your words out of the prompt with one shared reader (`LIFEOS/TOOLS/DeliveredContext.ts`), whichever shape the prompt has. The memory reviewer reads every text you sent from the thread log, through the active-thread marker the bridge writes, with each reply target kept (Tex ISA F17, F19).

The texting prompt opens with the shared assistant directive (`LIFEOS/TOOLS/AssistantDirective.ts`), the same text scheduled jobs carry: send only what the principal must know, must decide, or asked for, and never report that nothing changed.

## Voice

Inbound audio is transcribed on your Mac with mlx_whisper, so it never leaves the machine; outbound speech is Fish Audio in the DA's configured voice (`[da.voices.main]` in `LIFEOS_CONFIG.toml`). Audio is stored owner-only beside the other attachments and never in the guard's state directory. Model names come from `LIFEOS/TOOLS/models.ts`. `bun LIFEOS/RELAY/bridge/VoiceProbe.ts` checks the whole round trip: it speaks a test line through Fish and transcribes it locally.

## Security in one paragraph

Your number, over iMessage and not SMS, is the only sender that can drive the DA. Ring 1 of Security Rings can text it too (`Rings.ts relay --apply` rebuilds the bridge's `chatFrom` list from Ring 1), but they get a separate chat persona with no tools and no access to your data, and nothing they write grants anything. Every other sender is dropped, except that a reply from someone you texted in the last 30 days is forwarded to you as one plain message that no model or tool sees. The allowlist of your number can be pinned in a root-owned file (`bun LIFEOS/RELAY/bridge/PinAllowlist.ts` prints the one `sudo` command), and once it is, no text session can add a number to it. The phone line uses the same pinned list: only your number gets past the greeting, and nothing runs before you say the passphrase. A text from your number runs exactly like the terminal: the same `settings.json` permissions, auto mode, hooks and skills, secrets included (guard 4.0.0). The guard adds only two things. It asks in the thread before the actions the terminal also asks about (deploy, delete, money, publish or push, messages to people outside Ring 1). It also refuses any change to the text line's own login layer: the bridge, the allowlist of your number, and the guard itself. Since guard 4.2.0 that includes a settings write that changes hook registration, any write to the Relay launchd job, and a `launchctl` stop, restart or unload of it. Since guard 4.1.0 it also refuses typing into another terminal (herdr agent or pane input, kitty remote control, tmux send-keys), because those sessions run outside the guard; the herdr hand-off is driven by the bridge, never by the text session. The full model, its history and its open questions are in the Tex ISA and in the Lockbox doc (`Lockbox/LockboxSystem.md`), which will carry the security layer for every non-terminal channel.

## Where things live

- Code: `LIFEOS/RELAY/bridge/` (`index.ts` stream loop, `handler.ts` per-message flow, `session.ts` spawn and admission, `thread.ts` the running thread's log, tree and view, `compactor.ts` the Haiku summarizer, `ThreadCli.ts` status/view/backfill, `tapback.ts`, `voice.ts`, `orphan.ts` the exit-when-orphaned watch, `health.ts` the self-check, `identity.ts` resolves a handle to a People person).
- Health: `LIFEOS/TOOLS/RelayStatus.ts` is the one read of whether the line is healthy (service, bridge count, last self-check), shared by the Relay skill's Status tool, the Pulse /relay card and the `relay-watch` workflow.
- Guard: `hooks/TextingGuard.hook.ts` + `hooks/lib/texting-guard-core.ts`. The bridge registers it itself on every text session it starts (`--settings`, `GUARD_SETTINGS` in `session.ts`), never through `settings.json`, so no harness settings edit can drop or reshape it; terminal sessions never start it. A leftover harness entry for the hook stands down in a text session so one call never runs the guard twice. Only `disableAllHooks` or `allowManagedHooksOnly` in settings can still stop texting, and the bridge then replies that the line is misconfigured.
- Private state (0700/0600): `LIFEOS/USER/RELAY/state/`, attachments in `LIFEOS/USER/RELAY/inbox/`, the running thread in `LIFEOS/USER/RELAY/thread/` (git-ignored).
- Service: launchd `com.lifeos.relay`, installed by `bun LIFEOS/RELAY/bridge/Install.ts`.
- Operations: the `Relay` skill provides status, send to your line, countersign, probe, service control, and unlock.

## What it is not

Not a phone line for anyone but you. Not a group-chat bot. Not a channel for anyone but you to drive tools. Not a way to create a new place your data can go.

Not the Messages reader either. `LIFEOS/TOOLS/Messages/` (launchd `com.lifeos.messages`) copies inbound texts (minus any handles excluded in `heartbeat.json`) into a private inbox for the Hermes heartbeat's optional iMessage leg; it reads, never replies, and nothing in it drives tools.
