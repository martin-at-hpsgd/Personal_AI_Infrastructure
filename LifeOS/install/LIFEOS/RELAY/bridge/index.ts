#!/usr/bin/env bun
/**
 * The Tex bridge: iMessage in, a full-capability headless DA session (guarded by hooks/TextingGuard.hook.ts), the
 * reply out on the same thread. The session logic lives in session.ts and the per-message flow in handler.ts; this
 * file only connects them to a transport, chosen by `transport` in the bridge config:
 *
 *   linq    Linq webhooks → the lifeos-tex Worker's inbox → this process over one WebSocket (inbox-link.ts);
 *           replies through Linq's REST API (linq.ts). Relay ISA F28.
 *   photon  (default until F28's cutover) Photon Spectrum's gRPC stream through spectrum-ts. ISC-9 guard: refuses
 *           the production project while Hermes' photon plugin is still enabled (single-consumer rule).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Spectrum, markdown, text, typing } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { admit, askDA, confirmIsOpen, forgetSession, heldSummary, ingestAttachment, invariant, loadConfig, loadEnv, log, pinnedAllowFrom, safeHistoryText, serviceRatchet, STATE, CONFIG } from "./session.ts";
import type { IncomingMessage, MessageSpace } from "./handler.ts";
import { auditFact, LinqClient, linqVoiceClient, mapEvent } from "./linq.ts";
import { InboxLink } from "./inbox-link.ts";
import { bridgeToken } from "../worker/deploy.ts";
import { callTranscript, callTurn } from "./call-turns.ts";
import { countBridges, HEALTH_PROMPT, HEALTH_SENDER, startHealthCheck, writeHealthEvent } from "./health.ts";
import { synthesizeSpeech } from "./voice.ts";
import { remoteLinks } from "./remote-links.ts";
import { CONVERSATIONS, ConversationStore } from "./conversation.ts";
import { syncContactChannels } from "./contacts-sync.ts";
import { handleMessage } from "./handler.ts";
import { closeLostTurns, followGuardLog, useWorkerSinks } from "./record.ts";
import { routeWorkflowTapback, spawnResume } from "./workflow-tapback.ts";
import { chatReply, groupChatReply, namesDA } from "./chat.ts";
import { identify } from "./identity.ts";
import { loadValidRings, ringOfHandle } from "../../RINGS/policy.ts";
import { loadRecords } from "../../PEOPLE/query.ts";

/** Relay F34 ISC-420: a sender's Security Rings ring for the record; any failure is Ring 3. */
function ringOfSender(handle: string): number {
  try { return ringOfHandle(handle, loadValidRings(), loadRecords()); } catch { return 3; }
}
import { hydrateConversation, providerClient } from "./provider-context.ts";
import { remoteClient, sendNativeVoice } from "./voice-send.ts";
import { HerdrMirror } from "./herdr.ts";
import { PrincipalThread, PrincipalThreadHandle, THREAD_ROOT, resolvePrincipalThread } from "./thread.ts";
import { inferenceSummarizer } from "./compactor.ts";
import { exitWhenOrphaned } from "./orphan.ts";
import { relaySend } from "./send.ts";

/** Relay F31: the principal's own number, where a reply from someone {{DA_NAME}} texted is forwarded. */
function ownNumber(): string | undefined { return cfg.allowFrom.find(n => /^\+\d{8,15}$/.test(n)); }
/** Relay F31 / ISC-423: the People name for any handle (phone in any format, email, thread id); unresolved is undefined. */
const nameFor = (sender: string): string | undefined => identify(sender)?.name;

const cfg = loadConfig();
try { log("contacts_synced", syncContactChannels({ configPath: CONFIG })); }
catch (error) { log("contacts_sync_failed", { error: error instanceof Error ? error.message : "Contact sync failed" }); }
const transport: "linq" | "photon" = (cfg as { transport?: string }).transport === "linq" ? "linq" : "photon";
if (transport === "photon") invariant(cfg.projectId && cfg.projectSecret, "PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET missing from ~/.claude/.env");

