#!/usr/bin/env bun
/**
 * RiskRegister.ts — deterministic risk register CLI for the ThreatModel skill.
 *
 * Code is public; data is private. The register lives OUTSIDE the skill tree:
 *   default  ~/.claude/LIFEOS/USER/SECURITY/THREATMODEL/
 *   override THREATMODEL_DATA_DIR
 * A data dir resolving inside any skills/ path is refused (exit 2).
 *
 * Store: risk-register.json (system of record). RiskRegister.md is a generated view.
 * No secret values are ever stored — credential references by env-var name only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
// The TELOS life-risk register (LIFEOS/TOOLS ships with the runtime; this is the
// upward link from an estate row to the constitution's `## Risks (RN)` section).
import { readTelosRisks } from "../../../LIFEOS/TOOLS/TelosRisks";
import { loadRegistry, openByRisk } from "../../../LIFEOS/TOOLS/Achilles";

type Status = "open" | "mitigating" | "accepted" | "closed";
const STATUSES: Status[] = ["open", "mitigating", "accepted", "closed"];

/**
 * Scope: whose register row this is. `personal` is the operator's own estate;
 * the other values name a business or product whose rows may be exported
 * (see `render --scope`) into that entity's own governance surface. Absent
 * scope on a legacy row reads as `personal`. The list is data, not code:
 * `scopes.json` in the data dir (`{ "scopes": ["personal", "acme"] }`), so an
 * operator scopes rows to their own entities; the shipped default is
 * `["personal", "business"]` (in-family audit, round 11, 7.52.0 cut).
 */
export type Scope = string;
export const DEFAULT_SCOPE: Scope = "personal";
export const DEFAULT_SCOPES: Scope[] = ["personal", "business"];
function loadScopes(): Scope[] {
  try {
    const p = join(resolveDataDir(), "scopes.json");
    if (!existsSync(p)) return DEFAULT_SCOPES;
    const j = JSON.parse(readFileSync(p, "utf-8")) as { scopes?: unknown };
    const list = Array.isArray(j.scopes) ? j.scopes.filter((x): x is string => typeof x === "string" && /^[a-z][a-z0-9-]*$/.test(x)) : [];
    return list.includes(DEFAULT_SCOPE) ? list : [DEFAULT_SCOPE, ...list];
  } catch { return DEFAULT_SCOPES; }
}
export const SCOPES: Scope[] = loadScopes();
export const scopeOf = (r: { scope?: string }): Scope => (r.scope as Scope) ?? DEFAULT_SCOPE;
/** Shape of a TELOS life-risk id: `R0`, `R1`, … (the estate row ids are `R-001`; the two never collide). */
export const TELOS_REF = /^R\d+$/;

class InvariantViolation extends Error {}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(`Invariant violated: ${message}`);
}

export interface Risk {
  id: string;
  title: string;
  threat: string;
  assets: string[];
  data_classes: string[];
  likelihood: number; // 1-5
  impact: number; // 1-5
  score: number;
  level: "Low" | "Medium" | "High" | "Critical";
  status: Status;
  owner: string;
  mitigations: string[];
  response: string; // path/ref to response plan or scenario doc
  notes: string;
  created: string;
  updated: string;
  review_by: string; // ISO date
  history: { ts: string; event: string }[];
  /** Optional on legacy rows (reads as `personal`); always written by add/update since scope landed. */
  scope?: Scope;
  /**
   * The TELOS life-risk this estate row is an instance of (`R0`, `R1`, … — the
   * `## Risks (RN)` section of TELOS.md, zero-indexed, no dash). Optional: an
   * estate row with no life-level parent is legitimate, but every open High or
   * Critical row should carry one so a failure here reads as "Rn detect went red"
   * one level up. Validated against TELOS when the section is readable.
   */
  telos_ref?: string;
  /** The attack surface this row covers (e.g. `app-code`, `edge-config`), so findings on it have one home. */
  surface?: string;
  /** What detects this risk: an Achilles finder name or a Socrates question id (security-audit-unification ISC-89). */
  detect_refs?: string[];
}

interface Store {
  version: 1;
  updated: string;
  risks: Risk[];
}

export function levelFor(score: number): Risk["level"] {
  if (score >= 15) return "Critical";
  if (score >= 10) return "High";
  if (score >= 5) return "Medium";
  return "Low";
}

