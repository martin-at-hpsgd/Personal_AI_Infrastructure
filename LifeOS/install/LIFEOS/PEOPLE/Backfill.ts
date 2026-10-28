/**
 * Backfill.ts — the one-time fill of per-person history for exchanges from before rows carried a person
 * (conversation-memory ISA ISC-24; run by `people backfill`).
 *
 * Three sources, each written by `tool:people-backfill` on the stream of the fact (`relay` for texts and group
 * members, `mail` for mail), every row marked `backfill: true` with the exchange's original time and a `key` that
 * makes a re-run add nothing. A text row's event is `text`, never `text_in` or `text_out`, so no Relay reader (lost
 * turns, Status) takes an old exchange for a live one:
 *
 *   1. The Relay conversation store (and its pre-change snapshots): every contact and group message. A store folder
 *      is named by a hash of [sender, thread], so its owner is found by hashing candidate pairs: every handle People,
 *      Security Rings and the bridge config know, against every thread the record names and each handle's own DM
 *      thread ids. The principal's own threads are skipped; they are not a contact's history.
 *   2. `lib:relay` text rows written before rows carried a person, for messages the store no longer holds. A turn is
 *      tied to its person through the store message with the same id; a group row keeps its group.
 *   3. The DA mailbox's Sent folder, read through `gmail.ts sent-meta`: one `email_out` row per message, each
 *      recipient by People id, never an address.
 *
 * Message text is masked exactly as Relay masks its own rows (own-channel numbers and addresses become role labels),
 * and nothing is written when the bridge config those masks come from cannot be read. Output is names and counts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { append, listSegments, statvsDir, type StatvsInput, type StatvsRow } from "../STATVS/index.ts";
import { handlesOf } from "../RINGS/policy.ts";
import { invariant } from "../TOOLS/Invariant.ts";
import { daMailAccount, mailRecipients, mailRow } from "../TOOLS/gmail.ts";
import { leaks, LIVE_STATE, masksFor, scrub, type Masks } from "../RELAY/bridge/record.ts";
import { historyOf, historyRoot, HistoryShards, openHistory } from "./History.ts";
import { HISTORY_FILES, HISTORY_STREAMS } from "./HistoryFacts.ts";
import { canonicalId, recordableForHandle, recordableId, resolveIn, scrubContact, UNKNOWN_ID, type Index } from "./Identity.ts";

export const WRITER = "tool:people-backfill";
/** The stream a backfilled fact goes to: the stream the same fact goes to live. */
export const streamFor = (event: unknown): "relay" | "mail" => (event === "email_out" ? "mail" : "relay");
const GROUP_SENDER = "group";
const DM_PREFIXES = ["iMessage", "SMS", "RCS", "any"];
/** How close a record row and a store message must be in time to be taken for the same send. */
const SAME_SEND_MS = 10 * 60_000;

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const isGroupThread = (t: string | undefined) => !!t && t.includes(";+;");

interface StoreMessage { id: string; timestamp: string; direction: "inbound" | "outbound"; text: string; source?: string; replyTo?: string; speaker?: { id?: string; name?: string; role?: string } }
export interface StoreFolder { name: string; messages: StoreMessage[] }
export interface BridgeConfig { principal: string[]; trusted: string[] }
export interface SentMeta { id: string; threadId?: string; ts?: string | null; to?: string; cc?: string; bcc?: string; subject?: string; error?: string }

export interface BackfillInput {
  ix: Index;
  /** Every store folder, from the live store and its snapshots, merged by folder name. */
  folders: StoreFolder[];
  /** The rows the history already reads (live and earlier backfill). */
  rows: StatvsRow[];
  config: BridgeConfig;
  masks: Masks;
  /** The DA mailbox's Sent folder, or null when mail is not part of this run. */
  sent: SentMeta[] | null;
}

export interface BackfillCounts {
  folders: number; principalFolders: number; unattributedFolders: number;
  /** Every row the run would write, the group member lists included. */
  rows: number;
  storeMessages: number; recordRows: number; recordUnattributed: number; mail: number; mailErrors: number;
  alreadyRecorded: number;
}
export interface BackfillPlan { rows: StatvsInput[]; counts: BackfillCounts }

