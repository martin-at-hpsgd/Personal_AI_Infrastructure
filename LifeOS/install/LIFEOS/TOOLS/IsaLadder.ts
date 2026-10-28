#!/usr/bin/env bun
/**
 * IsaLadder — the Ideal State ladder at the top of every ISA (ISAFormat v2.28.0).
 *
 * Every ISA opens with `## Ideal State`, which states the ideal state at three
 * depths that must agree:
 *
 *   ### L3 · One sentence      — the whole ideal state in one sentence
 *   ### L2 · Summary           — one sentence, then exactly four bullets
 *   ### L1 · Full articulation — the complete describe-it-in-text prose
 *
 * `## Goal` (retired v2.28.0) folds into L3; `## Articulation` (v2.23.0) moves
 * into L1. Direction is the first thing an ISA gets right, so the ladder is the
 * first thing in it.
 *
 * Commands:
 *   check <isa...> | --list system|project|task|all   deterministic shape check
 *   snapshot --out <file> [--list …]                  record criteria/phase/progress/goal hashes
 *   verify-invariants --snapshot <file>               prove a migration changed none of them
 *   verify-commit <repo> <commit>                     same proof per ISA.md in one commit (parent vs commit), immune to later edits
 *   migrate <isa...> | --list … [--full] [--vendor v] [--level l] [--concurrency n] [--dry-run]
 *                                                     write the ladder (model authors L3/L2, and L1 with --full)
 *   drift <isa...> | --list … [--out file]            criteria-only restatement vs stated L3
 *   doc-sweep                                         live docs must not tell a writer to create `## Goal`
 *   list system|project|task                          print the discovered set
 *
 * Exit codes: 0 clean · 1 violations/drift found · 2 usage or runtime error.
 */

import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, lstatSync, realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths";
import { isaBody, parseIsaClaimsText } from "./lib/IsaClaims";

const HOME = homedir();
const CLAUDE = getClaudeDir();
const WORK = join(CLAUDE, "LIFEOS", "MEMORY", "WORK");
// MEMORY is a symlink into the USER data repo; a task ISA may be named by either path.
const WORK_REAL = (() => { try { return realpathSync(WORK); } catch { return WORK; } })();

// ── Parsing ──────────────────────────────────────────────────────────────────

export interface Ladder {
  present: boolean;
  firstSection: boolean; // `## Ideal State` is the first H2 of the body
  l3: string | null;
  l2Sentence: string | null;
  l2Bullets: string[];
  l2Present: boolean;
  l1: string | null;
}

function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? { fm: m[0], body: text.slice(m[0].length) } : { fm: "", body: text };
}

export function frontmatterMap(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

/** Strip fenced code blocks so example headings inside them are never read as structure. */
function maskFences(body: string): string {
  return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (b) => b.replace(/[^\n]/g, " "));
}

/** H2 sections of the body, in order, with offsets into the ORIGINAL body. */
export function h2Sections(body: string): { title: string; start: number; end: number; contentStart: number }[] {
  const masked = maskFences(body);
  const re = /^##[ \t]+([^\n]+)$/gm;
  const heads: { title: string; start: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) heads.push({ title: m[1]!.trim(), start: m.index, contentStart: m.index + m[0].length + 1 });
  return heads.map((h, i) => ({ ...h, end: i + 1 < heads.length ? heads[i + 1]!.start : body.length }));
}

function h3Blocks(section: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^###[ \t]+(L[123])\b[^\n]*$/gm;
  const heads: { key: string; start: number; cstart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section))) heads.push({ key: m[1]!, start: m.index, cstart: m.index + m[0].length });
  heads.forEach((h, i) => out.set(h.key, section.slice(h.cstart, i + 1 < heads.length ? heads[i + 1]!.start : section.length).trim()));
  return out;
}

export function parseLadder(text: string): Ladder {
  const { body } = splitFrontmatter(text);
  const secs = h2Sections(body);
  const idx = secs.findIndex((s) => /^Ideal State\s*$/i.test(s.title));
  const empty: Ladder = { present: false, firstSection: false, l3: null, l2Sentence: null, l2Bullets: [], l2Present: false, l1: null };
  if (idx === -1) return empty;
  const s = secs[idx]!;
  const blocks = h3Blocks(body.slice(s.contentStart, s.end));
  const l2 = blocks.get("L2") ?? null;
  let l2Sentence: string | null = null;
  const l2Bullets: string[] = [];
  if (l2) {
    const paras = l2.split(/\n\s*\n/);
    const lead = paras.find((p) => p.trim() && !/^\s*[-*]\s/.test(p));
    l2Sentence = lead ? lead.trim().replace(/\s+/g, " ") : null;
    for (const line of l2.split("\n")) {
      const b = line.match(/^[-*]\s+(.+)$/); // top-level bullets only
      if (b) l2Bullets.push(b[1]!.trim());
    }
  }
  return {
    present: true,
    firstSection: idx === 0,
    l3: blocks.get("L3")?.replace(/\s+/g, " ").trim() || null,
    l2Sentence,
    l2Bullets,
    l2Present: l2 !== null,
    l1: blocks.get("L1") || null,
  };
}

