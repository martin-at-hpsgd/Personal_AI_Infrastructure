#!/usr/bin/env bun
/**
 * Achilles — the vulnerability management registry CLI.
 *
 * Single source of truth for every known weakness across the estate, in any
 * category (technical | financial | reputational | legal | physical |
 * operational), fed by every finder (synapse | pentest | atlas | workflows-scanner
 * | threatmodel | vulnmanagement | manual) and worn by Pulse as a page and a
 * banner. Standing risks live in the ThreatModel risk register; Achilles holds
 * the concrete instances and their lifecycle.
 *
 *   bun Achilles.ts add --title T --category C --severity S --source SRC [...]
 *   bun Achilles.ts list [--status S] [--severity S] [--category C] [--json]
 *   bun Achilles.ts show <id>
 *   bun Achilles.ts apply <id> [--unattended]     # land a ready worker patch: clean index, apply --check, scoped tests, commit on the checked-out branch (--unattended: main only) (never deploys);
 *                                                 # --unattended (the loop) also refuses project repos, gate paths, and any patch Review.ts did not pass
 *   bun Achilles.ts classify [--all] [--apply]   # stamp fix_class (auto|agent|human) via classifyFix + USER overrides
 *   bun Achilles.ts update <id> [--fix-class C] [--status S] [--severity S] [--issue N | --work-issue N] [--evidence E] [--risk-ref R]
 *   bun Achilles.ts add ... [--dedupe-key K]        # every finder files here: dedupe across finders, reappearance, KEV floor, risk map
 *   bun Achilles.ts close <id> --evidence E [--resolution remediated|accepted|false_positive] [--owner O --until D] [--tune RULE] [--ref R]
 *   bun Achilles.ts backfill-risk [--apply]      # stamp mapped risk_refs from the ratified risk map (dry run by default)
 *   bun Achilles.ts expire-acceptances [--dry-run]
 *   bun Achilles.ts unmapped [--count]           # open entries with no risk_ref
 *   bun Achilles.ts reopen <id> --evidence E   # a closed entry whose condition is back (never `accepted`)
 *   bun Achilles.ts ticket <id>        # open a work-repo issue for an open entry (idempotent; `close` closes it)
 *   bun Achilles.ts sync-scanner [--dry-run] [--json] # mirror the Workflows scanner's findings ledger (AchillesSync.ts)
 *   bun Achilles.ts stats [--json]
 *   bun Achilles.ts open-crit          # open critical/high entries as JSON (banner + ping feed)
 *   bun Achilles.ts gen-stack          # regenerate the stack manifest from Atlas + GEAR
 *
 * Registry: LIFEOS/USER/SECURITY/ACHILLES/registry.json (private USER tree;
 * git history is the audit trail). Doctrine: LIFEOS/ACHILLES/ISA.md (maintainer-side state of record, not in the release).
 *
 * @version 1.2.5
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { invariant } from "./Invariant";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

const CLAUDE = getClaudeDir();
// ACHILLES_REGISTRY_PATH points a test or replay at a scratch registry; unset means the live one.
/** The registry path. Readers outside this file call loadRegistry() and never name the path (ISA ISC-1). */
export const registryPath = (): string => process.env.ACHILLES_REGISTRY_PATH || join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/registry.json");
const REGISTRY = registryPath();
const RISK_MAP = process.env.ACHILLES_RISK_MAP_PATH || join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/risk-map.json");
const KEV = join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/kev.json");
const STACK = join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/stack.json");
const ATLAS_SNAPSHOT = join(homedir(), ".local/state/lifeos/atlas/snapshot.json");
const GEAR = join(CLAUDE, "LIFEOS/USER/GEAR.md");
const RISK_REGISTER = join(CLAUDE, "LIFEOS/USER/SECURITY/THREATMODEL/risk-register.json");

export const CATEGORIES = ["technical", "financial", "reputational", "legal", "physical", "operational"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const SOURCES = ["synapse", "pentest", "atlas", "workflows-scanner", "threatmodel", "vulnmanagement", "socrates", "codesweep", "supplychain", "manual"] as const;
/**
 * Per-install config (USER zone): legacy source aliases and the curated stack terms.
 * ACHILLES_CONFIG_PATH points a test at a scratch file; unset means the install's own.
 * Shape: { source_aliases?: {legacy: current}, source_ref_prefix_aliases?: [[legacy, current]], stack_terms?: string[] }.
 */
export const achillesConfigPath = (): string => process.env.ACHILLES_CONFIG_PATH || join(CLAUDE, "LIFEOS/USER/CONFIG/achilles.json");
interface AchillesConfig {
  sourceAliases: Readonly<Record<string, (typeof SOURCES)[number]>>;
  refPrefixAliases: ReadonlyArray<readonly [legacy: string, current: string]>;
  stackTerms: readonly string[] | null;
}
let configCache: { path: string; mtime: number; cfg: AchillesConfig } | null = null;
/** Reads the per-install config at call time; a missing file is an empty config, a malformed one fails loud. */
export function achillesConfig(): AchillesConfig {
  const path = achillesConfigPath();
  if (!existsSync(path)) return { sourceAliases: {}, refPrefixAliases: [], stackTerms: null };
  const mtime = statSync(path).mtimeMs;
  if (configCache && configCache.path === path && configCache.mtime === mtime) return configCache.cfg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    invariant(false, `${path}: not valid JSON (${(e as Error).message})`);
  }
  invariant(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `${path}: must be a JSON object with source_aliases, source_ref_prefix_aliases and stack_terms keys`);
  const raw = parsed as Record<string, unknown>;
  const aliasesRaw = raw.source_aliases ?? {};
  invariant(aliasesRaw !== null && typeof aliasesRaw === "object" && !Array.isArray(aliasesRaw), `${path}: source_aliases must be an object of {legacy: current}`);
  const aliases = aliasesRaw as Record<string, string>;
  for (const [k, v] of Object.entries(aliases)) invariant((SOURCES as readonly string[]).includes(v), `${path}: source_aliases.${k} names unknown source ${v}`);
  const prefixes = (raw.source_ref_prefix_aliases ?? []) as unknown[];
  invariant(Array.isArray(prefixes) && prefixes.every((p) => Array.isArray(p) && p.length === 2 && p.every((s) => typeof s === "string" && s.length > 0)), `${path}: source_ref_prefix_aliases must be [[legacy, current], ...]`);
  const terms = raw.stack_terms;
  invariant(terms === undefined || (Array.isArray(terms) && terms.every((t) => typeof t === "string")), `${path}: stack_terms must be a string array`);
  const cfg: AchillesConfig = {
    sourceAliases: aliases as AchillesConfig["sourceAliases"],
    refPrefixAliases: prefixes as AchillesConfig["refPrefixAliases"],
    stackTerms: (terms as string[] | undefined) ?? null,
  };
  configCache = { path, mtime, cfg };
  return cfg;
}

/**
 * Renamed sources (Workflows ISA ISC-197, ISC-228). Rows written before a rename
 * keep their stored values byte-identical, because open work-repo tickets carry the
 * stored source_ref in their dedupe marker; every read resolves them to the current
 * name instead. Stored values stay valid on save. The legacy names are per-install
 * history, so they live in the USER config (`source_aliases`, `source_ref_prefix_aliases`).
 */
/** The current source name for a stored or typed source value. */
export function canonicalSource(source: string): string {
  const aliases = achillesConfig().sourceAliases;
  return Object.hasOwn(aliases, source) ? aliases[source]! : source;
}

/** The current form of a stored or typed source_ref: a legacy prefix becomes the current one. */
export function canonicalSourceRef(ref: string): string {
  for (const [legacy, current] of achillesConfig().refPrefixAliases) if (ref.startsWith(legacy)) return current + ref.slice(legacy.length);
  return ref;
}

/** An entry as Achilles reports it: source resolved to its current name; source_ref kept as stored (ticket markers match it). */
export function entryView(e: AchillesEntry): AchillesEntry {
  return { ...e, source: canonicalSource(e.source) as AchillesEntry["source"] };
}
export const STATUSES = ["open", "in_progress", "remediated", "accepted", "false_positive", "informational"] as const;
const CLOSED_STATUSES = new Set(["remediated", "accepted", "false_positive"]);
/**
 * Fix class — who closes it (2026-09-15, the flowing-system design):
 *   auto   the system closes it on evidence with no human (a patched browser, a retired job)
 *   agent  a bounded code/config fix a worker can prepare as a verified patch; a human applies
 *   human  needs a decision, a credential, live infra, or a dashboard only the principal can reach
 */
export const FIX_CLASSES = ["auto", "agent", "human"] as const;
export type FixClass = (typeof FIX_CLASSES)[number];

export interface AchillesEntry {
  id: string;
  title: string;
  description?: string;
  category: (typeof CATEGORIES)[number];
  severity: (typeof SEVERITIES)[number];
  source: (typeof SOURCES)[number];
  source_ref?: string; // idempotency key, e.g. "amber:<capture-id>"
  status: (typeof STATUSES)[number];
  affected_match?: boolean; // synapse: did the story match owned tech
  cves: string[];
  affected: string[];
  first_seen: string;
  closed_at?: string;
  work_issue?: number; // linked work-repo issue number (stored as ul_issue before 2026-10-13; loadRegistry migrates it)
  risk_ref?: string; // ThreatModel register id (R-xxx)
  risk_basis?: "finder" | "map"; // who linked the risk: the finder that filed it, or the ratified risk map
  dedupe_key?: string; // one weakness on one target, across finders: "<check>@<target>"
  linked_refs?: string[]; // other finders' source_refs reporting this same weakness
  cleared_refs?: string[]; // refs whose finder reported the weakness gone; the entry closes when every ref is clear
  held_refs?: string[]; // refs a finder resolved as accepted or not-applicable; closing a merged entry then needs the principal
  accepted_owner?: string; // who accepted the risk
  accepted_until?: string; // when the acceptance lapses and the entry reads open again
  fix_class?: FixClass; // who closes it; stamped at add by classifyFix, overridable
  notified_at?: string; // when the new-security-work email went out (idempotency marker)
  evidence: string[];
  links: string[];
}

interface Registry { version: 1; updated: string; entries: AchillesEntry[] }

// ---------- fix class ----------

