#!/usr/bin/env bun
// release-allow: profanity (retriever stopwords: frustration words carry no rule signal)
/**
 * Rules.ts — every LifeOS rule as an indexed unit with a stable id, plus a deterministic retriever
 * over them (Errata ISA F6, ISC-45).
 *
 *   bun LIFEOS/ERRATA/Rules.ts build            rebuild the index from the live sources
 *   bun LIFEOS/ERRATA/Rules.ts show <id>         print one rule's text
 *   bun LIFEOS/ERRATA/Rules.ts search <text>     top rules for a piece of text (BM25, no model)
 *   bun LIFEOS/ERRATA/Errata.ts v4 rules build|show|search   (same)
 *
 * Sources are a fixed list, never a crawler. Most resolve through SystemContext.ts (the existing
 * registry of doctrine files): the system prompt (`constitution`), OPERATIONAL_PREFERENCES (`operations`,
 * domain sections included since 2026-10-25), the current Algorithm (`algorithm`, via
 * LATEST), the DA's Writing Style section (`assistant`), and CLAUDE.md's rule sections (`router`,
 * without the three pointer lists). Two on-demand rule files the system prompt points at are not
 * SystemContext core sources, so they are named here by path and held to the same containment
 * (inside the LifeOS root, a regular .md file): `LIFEOS/RULES/SelfHealing.md` (where a fix may live,
 * including the two classes of hook it admits) and `LIFEOS/RULES/Verification.md` (the eight
 * verification rules). Philosophy.md is explanation, not rules, and is left out.
 *
 * A unit is one top-level bullet or numbered item (with its nested lines), one table row (cells
 * labeled by the header), one paragraph, or one blank-line-separated chunk of a fenced
 * block, under its heading path. Units under 40 characters are dropped (headings and fragments).
 *
 * Id scheme: `<source>.<slug of the nearest heading>.<first 6 hex of sha256(normalized text)>`,
 * e.g. `ops.outbound-messages.3fa2c1`. It depends only on the unit's own source, nearest heading and
 * words, so an edit anywhere else never moves it. An edited, moved or re-headed rule keeps its old
 * id when, in the same rebuild, a unit of the same source disappeared whose word set overlaps the
 * new unit's by at least CARRY_MIN_JACCARD (greedy, best overlap first, one-to-one). A rewrite
 * below that overlap is a new rule with a new id; coverage answers under the retired id stop
 * resolving, drop out of the leaderboard as stale, and the next coverage run asks again.
 *
 * The index is derived and regenerable and holds nothing beyond each rule's source, heading path
 * and exact text. It contains USER text, so it lives only under LIFEOS/USER/ERRATA/v4/.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { CORE_SOURCES, sourcePath } from "../TOOLS/SystemContext";
import { v4Dir } from "./Exchanges";

type SourceSpec = { prefix: string; context: string; file?: never } | { prefix: string; file: string; context?: never };
export const RULE_SOURCES = {
  constitution: { prefix: "sp", context: "constitution" },
  operations: { prefix: "ops", context: "operations" },
  algorithm: { prefix: "algo", context: "algorithm" },
  writing: { prefix: "write", context: "assistant" },
  router: { prefix: "route", context: "router" },
  selfhealing: { prefix: "heal", file: "LIFEOS/RULES/SelfHealing.md" },
  verification: { prefix: "verif", file: "LIFEOS/RULES/Verification.md" },
} as const satisfies Record<string, SourceSpec>;
export type RuleSource = keyof typeof RULE_SOURCES;
export const SOURCE_IDS = Object.keys(RULE_SOURCES) as RuleSource[];

export type RuleKind = "bullet" | "numbered" | "row" | "paragraph" | "block";
export type Rule = { id: string; source: RuleSource; path: string[]; kind: RuleKind; text: string; hash: string };
export type RuleIndex = {
  version: 1;
  built: string;
  sources: Record<string, { file: string; sha256: string; rules: number }>;
  rules: Rule[];
  /** Ids carried onto edited units in this build: new base id → kept id. */
  carried: Record<string, string>;
};

const MIN_RULE_CHARS = 40;
/** Word-set overlap at which an edited unit inherits a vanished unit's id. */
export const CARRY_MIN_JACCARD = 0.6;
/** CLAUDE.md sections that are pointer lists, not rules. */
const ROUTER_POINTER_SECTIONS = /^(LifeOS System Docs|Principal — Identity & Voice|Principal — Life Goals)\b/;

