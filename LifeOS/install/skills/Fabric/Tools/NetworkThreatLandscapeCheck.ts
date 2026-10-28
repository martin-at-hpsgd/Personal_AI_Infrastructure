#!/usr/bin/env bun
// NetworkThreatLandscapeCheck — checks a NetworkThreatLandscape output against
// the parts of its contract code can judge: the title, the six sections in
// order, the Risk line format and its severity order, the item counts, the
// summary length, the Evidence quote format (and, with --source, that every
// quote is in the input), and the bans on bold, italics, numbered lists, code
// fences and text outside the sections. Whether the findings are true to the
// scan and specific to it stays a judged check in the suite.

import { readFileSync } from "node:fs";

const HELP = `NetworkThreatLandscapeCheck — shape check for a Fabric NetworkThreatLandscape output

  bun skills/Fabric/Tools/NetworkThreatLandscapeCheck.ts <file|-> [--source <input-file>] [--json]

  --source F  the scan or statistics the report was built from; every Evidence quote must appear in it
  --json      print {ok, kind, counts, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTIONS = ["Description", "Risk", "Recommendations", "One-Sentence Summary", "Trends", "Evidence"] as const;
export type Section = (typeof SECTIONS)[number];

export const LIMITS = {
  descriptionMaxWords: 120,
  summaryMaxWords: 24,
  recommendations: [3, 15],
  trends: [3, 20],
  evidence: [3, 20],
} as const;

export const SEVERITIES = ["Critical", "High", "Medium", "Low"] as const;
export const NO_DATA = /^No port or service data: \S/;
export const NO_SCAN_EVIDENCE = "- No scan data was supplied.";
const TITLE = /^# Network Threat Landscape: \S/;
const RISK = /^- (Critical|High|Medium|Low): \d{1,5}(?:[,-]\d{1,5})*\/(?:tcp|udp|sctp)\b.*?: \S/;
const EVIDENCE = /^- `([^`]+)`: \S/;

export type Result = {
  ok: boolean;
  kind: "report" | "no-data" | "unknown";
  counts: Partial<Record<Section, number>>;
  problems: string[];
};

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Bold or italic markup outside inline code. */
export function emphasis(line: string): boolean {
  const bare = line.replace(/`[^`]*`/g, "");
  if (/\*\*|__/.test(bare)) return true;
  if (/(^|[\s(])\*[^\s*][^*]*\*(?=$|[\s.,;:)!?])/.test(bare.replace(/^\s*[-*]\s/, ""))) return true;
  if (/(^|[\s(])_[^\s_][^_]*_(?=$|[\s.,;:)!?])/.test(bare)) return true;
  return false;
}

export function check(input: string, opts: { source?: string } = {}): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const counts: Partial<Record<Section, number>> = {};
  const content = lines.map((l, i) => ({ text: l, ln: i + 1 })).filter((l) => l.text.trim() !== "");

  if (content.length === 0) return { ok: false, kind: "unknown", counts, problems: ["the output is empty"] };

  if (NO_DATA.test(content[0].text.trim())) {
    if (content.length > 1) problems.push(`a no-data output is the one "No port or service data:" line; found ${content.length} lines`);
    return { ok: problems.length === 0, kind: "no-data", counts, problems };
  }

  for (const { text, ln } of content) {
    if (/^\s*```/.test(text)) problems.push(`line ${ln}: code fence; the report is plain Markdown, never fenced`);
    if (/^\s*\d+[.)]\s/.test(text)) problems.push(`line ${ln}: numbered list; use bullets`);
    if (emphasis(text)) problems.push(`line ${ln}: bold or italic text ("${text.trim().slice(0, 60)}")`);
  }

  if (!TITLE.test(content[0].text.trim())) problems.push(`line ${content[0].ln}: the report opens on "# Network Threat Landscape: {scope}"`);

  const body: Record<string, { text: string; ln: number }[]> = {};
  const order: string[] = [];
  let current: string | null = null;
  for (const l of content.slice(1)) {
    const h = l.text.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) {
      const level = l.text.match(/^#+/)![0].length;
      const name = h[1];
      if (level !== 2 || !(SECTIONS as readonly string[]).includes(name)) {
        problems.push(`line ${l.ln}: unexpected heading "${l.text.trim()}"; the sections are ${SECTIONS.map((s) => `## ${s}`).join(", ")}`);
        current = null;
        continue;
      }
      if (order.includes(name)) problems.push(`line ${l.ln}: a second "## ${name}" section`);
      order.push(name);
      current = name;
      body[name] ??= [];
      continue;
    }
    if (current === null) problems.push(`line ${l.ln}: text outside the sections ("${l.text.trim().slice(0, 60)}")`);
    else body[current].push(l);
  }

  const missing = SECTIONS.filter((s) => !order.includes(s));
  if (missing.length) problems.push(`missing sections: ${missing.join(", ")}`);
  const present = SECTIONS.filter((s) => order.includes(s));
  const seen = order.filter((s, i) => order.indexOf(s) === i);
  if (seen.join("|") !== present.join("|")) problems.push(`sections out of order: found ${seen.join(", ")}; expected ${SECTIONS.join(", ")}`);

  const bulletsOf = (s: Section, prose: boolean) => {
    const ls = body[s] ?? [];
    const bullets = ls.filter((l) => /^- \S/.test(l.text));
    for (const l of ls) if (!/^- \S/.test(l.text) && !prose) problems.push(`line ${l.ln}: ${s} holds bullets only ("${l.text.trim().slice(0, 60)}")`);
    return bullets;
  };

  // Description: prose, at most 120 words.
  if (body.Description) {
    const ls = body.Description;
    if (ls.length === 0) problems.push("Description is empty");
    for (const l of ls) if (/^\s*[-*]\s/.test(l.text)) problems.push(`line ${l.ln}: Description is prose, not bullets`);
    const n = words(ls.map((l) => l.text).join(" ")).length;
    counts.Description = n;
    if (n > LIMITS.descriptionMaxWords) problems.push(`Description has ${n} words; at most ${LIMITS.descriptionMaxWords}`);
  }

  // Risk: severity, port/proto, service, colon, text; most severe first.
  if (body.Risk) {
    const risks = bulletsOf("Risk", false);
    counts.Risk = risks.length;
    if (risks.length === 0) problems.push("Risk has no entries");
    let last = -1;
    for (const r of risks) {
      const m = r.text.match(RISK);
      if (!m) {
        problems.push(`line ${r.ln}: a Risk entry reads "- {Critical|High|Medium|Low}: {port}/{tcp|udp} {service}: {risk}" ("${r.text.trim().slice(0, 60)}")`);
        continue;
      }
      const rank = SEVERITIES.indexOf(m[1] as (typeof SEVERITIES)[number]);
      if (rank < last) problems.push(`line ${r.ln}: ${m[1]} after ${SEVERITIES[last]}; Risk runs from most to least severe`);
      last = Math.max(last, rank);
    }
  }

  const ranged = (s: Section, [lo, hi]: readonly [number, number]) => {
    const bs = bulletsOf(s, false);
    counts[s] = bs.length;
    if (bs.length < lo || bs.length > hi) problems.push(`${s} has ${bs.length} items; ${lo} to ${hi}`);
    const openings = new Map<string, number>();
    for (const b of bs) {
      const w = words(b.text.slice(2)).slice(0, 2).map((x) => x.toLowerCase()).join(" ");
      if (openings.has(w)) problems.push(`line ${b.ln}: ${s} items open on the same words as line ${openings.get(w)} ("${w}")`);
      else openings.set(w, b.ln);
    }
  };
  if (body.Recommendations) ranged("Recommendations", LIMITS.recommendations);
  if (body.Trends) ranged("Trends", LIMITS.trends);

  // Summary: one line, one sentence, under 25 words.
  if (body["One-Sentence Summary"]) {
    const ls = body["One-Sentence Summary"];
    if (ls.length !== 1) problems.push(`One-Sentence Summary is one line; found ${ls.length}`);
    const text = ls.map((l) => l.text).join(" ").trim();
    if (/^[-*]\s/.test(text)) problems.push("One-Sentence Summary is a sentence, not a bullet");
    const n = words(text).length;
    counts["One-Sentence Summary"] = n;
    if (n === 0 || n > LIMITS.summaryMaxWords) problems.push(`One-Sentence Summary has ${n} words; 1 to ${LIMITS.summaryMaxWords}`);
    if (/[.!?]\s+\S/.test(text.replace(/\d\.\d/g, "0"))) problems.push("One-Sentence Summary holds more than one sentence");
  }

  // Evidence: exact quotes, or the one no-scan line.
  if (body.Evidence) {
    const ls = body.Evidence;
    if (ls.length === 1 && ls[0].text.trim() === NO_SCAN_EVIDENCE) {
      counts.Evidence = 0;
    } else {
      const bs = bulletsOf("Evidence", false);
      counts.Evidence = bs.length;
      const [lo, hi] = LIMITS.evidence;
      if (bs.length < lo || bs.length > hi) problems.push(`Evidence has ${bs.length} items; ${lo} to ${hi}, or the single line "${NO_SCAN_EVIDENCE}"`);
      const quotes = new Map<string, number>();
      for (const b of bs) {
        const m = b.text.match(EVIDENCE);
        if (!m) {
          problems.push(`line ${b.ln}: an Evidence item reads "- \`{exact text from the input}\`: {finding}" ("${b.text.trim().slice(0, 60)}")`);
          continue;
        }
        const q = norm(m[1]);
        if (quotes.has(q)) problems.push(`line ${b.ln}: Evidence quote repeats line ${quotes.get(q)}`);
        quotes.set(q, b.ln);
        if (opts.source !== undefined && !norm(opts.source).includes(q)) problems.push(`line ${b.ln}: Evidence quote is not in the source ("${q.slice(0, 60)}")`);
      }
    }
  }

  // No item repeated anywhere.
  const all = new Map<string, number>();
  for (const s of ["Risk", "Recommendations", "Trends"] as const)
    for (const l of body[s] ?? []) {
      const k = norm(l.text).toLowerCase();
      if (all.has(k)) problems.push(`line ${l.ln}: repeats line ${all.get(k)}`);
      else all.set(k, l.ln);
    }

  return { ok: problems.length === 0, kind: "report", counts, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--source");
  if (si >= 0 && (args[si + 1] === undefined || args[si + 1].startsWith("--"))) {
    console.error("--source needs a file path");
    process.exit(2);
  }
  const unknown = args.filter((a, i) => a.startsWith("--") && a !== "--json" && a !== "--source" && a !== "--help" && i !== si + 1);
  if (unknown.length) {
    console.error(`unknown flag: ${unknown.join(", ")}`);
    process.exit(2);
  }
  const src = args.find((a, i) => (!a.startsWith("--") || a === "-") && !(si >= 0 && i === si + 1));
  let input: string;
  let source: string | undefined;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
    if (si >= 0) source = readFileSync(args[si + 1], "utf8");
  } catch (e) {
    console.error(`cannot read input: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, { source });
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.kind === "no-data" ? "✓ no-data line, shape holds" : `✓ ${SECTIONS.length} sections, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
