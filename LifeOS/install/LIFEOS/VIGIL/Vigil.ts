#!/usr/bin/env bun
/** Vigil command-line control surface. @version 0.7.0 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"; import { dirname, join } from "node:path"; import { randomUUID } from "node:crypto"; import { emit, forward } from "./Emit"; import { KINDS, PRIVACY_CLASSES, SEVERITIES, validateEvent, type VigilEvent } from "./Schema"; import { readJson, stateDir, statePath } from "./State"; import { deliverFixed, draftLookup, exitIfAbandoned, saveDraft, sentStories, tick } from "./Tick"; import { heartbeatStale } from "./Heartbeat"; import { heartbeatReport } from "./Heartbeats"; import { REGISTERED_ADAPTERS } from "./adapters"; import { feedbackPath } from "./Editor"; import { appendJson } from "./State"; import { invariant } from "../TOOLS/Invariant"; import { isAdvocateSource, loadPolicy } from "./Policy"; import { fixedJob, isWatchSource, jobEvent, JOB_CLASSES, storyKeyOf, type JobClass } from "./Route"; import { lifeosPath } from "../TOOLS/Paths"; import { injectedEvents, readLedgerTexts, readVigilSent, replayWith, type ReplayReport } from "./Replay"; import { ceiling } from "../TOOLS/Interruptions"; import { inQuietHours } from "../TOOLS/QuietHours"; import { worldWatchReport, worldWatchReportText } from "./WorldWatch";
const HELP = `Vigil 0.7.0\n\nSubcommands:\n  emit     append an event to the local outbox\n           job text (F12): emit --text-file <path> [--source S] [--ref job] [--class security|prep|decision|ops|news] [--key K] [--severity S] [--now]\n           --now sends prep, decision and high security at once when decider_mode is enforce\n  forward  ship unsent events\n  tick     collect and route events [--dry-run]\n  heartbeat exit 0 when the last tick is fresh [--json: every heartbeat, incl. workflows-dispatcher, with last beat and stale flag]\n  status   show local queue and cursor health\n  list     list events, local and pulled from the store [--limit N] [--source S] [--json]
  feedback label an editor decision or a shadow pair: feedback <event-id|last> good|noise|missed [note]
  shadow-report  job texts beside what Vigil would have done [--since 24h] [--json]
  world-watch-report  per watchlist group: matches, bursts, texts and feedback labels (F18) [--days 7] [--json]
  replay   read-only: the last N days of texts with a source's events added [--days 7] --with <source> [--per-day 3] [--json]; exit 1 when it would text more than once a day or hold a text that went out
  queue    the held and deferred items for the morning brief, ranked, three at most, plus one counted Watches entry for every watch-* item outside that cap [--since 24h] [--max 3] [--json]`;
const args = process.argv.slice(2), cmd = args[0]; const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const jsonl = <T>(name: string): T[] => existsSync(statePath(name)) ? readFileSync(statePath(name), "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x) as T) : [];
function rows(): VigilEvent[] { return jsonl<VigilEvent>("outbox.jsonl"); }
/** A cursor file belongs to a registered adapter when it is `<name>.json`, `<name>.read.json`, or a `<name>_<part>` sidecar (ISC-95). */
export const registeredCursor = (file: string): boolean => REGISTERED_ADAPTERS.some((name) => file === `${name}.json` || file === `${name}.read.json` || file.startsWith(`${name}_`));
type EditorRow = { ts: string; event_id: string; title: string; action: string; verdict: string; why: string };
/** One job text beside Vigil's would-decision (F12 ISC-143). `would` is "pending" until the next tick decides it. */
export type ShadowPair = { ts: string; event_id: string; origin: string; class: string; key: string; actual: string; would: "send" | "hold" | "pending"; reason: string; draft: string; label: string | null };
type DraftRow = { event_id: string; text: string };
/** Shadow labels stay out of the editor's prompt: they judge job texts, not news picks. */
export const shadowFeedbackPath = (): string => join(dirname(feedbackPath()), "shadow-feedback.jsonl");
const jsonlAt = <T>(path: string): T[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((x) => { try { return [JSON.parse(x) as T]; } catch { return []; } }) : [];
export function shadowPairs(sinceMs = Number.POSITIVE_INFINITY, now = new Date(), all: VigilEvent[] = rows()): ShadowPair[] {
  const notes = new Map(all.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.shadow === true && e.ref).map((e) => [e.ref!, e] as const));
  const drafts = new Map(jsonl<DraftRow>("shadow-drafts.jsonl").map((d) => [d.event_id, d.text] as const)), labels = new Map(jsonlAt<{ event_id: string; label: string }>(shadowFeedbackPath()).map((l) => [l.event_id, l.label] as const));
  const cutoff = now.getTime() - sinceMs;
  return all.filter((e) => e.source !== "vigil" && e.meta?.shadow === true && Date.parse(e.ts) >= cutoff).sort((a, b) => a.ts.localeCompare(b.ts)).map((e): ShadowPair => {
    const note = notes.get(e.id), decision = String(note?.meta?.decision ?? ""), draft = drafts.get(e.id);
    return { ts: e.ts, event_id: e.id, origin: String(e.meta?.origin ?? e.ref ?? e.source), class: String(e.meta?.class ?? "ops"), key: String(e.meta?.key ?? ""), actual: String(e.meta?.actual ?? "unknown"), would: decision === "shadow-send" ? "send" : decision === "shadow-hold" ? "hold" : "pending", reason: note ? String(note.meta?.reason ?? "") : "not decided yet (next tick)", draft: draft === undefined ? "(draft missing)" : draft.replace(/\s+/g, " ").slice(0, 80), label: labels.get(e.id) ?? null };
  });
}
/** "24h", "90m", "7d" → milliseconds. */
export function parseSince(value: string): number { const m = value.match(/^(\d+)([mhd])$/); if (!m) throw new Error("--since takes a number and m, h or d, e.g. 24h"); return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]; }
export function shadowReportText(pairs: ShadowPair[]): string {
  const local = (ts: string) => new Date(ts).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
  const lines = pairs.map((p) => `${local(p.ts)}  ${p.origin}  ${p.class}  ${p.key}  actual=${p.actual}  would=${p.would}  (${p.reason})${p.label ? `  label=${p.label}` : ""}  ${p.event_id}\n    "${p.draft}"`);
  return [`${pairs.length} shadow pair${pairs.length === 1 ? "" : "s"}`, ...lines, "Label a pair: bun LIFEOS/VIGIL/Vigil.ts feedback <event-id> good|noise|missed [note]"].join("\n");
}
function shadowFeedback(target: string, label: string, note: string, pairs: ShadowPair[]): Record<string, string> | null {
  const pair = pairs.filter((p) => p.event_id === target || p.event_id.startsWith(target)).at(-1); if (!pair) return null;
  const line = { ts: new Date().toISOString(), event_id: pair.event_id, title: `${pair.origin} ${pair.class} ${pair.key}`.slice(0, 140), verdict: `would-${pair.would}`, actual: pair.actual, label, ...(note ? { note: note.slice(0, 200) } : {}) };
  invariant(line.event_id.length > 0 && ["good", "noise", "missed"].includes(line.label), "shadow label names a pair and a known label");
  appendJson(shadowFeedbackPath(), line);
  return line;
}
/** Label an editor decision so the next tick's prompt carries it (ISC-120), or a shadow pair (F12 ISC-143) into its own file. */
export function feedback(target: string, label: string, note: string, editorRows: EditorRow[] = jsonl<EditorRow>("editor.jsonl"), pairs: () => ShadowPair[] = () => shadowPairs()): Record<string, string> {
  if (!["good", "noise", "missed"].includes(label)) throw new Error("feedback label must be good, noise, or missed");
  const row = target === "last" ? editorRows.filter((r) => r.action === "text").at(-1) : editorRows.filter((r) => r.event_id === target || r.event_id.startsWith(target)).at(-1);
  if (!row && target !== "last") { const shadow = shadowFeedback(target, label, note, pairs()); if (shadow) return shadow; }
  if (!row) throw new Error(target === "last" ? "no editor text on record yet" : `no editor decision or shadow pair for ${target}`);
  const line = { ts: new Date().toISOString(), event_id: row.event_id, title: row.title.slice(0, 140), verdict: row.verdict, label, ...(note ? { note: note.slice(0, 200) } : {}) };
  appendJson(feedbackPath(), line);
  return line;
}
/**
 * F12 ISC-145: one queue for everything held or deferred. Vigil's digest.jsonl (held and digest-routed events, the hold reason read from
 * Vigil's own notification rows) plus the heartbeat ledger's held rows: `HELD (<why>, <job>): <text>` from AgentJob, and any finding stamped
 * with a `QUIET_HOURS_HELD` marker. The heartbeat's other rows (preps it sent, iMessages it saw, verifications) were never held.
 * Drops never reach the brief: repeats of one story key, tests, injection notices, and anything held only because it was already texted.
 * Ranked severity then recency. Pure: the caller reads the files.
 */
