#!/usr/bin/env bun
/**
 * @version 1.0.1
 * TurnOutcomes.ts — K1/K2: one durable record per substantive turn, and the era it ran in.
 *
 * The denominator the harness never had. Every other stream logs behavior or unhappiness; this one
 * logs "this ask, this route, this outcome", so "is it smarter than last week" is a group-by
 * instead of a benchmark. Corrections are the label (ERRATA/Signals.ts), silence is the complement.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { lifeosPath } from "./Paths.ts";
import { invariant } from "./Invariant.ts";
import { detectExplicitCorrection, frustrationRead } from "../ERRATA/Signals.ts";

export type WorkKind = "code" | "research" | "writing" | "ops" | "conversation";
export type Outcome = "corrected" | "re-asked" | "accepted" | "abandoned";
export interface TurnRecord {
  schema: 1; turn: string; session: string; ts: string; prompt_excerpt: string;
  work_kind: WorkKind | null; work_kind_source: "derived";
  route: { lane: string | null; level: string | null; binding: boolean; source: string | null } | null;
  fidelity: "pass" | "inline" | "hold" | "unresolved" | null;
  tool_calls: number; outcome: Outcome | null; outcome_resolved_ts: string | null;
  era: { carrier: string | null; system_prompt: string | null; algorithm: string | null; router: string | null };
  /** Transcript size in bytes at turn end. The next turn counts tool_use blocks from here. */
  transcript_bytes?: number;
  /** Which detector produced a "corrected" outcome, so the label's precision can be audited later. */
  correction_signal?: "signals" | "reformulation" | null;
  /** Whether this turn actually sent work off the carrier (Agent tool or a Worker.ts run). */
  delegated?: boolean;
}

/** Parse a bounded suffix of the ledger. The hook path never reads the whole file. */
function tailRecords(path: string, n = 400): TurnRecord[] {
  return tailLines(path, n).flatMap((line) => {
    try { return [JSON.parse(line) as TurnRecord]; } catch { return []; }
  });
}

export function turnOutcomesPath(): string {
  return process.env.LIFEOS_TURN_OUTCOMES || lifeosPath("MEMORY", "OBSERVABILITY", "turn-outcomes.jsonl");
}

/** Read only a bounded suffix, returning up to n complete lines. */
export function tailLines(path: string, n: number, maxBytes = 2 * 1024 * 1024): string[] {
  try {
    const fd = openSync(path, "r");
    try {
      const size = Bun.file(path).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, Math.max(0, size - length));
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      if (size > length) lines.shift();
      if (lines.at(-1) === "") lines.pop();
      return lines.slice(-n);
    } finally { closeSync(fd); }
  } catch { return []; }
}

export function readAll(path = turnOutcomesPath()): TurnRecord[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as TurnRecord]; } catch { return []; }
    });
  } catch { return []; }
}

export function appendTurn(rec: TurnRecord, path = turnOutcomesPath()): void {
  invariant(rec.schema === 1, "turn outcome schema must be 1");
  invariant(/^[A-Za-z0-9_-]{1,128}:\d+$/.test(rec.turn), "turn key is malformed");
  invariant(rec.session.trim().length > 0, "session is required");
  invariant(!Number.isNaN(Date.parse(rec.ts)), "turn timestamp must parse");
  invariant(Number.isInteger(rec.tool_calls) && rec.tool_calls >= 0, "tool_calls must be a non-negative integer");
  invariant(rec.outcome === null || ["corrected", "re-asked", "accepted", "abandoned"].includes(rec.outcome), "outcome is invalid");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(rec)}\n`, "utf8");
}

export function nextTurnIndex(session: string, path = turnOutcomesPath()): number {
  let highest = 0;
  for (const rec of tailRecords(path)) if (rec.session === session) {
    const match = rec.turn.match(/:(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

export function lastUnresolved(session: string, path = turnOutcomesPath()): TurnRecord | null {
  const records = tailRecords(path);
  for (let i = records.length - 1; i >= 0; i--) if (records[i].session === session && records[i].outcome === null) return records[i];
  return null;
}

export function resolveOutcome(turn: string, outcome: Outcome, path = turnOutcomesPath(), signal: "signals" | "reformulation" | null = null): boolean {
  try {
    const records = readAll(path); const index = records.findIndex((record) => record.turn === turn);
    if (index < 0 || records[index].outcome !== null) return false;
    records[index] = { ...records[index], outcome, outcome_resolved_ts: new Date().toISOString(), correction_signal: signal };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    renameSync(tmp, path); return true;
  } catch { return false; }
}

/**
 * A turn whose outcome never resolved because no next prompt arrived. Marked `abandoned`, NOT
 * `accepted`: a session that ends after a good answer and a session the principal walked away from
 * look identical from here, and guessing "accepted" would count silence as success — the exact
 * failure this ledger exists to stop. report() keeps abandoned out of the rate's denominator and
 * shows it as coverage instead, so the ambiguity stays visible rather than being averaged away.
 */
export function sweepAbandoned(olderThanHours = 12, path = turnOutcomesPath(), now = Date.now()): number {
  try {
    const cutoff = now - olderThanHours * 3600_000;
    const records = readAll(path);
    let swept = 0;
    const next = records.map((rec) => {
      if (rec.outcome !== null) return rec;
      const ts = Date.parse(rec.ts);
      if (!Number.isFinite(ts) || ts >= cutoff) return rec;
      swept++;
      return { ...rec, outcome: "abandoned" as Outcome, outcome_resolved_ts: new Date(now).toISOString(), correction_signal: null };
    });
    if (swept === 0) return 0;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${next.map((rec) => JSON.stringify(rec)).join("\n")}\n`, "utf8");
    renameSync(tmp, path);
    return swept;
  } catch { return 0; }
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((word) => word.length > 2));
}
/**
 * A correction that carries no negative word, so Signals.ts's precision-first rules miss it:
 * "no, I meant the other file". Kept HERE and not widened into Signals.ts, because that table is
 * shared with the capture hook and the Errata ledger — loosening it there would change what every
 * downstream analysis counts as a complaint. Prompt-initial only, and paired with a first-person
 * restatement marker, so an ordinary "no" answering a question is not swept in.
 */
