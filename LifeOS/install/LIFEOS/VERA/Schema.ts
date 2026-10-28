/**
 * Vera Schema — typed claim ledger for person profiles.
 *
 * Design (ISA.md, articulated 2026-08-27):
 * - The profile is the artifact; every score is a projection over claim rows.
 * - Every row carries source, happened date, recorded date, axes, kind,
 *   confidence, sensitivity. Rows are the only input to any score.
 * - Kinds are disjoint: verifiable rows resolve and measure; judged rows are
 *   model opinion and never enter an accuracy leaf; biographical rows are context.
 * - sensitivity=personal excludes a row from every scoring path and every
 *   rendered/exported surface. The evidence store keeps everything; the
 *   scoring layer reads only what the queried axis justifies.
 * - The axes tree is VIEW CONFIG over free axis tags — changing the tree
 *   never requires a ledger migration.
 */

export const CLAIM_KINDS = ["verifiable", "judged", "biographical"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const SENSITIVITIES = ["public", "personal"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const RESOLUTIONS = ["pending", "resolved_true", "resolved_false"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const SOURCE_KINDS = [
  "blog", "video", "paper", "tweet", "conversation", "news",
  "talk", "book", "kb-import", "direct-observation", "other",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface ClaimRow {
  /** Stable id: vc_<12 hex>. Never reused. */
  id: string;
  /** Cortex kb-v3 People slug — the one identity namespace. */
  person: string;
  /** The claim itself — one checkable or citable statement. */
  statement: string;
  /** Where this came from: URL, publication ref, or note slug. */
  source: string;
  source_kind: SourceKind;
  /** When the claimed thing happened / was said (ISO date). Decay keys off this. */
  happened: string;
  /** When this row was recorded (ISO date). */
  recorded: string;
  /** Free axis tags; the axes tree maps over them as a view. */
  axes: string[];
  kind: ClaimKind;
  /** Recorder's confidence the row is accurate, 0..1 — a WEIGHT, never the assessed value. */
  confidence: number;
  /**
   * The assessed value on 0..1 for judged/structural evidence (how good, not
   * how sure). Optional: judged rows without it fall back to confidence
   * (legacy conflation), biographical rows to a modest positive default.
   */
  value?: number;
  sensitivity: Sensitivity;
  /** Verifiable rows only. */
  resolution?: Resolution;
  /** ISO date the resolution landed. */
  resolved?: string;
  /** For verifiable predictions: stated probability 0..1, enables Brier. */
  stated_p?: number;
  /** Optional provenance marker, e.g. "kb-import". */
  derivation?: string;
}

/** A leaf score — always carries its own confidence machinery. */
export interface LeafScore {
  leaf: string;
  branch: string;
  /** null = insufficient signal (never rendered as 0). */
  estimate: number | null;
  /** Interval half-width around the estimate; widens as evidence thins. */
  interval: number;
  /** Effective evidence count after decay weighting. */
  n: number;
  /** Rows considered (post filter). */
  rows: number;
  /** Slope per year over the trailing window; null when < 3 dated points. */
  trajectory: number | null;
  insufficient: boolean;
}

export interface AxesTree {
  branches: { name: string; leaves: { name: string; tags: string[]; type: "accuracy" | "judged" | "structural" }[] }[];
}

/** Patterns that look like credentials — refused at the write path. */
const SECRET_SHAPES = [
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

export function looksSecret(s: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(s));
}

export interface RowError { field: string; problem: string }

/** Validate a candidate row. Returns [] when clean. */
export function validateRow(row: Partial<ClaimRow>): RowError[] {
  const errs: RowError[] = [];
  const req: (keyof ClaimRow)[] = [
    "id", "person", "statement", "source", "source_kind",
    "happened", "recorded", "axes", "kind", "confidence", "sensitivity",
  ];
  for (const f of req) {
    if (row[f] === undefined || row[f] === null || row[f] === "") errs.push({ field: f, problem: "missing" });
  }
  if (row.id && !/^vc_[0-9a-f]{12}$/.test(row.id)) errs.push({ field: "id", problem: "not vc_<12 hex>" });
  if (row.kind && !CLAIM_KINDS.includes(row.kind)) errs.push({ field: "kind", problem: `unknown kind ${row.kind}` });
  if (row.sensitivity && !SENSITIVITIES.includes(row.sensitivity))
    errs.push({ field: "sensitivity", problem: `unknown sensitivity ${row.sensitivity}` });
  if (row.source_kind && !SOURCE_KINDS.includes(row.source_kind))
    errs.push({ field: "source_kind", problem: `unknown source_kind ${row.source_kind}` });
  if (row.axes !== undefined && (!Array.isArray(row.axes) || row.axes.length === 0))
    errs.push({ field: "axes", problem: "must be a non-empty list" });
  if (row.confidence !== undefined && (typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1))
    errs.push({ field: "confidence", problem: "must be 0..1" });
  if (row.stated_p !== undefined && (row.stated_p < 0 || row.stated_p > 1))
    errs.push({ field: "stated_p", problem: "must be 0..1" });
  if (row.value !== undefined && (typeof row.value !== "number" || row.value < 0 || row.value > 1))
    errs.push({ field: "value", problem: "must be 0..1" });
  if (row.resolution && !RESOLUTIONS.includes(row.resolution))
    errs.push({ field: "resolution", problem: `unknown resolution ${row.resolution}` });
  if (row.resolution && row.kind && row.kind !== "verifiable")
    errs.push({ field: "resolution", problem: "only verifiable rows resolve" });
  for (const f of ["happened", "recorded", "resolved"] as const) {
    const v = row[f];
    if (v && !/^\d{4}-\d{2}-\d{2}/.test(v)) errs.push({ field: f, problem: "not an ISO date" });
  }
  for (const f of ["statement", "source"] as const) {
    const v = row[f];
    if (v && looksSecret(v)) errs.push({ field: f, problem: "credential-shaped string refused" });
  }
  return errs;
}

export function newClaimId(): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 12; i++) s += hex[Math.floor(Math.random() * 16)];
  return `vc_${s}`;
}
