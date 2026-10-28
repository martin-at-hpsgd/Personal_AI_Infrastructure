#!/usr/bin/env bun
/**
 * TelosRegions — the one parser for the machine-owned AUTOMATED regions in TELOS.md.
 *
 * TELOS keeps the principal's hand-written Current State and Ideal State at the
 * top of each section. Below each sits a fenced region that a scheduled step
 * renders from measurements (current) and from the principal's own stated wants
 * (ideal):
 *
 *   <!-- AUTOMATED:BEGIN current -->
 *   <!-- AUTOMATED:STAMP written 2026-10-11T04:00:00.000Z · machine-owned, hand edits here are overwritten -->
 *   #### Sleep
 *   ...
 *   <!-- AUTOMATED:END current -->
 *
 * Rules the fence carries:
 *   - It sits at the END of its H2 section, before the closing standalone `---`.
 *   - Its content uses H4 headings only, never `---` or `===` lines, never a
 *     TelosFreshness `<!-- updated: -->` marker, so no reader that walks H2
 *     sections or section ends can be fooled by it.
 *   - Exactly one stamp line, which TelosFreshness MARKER_RE never matches and
 *     which contentHash() ignores, so an unchanged render hashes the same.
 *
 * Every reader that must see only hand-written bytes (TelosFreshness, the telos
 * Vigil adapter, DeriveDenyHashes, the Pulse TELOS parser) goes through
 * exciseRegions() or linesOutsideRegions(). The one writer is UpdateTelos
 * `--region`, which calls planRegionWrite() here.
 *
 * CLI:
 *   bun LIFEOS/TOOLS/TelosRegions.ts check current|ideal [--file <path>] [--json]
 *       exit 0 when the region is present, well formed and in its own section; 1 otherwise
 *   bun LIFEOS/TOOLS/TelosRegions.ts audit-manual current|ideal [--file <path>] [--json]
 *       print-only: counts measured numerics (units, currency, metric labels) in the
 *       hand-written part of the section; exit 1 when any are found
 *
 * @version 1.0.0
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { getLifeosDir } from "./Paths";

export type RegionWhich = "current" | "ideal";
export const REGION_WHICH: readonly RegionWhich[] = ["current", "ideal"] as const;

/** The H2 heading each region belongs under, matched as a case-insensitive prefix. */
export const REGION_SECTION: Record<RegionWhich, string> = { current: "Current State", ideal: "Ideal State" };

const BEGIN_RE = /^<!--\s*AUTOMATED:BEGIN\s+([A-Za-z0-9_-]+)\s*-->\s*$/;
const END_RE = /^<!--\s*AUTOMATED:END\s+([A-Za-z0-9_-]+)\s*-->\s*$/;
const STAMP_RE = /^<!--\s*AUTOMATED:STAMP\b[^\n]*-->\s*$/;
/** Any TelosFreshness-style marker. Kept local so this module never imports TelosFreshness (which imports this). */
const FRESHNESS_MARKER_RE = /<!--\s*updated\s*:/i;
const H2_RE = /^##\s+(.+?)\s*$/;
const SECTION_BREAK_RE = /^#{1,2}\s/;

export const beginMarker = (which: RegionWhich): string => `<!-- AUTOMATED:BEGIN ${which} -->`;
export const endMarker = (which: RegionWhich): string => `<!-- AUTOMATED:END ${which} -->`;

/** The one stamp line a written region carries. Never matches TelosFreshness MARKER_RE. */
export function stampLine(now: Date): string {
  return `<!-- AUTOMATED:STAMP written ${now.toISOString()} · machine-owned, hand edits here are overwritten -->`;
}
export const isStampLine = (line: string): boolean => STAMP_RE.test(line);

/** Expected, operator-visible failure (bad body, missing section, malformed fence). Never an InvariantViolation. */
export class RegionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegionError";
  }
}

export interface Region {
  which: RegionWhich;
  /** Text of the enclosing H2 heading, or "" when the fence sits above any H2. */
  section: string;
  /** 0-based line index of the BEGIN marker. */
  beginLine: number;
  /** 0-based line index of the END marker. */
  endLine: number;
  /** Offset of the first byte of the BEGIN line. */
  start: number;
  /** Offset of the first byte after the BEGIN line. */
  bodyStart: number;
  /** Offset of the first byte of the END line. */
  bodyEnd: number;
  /** Offset just past the END line and, when present, one following blank line: the excise end. */
  end: number;
  /** Bytes between the markers. */
  body: string;
}

