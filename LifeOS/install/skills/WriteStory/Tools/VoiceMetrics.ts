#!/usr/bin/env bun
/**
 * VoiceMetrics — deterministic prose measurement.
 *
 * Computes a metric vector for any markdown or plain text. The vector is the
 * countable half of a voice model: rhythm, person, hedging, connective habit,
 * and the specific constructions that mark machine prose.
 *
 * Everything here is countable on purpose. Whatever needs a reader instead of a
 * counter belongs to the judge, not to this file.
 *
 * Usage:
 *   bun VoiceMetrics.ts <file>              # JSON vector for one file
 *   bun VoiceMetrics.ts --text "..."        # JSON vector for inline text
 *   bun VoiceMetrics.ts <file> --pretty     # human-readable table
 *   bun VoiceMetrics.ts <a> <b> ... --json  # array of vectors
 */

// ---------------------------------------------------------------- extraction

/**
 * Reduce a markdown document to the author's own running prose.
 *
 * Removed: frontmatter, fenced code, HTML/JSX component blocks, block quotes
 * (someone else's words), headings, images, list items, footnote/notes blocks,
 * and horizontal rules. What survives is the paragraphs the author wrote.
 */
export function extractProse(raw: string): string {
  let t = raw;

  t = t.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""); // frontmatter
  t = t.replace(/```[\s\S]*?```/g, "\n"); // fenced code
  t = t.replace(/~~~[\s\S]*?~~~/g, "\n");

  // Style and script bodies sit BETWEEN tags, so tag-stripping alone leaves CSS and JS
  // behind to be counted as sentences. Remove the whole element.
  t = t.replace(/<style[\s\S]*?<\/style>/gi, "\n");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, "\n");

  // Quoted material — never the author's voice.
  t = t.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n");
  t = t.replace(/<BlockQuote[\s\S]*?<\/BlockQuote>/g, "\n");
  t = t.replace(/^\s*>.*$/gm, "");

  // Notes / references blocks.
  t = t.replace(/<Notes>[\s\S]*?<\/Notes>/gi, "\n");
  t = t.replace(/^#+\s*(Notes|References|Sources|Footnotes)\s*$[\s\S]*$/im, "\n");

  // Structural component wrappers: keep inner text for callout/aside/definition,
  // since those carry the author's own lines.
  t = t.replace(/<\/?(callout|aside|definition|term|description|cite)[^>]*>/gi, " ");
  t = t.replace(/<[^>]+>/g, " "); // any remaining tags

  t = t.replace(/^#{1,6}\s+.*$/gm, ""); // headings
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links → text
  t = t.replace(/^\s*([-*+]|\d+[.)])\s+.*$/gm, ""); // list items
  t = t.replace(/^\s*([-*_]\s*){3,}\s*$/gm, ""); // rules
  t = t.replace(/^\s*\|.*\|\s*$/gm, ""); // tables
  t = t.replace(/[*_`]/g, ""); // emphasis marks

  return t.replace(/\n{3,}/g, "\n\n").trim();
}

export function splitParagraphs(prose: string): string[] {
  return prose
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Sentence split that survives abbreviations, initials, decimals and ellipses. */
export function splitSentences(paragraph: string): string[] {
  const guarded = paragraph
    .replace(/\b([A-Z])\.\s*([A-Z])\./g, "$1<DOT>$2<DOT>") // I.J. Good
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|No|Inc|Ltd|Fig)\./gi, "$1<DOT>")
    .replace(/(\d)\.(\d)/g, "$1<DOT>$2")
    .replace(/\.\.\./g, "<ELL>");

  return guarded
    .split(/(?<=[.!?])["')\]]*\s+/)
    .map((s) => s.replace(/<DOT>/g, ".").replace(/<ELL>/g, "...").trim())
    .filter((s) => s.length > 0);
}

const words = (s: string): string[] => s.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];

// ------------------------------------------------------------------ lexicons

/** Softeners and stance markers. Speech leaves these in; polished prose strips them. */
const HEDGES = [
  "i think", "i believe", "i guess", "i suspect", "i'd say", "i would say",
  "basically", "essentially", "pretty much", "kind of", "sort of", "somewhat",
  "probably", "maybe", "perhaps", "arguably", "honestly", "frankly",
  "at least", "more or less", "or something", "i mean", "seems like",
  "i'm not sure", "not sure", "as far as i", "in my experience", "to me",
];

/** Register markers: enthusiasm and emphasis words that speech carries and polished prose trims. */
const INTENSIFIERS = [
  "super", "really", "very", "so much", "way more", "way better", "a lot",
  "massively", "hugely", "extremely", "incredibly", "absolutely", "totally",
  "coolest", "craziest", "biggest", "best part", "favorite", "love",
];

/** Constructions that read as machine prose. Each is a documented tell. */
const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "negation-pair", re: /\b(it'?s|that'?s|this is|they'?re|we'?re|he was|she was|i'?m)\s+not\s+[^.!?]{2,60}?[,.—-]\s*(it'?s|that'?s|this is|they'?re|we'?re|he was|she was|i'?m)\b/gi },
  { name: "not-just-but", re: /\b(not (just|only|merely)|isn'?t (just|only|merely))\b[^.!?]{2,80}?\b(but|it'?s)\b/gi },
  { name: "the-question-isnt", re: /\bthe (question|point|issue|problem|answer|thing)\s+(isn'?t|is not|wasn'?t)\b/gi },
  // Narrow on purpose. Openers like "Here's what I recommend" and "So here's
  // what I've been thinking about" occur in real spoken corpora; only the bare
  // "here's the thing" transition is the machine tell.
  { name: "heres-the-thing", re: /\bhere'?s the thing\b|\bthe thing is[,:]/gi },
  { name: "its-not-about", re: /\b(it'?s|this is|that'?s)\s+not\s+about\b/gi },
  // Reaction reveal: announcing a reaction, then the fact after a colon ("the
  // number that got me:", "what struck me was"). State the fact, then react to it if the reaction earns its place.
  { name: "reaction-reveal", re: /\b(?:the\s+(?:number|part|thing|bit|line|stat|one)\s+that\s+(?:got|struck|stuck\s+with|stood\s+out\s+to|surprised|jumped\s+out\s+at|hit)\s+me|what\s+(?:got|struck|surprised|stood\s+out\s+to|jumped\s+out\s+at|hit)\s+me)\b(?:\s+(?:was|is|though))?\s*[:,]?/gi },
  // Narrator's aside / universalizing clause: the narrator steps out of the scene to
  // speak for everyone ("the way everyone reads agreements", "as anyone would"), then
  // steps back in. Reads as the machine reaching for wisdom in the middle of a scene.
  { name: "narrator-aside", re: /\b(?:the way (?:everyone|everybody|anyone|anybody|people|most people|nobody|no one|you|we) (?:always |never |ever )?(?:do|does|did|would|read|reads|forget|forgets|enter|enters|say|says|talk|talks|think|thinks|treat|treats|handle|handles|remember|remembers|use|uses)\b|as (?:anyone|anybody|everyone|everybody|most people) (?:would|does|did|might|will)\b|(?:everyone|everybody|nobody|no one|no-one|anyone|anybody) (?:ever|always|never)\b|which is what (?:everyone|everybody|people|anyone|we all|you) (?:do|does|did)\b|the (?:ordinary|usual|familiar) \w+ of (?:a|an|any|every) \w+)/gi },
  { name: "in-a-world-where", re: /\bin a world where\b/gi },
  { name: "spaced-em-dash", re: /\s—\s/g },
  { name: "delve-tapestry", re: /\b(delve|tapestry|multifaceted|underscore[sd]?|pivotal|realm|landscape of|navigate the|testament to)\b/gi },
  { name: "copula-avoidance", re: /\b(serves as|represents|constitutes|embodies|showcases|boasts|features a|presents a)\b/gi },
];

/** Openings that mark a sentence as a continuation of speech rather than a new brick. */
const INITIAL_CONJUNCTIONS = /^(and|but|so|or|because|which|yet|plus|also|though|anyway|still)\b/i;

/** Rough clause counter: commas, semicolons, colons and subordinators. */
const SUBORDINATORS = /\b(that|which|who|whom|whose|because|although|though|while|whereas|since|unless|until|when|where|if|before|after|so that|even though|as if)\b/gi;

// ------------------------------------------------------------------- metrics

export interface VoiceVector {
  source: string;
  word_count: number;
  sentence_count: number;
  paragraph_count: number;

  /** Rhythm. The single most discriminating family. */
  sent_len_mean: number;
  sent_len_sd: number;
  /** SD divided by mean. Uniform rhythm collapses toward 0. */
  sent_len_cv: number;
  sent_len_p10: number;
  sent_len_p90: number;
  /** Share of sentences under 6 words. Staccato prose stacks these. */
  short_sentence_rate: number;
  /** Share of sentences over 25 words. Explanatory prose needs some. */
  long_sentence_rate: number;

  /** Paragraph shape. */
  para_len_mean: number;
  para_len_sd: number;
  /** Share of paragraphs that are a single sentence. */
  single_sentence_para_rate: number;

  /** Per 100 words unless noted. */
  first_person_density: number;
  second_person_density: number;
  hedge_density: number;
  intensifier_density: number;
  contraction_density: number;

  /** Per 100 sentences. */
  initial_conjunction_rate: number;
  question_rate: number;
  fragment_rate: number;

  clauses_per_sentence: number;

  /** Raw counts of machine-prose constructions, plus a per-1000-word rate. */
  banned_hits: Record<string, number>;
  banned_total: number;
  banned_per_1k: number;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
};

const r2 = (n: number): number => Math.round(n * 100) / 100;

const countMatches = (text: string, needles: string[]): number => {
  const lower = text.toLowerCase();
  let n = 0;
  for (const needle of needles) {
    const re = new RegExp(`(?<![a-z])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "g");
    n += (lower.match(re) ?? []).length;
  }
  return n;
};

