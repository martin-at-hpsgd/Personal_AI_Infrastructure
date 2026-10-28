#!/usr/bin/env bun
/**
 * @version 1.0.1
 * ChangeImpact.ts — did a behavior-defining change make the principal happier, and what else changed?
 *
 * Read-only. Compares the window before a cut with the window after it on the signals LifeOS already
 * records: the principal's own complaints and corrections (Errata ledger), failures the v4 detector
 * found in every exchange (reported or not), breaks of named rules (Errata v4 coverage), and
 * turn-outcome corrections grouped by the era a turn ran on (TurnOutcomes). It also lists every
 * behavior-defining commit inside the after window, so a shift arrives with its suspects.
 *
 * Suspects are commits, not causes: several changes land in any two-week window. Attribution comes
 * from paired A/B evals (Assay Compare); this tool confirms an effect holds in real use.
 *
 * Usage:
 *   bun ChangeImpact.ts --cut <ISO> [--days 14] [--rules id,id] [--era field:before,after] [--min 200] [--json]
 * Exit: 0 improved · 1 mixed, no-change, worse, underpowered or insufficient-data · 2 usage error.
 * stdout (--json): { ok, state, cut, days, before, after, era, suspects }
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir, lifeosPath } from "./Paths.ts";
import { readAll, report, ERA_FIELDS, type EraField } from "./TurnOutcomes.ts";
import { ErrataStore } from "../ERRATA/Store.ts";
import { contextOf, loadTriageModel, predictDetect } from "../ERRATA/Combiner.ts";

const DAY = 86_400_000;

export interface Exchange { id: string; ts: string; prompt?: string; reply_tail?: string }
export interface Complaint { ts: string; kind: string; status?: string; source?: string }
export interface WindowStats {
  from: string; to: string; exchanges: number;
  failures_labeled: number; failures: number; failures_per_1000: number | null;
  complaints: number; complaints_per_1000: number | null;
  /** Null when the last coverage run predates the window end: stale coverage would read as fewer breaks. */
  rule_breaks: number | null; rule_breaks_per_1000: number | null;
}
export type State = "improved" | "mixed" | "no-change" | "worse" | "underpowered" | "insufficient-data";

const per1000 = (k: number, n: number) => (n ? Math.round(10_000 * k / n) / 10 : null);
const COMPLAINT_KINDS = new Set(["complaint", "correction"]);

export function windowStats(from: number, to: number, d: { exchanges: Exchange[]; isFailure: (ex: Exchange) => boolean | null; complaints: Complaint[]; ruleBreakIds: Set<string>; coverageThrough?: string | null }): WindowStats {
  const inWin = (ts: string) => { const t = Date.parse(ts); return t >= from && t < to; };
  const exs = d.exchanges.filter((e) => inWin(e.ts));
  let labeled = 0, failures = 0;
  for (const e of exs) { const v = d.isFailure(e); if (v === null) continue; labeled++; if (v) failures++; }
  const complaints = d.complaints.filter((c) => inWin(c.ts) && COMPLAINT_KINDS.has(c.kind) && c.status !== "duplicate" && (c.source ?? "principal") === "principal").length;
  const covered = d.coverageThrough === undefined || (d.coverageThrough !== null && Date.parse(d.coverageThrough) >= to);
  const breaks = covered ? exs.filter((e) => d.ruleBreakIds.has(e.id)).length : null;
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), exchanges: exs.length,
    failures_labeled: labeled, failures, failures_per_1000: per1000(failures, labeled),
    complaints, complaints_per_1000: per1000(complaints, exs.length),
    rule_breaks: breaks, rule_breaks_per_1000: breaks === null ? null : per1000(breaks, exs.length),
  };
}

/**
 * Minimum detectable relative change, in percent, between two Poisson counts: the smallest change a
 * two-sided test at α 0.05 with power 0.8 (z 1.96 + 0.84) could tell from chance, given the before
 * count and the two windows' denominators. Infinity when the before window has no events.
 */
export function mdePct(beforeCount: number, beforeN: number, afterN: number): number {
  if (beforeCount <= 0 || beforeN <= 0 || afterN <= 0) return Infinity;
  const expectedAfter = beforeCount * afterN / beforeN;
  return Math.round(1000 * 2.8 * Math.sqrt(1 / beforeCount + 1 / expectedAfter)) / 10;
}