/** Sentence count, tolerant of abbreviations, file names, versions, and decimals. */
export function sentenceCount(s: string): number {
  const cleaned = s
    .replace(/`[^`]*`/g, "CODE")
    .replace(/\b(e\.g|i\.e|etc|vs|approx|incl|cf|No|St|Dr|Mr|Ms|Mrs)\./gi, "$1")
    .replace(/(\w)\.(\w)/g, "$1$2")
    .replace(/\.{3}|…/g, "")
    .trim();
  const ends = cleaned.match(/[.!?]+["')\]]*(?=\s+[A-Z0-9"'`(\[]|\s*$)/g);
  return Math.max(1, ends?.length ?? 1);
}

// ── Scope: which ISAs are "project" and which are "system" ──────────────────

export type Scope = "system" | "project" | "task";

/** Task scale: a task ISA, or a skill's example ISA (examples illustrate every scale, so they follow task rules). */
function isTaskScale(path: string): boolean {
  return path.startsWith(WORK + "/") || path.startsWith(WORK_REAL + "/") || /\/skills\/[^/]+\/Examples\//.test(path);
}

/** L2 is required on project, system, and feature-bearing ISAs. */
function isaNeedsL2(path: string, text: string): boolean {
  if (!isTaskScale(path)) return true; // system + project ISAs
  return /^##\s+Features\s*$/m.test(text) || /^##\s+Articulation\s*$/m.test(text) || /^###\s+L1\b/m.test(text);
}

/** L1 is required on project and system ISAs; on a task ISA `## Vision` may carry the articulation. */
function isaNeedsL1(path: string): boolean {
  return !isTaskScale(path);
}

/**
 * Whether a discovery root is there to read. Only a true absence (ENOENT, ENOTDIR) is an empty root;
 * any other stat failure, such as an unsearchable ancestor, goes into `unreadable`. existsSync reads
 * both as "absent", which turned a locked root into an empty, clean scope (S077).
 */
function rootPresent(p: string, unreadable: string[]): boolean {
  try { statSync(p); return true; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(p);
    return false;
  }
}

/** The entries of a discovery root, or null after recording it in `unreadable` when it cannot be listed. */
function listRoot(p: string, unreadable: string[]): string[] | null {
  try { return readdirSync(p); } catch { unreadable.push(p); return null; }
}

/** Discovery could not read some locations, and the caller gave no `unreadable` list to report them in. */
export class DiscoveryIncomplete extends Error {
  constructor(readonly unreadable: string[]) {
    super(`ISA discovery incomplete: could not read ${unreadable.join(", ")}`);
    this.name = "DiscoveryIncomplete";
  }
}

/**
 * Runs a discovery with a place to record what it could not read. A caller that passes `unreadable`
 * reads the gaps from it; a caller that does not gets DiscoveryIncomplete, never a silently smaller
 * scope (S077). Every exported discovery goes through here, so no caller can get the quiet form.
 */
function settle<T>(unreadable: string[] | undefined, run: (sink: string[]) => T): T {
  const sink = unreadable ?? [];
  const result = run(sink);
  if (!unreadable && sink.length) throw new DiscoveryIncomplete(sink);
  return result;
}

/**
 * Collect every ISA.md under `root`. A directory that cannot be read, or an entry
 * that cannot be stat'ed, goes into `unreadable` when the caller passes it, so a
 * caller can tell an incomplete discovery from an empty one (LOSIntegrity
 * ); without it, the walk throws DiscoveryIncomplete (S077).
 */
export function walkIsas(root: string, skip: (dir: string) => boolean, out: string[], depth = 0, unreadable?: string[]): void {
  settle(unreadable, (sink) => walkInto(root, skip, out, depth, sink));
}

function walkInto(root: string, skip: (dir: string) => boolean, out: string[], depth: number, unreadable: string[]): void {
  if (depth > 6 || !rootPresent(root, unreadable)) return;
  let entries: string[];
  try { entries = readdirSync(root); } catch { unreadable.push(root); return; }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === "dist" || e === ".archive" || e === "_ephemeral") continue;
    const p = join(root, e);
    let st;
    try { st = lstatSync(p); } catch { unreadable.push(p); continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (!skip(p)) walkInto(p, skip, out, depth + 1, unreadable); }
    else if (e === "ISA.md") out.push(p);
  }
}

const JUDGED_VERDICTS = new Set(["aligned", "partial", "divergent"]);

/**
 * Exit code for a drift run: 2 when the run could not verify everything it was
 * asked to (a failed or unparseable judgment, a missing L3 or criteria to compare,
 * an unreadable directory during discovery), else 1 on any divergent row, else 0.
 * An unverifiable row never reads as a pass.
 */
export function driftExitCode(rows: Array<Record<string, unknown>>, unreadable: string[] = []): number {
  if (unreadable.length) return 2;
  if (rows.some((r) => !JUDGED_VERDICTS.has(String(r.verdict)))) return 2;
  return rows.some((r) => r.verdict === "divergent") ? 1 : 0;
}

/** A repo checkout that is a linked git worktree (its `.git` is a file) — the main checkout carries the ISA. */
function isLinkedWorktree(dir: string): boolean {
  const g = join(dir, ".git");
  try { return existsSync(g) && statSync(g).isFile(); } catch { return false; }
}

