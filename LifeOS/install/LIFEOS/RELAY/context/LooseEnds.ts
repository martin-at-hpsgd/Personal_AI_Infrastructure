#!/usr/bin/env bun
/**
 * LooseEnds.ts — Tex F23 loose ends: the things {{PRINCIPAL_NAME}} left undone, found by reading mail and calendar.
 * Tex ISA F23, ISC-349..356.
 *
 * Heads-up (F22) reacts to new mail, calendar events and follow-up dates, so it never notices what he has not done.
 * This scanner finds four kinds of loose end, and HeadsUp.ts runs it as a fourth gate (`loose-ends`) once per
 * principal-local day after 09:00. Its lines go into the same pending file as every other gate, so the same judge,
 * daily cap, Vigil bar and ask-first question carry them. Nothing here texts, mails, writes or calls a model.
 *
 *   reply-owed         a thread in one of {{PRINCIPAL_NAME}}'s own mailboxes whose newest message is from a person (not him, not
 *                      an automated or bulk sender) and is 3 to 14 days old
 *   unsigned           a DocuSign, Dropbox Sign or Adobe Sign request from the last 14 days with no later completion
 *                      mail for the same document
 *   invite-unanswered  an event in the next 14 days where {{PRINCIPAL_NAME}}'s own attendee entry still awaits his response
 *   meeting-follow-up  an event that ended in the last 2 days with someone outside {{PRINCIPAL_NAME}}'s own domains, and no
 *                      mail from him to any attendee since it ended
 *
 * Read-only by construction (ISC-355): every tool call goes through `readOnly()`, which refuses any subcommand
 * outside MAIL_READS / CALENDAR_READS. The mail tool is `LIFEOS/TOOLS/gmail.ts` (list, thread); the calendar tool
 * is the calendar skill's `gcal.ts` (list).
 *
 * Which mailboxes are {{PRINCIPAL_NAME}}'s: every Google mailbox credential (JobGate.mailboxAccounts) except one whose
 * `<label>@<domain>` address is a command mailbox ({{DA_NAME}}'s own). His addresses and domains come from the JobGate gate
 * config (selfAddresses, commandMailboxes); automated senders from the senders.yaml classes JobGate reads.
 *
 * CLI:
 *   bun LooseEnds.ts scan [--dry-run] [--json]
 *     scan       find loose ends now (ignoring the 09:00 and once-a-day clock), add the new ones to the heads-up
 *                pending file and remember them as surfaced
 *     --dry-run  find and print them; write no state, no pending, no event
 *
 * @version 1.0.0
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { address, loadGateConfig, loadSenderClasses, mailboxAccounts, type SenderClass } from "../../TOOLS/JobGate";
import { lifeosPath } from "../../TOOLS/Paths";
import { PRIVATE_SKILL_NAMES } from "../../TOOLS/CodeDataBoundary";

// ── Constants ──────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** A reply is owed once the newest message has waited this long… */
export const REPLY_MIN_AGE_MS = 3 * DAY_MS;
/** …and stops being a loose end once it is older than 14 days (14 days 0 h still counts; older threads are history, not a dropped ball). */
export const REPLY_MAX_AGE_MS = 14 * DAY_MS;
/** Signature requests are looked at for this long. */
export const SIGNATURE_WINDOW_MS = 14 * DAY_MS;
/** A signature request younger than this is still news (the mail gate already surfaced it), not a loose end. */
export const SIGNATURE_MIN_AGE_MS = DAY_MS;
/** Invites starting inside this window are checked for a response. */
export const INVITE_WINDOW_MS = 14 * DAY_MS;
/** Meetings that ended inside this window are checked for a follow-up. */
export const MEETING_WINDOW_MS = 2 * DAY_MS;
/** A meeting that ended less than this ago gets the rest of the day before it counts. */
export const MEETING_GRACE_MS = 3 * 60 * 60_000;
/** Threads fetched per mailbox to confirm their newest message (bounds the calls). */
export const MAX_THREAD_FETCHES = 12;
/** At most this many loose ends of one kind per scan. */
export const MAX_PER_KIND = 8;

