#!/usr/bin/env bun
// AuditConsentCheck — checks an AuditConsent output against the parts of its
// contract code can judge: one `## Audit:` block per consent claim (or the
// single no-consent-claim line), the consent-claim line, the subsections in
// order, the power-map and five-test tables with their fixed rows and values,
// the channel and verdict values, the None channel ending the audit, and a
// verdict consistent with the tests and asymmetries. Whether the evidence is
// tied to the input and the verdict is even-handed stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `AuditConsentCheck — shape check for a Fabric AuditConsent output

  bun skills/Fabric/Tools/AuditConsentCheck.ts <file|-> [--json]

  --json  print {ok, noClaim, audits, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const DIMENSIONS = ["Economic", "Information", "Social", "Structural"] as const;
export const ASYMMETRIES = ["Low", "Medium", "High", "Extreme"] as const;
export const CHANNELS = ["Words", "Conduct", "Agreement", "Prior permission", "None"] as const;
export const TESTS = ["Information", "Alternatives", "Capacity", "No manipulation", "Revocability"] as const;
export const STATUSES = ["Pass", "Partial", "Fail"] as const;
export const VERDICTS = ["GENUINE", "PRESSURED BUT FUNCTIONAL", "MANUFACTURED", "COERCED", "ILLUSORY"] as const;

const FULL_SECTIONS = ["Power map", "Consent channel", "Five consent tests", "Verdict", "What would make this genuine", "Minimum viable consent"];
const NONE_SECTIONS = ["Power map", "Consent channel", "What would make this genuine"];

export type Audit = {
  title: string;
  line: number;
  channel?: string;
  verdict?: string;
  asymmetry: Record<string, string>;
  tests: Record<string, string>;
};

const PLACEHOLDER = /\{[^}]*\}|\[(?:position|details|party)\]|^…$/;

function cells(row: string): string[] {
  const t = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split("|").map((c) => c.trim());
}

function tableRows(body: string[]): string[][] {
  return body.filter((l) => l.trim().startsWith("|")).map(cells);
}

function isSeparator(r: string[]): boolean {
  return r.every((c) => /^:?-{3,}:?$/.test(c));
}