if (transport === "photon" && cfg.projectId === cfg.prodProjectId) {
  const hermesCfg = join(homedir(), ".hermes/config.yaml");
  if (existsSync(hermesCfg)) {
    const yaml = readFileSync(hermesCfg, "utf8");
    const enabledBlock = yaml.split(/^plugins:/m)[1] ?? "";
    if (/^\s*-\s*platforms\/photon\s*$/m.test(enabledBlock.split(/^\s*disabled:/m)[0] ?? "")) {
      log("refuse_start", { reason: "production project while Hermes photon plugin enabled" });
      process.exit(1);
    }
  }
}

mkdirSync(STATE, { recursive: true });
log("bridge_starting", { transport, ...(transport === "photon" ? { projectId: cfg.projectId.slice(0, 8) } : {}), pid: process.pid, tools: "full", guard: "TextingGuard", allowFromCount: cfg.allowFrom.length, chatFromCount: cfg.chatFrom.length, countersign: !!cfg.countersignSha256, tap: !!cfg.approve?.enabled, allowFromPin: pinnedAllowFrom().state });
// Relay F25: a restart that kills RelayHost must not leave this bridge running beside the new one.
exitWhenOrphaned(log);

// Relay F21: STATVS writes run on a worker thread (ISC-282); texts cut off by the last stop get their outcome
// (ISC-283); guard decisions reach STATVS through the bridge, since the guard hook imports only its core (ISC-270).
useWorkerSinks();
closeLostTurns();
followGuardLog();
setInterval(() => { followGuardLog(); }, 5_000).unref();

// Tex F19 (ISC-244): every record the bridge writes reaches the principal thread when it is written. The hook is
// called only after both are set up below, and principalMemory.recorded never throws into a send.
const conversations: ConversationStore = new ConversationStore(CONVERSATIONS, (sender, thread, message) => principalMemory.recorded(conversations, sender, thread, message));
const herdr = new HerdrMirror({ stateDir: STATE });
// Tex F18: the bridge is the thread's single writer. It takes the lock now and runs the Haiku compactor queue
// in-process; if the Thread CLI holds the lock (a backfill), texts fall back to the delivered-history block until it exits.
const principal = resolvePrincipalThread(cfg.ownChannels.numbers, conversations);
const principalMemory = new PrincipalThreadHandle(
  principal,
  dir => PrincipalThread.open({ dir, summarizer: inferenceSummarizer(), onError: error => log("thread_compaction_failed", { error: String(error).slice(0, 200) }) }),
  (event, data) => log(event, data ?? {}),
  THREAD_ROOT,
  // The bridge resolves the thread once, here; the marker lets the memory reviewer read this same log (ISC-246).
  { writeActiveMarker: true },
);
if (principal) {
  principalMemory.forTurn(principal.sender, principal.thread);
  // Catch up on startup (ISC-249): records written while the bridge was down or on older code reach the thread now,
  // not at the next text.
  const swept = principalMemory.sweep(conversations);
  log("thread_startup_sweep", swept);
} else log("thread_unavailable", { reason: "ownChannels.numbers must name exactly one line" });
process.on("exit", () => principalMemory.close());
const ratchet = serviceRatchet();
// Relay F26: one real turn through this process's own spawn path, two minutes after start and then hourly.
startHealthCheck({
  ask: () => { forgetSession(HEALTH_SENDER); return askDA(HEALTH_SENDER, HEALTH_PROMPT, cfg); },
  bridges: countBridges, emit: writeHealthEvent, log,
});