/** The only subcommands this file may run: reads. */
export const MAIL_READS = ["list", "thread"] as const;
export const CALENDAR_READS = ["list"] as const;

export const KINDS = ["reply-owed", "unsigned", "invite-unanswered", "meeting-follow-up"] as const;
export type LooseEndKind = typeof KINDS[number];

/** Signature services whose request and completion mail is read. */
export const SIGNATURE_DOMAINS = ["docusign.net", "docusign.com", "dropboxsign.com", "hellosign.com", "adobesign.com", "echosign.com"] as const;

const BULK_LABELS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"];
const AUTOMATED_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|news(letter)?s?|updates?|digest|automated|auto[-_.]?confirm|system|support|billing|receipts?|info|hello|team|marketing|calendar[-_.]?notification)\b/i;
const AUTOMATED_DOMAIN = /(^|\.)(docusign\.(net|com)|dropboxsign\.com|hellosign\.com|adobesign\.com|echosign\.com|calendar\.google\.com|mailchimp\.com|sendgrid\.net|substack\.com|beehiiv\.com|linkedin\.com|github\.com|google\.com|amazonses\.com)$/i;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Runs one tool. argv[0] is a script path run with bun; never a shell. Same shape as HeadsUp's Runner. */
export type Runner = (argv: string[], env?: Record<string, string>) => { ok: boolean; stdout: string; stderr: string };

export interface LooseEnd { key: string; kind: LooseEndKind; line: string; at: string }
export interface LooseEndsConfig {
  /** {{PRINCIPAL_NAME}}'s own mailbox credential names ({{DA_NAME}}'s excluded). */
  accounts: string[];
  selfAddresses: string[];
  commandMailboxes: string[];
  ownDomains: string[];
  senderClasses: Map<string, SenderClass>;
  /** True when no mailbox credential exists at all (absent, not broken). */
  noMailboxes: boolean;
}
export type SourceState = "ok" | "absent" | "partial" | "failed";
export interface ScanResult {
  items: LooseEnd[];
  degraded: string[];
  sources: { mail: SourceState; calendar: SourceState };
  /** True when a source that exists could not be read at all (worth a retry later the same day). */
  failed: boolean;
  calls: string[][];
}
export interface ScanContext { run: Runner; now: Date; tz: string; root: string; config?: LooseEndsConfig }

interface MailRow { id: string; threadId?: string; labels?: string[]; from: string; to?: string; subject: string; date: string; snippet?: string; account: string }

// ── Config ────────────────────────────────────────────────────────────────────

const domainOf = (addr: string): string => (addr.split("@")[1] ?? "").toLowerCase();

/** The address a mailbox credential name stands for when it has a local part (`assistant.example.com` → assistant@example.com). */
function accountAddress(name: string): string | null {
  const parts = name.toLowerCase().split(".");
  return parts.length > 2 ? `${parts[0]}@${parts.slice(1).join(".")}` : null;
}

/** {{PRINCIPAL_NAME}}'s mailboxes, addresses and domains, read from the same USER config JobGate reads. */
export function loadLooseEndsConfig(): LooseEndsConfig {
  const cfg = loadGateConfig(lifeosPath("USER", "CONFIG", "agent-jobs.json"));
  const all = mailboxAccounts(lifeosPath("USER", "CONFIG", "CREDENTIALS", "google"));
  const accounts = all.filter((a) => { const addr = accountAddress(a); return !(addr && cfg.commandMailboxes.includes(addr)); });
  const ownDomains = new Set<string>();
  for (const a of [...cfg.selfAddresses, ...cfg.commandMailboxes]) if (domainOf(a)) ownDomains.add(domainOf(a));
  for (const a of all) { const addr = accountAddress(a); ownDomains.add(addr && cfg.commandMailboxes.includes(addr) ? domainOf(addr) : a.toLowerCase()); }
  return {
    accounts, selfAddresses: cfg.selfAddresses, commandMailboxes: cfg.commandMailboxes, ownDomains: [...ownDomains].filter(Boolean),
    senderClasses: loadSenderClasses(lifeosPath("USER", "INBOX", "senders.yaml")), noMailboxes: all.length === 0,
  };
}

