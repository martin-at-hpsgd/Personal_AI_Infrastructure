#!/usr/bin/env bun
/**
 * EssayLint.ts — structure and quote discipline for a run's Essay.md.
 *
 *   bun EssayLint.ts --run <slug|dir> [--source] [--json]
 *
 * Frontmatter must carry title, thesis, source, stance, attribution_unsure (a list,
 * possibly empty). Sections required: Their Claims, Where We Agree, The Disagreement,
 * The Argument. Every blockquote ends with an attribution line `> — <Speaker>`.
 * An explainer (`kind: explainer`) has no opposing source: it needs title, thesis, source
 * and kind, and only The Argument; any blockquote it carries still needs its attribution.
 * With --source, every quote's text must appear verbatim (normalized) in
 * Source/transcript.txt, and any quote whose speaker is ambiguous must be listed in
 * attribution_unsure (matched by its first eight words).
 */
import { existsSync, readFileSync } from "node:fs";
import { argValue, hasFlag, normalizeText, resolveRunDir, runPaths } from "./Lib.ts";

export interface Frontmatter { [k: string]: string | string[] }
export interface Quote { text: string; speaker: string; line: number }
export interface EssayLintResult { ok: boolean; problems: string[]; quotes: Quote[]; words: number }

export const REQUIRED_SECTIONS = ["Their Claims", "Where We Agree", "The Disagreement", "The Argument"];
const REQUIRED_KEYS = ["title", "thesis", "source", "stance", "attribution_unsure"];
export const EXPLAINER_SECTIONS = ["The Argument"];
const EXPLAINER_KEYS = ["title", "thesis", "source", "kind"];

export type EssayKind = "essay" | "explainer";

/** The essay kind from frontmatter: `kind: explainer`, else an argued essay. Any other kind is an error. */
export function essayKind(fm: Frontmatter): EssayKind {
  const k = fm.kind;
  if (k === undefined || k === "" || k === "essay") return "essay";
  if (k === "explainer") return "explainer";
  throw new Error(`unknown essay kind ${JSON.stringify(k)}: use essay or explainer`);
}

export function parseFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, body: md };
  const fm: Frontmatter = {};
  let key = "";
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const v = kv[2].trim();
      if (v === "" || v === "[]") fm[key] = v === "[]" ? [] : "";
      else if (v.startsWith("[") && v.endsWith("]")) fm[key] = v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      else fm[key] = v.replace(/^["']|["']$/g, "");
      continue;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) {
      const cur = fm[key];
      fm[key] = Array.isArray(cur) ? [...cur, item[1].trim().replace(/^["']|["']$/g, "")] : [item[1].trim().replace(/^["']|["']$/g, "")];
    }
  }
  return { fm, body: md.slice(m[0].length) };
}

export function extractQuotes(body: string): Quote[] {
  const lines = body.split("\n");
  const quotes: Quote[] = [];
  let buf: string[] = [];
  let startLine = 0;
  const flush = () => {
    if (!buf.length) return;
    const last = buf[buf.length - 1];
    const attr = last.match(/^[—–-]\s*(.+)$/);
    const textLines = attr ? buf.slice(0, -1) : buf;
    quotes.push({ text: textLines.join(" ").replace(/\s+/g, " ").trim(), speaker: attr ? attr[1].trim() : "", line: startLine });
    buf = [];
  };
  lines.forEach((l, i) => {
    const q = l.match(/^>\s?(.*)$/);
    if (q) { if (!buf.length) startLine = i + 1; if (q[1].trim() !== "") buf.push(q[1].trim()); }
    else flush();
  });
  flush();
  return quotes;
}

export function lintEssay(md: string, transcript?: string): EssayLintResult {
  const problems: string[] = [];
  const { fm, body } = parseFrontmatter(md);
  let kind: EssayKind = "essay";
  try { kind = essayKind(fm); } catch (e) { problems.push(String((e as Error).message)); }
  for (const k of kind === "explainer" ? EXPLAINER_KEYS : REQUIRED_KEYS) if (!(k in fm)) problems.push(`frontmatter missing ${k}`);
  if ("attribution_unsure" in fm && !Array.isArray(fm.attribution_unsure)) problems.push("attribution_unsure must be a list");
  for (const s of kind === "explainer" ? EXPLAINER_SECTIONS : REQUIRED_SECTIONS) if (!new RegExp(`^##\\s+${s}\\s*$`, "m").test(body)) problems.push(`section missing: ## ${s}`);
  const quotes = extractQuotes(body);
  if (quotes.length === 0 && kind === "essay") problems.push("no blockquotes — Their Claims must quote the source verbatim");
  for (const q of quotes) {
    if (!q.speaker) problems.push(`quote at line ${q.line} has no attribution line (\`> — Speaker\`)`);
    if (q.text.split(/\s+/).length < 4) problems.push(`quote at line ${q.line} is under four words`);
  }
  if (transcript !== undefined) {
    const src = normalizeText(transcript);
    const unsure = (Array.isArray(fm.attribution_unsure) ? fm.attribution_unsure : []).map((s) => normalizeText(String(s)));
    for (const q of quotes) {
      const n = normalizeText(q.text);
      if (!src.includes(n)) problems.push(`quote at line ${q.line} not found verbatim in the transcript: "${q.text.slice(0, 60)}…"`);
      const head = n.split(" ").slice(0, 8).join(" ");
      if (q.speaker.toLowerCase().includes("unsure") || q.speaker.toLowerCase().includes("?")) {
        if (!unsure.some((u) => u.startsWith(head) || head.startsWith(u))) problems.push(`quote at line ${q.line} is marked unsure but not listed in attribution_unsure`);
      }
    }
  }
  const words = body.replace(/^>.*$/gm, "").split(/\s+/).filter(Boolean).length;
  return { ok: problems.length === 0, problems, quotes, words };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runArg = argValue(argv, "--run");
  if (!runArg) { console.error("usage: EssayLint.ts --run <slug|dir> [--source] [--json]"); process.exit(2); }
  const paths = runPaths(resolveRunDir(runArg));
  if (!existsSync(paths.essay)) { console.error(`✗ ${paths.essay} missing`); process.exit(1); }
  const md = readFileSync(paths.essay, "utf8");
  const transcript = hasFlag(argv, "--source") ? readFileSync(paths.transcript, "utf8") : undefined;
  const r = lintEssay(md, transcript);
  if (hasFlag(argv, "--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.words} words (quotes excluded) · ${r.quotes.length} quotes`);
    for (const p of r.problems) console.log(`✗ ${p}`);
    if (r.ok) console.log("✓ essay ok");
  }
  process.exit(r.ok ? 0 : 1);
}
