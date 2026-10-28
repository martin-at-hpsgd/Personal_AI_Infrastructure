#!/usr/bin/env bun
// SecurePromptCheck — checks a SecurePrompt output (Intents/SecurePrompt.md)
// against the parts of its contract code can judge: one H1, the five sections in
// order, the system prompt as one non-empty ```text block with no skeleton
// placeholders or secret-shaped strings, the developer prompt as a block or a
// "Not needed" line, an injection-test table covering the required vectors, and
// a rubric table whose rows name the tests they grade, followed by a release bar.
// Whether the prompt fits the deployment stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `SecurePromptCheck — shape check for a Fabric SecurePrompt output

  bun skills/Fabric/Tools/SecurePromptCheck.ts <file|-> [--sections list] [--json]

  --sections list  comma list of the sections the request asked for, in order
                   (system,developer,tests,rubric,notes; default: all five)
  --json           print {ok, sections, tests, rubric, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const SECTION_KEYS = ["system", "developer", "tests", "rubric", "notes"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

const SECTION_TITLES: Record<SectionKey, RegExp> = {
  system: /^system prompt$/i,
  developer: /^(optional )?developer prompt$/i,
  tests: /^(prompt[- ])?injection tests$/i,
  rubric: /^evaluation rubric$/i,
  notes: /^notes$/i,
};

export const VECTORS = [
  "direct",
  "indirect",
  "extraction",
  "exfiltration",
  "role-play",
  "obfuscation",
  "multi-turn",
  "tool-abuse",
  "escalation",
  "benign",
] as const;
export const REQUIRED_VECTORS = ["direct", "indirect", "extraction", "benign"] as const;
export const MIN_TESTS = 6;
export const MIN_RUBRIC = 5;
const RELEASE_BAR = /^\**\s*release bar\s*\**\s*:\s*\**\s*(.*)$/i;

/** Test IDs a rubric cell names: T3, "T1 and T4", ranges like T1-T3, T1–T3, T1..T3, T1 to T3. */
export function testRefs(text: string): string[] {
  const out = new Set<string>();
  const range = /\bT(\d+)\s*(?:-|–|—|\.\.|to)\s*T?(\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = range.exec(text))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && b - a <= 50) for (let n = a; n <= b; n++) out.add(`T${n}`);
  }
  for (const x of text.matchAll(/\bT(\d+)\b/g)) out.add(`T${Number(x[1])}`);
  return [...out];
}

const SECRET_SHAPES: { name: string; re: RegExp }[] = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

type Section = { key: SectionKey | null; title: string; line: number; body: string[] };
type Row = { line: number; cells: Record<string, string> };

export type CheckResult = {
  ok: boolean;
  sections: string[];
  tests: { id: string; vector: string }[];
  rubric: string[];
  problems: string[];
};

function normVector(v: string): string {
  const s = v.trim().toLowerCase().replace(/[`*_]/g, "");
  if (s === "roleplay" || s === "role play") return "role-play";
  if (s === "multiturn" || s === "multi turn") return "multi-turn";
  if (s === "tool abuse") return "tool-abuse";
  return s;
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (inner[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse the first markdown table in a section body. Header names are lowercased. */
export function parseTable(body: string[], firstLine: number): { header: string[]; rows: Row[] } | null {
  const start = body.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0 || start + 1 >= body.length) return null;
  const header = splitRow(body[start]).map((h) => h.toLowerCase().replace(/[`*_]/g, "").trim());
  if (!/^\|?[\s:|-]+\|?$/.test(body[start + 1].trim()) || !body[start + 1].includes("-")) return null;
  const rows: Row[] = [];
  for (let i = start + 2; i < body.length && body[i].trim().startsWith("|"); i++) {
    const vals = splitRow(body[i]);
    const cells: Record<string, string> = {};
    header.forEach((h, j) => (cells[h] = vals[j] ?? ""));
    rows.push({ line: firstLine + i + 1, cells });
  }
  return { header, rows };
}

function col(header: string[], want: RegExp): string | undefined {
  return header.find((h) => want.test(h));
}

function fencedBlocks(body: string[]): { lang: string; text: string; closed: boolean }[] {
  const blocks: { lang: string; text: string; closed: boolean }[] = [];
  for (let i = 0; i < body.length; i++) {
    const open = body[i].match(/^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/);
    if (!open) continue;
    const fence = open[1];
    const inner: string[] = [];
    let j = i + 1;
    while (j < body.length && body[j].trim() !== fence) inner.push(body[j++]);
    blocks.push({ lang: open[2].toLowerCase(), text: inner.join("\n"), closed: j < body.length });
    i = j;
  }
  return blocks;
}

