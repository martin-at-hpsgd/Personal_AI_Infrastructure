/**
 * reconcile.ts — the record checked against its witnesses (STATVS ISA F15, ISC-117 to ISC-120).
 *
 * "Something absent from STATVS is unknown until reconciled" (StatvsSystem § What STATVS is the authority for).
 * This compares the record with independent witnesses over a recent window and names each gap:
 *
 *   turn       a human prompt in a Claude Code transcript with no `turn` row
 *   move       a tool call a command hook refused, in the transcript, with no `move` row for its session
 *   move-plugin the same for the in-process LifeOSHooks plugin, which cannot write rows yet (its own gap)
 *   ship       a segment row older than an hour the shipper has not sent to the cloud record
 *   schedule   an installed workflow schedule whose firing times differ from a fresh compile
 *
 * Read-only on the record. `reportGaps` turns each gap into one Vigil event per check per day through
 * writeEventOnce; an event carries counts, short session ids and the fix command, never prompt or row content.
 * Without this comparison, gaps between the record and its sources can sit unseen for days.
 * @version 1.0.0
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClaudeDir } from "../../TOOLS/Paths";
import { invariant } from "../../TOOLS/Invariant";
import { isPrompt, outcomeOf } from "../Rewind";
import { scan } from "./record";
import { cloudRows, shipState, type CloudConn } from "./cloudRead";
import { writeEventOnce, type EventInput, type WriteEventOnceResult } from "./event";

export type GapCheck = "turn" | "move" | "move-plugin" | "ship" | "schedule";
export interface Gap { check: GapCheck; count: number; ids: string[]; fix: string }
export interface ReconcileResult { from: string; to: string; seen: { prompts: number; refusals: number }; gaps: Gap[] }

export interface ReconcileOptions {
  now?: number;
  /** Window length; the hourly workflow uses 2 so each run overlaps the last. */
  hours?: number;
  /** The newest part of the window is left out, because the turn hook runs async and the shipper every ten minutes. */
  settleMinutes?: number;
  projectsDir?: string;
  /** STATVS record dir (env STATVS_DIR otherwise). */
  dir?: string;
  /** The shipper's state dir (holds ship/<cursor>.json). */
  shipStateDir?: string;
  /** The turn and move rows to judge; reconcileCloud fetches them from the cloud record, and without them the local record is read. */
  rows?: { turn: RowRef[]; move: RowRef[] };
  /** Sessions the shipper withholds from the cloud (consulting work): their turn and move rows are not in the cloud by design, so they are not judged. */
  skipSessions?: Set<string>;
  /** Installed schedules that drifted (the CLI passes the Workflows installer's drift check; none skips this check). */
  drift?: () => { name: string }[];
}

type Line = Record<string, any>;
/** What reconcile needs of a turn or move row, from either copy. */
export interface RowRef { session?: string; ts: string; data?: unknown }
const short = (s: string) => s.slice(0, 8);
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const resultText = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b: Line) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";

/** Transcripts written to inside the window: projects/<cwd folder>/<session>.jsonl only, as TurnRecord writes them. */
function transcripts(projects: string, fromMs: number): { session: string; path: string }[] {
  if (!existsSync(projects)) return [];
  const out: { session: string; path: string }[] = [];
  for (const dir of readdirSync(projects)) {
    const d = join(projects, dir);
    let entries: string[];
    try { if (!statSync(d).isDirectory()) continue; entries = readdirSync(d); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(d, f);
      try { if (statSync(p).mtimeMs >= fromMs) out.push({ session: f.slice(0, -6), path: p }); } catch { /* gone */ }
    }
  }
  return out;
}

/** The witness side, read cheaply: only lines that can be a human prompt or a failed tool result are parsed. */
function witness(path: string, fromMs: number, toMs: number): { prompts: number[]; refusals: { ms: number; plugin: boolean }[] } {
  const prompts: number[] = [];
  const refusals: { ms: number; plugin: boolean }[] = [];
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { prompts, refusals }; }
  for (const raw of text.split("\n")) {
    const maybePrompt = raw.includes('"turnOrigin":"human"');
    const maybeRefusal = raw.includes('"is_error":true');
    if (!maybePrompt && !maybeRefusal) continue;
    let j: Line;
    try { j = JSON.parse(raw); } catch { continue; }
    const ms = Date.parse(String(j.timestamp ?? ""));
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    if (maybePrompt && isPrompt(j as never)) prompts.push(ms);
    if (maybeRefusal && j.type === "user" && !j.isSidechain && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b?.type !== "tool_result" || b.is_error !== true) continue;
        const t = resultText(b.content);
        if (outcomeOf(true, t) !== "refused") continue;
        // A command hook's refusal reaches the transcript as "<Event>:<Tool> hook error: …"; the plugin's as a bare tool_use_error.
        refusals.push({ ms, plugin: !/hook error/.test(t) });
      }
    }
  }
  return { prompts, refusals };
}

