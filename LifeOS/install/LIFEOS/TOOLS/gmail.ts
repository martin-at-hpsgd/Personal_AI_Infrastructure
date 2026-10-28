#!/usr/bin/env bun
/**
 * @version 1.4.0
 */
// Direct Gmail API client using an OAuth refresh token: the one path for every mailbox
// read and write in LifeOS (no third-party CLI, no quota-project header).
//
// Global flag (anywhere on the line): --account <name>
//   picks {lifeosUserDir}/CONFIG/CREDENTIALS/google/<name>.json — one file per mailbox.
//   Default: $GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (settings.json env), then LIFEOS_CONFIG.toml.
//
// Read:
//   gmail.ts profile                               # which mailbox this credential reads
//   gmail.ts count "<q>"                           # inbox-size estimate for query
//   gmail.ts ids   "<q>" [max]                     # message IDs (default max 500)
//   gmail.ts list  "<q>" [max]                     # JSONL: id, threadId, labels, from, subject, date, snippet
//   gmail.ts fetch <id>                            # minimal From/Subject/snippet JSON
//   gmail.ts fetchfull <id>                        # + plain-text body
//   gmail.ts body <id>                             # full body + attachment list (to/cc/threadId, authResults)
//   gmail.ts attach <id> [outdir]                  # list, or download every attachment
//   gmail.ts thread <threadId>                     # every message in a thread (metadata)
//   gmail.ts threads "<q>" [max]                   # thread IDs + snippets
//   gmail.ts sent-meta [max]                       # JSONL: Sent-folder id, threadId, ts, to, cc, bcc, subject
//
// Every send and drafts send from the DA's own mailbox (the SENDER_DA account in the Communication config) writes
// one `mail` row to STATVS: each recipient by People id, never an address, with the subject and Gmail ids.
//   gmail.ts labels                                # every label (id, name, type)
//   gmail.ts drafts [list|get <id>]
// Write (labels; ids are comma-separated, up to 1000 per call):
//   gmail.ts modify <ids> [--add L1,L2] [--remove L1,L2]   # label names or ids; system labels by name
//   gmail.ts archive|inbox|star|unstar|read|unread|important|unimportant|spam|unspam <ids>
//   gmail.ts trash|untrash <ids>
//   gmail.ts labels create <name> | labels delete <name|id>
//   gmail.ts drafts create --to ADDR --subject SUBJ (--body-file PATH | --body-stdin) [--html] [--cc] [--bcc] [--reply-to-id GMAIL_ID] [--no-copy]
//                 (the stored draft carries the same standing BCC as a send, unless --no-copy)
//   gmail.ts drafts delete <draftId> | drafts send <draftId>
//   gmail.ts send --to ADDR --subject SUBJ (--body-file PATH | --body-stdin) [--html] [--attach PATH ...] [--no-copy]
//                 (every send BCCs LIFEOS_EMAIL_COPY_TO, else the mailbox itself, unless --no-copy)
//                 [--cc ADDR] [--bcc ADDR] [--from ADDR] [--reply-to ADDR]
//                 [--reply-to-id GMAIL_ID]         # auto-thread to this message
//
// send command sends as the authenticated Gmail user. Gmail signs with its own DKIM,
// so no DMARC alignment issues that SES has.
//
// Credentials path is resolved in order:
//   1. $GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (settings.json env)
//   2. LifeosConfig integrations.google.credentialsFile (LIFEOS_CONFIG.toml)
//   3. {lifeosUserDir}/CONFIG/CREDENTIALS/google/credentials.json (conventional fallback)

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { lifeosUserDir } from "./LifeosConfig";
import { type GoogleCreds, loadGoogleCreds } from "./GoogleCreds";
import { formatBlocked, gatedTransmit, type GateDeps } from "./lib/SendGate.ts";
import { invariant, InvariantViolation } from "./Invariant.ts";
import type { StatvsInput } from "../STATVS/index.ts";

// `--account <name>` anywhere on the line selects a mailbox credential by name; it is
// stripped from ARGV so subcommands never see it.
const ARGV: string[] = [];
let ACCOUNT: string | null = null;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--account") { ACCOUNT = process.argv[++i] ?? null; continue; }
  ARGV.push(process.argv[i]);
}

// Resolution lives in TOOLS/GoogleCreds.ts — one resolver for every consumer.
// The resolver checks account → env → TOML → conventional,
// plus a single-candidate directory scan for contexts that supply no env, which is
// what scheduled launchd jobs are. See that file's header for the 2026-09 incident.
type Creds = GoogleCreds;
// Lazy: importing this file (tests of the send gate) must not need a credential file.
let credsCache: Creds | null = null;
const getCreds = (): Creds => (credsCache ??= loadGoogleCreds({ account: ACCOUNT }));

let cachedToken: { token: string; expires: number } | null = null;
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const body = new URLSearchParams({
    client_id: getCreds().client_id,
    client_secret: getCreds().client_secret,
    refresh_token: getCreds().refresh_token,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`token refresh failed ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return cachedToken.token;
}

type GmailApi = (path: string, init?: RequestInit) => Promise<any>;
async function gmail(path: string, init?: RequestInit): Promise<any> {
  const t = await accessToken();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    ...init,
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function listIds(q: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  while (ids.length < max) {
    const pageSize = Math.min(500, max - ids.length);
    const qp = new URLSearchParams({ q, maxResults: String(pageSize) });
    if (pageToken) qp.set("pageToken", pageToken);
    const res = await gmail(`/messages?${qp.toString()}`);
    for (const m of res.messages ?? []) ids.push(m.id);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return ids;
}

async function countQuery(q: string): Promise<number> {
  const qp = new URLSearchParams({ q, maxResults: "1" });
  const res = await gmail(`/messages?${qp.toString()}`);
  return res.resultSizeEstimate ?? 0;
}

async function archiveBatch(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await gmail(`/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: chunk, removeLabelIds: ["INBOX"] }),
    });
  }
}

async function unspamBatch(ids: string[]): Promise<void> {
  // Rescue from spam back to inbox — the gmail.modify-scope substitute for a
  // "never send to spam" filter (which needs gmail.settings.basic we don't have).
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await gmail(`/messages/batchModify`, {
      method: "POST",
      body: JSON.stringify({ ids: chunk, removeLabelIds: ["SPAM"], addLabelIds: ["INBOX"] }),
    });
  }
}

