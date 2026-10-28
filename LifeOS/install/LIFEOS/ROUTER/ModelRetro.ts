#!/usr/bin/env bun
/**
 * @version 1.0.0
 * ModelRetro.ts — which models did we like, looking back over real work.
 *
 * Every typed prompt opens a turn; the principal's NEXT typed prompt is the reaction to it. Each turn
 * is credited to the models that did its work: the main-loop model that answered it, and every Claude
 * subagent or codex rollout that started inside its window (never the whole session). The reaction is
 * labelled by the shared Errata detector (ERRATA/Signals.ts, zero inference): corrected, frustrated,
 * praised, or neutral. The last turn of a session has no reaction and is not judged. A turn-ledger
 * `corrected` outcome (TurnOutcomes) also counts as corrected.
 *
 * Why the detector and not the ledgers: the turn ledger starts 2026-09-20 and the Jev exchange labels (retired 2026-10-10)
 * 2026-09-22, while the transcripts reach back much further. Rates carry a Wilson 95% interval and are
 * withheld below --min judged turns, because a model with nine turns has no rate worth reading.
 *
 * Usage:
 *   bun LIFEOS/ROUTER/ModelRetro.ts [--days 30] [--min 20] [--json]
 *   bun LIFEOS/ROUTER/ModelRetro.ts --model sonnet-5-5 --samples 20      # the turns to open and look at
 *   flags: --projects <dir> --codex <dir> (tests), --no-codex
 *
 * Local only: reads transcripts and rollout logs on this machine, calls no model and no network.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isDirectDispatch } from "../../hooks/lib/delegation";
import { detectExplicitCorrection, frustrationRead, normalize, NEGATIVE_SIGNAL, POSITIVE_PHRASES, POSITIVE_PRAISE_WORDS } from "../ERRATA/Signals";
import { readAll } from "../TOOLS/TurnOutcomes";
import { getClaudeDir } from "../TOOLS/Paths";
import { typedPrompt } from "./RealPrompts";
import { agentsForModel, listSessions, readRollouts, rolloutRoots, type Rollout } from "./RouteAudit";

export type Role = "main" | "subagent" | "codex";
export type Reaction = "corrected" | "frustrated" | "praised" | "neutral" | "none";

export interface Turn {
  session: string;
  project: string;
  startMs: number;
  /** The next typed prompt's time, or the session's last row for the final turn. */
  endMs: number;
  prompt: string;
  reaction: Reaction;
  reactionText: string;
  /** "role:model" → output tokens (codex: total tokens). */
  models: Record<string, number>;
  dispatches: Set<string>;
}

export interface ModelRow {
  role: Role;
  model: string;
  turns: number;
  judged: number;
  corrected: number;
  frustrated: number;
  praised: number;
  /** corrected + frustrated per 100 judged, with Wilson 95% bounds; null below the minimum. */
  unhappy: { rate: number; lo: number; hi: number } | null;
  praise: { rate: number; lo: number; hi: number } | null;
  tokens: number;
  first: string;
  last: string;
}

const SLOP_MS = 5 * 60_000;
const add = (o: Record<string, number>, k: string, v: number): void => { o[k] = (o[k] ?? 0) + v; };
const day = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "?");

/** Label the principal's reaction to a turn from the prompt that followed it. Priority: corrected > frustrated > praised > neutral. */
export function labelReaction(next: string | null): Reaction {
  if (next === null) return "none";
  if (detectExplicitCorrection(next) !== null) return "corrected";
  if (frustrationRead(next).fires) return "frustrated";
  const norm = normalize(next);
  const praised = [...POSITIVE_PHRASES].some((p) => norm.includes(p)) || norm.split(/[^a-z]+/).some((w) => POSITIVE_PRAISE_WORDS.has(w));
  return praised && !NEGATIVE_SIGNAL.test(norm) ? "praised" : "neutral";
}

