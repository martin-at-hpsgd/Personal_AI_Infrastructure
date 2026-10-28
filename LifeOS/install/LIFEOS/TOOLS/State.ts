#!/usr/bin/env bun
/**
 * @version 1.1.7
 * State.ts — short-form current-state journal (H2/M3-style entries).
 *
 * The grammar: <Letter(s)><Digit 1-5> with an optional free-text note.
 * Scale: 1 really bad · 2 bad · 3 fine, never a crisis · 4 and 5 the preferred range (higher is better,
 * star-rating semantics — scale rationale: OPERATIONAL_PREFERENCES / the state-logging skill).
 *   H overall · M mood · E energy · S sleep · R relationships · F financial
 *   C creativity · CF creative freedom
 *   W workout · K walk  (W/K are freshness counters — a bare `W` resets them)
 * Freshness is per-dimension, three tiers (fresh/aging/stale) from windows
 * declared in DIMENSIONS; current.json mirrors the windows for jq consumers.
 *
 * Data lives in LIFEOS/USER/STATE/ (principal data, release-excluded):
 *   log.jsonl     — append-only journal, one entry per line
 *   current.json  — derived snapshot (latest value + ts per dimension)
 *
 * Consumers: LIFEOS_StatusLine.sh (jq read of current.json — never spawns bun),
 * the state-logging skill, the Interview skill, Hermes.
 *
 * Usage:
 *   bun State.ts log "M2"                  # rate mood 2
 *   bun State.ts log "M1 slept badly"      # rating + note
 *   bun State.ts log "W"                   # reset workout freshness
 *   bun State.ts log "H3" --source interview
 *   bun State.ts reset W|K                 # same as bare-letter log
 *   bun State.ts current [--json]          # snapshot, human or JSON
 *   bun State.ts statusline                # compact plain-text segment
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { invariant } from "./Invariant";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Resolved per call, never at import: bun test shares one process across files, so an import-time constant
// would pin whichever LIFEOS_STATE_DIR the first importer saw (2026-09-05, found by bisecting a polluted run).
const stateDir = (): string => process.env.LIFEOS_STATE_DIR || join(SCRIPT_DIR, "..", "USER", "STATE");
const logPath = (): string => join(stateDir(), "log.jsonl");
const currentPath = (): string => join(stateDir(), "current.json");

// Every dimension reads the same direction: higher is better, 1-5. Nothing on
// the roster is inverted, so the statusline ramp never flips. Any dimension that
// would rate a pressure's INTENSITY is expressed through CF instead, which reads
// the same axis from the good end. Roster and its history:
// The state-logging skill’s customization Config.md
//
// CF (creative freedom) rates access to inner creativity. C joins it as the
// OUTCOME to CF's condition: freedom describes the conditions for creativity, C
// rates what actually came out. Deliberately independent and hand-rated, never
// derived from CF — high freedom with low output is exactly the signal worth
// catching.
// E (energy) is likewise its own dimension, not a proxy for mood or sleep.
//
// Parser note: the shorthand regex takes letters greedily ({1,2}), so single-letter
// C never shadows CF — "CF2" still parses as CF.
//
// Freshness model (v2, 2026-08-17): each dimension decays at its own rate, so
// staleness is per-dim, never a global constant. Rating dims carry freshH/staleH
// (hours): age ≤ freshH → fresh · ≤ staleH → aging · beyond → stale. Freshness
// dims carry targetDays (the cadence the counter exists to protect): days ≤
// target → fresh · ≤ 2×target → aging · beyond → stale. These windows are the
// single source of truth — deriveCurrent mirrors them into current.json so the
// statusline can tier in pure jq without spawning bun.
// `label` is the DISPLAY name (statusline and any dashboard) — the input
// grammar stays the single letters, but rendered output always uses words:
// bare letters are not readable at a glance.
export const DIMENSIONS: Record<
  string,
  {
    name: string;
    label: string;
    kind: "rating" | "freshness";
    freshH?: number;
    staleH?: number;
    targetDays?: number;
  }
> = {
  H: { name: "overall", label: "OVR", kind: "rating", freshH: 24, staleH: 72 },
  M: { name: "mood", label: "MOOD", kind: "rating", freshH: 12, staleH: 36 },
  E: { name: "energy", label: "ENRG", kind: "rating", freshH: 12, staleH: 36 },
  S: { name: "sleep", label: "SLEEP", kind: "rating", freshH: 18, staleH: 36 },
  R: { name: "relationships", label: "RELS", kind: "rating", freshH: 72, staleH: 168 },
  F: { name: "financial", label: "FIN", kind: "rating", freshH: 72, staleH: 168 },
  C: { name: "overall creativity", label: "CREAT", kind: "rating", freshH: 24, staleH: 72 },
  CF: { name: "creative freedom", label: "FREE", kind: "rating", freshH: 24, staleH: 72 },
  W: { name: "workout", label: "WKOUT", kind: "freshness", targetDays: 2 },
  K: { name: "walk", label: "WALK", kind: "freshness", targetDays: 1 },
  A: { name: "affirmation", label: "AFFIRM", kind: "freshness", targetDays: 1 },
};

export type FreshnessTier = "fresh" | "aging" | "stale";

export interface StateEntry {
  ts: string; // ISO 8601
  dim: string; // roster letter
  value: number | null; // 1-5 clamped; null = freshness reset with no rating
  raw?: number; // pre-clamp value when it differed
  note?: string;
  source: string; // manual | interview | signal | import
}

export interface ParsedEntry {
  dim: string;
  value: number | null;
  raw?: number;
  note?: string;
}

/** Parse one shorthand entry: "M2", "m2 slept badly", "CF4", bare "W". */
export function parseEntry(input: string): ParsedEntry | { error: string } {
  const trimmed = input.trim();
  const m = trimmed.match(/^([A-Za-z]{1,2})\s*(\d)?\s*(.*)$/s);
  if (!m) return { error: `unparseable entry: "${input}"` };
  const dim = m[1].toUpperCase();
  const spec = DIMENSIONS[dim];
  if (!spec) {
    const roster = Object.keys(DIMENSIONS).join(" ");
    return { error: `unknown dimension "${dim}" — roster: ${roster}` };
  }
  const note = m[3]?.trim() || undefined;
  if (m[2] === undefined) {
    if (spec.kind === "freshness") return { dim, value: null, note };
    return { error: `${dim} (${spec.name}) needs a value 1-5, e.g. ${dim}4` };
  }
  const raw = parseInt(m[2], 10);
  // Canonical scale is 1-5; tolerate 0/6-9 by clamping, preserve raw.
  const value = Math.min(5, Math.max(1, raw));
  return { dim, value, ...(value !== raw ? { raw } : {}), note };
}

