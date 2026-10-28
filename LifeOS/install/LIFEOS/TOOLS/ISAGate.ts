#!/usr/bin/env bun
/**
 * @version 1.3.2
 */
// ISAGate.ts — the deterministic ISA structural gate.
//
// The ISA doctrine promises granular, testable, anchored criteria and a document
// that is a real test harness, not a work-log. Until now those promises were
// enforced by a markdown checklist the model may or may not run on itself — so
// they leaked (the 2026-07-23 audit found closed ISAs missing anchoring, with no
// anti-criterion, and with unresolved fog at close). This tool makes the STRUCTURAL,
// un-gameable subset mechanical.
//
// Two tiers, and the split is doctrinal (the Goodhart line the 2026-07-24 Forge
// audit drew):
//   HARD  — binary structural facts a throwaway entry cannot satisfy. Block close.
//           (unresolved fog at complete · missing anchors_to when a goal is stated
//            · non-`M/N` progress format)
//   ADVISORY — anything a count could game (a lone anti-criterion, a no-probe tag).
//           Surface, never block — blocking a count just manufactures the count.
//
// Exit: 0 clean (or advisories only); 2 for hard violations at close, or for
// duplicate criterion IDs at any phase. Advisories print at any phase; most hard
// violations block only at close because a mid-climb ISA legitimately has open
// fog and unwired anchors.

