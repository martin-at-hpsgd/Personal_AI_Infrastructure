#!/usr/bin/env bun
// One-shot outbound send: bun send.ts <+E164> ["message"] [--image <path>] (add --md to render **bold**, *italic*, bullets as styled text)
// Own-line texts are designed cards (Relay ISA F13): a body that opens `<emoji> **<title>**` is sent as markdown without --md; a body with no
// lead emoji gets its origin's emoji and a miss line in the format-miss ledger; nothing is ever blocked for its shape.
// Every send is proofed by SendGate immediately before the transmit. A message to the principal's own line is a hand-off
// (a real secret still blocks); a message to any other number is an outward send.
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { formatBlocked, gatedTransmit, isOwnLine, type GateDeps } from "../../TOOLS/lib/SendGate.ts";
import { remoteLinks } from "./remote-links.ts";
import { isCard, leadEmoji, originEmoji, prepCard, stripMarkup } from "../../TOOLS/TextFormat.ts";
import { lifeosPath } from "../../TOOLS/Paths.ts";

const mimeTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".heic": "image/heic", ".webp": "image/webp" };

export type RelaySendOpts = { to: string; body: string; imagePath?: string; md?: boolean; origin?: string; approved?: boolean };
export type RelayTransmitArgs = { to: string; body: string; imageName?: string; imageBuffer?: Buffer; mimeType?: string; md: boolean; origin: string };
export type RelaySendDeps = {
  gate?: GateDeps;
  /** Test seam: the real transport (Photon/Spectrum) is the default. Returns the message ids. */
  transmit?: (a: RelayTransmitArgs) => Promise<{ textMessageId?: string | null; imageMessageId?: string | null; messageId?: string | null }>;
  /** Test seam: the principal's own numbers; the default reads the bridge's 0600 config. */
  ownNumbers?: string[];
  /** Test seam: the format-miss ledger. Under NODE_ENV=test with none given, nothing is written. */
  missLog?: string;
  /** Test seam: the local-URL rewrite for own-line texts; the default asks Tailscale for this Mac's address. */
  remoteLinks?: (text: string) => string;
  /** Test seam: the interruption ledger writer; the default is TOOLS/Interruptions (skipped under NODE_ENV=test). */
  recordInterruption?: (r: { kind: "text"; source: string; summary: string }) => void;
  /** Test seam: whether a non-principal recipient is Ring 1 (ISC-433); the default is ringTrust. */
  recipientTrust?: (to: string) => Promise<Trust>;
};

export type Trust = { trusted: boolean; why: string };
/** The reason a held send gives, and the exit code main() uses for it (ISC-433). */
export const NEEDS_YES = "NEEDS YES";

/**
 * Relay F36 ISC-433: a text to anyone but the principal goes out only when everyone receiving it is Ring 0 or 1. A
 * number or email is looked up in the rings; a `chat:` group has its current members read from the transport at send
 * time, so a member added after the request is caught. Members that cannot be read, invalid rings, or anyone outside
 * Ring 1 means not trusted.
 */
export async function ringTrust(to: string, d: { members?: (chatId: string) => Promise<string[]>; ringOf?: (handles: string[]) => number } = {}): Promise<Trust> {
  const ringOf = d.ringOf ?? (await (async () => {
    const { conversationRing, loadValidRings } = await import("../../RINGS/policy.ts");
    const { loadRecords } = await import("../../PEOPLE/query.ts");
    return (handles: string[]) => conversationRing(handles, () => ({ rings: loadValidRings(), records: loadRecords() }));
  })());
  const group = to.match(/^chat:([0-9a-f-]{36})$/i)?.[1];
  let handles = [to];
  if (group) {
    try { handles = await (d.members ?? groupMembers)(group); }
    catch { return { trusted: false, why: "the group's members could not be read" }; }
    if (!handles.length) return { trusted: false, why: "the group has no members to check" };
  }
  const ring = ringOf(handles);
  if (ring <= 1) return { trusted: true, why: `ring ${ring}` };
  return { trusted: false, why: group ? "someone in the group is outside Ring 1" : "the recipient is outside Ring 1" };
}

