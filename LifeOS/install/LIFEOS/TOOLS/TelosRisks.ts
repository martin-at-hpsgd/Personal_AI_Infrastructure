#!/usr/bin/env bun
/**
 * TelosRisks — the machine-readable view of the TELOS `## Risks (RN)` section.
 *
 * TELOS.md is the system of record for the principal's top life risks: the ten
 * scenarios most likely to knock them off the path to their ideal state, across
 * every domain, each carrying the CURRENT state of prevent, detect, and respond
 * and links into the systems that already watch it (the ThreatModel estate
 * register `R-NNN`, Socrates `SOC-NNNN`, Achilles `ACH-NNNN`, incident records
 * `INC-YYYYMMDD-slug`, SecurityPosture threat ids `Tn`, TELOS goal/challenge ids,
 * and `runbook:`/`doc:` paths). This tool parses that section deterministically,
 * validates its shape, and resolves every link — so Socrates can watch the
 * register, the summary generator can render it, and Pulse can serve it.
 *
 * Entry shape (one H3 per risk, IDs zero-indexed and never renumbered):
 *
 *   ### R0: A prompt injection borrows the DA's authority
 *   - domain: security · likelihood: 3 · impact: 5 · owner: assistant · review_by: 2026-10-10
 *   - scenario: …
 *   - prevent: partial — …
 *   - detect: partial — …
 *   - respond: none — …
 *   - links: R-012, SOC-0023, ACH-0047, T6.1, runbook:skills/…/CompromiseTriage.md, doc:LIFEOS/…
 *
 * Scoring mirrors skills/ThreatModel: likelihood × impact (1–5 each) →
 * Low 1–4 · Medium 5–9 · High 10–14 · Critical 15–25.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts list [--json]
 *   bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts show R0 [--json]
 *   bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts validate [--links] [--json]   # exit 1 on any error
 *   bun ~/.claude/LIFEOS/TOOLS/TelosRisks.ts summary                        # one line per risk
 *
 * Read-only: this tool never writes TELOS.md. Overrides (tests): LIFEOS_TELOS_PATH,
 * THREATMODEL_DATA_DIR, SOCRATES_QUESTIONS_DIR, ACHILLES_REGISTRY_PATH,
 * LIFEOS_INCIDENTS_DIR, SECURITY_POSTURE_PATH, PRINCIPAL_TELOS_PATH.
 *
 * @version 1.0.3
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getClaudeDir } from "./Paths";
import { loadRegistry, openByRisk, registryPath } from "./Achilles";

const CLAUDE = getClaudeDir();

/** `unknown` is honest when nobody has checked; it never counts as coverage. */
export const STATE_WORDS = ["none", "partial", "have", "unknown"] as const;
export type StateWord = (typeof STATE_WORDS)[number];
export type Level = "Low" | "Medium" | "High" | "Critical";

export type LinkKind = "register" | "socrates" | "achilles" | "incident" | "posture" | "telos" | "runbook" | "doc" | "unknown";

export interface LinkToken {
  raw: string;
  kind: LinkKind;
  /** The id or path the token names (path for runbook/doc, id otherwise). */
  ref: string;
}

export interface PdrState {
  state: StateWord;
  text: string;
}

export interface TelosRisk {
  id: string;
  title: string;
  domain: string;
  likelihood: number;
  impact: number;
  score: number;
  level: Level;
  owner: string;
  review_by: string;
  scenario: string;
  prevent: PdrState;
  detect: PdrState;
  respond: PdrState;
  links: LinkToken[];
  /** 1-based line of the `### Rn:` heading in TELOS.md. */
  line: number;
}

export interface ParseResult {
  risks: TelosRisk[];
  errors: string[];
  /** 1-based line of the `## Risks` heading; null when the section is absent. */
  sectionLine: number | null;
}

export function levelFor(score: number): Level {
  if (score >= 15) return "Critical";
  if (score >= 10) return "High";
  if (score >= 5) return "Medium";
  return "Low";
}

// ─── Paths ────────────────────────────────────────────────────────────────