/** Every ISA in a scope. Unreadable locations go into `unreadable`; without it, discover throws DiscoveryIncomplete (S077). */
export function discover(scope: Scope, unreadable?: string[]): string[] {
  return settle(unreadable, (sink) => discoverInto(scope, sink));
}

function discoverInto(scope: Scope, unreadable: string[]): string[] {
  const out: string[] = [];
  if (scope === "task") {
    if (!rootPresent(WORK, unreadable)) return out;
    for (const d of listRoot(WORK, unreadable) ?? []) {
      const p = join(WORK, d, "ISA.md");
      // existsSync reads a permission error as "absent"; only a true absence may be skipped (S077).
      try { statSync(p); out.push(p); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") unreadable.push(join(WORK, d));
      }
    }
  } else if (scope === "system") {
    walkInto(CLAUDE, (dir) => /\/LIFEOS\/(MEMORY|LIFEOS_RELEASES)$/.test(dir) || /\/(projects|file-history|shell-snapshots|todos|debug|plugins)$/.test(dir), out, 0, unreadable);
  } else {
    for (const root of [join(HOME, "Projects"), join(HOME, "LocalProjects")]) {
      if (!rootPresent(root, unreadable)) continue;
      for (const d of listRoot(root, unreadable) ?? []) {
        const repo = join(root, d);
        if (/OLD-archived/i.test(d) || isLinkedWorktree(repo)) continue;
        try { if (!statSync(repo).isDirectory()) continue; } catch { unreadable.push(repo); continue; }
        // `runs/` holds generated benchmark artifacts (arc-code), which are data, never working ISAs.
        walkInto(repo, (dir) => isLinkedWorktree(dir) || /\/runs$/.test(dir), out, 0, unreadable);
      }
    }
  }
  return out.sort();
}

// ── Check ────────────────────────────────────────────────────────────────────

export interface CheckResult { path: string; errors: string[]; warnings: string[] }

// The ladder states the summit, never the floor (ISAFormat § What the ladder captures: the summit).
// Floor words in L3 or L2 are a smell, so they warn and never fail the check.
const FLOOR_WORDS = /\b(intact|parity|regressions?|without breaking|nothing breaks|keeps? working|still works?|unchanged|no worse|without losing|no action needed)\b/i;

export function floorWarnings(L: Ladder): string[] {
  const lines: [string, string][] = [["L3", L.l3 ?? ""], ["L2 lead", L.l2Sentence ?? ""], ...L.l2Bullets.map((b, i): [string, string] => [`L2 bullet ${i + 1}`, b])];
  return lines.flatMap(([where, text]) => {
    const m = text.match(FLOOR_WORDS);
    return m ? [`${where} reads as floor ("${m[0]}"); write the summit and move the guard into criteria`] : [];
  });
}

export function checkText(path: string, text: string): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const L = parseLadder(text);
  const { body } = splitFrontmatter(text);
  const titles = h2Sections(body).map((s) => s.title);
  if (!L.present) errors.push("no `## Ideal State` section");
  else {
    if (!L.firstSection) errors.push("`## Ideal State` is not the first body section");
    if (!L.l3) errors.push("L3 missing or empty");
    else {
      if (sentenceCount(L.l3) !== 1) errors.push(`L3 must be one sentence (read ${sentenceCount(L.l3)})`);
      const words = L.l3.split(/\s+/).length;
      if (words > 60) errors.push(`L3 is ${words} words; one sentence a reader takes in at a glance runs 60 or fewer`);
    }
    const needL2 = isaNeedsL2(path, text);
    if (L.l2Present || needL2) {
      if (!L.l2Present) errors.push("L2 missing (required on project, system, and feature-bearing ISAs)");
      else {
        if (!L.l2Sentence) errors.push("L2 has no lead sentence");
        else if (sentenceCount(L.l2Sentence) !== 1) errors.push(`L2 lead must be one sentence (read ${sentenceCount(L.l2Sentence)})`);
        if (L.l2Bullets.length !== 4) errors.push(`L2 must carry exactly four bullets (read ${L.l2Bullets.length})`);
      }
    }
    if (isaNeedsL1(path) && !L.l1) errors.push("L1 missing (required on project and system ISAs)");
    warnings.push(...floorWarnings(L));
  }
  if (titles.some((t) => /^Goal\s*$/i.test(t))) errors.push("legacy `## Goal` still present (folds into L3)");
  if (titles.some((t) => /^Articulation\s*$/i.test(t))) errors.push("legacy `## Articulation` still present (moves into L1)");
  return { path, errors, warnings };
}

export function checkFile(path: string): CheckResult {
  return checkText(resolve(path), readFileSync(path, "utf8"));
}

// ── Invariants (the migration must not touch these) ─────────────────────────

function sha(s: string): string { return createHash("sha256").update(s).digest("hex").slice(0, 16); }