/** Optional principal overrides: { "<source_ref prefix or check>": "auto|agent|human" }, longest prefix wins. */
const FIX_CLASS_OVERRIDES = join(CLAUDE, "LIFEOS/USER/SECURITY/ACHILLES/fix-classes.json");
export function loadFixClassOverrides(path = FIX_CLASS_OVERRIDES): Record<string, FixClass> {
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const out: Record<string, FixClass> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_") && (FIX_CLASSES as readonly string[]).includes(String(v))) out[k] = v as FixClass;
  return out;
}

const SELF_UPDATING = /\b(google chrome|chrome|chromium|safari|firefox|microsoft edge|macos|ios|ipados|watchos|tvos)\b/i;
const SCANNER_HUMAN_CATEGORIES = new Set(["dns", "mail", "tls", "certificate", "registration", "availability"]);

/**
 * Default fix class from what the entry is, before overrides. Pure; the rules
 * are by source and shape, never by a specific question or target id — those
 * belong in the overrides file (USER data), not in public code.
 */
export function classifyFix(e: Pick<AchillesEntry, "source" | "source_ref" | "affected" | "category">, overrides: Record<string, FixClass> = loadFixClassOverrides()): FixClass {
  const ref = e.source_ref ?? "";
  const keys = Object.keys(overrides).filter((k) => ref.startsWith(k) || ref.includes(`|${k}`)).sort((a, b) => b.length - a.length);
  if (keys.length) return overrides[keys[0]!]!;
  switch (canonicalSource(e.source)) {
    case "synapse": return e.affected.some((a) => SELF_UPDATING.test(a)) ? "auto" : "human";
    case "workflows-scanner": {
      const cat = ref.split("|")[1] ?? "";
      return SCANNER_HUMAN_CATEGORIES.has(cat) ? "human" : "agent";
    }
    case "socrates": return "agent";
    case "atlas": return "agent";
    case "pentest": return "agent";
    case "codesweep": return "agent";
    case "vulnmanagement": return "agent";
    case "supplychain": return "agent";
    case "threatmodel": return "human";
    default: return e.category === "technical" ? "agent" : "human";
  }
}

// ---------- store ----------

/**
 * What each loaded registry object was read from: its path and the sha256 of the bytes on disk (null when no file
 * existed). saveRegistry compares it with the file under its lock, so a writer holding a stale copy (the scanner,
 * the CLI, the remediation loop, codesweep) fails loud instead of erasing another writer's entries.
 */
const loadedFrom = new WeakMap<Registry, { path: string; digest: string | null }>();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A save refused because the registry on disk changed after this copy was loaded. Reload, reapply, save again. */
export class RegistryConflict extends Error {
  constructor(path: string) { super(`registry at ${path} changed since it was loaded; reload and reapply`); this.name = "RegistryConflict"; }
}

export function loadRegistry(path = registryPath()): Registry {
  if (!existsSync(path)) {
    const empty: Registry = { version: 1, updated: new Date().toISOString(), entries: [] };
    loadedFrom.set(empty, { path: resolve(path), digest: null });
    return empty;
  }
  const text = readFileSync(path, "utf8");
  const r = JSON.parse(text) as Registry;
  loadedFrom.set(r, { path: resolve(path), digest: sha(text) });
  invariant(r.version === 1 && Array.isArray(r.entries), `registry at ${path} is not a v1 registry`);
  // Entries written before risk_basis existed got their risk_ref from the finder that filed them (ThreatModel, manual).
  for (const e of r.entries) if (e.risk_ref !== undefined && e.risk_basis === undefined) e.risk_basis = "finder";
  for (const e of r.entries) migrateIssueKey(e);
  return r;
}

/** The linked work-issue field was `ul_issue` before 2026-10-13. Readers accept both keys; every write carries only `work_issue`. */
export function migrateIssueKey(e: AchillesEntry): AchillesEntry {
  const legacy = e as AchillesEntry & { ul_issue?: number };
  if (legacy.ul_issue !== undefined) {
    if (e.work_issue === undefined) e.work_issue = legacy.ul_issue;
    delete legacy.ul_issue;
  }
  return e;
}

/** The linked work-issue number from an entry in either the current or the legacy key. */
export const workIssueOf = (e: { work_issue?: number | null; ul_issue?: number | null }): number | undefined =>
  (e.work_issue ?? e.ul_issue) ?? undefined;

export const isOpenEntry = (e: Pick<AchillesEntry, "status">): boolean => e.status === "open" || e.status === "in_progress";

/** Open technical entries per estate row, rolled up to each life risk through the row's telos_ref.
 *  The audit report counts by the same rule, so the CLI, the API and the report agree. */
export function openByRisk(entries: AchillesEntry[], estate: Array<{ id: string; telos_ref?: string }>): { estate: Record<string, number>; life: Record<string, number> } {
  const out = { estate: {} as Record<string, number>, life: {} as Record<string, number> };
  const lifeOf = new Map(estate.map((r) => [r.id, r.telos_ref]));
  for (const e of entries) {
    if (!isOpenEntry(e) || e.category !== "technical" || !e.risk_ref) continue;
    out.estate[e.risk_ref] = (out.estate[e.risk_ref] ?? 0) + 1;
    const lr = lifeOf.get(e.risk_ref);
    if (lr) out.life[lr] = (out.life[lr] ?? 0) + 1;
  }
  return out;
}

/** Acceptances closed from this date on must name an owner and an expiry; older ones predate the rule. */
export const ACCEPTANCE_RULE_FROM = "2026-10-09T00:00:00.000Z";

/**
 * Credential shapes a registry field must never carry (ISC-4). Each string field is scanned raw, so a quoted
 * value cannot hide behind JSON escaping. Keyword rules require a secret-looking value (letters and digits, no
 * dots or spaces), so code a finder quotes, such as `apiKey = env.API_KEY`, is not mistaken for a leak.
 */
export const SECRET_SHAPES: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(password|passwd|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["']?(?=[^\s"',;]*\d)(?=[^\s"',;]*[A-Za-z])[A-Za-z0-9_\-+/=]{12,}/i,
];
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

export function assertEntry(e: AchillesEntry, riskIds?: Set<string>): void {
  invariant(e.fix_class === undefined || (FIX_CLASSES as readonly string[]).includes(e.fix_class), `${e.id}: fix_class must be one of ${FIX_CLASSES.join("|")}`);
  invariant(/^ACH-\d{4}$/.test(e.id), `bad id ${e.id}`);
  invariant(e.title.trim().length > 0, "title required");
  invariant((CATEGORIES as readonly string[]).includes(e.category), `bad category ${e.category}`);
  invariant((SEVERITIES as readonly string[]).includes(e.severity), `bad severity ${e.severity}`);
  invariant((SOURCES as readonly string[]).includes(canonicalSource(e.source)), `bad source ${e.source}`);
  invariant((STATUSES as readonly string[]).includes(e.status), `bad status ${e.status}`);
  invariant(!Number.isNaN(Date.parse(e.first_seen)), `bad first_seen ${e.first_seen}`);
  invariant(Array.isArray(e.cves) && Array.isArray(e.affected) && Array.isArray(e.evidence) && Array.isArray(e.links), "array fields required");
  if (CLOSED_STATUSES.has(e.status)) {
    invariant(e.evidence.length > 0, `closed entry ${e.id} requires evidence`);
    invariant(!!e.closed_at && !Number.isNaN(Date.parse(e.closed_at)), `closed entry ${e.id} requires closed_at`);
  }
  if (e.risk_ref !== undefined && riskIds) invariant(riskIds.has(e.risk_ref), `risk_ref ${e.risk_ref} not in ThreatModel register`);
  if (e.risk_ref !== undefined) invariant(e.risk_basis === "finder" || e.risk_basis === "map", `${e.id}: risk_ref needs a risk_basis of finder or map`);
  invariant([e.linked_refs, e.cleared_refs, e.held_refs].every((a) => a === undefined || Array.isArray(a)), `${e.id}: linked_refs, cleared_refs and held_refs must be arrays`);
  if (e.status === "accepted" && e.closed_at && e.closed_at >= ACCEPTANCE_RULE_FROM) {
    invariant(!!e.accepted_owner?.trim(), `${e.id}: an accepted entry names its owner`);
    invariant(!!e.accepted_until && !Number.isNaN(Date.parse(e.accepted_until)), `${e.id}: an accepted entry carries an expiry date`);
  }
  const hit = stringsOf(e).some((s) => SECRET_SHAPES.some((re) => re.test(s)));
  invariant(!hit, `entry ${e.id} contains a credential-shaped string — never store secrets in the registry`);
}

function riskIds(): Set<string> {
  try {
    const r = JSON.parse(readFileSync(RISK_REGISTER, "utf8"));
    return new Set((r.risks ?? []).map((x: { id: string }) => x.id));
  } catch { return new Set(); }
}

/** A copy of r with new entries that keeps r's load provenance, so saving the copy still gets the stale-write check. */
export function withEntries(r: Registry, entries: AchillesEntry[]): Registry {
  const out: Registry = { ...r, entries };
  const base = loadedFrom.get(r);
  if (base) loadedFrom.set(out, base);
  return out;
}

export function saveRegistry(r: Registry, path = REGISTRY): void {
  const ids = riskIds();
  const seen = new Set<string>();
  for (const e of r.entries) {
    migrateIssueKey(e);
    assertEntry(e, e.risk_ref !== undefined ? ids : undefined);
    invariant(!seen.has(e.id), `duplicate id ${e.id}`);
    seen.add(e.id);
  }
  const refs = r.entries.flatMap((e) => [e.source_ref, ...(e.linked_refs ?? [])]).filter((ref): ref is string => !!ref).map(canonicalSourceRef);
  invariant(refs.length === new Set(refs).size, "duplicate source_ref — idempotency key collision");
  mkdirSync(dirname(path), { recursive: true });
  const release = takeRegistryLock(path + ".lock");
  try {
    // Compare-and-swap under the lock: a copy loaded from this path saves only over the bytes it was loaded from.
    const base = loadedFrom.get(r);
    if (base && base.path === resolve(path)) {
      const now = existsSync(path) ? sha(readFileSync(path, "utf8")) : null;
      if (now !== base.digest) throw new RegistryConflict(path);
    }
    r.updated = new Date().toISOString();
    const text = JSON.stringify(r, null, 2) + "\n";
    const tmp = path + ".tmp";
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    loadedFrom.set(r, { path: resolve(path), digest: sha(text) });
  } finally {
    release();
  }
}

