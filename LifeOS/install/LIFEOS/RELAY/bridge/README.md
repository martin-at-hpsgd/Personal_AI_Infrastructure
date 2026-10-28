# Relay conversation bridge

The direct iMessage line supplies conversation history independently of the model's resumable session. Proactive notifications and replies share the same private mirror, scoped by sender and provider thread ID. Transport acknowledgement means accepted for delivery, not a read receipt.

## Runtime

- `index.ts` owns the single Spectrum subscription and delegates to `handler.ts`.
- `handler.ts` admits direct messages and group texts whose members are all trusted (answered only as the no-tools chat persona, and only when the DA is named or replied to), serializes requests, deduplicates provider IDs, and persists final replies before delivery.
- `conversation.ts` stores acknowledged inbound/outbound context, claims, and pending replies under the private Relay state directory. Directories are mode 0700; records are 0600.
- `identity.ts` resolves every inbound handle to one People person (name, Ring, notes) through the People store and Ring member lists; an unresolved handle is the unknown sender. `handler.ts` and `chat.ts` use it to name speakers and `conversation.ts` stores the group speaker.
- `provider-context.ts` reuses the existing provider client to recover recent history and explicit reply targets omitted by Spectrum's normalized adapter. It excludes foreign threads, failed sends, authentication phrases, and unsafe content; edits and retractions invalidate stale text.
- `session.ts` supplies that history and the installed tool contract to the guarded agent. Session identity includes both sender and thread and is saved before execution.
- `thread.ts` is the principal's running thread (Tex ISA F18): an append-only log, a binary tree of 512-byte summaries, and the saved view each text reads, with zoom files the DA opens down to the original message. The principal's own-line DM gets this view instead of the delivered-history block; contacts never do.
- `compactor.ts` builds the summaries on Haiku, at most 8 at once, with an outage backoff, and with `--no-session-persistence` so a summary writes no Claude Code transcript. `ThreadCli.ts status|view|backfill` reads counts or imports history while the bridge is stopped; `verify-store` and `compaction-transcripts` only read and run any time.
- `transcriptClass.ts` tells a summarizer transcript from a real conversation (one-turn SDK session, no tools, the summary task header), so Cortex search skips them.
- `send.ts` records proactive notifications after transport acknowledgement.
- `LIFEOS/TOOLS/JobPrompt.ts` expands scheduled-agent path placeholders and lists the actual installed allowlisted scripts.

## Recovery and limits

The prompt includes at most 120 recent records and 24,000 characters, plus a known explicit target outside that window. Contact and group threads never expire: until the per-person memory holds them they are the only copy of that person's history, so nothing in `conversation.ts` removes them. In the principal's own thread, a record older than 30 days leaves this store only once the running thread log holds it in its current form (Tex ISA F19), so the log is the one long-term record of the own-line DM; the bridge copies every record into it as it is written and catches up on startup. There is no record-count cap. Pending replies and opaque execution claims are always kept. A missing explicit target stays missing rather than silently selecting a newer message.

Pending replies retry on the next inbound event. An ambiguous send acknowledgement can cause a clearly labeled recovered duplicate. Interrupted agent work is reported as uncertain and is not blindly re-executed. This is not an exactly-once transaction across model tools and the message provider, nor an autonomous durable job runner.

The existing TextingGuard policy remains binding. Native file reads and exact allowed mail/calendar/contacts reads work while locked; other operations retain their existing approval requirements. Discoverability does not imply unrestricted execution of every skill. A group chat is answered only when every member is trusted, only as the no-tools chat persona, and only when the DA is named or replied to; any other group text is ignored.

## Verification

From this directory:

```bash
bun test conversation.test.ts agent-context.test.ts provider-context.test.ts # source tree only; tests are not in the release payload
bunx tsc --noEmit
```

From the installation root:

```bash
bun test LIFEOS/TOOLS/JobPrompt.test.ts LIFEOS/TOOLS/OpenAiAgent.test.ts # source tree only; tests are not in the release payload
bun test hooks/lib/texting-guard-core.test.ts # source tree only; tests are not in the release payload
```

`ContextProbe.ts` reads the actual provider contract without sending or subscribing to the stream. `AgentEval.ts` exercises the real guarded agent with synthetic conversation fixtures and no transport sends. It still loads live agent context and may access authorized personal sources; model evaluation requires approved inference access. The named `relay-conversation` suite provides additional isolated context assertions.
