#!/usr/bin/env bun
/**
 * Advocate — the judgment for research, prepare and background (Vigil F16, STATVS migration design Lane D/G).
 *
 * Each tick, beside the new rows, the advocate reads {{PRINCIPAL_NAME}}'s TELOS goals and the latest current-to-ideal
 * gap (ISC-442): the dimension percentages in USER/TELOS/LIFEOS_STATE.json, the goals and the tiered target
 * rows in ~/.local/state/lifeos/ideal-state/reconcile.json, and the open loop recommendations beside it.
 * For each row it asks Assay's judgment layer, as caller `vigil-advocate`, whether the row deserves research,
 * preparation or a background run, and which goal or gap it would serve.
 *
 * It runs in shadow (Q-7): its verdict is recorded in the decision row beside the floor's outcome
 * (`advocateField`) and acts only after `Assay.ts report --caller vigil-advocate` shows agreement and
 * {{PRINCIPAL_NAME}} promotes both the caller and `advocate_mode`. While either is shadow, `act` is false and the
 * floor's outcome stands. Advocate rows (source advocate-*) are never judged again (depth 1).
 *
 *   bun LIFEOS/VIGIL/Advocate.ts context [--json]    the goals and gap the advocate would read now
 *   bun LIFEOS/VIGIL/Advocate.ts report [--days 7] [--dry-run]
 *       advocate verdicts, run results and {{PRINCIPAL_NAME}}'s labels in the record, and (ISC-443) one Assay label-store row
 *       per used, rejected or ignored outcome for caller vigil-advocate, question outcome
 *
 * ISC-443, the weekly measure: an outcome is a decision the advocate gave research, prepare or background, or
 * one an advocate run answered (an advocate-* event whose ref is the decision). {{PRINCIPAL_NAME}}'s vigil-log label on the
 * decision (Decision.writeLabel, ref = the decision row) says what he did with it: used (or good) is a principal
 * `right` label, rejected (or noise) a principal `wrong` label, and an outcome a run answered that carries no
 * label, or an explicit ignored, is a `proxy` `unsure` label, which Assay records and never counts. Each write
 * is idempotent by label id (vigil-advocate:<decision>:<used|rejected|ignored>), so a re-run adds nothing.
 *
 * @version 1.1.0
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { getPrincipalName } from "../../hooks/lib/identity";
/** The principal as the prompts address them: the first word of the configured name. */
const firstName = (): string => getPrincipalName().trim().split(/\s+/)[0] || "the principal";
import { lifeosPath } from "../TOOLS/Paths";
import type { LabelInput } from "../TOOLS/lib/LabelStore";
import type { Outcome } from "./Outcome";
import type { HandoffKind } from "./Handoff";

export const ADVOCATE_CALLER = "vigil-advocate";
/** The judgment's choices: none leaves the floor's outcome; the other three hand off to Workflows. */
export const ADVOCATE_CHOICES = ["none", "research", "prepare", "background"] as const;
export type AdvocateChoice = typeof ADVOCATE_CHOICES[number];
/** At most this many rows are judged per tick, highest severity first; the rest keep the floor's outcome. */
export const MAX_JUDGED_PER_TICK = 20;
/** At most this many goals and gap rows are offered as what a row could serve. */
export const MAX_SERVES = 8;

// ── Context: TELOS goals and the current-to-ideal gap ───────────────────────

export type Goal = { id: string; state: string; section?: string };
export type GapRow = { key: string; tier: string; progress: number | null; file?: string; section?: string };
export type OpenRec = { id: string; kind?: string; text: string };
export interface AdvocateContext {
  generated_at: string | null;
  dimensions: Record<string, number>;
  goals: Goal[];
  gap: GapRow[];
  recs: OpenRec[];
  /** Which of the three sources were read; an unread source is named in `detail`, never silently empty. */
  read: { telos: boolean; reconcile: boolean; recommendations: boolean };
  detail: string[];
}

export type ContextPaths = { telos: string; reconcile: string; recommendations: string };
export function defaultContextPaths(): ContextPaths {
  const ideal = join(homedir(), ".local/state/lifeos/ideal-state");
  return { telos: lifeosPath("USER", "TELOS", "LIFEOS_STATE.json"), reconcile: join(ideal, "reconcile.json"), recommendations: join(ideal, "recommendations.json") };
}

