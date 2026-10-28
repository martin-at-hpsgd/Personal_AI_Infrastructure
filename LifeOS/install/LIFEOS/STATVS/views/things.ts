/**
 * The `things` view: every RES's current shape, folded from the STATVS rows that name it
 * (CENSVS ISA F5, ISC-28..ISC-32). Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md.
 *
 * One generic fold over every registered stream. A row about a RES names it in `subject`
 * ("<kind>:<key>", kind from GENERA) and says what it did in `op`; the payload in `data` is:
 *
 *   create, observe  { title?, state?, parent?, class?, aliases?, data?: {...}, links?: [{rel,to}] }
 *   set              { title?, parent?, class?, aliases?, data?: {...}, unset?: [field] }   (`fields` is read as `data`)
 *                    a null value in `data` removes that field, as res.ts set() writes it
 *   move             { from?, to, verdict? }   a verdict other than "allowed" is a recorded refusal, never applied
 *   link, unlink     { rel, to }
 *   retire           { from?, to?, reason? }: `to` when it is a gone-bucket state, else the kind's first gone state
 *
 * A row with a subject and no op is a mention: it counts in the RES's timeline (rows, since,
 * updated, via) and changes nothing. Rows of the `work` stream carry no subject today; they fold
 * to `isa:<slug>` through core/lib/subject.ts deriveSubject, with the work registry's own reducer,
 * restricted to the fields an isa RES carries (CENSVS/live/isa.ts ISA_FIELDS). Other derivable
 * streams (turn, deploy, app-*) are not folded here: their subjects are a timeline, which
 * `rows-by-subject` reads from the record.
 *
 * The record rules on nothing, so the fold applies what writers did, and flags what breaks a
 * kind's rules in state.flags (rendered sorted by row): a field whose GENERA fieldOwners excludes
 * the writer, a field outside a kind's declared fields, a class below the kind's default, a state
 * the kind does not declare, a move off the map, a create/set/move/retire on a git kind (git owns
 * those; only observe, link and unlink land), an observe on a record kind, a bad subject or link.
 * Of those, the field-owner, undeclared-field, class, unknown-state, git and observe cases are
 * NOT applied; an off-map move IS applied (the writer chose to write it) and flagged.
 *
 * Order: fields are last-writer-wins by (hlc, writer, row id), with deletes kept as stamps, so an
 * incremental read that folds rows in batches equals a rebuild that folds them in one order.
 * Work rows keep the work view's sequential reducer; they come from one writer, whose rows are
 * always in hlc order.
 *
 * Slices: each LIFEOS/CENSVS/live/<kind>.ts default-exports a LiveSource and becomes the view
 * `things-<kind>`, whose render is source.project(...) and whose live() is source.live(), so
 * `Statvs.ts compare things-<kind>` diffs that kind's slice against the store it will replace.
 * A store that holds several kinds (Atlas) names its slice after itself and lists the GENERA kinds
 * it covers in `kinds` (live/atlas.ts → `things-atlas`). Files are found at load; a file that fails to import still registers its slice, and compare
 * reports the import error. Live sources import only types from this file (see live/isa.ts).
 *
 * As of a time (ISC-53): thingsAt(at) folds only the rows whose `ts` and whose hlc are both at or
 * before `at`, so a RES reads as the record knew it then. A row written later about an earlier
 * moment (a backdated ts, an import) is left out: it was not known at `at`. The fold is the same
 * foldThing, so the answer at `at` equals a rebuild run at that moment over the same rows.
 *
 * Customer-class rows are never read: a RES holds no customer content. The fold reads `row.data`
 * only; a payload over 64 KB lives in objects/ and the views engine hydrates it before fold, so a
 * caller folding scanned rows itself must hydrate them first (a work seed is such a row).
 *
 * @version 1.0.0
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { invariant } from "../../TOOLS/Invariant";
import { scan, statvsDir } from "../lib/record";
import { GENERA, OPS, bucketOf, canMove, canonicalState, looksPersonal, parseSubject, retireState, validSubject, type Authority, type Bucket, type KindClass } from "../../CENSVS/genera";
import type { Link, Res } from "../../CENSVS/sources/common";
import { ISA_FIELDS, pickIsa } from "../../CENSVS/live/isa";
import { deriveSubject } from "../core/lib/subject";
import { allStreams } from "../streams";
import type { PrivacyClass, StatvsRow } from "../lib/types";
import type { ViewDef } from "../lib/views";
import { foldEvents, type WorkEvent } from "../../../hooks/lib/work-events";

// ── Shapes ──

/** A row as the fold reads it: the F3 envelope fields may be absent on older rows. */
type SubjectRow = StatvsRow & { subject?: unknown; op?: unknown };