/**
 * Parse a whole message, which may carry several entries: "m2 e2 sick", "e4 cf3", "W K".
 * A message made only of shorthand tokens is one entry per token. Otherwise the leading run
 * of letter+digit tokens are the entries and the rest is a note shared by all of them; a bare
 * freshness letter mid-message stays note text ("M2 a rough day" is never an affirmation).
 * Anything else falls through to parseEntry unchanged. Any bad entry fails the whole message.
 */
export function parseEntries(input: string): ParsedEntry[] | { error: string } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const isRating = (t: string) =>
    /^[A-Za-z]{1,2}\d$/.test(t) && DIMENSIONS[t.slice(0, -1).toUpperCase()]?.kind === "rating";
  const isReset = (t: string) => DIMENSIONS[t.toUpperCase()]?.kind === "freshness";

  let shorthand: string[] = [];
  let note: string | undefined;
  if (tokens.length > 1 && tokens.every((t) => isRating(t) || isReset(t))) {
    shorthand = tokens;
  } else {
    let run = 0;
    while (run < tokens.length && isRating(tokens[run])) run++;
    if (run > 1) {
      shorthand = tokens.slice(0, run);
      note = tokens.slice(run).join(" ") || undefined;
    }
  }
  if (shorthand.length === 0) {
    const one = parseEntry(input);
    return "error" in one ? one : [one];
  }

  const out: ParsedEntry[] = [];
  for (const t of shorthand) {
    const parsed = parseEntry(t);
    if ("error" in parsed) return parsed;
    out.push(note ? { ...parsed, note } : parsed);
  }
  return out;
}