function readJson(path: string, detail: string[]): unknown {
  if (!existsSync(path)) { detail.push(`missing: ${path}`); return null; }
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { detail.push(`unparseable: ${path}`); return null; }
}

const TIER_RANK: Record<string, number> = { "needs-input": 0, "close-now": 1, drift: 2, "on-track": 3 };

/** Reads the goals and gap the advocate weighs rows against. Read-only; a missing file is reported, never thrown. */
export function loadAdvocateContext(paths: ContextPaths = defaultContextPaths()): AdvocateContext {
  const detail: string[] = [];
  const telos = readJson(paths.telos, detail) as { generated_at?: unknown; dimensions?: Record<string, { pct?: unknown }> } | null;
  const recon = readJson(paths.reconcile, detail) as { generated_at?: unknown; rows?: unknown; pursuit?: unknown } | null;
  const recs = readJson(paths.recommendations, detail) as { recs?: unknown } | null;
  const dimensions: Record<string, number> = {};
  for (const [k, v] of Object.entries(telos?.dimensions ?? {})) if (typeof v?.pct === "number") dimensions[k] = v.pct;
  const goals: Goal[] = Array.isArray(recon?.pursuit)
    ? (recon!.pursuit as Array<Record<string, unknown>>).filter((p) => p?.type === "goal" && typeof p.id === "string").map((p) => ({ id: p.id as string, state: String(p.state ?? "unknown"), ...(typeof p.section === "string" ? { section: p.section } : {}) }))
    : [];
  const gap: GapRow[] = Array.isArray(recon?.rows)
    ? (recon!.rows as Array<Record<string, unknown>>).filter((r) => typeof r?.key === "string").map((r) => ({
        key: r.key as string, tier: String(r.tier ?? "unknown"), progress: typeof r.progress === "number" ? r.progress : null,
        ...(typeof r.file === "string" ? { file: r.file } : {}), ...(typeof r.section === "string" ? { section: r.section } : {}),
      })).sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
    : [];
  const open: OpenRec[] = Array.isArray(recs?.recs)
    ? (recs!.recs as Array<Record<string, unknown>>).filter((r) => r?.status === "open" && typeof r.id === "string").map((r) => ({ id: r.id as string, ...(typeof r.kind === "string" ? { kind: r.kind } : {}), text: String(r.text ?? r.why ?? "").slice(0, 300) }))
    : [];
  return {
    generated_at: typeof recon?.generated_at === "string" ? recon.generated_at : typeof telos?.generated_at === "string" ? telos.generated_at : null,
    dimensions, goals, gap, recs: open,
    read: { telos: telos !== null, reconcile: recon !== null, recommendations: recs !== null },
    detail,
  };
}

/** What a row may serve: gap rows needing attention first, then goals being pursued, then the rest. Keys are ids. */
export function servesOptions(ctx: AdvocateContext): Array<{ id: string; kind: "gap" | "goal"; label: string }> {
  const gaps = ctx.gap.filter((g) => g.tier !== "on-track").map((g) => ({ id: g.key, kind: "gap" as const, label: `${g.key} (${g.tier}${g.file ? `, ${g.file}` : ""}${g.section ? ` § ${g.section}` : ""})` }));
  const goals = [...ctx.goals].sort((a, b) => (a.state === "pursued" ? 0 : 1) - (b.state === "pursued" ? 0 : 1)).map((g) => ({ id: g.id, kind: "goal" as const, label: `${g.id} (TELOS goal, ${g.state})` }));
  return [...gaps, ...goals].slice(0, MAX_SERVES);
}

// ── The judgment ─────────────────────────────────────────────────────────────

/** One row the advocate weighs: the routing view of a read row, and the outcome the floor gave it. */
export type AdvocateRow = { row_id: string; event_id: string; source: string; kind: string; severity: string; title: string; summary: string; floor: Outcome };

/** The state one judgment reads: the row beside the goals and the gap (ISC-442). */
export function advocateState(row: AdvocateRow, ctx: AdvocateContext): Record<string, unknown> {
  return {
    row: { source: row.source, kind: row.kind, severity: row.severity, title: row.title, summary: row.summary.slice(0, 600) },
    floor_outcome: row.floor,
    telos: { dimensions: ctx.dimensions, goals: ctx.goals.map((g) => ({ id: g.id, state: g.state })) },
    gap: ctx.gap.map((g) => ({ key: g.key, tier: g.tier, progress: g.progress })),
    open_recommendations: ctx.recs.map((r) => ({ id: r.id, kind: r.kind, text: r.text })),
  };
}