/** Which heading paths of a source hold its rules. Pure. */
export function includePath(source: RuleSource, path: readonly string[]): boolean {
  if (source === "writing") return path[0] === "Writing Style";
  if (source === "router") return path.length > 0 && !ROUTER_POINTER_SECTIONS.test(path[0]!);
  return true;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
export const normalizeRuleText = (s: string): string => s.replace(/\s+/g, " ").trim();
export const ruleHash = (text: string): string => sha(normalizeRuleText(text)).slice(0, 16);

export function slug(heading: string | undefined): string {
  const s = (heading ?? "").toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s.slice(0, 32).replace(/-+$/, "") || "top");
}

const baseId = (source: RuleSource, path: readonly string[], text: string): string =>
  `${RULE_SOURCES[source].prefix}.${slug(path[path.length - 1])}.${sha(normalizeRuleText(text)).slice(0, 6)}`;

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;
const FENCE_RE = /^\s*(```|~~~)/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

/**
 * Pure: the rule units of one markdown document. Frontmatter and the H1 title are skipped (the
 * Algorithm's H1 carries its version, which must not reach an id). Ids are unique within the call:
 * an identical text under the same heading gets `-2`, `-3` in document order.
 */
export function parseRules(source: RuleSource, markdown: string): Rule[] {
  let lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) lines = lines.slice(end + 1);
  }
  const out: Omit<Rule, "id" | "hash">[] = [];
  const stack: { level: number; text: string }[] = [];
  const path = (): string[] => stack.filter((h) => h.level >= 2).map((h) => h.text.replace(/`/g, ""));
  let buf: string[] = [];
  let kind: RuleKind = "paragraph";
  let header: string[] | null = null;
  const flush = (): void => {
    const text = buf.join("\n").trim();
    buf = [];
    const p = path();
    // An italic editorial note (`_(…)_`) describes the file, not a rule.
    if (normalizeRuleText(text).length >= MIN_RULE_CHARS && !/^_\(/.test(text) && includePath(source, p)) out.push({ source, path: p, kind, text });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      flush();
      const fence = line.trim().slice(0, 3);
      kind = "block";
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence); i++) {
        if (lines[i]!.trim() === "") flush(); else buf.push(lines[i]!);
      }
      flush();
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      flush();
      header = null;
      const level = h[1]!.length;
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: h[2]! });
      continue;
    }
    if (line.trim() === "") {
      // A blank line ends a paragraph or a table; a list item continues when the next text is indented.
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      if ((kind === "bullet" || kind === "numbered") && buf.length && next !== undefined && /^\s{2,}\S/.test(next) && !HEADING_RE.test(next)) { buf.push(""); continue; }
      flush();
      header = null;
      continue;
    }
    if (line.trim().startsWith("|")) {
      if (kind !== "row") flush();
      if (TABLE_SEP_RE.test(line)) continue;
      if (!header) { header = cells(line); kind = "row"; continue; }
      flush();
      const c = cells(line);
      kind = "row";
      buf.push(c.map((v, k) => (header![k] ? `${header![k]}: ${v}` : v)).filter((v) => v.replace(/^[^:]*:\s*/, "").length > 0).join("; "));
      flush();
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li && li[1]!.length < 2) {
      flush();
      kind = /\d/.test(li[2]!) ? "numbered" : "bullet";
      buf.push(line.trim());
      continue;
    }
    if (kind === "row") { flush(); header = null; kind = "paragraph"; }
    if (!buf.length) kind = "paragraph";
    buf.push(line.trim());
  }
  flush();
  const seen = new Map<string, number>();
  return out.map((r) => {
    let id = baseId(source, r.path, r.text);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) id = `${id}-${n}`;
    return { ...r, id, hash: ruleHash(r.text) };
  });
}

// ── Tokens and BM25 ─────────────────────────────────────────────────────────

const STOP = new Set(("the and for that this with you your are was were but not have has had its it's from they them then than into onto " +
  "what when where which who why how all any can could would should will just also only very really about there here been being " +
  "our out get got use used using one two our ours his her she him their there's i'm i've don't didn't doesn't isn't wasn't " +
  "fuck fucki shit damn goddam").split(" "));

/** Lowercase word tokens, stopwords out, each cut to its first five letters (a crude stem that joins verify/verification, deploy/deployment). Pure. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9']+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    const t = w.replace(/'s$/, "").slice(0, 5);
    if (!STOP.has(t)) out.push(t);
  }
  return out;
}

export type Bm25 = { docs: { id: string; tf: Map<string, number>; len: number }[]; df: Map<string, number>; avgLen: number };

/** Pure: a BM25 index over (id, text) documents. */
export function bm25Index(docs: { id: string; text: string }[]): Bm25 {
  const df = new Map<string, number>();
  const out = docs.map((d) => {
    const tf = new Map<string, number>();
    const ts = tokens(d.text);
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return { id: d.id, tf, len: ts.length };
  });
  return { docs: out, df, avgLen: out.reduce((s, d) => s + d.len, 0) / Math.max(1, out.length) };
}

