/**
 * record.ts — Relay's writes to STATVS (Relay ISA F21). Every bridge event, every text in and out with its words,
 * every guard decision and one outcome per text land in the personal `relay` stream, and a text that goes wrong
 * raises one Vigil event. Own-channel values never enter a row: each becomes its role label, and when the config that
 * names them cannot be read nothing is written at all. Recording never throws, so a broken record cannot touch a
 * reply or a guard verdict (ISC-274); in the bridge the appends run on a worker thread, so a held STATVS lock never
 * stalls a text (ISC-282).
 *
 * Writes reach the live record only from the live Relay state dir, or wherever STATVS_DIR points. Under `bun test`
 * the default state dir is a path that does not exist, so a test that never calls setStateForTest writes nothing and
 * never touches the live guard cursor (ISC-287).
 * @version 1.1.0
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { append, scan, writeEventOnce } from "../../STATVS/index.ts";
import type { EventInput, StatvsInput } from "../../STATVS/index.ts";
import { getClaudeDir } from "../../TOOLS/Paths.ts";

export const STREAM = "relay";
export const LIVE_STATE = join(getClaudeDir(), "LIFEOS/USER/RELAY/state");
export type Writer = "lib:relay" | "lib:relay-guard";
export type Role = "principal" | "contact";

// ── sinks ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Sinks = { append: (row: StatvsInput) => unknown; alert: (event: EventInput) => unknown };
let sinks: Sinks = { append, alert: writeEventOnce };
/** Tests swap the sinks to watch rows or to make the record fail; the returned function restores them. */
export function setSinksForTest(next: Partial<Sinks>): () => void {
  const prev = sinks;
  sinks = { ...sinks, ...next };
  return () => { sinks = prev; };
}

/** The bridge calls this once at start: appends and alerts go to a worker thread from then on, in order. A refusal
 *  is then known only to the worker, which writes the refusal row itself (record-worker.ts). */
export function useWorkerSinks(): boolean {
  try {
    const worker = new Worker(new URL("./record-worker.ts", import.meta.url).href);
    worker.unref();
    worker.addEventListener("error", (e) => console.error(`[relay-record] worker: ${String((e as ErrorEvent).message ?? e).slice(0, 160)}`));
    sinks = { append: (row) => { worker.postMessage({ kind: "append", row }); return undefined; }, alert: (event) => { worker.postMessage({ kind: "alert", event }); return undefined; } };
    return true;
  } catch (e) {
    console.error(`[relay-record] no worker, writing on this thread: ${String(e).slice(0, 160)}`);
    return false;
  }
}

let defaultState = process.env.NODE_ENV === "test" ? join(tmpdir(), `relay-record-test-state-unset-${process.pid}`) : LIVE_STATE;
/** Tests point the recorder at a temp state dir, so masking reads a fixture config instead of the live one. */
export function setStateForTest(dir: string): () => void { const prev = defaultState; defaultState = dir; return () => { defaultState = prev; }; }

function enabled(stateDir: string): boolean {
  return !!process.env.STATVS_DIR || process.env.NODE_ENV === "test" || resolve(stateDir) === resolve(LIVE_STATE);
}

// ── masking ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Own-channel values by kind: phone tails keyed by digit length (7–10), emails in canonical form. */
export interface Masks { tails: Map<number, Map<string, { role: Role; full: string }>>; emails: Map<string, Role> }
const maskCache = new Map<string, { mtime: number; masks: Masks }>();
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const digitsOf = (s: string): string => s.normalize("NFKC").replace(/\D/g, "");
/** One spelling per address: NFKC, lowercase, and the local part's +tag dropped. */
export const canonicalEmail = (e: string): string => {
  const [local = "", domain = ""] = e.normalize("NFKC").toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
};

/** Every number and email that names the principal or a trusted contact, from the bridge config; null when the
 *  config cannot be read, which stops every write (ISC-281). */
export function masksFor(stateDir: string): Masks | null {
  const path = join(stateDir, "bridge-config.json");
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { return null; }
  const hit = maskCache.get(stateDir);
  if (hit && hit.mtime === mtime) return hit.masks;
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const out: Masks = { tails: new Map(), emails: new Map() };
  const add = (role: Role, values: string[]) => {
    for (const v of values) {
      if (v.includes("@")) { const c = canonicalEmail(v); if (!out.emails.has(c)) out.emails.set(c, role); continue; }
      const d = digitsOf(v);
      if (d.length < 7) continue;
      const tail = d.slice(-10);
      const byLen = out.tails.get(tail.length) ?? new Map<string, { role: Role; full: string }>();
      if (!byLen.has(tail)) byLen.set(tail, { role, full: d });
      out.tails.set(tail.length, byLen);
    }
  };
  // Principal first, so a value listed in both places reads as the principal.
  add("principal", [...strings(raw?.allowFrom), ...strings(raw?.ownChannels?.numbers), ...strings(raw?.ownChannels?.emails)]);
  add("contact", [...strings(raw?.chatFrom), ...strings(raw?.contactChannels?.numbers), ...strings(raw?.contactChannels?.emails)]);
  maskCache.set(stateDir, { mtime, masks: out });
  return out;
}

