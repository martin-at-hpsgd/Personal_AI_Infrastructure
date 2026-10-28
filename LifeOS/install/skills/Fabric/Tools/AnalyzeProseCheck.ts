#!/usr/bin/env bun
// AnalyzeProseCheck — checks an AnalyzeProse output against the parts of its
// contract code can judge. Ratings mode ("# Prose Analysis:"): Novelty, Clarity
// and Prose each open on a grade from their fixed scale, Recommendations are
// labelled bullets covering every grade below A, and the Overall rating is one
// letter equal to the lowest grade. Pinker mode ("# Sense of Style:"): style
// bullets naming a Pinker style, the ten qualities scored once each with a
// weighted mean that adds up, pitfalls named from Pinker's list, good and bad
// examples, spelling and grammar fixes, recommendations with rewrites, and a
// score where 100 minus the deductions equals the final score. With --source,
// every quotation of six or more words (before any → rewrite) must appear in the supplied text and
// the output fits the word budget that text's length sets. Whether the grades
// are earned and the feedback specific stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeProseCheck — shape check for a Fabric AnalyzeProse output

  bun skills/Fabric/Tools/AnalyzeProseCheck.ts <file|-> [--mode ratings|pinker] [--source <text-file>] [--max-words N] [--sections <list>] [--json]

  --mode M      pin the mode (default: read from the title)
  --source F    the supplied text; quotations of 6+ words must appear in it, no **Source:** line is allowed,
                and counts and the word budget follow its length
  --max-words N cap the output at N words (overrides the budget)
  --sections L  comma list of the sections a hint asked for; the output holds exactly those, in order
                ratings: novelty, clarity, prose, recommendations, overall
                pinker:  style, positive, critical, examples, spelling, improvements, scoring
  --json        print {ok, mode, sections, words, budget, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Mode = "ratings" | "pinker";

export const RATINGS_SECTIONS = ["Novelty", "Clarity", "Prose", "Recommendations", "Overall rating"] as const;
export const PINKER_SECTIONS = [
  "Style analysis",
  "Positive assessment",
  "Critical assessment",
  "Examples",
  "Spelling and grammar",
  "Improvement recommendations",
  "Scoring",
] as const;

const ALIASES: Record<Mode, Record<string, string>> = {
  ratings: { novelty: "Novelty", clarity: "Clarity", prose: "Prose", recommendations: "Recommendations", overall: "Overall rating", "overall rating": "Overall rating" },
  pinker: {
    style: "Style analysis",
    positive: "Positive assessment",
    critical: "Critical assessment",
    examples: "Examples",
    spelling: "Spelling and grammar",
    grammar: "Spelling and grammar",
    improvements: "Improvement recommendations",
    recommendations: "Improvement recommendations",
    scoring: "Scoring",
    score: "Scoring",
  },
};

/** The three ratings-mode scales, best to worst. */
export const SCALES: Record<"Novelty" | "Clarity" | "Prose", Record<string, string>> = {
  Novelty: { A: "Novel", B: "Fresh", C: "Incremental", D: "Derivative", F: "Stale" },
  Clarity: { A: "Crystal", B: "Clean", C: "Kludgy", D: "Confusing", F: "Chaotic" },
  Prose: { A: "Inspired", B: "Distinctive", C: "Standard", D: "Stale", F: "Weak" },
};
const GRADE_ORDER = ["A", "B", "C", "D", "F"];

/** Pinker's ten qualities and the weight each carries in the weighted score. */
export const QUALITIES: Record<string, number> = {
  Clarity: 10, Brevity: 8, Elegance: 7, Coherence: 9, Directness: 8,
  Vividness: 7, Honesty: 9, Variety: 6, Precision: 9, Consistency: 7,
};

export const STYLES = ["classic", "practical", "self-conscious", "postmodern", "academic", "legal"];

export const PITFALLS = [
  "Metadiscourse", "Verbal hedge", "Nominalization", "Passive voice", "Jargon and technical terms",
  "Clichés", "False fronts", "Overuse of adverbs", "Zombie nouns", "Complex sentences", "Euphemism",
  "Out-of-context quotations", "Excessive precaution", "Overgeneralization", "Mixed metaphors",
  "Tautology", "Obfuscation", "Redundancy", "Provincialism", "Archaism", "Euphuism", "Officialese",
  "Gobbledygook", "Bafflegab", "Mangled idioms",
];

function norm(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().replace(/s$/, "");
}

/** A pitfall name matches when it equals a canonical name or is its first word(s) ("Jargon", "Hedge"). */
export function pitfallName(raw: string): string | undefined {
  const n = norm(raw);
  if (!n) return undefined;
  return PITFALLS.find((p) => {
    const c = norm(p);
    return c === n || c.startsWith(`${n} `) || c.split(" ").pop() === n;
  });
}

export function parseSections(mode: Mode, list: string): string[] | string {
  const out: string[] = [];
  for (const raw of list.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const s = ALIASES[mode][raw];
    if (!s) return `unknown ${mode} section "${raw}" (use ${Object.keys(ALIASES[mode]).filter((k) => !k.includes(" ")).join(", ")})`;
    if (!out.includes(s)) out.push(s);
  }
  if (out.length === 0) return "--sections needs at least one section";
  const order: readonly string[] = mode === "ratings" ? RATINGS_SECTIONS : PINKER_SECTIONS;
  return order.filter((s) => out.includes(s));
}

/** Letters and digits only, lowercased, apostrophes dropped, so punctuation and curly quotes never decide a match. */
export function tokens(text: string): string[] {
  return text.toLowerCase().replace(/['’‘`]/g, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

/** Double-quoted spans, straight or curly. */
export function quotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) out.push((m[1] ?? m[2]).trim());
  return out.filter((q) => tokens(q).length > 0);
}

/** The part of a line that quotes the text: everything before the first → or -> rewrite. */
export function quotedPart(line: string): string {
  const i = line.search(/→|->/);
  return i < 0 ? line : line.slice(0, i);
}

/** Quoted spans shorter than this are taken as suggested wording ("use", "you"), not as quotations of the text. */
export const QUOTE_MIN_TOKENS = 6;

/** A quotation matches when each fragment (split at ellipses and [bracketed] insertions) appears in the source as a token run. */
export function inSource(quote: string, sourceTokens: string): boolean {
  const fragments = quote.split(/\.\.\.|…|\[[^\]]*\]/).map((f) => tokens(f)).filter((f) => f.length > 0);
  if (fragments.length === 0) return true;
  return fragments.every((f) => ` ${sourceTokens} `.includes(` ${f.join(" ")} `));
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

/** The word budget for the whole output, from the mode and the analyzed text's length. */
export function budget(mode: Mode, sourceWords?: number): number {
  if (mode === "ratings") return sourceWords === undefined ? 500 : sourceWords < 150 ? 400 : sourceWords < 600 ? 500 : 600;
  return sourceWords === undefined ? 1500 : sourceWords < 150 ? 1100 : sourceWords < 600 ? 1500 : 1800;
}

type Row = { text: string; line: number };
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;
const LABELLED = /^\*\*([^*]{1,60}?):?\*\*:?\s*(.*)$/;

export type Result = { ok: boolean; mode?: Mode; sections: string[]; words: number; budget?: number; problems: string[] };

export function check(input: string, opts: { mode?: Mode; source?: string; sections?: string[]; maxWords?: number } = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent < 0) return { ok: false, sections: [], words: 0, problems: ["empty output"] };

  // Title and mode.
  const h1 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#\s/.test(l));
  let mode = opts.mode;
  if (h1.length !== 1) problems.push(`expected exactly one H1 title, found ${h1.length}`);
  else {
    const t = h1[0].l;
    const titled: Mode | undefined = /^#\s+Prose Analysis:\s+\S/.test(t) ? "ratings" : /^#\s+Sense of Style:\s+\S/.test(t) ? "pinker" : undefined;
    if (!titled) problems.push(`line ${h1[0].i + 1}: the title opens "# Prose Analysis: " (ratings) or "# Sense of Style: " (Pinker) and names the text`);
    else if (mode && titled !== mode) problems.push(`the title is a ${titled} title but --mode is ${mode}`);
    mode = mode ?? titled;
    if (firstContent !== h1[0].i) problems.push(`line ${firstContent + 1}: text before the title`);
  }
  if (!mode) return { ok: false, sections: [], words: 0, problems };

  const sourceTokens = opts.source !== undefined ? tokens(opts.source).join(" ") : undefined;
  const sourceWords = opts.source !== undefined ? wordCount(opts.source) : undefined;
  const short = sourceWords !== undefined && sourceWords < 150;
  const long = sourceWords !== undefined && sourceWords >= 150;
  const limit = opts.maxWords ?? budget(mode, sourceWords);
  const words = wordCount(lines.filter((l) => !/^#{1,6}\s/.test(l)).join("\n"));
  if (words > limit) problems.push(`the output has ${words} words; the budget is ${limit}`);

  // Sections.
  const order: readonly string[] = mode === "ratings" ? RATINGS_SECTIONS : PINKER_SECTIONS;
  const expected = opts.sections ?? order;
  const h2 = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^##\s/.test(l));
  const names = h2.map(({ l }) => l.replace(/^##\s+/, "").trim());
  if (names.map((n) => n.toLowerCase()).join("|") !== expected.map((s) => s.toLowerCase()).join("|")) {
    problems.push(`sections must be exactly ${expected.join(", ")} in that order; found ${names.length ? names.join(", ") : "none"}`);
  }

  // Header block: only **Source:** then **Answer:**.
  let hasSource = false;
  if (h1.length === 1) {
    const end = h2.length ? h2[0].i : lines.length;
    let seenAnswer = false;
    lines.slice(h1[0].i + 1, end).forEach((text, k) => {
      const t = text.trim();
      if (!t) return;
      const line = h1[0].i + 2 + k;
      if (/^\*\*Source:\*\*\s+\S/.test(t)) {
        if (hasSource) problems.push(`line ${line}: more than one **Source:** line`);
        if (seenAnswer) problems.push(`line ${line}: **Source:** comes before **Answer:**`);
        hasSource = true;
      } else if (/^\*\*Answer:\*\*\s+\S/.test(t)) {
        if (seenAnswer) problems.push(`line ${line}: more than one **Answer:** line`);
        seenAnswer = true;
      } else problems.push(`line ${line}: only a **Source:** or **Answer:** line may sit between the title and the first section ("${t.slice(0, 60)}")`);
    });
  }
  if (hasSource && opts.source !== undefined) problems.push("a text was supplied (--source), so there is no **Source:** line");
  const quotesRequired = !hasSource;

  const body = (name: string): Row[] | undefined => {
    const idx = names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (idx < 0) return undefined;
    const end = idx + 1 < h2.length ? h2[idx + 1].i : lines.length;
    return lines.slice(h2[idx].i + 1, end).map((text, k) => ({ text, line: h2[idx].i + 2 + k })).filter((r) => r.text.trim() !== "");
  };

  // Every present section is non-empty, and its quotations (before any rewrite) are the source's words.
  for (const n of names) {
    const rows = body(n) ?? [];
    if (rows.length === 0) problems.push(`${n} is empty`);
    if (sourceTokens !== undefined) {
      for (const r of rows) for (const q of quotations(quotedPart(r.text))) {
        if (tokens(q).length >= QUOTE_MIN_TOKENS && !inSource(q, sourceTokens)) problems.push(`line ${r.line}: ${n} quotation not found in the source ("${q.slice(0, 80)}")`);
      }
    }
  }

  const bullets = (rows: Row[]) => rows.filter((r) => BULLET.test(r.text)).map((r) => ({ ...r, item: r.text.match(BULLET)![1] }));
  const hasQuote = (s: string) => quotations(s).length > 0;
  const hasArrow = (s: string) => /→|->/.test(s);

  if (mode === "ratings") {
    const grades: Partial<Record<"Novelty" | "Clarity" | "Prose", string>> = {};
    for (const dim of ["Novelty", "Clarity", "Prose"] as const) {
      const rows = body(dim);
      if (!rows || rows.length === 0) continue;
      const m = rows[0].text.trim().match(/^\*\*Rating:\*\*\s+([ABCDF])\s*[-–—]\s*(\S.*?)\s*$/);
      if (!m) {
        problems.push(`line ${rows[0].line}: ${dim} opens on "**Rating:** <letter> - <label>"`);
        continue;
      }
      const label = SCALES[dim][m[1]];
      if (m[2].toLowerCase() !== label.toLowerCase()) problems.push(`line ${rows[0].line}: ${dim} grade ${m[1]} is "${m[1]} - ${label}", not "${m[1]} - ${m[2]}"`);
      grades[dim] = m[1];
      if (rows.length < 2) problems.push(`${dim}: the grade has no reason under it`);
      if (quotesRequired && dim !== "Novelty" && !rows.slice(1).some((r) => hasQuote(r.text))) problems.push(`${dim}: the reason quotes nothing from the text`);
    }

    const recs = body("Recommendations");
    if (recs && recs.length) {
      const items = bullets(recs);
      const covered = new Set<string>();
      for (const r of recs) if (!BULLET.test(r.text)) problems.push(`line ${r.line}: Recommendations holds only bullets ("${r.text.trim().slice(0, 60)}")`);
      for (const b of items) {
        const m = b.item.match(LABELLED);
        const dim = m && (["Novelty", "Clarity", "Prose"] as const).find((d) => d.toLowerCase() === m[1].trim().toLowerCase());
        if (!m || !dim) {
          problems.push(`line ${b.line}: a recommendation opens on the grade it raises ("- **Clarity:** …")`);
          continue;
        }
        covered.add(dim);
        if (wordCount(m[2]) > 30) problems.push(`line ${b.line}: recommendation has ${wordCount(m[2])} words; the cap is 30`);
        if (quotesRequired && dim !== "Novelty" && !hasQuote(m[2])) problems.push(`line ${b.line}: a ${dim} recommendation points to no passage of the text`);
      }
      if (items.length > 9) problems.push(`Recommendations has ${items.length} bullets; the cap is 9`);
      for (const [dim, g] of Object.entries(grades)) if (g !== "A" && !covered.has(dim)) problems.push(`Recommendations: ${dim} is graded ${g} but has no recommendation`);
    }

    const overall = body("Overall rating");
    if (overall && overall.length) {
      const t = overall.map((r) => r.text.trim()).join(" ");
      if (!/^[ABCDF]$/.test(t)) problems.push(`Overall rating holds only the letter grade, found "${t.slice(0, 40)}"`);
      else if (grades.Novelty && grades.Clarity && grades.Prose) {
        const lowest = [grades.Novelty, grades.Clarity, grades.Prose].sort((a, b) => GRADE_ORDER.indexOf(b) - GRADE_ORDER.indexOf(a))[0];
        if (t !== lowest) problems.push(`Overall rating is ${t}; it must be the lowest of the three grades, ${lowest}`);
      }
    }
  } else {
    const style = body("Style analysis");
    if (style && style.length) {
      const items = bullets(style);
      const min = long ? 3 : 2;
      if (items.length < min || items.length > 5) problems.push(`Style analysis has ${items.length} bullets; expected ${min} to 5`);
      if (!items.some((b) => STYLES.some((s) => b.item.toLowerCase().includes(s)))) problems.push("Style analysis names none of Pinker's styles (classic, practical, self-conscious, postmodern, academic, legal)");
    }

    const positive = body("Positive assessment");
    if (positive && positive.length) {
      const seen = new Map<string, number>();
      let weighted: number | undefined;
      for (const r of positive) {
        const t = r.text.trim();
        const w = t.match(/^\*\*Weighted:\*\*\s+(\d+(?:\.\d+)?)\/10\b/);
        if (w) {
          weighted = Number(w[1]);
          continue;
        }
        const b = t.match(BULLET);
        const m = b && b[1].match(/^\*\*([A-Za-z]+):\*\*\s+(\d+)\/10\b\s*[-–—:]?\s*(.*)$/);
        const q = m && Object.keys(QUALITIES).find((k) => k.toLowerCase() === m[1].toLowerCase());
        if (!m || !q) {
          problems.push(`line ${r.line}: Positive assessment holds "- **Quality:** N/10 — reason" bullets for Pinker's ten qualities and one **Weighted:** line ("${t.slice(0, 60)}")`);
          continue;
        }
        const s = Number(m[2]);
        if (s < 1 || s > 10) problems.push(`line ${r.line}: ${q} score ${s} is outside 1 to 10`);
        if (!m[3].trim()) problems.push(`line ${r.line}: ${q} has no reason`);
        if (seen.has(q)) problems.push(`line ${r.line}: ${q} is scored twice`);
        seen.set(q, s);
      }
      const missing = Object.keys(QUALITIES).filter((k) => !seen.has(k));
      if (missing.length) problems.push(`Positive assessment is missing ${missing.join(", ")}`);
      if (weighted === undefined) problems.push("Positive assessment ends on a **Weighted:** X/10 line");
      else if (!missing.length) {
        const total = Object.entries(QUALITIES).reduce((a, [k, w]) => a + w * seen.get(k)!, 0);
        const want = Math.round((total / Object.values(QUALITIES).reduce((a, b) => a + b, 0)) * 10) / 10;
        if (Math.abs(want - weighted) > 0.11) problems.push(`**Weighted:** is ${weighted}/10; the importance-weighted mean of the ten scores is ${want}/10`);
      }
    }

    const critical = body("Critical assessment");
    if (critical && critical.length) {
      const items = bullets(critical);
      for (const r of critical) {
        if (BULLET.test(r.text)) continue;
        if (/^Scores?\b.*\bavoid/i.test(r.text.trim()) || /^\*\*Avoided:\*\*\s+\S/.test(r.text.trim())) continue;
        problems.push(`line ${r.line}: Critical assessment holds the legend line, pitfall bullets and one **Avoided:** line ("${r.text.trim().slice(0, 60)}")`);
      }
      if (items.length === 0) problems.push("Critical assessment names no pitfall the prose commits");
      for (const b of items) {
        const m = b.item.match(/^\*\*([^*]{2,40}?):\*\*\s+(\d+)\/10\b\s*[-–—:]?\s*(.*)$/);
        if (!m) {
          problems.push(`line ${b.line}: a pitfall bullet reads "- **Pitfall:** N/10 — \\"quote\\" why"`);
          continue;
        }
        if (!pitfallName(m[1])) problems.push(`line ${b.line}: "${m[1]}" is not one of Pinker's pitfalls (${PITFALLS.join(", ")})`);
        const s = Number(m[2]);
        if (s < 1 || s > 9) problems.push(`line ${b.line}: a listed pitfall is one the prose commits, so its avoidance score is 1 to 9, not ${s}`);
        if (quotesRequired && !hasQuote(m[3])) problems.push(`line ${b.line}: ${m[1]} quotes no instance from the text`);
      }
    }

    const examples = body("Examples");
    if (examples && examples.length) {
      let good = 0;
      let bad = 0;
      for (const r of examples) {
        const b = r.text.match(BULLET);
        const m = b && b[1].match(/^\*\*(Good|Bad):\*\*\s+(.*\S)/i);
        if (!m) {
          problems.push(`line ${r.line}: Examples holds "- **Good:**" and "- **Bad:**" bullets ("${r.text.trim().slice(0, 60)}")`);
          continue;
        }
        if (m[1].toLowerCase() === "good") good++;
        else bad++;
        if (quotesRequired && !hasQuote(m[2])) problems.push(`line ${r.line}: an example quotes nothing from the text`);
      }
      const min = long ? 3 : 1;
      if (good < min || good > 5) problems.push(`Examples has ${good} good examples; expected ${min} to 5`);
      if (bad < min || bad > 5) problems.push(`Examples has ${bad} bad examples; expected ${min} to 5`);
    }

    const spelling = body("Spelling and grammar");
    if (spelling && spelling.length) {
      const none = spelling.length === 1 && /^None found\.?$/i.test(spelling[0].text.trim());
      if (!none) {
        for (const r of spelling) {
          const b = r.text.match(BULLET);
          if (!b) problems.push(`line ${r.line}: Spelling and grammar holds fix bullets or the single line "None found." ("${r.text.trim().slice(0, 60)}")`);
          else if (!hasArrow(b[1]) || (quotesRequired && !hasQuote(b[1]))) problems.push(`line ${r.line}: a fix quotes the error and gives the correction after → ("${b[1].slice(0, 60)}")`);
        }
      }
    }

    const improvements = body("Improvement recommendations");
    if (improvements && improvements.length) {
      const items = bullets(improvements);
      for (const r of improvements) if (!BULLET.test(r.text)) problems.push(`line ${r.line}: Improvement recommendations holds only bullets ("${r.text.trim().slice(0, 60)}")`);
      const min = short ? 2 : sourceWords === undefined ? 2 : 5;
      if (items.length < min || items.length > 10) problems.push(`Improvement recommendations has ${items.length} bullets; expected ${min} to 10`);
      for (const b of items) {
        if (!hasArrow(b.item) || (quotesRequired && !hasQuote(b.item))) problems.push(`line ${b.line}: a recommendation quotes the passage and gives the rewrite after → ("${b.item.slice(0, 60)}")`);
      }
    }

    const scoring = body("Scoring");
    if (scoring && scoring.length) {
      const text = scoring.map((r) => r.text.trim());
      const startIdx = text.findIndex((t) => /^Starting score:\s*100$/i.test(t));
      const finalIdx = text.findIndex((t) => /^Final score:\s*-?\d+$/i.test(t));
      if (startIdx !== 0) problems.push('Scoring opens on "Starting score: 100"');
      if (finalIdx < 0) problems.push('Scoring has a "Final score: X" line');
      else {
        const deductions = text.slice(Math.max(startIdx, 0) + 1, finalIdx).filter((t) => !/^Deductions:?$/i.test(t));
        let sum = 0;
        for (const d of deductions) {
          const m = d.match(/^[-*]\s+[-−–](\d+)\s+(?:for\s+)?\S/);
          if (!m) problems.push(`Scoring: a deduction reads "- −N for <reason>" ("${d.slice(0, 60)}")`);
          else sum += Number(m[1]);
        }
        const final = Number(text[finalIdx].match(/(-?\d+)$/)![1]);
        if (final < 0 || final > 100) problems.push(`Final score ${final} is outside 0 to 100`);
        if (100 - sum !== final) problems.push(`Final score is ${final}, but 100 minus the deductions (${sum}) is ${100 - sum}`);
        const verdict = text.slice(finalIdx + 1).join(" ");
        if (!verdict) problems.push("Scoring ends on the overall assessment after the final score");
        else {
          const sentences = verdict.split(/(?<=[.!?])\s+/).filter((s) => /\w/.test(s)).length;
          if (sentences < 2 || sentences > 3) problems.push(`the overall assessment is ${sentences} sentences; expected 2 to 3`);
          if (wordCount(verdict) > 200) problems.push(`the overall assessment has ${wordCount(verdict)} words; the cap is 200`);
        }
      }
    }
  }

  return { ok: problems.length === 0, mode, sections: names, words, budget: limit, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const valued = new Set(["--mode", "--source", "--sections", "--max-words"]);
  const known = new Set(["--json", ...valued]);
  const unknown = args.filter((a) => a.startsWith("--") && !known.has(a));
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
    process.exit(2);
  }
  const val = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  for (const f of valued) {
    if (args.includes(f) && (val(f) === undefined || val(f)!.startsWith("--"))) {
      console.error(`${f} needs a value`);
      process.exit(2);
    }
  }
  const modeArg = val("--mode");
  if (modeArg !== undefined && modeArg !== "ratings" && modeArg !== "pinker") {
    console.error("--mode is ratings or pinker");
    process.exit(2);
  }
  const maxArg = val("--max-words");
  const maxWords = maxArg === undefined ? undefined : Number(maxArg);
  if (maxWords !== undefined && (!Number.isInteger(maxWords) || maxWords < 1)) {
    console.error("--max-words needs a whole number of at least 1");
    process.exit(2);
  }
  const consumed = new Set<number>();
  args.forEach((a, i) => { if (valued.has(a)) consumed.add(i + 1); });
  const src = args.find((a, i) => !a.startsWith("--") && !consumed.has(i));
  const read = (p: string | undefined, what: string): string => {
    try {
      return p === undefined || p === "-" ? readFileSync(0, "utf8") : readFileSync(p, "utf8");
    } catch (e) {
      console.error(`cannot read ${what} ${p ?? "stdin"}: ${(e as Error).message}`);
      process.exit(2);
    }
  };
  const input = read(src, "output");
  const sourcePath = val("--source");
  const source = sourcePath === undefined ? undefined : read(sourcePath, "source");
  let sections: string[] | undefined;
  const sectionsArg = val("--sections");
  if (sectionsArg !== undefined) {
    const mode: Mode | undefined = (modeArg as Mode | undefined) ?? (/^#\s+Sense of Style:/m.test(input) ? "pinker" : /^#\s+Prose Analysis:/m.test(input) ? "ratings" : undefined);
    if (!mode) {
      console.error("--sections needs the mode: pass --mode or a recognizable title");
      process.exit(2);
    }
    const parsed = parseSections(mode, sectionsArg);
    if (typeof parsed === "string") {
      console.error(parsed);
      process.exit(2);
    }
    sections = parsed;
  }
  const r = check(input, { mode: modeArg as Mode | undefined, source, sections, maxWords });
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.mode} analysis, ${r.sections.length} sections, ${r.words}/${r.budget} words, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
