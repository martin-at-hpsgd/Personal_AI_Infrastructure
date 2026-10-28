#!/usr/bin/env bun
// EmailHeadersCheck — checks an EmailHeaders analysis against the parts of its
// contract code can judge: the title address, the SUMMARY table (SPF, DKIM,
// DMARC, ARC in order, each a recorded result word), the Header From /
// Envelope From / Domains Align / Verdict lines, DMARC consistency, the six
// DETAILS subsections in order, and the dig block (DOMAIN set to the From
// domain, every default selector queried). Whether a verdict came from the
// trusted header and the concerns are specific stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `EmailHeadersCheck — shape check for a Fabric EmailHeaders analysis

  bun skills/Fabric/Tools/EmailHeadersCheck.ts <file|-> [--json]

  --json  print {ok, summary, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const PROTOCOLS = ["SPF", "DKIM", "DMARC", "ARC"] as const;
export const RESULTS = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "not present"];
export const VERDICTS = ["Authentic", "Suspicious", "Spoofed", "Inconclusive"];
export const DETAIL_HEADINGS = [
  "SPF (Sender Policy Framework)",
  "DKIM (DomainKeys Identified Mail)",
  "DMARC (Domain-based Message Authentication, Reporting, and Conformance)",
  "ARC (Authenticated Received Chain)",
  "Security Concerns and Recommendations",
  "Dig Commands",
];
export const DKIM_SELECTORS = ["selector1", "selector2", "google", "s1", "s2", "k1", "k2"];

const ADDRESS = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;

export type Summary = {
  title?: string;
  results: Partial<Record<(typeof PROTOCOLS)[number], string>>;
  headerFrom?: string;
  envelopeFrom?: string;
  align?: string;
  verdict?: string;
};

function stripParenthetical(v: string): string {
  return v.replace(/\s*\(.*\)\s*$/, "").trim();
}