/** Wilson score interval for x of n at 95%, as percentages rounded to one decimal. */
export function wilson(x: number, n: number): { rate: number; lo: number; hi: number } {
  if (n === 0) return { rate: 0, lo: 0, hi: 0 };
  const z = 1.96, p = x / n, z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (v: number): number => Math.round(v * 1000) / 10;
  return { rate: r(p), lo: r(Math.max(0, center - half)), hi: r(Math.min(1, center + half)) };
}

/** Split one session transcript into turns, crediting the main-loop model that answered each. */
export function parseSession(text: string, session: string, project: string): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let lastMs = NaN;
  const close = (next: string | null, atMs: number): void => {
    if (!cur) return;
    cur.endMs = atMs;
    cur.reaction = labelReaction(next);
    cur.reactionText = next ?? "";
    // One main model per turn: the one that wrote most of the answer.
    const mains = Object.entries(cur.models).filter(([k]) => k.startsWith("main:")).sort((a, b) => b[1] - a[1]);
    for (const [k] of mains.slice(1)) delete cur.models[k];
    turns.push(cur);
  };
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let r: Record<string, any>;
    try { r = JSON.parse(line); } catch { continue; }
    const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(t)) lastMs = t;
    const typed = typedPrompt(r);
    if (typed) {
      close(typed.text, t);
      cur = { session, project, startMs: t, endMs: NaN, prompt: typed.text, reaction: "none", reactionText: "", models: {}, dispatches: new Set() };
      continue;
    }
    if (!cur || r.type !== "assistant" || r.isSidechain || !r.message) continue;
    const model = String(r.message.model ?? "?");
    if (model !== "<synthetic>") add(cur.models, `main:${model}`, r.message.usage?.output_tokens ?? 0);
    for (const c of r.message.content ?? []) {
      if (c?.type !== "tool_use") continue;
      if (c.name === "Agent" || c.name === "Task") cur.dispatches.add(String(c.input?.subagent_type ?? "general-purpose"));
      else if (c.name === "Bash" && isDirectDispatch(String(c.input?.command ?? ""))) {
        const m = /\bWorker\.ts\s+(luna|terra|sol|astra)\b/i.exec(String(c.input?.command ?? ""));
        if (m) cur.dispatches.add(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase());
      }
    }
  }
  close(null, lastMs);
  return turns;
}

/** The turn whose window holds `ms`, or null. Windows are [start, end) with the last turn closed at its end. */
export function turnAt(turns: Turn[], ms: number, slop = 0): Turn | null {
  let best: Turn | null = null;
  for (const t of turns) if (ms >= t.startMs - slop && ms <= t.endMs + slop && (!best || t.startMs > best.startMs)) best = t;
  return best;
}

/** Credit each subagent transcript to the turn its first row falls in. */
export function creditSubagents(turns: Turn[], subDir: string): void {
  if (!existsSync(subDir)) return;
  for (const f of readdirSync(subDir)) {
    if (!f.endsWith(".jsonl")) continue;
    let first = NaN;
    const out: Record<string, number> = {};
    for (const l of readFileSync(join(subDir, f), "utf8").split("\n")) {
      if (!l.startsWith("{")) continue;
      let j: any; try { j = JSON.parse(l); } catch { continue; }
      const t = typeof j.timestamp === "string" ? Date.parse(j.timestamp) : NaN;
      if (Number.isFinite(t) && !Number.isFinite(first)) first = t;
      if (j.type === "assistant" && j.message?.model && j.message.model !== "<synthetic>") add(out, j.message.model, j.message.usage?.output_tokens ?? 0);
    }
    const turn = turnAt(turns, first);
    if (!turn) continue;
    for (const [m, v] of Object.entries(out)) add(turn.models, `subagent:${m}`, v);
  }
}