export type FlagCode =
  | "bad-subject" | "bad-op" | "bad-payload" | "bad-link" | "bad-parent"
  | "field-owner" | "undeclared-field" | "class-lowered" | "unknown-state" | "off-map"
  | "git-authority" | "observe-on-record-kind" | "no-subject";

export interface Flag {
  row: string;
  hlc: string;
  writer: string;
  subject: string;
  op?: string;
  code: FlagCode;
  field?: string;
  detail?: string;
}

/** One RES under fold. Field values are last-writer-wins; `t` holds each field's stamp. */
export interface Entry {
  id: string;
  kind: string;
  title?: string;
  state?: string;
  parent?: string | null;
  /** The highest privacy class any applied row or explicit class carried (never below the kind's). */
  class: KindClass;
  data: Record<string, unknown>;
  /** "<rel>\u0000<to>" → present. */
  links: Record<string, boolean>;
  /** Legacy ids that resolve to this RES. Add-only, so order never matters. */
  aliases: string[];
  /** Field → stamp of the row that last wrote it: title, state, parent, class, d.<key>, l.<rel>\u0000<to>. */
  t: Record<string, string>;
  rows: number;
  since: string;
  updated: string;
  /** Streams whose rows named this RES. */
  via: string[];
}

export interface ThingsState {
  v: 1;
  res: Record<string, Entry>;
  /** slug → work.json row picked to ISA_FIELDS: the isa RES the work stream holds. */
  work: Record<string, Record<string, unknown>>;
  /** "<row id>|<code>|<field>" → flag. */
  flags: Record<string, Flag>;
}

/** A RES as the view renders it: the CENSVS RES shape plus its timeline summary. */
export interface ThingRes extends Res {
  bucket?: Bucket;
  rows: number;
  since?: string;
  updated?: string;
  via: string[];
}

export interface ThingsView {
  v: 1;
  count: number;
  byKind: Record<string, number>;
  res: Record<string, ThingRes>;
  /** Subjects named by rows that never defined them (no create, set, observe or work row): id → rows. */
  mentions: Record<string, number>;
  flags: Flag[];
}

/** A per-kind slice: how one existing store compares with the things fold during dual-write. */
export interface LiveSource {
  /** A GENERA kind, or the name of a store covering several (then `kinds` lists them); the slice is the view `things-<kind>`. */
  kind: string;
  /** The GENERA kinds a multi-kind slice covers (e.g. atlas). Required when `kind` is not itself a GENERA kind. */
  kinds?: readonly string[];
  /** Streams the slice folds; default every registered stream. */
  streams?: string[];
  /** The record side, in the live store's shape. */
  project(view: ThingsView, state: ThingsState): unknown;
  /** The live store's current content, read-only. */
  live(): unknown | Promise<unknown>;
}

// ── Helpers ──

const CLASS_RANK: Record<string, number> = { public: 0, system: 1, personal: 2 };
const isClass = (c: unknown): c is KindClass => typeof c === "string" && Object.hasOwn(CLASS_RANK, c);
const maxClass = (a: KindClass, b: KindClass): KindClass => (CLASS_RANK[b]! > CLASS_RANK[a]! ? b : a);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const clone = <T>(x: T): T => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const LINK_SEP = "\u0000";