export function invariantsOf(text: string): Record<string, string> {
  const fm = frontmatterMap(text);
  // Criteria through the shared parser (every shape it reads), plus a raw checkbox sweep so
  // a shape the parser misses is still counted. A checkbox-only filter missed prose-form
  // criteria, and a whole `## Ideal State Criteria` section was once dropped unseen.
  const parsed = (() => { try { return criteriaLines(text); } catch { return []; } })();
  const boxes = text.split("\n").filter((l) => /^\s*-\s*\[[ xX]\]\s/.test(l)).map((l) => l.trim());
  const criteria = [...parsed, "--", ...boxes].join("\n");
  const { body } = splitFrontmatter(text);
  const secs = h2Sections(body);
  const ts = secs.find((s) => /^Test Strategy\b/i.test(s.title));
  // Every section except the three the ladder legitimately absorbs must survive.
  const sections = secs.map((s) => s.title).filter((x) => !/^(Goal|Articulation|Ideal State)\s*$/i.test(x)).sort().join("|");
  return {
    sections: sha(sections),
    phase: fm.phase ?? "",
    progress: fm.progress ?? "",
    goal: sha(fm.principal_stated_goal ?? ""),
    criteria: sha(criteria),
    testStrategy: sha(ts ? body.slice(ts.start, ts.end).trim() : ""),
  };
}

// ── Migration (restructure is deterministic; only the words come from a model) ─

export interface LadderWords { l3: string; l2_sentence?: string; l2_bullets?: string[]; l1?: string }

/** Rebuild the body so `## Ideal State` comes first; `## Goal` is removed and `## Articulation` moves into L1. */
export function applyLadder(text: string, words: LadderWords): string {
  const { fm, body } = splitFrontmatter(text);
  const secs = h2Sections(body);
  const goal = secs.find((s) => /^Goal\s*$/i.test(s.title));
  const artic = secs.find((s) => /^Articulation\s*$/i.test(s.title));
  const existing = secs.find((s) => /^Ideal State\s*$/i.test(s.title));
  const l1 = (artic ? body.slice(artic.contentStart, artic.end).trim() : words.l1?.trim()) || "";
  invariant(words.l3 && words.l3.trim().length > 0, "applyLadder called without an L3");
  invariant(!(words.l2_bullets && words.l2_bullets.length !== 4), `applyLadder called with ${words.l2_bullets?.length} L2 bullets`);

  const drop = [goal, artic, existing].filter(Boolean) as typeof secs;
  let rest = "";
  let cursor = 0;
  for (const s of [...drop].sort((a, b) => a.start - b.start)) { rest += body.slice(cursor, s.start); cursor = s.end; }
  rest += body.slice(cursor);

  // Everything before the first H2 (a title line, preamble) stays above the ladder.
  const firstH2 = rest.search(/^##[ \t]/m);
  const preamble = firstH2 === -1 ? rest : rest.slice(0, firstH2);
  const after = firstH2 === -1 ? "" : rest.slice(firstH2);

  let ladder = `## Ideal State\n\n### L3 · One sentence\n\n${words.l3.trim()}\n`;
  if (words.l2_sentence && words.l2_bullets?.length === 4) {
    ladder += `\n### L2 · Summary\n\n${words.l2_sentence.trim()}\n\n${words.l2_bullets.map((b) => `- ${b.trim()}`).join("\n")}\n`;
  }
  if (l1) ladder += `\n### L1 · Full articulation\n\n${l1}\n`;
  // Tidy blank lines inside the ladder only; the rest of the document (fenced examples,
  // Test Strategy) keeps its bytes, and the invariant check runs on the text we return.
  ladder = ladder.replace(/\n{3,}/g, "\n\n");

  const pre = preamble.replace(/\s*$/, "");
  const out = `${fm}${pre ? pre + "\n\n" : fm ? "\n" : ""}${ladder}\n${after.replace(/^\s*/, "")}`;
  invariant(JSON.stringify(invariantsOf(out)) === JSON.stringify(invariantsOf(text)), "applyLadder changed a protected invariant (criteria, Test Strategy, phase, progress, or goal)");
  return out;
}

const MIGRATE_SYSTEM = `You write the Ideal State ladder that opens an ISA (Ideal State Artifact). The ISA's whole purpose is to make sure the work is the right thing, in the right direction, toward the ideal state the principal wants. The ladder states that ideal state at three depths that must agree exactly with each other and with everything else in the document.

Rules:
- Derive every word from the ISA you are given. Add no intent, feature, or promise it does not contain. Where the ISA has a principal_stated_goal, the ladder must honor it.
- L3: exactly one sentence, ideally 15 to 35 words and never over 60, stating what the thing IS at its ideal state (the destination, not the task list). Name the one thing it is and why it matters; never a comma-chained list of features. Plain, direct language a friend would use.
- L2 (only when asked): one lead sentence, then exactly four bullets. Each bullet is one short sentence naming one of the four most important aspects of the ideal state. Together they should let a reader check the rest of the document.
- L1 (only when asked): the full describe-it-in-text articulation in plain prose paragraphs, drawn only from the ISA's Problem, Vision, Goal, Features, Principles, and Constraints. What it is, why it is shaped that way, how the parts relate. No headings, no bullet lists, no criteria IDs.
- No marketing language, no em-dash chains, no "not X, it's Y" constructions.

Reply with JSON only: {"l3": "...", "l2_sentence": "...", "l2_bullets": ["...","...","...","..."], "l1": "..."} and omit keys you were not asked for.`;

/** Ask a model for only the ladder levels that are missing or invalid; valid levels a human wrote are kept verbatim. */
async function authorWords(path: string, text: string, keep: Partial<LadderWords>, opts: { full: boolean; vendor: string; level: string }): Promise<LadderWords> {
  const { inference } = await import("./Inference");
  const wantL3 = !keep.l3;
  const wantL2 = isaNeedsL2(path, text) && !keep.l2_sentence;
  const wantL1 = opts.full && isaNeedsL1(path) && !keep.l1;
  const asks = [...(wantL3 ? ["l3"] : []), ...(wantL2 ? ["l2_sentence", "l2_bullets"] : []), ...(wantL1 ? ["l1"] : [])];
  if (!asks.length) return keep as LadderWords;
  const clipped = text.length > 60_000 ? text.slice(0, 60_000) + "\n…[truncated]" : text;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await inference({
      systemPrompt: MIGRATE_SYSTEM,
      userPrompt: `Write these keys: ${asks.join(", ")}.${attempt > 1 ? " Your previous reply broke a rule: L3 and the L2 lead must each be exactly one sentence, and L2 must have exactly four bullets." : ""}\n\nISA:\n\n${clipped}`,
      level: opts.level as never,
      expectJson: true,
      vendor: opts.vendor as never,
      timeout: wantL1 ? 240_000 : 120_000,
    });
    if (!r.success || !r.parsed) continue;
    const w = r.parsed as LadderWords;
    if (wantL3 && (!w.l3 || sentenceCount(w.l3) !== 1)) continue;
    if (wantL2 && (!w.l2_sentence || sentenceCount(w.l2_sentence) !== 1 || w.l2_bullets?.length !== 4)) continue;
    if (wantL1 && !w.l1) continue;
    return {
      ...keep,
      ...(wantL3 ? { l3: w.l3 } : {}),
      ...(wantL2 ? { l2_sentence: w.l2_sentence, l2_bullets: w.l2_bullets } : {}),
      ...(wantL1 ? { l1: w.l1 } : {}),
    } as LadderWords;
  }
  throw new Error(`model did not return a valid ladder for ${path}`);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

// ── Drift: does the criteria set add up to the stated L3? ───────────────────

const RESTATE_SYSTEM = `You are given ONLY the criteria of an ISA (Ideal State Artifact), never its summary. Infer the ideal state these criteria jointly describe and state it as exactly one sentence of 60 words or fewer. Reply with JSON only: {"l3": "..."}.`;
const JUDGE_SYSTEM = `Two one-sentence statements of an ideal state are given: STATED (what the ISA says it is building) and INFERRED (what an independent reader concluded from the criteria alone). Judge whether the criteria are building the stated thing, in the stated direction. aligned = same destination; partial = same destination but the criteria cover a narrower or shifted part of it; divergent = the criteria point somewhere else. Reply with JSON only: {"verdict": "aligned|partial|divergent", "reason": "one sentence"}.`;

/** Criterion lines as written, via the shared parser (checkbox, table, and prose forms alike). */
export function criteriaLines(text: string): string[] {
  // The parser numbers lines from the body, frontmatter stripped; index the same text.
  const lines = isaBody(text).split(/\r?\n/);
  return parseIsaClaimsText(text).claims.map((c) => lines[c.line - 1]!.trim());
}

/**
 * The real path of an existing `p` when it resolves inside `root`, else null. Both sides go through realpathSync before the
 * comparison, so a symlinked component cannot lead out of `root` (Code invariants: realpath before any boundary check).
 * Kept local rather than importing lib/Boundary, so ISAGate.ts, which imports this module, keeps its public payload closure.
 */
function realUnder(root: string, p: string): string | null {
  let realRoot: string, real: string;
  try { realRoot = realpathSync(root); real = realpathSync(p); } catch { return null; }
  return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep) ? real : null;
}

