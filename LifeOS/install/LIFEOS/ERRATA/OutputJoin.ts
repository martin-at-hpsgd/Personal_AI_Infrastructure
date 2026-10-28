/**
 * @version 1.0.0
 * OutputJoin.ts — Errata's read-only joins over the output ledger and Assay receipts (assay-everywhere S10).
 *
 * Errata stores complaints only; it sees everything by joining them to what was delivered:
 *   erratum.context.output_ids -> output line (MEMORY/OBSERVABILITY/outputs-*.jsonl)
 *   output.skill (or output.run_id -> the run line in MEMORY/SKILLS/execution.jsonl) -> the skill
 *   output.receipt_id -> the receipt (receiptDir()/<id>.json), usable only when its sha256 is the output's sha256
 *
 * Four read-only reports, none of which writes a ledger:
 *   skillRows()        per skill: outputs delivered, complaints, complaint rate, false passes   (ISC-26)
 *   falsePasses()      complaints whose output had a passing receipt, with a suggested `Proof.ts miss` command  (ISC-37)
 *   retireCandidates() standing checks dismissed >= 3 times with no matching complaint                          (ISC-37)
 *   impact()           complaint rate per output for N days before vs after a date                              (ISC-40)
 *
 * Every source is injectable so tests run on synthesized ledgers; the defaults read the live stores. A missing source
 * reads as empty, never as an error.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getLifeosDir } from "../TOOLS/Paths";
import { readOutputLines, type OutputLine } from "../TOOLS/lib/OutputLedger";
import { receiptDir } from "../TOOLS/lib/ProofReceipt";
import { addUpgrade as addUpgradeReal, listUpgrades as listUpgradesReal, type UpgradeInput, type UpgradeRecord } from "../TOOLS/Upgrades";
import type { Erratum } from "./Schema";
import type { ErrataStore } from "./Store";

/** Kinds that count as a complaint; praise, questions and feature requests do not. */
const COMPLAINT_KINDS: ReadonlySet<string> = new Set(["complaint", "correction", "bug", "incident"]);
export const RETIRE_AFTER_DISMISSALS = 3;
export const NO_SKILL = "(no skill)";
const DAY_MS = 86_400_000;

export type ReceiptLite = {
  sha256: string;
  verdict: string;
  findings?: { check?: string }[];
  dismissals?: { check: string; at?: string; reason?: string }[];
};
export type LabelLite = { id?: string; ts?: string; source?: string; kind?: string; receipt_id?: string; check_id?: string; verdict?: string; note?: string };
export type StandingCheck = { id: string; note?: string };

export interface JoinSources {
  outputs: OutputLine[];
  /** run_id -> skill from the run ledger; only consulted for an output with no skill of its own. */
  runSkill: (runId: string) => string | null;
  receipt: (receiptId: string) => ReceiptLite | null;
  /** Every receipt in the store as [receipt_id, receipt], for dismissal counting. */
  receipts: () => [string, ReceiptLite][];
  labels: LabelLite[];
  standing: Map<string, StandingCheck[]>;
}

export interface SourceOptions {
  outputsDir?: string;
  executionFile?: string;
  receiptsDir?: string;
  labelsFile?: string;
  standingRoot?: string;
}

function readJsonl<T>(path: string): T[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").flatMap((l) => {
      if (!l.trim()) return [];
      try { return [JSON.parse(l) as T]; } catch { return []; }
    });
  } catch { return []; }
}

