/**
 * The RES writer (CENSVS ISA F6, ISC-33..ISC-35): one function per op, each a
 * single STATVS append() with `subject` and `op` set, so every rule of the record
 * applies to every change.
 *
 *   mint(kind, natural?)              a new id, never reissued (ids.ts)
 *   create(id, init, opts)            record kinds: brings a RES into being
 *   set(id, patch, opts)              record kinds: title, class (raise only), parent, data fields, aliases
 *   move(id, to, opts)                record kinds: one step on the kind's move map
 *   link(id, rel, to, opts)           record kinds: adds a typed link
 *   unlink(id, rel, to, opts)         record kinds: removes one
 *   observe(id, obs, opts)            git and observed kinds: what the outside authority shows now
 *   retire(id, opts)                  record kinds: to the kind's first state in the gone bucket
 *
 * Authority decides the ops. A `record` kind's truth is its rows, so it takes
 * every op but observe. A `git` or `observed` kind's truth lives elsewhere, so the
 * record observes it and may link it (a relation is the record's own fact);
 * create, set, move and retire on one are refused, which keeps git prose and
 * outside state out of hand edits. This matches what the `things` fold applies.
 *
 * move() asks GENERA first. A move off the kind's map, or a principal-only move
 * (GENERA `principalMoves`, such as proposal proposed>accepted) by a writer that
 * is not the principal's channel, is refused: nothing is written to the RES, one
 * row goes to the `move` stream with { gate, kind, verdict: "refuse", reason,
 * subject, from, to }, the shape hooks/lib/gate-run.ts writes plus the three RES
 * fields, and move() returns { ok: false, verdict: "refuse" }. STATVS still
 * rules on nothing: the refusal is this library's, recorded like any other.
 *
 * A principal-only move needs two things (ISC-61). The writer names the
 * principal's channel (`principal:terminal`), so the row itself shows who made
 * it. And the process is the principal's own interactive session, which
 * principalPresent() reads from where the process runs (channel, attended
 * session or terminal, no delegate marker), never from an argument: a writer
 * name alone, from a headless loop, a scheduled job or a subagent, is refused.
 * principalWriter() gives callers the writer to pass when the principal is here.
 *
 * Row payloads (row.data), which the `things` fold reads:
 *   create   { title, state, class?, parent?, links?, aliases?, data? }
 *   set      { title?, class?, parent?, aliases?, data?, unset? }   data merges; unset lists removed fields
 *   move     { from, to, reason? }
 *   link     { rel, to }       unlink { rel, to }
 *   observe  { state?, title?, data?, unset?, complete? }
 * A null in a caller's data means "remove this field" and travels as unset, the
 * things fold's word for it. `aliases` is read by ids.ts (mint and resolveId).
 *   retire   { from, to, reason? }
 *
 * Every function returns { ok: true, id, row } or { ok: false, refused } (or the
 * record's own { ok: false, spooled: true, reason } when the append was spooled).
 * Only an InvariantViolation, an impossible state, escapes.
 *
 * This file is a library and has no command line. The CENSVS command line is
 * Censvs.ts (`bun LIFEOS/CENSVS/Censvs.ts …`), a name no filesystem folds into
 * this one.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.0.0
 */
import { getNotificationChannel } from "../../hooks/lib/notification-channel";
import { isSubagentContext } from "../../hooks/lib/subagent";
import { append, streamDef } from "../STATVS/index";
import type { PrivacyClass, StatvsInput, StatvsRow } from "../STATVS/index";
import { invariant } from "../TOOLS/Invariant";
import { GENERA, OPS, bucketOf, canMove, canonicalState, needsPrincipal, parseSubject, retireState, validSubject } from "./genera";
import type { KindClass, Op } from "./genera";
import { RES_STREAM, addFoldStream, aliasProblem, recordFold } from "./ids";
import type { FoldedRes, ResFold } from "./ids";
import type { Link } from "./sources/common";