/** Credit each codex rollout to the latest-starting turn that dispatched a matching agent and whose window holds its start. */
export function creditRollouts(turns: Turn[], rollouts: Rollout[]): void {
  for (const roll of rollouts) {
    const agents = agentsForModel(roll.model);
    let owner: Turn | null = null;
    for (const t of turns) {
      if (![...agents].some((a) => t.dispatches.has(a))) continue;
      if (roll.start < t.startMs - SLOP_MS || roll.start > t.endMs + SLOP_MS) continue;
      if (!owner || t.startMs > owner.startMs) owner = t;
    }
    if (owner) add(owner.models, `codex:${roll.model}`, roll.tokens);
  }
}

/** Apply turn-ledger `corrected` outcomes to the nearest turn start in the same session (within 5 minutes). */
export function applyLedger(turns: Turn[], records: Array<{ session: string; ts: string; outcome: string | null }>): void {
  const bySession = new Map<string, Turn[]>();
  for (const t of turns) bySession.set(t.session, [...(bySession.get(t.session) ?? []), t]);
  for (const rec of records) {
    if (rec.outcome !== "corrected") continue;
    const ms = Date.parse(rec.ts);
    let best: Turn | null = null;
    for (const t of bySession.get(rec.session) ?? []) {
      if (Math.abs(t.startMs - ms) > SLOP_MS) continue;
      if (!best || Math.abs(t.startMs - ms) < Math.abs(best.startMs - ms)) best = t;
    }
    if (best && best.reaction !== "none") best.reaction = "corrected";
  }
}

/** One row per role:model across the turns. */
export function aggregate(turns: Turn[], min = 20): ModelRow[] {
  const rows = new Map<string, ModelRow & { firstMs: number; lastMs: number }>();
  for (const t of turns) {
    for (const [key, tokens] of Object.entries(t.models)) {
      const [role, ...rest] = key.split(":");
      const model = rest.join(":");
      const row = rows.get(key) ?? { role: role as Role, model, turns: 0, judged: 0, corrected: 0, frustrated: 0, praised: 0, unhappy: null, praise: null, tokens: 0, first: "", last: "", firstMs: Infinity, lastMs: 0 };
      row.turns++;
      row.tokens += tokens;
      if (t.reaction !== "none") row.judged++;
      if (t.reaction === "corrected") row.corrected++;
      if (t.reaction === "frustrated") row.frustrated++;
      if (t.reaction === "praised") row.praised++;
      if (Number.isFinite(t.startMs)) { row.firstMs = Math.min(row.firstMs, t.startMs); row.lastMs = Math.max(row.lastMs, t.startMs); }
      rows.set(key, row);
    }
  }
  const order: Record<Role, number> = { main: 0, subagent: 1, codex: 2 };
  return [...rows.values()]
    .map(({ firstMs, lastMs, ...r }) => ({
      ...r,
      first: day(firstMs), last: day(lastMs),
      unhappy: r.judged >= min ? wilson(r.corrected + r.frustrated, r.judged) : null,
      praise: r.judged >= min ? wilson(r.praised, r.judged) : null,
    }))
    .sort((a, b) => order[a.role] - order[b.role] || b.judged - a.judged);
}

export interface Sample { date: string; project: string; session: string; role: string; prompt: string; reaction: Reaction; reactionText: string }

const RANK: Record<Reaction, number> = { corrected: 0, frustrated: 1, praised: 2, neutral: 3, none: 4 };
const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** The turns a model did, unhappy ones first, then praised, then the most recent. */
export function samples(turns: Turn[], modelFilter: string, n: number): Sample[] {
  const needle = modelFilter.toLowerCase();
  return turns
    .flatMap((t) => {
      const key = Object.keys(t.models).find((k) => k.toLowerCase().includes(needle));
      return key ? [{ t, role: key }] : [];
    })
    .sort((a, b) => RANK[a.t.reaction] - RANK[b.t.reaction] || b.t.startMs - a.t.startMs)
    .slice(0, n)
    .map(({ t, role }) => ({ date: day(t.startMs), project: t.project, session: t.session, role, prompt: clip(t.prompt, 110), reaction: t.reaction, reactionText: clip(t.reactionText, 110) }));
}

