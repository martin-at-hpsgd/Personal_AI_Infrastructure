/**
 * IsaScope — the one definition of "which ISAs are in scope" for estate-wide
 * eval work (20261010-evals-in-the-isa, F9 M4, ISC-37).
 *
 * A scope spec is a comma list of terms:
 *   projects      every ISA the PROJECTS.md routing table points at, any phase
 *   recent:<N>d   every OPEN ISA (phase not complete/completed/done/archived/retired)
 *                 whose file changed in the last N days
 *
 * The approved M4 scope is `projects,recent:14d` (the principal, 2026-10-10). Results
 * are deduped by realpath, so a PROJECTS.md pointer and a recent hit on the
 * same file are one entry carrying both sources. CompileEstate (which ISAs to
 * compile) and EvalCensus --without-eval (ISC-37's probe) both read scope from
 * here, so the two can never disagree about what "in scope" means.
 *
 * Read-only: this module never writes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getClaudeDir, lifeosPath } from "../Paths.ts";

export type ScopeTerm = { kind: "projects" } | { kind: "recent"; days: number };

/** Phases that mean the ISA is closed. An ISA with no phase is open. */
export const CLOSED_PHASES: ReadonlySet<string> = new Set(["complete", "completed", "done", "archived", "retired"]);

export const DEFAULT_SCOPE = "projects,recent:14d";

/** Parses `projects,recent:14d`. Throws on an unknown or malformed term, so a typo never silently narrows scope. */
export function parseScope(spec: string): ScopeTerm[] {
  const terms = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (!terms.length) throw new Error(`empty scope "${spec}"`);
  return terms.map((t): ScopeTerm => {
    if (t === "projects") return { kind: "projects" };
    const m = /^recent:(\d+)d$/.exec(t);
    if (m && Number(m[1]) > 0) return { kind: "recent", days: Number(m[1]) };
    throw new Error(`unknown scope term "${t}" (expected projects or recent:<N>d)`);
  });
}

/** The ISA roots scanned for recent ISAs. Honours LIFEOS_EVAL_CENSUS_ROOTS (colon list), the same override EvalCensus uses. */
export function scopeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const o = env.LIFEOS_EVAL_CENSUS_ROOTS;
  if (o) return o.split(":").filter(Boolean);
  const home = homedir();
  return [getClaudeDir(), join(home, "Projects"), join(home, "LocalProjects"), lifeosPath("USER")];
}

const SKIP_DIR = /\/(node_modules|LIFEOS_RELEASES|\.git|_ephemeral)\//;

/** Every file matching `pattern` under the roots (default `**\/ISA.md`). Tests pass a fixture pattern. */
export async function discoverIsas(roots: string[], pattern = "**/ISA.md"): Promise<string[]> {
  const out = new Set<string>();
  const glob = new Bun.Glob(pattern);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for await (const p of glob.scan({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false, dot: false })) {
      if (!SKIP_DIR.test(p)) out.add(p);
    }
  }
  return [...out].sort();
}