function ensureDir(): void {
  if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
}

export function readLog(): StateEntry[] {
  if (!existsSync(logPath())) return [];
  return readFileSync(logPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as StateEntry);
}

export interface CurrentState {
  updated: string;
  dims: Record<string, { value: number | null; ts: string; note?: string; source: string }>;
  /** Per-dim freshness windows mirrored from DIMENSIONS so render paths tier in jq. */
  windows?: Record<string, { fresh?: number; stale?: number; target?: number }>;
  /** Display labels mirrored from DIMENSIONS so render paths never show bare letters. */
  labels?: Record<string, string>;
}

function windowsSnapshot(): NonNullable<CurrentState["windows"]> {
  const w: NonNullable<CurrentState["windows"]> = {};
  for (const [letter, spec] of Object.entries(DIMENSIONS)) {
    w[letter] =
      spec.kind === "freshness"
        ? { target: spec.targetDays }
        : { fresh: spec.freshH, stale: spec.staleH };
  }
  return w;
}

function labelsSnapshot(): NonNullable<CurrentState["labels"]> {
  return Object.fromEntries(Object.entries(DIMENSIONS).map(([l, s]) => [l, s.label]));
}

/** Derive the snapshot from the full log (latest entry per dimension). */
export function deriveCurrent(entries: StateEntry[]): CurrentState {
  const dims: CurrentState["dims"] = {};
  for (const e of entries) {
    // Retired dims stay in the append-only log but must never resurface in the
    // snapshot — the roster is the sole authority on what renders.
    if (!DIMENSIONS[e.dim]) continue;
    // entries are chronological (append-only) — last write per dim wins
    dims[e.dim] = { value: e.value, ts: e.ts, ...(e.note ? { note: e.note } : {}), source: e.source };
  }
  return { updated: new Date().toISOString(), dims, windows: windowsSnapshot(), labels: labelsSnapshot() };
}

/** Freshness tier for a dimension's latest timestamp, from its declared windows. */
export function freshnessTier(dim: string, ts: string, now: Date = new Date()): FreshnessTier {
  const spec = DIMENSIONS[dim];
  invariant(spec, `dim ${dim} not in roster`);
  if (spec.kind === "freshness") {
    const days = daysSince(ts, now);
    const target = spec.targetDays ?? 2;
    return days <= target ? "fresh" : days <= 2 * target ? "aging" : "stale";
  }
  const age = hoursSince(ts, now);
  return age <= (spec.freshH ?? 24) ? "fresh" : age <= (spec.staleH ?? 72) ? "aging" : "stale";
}

export function logEntry(parsed: ParsedEntry, source: string): StateEntry {
  invariant(DIMENSIONS[parsed.dim], `dim ${parsed.dim} not in roster`);
  invariant(
    parsed.value === null || (parsed.value >= 1 && parsed.value <= 5),
    `value ${parsed.value} outside 1-5 after clamp`,
  );
  invariant(source.length > 0, "source must be non-empty");
  ensureDir();
  const entry: StateEntry = {
    ts: new Date().toISOString(),
    dim: parsed.dim,
    value: parsed.value,
    ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}),
    ...(parsed.note ? { note: parsed.note } : {}),
    source,
  };
  appendFileSync(logPath(), JSON.stringify(entry) + "\n");
  const current = deriveCurrent(readLog());
  writeFileSync(currentPath(), JSON.stringify(current, null, 2) + "\n");
  return entry;
}

export function hoursSince(iso: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(iso).getTime()) / 3_600_000;
}

export function daysSince(iso: string, now: Date = new Date()): number {
  return Math.floor(hoursSince(iso, now) / 24);
}

/** Human-scale age: `Nh` under 48h, else `Nd`. */
export function ageLabel(iso: string, now: Date = new Date()): string {
  const h = hoursSince(iso, now);
  return h < 48 ? `${Math.round(h)}h` : `${daysSince(iso, now)}d`;
}

/**
 * Compact plain-text segment for the statusline (no ANSI — bash colors it).
 * Word labels, never bare letters. Fresh dims show just the value; aging and
 * stale append the explicit age: `MOOD4` · `ENRG2(20h)` · `SLEEP1(3d)`;
 * unrated: `MOOD-`. Freshness dims: days since last reset — `WKOUT0d`.
 */
