/** Read-only estate triage for the tier ladder of Assay's judgment layer (LIFEOS/DOCUMENTATION/Assay/AssaySystem.md). Classification only: never draft or run a verifier. */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import { censusRoots, isaFiles } from "./EvalCensus.ts";
import { invariant } from "./Invariant.ts";
import { defaultLogPath, safeCallerConfig, todayUsage } from "../ASSAY/Assay.ts";
import { CLASSIFY_CALLER, classifyRows, manualRows, retireVerdict, rowKey, type ClassifyOptions, type ManualRow } from "./IscTier.ts";
import { PROPOSAL_VERSION, renderProposal, resolveColumns, sha256, splitRow, type ClassifierPath, type IscTierProposal, type ProposalRow } from "./lib/IscTierProposal.ts";

export const TRIAGE_CLASSES = ["retire", "codable", "readable", "taste", "prose", "keep-manual"] as const;
export const STALE_WORK_AGE_MS = 21 * 24 * 60 * 60 * 1000;
export type TriageClass = typeof TRIAGE_CLASSES[number];
type Counts = Record<TriageClass, number>;
const counts = (): Counts => Object.fromEntries(TRIAGE_CLASSES.map(c => [c, 0])) as Counts;
export interface TriageRow {
  isc: string; occurrence: number; check: string; threshold: string; claim: string;
  classification: TriageClass; classified_by: ClassifierPath; reason: string; covered_by?: string[];
}
export interface TriageIsa {
  isa: string; scope: "live" | "history" | "duplicate"; rows: TriageRow[]; counts: Counts; movable: number; proposal?: string; duplicate_of?: string; history_reason?: "closed" | "stale";
}
export interface TriageOptions extends ClassifyOptions { out?: string; roots?: string[] }

export function triageScope(isa: string, text = readFileSync(isa, "utf8"), now = Date.now()): "live" | "history" {
  if (!/\/MEMORY\/WORK\//.test(realpathSync(isa))) return "live";
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!front) return "live";
  // Census includes historical documents with duplicate bookkeeping keys.
  // Read the phase without letting unrelated YAML diagnostics abort the estate.
  const phase = parseDocument(front, { uniqueKeys: false }).get("phase");
  if (typeof phase === "string" && /^(complete|done|closed|learn|archived)$/i.test(phase.trim())) return "history";
  return now - statSync(isa).mtimeMs > STALE_WORK_AGE_MS ? "history" : "live";
}

function historyReason(isa: string, text: string, now = Date.now()): "closed" | "stale" | undefined {
  if (triageScope(isa, text, now) !== "history") return undefined;
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const phase = front ? parseDocument(front, { uniqueKeys: false }).get("phase") : undefined;
  return typeof phase === "string" && /^(complete|done|closed|learn|archived)$/i.test(phase.trim()) ? "closed" : "stale";
}

function gitWorktree(isa: string): { linked: boolean; mainIsa?: string } {
  try {
    const realIsa = realpathSync(isa);
    const [gitDir, commonDir, top] = execFileSync("git", ["-C", dirname(realIsa), "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\r?\n/);
    if (!gitDir || !commonDir || !top) return { linked: false };
    const linked = gitDir !== commonDir;
    if (!linked) return { linked: false };
    return { linked: true, mainIsa: resolve(dirname(commonDir), relative(top, realIsa)) };
  } catch { return { linked: false }; }
}

/** A stable, order-independent identity for the manual rows actually written in an ISA. */
function manualRowSignature(text: string): string {
  let section = false;
  let columns = resolveColumns(null);
  const rows = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) { section = /^##\s+Test Strategy\b/i.test(trimmed); columns = resolveColumns(null); continue; }
    if (!section || !trimmed.startsWith("|")) continue;
    const cells = splitRow(trimmed);
    if (cells.some(c => c.toLowerCase() === "type") && cells.some(c => /^(isc|id|claim)$/i.test(c))) { columns = resolveColumns(cells); continue; }
    if (cells[columns.type] === "manual") rows.add(cells.map(c => c.trim().replace(/\s+/g, " ")).join("\t"));
  }
  return JSON.stringify([...rows].sort());
}

/** Bookkeeping is not an assertion about an artifact. Explicit human decisions stay human. */
export function triageOnlyClass(row: Pick<TriageRow, "check" | "claim">): "prose" | "keep-manual" | null {
  const check = row.check.trim();
  if (/\bhistorical (?:event|notes?|record|evidence only)\b|\bno ongoing state(?: to assert)?\b/i.test(check)) return "prose";
  if (/^(?:shipped(?:\s+(?:in|at)\b|\s*[:—–-]|$)|commit (?:narrative|record)\b|(?:implemented|landed|completed|delivered) in\b)/i.test(check)
    && !/\b(?:verify|check|assert|must|should|returns?|contains?|exists?)\b/i.test(check)) return "prose";
  if (/\b(?:owner|human|person|principal)\b.{0,35}\b(?:sign.off|approval|approves?|ratif\w*|attestation)\b|\b(?:keep manual|remain manual|physical inspection|in.person)\b/i.test(`${check} ${row.claim}`)) return "keep-manual";
  if (!check || /^(?:manual|attested|pending|tbd|n\/a|—|-)$/i.test(check)) return "keep-manual";
  return null;
}

/** Include malformed manual rows the execution parser drops; never silently lose estate debt. */
function readRows(isa: string, text: string): { row: TriageRow; source?: ManualRow }[] {
  const accepted = manualRows(isa);
  const seen = new Map<string, number>();
  const result: { row: TriageRow; source?: ManualRow }[] = [];
  let section = false;
  let col = resolveColumns(null);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("## ")) { section = /^##\s+Test Strategy\b/i.test(t); col = resolveColumns(null); continue; }
    if (!section || !t.startsWith("|")) continue;
    const cells = splitRow(t);
    if (cells.some(c => c.toLowerCase() === "type") && cells.some(c => /^(isc|id|claim)$/i.test(c))) { col = resolveColumns(cells); continue; }
    if (cells[col.type] !== "manual") continue;
    const isc = cells[col.isc] ?? "";
    const occurrence = (seen.get(isc) ?? 0) + 1;
    seen.set(isc, occurrence);
    const check = cells[col.check] ?? "";
    const index = accepted.findIndex(r => r.probe.isc === isc && r.probe.check === check);
    const source = index < 0 ? undefined : { ...accepted.splice(index, 1)[0]!, occurrence };
    result.push({ source, row: { isc, occurrence, check, threshold: cells[col.threshold] ?? "", claim: source?.claim ?? "",
      classification: "keep-manual", classified_by: "fallback", reason: "execution parser rejected this manual row; repair it before migration" } });
  }
  return result;
}