/** A Linq group's current members, read live (the bridge's chatMembers). Photon cannot list them, so it throws. */
async function groupMembers(chatId: string): Promise<string[]> {
  if (configuredTransport() !== "linq") throw new Error("group members are only readable on Linq");
  const { LinqClient } = await import("./linq.ts");
  const { loadEnv } = await import("./session.ts");
  return new LinqClient({ apiKey: loadEnv().LINQ_API_KEY ?? "" }).chatMembers(chatId);
}

/** One line per own-line text that arrived without a card head: which origin sent it, and what the shape was. */
export const formatMissPath = (): string => lifeosPath("MEMORY", "STATE", "relay", "format-misses.jsonl");

/**
 * The shape of an own-line text. A card head means markdown with no flag; a body with no lead emoji gets its origin's emoji; a body that
 * leads with an emoji but has no bold title is sent as written. A miss is logged, and no step here can stop the send: any throw sends the
 * caller's body untouched (ISC-132, 133, 134, 136, 157).
 */
export function shapeOwnText(o: { body: string; md: boolean; origin: string }, missLog?: string): { body: string; md: boolean } {
  const asGiven = { body: o.body, md: o.md };
  if (!o.body) return asGiven;
  try {
    if (isCard(o.body)) return { body: o.body, md: true };
    const prep = prepCard(o.body);
    if (prep) return { body: prep, md: true };
    const lead = leadEmoji(o.body);
    const body = lead ? o.body : `${originEmoji(o.origin)} ${o.body}`;
    try {
      const path = missLog ?? (process.env.NODE_ENV === "test" ? undefined : formatMissPath());
      if (path) { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), origin: o.origin, miss: lead ? "no bold title line" : "no lead emoji", chars: o.body.length }) + "\n"); }
    } catch { /* the ledger is a courtesy; the text goes out */ }
    return { body, md: o.md };
  } catch { return asGiven; }
}

/** The principal's own line is where cards live; any other number is an outward send and is passed as the caller gave it. */
export type SendArgs = { to: string; body: string; imagePath?: string; md: boolean; origin: string; approved: boolean };
const USAGE = "usage: send.ts <+E164 | chat:<linq chat id>> [message] [--image <path>] [--md] [--origin <name>] [--approved]";
/** The argv after `send.ts`: flags anywhere, the first positional is the number, the rest (joined by spaces) is the body, newlines kept. */
export function parseSendArgs(rawArgs: string[]): { ok: true; args: SendArgs } | { ok: false; usage: string } {
  const md = rawArgs.includes("--md");
  // --approved: the principal said yes to this exact text for someone outside Ring 1 (ISC-433); the texting guard holds it for that yes.
  const approved = rawArgs.includes("--approved");
  // --origin <name> records which system sent the text, so the interruption ledger can attribute every send.
  const originFlag = rawArgs.indexOf("--origin");
  const origin = originFlag === -1 ? "unknown" : (rawArgs[originFlag + 1] ?? "").replace(/[^\w.-]/g, "").slice(0, 40) || "unknown";
  const args = originFlag === -1 ? rawArgs : rawArgs.filter((_, i) => i !== originFlag && i !== originFlag + 1);
  const imageFlag = args.indexOf("--image");
  if (imageFlag !== -1 && (!args[imageFlag + 1] || args.indexOf("--image", imageFlag + 1) !== -1)) return { ok: false, usage: USAGE };
  const imagePath = imageFlag === -1 ? undefined : args[imageFlag + 1];
  const positional = args.filter((a, i) => a !== "--md" && a !== "--approved" && (imageFlag === -1 || (i !== imageFlag && i !== imageFlag + 1)));
  const [to, ...rest] = positional;
  const body = rest.join(" ");
  if (!to || (!body && !imagePath)) return { ok: false, usage: USAGE };
  return { ok: true, args: { to, body, imagePath, md, origin, approved } };
}

/** What the interruption ledger keeps of a text: the words, without markdown markup. */
export function interruptionSummary(body: string): string { return stripMarkup(body); }

