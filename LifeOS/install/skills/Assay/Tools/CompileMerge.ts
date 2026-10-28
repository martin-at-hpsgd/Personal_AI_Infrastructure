/**
 * CompileMerge — folds `Evals.proposed.md` into its ISA (eval-compile ISA,
 * F9 M4, ISC-37). Run as `bun Compile.ts merge <ISA> [--dry-run] [--json]`.
 *
 * Compile writes proposals and never the ISA; this is the one step that does,
 * and only the main session runs it. It applies exactly two things:
 *
 *   1. Test Strategy rows for the criteria the proposal compiled. A criterion's
 *      old rows are replaced only when the proposal covers it: every row when
 *      compile already owns the criterion (a criterion_sha is recorded for it),
 *      otherwise only its invalid rows, manual rows and `eval:#` refs.
 *   2. `## Evals` blocks and row ledger lines keyed by criterion id, each with
 *      its criterion_sha. A block is replaced when compile owns it (sha recorded,
 *      changed or forced) or it no longer parses. The section is created just
 *      before `## Articulation Log` (ISAFormat § Evals), or at the end.
 *
 * Nothing else changes: Glance registrations, splits, refusals, unbound and
 * disabled library checks stay reported items, never applied.
 *
 * Refusals (nothing written): the ISA's body changed since the proposal was
 * compiled (the header's `isa revision`), a criterion would end with two evals
 * (a surviving hand row or hand block beside the compiled one, or duplicate
 * blocks/ledgers/eval refs), or the merged ISA fails to parse the merged rows
 * and blocks.
 *
 * After a successful write the proposal keeps every item merge did not apply
 * (ISC-45): it is rewritten to hold only those sections, under a header that
 * carries the ISA's new revision and says its rows and blocks were merged, so
 * `Compile.ts split` can still read the splits. It is removed only when nothing
 * unapplied remains.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { isaRevision, parseIsaClaimsText } from "../../../LIFEOS/TOOLS/lib/IsaClaims.ts";
import { DEPLOY_CALL_TOOL, isProbeType, MODEL_CALL_TOOL, parseEvalsText, parseTestStrategyDiagnostic, probeCwdOf } from "../../../LIFEOS/TOOLS/lib/IsaTestStrategy.ts";
import { isRemnant, PROPOSED_FILE, recordedShas, REMNANT_MARK } from "./Compile.ts";

export { isRemnant, REMNANT_MARK };

// ── markdown helpers (fence-aware) ──────────────────────────────────────────

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Index of each line that is outside a fenced block. */
function outsideFence(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | null = null;
  for (const l of lines) {
    const m = FENCE.exec(l);
    if (fence) { out.push(false); if (m && l.trim().startsWith(fence)) fence = null; continue; }
    if (m) { fence = m[1]!; out.push(false); continue; }
    out.push(true);
  }
  return out;
}

/** [start, end) of the `## <name>` section (heading line included), or null. */
function sectionRange(lines: string[], name: RegExp): [number, number] | null {
  const free = outsideFence(lines);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!free[i] || !/^##\s/.test(lines[i]!)) continue;
    if (start >= 0) return [start, i];
    if (name.test(lines[i]!.trim())) start = i;
  }
  return start >= 0 ? [start, lines.length] : null;
}

/** Cells of a table row, escapes kept so a cell re-emits byte-identically. */
const cellsOf = (line: string): string[] => line.trim().split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
const isSeparator = (line: string): boolean => cellsOf(line).every((c) => /^:?-+:?$/.test(c) || c === "");

// ── the proposal ────────────────────────────────────────────────────────────

export interface ProposalItem { id: string; kind: "block" | "ledger"; text: string; sha: string | null }
export interface Proposal {
  revision: string;
  rows: { id: string; cells: string[]; line: string }[];
  evals: ProposalItem[];
  /** Sections reported, never applied: heading → lines. */
  reported: Record<string, string[]>;
}