export interface SignalChange { signal: "complaints" | "failures"; change_pct: number | null; mde_pct: number; detectable: boolean }

/** Each signal's relative change against what its counts could detect. */
export function signalChanges(before: WindowStats, after: WindowStats): SignalChange[] {
  const one = (signal: SignalChange["signal"], b: number | null, a: number | null, k: number, nb: number, na: number): SignalChange => {
    const change = b && a !== null ? Math.round(1000 * (a - b) / b) / 10 : null;
    const mde = mdePct(k, nb, na);
    return { signal, change_pct: change, mde_pct: mde, detectable: change !== null && Math.abs(change) >= mde };
  };
  return [
    one("complaints", before.complaints_per_1000, after.complaints_per_1000, before.complaints, before.exchanges, after.exchanges),
    one("failures", before.failures_per_1000, after.failures_per_1000, before.failures, before.failures_labeled, after.failures_labeled),
  ];
}

/**
 * Two signals vote: the principal's own complaint rate and the v4 failure rate (every exchange,
 * reported or not). A signal votes only when its change clears its minimum detectable change.
 * Both down, or one down and the other silent, is improved; the mirror is worse; one down and one up
 * is mixed, never improved. Movement that no signal can tell from chance is underpowered.
 */
export function verdict(before: WindowStats, after: WindowStats, minExchanges = 200): State {
  if (before.exchanges < minExchanges || after.exchanges < minExchanges) return "insufficient-data";
  const changes = signalChanges(before, after);
  const votes = changes.filter((c) => c.detectable).map((c) => Math.sign(c.change_pct!));
  if (votes.includes(-1) && votes.includes(1)) return "mixed";
  if (votes.includes(-1)) return "improved";
  if (votes.includes(1)) return "worse";
  return changes.some((c) => c.change_pct) ? "underpowered" : "no-change";
}

/** Corrections per 100 judged turns for two values of one era field (e.g. system_prompt 3.22.1 vs 4.0.0). */
export function eraCompare(field: EraField, values: [string, string], turnsPath?: string) {
  const rows = report({ by: field }, turnsPath) as Array<Record<string, unknown>>;
  const pick = (v: string) => rows.find((r) => r[field] === v) ?? { [field]: v, n: 0, judged: 0, corrections_per_100: null };
  return { field, before: pick(values[0]), after: pick(values[1]) };
}

export interface RepoSpec { root: string; paths: string[] }
export interface Suspect { repo: string; sha: string; ts: string; subject: string; files: string[]; tier?: 1 | 2 | 3 }

