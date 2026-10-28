#!/usr/bin/env bun
// AnalyzeRiskCheck — checks an AnalyzeRisk output against the parts of its
// contract code can judge: one `## Vendor risk:` block per vendor (or the
// single no-vendor line), the Risk and Data lines with their fixed values, the
// sections in order, the Findings and Compliance tables with their fixed areas
// and values, owned controls that name the finding they answer, change lines
// that move the rating, and a rating consistent with the data, findings and
// compliance status. Whether evidence is tied to the input and no vendor fact
// is invented stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AnalyzeRiskCheck — shape check for a Fabric AnalyzeRisk output

  bun skills/Fabric/Tools/AnalyzeRiskCheck.ts <file|-> [--json]

  --json  print {ok, noVendor, assessments, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const RATINGS = ["Low", "Medium", "High"] as const;
export const DATA_CLASSES = ["Public", "Internal", "Confidential", "Restricted"] as const;
export const AREAS = ["Data", "Security", "Privacy", "Terms", "Breach notice"] as const;
export const EFFECTS = ["Raises", "Lowers", "Neutral"] as const;
export const STATUSES = ["Met", "Gap", "Unknown"] as const;
export const OWNERS = ["Implementer", "User", "Procurement"] as const;
export const SECTIONS = ["Assumptions", "Findings", "Compliance", "Required controls", "What would change the rating"];

export type Assessment = {
  title: string;
  line: number;
  rating?: string;
  dataClass?: string;
  effects: string[];
  statuses: string[];
};

const PLACEHOLDER = /\{[^}]*\}|^…$/;
const has = (list: readonly string[], v: string) => list.includes(v);

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function tableRows(body: string[]): string[][] {
  return body.filter((l) => l.trim().startsWith("|")).map(cells);
}

function isSeparator(r: string[]): boolean {
  return r.every((c) => /^:?-{3,}:?$/.test(c));
}