function checkPromptBlock(sec: Section, label: string, problems: string[], allowNotNeeded: boolean): void {
  const blocks = fencedBlocks(sec.body);
  const prose = sec.body.filter((l) => l.trim() !== "");
  if (blocks.length === 0) {
    if (allowNotNeeded && prose.length >= 1 && /^not needed\b/i.test(prose[0].trim())) {
      if (prose[0].trim().split(/\s+/).length < 5) problems.push(`${label}: "Not needed" line gives no reason`);
      return;
    }
    problems.push(`${label}: no fenced \`\`\`text block${allowNotNeeded ? ' and no "Not needed: <reason>" line' : ""}`);
    return;
  }
  if (blocks.length > 1) problems.push(`${label}: ${blocks.length} fenced blocks; the prompt is one block`);
  const b = blocks[0];
  if (!b.closed) problems.push(`${label}: fenced block is never closed`);
  if (b.lang !== "text") problems.push(`${label}: fence language is "${b.lang || "none"}", expected text`);
  const text = b.text.trim();
  if (text.split(/\s+/).filter(Boolean).length < 40) problems.push(`${label}: prompt is under 40 words; that is a skeleton, not a prompt`);
  b.text.split("\n").forEach((l) => {
    const t = l.trim();
    if (t === "..." || t === "…") problems.push(`${label}: placeholder line "${t}" left in the prompt`);
  });
  if (/\[(insert|your|todo|tbd)\b[^\]]*\]|<(insert|your)[^>]*>|\bTODO\b|\bTBD\b/i.test(text))
    problems.push(`${label}: unfilled placeholder left in the prompt`);
  for (const s of SECRET_SHAPES) if (s.re.test(text)) problems.push(`${label}: contains a ${s.name}; a prompt never carries a credential`);
}

