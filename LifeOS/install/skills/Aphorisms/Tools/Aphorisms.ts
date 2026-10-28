#!/usr/bin/env bun
/**
 * Aphorisms.ts — deterministic checks over the aphorism collection, and raw page text for FindAphorism.
 *
 *   bun skills/Aphorisms/Tools/Aphorisms.ts check [--db <path>] [--prefs <path>] [--history-since YYYY-MM-DD] [--json]
 *   bun skills/Aphorisms/Tools/Aphorisms.ts fetch <url>
 *   bun skills/Aphorisms/Tools/Aphorisms.ts path
 *
 * Exit codes: 0 ok, 1 check found errors, 2 usage error, 3 fetch failed.
 * See Aphorisms.help.md.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const SKILL_DIR = join(import.meta.dir, "..");

const customDir = () => join(getClaudeDir(), "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Aphorisms");

export function defaultDbPath(): string {
  const custom = join(customDir(), "aphorisms.md");
  return existsSync(custom) ? custom : join(SKILL_DIR, "Database/aphorisms.md");
}

/** The user's PREFERENCES.md, which may not exist. */
export const defaultPrefsPath = () => join(customDir(), "PREFERENCES.md");

export interface Entry { quote: string; author?: string; theme?: string; context?: string; line: number }
export interface Report { db: string; entries: number; errors: string[]; historyRuns: string[] }

/** Theme categories: the bold names in SKILL.md § Taxonomy, up to the first blank-line-terminated list. */
export function taxonomyCategories(skillMd: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const l of section("\n" + skillMd, "Taxonomy").split("\n")) {
    const m = l.match(/^- \*\*(.+?)\*\* - /);
    if (m) { out.push(m[1]); inList = true; } else if (inList && l.trim() === "") break;
  }
  return out;
}

