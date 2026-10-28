#!/usr/bin/env bun
// DesignDocumentCheck — checks a DesignDocument output against the parts of its
// contract code can judge: the title, the five sections in order, their
// sub-sections, the `security control:` and `accepted risk:` prefixes, three C4
// views each holding one Mermaid block and one five-column table whose names
// appear in the diagram, questions that carry their assumed default, and no bold
// or italics. Every Mermaid block is rendered through mmdc, a real parser.
// Whether the content is specific and faithful stays a judged check in the suite.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELP = `DesignDocumentCheck — shape and Mermaid check for a Fabric DesignDocument output

  bun skills/Fabric/Tools/DesignDocumentCheck.ts <file|-> [--no-render] [--json]

  --no-render  skip rendering the Mermaid blocks through mmdc (shape checks only)
  --json       print {ok, title, sections, diagrams, rendered, problems}
Exit: 0 shape holds and diagrams render, 1 a rule failed,
      2 bad usage, unreadable input, or mmdc missing or hung.`;

export const SECTIONS = ["BUSINESS POSTURE", "SECURITY POSTURE", "DESIGN", "RISK ASSESSMENT", "QUESTIONS & ASSUMPTIONS"] as const;

export const SUBS: Record<string, string[]> = {
  "BUSINESS POSTURE": ["Business priorities", "Business risks"],
  "SECURITY POSTURE": ["Existing security controls", "Accepted risks", "Recommended security controls", "Security requirements"],
  DESIGN: ["C4 CONTEXT", "C4 CONTAINER", "C4 DEPLOYMENT"],
  "RISK ASSESSMENT": ["Critical business processes", "Data to protect"],
  "QUESTIONS & ASSUMPTIONS": ["BUSINESS POSTURE", "SECURITY POSTURE", "DESIGN"],
};

export const COLUMNS = ["Name", "Type", "Description", "Responsibilities", "Security controls"];
const MIN_ROWS = 2;

type Line = { ln: number; raw: string; t: string };
type Mermaid = { line: number; code: string; view: string };
type Table = { line: number; rows: { ln: number; cells: string[] }[] };
type Block = { name: string; line: number; text: Line[]; mermaid: Mermaid[]; tables: Table[] };
type Section = Block & { subs: Block[] };

export type Result = {
  ok: boolean;
  title: string | null;
  sections: { name: string; subs: string[] }[];
  diagrams: Mermaid[];
  problems: string[];
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** Lower-case word tokens joined by single spaces; Mermaid line breaks (<br/>, \n) and punctuation are separators. */
export const tokens = (s: string) =>
  s.replace(/<br\s*\/?>/gi, " ").replace(/\\n/g, " ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const block = (name: string, line: number): Block => ({ name, line, text: [], mermaid: [], tables: [] });

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function emphasis(text: string): string | null {
  const s = text.replace(/`[^`]*`/g, "");
  if (/\*\*|__/.test(s)) return "bold";
  if (/(^|[^\w*])\*[^\s*][^*\n]*?\*(?![\w*])/.test(s)) return "italic";
  if (/(^|[^\w_])_[^\s_][^_\n]*?_(?![\w_])/.test(s)) return "italic";
  return null;
}

