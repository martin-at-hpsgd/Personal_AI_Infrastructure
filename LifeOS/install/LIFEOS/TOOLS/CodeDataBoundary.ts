#!/usr/bin/env bun
/**
 * CodeDataBoundary.ts — the one general gate between code and the principal's data.
 *
 * Rule: a code directory holds only what git tracks or a build regenerates, and what
 * git tracks there carries no private fact. Everything else that turns up in a code
 * directory — a photo, a state file, a screenshot, an eval log, a lifelog dump — is
 * data in the wrong place. That is exactly what release cuts kept picking up:
 * gitignored files in code directories reached a cut, and every git-based sweep was
 * blind to them.
 *
 * Nothing in here names a past offender. The gate is general in what it scans and
 * explicit only in its artifact classes and a visible runtime-debt registry.
 *
 * Checks:
 *   untracked-in-code   every file under a code root is git-tracked, an ARTIFACT class
 *                       (node_modules, dist, lockfiles …), or in a declared RUNTIME_DEBT
 *                       dir (counted and printed, never hidden). Untracked SOURCE files
 *                       (.ts/.md/.sh …) are work in flight and report as info.
 *   identity-in-code    tracked code text carries none of the identity terms derived at
 *                       run time from the identity files. Two tiers, decided by data:
 *                         private  — street, phone, ZIP, household and contact names,
 *                                    anything the release sanitizer does NOT rewrite → blocks
 *                         public   — a term the release sanitizer (ShadowRelease
 *                                    TOKEN_SANITIZATION_MAP) rewrites on every cut → info
 *                       A public repo slug (`handle/repo`) is a product fact and allowed.
 *                       Containment-allowlisted files are exempt; tests report as info.
 *   home-path-in-code   no absolute `/Users/<login>/` in tracked code outside tests.
 *   symlink-in-code     every symlink under a code root is inventoried; one whose real target escapes the repo root
 *                       (and the LIFEOS/USER, LIFEOS/MEMORY data trees) blocks (dangling ones are judged by where they would point).
 *
 * Usage:  bun LIFEOS/TOOLS/CodeDataBoundary.ts [--root <dir>] [--json] [--verbose] [--identity-file <md>]
 * Exit:   0 clean · 1 blocking findings · 2 scan error
 *         A directory that cannot be listed, or a tracked text file that cannot be read, is a
 *         coverage gap (Report.unreadable): the scan is INCOMPLETE and exits 2 even when nothing
 *         blocking turned up, because an unread path is not a clean one (LOSIntegrity security
 *         rank 19, 2026-10-13). The paths go to stderr, where IntegrityCheck reads a scan error.
 * Wired into: IntegrityCheck (/ic, blocking). Release cuts run the same untracked sweep
 * via ShadowRelease G26 on the staging side.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { getClaudeDir } from "./Paths.ts";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { confinedPath } from "./lib/Boundary";

// Private integration names are centralized at this code/data enforcement boundary.
// Defaults preserve local routes; deployments may configure alternative skill names.
export const PRIVATE_SKILL_NAMES = {
  calendar: process.env.LIFEOS_PRIVATE_SKILL_CALENDAR ?? "_CALENDAR",
  cfo: process.env.LIFEOS_PRIVATE_SKILL_CFO ?? "_CFO",
  communication: process.env.LIFEOS_PRIVATE_SKILL_COMMUNICATION ?? "_COMMUNICATION",
  contacts: process.env.LIFEOS_PRIVATE_SKILL_CONTACTS ?? "_CONTACTPHOTOS",
  home: process.env.LIFEOS_PRIVATE_SKILL_HOME ?? "_HOME",
  inbox: process.env.LIFEOS_PRIVATE_SKILL_INBOX ?? "_INBOX",
  lifelog: process.env.LIFEOS_PRIVATE_SKILL_LIFELOG ?? "_LIFELOG",
  localintelligence: process.env.LIFEOS_PRIVATE_SKILL_LOCALINTELLIGENCE ?? "_LOCALINTELLIGENCE",
  network: process.env.LIFEOS_PRIVATE_SKILL_NETWORK ?? "_NETWORK",
  prioritize: process.env.LIFEOS_PRIVATE_SKILL_PRIORITIZE ?? "Prioritize",
  social: process.env.LIFEOS_PRIVATE_SKILL_SOCIAL ?? "X",
  video: process.env.LIFEOS_PRIVATE_SKILL_VIDEO ?? "_VIDEO",
} as const;

export type Check = "untracked-in-code" | "identity-in-code" | "home-path-in-code" | "symlink-in-code";
export type Finding = { check: Check; file: string; detail: string; info?: boolean };
/** `unreadable`: root-relative paths the scan could not list or read; non-empty means the scan is incomplete. */
export type Report = { findings: Finding[]; declaredRuntime: number; scanned: number; terms: Terms; unreadable: Unreadable[] };
export type Unreadable = { path: string; reason: string };