/** The two questions, `serves` built from this tick's context. */
export function advocateQuestions(ctx: AdvocateContext) {
  const serves: Record<string, string | null> = { none: "It serves none of the listed goals or gaps." };
  for (const o of servesOptions(ctx)) serves[o.id] = `It moves ${o.kind === "gap" ? "the ideal-state target" : "the TELOS goal"} ${o.label}.`;
  return {
    outcome: {
      type: "choice" as const,
      instructions: `A monitoring row arrived for ${firstName()}. Given their TELOS goals and the current-to-ideal gap beside it, should their assistant do more than the floor outcome, without contacting anyone, spending money or changing any system?`,
      criteria: {
        none: "No: the floor outcome is enough.",
        research: "Research it: read sources and write up what it means for one of their goals or gaps.",
        prepare: "Prepare for it: draft or assemble what they will need when they act on it.",
        background: "Run background work on it: a read-only job whose result they read later.",
      },
    },
    serves: { type: "choice" as const, instructions: `Which of ${firstName()}'s goals or ideal-state gaps would acting on this row move?`, criteria: serves },
  };
}

/** One answer from the judge: the chosen value and its confidence, per question. */
export type JudgeAnswer = { choice: string; confidence: number; act: boolean };
export type JudgeFn = (items: Array<{ key: string; state: Record<string, unknown> }>, questions: ReturnType<typeof advocateQuestions>) => Promise<Array<{ key: string; answers: Record<string, JudgeAnswer> | null; error: string | null }>>;

/** The advocate's verdict on one row, as recorded in its decision row beside the floor's outcome. */
export type AdvocateVerdict = {
  mode: "shadow" | "enforce";
  floor: Outcome;
  verdict: AdvocateChoice | null;
  confidence: number | null;
  /** True only in enforce mode, with a caller verdict that clears its threshold. */
  act: boolean;
  goal?: string;
  gap?: string;
  reason: string;
};

/** The `advocate` field of a decision row. */
export const advocateField = (v: AdvocateVerdict): AdvocateVerdict => ({ ...v });

/** The hand-off kind a verdict asks for when it acts, else null. */
export const actingKind = (v: AdvocateVerdict): HandoffKind | null => (v.act && v.verdict && v.verdict !== "none" ? v.verdict : null);

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Live judge: Assay judgeMany as caller vigil-advocate, the decide() verdict deciding `act`. */
export const assayJudge: JudgeFn = async (items, questions) => {
  const { judgeMany } = await import("../ASSAY/Assay");
  const res = await judgeMany(items.map((i) => ({ key: i.key, state: i.state })), questions, { caller: ADVOCATE_CALLER });
  return res.map((r) => ({
    key: r.key, error: r.error,
    answers: r.result ? Object.fromEntries(Object.entries(r.result).map(([q, j]) => {
      const a = j.answer as { type: string; choice?: string; confidence?: number };
      return [q, { choice: a.type === "choice" ? String(a.choice) : "none", confidence: typeof a.confidence === "number" ? a.confidence : 0, act: j.verdict.act === true }];
    })) : null,
  }));
};

/**
 * Judges this tick's rows. Advocate rows are skipped (depth 1); at most MAX_JUDGED_PER_TICK rows are judged,
 * highest severity first. In shadow every verdict has act false. Never throws on a judge failure: the row
 * keeps the floor's outcome and the verdict carries the error as its reason.
 */