/** What a transport does for one inbound message; everything else the handler needs is the same on every transport. */
interface TransportOps {
  send: (body: string, rich: boolean) => Promise<{ id: string; timestamp?: Date } | undefined>;
  typing: (state: "start" | "stop") => Promise<unknown>;
  react: (m: IncomingMessage, emoji: string) => Promise<unknown>;
  ack: (m: IncomingMessage) => Promise<undefined>;
  sendVoice: (body: string) => Promise<{ id: string; timestamp?: Date } | undefined>;
  hydrate?: (sender: string, thread: string, messageId: string) => Promise<{ replyTo?: string; count: number }>;
  /** Relay F32: a group's active members, read live for every group text so a newly added stranger is seen at once. */
  groupMembers?: () => Promise<string[]>;
}

// Never await a task here: the loop must keep receiving so a follow-up, a "stop", or a second
// thread is seen while a long task runs (F8 ISC-77). handleMessage serializes per thread itself.
function dispatch(space: MessageSpace, message: IncomingMessage, ops: TransportOps): void {
  void handleMessage(space, message, {
      store: conversations, allowFrom: cfg.allowFrom, chatFrom: cfg.chatFrom,
      admit: (sender, body) => admit(sender, body, cfg, Date.now(), space.id),
      ask: (sender, prompt, context) => askDA(sender, prompt, cfg, { ...context, memory: principalMemory.forTurn(sender, context.thread) }),
      chat: (_sender, history, body, who) => chatReply(who, history, body),
      groupChat: (history, body, people) => groupChatReply(history, body, people),
      identify,
      namesDA,
      ringOf: ringOfSender,
      ...(ops.groupMembers ? { groupMembers: ops.groupMembers } : {}),
      herdr,
      attachment: ingestAttachment,
      confirmOpen: sender => confirmIsOpen(sender, cfg),
      serviceRatchet: ratchet,
      heldAction: sender => heldSummary(sender, cfg),
      safeHistoryText: body => safeHistoryText(body, cfg),
      sweep: () => { principalMemory.sweep(conversations); },
      workflowTapback: (sender, thread, content) => routeWorkflowTapback(sender, thread, content, conversations, { resume: runId => spawnResume(runId, log) }),
      ...(ops.hydrate ? { hydrate: ops.hydrate } : {}),
      send: ops.send,
      remoteLinks,
      typing: ops.typing, log,
      react: ops.react,
      sendVoice: ops.sendVoice,
      ack: ops.ack,
      nameFor,
      forwardToPrincipal: async (body) => {
        const to = ownNumber();
        if (!to) throw new Error("no own number to forward to");
        const r = await relaySend({ to, body, origin: "relay-reply" });
        if (!r.ok) throw new Error(r.message.slice(0, 200));
      },
  }).catch(e => log("task_error", { error: String(e).slice(0, 500) }));
}