export type HeartbeatRow = { ts: string; finding: string };
export type QueueItem = { ts: string; from: "vigil" | "heartbeat"; source: string; severity: VigilEvent["severity"]; key: string; text: string; reason: string };
export type QueueDrop = "repeat" | "test" | "injection" | "already_texted";
/** ISC-137: every watch-* item in the window as one counted entry, outside the cap: `--json` carries the entry and its items, `queueText` prints the one Watches line. Consumers: the 08:00 morning-brief job reads this output; Pulse does not read the queue. Absent when no watch has anything held or deferred. */
export type WatchesEntry = { count: number; severity: VigilEvent["severity"]; sources: Record<string, number>; text: string; items: QueueItem[] };
export type Queue = { since: string; considered: number; dropped: Record<QueueDrop, number>; items: QueueItem[]; watches?: WatchesEntry };
const SEVERITY_RANK = ["info", "low", "medium", "high", "critical"] as const;
const TESTISH = /(^|[^a-z])(tests?|fixtures?)([^a-z]|$)/i, INJECTION = /\binjection\b/i, ALREADY_TOLD = /already (texted|told)/i;
const PREP_FINDING = /^(MEETING_PREP_DUE|MEETING_PREP|UPCOMING_EVENT):/;
export function watchesEntry(items: QueueItem[]): WatchesEntry {
  const sources: Record<string, number> = {}; for (const i of items) sources[i.source] = (sources[i.source] ?? 0) + 1;
  const severity = items.reduce<VigilEvent["severity"]>((best, i) => SEVERITY_RANK.indexOf(i.severity) > SEVERITY_RANK.indexOf(best) ? i.severity : best, "info");
  const by = Object.entries(sources).map(([s, n]) => `${s.replace(/^watch-/, "")} ${n}`).join(", ");
  return { count: items.length, severity, sources, text: `Watches: ${items.length} (${by}), highest ${severity}`, items };
}
export function buildQueue(o: { digest: VigilEvent[]; outbox: VigilEvent[]; heartbeat: HeartbeatRow[]; draftOf: (event: VigilEvent) => string | undefined; now: Date; sinceMs: number; max: number; since?: string }): Queue {
  const cutoff = o.now.getTime() - o.sinceMs, dropped: Record<QueueDrop, number> = { repeat: 0, test: 0, injection: 0, already_texted: 0 };
  const holds = new Map(o.outbox.filter((e) => e.source === "vigil" && e.kind === "notification" && e.meta?.shadow !== true && e.ref && (e.meta?.decision === "held" || e.meta?.decision === "editor-digest")).map((e) => [e.ref!, String(e.meta?.reason ?? "")] as const));
  const told = sentStories(o.outbox), inWindow = (ts: string) => Date.parse(ts) >= cutoff && Date.parse(ts) <= o.now.getTime() + 300_000;
  const candidates: Array<QueueItem & { drop?: QueueDrop }> = [];
  for (const e of o.digest.filter((e) => e && typeof e.ts === "string" && e.source !== "vigil" && inWindow(e.ts))) {
    const draft = e.meta?.class !== undefined ? o.draftOf(e) : undefined, key = storyKeyOf(e), reason = holds.get(e.id) || `${e.severity} routes to the digest by policy`;
    const text = (draft ?? `${e.title} — ${e.summary}`).replace(/\s+/g, " ").slice(0, 300);
    const drop: QueueDrop | undefined = [e.source, e.ref ?? "", String(e.meta?.origin ?? ""), e.dedup_key].some((s) => TESTISH.test(s)) || e.meta?.test === true ? "test" : INJECTION.test(`${e.title} ${e.summary} ${draft ?? ""}`) ? "injection" : ALREADY_TOLD.test(reason) || told.some((t) => t.key === key && t.ts >= e.ts) ? "already_texted" : undefined;
    candidates.push({ ts: e.ts, from: "vigil", source: e.source, severity: e.severity, key, text, reason, ...(drop ? { drop } : {}) });
  }
  const rows = o.heartbeat.filter((r) => typeof r?.ts === "string" && typeof r?.finding === "string" && inWindow(r.ts)), quietRuns = new Set(rows.filter((r) => r.finding.startsWith("QUIET_HOURS_HELD")).map((r) => r.ts));
  for (const r of rows) {
    const held = r.finding.match(/^HELD \(([^,)]+),\s*([^)]+)\):\s*([\s\S]*)$/), quiet = !held && quietRuns.has(r.ts) && !/^(QUIET_HOURS_HELD|IMESSAGE_SEEN)\b/.test(r.finding);
    if (!held && !quiet) continue;
    const origin = held ? held[2]!.trim() : "heartbeat", text = (held ? held[3]! : r.finding).replace(/\s+/g, " ").trim() || r.finding, reason = held ? `${held[1]!.trim()} (${origin})` : "quiet hours (heartbeat)";
    const event = jobEvent({ id: "queue", origin, text, ts: r.ts, shadow: false, ...(PREP_FINDING.test(text) ? { cls: "prep" as const } : {}) });
    const drop: QueueDrop | undefined = TESTISH.test(origin) ? "test" : INJECTION.test(text) ? "injection" : ALREADY_TOLD.test(reason) ? "already_texted" : undefined;
    candidates.push({ ts: r.ts, from: "heartbeat", source: origin, severity: event.severity, key: String(event.meta!.key), text: text.slice(0, 300), reason, ...(drop ? { drop } : {}) });
  }
  const ranked = candidates.filter((c) => { if (c.drop) dropped[c.drop]++; return !c.drop; }).sort((a, b) => SEVERITY_RANK.indexOf(b.severity) - SEVERITY_RANK.indexOf(a.severity) || b.ts.localeCompare(a.ts));
  const seen = new Set<string>(), items: QueueItem[] = [], watchItems: QueueItem[] = [];
  for (const { drop: _drop, ...c } of ranked) { if (seen.has(c.key)) { dropped.repeat++; continue; } seen.add(c.key); if (isWatchSource(c.source)) watchItems.push(c); else if (items.length < o.max) items.push(c); }
  return { since: o.since ?? new Date(cutoff).toISOString(), considered: candidates.length, dropped, items, ...(watchItems.length ? { watches: watchesEntry(watchItems) } : {}) };
}
/** The heartbeat ledger AgentJob writes: `HEARTBEAT_STATE_DIR` when set (AgentJob honours it too), else the agent-jobs state dir. */
export const heartbeatLedgerPath = (): string => process.env.HEARTBEAT_STATE_DIR ? join(process.env.HEARTBEAT_STATE_DIR, "ledger.jsonl") : lifeosPath("USER", "MEMORY", "STATE", "agent-jobs", "heartbeat", "ledger.jsonl");
export function readQueue(o: { now?: Date; since?: string; max?: number } = {}): Queue {
  const since = o.since ?? "24h", max = o.max ?? 3; if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error("--max takes a whole number from 1 to 10");
  return buildQueue({ digest: jsonlAt<VigilEvent>(statePath("digest.jsonl")), outbox: jsonlAt<VigilEvent>(statePath("outbox.jsonl")), heartbeat: jsonlAt<HeartbeatRow>(heartbeatLedgerPath()), draftOf: draftLookup(), now: o.now ?? new Date(), sinceMs: parseSince(since), max, since });
}
export function queueText(q: Queue): string {
  if (!q.items.length && !q.watches) return `Nothing held or deferred in the last ${q.since}.`;
  return [...q.items.map((i) => `- [${i.severity}] ${i.text} (${i.from} ${i.source}: ${i.reason})`), ...(q.watches ? [`- ${q.watches.text}`] : [])].join("\n");
}
/** A model-run agent job (AGENTJOB_ID set) reads Vigil and may hand it a job text; it never labels shadow pairs, ticks, forwards, or emits a raw event (the morning brief runs Vigil.ts on untrusted calendar and issue text). */
const AGENT_JOB_COMMANDS = new Set(["queue", "list", "status", "shadow-report", "heartbeat", "help", "--help"]);
/** Outbox rows the tick rotated into `archive/outbox-<rotation date>.jsonl` (Tick.ts rotateOutbox). A file is dated the day it was written, after every row in it, so a file dated before `fromMs` holds nothing in the window. */
export function archivedOutbox(fromMs: number): VigilEvent[] {
  const dir = statePath("archive"), fromDay = new Date(fromMs).toISOString().slice(0, 10);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^outbox-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(7, 17) >= fromDay).sort().flatMap((f) => jsonlAt<VigilEvent>(join(dir, f)));
}
/** The real text ledger and Vigil's own sends, replayed with `source`'s events added. Reads only. */
export function replay(o: { days: number; source: string; perDay: number; now?: Date }): ReplayReport {
  const now = o.now ?? new Date();
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 30) throw new Error("--days takes a whole number from 1 to 30");
  if (!Number.isInteger(o.perDay) || o.perDay < 1 || o.perDay > 24) throw new Error("--per-day takes a whole number from 1 to 24");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(o.source)) throw new Error("--with names one Vigil source, e.g. ideal-state");
  // The tick rotates outbox rows past 14 days into the archive (ISC-143). A window longer than that needs them, or an archived send
  // vanishes instead of showing as unjoined. A row caught in both files mid-rotation counts once.
  const live = [...rows(), ...jsonl<VigilEvent>("pulled.jsonl")], liveIds = new Set(live.map((e) => e.id));
  const events = [...live, ...archivedOutbox(now.getTime() - o.days * 86_400_000).filter((e) => !liveIds.has(e.id))];
  const ledgerPath = process.env.LIFEOS_INTERRUPTIONS_LEDGER || lifeosPath("MEMORY", "OBSERVABILITY", "interruptions.jsonl");
  return replayWith({ now, days: o.days, cap: ceiling(), policy: loadPolicy(), ledger: readLedgerTexts(ledgerPath), ledgerFound: existsSync(ledgerPath), vigilSent: readVigilSent(events), injected: injectedEvents(o.source, now, o.days, o.perDay), quietAt: (ts) => inQuietHours(new Date(ts)) });
}
export function replayText(r: ReplayReport): string {
  return [`replay ${r.window.from.slice(0, 16)} → ${r.window.to.slice(0, 16)} (${r.days}d), budget ${r.cap}/day: ${r.ledger_texts} texts in the ledger, ${r.vigil_texts} sent by Vigil (${r.budget_bound} budget-bound)`,
    `added ${r.injected} ${r.source} events: ${r.delta_texts} would text, max ${r.max_per_day} a day (${r.max_rolling_24h} in any 24h)`,
    ...Object.entries(r.delta_held).map(([why, n]) => `  held ${n}: ${why}`), ...Object.entries(r.per_day).map(([d, n]) => `  ${d}: ${n} text`),
    `displaced texts that went out before: ${r.displaced.length}`, ...r.displaced.map((d) => `  ${d.ts} ${d.source} ${d.key}`), ...(r.unjoined_sends ? [`${r.unjoined_sends} of Vigil's sends in the window have lost their event (outbox retention), so whether they were displaced is unknown: this replay cannot pass; shorten --days`] : []), ...(r.ledger_found ? [] : ["no interruption ledger found: there is no record of the real texts, so this replay cannot pass"]), r.pass ? "PASS" : "FAIL"].join("\n");
}
const JOB_TEXT_MAX = 4000;
export type JobEmit = { event_id: string; class: JobClass; mode: "shadow" | "enforce"; outcome: "sent" | "failed" | "held" | "queued" | "claimed" | "not-sent-shadow"; reason: string };
/**
 * F12 (ISC-139): a job hands Vigil its text. The draft goes to the local 0600 draft file first, then the event (a hash, never the words)
 * to the outbox. With `now`, a fixed-rule class (prep, decision, security at high or above) is routed and sent in this process under
 * decider_mode enforce; ops and news wait for the tick, which runs the story hold and the editor. Under shadow, nothing is sent.
 */