/** Resolved per call so a test (or a tick) that sets LIFEOS_TELOS_PATH after import still lands. */
export const telosPath = (): string => process.env.LIFEOS_TELOS_PATH ?? join(CLAUDE, "LIFEOS/USER/TELOS/TELOS.md");
const threatmodelDir = () => process.env.THREATMODEL_DATA_DIR ?? join(CLAUDE, "LIFEOS/USER/SECURITY/THREATMODEL");
const socratesDir = () => process.env.SOCRATES_QUESTIONS_DIR ?? join(CLAUDE, "LIFEOS/USER/SOCRATES/questions");
const achillesPath = registryPath;
const incidentsDir = () => process.env.LIFEOS_INCIDENTS_DIR ?? join(CLAUDE, "LIFEOS/USER/MEMORY/LEARNING/INCIDENTS");
const posturePath = () => process.env.SECURITY_POSTURE_PATH ?? join(CLAUDE, "LIFEOS/USER/SECURITY/SecurityPosture.md");
const principalTelosPath = () => process.env.PRINCIPAL_TELOS_PATH ?? join(CLAUDE, "LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md");

// ─── Link grammar ─────────────────────────────────────────────────────────

const LINK_PATTERNS: Array<[LinkKind, RegExp]> = [
  ["register", /^R-\d{3}$/],
  ["socrates", /^SOC-\d{4}$/],
  ["achilles", /^ACH-\d{4}$/],
  ["incident", /^INC-\d{8}-[a-z0-9-]+$/],
  ["posture", /^T\d+(?:\.\d+)?$/],
  ["telos", /^(?:G|C|P|S|M|N|PJ)\d+$/],
];

export function classifyLink(raw: string): LinkToken {
  const t = raw.trim();
  if (t.startsWith("runbook:")) return { raw: t, kind: "runbook", ref: t.slice("runbook:".length) };
  if (t.startsWith("doc:")) return { raw: t, kind: "doc", ref: t.slice("doc:".length) };
  for (const [kind, re] of LINK_PATTERNS) if (re.test(t)) return { raw: t, kind, ref: t };
  return { raw: t, kind: "unknown", ref: t };
}

// ─── Parsing ──────────────────────────────────────────────────────────────

const RISK_HEADING = /^###\s+(R\d+):\s*(.+?)\s*$/;
const SECTION_HEADING = /^##\s+Risks\b/i;