/** The order rows are applied in: (hlc, writer, row id). Unique across the record. */
const stampOf = (r: StatvsRow): string => `${r.hlc}\u0001${r.writer}\u0001${r.id}`;

/** The subject a row names: its own, else (work rows only) the one deriveSubject finds. */
export function rowSubject(row: StatvsRow): string | null {
  const s = (row as SubjectRow).subject;
  if (typeof s === "string") return s;
  return row.stream === "work" ? deriveSubject({ stream: row.stream, kind: row.kind, data: row.data }) : null;
}

function flag(state: ThingsState, row: StatvsRow, subject: string, code: FlagCode, field?: string, detail?: string): void {
  const op = (row as SubjectRow).op;
  const f: Flag = { row: row.id, hlc: row.hlc, writer: row.writer, subject, code };
  if (typeof op === "string") f.op = op;
  if (field !== undefined) f.field = field;
  if (detail !== undefined) f.detail = detail;
  state.flags[`${row.id}|${code}|${field ?? ""}`] = f;
}

function entry(state: ThingsState, id: string, kind: string, row: StatvsRow): Entry {
  let e = state.res[id];
  if (!e) {
    e = { id, kind, class: GENERA[kind]!.class, data: {}, links: {}, aliases: [], t: {}, rows: 0, since: row.ts, updated: row.ts, via: [] };
    state.res[id] = e;
  }
  invariant(e.kind === kind && e.id === id, `things: entry ${e.id} holds kind ${e.kind}, row says ${kind}`);
  e.aliases ??= []; // a checkpoint written before aliases existed
  return e;
}

/** Count a row in a RES's timeline. Commutative, so batch order never matters. */
function touch(e: Entry, row: StatvsRow): void {
  e.rows++;
  if (row.ts < e.since) e.since = row.ts;
  if (row.ts > e.updated) e.updated = row.ts;
  if (!e.via.includes(row.stream)) { e.via.push(row.stream); e.via.sort(); }
}

/** Write one field if this row is newer than whatever wrote it last. */
function lww(e: Entry, field: string, stamp: string, apply: () => void): void {
  const prev = e.t[field];
  if (prev !== undefined && prev >= stamp) return;
  apply();
  e.t[field] = stamp;
}

/** True when `writer` may write `field` of `kind` (GENERA fieldOwners; no entry means anyone). */
function owns(kind: string, field: string, writer: string): boolean {
  const owners = GENERA[kind]!.fieldOwners?.[field];
  return !owners || owners.some((p) => writer === p || writer.startsWith(p));
}

function validLink(l: unknown): l is Link {
  return isObj(l) && typeof l.rel === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(l.rel) && typeof l.to === "string" && validSubject(l.to) === null;
}

// ── Applying ops ──

