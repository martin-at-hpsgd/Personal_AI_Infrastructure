#!/usr/bin/env bun
// CodingProjectCheck — checks a CodingProject output against the parts of its
// contract code can judge: the nine upstream sections as H2 headings in order;
// PROJECT one sentence of at most 20 words; numbered STEPS of at most 16 words;
// a STRUCTURE tree whose files match DETAILED EXPLANATION and CODE exactly;
// every CODE file complete (no placeholder), parsed where Bun can parse it, and
// free of secret-shaped literals; a README.md; a SETUP script that passes
// `bash -n`, quotes every heredoc, writes each file as CODE shows it and never
// pipes a download into a shell; numbered TAKEAWAYS and bulleted SUGGESTIONS
// with no repeats. Whether the code does the job stays a judged check.

import { readFileSync } from "node:fs";

const HELP = `CodingProjectCheck — shape check for a Fabric CodingProject output

  bun skills/Fabric/Tools/CodingProjectCheck.ts <file|-> [--json]

  --json   print {ok, sections, files, validated, problems}
Exit: 0 shape holds, 1 a rule failed, 2 bad usage or unreadable input.`;

export const ORDER = ["PROJECT", "SUMMARY", "STEPS", "STRUCTURE", "DETAILED EXPLANATION", "CODE", "SETUP", "TAKEAWAYS", "SUGGESTIONS"] as const;
export type Section = (typeof ORDER)[number];

const CLOSER = /\b(?:let me know if|hope this helps|feel free to ask|if you have any (?:other |more )?questions|happy to help)\b/i;
const NOTE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(?:note|warning|disclaimer)s?(?:\*\*|__)?\s*:/i;
const MARKER = /\b(?:TODO|FIXME)\b/;
const PLACEHOLDER = /your (?:code|logic|implementation) here|\bimplement (?:this|me)\b|rest of (?:the )?(?:code|file|implementation)|^\s*(?:\/\/|#|\/\*|<!--)?\s*(?:\.\.\.|…)\s*(?:\*\/|-->)?\s*$/i;
const SECRETS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'\s$<{]{8,}["']/i,
];
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/;

export type Validated = { path: string; parser: string };
export type Result = { ok: boolean; sections: Section[]; files: string[]; validated: Validated[]; problems: string[] };

type Line = { text: string; n: number; fenced: boolean };
type Fence = { open: number; close: number; info: string; body: string[] };

export function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}`]+|[^\p{L}\p{N}`]+$/gu, ""))
    .filter((t) => t.length > 0);
}

// CommonMark-style fences: a fence closes only on the same character, at least
// as long as the opener, with nothing after it, so ```` can hold ```.
function scan(lines: string[]): { marked: Line[]; fences: Fence[] } {
  const marked: Line[] = [];
  const fences: Fence[] = [];
  let open: { ch: string; len: number; at: number; info: string; body: string[] } | null = null;
  lines.forEach((text, i) => {
    const m = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!open && m && !(m[1][0] === "`" && m[2].includes("`"))) {
      open = { ch: m[1][0], len: m[1].length, at: i, info: m[2].trim(), body: [] };
      marked.push({ text, n: i, fenced: true });
      return;
    }
    if (open) {
      const c = text.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      marked.push({ text, n: i, fenced: true });
      if (c && c[1][0] === open.ch && c[1].length >= open.len) {
        fences.push({ open: open.at, close: i, info: open.info, body: open.body });
        open = null;
      } else open.body.push(text);
      return;
    }
    marked.push({ text, n: i, fenced: false });
  });
  if (open) {
    const o = open as { at: number; info: string; body: string[] };
    fences.push({ open: o.at, close: lines.length, info: o.info, body: o.body });
  }
  return { marked, fences };
}

