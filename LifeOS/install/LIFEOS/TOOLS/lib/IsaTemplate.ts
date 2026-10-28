/**
 * IsaTemplate — the one ISA template version, and an ISA's computed standing against it.
 *
 * The template version lives here and nowhere else in code. It equals the
 * `template_version:` key in LIFEOS/DOCUMENTATION/ISA/ISAFormat.md's frontmatter
 * (a test pins the two together), so the spec and the code move in one commit.
 *
 * `conform()` reads an ISA's own sections and says whether it meets that
 * template, naming what is missing. It never trusts the `isa_format:` stamp:
 * a stamp claiming a version the file does not meet is itself a finding
 * (`stamp-unearned`). Only `IsaCheck.ts stamp` writes `isa_format`, and only
 * when conform is clean. Read-only.
 *
 * @version 1.0.0
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { h2Sections, parseLadder } from "../IsaLadder";
import { parseIsaClaimsText } from "./IsaClaims";
import { parseTestStrategyText } from "./IsaTestStrategy";

/** The current ISA template. Moves only with ISAFormat.md's `template_version:`. */
export const ISA_TEMPLATE_VERSION = "2.30.0";

/** The version that introduced the integer stamp `isa_format: 3`; `3` reads as this. */
export const LEGACY_FORMAT_3 = "2.29.0";

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Read an `isa_format:` value. Quotes are stripped. `3` is the legacy alias for
 * 2.29.0; an `x.y.z` value is itself; absent or empty means no stamp (known);
 * anything else is unknown.
 */
