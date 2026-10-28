/**
 * STATVS core — customer exclusion by provenance (statvs-full-migration ISA ISC-2, ISC-50,
 * ISC-68, ISC-69).
 *
 * Customer information never enters the record. Whether a row may enter is decided by where
 * it came from, never by a class label:
 *   - a Claude Code session whose cwd (or ~/.claude/projects folder) is customer consulting
 *     work is withheld whole;
 *   - a row or transcript line naming a tenant of the multi-tenant app other than the home tenant (the
 *     principal's own company) is withheld;
 *   - a line naming a consulting project path is withheld (config switch, on by default);
 *   - anything else is kept.
 * Object keys are scanned like values, since data keyed by a tenant or a path names it.
 * A session withheld whole stays withheld for every row of it, before or after the row
 * that revealed it (decideInSession, decideBatch over a WithheldSessions store).
 * A withheld source leaves one `withheld` marker row carrying its source, a count and a
 * reason code, and nothing from the withheld rows themselves.
 *
 * The patterns, the home tenant and the evidence for both live in the private USER config
 * (USER/STATVS/provenance.json); this file holds the rules only. Pure: no node:fs, so the
 * Worker intake can rescan with the same code the shipper and importer run.
 *
 * @version 0.1.0
 */

import { finalizeRow, type CoreRow, type TsBasis } from "./row.ts";

class InvariantViolation extends Error {
  constructor(message: string) { super(`INVARIANT VIOLATION: ${message}`); this.name = "InvariantViolation"; }
}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

/** Why something was withheld. Codes only: a reason never names the tenant or the path it matched. */
export type WithholdReason = "consulting_project" | "consulting_path" | "other_tenant" | "uninspectable" | "customer_class";
export const WITHHOLD_REASONS: readonly WithholdReason[] = ["consulting_project", "consulting_path", "other_tenant", "uninspectable", "customer_class"] as const;

export type Decision =
  | { action: "keep" }
  /** scope "session": the whole session or source goes, not just this line. */
  | { action: "withhold"; reason: WithholdReason; scope: "session" | "row" };