/** Split a `key: value · key: value` bullet into pairs. */
function parsePairs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(/\s+·\s+/)) {
    const m = part.match(/^([a-z_]+):\s*(.*)$/i);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function parsePdr(value: string, field: string, id: string, errors: string[]): PdrState {
  const m = value.match(/^(none|partial|have|unknown)\b\s*(?:[—–-]+\s*)?(.*)$/is);
  if (!m) {
    errors.push(`${id}: ${field} must open with one of ${STATE_WORDS.join("|")} — got "${value.slice(0, 40)}"`);
    return { state: "none", text: value };
  }
  return { state: m[1].toLowerCase() as StateWord, text: m[2].trim() };
}

/**
 * Parse the `## Risks` section out of a TELOS markdown document. Pure: no I/O.
 * Errors are collected, never thrown, so a broken entry reports next to the good ones.
 */
export function parseRisksMarkdown(md: string): ParseResult {
  const lines = md.split("\n");
  const errors: string[] = [];
  let sectionLine: number | null = null;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (sectionLine === null) {
      if (SECTION_HEADING.test(lines[i])) sectionLine = i + 1;
      continue;
    }
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  if (sectionLine === null) return { risks: [], errors: ["no `## Risks` section found"], sectionLine: null };

  const risks: TelosRisk[] = [];
  let cur: { id: string; title: string; line: number; fields: Record<string, string> } | null = null;
  const flush = () => {
    if (!cur) return;
    const f = cur.fields;
    const id = cur.id;
    const need = ["domain", "likelihood", "impact", "owner", "review_by", "scenario", "prevent", "detect", "respond", "links"];
    for (const k of need) if (!(k in f) || f[k] === "") errors.push(`${id}: missing field "${k}"`);
    const likelihood = Number(f.likelihood);
    const impact = Number(f.impact);
    if (!(likelihood >= 1 && likelihood <= 5 && Number.isInteger(likelihood))) errors.push(`${id}: likelihood must be an integer 1-5`);
    if (!(impact >= 1 && impact <= 5 && Number.isInteger(impact))) errors.push(`${id}: impact must be an integer 1-5`);
    if (f.review_by && !/^\d{4}-\d{2}-\d{2}$/.test(f.review_by)) errors.push(`${id}: review_by must be YYYY-MM-DD`);
    const score = likelihood * impact;
    const links = (f.links ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(classifyLink);
    for (const l of links) if (l.kind === "unknown") errors.push(`${id}: unrecognised link token "${l.raw}"`);
    risks.push({
      id, title: cur.title, line: cur.line,
      domain: (f.domain ?? "").toLowerCase(),
      likelihood, impact, score: Number.isFinite(score) ? score : 0, level: levelFor(Number.isFinite(score) ? score : 0),
      owner: f.owner ?? "", review_by: f.review_by ?? "",
      scenario: f.scenario ?? "",
      prevent: parsePdr(f.prevent ?? "", "prevent", id, errors),
      detect: parsePdr(f.detect ?? "", "detect", id, errors),
      respond: parsePdr(f.respond ?? "", "respond", id, errors),
      links,
    });
    cur = null;
  };

  for (let i = sectionLine; i < end; i++) {
    const line = lines[i];
    const h = line.match(RISK_HEADING);
    if (h) { flush(); cur = { id: h[1], title: h[2], line: i + 1, fields: {} }; continue; }
    if (!cur) continue;
    const b = line.match(/^-\s+(.*)$/);
    if (!b) continue;
    const body = b[1];
    const head = body.match(/^([a-z_]+):\s*/i);
    if (!head) continue;
    const key = head[1].toLowerCase();
    if (["domain", "likelihood", "impact", "owner", "review_by"].includes(key)) {
      Object.assign(cur.fields, parsePairs(body));
    } else {
      cur.fields[key] = body.slice(head[0].length).trim();
    }
  }
  flush();

  // IDs: unique, zero-indexed, sequential in document order — the TELOS convention.
  const seen = new Set<string>();
  risks.forEach((r, idx) => {
    if (seen.has(r.id)) errors.push(`${r.id}: duplicate id`);
    seen.add(r.id);
    if (r.id !== `R${idx}`) errors.push(`${r.id}: expected R${idx} at position ${idx} (ids are zero-indexed and never renumbered)`);
  });
  if (risks.length === 0) errors.push("`## Risks` section has no `### Rn:` entries");
  return { risks, errors, sectionLine };
}

export function readTelosRisks(path: string = telosPath()): ParseResult {
  if (!existsSync(path)) return { risks: [], errors: [`TELOS not found at ${path}`], sectionLine: null };
  return parseRisksMarkdown(readFileSync(path, "utf8"));
}

// ─── Link resolution ──────────────────────────────────────────────────────

export interface LinkResolvers {
  registerIds: Set<string>;
  socratesIds: Set<string>;
  /** Questions whose status is `active` — the only ones that count as watching a risk. */
  socratesActive: Set<string>;
  achillesIds: Set<string>;
  incidentIds: Set<string>;
  postureIds: Set<string>;
  telosIds: Set<string>;
  pathExists: (p: string) => boolean;
}

function safeJson<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null; } catch { return null; }
}