/** The local record's rows of one stream from the day before the window on. */
function localRefs(stream: string, classes: ("system" | "personal")[], fromMs: number, dir?: string): RowRef[] {
  return scan({ streams: [stream], classes, fromDate: utcDay(fromMs - 86_400_000), ...(dir ? { dir } : {}) }).rows;
}

/** Row times inside [from - slack, to + slack], by session; `keep` filters them (move rows: refusals only). */
function rowsBySession(rows: RowRef[], fromMs: number, toMs: number, keep: (data: unknown) => boolean = () => true): Map<string, number[]> {
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const ms = Date.parse(String(r.ts));
    if (!r.session || !Number.isFinite(ms) || ms < fromMs - 300_000 || ms > toMs + 300_000 || !keep(r.data)) continue;
    const list = by.get(r.session) ?? [];
    list.push(ms);
    by.set(r.session, list);
  }
  return by;
}

/** Take the nearest unused row time within [t - before, t + after]; true when one was found. */
function take(times: number[] | undefined, t: number, before: number, after: number): boolean {
  if (!times) return false;
  let best = -1;
  for (let i = 0; i < times.length; i++) {
    const d = times[i]! - t;
    if (d >= -before && d <= after && (best < 0 || Math.abs(d) < Math.abs(times[best]! - t))) best = i;
  }
  if (best < 0) return false;
  times.splice(best, 1);
  return true;
}

/** Segment rows older than an hour that the shipper's cursor has not passed. */
function shipBacklog(dir: string, shipStateDir: string, nowMs: number): { count: number; ids: string[] } {
  const shipDir = join(shipStateDir, "ship");
  const cursors = existsSync(shipDir) ? readdirSync(shipDir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f)) : [];
  // The shipper writes one cursor per destination; the newest is the live one.
  const cursorFile = cursors.sort((a, b) => statSync(join(shipDir, b)).mtimeMs - statSync(join(shipDir, a)).mtimeMs)[0];
  let segments: Record<string, { seq?: number }> = {};
  let floor = "";
  let cursorOk = false;
  if (cursorFile) {
    try {
      const c = JSON.parse(readFileSync(join(shipDir, cursorFile), "utf8")) as { segments?: typeof segments; floor?: string };
      segments = c.segments ?? {};
      floor = typeof c.floor === "string" ? c.floor : "";
      cursorOk = true;
    } catch { /* unreadable: judged as a shipper that has sent nothing */ }
  }
  let count = 0;
  const ids: string[] = [];
  for (const cls of ["system", "personal"]) {
    const base = join(dir, cls);
    if (!existsSync(base)) continue;
    for (const day of readdirSync(base)) {
      if (day < floor) continue; // the shipper finished every day below its floor and dropped them from the cursor
      for (const f of readdirSync(join(base, day))) {
        if (!f.endsWith(".jsonl")) continue;
        const rel = `${cls}/${day}/${f}`;
        const done = segments[rel]?.seq ?? 0;
        let stale = 0;
        for (const raw of readFileSync(join(base, day, f), "utf8").split("\n")) {
          if (!raw) continue;
          let r: Line;
          try { r = JSON.parse(raw); } catch { continue; }
          if (typeof r.seq === "number" && r.seq > done && nowMs - Date.parse(String(r.ts)) > 3_600_000) stale++;
        }
        if (stale > 0) { count += stale; ids.push(rel); }
      }
    }
  }
  // With no readable cursor every old row counts, and the first id says why.
  return { count, ids: count > 0 && !cursorOk ? ["no readable ship cursor", ...ids] : ids };
}