export function statuslineSegment(current: CurrentState | null, now: Date = new Date()): string {
  const parts: string[] = [];
  for (const [letter, spec] of Object.entries(DIMENSIONS)) {
    const d = current?.dims[letter];
    if (!d) {
      parts.push(`${spec.label}-`);
      continue;
    }
    if (spec.kind === "freshness") {
      parts.push(`${spec.label}${daysSince(d.ts, now)}d`);
    } else if (d.value === null) {
      parts.push(`${spec.label}-`);
    } else {
      const tier = freshnessTier(letter, d.ts, now);
      const suffix = tier === "fresh" ? "" : `(${ageLabel(d.ts, now)})`;
      parts.push(`${spec.label}${d.value}${suffix}`);
    }
  }
  return parts.join(" ");
}

function readCurrent(): CurrentState | null {
  if (!existsSync(currentPath())) return null;
  try {
    return JSON.parse(readFileSync(currentPath(), "utf8")) as CurrentState;
  } catch {
    return null;
  }
}

function humanCurrent(current: CurrentState | null): string {
  if (!current) return "no state logged yet";
  const now = new Date();
  const lines: string[] = [];
  for (const [letter, spec] of Object.entries(DIMENSIONS)) {
    const d = current.dims[letter];
    if (!d) {
      lines.push(`${letter}  ${spec.name.padEnd(13)} —`);
      continue;
    }
    const age = hoursSince(d.ts, now);
    const ageStr = age < 48 ? `${Math.round(age)}h ago` : `${daysSince(d.ts, now)}d ago`;
    const tier = freshnessTier(letter, d.ts, now);
    const val = spec.kind === "freshness" ? `last ${ageStr}` : `${d.value ?? "—"} (${ageStr})`;
    lines.push(
      `${letter}  ${spec.name.padEnd(13)} ${val}  [${tier}]${d.note ? `  — ${d.note}` : ""}`,
    );
  }
  return lines.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const srcIdx = rest.indexOf("--source");
  const source = srcIdx >= 0 ? rest[srcIdx + 1] : "manual";
  const args = srcIdx >= 0 ? [...rest.slice(0, srcIdx), ...rest.slice(srcIdx + 2)] : rest;

  switch (cmd) {
    case "log": {
      const input = args.join(" ");
      const parsed = parseEntries(input);
      if ("error" in parsed) {
        console.error(parsed.error);
        process.exit(1);
      }
      for (const p of parsed) {
        const entry = logEntry(p, source);
        const spec = DIMENSIONS[entry.dim];
        if (spec.kind === "freshness" && entry.value === null) {
          console.log(`${entry.dim} (${spec.name}) reset`);
        } else {
          console.log(`${entry.dim}${entry.value} logged (${spec.name})`);
        }
      }
      break;
    }
    case "reset": {
      const dim = (args[0] || "").toUpperCase();
      const spec = DIMENSIONS[dim];
      if (!spec || spec.kind !== "freshness") {
        console.error(`reset takes a freshness dimension (W or K), got "${args[0] ?? ""}"`);
        process.exit(1);
      }
      logEntry({ dim, value: null }, source === "manual" ? "signal" : source);
      console.log(`${dim} (${spec.name}) reset`);
      break;
    }
    case "current": {
      const current = readCurrent();
      if (args.includes("--json")) console.log(JSON.stringify(current, null, 2));
      else console.log(humanCurrent(current));
      break;
    }
    case "statusline": {
      console.log(statuslineSegment(readCurrent()));
      break;
    }
    case "rebuild": {
      // Re-derive current.json from the full log — picks up window/schema changes.
      ensureDir();
      writeFileSync(currentPath(), JSON.stringify(deriveCurrent(readLog()), null, 2) + "\n");
      console.log(`current.json rebuilt (${Object.keys(readLog().reduce((a, e) => ({ ...a, [e.dim]: 1 }), {})).length} dims)`);
      break;
    }
    default:
      console.log("usage: State.ts log <entry> [--source s] | reset W|K | current [--json] | statusline | rebuild");
      process.exit(cmd ? 1 : 0);
  }
}