export function scoreRisk(likelihood: number, impact: number): { score: number; level: Risk["level"] } {
  for (const [name, v] of [["likelihood", likelihood], ["impact", impact]] as const) {
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new Error(`${name} must be an integer 1-5, got ${v}`);
  }
  const score = likelihood * impact;
  return { score, level: levelFor(score) };
}

export function resolveDataDir(): string {
  const dir = resolve(
    process.env.THREATMODEL_DATA_DIR ?? join(homedir(), ".claude", "LIFEOS", "USER", "SECURITY", "THREATMODEL"),
  );
  // Structural code/data separation: never allow the register inside a skill tree.
  const probe = existsSync(dir) ? realpathSync(dir) : dir;
  if (probe.split(sep).includes("skills")) {
    console.error(`ERROR: data dir ${probe} is inside a skills/ path — code and data stay separate. Set THREATMODEL_DATA_DIR outside the skill tree.`);
    process.exit(2);
  }
  return dir;
}

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function storePath(dir: string): string {
  return join(dir, "risk-register.json");
}

function loadStore(dir: string): Store {
  const p = storePath(dir);
  if (!existsSync(p)) return { version: 1, updated: now(), risks: [] };
  const s = JSON.parse(readFileSync(p, "utf8")) as Store;
  if (s.version !== 1) throw new Error(`Unsupported store version ${s.version}`);
  return s;
}

function saveStore(dir: string, store: Store): void {
  // Write-path invariants: a row that would render wrong or leak across scopes never lands.
  const ids = new Set<string>();
  for (const r of store.risks) {
    invariant(/^R-\d{3,}$/.test(r.id) && !ids.has(r.id), `unique R-nnn id (${r.id})`);
    ids.add(r.id);
    invariant(STATUSES.includes(r.status), `${r.id}: status in ${STATUSES.join("|")}`);
    invariant(r.scope === undefined || SCOPES.includes(r.scope), `${r.id}: scope in ${SCOPES.join("|")}`);
    invariant(r.telos_ref === undefined || TELOS_REF.test(r.telos_ref), `${r.id}: telos_ref is R<n> (zero-indexed TELOS id)`);
    invariant(r.score === r.likelihood * r.impact && r.level === levelFor(r.score), `${r.id}: score/level consistent`);
    invariant(r.detect_refs === undefined || (Array.isArray(r.detect_refs) && r.detect_refs.every((x) => typeof x === "string" && x.trim().length > 0)), `${r.id}: detect_refs are non-empty strings`);
  }
  mkdirSync(dir, { recursive: true });
  store.updated = now();
  writeFileSync(storePath(dir), JSON.stringify(store, null, 2) + "\n");
}

function nextId(store: Store): string {
  const max = store.risks.reduce((m, r) => Math.max(m, parseInt(r.id.replace(/^R-/, ""), 10) || 0), 0);
  return `R-${String(max + 1).padStart(3, "0")}`;
}

function findRisk(store: Store, id: string): Risk {
  const r = store.risks.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!r) {
    console.error(`ERROR: no risk ${id}`);
    process.exit(1);
  }
  return r;
}

// ---------- arg parsing ----------

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string[]> } {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      (flags[key] ??= []).push(val);
    } else positional.push(a);
  }
  return { positional, flags };
}

const one = (flags: Record<string, string[]>, k: string): string | undefined => {
  const v = flags[k];
  return v ? v[v.length - 1] : undefined;
};
const list = (flags: Record<string, string[]>, k: string): string[] =>
  (flags[k] ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);

// ---------- rendering ----------

function line(r: Risk): string {
  return `${r.id}  [${r.level.padEnd(8)}] ${String(r.score).padStart(2)}  ${r.status.padEnd(10)} ${scopeOf(r).padEnd(8)} review:${r.review_by || "—"}  ${r.title}`;
}