export { mint, resolveId, aliasConflicts, recordFold, resetResFold, RES_STREAM } from "./ids";
export type { MintResult, FoldedRes, ResFold } from "./ids";

/** The move-stream gate name for refusals this library writes. */
export const MOVE_GATE = "censvs.move";
/** Writer prefix that marks the principal's own channel. */
export const PRINCIPAL_WRITER_PREFIX = "principal:";
/** A RES's data is capped; anything heavier goes by pointer (object hash, git path, URL). */
export const DATA_MAX_BYTES = 64 * 1024;

const REL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const CLASS_RANK: Record<string, number> = { public: 0, system: 1, personal: 2 };

export interface WriteOpts {
  /** Who is writing: `tool:Upgrades`, `hook:ISASync`, `principal:relay`. Required. */
  writer: string;
  /** Defaults to `res`. A stream other than `res` must be registered in STATVS. */
  stream?: string;
  /** Row privacy class; never below the stream's or the RES's class. */
  class?: PrivacyClass;
  session?: string;
  ts?: string;
}

export type ResResult =
  | { ok: true; id: string; row: StatvsRow }
  | { ok: false; refused: string; id?: string; verdict?: "refuse" }
  | { ok: false; spooled: true; reason: string };

export interface CreateInit {
  title: string;
  state?: string;
  class?: KindClass;
  parent?: string;
  links?: Link[];
  aliases?: string[];
  data?: Record<string, unknown>;
}

export interface SetPatch {
  title?: string;
  class?: KindClass;
  parent?: string;
  aliases?: string[];
  /** Merged into the RES's data; a null value removes that field. */
  data?: Record<string, unknown | null>;
}

export interface Observation {
  state?: string;
  title?: string;
  data?: Record<string, unknown | null>;
  /** For a sync-run row: how complete the collector's view was, 0..1. */
  complete?: number;
}

const refuse = (refused: string, id?: string): ResResult => ({ ok: false, refused, ...(id ? { id } : {}) });

/** LifeOS's own delegate markers: a named agent, and a Worker or workflow child that names its parent run. */
const DELEGATE_ENV = ["LIFEOS_AGENT", "LIFEOS_PARENT_RUN_ID"] as const;

/**
 * True only when this process is the principal's own interactive session (CENSVS ISA ISC-61). The answer comes from
 * where the process runs, never from an argument or a writer name:
 *  - the notification channel is not headless (hooks/lib/notification-channel: an explicit headless spawn, or no
 *    terminal identity at all, as launchd and cron give);
 *  - no subagent or delegate marker is set (hooks/lib/subagent's union, plus LifeOS's own DELEGATE_ENV);
 *  - the Claude Code session that spawned it is attended (CLAUDE_CODE_SESSION_ATTENDED=1, which the harness sets
 *    to 0 for a background, daemon or print run), or, outside Claude Code, stdin is a terminal.
 * Relay runs headless, so a principal-only move texted in is refused here; it waits for the terminal.
 */
export function principalPresent(): boolean {
  const env = process.env;
  if (getNotificationChannel() === "headless") return false;
  if (isSubagentContext()) return false;
  if (DELEGATE_ENV.some((k) => !!env[k])) return false;
  const attended = env.CLAUDE_CODE_SESSION_ATTENDED;
  if (attended !== undefined && attended !== "") return attended === "1";
  return Boolean(process.stdin?.isTTY);
}

/** The writer a caller acting for the principal passes (`principal:terminal`), or null when the principal is not present. */
export function principalWriter(): string | null {
  return principalPresent() ? `${PRINCIPAL_WRITER_PREFIX}terminal` : null;
}

/**
 * Why a principal-only move by `writer` is refused, or null when it may land. The writer must name the principal's
 * channel, so the row says who moved it; and this process must be the principal's interactive session, so naming
 * the channel is never enough on its own.
 */