async function fetchMin(id: string): Promise<any> {
  const qp2 = new URLSearchParams({ format: "metadata" });
  qp2.append("metadataHeaders", "From");
  qp2.append("metadataHeaders", "Subject");
  qp2.append("metadataHeaders", "Date");
  qp2.append("metadataHeaders", "List-Id");
  qp2.append("metadataHeaders", "List-Unsubscribe");
  const m = await gmail(`/messages/${id}?${qp2.toString()}`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  return {
    id, from: h("From"), subject: h("Subject"), date: h("Date"),
    snippet: (m.snippet ?? "").slice(0, 120),
    list_id: h("List-Id"), list_unsubscribe: h("List-Unsubscribe"),
  };
}


// ── full message body + attachment extraction (added 2026-07-30) ──────────────
// fetchMin returns metadata only, which is right for triage but useless when the
// message IS the payload — a correspondent's genealogy dump, a scanned page.
// `body` walks the MIME tree for text; `attach` lists or downloads parts.

function walkParts(part: any, out: any[]): void {
  if (!part) return;
  out.push(part);
  for (const p of part.parts ?? []) walkParts(p, out);
}

/**
 * Every Authentication-Results header value, in header order (top first, so the receiving server's own verdict
 * leads). Reading code picks the one whose authserv-id it trusts; this only exposes them.
 */
export function authenticationResults(headers: Array<{ name?: unknown; value?: unknown }>): string[] {
  return headers.filter((x) => String(x?.name ?? "").toLowerCase() === "authentication-results").map((x) => String(x?.value ?? ""));
}

export type { GmailApi };
export async function fetchWithParts(id: string, api: GmailApi = gmail): Promise<any> {
  const m = await api(`/messages/${id}?format=full`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) =>
    headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const parts: any[] = [];
  walkParts(m.payload, parts);

  const textParts = parts.filter((p) => p.mimeType === "text/plain" && p.body?.data);
  const htmlParts = parts.filter((p) => p.mimeType === "text/html" && p.body?.data);
  let body = textParts.map((p) => decodeB64Url(p.body.data)).join("\n\n");
  if (!body && htmlParts.length) {
    body = htmlParts
      .map((p) => decodeB64Url(p.body.data))
      .join("\n\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n");
  }
  // Leaf parts that are neither a read text/html part nor a named attachment: nothing above reads them, so a proof of this
  // projection does not cover them (an inline image without a filename, a text/calendar part, a text part held by id).
  const unaccounted = parts
    .filter((p) => !(p.parts?.length))
    .filter((p) => {
      if (p.filename) return false;
      const mt = String(p.mimeType ?? "");
      if ((mt === "text/plain" || mt === "text/html") && p.body?.data) return false;
      return !!(p.body?.data || p.body?.attachmentId || (p.body?.size ?? 0) > 0);
    })
    .map((p) => String(p.mimeType ?? "unknown"));
  const attachments = parts
    .filter((p) => p.filename && p.filename.length > 0)
    .map((p) => ({
      filename: p.filename,
      mimeType: p.mimeType,
      size: p.body?.size ?? 0,
      attachmentId: p.body?.attachmentId ?? null,
    }));
  return {
    id, threadId: m.threadId,
    from: h("From"), to: h("To"), cc: h("Cc"),
    subject: h("Subject"), date: h("Date"),
    replyTo: h("Reply-To"), inReplyTo: h("In-Reply-To"), references: h("References"), bcc: h("Bcc"),
    // The raw parts as stored (a draft goes out as stored), apart from the text-or-stripped-html `body`.
    textRaw: textParts.map((p) => decodeB64Url(p.body.data)).join("\n\n"),
    htmlRaw: htmlParts.map((p) => decodeB64Url(p.body.data)).join("\n\n"),
    body: body.trim(), attachments, unaccounted,
    // Added 2026-10-11 for the Recover inbox leg: the sender-trust check reads the receiving server's verdict.
    authResults: authenticationResults(headers),
  };
}

async function saveAttachment(msgId: string, attId: string, dest: string): Promise<number> {
  const a = await gmail(`/messages/${msgId}/attachments/${attId}`);
  const buf = Buffer.from(String(a.data).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  await Bun.write(dest, buf);
  return buf.length;
}

function decodeB64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}
function extractText(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64Url(payload.body.data);
  for (const p of payload.parts ?? []) {
    const t = extractText(p);
    if (t) return t;
  }
  // fall back to html if no plain part
  if (payload.mimeType === "text/html" && payload.body?.data)
    return decodeB64Url(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}
async function fetchFull(id: string): Promise<any> {
  const m = await gmail(`/messages/${id}?format=full`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  return { id, from: h("From"), subject: h("Subject"), date: h("Date"), body: extractText(m.payload).trim() };
}

type SendOpts = {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
  cc?: string;
  bcc?: string;
  from?: string;
  replyTo?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  /** Absolute paths of files to attach (multipart/mixed). Added 2026-09-07. */
  attachments?: string[];
  /** Skip the standing principal copy (OPERATIONAL_PREFERENCES § Outbound messages: every send copies the principal). */
  noCopy?: boolean;
};

function b64url(buf: Uint8Array | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf8") : Buffer.from(buf);
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 5322 headers are ASCII-only; non-ASCII (emoji, em-dashes) must be RFC 2047
// encoded-words or clients render mojibake (the 2026-07-17 Bunker canary subject).
function encodeHeaderValue(v: string): string {
  return /^[\x20-\x7E]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/**
 * An attachment filename that may enter a MIME header. A line break would insert another header and any other control
 * character is never part of a real filename: both are refused, nothing sent.
 */
export function assertSafeAttachmentName(name: string): string {
  if (/[\r\n]/.test(name)) throw new Error("attachment filename contains a line break; nothing sent");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("attachment filename contains a control character; nothing sent");
  if (!name.trim()) throw new Error("attachment filename is empty; nothing sent");
  return name;
}

/**
 * One MIME parameter for a filename (RFC 2231 / RFC 6266): a plain quoted value when the name is simple ASCII, otherwise an
 * ASCII fallback plus the percent-encoded UTF-8 `name*=UTF-8''...` form, so quotes, backslashes, semicolons and non-ASCII
 * never reach the header unescaped.
 */
export function mimeFilenameParam(param: "name" | "filename", rawName: string): string {
  const name = assertSafeAttachmentName(rawName);
  if (/^[A-Za-z0-9._ -]+$/.test(name)) return `${param}="${name}"`;
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  const enc = Array.from(Buffer.from(name, "utf8"), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
  return `${param}="${fallback}"; ${param}*=UTF-8''${enc}`;
}

function buildRfc822(opts: SendOpts, names: string[] = []): string {
  const headers: string[] = [];
  headers.push(`MIME-Version: 1.0`);
  if (opts.from) headers.push(`From: ${opts.from}`);
  headers.push(`To: ${opts.to}`);
  if (opts.cc) headers.push(`Cc: ${opts.cc}`);
  if (opts.bcc) headers.push(`Bcc: ${opts.bcc}`);
  if (opts.replyTo) headers.push(`Reply-To: ${opts.replyTo}`);
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  headers.push(`Subject: ${encodeHeaderValue(opts.subject)}`);
  const ctype = opts.html ? `text/html; charset="UTF-8"` : `text/plain; charset="UTF-8"`;
  const files = opts.attachments ?? [];
  if (files.length === 0) {
    headers.push(`Content-Type: ${ctype}`);
    headers.push(`Content-Transfer-Encoding: 8bit`);
    return `${headers.join("\r\n")}\r\n\r\n${opts.body}`;
  }
  // multipart/mixed: text part first, then each attachment base64 in 76-col lines (RFC 2045)
  const boundary = `----=_lifeos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  parts.push(`--${boundary}\r\nContent-Type: ${ctype}\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${opts.body}\r\n`);
  for (const [i, f] of files.entries()) {
    if (!existsSync(f)) throw new Error(`attachment not found: ${f}`);
    const name = assertSafeAttachmentName(names[i] ?? basename(f));
    const mime = name.toLowerCase().endsWith(".pdf") ? "application/pdf" : name.toLowerCase().endsWith(".png") ? "image/png" : /\.(jpe?g)$/i.test(name) ? "image/jpeg" : "application/octet-stream";
    const b64 = readFileSync(f).toString("base64").replace(/(.{76})/g, "$1\r\n");
    parts.push(`--${boundary}\r\nContent-Type: ${mime}; ${mimeFilenameParam("name", name)}\r\nContent-Disposition: attachment; ${mimeFilenameParam("filename", name)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`);
  }
  parts.push(`--${boundary}--\r\n`);
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("")}`;
}

async function resolveThreadFromReplyId(gmailId: string): Promise<{ threadId: string; inReplyTo: string; references: string; subject: string }> {
  const qp = new URLSearchParams({ format: "metadata" });
  qp.append("metadataHeaders", "Message-ID");
  qp.append("metadataHeaders", "References");
  qp.append("metadataHeaders", "Subject");
  const m = await gmail(`/messages/${gmailId}?${qp.toString()}`);
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const msgId = h("Message-ID") || h("Message-Id");
  const priorRefs = h("References");
  const subj = h("Subject");
  if (!msgId) throw new Error(`could not find Message-ID header on ${gmailId}`);
  const refs = priorRefs ? `${priorRefs} ${msgId}` : msgId;
  return { threadId: m.threadId, inReplyTo: msgId, references: refs, subject: subj };
}

/**
 * Standing principal copy (2026-09-07: "You are always supposed to copy me when you send anything").
 * Every send BCCs the copy address — LIFEOS_EMAIL_COPY_TO if set, else the authenticated mailbox —
 * unless --no-copy is passed or that address is already a recipient.
 */
const principalCopyAddress = (): string => (process.env.LIFEOS_EMAIL_COPY_TO || process.env.GMAIL_USER || "").trim();

const ADDR_SPEC = /^(?:[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+|"(?:[^"\\\r\n]|\\.)*")@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/**
 * Parse an RFC 5322 address-list header value into its bare lower-case envelope addresses, or null when the value is
 * malformed or ambiguous. Quoted display names, comments, angle addresses and groups are understood the way a mail
 * server reads them, so `"me@own.test" <them@ext.test>` yields them@ext.test (the address the message actually goes
 * to), never the text inside the display name. Anything the parser cannot read with certainty — an unbalanced quote,
 * comment or bracket, two angle addresses in one mailbox, text after the angle address, an addr-spec that is not one —
 * is null, and every caller treats null as the restrictive answer.
 */
export function parseAddressList(v: string | undefined): string[] | null {
  if (v === undefined || v.trim() === "") return [];
  if (/[\r\n]/.test(v)) return null;
  // Pass 1: strip comments (nested parentheses outside quotes) and split at top-level commas, tracking group syntax.
  const segments: string[] = [];
  let cur = "", inQuote = false, depth = 0, inAngle = false, inGroup = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (inQuote) {
      cur += c;
      if (c === "\\") { if (i + 1 >= v.length) return null; cur += v[++i]; continue; }
      if (c === '"') inQuote = false;
      continue;
    }
    if (depth > 0) {
      if (c === "\\") { i++; continue; }
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === "(") { depth = 1; cur += " "; continue; }
    if (c === ")") return null;
    if (c === '"') { inQuote = true; cur += c; continue; }
    if (c === "<") { if (inAngle) return null; inAngle = true; cur += c; continue; }
    if (c === ">") { if (!inAngle) return null; inAngle = false; cur += c; continue; }
    if (inAngle) { cur += c; continue; }
    if (c === ":") { if (inGroup) return null; inGroup = true; cur = ""; continue; }  // "Group name:" — the name is not an address
    if (c === ";") { if (!inGroup) return null; inGroup = false; segments.push(cur); cur = ""; continue; }
    if (c === ",") { segments.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (inQuote || depth > 0 || inAngle || inGroup) return null;
  segments.push(cur);
  // Pass 2: each non-empty segment is exactly one mailbox: `display <addr>` or a bare addr-spec.
  const out: string[] = [];
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) continue;
    // Find angle brackets outside quoted strings.
    const opens: number[] = [];
    let q = false;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i]!;
      if (q) { if (c === "\\") i++; else if (c === '"') q = false; continue; }
      if (c === '"') q = true; else if (c === "<") opens.push(i);
    }
    let addr: string;
    if (opens.length > 1) return null;
    if (opens.length === 1) {
      const close = seg.indexOf(">", opens[0]!);
      if (close < 0 || seg.slice(close + 1).trim() !== "") return null;
      addr = seg.slice(opens[0]! + 1, close).trim();
      // Obsolete source routes ("<@relay:a@b>") are refused rather than guessed at.
      if (addr.startsWith("@")) return null;
    } else {
      addr = seg;
    }
    if (!ADDR_SPEC.test(addr)) return null;
    out.push(addr.toLowerCase());
  }
  return out;
}

/** Bare lower-case addresses in a To/Cc/Bcc header value; throws when the value is malformed or ambiguous. */
function headerAddresses(v: string | undefined, field = "recipient"): string[] {
  const parsed = parseAddressList(v);
  if (parsed === null) throw new Error(`${field} header is malformed or ambiguous; nothing sent`);
  return parsed;
}

/**
 * True when every To/Cc/Bcc recipient is the principal's own address: the same address the standing copy resolves
 * (LIFEOS_EMAIL_COPY_TO, else the authenticated mailbox GMAIL_USER). Judged on the caller's recipients BEFORE the
 * automatic BCC copy is added, so that copy never makes a send "to the principal" by itself. No resolved address or no
 * recipient means not to the principal, and so does any list the parser cannot read with certainty: the restrictive
 * outward destination is the answer whenever there is doubt.
 */
export function allRecipientsArePrincipal(opts: Pick<SendOpts, "to" | "cc" | "bcc">, own: string[] = [principalCopyAddress()]): boolean {
  const ownLists = own.map((a) => parseAddressList(a));
  const lists = [parseAddressList(opts.to), parseAddressList(opts.cc), parseAddressList(opts.bcc)];
  if (ownLists.some((l) => l === null) || lists.some((l) => l === null)) return false;
  const ownSet = new Set(ownLists.flat() as string[]);
  const recipients = lists.flat() as string[];
  return ownSet.size > 0 && recipients.length > 0 && recipients.every((r) => ownSet.has(r));
}

export function withPrincipalCopy(opts: SendOpts, copyTo: string = principalCopyAddress()): SendOpts {
  if (opts.noCopy) return opts;
  // No copy address means the standing BCC cannot be added. Fail the send rather than go out
  // uncopied; --no-copy is the one named way to skip it.
  if (!copyTo) throw new Error("no copy address: set LIFEOS_EMAIL_COPY_TO or GMAIL_USER so the standing BCC can be added, or pass --no-copy; nothing sent");
  // Whole-address comparison: a recipient that merely contains the copy address as a substring does not count.
  const copyAddr = headerAddresses(copyTo)[0] ?? copyTo.trim().toLowerCase();
  const already = [opts.to, opts.cc, opts.bcc].flatMap((h) => headerAddresses(h)).includes(copyAddr);
  if (already) return opts;
  return { ...opts, bcc: opts.bcc ? `${opts.bcc}, ${copyTo}` : copyTo };
}

/**
 * The text the send gate proofs and hashes: every header that reaches the wire (From, To, Cc, Bcc, Reply-To,
 * In-Reply-To, References, the content type, the subject) and the body, so a changed header needs a new proof.
 * Attachments are hashed separately by the gate. The message is BUILT from this text (see buildFromCanonical), so
 * what is proofed is what is sent. A header value with a line break is refused: it would smuggle another header.
 */
export function canonicalSendText(opts: SendOpts): string {
  const hv = (k: string, v: string | undefined, always = false): string => {
    if (v && /[\r\n]/.test(v)) throw new Error(`header ${k} contains a line break; nothing sent`);
    return v || always ? `${k}: ${v ?? ""}` : "";
  };
  const head = [
    hv("From", opts.from), hv("To", opts.to, true), hv("Cc", opts.cc), hv("Bcc", opts.bcc), hv("Reply-To", opts.replyTo),
    hv("In-Reply-To", opts.inReplyTo), hv("References", opts.references), opts.html ? "Content-Type: text/html" : "", hv("Subject", opts.subject, true),
    // Attachment filenames reach the wire in MIME headers, so they are part of the proofed text, one JSON-quoted line each.
    ...(opts.attachments ?? []).map((f) => `Attachment-Name: ${JSON.stringify(assertSafeAttachmentName(basename(f)))}`),
  ].filter(Boolean).join("\n");
  return `${head}\n\n${opts.body}`;
}

/** The inverse of canonicalSendText: the RFC 822 message for exactly the proofed text and the proofed attachment copies. */
export function buildFromCanonical(text: string, attachmentFiles: string[], names: string[]): string {
  const cut = text.indexOf("\n\n");
  if (cut < 0) throw new Error("proofed text has no header block; nothing sent");
  const o: SendOpts = { to: "", subject: "", body: text.slice(cut + 2) };
  const proofedNames: string[] = [];
  for (const line of text.slice(0, cut).split("\n")) {
    const m = line.match(/^([A-Za-z-]+): ?(.*)$/);
    if (!m) throw new Error("proofed text has a malformed header; nothing sent");
    const v = m[2]!;
    switch (m[1]) {
      case "From": o.from = v; break;
      case "To": o.to = v; break;
      case "Cc": o.cc = v; break;
      case "Bcc": o.bcc = v; break;
      case "Reply-To": o.replyTo = v; break;
      case "In-Reply-To": o.inReplyTo = v; break;
      case "References": o.references = v; break;
      case "Subject": o.subject = v; break;
      case "Attachment-Name": {
        let n: unknown;
        try { n = JSON.parse(v); } catch { throw new Error("proofed text has a malformed attachment name; nothing sent"); }
        if (typeof n !== "string") throw new Error("proofed text has a malformed attachment name; nothing sent");
        proofedNames.push(assertSafeAttachmentName(n));
        break;
      }
      case "Content-Type": if (v !== "text/html") throw new Error("proofed text has an unknown content type; nothing sent"); o.html = true; break;
      default: throw new Error(`proofed text has an unknown header ${m[1]}; nothing sent`);
    }
  }
  if (attachmentFiles.length) o.attachments = attachmentFiles;
  // The proofed names win: a name that was not in the proofed text cannot reach a header.
  if (proofedNames.length && proofedNames.length !== attachmentFiles.length) throw new Error("proofed attachment names do not match the attachments; nothing sent");
  return buildRfc822(o, proofedNames.length ? proofedNames : names);
}

const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export type SendDeps = {
  gate?: GateDeps; transmit?: (payload: any) => Promise<any>; principalAddresses?: string[];
  /** Test seam: runs inside the transmit closure before the message is built (a tamper after the gate). */
  beforeBuild?: () => void;
  /** The credential name this send goes out on; defaults to `--account`. Only the DA's own mailbox is recorded. */
  mailbox?: string | null;
  /** Test seam: where the mail row goes (STATVS `append` by default). */
  record?: (row: StatvsInput) => { ok: boolean; refused?: string };
};

// ── the DA's sent mail on the record (conversation-memory ISA ISC-1, ISC-11) ────────────────────────────────────────

// release-allow: private-skill-names (a USER-data config path read only when the file exists; absent on an install without the communication skill, so daMailAccount returns null)
/** The credential name of the DA's own mailbox: LIFEOS_DA_MAIL_ACCOUNT, else the `--account <name>` in the
 *  `SENDER_DA` row of the Communication config, else null (no DA mailbox, so nothing is recorded). */
export function daMailAccount(configPath = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "_COMMUNICATION", "Config.md")): string | null {
  const env = process.env.LIFEOS_DA_MAIL_ACCOUNT?.trim();
  if (env) return env;
  let text = "";
  try { text = readFileSync(configPath, "utf8"); } catch { return null; }
  const row = text.split("\n").find((l) => /^\|\s*`?SENDER_DA`?\s*\|/.test(l));
  return row?.match(/--account\s+`?([A-Za-z0-9._-]+)/)?.[1] ?? null;
}

export type MailRecipient = { field: "to" | "cc" | "bcc"; person: string };
export type SentMail = { to?: string; cc?: string; bcc?: string; subject?: string; messageId?: string; threadId?: string; ts?: string };

/** Each recipient of a sent mail by recordable People id, To then Cc then Bcc, one entry per field and person. An
 *  address no People record carries is written as the hash of the id People would mint for it, never as itself. */
export function mailRecipients(m: Pick<SentMail, "to" | "cc" | "bcc">, personOf: (addr: string) => string): MailRecipient[] {
  const out: MailRecipient[] = [];
  const seen = new Set<string>();
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const addr of parseAddressList(m[field]) ?? []) {
      const person = personOf(addr);
      if (seen.has(`${field}:${person}`)) continue;
      seen.add(`${field}:${person}`);
      out.push({ field, person });
    }
  }
  return out;
}

/** The `mail` row for one email the DA's mailbox sent: recipients by person, the subject with any address or number
 *  replaced, and the Gmail ids. `backfill` marks a row written later from the Sent folder. */
export function mailRow(m: SentMail, recipients: MailRecipient[], scrub: (s: string) => string): StatvsInput {
  const data: Record<string, unknown> = {
    event: "email_out", mailbox: "da", recipients,
    subject: scrub(m.subject ?? ""),
    ...(m.messageId ? { message_id: m.messageId } : {}),
    ...(m.threadId ? { thread_id: m.threadId } : {}),
  };
  return { writer: "tool:gmail", stream: "mail", class: "personal", ...(m.ts ? { ts: m.ts } : {}), data };
}

/** No raw address survives into a mail row: the last check before the append. */
const MAIL_ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u;

/** Write one sent mail to the record when it went out on the DA's mailbox. Never throws: the mail is already sent,
 *  and a record that cannot be written is reported on stderr, never as a failed send. */
export async function recordSentMail(m: SentMail, deps: Pick<SendDeps, "mailbox" | "record"> = {}): Promise<boolean> {
  try {
    const mailbox = deps.mailbox === undefined ? ACCOUNT : deps.mailbox;
    const da = daMailAccount();
    if (!mailbox || !da || mailbox.replace(/\.json$/, "") !== da.replace(/\.json$/, "")) return false;
    const { recordableForHandle, scrubContact } = await import("../PEOPLE/Identity.ts");
    const row = mailRow(m, mailRecipients(m, (a) => recordableForHandle(a)), (s) => scrubContact(s, "[redacted]"));
    invariant(row.stream === "mail" && Array.isArray((row.data as { recipients?: unknown }).recipients), "a mail row names its recipients");
    invariant(!MAIL_ADDRESS.test(JSON.stringify(row.data)), "a mail row never carries a raw address");
    const append = deps.record ?? (await import("../STATVS/index.ts")).append;
    const r: { ok: boolean; refused?: string } = append(row);
    if (!r.ok && r.refused) console.error(`mail sent, record refused: ${r.refused.slice(0, 120)}`);
    return r.ok;
  } catch (e) {
    // An invariant stops the write and is said here; it is not rethrown, because the mail has already left and a
    // failed exit would invite a second send.
    console.error(`mail sent, not recorded${e instanceof InvariantViolation ? " (invariant)" : ""}: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
    return false;
  }
}

/** A run that reads strangers' mail sets LIFEOS_NO_OUTBOUND=1 (the mail-monitor workflow); no send leaves it, whatever its permission rules allow. */
function refuseWhenNoOutbound(): void {
  if (process.env.LIFEOS_NO_OUTBOUND === "1") throw new Error("refused: this run has no outbound (LIFEOS_NO_OUTBOUND=1); nothing sent");
}

async function sendMessage(opts: SendOpts & { dryRun?: boolean }, deps: SendDeps = {}): Promise<any> {
  refuseWhenNoOutbound();
  // A recipient list the parser cannot read with certainty is refused outright, --no-copy included.
  headerAddresses(opts.to, "To"); headerAddresses(opts.cc, "Cc"); headerAddresses(opts.bcc, "Bcc");
  const toPrincipal = allRecipientsArePrincipal(opts, deps.principalAddresses);
  opts = withPrincipalCopy(opts);
  const attachPaths = (opts.attachments ?? []).map((f) => resolve(f));
  const names = attachPaths.map((f) => basename(f));
  const canonical = canonicalSendText(opts);
  if (opts.dryRun) return { dryRun: true, rfc822_preview: buildFromCanonical(canonical, attachPaths, names).slice(0, 500) };
  const transmit = deps.transmit ?? ((p: any) => gmail(`/messages/send`, { method: "POST", body: JSON.stringify(p) }));
  // ISC-11: the proof of the exact bytes lives here, immediately before the network call, so it holds for every caller.
  // The message is built INSIDE the closure from the proofed copies, never from the caller's files or fields.
  const sent = await gatedTransmit(
    { channel: "gmail", destination: "send", body: canonical, recipientClass: "email", attachments: attachPaths, toPrincipal },
    async (g) => {
      deps.beforeBuild?.();
      const bodyItem = g.items.find((i) => i.role === "body");
      if (!bodyItem) throw new Error("gate returned no body item; nothing sent");
      const bodyBytes = readFileSync(bodyItem.file);
      if (sha256Hex(bodyBytes) !== bodyItem.sha256) throw new Error("proofed body copy changed; nothing sent");
      const atts = g.items.filter((i) => i.role === "attachment");
      for (const a of atts) if (sha256Hex(readFileSync(a.file)) !== a.sha256) throw new Error("proofed attachment copy changed; nothing sent");
      const payload: any = { raw: b64url(buildFromCanonical(bodyBytes.toString("utf8"), atts.map((a) => a.file), names)) };
      if (opts.threadId) payload.threadId = opts.threadId;
      return transmit(payload);
    },
    deps.gate,
  );
  if (!sent.ok) throw new Error(formatBlocked(sent, "gmail"));
  for (const fl of sent.gate.flags) console.error(`unearned flag, not blocking: ${fl.check}: ${String(fl.message).replace(/\s+/g, " ").slice(0, 160)}`);
  // The recipients as sent, the standing copy included.
  await recordSentMail({ to: opts.to, cc: opts.cc, bcc: opts.bcc, subject: opts.subject, messageId: sent.result?.id, threadId: sent.result?.threadId }, deps);
  return sent.result;
}

type DraftParts = {
  headers: { from: string; to: string; cc: string; bcc: string; replyTo: string; inReplyTo: string; references: string; subject: string };
  text: string; html: string; atts: { name: string; bytes: Buffer }[]; messageId?: string; threadId?: string; raw?: Buffer;
  /** Every header and MIME-metadata value in the raw snapshot that is transmitted, one proof line each (see rawSnapshotMetadata). */
  wire?: string[];
  /** The envelope recipients Gmail derives from the raw snapshot's own To/Cc/Bcc headers, every occurrence. */
  envelope?: string[];
};

type RawHeader = { name: string; value: string; decoded: string };

/** RFC 2047 encoded words decoded so the proof reads what a mail client shows; an unknown charset is refused, never skipped. */
function decodeEncodedWords(v: string): string {
  return v.replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
    const charset = cs.split("*")[0]!.toLowerCase();
    const label = charset === "us-ascii" ? "utf-8" : charset;
    if (!["utf-8", "utf8", "iso-8859-1", "latin1", "windows-1252"].includes(label)) throw new Error(`draft header uses charset ${charset}, which the proof cannot read; nothing sent`);
    const bytes = enc.toUpperCase() === "B"
      ? Buffer.from(data, "base64")
      : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return new TextDecoder(label).decode(bytes);
  });
}

function splitHeadBody(s: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(s);
  if (s.startsWith("\r\n") || s.startsWith("\n")) return { head: "", body: s.replace(/^\r?\n/, "") };
  return m ? { head: s.slice(0, m.index), body: s.slice(m.index + m[0].length) } : { head: s, body: "" };
}

function parseHeaderBlock(head: string, where: string): RawHeader[] {
  const out: RawHeader[] = [];
  if (!head) return out;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (!out.length) throw new Error(`draft ${where} starts with a continuation line; nothing sent`);
      const last = out[out.length - 1]!;
      last.value += ` ${line.trim()}`;
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) throw new Error(`draft ${where} has a line that is not a header; nothing sent`);
    out.push({ name: m[1]!, value: m[2]!.trim(), decoded: "" });
  }
  for (const h of out) h.decoded = decodeEncodedWords(h.value);
  return out;
}