function checkAssessment(lines: string[], start: number, title: string, problems: string[]): Assessment {
  const a: Assessment = { title, line: start + 1, effects: [], statuses: [] };
  const p = (msg: string) => problems.push(`assessment "${title}": ${msg}`);
  if (!title || PLACEHOLDER.test(title)) p("the `## Vendor risk:` heading names no vendor");
  else if (!/\sfor\s/.test(title)) p("the heading does not name the intended use (`{vendor} for {use}`)");

  const sections: { name: string; line: number; body: string[] }[] = [];
  const preamble: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(.+?)\s*$/);
    if (h) sections.push({ name: h[1], line: i + 1, body: [] });
    else if (/^#{1,2}\s/.test(lines[i])) p(`line ${i + 1}: unexpected heading "${lines[i].trim()}" inside the assessment`);
    else if (sections.length) sections[sections.length - 1].body.push(lines[i]);
    else preamble.push(lines[i]);
  }

  // Lead lines: Risk first, then Data, then optional Source and Answer.
  const pre = preamble.map((l) => l.trim()).filter(Boolean);
  if (!pre[0]?.startsWith("**Risk:**")) p("the `**Risk:**` line is not the first line of the assessment");
  if (pre[1] && !pre[1].startsWith("**Data:**")) p("the `**Data:**` line does not follow the Risk line");
  const risk = pre.find((l) => l.startsWith("**Risk:**"));
  const rm = risk?.match(/^\*\*Risk:\*\*\s+(\w+):\s+(\S.*)$/);
  if (!risk) p("no `**Risk:**` line");
  else if (!rm) p(`risk line "${risk}" is not \`**Risk:** {Low|Medium|High}: {reason}\``);
  else if (!has(RATINGS, rm[1])) p(`rating "${rm[1]}" is not one of ${RATINGS.join(", ")}`);
  else if (rm[2].length < 15 || PLACEHOLDER.test(rm[2])) p("the risk reason is empty or a placeholder");
  else a.rating = rm[1];
  const data = pre.find((l) => l.startsWith("**Data:**"));
  const dm = data?.match(/^\*\*Data:\*\*\s+(\w+):\s+(\S.*)$/);
  if (!data) p("no `**Data:**` line");
  else if (!dm) p(`data line "${data}" is not \`**Data:** {class}: {what data}\``);
  else if (!has(DATA_CLASSES, dm[1])) p(`data class "${dm[1]}" is not one of ${DATA_CLASSES.join(", ")}`);
  else if (PLACEHOLDER.test(dm[2])) p("the data description is a placeholder");
  else a.dataClass = dm[1];
  for (const l of pre) if (!/^\*\*(Risk|Data|Source|Answer):\*\*\s+\S/.test(l)) p(`unexpected line before the sections: "${l}"`);

  const names = sections.map((s) => s.name);
  if (names.join("|") !== SECTIONS.join("|")) p(`sections are [${names.join(", ")}], expected [${SECTIONS.join(", ")}]`);
  const get = (name: string) => sections.find((s) => s.name === name);
  const nonEmpty = (s: { body: string[] }) => s.body.map((l) => l.trim()).filter(Boolean);

  const as = get("Assumptions");
  if (as) {
    const body = nonEmpty(as);
    if (body.length === 0) p("Assumptions is empty");
    for (const l of body) {
      if (!/^[-*]\s+\*\*(Stated|Assumed):\*\*\s+\S/.test(l)) p(`assumption "${l}" does not open on **Stated:** or **Assumed:**`);
      else if (PLACEHOLDER.test(l)) p(`placeholder assumption: "${l}"`);
    }
  }

  const fs = get("Findings");
  if (fs) {
    const rows = tableRows(fs.body);
    if (rows.length < 2) p("Findings has no table");
    else {
      const [head, sep, ...rest] = rows;
      if (head.join("|") !== "Area|Finding|Evidence|Effect") p(`findings header is "| ${head.join(" | ")} |", expected | Area | Finding | Evidence | Effect |`);
      if (!isSeparator(sep)) p("findings table has no separator row under its header");
      for (const r of rest) {
        if (r.length !== 4) { p(`findings row "${r[0]}" has ${r.length} cells, expected 4`); continue; }
        if (!has(AREAS, r[0])) p(`findings area "${r[0]}" is not one of ${AREAS.join(", ")}`);
        if (!has(EFFECTS, r[3])) p(`findings row "${r[0]}": effect "${r[3]}" is not one of ${EFFECTS.join(", ")}`);
        else a.effects.push(r[3]);
        if (r[1].length < 8 || PLACEHOLDER.test(r[1])) p(`findings row "${r[0]}": the finding is empty or a placeholder`);
        if (r[2].length < 8 && r[2] !== "Not stated") p(`findings row "${r[0]}": evidence is empty (use a quote, the public fact, or Not stated)`);
        else if (PLACEHOLDER.test(r[2])) p(`findings row "${r[0]}": evidence is a placeholder`);
      }
      const areas = new Set(rest.map((r) => r[0]));
      const missing = AREAS.filter((x) => !areas.has(x));
      if (missing.length) p(`findings has no row for ${missing.join(", ")}`);
    }
  }

  const cs = get("Compliance");
  if (cs) {
    const body = nonEmpty(cs);
    const none = body.length === 1 && /^\*\*None apply:\*\*\s+\S.{8,}/.test(body[0]);
    if (!none) {
      const rows = tableRows(cs.body);
      if (rows.length < 3) p("Compliance has neither a table with a row nor a `**None apply:** {why}` line");
      else {
        const [head, sep, ...rest] = rows;
        if (head.join("|") !== "Obligation|Why it applies|Status|Evidence") p(`compliance header is "| ${head.join(" | ")} |", expected | Obligation | Why it applies | Status | Evidence |`);
        if (!isSeparator(sep)) p("compliance table has no separator row under its header");
        for (const r of rest) {
          if (r.length !== 4) { p(`compliance row "${r[0]}" has ${r.length} cells, expected 4`); continue; }
          if (!has(STATUSES, r[2])) p(`compliance row "${r[0]}": status "${r[2]}" is not one of ${STATUSES.join(", ")}`);
          else a.statuses.push(r[2]);
          if ([r[0], r[1], r[3]].some((c) => c.length < 3 || PLACEHOLDER.test(c))) p(`compliance row "${r[0]}": a cell is empty or a placeholder`);
        }
      }
      const notes = body.filter((l) => !l.startsWith("|"));
      const ruledOut = notes.filter((l) => /^\*\*Ruled out:\*\*\s+\S.{8,}/.test(l));
      if (ruledOut.length > 1) p("Compliance has more than one `**Ruled out:**` line");
      for (const l of notes) if (!ruledOut.includes(l)) p(`unexpected line in Compliance: "${l}" (only the table and one **Ruled out:** line)`);
      const lastRow = body.map((l, i) => (l.startsWith("|") ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
      for (const l of ruledOut) if (body.indexOf(l) < lastRow) p("the `**Ruled out:**` line comes before the end of the compliance table");
    }
  }

  const rc = get("Required controls");
  if (rc) {
    const body = nonEmpty(rc);
    if (body.length === 0) p("Required controls is empty");
    body.forEach((l, i) => {
      const m = l.match(/^(\d+)\.\s+\*\*(\w+)(?:\s+\([^)]+\))?:\*\*\s+(\S.*?)\s+Answers:\s+(\S.*)$/);
      if (!m) { p(`control "${l}" is not \`N. **{Owner}:** {control}. Answers: {finding}\``); return; }
      if (Number(m[1]) !== i + 1) p(`control numbered ${m[1]}, expected ${i + 1}`);
      if (!has(OWNERS, m[2])) p(`control owner "${m[2]}" is not one of ${OWNERS.join(", ")}`);
      if (PLACEHOLDER.test(m[3]) || PLACEHOLDER.test(m[4]) || m[3].length < 8) p(`control ${m[1]} is empty or a placeholder`);
    });
  }

  const wc = get("What would change the rating");
  if (wc) {
    const body = nonEmpty(wc);
    if (body.length === 0) p("What would change the rating is empty");
    if (body.length > 3) p(`What would change the rating has ${body.length} lines; it names one to three facts`);
    for (const l of body) {
      const m = l.match(/^[-*]\s+(\S.*?)\s+→\s+(\w+)\.?$/);
      if (!m) { p(`change line "${l}" is not \`- {fact} → {Low|Medium|High}\``); continue; }
      if (!has(RATINGS, m[2])) p(`change line target "${m[2]}" is not one of ${RATINGS.join(", ")}`);
      else if (a.rating && m[2] === a.rating) p(`change line "${m[1]}" moves the rating to ${m[2]}, which is the current rating`);
      if (PLACEHOLDER.test(m[1]) || m[1].length < 8) p("a change line names no fact");
    }
  }

  // Rating consistency with the data class, findings and compliance status.
  if (a.rating && a.dataClass) {
    const gap = a.statuses.includes("Gap");
    const raises = a.effects.includes("Raises");
    const sensitive = a.dataClass === "Confidential" || a.dataClass === "Restricted";
    if (a.rating === "Low" && a.dataClass === "Restricted" && gap) p("rating Low for Restricted data with an open compliance Gap");
    if (a.rating === "Low" && sensitive && raises && gap) p(`rating Low for ${a.dataClass} data with a finding that raises the risk and a compliance Gap`);
    if (a.rating === "High" && !raises && !gap) p("rating High with no finding that raises the risk and no compliance Gap");
    if (a.rating === "High" && a.dataClass === "Public" && !gap && a.effects.filter((e) => e === "Raises").length < 2) p("rating High for Public data on fewer than two findings that raise the risk and no Gap");
  }

  return a;
}

