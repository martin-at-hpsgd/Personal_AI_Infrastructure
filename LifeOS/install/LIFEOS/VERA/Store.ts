/**
 * Vera Store — JSONL claim ledgers in the private USER tree.
 *
 * Layout (Restricted Data, git-versioned — git IS the version layer):
 *   $VERA_DATA_DIR/people/<slug>/claims.jsonl   one row per line
 *   $VERA_DATA_DIR/people/<slug>/Profile.md     generated view (Profile.ts)
 *   $VERA_DATA_DIR/axes.json                    the axes tree (view config)
 *
 * VERA_DATA_DIR defaults to ~/.claude/LIFEOS/USER/VERA (symlinked private repo).
 * No score is ever stored — scores are projections computed at read time.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { lifeosPath } from "../TOOLS/Paths";
import { type AxesTree, type ClaimRow, validateRow } from "./Schema";

/** Resolved per call: bun test shares one process across files, so an import-time constant pins the first
 * importer's VERA_DATA_DIR for every later suite (2026-09-05, found by bisecting a polluted run). */
export function veraDataDir(): string {
  return process.env.VERA_DATA_DIR ?? lifeosPath("USER", "VERA");
}
/** Import-time snapshot, kept for callers that only need the production default. Prefer veraDataDir(). */
export const VERA_DATA_DIR = veraDataDir();

export const DEFAULT_AXES: AxesTree = {
  branches: [
    {
      name: "judgment",
      leaves: [
        { name: "predictions", tags: ["predictions", "forecast"], type: "accuracy" },
        { name: "calibration", tags: ["calibration", "hedging"], type: "judged" },
        { name: "reasoning", tags: ["reasoning", "argument"], type: "judged" },
        { name: "domain-accuracy", tags: ["domain-accuracy", "accuracy"], type: "accuracy" },
      ],
    },
    {
      name: "craft",
      leaves: [
        { name: "technical-depth", tags: ["technical-depth", "technical"], type: "judged" },
        { name: "originality", tags: ["originality", "creativity"], type: "judged" },
        { name: "clarity", tags: ["clarity", "communication"], type: "judged" },
        { name: "rigor", tags: ["rigor", "method"], type: "judged" },
      ],
    },
    {
      name: "conduct",
      leaves: [
        { name: "integrity", tags: ["integrity", "ethics"], type: "structural" },
        { name: "consistency", tags: ["consistency", "says-does"], type: "structural" },
        { name: "updates-when-wrong", tags: ["updates-when-wrong", "updating"], type: "structural" },
        { name: "stays-in-lane", tags: ["stays-in-lane", "lane"], type: "structural" },
      ],
    },
    {
      name: "position",
      leaves: [
        { name: "connectedness", tags: ["connectedness", "network"], type: "structural" },
        { name: "cited-by", tags: ["cited-by", "citations"], type: "structural" },
        { name: "access", tags: ["access", "in-the-room"], type: "structural" },
        { name: "track-record", tags: ["track-record", "shipped", "exits"], type: "structural" },
      ],
    },
  ],
};

export function personDir(slug: string): string {
  invariant(/^[a-z0-9][a-z0-9-]*$/.test(slug), `invalid person slug: ${slug}`);
  return join(veraDataDir(), "people", slug);
}

export function ledgerPath(slug: string): string {
  return join(personDir(slug), "claims.jsonl");
}

export function loadAxes(): AxesTree {
  const p = join(veraDataDir(), "axes.json");
  if (!existsSync(p)) return DEFAULT_AXES;
  return JSON.parse(readFileSync(p, "utf8")) as AxesTree;
}

export function ensureAxesFile(): string {
  const p = join(veraDataDir(), "axes.json");
  if (!existsSync(p)) {
    mkdirSync(veraDataDir(), { recursive: true });
    writeFileSync(p, JSON.stringify(DEFAULT_AXES, null, 2) + "\n");
  }
  return p;
}

export function readLedger(slug: string): ClaimRow[] {
  const p = ledgerPath(slug);
  if (!existsSync(p)) return [];
  const rows: ClaimRow[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as ClaimRow);
  }
  return rows;
}