/** A sentence with no finite verb and few words reads as a fragment. */
const FINITE_VERB = /\b(is|are|was|were|be|been|being|am|do|does|did|has|have|had|can|could|will|would|shall|should|may|might|must|get|gets|got|make|makes|made|go|goes|went|say|says|said|see|sees|saw|think|thinks|know|knows|want|wants|need|needs|use|uses|used|work|works|come|comes|take|takes|give|gives|find|finds|keep|keeps|run|runs|build|builds|write|writes|means|meant|stops|stopped|starts|started)\b|\w+(s|ed)\b/i;

export function measure(raw: string, source = "inline"): VoiceVector {
  const prose = extractProse(raw);
  const paras = splitParagraphs(prose);
  const sentencesByPara = paras.map((p) => splitSentences(p));
  const sentences = sentencesByPara.flat();

  const sentLens = sentences.map((s) => words(s).length).filter((n) => n > 0);
  const paraLens = sentencesByPara.map((ss) => ss.length).filter((n) => n > 0);
  const wc = words(prose).length;

  const per100w = (n: number): number => (wc ? r2((n / wc) * 100) : 0);
  const per100s = (n: number): number => (sentences.length ? r2((n / sentences.length) * 100) : 0);

  const firstPerson = (prose.match(/\b(I|I'm|I've|I'd|I'll|me|my|mine|myself|we|we're|we've|our|us)\b/gi) ?? []).length;
  const secondPerson = (prose.match(/\b(you|you're|you've|you'd|you'll|your|yours|yourself)\b/gi) ?? []).length;
  const contractions = (prose.match(/\b\w+['’](s|t|re|ve|ll|d|m)\b/gi) ?? []).length;

  const initialConj = sentences.filter((s) => INITIAL_CONJUNCTIONS.test(s.trim())).length;
  const questions = sentences.filter((s) => s.trim().endsWith("?")).length;
  const fragments = sentences.filter((s) => {
    const n = words(s).length;
    return n > 0 && n <= 6 && !FINITE_VERB.test(s);
  }).length;

  const clauseCounts = sentences.map((s) => {
    const punct = (s.match(/[,;:]/g) ?? []).length;
    const subs = (s.match(SUBORDINATORS) ?? []).length;
    return 1 + Math.max(punct, subs);
  });

  const banned_hits: Record<string, number> = {};
  let banned_total = 0;
  for (const { name, re } of BANNED_PATTERNS) {
    const n = (prose.match(re) ?? []).length;
    banned_hits[name] = n;
    banned_total += n;
  }

  const m = mean(sentLens);
  const s = sd(sentLens);

  return {
    source,
    word_count: wc,
    sentence_count: sentences.length,
    paragraph_count: paras.length,

    sent_len_mean: r2(m),
    sent_len_sd: r2(s),
    sent_len_cv: r2(m ? s / m : 0),
    sent_len_p10: pct(sentLens, 10),
    sent_len_p90: pct(sentLens, 90),
    short_sentence_rate: per100s(sentLens.filter((n) => n < 6).length),
    long_sentence_rate: per100s(sentLens.filter((n) => n > 25).length),

    para_len_mean: r2(mean(paraLens)),
    para_len_sd: r2(sd(paraLens)),
    single_sentence_para_rate: paraLens.length ? r2((paraLens.filter((n) => n === 1).length / paraLens.length) * 100) : 0,

    first_person_density: per100w(firstPerson),
    second_person_density: per100w(secondPerson),
    hedge_density: per100w(countMatches(prose, HEDGES)),
    intensifier_density: per100w(countMatches(prose, INTENSIFIERS)),
    contraction_density: per100w(contractions),

    initial_conjunction_rate: per100s(initialConj),
    question_rate: per100s(questions),
    fragment_rate: per100s(fragments),

    clauses_per_sentence: r2(mean(clauseCounts)),

    banned_hits,
    banned_total,
    banned_per_1k: wc ? r2((banned_total / wc) * 1000) : 0,
  };
}

/** Metrics that carry a target band. Counts and identifiers are excluded. */
export const BANDED_METRICS: Array<keyof VoiceVector> = [
  "sent_len_mean", "sent_len_sd", "sent_len_cv", "sent_len_p90",
  "short_sentence_rate", "long_sentence_rate",
  "para_len_mean", "single_sentence_para_rate",
  "first_person_density", "second_person_density", "hedge_density",
  "intensifier_density", "contraction_density",
  "initial_conjunction_rate", "question_rate", "fragment_rate",
  "clauses_per_sentence",
];

// ---------------------------------------------------------------------- main

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pretty = argv.includes("--pretty");
  const textIdx = argv.indexOf("--text");
  const files = argv.filter((a, i) => !a.startsWith("--") && !(textIdx !== -1 && i === textIdx + 1));

  const vectors: VoiceVector[] = [];

  if (textIdx !== -1 && argv[textIdx + 1]) {
    vectors.push(measure(argv[textIdx + 1], "inline"));
  }
  for (const f of files) {
    vectors.push(measure(await Bun.file(f).text(), f));
  }

  if (!vectors.length) {
    console.error("usage: VoiceMetrics.ts <file...> | --text \"...\" [--pretty]");
    process.exit(2);
  }

  if (pretty) {
    for (const v of vectors) {
      console.log(`\n${v.source}  (${v.word_count}w · ${v.sentence_count}s · ${v.paragraph_count}p)`);
      for (const k of BANDED_METRICS) console.log(`  ${String(k).padEnd(28)} ${v[k]}`);
      if (v.banned_total) {
        const hits = Object.entries(v.banned_hits).filter(([, n]) => n > 0);
        console.log(`  banned                       ${v.banned_total} (${hits.map(([k, n]) => `${k}:${n}`).join(", ")})`);
      }
    }
  } else {
    console.log(JSON.stringify(vectors.length === 1 ? vectors[0] : vectors, null, 2));
  }
}