/** The live sources, or the overrides a test passes. Nothing is read until a join asks for it. */
export function loadSources(o: SourceOptions = {}): JoinSources {
  const lifeos = () => getLifeosDir();
  const execFile = o.executionFile ?? join(lifeos(), "MEMORY", "SKILLS", "execution.jsonl");
  const recDir = o.receiptsDir ?? receiptDir();
  let runs: Map<string, string> | null = null;
  const readReceipt = (p: string): ReceiptLite | null => {
    try { const r = JSON.parse(readFileSync(p, "utf8")); return r && typeof r.sha256 === "string" && typeof r.verdict === "string" ? r : null; } catch { return null; }
  };
  const standing = new Map<string, StandingCheck[]>();
  const root = o.standingRoot ?? join(lifeos(), "USER", "CUSTOMIZATIONS", "SKILLS");
  try {
    for (const skill of readdirSync(root)) {
      const f = join(root, skill, "StandingChecks.json");
      if (!existsSync(f)) continue;
      try {
        const j = JSON.parse(readFileSync(f, "utf8")) as { checks?: { id?: unknown; note?: unknown; retired?: unknown }[] };
        const checks = (j.checks ?? []).filter((c) => typeof c?.id === "string" && !c.retired).map((c) => ({ id: c.id as string, ...(typeof c.note === "string" ? { note: c.note } : {}) }));
        if (checks.length) standing.set(skill, checks);
      } catch { /* an unreadable standing file reads as none */ }
    }
  } catch { /* no root */ }
  return {
    outputs: readOutputLines(o.outputsDir),
    runSkill: (runId) => {
      if (!runs) {
        runs = new Map();
        for (const l of readJsonl<{ run_id?: string; skill?: string }>(execFile)) if (l.run_id && l.skill) runs.set(l.run_id, l.skill);
      }
      return runs.get(runId) ?? null;
    },
    receipt: (id) => (/^[0-9a-f]{64}$/.test(id) ? readReceipt(join(recDir, `${id}.json`)) : null),
    receipts: () => {
      try {
        return readdirSync(recDir).filter((f) => /^[0-9a-f]{64}\.json$/.test(f)).flatMap((f) => {
          const r = readReceipt(join(recDir, f));
          return r ? [[f.slice(0, -5), r] as [string, ReceiptLite]] : [];
        });
      } catch { return []; }
    },
    labels: readJsonl<LabelLite>(o.labelsFile ?? process.env.LIFEOS_LABEL_STORE ?? join(lifeos(), "USER", "ASSAY", "labels.jsonl")),
    standing,
  };
}

/** The skill an output belongs to: its own, else its run line's, else NO_SKILL. */
export function skillOf(out: OutputLine, src: JoinSources): string {
  if (out.skill) return out.skill;
  return (out.run_id ? src.runSkill(out.run_id) : null) ?? NO_SKILL;
}

type Complaint = { erratum: Erratum; outputs: OutputLine[] };

/** Every complaint-kind erratum that carries output_ids resolving to at least one ledger line. */
export function resolveComplaints(rows: Erratum[], src: JoinSources): Complaint[] {
  const byId = new Map(src.outputs.map((o) => [o.output_id, o]));
  const out: Complaint[] = [];
  for (const e of rows) {
    if (!COMPLAINT_KINDS.has(e.kind)) continue;
    const ids = e.context?.output_ids;
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const outputs = ids.flatMap((id) => { const o = byId.get(id); return o ? [o] : []; });
    if (outputs.length) out.push({ erratum: e, outputs });
  }
  return out;
}

/** True when the output's receipt exists, describes these exact bytes, and passed. A receipt for other bytes proves nothing. */
export function hadPassingReceipt(o: OutputLine, src: JoinSources): boolean {
  if (!o.receipt_id) return false;
  const r = src.receipt(o.receipt_id);
  return !!r && r.sha256 === o.sha256 && r.verdict === "pass";
}

export interface SkillRow {
  skill: string;
  outputs: number;
  complaints: number;
  /** complaints / outputs; null when the skill delivered nothing in the window. */
  rate: number | null;
  false_passes: number;
}

export interface WindowOptions { since?: Date; until?: Date }
const inWindow = (ts: string, w: WindowOptions) => {
  const t = Date.parse(ts);
  return Number.isFinite(t) && (!w.since || t >= w.since.getTime()) && (!w.until || t < w.until.getTime());
};