export interface RetroOptions { projectsDir: string; codexDir?: string; noCodex?: boolean; sinceMs?: number; ledger?: boolean }

/** Read the transcripts (and rollouts) since `sinceMs` into credited, labelled turns. */
export function collectTurns(opts: RetroOptions): Turn[] {
  let sessions = listSessions(opts.projectsDir);
  if (opts.sinceMs) sessions = sessions.filter((s) => s.mtime >= opts.sinceMs!);
  const turns: Turn[] = [];
  for (const s of sessions) {
    const text = readFileSync(s.file, "utf8");
    if (!text.includes('"entrypoint":"cli"')) continue; // interactive sessions only; headless jobs have no reactions
    const ts = parseSession(text, s.id, s.project).filter((t) => !opts.sinceMs || t.startMs >= opts.sinceMs);
    if (!ts.length) continue;
    creditSubagents(ts, join(s.dir, s.id, "subagents"));
    turns.push(...ts);
  }
  if (!opts.noCodex) {
    const roots = rolloutRoots(opts.codexDir);
    const rolls = readRollouts(roots).filter((r) => !opts.sinceMs || r.start >= opts.sinceMs - SLOP_MS);
    creditRollouts(turns, rolls);
  }
  if (opts.ledger !== false) applyLedger(turns, readAll());
  return turns;
}

function fmtRate(r: ModelRow["unhappy"]): string {
  return r ? `${r.rate.toFixed(1)} [${r.lo.toFixed(0)}–${r.hi.toFixed(0)}]` : "n<min";
}

export function formatTable(rows: ModelRow[]): string {
  const head = ["role", "model", "turns", "judged", "unhappy/100 [95%]", "corr", "frus", "praise/100 [95%]", "tokens", "first", "last"];
  const body = rows.map((r) => [r.role, r.model, String(r.turns), String(r.judged), fmtRate(r.unhappy), String(r.corrected), String(r.frustrated), fmtRate(r.praise), r.tokens.toLocaleString("en-US"), r.first, r.last]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "30" }, min: { type: "string", default: "20" },
      model: { type: "string" }, samples: { type: "string", default: "15" },
      json: { type: "boolean", default: false }, projects: { type: "string" }, codex: { type: "string" },
      "no-codex": { type: "boolean", default: false },
    },
  });
  const sinceMs = Date.now() - Number(values.days) * 86_400_000;
  const projectsDir = values.projects ?? join(getClaudeDir(), "projects");
  const turns = collectTurns({ projectsDir, codexDir: values.codex, noCodex: values["no-codex"], sinceMs });
  const rows = aggregate(turns, Number(values.min));
  const judged = turns.filter((t) => t.reaction !== "none").length;
  const sample = values.model ? samples(turns, values.model, Number(values.samples)) : undefined;
  if (values.json) {
    console.log(JSON.stringify({ since: day(sinceMs), turns: turns.length, judged, models: rows, samples: sample }, null, 2));
  } else {
    console.log(`turns=${turns.length}  judged=${judged}  since=${day(sinceMs)}  (unhappy = corrected + frustrated; rates hidden below ${values.min} judged)\n`);
    console.log(formatTable(values.model ? rows.filter((r) => r.model.toLowerCase().includes(values.model!.toLowerCase())) : rows));
    if (sample) {
      console.log(`\nturns for "${values.model}" (unhappy first):`);
      for (const s of sample) console.log(`- ${s.date}  ${s.reaction.padEnd(10)} ${s.session}  ${s.prompt}${s.reactionText ? `\n    ↳ ${s.reactionText}` : ""}`);
    }
  }
  if (!rows.length) process.exit(1);
}
