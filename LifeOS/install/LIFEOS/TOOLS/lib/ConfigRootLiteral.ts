/**
 * Detector for a config root resolved from a HOME literal instead of Paths.ts.
 *
 * `join(homedir(), ".claude")`, `${HOME}/.claude/...` and their spellings pin the
 * HOME profile, so an install placed via CLAUDE_CONFIG_DIR / LIFEOS_SKILLS_DIR
 * still reads and writes ~/.claude (public issue #1974, @sabo961). The same shape
 * against the USER data root (`join(HOME, ".config/LIFEOS/USER/...")`) skips the
 * `LIFEOS/USER` symlink the resolver follows, so a relocated user tree is missed.
 * The /ic lane `config-root-literal` (IntegrityCheck.ts) uses this.
 *
 * Code shapes only: comment lines and display strings such as
 * `.replace(ROOT, "~/.claude")` are not resolution.
 *
 * Budget: LIFEOS/TOOLS and hooks are zero-tolerance. Everywhere else under
 * LIFEOS/ and skills/ carries a checked-in baseline
 * (LIFEOS/TOOLS/config-root-literal.baseline.json) that may only shrink: a file
 * over its own count blocks, and every private path is budgeted as one aggregate
 * so the public file never names it. "Private" is `skills/_*` by default; the /ic
 * lane passes the containment-zone test, so release-excluded subsystems (Vigil,
 * Bunker) fold into the aggregate too.
 */

const ROOT = String.raw`(?:\.claude|\.config\/LIFEOS)`;
const HOME_EXPR = String.raw`(?:(?:os\.)?homedir\(\)|process\.env\.(?:HOME|USERPROFILE)[^,]*|\b(?:HOME|home|homeDir|HOME_DIR)\b)`;

export const CONFIG_ROOT_LITERAL_RE = new RegExp([
  String.raw`\b(?:path\.)?(?:join|\w*[Rr]esolve)\(\s*${HOME_EXPR}\s*,\s*["'\x60]${ROOT}(?:\/|["'\x60])`,
  String.raw`\$\{\s*(?:(?:os\.)?homedir\(\)|process\.env\.HOME[^}]*|\b(?:HOME|home|homeDir|HOME_DIR)\b)\s*\}\/${ROOT}(?:\/|\x60)`,
  String.raw`(?:homedir\(\)|process\.env\.HOME!?|\bHOME\b)\s*\+\s*["'\x60]\/${ROOT}`,
].join("|"));

/** Paths whose job is to define the root (the resolvers), exempt by name. */
export const RESOLVER_FILES = new Set<string>([
  "LIFEOS/TOOLS/Paths.ts",
  "LIFEOS/TOOLS/LifeosConfig.ts",
  "LIFEOS/PULSE/Conduit/paths.ts",
  "LIFEOS/WORKFLOWS/engine/paths.ts",
  "hooks/lib/paths.ts",
  "skills/LifeOS/Tools/lib/claude-dir.ts", // the installer's own resolver: it runs before install, so it cannot import Paths.ts
]);

/** True when a source line is code (not a comment line) and resolves the root from a literal. */
export function hasConfigRootLiteral(line: string): boolean {
  const code = line.trim();
  if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
  return CONFIG_ROOT_LITERAL_RE.test(line);
}

/** Zero-tolerance scope: a literal here blocks outright, no baseline. */
export function isZeroToleranceScope(rel: string): boolean {
  return rel.startsWith("LIFEOS/TOOLS/") || rel.startsWith("hooks/");
}

export function isPrivateSkill(rel: string): boolean {
  return rel.startsWith("skills/_");
}

export interface ConfigRootBaseline {
  /** Per-file ceilings for public paths outside LIFEOS/TOOLS + hooks. Absent = 0. */
  files: Record<string, number>;
  /** One aggregate ceiling across every private path (`skills/_*` and, under /ic, every contained path). */
  privateSkills: number;
}

/** Decides which paths are budgeted in the private aggregate instead of by name. */
export type PrivatePathTest = (rel: string) => boolean;