/** A slug that names one WORK entry: a single path segment (no separator, no NUL), never `.` or `..`. */
const CHILD_SLUG = /^(?!\.\.?$)[^/\0]+$/;

/**
 * Child ISAs named in `children:` (ISAHierarchy). A parent holds the product's intent and
 * its children own the subsystem criteria, so drift on a parent must read the whole tree.
 * Resolved by slug: a task ISA under MEMORY/WORK, or any ISA.md under the parent's directory.
 * A location that cannot be read goes into `unreadable`; without it, the call throws
 * DiscoveryIncomplete, never returning a smaller tree (S077).
 */
export function childIsaPaths(path: string, text: string, unreadable?: string[]): string[] {
  const raw = frontmatterMap(text).children ?? "";
  const slugs = raw.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  if (!slugs.length) return [];
  return settle(unreadable, (sink) => {
    const local: string[] = [];
    walkInto(join(path, ".."), () => false, local, 0, sink);
    const out: string[] = [];
    for (const slug of slugs) {
      // WORK is searched only for a slug that is one entry name, and the hit must really sit under WORK: a traversal or
      // absolute slug, or a WORK entry that is a symlink out of WORK, would feed an unrelated file to the drift judge (S078).
      // The local lookup compares frontmatter slugs and builds no path, so every slug may use it, as before.
      if (CHILD_SLUG.test(slug)) {
        const lexical = join(WORK, slug, "ISA.md");
        let present = false;
        try { statSync(lexical); present = true; } catch (e) {
          // existsSync reads a permission error as "absent"; only a true absence may fall through quietly.
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") sink.push(join(WORK, slug));
        }
        const work = present ? realUnder(WORK, lexical) : null;
        if (work) { out.push(work); continue; }
      }
      const hit = local.find((p) => p !== path && frontmatterMap(readFileSync(p, "utf8")).slug === slug);
      if (hit) out.push(hit);
    }
    return out;
  });
}