function checkAudit(lines: string[], start: number, title: string, problems: string[]): Audit {
  const audit: Audit = { title, line: start + 1, asymmetry: {}, tests: {} };
  const p = (msg: string) => problems.push(`audit "${title}": ${msg}`);
  if (!title || PLACEHOLDER.test(title)) p("the `## Audit:` heading names no claim");

  // Split into preamble (before the first ###) and ### sections.
  const sections: { name: string; line: number; body: string[] }[] = [];
  const preamble: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(.+?)\s*$/);
    if (h) sections.push({ name: h[1], line: i + 1, body: [] });
    else if (/^#{1,2}\s/.test(lines[i])) p(`line ${i + 1}: unexpected heading "${lines[i].trim()}" inside the audit`);
    else if (sections.length) sections[sections.length - 1].body.push(lines[i]);
    else preamble.push(lines[i]);
  }

  const pre = preamble.map((l) => l.trim()).filter(Boolean);
  const claim = pre.find((l) => l.startsWith("**Consent claim:**"));
  if (!claim) p("no `**Consent claim:**` line before the first section");
  else if (claim.replace("**Consent claim:**", "").trim().length < 10 || PLACEHOLDER.test(claim)) p("the consent claim is empty or a placeholder");
  if (pre[0] && !pre[0].startsWith("**Consent claim:**")) p("the consent claim is not the first line of the audit");
  for (const l of pre) {
    if (!/^\*\*(Consent claim|Source|Answer):\*\*\s+\S/.test(l)) p(`unexpected line before the sections: "${l}"`);
  }

  const get = (name: string) => sections.find((s) => s.name === name);

  // Channel decides which section list applies.
  const chSec = get("Consent channel");
  if (chSec) {
    const chLine = chSec.body.map((l) => l.trim()).find((l) => l.startsWith("**Channel:**"));
    if (!chLine) p("no `**Channel:**` line under Consent channel");
    else {
      const m = chLine.match(/^\*\*Channel:\*\*\s+(.+?):\s+(\S.*)$/);
      if (!m) p(`channel line "${chLine}" is not \`**Channel:** {value}: {what carried it}\``);
      else if (!(CHANNELS as readonly string[]).includes(m[1])) p(`channel "${m[1]}" is not one of ${CHANNELS.join(", ")}`);
      else {
        audit.channel = m[1];
        if (PLACEHOLDER.test(m[2])) p("the channel detail is a placeholder");
      }
    }
  }
  const expected = audit.channel === "None" ? NONE_SECTIONS : FULL_SECTIONS;
  const names = sections.map((s) => s.name);
  if (names.join("|") !== expected.join("|")) {
    p(`sections are [${names.join(", ")}], expected [${expected.join(", ")}]${audit.channel === "None" ? " (a None channel ends the audit: no tests, verdict or minimum)" : ""}`);
  }

  // Power map.
  const pm = get("Power map");
  if (pm) {
    const rows = tableRows(pm.body);
    if (rows.length < 2) p("the power map has no table");
    else {
      const [head, sep, ...data] = rows;
      if (head.length !== 4 || head[0] !== "Dimension" || !/^Requester\b/.test(head[1]) || !/^Consenter\b/.test(head[2]) || head[3] !== "Asymmetry") {
        p(`power map header is "| ${head.join(" | ")} |", expected | Dimension | Requester: {party} | Consenter: {party} | Asymmetry |`);
      }
      if (!isSeparator(sep)) p("power map has no separator row under its header");
      const dims = data.map((r) => r[0]);
      if (dims.join("|") !== DIMENSIONS.join("|")) p(`power map rows are [${dims.join(", ")}], expected [${DIMENSIONS.join(", ")}]`);
      for (const r of data) {
        if (r.length !== 4) { p(`power map row "${r[0]}" has ${r.length} cells, expected 4`); continue; }
        if (!(ASYMMETRIES as readonly string[]).includes(r[3])) p(`power map row "${r[0]}": asymmetry "${r[3]}" is not one of ${ASYMMETRIES.join(", ")}`);
        else audit.asymmetry[r[0]] = r[3];
        if (!r[1] || !r[2] || PLACEHOLDER.test(r[1]) || PLACEHOLDER.test(r[2])) p(`power map row "${r[0]}": a party position is empty or a placeholder`);
      }
    }
  }

  // Five tests.
  const ft = get("Five consent tests");
  if (ft) {
    const rows = tableRows(ft.body);
    if (rows.length < 2) p("the five consent tests have no table");
    else {
      const [head, sep, ...data] = rows;
      if (head.join("|") !== "Test|Status|Evidence") p(`tests header is "| ${head.join(" | ")} |", expected | Test | Status | Evidence |`);
      if (!isSeparator(sep)) p("tests table has no separator row under its header");
      const tests = data.map((r) => r[0]);
      if (tests.join("|") !== TESTS.join("|")) p(`test rows are [${tests.join(", ")}], expected [${TESTS.join(", ")}]`);
      for (const r of data) {
        if (r.length !== 3) { p(`test row "${r[0]}" has ${r.length} cells, expected 3`); continue; }
        if (!(STATUSES as readonly string[]).includes(r[1])) p(`test "${r[0]}": status "${r[1]}" is not one of ${STATUSES.join(", ")}`);
        else audit.tests[r[0]] = r[1];
        if (r[2].length < 8 || PLACEHOLDER.test(r[2])) p(`test "${r[0]}": evidence is empty or a placeholder`);
      }
    }
  }

  // Verdict.
  const vs = get("Verdict");
  if (vs) {
    const vLine = vs.body.map((l) => l.trim()).find((l) => l.startsWith("**Verdict:**"));
    const m = vLine?.match(/^\*\*Verdict:\*\*\s+([A-Z ]+?):\s+(\S.*)$/);
    if (!m) p("no `**Verdict:** {VALUE}: {reason}` line under Verdict");
    else if (!(VERDICTS as readonly string[]).includes(m[1])) p(`verdict "${m[1]}" is not one of ${VERDICTS.join(", ")}`);
    else {
      audit.verdict = m[1];
      if (PLACEHOLDER.test(m[2])) p("the verdict reason is a placeholder");
    }
  }

  // Verdict consistency with the tests and power map.
  if (audit.verdict && Object.keys(audit.tests).length === TESTS.length && Object.keys(audit.asymmetry).length === DIMENSIONS.length) {
    const st = audit.tests;
    const allPass = TESTS.every((t) => st[t] === "Pass");
    const highAsym = DIMENSIONS.some((d) => audit.asymmetry[d] === "High" || audit.asymmetry[d] === "Extreme");
    const allLow = DIMENSIONS.every((d) => audit.asymmetry[d] === "Low");
    const v = audit.verdict;
    if (v === "GENUINE" && !allPass) p("verdict GENUINE but not every test passes");
    if (v === "GENUINE" && highAsym) p("verdict GENUINE with a High or Extreme asymmetry");
    if (v !== "GENUINE" && allPass && allLow) p(`verdict ${v} but every test passes and every asymmetry is Low; that is GENUINE`);
    if (v === "PRESSURED BUT FUNCTIONAL" && st["Alternatives"] === "Fail") p("verdict PRESSURED BUT FUNCTIONAL but the Alternatives test fails (refusal is not possible)");
    if (v === "ILLUSORY" && st["Alternatives"] !== "Fail") p("verdict ILLUSORY but the Alternatives test does not fail");
    if (v === "COERCED" && st["Alternatives"] !== "Fail" && st["Revocability"] !== "Fail") p("verdict COERCED but neither Alternatives nor Revocability fails");
    if ((v === "MANUFACTURED" || v === "COERCED" || v === "ILLUSORY") && allPass) p(`verdict ${v} while every test passes`);
  }

  // Closing sections.
  const genuine = audit.verdict === "GENUINE";
  const wm = get("What would make this genuine");
  if (wm) {
    const body = wm.body.map((l) => l.trim()).filter(Boolean);
    const bullets = body.filter((l) => /^[-*]\s+\S/.test(l));
    const noneNeeded = body.length === 1 && body[0] === "None needed.";
    if (noneNeeded && !genuine) p("`None needed.` under What would make this genuine on a verdict other than GENUINE");
    else if (!noneNeeded && bullets.length === 0) p("What would make this genuine has no bullet");
    for (const b of bullets) if (PLACEHOLDER.test(b)) p(`placeholder bullet under What would make this genuine: "${b}"`);
  }
  const mv = get("Minimum viable consent");
  if (mv) {
    const body = mv.body.map((l) => l.trim()).filter(Boolean);
    if (body.length === 0) p("Minimum viable consent is empty");
    else if (body.length === 1 && body[0] === "None needed." && !genuine) p("`None needed.` under Minimum viable consent on a verdict other than GENUINE");
    else if (body.some((l) => PLACEHOLDER.test(l))) p("Minimum viable consent is a placeholder");
  }

  return audit;
}