export type RelaySendResult = { ok: true; out: Record<string, unknown>; flags: string[] } | { ok: false; message: string };

/** Spectrum/iMessage transport. Imports are lazy so the gate path loads without the bridge's runtime. */
export async function photonTransmit(a: RelayTransmitArgs) {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(homedir(), ".claude/.env"), "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  const cfg = { projectId: env.PHOTON_PROJECT_ID, projectSecret: env.PHOTON_PROJECT_SECRET };
  if (!cfg.projectId || !cfg.projectSecret) throw new Error("PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET missing from ~/.claude/.env");
  const { Spectrum, attachment, markdown, text } = await import("spectrum-ts");
  const { imessage } = await import("spectrum-ts/providers/imessage");
  const { ConversationStore, recordSend } = await import("./conversation.ts");
  // Relay F20 ISC-257: SendGate refuses a real secret; this redacts anything secret-shaped that is left.
  const { redactSecrets } = await import("./thread.ts");
  const body = a.body ? redactSecrets(a.body) : a.body;
  const app = await Spectrum({ projectId: cfg.projectId, projectSecret: cfg.projectSecret, providers: [imessage.config()] });
  const im = imessage(app);
  const space = await im.space.create(a.to);
  const store = new ConversationStore();
  const textMessage = body ? await recordSend(store, a.to, space.id, body, "notification", () => space.send(a.md ? markdown(body) : text(body))) : undefined;
  const imageMessage = a.imageBuffer ? await recordSend(store, a.to, space.id, `[image: ${a.imageName}]`, "notification", () => space.send(attachment(a.imageBuffer!, { name: a.imageName, mimeType: a.mimeType }))) : undefined;
  return textMessage && imageMessage ? { textMessageId: textMessage.id ?? null, imageMessageId: imageMessage.id ?? null } : { messageId: (textMessage ?? imageMessage)?.id ?? null };
}

/** Relay F28: the transport the bridge config names (`transport: "linq"`), Photon until the cutover. */
export function configuredTransport(configPath = lifeosPath("USER", "RELAY", "state", "bridge-config.json")): "linq" | "photon" {
  try { return (JSON.parse(readFileSync(configPath, "utf8")) as { transport?: string }).transport === "linq" ? "linq" : "photon"; }
  catch { return "photon"; }
}

/** Linq transport (Relay F28): send to the number, letting Linq reuse its chat, and record it on that thread. */
export async function linqTransmit(a: RelayTransmitArgs, deps: { client?: import("./linq.ts").LinqClient; store?: import("./conversation.ts").ConversationStore } = {}) {
  const { LinqClient, threadIdFor } = await import("./linq.ts");
  const { ConversationStore, recordSend } = await import("./conversation.ts");
  const { redactSecrets } = await import("./thread.ts");
  let client = deps.client;
  if (!client) {
    const { loadEnv } = await import("./session.ts");
    client = new LinqClient({ apiKey: loadEnv().LINQ_API_KEY ?? "" });
  }
  const body = a.body ? redactSecrets(a.body) : a.body;
  const store = deps.store ?? new ConversationStore();
  // Relay F33 ISC-415: `chat:<linq chat id>` sends into that group, recorded in the group's own history (handler.ts F32).
  const group = a.to.match(/^chat:([0-9a-f-]{36})$/i)?.[1];
  if (group) {
    const { GROUP_SENDER } = await import("./handler.ts");
    const groupThread = threadIdFor(group, true, "", "iMessage");
    const textMessage = body ? await recordSend(store, GROUP_SENDER, groupThread, body, "reply", () => client!.sendText(group, body, undefined, a.md)) : undefined;
    const imageMessage = a.imageBuffer ? await recordSend(store, GROUP_SENDER, groupThread, `[image: ${a.imageName}]`, "reply", async () =>
      client!.sendMedia(group, await client!.upload(a.imageName ?? "image", a.mimeType ?? "application/octet-stream", new Uint8Array(a.imageBuffer!)))) : undefined;
    return textMessage && imageMessage ? { textMessageId: textMessage.id ?? null, imageMessageId: imageMessage.id ?? null } : { messageId: (textMessage ?? imageMessage)?.id ?? null };
  }
  const thread = threadIdFor("", false, a.to, "iMessage");
  let chatId: string | undefined;
  const textMessage = body ? await recordSend(store, a.to, thread, body, "notification", async () => {
    const r = await client!.sendTo(a.to, { body, rich: a.md });
    chatId = r.chatId;
    return { id: r.id };
  }) : undefined;
  const imageMessage = a.imageBuffer ? await recordSend(store, a.to, thread, `[image: ${a.imageName}]`, "notification", async () => {
    const attachmentId = await client!.upload(a.imageName ?? "image", a.mimeType ?? "application/octet-stream", new Uint8Array(a.imageBuffer!));
    return { id: chatId ? (await client!.sendMedia(chatId, attachmentId)).id : (await client!.sendTo(a.to, { attachmentId })).id };
  }) : undefined;
  return textMessage && imageMessage ? { textMessageId: textMessage.id ?? null, imageMessageId: imageMessage.id ?? null } : { messageId: (textMessage ?? imageMessage)?.id ?? null };
}