/** The longest separator run allowed between two digits of one number: "(555) 555-0100" has two. */
const MAX_GAP = 3;
/** Spans [start, end) of every own number in s, however it is written: any separators, any digit script, and
 *  whatever digits stand on either side of it (ISC-279). */
function ownNumberSpans(s: string, m: Masks): Array<[number, number, Role]> {
  const pos: number[] = [];
  let digits = "";
  for (let i = 0; i < s.length; i++) {
    const d = s[i]!.normalize("NFKC");
    if (d.length === 1 && d >= "0" && d <= "9") { digits += d; pos.push(i); }
  }
  const spans: Array<[number, number, Role]> = [];
  for (const [len, set] of m.tails) {
    for (let i = 0; i + len <= digits.length; i++) {
      const hit = set.get(digits.slice(i, i + len));
      if (!hit) continue;
      const joined = (from: number, to: number) => { for (let k = from + 1; k <= to; k++) if (pos[k]! - pos[k - 1]! - 1 > MAX_GAP) return false; return true; };
      if (!joined(i, i + len - 1)) continue;
      // Take in the stored number's country code and a leading "+" when they are written in front of it.
      let first = i;
      const prefix = hit.full.slice(0, hit.full.length - len);
      if (prefix && i >= prefix.length && digits.slice(i - prefix.length, i) === prefix && joined(i - prefix.length, i)) first = i - prefix.length;
      let start = pos[first]!;
      while (start > 0 && /[\s(]/.test(s[start - 1]!) && s.slice(0, start).trimEnd().endsWith("+")) start--;
      if (start > 0 && s[start - 1] === "+") start--;
      spans.push([start, pos[i + len - 1]! + 1, hit.role]);
    }
  }
  return spans;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

function maskString(s: string, m: Masks): string {
  let out = s.replace(EMAIL, (e) => { const role = m.emails.get(canonicalEmail(e)); return role ? `[${role}]` : e; });
  // Widest first, then right to left, so overlapping spans collapse into one label and indexes stay valid.
  const spans = ownNumberSpans(out, m).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let floor = Infinity;
  for (const [start, end, role] of spans) {
    if (end > floor) continue; // inside a span already replaced
    out = out.slice(0, start) + `[${role}]` + out.slice(end);
    floor = start;
  }
  return out;
}

/** The value with every own-channel number and email replaced by its role label, at any depth, keys included. */
export function scrub<T>(value: T, m: Masks): T {
  if (typeof value === "string") return maskString(value, m) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, m)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskString(k, m), scrub(v, m)])) as T;
  return value;
}