export interface ParsedRegions {
  current?: Region;
  ideal?: Region;
  /** Every well-formed BEGIN/END pair, placed correctly or not. Readers excise all of them. */
  regions: Region[];
  /** Malformed or misplaced fences, each message prefixed with the region name when known. */
  problems: string[];
}

function lineOffsets(raw: string): { lines: string[]; starts: number[] } {
  const lines = raw.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  return { lines, starts };
}

const isWhich = (w: string): w is RegionWhich => (REGION_WHICH as readonly string[]).includes(w);
const sectionMatches = (heading: string, which: RegionWhich): boolean =>
  heading.toLowerCase().startsWith(REGION_SECTION[which].toLowerCase());

/** Parse every AUTOMATED fence in the raw file. Pure; never throws. */
export function parseRegions(raw: string): ParsedRegions {
  const { lines, starts } = lineOffsets(raw);
  const out: ParsedRegions = { regions: [], problems: [] };
  let section = "";
  let open: { which: string; line: number; section: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h2 = line.match(H2_RE);
    if (h2 || /^#\s/.test(line)) {
      if (open) {
        out.problems.push(`${open.which}: BEGIN at line ${open.line + 1} has no END before the next heading at line ${i + 1}`);
        open = null;
      }
      section = h2 ? h2[1]! : "";
      continue;
    }
    const b = line.match(BEGIN_RE);
    if (b) {
      if (open) out.problems.push(`${open.which}: BEGIN at line ${open.line + 1} is still open when another BEGIN appears at line ${i + 1}`);
      open = { which: b[1]!, line: i, section };
      continue;
    }
    const e = line.match(END_RE);
    if (!e) continue;
    if (!open) {
      out.problems.push(`${e[1]}: END at line ${i + 1} has no BEGIN`);
      continue;
    }
    if (open.which !== e[1]) {
      out.problems.push(`${open.which}: BEGIN at line ${open.line + 1} is closed by END ${e[1]} at line ${i + 1}`);
      open = null;
      continue;
    }
    const which = open.which;
    if (!isWhich(which)) {
      out.problems.push(`${which}: unknown region name at line ${open.line + 1} (expected ${REGION_WHICH.join(" or ")})`);
      open = null;
      continue;
    }
    const lineEnd = i + 1 < lines.length ? starts[i + 1]! : raw.length;
    const end = raw[lineEnd] === "\n" ? lineEnd + 1 : lineEnd;
    const region: Region = {
      which,
      section: open.section,
      beginLine: open.line,
      endLine: i,
      start: starts[open.line]!,
      bodyStart: starts[open.line + 1]!,
      bodyEnd: starts[i]!,
      end,
      body: raw.slice(starts[open.line + 1]!, starts[i]!),
    };
    out.regions.push(region);
    if (!sectionMatches(open.section, which)) {
      out.problems.push(`${which}: region at line ${open.line + 1} sits under "${open.section || "no H2"}", expected "## ${REGION_SECTION[which]}"`);
    } else if (out[which]) {
      out.problems.push(`${which}: duplicate region at line ${open.line + 1}`);
    } else {
      out[which] = region;
    }
    open = null;
  }
  if (open) out.problems.push(`${open.which}: BEGIN at line ${open.line + 1} has no END`);
  return out;
}

/** Remove well-formed regions (markers, body, and one following blank line). Unpaired markers stay. */
export function exciseRegions(raw: string, which?: RegionWhich): string {
  const ranges = parseRegions(raw).regions.filter((r) => !which || r.which === which);
  let out = raw;
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + out.slice(r.end);
  return out;
}

/** The lines a hand-written reader should see, each with its real 1-based line number in `raw`. */
export function linesOutsideRegions(raw: string): Array<{ text: string; line: number }> {
  const ranges = parseRegions(raw).regions;
  const { lines, starts } = lineOffsets(raw);
  const kept: Array<{ text: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const at = starts[i]!;
    if (ranges.some((r) => at >= r.start && at < r.end)) continue;
    kept.push({ text: lines[i]!, line: i + 1 });
  }
  return kept;
}

