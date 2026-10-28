#!/usr/bin/env bun
/**
 * IsaFold — fold a Bunker verdict into an ISA, mechanically.
 *
 *   bun LIFEOS/TOOLS/IsaFold.ts apply <isa> <bunker-result.json> [--ref <commit>] [--dry-run] [--json]
 *
 * Input is Bunker's `test --json` output: `{ "isa": "<path>", "criteria": { "ISC-3": "pass"|"fail"|"unresolved" }, ... }`.
 *
 * What it does, and the whole of what it may do:
 *   - ticks `- [ ]` → `- [x]` on exactly the criteria whose verdict is "pass" and that are open now;
 *   - appends one `- ISC-N: bunker pass <date> <ref|no-ref>` line per newly ticked criterion to
 *     `## Verification` (when missing, the section is created before `## Remaining Work` or
 *     `## Articulation Log`, ISAFormat's fixed order, or at the end when the ISA has neither);
 *   - sets frontmatter `progress:` to the true count (countCriteria) and `updated:`;
 *   - after the write, mirrors the new frontmatter to work.json via syncToWorkJson, because a Bash-driven
 *     write bypasses the ISASync hook and Pulse progress would go stale. Skipped on --dry-run; a sync
 *     failure is reported (`workSync`) and never undoes the ISA write. Tests inject `syncWork` instead.
 * Its own write never unticks, never edits criterion text, never touches any other section of the ISA.
 * The work.json mirror is the same sync the ISASync hook runs, with the same one side effect: when both
 * the work.json row and the ISA frontmatter say `phase: complete` (and the ISA is not `frozen: true`),
 * the changed body triggers Resume After Complete, which writes the ISA a second time with `phase: learn`,
 * `iteration` + 1, `resumed_at`, `resumed_from_phase` and an "Auto-resumed" row under `## Decisions`.
 *
 * Exit codes: 0 applied (or nothing to do), 2 refused (bad input, ISA mismatch, unknown ISC).
 *
 * @version 1.1.1
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";
import { parseIsaClaimsText, isaBody } from "./lib/IsaClaims";
import { countCriteria, writeFrontmatterField, parseFrontmatter, syncToWorkJson } from "../../hooks/lib/isa-utils";
import { invariant } from "./Invariant";

export type Verdict = "pass" | "fail" | "unresolved";
const VERDICTS: ReadonlySet<string> = new Set(["pass", "fail", "unresolved"]);

export interface BunkerResult {
  isa: string;
  criteria: Record<string, Verdict>;
}

export interface FoldOptions {
  date: string;          // YYYY-MM-DD
  ref: string | null;    // commit ref, or null → "no-ref"
  updatedAt: string;     // value written to `updated:`
}

export interface FoldOutcome {
  content: string;
  ticked: string[];
  alreadyChecked: string[];
  notPassing: string[];
  skipped: Array<{ id: string; reason: string }>;
  progress: { checked: number; total: number };
  changed: boolean;
}

export class FoldRefusal extends Error {}

/** Checkbox prefix the ISA claim parser recognises; group 1 is everything up to the box char. */
const OPEN_BOX_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[) \]/;
const VERIFICATION_HEADING_RE = /^##\s+Verification\b/;
/** The ISAFormat sections that come after `## Verification` (positions 18 and 19). */
const AFTER_VERIFICATION_HEADING_RE = /^##\s+(?:Remaining Work|Articulation Log)\b/;

/** Validate untrusted JSON into a BunkerResult or throw a FoldRefusal naming what is wrong. */
export function parseBunkerResult(raw: unknown): BunkerResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FoldRefusal("bunker result is not a JSON object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.isa !== "string" || !obj.isa) throw new FoldRefusal("bunker result has no string `isa` field");
  const crit = obj.criteria;
  if (!crit || typeof crit !== "object" || Array.isArray(crit)) throw new FoldRefusal("bunker result has no `criteria` object");
  const criteria: Record<string, Verdict> = {};
  for (const [id, v] of Object.entries(crit as Record<string, unknown>)) {
    if (typeof v !== "string" || !VERDICTS.has(v)) throw new FoldRefusal(`criterion ${id} has verdict ${JSON.stringify(v)}; expected pass|fail|unresolved`);
    criteria[id] = v as Verdict;
  }
  return { isa: obj.isa, criteria };
}

function frontmatterLineCount(text: string): number {
  const prefix = text.slice(0, text.length - isaBody(text).length);
  return prefix ? prefix.split("\n").length - 1 : 0;
}

/**
 * Insert lines at the end of `## Verification`. When the section is missing, create it where ISAFormat's fixed
 * order puts it: before `## Remaining Work` or `## Articulation Log` (the sections that follow it), whichever
 * comes first, or at EOF when the ISA has neither.
 */