export function check(input: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const sections: Section[] = [];
  let title: string | null = null;
  let titleLine = 0;
  let fence: { lang: string; line: number; body: string[] } | null = null;
  let table: Table | null = null;

  const current = (): Block | null => {
    const s = sections[sections.length - 1];
    if (!s) return null;
    return s.subs[s.subs.length - 1] ?? s;
  };
  const viewName = () => {
    const s = sections[sections.length - 1];
    const sub = s?.subs[s.subs.length - 1];
    return sub ? sub.name : s?.name ?? "(top)";
  };

  lines.forEach((raw, i) => {
    const ln = i + 1;
    const t = raw.trim();

    if (fence) {
      if (/^```\s*$/.test(t)) {
        const target = current();
        if (fence.lang === "mermaid") {
          if (target) target.mermaid.push({ line: fence.line, code: fence.body.join("\n"), view: viewName() });
        } else problems.push(`line ${fence.line}: a code fence that is not mermaid ("\`\`\`${fence.lang}"); the document carries no other code`);
        fence = null;
      } else fence.body.push(raw);
      return;
    }

    if (table && !t.startsWith("|")) table = null;

    const open = t.match(/^```\s*([\w-]*)\s*$/);
    if (open) {
      if (title === null) problems.push(`line ${ln}: the document opens on a code fence; it is plain markdown, never wrapped in a fence`);
      fence = { lang: open[1].toLowerCase(), line: ln, body: [] };
      return;
    }
    if (t === "") return;

    const em = emphasis(t);
    if (em) problems.push(`line ${ln}: ${em} markdown ("${t.slice(0, 60)}"); the document uses no bold or italics`);

    const h1 = t.match(/^#\s+(.*)$/);
    if (h1) {
      if (title !== null) problems.push(`line ${ln}: a second # title`);
      else {
        const m = h1[1].match(/^Design Document:\s*(\S.*)$/);
        if (!m) problems.push(`line ${ln}: the title reads "# Design Document: {system name}"`);
        title = m ? m[1].trim() : h1[1].trim();
        titleLine = ln;
        if (sections.length) problems.push(`line ${ln}: the title must come before every section`);
      }
      return;
    }
    if (title === null && !/^#{2,}\s/.test(t)) {
      problems.push(`line ${ln}: text before the title ("${t.slice(0, 60)}")`);
      return;
    }

    const h2 = t.match(/^##\s+(.*?)\s*$/);
    if (h2) {
      sections.push({ ...block(h2[1], ln), subs: [] });
      return;
    }
    const h3 = t.match(/^###\s+(.*?)\s*$/);
    if (h3) {
      const s = sections[sections.length - 1];
      if (!s) problems.push(`line ${ln}: sub-heading "${h3[1]}" before any section`);
      else s.subs.push(block(h3[1], ln));
      return;
    }
    if (/^#{4,}\s/.test(t)) {
      problems.push(`line ${ln}: heading deeper than ### ("${t.slice(0, 60)}")`);
      return;
    }

    const target = current();
    if (!target) {
      problems.push(`line ${ln}: text between the title and the first section ("${t.slice(0, 60)}")`);
      return;
    }
    if (t.startsWith("|")) {
      if (!table) {
        table = { line: ln, rows: [] };
        target.tables.push(table);
      }
      table.rows.push({ ln, cells: cells(t) });
      return;
    }
    target.text.push({ ln, raw, t });
  });

  if (fence) problems.push(`line ${(fence as { line: number }).line}: code fence never closed`);
  if (title === null) problems.push('no title; the document opens on "# Design Document: {system name}"');
  void titleLine;

  // Sections: exactly the five, in order.
  const names = sections.map((s) => s.name);
  for (const want of SECTIONS) if (!names.includes(want)) problems.push(`no ## ${want} section`);
  for (const s of sections) if (!(SECTIONS as readonly string[]).includes(s.name)) problems.push(`line ${s.line}: unexpected section "## ${s.name}"`);
  const known = names.filter((n) => (SECTIONS as readonly string[]).includes(n));
  const order = SECTIONS.filter((n) => known.includes(n));
  if (known.join("|") !== order.join("|")) problems.push(`sections out of order (found ${known.join(", ")}; expected ${SECTIONS.join(", ")})`);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) problems.push(`section "## ${n}" appears more than once`);

  const diagrams: Mermaid[] = [];

  for (const s of sections) {
    const wantSubs = SUBS[s.name];
    if (!wantSubs) continue;
    const got = s.subs.map((b) => norm(b.name));
    for (const w of wantSubs) if (!got.includes(norm(w))) problems.push(`## ${s.name} has no ### ${w}`);
    for (const b of s.subs) if (!wantSubs.some((w) => norm(w) === norm(b.name))) problems.push(`line ${b.line}: unexpected sub-section "### ${b.name}" in ## ${s.name}`);
    const orderGot = got.filter((g) => wantSubs.some((w) => norm(w) === g));
    const orderWant = wantSubs.map(norm).filter((w) => orderGot.includes(w));
    if (orderGot.join("|") !== orderWant.join("|")) problems.push(`## ${s.name}: sub-sections out of order (expected ${wantSubs.join(", ")})`);

    if (s.mermaid.length || s.tables.length) problems.push(`line ${s.line}: ## ${s.name} holds a diagram or table outside its ### views`);
    if (s.name === "BUSINESS POSTURE" && !s.text.some((l) => !/^[-*+]\s/.test(l.t)))
      problems.push("## BUSINESS POSTURE opens with no paragraph on purpose, stage and risk appetite");

    for (const b of s.subs) {
      const key = norm(b.name);
      if (s.name === "DESIGN") {
        diagrams.push(...b.mermaid);
        if (b.mermaid.length !== 1) problems.push(`### ${b.name}: expected one mermaid block, found ${b.mermaid.length}`);
        if (b.tables.length !== 1) problems.push(`### ${b.name}: expected one table, found ${b.tables.length}`);
        const tb = b.tables[0];
        if (tb) {
          const [head, sep, ...rows] = tb.rows;
          if (!head || head.cells.map(norm).join("|") !== COLUMNS.map(norm).join("|"))
            problems.push(`line ${tb.line}: ### ${b.name} table columns must be ${COLUMNS.join(" | ")}`);
          if (!sep || !sep.cells.every((c) => /^:?-{3,}:?$/.test(c))) problems.push(`line ${tb.line + 1}: ### ${b.name} table has no separator row`);
          if (rows.length < MIN_ROWS) problems.push(`line ${tb.line}: ### ${b.name} table has ${rows.length} rows; it describes at least ${MIN_ROWS} elements`);
          const code = b.mermaid[0] ? ` ${tokens(b.mermaid[0].code)} ` : null;
          for (const r of rows) {
            if (r.cells.length !== COLUMNS.length) problems.push(`line ${r.ln}: row has ${r.cells.length} cells, expected ${COLUMNS.length}`);
            else if (r.cells.some((c) => c === "")) problems.push(`line ${r.ln}: row has an empty cell`);
            const name = r.cells[0] ?? "";
            if (code !== null && name) {
              const full = tokens(name);
              const bare = tokens(name.replace(/\([^)]*\)/g, " "));
              if (!(full && code.includes(` ${full} `)) && !(bare && code.includes(` ${bare} `)))
                problems.push(`line ${r.ln}: "${name}" is in the ### ${b.name} table but not in its diagram`);
            }
          }
          if (b.mermaid[0] && b.mermaid[0].line > tb.line) problems.push(`### ${b.name}: the diagram comes before its table`);
        }
        continue;
      }
      if (b.mermaid.length || b.tables.length) problems.push(`line ${b.line}: ### ${b.name} holds a diagram or table; only the ## DESIGN views do`);
      const bullets: Line[] = [];
      for (const l of b.text) {
        if (/^\s+[-*+]\s/.test(l.raw)) problems.push(`line ${l.ln}: sub-bullet; each item is its own top-level "- " bullet`);
        else if (/^[*+]\s/.test(l.t) || /^\d+[.)]\s/.test(l.t)) problems.push(`line ${l.ln}: items are "- " bullets ("${l.t.slice(0, 40)}")`);
        else if (/^- \S/.test(l.t)) bullets.push(l);
        else problems.push(`line ${l.ln}: commentary in ### ${b.name} ("${l.t.slice(0, 60)}")`);
      }
      if (bullets.length === 0) problems.push(`line ${b.line}: ### ${b.name} has no items`);
      for (const l of bullets) {
        const item = l.t.slice(2);
        if (key === "existing security controls" && !/^security control:\s*\S/.test(item))
          problems.push(`line ${l.ln}: an existing control opens on "security control:"`);
        if (key === "accepted risks" && !/^accepted risk:\s*\S/.test(item)) problems.push(`line ${l.ln}: an accepted risk opens on "accepted risk:"`);
        if (s.name === "QUESTIONS & ASSUMPTIONS" && !/\?[^\n]*?\bAssumed:\s*\S/.test(item))
          problems.push(`line ${l.ln}: a question ends in "?" and its bullet then gives "Assumed: {default}"`);
      }
    }
  }

  return {
    ok: problems.length === 0,
    title,
    sections: sections.map((s) => ({ name: s.name, subs: s.subs.map((b) => b.name) })),
    diagrams,
    problems,
  };
}

export class RenderUnavailable extends Error {}

const PUPPETEER = { headless: "new", args: ["--no-sandbox", "--disable-gpu"] };
const MERMAID = { securityLevel: "strict" };

async function mmdc(bin: string, dir: string, input: string, output: string, timeoutMs: number): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn([bin, "-q", "-p", join(dir, "puppeteer.json"), "-c", join(dir, "mermaid.json"), "-i", input, "-o", output], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (proc.signalCode) throw new RenderUnavailable(`mmdc did not finish within ${timeoutMs / 1000}s (Chrome failed to start?)`);
  return { code, err };
}

function firstError(err: string): string {
  const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => /error/i.test(l) && !/^at /.test(l));
  if (i < 0) return lines[0] ?? "unknown mmdc error";
  return lines.slice(i, i + 3).filter((l) => !/^at /.test(l)).join(" / ").replace(/^Error: Evaluation failed: /, "");
}