export function parseIsaFormat(raw: string | undefined): { version: string | null; known: boolean } {
  const v = (raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (v === "") return { version: null, known: true };
  if (v === "3") return { version: LEGACY_FORMAT_3, known: true };
  if (SEMVER.test(v)) return { version: v, known: true };
  return { version: null, known: false };
}

/** Numeric compare per dotted part: -1, 0 or 1. `2.4.0` < `2.29.0`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** From 2.29.0 on (stamp `3` included), an invalid Test Strategy row counts as no row. */
export function invalidRowIsNoRow(fm: Record<string, string>): boolean {
  const { version } = parseIsaFormat(fm.isa_format);
  return version !== null && compareVersions(version, LEGACY_FORMAT_3) >= 0;
}

/** The frontmatter `checkup:` value: `YYYY-MM-DD <verdict> <n>→<m>`. */
export const CHECKUP_RE = /^(\d{4}-\d{2}-\d{2}) ([A-Za-z][A-Za-z0-9_-]*) (\d+)→(\d+)$/;

export interface ConformMissing { code: string; detail: string }

export interface ConformResult {
  /** The template the ISA was checked against (always ISA_TEMPLATE_VERSION). */
  template: string;
  /** True when nothing is missing. */
  latest: boolean;
  missing: ConformMissing[];
  /** The `isa_format:` stamp read as a version (`3` → 2.29.0), or null when absent or unreadable. */
  stamp: string | null;
  /** The raw frontmatter `checkup:` value, or null. */
  checkup: string | null;
}

/**
 * The spec's fixed section order (ISAFormat § Body Sections), each with the
 * headings that count as it. Headings outside this table (`## Status`,
 * `## Anti-criteria`, `## Experiments`, anything bespoke) are ignored.
 */
const ORDER: { name: string; aliases: string[] }[] = [
  { name: "Ideal State", aliases: ["ideal state"] },
  { name: "Problem", aliases: ["problem"] },
  { name: "Vision", aliases: ["vision"] },
  { name: "Out of Scope", aliases: ["out of scope"] },
  { name: "Language", aliases: ["language"] },
  { name: "Principles", aliases: ["principles"] },
  { name: "Constraints", aliases: ["constraints"] },
  { name: "Dependencies", aliases: ["dependencies"] },
  { name: "Criteria", aliases: ["criteria", "isc criteria", "claims", "ideal state criteria"] },
  { name: "Not yet specified", aliases: ["not yet specified"] },
  { name: "Bridge Criteria", aliases: ["bridge criteria"] },
  { name: "Test Strategy", aliases: ["test strategy"] },
  { name: "Harness", aliases: ["harness"] },
  { name: "Extraction", aliases: ["extraction"] },
  { name: "Features", aliases: ["features"] },
  { name: "Decisions", aliases: ["decisions"] },
  { name: "Learning", aliases: ["learning"] },
  { name: "Verification", aliases: ["verification", "log"] },
  { name: "Remaining Work", aliases: ["remaining work"] },
  { name: "Evals", aliases: ["evals"] },
  { name: "Articulation Log", aliases: ["articulation log"] },
];

const RETIRED = ["goal", "changelog", "articulation"];

/** A heading's comparable form: a trailing parenthetical dropped, case folded. */
function norm(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

function rankOf(title: string): number {
  const t = norm(title);
  return ORDER.findIndex((s) => s.aliases.includes(t));
}

function frontmatterOf(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

function bodyOf(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length) : text;
}

/** Section text with HTML comments removed; empty means the section counts as missing. */
function substance(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** A task ISA lives under MEMORY/WORK (by real path); every other ISA is a project ISA. */
export function isTaskIsa(isaPath: string): boolean {
  const abs = resolve(isaPath);
  let real = abs;
  try { if (existsSync(abs)) real = realpathSync(abs); } catch { /* keep the lexical path */ }
  return real.includes("/MEMORY/WORK/") || abs.includes("/MEMORY/WORK/");
}

const TOMBSTONE_RE = /^\s*[-*]\s+\[[ xX~]\]\s+([A-Za-z][\w.-]*)\s*:\s*\[DROPPED\b/gm;
const HARNESS_NONE = /^None\s*[—–-]+\s*\S/;

function stripAnchorPrefix(a: string): string {
  const m = a.match(/^(?:derived|cross)\s*:\s*(.+)$/i);
  return (m ? m[1]! : a).trim();
}

/** Does this ISA meet the current template? Computed from its sections, never from its stamp. */
export function conform(content: string, isaPath: string): ConformResult {
  const fm = frontmatterOf(content);
  const body = bodyOf(content);
  const project = !isTaskIsa(isaPath);
  const found: ConformMissing[] = [];
  const secs = h2Sections(body);
  const sectionText = (name: string): string | null => {
    const s = secs.find((x) => rankOf(x.title) === ORDER.findIndex((o) => o.name === name));
    return s ? body.slice(s.contentStart, s.end) : null;
  };

  // The Ideal State ladder: L3 on every ISA; L2 and L1 on project ISAs.
  const ideal = sectionText("Ideal State");
  if (ideal === null || !substance(ideal)) {
    found.push({ code: "section-missing", detail: "## Ideal State is missing or empty" });
  } else {
    const L = parseLadder(content);
    if (!L.l3) found.push({ code: "ladder-missing", detail: "## Ideal State has no ### L3 · One sentence" });
    if (project && !(L.l2Present && (L.l2Sentence || L.l2Bullets.length))) found.push({ code: "ladder-missing", detail: "## Ideal State has no ### L2 · Summary (required on project ISAs)" });
    if (project && !L.l1) found.push({ code: "ladder-missing", detail: "## Ideal State has no ### L1 · Full articulation (required on project ISAs)" });
  }

  // Criteria, and a valid Test Strategy row for each one. The claim list and the
  // probe parse are the ones ISAGate's H8 reads, so a clean conform never leaves
  // a criterion H8 would count as rowless.
  const tombstones = new Set([...content.matchAll(TOMBSTONE_RE)].map((m) => m[1]!));
  const claims = [...new Set(parseIsaClaimsText(content, { path: isaPath }).claims.map((c) => c.id))].filter((id) => !tombstones.has(id));
  if (!claims.length) found.push({ code: "no-criteria", detail: "no criteria under ## Criteria or ## Features" });
  const ts = sectionText("Test Strategy");
  if (ts === null || !substance(ts)) found.push({ code: "section-missing", detail: "## Test Strategy is missing or empty" });
  let probed = new Set<string>();
  let invalid = new Set<string>();
  try {
    const parsed = parseTestStrategyText(content, isaPath);
    for (const p of parsed.probes) {
      if (p.isc) probed.add(p.isc);
      if (p.anchors_to) probed.add(stripAnchorPrefix(p.anchors_to));
    }
    invalid = new Set((parsed.invalid ?? []).map((r) => r.isc));
  } catch (e) {
    found.push({ code: "test-strategy-unreadable", detail: `## Test Strategy could not be parsed: ${(e as Error).message}` });
    probed = new Set();
  }
  for (const id of claims) {
    if (probed.has(id)) continue;
    found.push({ code: "criterion-no-row", detail: invalid.has(id) ? `${id} has only an invalid Test Strategy row` : `${id} has no Test Strategy row` });
  }

  // ## Harness on project ISAs: a yaml block, or a `None — <reason>` line.
  if (project) {
    const h = sectionText("Harness");
    const s = h === null ? "" : substance(h);
    if (!s) found.push({ code: "section-missing", detail: "## Harness is missing or empty (required on project ISAs; write `None — <reason>` when the app has no surface)" });
    else if (!/^(```|~~~)\s*ya?ml\b/m.test(s) && !HARNESS_NONE.test(s)) found.push({ code: "harness-shape", detail: "## Harness has neither a yaml block nor a `None — <reason>` line" });
  }

  // Retired sections, then the fixed order of the recognized ones.
  for (const s of secs) if (RETIRED.includes(norm(s.title))) found.push({ code: "retired-section", detail: `## ${s.title.trim()} is retired` });
  // `## Features` is the feature-mode home of the criteria, so it may also stand in
  // the Criteria slot (canonical-isa.md and most ISAs put it before Test Strategy).
  const FEATURES = ORDER.findIndex((o) => o.name === "Features");
  const CRITERIA = ORDER.findIndex((o) => o.name === "Criteria");
  const TEST_STRATEGY = ORDER.findIndex((o) => o.name === "Test Strategy");
  let maxRank = -1, maxName = "";
  for (const s of secs) {
    let r = rankOf(s.title);
    if (r < 0) continue;
    if (r === FEATURES && maxRank < TEST_STRATEGY) r = Math.max(CRITERIA, maxRank);
    if (r < maxRank) found.push({ code: "order", detail: `## ${ORDER[r]!.name} comes after ## ${maxName}; the template puts it before` });
    else { maxRank = r; maxName = ORDER[r]!.name; }
  }

  // The stamp and the checkup key.
  const stamp = parseIsaFormat(fm.isa_format);
  if (!stamp.known) found.push({ code: "stamp-unknown", detail: `isa_format: ${fm.isa_format} is not a version (want x.y.z, or the legacy 3)` });
  else if (stamp.version !== null && found.length) found.push({ code: "stamp-unearned", detail: `isa_format claims ${stamp.version} but the ISA does not meet template ${ISA_TEMPLATE_VERSION}` });
  const checkup = fm.checkup !== undefined ? fm.checkup.replace(/^["']|["']$/g, "") : null;
  if (checkup !== null && !CHECKUP_RE.test(checkup)) found.push({ code: "checkup-shape", detail: `checkup: "${checkup}" is not YYYY-MM-DD <verdict> <n>→<m>` });

  return { template: ISA_TEMPLATE_VERSION, latest: found.length === 0, missing: found, stamp: stamp.version, checkup };
}