/** create, set and observe: title, parent, class, data fields and links, each checked then applied last-writer-wins. */
function applyFields(state: ThingsState, e: Entry, row: StatvsRow, subject: string, p: Record<string, unknown>, op: string): void {
  const stamp = stampOf(row);
  const kind = e.kind;
  const def = GENERA[kind]!;
  const ok = (field: string): boolean => {
    if (owns(kind, field, row.writer)) return true;
    flag(state, row, subject, "field-owner", field, `writer ${row.writer} does not own ${field}`);
    return false;
  };
  let applied = false;
  if (p.title !== undefined) {
    if (typeof p.title === "string" && p.title.length > 0) { if (ok("title")) { lww(e, "title", stamp, () => { e.title = p.title as string; }); applied = true; } }
    else flag(state, row, subject, "bad-payload", "title");
  }
  if (p.parent !== undefined) {
    if (p.parent === null || (typeof p.parent === "string" && validSubject(p.parent) === null)) { if (ok("parent")) { lww(e, "parent", stamp, () => { e.parent = p.parent as string | null; }); applied = true; } }
    else flag(state, row, subject, "bad-parent", "parent");
  }
  if (p.class !== undefined) {
    if (!isClass(p.class)) flag(state, row, subject, "bad-payload", "class");
    else if (CLASS_RANK[p.class]! < CLASS_RANK[def.class]!) flag(state, row, subject, "class-lowered", "class", `${p.class} is below ${kind}'s ${def.class}`);
    else if (ok("class")) { e.class = maxClass(e.class, p.class); applied = true; }
  }
  if (op !== "set" && p.state !== undefined) {
    if (typeof p.state !== "string") flag(state, row, subject, "bad-payload", "state");
    else {
      const s = canonicalState(kind, p.state);
      if (s === null) flag(state, row, subject, "unknown-state", "state", p.state);
      else if (ok("state")) { lww(e, "state", stamp, () => { e.state = s; }); applied = true; }
    }
  }
  const patch = p.data ?? p.fields;
  if (patch !== undefined) {
    if (!isObj(patch)) flag(state, row, subject, "bad-payload", "data");
    else for (const [k, v] of Object.entries(patch)) {
      if (def.fields && !def.fields.includes(k)) { flag(state, row, subject, "undeclared-field", k); continue; }
      if (!ok(k)) continue;
      lww(e, `d.${k}`, stamp, () => { if (v === undefined || v === null) delete e.data[k]; else e.data[k] = clone(v); });
      applied = true;
    }
  }
  if (Array.isArray(p.unset)) for (const k of p.unset) {
    if (typeof k !== "string") continue;
    if (!ok(k)) continue;
    lww(e, `d.${k}`, stamp, () => { delete e.data[k]; });
    applied = true;
  }
  if (p.aliases !== undefined) {
    const good = Array.isArray(p.aliases) && p.aliases.every((a) => typeof a === "string" && /^\S{1,256}$/.test(a) && !looksPersonal(a));
    if (!good) flag(state, row, subject, "bad-payload", "aliases");
    else {
      for (const a of p.aliases as string[]) if (!e.aliases.includes(a)) e.aliases.push(a);
      e.aliases.sort();
      applied = true;
    }
  }
  if (Array.isArray(p.links)) for (const l of p.links) {
    if (!validLink(l)) { flag(state, row, subject, "bad-link", "links"); continue; }
    const key = `${l.rel}${LINK_SEP}${l.to}`;
    lww(e, `l.${key}`, stamp, () => { e.links[key] = true; });
    applied = true;
  }
  // Raising class with the row: what a row carried into the RES is at least as private as the row.
  if (applied && isClass(row.class)) e.class = maxClass(e.class, row.class);
}