export function reconcile(opts: ReconcileOptions = {}): ReconcileResult {
  const now = opts.now ?? Date.now();
  const hours = opts.hours ?? 2;
  invariant(hours > 0 && hours <= 24 * 7, "a reconcile window is between a moment and a week");
  const toMs = now - (opts.settleMinutes ?? 10) * 60_000;
  const fromMs = toMs - hours * 3_600_000;
  const projects = opts.projectsDir ?? join(getClaudeDir(), "projects");
  const dir = opts.dir ?? process.env.STATVS_DIR ?? join(getClaudeDir(), "LIFEOS", "MEMORY", "STATVS");

  const turns = rowsBySession(opts.rows?.turn ?? localRefs("turn", ["system"], fromMs, opts.dir), fromMs, toMs);
  // An ask or a fail-open row is not a refusal, so it can never stand in for one the transcript shows.
  const refusing = (d: unknown) => { const v = (d as { verdict?: unknown } | null)?.verdict; return v === "refuse" || v === "fail-closed"; };
  const moves = rowsBySession(opts.rows?.move ?? localRefs("move", ["personal"], fromMs, opts.dir), fromMs, toMs, refusing);
  const turnGap = new Map<string, number>();
  const moveGap = new Map<string, number>();
  const pluginGap = new Map<string, number>();
  let promptsSeen = 0, refusalsSeen = 0;
  for (const t of transcripts(projects, fromMs)) {
    if (opts.skipSessions?.has(t.session)) continue;
    const w = witness(t.path, fromMs, toMs);
    for (const ms of w.prompts) { promptsSeen++; if (!take(turns.get(t.session), ms, 60_000, 60_000)) turnGap.set(t.session, (turnGap.get(t.session) ?? 0) + 1); }
    for (const r of w.refusals) {
      refusalsSeen++;
      // The hook writes its row before it exits, so the row precedes the result line by up to a few seconds.
      if (take(moves.get(t.session), r.ms, 120_000, 5_000)) continue;
      const into = r.plugin ? pluginGap : moveGap;
      into.set(t.session, (into.get(t.session) ?? 0) + 1);
    }
  }
  const ship = shipBacklog(dir, opts.shipStateDir ?? join(homedir(), ".local", "state", "lifeos", "statvs"), now);
  const drifted = opts.drift ? opts.drift() : [];

  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const gaps: Gap[] = [];
  if (turnGap.size) gaps.push({ check: "turn", count: total(turnGap), ids: [...turnGap.keys()].map(short), fix: "bun test ./LIFEOS/STATVS/tests/rewind.test.ts, then check hooks/TurnRecord.hook.ts is registered on UserPromptSubmit" });
  if (moveGap.size) gaps.push({ check: "move", count: total(moveGap), ids: [...moveGap.keys()].map(short), fix: "find the refusing hook in the transcript and call recordRefusal (hooks/lib/record-verdict.ts) before its exit" });
  if (pluginGap.size) gaps.push({ check: "move-plugin", count: total(pluginGap), ids: [...pluginGap.keys()].map(short), fix: "STATVS ISA ISC-121: the LifeOSHooks plugin cannot write rows yet" });
  if (ship.count) gaps.push({ check: "ship", count: ship.count, ids: ship.ids.slice(0, 5), fix: "tail ~/.local/state/lifeos/statvs/ship.log, then bun LIFEOS/STATVS/core/tools/ship.ts --dry-run" });
  if (drifted.length) gaps.push({ check: "schedule", count: drifted.length, ids: drifted.map((d) => d.name).slice(0, 8), fix: "bun LIFEOS/WORKFLOWS/engine/schedule-install.ts drift --fix" });
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), seen: { prompts: promptsSeen, refusals: refusalsSeen }, gaps };
}

/** reconcile with the turn and move rows read from the cloud record, the authority (ISC-170). */
export async function reconcileCloud(opts: ReconcileOptions & { conn?: CloudConn } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now();
  const toMs = now - (opts.settleMinutes ?? 10) * 60_000;
  const fromMs = toMs - (opts.hours ?? 2) * 3_600_000;
  const from = new Date(fromMs - 300_000).toISOString(), to = new Date(toMs + 300_000).toISOString();
  const [turn, move] = await Promise.all([
    cloudRows({ stream: "turn", class: "system", from, to }, opts.conn),
    // A move row over 4 KB keeps its verdict in a body, and the verdict decides whether it answers a refusal.
    cloudRows({ stream: "move", class: "personal", from, to, withData: true }, opts.conn),
  ]);
  return reconcile({ ...opts, now, rows: { turn, move }, skipSessions: opts.skipSessions ?? shipState().withheldSessions });
}

const TITLES: Record<GapCheck, string> = {
  turn: "STATVS missed human prompts: no turn row",
  move: "STATVS missed gate refusals: no move row",
  "move-plugin": "STATVS cannot record the plugin's refusals yet",
  ship: "STATVS shipper is behind on the cloud record",
  schedule: "Workflow schedules drifted from their definitions",
};

/** An id as it may appear in an event: our own short names and segment paths, with anything else replaced. */
const safeId = (id: string) => id.replace(/[^A-Za-z0-9._/ -]/g, "_").slice(0, 80);

/** One event per gap check per day. Counts, short ids and the fix only (ISC-120). */
export function gapEvent(g: Gap, nowMs: number): EventInput {
  return {
    source: "statvs",
    ts: new Date(nowMs).toISOString(),
    kind: "infra",
    severity: g.check === "move-plugin" ? "medium" : "high",
    title: TITLES[g.check],
    summary: `Fix: ${g.fix}. ${g.count} found: ${g.ids.slice(0, 10).map(safeId).join(", ")}${g.ids.length > 10 ? ` and ${g.ids.length - 10} more` : ""}.`.slice(0, 500),
    privacy_class: "personal",
    dedup_key: `statvs-reconcile:${g.check}:${utcDay(nowMs)}`,
    meta: { check: g.check, count: g.count },
  } as EventInput;
}

export function reportGaps(result: ReconcileResult, opts: { now?: number; write?: (e: EventInput) => WriteEventOnceResult } = {}): WriteEventOnceResult[] {
  const now = opts.now ?? Date.now();
  return result.gaps.map((g) => (opts.write ?? ((e) => writeEventOnce(e)))(gapEvent(g, now)));
}