export function listPeople(): string[] {
  const root = join(veraDataDir(), "people");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * True when the ledger already carries this claim — by id, or by identical
 * statement text for the same person. Id formulas have changed across
 * versions (the 2026-09-07 import-kb re-run duplicated rows on id alone),
 * so bulk importers must dedupe on content, not only on id.
 */
export function hasClaim(rows: ClaimRow[], row: Pick<ClaimRow, "id" | "person" | "statement">): boolean {
  return rows.some((r) => r.id === row.id || (r.person === row.person && r.statement === row.statement));
}

/** Append one validated row. Throws InvariantViolation on malformed input. */
export function addClaim(row: ClaimRow): void {
  const errs = validateRow(row);
  invariant(errs.length === 0, `claim row invalid: ${errs.map((e) => `${e.field}: ${e.problem}`).join("; ")}`);
  const existing = readLedger(row.person);
  invariant(!existing.some((r) => r.id === row.id), `duplicate claim id ${row.id}`);
  if (row.kind === "verifiable" && row.resolution === undefined) row.resolution = "pending";
  mkdirSync(personDir(row.person), { recursive: true });
  appendFileSync(ledgerPath(row.person), JSON.stringify(row) + "\n");
}

/** Display title for a person: the Cortex People note's title, else the slug. Resolved per call (see veraDataDir). */
export function titleFor(slug: string): string {
  const kb = process.env.VERA_KB_PEOPLE_DIR ?? lifeosPath("MEMORY", "KNOWLEDGE", "People");
  const p = join(kb, `${slug}.md`);
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/^title:\s*"?([^"\n]+)"?\s*$/m);
    if (m) return m[1]!.trim();
  }
  return slug;
}

/**
 * The ledger state an analysis was written for: row count plus newest recorded date.
 * An analysis whose stored fingerprint differs describes an older ledger.
 * Resolving a row keeps the fingerprint (count and recorded dates do not move).
 */
export function ledgerFingerprint(rows: ClaimRow[]): string {
  const sorted = rows.map((r) => r.recorded).sort();
  return `${rows.length}:${sorted[sorted.length - 1] ?? ""}`;
}

/**
 * Which rows are personal-sensitivity, as a short hash of their ids ("" when there are none). The fingerprint above
 * does not move when a row is reclassified (count and dates stay), so an analysis also records this stamp.
 */
export function personalStamp(rows: ClaimRow[]): string {
  const ids = rows.filter((r) => r.sensitivity !== "public").map((r) => r.id).sort();
  return ids.length === 0 ? "" : createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 12);
}

/**
 * True when an analysis was written against the same personal/public split as the ledger now has. One that fails
 * may describe a claim that has since become personal, so it is never rendered or exported. One written before the
 * ledger grew (a different count or date) still passes: its inputs were all public rows that are still public.
 * An analysis with no recorded stamp (written before the stamp existed) passes only for a ledger with no personal rows.
 */
export function analysisCoversPrivacy(a: { personal_stamp?: string }, rows: ClaimRow[]): boolean {
  return (a.personal_stamp ?? "") === personalStamp(rows);
}

export function analysisPath(slug: string): string {
  return join(personDir(slug), "analysis.json");
}

export type AnalysisStatus = "fresh" | "stale" | "missing" | "empty";

/** empty = no public rows, so no analysis is owed; missing/stale = Assess.ts should run for this person. */
export function analysisStatus(slug: string, rows: ClaimRow[] = readLedger(slug)): AnalysisStatus {
  if (!rows.some((r) => r.sensitivity === "public")) return "empty";
  const p = analysisPath(slug);
  if (!existsSync(p)) return "missing";
  try {
    const a = JSON.parse(readFileSync(p, "utf8")) as { fingerprint?: string; personal_stamp?: string };
    return a.fingerprint === ledgerFingerprint(rows) && analysisCoversPrivacy(a, rows) ? "fresh" : "stale";
  } catch {
    return "missing";
  }
}

/** Every person whose analysis is missing or describes an older ledger. */
export function staleAnalyses(slugs: string[] = listPeople()): { slug: string; status: "stale" | "missing" }[] {
  const out: { slug: string; status: "stale" | "missing" }[] = [];
  for (const slug of slugs) {
    const s = analysisStatus(slug);
    if (s === "stale" || s === "missing") out.push({ slug, status: s });
  }
  return out;
}

/** Resolve a verifiable row. Rewrites the ledger (git shows the diff). */
export function resolveClaim(slug: string, id: string, outcome: "resolved_true" | "resolved_false", date?: string): ClaimRow {
  const rows = readLedger(slug);
  const idx = rows.findIndex((r) => r.id === id);
  invariant(idx >= 0, `no claim ${id} for ${slug}`);
  const row = rows[idx]!;
  invariant(row.kind === "verifiable", `claim ${id} is ${row.kind}; only verifiable rows resolve`);
  row.resolution = outcome;
  row.resolved = date ?? new Date().toISOString().slice(0, 10);
  const out = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(ledgerPath(slug), out);
  return row;
}