function applyOp(state: ThingsState, row: StatvsRow, subject: string): void {
  const raw = (row as SubjectRow).op;
  const bad = validSubject(subject);
  if (bad) { flag(state, row, subject, "bad-subject", undefined, bad); return; }
  const kind = parseSubject(subject)!.kind;
  const e = entry(state, subject, kind, row);
  touch(e, row);
  if (raw === undefined) return; // a mention
  if (typeof raw !== "string" || !(OPS as readonly string[]).includes(raw)) { flag(state, row, subject, "bad-op", undefined, String(raw)); return; }
  const op = raw;
  const authority: Authority = GENERA[kind]!.authority;
  if (authority === "git" && (op === "create" || op === "set" || op === "move" || op === "retire")) {
    flag(state, row, subject, "git-authority", undefined, `${kind} is owned by git; only observe, link and unlink land in the record`);
    return;
  }
  if (op === "observe" && authority === "record") {
    flag(state, row, subject, "observe-on-record-kind", undefined, `${kind} is owned by its rows; observe is for git and observed kinds`);
    return;
  }
  const p = row.data;
  if (op === "retire") {
    const asked = isObj(p) && typeof p.to === "string" ? canonicalState(kind, p.to) : null;
    const gone = asked !== null && bucketOf(kind, asked) === "gone" ? asked : retireState(kind);
    if (gone) lww(e, "state", stampOf(row), () => { e.state = gone; });
    return;
  }
  if (!isObj(p)) { flag(state, row, subject, "bad-payload"); return; }
  switch (op) {
    case "create":
    case "observe":
    case "set":
      applyFields(state, e, row, subject, p, op);
      return;
    case "move": {
      const v = p.verdict;
      if (v !== undefined && v !== "allowed") return; // a refusal the writer recorded
      const to = typeof p.to === "string" ? canonicalState(kind, p.to) : null;
      if (to === null) { flag(state, row, subject, "unknown-state", "state", String(p.to)); return; }
      if (typeof p.from === "string" && !canMove(kind, p.from, to)) flag(state, row, subject, "off-map", "state", `${p.from}>${to}`);
      if (!owns(kind, "state", row.writer)) { flag(state, row, subject, "field-owner", "state"); return; }
      lww(e, "state", stampOf(row), () => { e.state = to; });
      if (isClass(row.class)) e.class = maxClass(e.class, row.class);
      return;
    }
    case "link":
    case "unlink": {
      if (!validLink(p)) { flag(state, row, subject, "bad-link"); return; }
      const key = `${p.rel}${LINK_SEP}${p.to}`;
      lww(e, `l.${key}`, stampOf(row), () => { e.links[key] = op === "link"; });
      return;
    }
  }
}

/** A work row: the work registry's reducer, per slug, picked to the isa fields. */
function applyWork(state: ThingsState, row: StatvsRow): void {
  const d = row.data;
  if (!isObj(d)) return; // a redacted row folds to nothing, as in the work view
  const subjectFor = (slug: unknown): string | null => deriveSubject({ stream: "work", kind: "seed-row", data: { slug } });
  const count = (slug: string) => {
    const s = subjectFor(slug);
    if (s) touch(entry(state, s, "isa", row), row);
  };
  switch (row.kind) {
    case "seed": {
      const reg = isObj(d.registry) ? d.registry : null;
      if (!reg) return;
      state.work = {};
      for (const [slug, r] of Object.entries(isObj(reg.sessions) ? reg.sessions : {})) {
        if (!subjectFor(slug)) { flag(state, row, `isa:${slug}`, "no-subject", undefined, "slug is not a valid isa key"); continue; }
        state.work[slug] = pickIsa(r);
        count(slug);
      }
      return;
    }
    case "seed-row": {
      if (typeof d.slug !== "string" || d.slug.length === 0 || !isObj(d.row)) return;
      if (!subjectFor(d.slug)) { flag(state, row, `isa:${d.slug}`, "no-subject", undefined, "slug is not a valid isa key"); return; }
      state.work[d.slug] = pickIsa(d.row);
      count(d.slug);
      return;
    }
    case "event": {
      const ev = d as unknown as WorkEvent;
      if (typeof ev.slug !== "string" || ev.slug.length === 0) return;
      if (!subjectFor(ev.slug)) { flag(state, row, `isa:${ev.slug}`, "no-subject", undefined, "slug is not a valid isa key"); return; }
      const base = Object.hasOwn(state.work, ev.slug) ? { [ev.slug]: state.work[ev.slug] } : {};
      const next = foldEvents({ sessions: base }, [ev]).sessions[ev.slug];
      if (next === undefined) delete state.work[ev.slug];
      else state.work[ev.slug] = pickIsa(next);
      count(ev.slug);
      return;
    }
  }
}

// ── The fold ──

export function initThings(): ThingsState {
  return { v: 1, res: {}, work: {}, flags: {} };
}