/** True when a scrubbed value still carries an own-channel value, by the same detector: the pre-write check. */
export function leaks(value: unknown, m: Masks): boolean {
  const text = JSON.stringify(value);
  if (ownNumberSpans(text, m).length) return true;
  for (const e of text.match(EMAIL) ?? []) if (m.emails.has(canonicalEmail(e))) return true;
  return false;
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Bridge and guard events Vigil used to read out of the logs; Relay now raises them itself (ISC-276, parity). */
export const NOTICED: Record<string, [string, EventInput["severity"]]> = {
  bridge_starting: ["Relay restarted", "low"],
  session_dropped_after_errors: ["Relay dropped a session after errors", "medium"],
  fail_closed: ["Relay guard failed closed", "high"],
  drop_not_allowlisted: ["Relay dropped a message from an unknown sender", "medium"],
};

/** What stays of a refused row: its event, turn and the refusal, never the refused content (ISC-286). */
export function refusalRow(row: StatvsInput, reason: string): StatvsInput {
  const d = (row.data ?? {}) as Record<string, unknown>;
  return { ...row, data: { event: d.event, ...(d.turn ? { turn: d.turn } : {}), refused: reason.slice(0, 120) } };
}

/** One `relay` row. A row STATVS refuses (a credential-shaped field) is replaced by its refusal row. */
export function recordEvent(writer: Writer, event: string, data: Record<string, unknown> = {}, stateDir = defaultState): void {
  try {
    if (!enabled(stateDir)) return;
    const m = masksFor(stateDir);
    if (!m) { console.error(`[relay-record] ${event}: bridge config unreadable, nothing written`); return; }
    const ts = typeof data.ts === "string" ? data.ts : new Date().toISOString();
    const body = scrub({ event, ...data }, m);
    if (leaks(body, m)) { console.error(`[relay-record] ${event}: an own-channel value survived scrubbing; row not written`); return; }
    const row: StatvsInput = { writer, stream: STREAM, class: "personal", ts, data: body };
    const r = sinks.append(row) as { ok?: boolean; refused?: string } | undefined;
    if (r && r.ok === false && typeof r.refused === "string") sinks.append(refusalRow(row, r.refused));
    const noticed = NOTICED[event];
    // Only a fresh event raises: a row copied late (the guard follower after a restart) is recorded, not re-announced.
    // One event per kind per hour, so a burst of unknown senders is one notice.
    if (noticed && Date.now() - Date.parse(ts) < 15 * 60_000) raise(noticed[1], noticed[0], `${writer === "lib:relay-guard" ? "guard" : "bridge"} recorded ${event}.`, `relay:${event}:${ts.slice(0, 13)}`, stateDir, "security");
  } catch (e) {
    console.error(`[relay-record] ${event}: ${String(e).slice(0, 160)}`);
  }
}

/** One Vigil event through STATVS, once per dedup key. Scrubbed in full before anything is cut. */
export function raise(severity: EventInput["severity"], title: string, summary: string, dedupKey: string, stateDir = defaultState, kind: EventInput["kind"] = "infra"): void {
  try {
    if (!enabled(stateDir)) return;
    const m = masksFor(stateDir);
    if (!m) return;
    const clean = scrub({ title, summary, dedupKey }, m);
    const event = { source: "relay", ts: new Date().toISOString(), kind, severity, title: clean.title.slice(0, 140), summary: clean.summary.slice(0, 1000), privacy_class: "personal", dedup_key: clean.dedupKey } as EventInput;
    if (leaks(event, m)) return;
    sinks.alert(event);
  } catch (e) {
    console.error(`[relay-record] alert ${dedupKey}: ${String(e).slice(0, 160)}`);
  }
}

// ── guard decisions ─────────────────────────────────────────────────────────────────────────────────────────────

/** Read at most this much guard.log per pass, so a long backlog never lands as one allocation. */
const FOLLOW_CHUNK = 1 << 20;
type Cursor = { ino: number; offset: number };
const memCursor = new Map<string, Cursor>();

function saveCursor(path: string, c: Cursor): void {
  memCursor.set(path, c);
  try { writeFileSync(`${path}.tmp`, JSON.stringify(c), { mode: 0o600 }); renameSync(`${path}.tmp`, path); } catch { /* the in-memory cursor holds the place */ }
}
function loadCursor(path: string): Cursor | null {
  try { const c = JSON.parse(readFileSync(path, "utf8")); if (Number.isFinite(c?.ino) && Number.isFinite(c?.offset)) return c; } catch { /* absent or torn */ }
  return memCursor.get(path) ?? null;
}

/** Copy the complete lines of one file from `offset`, at most one chunk. Returns the new offset and rows copied. */
function copyLines(file: string, offset: number, stateDir: string): { offset: number; copied: number } {
  const size = statSync(file).size;
  if (size <= offset) return { offset, copied: 0 };
  const len = Math.min(size - offset, FOLLOW_CHUNK);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, len, offset); } finally { closeSync(fd); }
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { offset, copied: 0 }; // a line still being written
  let copied = 0;
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const { event, ...rest } = JSON.parse(line) as Record<string, unknown>; recordEvent("lib:relay-guard", String(event ?? "unknown"), rest, stateDir); }
    catch { recordEvent("lib:relay-guard", "unparsed_line", { chars: line.length }, stateDir); }
    copied++;
  }
  return { offset: offset + end + 1, copied };
}

/** Copies new guard.log lines into the record (ISC-270). The guard hook imports only its own core (ISC-171), so the
 *  bridge, which outlives every hook call, carries its decisions to STATVS. A cursor keeps the place across
 *  restarts; with none it starts at the current end, so history stays in guard.log and nothing old is re-announced.
 *  After a rotation the rest of guard.log.1 is read before the new file (ISC-286). Never throws. */
export function followGuardLog(stateDir = defaultState): number {
  try {
    if (!enabled(stateDir)) return 0;
    const path = join(stateDir, "guard.log");
    const cursorPath = join(stateDir, "guard-record-cursor.json");
    if (!existsSync(path)) return 0;
    const st = statSync(path);
    let cur = loadCursor(cursorPath);
    if (!cur) { saveCursor(cursorPath, { ino: st.ino, offset: st.size }); recordEvent("lib:relay-guard", "guard_follow_started", { offset: st.size }, stateDir); return 0; }
    let copied = 0;
    if (cur.ino !== st.ino) {
      const old = `${path}.1`;
      if (existsSync(old) && statSync(old).ino === cur.ino) {
        let o = cur.offset;
        for (;;) { const r = copyLines(old, o, stateDir); copied += r.copied; if (r.offset === o) break; o = r.offset; }
      }
      cur = { ino: st.ino, offset: 0 };
    } else if (cur.offset > st.size) cur = { ino: st.ino, offset: 0 }; // truncated in place
    const r = copyLines(path, cur.offset, stateDir);
    saveCursor(cursorPath, { ino: st.ino, offset: r.offset });
    return copied + r.copied;
  } catch (e) {
    console.error(`[relay-record] guard follow: ${String(e).slice(0, 160)}`);
    return 0;
  }
}

