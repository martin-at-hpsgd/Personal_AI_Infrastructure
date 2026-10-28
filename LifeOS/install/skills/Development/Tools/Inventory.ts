#!/usr/bin/env bun
/**
 * Inventory — deterministic list of every surface an application exposes, and
 * a sync check of that list against the app's ISA.
 *
 *   bun Inventory.ts <repo> [--json]            list surfaces
 *   bun Inventory.ts sync <repo> <isa> [--json] surfaces no criterion names,
 *                                               and probes whose files are missing
 *
 * Surface kinds: route (HTTP handlers), command (CLI subcommands and package
 * bins), script (package.json scripts), table (SQL CREATE TABLE), test (test
 * files). Reads JavaScript/TypeScript, SQL and package.json only. Read-only;
 * never writes to the repo or the ISA.
 *
 * Exit codes: 0 clean, 1 sync found gaps, 2 bad input.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseTestStrategy, probeCwdOf } from "../../../LIFEOS/TOOLS/lib/IsaTestStrategy";

export type SurfaceKind = "route" | "command" | "script" | "table" | "test";
export const SURFACE_KINDS: readonly SurfaceKind[] = ["route", "command", "script", "table", "test"];

/**
 * What this inventory cannot see. Printed on every run so "no gaps" is never
 * read as "everything is covered" — these surfaces need criteria found by hand.
 */
export const UNCOVERED_KINDS = [
  "code in languages other than JavaScript/TypeScript",
  "file-based routes (Next.js, SvelteKit, Astro pages) and mounted sub-router prefixes",
  "UI pages and components",
  "scheduled triggers (cron, launchd)",
  "queue consumers and webhooks",
  "middleware and auth rules",
  "environment-driven branches",
  "MCP tools and non-HTTP protocols",
] as const;

export interface Surface {
  kind: SurfaceKind;
  /** The name a criterion would use: "GET /api/lots", "deploy", "lots", "test/lots.test.ts". */
  id: string;
  file: string;
  line: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".wrangler", ".next", "coverage", ".turbo", "out"]);
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(\.|_)(test|spec)\.(ts|tsx|js|jsx|mjs)$/;

/** Regular files only. Symlinks are skipped: a dangling link or a loop must not kill the run. */
function walk(root: string, dir = root, out: string[] = []): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(abs); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile() && st.size < 2_000_000) out.push(relative(root, abs));
  }
  return out;
}