function addressProblem(label: string, raw: string): string | null {
  const v = stripParenthetical(raw);
  if (/[<>"]/.test(v) || /\s/.test(v)) return `${label} "${raw}" is not a bare address (display name or angle brackets)`;
  if (/^address$/i.test(v)) return `${label} holds the word "address" instead of an address`;
  if (!ADDRESS.test(v)) return `${label} "${raw}" is not an email address`;
  return null;
}

function normalizeShell(s: string): string {
  return s.replace(/["'{}]/g, "").replace(/\s+/g, " ").trim();
}

export function check(input: string): { ok: boolean; summary: Summary; problems: string[] } {
  const text = input.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const problems: string[] = [];
  const summary: Summary = { results: {} };

  // Title
  const first = lines.find((l) => l.trim() !== "")?.trim() ?? "";
  const tm = first.match(/^#\s+Email Header Analysis\s+-\s+(.+)$/);
  if (!tm) problems.push('first line is not "# Email Header Analysis - <Header From address>"');
  else {
    summary.title = tm[1].trim();
    const p = addressProblem("title", summary.title);
    if (p) problems.push(p);
  }

  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const sumAt = idx(/^##\s+SUMMARY\s*$/);
  const detAt = idx(/^##\s+DETAILS\s*$/);
  if (sumAt < 0) problems.push('no "## SUMMARY" section');
  if (detAt < 0) problems.push('no "## DETAILS" section');
  if (sumAt >= 0 && detAt >= 0 && detAt < sumAt) problems.push("DETAILS comes before SUMMARY; the summary opens the analysis");

  const sumLines = sumAt >= 0 ? lines.slice(sumAt + 1, detAt > sumAt ? detAt : lines.length) : [];

  // Summary table
  const rows = sumLines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
  const head = rows[0];
  if (!head || head[0]?.toLowerCase() !== "header" || head[1]?.toLowerCase() !== "disposition")
    problems.push('summary table header is not "| Header | Disposition |"');
  const body = rows.filter((r) => !/^:?-+:?$/.test(r[0] ?? "") && r[0]?.toLowerCase() !== "header");
  const names = body.map((r) => r[0].toUpperCase());
  if (names.join(",") !== PROTOCOLS.join(","))
    problems.push(`summary table rows are [${names.join(", ")}], expected exactly [${PROTOCOLS.join(", ")}] in that order`);
  for (const r of body) {
    const proto = r[0].toUpperCase() as (typeof PROTOCOLS)[number];
    if (!PROTOCOLS.includes(proto)) continue;
    const val = (r[1] ?? "").trim();
    summary.results[proto] = val;
    if (!RESULTS.includes(val.toLowerCase()))
      problems.push(`${proto} disposition "${val}" is not one result word (${RESULTS.join(", ")})`);
  }

  // Address and verdict lines
  const field = (label: string) => {
    const l = sumLines.find((x) => x.trim().toLowerCase().startsWith(label.toLowerCase() + ":"));
    return l === undefined ? undefined : l.trim().slice(label.length + 1).trim();
  };
  const hf = field("Header From");
  const ef = field("Envelope From");
  const da = field("Domains Align");
  const vd = field("Verdict");
  if (hf === undefined) problems.push('no "Header From:" line in the summary');
  else {
    summary.headerFrom = stripParenthetical(hf);
    const p = addressProblem("Header From", hf);
    if (p) problems.push(p);
    else if (summary.title && summary.headerFrom.toLowerCase() !== stripParenthetical(summary.title).toLowerCase())
      problems.push(`title address "${summary.title}" differs from Header From "${summary.headerFrom}"`);
  }
  if (ef === undefined) problems.push('no "Envelope From:" line in the summary');
  else {
    summary.envelopeFrom = stripParenthetical(ef);
    if (summary.envelopeFrom !== "<>" && !/^not present$/i.test(summary.envelopeFrom)) {
      const p = addressProblem("Envelope From", ef);
      if (p) problems.push(p);
    }
  }
  if (da === undefined) problems.push('no "Domains Align:" line in the summary');
  else {
    const m = da.match(/^(Pass|Fail)\b/i);
    if (!m) problems.push(`Domains Align "${da}" does not open on Pass or Fail`);
    else summary.align = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }
  if (vd === undefined) problems.push('no "Verdict:" line in the summary');
  else {
    const v = VERDICTS.find((w) => new RegExp(`^${w}\\b`, "i").test(vd));
    if (!v) problems.push(`Verdict "${vd}" does not open on one of ${VERDICTS.join(", ")}`);
    else summary.verdict = v;
  }

  // DMARC consistency
  const res = (p: (typeof PROTOCOLS)[number]) => (summary.results[p] ?? "").toLowerCase();
  if (res("DMARC") === "pass") {
    if (summary.align === "Fail") problems.push("DMARC is Pass but Domains Align is Fail; DMARC passes only on an aligned identifier");
    if (res("SPF") !== "pass" && res("DKIM") !== "pass") problems.push("DMARC is Pass but neither SPF nor DKIM passed");
  }

  // Details subsections
  const detLines = detAt >= 0 ? lines.slice(detAt + 1) : [];
  const h3 = detLines.map((l, i) => ({ i, m: l.match(/^###\s+(.+?)\s*$/) })).filter((x) => x.m);
  const titles = h3.map((x) => x.m![1]);
  let cursor = 0;
  for (const want of DETAIL_HEADINGS) {
    const at = titles.indexOf(want, cursor);
    if (at < 0) {
      problems.push(titles.includes(want) ? `DETAILS subsection "${want}" is out of order` : `DETAILS is missing "### ${want}"`);
      continue;
    }
    const start = h3[at].i + 1;
    const end = at + 1 < h3.length ? h3[at + 1].i : detLines.length;
    if (detLines.slice(start, end).every((l) => l.trim() === "")) problems.push(`DETAILS subsection "${want}" is empty`);
    cursor = at + 1;
  }

  // Dig block
  const digAt = h3.find((x) => x.m![1] === "Dig Commands");
  if (digAt) {
    const after = detLines.slice(digAt.i + 1).join("\n");
    const fence = after.match(/```(?:bash|sh|shell|zsh)?\n([\s\S]*?)```/);
    if (!fence) problems.push("Dig Commands has no fenced shell block");
    else {
      const block = fence[1];
      const dm = block.match(/^\s*(?:export\s+)?DOMAIN=["']?([^"'\s]+)["']?\s*$/m);
      const fromDomain = summary.headerFrom?.split("@")[1]?.toLowerCase();
      if (!dm) problems.push('dig block does not set DOMAIN="<Header From domain>"');
      else if (fromDomain && dm[1].toLowerCase() !== fromDomain)
        problems.push(`dig block sets DOMAIN="${dm[1]}", expected the Header From domain "${fromDomain}"`);
      const norm = block.split("\n").map(normalizeShell).join("\n");
      const required = [
        "dig +short mx $DOMAIN",
        "dig +short txt $DOMAIN | grep -i spf",
        ...DKIM_SELECTORS.map((s) => `dig +short txt ${s}._domainkey.$DOMAIN`),
        "dig +short txt _dmarc.$DOMAIN",
        "dig +short ns _dmarc.$DOMAIN",
        "dmarcian.com/domain-checker/?domain=$DOMAIN",
        "domain-checker.valimail.com/dmarc/$DOMAIN",
      ];
      for (const r of required) if (!norm.includes(r)) problems.push(`dig block is missing "${r}"`);
    }
  }

  return { ok: problems.length === 0, summary, problems };
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
    console.error(`unknown flag: ${unknown.join(" ")}`);
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
  if (json) console.log(JSON.stringify({ ok: r.ok, summary: r.summary, problems: r.problems }));
  else if (r.ok) console.log(`✓ ${r.summary.headerFrom}: shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