/**
 * Load, change one entry, save, retrying on a RegistryConflict, so a short read-modify-write never loses to a
 * concurrent writer and never erases its work. `fn` runs on each fresh load, so it must only describe the change.
 */
export function updateEntry(path: string, id: string, fn: (e: AchillesEntry) => void): AchillesEntry {
  for (let attempt = 1; ; attempt++) {
    const r = loadRegistry(path);
    const e = r.entries.find((x) => x.id === id);
    invariant(!!e, `${id} vanished from the registry mid-pass`);
    fn(e!);
    try {
      saveRegistry(r, path);
      return e!;
    } catch (err) {
      if (!(err instanceof RegistryConflict) || attempt >= 5) throw err;
    }
  }
}

/** A lock older than this belongs to a writer that died mid-save; a save takes well under a second. */
const REGISTRY_LOCK_STALE_MS = 30_000;
const sleepMs = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** O_EXCL lock beside the registry, held only for the compare and the rename. Waits up to 10 s for a live holder. */
function takeRegistryLock(lockPath: string): () => void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return () => rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      if (age > REGISTRY_LOCK_STALE_MS) { rmSync(lockPath, { force: true }); continue; }
      if (Date.now() >= deadline) throw new Error(`registry lock ${lockPath} held for over 10 s by a live writer`);
      sleepMs(25);
    }
  }
}

export function nextId(r: Registry): string {
  const max = r.entries.reduce((m, e) => Math.max(m, parseInt(e.id.slice(4), 10)), 0);
  return `ACH-${String(max + 1).padStart(4, "0")}`;
}

export function findBySourceRef(r: Registry, ref: string): AchillesEntry | undefined {
  const want = canonicalSourceRef(ref);
  return r.entries.find((e) => [e.source_ref, ...(e.linked_refs ?? [])].some((x) => x !== undefined && canonicalSourceRef(x) === want));
}

// ---------- the one write path every finder uses ----------
// addEntry is how a weakness enters the registry, whichever finder found it: the CLI's `add`,
// the scanner sync and the code sweep all come here. It owns dedupe (one entry per weakness per
// target, across finders), reappearance, suppression of tuned false positives, the KEV floor,
// and the risk link. Pure over the registry object; the caller saves.

export interface RiskMapRule { source: string; family?: string; risk_ref: string }
export interface RiskMap { ratified_by?: string; ratified_at?: string; rules: RiskMapRule[] }

/** The risk map, or null when absent. It stamps nothing until the principal has ratified it. */
export function loadRiskMap(path = RISK_MAP, ids: Set<string> = riskIds()): RiskMap | null {
  if (!existsSync(path)) return null;
  let m: RiskMap;
  // A broken map must never stop a finder from filing: it degrades to no map, loudly.
  try { m = JSON.parse(readFileSync(path, "utf8")) as RiskMap; } catch (err) { console.error(`[achilles] risk map unreadable, ignored: ${String(err).slice(0, 160)}`); return null; }
  if (!Array.isArray(m.rules)) { console.error(`[achilles] risk map at ${path} has no rules[], ignored`); return null; }
  const bad = ids.size ? m.rules.filter((x) => !ids.has(x.risk_ref)) : [];
  if (bad.length) console.error(`[achilles] risk map rules naming unknown risks dropped: ${bad.map((x) => x.risk_ref).join(", ")}`);
  return { ...m, rules: m.rules.filter((x) => !bad.includes(x)) };
}
export const isRatified = (m: RiskMap | null | undefined): m is RiskMap => !!m && !!m.ratified_by?.trim() && !!m.ratified_at;

/** The check family a finding belongs to, read from its source_ref: the scanner's category, code sweep's app, else none. */
export function riskFamily(e: Pick<AchillesEntry, "source" | "source_ref">): string | undefined {
  const ref = e.source_ref ?? "";
  if (canonicalSource(e.source) === "workflows-scanner") return ref.split("|")[1];
  if (ref.startsWith("codesweep:")) return ref.split(":")[1];
  return undefined;
}

/**
 * Pure: store each entry under its current source name. Legacy scanner labels become workflows-scanner, and
 * code-sweep findings filed under pentest become codesweep (security-audit-unification ISC-14, ISC-18). Only the
 * source field moves; source_ref stays byte-identical because open tickets carry it in their dedupe marker.
 */
export function relabelSources(r: Registry): { registry: Registry; changes: Array<{ id: string; from: string; to: string }> } {
  const changes: Array<{ id: string; from: string; to: string }> = [];
  const entries = r.entries.map((e) => {
    const to = (e.source_ref ?? "").startsWith("codesweep:") ? "codesweep" : canonicalSource(e.source);
    if (to === e.source) return e;
    changes.push({ id: e.id, from: e.source, to });
    return { ...e, source: to as AchillesEntry["source"] };
  });
  return { registry: withEntries(r, entries), changes };
}

/** The estate risk a ratified map gives this entry: a family-specific rule beats a source-wide one. */
export function mapRisk(e: Pick<AchillesEntry, "source" | "source_ref">, m: RiskMap | null | undefined): string | undefined {
  if (!isRatified(m)) return undefined;
  const src = canonicalSource(e.source), fam = riskFamily(e);
  const hit = m.rules.find((x) => canonicalSource(x.source) === src && x.family !== undefined && x.family === fam) ?? m.rules.find((x) => canonicalSource(x.source) === src && x.family === undefined);
  return hit?.risk_ref;
}

/** CISA known-exploited CVE ids, from the local cache a finder step refreshes. Empty when absent. */
export function loadKev(path = KEV): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { cves?: string[] };
    return new Set((j.cves ?? []).map((c) => c.toUpperCase()));
  } catch (err) { console.error(`[achilles] KEV cache unreadable, ignored: ${String(err).slice(0, 160)}`); return new Set(); }
}

/** One weakness on one target. The scanner's key gives "<check>@<target>"; any other finder names its own or keeps its ref. */
export function defaultDedupeKey(e: Pick<AchillesEntry, "source" | "source_ref" | "id">): string {
  const ref = e.source_ref ? canonicalSourceRef(e.source_ref) : "";
  if (canonicalSource(e.source) === "workflows-scanner" && ref.startsWith("workflows:")) {
    const [target, , check] = ref.slice("workflows:".length).split("#")[0]!.split("|");
    if (target && check) return `${check}@${target}`;
  }
  return ref ? `${canonicalSource(e.source)}:${ref}` : `id:${e.id}`;
}

export interface NewEntryInput {
  title: string;
  source: AchillesEntry["source"];
  source_ref?: string;
  dedupe_key?: string;
  description?: string;
  category?: AchillesEntry["category"];
  severity?: AchillesEntry["severity"];
  status?: AchillesEntry["status"];
  affected_match?: boolean;
  cves?: string[];
  affected?: string[];
  first_seen?: string;
  closed_at?: string;
  work_issue?: number;
  risk_ref?: string;
  fix_class?: FixClass;
  evidence?: string[];
  links?: string[];
  accepted_owner?: string;
  accepted_until?: string;
}
export interface AddContext { now?: string; riskMap?: RiskMap | null; kev?: Set<string>; overrides?: Record<string, FixClass>; actor?: string }
export type AddResult = { status: "added" | "exists" | "linked" | "reopened" | "suppressed"; id: string };

export const isTuned = (e: AchillesEntry) => e.status === "false_positive" && e.evidence.some((x) => x.startsWith("tune: "));
const refsOf = (e: AchillesEntry) => [e.source_ref, ...(e.linked_refs ?? [])].filter((x): x is string => !!x).map(canonicalSourceRef);

function reopenInPlace(e: AchillesEntry, evidence: string[]): void {
  e.status = "open";
  delete e.closed_at;
  delete e.work_issue; // the old ticket stays closed as history; `ticket` opens a fresh one
  delete (e as { ul_issue?: number }).ul_issue;
  e.cleared_refs = [];
  e.held_refs = [];
  e.evidence.push(...evidence);
}

export function addEntry(r: Registry, input: NewEntryInput, ctx: AddContext = {}): AddResult {
  const now = ctx.now ?? new Date().toISOString();
  const ref = input.source_ref ? canonicalSourceRef(input.source_ref) : undefined;
  // A ref-less add with no stated key is a new weakness by definition: nothing to dedupe against (audit #1).
  const key = input.dedupe_key ?? (input.source_ref ? defaultDedupeKey({ source: input.source, source_ref: input.source_ref, id: "" }) : undefined);
  const reported = input.evidence?.length ? input.evidence : [`${canonicalSource(input.source)} reported it again at ${now}`];

  const existing = (ref ? findBySourceRef(r, ref) : undefined) ?? (key === undefined ? undefined : r.entries.find((e) => (e.dedupe_key ?? defaultDedupeKey(e)) === key && e.status !== "informational"));
  if (existing) {
    if (isTuned(existing)) return { status: "suppressed", id: existing.id };
    const linkNew = !!ref && !refsOf(existing).includes(ref);
    if (linkNew) {
      existing.linked_refs = [...(existing.linked_refs ?? []), input.source_ref!];
      existing.evidence.push(`also reported by ${canonicalSource(input.source)}: ${input.source_ref}`);
    }
    if (ref && existing.cleared_refs?.length) existing.cleared_refs = existing.cleared_refs.filter((x) => canonicalSourceRef(x) !== ref);
    // A fixed weakness, or a false positive nobody tuned the finder for, that a finder reports again is open again (ISC-81).
    if (existing.status === "remediated" || existing.status === "false_positive") { reopenInPlace(existing, reported); return { status: "reopened", id: existing.id }; }
    return { status: linkNew ? "linked" : "exists", id: existing.id };
  }

  const status = input.status ?? "open";
  invariant(!(ctx.actor === "loop" && (status === "accepted" || status === "false_positive")), `the fix loop never files an entry as ${status}`);
  const id = nextId(r);
  const e: AchillesEntry = {
    id,
    title: input.title,
    description: input.description,
    category: input.category ?? "technical",
    severity: input.severity ?? "medium",
    source: input.source,
    source_ref: input.source_ref,
    dedupe_key: key ?? `id:${id}`,
    status,
    affected_match: input.affected_match,
    cves: input.cves ?? [],
    affected: input.affected ?? [],
    first_seen: input.first_seen ?? now,
    closed_at: input.closed_at,
    work_issue: input.work_issue,
    accepted_owner: input.accepted_owner,
    accepted_until: input.accepted_until,
    evidence: [...(input.evidence ?? [])],
    links: [...(input.links ?? [])],
  };
  for (const k of Object.keys(e) as (keyof AchillesEntry)[]) if (e[k] === undefined) delete e[k];
  const kevHit = e.cves.find((c) => (ctx.kev ?? new Set()).has(c.toUpperCase()));
  if (kevHit && (e.severity === "medium" || e.severity === "low")) {
    e.evidence.push(`raised ${e.severity} → high: ${kevHit} is on the CISA KEV list (known exploited)`);
    e.severity = "high";
  }
  if (input.risk_ref) { e.risk_ref = input.risk_ref; e.risk_basis = "finder"; }
  else {
    const mapped = mapRisk(e, ctx.riskMap);
    if (mapped) { e.risk_ref = mapped; e.risk_basis = "map"; }
  }
  e.fix_class = input.fix_class ?? classifyFix(e, ctx.overrides);
  if (CLOSED_STATUSES.has(e.status) && !e.closed_at) e.closed_at = now;
  assertEntry(e);
  r.entries.push(e);
  return { status: "added", id: e.id };
}