/** 1 doctrine, identity and model pins (every turn reads them) · 2 routing and agents · 3 hooks. */
export function tierOf(files: string[]): 1 | 2 | 3 {
  if (files.some((f) => /(LIFEOS_SYSTEM_PROMPT\.md|^LIFEOS\/ALGORITHM\/|^CLAUDE\.md|OPERATIONAL_PREFERENCES\.md|^DIGITAL_ASSISTANT\/|PRINCIPAL_IDENTITY\.md|^settings\.json|models\.ts)$|^LIFEOS\/ALGORITHM\/|^DIGITAL_ASSISTANT\//.test(f))) return 1;
  if (files.some((f) => /^(LIFEOS\/ROUTER|agents)\//.test(f))) return 2;
  return 3;
}

/** Commits touching behavior-defining paths inside [since, until), newest first. Unreadable repos are skipped. */
export function suspects(repos: RepoSpec[], since: string, until: string): Suspect[] {
  const out: Suspect[] = [];
  for (const r of repos) {
    if (!existsSync(join(r.root, ".git"))) continue;
    let text = "";
    try {
      text = execFileSync("git", ["-C", r.root, "log", `--since=${since}`, `--until=${until}`, "--format=\u001e%H\u001f%aI\u001f%s", "--name-only", "--", ...r.paths], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch { continue; }
    for (const block of text.split("\u001e").filter((b) => b.trim())) {
      const [head, ...rest] = block.split("\n");
      const [sha, ts, subject] = head.split("\u001f");
      const files = rest.map((f) => f.trim()).filter(Boolean);
      out.push({ repo: r.root, sha: sha.slice(0, 9), ts, subject, files, tier: tierOf(files) });
    }
  }
  return out.sort((a, b) => (a.tier ?? 3) - (b.tier ?? 3) || b.ts.localeCompare(a.ts));
}

/** What every turn reads: doctrine, identity, hooks, agents, model pins and routing. Listed commit by commit. */
export function defaultRepos(): RepoSpec[] {
  const claude = getClaudeDir();
  // LIFEOS/USER is a symlink into the user-data repo; git needs the repo root, so dereference it.
  const userLink = lifeosPath("USER");
  let userResolved = userLink;
  try { userResolved = realpathSync(userLink); } catch { /* no USER tree: keep the link path */ }
  const user = process.env.LIFEOS_USER_REPO ?? userResolved;
  return [
    { root: claude, paths: ["LIFEOS/LIFEOS_SYSTEM_PROMPT.md", "LIFEOS/ALGORITHM", "CLAUDE.md", "hooks", "agents", "settings.json", "LIFEOS/TOOLS/models.ts", "LIFEOS/ROUTER"] },
    { root: user, paths: ["CONFIG/OPERATIONAL_PREFERENCES.md", "DIGITAL_ASSISTANT", "PRINCIPAL/PRINCIPAL_IDENTITY.md"] },
  ];
}

/** Skills change constantly and each touches only its own domain, so they are counted per skill, not listed. */
export function skillChanges(since: string, until: string): Array<{ skill: string; commits: number }> {
  const counts = new Map<string, Set<string>>();
  for (const s of suspects([{ root: getClaudeDir(), paths: ["skills"] }], since, until))
    for (const f of s.files) { const m = f.match(/^skills\/([^/]+)\//); if (m) { const set = counts.get(m[1]) ?? new Set(); set.add(s.sha); counts.set(m[1], set); } }
  return [...counts].map(([skill, shas]) => ({ skill, commits: shas.size })).sort((a, b) => b.commits - a.commits);
}

/**
 * Which era fields moved at the cut, read from the turns themselves: the most common value of each
 * field before vs after. More than one field changing means the comparison is confounded.
 */
export function eraShift(turns: Array<{ ts: string; era?: Record<string, string | null> | null }>, from: number, cut: number, to: number) {
  const top = (a: number, b: number, f: EraField) => {
    const c = new Map<string, number>();
    for (const t of turns) { const ts = Date.parse(t.ts); if (ts >= a && ts < b) { const v = t.era?.[f] ?? "null"; c.set(v, (c.get(v) ?? 0) + 1); } }
    return [...c].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  };
  return ERA_FIELDS.map((field) => { const before = top(from, cut, field), after = top(cut, to, field); return { field, before, after, changed: before !== null && after !== null && before !== after }; });
}

function jsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}

/** The v4 verdict for one exchange: the model tier's class when it ran, else the detect head. Null when unlabeled. */
export function v4Verdicts(v4: string): (ex: Exchange) => boolean | null {
  const detect = new Map<string, Record<string, unknown>>();
  for (const l of jsonl<{ id: string; stage: string; answers: Record<string, unknown> }>(join(v4, "labels.jsonl"))) if (l.stage === "detect") detect.set(l.id, l.answers);
  const tier = new Map<string, string>();
  for (const c of jsonl<{ id: string; class: string }>(join(v4, "classtier.jsonl"))) tier.set(c.id, c.class);
  const model = loadTriageModel();
  return (ex) => {
    const cls = tier.get(ex.id);
    if (cls) return cls !== "not_a_failure";
    const answers = detect.get(ex.id);
    if (!answers || !model) return null;
    const p = predictDetect(model, answers, contextOf({ prompt: ex.prompt ?? "", reply_tail: ex.reply_tail ?? "" }));
    return p ? p.is_failure : null;
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const cutArg = val("--cut"), days = Number(val("--days") ?? 14), min = Number(val("--min") ?? 200);
  const cut = cutArg ? Date.parse(cutArg) : NaN;
  const eraArg = val("--era");
  const eraMatch = eraArg?.match(/^([a-z_]+):([^,]+),(.+)$/);
  if (!Number.isFinite(cut) || !(days > 0) || (eraArg && (!eraMatch || !ERA_FIELDS.includes(eraMatch[1] as EraField)))) {
    console.error(`Usage: ChangeImpact.ts --cut <ISO> [--days 14] [--rules id,id] [--era ${ERA_FIELDS.join("|")}:before,after] [--min 200] [--json]`);
    process.exit(2);
  }
  const errata = process.env.ERRATA_DIR ?? lifeosPath("USER", "ERRATA");
  const v4 = join(errata, "v4");
  const rules = new Set((val("--rules") ?? "").split(",").filter(Boolean));
  const coverage = jsonl<{ id: string; ts: string; rule: string; p: number }>(join(v4, "coverage.jsonl"));
  const ruleBreakIds = new Set(coverage.filter((c) => rules.has(c.rule) && c.p >= 0.7).map((c) => c.id));
  const coverageThrough = coverage.reduce<string | null>((m, c) => (!m || c.ts > m ? c.ts : m), null);
  const data = { exchanges: jsonl<Exchange>(join(v4, "exchanges.jsonl")), isFailure: v4Verdicts(v4), complaints: new ErrataStore().list() as Complaint[], ruleBreakIds, coverageThrough };
  const span = days * DAY;
  const before = windowStats(cut - span, cut, data), after = windowStats(cut, cut + span, data);
  const state = verdict(before, after, min);
  const era = eraMatch ? eraCompare(eraMatch[1] as EraField, [eraMatch[2], eraMatch[3]]) : null;
  const sinceIso = new Date(cut).toISOString(), untilIso = new Date(cut + span).toISOString();
  const sus = suspects(defaultRepos(), sinceIso, untilIso);
  const skills = skillChanges(sinceIso, untilIso);
  const shift = eraShift(readAll(), cut - span, cut, cut + span);
  const confounded = shift.filter((s) => s.changed).map((s) => s.field);
  const changes = signalChanges(before, after);
  const result = { ok: state === "improved", state, cut: sinceIso, days, changes, sources: { windows: "Errata v4 exchanges + Errata ledger", era: "TurnOutcomes turns" }, before, after, era, era_shift: shift, confounded, suspects: sus, skill_changes: skills };
  if (args.includes("--json")) console.log(JSON.stringify(result));
  else {
    console.log(`${state.toUpperCase()}  cut ${result.cut}  ±${days}d`);
    console.log("  Errata (every exchange, v4 detector + the principal's own complaints):");
    for (const [k, w] of [["before", before], ["after", after]] as const) console.log(`    ${k.padEnd(6)} exchanges ${w.exchanges}  complaints/1000 ${w.complaints_per_1000}  v4 failures/1000 ${w.failures_per_1000} (${w.failures_labeled} labeled)  rule breaks/1000 ${w.rule_breaks_per_1000}`);
    const rate = (r: Record<string, unknown>) => `${r[era?.field ?? ""]}: ${r.corrections_per_100 ?? "n/a"} per 100 (judged ${r.judged}${r.reason ? ", " + r.reason : ""})`;
    for (const c of changes) console.log(`    ${c.signal}: ${c.change_pct ?? "n/a"}% change, detectable from ±${c.mde_pct}%${c.detectable ? "" : " (not detectable)"}`);
    if (era) console.log(`  TurnOutcomes (turn corrections by ${era.field}): ${rate(era.before)} → ${rate(era.after)}`);
    console.log(`  Variables that moved at the cut: ${shift.map((x) => `${x.field} ${x.before}→${x.after}${x.changed ? " (changed)" : ""}`).join(" · ")}`);
    if (confounded.length > 1) console.log(`  ⚠ confounded: ${confounded.join(", ")} all changed at the cut`);
    const byTier = [1, 2, 3].map((t) => sus.filter((x) => x.tier === t).length);
    console.log(`  Commits in the after window: ${byTier[0]} doctrine/identity/model · ${byTier[1]} routing/agents · ${byTier[2]} hooks (doctrine first):`); for (const s of sus.slice(0, 25)) console.log(`    T${s.tier} ${s.ts.slice(0, 16)} ${s.sha} ${s.subject.slice(0, 86)}`);
    if (sus.length > 25) console.log(`    … ${sus.length - 25} more in --json`);
    if (skills.length) console.log(`  Skill changes (commits per skill): ${skills.slice(0, 10).map((k) => `${k.skill} ${k.commits}`).join(", ")}${skills.length > 10 ? ` … +${skills.length - 10} skills` : ""}`);
  }
  process.exit(state === "improved" ? 0 : 1);
}