/** Fold one row into the things state. Mutates and returns `state` (a fold's state is its own). */
export function foldThing(state: ThingsState, row: StatvsRow): ThingsState {
  invariant(!!state && state.v === 1 && isObj(state.res) && isObj(state.work) && isObj(state.flags), "things: fold state must be a v1 things state");
  if (row.class === "customer") return state;
  if (row.stream === "work") { applyWork(state, row); return state; }
  const s = (row as SubjectRow).subject;
  if (s === undefined) return state;
  if (typeof s !== "string") { flag(state, row, String(s), "bad-subject", undefined, "subject must be a string"); return state; }
  applyOp(state, row, s);
  return state;
}

/** The isa RES the work map holds, before any op row overlays it. */
function workRes(slug: string, r: Record<string, unknown>): ThingRes {
  const phase = typeof r.phase === "string" ? r.phase : undefined;
  const state = phase !== undefined ? canonicalState("isa", phase) ?? undefined : undefined;
  const data: Record<string, unknown> = {};
  for (const f of ISA_FIELDS) if (f !== "task" && f !== "phase" && Object.hasOwn(r, f)) data[f] = clone(r[f]);
  if (phase !== undefined && state === undefined) data.sourceState = phase;
  const out: ThingRes = { id: `isa:${slug}`, kind: "isa", title: typeof r.task === "string" && r.task ? r.task : slug, class: "personal", authority: "git", rows: 0, via: [] };
  if (state !== undefined) out.state = state;
  if (Object.keys(data).length) out.data = data;
  return out;
}

/** The rendered view: every defined RES, sorted by id, with mentions and flags. */
export function renderThings(state: ThingsState): ThingsView {
  const res: Record<string, ThingRes> = {};
  const mentions: Record<string, number> = {};
  const workIds = new Set(Object.keys(state.work).map((s) => `isa:${s}`));
  const ids = [...new Set([...Object.keys(state.res), ...workIds])].sort();
  for (const id of ids) {
    const e = state.res[id];
    const fromWork = workIds.has(id);
    const defined = fromWork || (!!e && (Object.keys(e.t).length > 0 || (e.aliases?.length ?? 0) > 0 || e.class !== GENERA[e.kind]!.class));
    if (!defined) {
      // A session the work registry dropped leaves the view with it; only other streams' bare mentions are listed.
      if (e && !(e.via.length === 1 && e.via[0] === "work")) mentions[id] = e.rows;
      continue;
    }
    const kind = e?.kind ?? "isa";
    const def = GENERA[kind]!;
    const base: ThingRes = fromWork
      ? workRes(id.slice(4), state.work[id.slice(4)]!)
      : { id, kind, title: parseSubject(id)!.key, class: def.class, authority: def.authority, rows: 0, via: [] };
    if (e) {
      if (e.t.title !== undefined && e.title !== undefined) base.title = e.title;
      if (e.t.state !== undefined && e.state !== undefined) { base.state = e.state; if (base.data) delete base.data.sourceState; }
      if (e.t.parent !== undefined) { if (e.parent) base.parent = e.parent; else delete base.parent; }
      base.class = maxClass(base.class, e.class);
      const data = { ...(base.data ?? {}), ...clone(e.data) };
      for (const k of Object.keys(e.t)) if (k.startsWith("d.") && !Object.hasOwn(e.data, k.slice(2))) delete data[k.slice(2)];
      if (Object.keys(data).length) base.data = data; else delete base.data;
      const links = Object.entries(e.links).filter(([, on]) => on).map(([k]) => { const [rel, to] = k.split(LINK_SEP); return { rel: rel!, to: to! }; })
        .sort((a, b) => (a.rel + a.to < b.rel + b.to ? -1 : 1));
      if (links.length) base.links = links;
      if (e.aliases?.length) base.aliases = [...e.aliases];
      base.rows = e.rows;
      base.since = e.since;
      base.updated = e.updated;
      base.via = [...e.via];
    }
    const b = base.state ? bucketOf(kind, base.state) : null;
    if (b) base.bucket = b;
    res[id] = base;
  }
  const byKind: Record<string, number> = {};
  for (const r of Object.values(res)) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const flags = Object.values(state.flags).sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.row < b.row ? -1 : a.row > b.row ? 1 : a.code < b.code ? -1 : 1));
  return { v: 1, count: Object.keys(res).length, byKind: Object.fromEntries(Object.entries(byKind).sort()), res, mentions, flags };
}