const norm = (p: string, root: string) => {
  let s = p.trim().replace(/^`+|`+$/g, "").replace(/^\*\*|\*\*$/g, "").replace(/^`+|`+$/g, "").trim();
  s = s.replace(/^\.\//, "");
  if (root && s.startsWith(root + "/")) s = s.slice(root.length + 1);
  return s;
};

const sameContent = (a: string[], b: string[]) => {
  const n = (x: string[]) => x.map((l) => l.replace(/\s+$/, "")).join("\n").trim();
  return n(a) === n(b);
};

// Parse a drawn tree (├── └── │) into authored file paths, plus empty dirs.
export function parseTree(body: string[]): { root: string; files: string[]; emptyDirs: string[]; problems: string[] } {
  const problems: string[] = [];
  const entries: { depth: number; name: string; path: string; slash: boolean }[] = [];
  const stack: string[] = [];
  let root = "";
  let sawConnector = false;
  for (const raw of body) {
    if (raw.trim() === "") continue;
    const m = raw.match(/^(.*?)(├──|└──|\|--|`--|\+--)\s*(.+)$/);
    if (!m) {
      if (!sawConnector && entries.length === 0 && !root) root = raw.trim().replace(/\s+(?:#|←|<-|\/\/).*$/, "").replace(/\/$/, "");
      else problems.push(`STRUCTURE line "${raw.trim().slice(0, 60)}" is not a tree entry`);
      continue;
    }
    sawConnector = true;
    const depth = Math.round(m[1].replace(/\t/g, "    ").length / 4);
    const name = m[3].replace(/\s+(?:#|←|<-|\/\/|-\s).*$/, "").replace(/`/g, "").trim();
    stack.length = depth;
    stack[depth] = name.replace(/\/$/, "");
    entries.push({ depth, name, path: stack.slice(0, depth + 1).join("/"), slash: name.endsWith("/") });
  }
  if (!sawConnector) problems.push("STRUCTURE is not a drawn tree (├── / └── entries)");
  const files: string[] = [];
  const emptyDirs: string[] = [];
  entries.forEach((e, i) => {
    const hasChild = entries[i + 1] !== undefined && entries[i + 1].depth > e.depth;
    if (hasChild) return;
    if (e.slash) emptyDirs.push(e.path);
    else files.push(e.path);
  });
  if (root === ".") root = "";
  return { root, files, emptyDirs, problems };
}

// SETUP heredocs: every delimiter quoted; collect the file each one writes.
export function heredocs(script: string[]): { writes: Map<string, string[]>; unquoted: string[] } {
  const writes = new Map<string, string[]>();
  const unquoted: string[] = [];
  for (let i = 0; i < script.length; i++) {
    const line = script[i];
    const m = line.match(/(?<!<)<<(?!<)(-?)\s*(\\?)(['"]?)([A-Za-z_][A-Za-z0-9_]*)\3/);
    if (!m) continue;
    const delim = m[4];
    const dash = m[1] === "-";
    if (!m[2] && !m[3]) unquoted.push(`line ${i + 1} of SETUP (<<${m[1]}${delim})`);
    const target = line.match(/(?:>{1,2}\s*|\btee\s+(?:-a\s+)?)["']?([^\s"'<>;|&]+)["']?/);
    const body: string[] = [];
    let j = i + 1;
    for (; j < script.length; j++) {
      const t = dash ? script[j].replace(/^\t+/, "") : script[j];
      if (t === delim || t.trim() === delim) break;
      body.push(t);
    }
    if (target && target[1] !== "/dev/null") writes.set(target[1], body);
    i = j;
  }
  return { writes, unquoted };
}

function bashSyntax(script: string): string | null {
  const r = Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? null : (r.stderr.toString().trim().split("\n")[0] || `bash -n exited ${r.exitCode}`);
}

// Parse a file by extension with a real parser. Returns parser name and error.
export function validateFile(path: string, content: string): { parser: string; error: string | null } | null {
  const ext = (path.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
  const loaders: Record<string, "ts" | "tsx" | "js" | "jsx"> = { ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx" };
  try {
    if (ext === "json") return { parser: "JSON.parse", error: (JSON.parse(content), null) };
    if (ext === "yaml" || ext === "yml") return { parser: "Bun.YAML.parse", error: (Bun.YAML.parse(content), null) };
    if (ext === "toml") return { parser: "Bun.TOML.parse", error: (Bun.TOML.parse(content), null) };
    if (loaders[ext]) {
      new Bun.Transpiler({ loader: loaders[ext] }).transformSync(content);
      return { parser: `Bun.Transpiler(${loaders[ext]})`, error: null };
    }
    if (ext === "sh" || ext === "bash") return { parser: "bash -n", error: bashSyntax(content) };
  } catch (e) {
    const parser = ext === "json" ? "JSON.parse" : ext === "yaml" || ext === "yml" ? "Bun.YAML.parse" : ext === "toml" ? "Bun.TOML.parse" : `Bun.Transpiler(${loaders[ext]})`;
    return { parser, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 160) };
  }
  return null;
}

type Item = { num?: number; bullet: boolean; text: string; line: number };
function listItems(body: Line[]): { items: Item[]; stray: Line[] } {
  const items: Item[] = [];
  const stray: Line[] = [];
  for (const l of body) {
    if (l.fenced || l.text.trim() === "") continue;
    const num = l.text.match(/^\s{0,3}(\d+)[.)]\s+(.*\S)\s*$/);
    const bul = l.text.match(/^\s{0,3}[-*+]\s+(.*\S)\s*$/);
    if (num) items.push({ num: Number(num[1]), bullet: false, text: num[2], line: l.n });
    else if (bul) items.push({ bullet: true, text: bul[1], line: l.n });
    else if (/^\s{2,}\S/.test(l.text) && items.length) continue; // continuation line
    else stray.push(l);
  }
  return { items, stray };
}

const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function check(input: string): Result {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const problems: string[] = [];
  const validated: Validated[] = [];
  const { marked, fences } = scan(lines);

  if (lines.every((l) => l.trim() === "")) return { ok: false, sections: [], files: [], validated, problems: ["output is empty"] };

  // Global text rules, outside fences.
  for (const l of marked) {
    if (l.fenced) continue;
    if (/^#\s/.test(l.text)) problems.push(`line ${l.n + 1}: H1 heading "${l.text.trim().slice(0, 60)}"; the output is the nine sections only`);
    if (NOTE_LINE.test(l.text)) problems.push(`line ${l.n + 1}: free-standing note or warning line ("${l.text.trim().slice(0, 60)}")`);
    if (CLOSER.test(l.text)) problems.push(`line ${l.n + 1}: closing offer or filler ("${l.text.trim().slice(0, 60)}")`);
  }

  // Sections.
  const found: { name: Section; line: number }[] = [];
  for (const l of marked) {
    if (l.fenced) continue;
    const h = l.text.match(/^##\s+(.*?)\s*#*\s*$/);
    if (!h) continue;
    const name = h[1].replace(/:$/, "").replace(/\*\*/g, "").trim();
    const canon = ORDER.find((s) => s === name.toUpperCase());
    if (!canon) {
      problems.push(`line ${l.n + 1}: unexpected section "## ${h[1]}"; allowed: ${ORDER.join(", ")}`);
      continue;
    }
    if (h[1] !== canon) problems.push(`line ${l.n + 1}: section "## ${h[1]}" must be written "## ${canon}"`);
    found.push({ name: canon, line: l.n });
  }
  const names = found.map((f) => f.name);
  if (found.length === 0) return { ok: false, sections: [], files: [], validated, problems: [...problems, `no section found; open on "## PROJECT"`] };
  const firstContent = lines.findIndex((l) => l.trim() !== "");
  if (firstContent < found[0].line) problems.push(`line ${firstContent + 1}: text before the first section ("${lines[firstContent].trim().slice(0, 60)}")`);
  for (const s of ORDER) {
    const c = names.filter((n) => n === s).length;
    if (c === 0) problems.push(`section "## ${s}" is missing`);
    if (c > 1) problems.push(`section "## ${s}" appears more than once`);
  }
  for (let i = 1; i < found.length; i++) {
    if (ORDER.indexOf(found[i].name) < ORDER.indexOf(found[i - 1].name)) problems.push(`line ${found[i].line + 1}: "## ${found[i].name}" comes after "## ${found[i - 1].name}"; expected order ${ORDER.join(", ")}`);
  }
  const bodyOf = (s: Section): Line[] | null => {
    const f = found.find((x) => x.name === s);
    if (!f) return null;
    const next = found.find((x) => x.line > f.line)?.line ?? lines.length;
    return marked.slice(f.line + 1, next);
  };
  const fencesIn = (body: Line[]) => (body.length ? fences.filter((f) => f.open >= body[0].n && f.open <= body[body.length - 1].n) : []);
  for (const f of found) {
    const b = bodyOf(f.name)!;
    if (b.every((l) => l.text.trim() === "")) problems.push(`line ${f.line + 1}: section "## ${f.name}" is empty`);
  }

  // PROJECT: one sentence, at most 20 words.
  const project = bodyOf("PROJECT");
  if (project) {
    const text = project.filter((l) => !l.fenced && l.text.trim()).map((l) => l.text.trim());
    if (text.some((t) => /^([-*+]|\d+[.)])\s/.test(t))) problems.push("PROJECT is a list; it must be one sentence");
    const joined = text.join(" ");
    const w = words(joined).length;
    if (w > 20) problems.push(`PROJECT has ${w} words; at most 20`);
    const sentences = joined.split(/(?<=[.!?])\s+(?=[A-Z0-9`])/).filter((s) => s.trim());
    if (sentences.length > 1) problems.push(`PROJECT has ${sentences.length} sentences; it must be one`);
  }

  // STEPS: numbered 1..n, each at most 16 words.
  const numbered = (s: Section, maxWords?: number) => {
    const b = bodyOf(s);
    if (!b) return;
    const { items, stray } = listItems(b);
    if (items.length < 2) problems.push(`${s} has ${items.length} item${items.length === 1 ? "" : "s"}; it needs a numbered list`);
    if (items.some((i) => i.bullet)) problems.push(`${s} must be a numbered list, not bullets`);
    items.filter((i) => !i.bullet).forEach((it, idx) => {
      if (it.num !== idx + 1) problems.push(`line ${it.line + 1}: ${s} item numbered ${it.num}, expected ${idx + 1}`);
      const w = words(it.text).length;
      if (maxWords && w > maxWords) problems.push(`line ${it.line + 1}: ${s} item has ${w} words; at most ${maxWords}`);
    });
    for (const l of stray) problems.push(`line ${l.n + 1}: text outside the ${s} list ("${l.text.trim().slice(0, 60)}")`);
    dupes(s, items);
  };
  const dupes = (s: Section, items: Item[]) => {
    const seen = new Set<string>();
    for (const it of items) {
      const k = key(it.text);
      if (seen.has(k)) problems.push(`line ${it.line + 1}: ${s} repeats an item ("${it.text.slice(0, 60)}")`);
      seen.add(k);
    }
  };
  numbered("STEPS", 16);

  // STRUCTURE.
  let root = "";
  let treeFiles: string[] = [];
  const structure = bodyOf("STRUCTURE");
  if (structure) {
    const f = fencesIn(structure)[0];
    if (!f) problems.push("STRUCTURE has no fenced tree");
    else {
      const t = parseTree(f.body);
      root = t.root;
      treeFiles = t.files.map((p) => norm(p, root));
      problems.push(...t.problems);
      for (const d of t.emptyDirs) problems.push(`STRUCTURE lists an empty directory "${d}/"`);
      if (treeFiles.length === 0) problems.push("STRUCTURE lists no files");
    }
  }

  // DETAILED EXPLANATION: one entry per file, purpose at most 16 words.
  const detailFiles: string[] = [];
  const detail = bodyOf("DETAILED EXPLANATION");
  if (detail) {
    const { items, stray } = listItems(detail);
    for (const it of items) {
      const m = it.text.match(/^(\*\*`[^`]+`\*\*|`[^`]+`|\*\*[^*]+\*\*|[^\s:]+)\s*(?::|\s[—–-])\s*(.*)$/);
      if (!m) {
        problems.push(`line ${it.line + 1}: DETAILED EXPLANATION entry is not "path: purpose" ("${it.text.slice(0, 60)}")`);
        continue;
      }
      const p = norm(m[1].replace(/:$/, ""), root);
      detailFiles.push(p);
      const w = words(m[2]).length;
      if (w === 0) problems.push(`line ${it.line + 1}: DETAILED EXPLANATION entry for ${p} has no purpose`);
      if (w > 16) problems.push(`line ${it.line + 1}: DETAILED EXPLANATION purpose for ${p} has ${w} words; at most 16`);
    }
    for (const l of stray) problems.push(`line ${l.n + 1}: text outside the DETAILED EXPLANATION list ("${l.text.trim().slice(0, 60)}")`);
  }

  // CODE: one ### per file, a description, one complete fenced block.
  const codeFiles = new Map<string, string[]>();
  const code = bodyOf("CODE");
  if (code) {
    const heads = code.filter((l) => !l.fenced && /^###\s+/.test(l.text));
    if (heads.length === 0) problems.push('CODE has no "### `path`" file headings');
    const before = code.filter((l) => !l.fenced && l.text.trim() && (heads.length === 0 || l.n < heads[0].n));
    for (const l of before) if (heads.length) problems.push(`line ${l.n + 1}: text in CODE before the first file heading ("${l.text.trim().slice(0, 60)}")`);
    heads.forEach((h, idx) => {
      const p = norm(h.text.replace(/^###\s+/, "").replace(/^(?:file|path)\s*:\s*/i, ""), root);
      const end = heads[idx + 1]?.n ?? code[code.length - 1].n + 1;
      const seg = code.filter((l) => l.n > h.n && l.n < end);
      const fs = fences.filter((f) => f.open > h.n && f.open < end);
      if (codeFiles.has(p)) problems.push(`CODE shows ${p} more than once`);
      if (fs.length === 0) {
        problems.push(`CODE ${p} has no fenced code block`);
        return;
      }
      const f = fs[0];
      const desc = seg.filter((l) => !l.fenced && l.n < f.open && l.text.trim());
      if (desc.length === 0) problems.push(`CODE ${p} has no one-line description before its code`);
      const after = seg.filter((l) => !l.fenced && l.n > f.close && l.text.trim());
      if (fs.length > 1 || after.length) problems.push(`CODE ${p} has text or a second block after its code (an inner fence may have closed it early; open the outer fence with more backticks)`);
      if (f.body.every((l) => l.trim() === "")) problems.push(`CODE ${p} is empty`);
      codeFiles.set(p, f.body);
      f.body.forEach((l, k) => {
        if (MARKER.test(l) || PLACEHOLDER.test(l)) problems.push(`CODE ${p} line ${k + 1}: placeholder ("${l.trim().slice(0, 60)}"); every file is complete`);
      });
      const isTest = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[a-z]+$/i.test(p);
      if (!isTest && !/(^|\/)\.env\.example$/.test(p)) {
        const joined = f.body.join("\n");
        if (SECRETS.some((r) => r.test(joined))) problems.push(`CODE ${p} holds a secret-shaped literal; read it from the environment`);
      }
      const v = validateFile(p, f.body.join("\n"));
      if (v) {
        validated.push({ path: p, parser: v.parser });
        if (v.error) problems.push(`CODE ${p} does not parse (${v.parser}): ${v.error}`);
      }
    });
    if (![...codeFiles.keys()].some((p) => /(^|\/)readme\.md$/i.test(p) && !p.includes("/"))) problems.push("CODE has no top-level README.md");
  }

  // The three file lists agree.
  const cf = [...codeFiles.keys()];
  const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  if (structure && code) {
    for (const p of diff(treeFiles, cf)) problems.push(`STRUCTURE lists ${p} but CODE has no code for it`);
    for (const p of diff(cf, treeFiles)) problems.push(`CODE shows ${p} but STRUCTURE does not list it`);
  }
  if (structure && detail) {
    for (const p of diff(treeFiles, detailFiles)) problems.push(`DETAILED EXPLANATION has no entry for ${p}`);
    for (const p of diff(detailFiles, treeFiles)) problems.push(`DETAILED EXPLANATION explains ${p}, which STRUCTURE does not list`);
  }

  // SETUP: one fenced script, parses, quoted heredocs, writes every file as CODE shows it.
  const setup = bodyOf("SETUP");
  if (setup) {
    const fs = fencesIn(setup);
    const f = fs[0];
    if (!f) problems.push("SETUP has no fenced script");
    else {
      const after = setup.filter((l) => !l.fenced && l.n > f.close && l.text.trim());
      if (fs.length > 1 || after.length) problems.push("SETUP has text or a second block after its script (an inner fence may have closed it early; open the outer fence with more backticks)");
      const script = f.body.join("\n");
      const err = bashSyntax(script);
      validated.push({ path: "SETUP", parser: "bash -n" });
      if (err) problems.push(`SETUP does not parse (bash -n): ${err}`);
      if (PIPE_TO_SHELL.test(script)) problems.push("SETUP pipes a download straight into a shell");
      const { writes, unquoted } = heredocs(f.body);
      for (const u of unquoted) problems.push(`SETUP heredoc at ${u} is unquoted; it expands $ and backticks in the file it writes (use <<'EOF')`);
      const written = new Map<string, string[]>();
      for (const [t, body] of writes) written.set(norm(t, root), body);
      for (const [p, body] of codeFiles) {
        const w = written.get(p);
        if (w) {
          if (!sameContent(w, body)) problems.push(`SETUP writes ${p} with different content from CODE`);
        } else if (!script.includes(p)) problems.push(`SETUP never creates ${p}`);
      }
    }
  }

  numbered("TAKEAWAYS");

  const sugg = bodyOf("SUGGESTIONS");
  if (sugg) {
    const { items, stray } = listItems(sugg);
    if (items.length < 2) problems.push(`SUGGESTIONS has ${items.length} item${items.length === 1 ? "" : "s"}; it needs a bulleted list`);
    if (items.some((i) => !i.bullet)) problems.push("SUGGESTIONS must be a bulleted list");
    for (const l of stray) problems.push(`line ${l.n + 1}: text outside the SUGGESTIONS list ("${l.text.trim().slice(0, 60)}")`);
    dupes("SUGGESTIONS", items);
  }

  return { ok: problems.length === 0, sections: names, files: cf, validated, problems };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log(HELP);
    process.exit(args.length === 0 ? 2 : 0);
  }
  let src: string | undefined;
  for (const a of args) {
    if (a === "--json") continue;
    if (a.startsWith("--")) {
      console.error(`unknown flag ${a}`);
      process.exit(2);
    }
    src = a;
  }
  let input: string;
  try {
    input = src === undefined || src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
  } catch (e) {
    console.error(`cannot read ${src ?? "stdin"}: ${(e as Error).message}`);
    process.exit(2);
  }
  const r = check(input);
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else if (r.ok) console.log(`✓ ${r.sections.length} sections, ${r.files.length} files, ${r.validated.length} parsed (${[...new Set(r.validated.map((v) => v.parser))].join(", ")}), shape holds`);
  else for (const p of r.problems) console.log(`✗ ${p}`);
  process.exit(r.ok ? 0 : 1);
}