/** Build resolvers from the live install. Missing sources resolve to empty sets and are reported as errors by resolveLinks. */
export function liveResolvers(): LinkResolvers & { missing: string[] } {
  const missing: string[] = [];
  const registerIds = new Set<string>();
  const reg = safeJson<{ risks?: Array<{ id: string }> }>(join(threatmodelDir(), "risk-register.json"));
  if (reg?.risks) for (const r of reg.risks) registerIds.add(r.id); else missing.push("threatmodel:risk-register.json");

  const socratesIds = new Set<string>();
  const socratesActive = new Set<string>();
  const sdir = socratesDir();
  if (existsSync(sdir)) {
    for (const f of readdirSync(sdir).filter((f) => f.endsWith(".json"))) {
      const pack = safeJson<{ questions?: Array<{ id: string; status?: string }> }>(join(sdir, f));
      for (const q of pack?.questions ?? []) { socratesIds.add(q.id); if (q.status === "active") socratesActive.add(q.id); }
    }
  } else missing.push("socrates:questions");

  const achillesIds = new Set<string>();
  const ach = safeJson<{ entries?: Array<{ id: string }> } | Array<{ id: string }>>(achillesPath());
  const entries = Array.isArray(ach) ? ach : ach?.entries;
  if (entries) for (const e of entries) achillesIds.add(e.id); else missing.push("achilles:registry.json");

  const incidentIds = new Set<string>();
  const idir = incidentsDir();
  if (existsSync(idir)) {
    for (const f of readdirSync(idir)) if (f.startsWith("INC-")) incidentIds.add(f.replace(/\.md$/, ""));
  } else missing.push("incidents");

  const postureIds = new Set<string>();
  const pp = posturePath();
  if (existsSync(pp)) for (const m of readFileSync(pp, "utf8").matchAll(/^\|\s*(T\d+(?:\.\d+)?)\s*\|/gm)) postureIds.add(m[1]);
  else missing.push("security-posture");

  const telosIds = new Set<string>();
  const pt = principalTelosPath();
  if (existsSync(pt)) for (const m of readFileSync(pt, "utf8").matchAll(/\*\*((?:G|C|P|S|M|N|PJ)\d+)\*\*/g)) telosIds.add(m[1]);
  else missing.push("principal-telos");

  return {
    registerIds, socratesIds, socratesActive, achillesIds, incidentIds, postureIds, telosIds, missing,
    pathExists: (p) => existsSync(resolve(CLAUDE, p)),
  };
}

export function resolveLinks(risks: TelosRisk[], r: LinkResolvers): string[] {
  const errors: string[] = [];
  for (const risk of risks) {
    for (const l of risk.links) {
      const ok =
        l.kind === "register" ? r.registerIds.has(l.ref)
        : l.kind === "socrates" ? r.socratesIds.has(l.ref)
        : l.kind === "achilles" ? r.achillesIds.has(l.ref)
        : l.kind === "incident" ? r.incidentIds.has(l.ref)
        : l.kind === "posture" ? r.postureIds.has(l.ref)
        : l.kind === "telos" ? r.telosIds.has(l.ref)
        : l.kind === "runbook" || l.kind === "doc" ? r.pathExists(l.ref)
        : false;
      if (!ok) errors.push(`${risk.id}: link ${l.raw} does not resolve (${l.kind})`);
    }
  }
  return errors;
}

// ─── Derived views ────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);

/** Open technical Achilles findings per life risk, rolled up through the estate register's telos_ref.
 *  Every parsed risk gets a number, zero included; a missing store reads as zero, never a crash. */
export function openFindings(ids: string[]): Record<string, number> {
  const reg = safeJson<{ risks?: Array<{ id: string; telos_ref?: string }> }>(join(threatmodelDir(), "risk-register.json"));
  let life: Record<string, number> = {};
  try { life = openByRisk(loadRegistry().entries, reg?.risks ?? []).life; } catch { life = {}; }
  return Object.fromEntries(ids.map((id) => [id, life[id] ?? 0]));
}

export function overdue(risks: TelosRisk[], on: string = today()): TelosRisk[] {
  return risks.filter((r) => !r.review_by || r.review_by <= on);
}

/**
 * A risk nobody is watching: its detect state is `none` or `unknown` AND it links no ACTIVE
 * Socrates question. An unanswerable question is a wish, not a watch; an Achilles link
 * names a weakness, not a detector — neither counts (advisor consult 2026-09-10).
 */
export function unwatched(risks: TelosRisk[], active: Set<string>): TelosRisk[] {
  return risks.filter((r) => (r.detect.state === "none" || r.detect.state === "unknown") && !r.links.some((l) => l.kind === "socrates" && active.has(l.ref)));
}

/** Table header for the TELOS summary: prevent, detect, and respond are their own columns. */
export const SUMMARY_HEADER = ["| ID | Risk | Score | Prevent | Detect | Respond |", "|---|---|---|---|---|---|"];

