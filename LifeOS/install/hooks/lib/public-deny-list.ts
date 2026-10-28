import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./paths";
import { SECRET_VALUE_SHAPES } from "./egress-shapes";

export interface DenyListGroups {
  identity: string[];
  hostnames: string[];
  cfIds: string[];
  privateTokens: string[];
}

/**
 * Credential families the public-publication scan takes from the shared inventory
 * (egress-shapes.ts SECRET_VALUE_SHAPES), each named by a marker that occurs in
 * exactly one inventory shape's source. The ERE is compiled from that shape, so a
 * change to the family's shape changes what this scan refuses: the two cannot drift.
 *
 * Only families that are clean today on the public LifeOS checkout (HEAD, branch and
 * tag tips, and their history: the push gate's own scope) are listed. Generic `sk-…`
 * and JWT are deliberately absent: both match synthetic examples the public tree ships.
 */
export const PUBLISHED_FAMILY_MARKERS: Readonly<Record<string, string>> = {
  npm: "npm_",
  stripe: "k_live_",
  githubFineGrained: "github_pat_",
  googleApiKey: "AIza",
  gitlab: "glpat-",
  cerebras: "csk-",
  openRouter: "sk-or-v1-",
  telegramBot: ":[A-Za-z0-9_-]{35}", // credential shape only: the integration was retired 2026-07-15, leaked bot tokens are still caught
  slackRotation: "xoxe",
  awsSecretAfterLabel: "aws[_ -]?secret",
};

/** Index of the `)` closing the group that opens at `open`. */
function skipGroup(src: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; if (src[i + 1] === "^") i++; if (src[i + 1] === "]") i++; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  throw new Error(`unbalanced group in ${src}`);
}

function swapCase(c: string): string {
  return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
}

/**
 * A JavaScript credential shape as a case-sensitive POSIX ERE for `git grep -E`.
 * Every rewrite keeps or widens what matches, never narrows it: `\b` and negative or
 * forward lookarounds are dropped, a lookbehind is consumed as ordinary text, `\d` and
 * `\s` become bracket classes, and an `i` flag becomes per-letter `[aA]` alternatives.
 * A construct with no safe translation throws, so a new inventory shape cannot slip in
 * half-compiled.
 */
export function jsShapeToGitEre(shape: RegExp): string {
  const src = shape.source;
  const ci = shape.flags.includes("i");
  let out = "";
  let inClass = false;
  let classStart = false;
  let classOut = 0; // where the open class begins in `out`
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      const n = src[++i];
      if (n === undefined) throw new Error(`trailing backslash in ${src}`);
      if (n === "d") out += inClass ? "0-9" : "[0-9]";
      else if (n === "s") out += inClass ? "[:space:]" : "[[:space:]]";
      else if (n === "b" && !inClass) { /* word boundary: no ERE form, dropped (widens) */ }
      else if (/[A-Za-z0-9]/.test(n)) throw new Error(`no git ERE form for \\${n} in ${src}`);
      else if (inClass) {
        // These need a position-dependent spelling in a bracket expression (`-` would form a range).
        if (n === "]" || n === "\\" || n === "^" || n === "-") throw new Error(`no git ERE form for \\${n} inside a class in ${src}`);
        out += n; // a bracket expression has no escapes: `\/` is just `/`
      } else out += n === "/" ? "/" : `\\${n}`;
      classStart = false;
      continue;
    }
    if (inClass) {
      if (c === "]" && !classStart) { inClass = false; out += c; continue; }
      classStart = false;
      if (ci && /[A-Za-z]/.test(c)) {
        const hi = src[i + 2];
        if (src[i + 1] === "-" && hi !== undefined && /[A-Za-z]/.test(hi)) {
          const swapped = `${swapCase(c)}-${swapCase(hi)}`;
          const classEnd = src.indexOf("]", i);
          out += src.slice(i, classEnd).includes(swapped) || out.slice(classOut).includes(swapped) ? `${c}-${hi}` : `${c}-${hi}${swapped}`;
          i += 2;
        } else out += c + swapCase(c);
        continue;
      }
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      classStart = true;
      classOut = out.length;
      out += c;
      if (src[i + 1] === "^") { out += "^"; i++; }
      continue;
    }
    if (c === "(" && src[i + 1] === "?") {
      const next = src[i + 2];
      if (next === ":") { out += "("; i += 2; continue; }
      if (next === "<" && src[i + 3] === "=") { out += "("; i += 3; continue; }
      if ((next === "<" && src[i + 3] === "!") || next === "=" || next === "!") { i = skipGroup(src, i); continue; }
      throw new Error(`no git ERE form for group (?${next} in ${src}`);
    }
    if (ci && /[A-Za-z]/.test(c)) { out += `[${c.toLowerCase()}${c.toUpperCase()}]`; continue; }
    out += c;
  }
  if (inClass) throw new Error(`unterminated class in ${src}`);
  return out;
}

