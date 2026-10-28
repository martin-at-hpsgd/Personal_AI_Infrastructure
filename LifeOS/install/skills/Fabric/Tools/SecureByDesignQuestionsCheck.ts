#!/usr/bin/env bun
// SecureByDesignQuestionsCheck — checks a SecureByDesignQuestions output against
// the parts of its contract code can judge: an OVERVIEW section of 15 to 35 words,
// then a SECURE BY DESIGN QUESTIONS section of capitalized theme headings, each
// holding bulleted single questions of 10 to 30 words, 15 to 50 questions in all,
// at least three themes, no duplicates, and nothing else. Whether the questions
// are specific to the input stays a judged check in the suite.

import { readFileSync } from "node:fs";

const HELP = `SecureByDesignQuestionsCheck — shape check for a Fabric SecureByDesignQuestions output

  bun skills/Fabric/Tools/SecureByDesignQuestionsCheck.ts <file|-> [--json]

  --json  print {ok, overviewWords, themes, questions, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const LIMITS = {
  overviewMin: 15,
  overviewMax: 35,
  questionMin: 10,
  questionMax: 30,
  totalMin: 15,
  totalMax: 50,
  themesMin: 3,
} as const;

export type Theme = { name: string; line: number; questions: { text: string; words: number; line: number }[] };
export type Result = { ok: boolean; overviewWords: number; themes: Theme[]; questions: number; problems: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

const OVERVIEW = /^##\s+OVERVIEW\s*$/;
const QUESTIONS = /^##\s+SECURE BY DESIGN QUESTIONS\s*$/;
const THEME = /^###\s+(.+?)\s*$/;
const BULLET = /^- (.*\S)\s*$/;

export function check(input: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const themes: Theme[] = [];
  const overview: string[] = [];
  let state: "start" | "overview" | "questions" = "start";
  let sawOverview = false;
  let sawQuestions = false;

  lines.forEach((raw, i) => {
    const ln = i + 1;
    const t = raw.trim();
    if (t === "") return;
    if (OVERVIEW.test(t)) {
      if (sawOverview) problems.push(`line ${ln}: a second OVERVIEW heading`);
      if (sawQuestions) problems.push(`line ${ln}: OVERVIEW must come before SECURE BY DESIGN QUESTIONS`);
      sawOverview = true;
      state = "overview";
      return;
    }
    if (QUESTIONS.test(t)) {
      if (sawQuestions) problems.push(`line ${ln}: a second SECURE BY DESIGN QUESTIONS heading`);
      if (!sawOverview) problems.push(`line ${ln}: SECURE BY DESIGN QUESTIONS before any OVERVIEW section`);
      sawQuestions = true;
      state = "questions";
      return;
    }
    if (/^#{1,2}\s/.test(t)) {
      problems.push(`line ${ln}: unexpected heading ("${t}"); the only sections are ## OVERVIEW and ## SECURE BY DESIGN QUESTIONS`);
      return;
    }
    if (state === "start") {
      problems.push(`line ${ln}: text before the OVERVIEW section ("${t.slice(0, 60)}")`);
      return;
    }
    if (state === "overview") {
      if (/^(#|[-*+]\s|\d+[.)]\s)/.test(t)) problems.push(`line ${ln}: the overview is one plain paragraph, not a heading or list`);
      overview.push(t);
      return;
    }
    // questions section
    const th = t.match(THEME);
    if (th) {
      const name = th[1].replace(/:$/, "");
      if (th[1].endsWith(":")) problems.push(`line ${ln}: theme heading "${th[1]}" carries a trailing colon`);
      if (/\p{Ll}/u.test(name)) problems.push(`line ${ln}: theme heading "${name}" is not in capitals`);
      if (themes.some((x) => x.name === name)) problems.push(`line ${ln}: theme "${name}" appears twice`);
      themes.push({ name, line: ln, questions: [] });
      return;
    }
    if (/^\s+[-*+]\s/.test(raw)) {
      problems.push(`line ${ln}: sub-bullet; each question is its own top-level bullet`);
      return;
    }
    if (/^\d+[.)]\s/.test(t)) {
      problems.push(`line ${ln}: numbered list; questions are "- " bullets`);
      return;
    }
    const b = raw.match(BULLET);
    if (!b) {
      problems.push(`line ${ln}: commentary in the questions section ("${t.slice(0, 60)}")`);
      return;
    }
    if (themes.length === 0) {
      problems.push(`line ${ln}: question before any ### THEME heading`);
      return;
    }
    const text = b[1];
    const n = words(text).length;
    const theme = themes[themes.length - 1];
    theme.questions.push({ text, words: n, line: ln });
    if (!text.endsWith("?")) problems.push(`line ${ln}: bullet does not end in a question mark ("${text.slice(0, 60)}")`);
    if ((text.match(/\?/g) ?? []).length > 1) problems.push(`line ${ln}: more than one question in one bullet`);
    if (n < LIMITS.questionMin || n > LIMITS.questionMax)
      problems.push(`line ${ln}: question has ${n} words; each holds ${LIMITS.questionMin} to ${LIMITS.questionMax}`);
  });

  if (!sawOverview) problems.push("no ## OVERVIEW section");
  if (!sawQuestions) problems.push("no ## SECURE BY DESIGN QUESTIONS section");

  const overviewWords = words(overview.join(" ")).length;
  if (sawOverview) {
    if (overview.length === 0) problems.push("the OVERVIEW section is empty");
    else if (overviewWords < LIMITS.overviewMin || overviewWords > LIMITS.overviewMax)
      problems.push(`overview has ${overviewWords} words; it holds ${LIMITS.overviewMin} to ${LIMITS.overviewMax}`);
  }

  for (const th of themes) if (th.questions.length === 0) problems.push(`line ${th.line}: theme "${th.name}" has no questions`);
  if (sawQuestions && themes.length < LIMITS.themesMin)
    problems.push(`found ${themes.length} themes; questions are grouped into at least ${LIMITS.themesMin}`);

  const all = themes.flatMap((t) => t.questions);
  if (sawQuestions && (all.length < LIMITS.totalMin || all.length > LIMITS.totalMax))
    problems.push(`found ${all.length} questions; the list holds ${LIMITS.totalMin} to ${LIMITS.totalMax}`);

  const seen = new Map<string, number>();
  for (const q of all) {
    const key = words(q.text).join(" ").toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) problems.push(`line ${q.line}: repeats the question on line ${prior}`);
    else seen.set(key, q.line);
  }

  return { ok: problems.length === 0, overviewWords, themes, questions: all.length, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const unknown = args.find((a) => a.startsWith("--") && a !== "--json");
  if (unknown) {
    console.error(`unknown flag ${unknown}\n\n${HELP}`);
    process.exit(2);
  }
  const src = args.find((a) => !a.startsWith("--"));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (json)
    console.log(
      JSON.stringify({
        ok: r.ok,
        overviewWords: r.overviewWords,
        themes: r.themes.map((t) => ({ name: t.name, questions: t.questions.length })),
        questions: r.questions,
        problems: r.problems,
      }),
    );
  else if (r.ok) console.log(`✓ ${r.questions} questions in ${r.themes.length} themes, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