export const REFORMULATION = /^(?:(?:no|nope|nah|actually)\b[\s,.:;-]*(?:.{0,40}?\b)?(?:i\s+(?:meant|said|asked|wanted?)|that'?s\s+not\s+what)|i\s+(?:meant|said)\b)/i;

export function correctionSignal(prompt: string): "signals" | "reformulation" | null {
  if (detectExplicitCorrection(prompt) || frustrationRead(prompt).correction) return "signals";
  if (REFORMULATION.test(prompt.trim())) return "reformulation";
  return null;
}

export function classifyOutcome(nextPrompt: string, prevPrompt: string): "corrected" | "re-asked" | "accepted" {
  if (correctionSignal(nextPrompt)) return "corrected";
  const a = words(nextPrompt), b = words(prevPrompt);
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  if (a.size >= 4 && b.size >= 4 && intersection / union >= 0.6) return "re-asked";
  return "accepted";
}

/**
 * Tool names used in the byte range [from, eof) of a transcript. The range is the turn's own
 * boundary: each record stores the transcript size at its end, so the next turn reads only what
 * was appended since. Bounded by maxBytes so a long turn can never make the Stop hook expensive.
 */
export function toolsSince(transcriptPath: string, from: number, maxBytes = 4 * 1024 * 1024): { tools: string[]; calls: number; delegated: boolean; bytes: number } {
  const empty = { tools: [] as string[], calls: 0, delegated: false, bytes: 0 };
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return empty;
    const size = Bun.file(transcriptPath).size;
    const start = Math.max(0, Math.min(from, size));
    const length = Math.min(size - start, maxBytes);
    if (length <= 0) return { ...empty, bytes: size };
    const fd = openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, start);
      const text = buffer.toString("utf8");
      const tools = new Set<string>();
      let calls = 0;
      for (const m of text.matchAll(/"type"\s*:\s*"tool_use"[^}]*?"name"\s*:\s*"([A-Za-z0-9_.-]+)"/g)) { tools.add(m[1]); calls++; }
      // Whether work actually went off the carrier, recorded HERE rather than derived later from the
      // transcript: transcripts prune after ~5 days, so a delegation fact that lives only there
      // cannot be joined to an outcome a week on. Both dispatch paths count — the Agent tool, and a
      // Worker.ts run, which is a Bash call and so invisible to the tool-name scan.
      const delegated = tools.has("Agent") || /TOOLS\/Worker\.ts/.test(text);
      return { tools: [...tools], calls, delegated, bytes: size };
    } finally { closeSync(fd); }
  } catch { return empty; }
}

export function deriveWorkKind(prompt: string, tools: string[]): WorkKind | null {
  if (tools.some((tool) => ["Edit", "Write", "NotebookEdit"].includes(tool)) || /\b(build|implement|refactor|fix|bug|compile|test|deploy)\b/i.test(prompt)) return "code";
  if (tools.some((tool) => ["WebSearch", "WebFetch"].includes(tool)) || /\b(research|find out|look up|investigate|what is)\b/i.test(prompt)) return "research";
  if (/\b(draft|write|post|essay|newsletter|copy|blog)\b/i.test(prompt)) return "writing";
  if (tools.includes("Bash")) return "ops";
  if (tools.length === 0) return "conversation";
  return null;
}

