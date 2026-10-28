/**
 * Rows — parses the ideal-state dimension files into target rows, and the TELOS
 * `## GOALS` section into goal rows.
 *
 * A row is a bullet ending in `— type: target|north_star`. After the type it may
 * carry suffixes, each introduced by ` — `:
 *
 *   - Weight at 100 kg — type: target — id: IS-0007 — pursuit: principal:workflow/weekly-weigh-in — measure: HEALTH/current.json#body.weight_kg to 100 by 2027-06-30
 *
 * `id:` is the row's stable id, assigned once (`IdealState.ts ids --write` or on
 * accept) and never reissued. `pursuit:` names who moves the row (system,
 * principal or others) and the Workflow or ISA that moves it, or
 * `none:<reason>` when it is deliberately unpursued. `measure:` names a JSON
 * file under the USER root, a dot path into it, the target value and the date
 * the target should be reached. `measure: socrates/SOC-NNNN` (optionally
 * `by YYYY-MM-DD`) binds a row that is not a number to a standing question: its
 * latest yes, no or unknown is the measurement. The loop can recommend any of
 * these, never write one on its own.
 *
 * Goals are TELOS paragraphs, never edited by the loop: their ids live in the
 * loop's state registry (Ids.ts) so achieving, rewording or deleting one goal
 * moves no other goal's id.
 *
 * @version 1.2.0
 *
 * 1.2.0: `measure: socrates/SOC-NNNN` binds a row to a standing question.
 * 1.1.0: `id:` and `pursuit:` suffixes; goal rows parsed from TELOS GOALS.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { idealDir } from "./Store";

export type NumericMeasure = { file: string; path: string; target: number; by: string };
/** A row measured by a Socrates standing question: yes is on track, no is off, unknown is unreadable. */
export type SocratesMeasure = { socrates: string; by?: string };
export type Measure = NumericMeasure | SocratesMeasure;
export const isNumericMeasure = (m: Measure): m is NumericMeasure => "file" in m;
export const OWNERS = ["system", "principal", "others"] as const;
export type Owner = (typeof OWNERS)[number];
export type Pursuit = { owner: Owner; kind: "workflow" | "isa"; name: string } | { none: string };
export type Row = {
  key: string;
  id?: string;
  file: string;
  section: string;
  text: string;
  type: "target" | "north_star" | "goal";
  line: number;
  measure?: Measure;
  pursuit?: Pursuit;
  /** Goal rows only. */
  status?: "active" | "achieved" | "dropped";
  /** Goal rows only: the date the goal's own text names, when it names one. */
  by?: string;
  /** Suffixes that did not parse; reported, never guessed. */
  issues?: string[];
};

const ROW_RE = /^\s*-\s+(.+?)\s+—\s+type:\s+(target|north_star)\b(.*)$/;
const MEASURE_RE = /—\s*measure:\s*([^\s#]+)#(\S+)\s+to\s+(-?\d+(?:\.\d+)?)\s+by\s+(\d{4}-\d{2}-\d{2})/;
const SOCRATES_MEASURE_RE = /—\s*measure:\s*socrates\/(SOC-\d{4,})(?:\s+by\s+(\d{4}-\d{2}-\d{2}))?(?=\s+—|\s*$)/;
export const ID_RE = /^IS-\d{4,}$/;
const PURSUIT_RE = /^(system|principal|others):(workflow|isa)\/([A-Za-z0-9._\/-]+)$/;

export function rowKey(file: string, text: string): string {
  return createHash("sha256").update(`${file}\n${text}`).digest("hex").slice(0, 12);
}

/** The id a row is tracked by: its stable id once it has one, its content key before. */
export const rowRef = (r: Pick<Row, "id" | "key">): string => r.id ?? r.key;

export function parseMeasure(tail: string): Measure | undefined {
  const m = tail.match(MEASURE_RE);
  if (m) return { file: m[1]!, path: m[2]!, target: Number(m[3]), by: m[4]! };
  const q = tail.match(SOCRATES_MEASURE_RE);
  if (q) return q[2] ? { socrates: q[1]!, by: q[2] } : { socrates: q[1]! };
  return undefined;
}

/** The `measure:` suffix value, the inverse of parseMeasure. */
export function formatMeasure(m: Measure): string {
  if (isNumericMeasure(m)) return `${m.file}#${m.path} to ${m.target} by ${m.by}`;
  return `socrates/${m.socrates}${m.by ? ` by ${m.by}` : ""}`;
}

export function parsePursuit(value: string): Pursuit | null {
  const v = value.trim();
  const none = v.match(/^none:\s*(.+)$/);
  if (none) return { none: none[1]!.trim() };
  const m = v.match(PURSUIT_RE);
  return m ? { owner: m[1] as Owner, kind: m[2] as "workflow" | "isa", name: m[3]! } : null;
}

export function formatPursuit(p: Pursuit): string {
  return "none" in p ? `none:${p.none}` : `${p.owner}:${p.kind}/${p.name}`;
}

/** Reads the ` — key: value` suffixes after a row's type. */
export function parseSuffixes(tail: string): Pick<Row, "id" | "measure" | "pursuit" | "issues"> {
  const out: Pick<Row, "id" | "measure" | "pursuit" | "issues"> = {};
  const issues: string[] = [];
  const measure = parseMeasure(tail);
  if (measure) out.measure = measure;
  for (const seg of tail.split(/\s+—\s+/).map((s) => s.trim()).filter(Boolean)) {
    const s = seg.replace(/^—\s*/, "");
    const kv = s.match(/^(id|pursuit|measure):\s*(.*)$/);
    if (!kv) continue;
    if (kv[1] === "id") { if (ID_RE.test(kv[2]!.trim())) out.id = kv[2]!.trim(); else issues.push(`malformed id: ${kv[2]}`); }
    if (kv[1] === "pursuit") { const p = parsePursuit(kv[2]!); if (p) out.pursuit = p; else issues.push(`malformed pursuit: ${kv[2]}`); }
    if (kv[1] === "measure" && !measure) issues.push(`malformed measure: ${kv[2]}`);
  }
  if (issues.length) out.issues = issues;
  return out;
}

export function parseRows(file: string, content: string): Row[] {
  const rows: Row[] = [];
  let section = "";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1]!; continue; }
    const m = line.match(ROW_RE);
    if (!m) continue;
    const text = m[1]!.trim();
    rows.push({ key: rowKey(file, text), file, section, text, type: m[2] as Row["type"], line: i + 1, ...parseSuffixes(m[3] ?? "") });
  }
  return rows;
}