import { readFileSync, existsSync, readdirSync, realpathSync, openSync, readSync, closeSync, fstatSync, statSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";
import { effectiveVerdict, isAssayReceipt, receiptDir, receiptProblem, type ProofReceipt } from "./lib/ProofReceipt";
import { checkText as ladderCheck } from "./IsaLadder";
// The Test Strategy parser (anchors_to for H3, criterion/probe coverage for A2 and
// H8) ships with the runtime: LIFEOS/TOOLS/lib/IsaTestStrategy.ts is the one
// source of truth and Bunker's copy re-exports it, so H3 is a hard block on
// every install (public issue #2037, @lowk3y).
// public issue #2037, @lowk3y
import { coverageOf, parseTestStrategyDiagnostic, type Probe } from "./lib/IsaTestStrategy";
import { parseIsaClaims, parseIsaClaimsText, isaBody } from "./lib/IsaClaims";
import { nextIscId, parseClaims as parseFrontierClaims, validateClaimIds, validateEdges } from "./IsaFrontier";
import { parseAsks } from "./IsaAsks";
import { invalidRowIsNoRow } from "./lib/IsaTemplate";
// The event writer loads optionally (STATVS and Vigil are absent from public installs); VigilOptional owns that.
import { emitVigilEvent, type VigilEvent } from "./lib/VigilOptional";

/** One event through the event writer; nothing when none is installed. A refusal is reported, never thrown. */
async function emitVigil(event: unknown): Promise<void> {
  try { emitVigilEvent(event as VigilEvent); }
  catch (e) { console.error(`[isa-gate] event refused: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)); }
}

export interface Violation {
  code: string;
  tier: "hard" | "advisory";
  message: string;
}

export interface GateReport {
  isaPath: string;
  phase: string;
  hard: Violation[];
  advisory: Violation[];
  blocks: boolean; // hard violations at a close, plus duplicate IDs and checked-without-row at every phase
}

/**
 * The ISA's YAML frontmatter as flat key → value strings. Only the leading
 * `---` block is read, never the body, so a `phase: complete` line quoted in a
 * code block is not the ISA's phase. A value wrapped whole in matching quotes is
 * unquoted (`phase: "complete"` is YAML for `complete`). Shared with
 * hooks/ISAGate.hook.ts so the hook and the gate read one phase (hooks audit shard ad #9).
 */
export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm: Record<string, string> = {};
  if (!m) return fm;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2]!.trim();
    const q = v.match(/^"([^"]*)"$|^'([^']*)'$/);
    fm[kv[1]!] = q ? (q[1] ?? q[2] ?? "").trim() : v;
  }
  return fm;
}

/** The ISA's phase, lowercased: `Complete`, `"complete"` and `complete` are one phase. */
export function isaPhase(fm: Record<string, string>): string {
  return (fm.phase ?? "").trim().toLowerCase();
}

/** A close: phase complete, or a closed milestone_progress. The one definition the gate and its hook share. */
export function isAtClose(fm: Record<string, string>): boolean {
  return isaPhase(fm) === "complete" || milestoneClosed(fm);
}

// Body of a named H2 section, up to the next H2. Null if the section is absent.
// (Rewritten 2026-08-17: the old lazy-regex form used `$` under the `m` flag, so
// any section whose body opened with a blank line captured as "" — which left
// fog-at-complete silently dead on normally-formatted ISAs. Found by the
// extraction test suite.)
function section(text: string, heading: string): string | null {
  const head = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n`, "m").exec(text);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

// Matches the checked checkbox line for one criterion id (`- [x] ISC-3:`,
// bold-wrapped `- [x] **C1a**:` included).
function checkedRe(id: string): RegExp {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*[-*]\\s+\\[[xX]\\]\\s+\\**${esc}\\**\\s*:`, "m");
}

// A criterion's description text, keyed by id (across Criteria + Features blocks).
function claimDescriptions(text: string): { id: string; desc: string; anti: boolean }[] {
  const out: { id: string; desc: string; anti: boolean }[] = [];
  const RE = /^- \[[ xX~-]\]\s+([A-Za-z][A-Za-z0-9.-]*?)\s*(?::|—)\s*(.+)$/;
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(RE);
    if (m) out.push({ id: m[1]!, desc: m[2]!.trim(), anti: /^Anti:/i.test(m[2]!.trim()) });
  }
  return out;
}

// A8 (20260908-universal-eval-reeval ISC-12): the classes a `manual` criterion's
// text can name that the compiler knows how to decompose into an assert. A
// match is advice, never a block — the criterion may still be honestly manual —
// but it says which assert type the criterion was asking for.
const DECOMPOSABLE_CLASSES: { cls: string; re: RegExp; assert: string }[] = [
  { cls: "http", re: /\b(https?:\/\/\S+|endpoint|responds|status \d{3}|returns (?:a )?\d{3}|reachable|\bURL\b|\d{3} on)\b/i, assert: "curl" },
  { cls: "exit", re: /\b(exits? (?:0|non-zero|with|code)|exit code|throws|rejects|returns (?:true|false|null|an? error))\b/i, assert: "bun-test" },
  { cls: "count", re: /\b(exactly \d+|at least \d+|at most \d+|no more than \d+|≥ ?\d+|<= ?\d+|>= ?\d+|\d+ (?:rows|files|lines|items|entries|claims|tests))\b/i, assert: "bash" },
  { cls: "file", re: /\b(file|on disk|exists|is written|written to|directory|path)\b/i, assert: "bash" },
  { cls: "text", re: /\b(contains|names|mentions|includes|lists|carries|says|matches)\b/i, assert: "bash" },
];
export function decomposableClassOf(desc: string): { cls: string; assert: string } | null {
  for (const c of DECOMPOSABLE_CLASSES) if (c.re.test(desc)) return { cls: c.cls, assert: c.assert };
  return null;
}

const EVENT_MARKERS = /\b(remediated|this session|this consolidation|touched only|iter \d+|deployed (?:this|in) |shipped this)\b/i;
const BUNDLE_MARKERS = /\b\w+ and \w+.*\b(and|with)\b|;\s*\w+.*;\s*\w+|\bincluding\b/i;

// ── Extraction era (2026-08-17 redesign) ─────────────────────────────────────
// New hard checks apply only to ISAs scaffolded on/after this date (or with no
// parseable `started:` — Scaffold always writes it, so omission is itself new).
// A date can't be dodged the way an opt-in marker key could; legacy ISAs are
// never retroactively gated (same contract as the hook's edited-this-turn rule).
const EXTRACTION_ADOPTION_MS = Date.parse("2026-08-17T00:00:00-07:00");

// ── Assert era (2026-08-31, every-ISC-an-assert doctrine) ────────────────────
// The extraction era is deliberately NOT reused: ISAs scaffolded between
// 08-17 and 08-31 didn't know the assert-coverage rule. Same creation-time
// signal contract as isExtractionEra; legacy ISAs are retrofitted by the M3
// sweep but never retro-GATED.
const ASSERT_ADOPTION_MS = Date.parse("2026-08-31T00:00:00-07:00");
// Ideal State ladder (ISAFormat v2.28.0). ISAs created before this were migrated
// by sweep (IsaLadder.ts migrate) and are checked advisory-only, never retro-gated.
const LADDER_ADOPTION_MS = Date.parse("2026-09-29T00:00:00-07:00");

function creationEraMs(fm: Record<string, string>): number | null {
  const signals = [
    Date.parse(fm.started ?? ""),
    Date.parse(fm.principal_stated_goal_locked ?? ""),
    Date.parse((fm.slug ?? "").match(/^(\d{4})(\d{2})(\d{2})/)?.slice(1).join("-") ?? ""),
  ].filter((t) => !Number.isNaN(t));
  return signals.length ? Math.min(...signals) : null;
}

export function isLadderEra(fm: Record<string, string>): boolean {
  const t = creationEraMs(fm);
  return t !== null && t >= LADDER_ADOPTION_MS;
}

/**
 * Whether the invalid-row-means-no-row rule applies (20261010-evals-in-the-isa):
 * true when `isa_format` reads as template 2.29.0 or later, the legacy integer
 * `3` included (it reads as 2.29.0). False for older versions, an absent stamp,
 * or an unreadable one. The name is historical; the version logic lives in
 * `lib/IsaTemplate.ts` (20261012-isa-version-checkup-analysis ISC-3, ISC-4).
 */
export function isFormat3(fm: Record<string, string>): boolean {
  return invalidRowIsNoRow(fm);
}

export function isAssertEra(fm: Record<string, string>): boolean {
  const t = creationEraMs(fm);
  return t !== null && t >= ASSERT_ADOPTION_MS;
}

export function isExtractionEra(fm: Record<string, string>): boolean {
  // CREATION-time signals only (started / goal-lock / slug date) — never
  // `updated`, or touching a legacy ISA today would flip it into the new era
  // and retro-gate old content. No parseable signal at all means LEGACY
  // (fail-open for the archive — pre-v7 ISAs often carry no timestamps, and some
  // of them retro-fired when "missing" was treated as new).
  // A modern scaffold always writes started + a dated slug, so a new ISA cannot
  // dodge this by omission without being visibly broken to every other consumer.
  const signals = [
    Date.parse(fm.started ?? ""),
    Date.parse(fm.principal_stated_goal_locked ?? ""),
    Date.parse((fm.slug ?? "").match(/^(\d{4})(\d{2})(\d{2})/)?.slice(1).join("-") ?? ""),
  ].filter((t) => !Number.isNaN(t));
  if (!signals.length) return false;
  return Math.min(...signals) >= EXTRACTION_ADOPTION_MS;
}

// URL-shaped token in the principal's verbatim ask — the deterministic subset of
// "an exemplar was named" (product-name detection is judgment and stays out of
// hard gates; Forge F5). TLD list is deliberately short: comparator sites, not
// file extensions.
const URL_IN_GOAL = /https?:\/\/|www\.|\b[a-z0-9][a-z0-9-]*\.(?:com|io|ai|app|dev|org|net|co)\b/i;

// `milestone_progress: M/N` — closed when M==N and N>0. Optional forever.
export function milestoneClosed(fm: Record<string, string>): boolean {
  const m = (fm.milestone_progress ?? "").trim().match(/^(\d+)\s*\/\s*(\d+)$/);
  return !!m && Number(m[1]) === Number(m[2]) && Number(m[2]) > 0;
}

// Parse an extraction manifest (extraction.md beside the ISA): data rows of a
// markdown table whose disposition cell classifies as isc/fog/oos/killed.
// Returns per-provenance tallies, total rows, and whether a comparator role line
// (`role: replicate|adapt|visual-only|workflow-only|avoid`) is recorded.
export interface ManifestStats {
  total: number;
  byProvenance: Record<string, { candidates: number; isc: number; fog: number; oos: number; killed: number }>;
  hasComparatorRole: boolean;
  malformed: string[];
}
export function parseManifest(path: string): ManifestStats | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const stats: ManifestStats = {
    total: 0,
    byProvenance: {},
    hasComparatorRole: /\brole:\s*(replicate|adapt|visual-only|workflow-only|avoid)\b/i.test(text),
    malformed: [],
  };
  // Column positions come from the table header when one names them (a
  // manifest authored as `# | Candidate | Provenance | Disposition` carries the
  // same facts as the 6-column spec order; a project ISA once shipped that
  // shape and the fixed-index read called every row malformed). Falls back
  // to the spec order id|provenance|derivation|evidence|disposition|rationale.
  // A sectioned manifest (`## 1 — Literal (…)`, one table per provenance, no
  // provenance column) reads the provenance from the heading instead.
  let idCol = 0, provCol: number | null = 1, dispoCol = 4, minCells = 6;
  let sectionProv: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const h2 = line.match(/^##\s+(?:\d+\s*[—-]\s*)?([A-Za-z][A-Za-z ]*?)(?:\s*\(|\s*$)/);
    if (h2) { sectionProv = h2[1]!.trim().toLowerCase(); continue; }
    if (sectionProv === "tally") continue; // the manifest's own summary table is not candidate rows
    if (!line.startsWith("|") || /^\|\s*:?-/.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
    const lower = cells.map((c) => c.toLowerCase());
    if (lower.includes("candidates") && lower.includes("killed")) continue; // a tally header outside a Tally section
    if (lower.includes("disposition")) {
      dispoCol = lower.indexOf("disposition");
      provCol = lower.includes("provenance") ? lower.indexOf("provenance") : null;
      idCol = lower.findIndex((c) => c === "id" || c === "#");
      if (idCol < 0) idCol = 0;
      minCells = Math.max(provCol ?? 0, dispoCol, idCol) + 1;
      continue;
    }
    if (/^\|\s*id\s*\|/i.test(line)) continue;
    if (cells.length < minCells) { stats.malformed.push(line.slice(0, 60)); continue; }
    const id = cells[idCol]!, disposition = cells[dispoCol]!;
    // In a sectioned manifest the heading IS the provenance class; a same-named
    // column there is a per-row source note ("conversation 2026-08-20",
    // "fetched (agents)"), never the class.
    const PROV_CLASSES = new Set(["literal", "implication", "exemplar", "principal corpus", "category priors"]);
    const provenance = sectionProv && PROV_CLASSES.has(sectionProv)
      ? sectionProv
      : provCol !== null ? cells[provCol]! : (sectionProv ?? "unknown");
    const dispo = /^isc[- ]?\d/i.test(disposition) || /^ISC/i.test(disposition) ? "isc"
      : /^fog/i.test(disposition) ? "fog"
      : /^(oos|out[- ]of[- ]scope)/i.test(disposition) ? "oos"
      : /^kill/i.test(disposition) ? "killed"
      : null;
    if (!dispo) { stats.malformed.push(`${id}: disposition "${disposition}"`); continue; }
    const p = (stats.byProvenance[provenance.toLowerCase()] ??= { candidates: 0, isc: 0, fog: 0, oos: 0, killed: 0 });
    p.candidates++;
    p[dispo]++;
    stats.total++;
  }
  return stats;
}

// Parse the "## Extraction" tally table. The table is the one whose header names
// the columns candidates, isc(s), fog, oos and killed, in any order, with or without
// leading or trailing pipes; the provenance class is the column named provenance/class,
// else the first column no count column uses. Class names are compared lowercased with
// bold/code markers stripped (manifest keys are lowercased the same way). A "total" row
// is kept for a sum check. A data row whose five counts are not integers (thousands
// separators allowed) is returned in `malformed`, never skipped. Returns null when the
// section has no such table; tallyHeaderProblem says why when a header tried to be one.
export interface TallyCounts { candidates: number; isc: number; fog: number; oos: number; killed: number }

const TALLY_COLUMNS: Array<[keyof TallyCounts, RegExp]> = [
  ["candidates", /^candidates?$/],
  ["isc", /^iscs?$/],
  ["fog", /^fog$/],
  ["oos", /^oos$/],
  ["killed", /^killed$/],
];

/** The cells of one table line, tolerant of a missing leading or trailing pipe; null for a line with no pipe. */
function tableCells(line: string): string[] | null {
  if (!line.includes("|")) return null;
  const cells = line.split("|").map((c) => c.trim());
  if (line.startsWith("|")) cells.shift();
  if (line.endsWith("|")) cells.pop();
  return cells;
}

const cleanCell = (c: string) => c.replace(/[*`_]/g, "").trim().toLowerCase();
const isSeparator = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));

function tallyColumns(cells: string[]): { cols: Record<keyof TallyCounts, number>; cls: number } | null {
  const lower = cells.map(cleanCell);
  const found = {} as Record<keyof TallyCounts, number>;
  for (const [key, re] of TALLY_COLUMNS) {
    const at = lower.findIndex((c) => re.test(c));
    if (at < 0) return null;
    found[key] = at;
  }
  const used = new Set(Object.values(found));
  if (used.size !== 5) return null;
  let cls = lower.findIndex((c, i) => !used.has(i) && /^(provenance|class|provenance class|source)$/.test(c));
  if (cls < 0) cls = lower.findIndex((_, i) => !used.has(i));
  return cls < 0 ? null : { cols: found, cls };
}

export function parseTally(sectionText: string): { rows: Array<{ cls: string; counts: TallyCounts }>; malformed: string[] } | null {
  let layout: ReturnType<typeof tallyColumns> = null;
  const rows: Array<{ cls: string; counts: TallyCounts }> = [];
  const malformed: string[] = [];
  for (const raw of sectionText.split("\n")) {
    const line = raw.trim();
    const cells = tableCells(line);
    if (cells === null) { if (layout && rows.length + malformed.length > 0) break; continue; }
    if (isSeparator(cells)) continue;
    if (!layout) { layout = tallyColumns(cells); continue; }
    const lower = cells.map(cleanCell);
    const num = (k: keyof TallyCounts) => {
      const cell = (lower[layout!.cols[k]] ?? "").replace(/^(\d{1,3}(?:,\d{3})+)$/, (m) => m.replace(/,/g, ""));
      return /^\d+$/.test(cell) ? Number(cell) : NaN;
    };
    const counts = { candidates: num("candidates"), isc: num("isc"), fog: num("fog"), oos: num("oos"), killed: num("killed") };
    const cls = (lower[layout.cls] ?? "").replace(/\s+/g, " ");
    if (!cls || Object.values(counts).some((n) => Number.isNaN(n))) { malformed.push(line.slice(0, 60)); continue; }
    rows.push({ cls: /^total\b/.test(cls) ? "total" : cls, counts });
  }
  return layout ? { rows, malformed } : null;
}

/**
 * Why a section that tried to carry a tally has none parseTally can read: a table header that names
 * some of the tally columns (candidates, isc, fog, oos, killed) but not all five, or repeats one. Null
 * when the section has no such header at all (prose, or an unrelated table).
 */
export function tallyHeaderProblem(sectionText: string): string | null {
  for (const raw of sectionText.split("\n")) {
    const cells = tableCells(raw.trim());
    if (cells === null || isSeparator(cells)) continue;
    const lower = cells.map(cleanCell);
    const named = TALLY_COLUMNS.filter(([, re]) => lower.some((c) => re.test(c))).map(([key]) => key);
    if (named.length < 2) continue;
    if (tallyColumns(cells)) return null;
    const missing = TALLY_COLUMNS.map(([key]) => key).filter((key) => !named.includes(key));
    return missing.length
      ? `its header names ${named.join(", ")} but not ${missing.join(", ")}`
      : "its header has no column left for the provenance class, or a count column repeats";
  }
  return null;
}

// ── Close reads the run ledger (Assay-everywhere S9, ISC-15) ─────────────────
// A gate reads recorded results and never runs a judge. A criterion's rows are
// looked up in bunker-runs.jsonl by (criterion, probe id) for the CURRENT criteria
// revision. A row without a `revision` field predates this rule and is not
// evidence. The ledger can grow very large, so only its tail is read.

/** Revision of the part of an ISA a result is about: criteria + Test Strategy, checkbox state ignored (ticking a box must not invalidate evidence). */
export function criteriaRevision(text: string): string {
  const keep: string[] = [];
  let on = false, h3 = false;
  const WANT = /^##\s+(?:ISC\s+)?(?:Criteria|Claims|IDEAL\s+STATE\s+CRITERIA|Features|Bridge\s+Criteria|Anti-(?:criteria|claims)|Test\s+Strategy)\b/i;
  for (const line of isaBody(text).split(/\r?\n/)) {
    if (/^##\s/.test(line)) { on = WANT.test(line); h3 = false; }
    else if (/^###\s/.test(line)) { if (/^###\s+Criteria\b/i.test(line)) { on = true; h3 = true; } else if (h3) { on = false; h3 = false; } }
    if (!on) continue;
    const norm = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[(?:[ xX~-]|DEFERRED-VERIFY)\]/, "$1[ ]").trimEnd();
    if (norm) keep.push(norm);
  }
  return createHash("sha256").update(keep.join("\n")).digest("hex").slice(0, 16);
}

/** Same identity as Bunker's ledgerProbeId (type, check, tool); a test pins the two together. */
export function closeProbeId(p: { type: string; check: string; tool: string }): string {
  return createHash("sha256").update(JSON.stringify([p.type, p.check, p.tool])).digest("hex");
}

export const DEFAULT_DEFER_CAP = 3;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;

export function closeLedgerPath(): string {
  return process.env.ISAGATE_LEDGER_PATH ?? process.env.BUNKER_LEDGER_PATH ?? join(getClaudeDir(), "LIFEOS/MEMORY/OBSERVABILITY/bunker-runs.jsonl");
}

/**
 * Every revisioned ledger row is also appended to its revision's own file
 * (Bunker ISC-35), so close reads the whole history of one revision without
 * scanning the ledger. Null for anything that is not a criteriaRevision hash,
 * which keeps a row's revision field from naming a path.
 */
export function revisionLedgerPath(ledgerPath: string, revision: string | undefined): string | null {
  if (!revision || !/^[0-9a-f]{16}$/.test(revision)) return null;
  return join(dirname(ledgerPath), "bunker-by-revision", `${revision}.jsonl`);
}

// ── Per-criterion revisions ──────────────────────────────────────────────────
// A whole-ISA revision changes on any edit to any criterion or row, so one new
// criterion reset every recorded pass in the ISA (a project ISA, 2026-10-10: every recorded pass dropped to zero).
// A criterion revision covers only what that criterion's result is about: its
// own line (checkbox state ignored) and its own Test Strategy rows. It also
// carries the ISA's identity (frontmatter slug, else the first H1), because
// "ISC-1: Tests pass." with the same row in two repos is two different facts.
// The identity is content, never a path, so a worktree of the same ISA shares
// its results the way whole revisions always have.

function isaIdentity(text: string): string {
  const slug = frontmatter(text).slug;
  if (slug) return `slug:${slug}`;
  const h1 = isaBody(text).match(/^#\s+(.+?)\s*$/m);
  return h1 ? `h1:${h1[1]}` : "";
}

/** Criterion id → its revision, from already-parsed claims and probes of `text`. */
export function criterionRevisionsOf(text: string, claims: ReadonlyArray<{ id: string; line: number }>, probes: ReadonlyArray<Probe>): Map<string, string> {
  const identity = isaIdentity(text);
  const body = isaBody(text).split(/\r?\n/);
  // A duplicated id hashes all of its lines: the gate blocks duplicates, and
  // until it is fixed no single line can stand for the id.
  const linesById = new Map<string, string[]>();
  for (const c of claims) {
    const norm = (body[c.line - 1] ?? "").replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[(?:[ xX~-]|DEFERRED-VERIFY)\]/, "$1[ ]").trim();
    linesById.set(c.id, [...(linesById.get(c.id) ?? []), norm]);
  }
  const out = new Map<string, string>();
  for (const [id, lines] of linesById) {
    const rows = probes.filter((p) => p.isc === id).map((p) => [p.type, p.check, p.threshold, p.tool, p.anchors_to, p.severity, p.tier, p.lane, p.stage, p.every ?? null]);
    out.set(id, createHash("sha256").update(JSON.stringify(["criterion-v1", identity, lines, rows])).digest("hex").slice(0, 16));
  }
  return out;
}

// Bunker calls this once per probe result, so a run over a large ISA would
// parse it once per row; the cache holds while the file's text is unchanged.
const criterionRevCache = new Map<string, { text: string; revs: Map<string, string> }>();

/** Criterion id → its current revision for the ISA at `isaPath`. */
export function criterionRevisions(isaPath: string): Map<string, string> {
  const abs = resolve(isaPath);
  const text = readFileSync(abs, "utf8");
  const hit = criterionRevCache.get(abs);
  if (hit && hit.text === text) return hit.revs;
  const revs = criterionRevisionsOf(text, parseIsaClaimsText(text, { path: abs }).claims, parseTestStrategyDiagnostic(abs).probes);
  // The probe parser reads the file itself; cache only when both reads saw the same text.
  if (readFileSync(abs, "utf8") === text) criterionRevCache.set(abs, { text, revs });
  return revs;
}

/** Every ledger row carrying a criterion revision also lands in that revision's own small file. Null for anything that is not a revision hash. */
export function criterionLedgerPath(ledgerPath: string, criterionRevision: string | undefined): string | null {
  if (!criterionRevision || !/^[0-9a-f]{16}$/.test(criterionRevision)) return null;
  return join(dirname(ledgerPath), "bunker-by-criterion", `${criterionRevision}.jsonl`);
}

/**
 * Identity of the recorded evidence a close of this ISA reads: the size and mtime
 * of its revision ledger file, each criterion's ledger file, and the receipt
 * store. A gate result cached against the ISA text alone would survive a newly
 * recorded fail; folding this in makes new evidence a new revision (hooks audit
 * shard ad #10). Only files written for THIS ISA count, never the shared ledger's
 * growth, so another ISA's runs never reset this one's retry bound.
 */
export function closeEvidenceIdentity(isaPath: string, text: string, ledgerPath = closeLedgerPath()): string {
  const stamp = (p: string | null): string => {
    if (!p) return "-";
    try { const s = statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return "-"; }
  };
  const parts = [stamp(revisionLedgerPath(ledgerPath, criteriaRevision(text)))];
  try {
    for (const rev of [...criterionRevisions(isaPath).values()].sort()) parts.push(stamp(criterionLedgerPath(ledgerPath, rev)));
  } catch { parts.push("criteria-unreadable"); }
  try { parts.push(stamp(receiptDir())); } catch { parts.push("-"); }
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Latest result per (criterion, probe) among rows written for one criterion revision, at any time. Reads that revision's file only. */
export function latestCriterionResults(criterionRevision: string | undefined, ledgerPath = closeLedgerPath(), strict = false): Map<string, string> {
  const out = new Map<string, string>();
  const file = criterionLedgerPath(ledgerPath, criterionRevision);
  if (!file || !existsSync(file)) return out;
  let text: string;
  // strict (the close path): a store that exists and cannot be read is a failure to verify, not an empty store.
  try { text = readFileSync(file, "utf8"); } catch (e) { if (strict) throw new LedgerUnreadable(`criterion ledger ${file} is unreadable: ${(e as Error).message}`); return out; }
  const lines = text.split("\n");
  const lastIdx = lastNonEmpty(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.criterion_revision === criterionRevision && typeof row.claim === "string" && typeof row.probe === "string" && typeof row.result === "string") out.set(`${row.claim}|${row.probe}`, row.result);
      else if (strict && row.criterion_revision === criterionRevision) throw new LedgerUnreadable(`criterion ledger ${file} line ${i + 1} is malformed`);
    } catch (e) {
      if (e instanceof LedgerUnreadable) throw e;
      // Only the last line can be torn by a write in flight; an interior line that does not parse is damage.
      if (strict && i !== lastIdx && line.includes(criterionRevision ?? "\0")) throw new LedgerUnreadable(`criterion ledger ${file} line ${i + 1} does not parse`);
    }
  }
  return out;
}

// Latest result per (criterion, probe) for one revision. Later lines win.
// The revision file is authoritative when present (Bunker ISC-34): the main
// ledger can grow fast enough that the 32 MB tail holds under a day of runs, and an
// ISA not re-run since then would read zero results. The tail stays as the fallback for a
// revision that has no file yet.
const tailCache = new Map<string, { key: string; text: string }>();

/** Verification evidence exists but cannot be read or trusted. The close gate turns this into a blocking cannot-verify. */
export class LedgerUnreadable extends Error {
  constructor(message: string) { super(message); this.name = "LedgerUnreadable"; }
}
function lastNonEmpty(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return i;
  return -1;
}
function ledgerTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const key = `${st.size}:${st.mtimeMs}:${maxBytes}`;
    const hit = tailCache.get(path);
    if (hit && hit.key === key) return hit.text;
    const len = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const text = buf.toString("utf8");
    tailCache.set(path, { key, text });
    return text;
  } finally { closeSync(fd); }
}

export function latestResults(revision: string, ledgerPath = closeLedgerPath(), maxBytes = Number(process.env.ISAGATE_LEDGER_BYTES) || LEDGER_TAIL_BYTES): Map<string, string> {
  return new Map([...latestRevisionRows(revision, ledgerPath, maxBytes)].map(([key, row]) => [key, row.result]));
}

interface LatestRow { result: string; criterion_revision?: string }

function latestRevisionRows(revision: string, ledgerPath: string, maxBytes: number, strict = false): Map<string, LatestRow> {
  const out = new Map<string, LatestRow>();
  const revFile = revisionLedgerPath(ledgerPath, revision);
  const source = revFile && existsSync(revFile) ? revFile : ledgerPath;
  if (!existsSync(source)) return out;
  let text: string;
  try { text = source === revFile ? readFileSync(source, "utf8") : ledgerTail(source, maxBytes); } catch (e) {
    if (strict) throw new LedgerUnreadable(`run ledger ${source} is unreadable: ${(e as Error).message}`);
    return out;
  }
  if (!text.includes(revision)) return out;
  const lines = text.split("\n");
  const lastIdx = lastNonEmpty(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes(revision)) continue;
    try {
      const row = JSON.parse(line);
      if (row.revision === revision && typeof row.claim === "string" && typeof row.probe === "string" && typeof row.result === "string") {
        out.set(`${row.claim}|${row.probe}`, typeof row.criterion_revision === "string" ? { result: row.result, criterion_revision: row.criterion_revision } : { result: row.result });
      } else if (strict && row.revision === revision) throw new LedgerUnreadable(`run ledger ${source} line ${i + 1} is malformed`);
    } catch (e) {
      if (e instanceof LedgerUnreadable) throw e;
      // The first line of a tail read starts mid-row and the last line may be mid-write; any other line naming this revision that does not parse is damage.
      if (strict && i !== lastIdx && !(i === 0 && source !== revFile)) throw new LedgerUnreadable(`run ledger ${source} line ${i + 1} names this revision and does not parse`);
    }
  }
  return out;
}

// ── Close reads Proof receipts too (20261010-evals-in-the-isa ISC-11) ────────
// A Proof run against an ISA (`Proof.ts run --isa <ISA> --criteria ISC-n`)
// writes an assay-receipt/1 whose ideal_state is { kind: "isa", path, criteria }.
// Close counts such a receipt as a recorded result for each criterion it names,
// next to the bunker-runs rows. Reading only: no Proof run, no judge.
//   Fresh     = the receipt validates (receiptProblem) and its artifact still
//               holds the bytes it names, by sha256. A changed artifact is not
//               evidence either way.
//   Counted   = verdict pass or fail. unavailable and reference count neither
//               way (nothing was measured), like a shadow row. A verdict word
//               this code does not know counts neither way too.
//   Attribution: the receipt's verdict is about the whole artifact, so it
//               applies to every criterion the receipt names. A fail keeps all of
//               them out of pass; that errs toward open, never toward closed.
// Binding:  the receipt's ideal_state.revision is the ISA's whole-file sha, which
//               changes on any edit, including the close itself, so it cannot bind a
//               criterion's wording. The receipt therefore carries the per-criterion
//               revisions it was measured against (ideal_state.criterion_revisions,
//               id -> criterionRevisionsOf), and a criterion counts a receipt only
//               when its current revision equals the recorded one. A receipt with no
//               recorded revision for a criterion cannot be tied to the current
//               wording: its fail still counts (that errs toward open), its pass
//               never does.
// Attribution is by path identity, never by the receipt's bytes: every receipt is parsed, and every
// path it is judged by goes through one comparator (lexical, resolved, and realpath), so `/./`, `/x/../`,
// a symlinked directory alias or a JSON escape all name the same ISA (S086). The whole read is bounded
// by PROOF_SCAN_MAX_FILES; the comparator caches per string, since the store repeats the same paths.

export const PROOF_SCAN_MAX_FILES = 20_000;

/** The one comparator: whether a path string is one of the ISA's own paths, lexically, resolved, or after resolving symlinks. */
function targetMatcher(targets: ReadonlySet<string>): (p: string) => boolean {
  const seen = new Map<string, boolean>();
  return (p) => {
    let hit = seen.get(p);
    if (hit === undefined) {
      hit = targets.has(p) || targets.has(resolve(p));
      if (!hit) { try { hit = targets.has(realpathSync(p)); } catch { hit = false; } }
      seen.set(p, hit);
    }
    return hit;
  };
}

/** Every string a parsed JSON value holds, object keys included, at any depth. */
function jsonStrings(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) { for (const x of v) stack.push(x); }  // never push(...v): a huge array overflows the call stack
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); stack.push(x); }
  }
  return out;
}

/** A JSON string body decoded, or null when its escapes are malformed. A raw control character (invalid JSON,
 *  but a lenient reader takes it as itself) is decoded as that character, not dropped. */
function decodeJsonString(body: string): string | null {
  try { return JSON.parse(`"${body.replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`) as string; } catch { return null; }
}

/** Every string a JSON text that does not parse as a whole could hold. Well-formed literals are read by regex,
 *  and every run between two quotes is read too, raw and decoded: one stray quote shifts the regex's pairing,
 *  which would otherwise hide every later string, the ISA's path included (S086). Over-reading only adds
 *  candidates, and each candidate still has to be one of this ISA's own absolute paths. */
function literalStrings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)) { const d = decodeJsonString(m[1]!); if (d !== null) out.push(d); }
  for (const run of text.split('"')) { out.push(run); const d = decodeJsonString(run); if (d !== null && d !== run) out.push(d); }
  return out;
}

export interface ProofCriterionResult { result: "pass" | "fail"; artifact: string; ran_at: string; receipt: string }

/** Every fresh Proof receipt that names this ISA, as results per criterion id. Never throws; an unreadable store reads as no results. */
export function proofResults(isaPath: string, opts: { receiptsDir?: string; strict?: boolean; criterionRevs?: ReadonlyMap<string, string> } = {}): Map<string, ProofCriterionResult[]> {
  const out = new Map<string, ProofCriterionResult[]>();
  const strict = opts.strict === true;
  const currentRevs = opts.criterionRevs ?? criterionRevisions(isaPath);
  let dir: string;
  try { dir = opts.receiptsDir ?? receiptDir(); } catch (e) { if (strict) throw new LedgerUnreadable(`receipt store cannot be located: ${(e as Error).message}`); return out; }
  if (!existsSync(dir)) return out;
  const targets = new Set<string>([resolve(isaPath)]);
  try { targets.add(realpathSync(isaPath)); } catch { /* the lexical path still matches */ }
  let names: string[];
  try {
    const all = readdirSync(dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
    if (strict && all.length > PROOF_SCAN_MAX_FILES) throw new LedgerUnreadable(`receipt store holds ${all.length} receipts, over the ${PROOF_SCAN_MAX_FILES} the scan reads; the rest cannot be checked`);
    names = all.slice(0, PROOF_SCAN_MAX_FILES);
  } catch (e) {
    if (e instanceof LedgerUnreadable) throw e;
    if (strict) throw new LedgerUnreadable(`receipt store ${dir} is unreadable: ${(e as Error).message}`);
    return out;
  }
  const isTarget = targetMatcher(targets);
  // Scanning a whole receipt compares absolute strings only: a relative string would resolve against this
  // process's cwd, so an unrelated word could name the ISA from one directory and not another.
  const namesAbsolute = (s: string) => isAbsolute(s) && isTarget(s);
  const shaCache = new Map<string, string | null>();
  const currentSha = (p: string): string | null => {
    if (!shaCache.has(p)) {
      try { shaCache.set(p, createHash("sha256").update(readFileSync(p)).digest("hex")); } catch { shaCache.set(p, null); }
    }
    return shaCache.get(p)!;
  };
  for (const name of names) {
    let text: string;
    try { text = readFileSync(join(dir, name), "utf8"); } catch (e) {
      if (strict) throw new LedgerUnreadable(`receipt ${name} is unreadable: ${(e as Error).message}`);
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch {
      // Unparseable: it names this ISA when any absolute path string in it is this ISA's path.
      if (strict && literalStrings(text).some(namesAbsolute)) throw new LedgerUnreadable(`receipt ${name} names this ISA and does not parse`);
      continue;
    }
    // A receipt is attributed by its absolute ideal-state path (the schema requires one); one whose path is another
    // file is another ISA's evidence. A missing or relative path reads as no path, so the whole receipt is scanned.
    const rawPath = (raw as { ideal_state?: { path?: unknown } } | null)?.ideal_state?.path;
    const refPath = typeof rawPath === "string" && isAbsolute(rawPath) ? rawPath : null;
    if (refPath !== null && !isTarget(refPath)) continue;
    const problem = receiptProblem(raw);
    if (problem !== null) {
      // A schema-invalid receipt is unverifiable evidence, and dropping it could drop a fail (S086). The close
      // gate refuses when its ideal-state path is this ISA, or, with no readable ideal-state path, any path in it is.
      if (strict && (refPath !== null || jsonStrings(raw).some(namesAbsolute))) throw new LedgerUnreadable(`receipt ${name} names this ISA and fails the receipt schema: ${problem}`);
      continue;
    }
    if (refPath === null) continue;
    const r = raw as ProofReceipt;
    if (!isAssayReceipt(r) || r.ideal_state.kind !== "isa") continue;
    const ref = r.ideal_state;
    // ISC-24: admitted-flagged and unmeasured close nothing, and a pre-ISC-24 "pass" with no check passed reads as one of them.
    const v = effectiveVerdict(r);
    if (v !== "pass" && v !== "fail") continue;
    if (!ref.criteria?.length) continue;
    if (currentSha(r.artifact) !== r.sha256) continue;
    const bound = (ref as { criterion_revisions?: unknown }).criterion_revisions;
    const boundRevs = bound && typeof bound === "object" && !Array.isArray(bound) ? (bound as Record<string, unknown>) : {};
    for (const id of new Set(ref.criteria)) {
      const recorded = boundRevs[id];
      if (typeof recorded === "string") {
        // Measured against a recorded wording: it counts only while that is still the criterion's wording.
        if (recorded !== currentRevs.get(id)) continue;
      } else if (v === "pass") {
        // Nothing ties this pass to the current wording, so it proves nothing about it.
        continue;
      }
      const list = out.get(id) ?? [];
      list.push({ result: v, artifact: r.artifact, ran_at: r.ran_at, receipt: name.replace(/\.json$/, "") });
      out.set(id, list);
    }
  }
  return out;
}

export interface CriterionClose { id: string; state: "pass" | "fail" | "deferred" | "open"; reason: string }
export interface CloseStatus {
  revision: string; total: number; passed: number; failed: number; deferred: number; open: number; cap: number;
  criteria: CriterionClose[];
}
const OK_RESULTS = new Set(["pass", "attested"]);
const DEFER_REASON = /\b(?:defer(?:red)?|reason|watcher)\s*[:=]\s*\S/i;

/** What a close would see for this ISA. Reads recorded results only; never runs a probe or a judge. */
export function closeStatus(isaPath: string, opts: { ledgerPath?: string; maxBytes?: number; receiptsDir?: string } = {}): CloseStatus {
  const text = readFileSync(isaPath, "utf8");
  const fm = frontmatter(text);
  const revision = criteriaRevision(text);
  const capRaw = Number(fm.defer_cap);
  const cap = fm.defer_cap !== undefined && Number.isInteger(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_DEFER_CAP;
  const ledgerPath = opts.ledgerPath ?? closeLedgerPath();
  const latest = latestRevisionRows(revision, ledgerPath, opts.maxBytes ?? (Number(process.env.ISAGATE_LEDGER_BYTES) || LEDGER_TAIL_BYTES), true);
  const { probes } = parseTestStrategyDiagnostic(isaPath);
  const lines = isaBody(text).split(/\r?\n/);
  const criteria: CriterionClose[] = [];
  const claims = parseIsaClaims(isaPath).claims;
  const criterionRevs = criterionRevisionsOf(text, claims, probes);
  const proofs = proofResults(isaPath, { receiptsDir: opts.receiptsDir, strict: true, criterionRevs: criterionRevs });
  for (const claim of claims) {
    const line = lines[claim.line - 1] ?? "";
    const deferMarked = /\[DEFERRED-VERIFY\]/.test(line);
    const deferReason = deferMarked && DEFER_REASON.test(line.slice(line.indexOf("DEFERRED-VERIFY")));
    // A result belongs to its own criterion: rows written for the criterion's
    // current revision count wherever they sit in history. Rows from before
    // criterion revisions existed are all older than any that carry one, so the
    // whole-ISA revision answers only when the criterion has none, and only with
    // a row that is that old kind (or this same criterion revision). A newer
    // row for another criterion revision means the identity changed: no result.
    const crev = criterionRevs.get(claim.id);
    const own = latestCriterionResults(crev, ledgerPath, true);
    const whole = (key: string): string | undefined => {
      const row = latest.get(key);
      return row && (!row.criterion_revision || row.criterion_revision === crev) ? row.result : undefined;
    };
    // A shadow glance row counts neither way: it is dropped before the rows are judged.
    const rows = probes.filter((p) => p.isc === claim.id).map((p) => { const key = `${claim.id}|${closeProbeId(p)}`; return { p, r: own.get(key) ?? whole(key) }; }).filter((x) => x.r !== "shadow");
    // ISC-11: each fresh Proof receipt naming this criterion is one more recorded result beside the rows.
    const proofRows = (proofs.get(claim.id) ?? []).map((pr) => ({ p: { check: `proof receipt ${pr.receipt.slice(0, 12)}` }, r: pr.result as string }));
    const all = [...rows, ...proofRows];
    const failing = all.filter((x) => x.r === "fail");
    let c: CriterionClose;
    if (failing.length) c = { id: claim.id, state: "fail", reason: `latest result is fail: ${failing.slice(0, 3).map((x) => x.p.check).join("; ")}` };
    else if (all.length > 0 && all.every((x) => x.r !== undefined && OK_RESULTS.has(x.r))) c = { id: claim.id, state: "pass", reason: proofRows.length ? (rows.length ? "every row has a latest pass or attestation, and every fresh Proof receipt passed" : "a fresh Proof receipt passed (no Test Strategy row)") : "every row has a latest pass or attestation" };
    else if (deferMarked) c = deferReason ? { id: claim.id, state: "deferred", reason: "deferred with a reason" } : { id: claim.id, state: "open", reason: "marked DEFERRED-VERIFY without a reason (add `defer: <reason>` or `watcher: <name>`)" };
    else if (rows.length === 0) c = { id: claim.id, state: "open", reason: probes.some((p) => p.isc === claim.id) ? "only shadow glance rows (they count neither way)" : "no Test Strategy row" };
    else c = { id: claim.id, state: "open", reason: `no recorded result for the current revision: ${rows.filter((x) => !(x.r && OK_RESULTS.has(x.r))).slice(0, 3).map((x) => `${x.p.check} (${x.r ?? "none"})`).join("; ")}` };
    criteria.push(c);
  }
  const n = (s: CriterionClose["state"]) => criteria.filter((c) => c.state === s).length;
  return { revision, total: criteria.length, passed: n("pass"), failed: n("fail"), deferred: n("deferred"), open: n("open"), cap, criteria };
}

export function gateReport(isaPath: string): GateReport {
  const text = readFileSync(isaPath, "utf8");
  const fm = frontmatter(text);
  const phase = isaPhase(fm);
  const hard: Violation[] = [];
  const advisory: Violation[] = [];
  // H9 also blocks claimed progress mid-climb; older hard rules remain close-only.
  const recognized = parseIsaClaims(isaPath);
  const zeroClaims = isAssertEra(fm) && (phase === "complete" || /^(?:0*[1-9]\d*)\/\d+$/.test(fm.progress ?? "")) && recognized.claims.length === 0;
  if (zeroClaims) hard.push({
    code: "zero-recognized-claims", tier: "hard",
    message: `Zero criteria recognized despite non-zero progress or complete phase. ${recognized.diagnostics.map(d => `${d.code}: ${d.message}`).join("; ") || "No criterion-like lines found under recognized criteria headings."}`,
  });

  // ── HARD (structural, un-gameable) ────────────────────────────────────────

  // H0 · criterion IDs identify Test Strategy bindings, so a duplicate silently
  // attributes another criterion's assert. This is invalid at every phase, not
  // merely at close: monitoring ISAs may never enter a closing phase.
  const frontierClaims = parseFrontierClaims(text);
  const duplicateIdErrors = validateClaimIds(frontierClaims);
  if (duplicateIdErrors.length) {
    hard.push({
      code: "duplicate-claim-id",
      tier: "hard",
      message: `${duplicateIdErrors.length} duplicate ISC ID(s): ${duplicateIdErrors.map((e) => e.replace("duplicate ISC ID: ", "")).join(", ")} — IDs bind Test Strategy rows and must be unique.`,
    });
  }

  // H1 · progress must be a mechanical M/N count, not `true`/prose.
  if (!/^\d+\/\d+$/.test(fm.progress ?? "")) {
    hard.push({
      code: "progress-format",
      tier: "hard",
      message: `progress: "${fm.progress ?? ""}" is not M/N — done must be a mechanical criteria count, not an opinion.`,
    });
  }

  // H2 · unresolved fog at close. Fog is honest mid-climb; at complete it must be empty.
  const fog = section(text, "Not yet specified");
  const fogLines = fog
    ? fog.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("<!--"))
    : [];
  if (phase === "complete" && fogLines.length > 0) {
    hard.push({
      code: "fog-at-complete",
      tier: "hard",
      message: `${fogLines.length} unresolved fog line(s) in "## Not yet specified" at phase: complete — graduate each to a criterion or kill it in Decisions.`,
    });
  }

  // H3 · anchors_to present on every Test Strategy row when a goal literal is set.
  const goal = fm.principal_stated_goal;
  const hasGoal = goal !== undefined && goal !== "null" && goal.replace(/^["']|["']$/g, "").length > 0;
  if (hasGoal) {
    const { probes, invalid = [] } = parseTestStrategyDiagnostic(isaPath);
    // Invalid rows (ISC-4, 20261010-evals-in-the-isa) are not probes, but they are
    // still rows an author wrote: H3 asks them for anchors_to exactly as before.
    const missing = [...probes, ...invalid].filter((p) => !p.anchors_to).map((p) => p.isc);
    if (missing.length) {
      hard.push({
        code: "anchors-missing",
        tier: "hard",
        message: `${missing.length} Test Strategy row(s) missing anchors_to though a principal_stated_goal is set: ${missing.slice(0, 8).join(", ")} — every criterion must trace to the literal or a named derived sub-criterion.`,
      });
    }
  }

  // ── HARD · extraction era (2026-08-17 redesign; new ISAs only) ────────────

  const newEra = isExtractionEra(fm);
  const atClose = isAtClose(fm);

  // H4 · milestone_progress format — M/N with M<=N. Key is optional forever;
  // when present it must be mechanical (it drives issue-close in WorkSweep).
  if (fm.milestone_progress !== undefined) {
    const m = fm.milestone_progress.match(/^(\d+)\/(\d+)$/);
    if (!m || Number(m[1]) > Number(m[2])) {
      hard.push({
        code: "milestone-format",
        tier: "hard",
        message: `milestone_progress: "${fm.milestone_progress}" is not M/N with M<=N.`,
      });
    }
  }

  const extractionSection = section(text, "Extraction");
  const manifestPath = join(dirname(isaPath), "extraction.md");
  const manifest = parseManifest(manifestPath);
  const decisions = section(text, "Decisions") ?? "";

  // H5 · exemplar obligation. A URL-shaped token in the principal's verbatim ask
  // means an exemplar decision is owed: either a manifest with a recorded
  // comparator role, or a Decisions row explaining why no exemplar mining
  // (deterministic escape hatch — prevents false blocks on "fix my own site"
  // asks while keeping the unexamined-exemplar shape unwritable). Fires at close only.
  if (newEra && atClose && hasGoal && URL_IN_GOAL.test(goal!)) {
    const excused = /exemplar/i.test(decisions);
    if (!(manifest && manifest.hasComparatorRole) && !excused) {
      hard.push({
        code: "exemplar-unmined",
        tier: "hard",
        message: `the stated goal names a URL/product but no extraction manifest with a comparator role exists (extraction.md) and no Decisions row mentions "exemplar" — a named product is a spec by reference; mine it, or record why not.`,
      });
    }
  }

  // H6 · extraction integrity. The in-ISA section is a generated tally of the
  // manifest, never a self-report: section without manifest fails; tally counts
  // must equal manifest counts per provenance class; malformed rows fail. The
  // tally is read as a table (header names the columns), so a class name with
  // spaces or bold is compared too, a provenance class the manifest has but the
  // tally omits is a mismatch, a row that does not parse is a mismatch, and on
  // extraction-era ISAs a section with a manifest but no tally table is an advisory.
  if (extractionSection !== null) {
    if (!manifest) {
      hard.push({
        code: "extraction-no-manifest",
        tier: "hard",
        message: `"## Extraction" section present but no extraction.md manifest beside the ISA — the section is a tally of the manifest, not a self-report.`,
      });
    } else {
      if (manifest.malformed.length) {
        hard.push({
          code: "extraction-malformed",
          tier: "hard",
          message: `${manifest.malformed.length} malformed manifest row(s): ${manifest.malformed.slice(0, 3).join(" · ")}`,
        });
      }
      const tally = parseTally(extractionSection);
      const mismatches: string[] = [];
      if (tally === null) {
        // A table that names tally columns but cannot be read as the tally is a finding on every era:
        // skipping it would leave the numbers beside the manifest unchecked.
        const problem = tallyHeaderProblem(extractionSection);
        if (problem !== null) {
          hard.push({
            code: "extraction-tally-unparsed",
            tier: "hard",
            message: `"## Extraction" has an extraction.md manifest and a table that looks like the tally, but it cannot be read: ${problem} (columns provenance | candidates | isc | fog | oos | killed, any order) — regenerate the tally from the manifest.`,
          });
        }
        // Advisory, not hard: some live ISAs carry a prose Extraction summary beside a
        // manifest (2026-10-09 scan); making that hard would block their closes on a
        // format the old gate never read. A table shape that is present stays hard-checked.
        else if (newEra) {
          advisory.push({
            code: "extraction-tally-missing",
            tier: "advisory",
            message: `"## Extraction" has an extraction.md manifest but no tally table (columns provenance | candidates | isc | fog | oos | killed) — a prose summary is a self-report; generate the tally from the manifest.`,
          });
        }
      } else {
        const zero = { candidates: 0, isc: 0, fog: 0, oos: 0, killed: 0 };
        const fmt = (c: typeof zero) => `${c.candidates}=${c.isc}+${c.fog}+${c.oos}+${c.killed}`;
        const same = (a: typeof zero, b: typeof zero) =>
          a.candidates === b.candidates && a.isc === b.isc && a.fog === b.fog && a.oos === b.oos && a.killed === b.killed;
        for (const bad of tally.malformed) mismatches.push(`unparsed tally row "${bad}"`);
        for (const row of tally.rows) {
          if (row.cls === "total") {
            const sum = Object.values(manifest.byProvenance).reduce(
              (acc, c) => ({ candidates: acc.candidates + c.candidates, isc: acc.isc + c.isc, fog: acc.fog + c.fog, oos: acc.oos + c.oos, killed: acc.killed + c.killed }),
              { ...zero },
            );
            if (!same(row.counts, sum)) mismatches.push(`total: tally ${fmt(row.counts)} vs manifest ${fmt(sum)}`);
            continue;
          }
          const m = manifest.byProvenance[row.cls] ?? zero;
          if (!same(row.counts, m)) mismatches.push(`${row.cls}: tally ${fmt(row.counts)} vs manifest ${fmt(m)}`);
        }
        const tallied = new Set(tally.rows.map((r) => r.cls));
        for (const [cls, c] of Object.entries(manifest.byProvenance)) {
          if (c.candidates > 0 && !tallied.has(cls)) mismatches.push(`${cls}: in the manifest (${c.candidates} candidates) but missing from the tally`);
        }
      }
      if (mismatches.length) {
        hard.push({
          code: "extraction-tally-mismatch",
          tier: "hard",
          message: `"## Extraction" tally disagrees with extraction.md: ${mismatches.slice(0, 4).join("; ")} — regenerate the tally from the manifest.`,
        });
      }
    }
  }

  // H7 · close-state must be recorded. The unflagged-ambiguity shape — closing complete with
  // context_sufficient: false, interview_invoked: false, and no Decisions row
  // recording the ambiguity flag or a principal `proceed` — becomes unwritable.
  if (
    newEra && phase === "complete" &&
    fm.context_sufficient === "false" && fm.interview_invoked === "false" &&
    !/proceed|ambiguity|flag/i.test(decisions)
  ) {
    hard.push({
      code: "close-state-unrecorded",
      tier: "hard",
      message: `phase: complete with context_sufficient: false + interview_invoked: false and no Decisions row recording the ambiguity flag or a principal proceed — record the override or run the discussion before closing.`,
    });
  }

  // ── HARD · assert era (2026-08-31, every-ISC-an-assert) ──────────────────

  // H8 · assert coverage. Every criterion carries >=1 Test Strategy row at close.
  // A `manual` row satisfies H8 (the sanctioned RARE exception — visible in the
  // manual-exception advisory below), so there is no pressure to fabricate a
  // fake probe; a criterion with ZERO rows is the thing that blocks. anchors_to
  // credit is inherited from coverageOf (two-level ISAs probe containers
  // through leaves — a fresh lookup here would false-block the H3 shape).
  // Deliberate reversal of the 2026-07-24 advisory-only call, principal
  // directive 2026-08-31; the escape valve is what makes the flip safe.
  const cov = coverageOf(isaPath);
  const assertEra = isAssertEra(fm);
  // An invalid row (unknown type word over a non-command tool) is never
  // coverage. On an `isa_format: 3` ISA it does not satisfy H8 either; older ISAs
  // keep today's behaviour and get the named warning below, until the M4
  // migration repairs them (20261010-evals-in-the-isa ISC-4, Decisions).
  const format3 = isFormat3(fm);
  const invalidOnly = cov.invalid ?? [];
  const h8Unprobed = format3 ? cov.unprobed.concat(invalidOnly.filter((id) => !cov.unprobed.includes(id))) : cov.unprobed;
  if (assertEra && atClose && h8Unprobed.length) {
    hard.push({
      code: "assert-coverage",
      tier: "hard",
      message: `${h8Unprobed.length} criteria have NO Test Strategy row at close: ${h8Unprobed.slice(0, 10).join(", ")}${h8Unprobed.length > 10 ? ", …" : ""} — every ISC needs an assert (deterministic or eval), or a \`manual\` exception row stating why no assert exists.${format3 && invalidOnly.length ? ` (${invalidOnly.length} of them have only an invalid row, which counts as none under isa_format: 3.)` : ""}`,
    });
  }

  // H8b · no checkbox without a row, at every phase (2026-09-30). H8 only
  // looked at close, so an assert-era ISA could check criteria off for days on
  // prose probes with zero rows while the 0/N `claims-uncovered` advisory was
  // ignored (one ISA got half its criteria checked with no Test Strategy). A
  // checked criterion with no row at all is closed without its assert
  // (Algorithm criterion 8), so it blocks wherever it appears; unchecked
  // criteria still get their rows by close under H8. `manual` stays the escape.
  const checkedWithoutRow = assertEra && !atClose
    ? h8Unprobed.filter((id) => checkedRe(id).test(text))
    : [];
  if (checkedWithoutRow.length) {
    hard.push({
      code: "checked-without-row",
      tier: "hard",
      message: `${checkedWithoutRow.length} checked criteria have NO Test Strategy row: ${checkedWithoutRow.slice(0, 10).join(", ")}${checkedWithoutRow.length > 10 ? ", …" : ""} — add the assert row (or a \`manual\` row saying why none exists), or uncheck the box.`,
    });
  }

  // H10 · the Ideal State ladder (ISAFormat v2.28.0, Algorithm v8.31.0 criterion 1).
  // Direction is the ISA's first job: `## Ideal State` opens the body with L3
  // (one sentence), L2 (one sentence + four bullets) where required, and L1
  // where required. Shape is deterministic, so a ladder-era ISA cannot close
  // without it; whether the levels AGREE with the criteria is judged
  // (IsaLadder.ts drift) and never blocks. Older ISAs see the same findings as
  // advisory — they were migrated by sweep, never retro-gated.
  const ladder = ladderCheck(isaPath, text);
  if (ladder.errors.length) {
    const hardLadder = isLadderEra(fm) && atClose;
    (hardLadder ? hard : advisory).push({
      code: "ladder",
      tier: hardLadder ? "hard" : "advisory",
      message: `Ideal State ladder: ${ladder.errors.join("; ")}. The ladder states where the work is going and opens every ISA (ISAFormat § The Ideal State ladder); \`bun LIFEOS/TOOLS/IsaLadder.ts migrate <isa>\` repairs a legacy shape.`,
    });
  }

  // H11 · close reads what actually ran (Assay-everywhere ISC-15). Only at a close.
  // A criterion whose latest recorded result for the current revision is a fail
  // blocks; so does a defer count over the cap. A criterion with no recorded
  // result stays open with its reason and is reported, never blocked on (an
  // unavailable verifier means DEFER, LIFEOS/RULES/Verification.md). The gate
  // reads the run ledger only; no judge runs here.
  if (atClose) {
    try {
      const cs = closeStatus(isaPath);
      if (cs.failed > 0 && assertEra) {
        hard.push({
          code: "close-row-failed", tier: "hard",
          message: `${cs.failed} of ${cs.total} criteria have a latest recorded fail for this revision: ${cs.criteria.filter((c) => c.state === "fail").slice(0, 6).map((c) => `${c.id} (${c.reason})`).join("; ")}. Fix it and re-run \`bunker test\`; a fail is never closed by a checkbox.`,
        });
      }
      if (cs.deferred > cs.cap) {
        hard.push({
          code: "defer-cap", tier: "hard",
          message: `${cs.deferred} of ${cs.total} criteria are deferred, over this ISA's cap of ${cs.cap} (defer_cap in frontmatter, default ${DEFAULT_DEFER_CAP}). Verify some of them, or raise defer_cap with a Decisions row saying why.`,
        });
      }
      if (cs.deferred > 0) advisory.push({ code: "deferred", tier: "advisory", message: `${cs.deferred} of ${cs.total} criteria deferred (cap ${cs.cap}): ${cs.criteria.filter((c) => c.state === "deferred").slice(0, 8).map((c) => c.id).join(", ")}.` });
      if (cs.open > 0) advisory.push({ code: "close-unrecorded", tier: "advisory", message: `${cs.passed} of ${cs.total} criteria have a recorded pass for this revision; ${cs.open} stay open (no recorded result, shadow-only, or deferral without a reason). Run \`bunker test\` on this ISA to record them.` });
    } catch (e) {
      // Fail closed. A close that cannot read what ran cannot say that nothing failed,
      // so the failure and defer-cap checks it would have made are replaced by one blocking finding.
      hard.push({
        code: "close-unverifiable", tier: "hard",
        message: `Close cannot verify recorded results, so it cannot say none failed: ${(e as Error)?.message ?? String(e)}. Repair the run ledger or receipt store (or the ISA that failed to parse) and re-run \`bunker test\`; an unreadable store is never read as a clean one.`,
      });
    }
  }

  // ── ADVISORY (count-gameable — surface, never block) ─────────────────────

  const claims = claimDescriptions(text);

  // A9 · invalid rows (20261010-evals-in-the-isa ISC-4). A type word that is not
  // a probe type over a tool cell that is not a command used to read as
  // `manual`. It is now invalid: never run, never coverage. Named at every phase
  // so the author fixes it while the table is open; it turns blocking for every
  // ISA after the M4 migration.
  const diag = parseTestStrategyDiagnostic(isaPath);
  const invalidRows = diag.invalid ?? [];
  if (invalidRows.length) {
    const ids = [...new Set(invalidRows.map((r) => r.isc))];
    advisory.push({
      code: "invalid-row-type",
      tier: "advisory",
      message: `${invalidRows.length} Test Strategy row(s) have an invalid type: ${invalidRows.slice(0, 8).map((r) => `${r.isc} ("${r.rawType || "(none)"}")`).join(", ")}${invalidRows.length > 8 ? ", …" : ""}. Each is neither a probe type nor a command, so it runs nothing and counts as no coverage${format3 ? " and does not satisfy H8 (isa_format: 3)" : "; it will block close after the M4 migration"} — write a probe type (\`manual\` when a person checks it). Criteria: ${ids.slice(0, 10).join(", ")}.`,
    });
  }

  // A10 · label debt at close (20261010-evals-in-the-isa ISC-5). Every `manual`
  // row, and every eval-ref row with a manual stage, closes on a person's word
  // with no label a cheaper check could earn from. Counted so the debt stays
  // visible; never a block.
  if (atClose) {
    const debt = diag.probes.filter((p) => p.type === "manual" || p.staged?.stages.some((s) => s.tier === "human"));
    if (debt.length) {
      const ids = [...new Set(debt.map((p) => p.isc))];
      advisory.push({
        code: "label-debt",
        tier: "advisory",
        message: `label debt: ${debt.length} manual row(s) across ${ids.length} criteria: ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …" : ""}. Each closes on attestation alone; record verdicts (\`bunker attest\`) so a glance or code check can earn the row.`,
      });
    }
  }

  // A6 · manual-exception ledger. Criteria whose ONLY rows are `manual` pass H8
  // by design, but each one is a standing exception to every-ISC-an-assert and
  // must stay visible so "rare" remains true by inspection, not by trust.
  if ((cov.manualOnly ?? []).length) {
    advisory.push({
      code: "manual-exception",
      tier: "advisory",
      message: `${cov.manualOnly!.length} criteria close on manual attestation only (the rare-exception class): ${cov.manualOnly!.slice(0, 10).join(", ")}${cov.manualOnly!.length > 10 ? ", …" : ""}. Each should state why no executable assert exists.`,
    });
  }

  // A8 · manual-decomposable (ISC-12, 20260908-universal-eval-reeval). A criterion
  // whose ONLY rows are `manual` but whose text names a class the compiler can
  // decompose (a URL, a file, a count, an exit code, a string) wanted an assert;
  // say which, never block — the exception class stays honest, not cheap.
  if ((cov.manualOnly ?? []).length) {
    const byId = new Map(claims.map((c) => [c.id, c.desc] as const));
    const hits = cov.manualOnly!.map((id) => ({ id, d: decomposableClassOf(byId.get(id) ?? "") })).filter((h) => h.d);
    if (hits.length) {
      advisory.push({
        code: "manual-decomposable",
        tier: "advisory",
        message: `${hits.length} manual-only criteria name a decomposable class: ${hits.slice(0, 8).map((h) => `${h.id} (${h.d!.cls} → ${h.d!.assert})`).join(", ")}${hits.length > 8 ? ", …" : ""}. Each was asking for that assert; write it, or state why the criterion is honestly manual.`,
      });
    }
  }

  // A7 · absence review (advisory forever — never a gate input). Substantial
  // work — an ISA carrying `## Features` — seeds its anti-criteria from one fresh
  // mind that never saw the criteria (Algorithm v8.29.0 criterion 3; ISAFormat
  // v2.26.0). The discriminator is the on-disk section, never a self-declared
  // tier, and a `skipped — <reason>` value satisfies this check because the
  // skip is then on record. Assert-era ISAs only; nothing retro-gates.
  if (assertEra && /^##\s+Features\s*$/m.test(text) && !fm.absence_review) {
    advisory.push({
      code: "absence-review-missing",
      tier: "advisory",
      message: "`## Features` ISA with no `absence_review:` frontmatter key — the absence pass (ISA Scaffold § Absence pass) has not run and no skip is on record. Advisory only; never blocks.",
    });
  }

  // A0 · disposition calibration (advisory forever — never a floor, never a gate
  // input). Reports extraction density so thin articulation is visible, not punished.
  if (manifest && manifest.total > 0) {
    const t = Object.values(manifest.byProvenance).reduce(
      (a, p) => ({ isc: a.isc + p.isc, fog: a.fog + p.fog, oos: a.oos + p.oos, killed: a.killed + p.killed }),
      { isc: 0, fog: 0, oos: 0, killed: 0 },
    );
    advisory.push({
      code: "extraction-density",
      tier: "advisory",
      message: `extraction: ${manifest.total} dispositions (${t.isc} ISC · ${t.fog} fog · ${t.oos} out-of-scope · ${t.killed} killed).`,
    });
  }

  // A1 · at least one anti-criterion (a goal with zero named failure modes is under-specified).
  if (claims.length > 0 && !claims.some((c) => c.anti)) {
    advisory.push({
      code: "no-anti-claim",
      tier: "advisory",
      message: `no Anti: criterion — name at least one thing that must NOT happen. (advisory: a lone anti-criterion added to pass is theater; write a real one.)`,
    });
  }

  // A2 · criteria with no runnable Test Strategy row (unverifiable, un-re-runnable).
  if (cov.uncovered.length) {
    advisory.push({
      code: "claims-uncovered",
      tier: "advisory",
      message: `${cov.coveredClaims}/${cov.totalClaims} criteria probe-covered — uncovered: ${cov.uncovered.slice(0, 10).join(", ")}${cov.uncovered.length > 10 ? ", …" : ""}. Each should name a probe or an explicit no-probe reason.`,
    });
  }

  // A3 · bundled criteria (Splitting Test — likely 2+ assertions in one criterion).
  const bundled = claims.filter((c) => !c.anti && BUNDLE_MARKERS.test(c.desc)).map((c) => c.id);
  if (bundled.length) {
    advisory.push({
      code: "bundled-claim",
      tier: "advisory",
      message: `${bundled.length} criteria look bundled (Splitting Test — 2+ assertions): ${bundled.slice(0, 8).join(", ")}. Split until each is one binary probe.`,
    });
  }

  // A4 · event-criteria (work-log masquerading as criteria — verify nothing ongoing).
  const events = claims.filter((c) => EVENT_MARKERS.test(c.desc)).map((c) => c.id);
  if (events.length) {
    advisory.push({
      code: "event-claim",
      tier: "advisory",
      message: `${events.length} criteria read as work-log events (verify nothing ongoing): ${events.slice(0, 8).join(", ")}. State the durable end-state, not the action taken.`,
    });
  }

  // A5 · broken edge graph (v2.21.0). Edges are optional forever — this fires
  // only when edges EXIST and are broken (typo'd blocker, cycle), which would
  // otherwise sit latent until someone happens to run IsaFrontier. Advisory,
  // never blocking, per the edges-never-required constraint.
  try {
    if (frontierClaims.some((c) => c.after.length > 0)) {
      const edgeErrors = validateEdges(frontierClaims);
      if (edgeErrors.length) {
        advisory.push({
          code: "edge-graph-broken",
          tier: "advisory",
          message: `dependency edges don't resolve: ${edgeErrors.slice(0, 4).join("; ")}${edgeErrors.length > 4 ? "; …" : ""}. Fix or drop the (after:) references.`,
        });
      }
    }
  } catch { /* IsaFrontier unavailable — edges simply aren't checked here */ }

  // A11 · open asks (advisory forever — never a hard input). An ask is a doubt about the ideal
  // state that only the principal can settle. It is recorded cheaply and never stalls the work, so
  // an open one at close is a nudge to answer it, not a block. `default-unratified` and `answered`
  // asks are settled and stay silent.
  try {
    const openAsks = parseAsks(text).filter((a) => a.status === "open");
    if (openAsks.length) {
      advisory.push({
        code: "open-asks",
        tier: "advisory",
        message: `${openAsks.length} open ask(s) on the ideal state: ${openAsks.slice(0, 8).map((a) => a.id).join(", ")}${openAsks.length > 8 ? ", …" : ""}. Answer them through Skill("ISA","refine"), or run \`bun LIFEOS/TOOLS/IsaAsks.ts settle ${isaPath}\` to record the defaults as unratified.`,
      });
    }
  } catch { /* an unreadable ask fence is the renderer's problem, never the gate's */ }

  // A milestone close (milestone_progress M==N) is a close: hard violations
  // block it exactly as they block phase: complete (2026-08-17 redesign).
  return { isaPath, phase, hard, advisory, blocks: zeroClaims || duplicateIdErrors.length > 0 || checkedWithoutRow.length > 0 || (hard.length > 0 && atClose) };
}

export async function sweepGate(dir: string): Promise<{ total: number; hardBlocked: number; files: { path: string; hard: string[]; advisory: string[] }[] }> {
  // Load the existing filename helper only for sweep, keeping normal CLI startup isolated.
  const { isIsaPath } = await import("../../hooks/lib/isa-utils");
  const files: { path: string; hard: string[]; advisory: string[] }[] = [];
  let hardBlocked = 0;
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isIsaPath(path)) {
        const report = gateReport(path);
        if (report.blocks) hardBlocked++;
        files.push({ path, hard: report.hard.map(v => v.code), advisory: report.advisory.map(v => v.code) });
      }
    }
  }
  walk(dir);
  return { total: files.length, hardBlocked, files };
}

export type LeakSweep = { scanned: number; leaks: { path: string; hard: string[] }[] };

export function leakRoots(): string[] {
  const claude = getClaudeDir();
  const override = process.env.ISAGATE_LEAK_ROOTS;
  const paths: string[] = override !== undefined ? override.split(":").filter(Boolean) : [];
  if (override === undefined) {
    const projects = join(claude, "LIFEOS/USER/PROJECTS.md");
    if (existsSync(projects)) {
      for (const match of readFileSync(projects, "utf8").matchAll(/`([^`\n]*ISA\.md)`/g)) {
        const raw = match[1]!;
        paths.push(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : resolve(claude, raw));
      }
    }
    for (const parent of [join(claude, "LIFEOS"), join(claude, "LIFEOS/MEMORY/WORK")]) {
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(join(parent, entry.name, "ISA.md"));
      }
    }
  }
  const unique = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, homedir());
    if (existsSync(path)) unique.add(realpathSync(path));
  }
  return [...unique].sort();
}

export function leakSweep(paths: string[] = leakRoots()): LeakSweep {
  const leaks: LeakSweep["leaks"] = [];
  for (const path of paths) {
    const fm = frontmatter(readFileSync(path, "utf8"));
    if (!isAssertEra(fm) || !isAtClose(fm)) continue;
    const report = gateReport(path);
    if (report.blocks) leaks.push({ path, hard: report.hard.map((h) => h.code) });
  }
  return { scanned: paths.length, leaks };
}

export async function emitLeakSweep(result: LeakSweep): Promise<void> {
  invariant(Number.isInteger(result.scanned) && result.scanned >= result.leaks.length && result.leaks.every((x) => !!x.path && x.hard.length > 0), "leak sweep event result is valid");
  const count = result.leaks.length;
  const event = { id: randomUUID(), source: "isa-gate", ts: new Date().toISOString(), kind: "other" as const,
    severity: count ? "medium" as const : "info" as const, privacy_class: "personal" as const, ref: null, url: null,
    title: `ISA gate leaks: ${count}`,
    summary: `${count} ISA gate leak(s) across ${result.scanned} scanned. ${result.leaks.slice(0, 5).map((x) => basename(dirname(x.path))).join(", ")}. Full list: bun LIFEOS/TOOLS/ISAGate.ts --leaks`,
    dedup_key: `isa-gate-leaks:${new Date().toISOString().slice(0, 10)}` };
  invariant(event.id.length > 0 && event.dedup_key.length > 0 && event.summary.startsWith(`${count} ISA gate leak(s)`), "leak sweep event is valid");
  await emitVigil(event);
}

export interface LeakSweepCliDeps {
  sweep: () => LeakSweep;
  emitResult: (r: LeakSweep) => Promise<void>;
  emitFailure: () => Promise<void>;
  out: (line: string) => void;
  err: (line: string) => void;
}

const DEFAULT_LEAK_SWEEP_DEPS: LeakSweepCliDeps = {
  sweep: leakSweep,
  emitResult: emitLeakSweep,
  emitFailure: () => emitVigil({ id: randomUUID(), source: "isa-gate", ts: new Date().toISOString(), kind: "other", severity: "low", privacy_class: "personal", ref: null, url: null,
    title: "ISA gate leak sweep failed", summary: "The daily leak sweep threw before finishing. Run bun LIFEOS/TOOLS/ISAGate.ts --leaks to see the error.",
    dedup_key: `isa-gate-leaks:${new Date().toISOString().slice(0, 10)}` }),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
};

/**
 * `--leaks [--json] [--emit]`. Returns the process exit code: 0 when the sweep
 * finished (leaks found or not), 1 when it failed, so a caller never reads a failed
 * verification run as a clean one. JSON callers
 * get `{"ok":false,"error":...}` on failure instead of nothing.
 */
export async function leakSweepCli(args: string[], deps: LeakSweepCliDeps = DEFAULT_LEAK_SWEEP_DEPS): Promise<number> {
  const jsonOut = args.includes("--json");
  const emit = args.includes("--emit");
  let result: LeakSweep;
  try {
    result = deps.sweep();
  } catch (error) {
    deps.err(`ISA leak sweep failed: ${String(error)}`);
    if (jsonOut) deps.out(JSON.stringify({ ok: false, error: String(error) }));
    // A scheduled run writes a Vigil line even when it fails.
    if (emit) {
      try { await deps.emitFailure(); } catch (e) { deps.err(`ISA leak sweep failure event not written: ${String(e)}`); }
    }
    return 1;
  }
  if (jsonOut) deps.out(JSON.stringify(result));
  else {
    for (const leak of result.leaks) deps.out(`${leak.path.replace(homedir(), "~")} ${leak.hard.join(", ")}`);
    deps.out(`Total: ${result.leaks.length} leaks / ${result.scanned} scanned`);
  }
  if (emit) {
    try { await deps.emitResult(result); } catch (e) {
      deps.err(`ISA leak sweep event not written: ${String(e)}`);
      return 1;
    }
  }
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  if (args.includes("--leaks")) process.exit(await leakSweepCli(args));
  const nextIdIndex = args.indexOf("--next-id");
  if (nextIdIndex !== -1) {
    const path = args[nextIdIndex + 1];
    if (!path || path.startsWith("--")) throw new Error("--next-id requires an ISA path");
    console.log(nextIscId(parseFrontierClaims(readFileSync(path, "utf8"))));
    process.exit(0);
  }
  const sweepIndex = args.indexOf("--sweep");
  if (sweepIndex !== -1) {
    const dir = args[sweepIndex + 1];
    if (!dir || dir.startsWith("--")) throw new Error("--sweep requires a directory");
    console.log(JSON.stringify(await sweepGate(dir), null, 2));
    process.exit(0);
  }
  const path = args.find((a) => !a.startsWith("--")) ?? "./ISA.md";
  const r = gateReport(path);
  if (jsonOut) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const v of r.hard) console.log(`❌ HARD  [${v.code}] ${v.message}`);
    for (const v of r.advisory) console.log(`⚠️  ADVISORY [${v.code}] ${v.message}`);
    if (!r.hard.length && !r.advisory.length) console.log(`✅ clean — no structural violations`);
    console.log(
      `\n${r.hard.length} hard · ${r.advisory.length} advisory · phase: ${r.phase || "?"} · ${r.blocks ? "BLOCKS close" : "does not block"}`,
    );
  }
  process.exit(r.blocks ? 2 : 0);
}