export interface BaselineVerdict {
  /** Files (or the private-skill aggregate) now over their ceiling. Blocking. */
  over: Array<{ scope: string; count: number; ceiling: number }>;
  /** Ceilings that can be lowered now; the baseline should follow the burn-down. */
  shrinkable: Array<{ scope: string; count: number; ceiling: number }>;
  total: number;
  ceiling: number;
}

export const PRIVATE_SKILLS_SCOPE = "private paths (aggregate)";

/**
 * Compare per-file literal counts (baselined scope only: zero-tolerance paths are
 * judged separately) against the checked-in baseline.
 */
export function compareToBaseline(counts: Record<string, number>, baseline: ConfigRootBaseline, isPrivate: PrivatePathTest = isPrivateSkill): BaselineVerdict {
  const over: BaselineVerdict["over"] = [];
  const shrinkable: BaselineVerdict["shrinkable"] = [];
  let privateCount = 0;
  let total = 0;
  const publicScopes = new Set<string>([...Object.keys(baseline.files)]);
  for (const [rel, n] of Object.entries(counts)) {
    total += n;
    if (isPrivate(rel)) privateCount += n;
    else publicScopes.add(rel);
  }
  for (const scope of [...publicScopes].sort()) {
    const count = counts[scope] ?? 0;
    const ceiling = baseline.files[scope] ?? 0;
    if (count > ceiling) over.push({ scope, count, ceiling });
    else if (count < ceiling) shrinkable.push({ scope, count, ceiling });
  }
  if (privateCount > baseline.privateSkills) over.push({ scope: PRIVATE_SKILLS_SCOPE, count: privateCount, ceiling: baseline.privateSkills });
  else if (privateCount < baseline.privateSkills) shrinkable.push({ scope: PRIVATE_SKILLS_SCOPE, count: privateCount, ceiling: baseline.privateSkills });
  const ceiling = Object.values(baseline.files).reduce((a, b) => a + b, 0) + baseline.privateSkills;
  return { over, shrinkable, total, ceiling };
}

/** Every ceiling in `next` above its value in `prev` (new keys count from 0): the baseline may only shrink. */
// A per-file ceiling in `prev` that `isPrivate` now claims counts toward the prev aggregate,
// so folding a named key into the aggregate is neutral, never a raise.
export function baselineRaises(prev: ConfigRootBaseline, next: ConfigRootBaseline, isPrivate: PrivatePathTest = isPrivateSkill): Array<{ scope: string; from: number; to: number }> {
  const out: Array<{ scope: string; from: number; to: number }> = [];
  for (const [scope, to] of Object.entries(next.files)) {
    const from = prev.files[scope] ?? 0;
    if (to > from) out.push({ scope, from, to });
  }
  const prevPrivate = prev.privateSkills + Object.entries(prev.files).filter(([k]) => isPrivate(k)).reduce((a, [, v]) => a + v, 0);
  if (next.privateSkills > prevPrivate) out.push({ scope: PRIVATE_SKILLS_SCOPE, from: prevPrivate, to: next.privateSkills });
  return out;
}

/** Shape-check a parsed baseline file; a malformed baseline is a scan error, never a silent zero. */
export function parseBaseline(raw: unknown, isPrivate: PrivatePathTest = isPrivateSkill): ConfigRootBaseline {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!r) throw new Error("baseline is not an object");
  const files = r.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error("baseline.files is not an object");
  for (const [k, v] of Object.entries(files)) {
    if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`baseline.files["${k}"] must be a positive integer`);
    if (isZeroToleranceScope(k)) throw new Error(`baseline.files["${k}"] is zero-tolerance scope and cannot be baselined`);
    if (isPrivate(k)) throw new Error(`baseline.files["${k}"] names a private path; fold it into privateSkills`);
  }
  if (!Number.isInteger(r.privateSkills) || (r.privateSkills as number) < 0) throw new Error("baseline.privateSkills must be a non-negative integer");
  return { files: files as Record<string, number>, privateSkills: r.privateSkills as number };
}
