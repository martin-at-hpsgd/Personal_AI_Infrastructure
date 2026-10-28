/**
 * CompileSplit — applies the splits compile proposed (eval-compile ISA,
 * F9 M4, ISC-47 and ISC-48). Run as `bun Compile.ts split <ISA> [--dry-run] [--json]`.
 *
 * Compile flags a compound criterion instead of crushing it into one eval, and
 * lists it under `## Split these` in `Evals.proposed.md`:
 *
 *   - ISC-4: two independent criteria
 *     - The page loads under one second.
 *     - The copy is friendly.
 *
 * Split turns each entry into the ID-stability shape (ISAFormat § The
 * ID-stability rule): the parent keeps its id and gains a `[container] ` prefix,
 * and the parts become nested children ISC-4.1, ISC-4.2, … beneath it (after
 * any indented continuation prose the parent carries),
 * two spaces deeper, each inheriting the parent's checkbox. Nothing renumbers;
 * Test Strategy, Evals and Decisions are untouched. When the ISA has an
 * `## Articulation Log`, one `refined:` line per split is appended there.
 *
 * A container with children needs no eval of its own (IsaClaims skips it), so
 * the next compile compiles only the new children.
 *
 * Refusals (nothing written, every reason listed): the ISA changed since the
 * proposal was compiled, the proposal still carries unmerged rows or blocks,
 * a parent id is not a criterion in the ISA, a parent is a table row, a parent
 * already has nested children, a child id already exists, or the rewritten ISA
 * does not parse to the old criteria plus exactly the new children.
 *
 * On success the applied entries leave the proposal's `## Split these`; the
 * rest of the file is kept, or the file removed when nothing unapplied remains.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { ANTI_HEADING_RE, CONTAINER_RE, claimText, isaBody, isaRevision, parseIsaClaimsText, type IsaClaim } from "../../../LIFEOS/TOOLS/lib/IsaClaims.ts";
import { PROPOSED_FILE } from "./Compile.ts";
import { parseProposal, remnantText, writeRemnant } from "./CompileMerge.ts";

export const SPLIT_SECTION = "Split these";

export interface SplitEntry { id: string; reason: string; parts: string[] }

export interface SplitResult {
  ok: boolean;
  isa: string;
  proposal: string;
  dryRun: boolean;
  written: boolean;
  applied: { id: string; children: string[] }[];
  refusals: string[];
  /** The rewritten ISA (also on a dry run); null when refused before rewriting. */
  text: string | null;
}

/**
 * Entries of a `## Split these` body: `- <id>: <reason>` with its indented
 * `- <part>` lines. An indented line with no list marker continues the line
 * above it (a wrapped reason or part) and is joined to it with one space.
 */
export function parseSplitEntries(body: readonly string[]): { entries: SplitEntry[]; problems: string[] } {
  const entries: SplitEntry[] = [];
  const problems: string[] = [];
  const squash = (t: string) => t.replace(/\s+/g, " ").trim();
  for (const line of body) {
    if (!line.trim()) continue;
    const top = /^-\s+([A-Za-z][\w.-]*):\s*(.*)$/.exec(line);
    const part = /^\s{2,}[-*+]\s+(.*)$/.exec(line);
    const last = entries[entries.length - 1];
    if (top) entries.push({ id: top[1]!, reason: top[2]!.trim(), parts: [] });
    else if (part && last) last.parts.push(squash(part[1]!));
    else if (/^\s{2,}\S/.test(line) && last) {
      if (last.parts.length) last.parts[last.parts.length - 1] = squash(`${last.parts[last.parts.length - 1]} ${line}`);
      else last.reason = squash(`${last.reason} ${line}`);
    }
    else problems.push(`unreadable line in ## ${SPLIT_SECTION}: ${line.trim()}`);
  }
  return { entries, problems };
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[(?:[ xX~-]|DEFERRED-VERIFY)\]\s*)?/;

/** Index of the last line belonging to the list item at `at`: its indented continuation, nested items included. */
function itemEnd(lines: readonly string[], at: number): number {
  const indent = /^\s*/.exec(lines[at]!)![0].length;
  let end = at;
  for (let j = at + 1; j < lines.length; j++) {
    if (!lines[j]!.trim()) continue;
    if (/^\s*/.exec(lines[j]!)![0].length <= indent) break;
    end = j;
  }
  return end;
}

/** Whether the item at `at` already has a nested list item beneath it. */
function hasNestedItem(lines: readonly string[], at: number): boolean {
  for (let j = at + 1; j <= itemEnd(lines, at); j++) if (LIST_ITEM.test(lines[j]!)) return true;
  return false;
}