export function assertRetireSibling(row: ManualRow): void {
  invariant(row.siblings?.some(p => p.isc === row.probe.isc && p.type !== "manual"), `retire ${rowKey(row)} requires a non-manual sibling on the same criterion`);
}

export async function triage(opts: TriageOptions = {}) {
  const out = resolve(opts.out ?? "LIFEOS/MEMORY/WORK/isc-tier-triage");
  const files = await isaFiles(opts.roots ?? censusRoots(opts.env));
  const isas: TriageIsa[] = [];
  const proposals: { path: string; value: IscTierProposal }[] = [];
  const totals = { all: counts(), live: counts(), history: counts(), duplicate: counts(), isas: { live: 0, history: 0, duplicate: 0 } };
  const source = files.map(isa => ({ isa, original: readFileSync(isa, "utf8"), worktree: gitWorktree(isa) }));
  const signatures = new Map<string, typeof source>();
  // ISAs with no manual rows all share the empty signature; that is not duplication.
  const empty = manualRowSignature("");
  for (const item of source) {
    const signature = manualRowSignature(item.original);
    if (signature === empty) continue;
    signatures.set(signature, [...(signatures.get(signature) ?? []), item]);
  }
  const duplicateOf = new Map<string, string>();
  for (const group of signatures.values()) {
    if (group.length < 2) continue;
    const canonical = [...group].sort((a, b) => Number(a.worktree.linked) - Number(b.worktree.linked) || realpathSync(a.isa).length - realpathSync(b.isa).length || realpathSync(a.isa).localeCompare(realpathSync(b.isa)))[0]!;
    for (const item of group) if (item !== canonical) duplicateOf.set(item.isa, canonical.isa);
  }
  // A linked worktree is a view of its main worktree even if the corresponding
  // main ISA was outside the selected census roots.
  for (const item of source) if (item.worktree.linked) duplicateOf.set(item.isa, item.worktree.mainIsa ?? duplicateOf.get(item.isa) ?? item.isa);
  let engineRows = 0;
  const offline = opts.offline || (opts.env ?? process.env).LIFEOS_GLANCE_DISABLED === "1";
  const logPath = opts.logPath ?? join(out, "classify.jsonl");
  let engineUnavailable: string | undefined;
  for (const { isa, original } of source) {
    const duplicate = duplicateOf.get(isa);
    const scope = duplicate ? "duplicate" : triageScope(isa, original);
    const entries = readRows(isa, original);
    const pending: ManualRow[] = [];
    for (const entry of entries) {
      if (!entry.source) continue;
      const retired = retireVerdict(entry.source);
      const special = triageOnlyClass(entry.row);
      if (retired.retire) {
        assertRetireSibling(entry.source);
        Object.assign(entry.row, { classification: "retire", reason: retired.reason, covered_by: retired.covered_by });
      } else if (special) Object.assign(entry.row, { classification: special, reason: special === "prose" ? "bookkeeping narrative; no verifier predicate" : "explicit human decision or no actionable check" });
      else pending.push(entry.source);
    }
    // Keep this task's writes in its output directory, but include existing daily
    // usage in the budget. A custom registry/log pair is an isolated caller estate.
    if (!offline && !engineUnavailable && !opts.callersPath && resolve(logPath) !== resolve(defaultLogPath())) {
      const cfg = safeCallerConfig(CLASSIFY_CALLER);
      const shared = todayUsage(CLASSIFY_CALLER);
      const local = todayUsage(CLASSIFY_CALLER, logPath);
      if (cfg && (shared.calls + local.calls >= cfg.budget.calls_per_day || shared.tokens + local.tokens >= cfg.budget.tokens_per_day)) {
        engineUnavailable = "registry daily budget exhausted (shared + triage ledger)";
      }
    }
    const verdicts = scope === "duplicate" ? new Map() : await classifyRows(pending, { ...opts, offline: offline || Boolean(engineUnavailable), poolPerIsa: true, session: isa, logPath });
    for (const v of verdicts.values()) {
      if (v.by === "fallback" && /engine unavailable:.*(?:disabled|not set|budget|fetch failed|network|timed? ?out|requires the registered)/i.test(v.reason)) {
        engineUnavailable ??= v.reason;
      }
    }
    for (const entry of entries) {
      const v = verdicts.get(`${entry.row.isc}#${entry.row.occurrence}`);
      if (v) Object.assign(entry.row, { classification: v.classification === "manual" ? "keep-manual" : v.classification, classified_by: v.by, reason: v.reason });
    }
    const record: TriageIsa = { isa, scope, rows: entries.map(e => e.row), counts: counts(), movable: 0, ...(duplicate ? { duplicate_of: duplicate } : {}), ...(scope === "history" ? { history_reason: historyReason(isa, original) } : {}) };
    for (const row of record.rows) {
      invariant(TRIAGE_CLASSES.includes(row.classification), "triage row must have exactly one known class");
      record.counts[row.classification]++;
      if (scope === "duplicate") totals.duplicate[row.classification]++;
      else { totals.all[row.classification]++; totals[scope][row.classification]++; }
      if (row.classified_by === "engine-shadow") engineRows++;
    }
    totals.isas[scope]++;
    record.movable = record.counts.retire + record.counts.codable + record.counts.readable;
    if (scope === "live" && record.counts.retire) {
      const retireRows = entries.filter(e => e.row.classification === "retire").map(e => {
        invariant(e.source, "retire source must exist"); assertRetireSibling(e.source);
        return { ...e.row, classification: "retire", ratified: false } as ProposalRow;
      });
      const slug = relative(process.cwd(), isa).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
      record.proposal = join(out, "proposals", `${slug}-${sha256(isa).slice(0, 10)}.json`);
      proposals.push({ path: record.proposal, value: { version: PROPOSAL_VERSION, isa: resolve(isa), isa_sha256: sha256(original), generated: new Date().toISOString(),
        classifier: { path: "fallback", caller: CLASSIFY_CALLER, note: "ISC-35 deterministic retirement only; unratified estate triage" }, rows: retireRows } });
    }
    invariant(readFileSync(isa, "utf8") === original, `triage ISA changed while reading: ${isa}`);
    isas.push(record);
  }
  const worklist = isas.filter(i => i.scope === "live").sort((a, b) => b.movable - a.movable || a.isa.localeCompare(b.isa));
  const report = { generated: new Date().toISOString(), out, offline: Boolean(offline), engineRows, engineUnavailable, totals, isas, worklist: worklist.map(i => ({ isa: i.isa, movable: i.movable, counts: i.counts, proposal: i.proposal })) };
  const lines = ["# ISC estate triage", "", "Classification only. No producers, mutation passes, or ISA edits. Retire proposals require ratification.", "",
    `Estate: ${totals.isas.live} live / ${totals.isas.history} history (closed + stale) / ${totals.isas.duplicate} duplicate ISAs. Engine-classified rows: ${engineRows}.`, "",
    "| Class | Estate | Live | History | Duplicate |", "|---|---:|---:|---:|---:|",
    ...TRIAGE_CLASSES.map(c => `| ${c} | ${totals.all[c]} | ${totals.live[c]} | ${totals.history[c]} | ${totals.duplicate[c]} |`), "",
    "## Live ISAs ranked by movable rows", "", "Movable = retire + codable + readable. History is counted above and excluded here.", "",
    "| ISA | Movable | Retire | Codable | Readable | Taste | Prose | Keep manual | Proposal |", "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ...worklist.map(i => `| ${relative(process.cwd(), i.isa)} | ${i.movable} | ${TRIAGE_CLASSES.map(c => i.counts[c]).join(" | ")} | ${i.proposal ? `[unratified](${relative(out, i.proposal)})` : "—"} |`), ""];
  mkdirSync(join(out, "proposals"), { recursive: true });
  for (const p of proposals) writeFileSync(p.path, renderProposal(p.value));
  writeFileSync(join(out, "triage.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, "Triage.md"), lines.join("\n"));
  return report;
}