const K1 = 1.2;
const B = 0.75;

/** Pure: the top `k` documents for a weighted query (term → weight), score > 0, ties by id. */
export function bm25Search(ix: Bm25, query: Map<string, number>, k: number): { id: string; score: number }[] {
  const n = ix.docs.length;
  const scored: { id: string; score: number }[] = [];
  for (const d of ix.docs) {
    let s = 0;
    for (const [t, w] of query) {
      const f = d.tf.get(t);
      if (!f) continue;
      const df = ix.df.get(t) ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      s += w * idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / (ix.avgLen || 1)));
    }
    if (s > 0) scored.push({ id: d.id, score: s });
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}

/** Pure: term weights from weighted text parts, e.g. the complaint counted twice beside the reply. */
export function weightedQuery(parts: { text: string; weight: number }[]): Map<string, number> {
  const q = new Map<string, number>();
  for (const p of parts) for (const t of tokens(p.text)) q.set(t, (q.get(t) ?? 0) + p.weight);
  return q;
}

/**
 * The day a rule was first stated, when its text carries one: the earliest ISO date in it (rules
 * are dated by the directive behind them, e.g. "(2026-09-14: …)"). Null for an undated rule,
 * which is taken to have always existed. Read at use time; the index stores only the text. Pure.
 */
export function ruleSince(text: string): string | null {
  const dates = (text.match(/\b20\d\d-[01]\d-[0-3]\d\b/g) ?? []).filter((d) => Number.isFinite(Date.parse(d))).sort();
  return dates[0] ?? null;
}

/** The text a rule is retrieved by: its heading path plus its words. */
export const ruleDocText = (r: Rule): string => `${r.path.join(" ")} ${r.text}`;

export type RuleRetriever = { index: RuleIndex; byId: Map<string, Rule>; search: (query: Map<string, number>, k: number) => Rule[] };

export function retriever(index: RuleIndex): RuleRetriever {
  const byId = new Map(index.rules.map((r) => [r.id, r]));
  const ix = bm25Index(index.rules.map((r) => ({ id: r.id, text: ruleDocText(r) })));
  return { index, byId, search: (query, k) => bm25Search(ix, query, k).map((h) => byId.get(h.id)!) };
}

// ── Build, carry-over, persistence ──────────────────────────────────────────

const wordSet = (text: string): Set<string> => new Set(tokens(text));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Pure: give each new unit whose id is new the id of a vanished unit of the same source when their
 * word sets overlap at least CARRY_MIN_JACCARD, best overlap first, one-to-one.
 */
export function carryIds(fresh: Rule[], previous: Rule[] | null): { rules: Rule[]; carried: Record<string, string> } {
  if (!previous?.length) return { rules: fresh, carried: {} };
  const freshIds = new Set(fresh.map((r) => r.id));
  const prevIds = new Set(previous.map((r) => r.id));
  const vanished = previous.filter((r) => !freshIds.has(r.id));
  const newcomers = fresh.filter((r) => !prevIds.has(r.id));
  const cand: { n: Rule; o: Rule; sim: number }[] = [];
  const oldSets = new Map(vanished.map((o) => [o.id, wordSet(o.text)]));
  for (const n of newcomers) {
    const ns = wordSet(n.text);
    for (const o of vanished) {
      if (o.source !== n.source) continue;
      const sim = jaccard(ns, oldSets.get(o.id)!);
      if (sim >= CARRY_MIN_JACCARD) cand.push({ n, o, sim });
    }
  }
  cand.sort((a, b) => b.sim - a.sim || a.n.id.localeCompare(b.n.id) || a.o.id.localeCompare(b.o.id));
  const usedN = new Set<string>(), usedO = new Set<string>();
  const carried: Record<string, string> = {};
  for (const c of cand) {
    if (usedN.has(c.n.id) || usedO.has(c.o.id)) continue;
    usedN.add(c.n.id); usedO.add(c.o.id);
    carried[c.n.id] = c.o.id;
  }
  return { rules: fresh.map((r) => (carried[r.id] ? { ...r, id: carried[r.id]! } : r)), carried };
}

export const rulesPath = (dir = v4Dir()): string => join(dir, "rules.json");
const CLAUDE_ROOT = resolve(import.meta.dir, "../..");

export function validRuleIndex(x: unknown): x is RuleIndex {
  if (!x || typeof x !== "object") return false;
  const ix = x as RuleIndex;
  if (ix.version !== 1 || typeof ix.built !== "string" || !Array.isArray(ix.rules) || !ix.sources || typeof ix.carried !== "object") return false;
  const ids = new Set<string>();
  for (const r of ix.rules) {
    if (!r || typeof r.id !== "string" || !/^[a-z]+\.[a-z0-9-]+\.[0-9a-f]{6}(-\d+)?$/.test(r.id) || ids.has(r.id)) return false;
    if (!SOURCE_IDS.includes(r.source) || !Array.isArray(r.path) || typeof r.text !== "string" || normalizeRuleText(r.text).length < MIN_RULE_CHARS) return false;
    if (r.hash !== ruleHash(r.text)) return false;
    ids.add(r.id);
  }
  return true;
}