// ── reading the sources ─────────────────────────────────────────────────────────────────────────────────────────

/** Store folders from the live store and every `conversations-snapshot-*` beside it, one entry per folder name with
 *  its messages merged by id. Reads only. */
export function readStore(stateDir = LIVE_STATE): StoreFolder[] {
  const roots = [join(stateDir, "conversations"), ...safeList(stateDir).filter(n => n.startsWith("conversations-snapshot-")).map(n => join(stateDir, n))];
  const byName = new Map<string, Map<string, StoreMessage>>();
  for (const root of roots) {
    for (const name of safeList(root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const msgs = byName.get(name) ?? byName.set(name, new Map()).get(name)!;
      for (const file of safeList(join(root, name))) {
        if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
        try {
          const m = JSON.parse(readFileSync(join(root, name, file), "utf8")) as StoreMessage;
          if (typeof m?.id === "string" && typeof m.text === "string" && Number.isFinite(Date.parse(m.timestamp)) && (m.direction === "inbound" || m.direction === "outbound") && !msgs.has(m.id)) msgs.set(m.id, m);
        } catch { /* an interrupted write is no message */ }
      }
    }
  }
  return [...byName].map(([name, msgs]) => ({ name, messages: [...msgs.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id)) }));
}

function safeList(dir: string): string[] { try { return readdirSync(dir); } catch { return []; } }

/** The principal's and the trusted contacts' handles from the bridge config, or null when it cannot be read. */
export function readBridgeConfig(stateDir = LIVE_STATE): BridgeConfig | null {
  let raw: any;
  try { raw = JSON.parse(readFileSync(join(stateDir, "bridge-config.json"), "utf8")); } catch { return null; }
  const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return {
    principal: [...list(raw?.allowFrom), ...list(raw?.ownChannels?.numbers), ...list(raw?.ownChannels?.emails)],
    trusted: [...list(raw?.chatFrom), ...list(raw?.contactChannels?.numbers), ...list(raw?.contactChannels?.emails)],
  };
}

/** The DA mailbox's Sent folder through `gmail.ts sent-meta`, or null when there is no DA mailbox. Throws when the
 *  read fails, so a run never mistakes a broken read for an empty folder. */
export function readSentMail(max = 2000, account = daMailAccount()): SentMeta[] | null {
  if (!account) return null;
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../TOOLS/gmail.ts"), "--account", account, "sent-meta", String(max)], { stdout: "pipe", stderr: "pipe", timeout: 180_000 });
  if (r.exitCode !== 0) throw new Error(`gmail.ts sent-meta failed (exit ${r.exitCode}): ${r.stderr.toString().slice(0, 200)}`);
  return r.stdout.toString().split("\n").filter(Boolean).map(l => JSON.parse(l) as SentMeta);
}

// ── who owns a store folder ─────────────────────────────────────────────────────────────────────────────────────

export type Owner = { kind: "principal" } | { kind: "contact"; handle: string } | { kind: "group"; thread: string };

/** Every thread id the record names: Relay rows' `thread`, a Linq `chatId`, and a `chat:<id>` send target. */
export function recordThreads(rows: StatvsRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const d = r.data as Data;
    const t = str(d.thread); if (t && !t.includes("[")) out.add(t);
    const c = str(d.chatId); if (c) out.add(`linq;+;${c}`);
    const g = str(d.to)?.match(/^chat:([0-9a-f-]{36})$/i)?.[1]; if (g) out.add(`linq;+;${g}`);
  }
  return out;
}

/** Each store folder's owner, found by hashing candidate [sender, thread] pairs the way the store names folders. */
export function folderOwners(names: Set<string>, handles: Iterable<string>, threads: Set<string>, principal: Set<string>): Map<string, Owner> {
  const out = new Map<string, Owner>();
  const hit = (sender: string, thread: string): boolean => {
    const name = hash(JSON.stringify([sender, thread]));
    if (!names.has(name) || out.has(name)) return false;
    out.set(name, sender === GROUP_SENDER ? { kind: "group", thread } : principal.has(sender) ? { kind: "principal" } : { kind: "contact", handle: sender });
    return true;
  };
  for (const t of threads) hit(GROUP_SENDER, t);
  for (const h of new Set(handles)) {
    for (const p of DM_PREFIXES) hit(h, `${p};-;${h}`);
    for (const t of threads) hit(h, t);
  }
  return out;
}