export function check(input: string, wanted: SectionKey[] = [...SECTION_KEYS]): CheckResult {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const sections: Section[] = [];
  const preamble: { line: number; text: string }[] = [];
  let inFence: string | null = null;

  lines.forEach((raw, i) => {
    const fence = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (inFence === null) inFence = fence[1];
      else if (raw.trim() === inFence) inFence = null;
    }
    const h2 = inFence === null ? raw.match(/^##\s+(.+?)\s*#*\s*$/) : null;
    if (h2 && !raw.startsWith("###")) {
      const title = h2[1].replace(/[*_`]/g, "").trim();
      const key = (SECTION_KEYS.find((k) => SECTION_TITLES[k].test(title)) ?? null) as SectionKey | null;
      sections.push({ key, title, line: i + 1, body: [] });
    } else if (sections.length) sections[sections.length - 1].body.push(raw);
    else if (raw.trim() !== "") preamble.push({ line: i + 1, text: raw.trim() });
  });

  const h1s = preamble.filter((p) => /^#\s+\S/.test(p.text));
  if (h1s.length !== 1) problems.push(`expected one H1 heading naming the deployment before the sections, found ${h1s.length}`);
  if (preamble.length > 1) problems.push(`${preamble.length} lines before the first section; only the H1 is allowed`);

  for (const s of sections) if (s.key === null) problems.push(`line ${s.line}: unexpected section "## ${s.title}"`);
  const found = sections.filter((s) => s.key !== null).map((s) => s.key as SectionKey);
  const dupes = found.filter((k, i) => found.indexOf(k) !== i);
  for (const d of new Set(dupes)) problems.push(`section "${d}" appears more than once`);
  for (const w of wanted) if (!found.includes(w)) problems.push(`missing section: ${w}`);
  for (const f of new Set(found)) if (!wanted.includes(f)) problems.push(`section "${f}" was not asked for`);
  const order = found.filter((k) => wanted.includes(k));
  const expectedOrder = wanted.filter((k) => order.includes(k));
  if (order.join(",") !== expectedOrder.join(",")) problems.push(`sections out of order: ${order.join(", ")} (expected ${expectedOrder.join(", ")})`);

  const get = (k: SectionKey) => sections.find((s) => s.key === k);
  const tests: { id: string; vector: string }[] = [];
  const rubric: string[] = [];
  const rubricRefs: { rid: string; ref: string; line: number }[] = [];
  const unmapped: { rid: string; line: number }[] = [];

  const sys = get("system");
  if (sys) checkPromptBlock(sys, "system prompt", problems, false);
  const dev = get("developer");
  if (dev) checkPromptBlock(dev, "developer prompt", problems, true);

  const tsec = get("tests");
  if (tsec) {
    const t = parseTable(tsec.body, tsec.line);
    if (!t) problems.push("injection tests: no markdown table");
    else {
      const id = col(t.header, /^(id|#)$/);
      const vec = col(t.header, /^vector/);
      const atk = col(t.header, /^attack/);
      const exp = col(t.header, /^expected/);
      for (const [name, c] of [["ID", id], ["Vector", vec], ["Attack", atk], ["Expected", exp]] as const)
        if (!c) problems.push(`injection tests: table has no ${name} column`);
      if (id && vec && atk && exp) {
        if (t.rows.length < MIN_TESTS) problems.push(`injection tests: ${t.rows.length} rows, at least ${MIN_TESTS} required`);
        const seen = new Set<string>();
        for (const r of t.rows) {
          const rid = r.cells[id].replace(/[`*]/g, "");
          if (!/^T\d+$/.test(rid)) problems.push(`line ${r.line}: test ID "${rid}" is not T<number>`);
          if (seen.has(rid)) problems.push(`line ${r.line}: duplicate test ID ${rid}`);
          seen.add(rid);
          const v = normVector(r.cells[vec]);
          if (!(VECTORS as readonly string[]).includes(v)) problems.push(`line ${r.line}: vector "${r.cells[vec]}" is not one of ${VECTORS.join(", ")}`);
          if (r.cells[atk].split(/\s+/).filter(Boolean).length < 3) problems.push(`line ${r.line}: attack input is under 3 words`);
          if (r.cells[exp].split(/\s+/).filter(Boolean).length < 3) problems.push(`line ${r.line}: expected behavior is under 3 words`);
          tests.push({ id: rid, vector: v });
        }
        for (const need of REQUIRED_VECTORS)
          if (!tests.some((x) => x.vector === need)) problems.push(`injection tests: no "${need}" test`);
      }
    }
  }

  const rsec = get("rubric");
  if (rsec) {
    const t = parseTable(rsec.body, rsec.line);
    if (!t) problems.push("evaluation rubric: no markdown table");
    else {
      const id = col(t.header, /^(id|#)$/);
      const crit = col(t.header, /^criterion|^criteria/);
      const pass = col(t.header, /^pass/);
      for (const [name, c] of [["ID", id], ["Criterion", crit], ["Pass when", pass]] as const)
        if (!c) problems.push(`evaluation rubric: table has no ${name} column`);
      if (id && crit && pass) {
        if (t.rows.length < MIN_RUBRIC) problems.push(`evaluation rubric: ${t.rows.length} rows, at least ${MIN_RUBRIC} required`);
        const seen = new Set<string>();
        for (const r of t.rows) {
          const rid = r.cells[id].replace(/[`*]/g, "");
          if (!/^R\d+$/.test(rid)) problems.push(`line ${r.line}: rubric ID "${rid}" is not R<number>`);
          if (seen.has(rid)) problems.push(`line ${r.line}: duplicate rubric ID ${rid}`);
          seen.add(rid);
          if (!r.cells[crit].trim()) problems.push(`line ${r.line}: empty criterion`);
          if (r.cells[pass].split(/\s+/).filter(Boolean).length < 3) problems.push(`line ${r.line}: "pass when" is under 3 words`);
          rubric.push(rid);
          for (const ref of testRefs(`${r.cells[crit]} ${r.cells[pass]}`)) rubricRefs.push({ rid, ref, line: r.line });
          if (testRefs(`${r.cells[crit]} ${r.cells[pass]}`).length === 0) unmapped.push({ rid, line: r.line });
        }
      }
    }
    const bar = rsec.body.map((l) => l.trim().match(RELEASE_BAR)).find((m) => m);
    if (!bar) problems.push('evaluation rubric: no "Release bar:" line under the table stating what must pass to ship');
    else if (bar[1].replace(/\*/g, "").split(/\s+/).filter(Boolean).length < 5)
      problems.push('evaluation rubric: "Release bar:" line is under 5 words; name the rows, the trials and what blocks release');
  }

  if (tsec && rsec && tests.length && rubric.length) {
    const ids = new Set(tests.map((t) => t.id));
    for (const u of unmapped) problems.push(`line ${u.line}: rubric ${u.rid} names no test ID; each row grades named tests`);
    for (const r of rubricRefs) if (!ids.has(r.ref)) problems.push(`line ${r.line}: rubric ${r.rid} names ${r.ref}, which is not a test`);
    const graded = new Set(rubricRefs.map((r) => r.ref));
    for (const t of tests) if (!graded.has(t.id)) problems.push(`injection tests: ${t.id} is graded by no rubric row`);
  }

  const notes = get("notes");
  if (notes && notes.body.every((l) => l.trim() === "")) problems.push("notes: section is empty");

  if (/virtual minutes/i.test(input)) problems.push('contains "virtual minutes" reasoning choreography');

  return { ok: problems.length === 0, sections: found, tests, rubric, problems };
}

export function parseSections(arg: string): SectionKey[] | null {
  const keys = arg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (keys.length === 0 || keys.some((k) => !(SECTION_KEYS as readonly string[]).includes(k))) return null;
  return keys as SectionKey[];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const si = args.indexOf("--sections");
  let wanted: SectionKey[] = [...SECTION_KEYS];
  if (si >= 0) {
    const parsed = parseSections(args[si + 1] ?? "");
    if (!parsed) {
      console.error(`--sections takes a comma list of ${SECTION_KEYS.join(",")}`);
      process.exit(2);
    }
    wanted = parsed;
  }
  const src = args.find((a, i) => !a.startsWith("--") && !(si >= 0 && i === si + 1));
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input, wanted);
  const green = (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s);
  const red = (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s);
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(green(`✓ ${r.sections.length} sections, ${r.tests.length} injection tests, ${r.rubric.length} rubric rows; shape holds`));
  else for (const p of r.problems) console.log(red(`✗ ${p}`));
  process.exit(r.ok ? 0 : 1);
}