/** Code roots: everything the release ships from. USER and MEMORY are data by definition. */
export const CODE_ROOTS = ["skills", "hooks", "agents", "commands", "LIFEOS"] as const;
const SKIP_UNDER_LIFEOS = new Set(["USER", "MEMORY", "LIFEOS_RELEASES"]);

/** Build/cache output a tool regenerates. Classes, not paths. */
const ARTIFACT_DIRS = new Set(["node_modules", "dist", "out", "build", "release", "stage", ".next", ".cache", ".cursor", "__pycache__", "coverage", ".wrangler", ".cloudflare", ".venv", "synced"]);  // synced: harness-synced payloads (claude.ai sync), vendor-owned
const ARTIFACT_BASENAMES = new Set(["bun.lock", "package-lock.json", ".DS_Store", ".metadata_never_index"]);
const ARTIFACT_SUFFIXES = [".tsbuildinfo", ".pid"];
/** Source extensions: an untracked one is uncommitted work, not data. */
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".md", ".template", ".yaml", ".yml", ".toml", ".css", ".html"]);

/**
 * Runtime state still written inside code directories. Each entry is relocation debt:
 * the gate counts and prints it every run so it never disappears from view, and a new
 * runtime dir cannot be added here without a reason that names where it should move.
 */
export const RUNTIME_DEBT: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "LIFEOS/PULSE/state/", reason: "Pulse daemon state; readers across TOOLS and PULSE — move to LIFEOS/MEMORY/STATE/pulse/" },
  { prefix: "LIFEOS/PULSE/logs/", reason: "launchd stdout/stderr; plists pin the path — move to ~/.local/state/lifeos/" },
  { prefix: "LIFEOS/PULSE/Performance/", reason: "aggregator state next to its code — move to LIFEOS/MEMORY/STATE/" },
  { prefix: "LIFEOS/PULSE/Desktop/assets/", reason: "Desktop build.ts output (icons, font copies) — build into dist/ instead" },
  { prefix: "LIFEOS/PULSE/MenuBar/icon", reason: "MenuBar build input copied from the brand path — build into build/ instead" },
  { prefix: "LIFEOS/TOOLS/.cache/", reason: "tool cache — move to ~/.cache/lifeos/" },
];
/** Eval run logs live beside their suite by design (suite-bearing skills keep their grade logs). */
const DESIGNED_DATA_DIR_RE = /(^|\/)Evals\/results\//;

const HOME = homedir();
const LOGIN = basename(HOME);

const reasonOf = (e: unknown): string => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e));

