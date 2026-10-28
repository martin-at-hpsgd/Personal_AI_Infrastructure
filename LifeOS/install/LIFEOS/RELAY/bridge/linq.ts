/**
 * Linq transport for Tex (Relay ISA F28).
 *
 * Linq is the iMessage backend: its webhooks reach the `lifeos-tex` Worker, the Worker's inbox hands them to this
 * bridge over one WebSocket (inbox-link.ts), and replies go back through Linq's REST API from here. Everything above
 * the transport (handler.ts, session.ts, the thread, the guard) sees the same message shapes it saw from Photon.
 *
 * Thread continuity: a direct chat is named `<service>;-;<sender>`, the id the thread log has always been keyed by,
 * so {{PRINCIPAL_NAME}}'s whole history carries over to the new line. Linq's own chat id is kept beside it for sends.
 *
 * API: https://docs.linqapp.com/channel/imessage/ (Partner API v3, read 2026-10-24).
 */
import { invariant } from "../../TOOLS/Invariant.ts";
import type { IncomingMessage, MessageSpace } from "./handler.ts";

export const LINQ_API = "https://api.linqapp.com/api/partner/v3";
/** Media URLs in Linq payloads are served from this host only; anything else is never fetched. */
export const LINQ_CDN = "cdn.linqapp.com";

/** Linq's six standard tapbacks, as the emoji the handler compares against (tapback.ts). */
export const TAPBACK_EMOJI: Readonly<Record<string, string>> = {
  love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓",
};
const EMOJI_TAPBACK: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(TAPBACK_EMOJI).map(([k, v]) => [v, k]));

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface LinqHandle { handle: string; service?: string; is_me?: boolean }
export interface LinqPart { type: string; value?: string; url?: string; filename?: string; mime_type?: string; id?: string }
/** One webhook event, as the Worker's inbox forwards it (the body Linq signed, parsed). */
export interface LinqEvent {
  event_id: string;
  event_type: string;
  created_at?: string;
  data: any;
}

export interface Mapped { space: MessageSpace & { chatId: string }; message: IncomingMessage }

/** The services a Linq handle can carry. Anything else is dropped, so no event can claim a service the bridge
 *  reserves for itself (the call line's, handler.ts CALL_SERVICE). */
const LINQ_SERVICES = new Set(["iMessage", "SMS", "RCS"]);
const knownService = (s: unknown): string | undefined => typeof s === "string" && LINQ_SERVICES.has(s) ? s : undefined;

/** The thread id the log is keyed by: `iMessage;-;+1…` for a direct chat, Linq's chat id for a group. */
export function threadIdFor(chatId: string, isGroup: boolean, sender: string, service?: string): string {
  if (isGroup) return `linq;+;${chatId}`;
  const prefix = service === "SMS" || service === "RCS" ? service : "iMessage";
  return `${prefix};-;${sender}`;
}