// ── outcomes ────────────────────────────────────────────────────────────────────────────────────────────────────

export type Outcome = "answered" | "acknowledged" | "dropped" | "duplicate" | "stopped" | "cancelled" | "failed" | "error" | "unanswered" | "lost";
/** The outcomes that mean a principal text went wrong; any of them raises a high event (ISC-272, ISC-283). A cancel
 *  follows the principal's own "stop", and a duplicate is a second delivery of a text already handled. */
export const BAD_OUTCOMES: readonly Outcome[] = ["failed", "error", "unanswered", "dropped", "lost"];
/** Whether a principal turn's outcome raises: a late error after the reply went out is recorded, not raised. */
export const raises = (outcome: Outcome, sentReplies: number): boolean => BAD_OUTCOMES.includes(outcome) && !(outcome === "error" && sentReplies > 0);

/** How a turn ended, read from what it logged and sent. Anything unrecognized that sent nothing is `unanswered`,
 *  so a new path that forgets to reply is caught without being listed here. */
export function classify(events: string[], sentReplies: number, error?: unknown): { outcome: Outcome; reason: string } {
  const has = (e: string) => events.includes(e);
  const failed = events.find((e) => e.startsWith("ask_failed:")) ?? events.find((e) => e === "attachment_failed" || e === "chat_failed");
  if (error !== undefined) return { outcome: "error", reason: String(error) };
  if (failed) return { outcome: "failed", reason: failed.startsWith("ask_failed:") ? failed.slice("ask_failed:".length) : failed };
  if (has("stopped_by_principal")) return { outcome: "stopped", reason: "stop" };
  if (has("task_cancelled_no_reply")) return { outcome: "cancelled", reason: "cancelled without a reply" };
  if (has("duplicate_inbound")) return { outcome: "duplicate", reason: "duplicate_inbound" };
  const drop = events.find((e) => e.startsWith("drop_"));
  if (drop) return { outcome: "dropped", reason: drop };
  if (has("replied") || (has("workflow_tapback") && sentReplies > 0)) return { outcome: "answered", reason: "replied" };
  if (has("acknowledged_by_tapback") || has("tapback") || has("workflow_tapback")) return { outcome: "acknowledged", reason: events.find((e) => e.includes("tapback"))! };
  if (sentReplies > 0) return { outcome: "answered", reason: "sent" };
  // Relay F32 ISC-408: a group line that did not name the DA is kept as context; no reply is owed.
  if (has("group_context")) return { outcome: "acknowledged", reason: "group_context" };
  return { outcome: "unanswered", reason: events.length ? `last event ${events[events.length - 1]}` : "no event" };
}

/** At bridge start: a principal text from the last two days with no outcome was cut off by a restart or crash. Each
 *  gets a `lost` outcome, and together they raise one event (ISC-283). Returns the turns closed. */
export function closeLostTurns(stateDir = defaultState, startedAt = Date.now(), dir?: string): number {
  try {
    if (!enabled(stateDir)) return 0;
    const rows = scan({ streams: [STREAM], classes: ["personal"], fromDate: new Date(startedAt - 2 * 86_400_000).toISOString().slice(0, 10), ...(dir ? { dir } : {}) }).rows
      .filter((r) => r.stream === STREAM);
    const data = (r: { data?: unknown }) => (r.data ?? {}) as Record<string, unknown>;
    const ended = new Set(rows.filter((r) => data(r).event === "outcome").map((r) => String(data(r).turn)));
    const lost = rows.filter((r) => { const d = data(r); return d.event === "text_in" && d.role === "principal" && !ended.has(String(d.turn)) && Date.parse(r.ts) < startedAt; });
    for (const r of lost) recordEvent("lib:relay", "outcome", { turn: data(r).turn, thread: data(r).thread, role: "principal", outcome: "lost", reason: "the bridge stopped mid-turn" }, stateDir);
    if (lost.length) raise("high", "A text to Relay went unanswered: lost", `${lost.length} text(s) from the principal were cut off when the bridge stopped.`, `relay:outcome:lost:${new Date(startedAt).toISOString().slice(0, 10)}`, stateDir);
    return lost.length;
  } catch (e) {
    console.error(`[relay-record] lost turns: ${String(e).slice(0, 160)}`);
    return 0;
  }
}