/** Every file under `dir`; a directory that cannot be listed goes to `gaps`, never silently dropped. */
function walk(dir: string, out: string[], gaps: Unreadable[], links: string[] = []): string[] {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { gaps.push({ path: dir, reason: reasonOf(e) }); return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    // A symlink is never followed (its content is not scanned here) but never skipped silently either: every one is
    // inventoried so run() can validate where it points, artifact-named ones included. The artifact exclusion only
    // stops the walk descending into a real build directory; a link named node_modules can point anywhere.
    if (e.isSymbolicLink()) { links.push(p); continue; }
    // A Cargo crate's target/ is its build output, the same as dist/ for a bundle.
    if (e.isDirectory()) { if (!ARTIFACT_DIRS.has(e.name) && e.name !== ".git" && !(e.name === "target" && existsSync(join(dir, "Cargo.toml")))) walk(p, out, gaps, links); }
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * Validate one inventoried symlink. Confined = its real target is inside the repo root, or inside the data tree the
 * code is designed to point at (LIFEOS/USER, LIFEOS/MEMORY) -> info. A target that escapes both is a blocking
 * finding; a dangling link cannot be checked at all, so it is a coverage gap.
 */
export function checkSymlink(root: string, rel: string, gaps: Unreadable[]): Finding | null {
  const rootReal = realpathSync(root);
  const within = (p: string, base: string) => p === base || p.startsWith(base + sep);
  const dataTrees = ["LIFEOS/USER", "LIFEOS/MEMORY"].map((d) => { try { return realpathSync(join(root, d)); } catch { return join(rootReal, d); } });
  let real: string;
  try { real = realpathSync(join(root, rel)); } catch (e) {
    // Only a missing target is dangling (S083). A loop, a permission error or anything else means the real target
    // could not be established, and the lexical target says nothing about where the link really leads: a gap.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") { gaps.push({ path: rel, reason: `symlink target could not be resolved (${reasonOf(e)})` }); return null; }
    // Dangling: nothing to scan, but where it WOULD point still has to be confined. Judged physically through the shared
    // Boundary walk (S083 review), never lexically: `../bridge/missing` with `bridge` a link out of the repo lands
    // outside even though its folded text stays inside. The link text is joined as written, so every `..` applies
    // after the link before it is followed.
    let linkText: string;
    try { linkText = readlinkSync(join(root, rel)); } catch (e2) { gaps.push({ path: rel, reason: `symlink unreadable (${reasonOf(e2)})` }); return null; }
    const wouldBe = isAbsolute(linkText) ? linkText : `${dirname(join(rootReal, rel))}${sep}${linkText}`;
    const landing = confinedPath(sep, wouldBe);
    if (landing === null) { gaps.push({ path: rel, reason: `dangling symlink whose destination cannot be established (${linkText}: .. past a missing directory, a loop or an unreadable component)` }); return null; }
    if (within(landing, rootReal) || dataTrees.some((d) => within(landing, d))) return { check: "symlink-in-code", file: rel, detail: `dangling symlink to ${within(landing, rootReal) ? relative(rootReal, landing) || landing : landing} (confined, nothing to scan)`, info: true };
    return { check: "symlink-in-code", file: rel, detail: `dangling symlink escapes the repo root to ${landing} (${reasonOf(e)})` };
  }
  if (within(real, rootReal) || dataTrees.some((d) => within(real, d))) return { check: "symlink-in-code", file: rel, detail: `symlink to ${within(real, rootReal) ? relative(rootReal, real) : "the data tree"} (confined)`, info: true };
  return { check: "symlink-in-code", file: rel, detail: `symlink escapes the repo root to ${real} — its content is outside every scan; replace it with a tracked file or point it at LIFEOS/USER` };
}

function isArtifact(rel: string): boolean {
  const base = basename(rel);
  if (ARTIFACT_BASENAMES.has(base) || ARTIFACT_SUFFIXES.some((s) => base.endsWith(s))) return true;
  // The harness lays each mod's build declarations in <plugin>/.claude-plugin/types/ under its own `*` .gitignore.
  return rel.split("/").some((seg) => ARTIFACT_DIRS.has(seg)) || rel.includes(".claude-plugin/types/");
}

function codeFiles(root: string, gaps: Unreadable[], symlinks: string[] = []): string[] {
  const files: string[] = [];
  const links: string[] = [];
  const dirGaps: Unreadable[] = [];
  for (const r of CODE_ROOTS) {
    const dir = join(root, r);
    // lstat, not existsSync: a code root that is itself a symlink (dangling or not) is inventoried and validated
    // by checkSymlink, never walked through as if it were the repo's own tree.
    let st: import("node:fs").Stats;
    try { st = lstatSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException)?.code === "ENOENT") continue; dirGaps.push({ path: dir, reason: reasonOf(e) }); continue; }
    if (st.isSymbolicLink()) { links.push(dir); continue; }
    if (!st.isDirectory()) { dirGaps.push({ path: dir, reason: "code root is not a directory" }); continue; }
    if (r === "LIFEOS") {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_UNDER_LIFEOS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) { links.push(p); continue; }
        if (e.isDirectory()) walk(p, files, dirGaps, links); else if (e.isFile()) files.push(p);
      }
    } else walk(dir, files, dirGaps, links);
  }
  for (const g of dirGaps) gaps.push({ path: relative(root, g.path), reason: g.reason });
  for (const l of links) symlinks.push(relative(root, l));
  return files.map((f) => relative(root, f));
}