/** Adds ` — id: <id>` at the end of the row, leaving everything before it as it was (a note after the type stays its own text). */
export function withId(line: string, id: string): string {
  return `${line.replace(/\s+$/, "")} — id: ${id}`;
}

/** Every dimension file in IDEAL_STATE except the index and readme. */
export function dimensionFiles(dir = idealDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "INDEX.md" && f !== "README.md").sort();
}

export function allRows(dir = idealDir()): Row[] {
  return dimensionFiles(dir).flatMap((f) => parseRows(f, readFileSync(join(dir, f), "utf8")));
}

export function sections(content: string): string[] {
  return content.split("\n").flatMap((l) => { const h = l.match(/^##\s+(.+?)\s*$/); return h ? [h[1]!] : []; });
}

// ── goals ──────────────────────────────────────────────────────────────────

export type Goal = { text: string; status: "active" | "achieved" | "dropped"; by?: string; line: number };

/** The date a goal's own words name: "by end of 2026", "by 2028", "by 2027-06-30". */
export function goalBy(text: string): string | undefined {
  const d = text.match(/\bby\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (d) return d[1];
  const y = text.match(/\bby\s+(?:the\s+)?(?:end\s+of\s+)?(\d{4})\b/i);
  return y ? `${y[1]}-12-31` : undefined;
}

/** The paragraphs of TELOS `## GOALS`, comments stripped, each with its status. */
export function parseGoals(telos: string): Goal[] {
  const lines = telos.split("\n");
  const start = lines.findIndex((l) => /^## GOALS\b/.test(l));
  if (start < 0) return [];
  const goals: Goal[] = [];
  let buf: string[] = [], at = 0;
  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    buf = [];
    if (!text) return;
    const status = /^\[DROPPED/i.test(text) ? "dropped" : /\bACHIEVED\b/.test(text) ? "achieved" : "active";
    const by = goalBy(text);
    goals.push({ text, status, line: at, ...(by ? { by } : {}) });
  };
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^## /.test(l) || /^---\s*$/.test(l)) break;
    const clean = l.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!clean) { flush(); continue; }
    if (!buf.length) at = i + 1;
    buf.push(clean.replace(/^-\s+/, ""));
  }
  flush();
  return goals;
}

/** Goals as rows, with the ids the registry gave them (Ids.ts assignGoalIds). */
export function goalRows(goals: Goal[], ids: (string | undefined)[]): Row[] {
  return goals.map((g, i) => ({ key: rowKey("TELOS.md", g.text), ...(ids[i] ? { id: ids[i] } : {}), file: "TELOS.md", section: "GOALS", text: g.text, type: "goal" as const, line: g.line, status: g.status, ...(g.by ? { by: g.by } : {}) }));
}