const REVISION_RE = /isa revision ([0-9a-f]{6,64})/;
const LEDGER_LINE = /^<!--\s*criterion_sha\s+([A-Za-z][\w.-]*)\s+([0-9a-f]{6,64})\s*(?:\(row\))?\s*-->\s*$/;
const HEADING_ID = /^###\s+([A-Za-z][\w.-]*?)(?:\s*$|\s+[·—–:-])/;
const SHA_COMMENT = /^\s*#\s*criterion_sha:\s*([0-9a-f]{6,64})\s*$/m;

/** Splits an `## Evals` body into keyed items: `### id` + its fenced block, and ledger lines. Prose is ignored. */
function evalItems(lines: string[]): { id: string; kind: "block" | "ledger"; start: number; end: number; text: string; sha: string | null }[] {
  const items: { id: string; kind: "block" | "ledger"; start: number; end: number; text: string; sha: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const led = LEDGER_LINE.exec(t);
    if (led) { items.push({ id: led[1]!, kind: "ledger", start: i, end: i + 1, text: t, sha: led[2]! }); continue; }
    const h = HEADING_ID.exec(t);
    if (!h) continue;
    // The block runs to the close of the first fence after the heading, else to the next heading.
    let j = i + 1;
    while (j < lines.length && !FENCE.test(lines[j]!) && !/^#{2,3}\s/.test(lines[j]!.trim())) j++;
    let end = j;
    if (j < lines.length && FENCE.test(lines[j]!)) {
      const fence = FENCE.exec(lines[j]!)![1]!;
      let k = j + 1;
      while (k < lines.length && !lines[k]!.trim().startsWith(fence)) k++;
      end = Math.min(k + 1, lines.length);
    }
    const text = lines.slice(i, end).join("\n");
    items.push({ id: h[1]!, kind: "block", start: i, end, text, sha: SHA_COMMENT.exec(text)?.[1] ?? null });
    i = end - 1;
  }
  return items;
}

export function parseProposal(text: string): Proposal {
  const revision = REVISION_RE.exec(text.split("\n", 1)[0] ?? "")?.[1];
  if (!revision) throw new Error("proposal has no `isa revision` header; recompile it");
  const lines = text.split("\n");
  const free = outsideFence(lines);
  const heads: { name: string; i: number }[] = [];
  lines.forEach((l, i) => { if (free[i] && /^##\s/.test(l)) heads.push({ name: l.replace(/^##\s+/, "").trim(), i }); });
  const out: Proposal = { revision, rows: [], evals: [], reported: {} };
  heads.forEach((h, n) => {
    const body = lines.slice(h.i + 1, heads[n + 1]?.i ?? lines.length);
    if (h.name === "Test Strategy rows") {
      for (const l of body) {
        if (!l.trim().startsWith("|") || isSeparator(l)) continue;
        const cells = cellsOf(l);
        if ((cells[0] ?? "").toLowerCase() === "isc") continue;
        out.rows.push({ id: cells[0]!, cells, line: l.trim() });
      }
    } else if (h.name === "Evals") {
      for (const it of evalItems(body)) out.evals.push({ id: it.id, kind: it.kind, text: it.text, sha: it.sha });
    } else {
      out.reported[h.name] = body.filter((l) => l.trim());
    }
  });
  return out;
}

// ── the remnant (ISC-45) ─────────────────────────────────────────────────────

// REMNANT_MARK and isRemnant live in Compile.ts, whose writeProposed carries a remnant forward.

/**
 * The proposal text holding only the given reported sections, headed by the
 * ISA's current revision so a later split or merge can check it. null when no
 * section carries anything, which means the file should be removed.
 */
export function remnantText(isaName: string, revision: string, reported: Record<string, string[]>, note: string): string | null {
  const sections = Object.entries(reported).filter(([, lines]) => lines.some((l) => l.trim()));
  if (!sections.length) return null;
  invariant(/^[0-9a-f]{6,64}$/.test(revision), "a remnant carries the ISA's revision");
  const out = [`<!-- assay compile · ${isaName} · isa revision ${revision} · ${new Date().toISOString().slice(0, 10)} · ${REMNANT_MARK} ${note} -->`, "", "# Proposed evals, not applied", ""];
  for (const [name, lines] of sections) out.push(`## ${name}`, "", ...lines.filter((l) => l.trim()), "");
  return out.join("\n");
}

/** Rewrites (atomically) or removes the proposal; returns the section names kept. */
export function writeRemnant(proposalPath: string, text: string | null): string[] {
  invariant(basename(proposalPath) === PROPOSED_FILE, "only Evals.proposed.md is rewritten as a remnant");
  if (text === null) { if (existsSync(proposalPath)) unlinkSync(proposalPath); return []; }
  invariant(isRemnant(text), "a remnant's header must say it was merged");
  const tmp = join(dirname(proposalPath), `.${PROPOSED_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, proposalPath);
  return [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
}

/** A proposal waits on merge when it exists and still carries rows or blocks; a remnant with only reported items does not. */
export function proposalPending(isaDir: string): boolean {
  const p = join(isaDir, PROPOSED_FILE);
  if (!existsSync(p)) return false;
  const text = readFileSync(p, "utf8");
  if (!isRemnant(text)) return true;
  try { const pr = parseProposal(text); return pr.rows.length > 0 || pr.evals.length > 0; } catch { return true; }
}

// ── column mapping ──────────────────────────────────────────────────────────

type Field = "isc" | "type" | "check" | "threshold" | "tool";
const FIELD_WORDS: Record<string, Field> = {
  isc: "isc", id: "isc", claim: "isc", criterion: "isc", "isc id": "isc",
  type: "type", verifier: "type", kind: "type", class: "type", method: "type",
  check: "check", evidence: "check",
  threshold: "threshold", expected: "threshold", pass: "threshold",
  tool: "tool", assert: "tool", command: "tool", cmd: "tool", "tool / command": "tool",
};
const PROPOSAL_ORDER: Field[] = ["isc", "type", "check", "threshold", "tool"];

/** Each header column's field (or null), the parser's alias words; `probe` is the command unless another column names one. */
function headerFields(header: string[]): (Field | null)[] {
  const words = header.map((c) => c.trim().toLowerCase());
  const namesTool = words.some((w) => FIELD_WORDS[w] === "tool");
  const seen = new Set<Field>();
  return words.map((w) => {
    const f = w === "probe" ? (namesTool ? "check" : "tool") : FIELD_WORDS[w] ?? null;
    if (!f || seen.has(f)) return null;
    seen.add(f);
    return f;
  });
}

/** A proposal row re-laid for the target table's header. */
function fitRow(cells: string[], fields: (Field | null)[]): string {
  const value = (f: Field) => cells[PROPOSAL_ORDER.indexOf(f)] ?? "";
  return `| ${fields.map((f) => (f ? value(f) : "")).join(" | ")} |`;
}

// ── merge ───────────────────────────────────────────────────────────────────

/** Sections that sit after `## Test Strategy` (ISAFormat body order); a new Test Strategy goes before the first present. */
const AFTER_TEST_STRATEGY = /^##\s+(Extraction|Experiments|Features|Decisions|Learning|Verification|Log|Remaining Work|Evals|Articulation Log)\s*$/i;

export interface MergeResult {
  isa: string;
  proposal: string;
  ok: boolean;
  written: boolean;
  dryRun: boolean;
  refusals: string[];
  applied: { rowsAdded: string[]; rowsRemoved: string[]; blocksAdded: string[]; blocksReplaced: string[]; ledgers: string[]; sectionsCreated: string[]; rowsOwed: string[] };
  reported: Record<string, string[]>;
  /** Sections left in Evals.proposed.md after a successful write; empty when the file was removed. */
  proposalKept: string[];
  /** The merged text (also on a dry run); null when refused before merging. */
  merged: string | null;
}

/** Runs one row command where Bunker would: ok on exit 0, else a short reason. Injected in tests. */
export type RowRunner = (command: string, cwd: string) => { ok: boolean; reason: string };

export interface MergeOptions { dryRun?: boolean; runRow?: RowRunner }

const RUN_TYPES = new Set(["bash", "bun-test"]);

export const runRowCommand: RowRunner = (command, cwd) => {
  const p = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  if (p.exitCode === 0) return { ok: true, reason: "" };
  const first = `${p.stderr.toString()}\n${p.stdout.toString()}`.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return { ok: false, reason: `exit ${p.exitCode ?? "timeout"}${first ? `: ${first.slice(0, 80)}` : ""}` };
};

/** The shell command a proposal row's tool cell carries: wrapping backticks dropped, escaped pipes restored. */
function rowCommand(tool: string): string {
  const t = tool.trim();
  return (t.startsWith("`") && t.endsWith("`") && t.length > 1 ? t.slice(1, -1) : t).replace(/\\\|/g, "|");
}

export function mergeProposal(isaPathIn: string, opts: MergeOptions = {}): MergeResult {
  const isaPath = resolve(isaPathIn);
  const proposalPath = join(dirname(isaPath), PROPOSED_FILE);
  const result: MergeResult = {
    isa: isaPath, proposal: proposalPath, ok: false, written: false, dryRun: !!opts.dryRun, refusals: [],
    applied: { rowsAdded: [], rowsRemoved: [], blocksAdded: [], blocksReplaced: [], ledgers: [], sectionsCreated: [], rowsOwed: [] },
    reported: {}, proposalKept: [], merged: null,
  };
  if (!existsSync(proposalPath)) { result.refusals.push(`no ${PROPOSED_FILE} beside the ISA`); return result; }
  const original = readFileSync(isaPath, "utf8");
  let proposal: Proposal;
  try { proposal = parseProposal(readFileSync(proposalPath, "utf8")); }
  catch (e) { result.refusals.push((e as Error).message); return result; }
  result.reported = proposal.reported;

  const current = isaRevision(original).slice(0, proposal.revision.length);
  if (current !== proposal.revision) {
    result.refusals.push(`ISA changed since the proposal was compiled (proposal revision ${proposal.revision}, ISA now ${current}); recompile`);
    return result;
  }
  const ids = new Set([...proposal.rows.map((r) => r.id), ...proposal.evals.map((e) => e.id)]);
  if (!ids.size) {
    // Nothing to merge. A proposal that only reports items (splits, refusals) becomes a remnant
    // under the same revision, so estate stops treating it as waiting on merge; the ISA is untouched.
    result.ok = true;
    const text = readFileSync(proposalPath, "utf8");
    if (!opts.dryRun && !isRemnant(text)) result.proposalKept = writeRemnant(proposalPath, remnantText(basename(isaPath), proposal.revision, proposal.reported, "it carried no Test Strategy rows or Evals blocks to merge; the sections below were not applied"));
    return result;
  }

  // A proposal itself carrying two evals for one id is refused before anything else.
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  for (const [id, n] of count(proposal.rows.map((r) => r.id))) if (n > 1) result.refusals.push(`${id}: the proposal carries ${n} rows; one eval per criterion`);
  for (const [id, n] of count(proposal.evals.map((e) => e.id))) if (n > 1) result.refusals.push(`${id}: the proposal carries ${n} evals; one eval per criterion`);
  if (result.refusals.length) return result;

  // 0. A compiled code row never lands red on a ticked criterion. Run each one where Bunker would;
  // a red one lands as `manual` "EVAL OWED" with its command kept, so the tick is not silently
  // contradicted and ClaimGate is not handed a row that was never green (2026-10-12: in one project
  // compiled rows required tests nobody wrote and blocked its deploys for days).
  const ticked = new Set(parseIsaClaimsText(original, { path: isaPath }).claims.filter((c) => c.checked && !c.anti).map((c) => c.id));
  const runRow = opts.runRow ?? runRowCommand;
  const cwd = probeCwdOf(isaPath);
  for (const row of proposal.rows) {
    const type = (row.cells[1] ?? "").toLowerCase();
    const command = rowCommand(row.cells[4] ?? "");
    if (!ticked.has(row.id) || !RUN_TYPES.has(type) || !command || DEPLOY_CALL_TOOL(command) || MODEL_CALL_TOOL(command)) continue;
    const ran = runRow(command, cwd);
    if (ran.ok) continue;
    row.cells[1] = "manual";
    row.cells[2] = `EVAL OWED: the compiled row was red at merge (${ran.reason.replace(/\|/g, "/")}); command kept for when it passes. ${row.cells[2] ?? ""}`.trim();
    result.applied.rowsOwed.push(row.id);
  }

  const owned = recordedShas(original);
  const ts = parseTestStrategyDiagnostic(isaPath);
  const invalidRaw = new Set([...(ts.invalid ?? []).map((r) => r.raw.trim()), ...ts.dropped.map((r) => r.raw.trim())]);
  const brokenIds = new Set(parseEvalsText(original, isaPath).errors.map((e) => /^([A-Za-z][\w.-]*):/.exec(e.reason)?.[1]).filter((x): x is string => !!x));

  let lines = original.split("\n");

  // 1. Test Strategy rows.
  if (proposal.rows.length) {
    let range = sectionRange(lines, /^##\s+Test Strategy\b/i);
    if (!range) {
      const free = outsideFence(lines);
      const at = lines.findIndex((l, i) => free[i] && AFTER_TEST_STRATEGY.test(l.trim()));
      const section = ["## Test Strategy", "", "| isc | type | check | threshold | tool |", "|---|---|---|---|---|", ""];
      if (at >= 0) lines.splice(at, 0, ...section);
      else {
        while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
        lines.push("", ...section);
      }
      result.applied.sectionsCreated.push("Test Strategy");
      range = sectionRange(lines, /^##\s+Test Strategy\b/i)!;
    }
    const [s, e] = range;
    const tableIdx: number[] = [];
    for (let i = s + 1; i < e; i++) if (lines[i]!.trim().startsWith("|")) tableIdx.push(i);
    const headerAt = tableIdx.find((i) => i + 1 < e && isSeparator(lines[i + 1]!));
    invariant(headerAt !== undefined, "Test Strategy has a table without a header row; repair its format first");
    const fields = headerFields(cellsOf(lines[headerAt]!));
    const col = (f: Field) => fields.indexOf(f);
    if (col("isc") < 0) { result.refusals.push("Test Strategy header names no criterion column; repair its format first"); return result; }
    const dataIdx = tableIdx.filter((i) => i !== headerAt && !isSeparator(lines[i]!));
    const remove = new Set<number>();
    const insertAt = new Map<string, number>();
    for (const row of proposal.rows) {
      const mine = dataIdx.filter((i) => cellsOf(lines[i]!)[col("isc")] === row.id);
      const ownedById = owned.has(row.id) || brokenIds.has(row.id);
      for (const i of mine) {
        const cells = cellsOf(lines[i]!);
        const type = (cells[col("type")] ?? "").toLowerCase();
        const tool = cells[col("tool")] ?? "";
        const replaceable = ownedById || invalidRaw.has(lines[i]!.trim()) || !isProbeType(type) || type === "manual" || tool.startsWith("eval:#");
        if (replaceable) { remove.add(i); if (!insertAt.has(row.id)) insertAt.set(row.id, i); }
        else result.refusals.push(`${row.id}: a hand-written ${type} row stays beside the compiled eval (two evals); remove one by hand, then merge`);
      }
    }
    if (result.refusals.length) return result;
    const lastData = dataIdx.length ? Math.max(...dataIdx) : headerAt + 1;
    const next: string[] = [];
    const appended: string[] = [];
    for (const row of proposal.rows) if (!insertAt.has(row.id)) appended.push(fitRow(row.cells, fields));
    for (let i = 0; i < lines.length; i++) {
      const placed = [...insertAt].filter(([, at]) => at === i).map(([id]) => fitRow(proposal.rows.find((r) => r.id === id)!.cells, fields));
      if (remove.has(i)) { next.push(...placed); result.applied.rowsRemoved.push(cellsOf(lines[i]!)[col("isc")]!); }
      else next.push(lines[i]!);
      if (i === lastData) next.push(...appended);
    }
    result.applied.rowsAdded.push(...proposal.rows.map((r) => r.id));
    lines = next;
  }

  // 2. `## Evals` blocks and ledger lines.
  if (proposal.evals.length) {
    const added: string[] = [];
    for (const p of proposal.evals) added.push(...(added.length ? [""] : []), p.text);
    const range = sectionRange(lines, /^##\s+Evals\s*$/i);
    let kept: string[] = [];
    if (range) {
      const body = lines.slice(range[0] + 1, range[1]);
      const drop = new Set<number>();
      for (const p of proposal.evals) {
        for (const it of evalItems(body).filter((x) => x.id === p.id)) {
          if (it.sha === null && !brokenIds.has(it.id)) { result.refusals.push(`${p.id}: a hand-written eval block stays beside the compiled eval (two evals); remove one by hand, then merge`); continue; }
          for (let k = it.start; k < it.end; k++) drop.add(k);
          if (it.kind === "block") result.applied.blocksReplaced.push(p.id);
        }
      }
      if (result.refusals.length) return result;
      // Keep the rest of the section, collapsing the blank runs a removal leaves.
      for (const l of body.filter((_, k) => !drop.has(k))) if (!(l.trim() === "" && (!kept.length || kept[kept.length - 1]!.trim() === ""))) kept.push(l);
      while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
    }
    for (const p of proposal.evals) {
      if (p.kind === "ledger") result.applied.ledgers.push(p.id);
      else if (!result.applied.blocksReplaced.includes(p.id)) result.applied.blocksAdded.push(p.id);
    }
    const section = ["## Evals", "", ...kept, ...(kept.length ? [""] : []), ...added, ""];
    if (range) lines.splice(range[0], range[1] - range[0], ...section);
    else {
      result.applied.sectionsCreated.push("Evals");
      const free = outsideFence(lines);
      const at = lines.findIndex((l, i) => free[i] && /^##\s+Articulation Log\s*$/i.test(l.trim()));
      if (at >= 0) lines.splice(at, 0, ...section);
      else {
        while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
        lines.push("", ...section);
      }
    }
  }

  const merged = lines.join("\n");
  result.merged = merged;

  // 3. One eval per criterion, across the whole merged ISA.
  const mergedLines = merged.split("\n");
  const er = sectionRange(mergedLines, /^##\s+Evals\s*$/i);
  const evalIds = er ? evalItems(mergedLines.slice(er[0] + 1, er[1])).map((x) => x.id) : [];
  for (const [id, n] of count(evalIds)) if (n > 1 && ids.has(id)) result.refusals.push(`${id}: would carry ${n} evals in ## Evals; one eval per criterion`);
  const tsr = sectionRange(mergedLines, /^##\s+Test Strategy\b/i);
  const tsRefs = tsr ? (mergedLines.slice(tsr[0], tsr[1]).join("\n").match(/eval:#[A-Za-z][\w.-]*/g) ?? []).map((x) => x.slice(6)) : [];
  for (const [id, n] of count(tsRefs)) if (n > 1 && ids.has(id)) result.refusals.push(`${id}: would carry ${n} eval:# rows; one eval per criterion`);
  if (result.refusals.length) return result;

  // 4. The merged ISA must parse every merged row and block, and lose nothing else.
  const tmp = join(dirname(isaPath), `.${basename(isaPath)}.merge-${process.pid}.tmp`);
  invariant(tmp !== isaPath && basename(tmp).endsWith(".tmp"), "merge stages only a .tmp beside the ISA");
  writeFileSync(tmp, merged);
  try {
    const after = parseTestStrategyDiagnostic(tmp);
    const afterEvals = parseEvalsText(merged, tmp);
    const beforeEvals = parseEvalsText(original, isaPath);
    for (const row of proposal.rows) {
      if (!after.probes.some((p) => p.isc === row.id)) result.refusals.push(`${row.id}: the merged row does not parse as a probe`);
    }
    for (const p of proposal.evals.filter((x) => x.kind === "block")) {
      if (!afterEvals.evals.has(p.id)) result.refusals.push(`${p.id}: the merged block does not parse (${afterEvals.errors.find((x) => x.reason.startsWith(`${p.id}:`))?.reason ?? "missing"})`);
    }
    const newErrors = afterEvals.errors.filter((x) => !beforeEvals.errors.some((y) => y.reason === x.reason));
    for (const x of newErrors) result.refusals.push(`the merge introduced an Evals parse error: ${x.reason}`);
    const idsOf = (t: string, p: string) => parseIsaClaimsText(t, { path: p }).claims.map((c) => c.id).join(",");
    if (idsOf(original, isaPath) !== idsOf(merged, tmp)) result.refusals.push("the merge changed the ISA's criteria list");
    if (result.refusals.length || opts.dryRun) { unlinkSync(tmp); result.ok = !result.refusals.length; return result; }
    // The write: assert the impossible states first, then swap atomically.
    invariant(isaRevision(readFileSync(isaPath, "utf8")).slice(0, proposal.revision.length) === proposal.revision, "ISA changed during the merge");
    invariant(basename(proposalPath) === PROPOSED_FILE && proposalPath !== isaPath, "merge rewrites only Evals.proposed.md");
    // A recompile that reproduced the ISA's own rows and blocks byte for byte leaves the ISA as it is;
    // they are already in it, so the proposal still becomes a remnant below.
    if (merged === original) unlinkSync(tmp);
    else { renameSync(tmp, isaPath); result.written = true; }
    // ISC-45: keep what merge did not apply, under the ISA's new revision; remove only when nothing is left.
    const revision = isaRevision(merged).slice(0, proposal.revision.length);
    result.proposalKept = writeRemnant(proposalPath, remnantText(basename(isaPath), revision, proposal.reported, "its Test Strategy rows and Evals blocks were merged into the ISA; the sections below were not applied"));
    result.ok = true;
    return result;
  } catch (e) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw e;
  }
}

export function mergeSummary(r: MergeResult): string {
  const a = r.applied;
  const out: string[] = [];
  const verb = r.written ? "merged" : r.dryRun && r.ok ? "would merge" : r.ok ? (a.rowsAdded.length || a.blocksAdded.length || a.blocksReplaced.length ? "already in the ISA" : "nothing to merge") : "refused";
  out.push(`compile merge: ${verb} ${r.isa}`);
  if (a.sectionsCreated.length) out.push(`  sections created: ${a.sectionsCreated.join(", ")}`);
  if (a.rowsAdded.length) out.push(`  rows: +${a.rowsAdded.join(", ")}${a.rowsRemoved.length ? ` (replaced ${a.rowsRemoved.join(", ")})` : ""}`);
  if (a.rowsOwed.length) out.push(`  rows owed (red at merge on a ticked criterion, landed manual): ${a.rowsOwed.join(", ")}`);
  if (a.blocksAdded.length) out.push(`  blocks added: ${a.blocksAdded.join(", ")}`);
  if (a.blocksReplaced.length) out.push(`  blocks replaced: ${a.blocksReplaced.join(", ")}`);
  if (a.ledgers.length) out.push(`  ledger lines: ${a.ledgers.join(", ")}`);
  for (const f of r.refusals) out.push(`  refused: ${f}`);
  for (const [name, items] of Object.entries(r.reported)) out.push(`  reported, not applied — ${name}: ${items.filter((l) => /^-\s/.test(l)).length || items.length} item(s)`);
  if (r.written || (r.ok && !r.dryRun && (a.rowsAdded.length || a.blocksAdded.length || a.blocksReplaced.length))) out.push(r.proposalKept.length ? `  kept in ${PROPOSED_FILE}: ${r.proposalKept.join(", ")}` : `  removed ${PROPOSED_FILE}: nothing unapplied remains`);
  else if (r.proposalKept.length) out.push(`  kept in ${PROPOSED_FILE} (nothing to merge, marked as not waiting on merge): ${r.proposalKept.join(", ")}`);
  return out.join("\n");
}

/** `bun Compile.ts merge <ISA> [--dry-run] [--json]`. Exit 0 merged (or dry run clean, or nothing to merge) · 1 refused · 2 usage. */
export function mergeMain(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--json");
  const isa = argv.filter((a) => !a.startsWith("--"))[0];
  if (unknown.length || !isa || !existsSync(isa)) { console.error("usage: bun Compile.ts merge <ISA.md> [--dry-run] [--json]"); return 2; }
  const r = mergeProposal(isa, { dryRun });
  if (json) console.log(JSON.stringify({ ...r, merged: dryRun ? r.merged : undefined }, null, 2));
  else console.log(mergeSummary(r));
  return r.ok ? 0 : 1;
}