function tracked(root: string): Set<string> {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z", ...CODE_ROOTS], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return new Set(out.split("\0").filter(Boolean));
}

// ── identity terms, derived at run time ─────────────────────────────────────
const BULLET = /^- \*\*([A-Za-z /]+):\*\*\s*(.+)$/;
const STREET_RE = /\b(st|ave|blvd|rd|dr|ct|ln|way|pl|cir)\b\.?/i;

/**
 * Pull identity terms out of the identity files. Only the Quick Reference bullet
 * shapes are read; prose is never mined, so a stray sentence cannot become a term.
 */
/** `consented` is the part of `public` that is public by the person's consent (credited contributors), not by a sanitizer rewrite. */
export type Terms = { private: string[]; public: string[]; consented?: string[] };
export function identityTerms(opts: { principalIdentity?: string; contacts?: string; daName?: string }): Terms {
  const priv = new Set<string>(), pub = new Set<string>(), consented = new Set<string>();
  const add = (t: string | undefined) => { const v = (t ?? "").trim(); if (v.length >= 4) priv.add(v); };
  // Public by nature: names, online handles, the DA name. The release sanitizer rewrites these on every cut.
  const addPublic = (t: string | undefined) => { const v = (t ?? "").trim(); if (v.length >= 3) pub.add(v); };
  for (const line of (opts.principalIdentity ?? "").split("\n")) {
    const m = line.match(BULLET); if (!m) continue;
    const key = m[1]!.toLowerCase(), val = m[2]!;
    if (key === "name") { const full = val.replace(/\s*\(.*$/, "").trim(); addPublic(full); const parts = full.split(/\s+/); if (parts.length > 1) addPublic(parts[parts.length - 1]); }
    if (key === "home" || key === "hometown") {
      for (const seg of val.split(",")) { const s = seg.replace(/\(.*?\)/g, "").replace(/\bZIP\b/i, "").trim(); if (/\d/.test(s) && STREET_RE.test(s)) add(s); }
      for (const zip of val.match(/\b\d{5}\b/g) ?? []) add(zip);
    }
    if (key === "phone") { add(val.trim()); add(val.replace(/\D/g, "")); }
    if (/^(youtube|x|linkedin|github|instagram|bluesky|mastodon)$/.test(key)) { for (const h of val.match(/@[A-Za-z0-9_.-]+|linkedin\.com\/in\/[A-Za-z0-9_-]+/g) ?? []) addPublic(h.replace(/^linkedin\.com\/in\//, "").replace(/^@/, "")); }
    if (key === "household" || key === "relationship") {
      // `Nickname (Legal Name)` and `Name ("Nickname")` — the two shapes those bullets use.
      for (const m2 of val.matchAll(/\b([A-Z][a-z]{2,})\s*\(("?)([^)"]+)\2\)/g)) { add(m2[1]); add(m2[3]); }
    }
  }
  for (const line of (opts.contacts ?? "").split("\n")) {
    const m = line.match(/^- \*\*([^*\]]+?)\*\*\s*(\[[^\]]*\])?/); if (!m) continue;
    const name = m[1]!.replace(/\(.*?\)/g, "").trim();
    if (name.split(/\s+/).length < 2) continue;
    // A contact whose role tag says Contributor is credited publicly by consent (release README credits).
    if (/contributor/i.test(m[2] ?? "")) { addPublic(name); consented.add(name); } else add(name);
  }
  addPublic(opts.daName);
  for (const t of pub) priv.delete(t);
  return { private: [...priv], public: [...pub], consented: [...consented].filter((t) => pub.has(t)) };
}

/**
 * Needles the release sanitizer rewrites. The map lives in the release-rewrites file (LIFEOS_RELEASE_REWRITES, else
 * LIFEOS/USER/SECURITY/release-rewrites.json, the same path ShadowRelease reads), parsed as data. The older in-source
 * TOKEN_SANITIZATION_MAP array in ShadowRelease.ts is still read when a tree carries one. Nothing is executed.
 */
export function sanitizedNeedles(root: string): Set<string> {
  const out = new Set<string>();
  const rewrites = process.env.LIFEOS_RELEASE_REWRITES || join(root, "LIFEOS", "USER", "SECURITY", "release-rewrites.json");
  try {
    const tokens = (JSON.parse(readFileSync(rewrites, "utf8")) as { tokens?: unknown }).tokens;
    if (Array.isArray(tokens)) for (const t of tokens) { const n = (t as { needle?: unknown } | null)?.needle; if (typeof n === "string" && n) out.add(n); }
  } catch { /* no rewrites file: no needle is known to be rewritten */ }
  const p = join(root, "skills", "_" + "LIFEOS", "Tools", "ShadowRelease.ts");
  if (existsSync(p)) {
    const src = readFileSync(p, "utf8");
    const start = src.indexOf("TOKEN_SANITIZATION_MAP: Array");
    if (start >= 0) {
      const end = src.indexOf("\n];", start);
      const block = src.slice(start, end < 0 ? undefined : end);
      for (const m of block.matchAll(/^\s*\["((?:[^"\\]|\\.)+)",\s*"/gm)) out.add(m[1]!);
    }
  }
  return out;
}

