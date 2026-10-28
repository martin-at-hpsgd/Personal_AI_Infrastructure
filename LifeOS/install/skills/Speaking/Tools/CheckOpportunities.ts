#!/usr/bin/env bun
// Checks the speaking opportunities list against the skill's checkable anti-criteria:
// every active entry has a close date, a URL or contact, and a pay tier, and no
// active entry sits past its deadline without a submission or an Archive move.
// Usage: bun CheckOpportunities.ts [listPath] [--json] [--today YYYY-MM-DD]
// Exit: 0 clean, 1 findings, 2 list unreadable.
import { basename, dirname, join } from "node:path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

export interface Finding { entry: string; section: string; problem: string }

const field = (body: string, names: string[]): string | null => {
  for (const n of names) {
    const m = body.match(new RegExp(`\\*\\*${n}:?\\*\\*:?\\s*\\|?\\s*([^|\\n]*)`, "i"));
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
};

export function checkOpportunities(text: string, today: Date): Finding[] {
  const findings: Finding[] = [];
  let section = "";
  const entries: { title: string; section: string; body: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) { section = line.slice(3).trim(); continue; }
    if (/^### /.test(line)) { entries.push({ title: line.slice(4).trim(), section, body: [] }); continue; }
    entries.at(-1)?.body.push(line);
  }
  for (const e of entries) {
    if (/archive/i.test(e.section)) continue;
    const body = e.body.join("\n");
    const add = (problem: string) => findings.push({ entry: e.title, section: e.section, problem });
    const deadline = field(body, ["Deadline", "CFP Deadline", "Closes"]);
    if (!deadline) add("no close date (Deadline field)");
    if (!/https?:\/\/|\]\([^)]+\)|[\w.+-]+@[\w-]+\.[\w.]+|\b[\w-]+\.(com|org|net|io|co|ai|live)\b/i.test(body)) add("no URL or contact");
    if (!field(body, ["Pay Tier", "Pay"])) add("no pay tier");
    if (deadline && !/submitted/i.test(body)) {
      // A date with no four-digit year ("March 31") is skipped: Date() would read it as 2001
      // and report a false pass. Only a dated deadline can be shown to have passed.
      const cleaned = deadline.replace(/\(.*?\)/g, "").trim();
      const d = /\b\d{4}\b/.test(cleaned) ? new Date(cleaned) : new Date(NaN);
      if (!Number.isNaN(d.getTime()) && d < today) add(`deadline ${deadline} has passed: record the submission or move it to Archive with its outcome`);
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const ti = args.indexOf("--today");
  const today = ti >= 0 ? new Date(args[ti + 1]) : new Date(new Date().toDateString());
  const pathArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--today");
  const configRoot = getClaudeDir();
  // The skill's USER folder carries the skill's own folder name, so a rename keeps working.
  const skillName = basename(dirname(import.meta.dir));
  const path = pathArg ?? join(configRoot, "LIFEOS/USER/CUSTOMIZATIONS/SKILLS", skillName, "Opportunities.md");
  let text: string;
  try { text = await Bun.file(path).text(); } catch { console.error(`cannot read ${path}`); process.exit(2); }
  const findings = checkOpportunities(text, today);
  if (json) console.log(JSON.stringify({ path, findings }, null, 2));
  else if (!findings.length) console.log("clean: every active entry has a close date, a URL or contact, and a pay tier");
  else for (const f of findings) console.log(`${f.entry} [${f.section}]: ${f.problem}`);
  process.exit(findings.length ? 1 : 0);
}