// ── As of a time (ISC-53) ──

/** `at` as epoch milliseconds: a number, a Date, or a string Date.parse reads (ISO with a zone). */
export function atMs(at: number | string | Date): number {
  const ms = typeof at === "number" ? at : at instanceof Date ? at.getTime() : Date.parse(at);
  invariant(Number.isFinite(ms), `things: "${String(at)}" is not a time`);
  return ms;
}

/** The physical milliseconds of a row's hlc ("<13 digits>.<4 digits>"), or NaN. */
export function hlcMs(hlc: string): number {
  return /^\d{13}\.\d{4}$/.test(hlc) ? Number(hlc.slice(0, 13)) : NaN;
}

/** True when the record held this row at `ms`: its ts and its hlc are both at or before it. */
export function knownAt(row: StatvsRow, ms: number): boolean {
  const h = hlcMs(row.hlc);
  if (Number.isFinite(h) && h > ms) return false;
  const t = Date.parse(row.ts);
  if (Number.isFinite(t) && t > ms) return false;
  return Number.isFinite(h) || Number.isFinite(t);
}

/** Fold already-scanned rows as of `at`. Pure: rows past `at` are skipped, the rest go through foldThing in hlc order. */
export function foldThingsAt(rows: readonly StatvsRow[], at: number | string | Date): ThingsState {
  const ms = atMs(at);
  const ordered = [...rows].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0));
  let state = initThings();
  for (const r of ordered) if (knownAt(r, ms)) state = foldThing(state, r);
  return state;
}

export interface ThingsAt {
  /** The cut, as an ISO string. */
  at: string;
  state: ThingsState;
  view: ThingsView;
  /** Every row the fold may read (registered streams, non-customer, not redacted), hydrated, in hlc order, up to and including `at`. */
  rows: StatvsRow[];
  /** Malformed lines the scan skipped. */
  problems: string[];
}

/** A payload over 64 KB lives in objects/; give the fold the data itself, as the views engine does. */
function hydrateRow(row: StatvsRow, dir: string): StatvsRow {
  if (row.data !== null || typeof row.obj !== "string" || !/^[a-f0-9]{64}$/.test(row.obj)) return row;
  try { return { ...row, data: JSON.parse(readFileSync(join(dir, "objects", row.obj.slice(0, 2), `${row.obj}.json`), "utf8")) }; } catch { return row; }
}

/**
 * The things fold as the record knew it at `at`: a full scan of the record, cut at `at`, folded with
 * foldThing. Reads only; writes no view output and no checkpoint (a past state is not the view's state).
 * A redacted row stays out whenever the redaction landed: privacy wins over history.
 */
export function thingsAt(at: number | string | Date, opts: { recordDir?: string } = {}): ThingsAt {
  const ms = atMs(at);
  const dir = resolve(opts.recordDir ?? statvsDir());
  const streams = new Set(everyStream());
  const { rows, problems } = scan({ dir, classes: CLASSES });
  const gone = new Set<string>();
  for (const r of rows) {
    if (r.stream !== "statvs" || r.kind !== "redact") continue;
    const t = (r.data as { target?: unknown } | null)?.target;
    if (typeof t === "string") gone.add(t);
  }
  const kept: StatvsRow[] = [];
  for (const r of rows) {
    if (!streams.has(r.stream) || !CLASSES.includes(r.class) || gone.has(r.id) || !knownAt(r, ms)) continue;
    kept.push(hydrateRow(r, dir));
  }
  const state = foldThingsAt(kept, ms);
  return { at: new Date(ms).toISOString(), state, view: renderThings(state), rows: kept, problems: problems ?? [] };
}