/**
 * Fit criteria into the restater's budget. A head-slice silently cut large ISAs (over a
 * thousand criteria) off mid-feature, so later features never reached the model. Lines are
 * shortened evenly when that stays readable, and sampled evenly across the list when not.
 */
export function fitCriteria(criteria: string, budget: number): string {
  if (criteria.length <= budget) return criteria;
  const lines = criteria.split("\n");
  const clip = (l: string, n: number) => (l.length > n ? l.slice(0, n - 1) + "…" : l);
  const per = Math.floor(budget / lines.length) - 1;
  if (per >= 60) return lines.map((l) => clip(l, per)).join("\n");
  // Too many to shorten readably: sample evenly across the whole list at 80 chars, so
  // every region of the ISA (early and late features alike) is represented.
  const keep = Math.floor(budget / 81);
  const step = lines.length / keep;
  return Array.from({ length: keep }, (_, i) => clip(lines[Math.floor(i * step)]!, 80)).join("\n");
}

// The drift check is a judge (restate, then compare), so both model calls go through Assay's one judge
// transport (AssaySystem.md § One judge transport). One shared import: the sweep runs driftOne in a pool,
// and concurrent dynamic imports hand every caller but the first a module still evaluating, which throws
// "Cannot access 'INFERENCE_DISABLED_FLAG' before initialization" (Bun 1.3; see Review.ts defaultReviewer).
let judgeModule: Promise<typeof import("../ASSAY/JudgeCall")> | null = null;

async function driftOne(path: string): Promise<Record<string, unknown>> {
  const { judgeText } = await (judgeModule ??= import("../ASSAY/JudgeCall"));
  const text = readFileSync(path, "utf8");
  const L = parseLadder(text);
  // A child list read from a partly unreadable tree would judge part of the criteria as the whole (S077).
  let children: string[];
  try { children = childIsaPaths(path, text); } catch (e) {
    if (e instanceof DiscoveryIncomplete) return { path, verdict: "error", error: e.message };
    throw e;
  }
  const criteria = [
    ...criteriaLines(text),
    ...children.flatMap((c) => criteriaLines(readFileSync(c, "utf8")).map((l) => `[child ISA] ${l}`)),
  ].join("\n");
  if (!L.l3) return { path, verdict: "no-l3" };
  if (!criteria.trim()) return { path, verdict: "no-criteria", stated: L.l3 };
  const r1 = await judgeText({ systemPrompt: RESTATE_SYSTEM, userPrompt: fitCriteria(criteria, 40_000), level: "medium", expectJson: true, vendor: "openai", timeout: 120_000 });
  const inferred = (r1.parsed as { l3?: string } | undefined)?.l3;
  if (!inferred) return { path, verdict: "error", error: r1.error ?? "no restatement" };
  const r2 = await judgeText({ systemPrompt: JUDGE_SYSTEM, userPrompt: `STATED: ${L.l3}\n\nINFERRED: ${inferred}`, level: "medium", expectJson: true, vendor: "anthropic", timeout: 120_000 });
  const j = r2.parsed as { verdict?: string; reason?: string } | undefined;
  return { path, stated: L.l3, inferred, verdict: j?.verdict ?? "error", reason: j?.reason ?? r2.error, ...(children.length ? { children } : {}) };
}

// ── Doc sweep: live docs must teach the ladder, never `## Goal` ─────────────