export async function judgeRows(rows: AdvocateRow[], ctx: AdvocateContext, opts: { mode: "shadow" | "enforce"; judge?: JudgeFn; max?: number }): Promise<Map<string, AdvocateVerdict>> {
  invariant(opts.mode === "shadow" || opts.mode === "enforce", "advocate mode is shadow or enforce");
  const out = new Map<string, AdvocateVerdict>();
  const eligible = rows.filter((r) => !r.source.startsWith("advocate-"))
    .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))
    .slice(0, opts.max ?? MAX_JUDGED_PER_TICK);
  if (!eligible.length) return out;
  const questions = advocateQuestions(ctx);
  const options = new Map(servesOptions(ctx).map((o) => [o.id, o.kind]));
  let results: Awaited<ReturnType<JudgeFn>>;
  try { results = await (opts.judge ?? assayJudge)(eligible.map((r) => ({ key: r.row_id, state: advocateState(r, ctx) })), questions); }
  catch (e) { results = eligible.map((r) => ({ key: r.row_id, answers: null, error: String((e as Error)?.message ?? e).slice(0, 200) })); }
  const byKey = new Map(results.map((r) => [r.key, r]));
  for (const row of eligible) {
    const r = byKey.get(row.row_id);
    const o = r?.answers?.outcome, s = r?.answers?.serves;
    const verdict = o && (ADVOCATE_CHOICES as readonly string[]).includes(o.choice) ? (o.choice as AdvocateChoice) : null;
    const serves = s && s.choice !== "none" ? options.get(s.choice) : undefined;
    const act = opts.mode === "enforce" && o?.act === true && verdict !== null && verdict !== "none";
    out.set(row.row_id, {
      mode: opts.mode, floor: row.floor, verdict, confidence: o ? o.confidence : null, act,
      ...(serves === "goal" ? { goal: s!.choice } : serves === "gap" ? { gap: s!.choice } : {}),
      reason: !r || r.error ? `judgment unavailable: ${r?.error ?? "no answer"}` : opts.mode === "shadow" ? "advocate in shadow; the floor's outcome stands" : act ? "caller verdict cleared its threshold" : "caller verdict did not act",
    });
  }
  invariant(opts.mode === "enforce" || [...out.values()].every((v) => !v.act), "nothing acts while the advocate is in shadow");
  return out;
}

// ── ISC-443: the weekly measure ─────────────────────────────────────────────

/** The judgment-layer question the weekly labels land on. */
export const ADVOCATE_QUESTION = "outcome";
/** Label verdicts on an advocate decision, by what they say {{PRINCIPAL_NAME}} did. good and noise are the feedback verdicts in use today. */
export const USED_LABELS: readonly string[] = ["used", "good"];
export const REJECTED_LABELS: readonly string[] = ["rejected", "noise"];
export const IGNORED_LABELS: readonly string[] = ["ignored"];
export type Disposition = "used" | "rejected" | "ignored";

/** The fields of a record row the report reads. */
type ReportRow = { id: string; ts: string; stream: string; kind?: string; ref?: string | null; data?: unknown };
export interface AdvocateReport {
  caller: string; days: number;
  /** Advocate verdicts in decision rows. */
  verdicts: Record<string, number>;
  /** Advocate run results, by source. */
  results: Record<string, number>;
  /** Label verdicts on advocate outcomes, as written. */
  labels: Record<string, number>;
  used: number; rejected: number; ignored: number;
  /** One Assay label per used, rejected or ignored outcome. */
  assay: Array<LabelInput & { id: string }>;
}