/** Cuts every sanitizer needle (case-insensitive, longest first) out of a text, to see what the rewrite would leave behind. */
function needleStripper(root: string): (text: string) => string {
  const needles = [...sanitizedNeedles(root)].sort((a, b) => b.length - a.length);
  if (!needles.length) return (text) => text;
  const re = new RegExp(needles.map(escape).join("|"), "gi");
  return (text) => text.replace(re, " ");
}

function loadTerms(root: string, identityFile: string | undefined, gaps: Unreadable[]): Terms {
  // The identity source is required input: a missing explicit --identity-file, or a missing default
  // PRINCIPAL_IDENTITY.md, would otherwise turn identity matching off while the scan still reported clean.
  const identitySource = identityFile ?? join(root, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md");
  if (!existsSync(identitySource)) gaps.push({ path: identityFile ? identitySource : relative(root, identitySource), reason: identityFile ? "identity file missing (explicit --identity-file)" : "ENOENT: principal identity missing, identity matching is off" });
  const read = (p: string) => {
    if (!existsSync(p)) return "";
    try { return readFileSync(p, "utf8"); } catch (e) { gaps.push({ path: p, reason: reasonOf(e) }); return ""; }
  };
  let daName: string | undefined;
  if (!identityFile) { try { daName = (require("../../hooks/lib/identity.ts") as { getDAName: () => string }).getDAName(); } catch { /* no identity module */ } }
  const all = identityTerms({
    principalIdentity: identityFile ? read(identityFile) : read(join(root, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md")) + "\n" + read(join(root, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_PRIVATE.md")),
    contacts: read(join(root, "LIFEOS/USER/CONTACTS.md")),
    daName,
  });
  // A private-by-source term the release sanitizer already rewrites drops to the public tier. A public-by-source term
  // (name, handle, DA name) stays there only as long as run() finds the sanitizer really rewrites every place it sits.
  const needles = [...sanitizedNeedles(root)].map((n) => n.toLowerCase());
  const isSanitized = (t: string) => needles.includes(t.toLowerCase());
  return { private: all.private.filter((t) => !isSanitized(t)), public: [...all.public, ...all.private.filter(isSanitized)], consented: all.consented ?? [] };
}

function containmentAllowlist(root: string): Set<string> {
  try {
    const mod = require(join(root, "hooks/lib/containment-zones.ts")) as { PATTERN_ALLOWLIST_FILES?: readonly string[] };
    return new Set(mod.PATTERN_ALLOWLIST_FILES ?? []);
  } catch { return new Set(); }
}

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".md", ".json", ".yaml", ".yml", ".toml", ".txt", ".html", ".css", ".ps1", ".plist", ".template"]);
const isTest = (rel: string) => /\.test\.tsx?$|\/tests?\/|\/Fixtures\//i.test(rel);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-token match; `handle/repo` (a public slug) and `x.com/handle` are product facts, not identity leaks. */
const termRegex = (t: string) => new RegExp(`(?<![A-Za-z0-9_/.-])${escape(t)}(?![A-Za-z0-9_-]|\\s*/)`);