function appendVerification(lines: string[], entries: string[]): string[] {
  if (entries.length === 0) return lines;
  const start = lines.findIndex((l) => VERIFICATION_HEADING_RE.test(l));
  if (start === -1) {
    const after = lines.findIndex((l) => AFTER_VERIFICATION_HEADING_RE.test(l));
    if (after !== -1) {
      const gap = after > 0 && lines[after - 1]!.trim() !== "" ? [""] : [];
      return [...lines.slice(0, after), ...gap, "## Verification", "", ...entries, "", ...lines.slice(after)];
    }
    const out = [...lines];
    const hadTrailingNewline = out.length > 0 && out[out.length - 1] === "";
    if (hadTrailingNewline) out.pop();
    while (out.length && out[out.length - 1]!.trim() === "") out.pop();
    out.push("", "## Verification", "", ...entries);
    out.push("");
    return out;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i]!)) { end = i; break; }
  }
  // Insert after the last non-blank line of the section, so trailing blanks stay before the next heading.
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
  const out = [...lines];
  const needsGap = insertAt === start + 1; // empty section: keep one blank line under the heading
  out.splice(insertAt, 0, ...(needsGap ? ["", ...entries] : entries));
  return out;
}

/** Pure fold: ISA text + verdicts → new text and what changed. Throws FoldRefusal on bad input. */
export function foldText(text: string, verdicts: Record<string, Verdict>, opts: FoldOptions): FoldOutcome {
  const parsed = parseIsaClaimsText(text, { includeParents: true });
  const byId = new Map<string, typeof parsed.claims>();
  for (const c of parsed.claims) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);

  const unknown = Object.keys(verdicts).filter((id) => !byId.has(id));
  if (unknown.length) throw new FoldRefusal(`criteria not in the ISA: ${unknown.join(", ")}`);

  const fmLines = frontmatterLineCount(text);
  const lines = text.split("\n");
  const ticked: string[] = [];
  const alreadyChecked: string[] = [];
  const notPassing: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const [id, verdict] of Object.entries(verdicts)) {
    if (verdict !== "pass") { notPassing.push(id); continue; }
    const claims = byId.get(id)!;
    if (claims.length > 1) { skipped.push({ id, reason: `ambiguous: ${claims.length} lines carry this id` }); continue; }
    const claim = claims[0]!;
    if (claim.checked) { alreadyChecked.push(id); continue; }
    if (claim.source !== "checkbox") { skipped.push({ id, reason: `no checkbox (${claim.source} criterion)` }); continue; }
    const idx = fmLines + claim.line - 1;
    const line = lines[idx];
    if (line === undefined || !OPEN_BOX_RE.test(line)) { skipped.push({ id, reason: "checkbox is not `[ ]` (partial or other state)" }); continue; }
    lines[idx] = line.replace(OPEN_BOX_RE, (_m, head: string) => `${head}x]`);
    ticked.push(id);
  }

  ticked.sort(compareIds);
  const entries = ticked.map((id) => `- ${id}: bunker pass ${opts.date} ${opts.ref ?? "no-ref"}`);
  let content = appendVerification(lines, entries).join("\n");

  const progress = countCriteria(content);
  const fm = parseFrontmatter(content);
  const progressValue = `${progress.checked}/${progress.total}`;
  const progressStale = fm !== null && fm.progress !== progressValue;
  if (fm !== null && (ticked.length > 0 || progressStale)) {
    content = writeFrontmatterField(content, "progress", progressValue);
    content = writeFrontmatterField(content, "updated", opts.updatedAt);
  }
  return { content, ticked, alreadyChecked, notPassing, skipped, progress, changed: content !== text };
}

/** Natural order for ISC-2 < ISC-10. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** The invariants a fold must hold before it may reach disk. */
export function assertFoldInvariants(before: string, outcome: FoldOutcome): void {
  const prev = parseIsaClaimsText(before, { includeParents: true }).claims;
  const next = parseIsaClaimsText(outcome.content, { includeParents: true }).claims;
  invariant(prev.length === next.length, `fold changed the criterion count (${prev.length} → ${next.length})`);
  const tickedSet = new Set(outcome.ticked);
  for (let i = 0; i < prev.length; i++) {
    const p = prev[i]!;
    const n = next[i]!;
    invariant(p.id === n.id, `fold reordered or renamed criterion ${p.id} → ${n.id}`);
    invariant(!(p.checked && !n.checked), `fold unticked ${p.id}`);
    invariant(p.checked === n.checked || tickedSet.has(p.id), `${p.id} changed state without a pass verdict`);
  }
  const before0 = countCriteria(before).checked;
  const after0 = countCriteria(outcome.content).checked;
  invariant(after0 >= before0, `checked count went down (${before0} → ${after0})`);
  for (const id of outcome.ticked) {
    invariant(outcome.content.includes(`- ${id}: bunker pass `), `verification line for ${id} missing`);
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.isafold-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* tmp never created or already renamed */ }
    throw err;
  }
}