function detail(r: Risk): string {
  return [
    `${r.id}: ${r.title}`,
    `  level: ${r.level} (score ${r.score} = likelihood ${r.likelihood} × impact ${r.impact})   status: ${r.status}   owner: ${r.owner || "—"}   scope: ${scopeOf(r)}   telos: ${r.telos_ref || "—"}`,
    `  threat: ${r.threat}`,
    `  assets: ${r.assets.join(", ") || "—"}`,
    `  data classes: ${r.data_classes.join(", ") || "—"}`,
    `  mitigations:${r.mitigations.length ? "\n" + r.mitigations.map((m) => `    - ${m}`).join("\n") : " —"}`,
    `  response: ${r.response || "—"}`,
    `  surface: ${r.surface || "—"}   detected by: ${r.detect_refs?.length ? r.detect_refs.join(", ") : "—"}`,
    `  review by: ${r.review_by || "—"}   created: ${r.created.slice(0, 10)}   updated: ${r.updated.slice(0, 10)}`,
    r.notes ? `  notes: ${r.notes}` : "",
  ].filter(Boolean).join("\n");
}

/** Markdown view of a set of rows. `scope` narrows to one scope and labels the document for that entity. */
export function renderMarkdown(store: Store, scope?: Scope): string {
  const rows = scope ? store.risks.filter((r) => scopeOf(r) === scope) : store.risks;
  const open = rows.filter((r) => r.status !== "closed").sort((a, b) => b.score - a.score);
  const closed = rows.filter((r) => r.status === "closed").sort((a, b) => b.updated.localeCompare(a.updated));
  const row = (r: Risk) =>
    `| ${r.id} | ${r.level} | ${r.score} | ${r.status} | ${scopeOf(r)} | ${r.telos_ref || "—"} | ${r.title} | ${r.assets.join(", ")} | ${r.data_classes.join(", ")} | ${r.owner || "—"} | ${r.review_by || "—"} |`;
  const header = `| ID | Level | Score | Status | Scope | TELOS | Risk | Assets | Data classes | Owner | Review by |\n|---|---|---|---|---|---|---|---|---|---|---|`;
  return [
    scope ? `# Risk Register — scope: ${scope}` : `# Risk Register`,
    ``,
    `> GENERATED by ThreatModel/Tools/RiskRegister.ts — edit via the CLI, not here. Source of record: risk-register.json. Updated: ${store.updated}${scope ? ` · ${rows.length} of ${store.risks.length} rows carry scope \`${scope}\`` : ""}`,
    ``,
    `## Open (${open.length})`,
    ``,
    header,
    ...open.map(row),
    ``,
    `## Closed (${closed.length})`,
    ``,
    header,
    ...closed.map(row),
    ``,
    `## Detail`,
    ``,
    ...open.map((r) => "```\n" + detail(r) + "\n```\n"),
  ].join("\n");
}

function exportMarkdown(dir: string, store: Store): string {
  const p = join(dir, "RiskRegister.md");
  writeFileSync(p, renderMarkdown(store));
  return p;
}

function parseScope(flags: Record<string, string[]>): Scope | undefined {
  const s = one(flags, "scope");
  if (s === undefined) return undefined;
  if (!SCOPES.includes(s as Scope)) {
    console.error(`ERROR: scope must be one of ${SCOPES.join("|")}`);
    process.exit(1);
  }
  return s as Scope;
}

/**
 * `--telos-ref Rn`: the TELOS life-risk this row rolls up to. Shape is always
 * checked; existence is checked against the live TELOS `## Risks` section when
 * one is readable (an install without the section accepts shape only, and says so).
 */
function parseTelosRef(flags: Record<string, string[]>): string | undefined {
  const t = one(flags, "telos-ref");
  if (t === undefined) return undefined;
  if (!TELOS_REF.test(t)) {
    console.error(`ERROR: --telos-ref must look like R0, R1, … (a TELOS \`## Risks\` id, zero-indexed, no dash)`);
    process.exit(1);
  }
  const parsed = readTelosRisks();
  if (parsed.sectionLine !== null && !parsed.risks.some((r) => r.id === t)) {
    console.error(`ERROR: TELOS \`## Risks\` has no ${t} (has: ${parsed.risks.map((r) => r.id).join(", ") || "none"})`);
    process.exit(1);
  }
  if (parsed.sectionLine === null) console.error(`note: TELOS has no \`## Risks\` section to validate ${t} against — shape accepted`);
  return t;
}

// ---------- commands ----------

