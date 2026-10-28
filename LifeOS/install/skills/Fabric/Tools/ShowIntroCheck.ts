#!/usr/bin/env bun
// ShowIntroCheck — checks a ShowIntro output against the parts of its contract
// code can judge: the four blocks in order (opener, lead line, topic list,
// closer), the guest or solo form held consistently across opener, lead line
// and closer, the opener's length, 3 to 10 topics (or the pinned count), each a
// 2-to-7-word header with no duplicates, the closer naming the guest the opener
// named, and nothing a host could not read aloud (markup, links, template
// blanks). Whether the topics are the show's surprising parts, specific to it,
// spread across it and true to it stays judged in the fabric-showintro suite.

import { readFileSync } from "node:fs";

const HELP = `ShowIntroCheck — shape check for a Fabric ShowIntro output

  bun skills/Fabric/Tools/ShowIntroCheck.ts <file|-> [--topics N] [--json]

  --topics N  the exact topic count a hint asked for (1 to 10); default is any count from 3 to 10
  --json      print {ok, form, guests, topics, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export type Form = "guest" | "solo" | "unknown";
export type Result = { ok: boolean; form: Form; guests: string | null; topics: string[]; problems: string[] };

export const MAX_OPENER_WORDS = 60;
export const MIN_TOPIC_WORDS = 2;
export const MAX_TOPIC_WORDS = 7;
export const MIN_TOPICS = 3;
export const MAX_TOPICS = 10;

const GUEST_OPEN = /^In this conversation I speak with (.+?)\.(?:\s|$)/;
const SOLO_OPEN = /^In this episode I \S/;
const GUEST_CLOSE = /^And with that, here['’]s (?:my |the )?conversation with (.+)\.$/;
const SOLO_CLOSE = /^And with that, here['’]s the episode\.$/;
const LEAD: Record<Exclude<Form, "unknown">, string> = { guest: "We discuss:", solo: "I cover:" };

/** Whitespace-separated words; a `[TBD: ...]` marker counts as one word. */
export function words(text: string): string[] {
  return text.replace(/\[TBD:[^\]]*\]/g, "TBD").trim().split(/\s+/).filter(Boolean);
}

/** Text with `[TBD: ...]` markers removed, so markup checks never trip on them. */
function unmarked(text: string): string {
  return text.replace(/\[TBD:[^\]]*\]/g, "");
}

export function check(input: string, opts: { topics?: number } = {}): Result {
  const text = input.replace(/\r\n/g, "\n").trim();
  const problems: string[] = [];
  const topics: string[] = [];
  let form: Form = "unknown";
  let guests: string | null = null;

  if (text === "") return { ok: false, form, guests, topics, problems: ["empty output"] };

  // Read-aloud hygiene over the whole output.
  const bare = unmarked(text);
  if (/\*|(?:^|\s)__?\S[^\n]*?__?(?=$|\s|[.,;:!?])/m.test(bare)) problems.push("bold, italics or asterisks in the output; a host reads plain text");
  if (/^#{1,6}\s/m.test(bare)) problems.push("a heading in the output; the output is the intro only");
  if (/`/.test(bare)) problems.push("a backtick or code span in the output");
  if (/https?:\/\/|www\.\S/i.test(bare)) problems.push("a link in the output; a host cannot read a URL aloud");
  if (/\{[^}\n]*\}|_{3,}/.test(bare)) problems.push("a template blank ({...} or ___) left in the output; an unknown fact is a [TBD: ...] marker");
  if (/^\s*\d+[.)]\s/m.test(bare)) problems.push("a numbered list; topics are '- ' bullets");
  if (/^[ \t]+[-*•]\s/m.test(text)) problems.push("a sub-bullet; topics are one flat list");

  const blocks = text.split(/\n[ \t]*\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length !== 4) {
    problems.push(`expected 4 blocks separated by blank lines (opener, lead line, topics, closer); found ${blocks.length}`);
  }
  const [opener = "", lead = "", list = "", closer = ""] = blocks.length === 4 ? blocks : [blocks[0] ?? "", "", "", blocks[blocks.length - 1] ?? ""];

  // Opener.
  const openerLine = opener.replace(/\s*\n\s*/g, " ");
  const g = openerLine.match(GUEST_OPEN);
  if (g) { form = "guest"; guests = g[1].trim(); }
  else if (SOLO_OPEN.test(openerLine)) form = "solo";
  else problems.push('the opener begins "In this conversation I speak with {guest}." or, for a show with no guest, "In this episode I ..."');
  if (/^\s*[-*•]\s/.test(opener)) problems.push("the opener is prose, not a bullet");
  const ow = words(openerLine).length;
  if (ow > MAX_OPENER_WORDS) problems.push(`the opener is ${ow} words; at most ${MAX_OPENER_WORDS}`);

  if (blocks.length === 4) {
    // Lead line.
    const expectedLead = form === "unknown" ? null : LEAD[form];
    if (expectedLead ? lead !== expectedLead : !Object.values(LEAD).includes(lead)) {
      problems.push(`the lead line is exactly "${expectedLead ?? 'We discuss:" or "I cover:'}" on its own; found "${lead.slice(0, 40)}"`);
    }

    // Topics.
    const seen = new Set<string>();
    for (const [i, raw] of list.split("\n").entries()) {
      const line = raw.trimEnd();
      const m = line.match(/^- (\S.*)$/);
      if (!m) { problems.push(`topic line ${i + 1} is not a "- " bullet ("${line.trim().slice(0, 50)}")`); continue; }
      const t = m[1].trim();
      topics.push(t);
      const n = words(t).length;
      if (n < MIN_TOPIC_WORDS || n > MAX_TOPIC_WORDS) problems.push(`topic "${t}" is ${n} word${n === 1 ? "" : "s"}; each topic is ${MIN_TOPIC_WORDS} to ${MAX_TOPIC_WORDS}`);
      if (/[.!]$/.test(t)) problems.push(`topic "${t}" ends like a sentence; a topic is a header`);
      const key = t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ");
      if (seen.has(key)) problems.push(`topic "${t}" appears twice`);
      seen.add(key);
    }
    if (opts.topics !== undefined) {
      if (topics.length !== opts.topics) problems.push(`${topics.length} topics; the request pinned ${opts.topics}`);
    } else if (topics.length < MIN_TOPICS || topics.length > MAX_TOPICS) {
      problems.push(`${topics.length} topics; a show intro carries ${MIN_TOPICS} to ${MAX_TOPICS}`);
    }
  }

  // Closer.
  const closerLine = closer.replace(/\s*\n\s*/g, " ");
  if (form === "guest") {
    const c = closerLine.match(GUEST_CLOSE);
    if (!c) problems.push(`the closer is "And with that, here's my conversation with ${guests ?? "{guest}"}."`);
    else if (guests !== null && !openerLine.includes(c[1].trim())) problems.push(`the closer names "${c[1].trim()}", who the opener does not name`);
  } else if (form === "solo") {
    if (!SOLO_CLOSE.test(closerLine)) problems.push(`the closer is "And with that, here's the episode."`);
  } else if (!GUEST_CLOSE.test(closerLine) && !SOLO_CLOSE.test(closerLine)) {
    problems.push(`the closer begins "And with that, here's"`);
  }

  return { ok: problems.length === 0, form, guests, topics, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const flags = new Set(["--topics", "--json"]);
  const unknown = args.find((a) => a.startsWith("--") && !flags.has(a));
  if (unknown) { console.error(`unknown flag ${unknown}`); process.exit(2); }
  let pinned: number | undefined;
  const ti = args.indexOf("--topics");
  if (ti >= 0) {
    const v = args[ti + 1];
    if (v === undefined || !/^\d+$/.test(v) || +v < 1 || +v > MAX_TOPICS) { console.error(`--topics needs a whole number from 1 to ${MAX_TOPICS}`); process.exit(2); }
    pinned = +v;
  }
  const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--topics"));
  if (positional.length > 1) { console.error("one output file at most"); process.exit(2); }
  const src = positional[0];
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { topics: pinned });
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.form} intro, ${r.topics.length} topics, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