function principalProblem(writer: string): string | null {
  if (!(writer.startsWith(PRINCIPAL_WRITER_PREFIX) && writer.length > PRINCIPAL_WRITER_PREFIX.length)) {
    return `writer ${writer} does not name the principal's channel`;
  }
  if (!principalPresent()) {
    return `writer ${writer} is not in the principal's own interactive session (this process is headless, delegated or unattended)`;
  }
  return null;
}

/** The class a row is written at: the highest of the caller's, the stream's and the RES's. */
function rowClass(opts: WriteOpts, resClass: KindClass): PrivacyClass | null {
  const def = streamDef(opts.stream ?? RES_STREAM);
  if (!def) return null;
  const pick: string[] = [opts.class ?? "public", def.class, resClass];
  if (pick.includes("customer")) return null;
  return pick.reduce((a, b) => ((CLASS_RANK[b] ?? 0) > (CLASS_RANK[a] ?? 0) ? b : a)) as PrivacyClass;
}

/** A caller's data patch as the row carries it: null values become the unset list. */
function splitNulls(data: Record<string, unknown> | undefined): { data?: Record<string, unknown>; unset?: string[] } {
  if (!data) return {};
  const keep = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
  const gone = Object.entries(data).filter(([, v]) => v === null).map(([k]) => k);
  return { ...(keep.length ? { data: Object.fromEntries(keep) } : {}), ...(gone.length ? { unset: gone } : {}) };
}

function bytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v ?? null), "utf8");
}

/** Checks shared by every op: the id, the writer, the stream, the kind's authority. Returns the kind or a refusal. */
function precheck(id: string, op: Op, opts: WriteOpts): { kind: string } | string {
  if (!opts || typeof opts.writer !== "string" || !opts.writer.trim()) return "writer is required";
  const bad = validSubject(id);
  if (bad) return bad;
  const stream = opts.stream ?? RES_STREAM;
  if (!streamDef(stream)) return `unregistered stream: ${stream}`;
  if (stream !== RES_STREAM) addFoldStream(stream);
  const kind = parseSubject(id)!.kind;
  const authority = GENERA[kind]!.authority;
  if (authority === "record" && op === "observe") return `${kind} is a record kind: its rows are its truth, so it is never observed`;
  if (authority !== "record" && !["observe", "link", "unlink"].includes(op)) {
    return `${kind} is a ${authority} kind: the record observes and links it, never ${op}s it`;
  }
  return { kind };
}

function linkProblem(l: unknown): string | null {
  if (!l || typeof l !== "object") return "a link is { rel, to }";
  const { rel, to } = l as Link;
  if (typeof rel !== "string" || !REL_RE.test(rel)) return `link rel must match ${REL_RE.source}`;
  const bad = validSubject(to);
  return bad ? `link target ${String(to)}: ${bad}` : null;
}

function fieldsProblem(kind: string, data: unknown): string | null {
  if (data === undefined) return null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data must be an object";
  const declared = GENERA[kind]!.fields;
  if (declared) {
    const extra = Object.keys(data).filter((k) => !declared.includes(k));
    if (extra.length) return `${kind} declares no field ${extra.join(", ")}`;
  }
  return null;
}

/** The one append. Every op passes through here exactly once. */
function write(id: string, op: Op, payload: Record<string, unknown>, opts: WriteOpts, resClass: KindClass): ResResult {
  const cls = rowClass(opts, resClass);
  if (!cls) return refuse(`cannot write a ${resClass} RES on stream ${opts.stream ?? RES_STREAM}`, id);
  invariant(validSubject(id) === null, `res.${op}: subject ${id} must be valid before append`);
  invariant((OPS as readonly string[]).includes(op), `res: op ${op} must be one of OPS`);
  invariant((CLASS_RANK[cls] ?? -1) >= (CLASS_RANK[resClass] ?? 99), `res.${op}: row class ${cls} below RES class ${resClass}`);
  const input = {
    writer: opts.writer,
    stream: opts.stream ?? RES_STREAM,
    class: cls,
    title: `${op} ${id}`,
    subject: id,
    op,
    data: payload,
    ...(opts.session ? { session: opts.session } : {}),
    ...(opts.ts ? { ts: opts.ts } : {}),
  } as StatvsInput;
  const r = append(input);
  if (!r.ok) return "spooled" in r ? r : refuse(r.refused, id);
  const row = r.row as StatvsRow & { subject?: string; op?: string };
  invariant(row.subject === id && row.op === op, `res.${op}: the record dropped subject or op (append() must carry the F3 fields)`);
  return { ok: true, id, row: r.row };
}