/** Per-skill delivered, complaints, rate and false passes. A complaint counts once per skill it touches. Read-only. */
export function skillRows(rows: Erratum[], src: JoinSources, w: WindowOptions = {}): SkillRow[] {
  const acc = new Map<string, { outputs: number; complaints: Set<string>; fp: Set<string> }>();
  const get = (s: string) => { let a = acc.get(s); if (!a) { a = { outputs: 0, complaints: new Set(), fp: new Set() }; acc.set(s, a); } return a; };
  // A "blocked" line is a refused hand-off, never delivered: it is not an output the skill delivered.
  for (const o of src.outputs) if (inWindow(o.ts, w) && o.decision !== "blocked") get(skillOf(o, src)).outputs++;
  for (const c of resolveComplaints(rows.filter((e) => inWindow(e.ts, w)), src)) {
    for (const o of c.outputs) {
      const a = get(skillOf(o, src));
      a.complaints.add(c.erratum.id);
      if (c.outputs.length === 1 && hadPassingReceipt(o, src)) a.fp.add(c.erratum.id);
    }
  }
  return [...acc.entries()]
    .map(([skill, a]) => ({ skill, outputs: a.outputs, complaints: a.complaints.size, rate: a.outputs ? Math.round((a.complaints.size / a.outputs) * 10_000) / 10_000 : null, false_passes: a.fp.size }))
    .sort((x, y) => y.complaints - x.complaints || y.outputs - x.outputs || x.skill.localeCompare(y.skill));
}

/** Markdown for the triage report; empty string when the output ledger holds nothing, so reports without S3 data are unchanged. */
export function skillRowsMarkdown(rows: SkillRow[]): string {
  if (!rows.length) return "";
  const pct = (r: number | null) => (r === null ? "-" : `${(r * 100).toFixed(1)}%`);
  return [
    "## Per-skill output quality (output ledger x errata x receipts)", "",
    "| skill | outputs delivered | complaints | complaint rate | false passes |", "|---|---:|---:|---:|---:|",
    ...rows.map((r) => `| ${r.skill} | ${r.outputs} | ${r.complaints} | ${pct(r.rate)} | ${r.false_passes} |`),
    "", "A false pass is a complaint about an output whose receipt (for the same bytes) passed.", "",
  ].join("\n");
}