export async function emitJob(o: { textFile: string; source?: string; ref?: string; cls?: string; key?: string; severity?: string; now?: boolean; textSend?: (text: string) => Promise<boolean> }): Promise<JobEmit> {
  const text = readFileSync(o.textFile, "utf8").trim(), source = o.source ?? "agentjob", origin = o.ref ?? source;
  if (!text) throw new Error("--text-file is empty"); if (text.length > JOB_TEXT_MAX) throw new Error(`--text-file is over ${JOB_TEXT_MAX} characters`);
  if (source === "vigil") throw new Error("--source vigil is reserved for Vigil's own rows");
  if (isAdvocateSource(source)) throw new Error("advocate-* sources never text on their own (ISC-447): emit the result as an ordinary event");
  if (o.cls !== undefined && !(JOB_CLASSES as readonly string[]).includes(o.cls)) throw new Error(`--class must be one of ${JOB_CLASSES.join(", ")}`);
  if (o.severity !== undefined && !(SEVERITIES as readonly string[]).includes(o.severity)) throw new Error(`--severity must be one of ${SEVERITIES.join(", ")}`);
  if (o.key !== undefined && !/^[^\s\u0000-\u001f]{1,120}$/.test(o.key)) throw new Error("--key is 1-120 characters with no spaces");
  const event = jobEvent({ id: randomUUID(), origin, text, ts: new Date().toISOString(), source, shadow: false, cls: o.cls as JobClass | undefined, key: o.key, severity: o.severity as VigilEvent["severity"] | undefined });
  validateEvent(event); saveDraft(event, text); emit(event);
  const mode = loadPolicy().decider_mode, cls = event.meta!.class as JobClass, base = { event_id: event.id, class: cls, mode };
  if (!o.now) return { ...base, outcome: "queued", reason: "the next tick decides it" };
  if (mode !== "enforce") return { ...base, outcome: "not-sent-shadow", reason: "decider_mode is shadow: emitted and recorded, not sent" };
  if (!fixedJob(event)) return { ...base, outcome: "queued", reason: `${cls} at ${event.severity} is not a fixed-rule class; the next tick decides it` };
  const [done] = await deliverFixed({ only: [event.id], textSend: o.textSend });
  return done ? { ...base, outcome: done.state, reason: done.decision.reason } : { ...base, outcome: "claimed", reason: "a concurrent tick owns this event" };
}
async function main() { if (!cmd || cmd === "--help" || cmd === "help") return console.log(HELP);
  if (process.env.AGENTJOB_ID && !AGENT_JOB_COMMANDS.has(cmd) && !(cmd === "emit" && flag("text-file") !== undefined)) throw new Error(`${cmd} is not open to agent jobs (AGENTJOB_ID is set): they may run queue, list, status, shadow-report, heartbeat, or emit --text-file`);
  if (cmd === "world-watch-report") { const days = Number(flag("days") ?? 7); invariant(Number.isFinite(days) && days > 0, "world-watch-report --days must be a positive number"); const rows = worldWatchReport(days); console.log(args.includes("--json") ? JSON.stringify(rows, null, 2) : worldWatchReportText(rows, days)); return; }
  if (cmd === "replay") { const source = flag("with"); if (!source) throw new Error("replay needs --with <source>"); const r = replay({ days: Number(flag("days") ?? 7), source, perDay: Number(flag("per-day") ?? 3) }); console.log(args.includes("--json") ? JSON.stringify(r, null, 2) : replayText(r)); process.exitCode = r.pass ? 0 : 1; return; }
  if (cmd === "queue") { const q = readQueue({ since: flag("since"), max: flag("max") === undefined ? undefined : Number(flag("max")) }); console.log(args.includes("--json") ? JSON.stringify(q, null, 2) : queueText(q)); return; } if (cmd === "heartbeat") { const now = new Date(); if (args.includes("--json")) console.log(JSON.stringify(heartbeatReport(now, stateDir()), null, 2)); process.exitCode = heartbeatStale(now, stateDir()) ? 1 : 0; return; }
  if (cmd === "emit" && (args.includes("--now") || ["text-file", "class", "key"].some((name) => flag(name) !== undefined))) { const textFile = flag("text-file"); if (!textFile) throw new Error("--now, --class and --key describe a job text: pass --text-file <path>"); const r = await emitJob({ textFile, source: flag("source"), ref: flag("ref"), cls: flag("class"), key: flag("key"), severity: flag("severity"), now: args.includes("--now") }); console.log(JSON.stringify(r)); if (r.outcome === "failed") process.exitCode = 1; return; }
  if (cmd === "emit") { const kind = flag("kind") as VigilEvent["kind"], severity = flag("severity") as VigilEvent["severity"], source = flag("source"), title = flag("title"), summary = flag("summary"); if (!source || !title || summary === undefined || !KINDS.includes(kind) || !SEVERITIES.includes(severity)) throw new Error("emit requires --source --kind --severity --title --summary"); const privacy = (flag("privacy") ?? "personal") as VigilEvent["privacy_class"]; if (!PRIVACY_CLASSES.includes(privacy)) throw new Error("invalid privacy"); const ref = flag("ref") ?? null; emit({ id: randomUUID(), source, ts: new Date().toISOString(), kind, severity, title, summary, ref, url: flag("url") ?? null, privacy_class: privacy, dedup_key: `${source}:${ref ?? title}:${severity}` }); console.log("emitted"); return; } if (cmd === "forward") return console.log(JSON.stringify(await forward())); if (cmd === "tick") { await tick({ dryRun: args.includes("--dry-run") }); return exitIfAbandoned(); } if (cmd === "status") { const all = rows(), saved = readJson<Array<string | { id: string }>>(statePath("sent.json"), []), sent = new Set(saved.map((x) => typeof x === "string" ? x : x.id)), cursorDir = statePath("cursors"); let cursors: Record<string, number> = {}; try { for (const f of new Bun.Glob("*.json").scanSync(cursorDir)) if (registeredCursor(f)) cursors[f] = Math.round((Date.now() - statSync(`${cursorDir}/${f}`).mtimeMs) / 1000); } catch {} console.log(JSON.stringify({ outbox: all.length, unsent: all.filter((e) => !sent.has(e.id)).length, cursor_ages_seconds: cursors, last_tick: readJson(statePath("last-tick.json"), null) }, null, 2)); return; } if (cmd === "shadow-report") { const pairs = shadowPairs(parseSince(flag("since") ?? "24h")); console.log(args.includes("--json") ? JSON.stringify(pairs, null, 2) : shadowReportText(pairs)); return; } if (cmd === "feedback") { const [target, label, ...note] = args.slice(1); if (!target || !label) throw new Error("usage: feedback <event-id|last> good|noise|missed [note]"); console.log(JSON.stringify(feedback(target, label, note.join(" ")))); return; } if (cmd === "list") { const limit = Number(flag("limit") ?? 20), source = flag("source"), list = [...rows(), ...jsonl<VigilEvent>("pulled.jsonl")].filter((e) => !source || e.source === source).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit).reverse(); if (args.includes("--json")) console.log(JSON.stringify(list, null, 2)); else list.forEach((e) => console.log(`${e.ts} ${e.severity.padEnd(8)} ${e.source}: ${e.title}`)); return; } throw new Error(`unknown command: ${cmd}`); }
if (import.meta.main) main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