/**
 * A finder reports one of its refs resolved. A merged entry closes as remediated only once every finder that
 * reported it has cleared it with a pass (ISC-37). A finder that resolves its ref as accepted or not-applicable
 * holds that ref: when every ref is cleared or held and any is held, the close is the principal's call.
 * Idempotent: a ref already cleared or held changes nothing, so an hourly ledger that keeps resolved findings
 * never rewrites the entry (audit #3).
 */
export function clearRef(r: Registry, ref: string, evidence: string, now = new Date().toISOString(), resolution: "remediated" | "accepted" | "false_positive" = "remediated"): "closed" | "partial" | "needs_principal" | "unchanged" | "none" {
  const e = findBySourceRef(r, ref);
  if (!e || !(e.status === "open" || e.status === "in_progress")) return "none";
  const want = canonicalSourceRef(ref);
  const cleared = new Set((e.cleared_refs ?? []).map(canonicalSourceRef));
  const held = new Set((e.held_refs ?? []).map(canonicalSourceRef));
  if (cleared.has(want) || held.has(want)) return "unchanged";
  (resolution === "remediated" ? cleared : held).add(want);
  e.evidence.push(evidence);
  const all = refsOf(e);
  const open = all.filter((x) => !cleared.has(x) && !held.has(x));
  e.cleared_refs = [...cleared];
  e.held_refs = [...held];
  if (open.length) { e.evidence.push(`${want} ${resolution === "remediated" ? "cleared" : `resolved as ${resolution}`}; still reported by ${open.join(", ")}`); return "partial"; }
  if (held.size === 0) { e.status = "remediated"; e.closed_at = now; e.cleared_refs = []; return "closed"; }
  e.fix_class = "human";
  e.evidence.push(`every finder has resolved it, but ${[...held].join(", ")} resolved as accepted or not-applicable; closing it is the principal's call`);
  return "needs_principal";
}

export interface CloseOptions {
  resolution: "remediated" | "accepted" | "false_positive";
  evidence: string[];
  owner?: string;
  until?: string;
  tune?: string;
  /** "loop" is the unattended fix loop, which never makes a risk decision (ISC-43). */
  actor?: string;
  now?: string;
}

/** The one close: evidence always, an owner and expiry on an acceptance, never a risk decision by the loop. */
export function closeEntry(e: AchillesEntry, o: CloseOptions): AchillesEntry {
  invariant(CLOSED_STATUSES.has(o.resolution), `resolution must be one of remediated|accepted|false_positive`);
  invariant(o.evidence.length > 0, `${e.id}: a close needs evidence`);
  invariant(!(o.actor === "loop" && o.resolution !== "remediated"), `${e.id}: the fix loop never closes an entry as ${o.resolution}; only the principal makes that call`);
  if (o.resolution === "accepted") {
    invariant(!!o.owner?.trim(), `${e.id}: accepting a risk names its owner (--owner)`);
    invariant(!!o.until && !Number.isNaN(Date.parse(o.until)), `${e.id}: accepting a risk sets an expiry (--until YYYY-MM-DD)`);
  }
  const out: AchillesEntry = { ...e, status: o.resolution, closed_at: o.now ?? new Date().toISOString(), evidence: [...e.evidence, ...o.evidence, ...(o.tune ? [`tune: ${o.tune}`] : [])] };
  if (o.resolution === "accepted") { out.accepted_owner = o.owner!.trim(); out.accepted_until = o.until; }
  assertEntry(out);
  return out;
}

/** The moment an acceptance lapses: the end of its until day when it names a date only. */
export const acceptanceEnd = (until: string): number => Date.parse(until) + (/^\d{4}-\d{2}-\d{2}$/.test(until) ? DAY : 0);

/** Acceptances past their expiry read open again and wait for a fresh decision. Returns the ids reopened. */
export function expireAcceptances(r: Registry, now = new Date().toISOString()): string[] {
  const out: string[] = [];
  for (const e of r.entries) {
    if (e.status !== "accepted" || !e.accepted_until || acceptanceEnd(e.accepted_until) > Date.parse(now)) continue;
    e.status = "open";
    delete e.closed_at;
    delete e.work_issue;
    delete (e as { ul_issue?: number }).ul_issue; // accepted_until stays: the scanner reads it to know an older tombstone cannot re-accept
    e.evidence.push(`acceptance expired ${e.accepted_until.slice(0, 10)} (owner ${e.accepted_owner ?? "unknown"}); needs a fresh decision`);
    out.push(e.id);
  }
  return out;
}

/** Pure: stamp a mapped risk_ref on every entry that has none. Never moves an existing link or touches another field. */
export function backfillRiskRefs(r: Registry, m: RiskMap | null): { registry: Registry; changes: Array<{ id: string; risk_ref: string }> } {
  const changes: Array<{ id: string; risk_ref: string }> = [];
  const entries = r.entries.map((e) => {
    if (e.risk_ref !== undefined) return e;
    const mapped = mapRisk(e, m);
    if (!mapped) return e;
    changes.push({ id: e.id, risk_ref: mapped });
    return { ...e, risk_ref: mapped, risk_basis: "map" as const };
  });
  return { registry: withEntries(r, entries), changes };
}

// ---------- tickets ----------
// Achilles owns both ends of the work-repo ticket lifecycle: `ticket` opens,
// `close` closes. The hidden marker is the dedupe key; the search key is the
// entry id (unique, search-safe — source_refs carry `|` and `#`).

const PRIORITY_BY_SEVERITY: Record<AchillesEntry["severity"], string> = { critical: "Priority:P0", high: "Priority:P1", medium: "Priority:P2", low: "Priority:P3" };

export const ticketMarker = (e: AchillesEntry): string => `<!-- achilles:${e.source_ref ?? e.id} -->`;

export function ticketTitle(e: AchillesEntry): string {
  return `[Achilles] ${e.severity.toUpperCase()}: ${e.title}`.replace(/"/g, "'").slice(0, 100);
}

export function ticketLabels(e: AchillesEntry, agentLabel: string): string[] {
  return ["Status:queued", agentLabel, "Type:problem", PRIORITY_BY_SEVERITY[e.severity], ...(e.category === "technical" ? ["security"] : []), ...(e.fix_class ? [`fix:${e.fix_class}`] : [])];
}

export function ticketBody(e: AchillesEntry): string {
  return [
    `## Achilles ${e.id} — ${e.severity}/${e.category} (${e.source})`,
    e.description ?? "",
    "",
    e.affected.length ? `- Affected: ${e.affected.map((a) => `\`${a}\``).join(", ")}` : "",
    e.cves.length ? `- CVEs: ${e.cves.join(", ")}` : "",
    e.risk_ref ? `- Risk: ${e.risk_ref}` : "",
    e.fix_class ? `- Fix class: ${e.fix_class}${e.fix_class === "agent" ? " (a worker prepares a verified patch nightly; `achilles apply` lands it)" : e.fix_class === "auto" ? " (closes itself on evidence)" : " (needs the principal)"}` : "",
    ...e.evidence.map((ev) => `- Evidence: ${ev}`),
    ...e.links.map((l) => `- Link: ${l}`),
    `- Registry: \`bun LIFEOS/TOOLS/Achilles.ts show ${e.id}\` · closing the entry with evidence closes this issue`,
    "",
    "_Opened by Achilles (the vulnerability registry). A LifeOS-install patch may land on main unattended once its scoped tests and an independent review pass; a project patch waits for the principal's y. Achilles never deploys or pushes._",
    ticketMarker(e),
  ].filter((l) => l !== "").join("\n");
}

// ---------- time to close ----------

const DAY = 86_400_000;
/**
 * The one number the flowing system is measured on: how long a weakness sits.
 * Closed entries from the last 30 days give the median days-to-close per fix
 * class; open ones give the oldest age. Target: under 1 day for auto and agent.
 */
export function timeToClose(entries: AchillesEntry[], now = Date.now()): Record<string, { closed_30d: number; median_days: number | null; open: number; oldest_open_days: number | null; over_24h: number }> {
  const out: Record<string, { closed_30d: number; median_days: number | null; open: number; oldest_open_days: number | null; over_24h: number }> = {};
  for (const c of [...FIX_CLASSES, "unclassified"]) {
    const mine = entries.filter((e) => (e.fix_class ?? "unclassified") === c && e.status !== "informational");
    const closed = mine.filter((e) => CLOSED_STATUSES.has(e.status) && e.closed_at && now - Date.parse(e.closed_at) <= 30 * DAY)
      .map((e) => (Date.parse(e.closed_at!) - Date.parse(e.first_seen)) / DAY).sort((a, b) => a - b);
    const open = mine.filter((e) => e.status === "open" || e.status === "in_progress").map((e) => (now - Date.parse(e.first_seen)) / DAY);
    const median = closed.length ? closed[Math.floor(closed.length / 2)]! : null;
    out[c] = {
      closed_30d: closed.length,
      median_days: median === null ? null : Math.round(median * 10) / 10,
      open: open.length,
      oldest_open_days: open.length ? Math.round(Math.max(...open) * 10) / 10 : null,
      over_24h: open.filter((d) => d > 1).length,
    };
  }
  return out;
}

// ---------- args ----------