/** The inventory shape a marker names: exactly one, or this list and the inventory have drifted. */
export function publishedFamilyShape(marker: string): RegExp {
  const hits = SECRET_VALUE_SHAPES.filter((r) => r.source.includes(marker));
  if (hits.length !== 1) throw new Error(`public deny list: marker ${JSON.stringify(marker)} names ${hits.length} inventory shapes, expected exactly 1`);
  return hits[0]!;
}

/** The published families as git ERE, in PUBLISHED_FAMILY_MARKERS order. */
export function publishedFamilyEres(): string[] {
  return Object.values(PUBLISHED_FAMILY_MARKERS).map((m) => jsShapeToGitEre(publishedFamilyShape(m)));
}

/** Public, non-personal signatures. Private pattern content remains in USER/SECURITY. */
const GENERIC_PATTERNS = [
  "sk-ant-[A-Za-z0-9_-]{10}",
  "ghp_[A-Za-z0-9]{20}",
  "github_pat_[A-Za-z0-9_]{20}",
  "AKIA[0-9A-Z]{16}",
  "xox[bpars]-[A-Za-z0-9-]{10}",
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
];

function patternLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

/** The union used by both release and public-push enforcement points. */
export function loadPublicDenyList(configRoot = getClaudeDir()): { generic: string[]; groups: DenyListGroups; user: string[] } {
  const security = join(configRoot, "LIFEOS", "USER", "SECURITY");
  const groups: DenyListGroups = { identity: [], hostnames: [], cfIds: [], privateTokens: [] };
  // A source file that exists but yields nothing is corruption, and both
  // consumers are the last thing between this tree and a public remote. Each
  // source is judged on its own (p1b2 S028): an empty DENY_LIST.txt beside a
  // populated scrub file used to load, silently dropping the identity, hostname,
  // Cloudflare-ID and private-token groups. Absent files are the fresh-install
  // case, where there is nothing private yet.
  const empty: string[] = [];
  let current: keyof DenyListGroups | null = null;
  const denyPath = join(security, "DENY_LIST.txt");
  if (existsSync(denyPath)) {
    let loaded = 0;
    for (const rawLine of readFileSync(denyPath, "utf8").split("\n")) {
      const line = rawLine.trim();
      const header = /^#\s*---\s*(.+?)\s*---\s*$/.exec(line);
      if (header) {
        const name = header[1]!.toLowerCase().replace(/\s+/g, "");
        if (name.includes("identity")) current = "identity";
        else if (name.includes("hostname") || name.includes("network") || name.includes("topology")) current = "hostnames";
        else if (name.includes("cloudflare") || name.includes("cfid")) current = "cfIds";
        else if (name.includes("token") || name.includes("private")) current = "privateTokens";
        else current = "identity";
        continue;
      }
      if (line !== "" && !line.startsWith("#") && current) { groups[current].push(line); loaded++; }
    }
    if (loaded === 0) empty.push(denyPath);
  }
  const scrubPath = join(security, "PublicScrubPatterns.txt");
  const scrub = patternLines(scrubPath);
  if (existsSync(scrubPath) && scrub.length === 0) empty.push(scrubPath);
  groups.identity.push(...scrub);
  if (empty.length > 0) {
    throw new Error(`public deny list source yields no patterns although it exists: ${empty.join(", ")} — refusing to scan without it`);
  }
  const user = Array.from(new Set([...groups.identity, ...groups.hostnames, ...groups.cfIds, ...groups.privateTokens]));
  return { generic: Array.from(new Set([...GENERIC_PATTERNS, ...publishedFamilyEres()])), groups, user };
}
