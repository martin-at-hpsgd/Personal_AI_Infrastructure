#!/usr/bin/env bun
// StoicLensCheck — checks a StoicLens output against the parts of its contract
// code can judge: the "# Stoic Lens:" title, optional Source and Answer lines,
// the five sections in order (or the hinted subset), lineage entries marked
// named or unnamed, tensions in prose, questions attributed to a tradition and
// ending on "?" with a Stoic one among them, connections marked converges or
// contradicts, quotations from the text where a supplied text requires them,
// and the one-line nothing-to-trace form. Whether the reading traces lineage
// rather than summarizing, and whether attributions are accurate, stays judged.

import { readFileSync } from "node:fs";

const HELP = `StoicLensCheck — shape check for a Fabric StoicLens output

  bun skills/Fabric/Tools/StoicLensCheck.ts <file|-> [--source <text-file>] [--sections <list>] [--json]

  --source F    the supplied text; each lineage entry and the tensions section must
                quote it, and no **Source:** line is allowed
  --sections L  comma list of the sections a hint asked for (lineage, tensions,
                questions, connections, seeds); they must appear alone, in canonical order
  --json        print {ok, nothingToTrace, sections, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = [
  "Philosophical lineage",
  "Key tensions and divergences",
  "Unasked questions",
  "Connections to other thinkers",
  "Synthesis seeds",
] as const;
export type Section = (typeof SECTIONS)[number];

const SHORT: Record<string, Section> = {
  lineage: "Philosophical lineage",
  tensions: "Key tensions and divergences",
  divergences: "Key tensions and divergences",
  questions: "Unasked questions",
  connections: "Connections to other thinkers",
  seeds: "Synthesis seeds",
  synthesis: "Synthesis seeds",
};

export const STOIC = /\b(?:stoic|stoics|stoicism|epictetus|seneca|marcus aurelius|zeno|chrysippus|cleanthes|musonius|panaetius|posidonius)\b/i;
/** A bold label that may hold *italic* titles: the shortest run up to a closing ** not followed by a third *. */
const LABEL = String.raw`\*\*(.+?\*?)\*\*(?!\*)`;
const LINEAGE_ENTRY = new RegExp(String.raw`^- ${LABEL}\s*\((named|unnamed)\)\s*:\s*(\S.*)$`, "i");
const QUESTION_ENTRY = [new RegExp(String.raw`^- \*\*(.+?):\*\*\s*(\S.*)$`), new RegExp(String.raw`^- ${LABEL}:\s*(\S.*)$`)];
const CONNECTION_ENTRY = new RegExp(String.raw`^- ${LABEL}\s*\((?:converges|contradicts|converges and contradicts|both)\)\s*:\s*\S`, "i");
const PLACEHOLDER = /\{[^}\n]*\}|\bnamed \| unnamed\b|\bconverges \| contradicts\b/;

export function parseSections(arg: string): Section[] | string {
  const out: Section[] = [];
  for (const raw of arg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const full = SECTIONS.find((s) => s.toLowerCase() === raw) ?? SHORT[raw];
    if (!full) return `unknown section "${raw}"`;
    if (!out.includes(full)) out.push(full);
  }
  if (out.length === 0) return "--sections needs at least one section";
  return SECTIONS.filter((s) => out.includes(s));
}

/** Letters and digits only, lowercased, apostrophes dropped, so punctuation and curly quotes never decide a match. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’‘]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Double-quoted spans, straight or curly. */
export function quotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) out.push((m[1] ?? m[2]).trim());
  return out.filter((q) => tokens(q).length > 0);
}

/** A quotation matches when each fragment (split at ellipses and [bracketed] insertions) appears in the source as a token run. */
export function inSource(quote: string, source: string): boolean {
  const hay = ` ${tokens(source).join(" ")} `;
  const fragments = quote.split(/\.\.\.|…|\[[^\]]*\]/).map((f) => tokens(f)).filter((f) => f.length > 0);
  return fragments.length > 0 && fragments.every((f) => hay.includes(` ${f.join(" ")} `));
}

const stem = (t: string) => t.replace(/(?:ing|ed|es|s)$/, "");

/**
 * A quotation not found in the source that is still almost the source's words:
 * the same run with inflections changed ("feel it fastest" for "feels it
 * fastest"), or a run of four or more words with one word swapped. That is a
 * misquote of the text, never a quotation from another thinker.
 */
export function nearMiss(quote: string, source: string): boolean {
  if (inSource(quote, source)) return false;
  const q = tokens(quote);
  if (q.length < 3) return false;
  const s = tokens(source);
  const qs = q.map(stem);
  const ss = s.map(stem);
  for (let i = 0; i + q.length <= s.length; i++) {
    let exactMiss = 0;
    let stemMiss = 0;
    for (let j = 0; j < q.length; j++) {
      if (q[j] !== s[i + j]) exactMiss++;
      if (qs[j] !== ss[i + j]) stemMiss++;
    }
    if (stemMiss === 0) return true;
    if (q.length >= 4 && exactMiss <= 1) return true;
  }
  return false;
}

type Line = { text: string; line: number };
type Result = { ok: boolean; nothingToTrace: boolean; sections: string[]; problems: string[] };

/** Group a section body into bullets, each with its indented continuation lines. */
function bullets(body: Line[], section: string, problems: string[]): Line[] {
  const out: Line[] = [];
  for (const l of body) {
    if (/^- \S/.test(l.text)) out.push({ ...l });
    else if (/^\s{2,}\S/.test(l.text) && out.length) out[out.length - 1].text += ` ${l.text.trim()}`;
    else problems.push(`line ${l.line}: ${section} holds bullets only ("${l.text.trim().slice(0, 50)}")`);
  }
  return out;
}

export function check(input: string, opts: { source?: string; sections?: Section[] } = {}): Result {
  const text = input.replace(/\r\n/g, "\n").trim();
  const problems: string[] = [];

  if (/^\*\*Nothing to trace:\*\*/.test(text)) {
    if (text.replace(/^\*\*Nothing to trace:\*\*/, "").trim() === "") problems.push("the nothing-to-trace line says nothing about what the text is");
    if (text.includes("\n")) problems.push("a nothing-to-trace output is one line only");
    return { ok: problems.length === 0, nothingToTrace: true, sections: [], problems };
  }
  if (text === "") return { ok: false, nothingToTrace: false, sections: [], problems: ["empty output"] };

  const lines: Line[] = text.split("\n").map((t, i) => ({ text: t, line: i + 1 }));
  const ph = lines.find((l) => PLACEHOLDER.test(l.text));
  if (ph) problems.push(`line ${ph.line}: template placeholder left in the output ("${ph.text.trim().slice(0, 60)}")`);

  // Title.
  const h1s = lines.filter((l) => /^# /.test(l.text));
  if (!/^# Stoic Lens: *\S/.test(lines[0].text)) problems.push('the output opens on the title "# Stoic Lens: {what the text is}"');
  if (h1s.length > 1) problems.push(`${h1s.length} H1 titles; only one is allowed`);

  // Sections.
  const heads = lines.filter((l) => /^## /.test(l.text));
  const names = heads.map((h) => h.text.slice(3).trim());
  const canonical = names.map((n) => SECTIONS.find((s) => s.toLowerCase() === n.toLowerCase()));
  const expected: readonly Section[] = opts.sections ?? SECTIONS;
  if (canonical.some((c) => !c) || canonical.join("|") !== expected.join("|")) {
    problems.push(`sections must be exactly ${expected.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }

  // Between the title and the first section: an optional Source line, then an optional Answer line.
  const firstHead = heads.length ? heads[0].line : lines.length + 1;
  const front = lines.slice(1, firstHead - 1).filter((l) => l.text.trim() !== "");
  let hasSource = false;
  let sawAnswer = false;
  for (const l of front) {
    const m = l.text.match(/^\*\*(Source|Answer):\*\*\s*(.*)$/);
    if (!m) { problems.push(`line ${l.line}: only a **Source:** or **Answer:** line may sit between the title and the sections`); continue; }
    if (m[2].trim() === "") problems.push(`line ${l.line}: empty ${m[1]} line`);
    if (m[1] === "Source") {
      if (hasSource) problems.push("more than one Source line");
      if (sawAnswer) problems.push(`line ${l.line}: the Source line comes before the Answer line`);
      hasSource = true;
    } else {
      if (sawAnswer) problems.push("more than one Answer line");
      sawAnswer = true;
    }
  }
  if (hasSource && opts.source !== undefined) problems.push("a text was supplied (--source), so there is no **Source:** line");
  const textSupplied = !hasSource;

  const body = (s: Section): Line[] | null => {
    const i = canonical.indexOf(s);
    if (i < 0) return null;
    const end = i + 1 < heads.length ? heads[i + 1].line - 1 : lines.length;
    return lines.slice(heads[i].line, end).filter((l) => l.text.trim() !== "");
  };
  const quoted = (where: string, t: string, line: number) => {
    if (!textSupplied) return;
    const qs = quotations(t);
    if (qs.length === 0) { problems.push(`line ${line}: ${where} quotes nothing from the text`); return; }
    if (opts.source !== undefined && !qs.some((q) => inSource(q, opts.source!))) problems.push(`line ${line}: ${where} has no quotation found in the source ("${qs[0].slice(0, 60)}")`);
  };

  for (const s of SECTIONS) {
    const b = body(s);
    if (b === null) continue;
    const at = heads[canonical.indexOf(s)].line;
    if (b.length === 0) { problems.push(`line ${at}: section "${s}" is empty`); continue; }

    if (s === "Philosophical lineage") {
      for (const e of bullets(b, s, problems)) {
        const m = e.text.match(LINEAGE_ENTRY);
        if (!m) { problems.push(`line ${e.line}: a lineage entry opens "- **Thinker** (named|unnamed): " ("${e.text.slice(0, 60)}")`); continue; }
        quoted(`lineage entry "${m[1].trim()}"`, m[3], e.line);
      }
    }

    if (s === "Key tensions and divergences") {
      if (b.every((l) => /^\s*[-*] /.test(l.text))) problems.push(`line ${at}: Key tensions and divergences is prose, not bullets only`);
      quoted("Key tensions and divergences", b.map((l) => l.text).join(" "), at);
    }

    if (s === "Unasked questions") {
      const qs = bullets(b, s, problems);
      let stoic = false;
      for (const q of qs) {
        const m = q.text.match(QUESTION_ENTRY[0]) ?? q.text.match(QUESTION_ENTRY[1]);
        if (!m) { problems.push(`line ${q.line}: a question opens on its tradition in bold ("- **The Stoics:** ...")`); continue; }
        if (STOIC.test(m[1])) stoic = true;
        if (!/\?["”')\]*_]*$/.test(m[2].trim())) problems.push(`line ${q.line}: the ${m[1].trim()} entry is not phrased as a question`);
      }
      if (qs.length && !stoic) problems.push(`line ${at}: no question is attributed to a Stoic thinker or the Stoics`);
    }

    if (s === "Connections to other thinkers") {
      for (const e of bullets(b, s, problems)) {
        if (!CONNECTION_ENTRY.test(e.text)) problems.push(`line ${e.line}: a connection opens "- **Thinker** (converges|contradicts|both): " ("${e.text.slice(0, 60)}")`);
      }
    }

    if (s === "Synthesis seeds") bullets(b, s, problems);
  }

  if (opts.source !== undefined) {
    for (const l of lines) for (const q of quotations(l.text)) {
      if (nearMiss(q, opts.source)) problems.push(`line ${l.line}: "${q.slice(0, 60)}" misquotes the text; quote its exact words`);
    }
  }

  return { ok: problems.length === 0, nothingToTrace: false, sections: names, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const valued = new Set(["--source", "--sections"]);
  const flags = new Set([...valued, "--json"]);
  const unknown = args.find((a) => a.startsWith("--") && !flags.has(a));
  if (unknown) { console.error(`unknown flag ${unknown}`); process.exit(2); }
  const value = (f: string): string | undefined => {
    const i = args.indexOf(f);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) { console.error(`${f} needs a value`); process.exit(2); }
    return v;
  };
  const sourcePath = value("--source");
  const sectionsArg = value("--sections");
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && valued.has(args[i - 1])));
  if (positional.length > 1) { console.error("one output file at most"); process.exit(2); }
  const src = positional[0];
  let sections: Section[] | undefined;
  if (sectionsArg !== undefined) {
    const parsed = parseSections(sectionsArg);
    if (typeof parsed === "string") { console.error(parsed); process.exit(2); }
    sections = parsed;
  }
  const isStdin = (p: string | undefined) => p === undefined || p === "-";
  if (sourcePath === "-" && isStdin(src)) { console.error("only one of the output and --source can be stdin"); process.exit(2); }
  let input: string;
  let source: string | undefined;
  try {
    input = isStdin(src) ? readFileSync(0, "utf8") : readFileSync(src!, "utf8");
    if (sourcePath !== undefined) source = sourcePath === "-" ? readFileSync(0, "utf8") : readFileSync(sourcePath, "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { source, sections });
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.nothingToTrace ? "✓ nothing-to-trace line, shape holds" : `✓ ${r.sections.length} sections, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