export const DOC_ROOTS = [
  "LIFEOS/DOCUMENTATION/ISA",
  "LIFEOS/DOCUMENTATION/Algorithm",
  "LIFEOS/DOCUMENTATION/Testing",
  "LIFEOS/DOCUMENTATION/Bunker",
  "skills/ISA",
  "skills/Development",
  "LIFEOS/LIFEOS_SYSTEM_PROMPT.md",
  "CLAUDE.md",
];
const LEGACY_OK = /legacy|retired|retire|folded|folds|formerly|was `## |previous|pre-v2\.28|v2\.2[0-7]|Spec v2\.[0-9]\b|historical|still parse|accept|moves into|moved into|becomes|replaces|leftover/i;

export function docSweep(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  const files: string[] = [];
  // A doc root that is there but unreadable is an incomplete sweep, never a clean one (S077).
  const unreadable: string[] = [];
  const walk = (p: string) => {
    if (!rootPresent(p, unreadable)) return;
    const st = statSync(p);
    if (st.isDirectory()) { for (const e of readdirSync(p)) if (e !== "node_modules" && e !== "test") walk(join(p, e)); }
    else if (p.endsWith(".md")) files.push(p);
  };
  for (const r of DOC_ROOTS) walk(join(CLAUDE, r));
  if (unreadable.length) throw new DiscoveryIncomplete(unreadable);
  const latest = join(CLAUDE, "LIFEOS/ALGORITHM", `v${readFileSync(join(CLAUDE, "LIFEOS/ALGORITHM/LATEST"), "utf8").trim()}.md`);
  files.push(latest);
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      if (/##\s+Goal\b(?!s)|##\s+Articulation\b(?!\s+Log)/.test(l) && !LEGACY_OK.test(l)) hits.push({ file: f.replace(CLAUDE + "/", ""), line: i + 1, text: l.trim().slice(0, 140) });
    });
  }
  return hits;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function targets(args: string[], unreadable?: string[]): string[] {
  const i = args.indexOf("--list");
  if (i !== -1) {
    const which = args[i + 1];
    if (which === "all") return [...discover("system", unreadable), ...discover("project", unreadable), ...discover("task", unreadable)];
    if (which === "system" || which === "project" || which === "task") return discover(which, unreadable);
    throw new Error(`--list needs system|project|task|all, got ${which}`);
  }
  const valued = new Set(["--out", "--snapshot", "--vendor", "--level", "--concurrency"]);
  return args.filter((a, j) => !a.startsWith("--") && !(j > 0 && valued.has(args[j - 1]!))).map((p) => resolve(p));
}
function flag(args: string[], name: string, dflt: string): string {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1]! : dflt;
}

export type VerifyGit = (...a: string[]) => { ok: boolean; out: string };
const spawnGit = (repo: string): VerifyGit => (...a) => {
  const r = Bun.spawnSync(["git", "-C", repo, ...a], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString() };
};

/**
 * Do the ISAs a commit touched keep their invariants? Fails closed: an unresolvable commit, a failed
 * discovery, or a failed read of a file that exists on both sides is an entry in `errors`, never a
 * skipped file. Only a file the commit truly adds or deletes (diff-tree status A / D) is skipped,
 * since it has nothing to preserve.
 */
export function verifyCommit(repo: string, commit: string, git: VerifyGit = spawnGit(repo)): { files: string[]; bad: string[]; errors: string[] } {
  const errors: string[] = [];
  const bad: string[] = [];
  if (!git("rev-parse", "--verify", "-q", `${commit}^{commit}`).ok) return { files: [], bad, errors: [`cannot resolve commit ${commit} in ${repo}`] };
  const tree = git("diff-tree", "--no-commit-id", "--name-status", "-r", commit);
  if (!tree.ok) return { files: [], bad, errors: [`git diff-tree failed for ${commit} in ${repo}`] };
  const entries = tree.out.split("\n").filter(Boolean).map((l) => { const [status, ...rest] = l.split("\t"); return { status: status ?? "", path: rest.join("\t") }; });
  const files = entries.filter((e) => /(^|\/)ISA\.md$/.test(e.path)).map((e) => e.path);
  for (const e of entries.filter((x) => /(^|\/)ISA\.md$/.test(x.path))) {
    if (e.status === "A" || e.status === "D") continue; // added or deleted in this commit: nothing to preserve
    const before = git("show", `${commit}^:${e.path}`);
    const after = git("show", `${commit}:${e.path}`);
    if (!before.ok || !after.ok) { errors.push(`could not read ${e.path} at ${commit}^ or ${commit}`); continue; }
    const a = invariantsOf(before.out), b = invariantsOf(after.out);
    for (const k of Object.keys(a)) if (a[k] !== b[k]) bad.push(`${e.path}: ${k} changed`);
  }
  return { files, bad, errors };
}

/** Print every location discovery could not read; true when there was one, so the caller exits nonclean (S077). */
function reportUnreadable(unreadable: string[]): boolean {
  for (const u of unreadable) console.log(`? discovery could not read ${u} — discovery incomplete`);
  return unreadable.length > 0;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  switch (cmd) {
    case "list": {
      const unreadable: string[] = [];
      for (const p of discover(args[0] as Scope, unreadable)) console.log(p);
      return reportUnreadable(unreadable) ? 2 : 0;
    }
    case "check": {
      const unreadable: string[] = [];
      const paths = targets(args, unreadable);
      const results = paths.map(checkFile);
      const bad = results.filter((r) => r.errors.length);
      const warned = results.filter((r) => !r.errors.length && r.warnings.length);
      if (json) console.log(JSON.stringify({ checked: paths.length, failing: bad.length, results: bad, warnings: warned, unreadable, complete: unreadable.length === 0 }));
      else {
        for (const r of bad) console.log(`✗ ${r.path}\n    ${r.errors.join("\n    ")}`);
        for (const r of warned) console.log(`~ ${r.path}\n    ${r.warnings.join("\n    ")}`);
        console.log(`${paths.length - bad.length}/${paths.length} ISAs carry a valid Ideal State ladder`);
      }
      // An incomplete discovery is never a clean check (S077).
      if (json ? unreadable.length > 0 : reportUnreadable(unreadable)) return 2;
      return bad.length ? 1 : 0;
    }
    case "snapshot": {
      const out = flag(args, "--out", "");
      if (!out) throw new Error("snapshot needs --out <file>");
      const unreadable: string[] = [];
      const paths = args.includes("--list") ? targets(args, unreadable) : [...discover("system", unreadable), ...discover("project", unreadable), ...discover("task", unreadable)];
      // A snapshot of an incomplete discovery would let verify-invariants pass over ISAs it never saw.
      if (reportUnreadable(unreadable)) throw new Error(`snapshot refused: discovery could not read ${unreadable.length} location(s)`);
      const snap: Record<string, Record<string, string>> = {};
      for (const p of paths) snap[p] = invariantsOf(readFileSync(p, "utf8"));
      invariant(Object.keys(snap).length === paths.length, "snapshot lost an entry");
      writeFileSync(out, JSON.stringify(snap, null, 1));
      console.log(`snapshot: ${paths.length} ISAs → ${out}`);
      return 0;
    }
    case "verify-invariants": {
      const snap = JSON.parse(readFileSync(flag(args, "--snapshot", ""), "utf8")) as Record<string, Record<string, string>>;
      const drift: string[] = [];
      for (const [p, before] of Object.entries(snap)) {
        if (!existsSync(p)) { drift.push(`${p}: missing`); continue; }
        const now = invariantsOf(readFileSync(p, "utf8"));
        for (const k of Object.keys(before)) if (before[k] !== now[k]) drift.push(`${p}: ${k} changed`);
      }
      for (const d of drift) console.log(`✗ ${d}`);
      console.log(`${Object.keys(snap).length} ISAs checked, ${drift.length} invariant changes`);
      return drift.length ? 1 : 0;
    }
    case "verify-commit": {
      const [repo, commit] = args.filter((a) => !a.startsWith("--"));
      if (!repo || !commit) throw new Error("verify-commit needs <repo> <commit>");
      const v = verifyCommit(repo, commit);
      for (const b of v.bad) console.log(`✗ ${b}`);
      for (const e of v.errors) console.log(`✗ git error: ${e}`);
      console.log(`verify-commit ${commit}: ${v.files.length} ISAs, ${v.bad.length} invariant changes, ${v.errors.length} git errors`);
      return v.bad.length || v.errors.length ? 1 : 0;
    }
    case "migrate": {
      const unreadable: string[] = [];
      const paths = targets(args, unreadable);
      const opts = { full: args.includes("--full"), vendor: flag(args, "--vendor", "openai"), level: flag(args, "--level", "medium") };
      const dry = args.includes("--dry-run");
      let done = 0, skipped = 0;
      const failed: string[] = [];
      await pool(paths, Number(flag(args, "--concurrency", "8")), async (p) => {
        const text = readFileSync(p, "utf8");
        if (!checkText(p, text).errors.length) { skipped++; return; }
        try {
          const L = parseLadder(text);
          // Re-author only what is missing or invalid; keep valid levels a human already wrote.
          const keep: Partial<LadderWords> = {};
          if (L.l3 && sentenceCount(L.l3) === 1 && L.l3.split(/\s+/).length <= 60) keep.l3 = L.l3;
          if (L.l2Sentence && sentenceCount(L.l2Sentence) === 1 && L.l2Bullets.length === 4) { keep.l2_sentence = L.l2Sentence; keep.l2_bullets = L.l2Bullets; }
          if (L.l1) keep.l1 = L.l1;
          const words = await authorWords(p, text, keep, opts);
          const next = applyLadder(text, words);
          if (dry) console.log(`--- ${p}\n${next.slice(0, 1600)}\n`);
          else writeFileSync(p, next);
          done++;
          if (!json && done % 25 === 0) console.error(`… ${done} migrated`);
        } catch (e) {
          failed.push(`${p}: ${(e as Error).message}`);
        }
      });
      for (const f of failed) console.log(`✗ ${f}`);
      console.log(`migrated ${done}, already valid ${skipped}, failed ${failed.length}`);
      if (reportUnreadable(unreadable)) return 2;
      return failed.length ? 1 : 0;
    }
    case "drift": {
      const unreadable: string[] = [];
      const paths = targets(args, unreadable);
      const out = flag(args, "--out", "");
      const rows: Record<string, unknown>[] = [];
      await pool(paths, Number(flag(args, "--concurrency", "6")), async (p) => { rows.push(await driftOne(p)); });
      if (out) writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const off = rows.filter((r) => r.verdict === "divergent" || r.verdict === "partial");
      for (const r of off) console.log(`${r.verdict === "divergent" ? "✗" : "~"} ${r.path}\n    stated:   ${r.stated}\n    inferred: ${r.inferred}\n    ${r.reason}`);
      const tally = rows.reduce<Record<string, number>>((a, r) => ((a[String(r.verdict)] = (a[String(r.verdict)] ?? 0) + 1), a), {});
      console.log(`drift: ${JSON.stringify(tally)}`);
      for (const r of rows.filter((x) => !JUDGED_VERDICTS.has(String(x.verdict)))) console.log(`? ${r.path}: ${String(r.verdict)}${r.error ? ` (${String(r.error)})` : ""} — not verified`);
      reportUnreadable(unreadable);
      return driftExitCode(rows, unreadable);
    }
    case "doc-sweep": {
      const hits = docSweep();
      for (const h of hits) console.log(`✗ ${h.file}:${h.line}  ${h.text}`);
      console.log(`doc-sweep: ${hits.length} live instruction(s) still teach \`## Goal\` or a standalone \`## Articulation\``);
      return hits.length ? 1 : 0;
    }
    default:
      console.log(readFileSync(import.meta.path, "utf8").match(/\/\*\*([\s\S]*?)\*\//)![1]!.replace(/^ \* ?/gm, ""));
      return cmd ? 2 : 0;
  }
}

if (import.meta.main) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(`IsaLadder: ${(e as Error).message}`); process.exit(2); });
}