function current(id: string, f: ResFold): FoldedRes | null {
  return Object.hasOwn(f.res, id) ? f.res[id]! : null;
}

/** The RES when it exists and is not retired, else why not. */
function live(id: string, f: ResFold): FoldedRes | string {
  const r = current(id, f);
  if (!r) return `${id} does not exist in the record`;
  if (r.state && bucketOf(r.kind, r.state) === "gone") return `${id} is retired (${r.state})`;
  return r;
}

// ── ops ──────────────────────────────────────────────────────────────────────

export function create(id: string, init: CreateInit, opts: WriteOpts): ResResult {
  const pc = precheck(id, "create", opts);
  if (typeof pc === "string") return refuse(pc, id);
  const def = GENERA[pc.kind]!;
  const f = recordFold();
  if (Object.hasOwn(f.issued, id)) return refuse(`${id} was already issued; ids are never reissued`, id);
  if (f.aliases[id]?.length) return refuse(`${id} is an alias of ${f.aliases[id]!.join(", ")}`, id);
  if (!init || typeof init !== "object") return refuse("create needs { title, ... }", id);
  if (typeof init.title !== "string" || !init.title.trim()) return refuse("title is required", id);
  const state = init.state === undefined ? def.states[0]! : canonicalState(pc.kind, init.state);
  if (!state) return refuse(`${pc.kind} has no state "${init.state}"`, id);
  const cls = init.class ?? def.class;
  if ((CLASS_RANK[cls] ?? -1) < CLASS_RANK[def.class]!) return refuse(`class can only be raised: ${pc.kind} is ${def.class}`, id);
  if (init.parent !== undefined) {
    const bad = validSubject(init.parent);
    if (bad) return refuse(`parent ${init.parent}: ${bad}`, id);
  }
  for (const l of init.links ?? []) {
    const bad = linkProblem(l);
    if (bad) return refuse(bad, id);
  }
  for (const a of init.aliases ?? []) {
    const bad = aliasProblem(a, id, f);
    if (bad) return refuse(bad, id);
  }
  const fp = fieldsProblem(pc.kind, init.data);
  if (fp) return refuse(fp, id);
  if (bytes(init.data) > DATA_MAX_BYTES) return refuse(`data is over ${DATA_MAX_BYTES} bytes; store it by pointer`, id);

  const payload: Record<string, unknown> = { title: init.title, state };
  if (init.class !== undefined) payload.class = init.class;
  if (init.parent !== undefined) payload.parent = init.parent;
  if (init.links?.length) payload.links = init.links.map((l) => ({ rel: l.rel, to: l.to }));
  if (init.aliases?.length) payload.aliases = [...new Set(init.aliases)];
  const created = splitNulls(init.data).data;
  if (created) payload.data = created;
  invariant(def.states.includes(state), `res.create: state ${state} must be declared for ${pc.kind}`);
  const r = write(id, "create", payload, opts, cls);
  if (!r.ok) return r;

  // No lock: another writer may have created the same id between our check and our append. The
  // record orders both rows; the first create wins in every fold, and the loser is told so.
  const winner = recordFold().res[id]?.origin;
  if (winner !== r.row.id) return refuse(`${id} was created by another writer first (row ${winner}); mint a new id`, id);
  return r;
}