/** Whether body line `at` sits under an `## Anti-criteria` heading. */
function inAntiSection(lines: readonly string[], at: number): boolean {
  for (let j = at; j >= 0; j--) if (/^##\s/.test(lines[j]!)) return ANTI_HEADING_RE.test(lines[j]!);
  return false;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SplitOptions { dryRun?: boolean }

export function splitProposal(isaPathIn: string, opts: SplitOptions = {}): SplitResult {
  const isaPath = resolve(isaPathIn);
  const proposalPath = join(dirname(isaPath), PROPOSED_FILE);
  const result: SplitResult = { ok: false, isa: isaPath, proposal: proposalPath, dryRun: !!opts.dryRun, written: false, applied: [], refusals: [], text: null };
  if (!existsSync(proposalPath)) { result.refusals.push(`no ${PROPOSED_FILE} beside the ISA`); return result; }
  const original = readFileSync(isaPath, "utf8");
  const proposalText = readFileSync(proposalPath, "utf8");
  let proposal: ReturnType<typeof parseProposal>;
  try { proposal = parseProposal(proposalText); }
  catch (e) { result.refusals.push((e as Error).message); return result; }

  const current = isaRevision(original).slice(0, proposal.revision.length);
  if (current !== proposal.revision) {
    result.refusals.push(`ISA changed since the proposal was compiled (proposal revision ${proposal.revision}, ISA now ${current}); recompile`);
    return result;
  }
  // Splitting moves the ISA's revision, which would strand rows merge has not applied yet.
  if (proposal.rows.length || proposal.evals.length) result.refusals.push(`the proposal still carries unmerged Test Strategy rows or Evals blocks; run merge first`);
  const { entries, problems } = parseSplitEntries(proposal.reported[SPLIT_SECTION] ?? []);
  result.refusals.push(...problems);
  if (!entries.length && !result.refusals.length) { result.ok = true; return result; }

  // Body lines are what IsaClaims numbers; the frontmatter is carried through untouched.
  const body = isaBody(original);
  const head = original.slice(0, original.length - body.length);
  const lines = body.split("\n");
  const before = parseIsaClaimsText(original, { path: isaPath, includeParents: true }).claims;
  const byId = new Map<string, IsaClaim>();
  for (const c of before) if (!byId.has(c.id)) byId.set(c.id, c);
  const seen = new Set<string>();
  const edits: { at: number; end: number; parent: string; children: string[]; entry: SplitEntry; childIds: string[] }[] = [];

  for (const e of entries) {
    const why = (r: string) => result.refusals.push(`${e.id}: ${r}`);
    if (seen.has(e.id)) { why("listed more than once in the proposal"); continue; }
    seen.add(e.id);
    if (e.parts.length < 2) { why(`a split needs at least two parts, the proposal gives ${e.parts.length}`); continue; }
    const c = byId.get(e.id);
    if (!c) { why("parent criterion not found in the ISA"); continue; }
    const at = c.line - 1;
    const raw = lines[at] ?? "";
    if (c.source === "table") { why("the parent is a table row; nested children need a list item, split it by hand"); continue; }
    const item = LIST_ITEM.exec(raw);
    if (!item) { why("the parent is not a list item"); continue; }
    if (c.container || hasNestedItem(lines, at)) { why("the parent already has nested children"); continue; }
    const childIds = e.parts.map((_, n) => `${e.id}.${n + 1}`);
    const taken = childIds.filter((id) => byId.has(id));
    if (taken.length) { why(`child id already exists in the ISA: ${taken.join(", ")}`); continue; }
    const parsed = claimText(raw.slice(item[0].length));
    if (!parsed || parsed.id !== e.id || !parsed.body) { why("the parent line has no criterion text to keep"); continue; }

    // `[container] ` goes once, at the start of the criterion text (the line ends with it).
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    const textAt = line.trimEnd().length - parsed.body.length;
    invariant(textAt > 0 && line.slice(textAt).trimEnd() === parsed.body, `${e.id}: criterion text located in its line`);
    const parent = CONTAINER_RE.test(parsed.body) ? raw : `${line.slice(0, textAt)}[container] ${line.slice(textAt)}${cr}`;
    // Two spaces deeper under a bullet; under a numbered marker the children sit at its
    // content column (at least three spaces), which CommonMark needs to nest them.
    const numbered = /^\d/.test(item[2]!);
    const pad = item[1]! + " ".repeat(numbered ? Math.max(3, item[2]!.length + 1) : 2);
    const marker = numbered ? "-" : item[2]!;
    const box = item[4] ? `${item[4].trim()} ` : "";
    // A prose-marked anti-criterion outside the Anti-criteria section keeps its kind in each child.
    const antiPrefix = c.anti && !inAntiSection(lines, at) && !/^A\d/.test(e.id) ? "Anti: " : "";
    const children = e.parts.map((p, n) => `${pad}${marker} ${box}${childIds[n]}: ${antiPrefix && !/^Anti:/i.test(p) ? antiPrefix : ""}${p}${cr}`);
    // Children go beneath the parent item, after any indented continuation prose it carries.
    edits.push({ at, end: itemEnd(lines, at), parent, children, entry: e, childIds });
  }
  if (result.refusals.length) return result;

  // Apply bottom-up so earlier indexes stay valid.
  const out = [...lines];
  for (const ed of [...edits].sort((a, b) => b.at - a.at)) { out.splice(ed.end + 1, 0, ...ed.children); out[ed.at] = ed.parent; }

  // One `refined:` line per split, only when the ISA keeps an Articulation Log.
  const logAt = out.findIndex((l) => /^##\s+Articulation Log\s*$/i.test(l.trim()));
  if (logAt >= 0) {
    let end = out.findIndex((l, i) => i > logAt && /^#{1,2}\s/.test(l));
    if (end < 0) end = out.length;
    let last = end;
    while (last > logAt + 1 && !out[last - 1]!.trim()) last--;
    const logLines = edits.map((ed) => `- ${today()}: refined: ${ed.entry.id} split into ${ed.childIds.join(" / ")} (compile split)`);
    out.splice(last, 0, ...(last === logAt + 1 ? [""] : []), ...logLines);
  }
  const text = head + out.join("\n");
  result.text = text;

  // The rewritten ISA must hold the old criteria plus exactly the new children, each with its parent's state.
  const after = parseIsaClaimsText(text, { path: isaPath, includeParents: true }).claims;
  const want = [...before.map((c) => c.id), ...edits.flatMap((ed) => ed.childIds)].sort();
  const got = after.map((c) => c.id).sort();
  if (want.join("\n") !== got.join("\n")) result.refusals.push(`the rewritten ISA's criteria are not the old set plus exactly the new children (expected ${want.length}, parsed ${got.length})`);
  for (const ed of edits) {
    const parent = before.find((c) => c.id === ed.entry.id)!;
    const p2 = after.find((c) => c.id === ed.entry.id);
    if (!p2?.container) result.refusals.push(`${ed.entry.id}: the rewritten parent does not parse as a container`);
    for (const id of ed.childIds) {
      const ch = after.find((c) => c.id === id);
      if (!ch || ch.status !== parent.status || ch.anti !== parent.anti) result.refusals.push(`${id}: the child does not parse with its parent's state`);
    }
  }
  if (result.refusals.length) return result;
  result.applied = edits.sort((a, b) => a.at - b.at).map((ed) => ({ id: ed.entry.id, children: ed.childIds }));
  if (opts.dryRun) { result.ok = true; return result; }

  // The write: impossible states asserted first, then an atomic swap.
  const tmp = join(dirname(isaPath), `.${basename(isaPath)}.split-${process.pid}.tmp`);
  invariant(tmp !== isaPath && basename(tmp).endsWith(".tmp"), "split stages only a .tmp beside the ISA");
  invariant(text !== original, "a split that applies entries must change the ISA");
  invariant(isaRevision(readFileSync(isaPath, "utf8")) === isaRevision(original), "ISA changed during the split");
  writeFileSync(tmp, text);
  try { renameSync(tmp, isaPath); }
  catch (e) { if (existsSync(tmp)) unlinkSync(tmp); throw e; }
  result.written = true;

  // The applied entries leave the proposal; everything else stays, under the ISA's new revision.
  const reported = { ...proposal.reported };
  delete reported[SPLIT_SECTION];
  const revision = isaRevision(text).slice(0, proposal.revision.length);
  writeRemnant(proposalPath, remnantText(basename(isaPath), revision, reported, "its splits were applied to the ISA by compile split; the sections below were not applied"));
  result.ok = true;
  return result;
}

export function splitSummary(r: SplitResult): string {
  const verb = r.written ? "split" : r.dryRun && r.ok && r.applied.length ? "would split" : r.ok ? "nothing to split" : "refused";
  const out = [`compile split: ${verb} ${r.isa}`];
  for (const a of r.applied) out.push(`  ${a.id} → ${a.children.join(", ")}`);
  for (const f of r.refusals) out.push(`  refused: ${f}`);
  return out.join("\n");
}

/** `bun Compile.ts split <ISA> [--dry-run] [--json]`. Exit 0 split (or dry run clean, or nothing to split) · 1 refused · 2 usage. */
export function splitMain(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--json");
  const isa = argv.filter((a) => !a.startsWith("--"))[0];
  if (unknown.length || !isa || !existsSync(isa)) { console.error("usage: bun Compile.ts split <ISA.md> [--dry-run] [--json]"); return 2; }
  const r = splitProposal(isa, { dryRun });
  if (json) console.log(JSON.stringify({ ok: r.ok, isa: r.isa, applied: r.applied, refusals: r.refusals, written: r.written, dryRun: r.dryRun }, null, 2));
  else console.log(splitSummary(r));
  return r.ok ? 0 : 1;
}