// ── View definitions ──

/** Every registered stream, read at use so a stream added since load (or by a test) is folded too. */
function everyStream(): string[] {
  return Object.keys(allStreams()).sort();
}
const CLASSES: PrivacyClass[] = ["public", "system", "personal"];

/** The `things` view itself: every RES, compared in drill against its own output. */
export const THINGS: ViewDef<ThingsState> = {
  name: "things",
  group: "things",
  get streams() { return everyStream(); },
  classes: CLASSES,
  path: "statvs-views/things.json",
  init: initThings,
  fold: foldThing,
  render: renderThings,
};

/** The view `things-<kind>` for one live source. */
export function sliceView(src: LiveSource): ViewDef<ThingsState> {
  invariant(typeof src?.kind === "string" && /^[a-z_]+$/.test(src.kind), `things: a live source needs a kind name, got ${String(src?.kind)}`);
  const own = Array.isArray(src.streams) && src.streams.length > 0 ? [...src.streams] : null;
  return {
    name: `things-${src.kind}`,
    group: "things",
    get streams() { return own ?? everyStream(); },
    classes: CLASSES,
    path: `statvs-views/things-${src.kind}.json`,
    init: initThings,
    fold: foldThing,
    render: (s) => src.project(renderThings(s), s),
    live: () => src.live(),
  };
}

/** The live sources in LIFEOS/CENSVS/live/: one per kind, named <kind>.ts. */
export const LIVE_DIR = resolve(import.meta.dir, "..", "..", "CENSVS", "live");

async function loadSources(dir: string): Promise<LiveSource[]> {
  let files: string[] = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && /\.ts$/.test(f.name) && !/\.test\.ts$/.test(f.name) && !f.name.startsWith("_") && !f.name.endsWith(".d.ts"))
      .map((f) => f.name).sort();
  } catch { return []; }
  const out: LiveSource[] = [];
  for (const f of files) {
    const kind = f.slice(0, -3);
    let src: unknown;
    let problem: string | null = null;
    try { src = (await import(join(dir, f))).default; } catch (e) { problem = `import failed: ${(e as Error).message}`; }
    const s = src as LiveSource | undefined;
    if (!problem && (!s || typeof s !== "object" || typeof s.project !== "function" || typeof s.live !== "function")) problem = "default export is not a LiveSource { kind, project, live }";
    if (!problem && s!.kind !== kind) problem = `kind "${s!.kind}" does not match its file name ${f}`;
    const covers = s && Array.isArray(s.kinds) ? s.kinds : null;
    if (!problem && !Object.hasOwn(GENERA, kind)) {
      if (!covers || covers.length === 0) problem = `"${kind}" is not a GENERA kind and lists no kinds it covers`;
      else {
        const stray = covers.filter((k) => typeof k !== "string" || !Object.hasOwn(GENERA, k));
        if (stray.length) problem = `"${kind}" covers kinds not in GENERA: ${stray.join(", ")}`;
      }
    }
    if (problem || !/^[a-z_]+$/.test(kind)) {
      // The slice still registers, so `compare things-<kind>` names the failure instead of "no registered view".
      const why = problem ?? `bad file name ${f}`;
      out.push({ kind: /^[a-z_]+$/.test(kind) ? kind : "invalid", project: () => ({}), live: () => { throw new Error(`live source ${f}: ${why}`); } });
      continue;
    }
    out.push(s!);
  }
  return out;
}

const SOURCES = await loadSources(LIVE_DIR);

/**
 * Every view this module registers: `things` and one slice per live source. The views loader
 * registers a module's `views` array when it exports one; a loader that reads only `default`
 * still registers `things` itself.
 */
export const views: ViewDef<ThingsState>[] = [THINGS, ...SOURCES.map(sliceView)];
export default THINGS;