export function check(input: string): { ok: boolean; noVendor: boolean; assessments: Assessment[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const nonEmpty = lines.map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l);
  const noVendor = nonEmpty.filter((x) => x.l.startsWith("**No vendor:**"));

  if (noVendor.length) {
    if (nonEmpty.length !== 1) problems.push("the `**No vendor:**` line must be the whole output");
    if (noVendor[0].l.replace("**No vendor:**", "").trim().length < 5) problems.push("the no-vendor line does not say what the input is instead");
    return { ok: problems.length === 0, noVendor: true, assessments: [], problems };
  }

  const starts = lines.map((l, i) => (/^##\s+Vendor risk:/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0) {
    problems.push("no `## Vendor risk:` block and no `**No vendor:**` line");
    return { ok: false, noVendor: false, assessments: [], problems };
  }
  for (const x of nonEmpty) if (x.i < starts[0]) problems.push(`line ${x.i + 1}: text before the first assessment ("${x.l}")`);

  const assessments = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const title = lines[s].replace(/^##\s+Vendor risk:\s*/, "").trim();
    return checkAssessment(lines.slice(0, end), s, title, problems);
  });

  return { ok: problems.length === 0, noVendor: false, assessments, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json");
  if (unknown.length) {
    console.error(`unknown flag ${unknown[0]}`);
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
  if (json) console.log(JSON.stringify({ ok: r.ok, noVendor: r.noVendor, assessments: r.assessments.map((x) => ({ title: x.title, rating: x.rating ?? null, data: x.dataClass ?? null })), problems: r.problems }));
  else if (r.ok) console.log(r.noVendor ? "✓ no vendor, single line" : `✓ ${r.assessments.length} assessment${r.assessments.length === 1 ? "" : "s"}, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