/**
 * The files the release ships, from the maintainer's public.lock (written by `release.ts classify`), or null
 * where no lock exists. A public term left standing blocks only in a file that ships; with no lock every file
 * is treated as shipping.
 */
export function shippedSet(root: string): Set<string> | null {
  const lock = join(root, "skills", "_LIFEOS", "Release", "public.lock");
  if (!existsSync(lock)) return null;
  return new Set(readFileSync(lock, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
}

export function run(root: string, opts: { identityFile?: string } = {}): Report {
  const findings: Finding[] = [];
  const unreadable: Unreadable[] = [];
  const symlinks: string[] = [];
  const files = codeFiles(root, unreadable, symlinks);
  const known = tracked(root);
  let declaredRuntime = 0;
  for (const rel of symlinks) { const f = checkSymlink(root, rel, unreadable); if (f) findings.push(f); }

  for (const rel of files) {
    if (known.has(rel) || isArtifact(rel) || DESIGNED_DATA_DIR_RE.test(rel)) continue;
    if (RUNTIME_DEBT.some((d) => rel.startsWith(d.prefix))) { declaredRuntime++; continue; }
    if (SOURCE_EXT.has(extname(rel))) { findings.push({ check: "untracked-in-code", file: rel, detail: "uncommitted source file", info: true }); continue; }
    findings.push({ check: "untracked-in-code", file: rel, detail: "not tracked by git and not build output — data living in a code directory; move it under LIFEOS/USER or LIFEOS/MEMORY (or, if a build makes it, build it into dist/)" });
  }

  const shipped = shippedSet(root);
  const terms = loadTerms(root, opts.identityFile, unreadable);
  const consented = new Set(terms.consented ?? []);
  const stripNeedles = needleStripper(root);
  const allow = containmentAllowlist(root);
  const privateRes = terms.private.map((t) => ({ t, re: termRegex(t) }));
  const publicRes = terms.public.map((t) => ({ t, re: termRegex(t) }));
  const homeRe = new RegExp(`/Users/${escape(LOGIN)}/`);
  // The substring test comes first: a term absent from the text cannot match its regex, and the lookbehind
  // regex alone cost about 1.5 s per term across the tree, most of the /ic run (2026-10-17).
  const hit = (text: string, list: typeof privateRes) => { for (const { t, re } of list) if (text.includes(t) && re.test(text)) return { t, line: text.split("\n").findIndex((l) => re.test(l)) + 1 }; return null; };
  for (const rel of files) {
    if (!known.has(rel) || !TEXT_EXT.has(extname(rel)) || allow.has(rel)) continue;
    let text: string;
    try { text = readFileSync(join(root, rel), "utf8"); } catch (e) { unreadable.push({ path: rel, reason: reasonOf(e) }); continue; }
    const test = isTest(rel);
    const where = test ? "a test fixture" : "code";
    if (homeRe.test(text)) findings.push({ check: "home-path-in-code", file: rel, detail: `absolute home path /Users/${LOGIN}/ in ${where} — use ~ / $HOME / CLAUDE_CONFIG_DIR`, info: test });
    const priv = hit(text, privateRes);
    if (priv) { findings.push({ check: "identity-in-code", file: `${rel}:${priv.line}`, detail: `private identity term "${priv.t}" in ${where} — identity belongs in LIFEOS/USER, read at run time`, info: test }); continue; }
    // A public term is safe only where the release sanitizer rewrites it: once every needle the sanitizer carries is
    // cut out of the text, a term still standing ships in the release, so it blocks like a private one. Credited
    // contributors are public by consent. Nothing here trusts a term merely for being derived as public.
    let info: { t: string; line: number } | null = null, residualText: string | null = null;
    for (const { t, re } of publicRes) {
      if (!text.includes(t) || !re.test(text)) continue;
      const line = text.split("\n").findIndex((l) => re.test(l)) + 1;
      if (!consented.has(t)) {
        residualText ??= stripNeedles(text);
        if (re.test(residualText) && (!shipped || shipped.has(rel))) {
          const at = text.split("\n").findIndex((l) => re.test(stripNeedles(l))) + 1;
          findings.push({ check: "identity-in-code", file: `${rel}:${at || line}`, detail: `identity term "${t}" in ${where} is not rewritten by the release sanitizer (no matching needle in the release-rewrites file) — it would ship; identity belongs in LIFEOS/USER, read at run time`, info: test });
          info = null; break;
        }
      }
      info ??= { t, line };
    }
    if (info) findings.push({ check: "identity-in-code", file: `${rel}:${info.line}`, detail: `public identity term "${info.t}" in ${where} — rewritten by the release sanitizer; prefer getPrincipalName()/getDAName()`, info: true });
  }
  return { findings, declaredRuntime, scanned: files.length, terms, unreadable };
}

/** 2 when any path went unread (coverage gap), else 1 on a blocking finding, else 0. */
export function exitCodeFor(report: Report): 0 | 1 | 2 {
  if (report.unreadable.length) return 2;
  return report.findings.some((f) => !f.info) ? 1 : 0;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = arg("--root") ?? getClaudeDir();
  let report: Report;
  try { report = run(root, { identityFile: arg("--identity-file") }); }
  catch (e) { console.error(`CodeDataBoundary: scan error — ${e instanceof Error ? e.message : String(e)}`); process.exit(2); }
  const blocking = report.findings.filter((f) => !f.info);
  const info = report.findings.filter((f) => f.info);
  const code = exitCodeFor(report);
  // Coverage gaps go to stderr in both modes: IntegrityCheck reads exit 2 plus stderr as a scan error.
  if (report.unreadable.length) {
    console.error(`CodeDataBoundary: scan INCOMPLETE — ${report.unreadable.length} path(s) could not be read, so the result cannot be called clean:`);
    for (const u of report.unreadable.slice(0, 20)) console.error(`  ${u.path} (${u.reason})`);
    if (report.unreadable.length > 20) console.error(`  … +${report.unreadable.length - 20} more (see --json)`);
  }
  if (argv.includes("--json")) { console.log(JSON.stringify({ ...report, blocking: blocking.length }, null, 2)); process.exit(code); }
  console.log(`CodeDataBoundary — ${report.scanned} files under ${CODE_ROOTS.join(", ")}; ${report.terms.private.length} private + ${report.terms.public.length} sanitized identity terms; ${report.declaredRuntime} file(s) in declared runtime-debt dirs`);
  for (const f of blocking) console.log(`  ✗ [${f.check}] ${f.file} — ${f.detail}`);
  const kind = (f: Finding) => f.detail.split(" — ")[0]!.replace(/"[^"]*"/, "…");
  const byKind = new Map<string, number>();
  for (const f of info) byKind.set(kind(f), (byKind.get(kind(f)) ?? 0) + 1);
  for (const [k, n] of byKind) console.log(`  · info ×${n}: ${k}`);
  if (argv.includes("--verbose")) for (const f of info) console.log(`    · [${f.check}] ${f.file} — ${f.detail}`);
  if (report.declaredRuntime) for (const d of RUNTIME_DEBT) console.log(`  ~ runtime debt: ${d.prefix} — ${d.reason}`);
  if (blocking.length) console.log(`❌ ${blocking.length} blocking finding(s)`);
  if (report.unreadable.length) console.log(`❌ scan incomplete: ${report.unreadable.length} unreadable path(s)`);
  if (code === 0) console.log("✅ clean: code directories hold only tracked files and build output; no private identity in code");
  process.exit(code);
}