export function set(id: string, patch: SetPatch, opts: WriteOpts): ResResult {
  const pc = precheck(id, "set", opts);
  if (typeof pc === "string") return refuse(pc, id);
  const f = recordFold();
  const r = live(id, f);
  if (typeof r === "string") return refuse(r, id);
  if (!patch || typeof patch !== "object") return refuse("set needs a patch", id);
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (!keys.length) return refuse("set needs at least one of title, class, parent, aliases, data", id);
  const unknown = keys.filter((k) => !["title", "class", "parent", "aliases", "data"].includes(k));
  if (unknown.length) return refuse(`set cannot change ${unknown.join(", ")} (use move, link or retire)`, id);
  if (patch.title !== undefined && (typeof patch.title !== "string" || !patch.title.trim())) return refuse("title must be a non-empty string", id);
  if (patch.class !== undefined && (CLASS_RANK[patch.class] ?? -1) < CLASS_RANK[r.class]!) {
    return refuse(`class can only be raised: ${id} is ${r.class}`, id);
  }
  if (patch.parent !== undefined) {
    const bad = validSubject(patch.parent);
    if (bad) return refuse(`parent ${patch.parent}: ${bad}`, id);
  }
  for (const a of patch.aliases ?? []) {
    const bad = aliasProblem(a, id, f);
    if (bad) return refuse(bad, id);
  }
  const fp = fieldsProblem(pc.kind, patch.data);
  if (fp) return refuse(fp, id);
  const merged: Record<string, unknown> = { ...r.data };
  for (const [k, v] of Object.entries(patch.data ?? {})) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  if (bytes(merged) > DATA_MAX_BYTES) return refuse(`data would be over ${DATA_MAX_BYTES} bytes; store it by pointer`, id);

  const payload: Record<string, unknown> = {};
  for (const k of keys) if (k !== "data") payload[k] = (patch as Record<string, unknown>)[k];
  Object.assign(payload, splitNulls(patch.data));
  if (!Object.keys(payload).length) return refuse("set changes nothing", id);
  return write(id, "set", payload, opts, (patch.class ?? r.class) as KindClass);
}

/** Write a refused move to the `move` stream. A failed write never changes the refusal. */
function recordRefusal(id: string, from: string | null, to: string, reason: string, opts: WriteOpts): void {
  try {
    append({
      writer: opts.writer,
      stream: "move",
      class: "personal",
      kind: "move",
      title: `${MOVE_GATE} refuse`,
      subject: id,
      data: { gate: MOVE_GATE, kind: "enforce", verdict: "refuse", reason, subject: id, from, to },
    } as StatvsInput);
  } catch (e) {
    if ((e as Error)?.name === "InvariantViolation") throw e;
  }
}

export function move(id: string, to: string, opts: WriteOpts & { from?: string; reason?: string }): ResResult {
  const pc = precheck(id, "move", opts);
  if (typeof pc === "string") return refuse(pc, id);
  const r = current(id, recordFold());
  if (!r) return refuse(`${id} does not exist in the record`, id);
  const from = r.state ?? null;
  const refused = (reason: string): ResResult => {
    recordRefusal(id, from, to, reason, opts);
    return { ok: false, refused: reason, id, verdict: "refuse" };
  };
  if (opts.from !== undefined && canonicalState(pc.kind, opts.from) !== from) {
    return refused(`${id} is in ${from ?? "no state"}, not ${opts.from}; read it again before moving`);
  }
  if (from === null || !canMove(pc.kind, from, to)) {
    return refused(`${pc.kind} cannot move ${from ?? "(no state)"}>${to}: not on its move map`);
  }
  const target = canonicalState(pc.kind, to)!;
  const notPrincipal = needsPrincipal(pc.kind, from, target) ? principalProblem(opts.writer) : null;
  if (notPrincipal) return refused(`${pc.kind} ${from}>${target} needs the principal's own interactive session; ${notPrincipal}`);
  invariant(canMove(pc.kind, from, target), `res.move: ${from}>${target} must be on the ${pc.kind} map before append`);
  const payload: Record<string, unknown> = { from, to: target };
  if (opts.reason) payload.reason = opts.reason;
  return write(id, "move", payload, opts, r.class);
}