/** Who a sent text went to, as its record row holds it (Relay ISC-427, conversation-memory ISC-11): the principal's own
 *  line as given (the record masks it to its role), a group by its thread, and anyone else by People id (`unknown`
 *  when no record carries the handle) with the `[contact]` label in place of the handle, so a number outside every
 *  configured channel never lands raw. send.ts texts only people the principal named, so each is a contact. */
export function sendTarget(to: string, toPrincipal: boolean, personOf: (handle: string) => string): Record<string, string> {
  if (toPrincipal) return { to };
  const group = to.match(/^chat:([0-9a-f-]{36})$/i)?.[1];
  if (group) return { to, thread: `linq;+;${group}` };
  const person = personOf(to);
  return { to: "[contact]", person };
}

/** The transport's message id for a sent text, so the history can join it to the conversation store's copy. */
export function sentMessageId(result: unknown): { message?: string } {
  const r = (result ?? {}) as { messageId?: unknown; textMessageId?: unknown; imageMessageId?: unknown };
  const id = [r.messageId, r.textMessageId, r.imageMessageId].find((v): v is string => typeof v === "string" && v.length > 0);
  return id ? { message: id } : {};
}

/**
 * The gated send: SendGate proofs the exact text and any image immediately before the transmit, and nothing leaves
 * (no connection is even opened) when it says no. The own line is a hand-off; any other number is an outward send.
 */
