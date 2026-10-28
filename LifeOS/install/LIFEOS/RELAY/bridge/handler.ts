import { ConversationStore, recordSend } from "./conversation.ts";
import { isStopCommand, ProgressReporter, type AgentEvent } from "./progress.ts";
import { join } from "node:path";
import { ACK_TAPBACK, asksQuestion, isPureAck, latestAnswerable, NO_TAPBACK, sameMessage, tapbackIntent } from "./tapback.ts";
import { asksForVoice, isAudio, SPOKEN_INSTRUCTION, splitSpoken } from "./voice.ts";
import type { HerdrRun } from "./herdr.ts";
import { injectionShaped } from "../../../hooks/lib/texting-guard-core.ts";
import { maskSeenCodes, redactSecrets } from "./thread.ts";
import { classify, followGuardLog, raise, raises, recordEvent } from "./record.ts";
import { invariant } from "../../TOOLS/Invariant.ts";
import { daName, identify, principalName, recordableId, UNKNOWN_ID, UNKNOWN_SENDER, type Person, type Speaker } from "./identity.ts";
import type { ConversationMessage } from "./conversation.ts";

export interface IncomingMessage {
  id: string;
  sender?: { id: string; service?: string };
  direction: "inbound" | "outbound";
  timestamp: Date;
  content: any;
}
export interface MessageSpace {
  id: string;
  type?: string;
}
export interface HandlerDependencies {
  store: ConversationStore;
  allowFrom: string[];
  chatFrom?: string[];
  admit: (sender: string, body: string) => { prompt: string } | { reply: string };
  ask: (sender: string, prompt: string, context: { thread: string; messageId: string; replyTo?: string; onInterim?: () => void; onEvent?: (e: AgentEvent) => void; onLine?: (line: string) => void; signal?: AbortSignal; /** Tex F22: the session hands back a writer for mid-turn texts, then undefined when it closes. */ steer?: (write: ((text: string) => boolean) | undefined) => void }) => Promise<{ text: string; cancelled?: boolean; failure?: string; error?: string; /** Tex F22 ISC-329: the second-look line for a held send to someone else. */ secondLook?: string; /** Tex F22 ISC-343: codes the turn read from mail; what is logged or recorded of this turn has them masked. */ seenCodes?: readonly string[] }>;
  /** Relay ISA F12: a text that asks for herdr is also mirrored live into a herdr workspace on the Mac. */
  herdr?: { route: (text: string) => { herdr: boolean; prompt: string }; open: (thread: string, prompt: string) => Promise<HerdrRun> };
  /** Visible receipt (👀 reaction + read receipt) the moment a principal text arrives; resolves to an undo. */
  ack?: (message: IncomingMessage) => Promise<(() => Promise<unknown>) | undefined>;
  confirmOpen?: (sender: string) => boolean;
  react?: (message: IncomingMessage, emoji: string) => Promise<unknown>;
  sendVoice?: (text: string) => Promise<{ id: string; timestamp?: Date } | undefined>;
  /** Progress cadence override (tests). */
  progress?: { firstAfterMs?: number; everyMs?: number; max?: number };
  /** `who` is the sender resolved to a person (Relay ISC-423, ISC-426); the persona sees the name, never the handle. */
  chat?: (sender: string, history: string, body: string, who: Speaker) => Promise<{ text: string }>;
  attachment: (sender: string, content: any) => Promise<{ prompt: string; voice?: boolean }>;
  send: (body: string, rich: boolean) => Promise<{ id: string; timestamp?: Date } | undefined>;
  /** Rewrites local-only URLs in a text to the principal (remote-links.ts); contacts never get it. */
  remoteLinks?: (text: string) => string;
  typing: (state: "start" | "stop") => Promise<unknown>;
  hydrate?: (sender: string, thread: string, messageId: string) => Promise<{ replyTo?: string; count: number }>;
  safeHistoryText?: (body: string) => boolean;
  /** A principal tapback on a workflow approval text answers that step (workflow-tapback.ts); unhandled falls through. */
  workflowTapback?: (sender: string, thread: string, content: any) => { handled: boolean; reply?: string; log?: Record<string, unknown> };
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Tex F19 ISC-244: mirrors what other processes recorded into the principal thread. Runs at the start and end
   *  of every handler pass, contacts and outbound echoes included; it never throws. */
  sweep?: () => void;
  /** Relay F20 (ISC-255/256): whether this allowlisted number has ever arrived marked iMessage, and the marker. */
  serviceRatchet?: { seen: (sender: string) => boolean; mark: (sender: string) => void };
  /** Relay F20 (ISC-258): the guard's own summary of the action it holds for this sender, when one is held. */
  heldAction?: (sender: string) => string | undefined;
  /** Tex F22 ISC-308: files a 👎 on a heads-up text as one Errata miss. Defaults to fileHeadsUpMiss. */
  headsUpMiss?: (text: string) => Promise<HeadsUpMissResult>;
  /** Relay F31 ISC-400: sends one plain text to the principal's own line. Absent, a reply from someone {{DA_NAME}} texted is dropped. */
  forwardToPrincipal?: (body: string) => Promise<unknown>;
  /** Relay F31: the name the principal knows a number by, or undefined. */
  nameFor?: (sender: string) => string | undefined;
  /** Relay ISC-423: the People person a handle belongs to, or undefined. Defaults to identity.ts against the live store. */
  identify?: (handle: string) => Person | undefined;
  /** Relay F34 ISC-420: the Security Rings ring of a handle, for the record; absent, drops are written as Ring 3. */
  ringOf?: (handle: string) => number;
  /** Relay F32 ISC-50/406: a group's active members, our own line left out. Throws, or is absent, when unknown; the group is then dropped. */
  groupMembers?: (space: MessageSpace) => Promise<string[]>;
  /** Relay F32 ISC-407: the friend persona for a group, from the group's shared history. Absent, groups are never answered. */
  groupChat?: (history: string, body: string, people: Speaker[]) => Promise<{ text: string }>;
  /** Relay F32 ISC-408: whether a group text names the DA. */
  namesDA?: (text: string) => boolean;
}