export function check(input: string): { ok: boolean; noClaim: boolean; audits: Audit[]; problems: string[] } {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const nonEmpty = lines.map((l, i) => ({ l: l.trim(), i })).filter((x) => x.l);
  const noClaimLines = nonEmpty.filter((x) => x.l.startsWith("**No consent claim:**"));

  if (noClaimLines.length) {
    if (nonEmpty.length !== 1) problems.push("the `**No consent claim:**` line must be the whole output");
    if (noClaimLines[0].l.replace("**No consent claim:**", "").trim().length < 5) problems.push("the no-consent-claim line does not say what the input is instead");
    return { ok: problems.length === 0, noClaim: true, audits: [], problems };
  }

  const starts = lines.map((l, i) => (/^##\s+Audit:/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length === 0) {
    problems.push("no `## Audit:` block and no `**No consent claim:**` line");
    return { ok: false, noClaim: false, audits: [], problems };
  }
  for (const x of nonEmpty) if (x.i < starts[0]) problems.push(`line ${x.i + 1}: text before the first audit ("${x.l}")`);

  const audits = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const title = lines[s].replace(/^##\s+Audit:\s*/, "").trim();
    return checkAudit(lines.slice(0, end), s, title, problems);
  });

  return { ok: problems.length === 0, noClaim: false, audits, problems };
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
  if (json) console.log(JSON.stringify({ ok: r.ok, noClaim: r.noClaim, audits: r.audits.map((a) => ({ title: a.title, channel: a.channel ?? null, verdict: a.verdict ?? null })), problems: r.problems }));
  else if (r.ok) console.log(r.noClaim ? "✓ no consent claim, single line" : `✓ ${r.audits.length} audit${r.audits.length === 1 ? "" : "s"}, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