if (transport === "linq") {
  // Relay F28. The inbox URL lives in the 0600 bridge config, the Linq API key in .env, and the bridge token in the
  // login Keychain, where the Worker's deploy script minted it.
  const env = loadEnv();
  const linqCfg = (cfg as { linq?: { inboxUrl?: string } }).linq ?? {};
  const token = bridgeToken();
  invariant(!!env.LINQ_API_KEY, "LINQ_API_KEY missing from ~/.claude/.env");
  invariant(!!token, "the Tex bridge token is missing from the Keychain (bun LIFEOS/RELAY/worker/deploy.ts secrets)");
  invariant(typeof linqCfg.inboxUrl === "string" && /^wss:\/\//.test(linqCfg.inboxUrl), "linq.inboxUrl must be the Worker's wss:// /bridge URL");
  const linq = new LinqClient({ apiKey: env.LINQ_API_KEY });
  const link = new InboxLink({ url: linqCfg.inboxUrl, token, log }).start();
  const principalNumber = cfg.ownChannels.numbers[0] ?? "";
  for await (const event of link.events()) {
    try {
      // Relay F29: a request spoken on a call runs like a text on {{PRINCIPAL_NAME}}'s thread; its answer goes back to the call.
      const turn = callTurn(event, principalNumber);
      if (turn) {
        dispatch(turn.space, turn.message, {
          send: async (body) => {
            if (!link.send({ type: "call_result", call_id: turn.callId, text: body })) throw new Error("inbox not connected");
            return { id: `call-${crypto.randomUUID()}`, timestamp: new Date() };
          },
          typing: async () => undefined,
          react: async () => undefined,
          ack: async () => undefined,
          sendVoice: async () => undefined,
        });
      }
      const transcript = callTranscript(event, principalNumber);
      if (transcript) {
        conversations.record(transcript.sender, transcript.thread, transcript.message);
        principalMemory.sweep(conversations);
        // Relay F33 ISC-414: the words go on the record; the passphrase is already a placeholder in them (call-core.ts).
        log("call_transcript_recorded", { chars: transcript.message.text.length, text: transcript.message.text });
      }
      const fact = auditFact(event);
      if (fact) log(fact.event, fact.data);
      for (const { space, message } of mapEvent(event)) {
        // A caption sent with a photo arrives as a second part (`<id>#1`); Linq tapbacks and receipts go to the message.
        const linqId = message.id.replace(/#\d+$/, "");
        dispatch(space, message, {
          send: (body, rich) => linq.sendText(space.chatId, body, undefined, rich),
          ...(space.type === "group" ? { groupMembers: () => linq.chatMembers(space.chatId) } : {}),
          typing: state => linq.typing(space.chatId, state),
          react: async (m, emoji) => {
            if (m.id !== message.id) throw new Error("react unavailable");
            await linq.react(linqId, emoji);
          },
          // 👀 + read receipt at receipt (F8 ISC-78), once per message, never per part.
          ack: async (m) => {
            if (m.id !== message.id || message.id !== linqId) return undefined;
            void linq.markRead(space.chatId).catch(() => {});
            await linq.react(linqId, "👀");
            return undefined;
          },
          sendVoice: async (body) => {
            const { buffer } = await synthesizeSpeech(body);
            return sendNativeVoice(linqVoiceClient(linq) as Parameters<typeof sendNativeVoice>[0], space.chatId, buffer);
          },
        });
      }
    } catch (e) {
      log("loop_error", { error: String(e).slice(0, 500) });
    }
    // The conversation store has claimed each message by now, so a replay after a crash is recognised as a duplicate.
    link.ack(event.event_id);
  }
}

const app = await Spectrum({
  projectId: cfg.projectId,
  projectSecret: cfg.projectSecret,
  providers: [imessage.config()],
});
log("stream_connected", {});
for await (const [space, message] of app.messages) {
  try {
    dispatch(space, message, {
      hydrate: (sender, thread, messageId) => hydrateConversation(providerClient(app, imessage(space).phone), conversations, sender, thread, messageId, body => safeHistoryText(body, cfg)),
      send: (body, rich) => space.send(rich ? markdown(body) : text(body)),
      typing: state => space.send(typing(state)),
      react: async (m, emoji) => {
        const msg = message as typeof message & { react?: (e: string) => Promise<unknown> };
        if (m.id !== message.id || typeof msg.react !== "function") throw new Error("react unavailable");
        await msg.react(emoji);
      },
      sendVoice: async (body) => {
        const { buffer } = await synthesizeSpeech(body);
        return sendNativeVoice(remoteClient(app, imessage(space).phone), space.id, buffer);
      },
      // 👀 tapback + read receipt at receipt (F8 ISC-78). The 👀 stays: iMessage notifies on every removed
      // reaction, and the principal does not want those notifications (2026-10-08), so no undo is returned.
      ack: async (m) => {
        const msg = message as typeof message & { react?: (e: string) => Promise<unknown> };
        if (m.id !== message.id || typeof msg.react !== "function") return undefined;
        void space.read(message).catch(() => {});
        await msg.react("👀");
        return undefined;
      },
    });
  } catch (e) {
    log("loop_error", { error: String(e).slice(0, 500) });
  }
}