export async function relaySend(o: RelaySendOpts, deps: RelaySendDeps = {}): Promise<RelaySendResult> {
  const imagePath = o.imagePath ? resolve(o.imagePath) : undefined;
  const mimeType = imagePath ? mimeTypes[extname(imagePath).toLowerCase()] : undefined;
  if (imagePath && !mimeType) return { ok: false, message: `unsupported image extension: ${extname(imagePath) || "(none)"}` };
  try { if (imagePath && statSync(imagePath).size === 0) throw new Error("empty"); if (imagePath) statSync(imagePath); }
  catch { return { ok: false, message: `image file is missing or empty: ${o.imagePath}` }; }
  const imageName = imagePath ? basename(imagePath) : undefined;
  const toPrincipal = isOwnLine(o.to, deps.ownNumbers ? { numbers: deps.ownNumbers } : {});
  if (!toPrincipal && !o.approved) {
    const trust = await (deps.recipientTrust ?? ringTrust)(o.to).catch((e): Trust => ({ trusted: false, why: `the rings could not be checked: ${String(e).slice(0, 80)}` }));
    if (!trust.trusted) {
      try {
        const { recordEvent } = await import("./record.ts");
        const { recordableForHandle } = await import("./identity.ts");
        recordEvent("lib:relay", "send_held", { via: "send", origin: o.origin ?? "unknown", ...sendTarget(o.to, false, recordableForHandle), why: trust.why });
      } catch { /* the record never changes a send */ }
      return { ok: false, message: `${NEEDS_YES}: ${trust.why}. Nothing was sent. Ask the principal with the exact words, then rerun with --approved.` };
    }
  }
  const transmit = deps.transmit ?? (configuredTransport() === "linq" ? linqTransmit : photonTransmit);
  // Shaped once, before the gate: the body the gate proofs is the body transmit sends (ISC-158). Another number's text is passed as given (ISC-135).
  const shaped = toPrincipal ? shapeOwnText({ body: (deps.remoteLinks ?? remoteLinks)(o.body), md: o.md === true, origin: o.origin ?? "unknown" }, deps.missLog) : { body: o.body, md: o.md === true };
  const sent = await gatedTransmit(
    // An image-only send proofs its stand-in line, the same text the conversation record carries.
    { channel: "imessage", destination: "send", body: shaped.body || `[image: ${imageName}]`, recipientClass: "imessage", attachments: imagePath ? [imagePath] : undefined, toPrincipal },
    async (g) => {
      // The bytes sent are the bytes proofed: re-read the image after the gate and compare to the gate's hash.
      let imageBuffer: Buffer | undefined;
      if (imagePath) {
        imageBuffer = readFileSync(imagePath);
        const proofed = g.items.find((i) => i.role === "attachment")?.sha256;
        if (createHash("sha256").update(imageBuffer).digest("hex") !== proofed) throw new Error("image changed after it was proofed; nothing sent");
      }
      return transmit({ to: o.to, body: shaped.body, imageName, imageBuffer, mimeType, md: shaped.md, origin: o.origin ?? "unknown" });
    },
    deps.gate,
  );
  // Relay F21 ISC-285: every text this tool sends, or the gate holds, is on the record with its words.
  try {
    const { recordEvent } = await import("./record.ts");
    const { recordableForHandle } = await import("./identity.ts");
    recordEvent("lib:relay", sent.ok ? "text_out" : "send_blocked", { via: "send", origin: o.origin ?? "unknown", ...sendTarget(o.to, toPrincipal, recordableForHandle), ...sentMessageId(sent.ok ? sent.result : undefined), toPrincipal, text: shaped.body, ...(imageName ? { image: imageName } : {}) });
  } catch { /* the record never changes a send */ }
  if (!sent.ok) return { ok: false, message: formatBlocked(sent, "imessage") };
  if (shaped.body) {
    try {
      const record = deps.recordInterruption ?? (process.env.NODE_ENV === "test" ? undefined : (await import("../../TOOLS/Interruptions")).record);
      record?.({ kind: "text", source: `relay/${o.origin ?? "unknown"}`, summary: interruptionSummary(shaped.body) });
    } catch { /* attribution is a ledger, never a reason to fail a sent text */ }
  }
  return { ok: true, out: { ok: true, ...sent.result }, flags: sent.gate.flags.map((f) => `unearned flag, not blocking: ${f.check}: ${String(f.message).replace(/\s+/g, " ").slice(0, 160)}`) };
}

async function main(): Promise<void> {
  // Test runs never reach the phone: bun test sets NODE_ENV=test and every spawned child inherits it (a test that reaches a real send path would otherwise text a real phone).
  if (process.env.NODE_ENV === "test" && process.env.RELAY_TEST_SEND !== "1") { console.log(JSON.stringify({ ok: true, skipped: "NODE_ENV=test" })); process.exit(0); }

  const parsed = parseSendArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.usage); process.exit(2); }
  const { to, body, imagePath, md, origin, approved } = parsed.args;

  let r: RelaySendResult;
  try { r = await relaySend({ to, body, imagePath, md, origin, approved }); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(2); }
  if (!r.ok) {
    console.error(r.message);
    process.exit(r.message.startsWith("SEND BLOCKED") ? 1 : r.message.startsWith(NEEDS_YES) ? 3 : 2);
  }
  for (const f of r.flags) console.error(f);
  console.log(JSON.stringify(r.out));
  process.exit(0);
}

if (import.meta.main) await main();