/** One table row per risk for the TELOS summary; pair with SUMMARY_HEADER. */
export function summaryLines(risks: TelosRisk[]): string[] {
  return risks.map((r) => `| **${r.id}** | ${r.title} | ${r.level} ${r.score} | ${r.prevent.state} | ${r.detect.state} | ${r.respond.state} |`);
}

// ─── CLI ──────────────────────────────────────────────────────────────────

function usage(): void {
  console.log(`TelosRisks — the TELOS risk register (${telosPath()})

  list [--json]                 every risk, score order preserved as written
  show <id> [--json]            one risk in full
  validate [--links] [--json]   shape check; --links also resolves every link token (exit 1 on errors)
  summary                       one line per risk for the TELOS summary`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const json = args.includes("--json");
  const parsed = readTelosRisks();

  if (!cmd || cmd === "--help" || cmd === "-h") { usage(); process.exit(0); }

  if (cmd === "list") {
    if (json) { console.log(JSON.stringify(parsed.risks, null, 2)); }
    else {
      for (const r of parsed.risks) console.log(`${r.id.padEnd(4)} ${r.level.padEnd(8)} ${String(r.score).padStart(2)}  ${r.domain.padEnd(10)} P:${r.prevent.state.padEnd(7)} D:${r.detect.state.padEnd(7)} R:${r.respond.state.padEnd(7)} ${r.title}`);
      if (parsed.errors.length) console.error(`\n${parsed.errors.length} parse error(s) — run validate`);
    }
    process.exit(0);
  }

  if (cmd === "show") {
    const id = args[1];
    const r = parsed.risks.find((x) => x.id === id);
    if (!r) { console.error(`no risk ${id}`); process.exit(1); }
    const open = openFindings([r.id])[r.id];
    if (json) console.log(JSON.stringify({ ...r, open_findings: open }, null, 2));
    else {
      console.log(`${r.id}: ${r.title}\n  level: ${r.level} (score ${r.score} = likelihood ${r.likelihood} × impact ${r.impact})   domain: ${r.domain}   owner: ${r.owner}   review by: ${r.review_by}\n  scenario: ${r.scenario}\n  prevent [${r.prevent.state}]: ${r.prevent.text}\n  detect  [${r.detect.state}]: ${r.detect.text}\n  respond [${r.respond.state}]: ${r.respond.text}\n  links: ${r.links.map((l) => l.raw).join(", ")}\n  Achilles: ${open} open`);
    }
    process.exit(0);
  }

  if (cmd === "validate") {
    const errors = [...parsed.errors];
    if (args.includes("--links")) {
      const res = liveResolvers();
      const usedKinds = new Set(parsed.risks.flatMap((r) => r.links.map((l) => l.kind)));
      const kindOf: Record<string, LinkKind> = { "threatmodel:risk-register.json": "register", "socrates:questions": "socrates", "achilles:registry.json": "achilles", incidents: "incident", "security-posture": "posture", "principal-telos": "telos" };
      // A store nobody links is not an error: a fresh install has no Socrates or Achilles yet
      // (TelosTemplateGate, 7.52.0 cut — six phantom errors on the shipped template).
      for (const m of res.missing) if (usedKinds.has(kindOf[m] ?? m)) errors.push(`link source unavailable: ${m}`);
      errors.push(...resolveLinks(parsed.risks, res));
    }
    if (json) console.log(JSON.stringify({ ok: errors.length === 0, count: parsed.risks.length, errors }, null, 2));
    else if (errors.length === 0) console.log(`✅ ${parsed.risks.length} risk(s), no errors${args.includes("--links") ? ", every link resolves" : ""}`);
    else { console.error(`❌ ${errors.length} error(s):`); for (const e of errors) console.error(`  - ${e}`); }
    process.exit(errors.length === 0 ? 0 : 1);
  }

  if (cmd === "summary") {
    for (const l of [...SUMMARY_HEADER, ...summaryLines(parsed.risks)]) console.log(l);
    process.exit(0);
  }

  usage();
  process.exit(1);
}