function usage(): void {
  console.log(`RiskRegister — deterministic risk register (data dir: ${resolveDataDir()})

  init                                    scaffold the data dir + empty register
  add --title T --threat T [--assets a,b] [--data-classes x,y]
      --likelihood 1-5 --impact 1-5 [--owner O] [--mitigation M]...
      [--response REF] [--review-by YYYY-MM-DD] [--notes N] [--scope ${SCOPES.join("|")}] [--telos-ref Rn]
      [--surface S] [--detect finder,SOC-nnnn]
  list [--status S] [--level L] [--scope S] [--all] [--json]
  show <id> [--json]
  update <id> [--likelihood N] [--impact N] [--status S] [--owner O] [--scope S] [--telos-ref Rn] [--surface S] [--detect a,b]
      [--add-mitigation M]... [--response REF] [--review-by D] [--notes N] [--title T] [--threat T]
  close <id> --reason R
  review [--scope S] [--json]             risks overdue / missing review date
  stats [--json]
  export                                  regenerate RiskRegister.md view
  render [--scope S]                      print a markdown register (one scope) to stdout
`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const dir = resolveDataDir();
  const asJson = one(flags, "json") === "true";

  switch (cmd) {
    case "init": {
      mkdirSync(join(dir, "Scenarios"), { recursive: true });
      const store = loadStore(dir);
      saveStore(dir, store);
      exportMarkdown(dir, store);
      console.log(`Initialized ${dir} (${store.risks.length} risks)`);
      break;
    }
    case "add": {
      const store = loadStore(dir);
      const title = one(flags, "title");
      const threat = one(flags, "threat");
      if (!title || !threat) {
        console.error("ERROR: --title and --threat are required");
        process.exit(1);
      }
      const likelihood = Number(one(flags, "likelihood"));
      const impact = Number(one(flags, "impact"));
      const { score, level } = scoreRisk(likelihood, impact);
      const r: Risk = {
        id: nextId(store),
        title,
        threat,
        assets: list(flags, "assets"),
        data_classes: list(flags, "data-classes"),
        likelihood,
        impact,
        score,
        level,
        status: (one(flags, "status") as Status) ?? "open",
        owner: one(flags, "owner") ?? "",
        mitigations: flags["mitigation"] ?? [],
        response: one(flags, "response") ?? "",
        notes: one(flags, "notes") ?? "",
        created: now(),
        updated: now(),
        review_by: one(flags, "review-by") ?? "",
        history: [{ ts: now(), event: "created" }],
        scope: parseScope(flags) ?? DEFAULT_SCOPE,
        telos_ref: parseTelosRef(flags),
        ...(one(flags, "surface") ? { surface: one(flags, "surface") } : {}),
        ...(list(flags, "detect").length ? { detect_refs: list(flags, "detect") } : {}),
      };
      if (!STATUSES.includes(r.status)) {
        console.error(`ERROR: status must be one of ${STATUSES.join("|")}`);
        process.exit(1);
      }
      store.risks.push(r);
      saveStore(dir, store);
      exportMarkdown(dir, store);
      console.log(asJson ? JSON.stringify(r, null, 2) : line(r));
      break;
    }
    case "list": {
      const store = loadStore(dir);
      let rs = store.risks;
      if (!flags["all"] && !flags["status"]) rs = rs.filter((r) => r.status !== "closed");
      const st = one(flags, "status");
      if (st) rs = rs.filter((r) => r.status === st);
      const lv = one(flags, "level");
      if (lv) rs = rs.filter((r) => r.level.toLowerCase() === lv.toLowerCase());
      const sc = parseScope(flags);
      if (sc) rs = rs.filter((r) => scopeOf(r) === sc);
      rs = [...rs].sort((a, b) => b.score - a.score);
      console.log(asJson ? JSON.stringify(rs, null, 2) : rs.map(line).join("\n") || "(no risks)");
      break;
    }
    case "show": {
      const store = loadStore(dir);
      const r = findRisk(store, positional[0] ?? "");
      // Open technical Achilles entries linked to this row (the same count the audit report uses).
      const open = openByRisk(loadRegistry().entries, store.risks).estate[r.id] ?? 0;
      console.log(asJson ? JSON.stringify({ ...r, open_findings: open }, null, 2) : `${detail(r)}\n  Achilles: ${open} open`);
      break;
    }
    case "update": {
      const store = loadStore(dir);
      const r = findRisk(store, positional[0] ?? "");
      const changes: string[] = [];
      for (const k of ["title", "threat", "owner", "response", "notes", "review-by"] as const) {
        const v = one(flags, k);
        if (v !== undefined) {
          (r as any)[k === "review-by" ? "review_by" : k] = v;
          changes.push(k);
        }
      }
      const st = one(flags, "status");
      if (st) {
        if (!STATUSES.includes(st as Status)) {
          console.error(`ERROR: status must be one of ${STATUSES.join("|")}`);
          process.exit(1);
        }
        r.status = st as Status;
        changes.push(`status=${st}`);
      }
      const sc = parseScope(flags);
      if (sc) {
        r.scope = sc;
        changes.push(`scope=${sc}`);
      }
      const tr = parseTelosRef(flags);
      if (tr) {
        r.telos_ref = tr;
        changes.push(`telos_ref=${tr}`);
      }
      const lk = one(flags, "likelihood");
      const im = one(flags, "impact");
      if (lk !== undefined || im !== undefined) {
        const likelihood = lk !== undefined ? Number(lk) : r.likelihood;
        const impact = im !== undefined ? Number(im) : r.impact;
        const { score, level } = scoreRisk(likelihood, impact);
        Object.assign(r, { likelihood, impact, score, level });
        changes.push(`rescored=${score}`);
      }
      if (one(flags, "surface")) { r.surface = one(flags, "surface"); changes.push("surface"); }
      if (list(flags, "detect").length) { r.detect_refs = list(flags, "detect"); changes.push("detect"); }
      for (const m of flags["add-mitigation"] ?? []) {
        r.mitigations.push(m);
        changes.push("mitigation+");
      }
      if (list(flags, "assets").length) {
        r.assets = list(flags, "assets");
        changes.push("assets");
      }
      if (list(flags, "data-classes").length) {
        r.data_classes = list(flags, "data-classes");
        changes.push("data-classes");
      }
      r.updated = now();
      r.history.push({ ts: now(), event: `updated: ${changes.join(", ") || "no-op"}` });
      saveStore(dir, store);
      exportMarkdown(dir, store);
      console.log(asJson ? JSON.stringify(r, null, 2) : line(r));
      break;
    }
    case "close": {
      const store = loadStore(dir);
      const r = findRisk(store, positional[0] ?? "");
      const reason = one(flags, "reason");
      if (!reason) {
        console.error("ERROR: --reason is required to close a risk");
        process.exit(1);
      }
      r.status = "closed";
      r.updated = now();
      r.history.push({ ts: now(), event: `closed: ${reason}` });
      saveStore(dir, store);
      exportMarkdown(dir, store);
      console.log(line(r));
      break;
    }
    case "review": {
      const store = loadStore(dir);
      const sc = parseScope(flags);
      const due = store.risks.filter(
        (r) => r.status !== "closed" && (!r.review_by || r.review_by <= today()) && (!sc || scopeOf(r) === sc),
      ).sort((a, b) => b.score - a.score);
      console.log(
        asJson
          ? JSON.stringify(due, null, 2)
          : due.length
            ? due.map((r) => `${line(r)}${r.review_by ? "" : "  (no review date)"}`).join("\n")
            : "(nothing due for review)",
      );
      break;
    }
    case "stats": {
      const store = loadStore(dir);
      const open = store.risks.filter((r) => r.status !== "closed");
      const byLevel = Object.fromEntries(
        (["Critical", "High", "Medium", "Low"] as const).map((l) => [l, open.filter((r) => r.level === l).length]),
      );
      const byStatus = Object.fromEntries(STATUSES.map((s) => [s, store.risks.filter((r) => r.status === s).length]));
      const overdue = open.filter((r) => !r.review_by || r.review_by <= today()).length;
      const out = { total: store.risks.length, open: open.length, byLevel, byStatus, overdue_review: overdue, updated: store.updated, data_dir: dir };
      console.log(asJson ? JSON.stringify(out, null, 2) : Object.entries(out).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n"));
      break;
    }
    case "export": {
      const store = loadStore(dir);
      console.log(`Wrote ${exportMarkdown(dir, store)}`);
      break;
    }
    case "render": {
      const store = loadStore(dir);
      process.stdout.write(renderMarkdown(store, parseScope(flags)));
      break;
    }
    default:
      usage();
      if (cmd && cmd !== "--help" && cmd !== "help") process.exit(1);
  }
}

if (import.meta.main) main();