function canonical(path: string): string | null {
  try { return realpathSync(resolve(path)); } catch { return null; }
}

/** Mirrors an ISA write into work.json; the first three parameters of syncToWorkJson. */
export type WorkSync = (fm: Record<string, string>, isaPath: string, content: string) => void;

export type WorkSyncOutcome = { status: "synced" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

export interface ApplyResult {
  isa: string;
  dryRun: boolean;
  ticked: string[];
  alreadyChecked: string[];
  notPassing: string[];
  skipped: Array<{ id: string; reason: string }>;
  progress: string;
  wrote: boolean;
  workSync: WorkSyncOutcome;
}

/** Read, fold, assert, write. Throws FoldRefusal on any refusal condition. */
export function applyFold(isaPath: string, result: BunkerResult, opts: { ref: string | null; dryRun: boolean; now?: Date; syncWork?: WorkSync }): ApplyResult {
  const isaReal = canonical(isaPath);
  if (!isaReal) throw new FoldRefusal(`ISA not found: ${isaPath}`);
  const jsonReal = canonical(result.isa);
  if (jsonReal !== isaReal) throw new FoldRefusal(`bunker result is for ${result.isa}, not ${isaPath}`);
  const now = opts.now ?? new Date();
  const before = readFileSync(isaReal, "utf8");
  const outcome = foldText(before, result.criteria, {
    date: now.toISOString().slice(0, 10),
    ref: opts.ref,
    updatedAt: now.toISOString(),
  });
  let wrote = false;
  if (outcome.changed && !opts.dryRun) {
    assertFoldInvariants(before, outcome);
    invariant(readFileSync(isaReal, "utf8") === before, `ISA changed on disk while folding: ${isaReal}`);
    atomicWrite(isaReal, outcome.content);
    wrote = true;
  }
  let workSync: WorkSyncOutcome = { status: "skipped", reason: opts.dryRun ? "dry run" : "ISA unchanged" };
  if (wrote) {
    const fm = parseFrontmatter(outcome.content);
    if (!fm) workSync = { status: "skipped", reason: "ISA has no frontmatter" };
    else {
      try { (opts.syncWork ?? syncToWorkJson)(fm, isaReal, outcome.content); workSync = { status: "synced" }; }
      catch (e) { workSync = { status: "failed", reason: (e as Error).message }; }
    }
  }
  return {
    isa: isaReal,
    dryRun: opts.dryRun,
    ticked: outcome.ticked,
    alreadyChecked: outcome.alreadyChecked,
    notPassing: outcome.notPassing,
    skipped: outcome.skipped,
    progress: `${outcome.progress.checked}/${outcome.progress.total}`,
    wrote,
    workSync,
  };
}

const USAGE = "usage: IsaFold.ts apply <isa> <bunker-result.json> [--ref <commit>] [--dry-run] [--json]";

export function main(argv: string[]): number {
  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const refIdx = argv.indexOf("--ref");
  const ref = refIdx >= 0 ? argv[refIdx + 1] ?? null : null;
  if (refIdx >= 0 && (!ref || ref.startsWith("--"))) { console.error(USAGE); return 2; }
  const positional = argv.filter((a, i) => !a.startsWith("--") && !(refIdx >= 0 && i === refIdx + 1));
  const [sub, isa, resultPath] = positional;
  if (sub !== "apply" || !isa || !resultPath) { console.error(USAGE); return 2; }
  const refuse = (reason: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, refused: true, reason }));
    else console.error(`IsaFold refused: ${reason}`);
    return 2;
  };
  if (!existsSync(resultPath)) return refuse(`bunker result not found: ${resultPath}`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resultPath, "utf8")); } catch (e) { return refuse(`bunker result is not valid JSON: ${(e as Error).message}`); }
  try {
    const result = applyFold(isa, parseBunkerResult(raw), { ref, dryRun });
    if (json) console.log(JSON.stringify({ ok: true, ...result }));
    else {
      const verb = dryRun ? "would tick" : "ticked";
      console.log(`${verb} ${result.ticked.length}: ${result.ticked.join(", ") || "none"} · progress ${result.progress}${result.wrote ? "" : " · no write"}`);
      for (const s of result.skipped) console.log(`  skipped ${s.id}: ${s.reason}`);
    }
    if (result.workSync.status === "failed") console.error(`IsaFold: ISA written, but the work.json mirror failed: ${result.workSync.reason}`);
    return 0;
  } catch (e) {
    if (e instanceof FoldRefusal) return refuse(e.message);
    throw e;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