// ── planning ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The rows a backfill run would write, and what it found. Pure: reads nothing, writes nothing. */
export function planBackfill(input: BackfillInput): BackfillPlan {
  const { ix, folders, rows, config, masks } = input;
  const counts: BackfillCounts = { rows: 0, folders: folders.length, principalFolders: 0, unattributedFolders: 0, storeMessages: 0, recordRows: 0, recordUnattributed: 0, mail: 0, mailErrors: 0, alreadyRecorded: 0 };
  const done = new Set<string>();
  const live = new Set<string>();
  for (const r of rows) {
    const d = r.data as Data;
    if (d.backfill === true) { const k = str(d.key); if (k) done.add(k); continue; }
    if (d.event === "email_out") { const m = str(d.message_id); if (m) live.add(`mail:${m}`); continue; }
    if (!("person" in d)) continue;
    const turn = str(d.turn), message = str(d.message);
    if (d.event === "text_in" && turn) live.add(`in:${turn}`);
    if ((d.event === "text_out" || d.event === "voice_out") && turn) live.add(`outturn:${turn}`);
    if (message) live.add(`msg:${message}`);
  }
  const out: StatvsInput[] = [];
  const planned = new Set<string>();
  /** Queue one row unless its fact is already recorded, live or by an earlier run, or already planned. */
  const add = (ts: string, data: Data, keys: string[]): boolean => {
    const key = keys[0]!;
    if (done.has(key) || planned.has(key) || keys.some(k => live.has(k))) { counts.alreadyRecorded++; return false; }
    planned.add(key);
    out.push({ writer: WRITER, stream: streamFor(data.event), class: "personal", ts, data: { ...data, backfill: true, key, keys } });
    return true;
  };
  const clean = (text: string): string => scrub(text, masks);

  const principalSet = new Set(config.principal);
  const principalPerson = config.principal.map(h => resolveIn(h, ix)).find(Boolean);
  const principalId = principalPerson ? recordableId(principalPerson.id) : UNKNOWN_ID;
  const handles = new Set<string>([...config.principal, ...config.trusted]);
  for (const r of ix.byId.values()) for (const h of handlesOf(r)) handles.add(h);
  const owners = folderOwners(new Set(folders.map(f => f.name)), handles, recordThreads(rows), principalSet);

  // A group line from before speakers were stored opens with the speaker's name; it is matched only against the
  // people the bridge trusts, since no one else can be in an answered group.
  const trustedByName = new Map<string, string>();
  for (const h of [...config.principal, ...config.trusted]) {
    const p = resolveIn(h, ix);
    if (p && !trustedByName.has(p.name)) trustedByName.set(p.name, recordableId(p.id));
  }
  const turnOwner = new Map<string, Owner>(); // inbound store message id → its folder's owner
  const storeOutByTurn = new Set<string>();
  const storeOut: Array<{ owner: Owner; ts: number; text: string }> = [];

  for (const f of folders) {
    const owner = owners.get(f.name);
    if (!owner) {
      // A folder no candidate pair names: the principal's when every inbound is his, otherwise unattributed.
      if (f.messages.every(m => m.direction === "outbound" || m.source === "principal")) counts.principalFolders++;
      else counts.unattributedFolders++;
      continue;
    }
    if (owner.kind === "principal") { counts.principalFolders++; continue; }
    const groupMembers = new Set<string>();
    for (const m of f.messages) {
      if (m.direction === "inbound") turnOwner.set(m.id, owner);
      else { if (m.replyTo) storeOutByTurn.add(m.replyTo); storeOut.push({ owner, ts: Date.parse(m.timestamp), text: m.text.trim() }); }
      const keys = m.direction === "inbound" ? [`in:${m.id}`] : [`msg:${m.id}`, ...(m.replyTo ? [`outturn:${m.replyTo}`] : [])];
      if (owner.kind === "contact") {
        const person = recordableForHandle(owner.handle, ix);
        if (add(m.timestamp, { event: "text", source: "conversation", group: false, direction: m.direction === "inbound" ? "in" : "out", person, text: clean(m.text), ...(m.replyTo ? { turn: m.replyTo } : {}), ...(m.direction === "outbound" ? { message: m.id } : {}) }, keys)) counts.storeMessages++;
        continue;
      }
      if (m.direction === "outbound") {
        if (add(m.timestamp, { event: "text", source: "conversation", group: true, thread: owner.thread, direction: "out", text: clean(m.text), ...(m.replyTo ? { turn: m.replyTo } : {}), message: m.id }, keys)) counts.storeMessages++;
        continue;
      }
      const { speaker, text } = groupSpeaker(m, trustedByName);
      if (speaker !== UNKNOWN_ID) groupMembers.add(speaker);
      const role = speaker !== UNKNOWN_ID && speaker === principalId ? { role: "principal" } : {};
      if (add(m.timestamp, { event: "text", source: "conversation", group: true, thread: owner.thread, direction: "in", person: speaker, ...role, text: clean(text) }, keys)) counts.storeMessages++;
    }
    if (owner.kind === "group" && groupMembers.size) {
      const members = [...groupMembers].sort();
      add(f.messages[0]!.timestamp, { event: "group_members", source: "conversation", thread: owner.thread, members }, [`members:${owner.thread}:${hash(members.join(",")).slice(0, 16)}`]);
    }
  }

  // Record rows from before rows carried a person, for what the store no longer holds.
  const ordinal = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))) {
    const d = r.data as Data;
    if (r.writer !== "lib:relay" || d.backfill === true || "person" in d) continue;
    const event = str(d.event);
    if (event !== "text_in" && event !== "text_out" && event !== "voice_out") continue;
    // Masked again with today's masks: a channel added since the row was written is masked too.
    const thread = str(d.thread), turn = str(d.turn), text = clean(str(d.text) ?? "");
    const group = isGroupThread(thread) ? thread : undefined;
    const ts = str(d.ts) ?? r.ts;
    // The principal's own DM, masked or not, is not a contact's history; nor is a group the bridge refused.
    if (!group && (d.role === "principal" || (thread ?? "").includes("[principal]") || d.toPrincipal === true)) continue;
    if (d.role === "other") continue;
    if (event === "text_in") {
      if (!turn) { counts.recordUnattributed++; continue; }
      const key = `in:${turn}`;
      if (planned.has(key) || done.has(key)) continue; // the store copy is already planned or written
      const owner = turnOwner.get(turn);
      if (group) {
        const person = d.role === "principal" ? principalId : UNKNOWN_ID;
        if (add(ts, { event: "text", source: "record", group: true, thread: group, direction: "in", person, ...(d.role === "principal" ? { role: "principal" } : {}), text, turn, row: r.id }, [key])) counts.recordRows++;
      } else if (owner?.kind === "contact") {
        if (add(ts, { event: "text", source: "record", group: false, direction: "in", person: recordableForHandle(owner.handle, ix), text, turn, row: r.id }, [key])) counts.recordRows++;
      } else counts.recordUnattributed++;
      continue;
    }
    if (turn) {
      if (storeOutByTurn.has(turn)) continue; // the store holds this turn's replies
      const n = (ordinal.get(turn) ?? 0) + 1;
      ordinal.set(turn, n);
      const key = `outturn:${turn}#${n}`;
      const owner = turnOwner.get(turn);
      if (group) { if (add(ts, { event: "text", source: "record", group: true, thread: group, direction: "out", text, turn, row: r.id }, [key, `outturn:${turn}`])) counts.recordRows++; }
      else if (owner?.kind === "contact") { if (add(ts, { event: "text", source: "record", group: false, direction: "out", person: recordableForHandle(owner.handle, ix), text, turn, row: r.id }, [key, `outturn:${turn}`])) counts.recordRows++; }
      else counts.recordUnattributed++;
      continue;
    }
    // A send.ts row: a group by its chat id, a contact only through the store copy of the same text.
    const chat = str(d.to)?.match(/^chat:([0-9a-f-]{36})$/i)?.[1];
    const at = Date.parse(ts);
    const twin = storeOut.find(s => s.text === text.trim() && Math.abs(s.ts - at) <= SAME_SEND_MS);
    if (twin) continue;
    if (chat) { if (add(ts, { event: "text", source: "record", group: true, thread: `linq;+;${chat}`, direction: "out", text, row: r.id }, [`send:${r.id}`])) counts.recordRows++; }
    else counts.recordUnattributed++;
  }

  // The DA mailbox's Sent folder.
  for (const m of input.sent ?? []) {
    if (m.error || !m.id) { counts.mailErrors++; continue; }
    const ts = m.ts ?? undefined;
    const row = mailRow({ to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, messageId: m.id, threadId: m.threadId, ...(ts ? { ts } : {}) }, mailRecipients(m, a => recordableForHandle(a, ix)), s => scrubContact(s, "[redacted]"));
    if (add(ts ?? new Date().toISOString(), { ...(row.data as Data), source: "gmail-sent" }, [`mail:${m.id}`])) counts.mail++;
  }
  counts.rows = out.length;
  return { rows: out, counts };
}