/**
 * Blank out comments, keeping string contents and newlines so indexes and line
 * numbers still line up. A commented-out `app.get("/old")` is not a live route.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += n ?? ""; i += 2; continue; }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && n === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Hono / Express / itty style: app.get("/x", …), router.post('/y', …).
const ROUTE_RE = /\.(get|post|put|patch|delete|all)\(\s*(['"`])(\/[^'"`\s]*)\2/g;
const TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
const ARGV = String.raw`(?:process|Bun)\.argv`;

/** Identifiers that hold the subcommand: bound straight from argv, or from an args array sliced off argv. */
function subcommandVars(src: string): string[] {
  const vars = new Set<string>();
  const arrays = new Set<string>();
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${ARGV}\.slice\(`, "g"))) arrays.add(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+\[\s*(\w+)[^\]]*\]\s*=\s*${ARGV}\.slice\(`, "g"))) vars.add(m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${ARGV}\[\s*\d+\s*\]`, "g"))) vars.add(m[1]);
  for (const a of arrays) {
    for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(\w+)\s*=\s*${a}\[\s*0\s*\]`, "g"))) vars.add(m[1]);
    for (const m of src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+\[\s*(\w+)[^\]]*\]\s*=\s*${a}\b`, "g"))) vars.add(m[1]);
  }
  return [...vars];
}

/** Index of the brace that closes the one opening at `open`, skipping strings. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return src.length;
}

const COMMAND_NAME = /^[a-z][a-z0-9:_-]*$/;

/** Subcommands compared against an argv-bound variable: `cmd === "x"` chains and `switch (cmd)` blocks. */
function commandsIn(src: string): { id: string; index: number }[] {
  const found: { id: string; index: number }[] = [];
  for (const v of subcommandVars(src)) {
    const cmpA = new RegExp(String.raw`\b${v}\s*===?\s*(['"])([^'"]+)\1`, "g");
    const cmpB = new RegExp(String.raw`(['"])([^'"]+)\1\s*===?\s*${v}\b`, "g");
    for (const re of [cmpA, cmpB]) for (const m of src.matchAll(re)) found.push({ id: m[2], index: m.index! });
    for (const m of src.matchAll(new RegExp(String.raw`switch\s*\(\s*${v}\s*\)\s*\{`, "g"))) {
      const open = m.index! + m[0].length - 1;
      const body = src.slice(open, matchBrace(src, open));
      for (const c of body.matchAll(/case\s+(['"])([^'"]+)\1\s*:/g)) found.push({ id: c[2], index: open + c.index! });
    }
  }
  return found.filter((f) => COMMAND_NAME.test(f.id));
}

export function inventory(repo: string): Surface[] {
  const root = resolve(repo);
  const surfaces: Surface[] = [];
  const add = (s: Surface) => {
    if (!surfaces.some((x) => x.kind === s.kind && x.id === s.id && x.file === s.file)) surfaces.push(s);
  };

  for (const file of walk(root)) {
    const abs = join(root, file);
    if (TEST_FILE.test(file)) {
      add({ kind: "test", id: file, file, line: 1 });
      continue;
    }
    if (basename(file) === "package.json") {
      const text = readFileSync(abs, "utf8");
      let pkg: any;
      try { pkg = JSON.parse(text); } catch { continue; }
      for (const name of Object.keys(pkg.scripts ?? {})) {
        add({ kind: "script", id: name, file, line: lineOf(text, text.indexOf(`"${name}"`)) });
      }
      const bins = typeof pkg.bin === "string" ? { [pkg.name ?? basename(root)]: pkg.bin } : pkg.bin ?? {};
      for (const name of Object.keys(bins)) {
        add({ kind: "command", id: name, file, line: lineOf(text, text.indexOf(`"${name}"`)) });
      }
      continue;
    }
    const isCode = CODE_EXT.test(file);
    const isSql = file.endsWith(".sql");
    if (!isCode && !isSql) continue;
    const raw = readFileSync(abs, "utf8");
    const text = isCode ? stripComments(raw) : raw.replace(/--[^\n]*/g, (m) => " ".repeat(m.length));

    for (const m of text.matchAll(TABLE_RE)) {
      add({ kind: "table", id: m[1], file, line: lineOf(text, m.index!) });
    }
    if (!isCode) continue;
    for (const m of text.matchAll(ROUTE_RE)) {
      const method = m[1] === "all" ? "ANY" : m[1].toUpperCase();
      add({ kind: "route", id: `${method} ${m[3]}`, file, line: lineOf(text, m.index!) });
    }
    for (const c of commandsIn(text)) add({ kind: "command", id: c.id, file, line: lineOf(text, c.index) });
  }
  return surfaces.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

// ── sync ─────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What in the ISA counts as naming a surface. Only criteria and Test Strategy
 * rows count, never prose: a Vision paragraph that says "deploy" does not
 * cover the `deploy` script.
 */
export interface Corpus {
  /** Criterion lines plus Test Strategy rows. */
  criteria: string;
  /** Backtick spans in criterion lines, plus every Test Strategy tool cell. */
  code: string;
}

export function corpusOf(isaPath: string): Corpus {
  const lines = readFileSync(isaPath, "utf8").split("\n").filter((l) => /^\s*-\s*\[[ xX]\]/.test(l));
  const probes = parseTestStrategy(isaPath);
  const spans = lines.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  return {
    criteria: [...lines, ...probes.map((p) => `${p.check} ${p.tool}`)].join("\n"),
    code: [...spans, ...probes.map((p) => p.tool)].join("\n"),
  };
}

/**
 * A route is named by method and path together ("POST /api/lots"), so a criterion
 * about GET never covers POST. A test by its repo-relative path. A script,
 * command or table by its name inside code (a backtick span or a probe), since
 * names like `build` and `deploy` are ordinary English words.
 */
export function covers(s: Surface, c: Corpus): boolean {
  if (s.kind === "route") {
    const [method, path] = s.id.split(" ");
    const lead = method === "ANY" ? "" : String.raw`\b${method}\s+`;
    return new RegExp(`${lead}${esc(path)}(?![A-Za-z0-9_/-])`).test(c.criteria);
  }
  const bounded = (id: string) => new RegExp(`(^|[^A-Za-z0-9_-])${esc(id)}(?![A-Za-z0-9_-])`, "m");
  if (s.kind === "test") return bounded(s.id).test(c.criteria);
  return bounded(s.id).test(c.code);
}

// Paths a probe command points at: tokens with a slash or a code/script extension, outside quotes.
const PATH_TOKEN = /(?:\.{0,2}\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.(?:ts|tsx|js|mjs|sh|sql|json|md)\b/g;

export interface MissingProbeTarget {
  isc: string;
  path: string;
}

export interface SyncReport {
  repo: string;
  isa: string;
  surfaces: number;
  unreferenced: Surface[];
  missingProbeTargets: MissingProbeTarget[];
  uncoveredKinds: string[];
}

/**
 * Expands `$HOME`, `~/` and variables the command assigns itself (`A=$HOME/x; rg … $A/y.ts`), and
 * drops a path that starts with a variable it cannot resolve, so `$A/Workers/x.ts` is never read
 * as a missing `A/Workers/x.ts` (29 false reports on one app's ISA, 2026-10-10).
 */
export function expandVars(cmd: string, home = homedir()): string {
  const vars: Record<string, string> = { HOME: home };
  const sub = (s: string) => s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (_all, n: string) => vars[n] ?? "\u0000");
  for (const m of cmd.matchAll(/(?:^|[;&|\s])([A-Za-z_]\w*)=([^\s;&|]+)/g)) vars[m[1]] = sub(m[2]);
  return sub(cmd)
    .replace(/(^|\s)~\//g, (_all, pre: string) => `${pre}${home}/`)
    .replace(/\S*\u0000\S*/g, " ");
}

export function sync(repo: string, isaPath: string): SyncReport {
  const root = resolve(repo);
  const isa = resolve(isaPath);
  const corpus = corpusOf(isa);
  const surfaces = inventory(root);
  const unreferenced = surfaces.filter((s) => !covers(s, corpus));

  // Probes run from the ISA's probe_cwd, so relative paths resolve there first.
  const probeCwd = probeCwdOf(isa);
  const missingProbeTargets: MissingProbeTarget[] = [];
  for (const probe of parseTestStrategy(isa)) {
    if (probe.type === "manual" || probe.tool.startsWith("suite:") || probe.tool.startsWith("glance:")) continue;
    // Quoted text is a search pattern or a message, not a path the probe opens.
    const unquoted = expandVars(probe.tool.replace(/`/g, "").replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, " "));
    for (const m of unquoted.matchAll(PATH_TOKEN)) {
      const p = m[0];
      const candidates = isAbsolute(p) ? [p] : [join(probeCwd, p), join(root, p)];
      if (!candidates.some((c) => existsSync(c))) missingProbeTargets.push({ isc: probe.isc, path: p });
    }
  }
  return { repo: root, isa, surfaces: surfaces.length, unreferenced, missingProbeTargets, uncoveredKinds: [...UNCOVERED_KINDS] };
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  if (args[0] === "sync") {
    const [, repo, isa] = args;
    if (!repo || !isa || !existsSync(repo) || !existsSync(isa)) {
      console.error("usage: Inventory.ts sync <repo> <isa> [--json]");
      return 2;
    }
    const r = sync(repo, isa);
    if (json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${r.surfaces} surfaces · ${r.unreferenced.length} with no criterion · ${r.missingProbeTargets.length} probes pointing at missing files`);
      for (const s of r.unreferenced) console.log(`  no ISC     ${s.kind.padEnd(7)} ${s.id}  (${s.file}:${s.line})`);
      for (const m of r.missingProbeTargets) console.log(`  missing    ${m.isc.padEnd(7)} ${m.path}`);
      console.log(`not inventoried (check by hand): ${r.uncoveredKinds.join("; ")}`);
    }
    return r.unreferenced.length || r.missingProbeTargets.length ? 1 : 0;
  }
  const repo = args[0];
  if (!repo || !existsSync(repo) || !lstatSync(resolve(repo)).isDirectory()) {
    console.error("usage: Inventory.ts <repo> [--json] | sync <repo> <isa> [--json]");
    return 2;
  }
  const surfaces = inventory(repo);
  if (json) console.log(JSON.stringify({ repo: resolve(repo), surfaces, uncoveredKinds: UNCOVERED_KINDS }, null, 2));
  else {
    for (const kind of SURFACE_KINDS) {
      const of = surfaces.filter((s) => s.kind === kind);
      if (!of.length) continue;
      console.log(`${kind} (${of.length})`);
      for (const s of of) console.log(`  ${s.id}  ${s.file}:${s.line}`);
    }
    console.log(`not inventoried (check by hand): ${UNCOVERED_KINDS.join("; ")}`);
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