/** Renders every diagram through mmdc. Returns one problem per diagram that fails to parse. */
export async function renderMermaid(diagrams: Mermaid[], timeoutMs = 120_000): Promise<string[]> {
  if (diagrams.length === 0) return [];
  const bin = Bun.which("mmdc");
  if (!bin) throw new RenderUnavailable("mmdc not found; install @mermaid-js/mermaid-cli or pass --no-render");
  const dir = mkdtempSync(join(tmpdir(), "designdoc-"));
  try {
    writeFileSync(join(dir, "puppeteer.json"), JSON.stringify(PUPPETEER));
    writeFileSync(join(dir, "mermaid.json"), JSON.stringify(MERMAID));
    const md = diagrams.map((d) => "```mermaid\n" + d.code + "\n```").join("\n\n");
    writeFileSync(join(dir, "all.md"), md + "\n");
    const all = await mmdc(bin, dir, join(dir, "all.md"), join(dir, "out.md"), timeoutMs);
    if (all.code === 0) return [];
    // One block failed: render each alone, in parallel, to name it.
    const each = await Promise.all(
      diagrams.map(async (d, i) => {
        writeFileSync(join(dir, `d${i}.mmd`), d.code + "\n");
        const r = await mmdc(bin, dir, join(dir, `d${i}.mmd`), join(dir, `d${i}.svg`), timeoutMs);
        return r.code === 0 ? null : `line ${d.line}: the ### ${d.view} diagram does not render (${firstError(r.err)})`;
      }),
    );
    const found = each.filter((p): p is string => p !== null);
    return found.length ? found : [`the Mermaid blocks do not render together (${firstError(all.err)})`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.length === 0) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const noRender = args.includes("--no-render");
  const unknown = args.find((a) => a.startsWith("--") && a !== "--json" && a !== "--no-render");
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
  let rendered: boolean | null = null;
  if (!noRender) {
    try {
      const fails = await renderMermaid(r.diagrams);
      rendered = fails.length === 0;
      r.problems.push(...fails);
      r.ok = r.problems.length === 0;
    } catch (e) {
      if (!(e instanceof RenderUnavailable)) throw e;
      console.error(`✗ ${e.message}`);
      if (json) console.log(JSON.stringify({ ok: false, title: r.title, rendered: null, problems: [...r.problems, e.message] }));
      process.exit(2);
    }
  }
  if (json)
    console.log(
      JSON.stringify({
        ok: r.ok,
        title: r.title,
        sections: r.sections,
        diagrams: r.diagrams.map((d) => ({ view: d.view, line: d.line })),
        rendered,
        problems: r.problems,
      }),
    );
  else if (r.ok) console.log(`✓ ${r.sections.length} sections, ${r.diagrams.length} diagrams${rendered ? " rendered" : ""}, shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