/**
 * The model the session actually ran on, read from the transcript's last main-thread assistant
 * message. The era stamp reads settings.json first; this is the fallback for the common case where
 * no model is pinned there, which left the carrier null on most turns. Bounded tail read, never throws.
 */
export function modelFromTranscript(transcriptPath: string, maxBytes = 512 * 1024): string | null {
  const lines = transcriptPath ? tailLines(transcriptPath, 2000, maxBytes) : [];
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      const model = row?.type === "assistant" && row.isSidechain !== true ? row.message?.model : null;
      if (typeof model === "string" && model && model !== "<synthetic>") return model;
    } catch {}
  }
  return null;
}

export const ERA_FIELDS = ["carrier", "system_prompt", "algorithm", "router"] as const;
export type EraField = (typeof ERA_FIELDS)[number];

/** One report row, keyed by the era field it was grouped on (`carrier` unless `by` says otherwise). */
export type ReportRow = Record<string, unknown> & { work_kind?: WorkKind | null; n: number; corrected: number; re_asked: number; accepted: number; abandoned: number; judged: number; coverage_pct: number; corrections_per_100?: number; rate?: null; reason?: string };

export function report(opts: { byKind?: boolean; by?: EraField } = {}, path = turnOutcomesPath()): ReportRow[] {
  const by = opts.by ?? "carrier";
  const groups = new Map<string, Record<string, unknown> & { work_kind?: WorkKind | null; n: number; corrected: number; re_asked: number; accepted: number; abandoned: number }>();
  for (const rec of readAll(path)) if (rec.outcome) {
    const value = rec.era?.[by] ?? null; const key = opts.byKind ? `${value ?? "null"}\u0000${rec.work_kind ?? "null"}` : (value ?? "null");
    const group = groups.get(key) ?? { [by]: value, ...(opts.byKind ? { work_kind: rec.work_kind } : {}), n: 0, corrected: 0, re_asked: 0, accepted: 0, abandoned: 0 };
    group.n++; group[rec.outcome === "re-asked" ? "re_asked" : rec.outcome]++; groups.set(key, group);
  }
  // The rate's denominator is turns a next prompt actually judged. Abandoned turns carry no signal
  // either way, so they are reported as coverage rather than silently counted as non-corrected.
  return [...groups.values()].map((group): ReportRow => {
    const judged = group.corrected + group.re_asked + group.accepted;
    const coverage = group.n === 0 ? 0 : Math.round(1000 * judged / group.n) / 10;
    return judged < 20
      ? { ...group, judged, coverage_pct: coverage, rate: null, reason: "judged<20" }
      : { ...group, judged, coverage_pct: coverage, corrections_per_100: Math.round(1000 * group.corrected / judged) / 10 };
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2); const command = args.shift();
  if (command === "stats" && args.length === 0) {
    const all = readAll(); const dates = all.map((r) => r.ts).filter((ts) => !Number.isNaN(Date.parse(ts))).sort();
    console.log(JSON.stringify({ total: all.length, resolved: all.filter((r) => r.outcome !== null).length, unresolved: all.filter((r) => r.outcome === null).length, span: dates.length ? { first: dates[0], last: dates.at(-1) } : null }));
  } else if (command === "recent" && args.length <= 1 && (args.length === 0 || /^\d+$/.test(args[0]))) console.log(JSON.stringify(readAll().slice(-(Number(args[0] ?? 20))), null, 2));
  else if (command === "report" && args.every((arg) => arg === "--by-kind" || arg === "--json" || ERA_FIELDS.some((f) => arg === `--by=${f}`))) {
    const by = args.find((a) => a.startsWith("--by="))?.slice(5) as EraField | undefined;
    const data = report({ byKind: args.includes("--by-kind"), by });
    if (args.includes("--json")) console.log(JSON.stringify(data, null, 2));
    else if (data.length) console.table(data);
    else console.log("No resolved turn outcomes.");
  } else if (command === "sweep" && args.every((arg) => arg === "--dry-run" || /^--hours=\d+$/.test(arg))) {
    const hours = Number(args.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? 12);
    if (args.includes("--dry-run")) {
      const cutoff = Date.now() - hours * 3600_000;
      const stale = readAll().filter((r) => r.outcome === null && Date.parse(r.ts) < cutoff);
      console.log(JSON.stringify({ would_sweep: stale.length, hours, turns: stale.map((r) => r.turn) }));
    } else console.log(JSON.stringify({ swept: sweepAbandoned(hours), hours }));
  } else { console.error(`Usage: report [--by=${ERA_FIELDS.join("|")}] [--by-kind] [--json] | recent [N] | stats | sweep [--hours=N] [--dry-run]`); process.exitCode = 1; }
}