/** The frontmatter `phase:` value, lowercased, or "" when absent. */
export function phaseOf(text: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const m = /^phase:[ \t]*["']?([^"'\s#]+)/m.exec(fm);
  return (m?.[1] ?? "").toLowerCase();
}

export function isOpen(text: string): boolean {
  return !CLOSED_PHASES.has(phaseOf(text));
}

export interface ProjectRef { project: string; raw: string; path: string; exists: boolean }

/**
 * ISA pointers in the PROJECTS.md routing tables: every backticked path ending
 * in `.md` whose basename is ISA.md (or `*.isa.md`, for fixtures) in a table
 * row's last cell. `~/` resolves against `home`; a relative path against the
 * config root, the convention the table uses for in-tree ISAs.
 */
export function projectIsaRefs(markdown: string, opts: { home?: string; claudeDir?: string } = {}): ProjectRef[] {
  const home = opts.home ?? homedir();
  const claudeDir = opts.claudeDir ?? getClaudeDir();
  const out: ProjectRef[] = [];
  for (const line of markdown.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|\s*:?-{2,}/.test(t)) continue;
    const cells = t.split(/(?<!\\)\|/).slice(1, -1);
    if (cells.length < 2) continue;
    const last = cells[cells.length - 1]!;
    const project = cells[0]!.replace(/\*\*/g, "").trim();
    for (const m of last.matchAll(/`([^`]+?\.md)`/g)) {
      const raw = m[1]!.trim();
      if (!/(^|\/)ISA\.md$|\.isa\.md$/.test(raw)) continue;
      const path = raw.startsWith("~/") ? join(home, raw.slice(2)) : isAbsolute(raw) ? raw : join(claudeDir, raw);
      out.push({ project, raw, path, exists: existsSync(path) });
    }
  }
  return out;
}

export interface ScopeEntry {
  /** The path as found (first source wins). */
  path: string;
  /** realpath, the dedupe key. */
  real: string;
  sources: ("projects" | "recent")[];
  phase: string;
}

export interface ScopeResult {
  entries: ScopeEntry[];
  /** PROJECTS.md pointers whose file does not exist. Reported, never silently dropped. */
  unresolved: ProjectRef[];
}

export interface ResolveOptions {
  projectsMd?: string;
  roots?: string[];
  pattern?: string;
  /** Candidate files for recent:<N>d; skips discovery (tests). */
  files?: string[];
  now?: number;
  home?: string;
  claudeDir?: string;
}

const DAY_MS = 86_400_000;

/** The ISAs a scope spec names, deduped by realpath, sorted by path. */
export async function resolveScope(spec: string, opts: ResolveOptions = {}): Promise<ScopeResult> {
  const terms = parseScope(spec);
  const now = opts.now ?? Date.now();
  const byReal = new Map<string, ScopeEntry>();
  const unresolved: ProjectRef[] = [];
  const add = (path: string, source: "projects" | "recent") => {
    const real = realpathSync(path);
    const hit = byReal.get(real);
    if (hit) { if (!hit.sources.includes(source)) hit.sources.push(source); return; }
    byReal.set(real, { path, real, sources: [source], phase: phaseOf(readFileSync(path, "utf8")) });
  };
  for (const term of terms) {
    if (term.kind === "projects") {
      const md = opts.projectsMd ?? lifeosPath("USER", "PROJECTS.md");
      if (!existsSync(md)) throw new Error(`PROJECTS.md not found at ${md}`);
      for (const ref of projectIsaRefs(readFileSync(md, "utf8"), { home: opts.home, claudeDir: opts.claudeDir })) {
        if (ref.exists) add(ref.path, "projects");
        else unresolved.push(ref);
      }
    } else {
      const files = opts.files ?? (await discoverIsas(opts.roots ?? scopeRoots(), opts.pattern));
      const cutoff = now - term.days * DAY_MS;
      for (const f of files) {
        if (!existsSync(f)) continue;
        if (statSync(f).mtimeMs < cutoff) continue;
        if (!isOpen(readFileSync(f, "utf8"))) continue;
        add(f, "recent");
      }
    }
  }
  return { entries: [...byReal.values()].sort((a, b) => a.path.localeCompare(b.path)), unresolved };
}

/**
 * Uncommitted state of one file in its git repo: "clean", "dirty" (modified,
 * staged or untracked: somebody's in-flight work), or "no-repo".
 */
export function gitState(path: string): "clean" | "dirty" | "no-repo" {
  const r = spawnSync("git", ["-C", dirname(resolve(path)), "status", "--porcelain", "--", basename(path)], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0) return "no-repo";
  return r.stdout.trim() ? "dirty" : "clean";
}

/** A Test Strategy row as the parser's `probes` list carries it (valid rows only; invalid rows never reach it). */
export interface CoverageRow { isc: string; type: string; anchors_to?: string }

/**
 * The one definition of "this criterion has an eval" (ISC-37). A criterion has
 * an eval when a valid Test Strategy row whose type is not `manual` names it,
 * directly or through `anchors_to`, or when an `## Evals` block is keyed by it.
 * A manual row is a label owed, never an eval (system prompt 4.3.0), and an
 * invalid row never reaches `probes`. Compile's planCriteria (what still needs
 * compiling) and EvalCensus --without-eval (ISC-37's probe) both read this, so
 * the work list and the probe can never disagree. Read-only.
 */
export function idsWithEval(probes: readonly CoverageRow[], evalIds: Iterable<string>): Set<string> {
  const has = new Set<string>();
  for (const p of probes) {
    if (p.type === "manual") continue;
    if (p.isc) has.add(p.isc);
    if (p.anchors_to) has.add(p.anchors_to.replace(/^(?:derived|cross)\s*:\s*/i, "").trim());
  }
  for (const id of evalIds) has.add(id);
  return has;
}