function at(value: unknown): Date {
  const d = typeof value === "string" ? new Date(value) : new Date(NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** A media part becomes the handler's attachment content; its bytes are read only from Linq's CDN. */
function mediaContent(part: LinqPart, fetcher: Fetch): Record<string, unknown> {
  const mimeType = part.mime_type ?? "";
  const name = part.filename ?? "";
  const voice = /^audio\//i.test(mimeType) || /\.(caf|m4a|amr)$/i.test(name);
  return {
    type: voice ? "voice" : "attachment", name, mimeType,
    read: async (): Promise<ArrayBuffer> => {
      const url = new URL(part.url ?? "");
      invariant(url.protocol === "https:" && url.hostname === LINQ_CDN, "attachment bytes come only from Linq's CDN");
      const res = await fetcher(url.toString());
      if (!res.ok) throw new Error(`attachment download ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

/**
 * Relay F33 (ISC-412, ISC-413): an event the bridge records rather than handles: Linq delivery, failure and group
 * membership, and what the Worker alone saw (`tex.audit`, which only the Worker enqueues; Linq's own types never pass
 * the Worker's filter under that name). Returns the event name and fields for the record, or null.
 */
export function auditFact(event: LinqEvent): { event: string; data: Record<string, unknown> } | null {
  const d = event.data ?? {};
  switch (event.event_type) {
    case "message.delivered":
      return { event: "linq_delivered", data: { messageId: d.id ?? d.message_id, chatId: d.chat?.id ?? d.chat_id, at: d.delivered_at ?? event.created_at } };
    case "message.failed":
      return { event: "linq_failed", data: { messageId: d.message_id ?? d.id, chatId: d.chat_id ?? d.chat?.id, code: d.code, reason: d.reason, at: d.failed_at ?? event.created_at } };
    case "participant.added":
    case "participant.removed":
      return { event: event.event_type === "participant.added" ? "group_member_added" : "group_member_removed", data: { chatId: d.chat_id ?? d.chat?.id, handle: d.handle ?? d.participant?.handle } };
    case "tex.audit": {
      if (typeof d.event !== "string" || !/^[a-z_]{1,40}$/.test(d.event)) return null;
      const { event: name, ...rest } = d;
      return { event: `worker_${name}`, data: rest };
    }
  }
  return null;
}

/**
 * Map one Linq event to what the handler takes. A message with several parts becomes one handler message per part,
 * in order (the first keeps Linq's id; the rest get `<id>#<n>`), so a photo and its caption are each seen. Events the
 * handler has no use for, and our own outbound echoes, map to nothing.
 */
export function mapEvent(event: LinqEvent, fetcher: Fetch = fetch): Mapped[] {
  const d = event.data ?? {};
  if (event.event_type === "message.received") {
    // Both payload versions: 2026-02-03 puts chat and parts at the top of data; 2025-01-01 nests them under message.
    const chatId: string = d.chat?.id ?? d.chat_id;
    const isGroup = !!(d.chat?.is_group ?? d.is_group);
    const from: LinqHandle | undefined = d.sender_handle ?? d.from_handle ?? (d.from ? { handle: d.from } : undefined);
    const service = knownService(from?.service ?? d.service);
    const id: string = d.id ?? d.message?.id;
    const parts: LinqPart[] = d.parts ?? d.message?.parts ?? [];
    const replyTo: string | undefined = d.reply_to?.message_id ?? d.message?.reply_to?.message_id;
    if (!chatId || !id || !from?.handle || from.is_me || d.is_from_me) return [];
    const space = { id: threadIdFor(chatId, isGroup, from.handle, service), type: isGroup ? "group" : "direct", chatId };
    const timestamp = at(d.sent_at ?? d.message?.sent_at ?? event.created_at);
    return parts.flatMap((part, i): Mapped[] => {
      let content: any;
      if (part.type === "text" && typeof part.value === "string" && part.value.trim()) content = { type: "text", text: part.value };
      else if (part.type === "media" && part.url) content = mediaContent(part, fetcher);
      else return [];
      if (replyTo) content = { type: "reply", target: { id: replyTo, space: { id: space.id } }, content };
      return [{ space, message: { id: i === 0 ? id : `${id}#${i}`, sender: { id: from.handle, service }, direction: "inbound", timestamp, content } }];
    });
  }
  if (event.event_type === "reaction.added") {
    const from: LinqHandle | undefined = d.from_handle ?? (d.from ? { handle: d.from } : undefined);
    if (!d.chat_id || !d.message_id || !from?.handle || from.is_me || d.is_from_me) return [];
    const emoji = d.reaction_type === "custom" ? d.custom_emoji : TAPBACK_EMOJI[d.reaction_type];
    if (!emoji) return [];
    const service = knownService(from.service ?? d.service);
    // A reaction carries no is_group; a tapback that matters (yes/no) only ever answers {{PRINCIPAL_NAME}}'s direct chat.
    const space = { id: threadIdFor(d.chat_id, false, from.handle, service), type: "direct", chatId: d.chat_id };
    return [{ space, message: {
      id: event.event_id, sender: { id: from.handle, service }, direction: "inbound", timestamp: at(d.reacted_at ?? event.created_at),
      content: { type: "reaction", emoji, target: { id: d.message_id, space: { id: space.id } } },
    } }];
  }
  return [];
}

/**
 * The markdown TextFormat produces for iMessage (`**bold**` and backslash escapes) as Linq wants it: plain text plus
 * bold ranges in UTF-16 code units, which is what JS string indices already count.
 */
export function richText(md: string): { value: string; decorations: { range: [number, number]; style: "bold" }[] } {
  let value = "";
  const decorations: { range: [number, number]; style: "bold" }[] = [];
  let open = -1;
  for (let i = 0; i < md.length; i++) {
    const c = md[i]!;
    if (c === "\\" && i + 1 < md.length && /[\\*_`\[\]~#>+-]/.test(md[i + 1]!)) { value += md[++i]; continue; }
    if (c === "*" && md[i + 1] === "*") {
      if (open < 0) open = value.length;
      else { if (value.length > open) decorations.push({ range: [open, value.length], style: "bold" }); open = -1; }
      i++; continue;
    }
    value += c;
  }
  return { value, decorations };
}

/** Relay F33: one fact per send that reached Linq. Words are not carried, only their length and hash, so a mail code a
 *  turn masked in its own text_out row (Tex F22 ISC-343) is never written here in the clear; the hash joins the two. */
export interface LinqSendFact { op: string; chatId?: string; to?: string; messageId?: string; parts: string[]; chars: number; sha256?: string }

export interface LinqClientOptions { apiKey: string; fetch?: Fetch; base?: string; record?: (fact: LinqSendFact) => void }

/** Sends that put something in front of a person; each one is recorded however the client was made (Relay F33). */
const SEND_PATH = /^\/(?:messages|chats\/[^/]+\/(?:messages|voicememo)|messages\/[^/]+\/reactions)$/;

function sendFact(path: string, body: any, response: any): LinqSendFact {
  const parts: any[] = body?.message?.parts ?? (body?.attachment_id ? [{ type: "voicememo" }] : body?.operation ? [{ type: "reaction" }] : []);
  const text = parts.filter(p => p?.type === "text" && typeof p.value === "string").map(p => p.value).join("\n");
  const op = path === "/messages" ? "send_to" : path.endsWith("/voicememo") ? "voice_memo" : path.endsWith("/reactions") ? "reaction" : "send";
  return {
    op,
    chatId: path.match(/^\/chats\/([^/]+)/)?.[1] ?? response?.chat_id,
    ...(Array.isArray(body?.to) ? { to: String(body.to[0] ?? "") } : {}),
    messageId: response?.message?.id ?? response?.id ?? path.match(/^\/messages\/([^/]+)\/reactions$/)?.[1],
    parts: parts.map(p => String(p?.type ?? "unknown")),
    chars: text.length,
    ...(text ? { sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") } : {}),
  };
}

const recordToStatvs = async (fact: LinqSendFact): Promise<void> => {
  const { recordEvent } = await import("./record.ts");
  recordEvent("lib:relay", "linq_send", { ...fact });
};

/** Linq Partner API v3: the calls Tex makes, nothing more. */
export class LinqClient {
  private readonly key: string;
  private readonly f: Fetch;
  private readonly base: string;
  private readonly record: (fact: LinqSendFact) => void | Promise<void>;
  constructor(o: LinqClientOptions) {
    invariant(typeof o.apiKey === "string" && o.apiKey.length > 0, "Linq API key present");
    this.key = o.apiKey; this.f = o.fetch ?? fetch; this.base = o.base ?? LINQ_API;
    this.record = o.record ?? recordToStatvs;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.f(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Linq ${method} ${path.replace(/[0-9a-f-]{36}/gi, ":id")} ${res.status}: ${text.slice(0, 200)}`);
    const parsed = text ? JSON.parse(text) : undefined;
    // Relay F33: every send that reached Linq is recorded here, the one place all sends pass, so no caller can skip it.
    if (method === "POST" && SEND_PATH.test(path)) {
      try { await this.record(sendFact(path, body, parsed)); } catch (e) { console.error(`[linq] send not recorded: ${String(e).slice(0, 120)}`); }
    }
    return parsed;
  }

  /** Send text to an existing chat (rich: the TextFormat markdown subset, rendered as bold); resolves to the message id. */
  async sendText(chatId: string, body: string, replyTo?: string, rich = false): Promise<{ id: string; timestamp?: Date }> {
    const { value, decorations } = rich ? richText(body) : { value: body, decorations: [] };
    invariant(value.length > 0, "a sent text is never empty");
    const part = { type: "text", value, ...(decorations.length ? { text_decorations: decorations } : {}) };
    const r = await this.call("POST", `/chats/${chatId}/messages`, { message: { parts: [part], ...(replyTo ? { reply_to: { message_id: replyTo } } : {}) } });
    return { id: r.message.id, timestamp: r.message.sent_at ? new Date(r.message.sent_at) : undefined };
  }

  /** Send a pre-uploaded file to an existing chat. */
  async sendMedia(chatId: string, attachmentId: string): Promise<{ id: string }> {
    const r = await this.call("POST", `/chats/${chatId}/messages`, { message: { parts: [{ type: "media", attachment_id: attachmentId }] } });
    return { id: r.message.id };
  }

  /**
   * Send to a number rather than a chat (POST /v3/messages): Linq reuses the chat that number is already in, or opens
   * one on our line. This is how other systems text {{PRINCIPAL_NAME}}; a text part, a media part, or both.
   */
  async sendTo(to: string, o: { body?: string; rich?: boolean; attachmentId?: string }): Promise<{ chatId: string; id: string; service?: string }> {
    const parts: unknown[] = [];
    if (o.body) {
      const { value, decorations } = o.rich ? richText(o.body) : { value: o.body, decorations: [] };
      parts.push({ type: "text", value, ...(decorations.length ? { text_decorations: decorations } : {}) });
    }
    if (o.attachmentId) parts.push({ type: "media", attachment_id: o.attachmentId });
    invariant(parts.length > 0, "a send carries text or a file");
    const r = await this.call("POST", "/messages", { to: [to], message: { parts } });
    invariant(typeof r?.chat_id === "string", "Linq named the chat it sent into");
    return { chatId: r.chat_id, id: r.message?.id, service: r.service };
  }

  typing(chatId: string, state: "start" | "stop"): Promise<unknown> {
    return this.call(state === "start" ? "POST" : "DELETE", `/chats/${chatId}/typing`);
  }

  markRead(chatId: string): Promise<unknown> { return this.call("POST", `/chats/${chatId}/read`); }

  /** Relay F32: the handles still in a chat, our own line left out. Throws when Linq cannot say, so a caller fails closed. */
  async chatMembers(chatId: string): Promise<string[]> {
    const chat = await this.call("GET", `/chats/${chatId}`);
    invariant(Array.isArray(chat?.handles), "Linq returned the chat's handles");
    return chat.handles
      .filter((h: { handle?: unknown; is_me?: boolean; status?: string | null; left_at?: string | null }) => !h.is_me && (h.status ?? "active") === "active" && !h.left_at)
      .map((h: { handle: string }) => h.handle);
  }

  /** Tapback a message: a standard one by name, anything else (👀) as a custom emoji. */
  react(messageId: string, emoji: string): Promise<unknown> {
    const type = EMOJI_TAPBACK[emoji];
    return this.call("POST", `/messages/${messageId}/reactions`, type ? { operation: "add", type } : { operation: "add", type: "custom", custom_emoji: emoji });
  }

  /** Upload bytes (presigned PUT); resolves to the reusable attachment id. */
  async upload(filename: string, contentType: string, data: Uint8Array): Promise<string> {
    invariant(data.length > 0, "an uploaded file has bytes");
    const r = await this.call("POST", "/attachments", { filename, content_type: contentType, size_bytes: data.length });
    const put = await this.f(r.upload_url, { method: "PUT", headers: { ...(r.required_headers ?? {}), "Content-Type": contentType }, body: data });
    if (!put.ok) throw new Error(`Linq upload PUT ${put.status}`);
    invariant(typeof r.attachment_id === "string" && r.attachment_id.length > 0, "upload returned an attachment id");
    return r.attachment_id;
  }

  /** A native iMessage voice-memo bubble from an uploaded attachment. */
  async sendVoiceMemo(chatId: string, attachmentId: string): Promise<{ id: string }> {
    const r = await this.call("POST", `/chats/${chatId}/voicememo`, { attachment_id: attachmentId });
    return { id: r.message?.id ?? r.id };
  }
}

/** The VoiceClient voice-send.ts expects, over Linq: upload the CAF, then send it as a voice memo. */
export function linqVoiceClient(client: LinqClient) {
  return {
    attachments: {
      upload: async (input: { fileName: string; data: Uint8Array }) => ({ attachment: { guid: await client.upload(input.fileName, "audio/x-caf", input.data) } }),
    },
    messages: {
      sendAttachment: async (chat: string, attachment: string) => {
        const r = await client.sendVoiceMemo(chat, attachment);
        return { guid: r.id, dateCreated: new Date() };
      },
    },
  };
}