/** Categories the user approved beyond the Taxonomy: the bullets of PREFERENCES.md § Approved categories. */
export function approvedCategories(prefsMd: string): string[] {
  return section("\n" + prefsMd, "Approved categories").split("\n").slice(1)
    .map((l) => l.match(/^- (?:\*\*(.+?)\*\*|(.+?))(?:\s+-\s+.*)?\s*$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => (m[1] ?? m[2]).trim())
    .filter(Boolean);
}

function section(md: string, heading: string): string {
  const i = md.indexOf(`\n## ${heading}`);
  if (i < 0) return "";
  const j = md.indexOf("\n## ", i + 4);
  return md.slice(i, j < 0 ? undefined : j);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const baseName = (s: string) => s.replace(/\(.*?\)/g, "").trim();

export function parseEntries(md: string): Entry[] {
  const lines = md.split("\n");
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  lines.forEach((l, i) => {
    const q = l.match(/^\*\*"(.+)"\*\*\s*$/);
    if (q) { cur = { quote: q[1], line: i + 1 }; entries.push(cur); return; }
    const f = l.match(/^- (Author|Theme|Context): (.*)$/);
    if (f && cur) (cur as any)[f[1].toLowerCase()] = f[2].trim();
    else if (l.trim() === "" || l.startsWith("#")) cur = null;
  });
  return entries;
}

export function parseThemeIndex(md: string): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  let theme = "";
  for (const l of section(md, "Theme Index").split("\n")) {
    const h = l.match(/^\*\*(.+):\*\*\s*$/);
    if (h) { theme = h[1]; idx.set(theme, []); continue; }
    const item = l.match(/^- (.+)$/);
    if (item && theme) idx.get(theme)!.push(...item[1].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return idx;
}

export function historyRuns(md: string): string[] {
  return [...section(md, "Newsletter Usage History").matchAll(/^### (\d{4}-\d{2}-\d{2})\b/gm)].map((m) => m[1]);
}

export function check(md: string, categories: string[], historySince?: string, db = ""): Report {
  const errors: string[] = [];
  const all = parseEntries(md);
  // Entries live above the Theme Index; usage-history quotes are references, not entries.
  const ti = md.indexOf("\n## Theme Index");
  const tiLine = ti < 0 ? Infinity : md.slice(0, ti).split("\n").length;
  const entries = all.filter((e) => e.line <= tiLine);

  const seen = new Map<string, number>();
  for (const e of entries) {
    for (const k of ["author", "theme", "context"] as const)
      if (!e[k]) errors.push(`line ${e.line}: entry is missing its ${k[0].toUpperCase() + k.slice(1)} line`);
    const key = norm(e.quote);
    if (seen.has(key)) errors.push(`line ${e.line}: exact duplicate of the quote at line ${seen.get(key)}`);
    else seen.set(key, e.line);
  }

  const idx = parseThemeIndex(md);
  if (idx.size === 0) errors.push("no Theme Index section found");
  const authors = [...new Set(entries.map((e) => baseName(e.author ?? "")).filter(Boolean))];
  const matches = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
  const indexed: string[] = [];
  for (const [theme, names] of idx) {
    if (categories.length && !categories.includes(theme))
      errors.push(`Theme Index heading "${theme}" is not a category in SKILL.md § Taxonomy or PREFERENCES.md § Approved categories`);
    for (const n of names) {
      indexed.push(baseName(n));
      if (!authors.some((a) => matches(a, baseName(n))))
        errors.push(`Theme Index "${theme}" names "${n}", who has no entry`);
    }
  }
  for (const a of authors)
    if (!indexed.some((n) => matches(a, n))) errors.push(`author "${a}" has an entry but no Theme Index line`);

  const runs = historyRuns(md);
  if (historySince && !runs.some((d) => d >= historySince))
    errors.push(`Newsletter Usage History has no run dated ${historySince} or later`);

  return { db, entries: entries.length, errors, historyRuns: runs };
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&#39;|&rsquo;|&lsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, "&");

/** Article text from raw HTML: <article>, else <main>, else <body>; script, style and page chrome dropped. */
export async function extractText(html: string): Promise<{ title: string; text: string }> {
  const scopes = ["article", "main", "body"];
  const skip = "script, style, noscript, nav, header, footer, aside, svg, form";
  let title = "";
  for (const scope of scopes) {
    if (!new RegExp(`<${scope}[\\s>]`, "i").test(html)) continue;
    const chunks: string[] = [];
    let depth = 0, skipDepth = 0;
    const rw = new HTMLRewriter()
      .on("title", { text(t) { title += t.text; } })
      .on(scope, { element(el) { depth++; el.onEndTag(() => { depth--; }); } })
      .on(skip, { element(el) { skipDepth++; el.onEndTag(() => { skipDepth--; }); } })
      .on("p, h1, h2, h3, h4, li, blockquote, br, div", { element(el) { if (depth) chunks.push("\n"); } })
      .on("*", { text(t) { if (depth && !skipDepth) chunks.push(t.text); } });
    await rw.transform(new Response(html)).text();
    const text = decode(chunks.join("")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
    if (text.length > 200 || scope === "body") return { title: decode(title).trim(), text };
    title = "";
  }
  return { title: title.trim(), text: "" };
}

function usage(): never {
  console.error("usage: Aphorisms.ts check [--db <path>] [--prefs <path>] [--history-since YYYY-MM-DD] [--json] | fetch <url> | path");
  process.exit(2);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "path") {
    console.log(defaultDbPath());
  } else if (cmd === "check") {
    const db = flag("--db") ?? defaultDbPath();
    const since = flag("--history-since");
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) usage();
    if (!existsSync(db)) { console.error(`no database at ${db}`); process.exit(2); }
    const prefs = flag("--prefs") ?? defaultPrefsPath();
    const categories = [
      ...taxonomyCategories(readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8")),
      ...(existsSync(prefs) ? approvedCategories(readFileSync(prefs, "utf8")) : []),
    ];
    const report = check(readFileSync(db, "utf8"), categories, since, db);
    if (rest.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`${report.db}: ${report.entries} entries, ${report.historyRuns.length} usage-history runs`);
      for (const e of report.errors) console.log(`ERROR ${e}`);
      if (!report.errors.length) console.log("OK");
    }
    process.exit(report.errors.length ? 1 : 0);
  } else if (cmd === "fetch") {
    const url = rest[0];
    if (!url || !/^https?:\/\//.test(url)) usage();
    try {
      const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "LifeOS-Aphorisms/1.0" } });
      if (!res.ok) { console.error(`fetch ${url}: HTTP ${res.status}`); process.exit(3); }
      const { title, text } = await extractText(await res.text());
      if (!text) { console.error(`fetch ${url}: no article text found`); process.exit(3); }
      console.log(`# ${title}\n\n${text}`);
    } catch (e) {
      console.error(`fetch ${url}: ${(e as Error).message}`);
      process.exit(3);
    }
  } else usage();
}