export interface FalsePass {
  erratum_id: string;
  ts: string;
  skill: string;
  output_id: string;
  receipt_id: string;
  kind: string;
  complaint: string;
  suggested: string;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that would turn this miss into a standing check. The check JSON is a template; the principal fills the pattern. */
export function suggestMissCommand(skill: string, kind: string, complaint: string): string {
  const note = complaint.replace(/\s+/g, " ").trim().slice(0, 160);
  const isText = kind === "text" || kind === "doc";
  const check = isText ? { type: "text-absent", pattern: "<EDIT: the text that should not be there>" } : { type: "glance", question: "<EDIT: the yes/no question the missed defect answers>" };
  const skillArg = skill === NO_SKILL ? "<Skill>" : skill;
  return `bun skills/Assay/Tools/Proof.ts miss --skill ${skillArg} --kind ${kind} --check ${shellQuote(JSON.stringify(check))} --note ${JSON.stringify(note.length >= 8 ? note : `${note} (principal complaint)`)}`;
}

/**
 * Every complaint that cites exactly one output whose receipt passed for its bytes. Oldest first. A complaint citing
 * several outputs (everything the turn delivered) does not say which one it is about, so it names no false pass: one
 * complaint about direction once became six RedTeam misses (2026-10-05).
 */
export function falsePasses(rows: Erratum[], src: JoinSources, w: WindowOptions = {}): FalsePass[] {
  const out: FalsePass[] = [];
  for (const c of resolveComplaints(rows.filter((e) => inWindow(e.ts, w)), src)) {
    if (c.outputs.length !== 1) continue;
    for (const o of c.outputs) {
      if (!hadPassingReceipt(o, src)) continue;
      const skill = skillOf(o, src);
      out.push({
        erratum_id: c.erratum.id, ts: c.erratum.ts, skill, output_id: o.output_id, receipt_id: o.receipt_id!, kind: o.kind,
        complaint: c.erratum.complaint.replace(/\s+/g, " ").slice(0, 200), suggested: suggestMissCommand(skill, o.kind, c.erratum.complaint),
      });
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface RetireCandidate { skill: string; check: string; dismissals: number; note: string | null }

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/** A complaint on this skill matches a check when it names the check id, or shares at least half of the note's content words. */
function complaintMatches(c: Complaint, skill: string, check: StandingCheck, src: JoinSources): boolean {
  if (!c.outputs.some((o) => skillOf(o, src) === skill)) return false;
  const text = [c.erratum.complaint, c.erratum.enrichment?.which_part, c.erratum.enrichment?.what_upset, c.erratum.enrichment?.class].filter(Boolean).join(" ").toLowerCase();
  if (text.includes(check.id.toLowerCase())) return true;
  const nw = check.note ? words(check.note) : new Set<string>();
  if (nw.size === 0) return false;
  const tw = words(text);
  let hit = 0;
  for (const w of nw) if (tw.has(w)) hit++;
  return hit / nw.size >= 0.5;
}

/**
 * Standing checks dismissed >= RETIRE_AFTER_DISMISSALS times with no matching complaint. Dismissals come from receipts'
 * `dismissals` and from the label store (proxy check labels that call a flag wrong); the same flag counted in both is one.
 */
export function retireCandidates(rows: Erratum[], src: JoinSources, min = RETIRE_AFTER_DISMISSALS): RetireCandidate[] {
  if (src.standing.size === 0) return [];
  const bySkillOfReceipt = new Map<string, string>();
  for (const o of src.outputs) if (o.receipt_id) bySkillOfReceipt.set(o.receipt_id, skillOf(o, src));
  const owners = new Map<string, string[]>(); // check id -> skills whose standing set holds it
  for (const [skill, checks] of src.standing) for (const c of checks) owners.set(c.id, [...(owners.get(c.id) ?? []), skill]);
  const seen = new Set<string>();
  const counts = new Map<string, number>(); // `${skill}\0${check}`
  const bump = (receiptId: string | undefined, check: string, uniq: string) => {
    const skill = (receiptId ? bySkillOfReceipt.get(receiptId) : undefined) ?? (owners.get(check)?.length === 1 ? owners.get(check)![0] : undefined);
    if (!skill || !src.standing.get(skill)?.some((c) => c.id === check)) return;
    const key = `${skill}\0${check}\0${uniq}`;
    if (seen.has(key)) return;
    seen.add(key);
    counts.set(`${skill}\0${check}`, (counts.get(`${skill}\0${check}`) ?? 0) + 1);
  };
  for (const [id, r] of src.receipts()) for (const d of r.dismissals ?? []) bump(id, d.check, `${id}|${d.check}|${d.at ?? ""}`);
  for (const l of src.labels) {
    if (l.source !== "proxy" || l.kind !== "check" || l.verdict !== "wrong" || !l.check_id) continue;
    // A label for a receipt dismissal already counted above is the same dismissal.
    const dup = l.receipt_id && (src.receipt(l.receipt_id)?.dismissals ?? []).some((d) => d.check === l.check_id);
    if (dup) continue;
    bump(l.receipt_id, l.check_id, `label|${l.id ?? l.ts ?? ""}`);
  }
  const complaints = resolveComplaints(rows, src);
  const out: RetireCandidate[] = [];
  for (const [key, n] of counts) {
    if (n < min) continue;
    const [skill, check] = key.split("\0");
    const sc = src.standing.get(skill)!.find((c) => c.id === check)!;
    if (complaints.some((c) => complaintMatches(c, skill, sc, src))) continue;
    out.push({ skill, check, dismissals: n, note: sc.note ?? null });
  }
  return out.sort((a, b) => b.dismissals - a.dismissals || a.skill.localeCompare(b.skill) || a.check.localeCompare(b.check));
}

export interface ImpactWindow { from: string; to: string; outputs: number; complaints: number; rate: number | null }
export interface Impact { skill: string; since: string; days: number; before: ImpactWindow; after: ImpactWindow; delta: number | null; verdict: "lower" | "higher" | "unchanged" | "insufficient-data" }

/** Complaint rate per output for `days` before vs `days` from `since` (capped at `now`). Read-only. */
export function impact(rows: Erratum[], src: JoinSources, skill: string, since: Date, days = 14, now = new Date()): Impact {
  const s = since.getTime();
  const win = (from: number, to: number): ImpactWindow => {
    const r = skillRows(rows, src, { since: new Date(from), until: new Date(to) }).find((x) => x.skill === skill);
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), outputs: r?.outputs ?? 0, complaints: r?.complaints ?? 0, rate: r?.rate ?? null };
  };
  const before = win(s - days * DAY_MS, s);
  const after = win(s, Math.min(s + days * DAY_MS, Math.max(now.getTime(), s)));
  const delta = before.rate !== null && after.rate !== null ? Math.round((after.rate - before.rate) * 10_000) / 10_000 : null;
  return { skill, since: since.toISOString(), days, before, after, delta, verdict: delta === null ? "insufficient-data" : delta < 0 ? "lower" : delta > 0 ? "higher" : "unchanged" };
}

export function formatImpact(i: Impact): string {
  const pct = (r: number | null) => (r === null ? "n/a (no outputs)" : `${(r * 100).toFixed(1)}%`);
  const line = (n: string, w: ImpactWindow) => `${n.padEnd(7)} ${w.from.slice(0, 10)} .. ${w.to.slice(0, 10)}  ${w.outputs} outputs, ${w.complaints} complaints, rate ${pct(w.rate)}`;
  return [`impact for ${i.skill} since ${i.since.slice(0, 10)} (${i.days}-day windows)`, line("before", i.before), line("after", i.after), `delta: ${i.delta === null ? "n/a" : `${(i.delta * 100).toFixed(1)} points`} (${i.verdict})`].join("\n");
}

/** `misses` report: false passes with suggested commands, then retire candidates. */
export function formatMisses(fp: FalsePass[], retire: RetireCandidate[]): string {
  const out: string[] = [`false passes: ${fp.length}`];
  for (const f of fp) out.push(`- ${f.erratum_id} · ${f.skill} · ${f.output_id}`, `  complaint: ${f.complaint}`, `  suggest: ${f.suggested}`);
  out.push("", `retire candidates (dismissed ${RETIRE_AFTER_DISMISSALS}+ times, no matching complaint): ${retire.length}`);
  for (const r of retire) out.push(`- ${r.skill} · ${r.check} · dismissed ${r.dismissals}x${r.note ? ` · ${r.note}` : ""}`, `  retire: bun skills/Assay/Tools/Proof.ts retire --skill ${r.skill} --check ${r.check} --reason "<why it keeps missing>"`);
  return out.join("\n");
}

export interface AssayMissDeps {
  /** Injected for tests; defaults to the real Upgrades store. */
  addUpgrade?: (input: UpgradeInput) => { created: boolean; id: string; reason?: string };
  listUpgrades?: (filter: { source: string }) => Pick<UpgradeRecord, "evidence">[];
}
export interface AssayMissFiled { filed: number; duplicates: number; refused: number; ids: string[] }

/**
 * `misses --file-upgrades`: one Upgrades item (source "assay-miss") per false pass, so a check that passed an output the
 * principal then called wrong becomes a queued fix instead of a line in a report. Deduped by output id: an assay-miss item
 * that already carries the output id as evidence is not filed again, and the claim embeds the output id so the store's own
 * claim-hash dedup catches a repeat too. Two complaints about one output file one item.
 */
export function fileAssayMissUpgrades(fp: FalsePass[], deps: AssayMissDeps = {}): AssayMissFiled {
  const add = deps.addUpgrade ?? addUpgradeReal;
  const list = deps.listUpgrades ?? ((f) => listUpgradesReal(f));
  const seen = new Set<string>();
  for (const r of list({ source: "assay-miss" })) for (const e of r.evidence ?? []) seen.add(e);
  const out: AssayMissFiled = { filed: 0, duplicates: 0, refused: 0, ids: [] };
  for (const f of fp) {
    if (seen.has(f.output_id)) { out.duplicates++; continue; }
    seen.add(f.output_id);
    const res = add({
      claim: `A passing receipt let output ${f.output_id} (${f.skill}, ${f.kind}) through and the principal then reported it wrong; add or sharpen a check so this class of miss fails.`,
      source: "assay-miss",
      current_state: `The output carried a passing receipt (${f.receipt_id.slice(0, 12)}). Complaint (${f.erratum_id}): ${f.complaint}`,
      recommendation: `Record the miss, which compiles it into a standing check for the skill: ${f.suggested}`,
      target_surface: "skill",
      confidence: 0.6,
      evidence: [f.output_id, f.receipt_id, f.erratum_id],
    });
    if (res.created) { out.filed++; out.ids.push(res.id); }
    else if (res.reason === "duplicate") out.duplicates++;
    else out.refused++;
  }
  return out;
}

/** Convenience for the CLI and triage: rows from a store. */
export function complaintRows(store: ErrataStore, since?: string): Erratum[] {
  return store.list({ since });
}