/** CRLF → LF, leading and trailing blank lines dropped, one trailing newline when non-empty. */
function canonicalBody(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** The body minus any stamp line, canonicalized. What contentHash() hashes. */
export function normalizeBody(body: string): string {
  return canonicalBody(body.replace(/\r\n?/g, "\n").split("\n").filter((l) => !isStampLine(l)).join("\n"));
}

/** sha256 of the body excluding the stamp line, so a re-render with no new content hashes the same. */
export function contentHash(body: string): string {
  return createHash("sha256").update(normalizeBody(body)).digest("hex");
}

/** Reject anything that would let region bytes leak into a hand-written reader's view of the file. */
export function validateBody(body: string): void {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let stamps = 0;
  lines.forEach((line, i) => {
    const n = i + 1;
    const heading = line.match(/^(#{1,6})\s/);
    if (heading && heading[1]!.length !== 4) throw new RegionError(`region body line ${n}: only H4 (####) headings are allowed`);
    if (line.trim() === "---" || /^\s*=+\s*$/.test(line)) throw new RegionError(`region body line ${n}: divider or setext underline is not allowed`);
    if (BEGIN_RE.test(line) || END_RE.test(line)) throw new RegionError(`region body line ${n}: AUTOMATED markers are not allowed inside a region`);
    if (FRESHNESS_MARKER_RE.test(line)) throw new RegionError(`region body line ${n}: a TelosFreshness updated marker is not allowed inside a region`);
    if (isStampLine(line)) stamps++;
  });
  if (stamps > 1) throw new RegionError(`region body carries ${stamps} stamp lines; at most one is allowed`);
}

/** Where a new fence goes: the start of the line that closes the section (next H1/H2 or standalone `---`), or EOF. */
function fenceInsertOffset(raw: string, which: RegionWhich): number {
  const { lines, starts } = lineOffsets(raw);
  const head = lines.findIndex((l) => {
    const m = l.match(H2_RE);
    return !!m && sectionMatches(m[1]!, which);
  });
  if (head === -1) throw new RegionError(`no "## ${REGION_SECTION[which]}" section in the file`);
  for (let i = head + 1; i < lines.length; i++) {
    if (SECTION_BREAK_RE.test(lines[i]!) || lines[i]!.trim() === "---") return starts[i]!;
  }
  if (raw.length && !raw.endsWith("\n")) throw new RegionError(`"## ${REGION_SECTION[which]}" runs to EOF without a trailing newline`);
  return raw.length;
}

/**
 * Replace the bytes between the `which` markers with `body`, inserting the
 * fence at the end of its section when it is absent. Pure. Asserts that every
 * byte outside the region is unchanged.
 */
export function replaceRegion(raw: string, which: RegionWhich, body: string): string {
  validateBody(body);
  const parsed = parseRegions(raw);
  if (parsed.problems.length) throw new RegionError(`malformed AUTOMATED fences: ${parsed.problems.join("; ")}`);
  const canon = canonicalBody(body);
  const existing = parsed[which];
  let next: string;
  if (existing) {
    next = raw.slice(0, existing.bodyStart) + canon + raw.slice(existing.bodyEnd);
  } else {
    const at = fenceInsertOffset(raw, which);
    next = `${raw.slice(0, at)}${beginMarker(which)}\n${canon}${endMarker(which)}\n\n${raw.slice(at)}`;
  }
  invariant(exciseRegions(next, which) === exciseRegions(raw, which), `replaceRegion(${which}) changed bytes outside the region`);
  const after = parseRegions(next);
  invariant(after.problems.length === 0 && after[which]?.body === canon, `replaceRegion(${which}) produced a malformed fence`);
  return next;
}

export interface RegionPlan {
  /** False when the stored body already hashes the same: nothing to write. */
  changed: boolean;
  /** The full file to write; equals `raw` when unchanged. */
  next: string;
  /** contentHash of the requested body. */
  hash: string;
}

/**
 * Decide a region write: skip when the content hash is unchanged, otherwise
 * render one stamp line plus the body into the region. Pure and deterministic
 * for a given `now`.
 */
export function planRegionWrite(raw: string, which: RegionWhich, body: string, now: Date): RegionPlan {
  validateBody(body);
  const parsed = parseRegions(raw);
  if (parsed.problems.length) throw new RegionError(`malformed AUTOMATED fences: ${parsed.problems.join("; ")}`);
  const hash = contentHash(body);
  const existing = parsed[which];
  if (existing && contentHash(existing.body) === hash) return { changed: false, next: raw, hash };
  const stamp = stampLine(now);
  invariant(!FRESHNESS_MARKER_RE.test(stamp), "stamp line would read as a TelosFreshness marker");
  const next = replaceRegion(raw, which, `${stamp}\n${normalizeBody(body)}`);
  return { changed: true, next, hash };
}

// ─── Manual-top audit ────────────────────────────────────────────────────

const NUMBER_RE = /(\$\s?)?(\d[\d,]*(?:\.\d+)?)/g;
const UNIT_RE = /^\s?(%|(?:bpm|ms|kgs?|lbs?|kcal|hrs?|hours?|h|mins?|minutes?|steps|k|m)\b)/i;
const LABEL_RE = /\b(rhr|hrv|vo2\s?max|readiness|sleep score|score|mrr|arr|revenue|subscribers?|weight|steps|resting hr|heart rate)\b[^\d\n]{0,12}$/i;

/** Classify one numeric token on a line; null when it is not a measurement (dates, times, years, bare counts). */
function measuredUnit(line: string, index: number, dollar: string | undefined, digits: string): string | null {
  const before = line.slice(0, index);
  const after = line.slice(index + (dollar?.length ?? 0) + digits.length);
  if (/[\d][-/:.]$/.test(before) || /^[-/:]\d/.test(after)) return null; // part of a date or time
  if (dollar) return "currency";
  const unit = after.match(UNIT_RE);
  if (unit) return unit[1]!.toLowerCase();
  if (/^(19|20)\d\d$/.test(digits)) return null; // a bare year
  const label = line.slice(Math.max(0, index - 24), index).match(LABEL_RE);
  return label ? label[1]!.toLowerCase() : null;
}

export interface ManualAudit {
  which: RegionWhich;
  count: number;
  lines: Array<{ line: number; kinds: string[] }>;
}

/** Count measured numerics in the hand-written part of the `which` section. Read-only. */
export function auditManual(raw: string, which: RegionWhich): ManualAudit {
  const kept = linesOutsideRegions(raw);
  const head = kept.findIndex((l) => {
    const m = l.text.match(H2_RE);
    return !!m && sectionMatches(m[1]!, which);
  });
  if (head === -1) throw new RegionError(`no "## ${REGION_SECTION[which]}" section in the file`);
  const report: ManualAudit = { which, count: 0, lines: [] };
  for (let i = head + 1; i < kept.length; i++) {
    const { text, line } = kept[i]!;
    if (SECTION_BREAK_RE.test(text) || text.trim() === "---") break;
    if (/^\s*<!--/.test(text)) continue;
    const kinds: string[] = [];
    for (const m of text.matchAll(NUMBER_RE)) {
      const kind = measuredUnit(text, m.index!, m[1], m[2]!);
      if (kind) kinds.push(kind);
    }
    if (kinds.length) {
      report.count += kinds.length;
      report.lines.push({ line, kinds });
    }
  }
  return report;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function defaultTelosPath(): string {
  return join(getLifeosDir(), "USER", "TELOS", "TELOS.md");
}

function cli(argv: string[]): number {
  const [cmd, which] = argv;
  const fileIdx = argv.indexOf("--file");
  const file = fileIdx !== -1 ? argv[fileIdx + 1] : defaultTelosPath();
  const json = argv.includes("--json");
  const usage = "usage: TelosRegions.ts check|audit-manual current|ideal [--file <path>] [--json]";
  if (!cmd || !which || !isWhich(which) || !file || !["check", "audit-manual"].includes(cmd)) {
    console.error(usage);
    return 2;
  }
  if (!existsSync(file)) {
    console.error(`TELOS file not found: ${file}`);
    return 1;
  }
  const raw = readFileSync(file, "utf8");

  if (cmd === "check") {
    const parsed = parseRegions(raw);
    const region = parsed[which];
    const problems = parsed.problems.filter((p) => p.startsWith(`${which}:`));
    const ok = !!region && problems.length === 0;
    const result = {
      which,
      present: !!region,
      section: region?.section ?? null,
      lines: region ? region.endLine - region.beginLine - 1 : 0,
      hash: region ? contentHash(region.body).slice(0, 12) : null,
      problems,
    };
    if (json) console.log(JSON.stringify(result));
    else if (ok) console.log(`${which}: present under "## ${result.section}", ${result.lines} lines, content ${result.hash}`);
    else console.log(`${which}: ${region ? "present but" : "absent"}${problems.length ? ` — ${problems.join("; ")}` : ""}`);
    return ok ? 0 : 1;
  }

  let report: ManualAudit;
  try {
    report = auditManual(raw, which);
  } catch (e) {
    if (!(e instanceof RegionError)) throw e;
    console.error(e.message);
    return 1;
  }
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`${which} manual top: ${report.count} measured numeric${report.count === 1 ? "" : "s"}`);
    for (const l of report.lines) console.log(`  line ${l.line}: ${l.kinds.join(", ")}`);
  }
  return report.count === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(cli(process.argv.slice(2)));