/** Relay F32 ISC-409: the store key every group line is kept under, so a group has one shared history whoever speaks. */
export const GROUP_SENDER = "group";

/** Relay F31: how long after {{DA_NAME}} texts a number its replies still reach the principal (the store keeps them 30 days). */
export const REPLY_WINDOW_MS = 30 * 86400000;

/** Relay F31 ISC-400/401: whether {{DA_NAME}} sent this number a text in the window, on this thread or its iMessage thread. */
export function textedRecently(store: ConversationStore, sender: string, thread: string, now = Date.now()): boolean {
  const threads = [...new Set([thread, `iMessage;-;${sender}`])];
  return threads.some(t => store.messages(sender, t).some(m => m.direction === "outbound" && m.source === "notification" && now - Date.parse(m.timestamp) <= REPLY_WINDOW_MS));
}

/** Relay F31 ISC-400/402: the one plain message a reply becomes. Its words are data for the principal; instruction-shaped words are held. */
export function forwardedReply(name: string, body: string): string {
  const clean = redactSecrets(body).replace(/\s+/g, " ").trim().slice(0, 600);
  const head = `💬 **Reply from ${name.replace(/[*\\`_~\[\]]/g, "")}**`;
  if (!clean) return `${head}\nThey sent something that is not text.`;
  if (injectionShaped(clean)) return `${head}\nHeld: it reads like instructions to an AI, so I did not pass the words on.`;
  return `${head}\n“${clean}”`;
}

/** Relay F34 ISC-419: a refused reply says why; a broken ring file reads rings_invalid. */
export function chatFailure(e: unknown, ring: number): { ring: number; reason: string } {
  const m = String((e as Error)?.message ?? e);
  return { ring, reason: m.startsWith("rings_invalid") ? "rings_invalid" : "inference" };
}

export type HeadsUpMissResult = { matched: false } | { matched: true; headsUpId: string; erratumId?: string; error?: string };

/**
 * Tex F22 ISC-308: a 👎 on a heads-up text is a miss, and the only thing it does is file one Errata row naming that
 * text. It approves nothing and runs nothing: no model, no workflow, no held action. The text is matched to the heads-up
 * it carried (HeadsUp.ts findHeadsUp, the last 7 days of sent heads-ups); a text that was not a heads-up is unmatched
 * and keeps the ordinary tapback rules. The row goes in through the Errata CLI as an argv array, never a shell line.
 */
export async function fileHeadsUpMiss(text: string, opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Promise<HeadsUpMissResult> {
  const { findHeadsUp, HEADSUP_SOURCE } = await import("../context/HeadsUp.ts");
  const hit = findHeadsUp(text);
  if (!hit) return { matched: false };
  invariant(typeof hit.id === "string" && hit.id.length > 0, "a matched heads-up carries its id");
  const quoted = hit.text.replace(/\s+/g, " ").trim().slice(0, 400);
  invariant(quoted.length > 0, "a heads-up miss names the text it is about");
  const env: Record<string, string | undefined> = { ...process.env, ...opts.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" };
  delete env.LIFEOS_TEXTING_SESSION;
  delete env.LIFEOS_TEXTING_STATE;
  const argv = [process.execPath, join(import.meta.dir, "../../ERRATA/Errata.ts"), "add", "--json",
    "--system", "lifeos", "--source", "principal", "--channel", "relay", "--kind", "complaint",
    "--reporter-id", "principal", "--reporter-role", "principal",
    "--complaint", `👎 on a heads-up text: "${quoted}"`,
    "--component", HEADSUP_SOURCE, "--requested", `heads-up ${hit.id} (${hit.urgency}, sent ${hit.ts})`,
    "--tag", HEADSUP_SOURCE, "--tag", `headsup:${hit.id}`, "--tag", "f22-isc-308"];
  const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).finally(() => clearTimeout(timer));
  if (code !== 0) return { matched: true, headsUpId: hit.id, error: (err.trim() || `exit ${code}`).slice(0, 200) };
  let erratumId: string | undefined;
  try { erratumId = (JSON.parse(out.trim().split("\n").pop() ?? "{}") as { id?: string }).id; } catch { /* filed; id unreadable */ }
  return { matched: true, headsUpId: hit.id, ...(erratumId ? { erratumId } : {}) };
}

/** The sender service of a request {{PRINCIPAL_NAME}} spoke on a phone call (Relay F29). */
export const CALL_SERVICE = "tex-call";

/** An allowlisted number is the principal only over iMessage. SMS and RCS never are. An unmarked or "unknown"
 *  service is admitted only until this number has once arrived marked iMessage: that closes the gap the moment
 *  Photon has shown it sends the mark, and can never lock the principal out before then (Relay F20). */
export function principalTier(message: IncomingMessage, allowFrom: string[], iMessageSeen = false): boolean {
  if (!message.sender || !allowFrom.includes(message.sender.id)) return false;
  const service = message.sender.service;
  // CALL_SERVICE is set only by the bridge, for a request spoken on a call the Worker admitted after the passphrase
  // (Relay F29); the Linq mapping drops any service it does not know, so a text can never carry it.
  if (service === "iMessage" || service === CALL_SERVICE) return true;
  if (/^(SMS|RCS)$/i.test(service ?? "")) return false;
  return !iMessageSeen;
}

/** Terminal escape sequences, plus the colour fragments left when iMessage drops the ESC byte ("[38;2;59;130;246m",
 *  "[39m"). A text never wants either: on 2026-10-17..23 RichFormat's colour codes reached iMessage (Tex F27). */
const TERMINAL_CODES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|\[(?:[34]8;(?:5;\d{1,3}|2;\d{1,3};\d{1,3};\d{1,3})|0|22|23|24|27|39|49)m/g;
export function stripTerminalCodes(text: string): string { return text.replace(TERMINAL_CODES, ""); }

/** Every outbound text and spoken line has secret values redacted (Relay F20 ISC-257) and terminal codes removed
 *  (Tex F27 ISC-374) before it reaches the provider. */
export function withOutboundRedaction(d: HandlerDependencies): HandlerDependencies {
  return {
    ...d,
    send: (body, rich) => d.send(stripTerminalCodes(redactSecrets(body)), rich),
    ...(d.sendVoice ? { sendVoice: (text: string) => d.sendVoice!(stripTerminalCodes(redactSecrets(text))) } : {}),
  };
}

/** The bridge-written line that names the held action, so what the principal approves is what the guard holds.
 *  It ends on its own question, so a 👍 on this reply still reads as an answer (tapback.ts asksQuestion). */
export function heldActionLine(summary: string): string {
  const s = summary.replace(/\s+/g, " ").trim();
  return `🔒 Held for your yes: ${s.length > 110 ? `${s.slice(0, 109)}…` : s}. Run it?`;
}

/** What the record holds in place of a countersign or injection-shaped text, the same rule the thread uses. */
const OMITTED = "[authentication continuation; content omitted]";

const isGroup = (space: MessageSpace) => space.type === "group" || space.id.includes(";+;");

/** Relay ISC-423/424: who a handle is in this conversation. The principal's own handle is always the principal; a handle
 *  that resolves to no one is the unknown sender, never a guessed name. */
export function speakerOf(d: Pick<HandlerDependencies, "allowFrom" | "identify" | "nameFor">, handle: string): Speaker {
  const role = d.allowFrom.includes(handle) ? "principal" : "contact";
  const found = (d.identify ?? identify)(handle);
  if (found) return { ...found, role };
  const name = d.nameFor?.(handle);
  return role === "principal"
    ? { id: UNKNOWN_ID, name: name ?? principalName(), ring: 0, about: [], role }
    : { id: UNKNOWN_ID, name: name ?? UNKNOWN_SENDER, ring: 3, about: [], role };
}

/** Relay ISC-425: a group record as the model reads it, labelled by speaker and role, {{DA_NAME}}'s own lines as the assistant's.
 *  A record from before speakers were stored keeps the name its text starts with. */
export function groupLine(m: ConversationMessage): object {
  const { source: _source, receivedAt: _receivedAt, speaker, ...rest } = m;
  if (m.direction === "outbound") return { ...rest, speaker: daName(), role: "assistant" };
  if (speaker) return { ...rest, speaker: speaker.name, role: speaker.role };
  const label = /^([^:\n]{1,80}): /.exec(m.text)?.[1];
  return { ...rest, ...(label ? { speaker: label } : {}) };
}
const textOf = (content: any): string => content?.type === "text" ? content.text : content?.type === "markdown" ? content.markdown : "";

/** The production entry point, with transport side effects injected for replays. Callers must NOT await it
 *  inside the stream loop: one task per thread runs at a time, but receipt, 👀 and "stop" never wait (ISC-77). */
export async function handleMessage(space: MessageSpace, message: IncomingMessage, deps: HandlerDependencies): Promise<void> {
  if (message.direction !== "inbound") return handleTurn(space, message, deps);
  const turn = recordedTurn(space, message, deps);
  let error: unknown;
  try { await handleTurn(space, message, turn.deps); } catch (e) { error = e; throw e; } finally { turn.end(error); }
}

/** Relay ISA F21: the text, every text sent back, and how the turn ended, on the STATVS record. The words are what
 *  left: sends are recorded after outbound redaction. A countersign or injection-shaped text is recorded as omitted,
 *  the same rule the thread uses (ISC-268). A bad outcome on a principal text raises one high event a day (ISC-272). */
function recordedTurn(space: MessageSpace, message: IncomingMessage, deps: HandlerDependencies): { deps: HandlerDependencies; end: (error?: unknown) => void } {
  const sender = message.sender?.id ?? "";
  const role = deps.allowFrom.includes(sender) ? "principal" : (deps.chatFrom ?? []).includes(sender) ? "contact" : "other";
  // Nothing here may throw into the handler: a text that cannot be described is still recorded and still handled.
  let fields: Record<string, unknown> = {};
  try {
    const outer = message.content;
    const content = outer?.type === "reply" ? outer.content : outer;
    const raw = textOf(content) || (content?.type === "reaction" ? String(content.emoji ?? "") : "");
    const text = raw && deps.safeHistoryText && !deps.safeHistoryText(raw) ? OMITTED : raw;
    const file = content?.type === "attachment" || content?.type === "voice" ? { name: content?.name, mimeType: content?.mimeType } : {};
    const ts = message.timestamp instanceof Date && !Number.isNaN(message.timestamp.getTime()) ? message.timestamp.toISOString() : undefined;
    fields = { type: content?.type, ...(outer?.type === "reply" ? { swipeReply: true } : {}), text, ...file, ...(ts ? { ts } : {}) };
  } catch (e) { fields = { unreadable: String(e).slice(0, 120) }; }
  // Relay ISC-427: contact and group rows name the person by People id (or `unknown`); the principal's DM rows are as before.
  let person: { person?: string } = {};
  if (role !== "principal" || isGroup(space)) {
    try { person = { person: recordableId(speakerOf(deps, sender).id) }; } catch { person = { person: UNKNOWN_ID }; }
  }
  // A non-principal handle never lands raw: the masks only cover configured channels, so a stranger's number would.
  const recordedSender = role === "principal" ? sender : person.person === UNKNOWN_ID ? "[unknown]" : "[contact]";
  recordEvent("lib:relay", "text_in", { turn: message.id, thread: space.id, sender: recordedSender, role, ...person, ...fields });
  const events: string[] = [];
  let sent = 0;
  // Tex F22 ISC-343: a code the turn read from mail is masked in the text_out and voice_out rows; the send is not.
  let seenCodes: readonly string[] = [];
  const wrapped: HandlerDependencies = {
    ...deps,
    ask: async (...args) => {
      const r = await deps.ask(...args);
      if (r.seenCodes?.length) seenCodes = [...seenCodes, ...r.seenCodes];
      return r;
    },
    log: (event, data) => { events.push(event === "ask_failed" ? `ask_failed:${String(data?.failure ?? "unknown")}` : event); deps.log(event, data); },
    send: async (body, rich) => {
      const r = await deps.send(body, rich);
      sent++;
      recordEvent("lib:relay", "text_out", { turn: message.id, thread: space.id, ...person, rich, text: maskSeenCodes(body, seenCodes) });
      return r;
    },
    ...(deps.sendVoice ? { sendVoice: async (body: string) => {
      const r = await deps.sendVoice!(body);
      sent++;
      recordEvent("lib:relay", "voice_out", { turn: message.id, thread: space.id, ...person, text: maskSeenCodes(body, seenCodes) });
      return r;
    } } : {}),
  };
  return {
    deps: wrapped,
    end: (error) => {
      followGuardLog(); // the turn's guard decisions land before its outcome
      const { outcome, reason } = classify(events, sent, error);
      recordEvent("lib:relay", "outcome", { turn: message.id, thread: space.id, role, ...person, outcome, reason });
      if (role === "principal" && raises(outcome, sent)) {
        const kind = outcome === "failed" ? reason : outcome;
        raise("high", `A text to Relay went unanswered: ${outcome}`, `A text from the principal ended ${outcome} (${reason}).`, `relay:outcome:${kind}:${new Date().toISOString().slice(0, 10)}`);
      }
    },
  };
}

/** The member list last recorded for each group in this process, so a list is written once per change. */
const recordedMembers = new Map<string, string>();
/** Conversation-memory ISC-10: who is in a trusted group, as People ids, so each member's history holds the group lines
 *  they were present for. One `group_members` row when a list first appears or changes; never throws into the turn. */
export function recordGroupMembers(d: Pick<HandlerDependencies, "allowFrom" | "identify" | "nameFor">, thread: string, members: string[]): void {
  try {
    const ids = [...new Set(members.map(m => recordableId(speakerOf(d, m).id)))].sort();
    const key = ids.join(",");
    if (recordedMembers.get(thread) === key) return;
    recordedMembers.set(thread, key);
    recordEvent("lib:relay", "group_members", { thread, members: ids });
  } catch (e) { console.error(`[relay] group members: ${String(e).slice(0, 160)}`); }
}

/** Relay F32: a group text from the principal or a chat-only contact. Answered only when every member is trusted
 *  (ISC-50, ISC-406), always as the no-tools friend persona (ISC-407), only when the DA is named or replied to
 *  (ISC-408), from one shared history labelled by speaker with the tripwire first (ISC-409). */
async function groupTurn(space: MessageSpace, message: IncomingMessage, d: HandlerDependencies, sender: string): Promise<void> {
  const trusted = new Set([...d.allowFrom, ...(d.chatFrom ?? [])]);
  let members: string[] | undefined;
  try { members = await d.groupMembers?.(space); }
  catch (e) { d.log("group_members_failed", { error: String(e).slice(0, 160) }); }
  if (!members?.length || !d.groupChat) { d.log("drop_group_unknown"); return; }
  if (!members.every(m => trusted.has(m))) { d.log("drop_group_untrusted", { members: members.length, ring: Math.max(...members.map(m => d.ringOf?.(m) ?? 3)) }); return; }
  if (!message.id || !space.id) { d.log("drop_missing_identity"); return; }
  if (!d.store.claim(GROUP_SENDER, space.id, message.id)) { d.log("duplicate_inbound"); return; }
  recordGroupMembers(d, space.id, members);
  let content = message.content;
  let replyTo: string | undefined;
  if (content?.type === "reply") {
    const target = content.target;
    if (target?.space?.id === space.id && typeof target.id === "string") replyTo = target.id;
    content = content.content;
  }
  const body = textOf(content);
  if ((content?.type !== "text" && content?.type !== "markdown") || !body.trim()) {
    d.log("group_non_text_ignored", { contentType: content?.type });
    d.log("group_context");
    d.store.finishReply(GROUP_SENDER, space.id, message.id);
    return;
  }
  const history = d.store.messages(GROUP_SENDER, space.id);
  const addressed = (d.namesDA?.(body) ?? false) || (!!replyTo && history.some(m => m.direction === "outbound" && sameMessage(m.id, replyTo)));
  const who = speakerOf(d, sender);
  const shaped = injectionShaped(body);
  const line = `${who.name}: ${shaped ? "[Message withheld]" : body}`;
  d.store.record(GROUP_SENDER, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: line, source: "contact", replyTo, speaker: { id: who.id, name: who.name, role: who.role } });
  d.store.prune(GROUP_SENDER, space.id);
  d.log("inbound", { chars: body.length, group: true, addressed, ring: 1 });
  const send = (text: string) => recordSend(d.store, GROUP_SENDER, space.id, text, "reply", () => d.send(text, false), message.id);
  if (shaped) {
    d.log("injection_dropped", { group: true, chars: body.length });
    if (addressed) await send("I'm not going to act on that one.");
    else d.log("group_context");
    d.store.finishReply(GROUP_SENDER, space.id, message.id);
    return;
  }
  if (!addressed) { d.log("group_context"); d.store.finishReply(GROUP_SENDER, space.id, message.id); return; }
  try {
    const r = await d.groupChat(d.store.context(GROUP_SENDER, space.id, message.id, replyTo, undefined, groupLine), line, members.map(m => speakerOf(d, m)));
    d.store.prepareReply(GROUP_SENDER, space.id, message.id, r.text);
    await send(r.text);
    d.store.finishReply(GROUP_SENDER, space.id, message.id);
    d.log("replied", { chars: r.text.length, group: true, ring: 1 });
    d.log("group_replied");
  } catch (e) {
    d.log("chat_failed", chatFailure(e, 1));
    await send("Sorry, I can't chat right now. Please try again later.");
    d.store.finishReply(GROUP_SENDER, space.id, message.id);
  }
}

async function handleTurn(space: MessageSpace, message: IncomingMessage, deps: HandlerDependencies): Promise<void> {
  const d = withOutboundRedaction(deps);
  const key = JSON.stringify([d.store.root, space.id, message.sender?.id]);
  const sender = message.sender?.id ?? "";
  const principalDirect = message.direction === "inbound" && principalTier(message, d.allowFrom, d.serviceRatchet?.seen(sender) ?? false) && !isGroup(space) && !!message.id && !!space.id;
  // Seen, visibly, before anything else happens — even when this text queues behind a running task (ISC-78).
  const acked = principalDirect && message.content?.type !== "reaction" && d.ack ? d.ack(message).then((undo) => { d.log("acked"); return undo; }, () => { d.log("ack_failed"); return undefined; }) : undefined;
  const release = async () => { const undo = await acked; if (undo) await undo().catch(() => d.log("unack_failed")); };
  d.sweep?.();
  // "stop" cancels the running task now instead of waiting behind it (ISC-80).
  const running = tasks.get(key);
  if (principalDirect && running && isStopCommand(textOf(message.content))) {
    try { await stopTask(space, message, d, running); } finally { d.sweep?.(); await release(); }
    return;
  }
  // Tex F22 steering: a principal text that arrives while a task runs joins that task at its next tool boundary,
  // after the same admission, service and tripwire checks as any text. Tapbacks, attachments, acks, held-action
  // answers and anything the tripwire or countersign check catches never steer; they take the queue below.
  let claimed = false;
  const steerBody = principalDirect && running?.steer ? steerableText(message, d, sender) : undefined;
  if (steerBody !== undefined) {
    const steered = await steerTask(space, message, d, key, running!, steerBody);
    if (steered.done) { d.sweep?.(); await release(); return; }
    claimed = steered.claimed;
  }
  // A text sent while an earlier one is still being worked on waits its turn silently; the 👀 is its acknowledgement
  // (2026-10-10).
  const followUp = principalDirect && active.has(key);
  if (followUp) d.log("queued_followup");
  const previous = active.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => processMessage(space, message, d, key, followUp, claimed));
  active.set(key, next);
  try { await next; } finally { if (active.get(key) === next) active.delete(key); d.sweep?.(); await release(); }
}
const active = new Map<string, Promise<void>>();
/** The task running on a thread: its stop switch, the writer that steers it while it can take a text (F22), and how
 *  it ended, which a text steered into it reports as its own outcome. */
interface TaskSlot { controller: AbortController; steer?: (text: string) => boolean; replied?: boolean; cancelled?: boolean; failure?: string }
const tasks = new Map<string, TaskSlot>();

/** Wraps a steered text so the model reads it as a change to the task it is running, like FOLLOW_UP_NOTE. */
export const STEER_NOTE = "\n[Sent by the principal while you were still working on this task. It may add to, narrow, or correct what you are doing rather than start something new: fold it in, don't redo work already done, and answer it in the same one reply.]";

/** The text a message would steer with, or undefined when it must take the normal queue. Only plain principal text
 *  steers: a tapback, attachment or voice note, a pure ack, an answer while a held action is open, and any text the
 *  tripwire or the countersign check catches all go through processMessage, where their own rules apply. */
function steerableText(message: IncomingMessage, d: HandlerDependencies, sender: string): string | undefined {
  const outer = message.content;
  const content = outer?.type === "reply" ? outer.content : outer;
  if (content?.type !== "text" && content?.type !== "markdown") return undefined;
  const body = textOf(content);
  if (typeof body !== "string" || !body.trim()) return undefined;
  if (isStopCommand(body) || isPureAck(body) || injectionShaped(body)) return undefined;
  if (d.safeHistoryText && !d.safeHistoryText(body)) return undefined;
  if (d.confirmOpen?.(sender)) return undefined;
  return body;
}

/** Writes a principal text into the running task (Tex F22, ISC-318). done:false hands it back to the queue; claimed
 *  says the inbound id is already taken, so processMessage must not claim it again. */
async function steerTask(space: MessageSpace, message: IncomingMessage, d: HandlerDependencies, key: string, slot: TaskSlot, body: string): Promise<{ done: true } | { done: false; claimed: boolean }> {
  const sender = message.sender!.id;
  if (!d.store.claim(sender, space.id, message.id)) { d.log("duplicate_inbound"); return { done: true }; }
  d.log("principal_service", { service: message.sender?.service ?? "absent" });
  if (message.sender?.service === "iMessage") d.serviceRatchet?.mark(sender);
  const gate = d.admit(sender, body);
  if ("reply" in gate) {
    await recordSend(d.store, sender, space.id, gate.reply, "reply", () => d.send(gate.reply, false), message.id);
    d.store.finishReply(sender, space.id, message.id);
    d.log("replied", { sender, ring: 0, chars: gate.reply.length, gated: true });
    return { done: true };
  }
  invariant(gate.prompt.trim().length > 0, "a steered text must carry words");
  const outer = message.content;
  const replyTo = outer?.type === "reply" && outer.target?.space?.id === space.id && typeof outer.target.id === "string" ? outer.target.id : undefined;
  if (!(slot.steer?.(gate.prompt + STEER_NOTE) ?? false)) { d.log("steer_missed"); return { done: false, claimed: true }; }
  d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: body, source: "principal", replyTo });
  d.store.prune(sender, space.id);
  d.store.finishReply(sender, space.id, message.id);
  d.log("steered_into_task", { sender, chars: body.length });
  // The running task's one reply answers this text too, so this turn ends when that task does, with its outcome.
  await (active.get(key) ?? Promise.resolve()).catch(() => {});
  if (slot.cancelled) d.log("task_cancelled_no_reply", { sender, steered: true });
  else if (slot.failure) d.log("ask_failed", { failure: slot.failure, steered: true });
  else if (slot.replied) d.log("replied", { sender, ring: 0, chars: 0, steered: true });
  return { done: true };
}

async function stopTask(space: MessageSpace, message: IncomingMessage, d: HandlerDependencies, running: TaskSlot): Promise<void> {
  const sender = message.sender!.id;
  if (!d.store.claim(sender, space.id, message.id)) { d.log("duplicate_inbound"); return; }
  running.controller.abort();
  d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: textOf(message.content), source: "principal" });
  const body = "🛑 Stopped. Anything it already finished stays done; nothing else will run on that one.";
  await recordSend(d.store, sender, space.id, body, "status", () => d.send(body, false), message.id);
  d.store.finishReply(sender, space.id, message.id);
  d.log("stopped_by_principal");
}

/** Appended to a text that arrived while the one before it was still running, so it is read in that context. */
export const FOLLOW_UP_NOTE = "\n[Sent while you were still working on the principal's previous message. Read it with that message and your reply to it: it may add to, narrow, or correct the same request rather than start a new one. Do what it asks in that light, and don't redo work already done.]";

async function processMessage(space: MessageSpace, message: IncomingMessage, d: HandlerDependencies, key: string, followUp = false, claimed = false): Promise<void> {
  const sender = message.sender?.id ?? "";
  if (message.direction !== "inbound") return;
  const service = message.sender?.service;
  if (d.allowFrom.includes(sender)) {
    d.log("principal_service", { service: service ?? "absent" });
    if (service === "iMessage") d.serviceRatchet?.mark(sender);
  }
  const principal = principalTier(message, d.allowFrom, d.serviceRatchet?.seen(sender) ?? false);
  const contact = !principal && (d.chatFrom ?? []).includes(sender);
  if (!principal && !contact) {
    // Relay F31: someone {{DA_NAME}} texted answered. The principal gets their words as one plain message; no model or tool sees them.
    if (!d.allowFrom.includes(sender) && d.forwardToPrincipal && !isGroup(space) && message.id && space.id && textedRecently(d.store, sender, space.id)) {
      if (!d.store.claim(sender, space.id, message.id)) { d.log("duplicate_inbound"); return; }
      const last4 = sender.replace(/\D/g, "").slice(-4);
      const name = d.nameFor?.(sender) ?? (last4 ? `the number ending ${last4}` : "someone you texted");
      try { await d.forwardToPrincipal(forwardedReply(name, textOf(message.content))); d.log("reply_forwarded", { ring: d.ringOf?.(sender) ?? 3 }); }
      catch (e) { d.log("reply_forward_failed", { error: String(e).slice(0, 200) }); }
      return;
    }
    d.log(d.allowFrom.includes(sender) ? "drop_principal_non_imessage" : "drop_not_allowlisted", { ring: d.allowFrom.includes(sender) ? 0 : d.ringOf?.(sender) ?? 3 }); return;
  }
  // A group never reuses the principal's session, private history, or sender authorization (Relay F32).
  if (isGroup(space)) return groupTurn(space, message, d, sender);
  if (!message.id || !space.id) { d.log("drop_missing_identity"); return; }
  for (const pending of d.store.pending(sender, space.id)) {
    const lead = "Recovered reply (may duplicate a previously delivered message): ";
    const body = `${lead}${pending.text}`;
    try {
      // Tex F22 ISC-348: the record gets the masked copy saved before the crash; the principal gets the reply as written.
      await recordSend(d.store, sender, space.id, `${lead}${pending.recorded ?? pending.text}`, "reply", () => d.send(body, principal), pending.requestId);
      d.store.finishReply(sender, space.id, pending.requestId);
    } catch { d.log("pending_reply_retry_failed"); }
  }
  if (!claimed && !d.store.claim(sender, space.id, message.id)) {
    d.log("duplicate_inbound");
    if (d.store.incomplete(sender, space.id, message.id)) {
      const warning = "The earlier attempt was interrupted. Some work may have completed; I need to check its saved session before repeating any action.";
      await recordSend(d.store, sender, space.id, warning, "status", () => d.send(warning, false), message.id);
      d.store.finishReply(sender, space.id, message.id);
    }
    return;
  }
  let content = message.content;
  let replyTo: string | undefined;
  if (content?.type === "reply") {
    // Only a target belonging to this exact thread can supply quoted context.
    const target = content.target;
    if (target?.space?.id === space.id && typeof target.id === "string") replyTo = target.id;
    content = content.content;
  }
  let body = content?.type === "text" ? content.text : content?.type === "markdown" ? content.markdown : "";
  let voiceIn = false;
  // Tex F22 ISC-343: codes this turn read from mail. The conversation record (which the thread log ingests) holds
  // the text with them masked; the text sent to the principal is unchanged.
  let seenCodes: readonly string[] = [];
  const send = (raw: string, rich = false, source: "reply" | "status" = "reply") => {
    const text = principal && d.remoteLinks ? d.remoteLinks(raw) : raw;
    return recordSend(d.store, sender, space.id, maskSeenCodes(text, seenCodes), source, () => d.send(text, rich), message.id);
  };
  if (contact) {
    if (content?.type === "reaction") { d.log("tapback_contact_ignored"); d.store.finishReply(sender, space.id, message.id); return; }
    if (content?.type !== "text" && content?.type !== "markdown") {
      await send("I can only chat by text right now.");
      d.store.finishReply(sender, space.id, message.id);
      return;
    }
    if (typeof body !== "string" || !body.trim()) { d.log("drop_non_text", { contentType: content?.type }); return; }
    d.log("inbound", { service: message.sender?.service, chars: body.length, contact: true, ring: 1 });
    // Relay ISA F16 (ISC-186): the tripwire runs before every model call, contacts included. The raw text is never
    // stored either, since stored history is fed to the next chat call.
    if (injectionShaped(body)) {
      d.log("injection_dropped", { contact: true, chars: body.length });
      d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: "[Message withheld]", source: "contact", replyTo });
      await send("I'm not going to act on that one.");
      d.store.finishReply(sender, space.id, message.id);
      return;
    }
    d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: body, source: "contact", replyTo });
    d.store.prune(sender, space.id);
    if (!d.chat) {
      await send("Sorry, I can't chat right now. Please try again later.");
      d.store.finishReply(sender, space.id, message.id);
      return;
    }
    try {
      const r = await d.chat(sender, d.store.context(sender, space.id, message.id), body, speakerOf(d, sender));
      d.store.prepareReply(sender, space.id, message.id, r.text);
      await send(r.text);
      d.store.finishReply(sender, space.id, message.id);
      d.log("replied", { sender, chars: r.text.length, rich: false, contact: true, ring: 1 });
    } catch (e) {
      d.log("chat_failed", chatFailure(e, 1));
      await send("Sorry, I can't chat right now. Please try again later.");
      d.store.finishReply(sender, space.id, message.id);
    }
    return;
  }
  // Tex F22 ISC-308: a 👎 on a heads-up text files one Errata miss and does nothing else, before any other tapback
  // rule can read it as an answer.
  if (content?.type === "reaction" && content.emoji === NO_TAPBACK && (!content.target?.space?.id || content.target.space.id === space.id)) {
    const target = d.store.messages(sender, space.id).find((m) => m.direction === "outbound" && sameMessage(m.id, content.target?.id));
    if (target?.text) {
      let miss: HeadsUpMissResult;
      try { miss = await (d.headsUpMiss ?? fileHeadsUpMiss)(target.text); }
      catch (error) { miss = { matched: false }; d.log("headsup_miss_failed", { error: String(error).slice(0, 160) }); }
      if (miss.matched) {
        d.log("tapback", { emoji: content.emoji, action: "headsup_miss" });
        d.log(miss.error ? "headsup_miss_failed" : "headsup_miss_filed", { headsup: miss.headsUpId, ...(miss.erratumId ? { erratum: miss.erratumId } : {}), ...(miss.error ? { error: miss.error } : {}) });
        d.store.finishReply(sender, space.id, message.id);
        return;
      }
    }
  }
  const workflow = content?.type === "reaction" && d.workflowTapback ? d.workflowTapback(sender, space.id, content) : undefined;
  if (workflow?.handled) { d.log("workflow_tapback", workflow.log); if (workflow.reply) await send(workflow.reply, false, "status"); d.store.finishReply(sender, space.id, message.id); return; }
  if (content?.type === "reaction") {
    const latest = latestAnswerable(d.store.messages(sender, space.id));
    const intent = content.target?.space?.id && content.target.space.id !== space.id
      ? { kind: "ignore" as const, why: "stale" as const }
      : tapbackIntent(content.emoji, content.target?.id, latest, d.confirmOpen?.(sender) ?? false);
    d.log("tapback", { emoji: content.emoji, action: intent.kind, ...(intent.kind === "ignore" ? { why: intent.why } : {}) });
    if (intent.kind === "ignore") { d.store.finishReply(sender, space.id, message.id); return; }
    body = intent.text;
    replyTo = intent.replyTo;
  }
  if (content?.type === "attachment" || content?.type === "voice") {
    try {
      const attachment = await d.attachment(sender, content); body = attachment.prompt; voiceIn = attachment.voice === true;
      // Relay F21 ISC-284: the transcript or file text is what was said, so it goes on the record under the same rule.
      recordEvent("lib:relay", "attachment_text", { turn: message.id, thread: space.id, voice: voiceIn, text: d.safeHistoryText && !d.safeHistoryText(body) ? OMITTED : body });
    }
    catch {
      d.log("attachment_failed");
      const audio = content?.type === "voice" || isAudio(content?.mimeType, content?.name);
      await send(audio ? "🎙️ I couldn't make out that voice message. Mind sending it again, or typing it?" : "That attachment didn't come through on my side. Please send it again.");
      d.store.finishReply(sender, space.id, message.id); return;
    }
  }
  if (typeof body !== "string" || !body.trim()) { d.log("drop_non_text", { contentType: content?.type }); return; }
  d.log("inbound", { sender, chars: body.length, attachment: content?.type === "attachment", ring: 0 });
  const gate = d.admit(sender, body);
  // Admission consumes authentication phrases. Never persist raw input before it.
  if ("reply" in gate) { await send(gate.reply); d.store.finishReply(sender, space.id, message.id); d.log("replied", { sender, ring: 0, chars: gate.reply.length, gated: true }); return; }
  const latest = latestAnswerable(d.store.messages(sender, space.id));
  if (content?.type === "reaction" && gate.prompt === body) {
    gate.prompt = body === "yes" ? "Yes. [They answered your last message with a 👍 tapback.]" : "No. [They answered your last message with a 👎 tapback.]";
  }
  if ((content?.type === "text" || content?.type === "markdown") && gate.prompt === body && isPureAck(body) && d.react && !(d.confirmOpen?.(sender)) && !asksQuestion(latest?.text ?? "")) {
    const historyText = d.safeHistoryText && !d.safeHistoryText(body) ? "[Authentication continuation; content omitted]" : body;
    d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: historyText, source: "principal", replyTo });
    try { await d.react(message, ACK_TAPBACK); d.log("acknowledged_by_tapback"); d.store.finishReply(sender, space.id, message.id); return; }
    catch { /* fall through to normal reply */ }
  }
  const historyText = content?.type === "reaction"
    ? `${content.emoji} (tapback: ${body})`
    : d.safeHistoryText && !d.safeHistoryText(body) ? "[Authentication continuation; content omitted]" : body;
  if (d.hydrate) {
    try { const context = await d.hydrate(sender, space.id, message.id); replyTo = context.replyTo ?? replyTo; d.log("conversation_hydrated", { count: context.count, explicitReply: !!replyTo }); }
    catch { d.log("conversation_hydration_failed"); gate.prompt += "\n[Conversation retrieval is temporarily unavailable. Local delivered history may be incomplete, and an explicit reply target may be missing. Use known context; never claim the missing history was checked.]"; }
  }
  d.store.record(sender, space.id, { id: message.id, timestamp: message.timestamp.toISOString(), direction: "inbound", text: historyText, source: "principal", replyTo });
  d.store.prune(sender, space.id);
  await d.typing("start").catch(() => {});
  // iMessage drops the typing bubble after about a minute, so it is refreshed while the task runs.
  const typingRefresh = setInterval(() => { void d.typing("start").catch(() => {}); }, 50_000);
  const progress = new ProgressReporter({
    ...d.progress,
    send: (text) => { d.log("progress_sent", { n: progress.count }); void send(text, false, "status").catch(() => d.log("progress_send_failed")); },
  }).start();
  const controller = new AbortController();
  const slot: TaskSlot = { controller };
  tasks.set(key, slot);
  const route = content?.type !== "reaction" && d.herdr ? d.herdr.route(gate.prompt) : undefined;
  let mirror: HerdrRun | undefined;
  if (route?.herdr) {
    gate.prompt = route.prompt;
    mirror = await d.herdr!.open(space.id, route.prompt).catch(() => undefined);
    d.log("herdr_mirror", { ok: !!mirror?.ok });
  }
  const wantsVoice = voiceIn || asksForVoice(content?.type === "text" ? content.text : content?.type === "markdown" ? content.markdown : "");
  if (wantsVoice && d.sendVoice) gate.prompt += `\n${SPOKEN_INSTRUCTION}`;
  if (followUp && content?.type !== "reaction") gate.prompt += FOLLOW_UP_NOTE;
  try {
    const r = await d.ask(sender, gate.prompt, {
      thread: space.id, messageId: message.id, replyTo,
      onEvent: (e) => progress.note(e), signal: controller.signal,
      steer: (write) => { slot.steer = write; },
      ...(mirror?.ok ? { onLine: (l: string) => mirror!.line(l) } : {}),
    });
    progress.stop();
    seenCodes = r.seenCodes ?? [];
    if (r.failure) { slot.failure = r.failure; d.log("ask_failed", { failure: r.failure, reason: String(r.error ?? "").slice(0, 160) }); }
    if (r.cancelled) slot.cancelled = true;
    if (r.cancelled) { d.store.finishReply(sender, space.id, message.id); d.log("task_cancelled_no_reply", { sender }); return; }
    // A stray SPOKEN line never reaches the screen, whether or not a voice note was asked for.
    const split = splitSpoken(r.text);
    const body = mirror ? `${split.text}\n\n${mirror.note}` : split.text;
    // The model writes the question; the bridge names what a yes would actually release (Relay F20 ISC-258).
    const held = d.heldAction?.(sender);
    // Tex F22 ISC-329: the second look sits just above the question, which stays last so a 👍 still reads as its answer.
    const look = held && r.secondLook ? `${r.secondLook.replace(/\s+/g, " ").trim().slice(0, 240)}\n` : "";
    const shown = held ? `${body}\n\n${look}${heldActionLine(held)}` : body;
    const spoken = split.spoken;
    d.store.prepareReply(sender, space.id, message.id, shown, maskSeenCodes(shown, seenCodes));
    await send(shown, true);
    d.store.finishReply(sender, space.id, message.id);
    slot.replied = true;
    d.log("replied", { sender, ring: 0, chars: shown.length, rich: true, progressTexts: progress.count });
    if (wantsVoice && d.sendVoice) {
      try {
        await recordSend(d.store, sender, space.id, maskSeenCodes(`[Voice note] ${spoken}`, seenCodes), "reply", () => d.sendVoice!(spoken), message.id);
        d.log("voice_reply_sent", { chars: spoken.length, fullChars: shown.length });
      } catch { d.log("voice_reply_failed"); }
    }
  } finally {
    progress.stop(); clearInterval(typingRefresh); mirror?.finish();
    slot.steer = undefined;
    if (tasks.get(key) === slot) tasks.delete(key);
    await d.typing("stop").catch(() => {});
  }
}
