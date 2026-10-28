#!/usr/bin/env bun
/**
 * @version 1.6.0
 */
// SkillHygieneGate.ts — deterministic code/data-separation gate for the skills tree.
//
// Verdict: is every skill (public AND private) publishable-clean code — no identity
// strings, no home paths, no vendored deps in git — with sensitive data living under
// LIFEOS/USER/ instead of inside the skill? And does every SKILL.md run the one way
// skills run — frontmatter limited to the permitted descriptive keys (§ Frontmatter
// allowlist below), with no key that changes how the harness runs that one skill?
//
// "Dirty" is defined by the install-local canonical deny-list;
// this gate never forks that pattern set, so skill-clean ≡ release-clean by
// construction. Private skills reference LIFEOS/USER/ paths freely — that's the
// pattern, not a violation (the deny-list contains no LIFEOS/USER path patterns).
//
// Allowlist: LIFEOS/TOOLS/skill-hygiene-allowlist.json — file or dir-prefix entries,
// each with a reason. Entries are reviewed additions, never a bulk escape hatch.
// PATTERN_ALLOWLIST_FILES from hooks/lib/containment-zones.ts is honored too (those
// files embed patterns in order to detect them).
//
// Exit codes: 0 clean · 1 violations · 2 scan error or cannot-verify (a broken gate
// never reads as clean). With no deny artifacts at all, the generic checks (home-path
// shapes, release scrub patterns, tracked vendored deps) still run; zero hits then
// exits 2 "deny list absent: only generic checks ran" unless --no-deny-list declares
// that this install has none, which turns that state into a qualified exit 0.
// The scan set is every file under skills/ except the machine-local runtime dirs below: hidden files and gitignored files
// are scanned (rg --hidden --no-ignore), and a symlink whose target the scan would never read is itself a violation.
// The git-backed checks (tracked vendored deps, shipped backends) must run: a git failure exits 2, never a quiet skip. Two
// declarations turn "not a git repository" into a labelled skip: --root <dir> (a copy or fixture tree) and --no-git (an
// install that is not a checkout). Any other git failure (git missing, bad output, a real error) exits 2 either way.
// Usage: bun SkillHygieneGate.ts [--json] [--skill _NAME] [--root <dir>] [--max-detail N] [--no-deny-list] [--no-git]
//
// Frontmatter violations are never allowlisted: the one exception (disallowed-tools holding
// a skill read-only) is a rule in code, not a path entry.
//
// Consumed by: IntegrityCheck.ts (/ic check "skill-hygiene"), sweep intents, CreateSkill
// pre-flight. Report-only by design — this tool never modifies a file.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PATTERN_ALLOWLIST_FILES } from "../../hooks/lib/containment-zones";
import { confinedPath } from "./lib/Boundary";
import { getClaudeDir, lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const skillFilter = args.includes("--skill") ? args[args.indexOf("--skill") + 1] : null;
const rootArg = args.includes("--root") ? args[args.indexOf("--root") + 1] : null;
const maxDetail = args.includes("--max-detail") ? parseInt(args[args.indexOf("--max-detail") + 1], 10) : 8;
const declaredNoDenyList = args.includes("--no-deny-list");
const declaredNoGit = args.includes("--no-git");

const CLAUDE_DIR = rootArg ?? getClaudeDir();
const SKILLS_DIR = join(CLAUDE_DIR, "skills");
const DENY_LIST_PATH = lifeosPath("USER", "SECURITY", "DENY_LIST.txt");
// Allowlist lives in the USER tree: every entry names a private `_*` skill path,
// and one entry (the customer skill) contains a deny-listed token — so the file is
// install-local, must be release-excluded, and SystemFileGuard must permit it to
// hold identity strings. All three hold only under LIFEOS/USER/.
const ALLOWLIST_PATH = join(CLAUDE_DIR, "LIFEOS", "USER", "CONFIG", "skill-hygiene-allowlist.json");
// Bare-name patterns (v1.3.0, 2026-08-28 skill-separation audit): the deny-list
// deliberately omits the principal's plain full name (it is sanctioned public
// attribution in shipped README/Fabric content, so listing it there would flood
// the release gates). Inside skills/ though, a plain-name literal is exactly the
// class this gate exists to catch — a default arg value carrying the principal's
// name passed the gate CLEAN while violating publishable-clean. This file is a
// gate-scoped pattern set: identity DATA, USER-resident, never shipped; consumed
// ONLY here, so release-gate behavior is untouched. Allowlist entries with
// scope:"names" suppress ONLY this class (attribution-by-design files), never
// deny-list hits — a blanket dir allowlist would weaken the existing control.
const NAME_PATTERNS_PATH = lifeosPath("USER", "SECURITY", "SkillNamePatterns.txt");

// Machine-local runtime dirs — never shipped (containment zone skill-runtime-data),
// regenerated on use, scanning them is noise. Tracked data/state dirs ARE scanned:
// tracked state with identity is exactly the class this gate exists to relocate.
const EXCLUDE_GLOBS = ["!**/.git/**", "!**/node_modules/**", "!**/.playwright-cli/**", "!**/profile-data/**", "!**/.cache/**", "!**/*.png", "!**/*.jpg", "!**/*.mp3", "!**/*.mp4"];
// The excluded runtime dirs as names, read from EXCLUDE_GLOBS: the symlink walk does not look for links inside them.
// Whether a link's TARGET is scanned is never judged from these names; it is judged against ripgrep's own file list (S104).
const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set(EXCLUDE_GLOBS.filter((g) => g.startsWith("!**/") && g.endsWith("/**")).map((g) => g.slice(4, -3)));

interface Violation { file: string; line: number; pattern: string; excerpt: string }
interface AllowEntry { path: string; reason: string; added: string; scope?: "all" | "names" }

function fail(msg: string): never {
  if (jsonOutput) console.log(JSON.stringify({ ok: false, exitCode: 2, error: msg }));
  else console.error(`SCAN ERROR: ${msg}`);
  process.exit(2);
}

// "present": the plaintext deny-list was loaded. "absent": no deny artifact exists, so
// only the generic patterns below are in the set and identity coverage is unverified.
type DenyCoverage = "present" | "absent";

function loadDenyPatterns(): { patterns: string[]; coverage: DenyCoverage } {
  // The deny-list is identity DATA and lives under LIFEOS/USER/ (2026-07-25
  // relocation — it was inside private maintenance tooling, reached across the boundary by
  // this public tool). USER/ is rebuilt from templates at release, so on a tree
  // with no personal data the file is legitimately absent: there is nothing to
  // deny yet. The generic checks still run; the verdict says identity coverage is
  // unverified (exit 2) unless --no-deny-list declares the install has none.
  let patterns: string[] = [];
  let coverage: DenyCoverage = "present";
  if (!existsSync(DENY_LIST_PATH)) {
    // "No plaintext deny-list" is NOT the same as "no personal data": a
    // hash-only deny surface (DENY_HASHES.json) can exist alone, meaning
    // personal data IS protected elsewhere and this gate simply cannot
    // verify. Fail loud in that state instead of certifying cleanliness.
    // (public issue #1833, @xmasyx)
    const hashesPath = lifeosPath("USER", "SECURITY", "DENY_HASHES.json");
    if (existsSync(hashesPath)) {
      if (jsonOutput) console.log(JSON.stringify({ ok: false, skipped: true, error: `DENY_HASHES.json exists but DENY_LIST.txt is absent — personal data exists and this gate cannot scan without the plaintext list` }));
      else console.error(`CANNOT VERIFY: ${hashesPath} exists but DENY_LIST.txt is absent — personal data exists on this tree and this gate cannot scan without the plaintext list. Restore DENY_LIST.txt or run the hash-based guard.`);
      process.exit(1);
    }
    coverage = "absent";
    if (!jsonOutput) console.error(`NOTE: no deny-list at ${DENY_LIST_PATH} and no DENY_HASHES.json — running generic checks only (home paths, scrub patterns, vendored deps).`);
  } else {
    patterns = readFileSync(DENY_LIST_PATH, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#"));
    if (patterns.length < 20) fail(`deny-list suspiciously small (${patterns.length} patterns) — refusing to scan against a truncated list`);
  }
  // Home-path shape patterns: ANY user-home literal is machine-bound and
  // unpublishable, beyond the principal-specific one the deny-list carries.
  // (?-i) keeps these case-sensitive inside the -i scan — macOS home paths are
  // literally "/Users/"; without it, generic REST-ish segments like
  // "orgs/projects/users/billing" false-positive (hit live on ISA/Examples).
  patterns.push(String.raw`(?-i)/Users/[a-z][a-z0-9_-]+/`, String.raw`(?-i)/home/[a-z][a-z0-9_-]+/`);
  // Release scrub patterns (LIFEOS/USER/SECURITY/PublicScrubPatterns.txt) are the
  // OTHER half of release-clean: PublicPushGate scans pushes against them, so a
  // skill that only passed the deny-list could still be blocked at push time.
  // Folding them in here keeps "skill-clean ≡ release-clean" true by construction
  // (2026-08-24: a new skill passed this gate, then needed a separate scrub grep
  // to call it release-safe — one gate must answer both). Absent file = additive
  // set not present on this install; the deny-list scan above still ran.
  const scrubPath = lifeosPath("USER", "SECURITY", "PublicScrubPatterns.txt");
  if (existsSync(scrubPath)) {
    const scrub = readFileSync(scrubPath, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith("#"));
    for (const p of scrub) if (!patterns.includes(p)) patterns.push(p);
  }
  return { patterns, coverage };
}

function loadAllowlist(): AllowEntry[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
    if (!Array.isArray(parsed)) fail("allowlist is not an array");
    return parsed;
  } catch (e: any) { fail(`allowlist unreadable: ${e.message}`); }
}

// path entries are repo-relative; a trailing "/" means dir-prefix.
function pathMatches(relPath: string, a: AllowEntry): boolean {
  return a.path.endsWith("/") ? relPath.startsWith(a.path) : relPath === a.path;
}
// Deny-list class: only unscoped/"all" entries apply — a names-scoped entry must
// never suppress a deny-list hit.
function isAllowed(relPath: string, allow: AllowEntry[]): boolean {
  if (PATTERN_ALLOWLIST_FILES.includes(relPath)) return true;
  return allow.some(a => (a.scope ?? "all") === "all" && pathMatches(relPath, a));
}
// Name class: any entry (names-scoped or general) applies.
function isAllowedName(relPath: string, allow: AllowEntry[]): boolean {
  if (PATTERN_ALLOWLIST_FILES.includes(relPath)) return true;
  return allow.some(a => pathMatches(relPath, a));
}

function loadNamePatterns(): string[] {
  if (!existsSync(NAME_PATTERNS_PATH)) return []; // absent = additive set not present; reported in output
  return readFileSync(NAME_PATTERNS_PATH, "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"));
}