// ── Read-only tool access (ISC-355) ───────────────────────────────────────────

export const mailToolPath = (root: string): string => join(root, "LIFEOS/TOOLS/gmail.ts");
export const calendarToolPath = (root: string): string => join(root, "skills", PRIVATE_SKILL_NAMES.calendar, "Tools", "gcal.ts");

/** The subcommand of a tool argv: the first token after the script that is not `--account <name>`. */
export function subcommandOf(argv: string[]): string {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--account") { i++; continue; }
    return argv[i]!;
  }
  return "";
}

/** Wraps a runner so only read subcommands of the mail and calendar tools can ever run. */
export function readOnly(run: Runner, root: string, calls: string[][]): Runner {
  return (argv, env) => {
    const sub = subcommandOf(argv);
    const tool = argv[0] ?? "";
    const allowed = tool === mailToolPath(root) ? (MAIL_READS as readonly string[]).includes(sub)
      : tool === calendarToolPath(root) ? (CALENDAR_READS as readonly string[]).includes(sub) : false;
    if (!allowed) throw new Error(`loose ends refused a non-read tool call: ${tool.split("/").pop()} ${sub}`);
    calls.push(argv);
    return run(argv, env);
  };
}

function jsonl(stdout: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { const o = JSON.parse(t); if (o && typeof o === "object" && !o.error) out.push(o); } catch { /* not a row */ }
  }
  return out;
}

// ── Formatting ────────────────────────────────────────────────────────────────

const displayName = (from: string): string => {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = m?.[1]?.trim();
  return (name || address(from)).slice(0, 60);
};
const clip = (s: string, n: number): string => s.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, n);
const days = (ms: number): string => { const n = Math.max(0, Math.floor(ms / DAY_MS)); return `${n} day${n === 1 ? "" : "s"}`; };
const when = (d: Date, tz: string): string => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const shortHash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ── Mail: reply owed ──────────────────────────────────────────────────────────

/** True when a message is from {{PRINCIPAL_NAME}}: a sent label or one of his own addresses. */
function fromPrincipal(m: { from: string; labels?: string[] }, cfg: LooseEndsConfig): boolean {
  return (m.labels ?? []).includes("SENT") || cfg.selfAddresses.includes(address(m.from));
}

/** True when a message is from a person rather than an automated or bulk sender (ISC-350). */
export function fromPerson(m: { from: string; labels?: string[]; snippet?: string }, cfg: LooseEndsConfig): boolean {
  const addr = address(m.from);
  if (!addr.includes("@")) return false;
  if (cfg.selfAddresses.includes(addr) || cfg.commandMailboxes.includes(addr)) return false;
  const cls = cfg.senderClasses.get(addr);
  if (cls === "marketing" || cls === "notification") return false;
  if ((m.labels ?? []).some((l) => BULK_LABELS.includes(l))) return false;
  const [local = "", domain = ""] = addr.split("@");
  if (cls !== "human" && (AUTOMATED_LOCAL.test(local) || AUTOMATED_DOMAIN.test(domain))) return false;
  if (cls !== "human" && /\bunsubscribe\b/i.test(m.snippet ?? "")) return false;
  return true;
}