export function loadRuleIndex(dir = v4Dir()): RuleIndex | null {
  const p = rulesPath(dir);
  if (!existsSync(p)) return null;
  try {
    const x: unknown = JSON.parse(readFileSync(p, "utf8"));
    return validRuleIndex(x) ? x : null;
  } catch { return null; }
}

export type SourceText = { source: RuleSource; file: string; text: string };

/**
 * A path-named rule source, resolved with SystemContext's containment: symlinks dereferenced, the
 * real file inside the LifeOS root, a regular `.md` file. Throws otherwise.
 */
export function containedSourcePath(rel: string, root = CLAUDE_ROOT): string {
  const base = realpathSync(root);
  const file = realpathSync(resolve(root, rel));
  const r = relative(base, file);
  if (!r || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r) || !file.endsWith(".md") || !statSync(file).isFile()) throw new Error(`rule source ${rel} escapes the LifeOS root or is not a markdown file`);
  return file;
}

/** The live source texts, resolved through SystemContext's registry or by fixed path. `file` is relative to the LifeOS root. */
export function liveSources(root = CLAUDE_ROOT): SourceText[] {
  return SOURCE_IDS.map((source) => {
    const spec: SourceSpec = RULE_SOURCES[source];
    if (spec.file !== undefined) return { source, file: spec.file, text: readFileSync(containedSourcePath(spec.file, root), "utf8") };
    const ctx = spec.context;
    const abs = sourcePath(ctx, root);
    // Named by install path (USER sources resolve through a symlink); the Algorithm by its versioned file.
    const file = ctx === "algorithm" ? `LIFEOS/ALGORITHM/${basename(abs)}` : CORE_SOURCES[ctx]!;
    return { source, file, text: readFileSync(abs, "utf8") };
  });
}

/** Pure over its inputs: parse every source, carry ids from the previous index, and assemble a valid index. */
export function assembleIndex(texts: SourceText[], previous: RuleIndex | null, now = new Date()): RuleIndex {
  const fresh = texts.flatMap((t) => parseRules(t.source, t.text));
  const { rules, carried } = carryIds(fresh, previous?.rules ?? null);
  const sources: RuleIndex["sources"] = {};
  for (const t of texts) sources[t.source] = { file: t.file, sha256: sha(t.text), rules: rules.filter((r) => r.source === t.source).length };
  return { version: 1, built: now.toISOString(), sources, rules, carried };
}

/** Rebuild and atomically write the index. */
export function buildRuleIndex(opts: { dir?: string; texts?: SourceText[]; now?: Date } = {}): RuleIndex {
  const dir = opts.dir ?? v4Dir();
  const index = assembleIndex(opts.texts ?? liveSources(), loadRuleIndex(dir), opts.now);
  invariant(validRuleIndex(index), "rule index failed validation (duplicate id, hash mismatch or short rule)");
  invariant(index.rules.length > 0, "rule index is empty");
  mkdirSync(dir, { recursive: true });
  const p = rulesPath(dir);
  invariant(resolve(p).startsWith(resolve(dir)), "rule index must land under the v4 dir");
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 1) + "\n");
  renameSync(tmp, p);
  return index;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === "build") {
    const ix = buildRuleIndex();
    const bySource = Object.fromEntries(Object.entries(ix.sources).map(([s, v]) => [s, v.rules]));
    console.log(JSON.stringify({ path: rulesPath(), rules: ix.rules.length, by_source: bySource, carried: Object.keys(ix.carried).length }));
    return 0;
  }
  const ix = loadRuleIndex();
  if (!ix) { console.error("no rule index; run `Rules.ts build` first"); return 1; }
  if (cmd === "show" && rest[0]) {
    const r = ix.rules.find((x) => x.id === rest[0]);
    if (!r) { console.error(`no rule ${rest[0]}`); return 1; }
    console.log(`${r.id}  [${r.source}] ${r.path.join(" › ")}\n\n${r.text}`);
    return 0;
  }
  if (cmd === "search" && rest.length) {
    for (const r of retriever(ix).search(weightedQuery([{ text: rest.join(" "), weight: 1 }]), 8)) console.log(`${r.id}  ${normalizeRuleText(r.text).slice(0, 110)}`);
    return 0;
  }
  console.error("usage: Rules.ts build | show <id> | search <text>");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