function linkOp(op: "link" | "unlink", id: string, rel: string, to: string, opts: WriteOpts): ResResult {
  const pc = precheck(id, op, opts);
  if (typeof pc === "string") return refuse(pc, id);
  const bad = linkProblem({ rel, to });
  if (bad) return refuse(bad, id);
  if (to === id) return refuse("a RES cannot link to itself", id);
  // A record kind must exist and be live; a git or observed RES may be linked before the record observes it.
  const f = recordFold();
  const r = GENERA[pc.kind]!.authority === "record" ? live(id, f) : current(id, f);
  if (typeof r === "string") return refuse(r, id);
  const has = r?.links.some((l) => l.rel === rel && l.to === to) ?? false;
  if (op === "link" && has) return refuse(`${id} already has ${rel} → ${to}`, id);
  if (op === "unlink" && !has) return refuse(`${id} has no ${rel} → ${to}`, id);
  return write(id, op, { rel, to }, opts, r?.class ?? GENERA[pc.kind]!.class);
}

export function link(id: string, rel: string, to: string, opts: WriteOpts): ResResult {
  return linkOp("link", id, rel, to, opts);
}

export function unlink(id: string, rel: string, to: string, opts: WriteOpts): ResResult {
  return linkOp("unlink", id, rel, to, opts);
}

export function observe(id: string, obs: Observation, opts: WriteOpts): ResResult {
  const pc = precheck(id, "observe", opts);
  if (typeof pc === "string") return refuse(pc, id);
  if (!obs || typeof obs !== "object") return refuse("observe needs { state?, title?, data?, complete? }", id);
  const payload: Record<string, unknown> = {};
  if (obs.state !== undefined) {
    const s = canonicalState(pc.kind, obs.state);
    if (!s) return refuse(`${pc.kind} has no state "${obs.state}"`, id);
    payload.state = s;
  }
  if (obs.title !== undefined) {
    if (typeof obs.title !== "string" || !obs.title.trim()) return refuse("title must be a non-empty string", id);
    payload.title = obs.title;
  }
  if (obs.data !== undefined) {
    const fp = fieldsProblem(pc.kind, obs.data);
    if (fp) return refuse(fp, id);
    if (bytes(obs.data) > DATA_MAX_BYTES) return refuse(`data is over ${DATA_MAX_BYTES} bytes; store it by pointer`, id);
    Object.assign(payload, splitNulls(obs.data));
  }
  if (obs.complete !== undefined) {
    if (typeof obs.complete !== "number" || !(obs.complete >= 0 && obs.complete <= 1)) return refuse("complete must be a number from 0 to 1", id);
    payload.complete = obs.complete;
  }
  if (!Object.keys(payload).length) return refuse("an observation needs at least one of state, title, data, complete", id);
  const r = current(id, recordFold());
  return write(id, "observe", payload, opts, r?.class ?? GENERA[pc.kind]!.class);
}

export function retire(id: string, opts: WriteOpts & { reason?: string }): ResResult {
  const pc = precheck(id, "retire", opts);
  if (typeof pc === "string") return refuse(pc, id);
  const r = live(id, recordFold());
  if (typeof r === "string") return refuse(r, id);
  const to = retireState(pc.kind);
  invariant(to !== null, `res.retire: ${pc.kind} must declare a gone state (GENERA audit)`);
  const payload: Record<string, unknown> = { from: r.state ?? null, to };
  if (opts.reason) payload.reason = opts.reason;
  return write(id, "retire", payload, opts, r.class);
}