function replyOwed(run: Runner, ctx: ScanContext, cfg: LooseEndsConfig, account: string, sent: MailRow[] | null, degraded: string[]): LooseEnd[] {
  const now = ctx.now.getTime();
  const gmail = mailToolPath(ctx.root);
  const r = run([gmail, "--account", account, "list", "in:inbox newer_than:16d older_than:2d -category:promotions -category:social -category:updates -category:forums", "150"]);
  if (!r.ok) { degraded.push(`mail list failed for one mailbox: ${clip(r.stderr || "no output", 120)}`); return []; }
  const newest = new Map<string, MailRow>();
  for (const o of jsonl(r.stdout)) {
    const m = { ...o, account } as MailRow;
    const t = Date.parse(m.date);
    if (!m.threadId || Number.isNaN(t)) continue;
    const cur = newest.get(m.threadId);
    if (!cur || Date.parse(cur.date) < t) newest.set(m.threadId, m);
  }
  const candidates = [...newest.values()].filter((m) => {
    const age = now - Date.parse(m.date);
    if (age < REPLY_MIN_AGE_MS || age > REPLY_MAX_AGE_MS) return false;
    if (!fromPerson(m, cfg)) return false;
    // A sent message in the same thread at or after it means he answered.
    return !(sent ?? []).some((s) => s.threadId === m.threadId && Date.parse(s.date) >= Date.parse(m.date));
  }).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, MAX_THREAD_FETCHES);

  const out: LooseEnd[] = [];
  for (const c of candidates) {
    const t = run([gmail, "--account", account, "thread", c.threadId!]);
    let msgs: Array<{ from: string; date: string; labels?: string[]; subject?: string; snippet?: string }> = [];
    try { msgs = (JSON.parse(t.stdout) as { messages?: typeof msgs }).messages ?? []; } catch { msgs = []; }
    if (!t.ok || msgs.length === 0) { degraded.push("a mail thread could not be read"); continue; }
    const real = msgs.filter((m) => !(m.labels ?? []).includes("DRAFT") && !Number.isNaN(Date.parse(m.date)));
    const last = real.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[real.length - 1];
    if (!last || fromPrincipal(last, cfg) || !fromPerson(last, cfg)) continue;
    const age = now - Date.parse(last.date);
    if (age < REPLY_MIN_AGE_MS || age > REPLY_MAX_AGE_MS) continue;
    out.push({
      key: `reply:${c.threadId}`, kind: "reply-owed", at: new Date(Date.parse(last.date)).toISOString(),
      line: `LOOSE_END reply-owed · from ${displayName(last.from)} · "${clip(last.subject || c.subject || "(no subject)", 120)}" · ${days(age)}`,
    });
  }
  return out;
}

// ── Mail: unsigned documents ──────────────────────────────────────────────────

const COMPLETION = /^\s*(completed|signed|you signed|document completed|voided|declined)\b|\bhas been (completed|signed)\b|\bsigned by all\b|\s-\s+signed by\b|\b(everyone|all parties) (has|have) signed\b|\bfully executed\b|\bsigned and filed\b|\bhas been (voided|declined|cancell?ed)\b/i;
const REQUEST = /\b(please docusign|complete with docusign|please (review and )?sign|signature request(ed)?|requested your signature|review and sign|needs your signature|waiting for your signature|invitation to sign|sign(ing)? reminder|reminder)\b/i;