const RESENT_OR_ENVELOPE = /^(resent-(to|cc|bcc|from|sender)|apparently-to|x-envelope-to|envelope-to)$/i;

/**
 * Every header and MIME-metadata value the raw snapshot transmits, read from the snapshot's own bytes: the message
 * headers, each MIME part's headers at every depth, and any multipart preamble or epilogue text. Header values are
 * proofed after RFC 2047 decoding. Structures the proof cannot read with certainty (a non-header line in a header
 * block, a multipart with no boundary or no closing delimiter, an unknown charset, a Resent-* or envelope header that
 * would route the message somewhere the To/Cc/Bcc check does not see) are refused.
 */
export function rawSnapshotMetadata(raw: Buffer): { wire: string[]; envelope: string[] } {
  const wire: string[] = [];
  const top = splitHeadBody(raw.toString("utf8"));
  const topHeaders = parseHeaderBlock(top.head, "message header block");
  if (!topHeaders.length) throw new Error("draft snapshot has no header block; nothing sent");
  const envelope: string[] = [];
  for (const h of topHeaders) {
    if (RESENT_OR_ENVELOPE.test(h.name)) throw new Error(`draft carries a ${h.name} header the send gate does not route; nothing sent`);
    if (/^(to|cc|bcc)$/i.test(h.name)) {
      const list = parseAddressList(h.value);
      if (list === null) throw new Error(`draft ${h.name} header is malformed or ambiguous; nothing sent`);
      envelope.push(...list);
    }
  }
  const walk = (headers: RawHeader[], body: string, path: string, depth: number): void => {
    if (depth > 8) throw new Error("draft MIME structure nests too deep; nothing sent");
    for (const h of headers) wire.push(`${path} ${h.name}: ${h.decoded.replace(/[\r\n]+/g, " ")}`);
    const ct = headers.filter((h) => h.name.toLowerCase() === "content-type");
    if (ct.length > 1) throw new Error(`draft ${path} has more than one Content-Type; nothing sent`);
    if (!ct.length || !/^\s*multipart\//i.test(ct[0]!.value)) return;
    const bm = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(ct[0]!.value);
    const boundary = bm?.[1] ?? bm?.[2];
    if (!boundary) throw new Error(`draft ${path} is multipart with no boundary; nothing sent`);
    const lines = body.split(/\r?\n/);
    const delim = `--${boundary}`;
    const parts: string[][] = [];
    const preamble: string[] = [];
    let curPart: string[] | null = null;
    let closed = false;
    const epilogue: string[] = [];
    for (const line of lines) {
      if (closed) { epilogue.push(line); continue; }
      const t = line.replace(/[ \t]+$/, "");
      if (t === `${delim}--`) { if (curPart) parts.push(curPart); curPart = null; closed = true; continue; }
      if (t === delim) { if (curPart) parts.push(curPart); curPart = []; continue; }
      (curPart ?? preamble).push(line);
    }
    if (!closed) throw new Error(`draft ${path} has no closing MIME boundary; nothing sent`);
    if (preamble.join("").trim()) wire.push(`${path} MIME-Preamble: ${preamble.join(" ").trim()}`);
    if (epilogue.join("").trim()) wire.push(`${path} MIME-Epilogue: ${epilogue.join(" ").trim()}`);
    parts.forEach((p, i) => {
      const sub = splitHeadBody(p.join("\r\n"));
      walk(parseHeaderBlock(sub.head, `${path}.${i + 1} header block`), sub.body, `${path}.${i + 1}`, depth + 1);
    });
  };
  walk(topHeaders, top.body, "Wire[0]", 0);
  return { wire, envelope };
}

/** Read a stored draft whole: headers, the text and HTML parts, and every attachment's bytes. Any attachment that cannot be fetched throws. */
async function readDraftParts(draftId: string, api: GmailApi): Promise<DraftParts> {
  const draft = await api(`/drafts/${draftId}?format=full`);
  const full = await fetchWithParts(draft.message.id, api);
  if (full.unaccounted?.length) throw new Error(`draft has MIME part(s) the proof does not cover (${[...new Set(full.unaccounted)].join(", ")}); nothing sent`);
  // The message id is the draft's version: every edit makes a new message, and a stored message never changes. The raw
  // bytes of THIS message are what gets sent, so what is proofed and what goes out cannot diverge.
  const rawMsg = await api(`/messages/${draft.message.id}?format=raw`);
  if (typeof rawMsg?.raw !== "string" || !rawMsg.raw) throw new Error("draft message came back without its raw bytes; nothing sent");
  const raw = Buffer.from(rawMsg.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  // What is transmitted is the raw snapshot, so its own header and MIME metadata is what the proof reads and what the
  // recipient check judges, never only the parsed projection.
  const { wire, envelope } = rawSnapshotMetadata(raw);
  const bccHeader = (draft.message?.payload?.headers ?? []).find((x: any) => String(x.name).toLowerCase() === "bcc")?.value ?? full.bcc ?? "";
  const atts: DraftParts["atts"] = [];
  for (const a of full.attachments ?? []) {
    if (!a.attachmentId) throw new Error(`draft attachment "${a.filename}" has no attachment id and cannot be fetched; nothing sent`);
    let data: any;
    try { data = await api(`/messages/${draft.message.id}/attachments/${a.attachmentId}`); }
    catch (e) { throw new Error(`draft attachment "${a.filename}" could not be fetched (${e instanceof Error ? e.message.slice(0, 120) : "error"}); nothing sent`); }
    if (typeof data?.data !== "string") throw new Error(`draft attachment "${a.filename}" came back without data; nothing sent`);
    const bytes = Buffer.from(data.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (a.size > 0 && bytes.length !== a.size) throw new Error(`draft attachment "${a.filename}" fetched ${bytes.length} bytes, expected ${a.size}; nothing sent`);
    atts.push({ name: a.filename, bytes });
  }
  return { headers: { from: full.from ?? "", to: full.to ?? "", cc: full.cc ?? "", bcc: bccHeader, replyTo: full.replyTo ?? "", inReplyTo: full.inReplyTo ?? "", references: full.references ?? "", subject: full.subject ?? "" }, text: full.textRaw ?? "", html: full.htmlRaw ?? "", atts, messageId: draft.message.id, threadId: draft.message.threadId ?? full.threadId, raw, wire, envelope };
}

/** The text the gate proofs for a stored draft: every header, the text part, the HTML part, and the attachment names. */
export function canonicalDraftText(p: DraftParts): string {
  const h = p.headers;
  const hv = (k: string, v: string): string => (v ? `${k}: ${v.replace(/[\r\n]+/g, " ")}` : "");
  const head = [hv("From", h.from), `To: ${h.to}`, hv("Cc", h.cc), hv("Bcc", h.bcc), hv("Reply-To", h.replyTo), hv("In-Reply-To", h.inReplyTo), hv("References", h.references), `Subject: ${h.subject}`].filter(Boolean).join("\n");
  const snapshot = p.raw ? `\n\nMessage-Snapshot: ${p.messageId ?? ""} sha256=${sha256Hex(p.raw)}` : "";
  const wire = p.wire?.length ? `\n\n--- transmitted headers and MIME metadata ---\n${p.wire.join("\n")}` : "";
  return `${head}\n\n${p.text}${p.html ? `\n\n--- text/html part ---\n${p.html}` : ""}\n\nAttachments: ${p.atts.map((a) => a.name.replace(/[\r\n]+/g, " ")).join(", ")}${wire}${snapshot}`;
}

/**
 * A draft is a hand-off only when every envelope recipient of the snapshot that is actually transmitted is the
 * principal's own address. Without a parsed snapshot there is no envelope to judge, so it is never a hand-off.
 */
export function draftToPrincipal(p: Pick<DraftParts, "envelope">, own: string[] = [principalCopyAddress()]): boolean {
  if (!p.envelope?.length) return false;
  const ownLists = own.map((a) => parseAddressList(a));
  if (ownLists.some((l) => l === null)) return false;
  const ownSet = new Set(ownLists.flat() as string[]);
  return ownSet.size > 0 && p.envelope.every((r) => ownSet.has(r));
}

/**
 * Send a stored draft. The gate proofs everything the draft holds (headers, text, HTML, each attachment's bytes); a
 * draft whose attachment cannot be fetched is refused. Gmail's drafts.send transmits what is stored, so the closure
 * re-reads the draft and refuses if any of it differs from what was proofed.
 */
export async function sendDraft(draftId: string, deps: { gate?: GateDeps; api?: GmailApi } & Pick<SendDeps, "mailbox" | "record"> = {}): Promise<any> {
  refuseWhenNoOutbound();
  const api = deps.api ?? gmail;
  const parts = await readDraftParts(draftId, api);
  const dir = mkdtempSync(join(tmpdir(), "gmail-draft-"));
  chmodSync(dir, 0o700);
  try {
    const files = parts.atts.map((a, i) => { const f = join(dir, `${i}-${a.name.replace(/[^A-Za-z0-9._-]/g, "_")}`); writeFileSync(f, a.bytes, { mode: 0o600 }); return f; });
    const text = canonicalDraftText(parts);
    const sent = await gatedTransmit(
      { channel: "gmail", destination: "send", body: text, recipientClass: "email", attachments: files, toPrincipal: draftToPrincipal(parts) },
      async (g) => {
        const again = await readDraftParts(draftId, api);
        const attItems = g.items.filter((i) => i.role === "attachment");
        if (canonicalDraftText(again) !== text || again.atts.length !== attItems.length || again.atts.some((a, i) => sha256Hex(a.bytes) !== attItems[i]!.sha256)) {
          throw new Error("the draft changed after it was proofed; nothing sent");
        }
        // Send the proofed snapshot itself, never the mutable draft by id: a stored message is immutable, so an edit made
        // after this point cannot ride along. The draft is removed afterwards so it is not sent twice.
        const payload: any = { raw: b64url(parts.raw!) };
        if (parts.threadId) payload.threadId = parts.threadId;
        const res = await api(`/messages/send`, { method: "POST", body: JSON.stringify(payload) });
        try { await api(`/drafts/${draftId}`, { method: "DELETE" }); } catch (e) { console.error(`sent, but draft ${draftId} could not be deleted: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`); }
        return res;
      },
      deps.gate,
    );
    if (!sent.ok) throw new Error(formatBlocked(sent, "gmail"));
    const h = parts.headers;
    await recordSentMail({ to: h.to, cc: h.cc, bcc: h.bcc, subject: h.subject, messageId: sent.result?.id, threadId: sent.result?.threadId }, deps);
    return sent.result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export { sendMessage };

function parseSendArgs(argv: string[]): SendOpts & { bodyFile?: string; bodyStdin?: boolean; replyToId?: string; dryRun?: boolean } {
  const out: any = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const nxt = () => argv[++i];
    switch (a) {
      case "--to": out.to = nxt(); break;
      case "--subject": out.subject = nxt(); break;
      case "--body-file": out.bodyFile = nxt(); break;
      case "--body-stdin": out.bodyStdin = true; break;
      case "--html": out.html = true; break;
      case "--cc": out.cc = nxt(); break;
      case "--bcc": out.bcc = nxt(); break;
      case "--from": out.from = nxt(); break;
      case "--reply-to": out.replyTo = nxt(); break;
      case "--reply-to-id": out.replyToId = nxt(); break;
      case "--in-reply-to": out.inReplyTo = nxt(); break;
      case "--references": out.references = nxt(); break;
      case "--thread-id": out.threadId = nxt(); break;
      case "--dry-run": out.dryRun = true; break;
      case "--attach": (out.attachments ??= []).push(nxt()); break;
      case "--no-copy": out.noCopy = true; break;
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ── label + thread + draft operations (added 2026-09-02, gws retirement) ──────
const SYSTEM_LABELS = new Set(["INBOX", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"]);
let labelCache: { id: string; name: string; type: string }[] | null = null;
async function allLabels() {
  if (!labelCache) labelCache = ((await gmail(`/labels`)).labels ?? []).map((l: any) => ({ id: l.id, name: l.name, type: l.type }));
  return labelCache!;
}
// Accepts a system label, a user label's name, or a raw label id.
async function labelIds(spec: string): Promise<string[]> {
  const out: string[] = [];
  for (const raw of spec.split(",").map(s => s.trim()).filter(Boolean)) {
    if (SYSTEM_LABELS.has(raw.toUpperCase())) { out.push(raw.toUpperCase()); continue; }
    const ls = await allLabels();
    const hit = ls.find(l => l.id === raw) ?? ls.find(l => l.name.toLowerCase() === raw.toLowerCase());
    if (!hit) throw new Error(`unknown label "${raw}" — see: gmail.ts labels`);
    out.push(hit.id);
  }
  return out;
}
async function modifyBatch(ids: string[], add: string[], remove: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 1000) {
    const body: any = { ids: ids.slice(i, i + 1000) };
    if (add.length) body.addLabelIds = add;
    if (remove.length) body.removeLabelIds = remove;
    await gmail(`/messages/batchModify`, { method: "POST", body: JSON.stringify(body) });
  }
}
const splitIds = (s: string | undefined) => { const ids = (s ?? "").split(",").map(x => x.trim()).filter(Boolean); if (!ids.length) throw new Error("no ids"); return ids; };
const flag = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
// Label shortcuts: verb → [add, remove]
const SHORTCUTS: Record<string, [string[], string[]]> = {
  archive: [[], ["INBOX"]], inbox: [["INBOX"], []],
  star: [["STARRED"], []], unstar: [[], ["STARRED"]],
  read: [[], ["UNREAD"]], unread: [["UNREAD"], []],
  important: [["IMPORTANT"], []], unimportant: [[], ["IMPORTANT"]],
  spam: [["SPAM"], ["INBOX"]], unspam: [["INBOX"], ["SPAM"]],
};
async function threadMeta(threadId: string) {
  const qp = new URLSearchParams({ format: "metadata" });
  for (const h of ["From", "To", "Subject", "Date"]) qp.append("metadataHeaders", h);
  const t = await gmail(`/threads/${threadId}?${qp.toString()}`);
  const msgs = (t.messages ?? []).map((m: any) => {
    const headers = m.payload?.headers ?? [];
    const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    return { id: m.id, from: h("From"), to: h("To"), subject: h("Subject"), date: h("Date"), labels: m.labelIds ?? [], snippet: (m.snippet ?? "").slice(0, 160) };
  });
  return { threadId, messages: msgs };
}
async function draftMeta(d: any) {
  const m = d.message ?? {};
  const headers = m.payload?.headers ?? [];
  const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  return { draftId: d.id, messageId: m.id, threadId: m.threadId, to: h("To"), subject: h("Subject"), date: h("Date"), snippet: (m.snippet ?? "").slice(0, 160) };
}
async function draftPayload(argv: string[]): Promise<any> {
  const opts = parseSendArgs(argv);
  if (!opts.to || !opts.subject) throw new Error("--to and --subject required");
  if (!opts.bodyFile && !opts.bodyStdin) throw new Error("--body-file or --body-stdin required");
  const body = opts.bodyStdin ? await readStdin() : readFileSync(opts.bodyFile!, "utf8");
  if (opts.replyToId) {
    const thr = await resolveThreadFromReplyId(opts.replyToId);
    opts.threadId ??= thr.threadId; opts.inReplyTo ??= thr.inReplyTo; opts.references ??= thr.references;
  }
  return { message: draftMessage(opts, body) };
}

/**
 * The stored-draft message for a send's options. A draft goes out byte for byte as stored (sendDraft transmits the
 * proofed snapshot), so the standing principal copy has to be in the draft when it is created; --no-copy skips it.
 */
export function draftMessage(opts: SendOpts & { threadId?: string }, body: string): { raw: string; threadId?: string } {
  const withCopy = withPrincipalCopy(opts);
  const message: { raw: string; threadId?: string } = { raw: b64url(buildRfc822({ ...withCopy, body })) };
  if (opts.threadId) message.threadId = opts.threadId;
  return message;
}

const [cmd, ...args] = ARGV;
if (import.meta.main) (async () => {
  try {
    if (cmd === "list") {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 50;
      const ids = await listIds(q, max);
      const conc = 10;
      for (let i = 0; i < ids.length; i += conc) {
        const rows = await Promise.all(ids.slice(i, i + conc).map(async id => {
          try {
            const qp = new URLSearchParams({ format: "metadata" });
            for (const h of ["From", "To", "Subject", "Date", "Authentication-Results"]) qp.append("metadataHeaders", h);
            const m = await gmail(`/messages/${id}?${qp.toString()}`);
            const headers = m.payload?.headers ?? [];
            const h = (n: string) => headers.find((x: any) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
            return { id, threadId: m.threadId, labels: m.labelIds ?? [], from: h("From"), to: h("To"), subject: h("Subject"), date: h("Date"), snippet: (m.snippet ?? "").slice(0, 160), authResults: authenticationResults(headers) };
          } catch (e: any) { return { id, error: e.message }; }
        }));
        for (const r of rows) console.log(JSON.stringify(r));
      }
    } else if (cmd === "sent-meta") {
      // The People backfill's read of a mailbox's Sent folder: one JSONL line per message with its recipients.
      const max = args[0] ? parseInt(args[0], 10) : 500;
      if (!Number.isInteger(max) || max < 1) throw new Error("usage: gmail.ts sent-meta [max]");
      const ids = await listIds("in:sent", max);
      for (let i = 0; i < ids.length; i += 10) {
        const rows = await Promise.all(ids.slice(i, i + 10).map(async id => {
          try {
            const qp = new URLSearchParams({ format: "metadata" });
            for (const h of ["To", "Cc", "Bcc", "Subject", "Date"]) qp.append("metadataHeaders", h);
            const m = await gmail(`/messages/${id}?${qp.toString()}`);
            const headers = m.payload?.headers ?? [];
            const h = (n: string) => headers.filter((x: any) => x.name.toLowerCase() === n.toLowerCase()).map((x: any) => x.value).join(", ");
            const at = Number(m.internalDate);
            return { id, threadId: m.threadId, ts: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null, to: h("To"), cc: h("Cc"), bcc: h("Bcc"), subject: h("Subject") };
          } catch (e: any) { return { id, error: String(e.message).slice(0, 160) }; }
        }));
        for (const r of rows) console.log(JSON.stringify(r));
      }
    } else if (cmd === "modify") {
      const ids = splitIds(args[0]);
      const add = flag(args, "--add") ? await labelIds(flag(args, "--add")!) : [];
      const remove = flag(args, "--remove") ? await labelIds(flag(args, "--remove")!) : [];
      if (!add.length && !remove.length) throw new Error("--add and/or --remove required");
      await modifyBatch(ids, add, remove);
      console.log(`modified ${ids.length}${add.length ? ` +${add.join(",")}` : ""}${remove.length ? ` -${remove.join(",")}` : ""}`);
    } else if (cmd && SHORTCUTS[cmd] && cmd !== "archive" && cmd !== "unspam") {
      const ids = splitIds(args[0]);
      const [add, remove] = SHORTCUTS[cmd];
      await modifyBatch(ids, add, remove);
      console.log(`${cmd} ${ids.length}`);
    } else if (cmd === "trash" || cmd === "untrash") {
      const ids = splitIds(args[0]);
      for (const id of ids) await gmail(`/messages/${id}/${cmd}`, { method: "POST" });
      console.log(`${cmd}ed ${ids.length}`);
    } else if (cmd === "thread") {
      if (!args[0]) throw new Error("usage: gmail.ts thread <threadId>");
      console.log(JSON.stringify(await threadMeta(args[0]), null, 2));
    } else if (cmd === "threads") {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 50;
      const qp = new URLSearchParams({ q, maxResults: String(Math.min(500, max)) });
      const res = await gmail(`/threads?${qp.toString()}`);
      for (const t of res.threads ?? []) console.log(JSON.stringify({ threadId: t.id, snippet: (t.snippet ?? "").slice(0, 160) }));
    } else if (cmd === "labels") {
      if (args[0] === "create") {
        if (!args[1]) throw new Error("usage: gmail.ts labels create <name>");
        const l = await gmail(`/labels`, { method: "POST", body: JSON.stringify({ name: args[1], labelListVisibility: "labelShow", messageListVisibility: "show" }) });
        console.log(JSON.stringify({ id: l.id, name: l.name }));
      } else if (args[0] === "delete") {
        if (!args[1]) throw new Error("usage: gmail.ts labels delete <name|id>");
        const [id] = await labelIds(args[1]);
        if (SYSTEM_LABELS.has(id)) throw new Error("refusing to delete a system label");
        await gmail(`/labels/${id}`, { method: "DELETE" });
        console.log(`deleted label ${id}`);
      } else {
        console.log(JSON.stringify(await allLabels(), null, 2));
      }
    } else if (cmd === "drafts") {
      const sub = args[0] ?? "list";
      if (sub === "list") {
        const res = await gmail(`/drafts?maxResults=${args[1] ?? 50}`);
        for (const d of res.drafts ?? []) console.log(JSON.stringify(await draftMeta(await gmail(`/drafts/${d.id}?format=metadata`))));
      } else if (sub === "get") {
        if (!args[1]) throw new Error("usage: gmail.ts drafts get <draftId>");
        const d = await gmail(`/drafts/${args[1]}?format=full`);
        const full = await fetchWithParts(d.message.id);
        console.log(JSON.stringify({ draftId: d.id, ...full }, null, 2));
      } else if (sub === "create") {
        const d = await gmail(`/drafts`, { method: "POST", body: JSON.stringify(await draftPayload(args.slice(1))) });
        console.log(JSON.stringify({ draftId: d.id, messageId: d.message?.id, threadId: d.message?.threadId }));
      } else if (sub === "delete") {
        if (!args[1]) throw new Error("usage: gmail.ts drafts delete <draftId>");
        await gmail(`/drafts/${args[1]}`, { method: "DELETE" });
        console.log(`deleted draft ${args[1]}`);
      } else if (sub === "send") {
        if (!args[1]) throw new Error("usage: gmail.ts drafts send <draftId>");
        const r = await sendDraft(args[1]);
        console.log(JSON.stringify({ id: r.id, threadId: r.threadId, labels: r.labelIds }));
      } else throw new Error(`unknown drafts subcommand ${sub}`);
    } else if (cmd === "profile") {
      // Which mailbox is this credential actually reading? Settles identity when
      // several credential files sit side by side in CONFIG/CREDENTIALS/google/.
      console.log(JSON.stringify(await gmail("/profile"), null, 2));
    } else if (cmd === "count") {
      console.log(await countQuery(args[0] ?? "in:inbox"));
    } else if (cmd === "ids") {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 500;
      const ids = await listIds(q, max);
      console.log(ids.join("\n"));
    } else if (cmd === "archive") {
      const ids = (args[0] ?? "").split(",").filter(Boolean);
      if (!ids.length) throw new Error("no ids");
      await archiveBatch(ids);
      console.log(`archived ${ids.length}`);
    } else if (cmd === "unspam") {
      const ids = (args[0] ?? "").split(",").filter(Boolean);
      if (!ids.length) throw new Error("no ids");
      await unspamBatch(ids);
      console.log(`unspammed ${ids.length}`);
    } else if (cmd === "fetch") {
      console.log(JSON.stringify(await fetchMin(args[0]), null, 2));
    } else if (cmd === "fetchfull") {
      console.log(JSON.stringify(await fetchFull(args[0]), null, 2));
    } else if (cmd === "fetchall") {
      const q = args[0] ?? "in:inbox";
      const max = args[1] ? parseInt(args[1], 10) : 500;
      const ids = await listIds(q, max);
      const conc = 20;
      for (let i = 0; i < ids.length; i += conc) {
        const chunk = ids.slice(i, i + conc);
        const results = await Promise.all(chunk.map(id => fetchMin(id).catch(e => ({ id, error: e.message }))));
        for (const r of results) console.log(JSON.stringify(r));
      }
    } else if (cmd === "body") {
      if (!args[0]) throw new Error("usage: gmail.ts body <id>");
      console.log(JSON.stringify(await fetchWithParts(args[0]), null, 2));
    } else if (cmd === "attach") {
      // gmail.ts attach <id>              → list attachments
      // gmail.ts attach <id> <outdir>     → download all attachments
      if (!args[0]) throw new Error("usage: gmail.ts attach <id> [outdir]");
      const full = await fetchWithParts(args[0]);
      if (!args[1]) { console.log(JSON.stringify(full.attachments, null, 2)); }
      else {
        for (const a of full.attachments) {
          if (!a.attachmentId) continue;
          const safe = a.filename.replace(/[^A-Za-z0-9._-]/g, "_");
          const dest = `${args[1]}/${args[0]}__${safe}`;
          const n = await saveAttachment(args[0], a.attachmentId, dest);
          console.log(`${n}\t${dest}`);
        }
      }
    } else if (cmd === "send") {
      const opts = parseSendArgs(args);
      if (!opts.to) throw new Error("--to required");
      if (!opts.subject && !opts.replyToId) throw new Error("--subject required (or --reply-to-id to inherit)");
      if (!opts.bodyFile && !opts.bodyStdin) throw new Error("--body-file or --body-stdin required");
      const body = opts.bodyStdin ? await readStdin() : readFileSync(opts.bodyFile!, "utf8");
      if (opts.replyToId) {
        const thr = await resolveThreadFromReplyId(opts.replyToId);
        opts.threadId ??= thr.threadId;
        opts.inReplyTo ??= thr.inReplyTo;
        opts.references ??= thr.references;
        if (!opts.subject) opts.subject = thr.subject.startsWith("Re:") ? thr.subject : `Re: ${thr.subject}`;
      }
      const res = await sendMessage({ ...opts, body });
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log("usage: gmail.ts [--account <name>] profile|count|ids|list|sent-meta|fetch|fetchfull|fetchall|body|attach|thread|threads|labels|drafts|modify|archive|inbox|star|unstar|read|unread|important|unimportant|spam|unspam|trash|untrash|send ... (see header)");
      process.exit(1);
    }
  } catch (e: any) {
    console.error(`ERR: ${e.message}`);
    process.exit(1);
  }
})();