// The ripgrep flags that decide WHICH files the content scan reads. The scan and the symlink check both take
// them from here, so the set the symlink check trusts is the set ripgrep actually walks (S104).
// The skill include MUST precede the excludes: ripgrep applies -g in order, last match wins, so a positive
// `_SKILL/**` after `!**/node_modules/**` would re-include the skill's on-disk deps (the 2026-07-23 --skill
// broadcast skill false-positive).
function scanSetArgs(only: string | null): string[] {
  const a = ["--hidden", "--no-ignore"];
  if (only) a.push("-g", `${only}/**`);
  for (const g of EXCLUDE_GLOBS) a.push("-g", g);
  return a;
}

/** skills/-relative paths of every file the content scan reads: ripgrep's own walk with the scan's flags, never a reconstruction of it (S104). */
export function scannedFiles(skillsDir: string, only: string | null): Set<string> {
  let out = "";
  try {
    out = execFileSync("rg", ["--files", ...scanSetArgs(only), "."], { cwd: skillsDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    if (e.status !== 1) throw new Error(`rg --files failed, so the scanned set is unknown: ${String(e?.stderr || e?.message || "").trim().slice(0, 200)}`);
  }
  return new Set(out.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, "")));
}

function runRg(patternFile: string, patternTag = "deny-list"): Violation[] {
  // --hidden --no-ignore: dotfiles (.claude-plugin/, .claude/types/) and gitignored files are part of the scan set; only the
  // machine-local runtime dirs in EXCLUDE_GLOBS are left out.
  // --binary: a file with a NUL byte is still searched. Without it ripgrep's walk drops binary files silently while
  // `rg --files` (the scanned set the symlink check trusts) lists them, so private text in one passed as scanned (S104).
  const rgArgs = ["-i", "--binary", ...scanSetArgs(skillFilter), "--no-heading", "-n", "--with-filename", "-f", patternFile, "."];
  let out = "";
  try {
    out = execFileSync("rg", rgArgs, { cwd: SKILLS_DIR, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e: any) {
    if (e.status === 1) return []; // rg: no matches
    fail(`rg failed: ${e.message}`);
  }
  const violations: Violation[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // A binary file reports one line with no line number: `<path>: binary file matches (found "\0" byte ...)`.
    const bin = line.match(/^(.+?): binary file matches \(/);
    if (bin) {
      violations.push({ file: bin[1].replace(/^\.\//, ""), line: 1, pattern: patternTag, excerpt: `${patternTag} match in a binary file (content withheld)` });
      continue;
    }
    // [\s\S]: a matched line may hold a \r (a CRLF file) or U+2028, which `.` refuses, and the match was then dropped.
    const m = line.match(/^(.+?):(\d+):[\s\S]*$/);
    // Any other line is a match the gate cannot place: cannot-verify, never a silent pass, and never echoed (S105).
    if (!m) fail("rg printed a line the gate cannot read, so a match may be unreported (content withheld)");
    const file = m[1].replace(/^\.\//, "");
    // The matched line is the private content this gate exists to keep from spreading: report where and
    // which class, never the text (S105). The reader opens file:line.
    violations.push({ file, line: parseInt(m[2], 10), pattern: patternTag, excerpt: `${patternTag} match (line content withheld)` });
  }
  return violations;
}

// Vendored dependencies tracked in git are a structural violation (deps are
// installed, never committed). Disk-only node_modules is fine (runtime artifact).
/** Whether the git-backed checks ran: "ran", or "skipped-declared" when --root/--no-git declared a tree that is not a checkout. */
let gitChecks: "ran" | "skipped-declared" = "ran";

/** Why a git failure may be a labelled skip: only "not a git repository", and only on a tree declared as a copy (--root) or non-checkout (--no-git). */
export function gitFailureIsDeclaredSkip(stderr: string, declaredTree: boolean): boolean {
  return declaredTree && /not a git repository/i.test(stderr);
}

/** `git ls-files` for a path under skills/, or null when the tree is declared not to be a checkout. Any other failure exits 2. */
function gitTracked(pathspec: string, flags: string[] = []): string | null {
  if (declaredNoGit) { gitChecks = "skipped-declared"; return null; }
  try {
    return execFileSync("git", ["-C", CLAUDE_DIR, "ls-files", ...flags, "--", pathspec], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    const stderr = String(e?.stderr ?? "");
    if (gitFailureIsDeclaredSkip(stderr, rootArg !== null)) { gitChecks = "skipped-declared"; return null; }
    return fail(`git ls-files failed, so tracked-dependency and shipped-backend checks did not run: ${(stderr || e?.message || "unknown error").toString().trim().slice(0, 200)} (a tree that is not a checkout is declared with --no-git)`);
  }
}

function trackedVendoredDeps(): string[] {
  const out = gitTracked("skills/");
  if (out === null) return [];
  {
    const dirs = new Set<string>();
    for (const f of out.split("\n")) {
      const i = f.indexOf("/node_modules/");
      if (i > 0) dirs.add(f.slice(0, i + "/node_modules".length));
    }
    return [...dirs];
  }
}

// A skill's Setup.md tells the reader how to build its backend; the backend itself never
// ships in the skill: a setup guide is instructions for what to build, never the built
// thing itself. The class is "a deployable
// service package", detected by the files that make one deployable, never by skill name.
const BACKEND_PACKAGE = /(^|\/)(wrangler\.(toml|jsonc?)|cloudflare\.config\.ts|Dockerfile|(docker-)?compose\.ya?ml)$|(^|\/)migrations\/[^/]+\.sql$/;
export function backendPackageFiles(paths: readonly string[]): string[] {
  return paths.filter(p => BACKEND_PACKAGE.test(p));
}

/** skills/-relative paths of the symlinks git tracks (mode 120000), or null when the git checks are declared skipped. */
function trackedSymlinkPaths(): Set<string> | null {
  const out = gitTracked(skillFilter ? `skills/${skillFilter}/` : "skills/", ["-s"]);
  if (out === null) return null;
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    const m = line.match(/^120000 \S+ \d\t(.+)$/);
    if (m) set.add(m[1].replace(/^skills\//, ""));
  }
  return set;
}

function shippedBackendViolations(): Violation[] {
  const out = gitTracked(skillFilter ? `skills/${skillFilter}/` : "skills/");
  if (out === null) return [];
  return backendPackageFiles(out.split("\n").filter(Boolean)).map(f => ({
    file: f.replace(/^skills\//, ""), line: 1, pattern: "shipped-backend",
    excerpt: "deployable backend inside a skill: describe it in Setup.md, keep the package under LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<Name>/",
  }));
}

// A symlink is scanned by nothing: rg does not follow it, so a link to a file outside skills/ (or to nothing) carries content
// the gate never read. A link inside skills/ passes only when everything it reaches is in the set ripgrep actually walked
// this run (`scanned`, from scannedFiles with the scan's own flags and globs), so --skill scope, excluded runtime dirs and
// media globs that prune whole directories all count exactly as the scan applies them (S104). A link git does not track
// (a gitignored local link into USER data, the sanctioned pattern) never ships, so with git available only tracked links count;
// without it (declared non-checkout) every link counts. `tracked` holds skills/-relative paths of tracked symlinks, or null.
export function unscannedSymlinks(dirArg: string, only: string | null, tracked: ReadonlySet<string> | null = null, scanned: ReadonlySet<string> = scannedFiles(dirArg, only)): Violation[] {
  // Absolute before anything is joined: every link path below already carries this prefix, and a relative prefix
  // would be resolved against the root a second time by confinedPath (final review, :319).
  const skillsDir = resolve(dirArg);
  const root = confinedPath(skillsDir, ".");
  if (root === null) throw new Error(`skills dir cannot be resolved: ${skillsDir}`);
  /** Why the scan never reads what this link reaches, or null when it reads all of it. */
  const unscannedBecause = (link: string): string | null => {
    if (!existsSync(link)) return "dangling symlink: its content cannot be scanned";
    const real = confinedPath(skillsDir, link);
    if (real === null) return "symlink points outside skills/: its content is never scanned; copy the content in or remove the link";
    let listed: string[];
    try {
      // A file target is itself; a directory target is every file it reaches, listed by ripgrep with no globs and
      // --follow, so a link nested anywhere under it is walked too (into an excluded dir, outside skills/, or to
      // nothing: a dangling or looping nested link makes ripgrep fail, and that is a violation, never a pass).
      listed = statSync(real).isDirectory()
        ? execFileSync("rg", ["--files", "--hidden", "--no-ignore", "--follow", "."], { cwd: real, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
            .split("\n").filter(Boolean).map((f) => join(real, f))
        : [real];
    } catch (e: any) {
      if (e?.status === 1 && !String(e?.stderr ?? "").trim()) return null; // an empty directory reaches nothing unscanned
      return "symlink target cannot be fully read (a nested link is dangling, looping or unreadable): its content cannot be scanned";
    }
    // Each file is judged by where it physically is, every nested link resolved by Boundary, never by the path
    // ripgrep walked to reach it: that path runs through links the scan itself never follows (S104).
    const reached: string[] = [];
    for (const f of listed) {
      const phys = confinedPath(skillsDir, f);
      if (phys === null) return "symlink reaches content outside skills/ through a nested link: it is never scanned; copy the content in or remove the link";
      reached.push(relative(root, phys));
    }
    if (reached.every((f) => scanned.has(f))) return null;
    if (only && confinedPath(join(skillsDir, only), link) === null) return "symlink points outside the --skill scope: this run never scans its target; copy the content in or remove the link";
    return "symlink points at content the scan excludes (a runtime dir or media glob): it is never scanned; copy the content in or remove the link";
  };
  const out: Violation[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const why = unscannedBecause(full);
        if (why !== null && (tracked === null || tracked.has(relative(skillsDir, full)))) out.push({ file: relative(skillsDir, full), line: 1, pattern: "symlink-unscanned", excerpt: why });
      } else if (e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name)) walk(full);
    }
  };
  walk(only ? join(skillsDir, only) : skillsDir);
  return out;
}

// ── Frontmatter allowlist ──────────────────────────────────────────────────────────────
// Every skill runs the same way: inline, through the Skill tool, in the conversation that
// invoked it (principal, 2026-10-11: no "strange stuff" in skills). So SKILL.md frontmatter
// carries only keys that DESCRIBE the skill. Any other top-level key fails — context,
// background, disable-model-invocation, allowed-tools, effort, model, user-invocable, hooks,
// and whatever the harness adds next — because the class is "not on the allowlist", never a
// list of today's offenders. The one control key kept is disallowed-tools, and only when it
// denies Edit and Write: it holds an analysis skill read-only, and removing it would weaken a
// control. Doctrine: LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § Frontmatter.
export const PERMITTED_SKILL_KEYS: readonly string[] = ["name", "description", "version", "metadata", "evals", "argument-hint", "license"];
export const READ_ONLY_KEY = "disallowed-tools";
export const READ_ONLY_TOOLS: readonly string[] = ["Edit", "Write"];

export interface FrontmatterProblem { line: number; key: string; reason: string }

/** Whether a parsed disallowed-tools value denies both Edit and Write: a list's entries, or a scalar's comma or space separated words. */
function deniesReadOnlyTools(value: unknown): boolean {
  const tools = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[\s,]+/) : [];
  return READ_ONLY_TOOLS.every((t) => tools.includes(t));
}

const indentOf = (l: string): number => l.length - l.trimStart().length;
/** Marks a disallowed-tools value that YAML could not read, so it can never count as denying anything. */
const UNREADABLE = Symbol("unreadable");

/**
 * The value YAML gives the key on line `i` (keys at `indent`), read by parsing that key's own lines, never by
 * reading comments or quotes by hand (S103): the key line plus the consecutive `- item` lines indented deeper,
 * the one list shape the line reader always took. A same-indent list, a multi-line flow list or a block scalar
 * is not taken, so it cannot be shown to deny anything and fails closed (S103 parity). UNREADABLE when that
 * snippet is not a YAML mapping.
 */
function keyValueAt(lines: readonly string[], i: number, close: number, indent: number): unknown {
  const block = [lines[i].slice(indent)];
  for (let j = i + 1; j < close && indentOf(lines[j]) > indent && /^\s+-\s/.test(lines[j]); j++) block.push(lines[j].slice(indent));
  try {
    const v: unknown = Bun.YAML.parse(block.join("\n"));
    if (v !== null && typeof v === "object" && !Array.isArray(v)) { const vals = Object.values(v); if (vals.length === 1) return vals[0]; }
  } catch { /* falls through */ }
  return UNREADABLE;
}

/** Top-level frontmatter keys of a SKILL.md that break the allowlist, with 1-based line numbers.
 *  A file with no frontmatter returns nothing (IntentLint and /ic own that); an unclosed one is a
 *  problem, since its keys cannot be read. Pure. */
export function skillFrontmatterProblems(text: string): FrontmatterProblem[] {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return [];
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return [{ line: 1, key: "", reason: "frontmatter has no closing ---, so its keys cannot be checked" }];
  const problems: FrontmatterProblem[] = [];
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([^\s#:-][^:]*?)\s*:(.*)$/);
    if (!m) continue; // indented, list item, comment or blank: not a top-level key
    const key = m[1].replace(/^["']|["']$/g, "").trim();
    if (PERMITTED_SKILL_KEYS.includes(key)) continue;
    // disallowed-tools is judged below on the value YAML gives it, never on the line's text (S103).
    if (key === READ_ONLY_KEY) continue;
    problems.push({ line: i + 1, key, reason: `the frontmatter key on this line is not permitted (its name is withheld): skills run one way, keys allowed are ${PERMITTED_SKILL_KEYS.join(", ")} (+ read-only ${READ_ONLY_KEY})` });
  }
  // The line scan above reads only column-0 keys, but YAML takes a uniformly indented block or a flow
  // mapping as the same top-level mapping, so `  context: fork` passed while the harness read it
  //. The parsed mapping is the authority when the block parses.
  // Many live skills carry an unquoted description with ": " in it, which strict YAML rejects and the
  // harness reads anyway (measured 2026-10-14: 26 of 162), so a parse failure is not itself a problem;
  // the keys are then the lines at the block's own minimum indentation, which an indented block cannot hide from,
  // and disallowed-tools takes the value YAML gives its own lines (keyValueAt), so a comment or a quoted `#` reads
  // exactly as the parser reads it (S103).
  const seen = new Set(problems.map((p) => p.key));
  for (let i = 1; i < close; i++) { const m = lines[i].match(/^([^\s#:-][^:]*?)\s*:/); if (m) seen.add(m[1].replace(/^["']|["']$/g, "").trim()); }
  // The key lines at the block's own minimum indentation are its top-level keys, parsed or not.
  const keyLines = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i > 0 && i < close && /^\s*[^\s#:-][^:]*?\s*:/.test(l));
  const indent = Math.min(...keyLines.map(({ l }) => indentOf(l)));
  const topKeys = Number.isFinite(indent)
    ? keyLines.filter(({ l }) => indentOf(l) === indent).flatMap(({ l, i }) => { const m = l.trim().match(/^([^:]+?)\s*:/); return m ? [{ i, key: m[1].replace(/^["']|["']$/g, "").trim() }] : []; })
    : [];
  let parsed: unknown;
  let parseFailed = false;
  try { parsed = Bun.YAML.parse(lines.slice(1, close).join("\n")); } catch { parseFailed = true; }
  // Every disallowed-tools occurrence is judged on its own lines: YAML keeps only the last of a repeated key, so a
  // whole-block parse alone lets a later value hide an earlier insufficient one (final review, :420).
  const readOnlyKeys = topKeys.filter(({ key }) => key === READ_ONLY_KEY);
  for (const { i, key } of readOnlyKeys) {
    let value = keyValueAt(lines, i, close, indent);
    // An indented block that parses whole and names the key once is judged on the value the whole parse gives
    // it, as the line reader's whole-parse path did: an anchor alias or a same-indent list there reads exactly
    // as YAML reads it (S103 parity). A column-0 key keeps its own lines only.
    const whole = !parseFailed && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    if (!deniesReadOnlyTools(value) && indent > 0 && whole && readOnlyKeys.length === 1) value = whole[READ_ONLY_KEY];
    if (deniesReadOnlyTools(value)) continue;
    problems.push({ line: i + 1, key, reason: value === UNREADABLE
      ? `${READ_ONLY_KEY} could not be read as YAML, so it cannot be shown to deny ${READ_ONLY_TOOLS.join(" and ")}`
      : `${READ_ONLY_KEY} is kept only to hold a skill read-only, so it must deny ${READ_ONLY_TOOLS.join(" and ")}` });
  }
  if (parseFailed) {
    if (!Number.isFinite(indent)) return problems;
    // No prototype: `constructor`, `toString` or `__proto__` as a key is an own entry like any other, never
    // mistaken for one already present (final review, :447).
    const fallback: Record<string, unknown> = Object.create(null);
    for (const { i, key } of topKeys) if (!Object.hasOwn(fallback, key)) fallback[key] = key === READ_ONLY_KEY ? keyValueAt(lines, i, close, indent) : true;
    parsed = fallback;
  }
  if (parsed === null || parsed === undefined) return problems;
  if (typeof parsed !== "object" || Array.isArray(parsed)) return [...problems, { line: 1, key: "", reason: "frontmatter is not a key: value mapping, so its keys cannot be checked" }];
  const lineOf = (key: string) => { const at = lines.findIndex((l, i) => i > 0 && i < close && l.includes(key)); return at > 0 ? at + 1 : 1; };
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (PERMITTED_SKILL_KEYS.includes(key)) continue;
    // The read-only rule is judged only here, on the value YAML gives the key: what YAML parses is what the
    // harness enforces (S103). One problem per key.
    if (key !== READ_ONLY_KEY && seen.has(key)) continue;
    if (key === READ_ONLY_KEY) {
      // One problem per key: an occurrence already judged above stands for it.
      if (deniesReadOnlyTools(value) || problems.some((p) => p.key === READ_ONLY_KEY)) continue;
      problems.push({ line: lineOf(key), key, reason: value === UNREADABLE
        ? `${READ_ONLY_KEY} could not be read as YAML, so it cannot be shown to deny ${READ_ONLY_TOOLS.join(" and ")}`
        : `${READ_ONLY_KEY} is kept only to hold a skill read-only, so it must deny ${READ_ONLY_TOOLS.join(" and ")}` });
      continue;
    }
    problems.push({ line: lineOf(key), key, reason: `the frontmatter key on this line is not permitted (a top-level key once parsed as YAML; its name is withheld): keys allowed are ${PERMITTED_SKILL_KEYS.join(", ")} (+ read-only ${READ_ONLY_KEY})` });
  }
  return problems;
}

/** Frontmatter problems across the skills in scope, as gate violations (file relative to skills/). */
function frontmatterViolations(): Violation[] {
  const dirs = skillFilter ? [skillFilter] : readdirSync(SKILLS_DIR);
  const out: Violation[] = [];
  for (const dir of dirs) {
    const skillMd = join(SKILLS_DIR, dir, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let text: string;
    try { text = readFileSync(skillMd, "utf8"); } catch (e: any) { fail(`cannot read ${skillMd}: ${e.message}`); }
    for (const p of skillFrontmatterProblems(text)) out.push({ file: `${dir}/SKILL.md`, line: p.line, pattern: "frontmatter-key", excerpt: p.reason });
  }
  return out;
}

function main(): never {
if (!existsSync(SKILLS_DIR)) fail(`skills dir missing at ${SKILLS_DIR}`);
// A --skill that names nothing on disk scans nothing and would print CLEAN. Refuse: exit 2.
if (args.includes("--skill")) {
  if (!skillFilter || skillFilter.startsWith("--") || !/^[A-Za-z0-9_.-]+$/.test(skillFilter) || skillFilter.startsWith(".")) fail(`--skill needs a skill directory name, got "${skillFilter ?? ""}"`);
  if (!existsSync(join(SKILLS_DIR, skillFilter))) fail(`no such skill: ${join(SKILLS_DIR, skillFilter)} does not exist, so nothing was scanned`);
}
const { patterns, coverage: denyCoverage } = loadDenyPatterns();
const allow = loadAllowlist();
const tmp = mkdtempSync(join(tmpdir(), "shg-"));
const patternFile = join(tmp, "patterns.txt");
writeFileSync(patternFile, patterns.join("\n") + "\n");

const namePatterns = loadNamePatterns();

let raw: Violation[] = [];
let rawNames: Violation[] = [];
let vendored: string[] = [];
try {
  raw = runRg(patternFile);
  if (namePatterns.length > 0) {
    const nameFile = join(tmp, "names.txt");
    writeFileSync(nameFile, namePatterns.join("\n") + "\n");
    rawNames = runRg(nameFile, "name-literal");
  }
  vendored = trackedVendoredDeps().filter(d => !skillFilter || d.startsWith(`skills/${skillFilter}/`));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const fmViolations = frontmatterViolations();
const backendViolations = shippedBackendViolations();
const symlinkViolations = unscannedSymlinks(SKILLS_DIR, skillFilter, trackedSymlinkPaths());
const violations = [
  ...raw.filter(v => !isAllowed(`skills/${v.file}`, allow)),
  ...rawNames.filter(v => !isAllowedName(`skills/${v.file}`, allow)),
  ...fmViolations, // never allowlisted
  ...backendViolations, // never allowlisted
  ...symlinkViolations, // never allowlisted
];
const allowedCount = raw.length + rawNames.length + fmViolations.length + backendViolations.length + symlinkViolations.length - violations.length;

const bySkill = new Map<string, Violation[]>();
for (const v of violations) {
  const skill = v.file.split("/")[0];
  if (!bySkill.has(skill)) bySkill.set(skill, []);
  bySkill.get(skill)!.push(v);
}

const total = violations.length + vendored.length;
// Zero hits without a deny-list proves only the generic checks: identity strings were
// never looked for, so that is cannot-verify (2), never CLEAN, unless declared.
const denyAbsentUndeclared = denyCoverage === "absent" && !declaredNoDenyList;
const DENY_ABSENT_MSG = "deny list absent: only generic checks ran (home paths, scrub patterns, vendored deps); identity strings were not scanned. Restore LIFEOS/USER/SECURITY/DENY_LIST.txt, or pass --no-deny-list to declare this install has none";
const exitCode = total > 0 ? 1 : denyAbsentUndeclared ? 2 : 0;

if (jsonOutput) {
  console.log(JSON.stringify({
    ok: exitCode === 0,
    exitCode,
    denyList: denyCoverage,
    gitChecks,
    ...(exitCode === 2 ? { error: DENY_ABSENT_MSG } : {}),
    totalViolations: violations.length,
    frontmatterViolations: fmViolations.length,
    allowedHits: allowedCount,
    vendoredDeps: vendored,
    skills: [...bySkill.entries()].map(([skill, vs]) => ({
      skill,
      count: vs.length,
      files: [...new Set(vs.map(v => v.file))].length,
      detail: vs.slice(0, maxDetail),
    })).sort((a, b) => b.count - a.count),
  }, null, 2));
} else {
  console.log(`\n🧼 Skill Hygiene Gate — deny-list: ${denyCoverage === "absent" ? "ABSENT (generic checks only)" : `${patterns.length} patterns`} · name-literals: ${namePatterns.length || "ABSENT"} · allowlist: ${allow.length} entries (+${PATTERN_ALLOWLIST_FILES.length} containment)`);
  console.log("─".repeat(64));
  if (bySkill.size === 0 && vendored.length === 0) {
    if (denyCoverage === "absent") console.log("No generic-check hits in skills/ — deny list absent, identity strings not scanned");
    else console.log("CLEAN — zero non-allowlisted violations in skills/");
  } else {
    for (const [skill, vs] of [...bySkill.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`✗ ${skill.padEnd(32)} ${String(vs.length).padStart(5)} hits in ${new Set(vs.map(v => v.file)).size} files`);
      for (const v of vs.slice(0, maxDetail)) console.log(`    ${v.file}:${v.line}  ${v.excerpt.trim().slice(0, 100)}`);
      if (vs.length > maxDetail) console.log(`    … ${vs.length - maxDetail} more (use --json or --skill ${skill})`);
    }
    for (const d of vendored) console.log(`✗ VENDORED DEPS tracked in git: ${d}`);
  }
  console.log("─".repeat(64));
  if (gitChecks === "skipped-declared") console.log("NOTE: git-backed checks (tracked vendored deps, shipped backends) were skipped: this tree is declared not to be a checkout (--root or --no-git)");
  const verdict = total > 0 ? `${total} violations`
    : denyAbsentUndeclared ? `NOT VERIFIED — ${DENY_ABSENT_MSG}`
    : denyCoverage === "absent" ? "CLEAN (generic checks only — no deny list, declared by --no-deny-list)"
    : "CLEAN";
  console.log(`Verdict: ${verdict} (${allowedCount} allowlisted hits suppressed)\n`);
}
process.exit(exitCode);
}

if (import.meta.main) main();