/** The document a signature mail is about, so a completion can be matched to its request. */
export function docKey(subject: string): string {
  let s = subject.toLowerCase().replace(/\s+/g, " ").trim();
  const quoted = s.match(/["'‘’“”]([^"'‘’“”]{4,})["'‘’“”]/);
  if (quoted) s = quoted[1]!;
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/^(re|fwd?|completed|reminder|please docusign|complete with docusign|please sign|please review(?: and sign)?|you signed|signed|voided|declined|document completed)\s*:\s*/i, "");
    if (s === before) break;
  }
  s = s.replace(/\s+-\s+(signature requested|signed) by .*$/i, "")
    .replace(/^.*?\bhas requested your signature on\s+/i, "")
    .replace(/^signature requested on\s+/i, "")
    .replace(/^(everyone has signed|you've been copied on)\s+/i, "")
    .replace(/\s+(between .* )?is signed and filed!?$/i, "")
    .replace(/[\s.!:'"-]+$/g, "").replace(/^[\s.!:'"-]+/g, "").trim();
  return s;
}

const sameDoc = (a: string, b: string): boolean => a === b || (a.length >= 6 && b.length >= 6 && (a.includes(b) || b.includes(a)));

function unsigned(run: Runner, ctx: ScanContext, account: string, degraded: string[]): LooseEnd[] {
  const now = ctx.now.getTime();
  const r = run([mailToolPath(ctx.root), "--account", account, "list", `newer_than:15d from:(${SIGNATURE_DOMAINS.join(" OR ")})`, "100"]);
  if (!r.ok) { degraded.push(`signature mail list failed for one mailbox: ${clip(r.stderr || "no output", 120)}`); return []; }
  const rows = jsonl(r.stdout).map((o) => ({ ...o, account }) as MailRow).filter((m) => !Number.isNaN(Date.parse(m.date)));
  const completions = rows.filter((m) => COMPLETION.test(m.subject ?? ""));
  const requests = rows.filter((m) => !COMPLETION.test(m.subject ?? "") && REQUEST.test(m.subject ?? ""));
  const byDoc = new Map<string, MailRow>();
  for (const q of requests) {
    const t = Date.parse(q.date);
    if (now - t > SIGNATURE_WINDOW_MS) continue;
    const key = docKey(q.subject);
    if (!key) continue;
    const done = completions.some((c) => Date.parse(c.date) >= t && ((q.threadId && c.threadId === q.threadId) || sameDoc(docKey(c.subject), key)));
    if (done) continue;
    const cur = byDoc.get(key);
    if (!cur || Date.parse(cur.date) > t) byDoc.set(key, q); // the first request dates the loose end
  }
  const out: LooseEnd[] = [];
  for (const [key, q] of byDoc) {
    const age = now - Date.parse(q.date);
    if (age < SIGNATURE_MIN_AGE_MS) continue;
    const provider = /docusign/i.test(q.from) ? "DocuSign" : /dropboxsign|hellosign/i.test(q.from) ? "Dropbox Sign" : /adobesign|echosign/i.test(q.from) ? "Adobe Sign" : "e-signature";
    out.push({ key: `sign:${shortHash(key)}`, kind: "unsigned", at: new Date(Date.parse(q.date)).toISOString(), line: `LOOSE_END unsigned · ${provider} · "${clip(q.subject, 120)}" · ${days(age)}` });
  }
  return out;
}

// ── Calendar ──────────────────────────────────────────────────────────────────

type Attendee = { email?: string; displayName?: string; self?: boolean; responseStatus?: string; resource?: boolean; organizer?: boolean };
type CalEvent = { id?: string; summary?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; attendees?: Attendee[]; organizer?: { email?: string; self?: boolean } };

const isResource = (a: Attendee): boolean => !!a.resource || /(resource\.calendar\.google\.com|group\.calendar\.google\.com|group\.v\.calendar\.google\.com)$/i.test(a.email ?? "");

/** Merge copies of one event read through several of {{PRINCIPAL_NAME}}'s calendars: every copy's attendees, its own self flag kept. */
function mergeEvents(items: CalEvent[]): CalEvent[] {
  const by = new Map<string, CalEvent>();
  for (const ev of items) {
    if (!ev?.id) continue;
    const cur = by.get(ev.id);
    if (!cur) { by.set(ev.id, { ...ev, attendees: [...(ev.attendees ?? [])] }); continue; }
    cur.attendees = [...(cur.attendees ?? []), ...(ev.attendees ?? [])];
    if (ev.organizer?.self) cur.organizer = ev.organizer;
  }
  return [...by.values()];
}

function calendarLooseEnds(run: Runner, ctx: ScanContext, degraded: string[]): { items: CalEvent[]; state: SourceState } {
  const tool = calendarToolPath(ctx.root);
  if (!existsSync(tool)) return { items: [], state: "absent" };
  const now = ctx.now.getTime();
  const r = run([tool, "list", "--from", new Date(now - MEETING_WINDOW_MS).toISOString(), "--to", new Date(now + INVITE_WINDOW_MS).toISOString(), "--max", "250"]);
  let parsed: { items?: CalEvent[]; degraded?: string[] } | null = null;
  try { parsed = JSON.parse(r.stdout); } catch { parsed = null; }
  if (!r.ok || !parsed) { degraded.push(`calendar list unreadable: ${clip(r.stderr || "bad output", 120)}`); return { items: [], state: "failed" }; }
  const partly = Array.isArray(parsed.degraded) && parsed.degraded.length > 0;
  if (partly) degraded.push(`calendar partly unreadable (${parsed.degraded!.length})`);
  return { items: mergeEvents(parsed.items ?? []), state: partly ? "partial" : "ok" };
}

function invites(events: CalEvent[], ctx: ScanContext): LooseEnd[] {
  const now = ctx.now.getTime();
  const out: LooseEnd[] = [];
  for (const ev of events) {
    if (ev.status === "cancelled" || ev.organizer?.self) continue;
    const startIso = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : undefined);
    const start = startIso ? Date.parse(startIso) : NaN;
    if (Number.isNaN(start) || start < now || start > now + INVITE_WINDOW_MS) continue;
    const self = (ev.attendees ?? []).filter((a) => a.self);
    if (self.length === 0 || self.some((a) => a.responseStatus && a.responseStatus !== "needsAction")) continue;
    if (!self.some((a) => a.responseStatus === "needsAction")) continue;
    const inDays = Math.max(0, Math.round((start - now) / DAY_MS));
    out.push({
      key: `invite:${ev.id}`, kind: "invite-unanswered", at: new Date(start).toISOString(),
      line: `LOOSE_END invite-unanswered · "${clip(ev.summary ?? "(no title)", 120)}" · ${ev.start?.dateTime ? when(new Date(start), ctx.tz) : ev.start?.date} · in ${inDays === 0 ? "under a day" : `${inDays} day${inDays === 1 ? "" : "s"}`}`,
    });
  }
  return out;
}

function meetingFollowUps(run: Runner, events: CalEvent[], ctx: ScanContext, cfg: LooseEndsConfig, sentBy: Map<string, MailRow[] | null>, degraded: string[]): LooseEnd[] {
  const now = ctx.now.getTime();
  const own = new Set(cfg.ownDomains.map((d) => d.toLowerCase()));
  const out: LooseEnd[] = [];
  for (const ev of events) {
    if (ev.status === "cancelled" || !ev.end?.dateTime || !ev.start?.dateTime) continue; // all-day events are not meetings
    const end = Date.parse(ev.end.dateTime);
    if (Number.isNaN(end) || end > now - MEETING_GRACE_MS || end < now - MEETING_WINDOW_MS) continue;
    const attendees = ev.attendees ?? [];
    const self = attendees.filter((a) => a.self);
    if (self.length > 0 && self.every((a) => a.responseStatus === "declined")) continue;
    for (const a of self) if (a.email) own.add(domainOf(a.email));
    const others = attendees.filter((a) => !a.self && !isResource(a) && a.email && !cfg.selfAddresses.includes(a.email.toLowerCase()));
    const external = others.filter((a) => !own.has(domainOf(a.email!)));
    if (external.length === 0) continue;
    const emails = [...new Set(others.map((a) => a.email!.toLowerCase()))].slice(0, 10);
    // Mail from {{PRINCIPAL_NAME}} to any attendee since the meeting ended: first the sent rows already read, then one search per mailbox.
    let mailed = false;
    let checked = 0;
    for (const account of cfg.accounts) {
      const sent = sentBy.get(account);
      if (sent && sent.some((s) => Date.parse(s.date) >= end && emails.some((e) => (s.to ?? "").toLowerCase().includes(e)))) { mailed = true; break; }
      const q = `in:sent after:${Math.floor(end / 1000)} {${emails.map((e) => `to:${e} cc:${e} bcc:${e}`).join(" ")}}`;
      const r = run([mailToolPath(ctx.root), "--account", account, "list", q, "5"]);
      if (!r.ok) { degraded.push(`sent-mail check failed for one mailbox: ${clip(r.stderr || "no output", 120)}`); continue; }
      checked++;
      if (jsonl(r.stdout).length > 0) { mailed = true; break; }
    }
    if (mailed || checked === 0) continue; // unknown is not a loose end
    const first = external[0]!;
    out.push({
      key: `meeting:${ev.id}`, kind: "meeting-follow-up", at: new Date(end).toISOString(),
      line: `LOOSE_END meeting-follow-up · "${clip(ev.summary ?? "(no title)", 120)}" · ended ${when(new Date(end), ctx.tz)} · with ${clip(first.displayName || first.email!, 60)}${external.length > 1 ? ` (+${external.length - 1})` : ""} · no mail since`,
    });
  }
  return out;
}

// ── The scan ──────────────────────────────────────────────────────────────────

function sentRows(run: Runner, ctx: ScanContext, account: string): MailRow[] | null {
  const r = run([mailToolPath(ctx.root), "--account", account, "list", "in:sent newer_than:16d", "200"]);
  if (!r.ok) return null;
  return jsonl(r.stdout).map((o) => ({ ...o, account }) as MailRow);
}

/**
 * Find every loose end now. Pure apart from the injected runner: no state, no model, no event. Each line is the raw
 * line; HeadsUp's gate masks it before it reaches the pending file.
 */
export function scanLooseEnds(ctx: ScanContext): ScanResult {
  const cfg = ctx.config ?? loadLooseEndsConfig();
  const calls: string[][] = [];
  const run = readOnly(ctx.run, ctx.root, calls);
  const degraded: string[] = [];
  const items: LooseEnd[] = [];

  // Mail
  let mail: SourceState = "ok";
  const sentBy = new Map<string, MailRow[] | null>();
  if (cfg.accounts.length === 0) {
    mail = "absent";
    degraded.push(cfg.noMailboxes ? "no mailbox credentials" : "no mailbox of {{PRINCIPAL_NAME}}'s own is configured");
  } else if (!existsSync(mailToolPath(ctx.root))) {
    mail = "absent";
    degraded.push("mail tool not installed");
  } else {
    let okAccounts = 0;
    const replies: LooseEnd[] = [];
    const sigs: LooseEnd[] = [];
    for (const account of cfg.accounts) {
      const before = degraded.length;
      const sent = sentRows(run, ctx, account);
      sentBy.set(account, sent);
      if (sent === null) degraded.push("sent-mail list failed for one mailbox");
      replies.push(...replyOwed(run, ctx, cfg, account, sent, degraded));
      sigs.push(...unsigned(run, ctx, account, degraded));
      if (degraded.length === before) okAccounts++;
    }
    mail = okAccounts === cfg.accounts.length ? "ok" : okAccounts === 0 && replies.length + sigs.length === 0 ? "failed" : "partial";
    // One loose end per key, and one per identical line (the same mail delivered to two of his mailboxes).
    const dedupe = (xs: LooseEnd[]) => [...new Map([...new Map(xs.map((x) => [x.key, x])).values()].map((x) => [x.line, x])).values()];
    items.push(...dedupe(replies).slice(0, MAX_PER_KIND), ...dedupe(sigs).slice(0, MAX_PER_KIND));
  }

  // Calendar
  const cal = calendarLooseEnds(run, ctx, degraded);
  if (cal.state === "absent") degraded.push("calendar tool not installed");
  items.push(...invites(cal.items, ctx).slice(0, MAX_PER_KIND));
  if (mail !== "absent" && cfg.accounts.length > 0) items.push(...meetingFollowUps(run, cal.items, ctx, cfg, sentBy, degraded).slice(0, MAX_PER_KIND));

  return { items, degraded, sources: { mail, calendar: cal.state }, failed: mail === "failed" || cal.state === "failed", calls };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/** The CLI's exit code: 1 when mail or calendar failed, so the ISC-356 row catches a half-dead scan. */
export function scanExitCode(sources: { mail: SourceState; calendar: SourceState }): number {
  return sources.mail === "failed" || sources.calendar === "failed" ? 1 : 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes("--json");
  const dryRun = rest.includes("--dry-run");
  if (cmd !== "scan") {
    console.error("usage: LooseEnds.ts scan [--dry-run] [--json]");
    process.exit(2);
  }
  // Dynamic import: HeadsUp.ts owns the heads-up state and masking, and imports this file.
  const { looseEndsScanNow } = await import("./HeadsUp.ts");
  const r = await looseEndsScanNow({}, { dryRun });
  const summary = { dryRun, found: r.found, fresh: r.lines.length, kinds: r.kinds, sources: r.sources, degraded: r.degraded, calls: r.calls };
  if (json) console.log(JSON.stringify({ ...summary, lines: r.lines }));
  else {
    console.log(JSON.stringify(summary, null, 2));
    for (const l of r.lines) console.log(l);
  }
  process.exit(scanExitCode(r.sources));
}