/** The weekly counts and the Assay labels they become. Pure: rows in, report out. */
export function advocateReport(rows: ReportRow[], opts: { days: number; since: number }): AdvocateReport {
  invariant(Number.isFinite(opts.days) && opts.days > 0 && Number.isFinite(opts.since), "a report covers a positive window");
  const inWindow = rows.filter((r) => Date.parse(r.ts) >= opts.since);
  const verdicts: Record<string, number> = {}, labels: Record<string, number> = {}, results: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const outcomes = new Map<string, { answered: boolean }>();
  for (const r of inWindow) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (r.stream === "vigil" && r.kind === "decision" && d.advocate && typeof d.advocate === "object") {
      const v = String((d.advocate as { verdict?: unknown }).verdict ?? "none");
      bump(verdicts, v);
      if (v !== "none" && v !== "null") outcomes.set(r.id, outcomes.get(r.id) ?? { answered: false });
    }
  }
  for (const r of inWindow) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    if (r.stream !== "event" || typeof d.source !== "string" || !d.source.startsWith("advocate-")) continue;
    bump(results, d.source);
    const meta = (d.meta ?? {}) as Record<string, unknown>;
    const decision = typeof r.ref === "string" && r.ref ? r.ref : typeof meta.decision === "string" ? meta.decision : null;
    if (decision) outcomes.set(decision, { answered: true });
  }
  // The latest label on each outcome decides it.
  const latest = new Map<string, { ts: string; verdict: string }>();
  for (const r of inWindow) {
    if (r.stream !== "vigil-log" || r.kind !== "label" || !r.ref || !outcomes.has(r.ref)) continue;
    const verdict = String(((r.data ?? {}) as { verdict?: unknown }).verdict ?? "unlabeled");
    bump(labels, verdict);
    const prev = latest.get(r.ref);
    if (!prev || r.ts >= prev.ts) latest.set(r.ref, { ts: r.ts, verdict });
  }
  const assay: AdvocateReport["assay"] = [];
  const counts = { used: 0, rejected: 0, ignored: 0 };
  for (const [decision, o] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
    const v = latest.get(decision)?.verdict;
    const how: Disposition | null = v && USED_LABELS.includes(v) ? "used" : v && REJECTED_LABELS.includes(v) ? "rejected" : (v && IGNORED_LABELS.includes(v)) || (!v && o.answered) ? "ignored" : null;
    if (!how) continue;
    counts[how]++;
    const base = { id: `${ADVOCATE_CALLER}:${decision}:${how}`, kind: "check" as const, caller: ADVOCATE_CALLER, question: ADVOCATE_QUESTION, note: `advocate-report: ${how}${v ? ` (label ${v})` : " (no label)"} on decision ${decision}` };
    assay.push(how === "ignored"
      ? { ...base, source: "proxy", verdict: "unsure", by: "vigil-advocate-report" }
      : { ...base, source: "principal", verdict: how === "used" ? "right" : "wrong", by: "principal" });
  }
  return { caller: ADVOCATE_CALLER, days: opts.days, verdicts, results, labels, ...counts, assay };
}

/** Write the report's Assay labels through the label store (idempotent by id). Returns how many were new. */
export async function writeAdvocateLabels(report: AdvocateReport, opts: { path?: string } = {}): Promise<{ written: number; existing: number }> {
  const { addLabel, readLabels } = await import("../TOOLS/lib/LabelStore");
  invariant(report.assay.every((l) => l.caller === ADVOCATE_CALLER && l.question === ADVOCATE_QUESTION && l.id.startsWith(`${ADVOCATE_CALLER}:`)), "advocate-report writes only vigil-advocate outcome labels");
  invariant(report.assay.every((l) => l.source === "proxy" ? l.verdict === "unsure" : l.verdict === "right" || l.verdict === "wrong"), "a principal label is right or wrong; an ignored outcome is a proxy unsure");
  const have = new Set(readLabels(opts.path ? { path: opts.path } : {}).map((l) => l.id));
  let written = 0, existing = 0;
  for (const l of report.assay) {
    if (have.has(l.id)) { existing++; continue; }
    addLabel(l, opts.path ? { path: opts.path } : {}); written++;
  }
  return { written, existing };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "context") {
    const ctx = loadAdvocateContext();
    if (rest.includes("--json")) console.log(JSON.stringify(ctx, null, 2));
    else console.log(`Goals ${ctx.goals.length} · Gap rows ${ctx.gap.length} · Open recommendations ${ctx.recs.length}${ctx.detail.length ? ` · ${ctx.detail.join("; ")}` : ""}`);
    return 0;
  }
  if (cmd === "report") {
    const i = rest.indexOf("--days"), days = i >= 0 ? Number(rest[i + 1]) : 7;
    invariant(Number.isFinite(days) && days > 0, "--days is a positive number");
    const { scan } = await import("../STATVS/index");
    const since = Date.now() - days * 86_400_000;
    const rows = scan({ streams: ["vigil", "vigil-log", "event"], fromDate: new Date(since).toISOString().slice(0, 10) }).rows;
    const report = advocateReport(rows, { days, since });
    const assay = rest.includes("--dry-run") ? { written: 0, existing: 0, dry_run: true } : await writeAdvocateLabels(report);
    const { assay: labelsOut, ...counts } = report;
    console.log(JSON.stringify({ ...counts, assay: { ...assay, labels: labelsOut.length, caller: ADVOCATE_CALLER, question: ADVOCATE_QUESTION } }));
    return 0;
  }
  console.error("usage: Advocate.ts context [--json] | report [--days N] [--dry-run]");
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