export interface ProvenanceConfig {
  consulting: {
    /** Path patterns: leading ~/ is any home, * stays inside a segment, ** crosses segments; a pattern covers everything under it. */
    cwd_patterns: string[];
    /** Withhold a line whose text names a consulting path, even in a non-consulting session. */
    withhold_lines_naming_paths: boolean;
  };
  /** Optional: an install with no multi-tenant app omits it, and then no tenant rule runs. */
  vector?: {
    home_tenant_id: string;
    home_tenant_slug: string;
    tenant_id_prefix: string;
    /** Regex source for a tenant slug (Vector: [a-z][a-z0-9]{1,15}). */
    slug_pattern: string;
    /** Rows from these apps (row.app or row.source) are Vector rows, so their tenant fields count even without the prefix. */
    apps: string[];
    /** Field names that hold a tenant id or slug, at any depth. */
    row_fields: string[];
    /** Other tenants known by slug; always withheld. */
    known_other_tenants: string[];
    /** <prefix><word> tokens that are Vector table or column names, not tenants. */
    schema_identifiers: string[];
    /** Synthetic tenants from that app's own tests; not withheld when they appear in text. */
    fixture_slugs: string[];
  };
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Validate parsed provenance.json. Throws an Error naming the first bad field; unknown fields (_doc, evidence) are ignored. */
export function parseProvenanceConfig(raw: unknown): ProvenanceConfig {
  const fail = (msg: string): never => { throw new Error(`provenance config: ${msg}`); };
  if (!raw || typeof raw !== "object") fail("not an object");
  const r = raw as Record<string, any>;
  const c = r.consulting, v = r.vector;
  if (!c || typeof c !== "object") fail("consulting missing");
  if (v !== undefined && (!v || typeof v !== "object")) fail("vector must be an object when present");
  if (!strings(c.cwd_patterns)) fail("consulting.cwd_patterns must be a string array");
  for (const p of c.cwd_patterns as string[]) if (!p.startsWith("/") && !p.startsWith("~/")) fail(`pattern ${p} must start with / or ~/`);
  const consulting = { cwd_patterns: [...c.cwd_patterns], withhold_lines_naming_paths: c.withhold_lines_naming_paths !== false };
  if (v === undefined) return { consulting };
  for (const k of ["home_tenant_id", "home_tenant_slug", "tenant_id_prefix", "slug_pattern"]) if (typeof v[k] !== "string" || !v[k]) fail(`vector.${k} must be a non-empty string`);
  for (const k of ["apps", "row_fields", "known_other_tenants", "schema_identifiers", "fixture_slugs"]) if (!strings(v[k])) fail(`vector.${k} must be a string array`);
  let slugRe: RegExp;
  try { slugRe = new RegExp(`^(?:${v.slug_pattern})$`); } catch { return fail("vector.slug_pattern is not a regex"); }
  if (!slugRe.test(v.home_tenant_slug)) fail("vector.home_tenant_slug does not match slug_pattern");
  if (v.home_tenant_id !== v.tenant_id_prefix + v.home_tenant_slug) fail("vector.home_tenant_id must be tenant_id_prefix + home_tenant_slug");
  if ((v.known_other_tenants as string[]).includes(v.home_tenant_slug)) fail("the home tenant cannot be a known other tenant");
  return {
    consulting,
    vector: {
      home_tenant_id: v.home_tenant_id, home_tenant_slug: v.home_tenant_slug, tenant_id_prefix: v.tenant_id_prefix, slug_pattern: v.slug_pattern,
      apps: [...v.apps], row_fields: [...v.row_fields], known_other_tenants: [...v.known_other_tenants],
      schema_identifiers: [...v.schema_identifiers], fixture_slugs: [...v.fixture_slugs],
    },
  };
}

// ── pattern compilation ─────────────────────────────────────────────────────────────────

interface Compiled {
  cwd: RegExp[];
  folder: RegExp[];
  text: RegExp[];
  tenantToken: RegExp;
  rowFields: Set<string>;
  apps: Set<string>;
  known: Set<string>;
  benign: Set<string>;
}

const cache = new WeakMap<ProvenanceConfig, Compiled>();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Regex source for a path pattern; `seg` is what one segment may hold, `head` replaces a leading ~. */
function pathSource(pattern: string, head: string, seg: string, literal: (s: string) => string): string {
  const tilde = pattern.startsWith("~/");
  const rest = tilde ? pattern.slice(1) : pattern;
  const body = rest.replace(/\/+$/, "").split(/(\*\*|\*)/).map((part) => (part === "**" ? ".*" : part === "*" ? `${seg}*` : literal(part))).join("");
  return (tilde ? head : "") + body;
}

function compile(config: ProvenanceConfig): Compiled {
  const hit = cache.get(config);
  if (hit) return hit;
  const v = config.vector;
  const pats = config.consulting.cwd_patterns;
  // Claude Code names a project folder by its cwd with every non-alphanumeric character turned into "-".
  const encode = (s: string) => esc(s.replace(/[^A-Za-z0-9]/g, "-"));
  // Text scanning runs over every string of every transcript line, so all patterns share one
  // regex, one pass per string. A ~/ pattern matches in text by what follows the home, with
  // any prefix: a line names the folder as /Users/<name>/Projects/x, $HOME/Projects/x,
  // ../../Projects/x or through a symlinked home folder, and each of those is the same folder.
  const textSeg = "[^/\\s\"'`]";
  const home = pats.filter((p) => p.startsWith("~/")).map((p) => pathSource(p.slice(2), "", textSeg, esc));
  const abs = pats.filter((p) => !p.startsWith("~/")).map((p) => pathSource(p, "", textSeg, esc));
  const alts = [...(home.length ? [`(?<![A-Za-z0-9_.-])(?:${home.join("|")})`] : []), ...(abs.length ? [`(?<![A-Za-z0-9._~/-])(?:${abs.join("|")})`] : [])];
  const compiled: Compiled = {
    cwd: pats.map((p) => new RegExp(`^${pathSource(p, "(?:/Users/[^/]+|/home/[^/]+|/root|~)", "[^/]", esc)}(?:/.*)?$`, "i")),
    folder: pats.map((p) => new RegExp(`^${pathSource(p, "(?:-(?:Users|home)-[A-Za-z0-9-]+?|-root)", "[A-Za-z0-9-]", encode)}(?:-.*)?$`, "i")),
    text: alts.length ? [new RegExp(`(?:${alts.join("|")})(?![A-Za-z0-9._-])`, "i")] : [],
    // No vector section: the token never matches, and the other sets are empty.
    tenantToken: v ? new RegExp(`(?<![A-Za-z0-9_])${esc(v.tenant_id_prefix)}(${v.slug_pattern})(?![A-Za-z0-9_])`, "g") : /(?!)/g,
    rowFields: new Set(v?.row_fields ?? []),
    apps: new Set((v?.apps ?? []).map((a) => a.toLowerCase())),
    known: new Set(v?.known_other_tenants ?? []),
    benign: new Set([...(v?.schema_identifiers ?? []), ...(v?.fixture_slugs ?? [])]),
  };
  cache.set(config, compiled);
  return compiled;
}

// ── the rules ───────────────────────────────────────────────────────────────────────────

/** Is this cwd customer consulting work? */
export function isConsultingCwd(cwd: string, config: ProvenanceConfig): boolean {
  const path = cwd.replace(/\/+$/, "") || "/";
  return compile(config).cwd.some((re) => re.test(path));
}

/** Is this ~/.claude/projects folder name (an encoded cwd) customer consulting work? Encoding is lossy, so this errs toward withholding. */
export function isConsultingFolder(folder: string, config: ProvenanceConfig): boolean {
  const name = folder.replace(/\/+$/, "").split("/").pop() ?? "";
  return compile(config).folder.some((re) => re.test(name));
}

/** Deepest nesting inspected; anything deeper is withheld as uninspectable, never passed unread. */
export const MAX_DEPTH = 64;
/** Most strings and keys inspected in one input, and most characters across them; past either, the input is withheld. */
export const MAX_STRINGS = 200_000;
export const MAX_CHARS = 32 * 1024 * 1024;

/** What one full walk of an input saw: every string and key, every key alone, and every string held under a tenant field. */
interface Inspection { texts: string[]; keys: string[]; tenantValues: string[] }

/**
 * Walk an input once and collect everything the rules read. Returns null when the walk could not see all of it:
 * nesting past MAX_DEPTH, more than MAX_STRINGS strings or MAX_CHARS characters, or a value JSON cannot hold
 * (a class instance, a Map, a function, a symbol, a bigint), whose content Object.entries would silently skip.
 * Object keys are content whenever data is keyed by them ({ "tenant_x": {...} }, a map of file paths), so they are
 * scanned like values. Everything beneath a tenant field, at any depth and of any shape, counts as a tenant value.
 */
function inspect(root: unknown, tenantFields: Set<string>): Inspection | null {
  const out: Inspection = { texts: [], keys: [], tenantValues: [] };
  let chars = 0;
  const take = (s: string, underTenant: boolean): boolean => {
    out.texts.push(s);
    if (underTenant) out.tenantValues.push(s);
    chars += s.length;
    return out.texts.length <= MAX_STRINGS && chars <= MAX_CHARS;
  };
  const stack: Array<[unknown, number, boolean]> = [[root, 0, false]];
  while (stack.length) {
    const [node, depth, underTenant] = stack.pop()!;
    if (typeof node === "string") { if (!take(node, underTenant)) return null; continue; }
    if (node === null || node === undefined || typeof node === "boolean") continue;
    if (typeof node === "number") { if (!Number.isFinite(node)) return null; continue; }
    if (typeof node !== "object") return null; // function, symbol, bigint: not JSON, not inspectable
    if (depth >= MAX_DEPTH) return null;
    if (Array.isArray(node)) { for (const child of node) stack.push([child, depth + 1, underTenant]); continue; }
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return null;
    for (const k of Object.keys(node)) {
      out.keys.push(k);
      if (!take(k, false)) return null; // a key under a tenant field ({ tenant: { id: ... } }) is a field name, not a tenant
      stack.push([(node as Record<string, unknown>)[k], depth + 1, underTenant || tenantFields.has(k)]);
    }
  }
  return out;
}

/** Does the row name an app tenant other than the home tenant, in a tenant field or as a prefixed token in its text? */
function namesOtherTenant(obj: unknown, seen: Inspection, config: ProvenanceConfig): boolean {
  const v = config.vector;
  if (!v) return false; // no multi-tenant app configured: there is no tenant to name
  const c = compile(config);
  const texts = seen.texts;
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const top = obj as Record<string, unknown>;
    const fromVector = [top.app, top.source].some((a) => typeof a === "string" && c.apps.has(a.toLowerCase()));
    for (const raw of seen.tenantValues) {
      const value = raw.trim().toLowerCase();
      const prefixed = value.startsWith(v.tenant_id_prefix);
      if (!prefixed && !fromVector) continue; // a tenant field on a non-Vector row is some other app's notion of tenant
      const slug = prefixed ? value.slice(v.tenant_id_prefix.length) : value;
      if (slug && slug !== v.home_tenant_slug) return true;
    }
    // A Vector row keyed by a known other tenant's bare slug ({ by_tenant: { <slug>: {...} } }) names that tenant.
    if (fromVector && seen.keys.some((k) => c.known.has(k.trim().toLowerCase()))) return true;
  }
  for (const text of texts) {
    if (!text.includes(v.tenant_id_prefix)) continue;
    for (const m of text.matchAll(c.tenantToken)) {
      const slug = m[1]!;
      if (slug === v.home_tenant_slug) continue;
      if (c.known.has(slug)) return true;
      if (c.benign.has(slug)) continue;
      return true; // an unknown tenant is a tenant until shown otherwise
    }
  }
  return false;
}