/** --issue N or --work-issue N; --ul-issue N is the pre-2026-10-13 spelling, kept as an undocumented alias. */
function issueFlag(args: string[]): number | undefined {
  const v = flag(args, "issue") ?? flag(args, "work-issue") ?? flag(args, "ul-issue");
  return v ? Number(v) : undefined;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : undefined;
}
function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === `--${name}`) out.push(args[i + 1]);
  return out;
}

// ---------- stack manifest ----------

function genStack(): { generated_at: string; sources: string[]; terms: string[] } {
  const terms = new Set<string>();
  const sources: string[] = [];
  if (existsSync(ATLAS_SNAPSHOT)) {
    sources.push("atlas");
    const snap = JSON.parse(readFileSync(ATLAS_SNAPSHOT, "utf8"));
    for (const a of snap.assets ?? []) {
      if (a.status && a.status !== "active") continue;
      if (["device", "machine", "service", "system"].includes(a.kind)) terms.add(String(a.display_name));
      if (a.kind === "domain") terms.add(String(a.display_name));
    }
  }
  if (existsSync(GEAR)) {
    sources.push("gear");
    const gear = readFileSync(GEAR, "utf8");
    // Vendor/product names: bolded terms and table first-columns are the curated names.
    for (const m of gear.matchAll(/\*\*([A-Z][A-Za-z0-9 .\-+/]{2,40})\*\*/g)) terms.add(m[1].trim());
  }
  // The platform LifeOS itself runs on, then the install's own curated platform terms (USER config `stack_terms`).
  for (const t of ["macOS", "Chrome", "bun", "TypeScript", "GitHub", "Cloudflare", "Cloudflare Workers"]) terms.add(t);
  const curated = achillesConfig().stackTerms;
  if (curated === null) console.error(`achilles gen-stack: ${achillesConfigPath()} has no stack_terms; add the platforms your estate runs on (Atlas and GEAR terms still apply)`);
  for (const t of curated ?? []) terms.add(t);
  const out = { generated_at: new Date().toISOString(), sources, terms: [...terms].sort() };
  // The guard protects a good manifest from a broken regeneration (Atlas or GEAR unreadable),
  // so it compares against the manifest on disk rather than a fixed size: a fresh install with
  // only the template's stack_terms writes its first manifest, and a later run may not shrink it by half.
  const prior = existsSync(STACK) ? ((): number => { try { const t = JSON.parse(readFileSync(STACK, "utf8"))?.terms; return Array.isArray(t) ? t.length : 0; } catch { return 0; } })() : 0;
  invariant(out.terms.length * 2 >= prior, `stack manifest would shrink from ${prior} to ${out.terms.length} terms; refusing to overwrite ${STACK} (check Atlas, GEAR and ${achillesConfigPath()} stack_terms)`);
  mkdirSync(dirname(STACK), { recursive: true });
  writeFileSync(STACK, JSON.stringify(out, null, 2) + "\n");
  return out;
}

// ---------- apply (the lander) ----------
// `achilles apply` lands a worker-prepared patch on main. A human at the keyboard gets the
// shared-tree checks (a clean index, clean target files, the scoped tests). The unattended
// loop (`--unattended`, called by AchillesRemediate) also gets the refusals a human would
// have supplied: install only, never a gate path, never without a passing independent review.
// The lander enforces them, so no caller can skip them. It never deploys or pushes.

const REVIEW_SCRIPT = join(CLAUDE, "LIFEOS/TOOLS/Review.ts");
export const LAND_TEST_TIMEOUT_MS = 10 * 60_000;
export const LAND_REVIEW_TIMEOUT_MS = 20 * 60_000;

/**
 * Gate paths (ISC-56): the harness's guards, its instructions, its agents, the reviewer, the
 * invariant and send guards, this loop's own code, and the git plumbing that decides what a
 * commit carries and what runs on commit. A patch to any of them changes what judges the next
 * patch, so the loop never lands one. Every `.env*` name is gated because no remediation path
 * may touch secrets (ISC-35). Names match at any depth and case-insensitively: the install
 * sits on a case-insensitive volume, and a nested `.gitignore` steers tracking as much as the
 * root one does. A gate directory name matches on every path component, the last one
 * included: a patch that creates `.githooks` itself (a symlink, a gitlink, or a plain file
 * standing in for the directory) redirects what runs on commit as surely as one inside it.
 * `.env*` is matched the same way, so a `.env.d/` directory is as closed as a `.env` file.
 */
const GATE_DIRS = new Set(["hooks", "agents", ".githooks"]);
const GATE_ENV = /^\.env/i;
const GATE_FILE = /^(settings[^/]*\.json|claude\.md|lifeos_system_prompt\.md|review\.ts|achilles[^/]*\.ts|invariant\.ts|sendgate\.ts|\.gitattributes|\.gitignore)$/i;

/**
 * The enforcement tools that live beside the ordinary ones in LIFEOS/TOOLS: the purchase-confirmation challenge,
 * the code/data boundary, the emergency API lane and its spend ledger, the secret store and scanner, and the
 * gates that decide what may ship. A patch to any of them (or its test) changes what judges or permits the next
 * action, so the loop never lands one unattended. Exact names, any depth, case-insensitive.
 *
 * The confinement primitives are on the list too (S080): the Seatbelt sandbox that confines worker-written code
 * while the loop judges it, and the shared path and network boundaries (Boundary, SafeFetch). A test file is a gate
 * path when any dot- or dash-separated part of its name is one of these stems (`p1-sandbox.test.ts`,
 * `IscTier.sandbox.losi-p1.test.ts`), because a sandbox test may live beside the tool that uses it.
 */
const GATE_TOOL_STEMS = ["codedataboundary", "confirm", "apilane", "overage", "secrets", "secretscan", "checkfileboundary", "gateratify", "gatereach", "blockmessagegate", "briefgate", "devgate", "isagate", "jobgate", "skillhygienegate", "videopiigate", "sandbox", "boundary", "safefetch"];
const GATE_TOOLS = new RegExp(`^(${GATE_TOOL_STEMS.join("|")})(\\.coverage)?(\\.test)?\\.ts$`, "i");
const gateToolTest = (name: string): boolean => /\.test\.ts$/i.test(name) && name.toLowerCase().split(/[.\-_]/).some((part) => GATE_TOOL_STEMS.includes(part));

/** The result of `gh issue list --json number`: ok with the first issue number (or none), or not ok with why the search proves nothing. */
export function parseTicketSearch(code: number, out: string): { ok: true; number: number | undefined } | { ok: false; why: string } {
  if (code !== 0) return { ok: false, why: `gh exited ${code}` };
  let parsed: unknown;
  try { parsed = JSON.parse(out); } catch { return { ok: false, why: "unparseable output" }; }
  if (!Array.isArray(parsed)) return { ok: false, why: "not a list" };
  for (const row of parsed) {
    if (typeof row !== "object" || row === null || !Number.isInteger((row as { number?: unknown }).number) || (row as { number: number }).number <= 0) return { ok: false, why: "row without an issue number" };
  }
  return { ok: true, number: (parsed[0] as { number: number } | undefined)?.number };
}