/** A store group line's speaker, as a recorded id, and its words without the "Name: " the store line opens with. */
function groupSpeaker(m: StoreMessage, trustedByName: Map<string, string>): { speaker: string; text: string } {
  if (m.speaker?.id) {
    const prefix = m.speaker.name ? `${m.speaker.name}: ` : "";
    return { speaker: m.speaker.id === UNKNOWN_ID ? UNKNOWN_ID : recordableId(m.speaker.id), text: prefix && m.text.startsWith(prefix) ? m.text.slice(prefix.length) : m.text };
  }
  const label = /^([^:\n]{1,80}): /.exec(m.text)?.[1];
  if (!label) return { speaker: UNKNOWN_ID, text: m.text };
  return { speaker: trustedByName.get(label) ?? UNKNOWN_ID, text: m.text.slice(label.length + 2) };
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/u;

export interface WriteResult { written: number; refused: number; spooled: number }

/** Append every planned row. Each is checked before it is written: a backfill row on the people stream, a key no
 *  earlier row holds, no own-channel value in it, and no raw address among its people or mail fields. */
export function writeBackfill(plan: BackfillPlan, masks: Masks, existingKeys: Set<string>, sink: (row: StatvsInput) => { ok: boolean; refused?: string; spooled?: boolean } = append): WriteResult {
  const res: WriteResult = { written: 0, refused: 0, spooled: 0 };
  const keys = new Set(existingKeys);
  // Every row is checked before the first is written, so a run that would break a rule writes nothing.
  for (const row of plan.rows) {
    const d = row.data as Data;
    const key = str(d.key);
    invariant(row.writer === WRITER && row.stream === streamFor(d.event) && d.backfill === true && d.event !== "text_in" && d.event !== "text_out", "a backfill row is a marked row on its fact's stream, never a live text event");
    invariant(!!key && !keys.has(key), "a backfill row's key is new, so a re-run adds nothing");
    invariant(!leaks(d, masks), "a backfill row carries no own-channel number or address");
    invariant(!ADDRESS.test(JSON.stringify({ person: d.person, members: d.members, recipients: d.recipients, subject: d.subject })), "a backfill row names people by id, never by address");
    keys.add(key!);
  }
  for (const row of plan.rows) {
    const r = sink(row);
    if (r.ok) res.written++; else if (r.spooled) res.spooled++; else res.refused++;
  }
  return res;
}

// ── what it means per person ────────────────────────────────────────────────────────────────────────────────────

export interface PersonCount { name: string; texts: number; groupWrote: number; groupPresent: number; emails: number }

/** The people a plan touches, as canonical record ids. */
function touched(plan: BackfillPlan, ix: Index): string[] {
  const byRecorded = new Map<string, string>();
  for (const id of ix.byId.keys()) byRecorded.set(recordableId(id), canonicalId(id, ix));
  const people = new Set<string>();
  for (const r of plan.rows) {
    const d = r.data as Data;
    const ids = [str(d.person), ...(Array.isArray(d.members) ? d.members : []), ...(Array.isArray(d.recipients) ? (d.recipients as Array<{ person?: unknown }>).map(x => x.person) : [])];
    for (const id of ids) { const c = typeof id === "string" ? byRecorded.get(id) : undefined; if (c) people.add(c); }
  }
  return [...people];
}

/** For every person the plan touches, how many of their history items the backfill holds: names and counts only. */
export function countsPerPerson(plan: BackfillPlan, projection: HistoryShards, ix: Index): PersonCount[] {
  return touched(plan, ix).map(id => {
    const items = historyOf(id, ix, projection, { all: true }).filter(i => i.backfill);
    return {
      name: scrubContact(ix.byId.get(id)?.name ?? "") || "an unnamed contact",
      texts: items.filter(i => i.thread === "1:1").length,
      groupWrote: items.filter(i => i.as === "wrote").length,
      groupPresent: items.filter(i => i.as === "present").length,
      emails: items.filter(i => i.channel === "email").length,
    };
  }).filter(c => c.texts + c.groupWrote + c.groupPresent + c.emails > 0).sort((a, b) => a.name.localeCompare(b.name));
}

/** The keys every earlier backfill row holds. */
export const existingBackfillKeys = (rows: StatvsRow[]): Set<string> =>
  new Set(rows.filter(r => (r.data as Data).backfill === true).map(r => str((r.data as Data).key)).filter((k): k is string => !!k));

/** The history writers' rows, read from their segments once: the backfill needs the rows from before rows carried a
 *  person, which the projection leaves out. A one-time read, never part of a lookup. */
export function recordRows(dir = statvsDir()): StatvsRow[] {
  const files = new Set(HISTORY_FILES);
  const streams = new Set<string>(HISTORY_STREAMS);
  const rows: StatvsRow[] = [];
  for (const seg of listSegments(dir, ["personal"])) {
    if (!files.has(seg.rel.slice(seg.rel.lastIndexOf("/") + 1))) continue;
    let text: string;
    try { text = readFileSync(seg.abs, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try { const row = JSON.parse(line) as StatvsRow; if (row && typeof row === "object" && streams.has(row.stream) && row.data && typeof row.data === "object") rows.push(row); }
      catch { /* a torn line is the record's to report */ }
    }
  }
  return rows;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunOptions { dryRun: boolean; mail: boolean; ix: Index; stateDir?: string; statvsDir?: string; historyDir?: string }
export interface RunResult { plan: BackfillCounts; perPerson: PersonCount[]; write?: WriteResult }

/** Plan, and unless dry, write and bring the history projection up to the record. A dry run counts against a scratch
 *  projection of the record plus the plan, in a temp folder removed after. Refuses when the bridge config (the masks)
 *  cannot be read. */
export function runBackfill(o: RunOptions, sent: SentMeta[] | null): RunResult {
  const stateDir = o.stateDir ?? LIVE_STATE;
  const masks = masksFor(stateDir);
  const config = readBridgeConfig(stateDir);
  if (!masks || !config) throw new Error("the Relay bridge config cannot be read, so message text cannot be masked; nothing planned");
  const recordDir = o.statvsDir ?? statvsDir();
  const rows = recordRows(recordDir);
  const plan = planBackfill({ ix: o.ix, folders: readStore(stateDir), rows, config, masks, sent: o.mail ? sent : null });
  if (o.dryRun) {
    const dir = mkdtempSync(join(tmpdir(), "people-backfill-dry-"));
    const scratch = new HistoryShards(dir);
    try {
      scratch.applyRows([...rows, ...plan.rows.map((r, i) => ({ ...(r as unknown as StatvsRow), id: `plan-${i}`, hlc: `plan-${String(i).padStart(8, "0")}`, ts: r.ts ?? "" }))]);
      return { plan: plan.counts, perPerson: countsPerPerson(plan, scratch, o.ix) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const write = writeBackfill(plan, masks, existingBackfillKeys(rows));
  const projection = openHistory(o.historyDir ?? historyRoot(), recordDir);
  return { plan: plan.counts, perPerson: countsPerPerson(plan, projection, o.ix), write };
}