/**
 * Decide whether a row, a transcript line or a session may enter the record. Input is a
 * parsed object (a CoreRow, a v1 row, a raw transcript line, or `{ cwd }` / `{ project_folder }`
 * for a whole session) or a raw string line, which is parsed when it is JSON.
 */
export function decide(input: unknown, config: ProvenanceConfig): Decision {
  const uninspectable: Decision = { action: "withhold", reason: "uninspectable", scope: "row" };
  let obj: unknown = input;
  if (typeof input === "string") {
    if (input.length > MAX_CHARS) return uninspectable;
    try { obj = JSON.parse(input); } catch {
      // A line that opens as JSON but does not parse cannot have its fields read (a tenant field's bare slug, a cwd), so
      // it is withheld; any other line is plain text and is scanned whole below.
      if (/^\s*[{[]/.test(input)) return uninspectable;
      obj = input;
    }
  }
  const c = compile(config);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const top = obj as Record<string, unknown>;
    // A cwd or project folder that is present but not a string cannot be checked against the consulting patterns.
    const folder = top.project_folder ?? top.projectFolder;
    for (const f of [top.cwd, folder]) if (f !== undefined && f !== null && typeof f !== "string") return uninspectable;
    if (typeof top.cwd === "string" && isConsultingCwd(top.cwd, config)) return { action: "withhold", reason: "consulting_project", scope: "session" };
    if (typeof folder === "string" && isConsultingFolder(folder, config)) return { action: "withhold", reason: "consulting_project", scope: "session" };
  }
  const seen = inspect(obj, c.rowFields);
  if (!seen) return uninspectable;
  const texts = seen.texts;
  if (namesOtherTenant(obj, seen, config)) return { action: "withhold", reason: "other_tenant", scope: "row" };
  if (config.consulting.withhold_lines_naming_paths && texts.some((t) => c.text.some((re) => re.test(t)))) {
    return { action: "withhold", reason: "consulting_path", scope: "row" };
  }
  return { action: "keep" };
}

// ── whole-session withholding ───────────────────────────────────────────────────────────

/**
 * The sessions already withheld whole, and why. A `Map<string, WithholdReason>` satisfies
 * it; the intake backs it with an in-memory Map that lasts one request (one batch), and the
 * shipper with its cursor, which carries the decision between runs. A session is never
 * taken back out.
 */
export interface WithheldSessions {
  get(session: string): WithholdReason | undefined;
  set(session: string, reason: WithholdReason): unknown;
}

/** The session a row or transcript line belongs to (`session`, `sessionId` or `session_id`), if it names one. */
export function sessionOf(input: unknown): string | undefined {
  let obj: unknown = input;
  if (typeof input === "string") {
    try { obj = JSON.parse(input); } catch { return undefined; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const top = obj as Record<string, unknown>;
  for (const k of ["session", "sessionId", "session_id"]) {
    const s = top[k];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return undefined;
}

/** Record a session as withheld whole. Never downgrades: a session already withheld keeps its first reason. */
function markSession(sessions: WithheldSessions, session: string, reason: WithholdReason): void {
  invariant(session.length > 0 && session.length <= 200, "a withheld session id is a non-empty opaque id of at most 200 characters");
  invariant(WITHHOLD_REASONS.includes(reason), `unknown withhold reason ${String(reason)}`);
  if (sessions.get(session) === undefined) sessions.set(session, reason);
}

/**
 * Decide one row with memory of its session: a row from a session already withheld whole is
 * withheld whatever it says, and a row that withholds its session marks that session for
 * every row after it.
 */
export function decideInSession(input: unknown, config: ProvenanceConfig, sessions: WithheldSessions): Decision {
  const session = sessionOf(input);
  const prior = session ? sessions.get(session) : undefined;
  if (prior) return { action: "withhold", reason: prior, scope: "session" };
  const d = decide(input, config);
  if (d.action === "withhold" && d.scope === "session" && session) markSession(sessions, session, d.reason);
  return d;
}

/**
 * Decide a batch with memory of sessions. A session withheld by any row in the batch is
 * withheld for every row of it in the batch, earlier rows included, and stays recorded in
 * `sessions` for later batches. Returns one decision per input, in order.
 */
export function decideBatch(inputs: readonly unknown[], config: ProvenanceConfig, sessions: WithheldSessions): Decision[] {
  const first = inputs.map((input) => decideInSession(input, config, sessions));
  return first.map((d, i) => {
    if (d.action === "withhold") return d;
    const session = sessionOf(inputs[i]);
    const reason = session ? sessions.get(session) : undefined;
    return reason ? { action: "withhold", reason, scope: "session" } : d;
  });
}

// ── the marker ──────────────────────────────────────────────────────────────────────────

/** A marker's source is a store name and an opaque id (`transcript:<session uuid>`, `vigil:vector`): no path, no spaces, no free text. */
const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,159}$/;

/** Where the marker row goes: the writer chain and seq the caller assigns, and when the withholding happened. */
export interface MarkerPlace {
  writer: string;
  chain: string;
  seq: number;
  ts: string;
  ts_basis?: TsBasis;
}

/**
 * The row that records a withholding: stream "statvs", kind "withheld", data
 * { source, count, reason }. It takes no part of the withheld rows, so it cannot carry
 * their content; its time is when the withholding happened.
 */
export async function withheldMarker(source: string, count: number, reason: WithholdReason, at: MarkerPlace): Promise<CoreRow> {
  invariant(SOURCE_RE.test(source), `a withheld marker's source must be a store name and opaque id, never a path or text (got ${JSON.stringify(source.slice(0, 40))})`);
  invariant(Number.isInteger(count) && count >= 1, `a withheld marker counts at least one withheld item (got ${String(count)})`);
  invariant(WITHHOLD_REASONS.includes(reason), `unknown withhold reason ${String(reason)}`);
  return finalizeRow({
    chain: at.chain,
    seq: at.seq,
    ts: at.ts,
    ts_basis: at.ts_basis ?? "stated",
    writer: at.writer,
    stream: "statvs",
    kind: "withheld",
    data: { source, count, reason },
  });
}