export function gatePathHits(paths: string[]): string[] {
  return paths.filter((p) => {
    const parts = p.replace(/^\.\//, "").split("/").filter(Boolean);
    const last = parts.at(-1) ?? "";
    return parts.some((d) => GATE_DIRS.has(d.toLowerCase()) || GATE_ENV.test(d)) || GATE_FILE.test(last) || GATE_TOOLS.test(last) || gateToolTest(last);
  });
}

/** A git C-quoted header path (`"a\303\251.ts"`) back to its UTF-8 text; unquoted paths pass through. */
function unquoteGitPath(s: string): string {
  if (!(s.startsWith('"') && s.endsWith('"'))) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const named: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") { bytes.push(...new TextEncoder().encode(ch)); continue; }
    const nx = body[i + 1] ?? "";
    if (/[0-7]/.test(nx)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; }
    else { bytes.push(named[nx] ?? nx.charCodeAt(0)); i += 1; }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** One `git apply --numstat -z` record: added, deleted (`-` for binary), then the raw path, which may itself hold tabs or newlines. */
const NUMSTAT_RECORD = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/;

/**
 * Every path a patch changes, as git itself parses it, plus the old side of each rename
 * (`git apply --numstat` names only the new side, and moving a guard away disables it).
 * A copy's source is unchanged and is not listed. Null when git cannot read the patch.
 * Takes the patch bytes, so the caller can judge and apply one in-memory copy; a string is a path, read once.
 */
export function patchPaths(patch: string | Uint8Array, cwd: string): string[] | null {
  let bytes: Uint8Array;
  try { bytes = typeof patch === "string" ? readFileSync(patch) : patch; } catch { return null; }
  const p = spawnSync("git", ["apply", "--numstat", "-z"], { cwd, input: bytes, encoding: "utf8" });
  if (p.status !== 0) return null;
  const out = new Set<string>();
  for (const rec of (p.stdout ?? "").split("\0")) {
    if (!rec) continue;
    const m = NUMSTAT_RECORD.exec(rec);
    // A non-empty record git printed that does not parse is an unknown shape; refusing beats guessing past it.
    if (!m) return null;
    out.add(m[1]!);
  }
  for (const m of new TextDecoder().decode(bytes).matchAll(/^rename from (.+)$/gm)) out.add(unquoteGitPath(m[1]!));
  return [...out];
}

/** Review.ts exit codes: 0 pass, 1 blocked, 2 could not run. Anything else, a timeout included, counts as 2. */
const reviewCode = (c: number | null): 0 | 1 | 2 => (c === 0 || c === 1 ? c : 2);

/**
 * The default independent review (ISC-40, ISC-55). Review.ts blocks any uncommitted path,
 * and the shared install always carries peers' uncommitted work, so the patch is judged in
 * a throwaway shared clone at HEAD with the patch committed under the worker's trailer:
 * the clone's upstream is the install's HEAD, so the reviewed diff is exactly the patch, and
 * the trailer routes it to the vendor that did not write it. Setup failure is a 2.
 */
export function reviewInClone(repo: string, patch: string | Uint8Array, o: { reviewScript?: string; timeoutMs?: number; coAuthor?: string } = {}): 0 | 1 | 2 {
  // Bytes in hand are the bytes reviewed: the clone applies this buffer from stdin, never a re-read of a file.
  let bytes: Uint8Array;
  try { bytes = typeof patch === "string" ? readFileSync(patch) : patch; } catch { return 2; }
  const parent = mkdtempSync(join(tmpdir(), "achilles-review-"));
  try {
    const clone = join(parent, "repo");
    const git = (args: string[], cwd: string, input?: Uint8Array) => spawnSync("git", args, { cwd, input, encoding: "utf8" }).status === 0;
    if (!git(["clone", "--shared", "--quiet", repo, clone], parent)) return 2;
    if (!git(["apply"], clone, bytes) || !git(["add", "-A"], clone)) return 2;
    const msg = ["Achilles review candidate", ...(o.coAuthor ? ["", `Co-Authored-By: ${o.coAuthor}`] : [])].join("\n");
    if (!git(["-c", "user.name=Achilles", "-c", "user.email=achilles@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", msg], clone)) return 2;
    const r = spawnSync(process.execPath, [o.reviewScript ?? REVIEW_SCRIPT, clone, "--json"], {
      cwd: clone, encoding: "utf8", timeout: o.timeoutMs ?? LAND_REVIEW_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" },
    });
    return reviewCode(r.status);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export interface ApplyOptions {
  id: string;
  registryPath?: string;
  statePath?: string;
  installDir?: string;
  /** The loop's mode: adds the install-only, gate-path and independent-review refusals. */
  unattended?: boolean;
  /**
   * Test seam for the independent review; returns Review.ts's exit code. Defaults to reviewInClone,
   * which is handed the lander's in-memory bytes. The seam gets a private snapshot of those bytes,
   * and a snapshot that changes during the review refuses the patch.
   */
  review?: (repo: string, patch: string) => number | null;
}
export type RefusalReason = "no_entry" | "no_patch" | "not_install" | "git_failed" | "foreign_index" | "unreadable_patch" | "gate_path" | "patch_changed" | "no_longer_applies" | "dirty_files" | "review_blocked" | "review_unavailable" | "apply_failed" | "tests_failed" | "commit_failed" | "wrong_branch";
export type ApplyResult =
  | { code: 0; status: "applied"; id: string; repo: string; commit: string; files: string[]; testArgv: string[] }
  | { code: 1; status: "refused"; id: string; reason: RefusalReason; detail: string };

/**
 * The worker's co-author as `Name <email>`, or "" when the report names none. The worker report
 * line is JSON, so the structured `co_authored_by` field wins; a bare `CO-AUTHOR:` line is read
 * only up to the closing `>`, never to the end of the line (2026-10-24: every lander commit since
 * the JSON report carried `","model":...` after the email).
 */
export function coAuthorOf(report: string): string {
  const field = report.match(/"co_authored_by"\s*:\s*"(?:Co-Authored-By:\s*)?([^"<\n]+<[^>"\n]+>)"/)?.[1];
  const line = report.match(/CO-AUTHOR:\s*(?:Co-Authored-By:\s*)?([^"<\n]+<[^>"\n]+>)/)?.[1];
  return (field ?? line ?? "").trim();
}

const realDir = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p));

export async function applyPatch(o: ApplyOptions): Promise<ApplyResult> {
  const registryPath = o.registryPath ?? REGISTRY;
  const installDir = o.installDir ?? CLAUDE;
  const refuse = (reason: RefusalReason, detail: string): ApplyResult => ({ code: 1, status: "refused", id: o.id, reason, detail });
  const r = loadRegistry(registryPath);
  const e = r.entries.find((x) => x.id === o.id);
  if (!e) return refuse("no_entry", `no entry ${o.id}`);
  const { judgeTests, loadState, makeSandboxedSpawn, saveState, testCommand } = await import("./AchillesRemediate");
  const st = loadState(o.statePath);
  const ready = (st.attempts[e.id] ?? []).filter((a) => a.outcome === "patch" && a.patch && a.repo).slice(-1)[0];
  if (!ready) return refuse("no_patch", `${e.id} has no ready patch (run AchillesRemediate first)`);
  const repo = ready.repo!;
  const patch = ready.patch!;
  const isInstall = realDir(repo) === realDir(installDir);
  if (o.unattended && !isInstall) return refuse("not_install", `the loop lands LifeOS-install patches only; ${repo} is a project repo and waits for a "y"`);

  const run = (argv: string[], timeout?: number, input?: Uint8Array) => {
    const p = spawnSync(argv[0]!, argv.slice(1), { cwd: repo, input, encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 });
    return { code: p.status ?? 1, out: p.stdout ?? "", err: p.stderr ?? (p.error ? String(p.error) : "") };
  };
  const stagedNow = (): string[] | null => {
    // -z: a name holding a tab or newline comes back raw, so it compares equal to the patch's own path.
    const s = run(["git", "diff", "--cached", "--name-only", "--no-renames", "-z"]);
    return s.code === 0 ? s.out.split("\0").filter(Boolean) : null;
  };

  // The lander commits on the checked-out branch. The loop promises `main`, so it refuses any other branch (or a
  // detached HEAD); an attended apply may be on a branch on purpose, and its evidence names the real one.
  const branchNow = run(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchNow.code === 0 ? branchNow.out.trim() : "";
  if (o.unattended && branch !== "main") return refuse("wrong_branch", `the loop lands on main only; ${repo} is on ${branch ? `branch ${branch}` : "a detached HEAD"}`);

  // ISC-57: a commit takes everything in the index, so a peer's staged file would ride along.
  const foreign = stagedNow();
  if (foreign === null) return refuse("git_failed", `could not read the index of ${repo}`);
  if (foreign.length) return refuse("foreign_index", `the index already holds staged files this lander did not stage: ${foreign.slice(0, 10).join(", ")}`);

  // The patch is read once. Every later step (gate, check, review, apply, test scoping) uses
  // these bytes, so a rewrite of the file on disk after this line cannot land unjudged content.
  // The commit is held to the same bytes: the target files are rechecked after the review, and the
  // staged tree must equal HEAD plus this patch, so a peer's edit to a patched file never lands unreviewed.
  let bytes: Uint8Array;
  try { bytes = readFileSync(patch); } catch (err) { return refuse("unreadable_patch", `cannot read ${patch}: ${String(err).slice(0, 200)}`); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const paths = patchPaths(bytes, repo);
  if (!paths || paths.length === 0) return refuse("unreadable_patch", `git cannot read ${patch}`);
  if (o.unattended) {
    const hits = gatePathHits(paths);
    if (hits.length) return refuse("gate_path", `the patch touches gate paths the loop never lands: ${hits.join(", ")}`);
  }
  const check = run(["git", "apply", "--check"], undefined, bytes);
  if (check.code !== 0) return refuse("no_longer_applies", `patch no longer applies cleanly to ${repo}: ${check.err.slice(0, 300)}`);
  const dirtyRefusal = (): ApplyResult | null => {
    const dirty = run(["git", "status", "--porcelain", "--untracked-files=all", "--", ...paths]);
    if (dirty.code !== 0) return refuse("git_failed", dirty.err.slice(0, 300));
    if (dirty.out.trim()) return refuse("dirty_files", `these files carry uncommitted work in ${repo}:\n${dirty.out.trim()}`);
    return null;
  };
  const dirtyBefore = dirtyRefusal();
  if (dirtyBefore) return dirtyBefore;

  const report = ready.report && existsSync(ready.report) ? readFileSync(ready.report, "utf8") : "";
  const trailer = coAuthorOf(report);
  if (o.unattended) {
    // Starts at "could not run": any path below that fails before a reviewer answers stays unreviewed.
    let code: 0 | 1 | 2 = 2;
    let snapshotMoved = false;
    if (o.review) {
      const snapDir = mkdtempSync(join(tmpdir(), "achilles-patch-"));
      const snap = join(snapDir, basename(patch));
      try {
        try { writeFileSync(snap, bytes, { mode: 0o400 }); code = reviewCode(o.review(repo, snap)); } catch { code = 2; }
        let after = "";
        try { after = createHash("sha256").update(readFileSync(snap)).digest("hex"); } catch { after = ""; }
        snapshotMoved = after !== digest;
      } finally {
        rmSync(snapDir, { recursive: true, force: true });
      }
    } else {
      try { code = reviewCode(reviewInClone(repo, bytes, { coAuthor: trailer || undefined })); } catch { code = 2; }
    }
    if (snapshotMoved) return refuse("patch_changed", "the patch bytes the reviewer was handed changed during the review; what was reviewed is not what would land");
    if (code === 1) return refuse("review_blocked", "Review.ts blocked the patch (exit 1); it stays unapplied");
    if (code === 2) return refuse("review_unavailable", "Review.ts could not run (exit 2 or no exit); an unreviewed patch is never landed by the loop");
    // The review can take minutes: a peer who touched a target file meanwhile would have that edit applied around the hunks.
    const dirtyAfter = dirtyRefusal();
    if (dirtyAfter) return dirtyAfter;
  }

  /** The tree HEAD plus exactly these bytes gives, built in a private index so the live tree and index never enter it. */
  const expectedTree = (): string | null => {
    const dir = mkdtempSync(join(tmpdir(), "achilles-index-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
      const g = (args: string[], input?: Uint8Array) => spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8" });
      if (g(["read-tree", "HEAD"]).status !== 0 || g(["apply", "--cached"], bytes).status !== 0) return null;
      const t = g(["write-tree"]);
      return t.status === 0 && /^[0-9a-f]{40,64}$/.test(t.stdout.trim()) ? t.stdout.trim() : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const wantTree = expectedTree();
  if (!wantTree) return refuse("git_failed", `could not build the expected tree for the patch in ${repo}`);

  /**
   * The one way a failed landing backs out: take back only the patch's own hunks with `git apply -R`, so a peer's
   * edit to a patched file made during the review or tests survives. Never `checkout` or delete a whole file, which
   * would erase that edit. The index is touched only when this lander staged the paths itself (`weStaged`); before
   * that, any staged entry on a patch path is a peer's and stays. A hunk the peer overlapped is left applied and named.
   */
  const withdraw = (weStaged: boolean): string => {
    if (weStaged) run(["git", "restore", "--staged", "--", ...paths]);
    let back = run(["git", "apply", "-R"], undefined, bytes);
    // A peer line inside a hunk's context makes the strict reverse refuse; -C0 matches no context, so it still takes
    // back only the patch's own lines and leaves the peer's line where it is.
    if (back.code !== 0) back = run(["git", "apply", "-R", "-C0"], undefined, bytes);
    return back.code === 0 ? "" : ` The patch could not be reversed around the other edit and is still applied in the working tree:\n${back.err.slice(0, 300)}`;
  };

  invariant(createHash("sha256").update(bytes).digest("hex") === digest, `${e.id}: the in-memory patch changed between judging and applying`);
  // `git apply` without --reject is all-or-nothing: a failed apply wrote nothing, so there is nothing to take back.
  const ap = run(["git", "apply"], undefined, bytes);
  if (ap.code !== 0) return refuse("apply_failed", `${ap.err.slice(0, 300)}; nothing was applied.`);
  // ISC-58: the install is judged by the same scoped command the preparer used, never the whole suite.
  // ISC-90/101: judged test by test against a clean clone at HEAD, never against the live tree's own state.
  const testArgv = testCommand(repo, new TextDecoder().decode(bytes), isInstall ? repo : installDir);
  // The patch's tests are candidate code: they run confined and on a scrubbed environment, the same seam the
  // preparer uses. No sandbox means no run, so the patch is refused rather than tested unconfined.
  const judgeRun = makeSandboxedSpawn({ timeoutMs: LAND_TEST_TIMEOUT_MS, defaultCwd: repo });
  const t = judgeTests({ argv: testArgv, baselineRepo: repo, patchedDir: repo, run: judgeRun, linkDepsFrom: repo });
  if (!t.ok) return refuse("tests_failed", `${testArgv.join(" ")}: ${t.note.slice(0, 600)}; patch withdrawn.${withdraw(false)}`);

  // The index is shared: a peer may have staged during the test run. Land only our exact paths.
  const between = stagedNow();
  if (between === null || between.length) return refuse("foreign_index", `the index changed while tests ran (${(between ?? ["unreadable"]).slice(0, 10).join(", ")}); patch withdrawn.${withdraw(false)}`);
  const add = run(["git", "add", "--all", "--", ...paths]);
  const staged = stagedNow();
  const want = [...paths].sort();
  if (add.code !== 0 || staged === null || staged.slice().sort().join("\n") !== want.join("\n")) {
    return refuse("foreign_index", `the staged set is not exactly the patch (${(staged ?? ["unreadable"]).join(", ")}); patch withdrawn.${withdraw(true)}`);
  }
  // Same names is not same content: an edit to a patched file during the tests would be staged with it.
  const tree = run(["git", "write-tree"]);
  if (tree.code !== 0 || tree.out.trim() !== wantTree) {
    return refuse("patch_changed", `the staged content is not HEAD plus the reviewed patch (a patched file changed after the review); patch withdrawn.${withdraw(true)}`);
  }

  const msg = [`Achilles ${e.id}: ${e.title}`.slice(0, 72), "", `Worker-prepared patch landed via \`achilles apply${o.unattended ? " --unattended" : ""}\`; tests: ${testArgv.join(" ")} judged against HEAD, ${t.note}${o.unattended ? "; Review.ts passed" : ""}. Registry: ${e.id}.`, ...(trailer ? ["", `Co-Authored-By: ${trailer}`] : [])].join("\n");
  invariant(want.length > 0 && staged.length === want.length, `${e.id}: refusing to commit an index that is not exactly the patch`);
  const c = run(["git", "commit", "-q", "-m", msg]);
  if (c.code !== 0) return refuse("commit_failed", `${c.err.slice(0, 300)}; patch withdrawn.${withdraw(true)}`);
  const sha = run(["git", "rev-parse", "--short", "HEAD"]).out.trim();
  invariant(/^[0-9a-f]{7,}$/.test(sha), `${e.id}: commit landed but HEAD is unreadable`);
  ready.note = `applied ${sha}`;
  saveState(st, o.statePath);
  // The review and tests above take minutes, so the copy loaded at the top is stale by now: the evidence line goes
  // onto a fresh load, and a writer that lands between that load and the save makes it retry, never vanish.
  const line = `patch applied on ${branch === "main" ? "main" : branch ? `branch ${branch}` : "a detached HEAD"}: ${sha} (${paths.length} files; ${testArgv.join(" ")} judged against HEAD: ${t.note}${o.unattended ? "; Review.ts pass" : ""})`;
  updateEntry(registryPath, e.id, (fresh) => { fresh.evidence.push(line); });
  return { code: 0, status: "applied", id: e.id, repo, commit: sha, files: paths, testArgv };
}

// ---------- commands ----------

function fmt(e: AchillesEntry): string {
  const close = e.closed_at ? ` closed=${e.closed_at.slice(0, 10)}` : "";
  const issue = workIssueOf(e) ? ` #${workIssueOf(e)}` : "";
  return `${e.id} [${e.severity}/${e.category}] ${e.status}${issue} ${e.title} (${canonicalSource(e.source)}${close})`;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const json = args.includes("--json");
  const r = loadRegistry();

  switch (cmd) {
    case "add": {
      const res = addEntry(r, {
        title: flag(args, "title") ?? "",
        description: flag(args, "description"),
        category: flag(args, "category") as AchillesEntry["category"] | undefined,
        severity: flag(args, "severity") as AchillesEntry["severity"] | undefined,
        source: (flag(args, "source") ?? "manual") as AchillesEntry["source"],
        source_ref: flag(args, "source-ref"),
        dedupe_key: flag(args, "dedupe-key"),
        status: flag(args, "status") as AchillesEntry["status"] | undefined,
        affected_match: flag(args, "affected-match") === undefined ? undefined : flag(args, "affected-match") === "true",
        cves: multi(args, "cve"),
        affected: multi(args, "affected"),
        first_seen: flag(args, "first-seen"),
        closed_at: flag(args, "closed-at"),
        work_issue: issueFlag(args),
        risk_ref: flag(args, "risk-ref"),
        fix_class: flag(args, "fix-class") as FixClass | undefined,
        evidence: multi(args, "evidence"),
        links: multi(args, "link"),
        accepted_owner: flag(args, "owner"),
        accepted_until: flag(args, "until"),
      }, { riskMap: loadRiskMap(), kev: loadKev(), actor: process.env.ACHILLES_ACTOR });
      if (res.status !== "exists" && res.status !== "suppressed") saveRegistry(r);
      console.log(JSON.stringify(res));
      break;
    }
    case "list": {
      let es = r.entries;
      for (const f of ["status", "severity", "category"] as const) {
        const v = flag(args, f);
        if (v) es = es.filter((e) => e[f] === v);
      }
      const source = flag(args, "source");
      if (source) es = es.filter((e) => canonicalSource(e.source) === canonicalSource(source));
      if (json) console.log(JSON.stringify(es.map(entryView), null, 2));
      else { for (const e of es) console.log(fmt(e)); console.log(`${es.length} entries`); }
      break;
    }
    case "show": {
      const e = r.entries.find((x) => x.id === args[0]);
      if (!e) { console.error(`no entry ${args[0]}`); process.exit(1); }
      console.log(JSON.stringify(entryView(e), null, 2));
      break;
    }
    case "classify": {
      // Backfill fix_class on every entry that lacks one (or all with --all). --apply writes.
      const all = args.includes("--all"), apply = args.includes("--apply");
      const ov = loadFixClassOverrides();
      const changes: Array<{ id: string; from?: string; to: string }> = [];
      for (const e of r.entries) {
        if (e.fix_class && !all) continue;
        const to = classifyFix(e, ov);
        if (e.fix_class !== to) { changes.push({ id: e.id, from: e.fix_class, to }); if (apply) e.fix_class = to; }
      }
      if (apply && changes.length) saveRegistry(r);
      console.log(JSON.stringify({ status: apply ? "applied" : "dry_run", changes: changes.length, detail: json ? changes : undefined }, null, json ? 2 : 0));
      break;
    }
    case "update": {
      const e = r.entries.find((x) => x.id === args[0]);
      if (!e) { console.error(`no entry ${args[0]}`); process.exit(1); }
      if (flag(args, "fix-class")) e.fix_class = flag(args, "fix-class") as FixClass;
      const status = flag(args, "status");
      if (status && CLOSED_STATUSES.has(status)) {
        const evidence = multi(args, "evidence");
        try {
          const closed = closeEntry(e, { resolution: status as CloseOptions["resolution"], evidence, owner: flag(args, "owner"), until: flag(args, "until"), tune: flag(args, "tune"), actor: process.env.ACHILLES_ACTOR });
          Object.assign(e, closed);
        } catch (err) { console.error(`update refused: ${String((err as Error).message ?? err)}`); process.exit(1); }
        args.splice(0, args.length, ...args.filter((_, i, a) => a[i] !== "--evidence" && a[i - 1] !== "--evidence"));
      } else if (status) e.status = status as AchillesEntry["status"];
      if (flag(args, "severity")) e.severity = flag(args, "severity") as AchillesEntry["severity"];
      if (issueFlag(args) !== undefined) e.work_issue = issueFlag(args);
      if (flag(args, "risk-ref")) { e.risk_ref = flag(args, "risk-ref"); e.risk_basis = "finder"; } // a hand-set link is stated, not mapped
      e.evidence.push(...multi(args, "evidence"));
      e.links.push(...multi(args, "link"));
      if (CLOSED_STATUSES.has(e.status) && !e.closed_at) e.closed_at = new Date().toISOString();
      saveRegistry(r);
      console.log(JSON.stringify({ status: "updated", id: e.id }));
      break;
    }
    case "close": {
      const idx = r.entries.findIndex((x) => x.id === args[0]);
      if (idx < 0) { console.error(`no entry ${args[0]}`); process.exit(1); }
      const evidence = multi(args, "evidence");
      if (evidence.length === 0) { console.error("close requires --evidence (a probe ref, ISA link, or commit)"); process.exit(1); }
      const resolution = (flag(args, "resolution") ?? "remediated") as CloseOptions["resolution"];
      // --ref: a finder clearing its own ref. A merged entry stays open until every finder that reported it has cleared it.
      const ref = flag(args, "ref");
      if (ref && (r.entries[idx]!.linked_refs ?? []).length) {
        invariant(findBySourceRef(r, ref)?.id === r.entries[idx]!.id, `close: ref ${ref} does not belong to ${r.entries[idx]!.id}`);
        const outcome = clearRef(r, ref, evidence.join(" · "), new Date().toISOString(), resolution);
        if (outcome !== "unchanged" && outcome !== "none") saveRegistry(r);
        if (outcome !== "closed") { console.log(JSON.stringify({ status: outcome, id: r.entries[idx]!.id })); break; }
      } else {
        try {
          r.entries[idx] = closeEntry(r.entries[idx]!, { resolution, evidence, owner: flag(args, "owner"), until: flag(args, "until"), tune: flag(args, "tune"), actor: process.env.ACHILLES_ACTOR });
        } catch (err) { console.error(`close refused: ${String((err as Error).message ?? err)}`); process.exit(1); }
      }
      const e = r.entries[idx]!;
      saveRegistry(r);
      // Same-motion ticket close (ISA ISC-10): a closed entry closes its work ticket
      // with the evidence as the closing comment. The comment goes only to a repo the
      // work-config loader has verified private (same gate as `ticket`); an
      // unverified or public repo is refused and the local close still stands.
      let issueClosed = false;
      let closeRefused: string | null = null;
      if (e.work_issue) {
        let wc: { repo: string | null; reason?: string };
        try {
          const { loadWorkConfig } = await import(join(CLAUDE, "hooks/lib/work-config.ts"));
          wc = loadWorkConfig() as { repo: string | null; reason?: string };
        } catch (err) {
          wc = { repo: null, reason: `work-config load failed: ${String(err).slice(0, 120)}` };
        }
        if (!wc.repo) {
          closeRefused = `work repo not verified private — ${wc.reason ?? "work config disabled"}`;
          console.error(`work-repo issue close refused: ${closeRefused}`);
        } else {
          const p = Bun.spawnSync(["gh", "issue", "close", String(e.work_issue), "--repo", wc.repo, "--comment", `Closed by Achilles ${e.id} (${e.status}). Evidence: ${evidence.join(" · ")}`], { stdout: "pipe", stderr: "pipe" });
          issueClosed = p.exitCode === 0;
          if (!issueClosed) console.error(`work-repo issue close failed: ${p.stderr.toString().slice(0, 160)}`);
        }
      }
      console.log(JSON.stringify({ status: "closed", id: e.id, resolution: e.status, work_issue: e.work_issue ?? null, work_issue_closed: issueClosed, ...(closeRefused ? { work_issue_close_refused: closeRefused } : {}) }));
      break;
    }
    case "reopen": {
      // The condition a closed entry described is back (a scanner check failing
      // again, a question failing again). `accepted` is a human risk decision and
      // never reopens from here — disagree at the source (tombstone in the
      // scanner) rather than fight it. The old ticket stays closed as history;
      // `ticket` opens a fresh one.
      const e = r.entries.find((x) => x.id === args[0]);
      if (!e) { console.error(`no entry ${args[0]}`); process.exit(1); }
      const evidence = multi(args, "evidence");
      if (evidence.length === 0) { console.error("reopen requires --evidence (what showed the condition is back)"); process.exit(1); }
      if (!CLOSED_STATUSES.has(e.status)) { console.error(`reopen: ${e.id} is ${e.status}, not closed`); process.exit(1); }
      if (e.status === "accepted") { console.error(`reopen: ${e.id} is accepted — a human risk decision; revisit it explicitly with update --status open`); process.exit(1); }
      if (isTuned(e)) { console.error(`reopen: ${e.id} is a false positive whose finder was tuned — revisit it explicitly with update --status open`); process.exit(1); }
      e.status = "open";
      delete e.closed_at;
      delete e.work_issue;
      e.cleared_refs = [];
      e.held_refs = [];
      e.evidence.push(...evidence);
      saveRegistry(r);
      console.log(JSON.stringify({ status: "reopened", id: e.id }));
      break;
    }
    case "ticket": {
      const e = r.entries.find((x) => x.id === args[0]);
      if (!e) { console.error(`no entry ${args[0]}`); process.exit(1); }
      if (!(e.status === "open" || e.status === "in_progress")) { console.error(`ticket: ${e.id} is ${e.status} — only open entries get tickets`); process.exit(1); }
      if (e.work_issue) { console.log(JSON.stringify({ status: "exists", id: e.id, work_issue: e.work_issue })); break; }
      const { loadWorkConfig } = await import(join(CLAUDE, "hooks/lib/work-config.ts"));
      const wc = loadWorkConfig() as { repo: string | null; agentLabel: string; reason?: string };
      if (!wc.repo) { console.error(`ticket: no work repo bound — ${wc.reason ?? "work config disabled"}`); process.exit(1); }
      const run = (argv: string[]) => {
        const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
        return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
      };
      // Reuse an OPEN issue that already carries this entry (re-run after a
      // partial failure); a closed one is history and a reopened entry earns a new ticket.
      let num: number | undefined;
      let created = false;
      const search = run(["gh", "issue", "list", "--repo", wc.repo, "--search", `"${e.id}" in:body`, "--state", "open", "--json", "number", "--limit", "1"]);
      // "No ticket exists" is only concluded from a search that succeeded and returned a schema-valid list.
      // A failed or unparseable search says nothing, and creating on it opens a duplicate (fail closed).
      const found = parseTicketSearch(search.code, search.out);
      if (!found.ok) { console.error(`ticket: could not search for an existing issue (${found.why}) — not creating a possible duplicate`); process.exit(1); }
      num = found.number;
      if (!num) {
        const c = run(["gh", "issue", "create", "--repo", wc.repo, "--title", ticketTitle(e), "--label", ticketLabels(e, wc.agentLabel).join(","), "--body", ticketBody(e)]);
        num = Number(c.out.match(/\/issues\/(\d+)/)?.[1]) || undefined;
        if (c.code !== 0 || !num) { console.error(`ticket: issue create failed — ${(c.err || c.out).slice(0, 200)}`); process.exit(1); }
        created = true;
      }
      e.work_issue = num;
      saveRegistry(r);
      console.log(JSON.stringify({ status: "ticketed", id: e.id, work_issue: num, created }));
      break;
    }
    case "apply": {
      // Land a worker-prepared patch. --unattended is the loop: the lander itself refuses gate paths,
      // project repos, and any patch whose independent review did not pass. Never deploys.
      const res = await applyPatch({ id: args[0] ?? "", unattended: args.includes("--unattended") });
      if (res.code !== 0) { console.error(`apply: refused (${res.reason}) — ${res.detail}`); console.log(JSON.stringify(res)); process.exit(1); }
      console.log(JSON.stringify({ ...res, next: "run the repo's gated deploy, then close the entry with the live probe" }));
      break;
    }
    case "sync-scanner": {
      const { runSync } = await import("./AchillesSync");
      process.exit(await runSync({ dryRun: args.includes("--dry-run"), json }));
    }
    case "backfill-risk": {
      // Stamp mapped risk_refs on entries with none. Dry run by default; --apply writes, after a snapshot commit and the principal's yes (ISA ISC-48).
      const m = loadRiskMap();
      if (!isRatified(m)) { console.error("backfill-risk: the risk map is missing or not ratified (ratified_by, ratified_at) — nothing stamped"); process.exit(1); }
      const { registry, changes } = backfillRiskRefs(r, m);
      if (args.includes("--apply") && changes.length) {
        const dirty = spawnSync("git", ["status", "--porcelain", "--", basename(REGISTRY)], { cwd: dirname(realpathSync(REGISTRY)), encoding: "utf8" });
        if (dirty.status !== 0 || dirty.stdout.trim()) { console.error("backfill-risk --apply: commit a pre-backfill snapshot of the registry first (its git status is not clean)"); process.exit(1); }
        saveRegistry(registry);
      }
      console.log(JSON.stringify({ status: args.includes("--apply") ? "applied" : "dry_run", changes: changes.length, detail: json ? changes : undefined }, null, json ? 2 : 0));
      break;
    }
    case "relabel": {
      const { registry, changes } = relabelSources(r);
      if (args.includes("--apply") && changes.length) saveRegistry(registry);
      console.log(JSON.stringify({ status: args.includes("--apply") ? "applied" : "dry_run", changes: changes.length, detail: json ? changes : undefined }, null, json ? 2 : 0));
      break;
    }
    case "expire-acceptances": {
      const ids = expireAcceptances(r);
      if (ids.length && !args.includes("--dry-run")) saveRegistry(r);
      console.log(JSON.stringify({ status: args.includes("--dry-run") ? "dry_run" : "done", reopened: ids }));
      break;
    }
    case "unmapped": {
      // Open entries with no risk above them: the orphans the morning ping lists.
      // Technical entries only by default: a workout or spend question is not a security weakness and has no estate risk. --all lists every category.
      const es = r.entries.filter((e) => (e.status === "open" || e.status === "in_progress") && !e.risk_ref && (args.includes("--all") || e.category === "technical"));
      if (args.includes("--count")) console.log(String(es.length));
      else if (json) console.log(JSON.stringify(es.map(entryView), null, 2));
      else { for (const e of es) console.log(fmt(e)); console.log(`${es.length} unmapped`); }
      break;
    }
    case "stats": {
      const open = r.entries.filter((e) => e.status === "open" || e.status === "in_progress");
      const s = {
        total: r.entries.length,
        open: open.length,
        open_critical: open.filter((e) => e.severity === "critical").length,
        open_high: open.filter((e) => e.severity === "high").length,
        informational: r.entries.filter((e) => e.status === "informational").length,
        by_category: Object.fromEntries(CATEGORIES.map((c) => [c, r.entries.filter((e) => e.category === c).length])),
        by_status: Object.fromEntries(STATUSES.map((c) => [c, r.entries.filter((e) => e.status === c).length])),
        by_fix_class: Object.fromEntries([...FIX_CLASSES, "unclassified"].map((c) => [c, open.filter((e) => (e.fix_class ?? "unclassified") === c).length])),
        time_to_close: timeToClose(r.entries),
        updated: r.updated,
      };
      console.log(JSON.stringify(s, null, json ? 2 : 0));
      break;
    }
    case "open-crit": {
      const es = r.entries.filter((e) => (e.status === "open" || e.status === "in_progress") && (e.severity === "critical" || e.severity === "high"));
      console.log(JSON.stringify(es, null, 2));
      break;
    }
    case "gen-stack": {
      const out = genStack();
      console.log(JSON.stringify({ status: "written", path: STACK, terms: out.terms.length, sources: out.sources }));
      break;
    }
    default:
      console.log("achilles: add | list | show <id> | apply <id> [--unattended] | classify [--all] [--apply] | update <id> [--fix-class C] | close <id> --evidence E | reopen <id> --evidence E | ticket <id> | sync-scanner [--dry-run] | relabel [--apply] | backfill-risk [--apply] | expire-acceptances [--dry-run] | unmapped [--count] [--all] | stats | open-crit | gen-stack");
  }
}
