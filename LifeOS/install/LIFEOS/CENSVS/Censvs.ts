#!/usr/bin/env bun
/**
 * Censvs — the CENSVS command line (ISA F6 ISC-36, F5 ISC-53, F7 ISC-37..ISC-39, F12 ISC-54, F11 ISC-67).
 *
 * Named like Statvs.ts. The writer library is res.ts and has no command line of
 * its own, so no two names here can fold into one file on a case-insensitive
 * filesystem.
 *
 *   bun LIFEOS/CENSVS/Censvs.ts kinds [--json]                              every GENERA kind
 *   bun LIFEOS/CENSVS/Censvs.ts get <id> [--at T] [--json]                  one RES as JSON
 *   bun LIFEOS/CENSVS/Censvs.ts list <kind> [--state s] [--at T] [--json]   every RES of a kind
 *   bun LIFEOS/CENSVS/Censvs.ts show <id> [--at T] [--all] [--json]         fields, links, then the row timeline
 *   bun LIFEOS/CENSVS/Censvs.ts links <id> [--at T] [--json]                links out, links in, parent
 *   bun LIFEOS/CENSVS/Censvs.ts situation <id> [--at T] [--depth N] [--window 24h] [--out file] [--json]
 *   bun LIFEOS/CENSVS/Censvs.ts resolve [--json] [--full] [--source X]...   the read-only resolver
 *
 * Where a RES comes from, in order: the `things` view (LIFEOS/STATVS/views/things.ts)
 * when it is registered; otherwise the RES rows in the local record, folded here;
 * and, for get, show, links and list, the read-only resolver when neither has it.
 * Every answer says which one it used. The timeline is every row in the local
 * record whose subject is the RES, named on the row or derived from it by the one
 * resolver STATVS core uses (core/lib/subject.ts indexSubject).
 *
 * --at T reads the record as it stood at T (ISC-53): the things fold over only the
 * rows the record held then (views/things.ts thingsAt), and the timeline cut at T.
 * T is an ISO time with a zone, a local date and time, or a local HH:mm today, in
 * the principal's zone. With --at there is no resolver fallback: the source stores
 * hold only today.
 *
 * situation (ISC-54) walks from the RES through parent, children and links to
 * --depth (default 2), folds each as of T, adds every row about them in the
 * --window before T (default 24 h) and the nearest turn row for any session in the
 * set, and writes it as one JSON file, mode 0600, under
 * LIFEOS/MEMORY/STATE/censvs/situations/. situation.ts holds the file's contract.
 *
 * Reads only, except that reading the things view advances its checkpoint, as
 * every STATVS view read does, and that situation writes its one file. `resolve`
 * reads nothing but the source stores.
 *
 * Concept: LIFEOS/DOCUMENTATION/Censvs/CensvsSystem.md * @version 1.1.0
 */
import { getView, readViewDef, scan } from "../STATVS/index";
import type { StatvsRow } from "../STATVS/index";
import { indexSubject } from "../STATVS/core/lib/subject";
import { knownAt, thingsAt } from "../STATVS/views/things";
import { principalTimezone } from "../TOOLS/lib/Timezone";
import { GENERA, bucketOf, isKind, parseSubject } from "./genera";
import { recordFold, resolveId, rowPayload } from "./ids";
import type { FoldedRes } from "./ids";
import { resolveAll, resolveOne } from "./resolve";
import type { Res } from "./resolve";
import { DEFAULT_DEPTH, MAX_DEPTH, buildSituation, parseAt, parseWindow, writeSituation } from "./situation";

type Origin = "things" | "record" | "resolver" | "past";
interface Found {
  res: Res;
  origin: Origin;
}

// ── where RES come from ──────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function asRes(v: unknown): Res | null {
  if (!isObj(v) || typeof v.id !== "string") return null;
  const p = parseSubject(v.id);
  if (!p) return null;
  return { ...(v as unknown as Res), kind: typeof v.kind === "string" ? v.kind : p.kind, title: typeof v.title === "string" ? v.title : v.id };
}

/** Every RES a things-view output holds, whatever container the view renders them in. */
export function thingsIn(out: unknown): Map<string, Res> {
  const m = new Map<string, Res>();
  const take = (c: unknown) => {
    const items = Array.isArray(c) ? c : isObj(c) ? Object.entries(c).map(([k, v]) => (isObj(v) && !("id" in v) ? { ...v, id: k } : v)) : [];
    for (const it of items) {
      const r = asRes(it);
      if (r) m.set(r.id, r);
    }
  };
  if (Array.isArray(out)) take(out);
  else if (isObj(out)) {
    const box = ["things", "res", "items", "byId"].find((k) => k in out);
    take(box ? out[box] : out);
  }
  return m;
}

function folded(r: FoldedRes): Res {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    ...(r.state ? { state: r.state } : {}),
    ...(r.parent ? { parent: r.parent } : {}),
    ...(r.links.length ? { links: r.links } : {}),
    class: r.class,
    authority: r.authority,
    data: { ...r.data, created: r.created, updated: r.updated, ...(r.flags.length ? { flags: r.flags } : {}) },
    ...(r.aliases.length ? { aliases: r.aliases } : {}),
  };
}

let registry: { origin: Origin; all: Map<string, Res>; note?: string } | null = null;
/** --at: the moment every read is cut at (epoch ms), or null for now. */
let cut: number | null = null;

/** The register: the things fold as of --at when given, else the things view when registered, else the record's own RES rows. */
async function register(): Promise<{ origin: Origin; all: Map<string, Res>; note?: string }> {
  if (registry) return registry;
  if (cut !== null) {
    registry = { origin: "past", all: thingsIn(thingsAt(cut).view) };
    return registry;
  }
  const def = await getView("things").catch(() => null);
  if (def) {
    try {
      const r = readViewDef(def);
      registry = { origin: "things", all: thingsIn(def.render(r.state as never)) };
      if (registry.all.size === 0) registry.all = thingsIn(r.state);
      return registry;
    } catch (e) {
      const all = new Map(Object.values(recordFold().res).map((r) => [r.id, folded(r)] as const));
      registry = { origin: "record", all, note: `The things view would not read (${(e as Error).message}); folded the RES rows directly.` };
      return registry;
    }
  }
  const all = new Map(Object.values(recordFold().res).map((r) => [r.id, folded(r)] as const));
  registry = { origin: "record", all, note: "The things view is not registered yet; folded the RES rows in the record directly." };
  return registry;
}

/** One RES by id or alias: the register first, then the resolver. */
async function find(idOrAlias: string): Promise<Found | null> {
  const reg = await register();
  const direct = reg.all.get(idOrAlias);
  if (direct) return { res: direct, origin: reg.origin };
  const viaAlias = [...reg.all.values()].find((r) => r.aliases?.includes(idOrAlias));
  if (viaAlias) return { res: viaAlias, origin: reg.origin };
  const recId = resolveId(idOrAlias);
  if (recId && reg.all.has(recId)) return { res: reg.all.get(recId)!, origin: reg.origin };
  if (cut !== null) return null; // the source stores hold only today
  const r = resolveOne(idOrAlias);
  return r ? { res: r, origin: "resolver" } : null;
}

// ── formatting ───────────────────────────────────────────────────────────────

let zone: string | null = null;
function when(ts: string): string {
  zone ??= (() => {
    try {
      return principalTimezone();
    } catch {
      return "UTC";
    }
  })();
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function originLine(origin: Origin, extra?: string): string {
  const said = {
    things: "From the things view.",
    record: "From the RES rows in the record.",
    resolver: "Not in the record yet. Read from its own store by the resolver, which writes nothing.",
    past: `As the record stood at ${cut === null ? "?" : when(new Date(cut).toISOString())}, from the rows it held then.`,
  }[origin];
  return extra ? `${said} ${extra}` : said;
}

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ").trimEnd()).join("\n");
}

function short(v: unknown, max = 100): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ── the timeline ─────────────────────────────────────────────────────────────

/** Every row in the local record about `id`: named on the row, or derived from it (old rows). `at` cuts it at that moment. */
export function timeline(id: string, at: number | null = cut): StatvsRow[] {
  const { rows } = scan({});
  return rows.filter((row) => indexSubject(row as never) === id && (at === null || knownAt(row, at)));
}

/** "as of <local time>" when --at is set, else "". */
const asOf = (): string => (cut === null ? "" : ` as of ${when(new Date(cut).toISOString())}`);

function describeRow(row: StatvsRow & { subject?: string; op?: string }): string {
  const d = rowPayload(row);
  const o = isObj(d) ? d : {};
  switch (row.op) {
    case "create":
      return `Created as ${o.state ?? "?"}: ${short(o.title ?? "", 70)}`;
    case "move":
      return `Moved ${o.from ?? "?"} → ${o.to ?? "?"}${o.reason ? ` (${short(o.reason, 60)})` : ""}`;
    case "retire":
      return `Retired ${o.from ?? "?"} → ${o.to ?? "?"}${o.reason ? ` (${short(o.reason, 60)})` : ""}`;
    case "set":
      return `Set ${Object.keys(o).flatMap((k) => (k === "data" && isObj(o.data) ? Object.keys(o.data) : [k])).join(", ")}`;
    case "link":
      return `Linked ${o.rel} → ${o.to}`;
    case "unlink":
      return `Unlinked ${o.rel} → ${o.to}`;
    case "observe":
      return `Observed${o.state ? ` ${o.state}` : ""}${isObj(o.data) ? ` (${Object.keys(o.data).join(", ")})` : ""}`;
  }
  if (row.stream === "move" && o.verdict) return `Move refused ${o.from ?? "?"} → ${o.to ?? "?"}: ${short(o.reason ?? "", 70)}`;
  if (row.stream === "work" && row.kind === "event") {
    const f = isObj(o.fields) ? o.fields : {};
    if (o.op === "delete") return `Work row removed (${o.src ?? "?"})`;
    const phase = typeof f.phase === "string" ? `phase ${f.phase}` : "";
    const prog = typeof f.progress === "string" ? `progress ${f.progress}` : "";
    const rest = Object.keys(f).filter((k) => k !== "phase" && k !== "progress" && k !== "updatedAt");
    const said = [phase, prog, rest.length ? `${rest.slice(0, 4).join(", ")}${rest.length > 4 ? "…" : ""}` : ""].filter(Boolean).join(" · ");
    return `Work updated${said ? `: ${said}` : ""} (${o.src ?? "?"})`;
  }
  if (row.stream === "work" && row.kind === "seed-row") return "Work row seeded";
  return row.title ? short(row.title, 90) : `${row.kind ?? "row"}`;
}

// ── commands ─────────────────────────────────────────────────────────────────

function kinds(json: boolean): void {
  const entries = Object.entries(GENERA);
  if (json) {
    console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
    return;
  }
  const rows = [["Kind", "Group", "Authority", "Class", "Key", "States", "Species"]];
  for (const [k, d] of entries) rows.push([k, d.group, d.authority, d.class, d.key, d.states.join(" "), (d.species ?? []).join(" ")]);
  console.log(`GENERA: ${entries.length} kinds\n`);
  console.log(table(rows));
}

async function get(id: string, json: boolean): Promise<number> {
  const f = await find(id);
  if (!f) {
    console.error(cut === null ? `No RES ${id}: not in the register and no source store holds it.` : `No RES ${id}${asOf()}: the record held no row defining it then.`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ origin: f.origin, ...(cut !== null ? { at: new Date(cut).toISOString() } : {}), res: f.res }, null, 2));
  else {
    console.log(originLine(f.origin));
    console.log(JSON.stringify(f.res, null, 2));
  }
  return 0;
}

async function list(kind: string, state: string | undefined, json: boolean): Promise<number> {
  if (!isKind(kind)) {
    console.error(`Unknown kind "${kind}". Run "Censvs.ts kinds" for the list.`);
    return 1;
  }
  const reg = await register();
  let items = [...reg.all.values()].filter((r) => r.kind === kind);
  let origin: Origin = reg.origin;
  let note = reg.note;
  if (!items.length && cut === null) {
    const out = resolveAll().res.filter((r) => r.kind === kind);
    if (out.length) {
      items = out;
      origin = "resolver";
      note = `No ${kind} RES in the ${reg.origin === "things" ? "things view" : "record"} yet; these come from the source stores, read by the resolver, which writes nothing.`;
    }
  }
  if (state) items = items.filter((r) => r.state === state || (r.data as { sourceState?: string } | undefined)?.sourceState === state);
  items.sort((a, b) => a.id.localeCompare(b.id));
  if (json) {
    console.log(JSON.stringify({ origin, kind, ...(state ? { state } : {}), ...(cut !== null ? { at: new Date(cut).toISOString() } : {}), count: items.length, res: items }, null, 2));
    return 0;
  }
  console.log(`${items.length} ${kind} RES${state ? ` in state ${state}` : ""}${asOf()}. ${origin === "resolver" ? note : originLine(origin, note)}`);
  if (!items.length) return 0;
  console.log("");
  console.log(table([["Id", "State", "Bucket", "Title"], ...items.map((r) => [r.id, r.state ?? "-", r.state ? bucketOf(r.kind, r.state) ?? "-" : "-", short(r.title, 80)])]));
  return 0;
}

async function show(id: string, all: boolean, json: boolean): Promise<number> {
  const f = await find(id);
  const subject = f?.res.id ?? id;
  const rows = timeline(subject);
  if (!f && !rows.length) {
    console.error(cut === null ? `No RES ${id}: not in the register, not in any source store, and no row names it.` : `No RES ${id}${asOf()}: no row the record held then defines or names it.`);
    return 1;
  }
  if (json) {
    console.log(JSON.stringify({ origin: f?.origin ?? null, ...(cut !== null ? { at: new Date(cut).toISOString() } : {}), res: f?.res ?? null, timeline: rows }, null, 2));
    return 0;
  }
  if (f) {
    const r = f.res;
    console.log(`${r.title}  (${r.id})`);
    console.log(originLine(f.origin));
    console.log("");
    const def = isKind(r.kind) ? GENERA[r.kind] : null;
    const fields: [string, string][] = [
      ["Kind", `${r.kind}${def ? ` · ${def.group} · ${def.authority}` : ""}`],
      ["State", r.state ? `${r.state} (${bucketOf(r.kind, r.state) ?? "?"})` : "-"],
      ["Class", r.class],
      ...(r.parent ? [["Parent", r.parent] as [string, string]] : []),
      ...(r.aliases?.length ? [["Aliases", r.aliases.join(", ")] as [string, string]] : []),
    ];
    for (const [k, v] of Object.entries(r.data ?? {})) fields.push([k[0]!.toUpperCase() + k.slice(1), short(v)]);
    console.log(table(fields.map(([k, v]) => [`${k}:`, v])));
    console.log("");
    console.log(`Links: ${r.links?.length ?? 0}`);
    for (const l of r.links ?? []) console.log(`  ${l.rel} → ${l.to}`);
  } else {
    console.log(`${id}`);
    console.log("No register entry or source store holds this RES; rows in the record name it.");
  }
  console.log("");
  const shown = all ? rows : rows.slice(-50);
  console.log(`Timeline: ${rows.length} row${rows.length === 1 ? "" : "s"} in the local record${asOf()}${shown.length < rows.length ? `, the last ${shown.length} shown (--all for every one)` : ""}`);
  for (const row of shown) console.log(`  ${when(row.ts)}  ${row.stream.padEnd(10)} ${describeRow(row)}  · ${row.writer}`);
  return 0;
}

async function links(id: string, json: boolean): Promise<number> {
  const f = await find(id);
  if (!f) {
    console.error(`No RES ${id}.`);
    return 1;
  }
  const reg = await register();
  const incoming: { from: string; rel: string }[] = [];
  const children: string[] = [];
  // Links into a RES can come from any noun: the register's, plus what the source stores hold (an ISA's criteria live only there).
  const everyone = new Map(reg.all);
  if (cut === null) for (const r of resolveAll().res) if (!everyone.has(r.id)) everyone.set(r.id, r);
  for (const r of everyone.values()) {
    for (const l of r.links ?? []) if (l.to === f.res.id) incoming.push({ from: r.id, rel: l.rel });
    if (r.parent === f.res.id) children.push(r.id);
  }
  const out = { id: f.res.id, origin: f.origin, ...(cut !== null ? { at: new Date(cut).toISOString() } : {}), parent: f.res.parent ?? null, out: f.res.links ?? [], in: incoming, children };
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  console.log(`${f.res.title}  (${f.res.id})`);
  console.log(originLine(f.origin));
  console.log(`Parent: ${out.parent ?? "-"}`);
  console.log(`Links out: ${out.out.length}`);
  for (const l of out.out) console.log(`  ${l.rel} → ${l.to}`);
  console.log(`Links in: ${incoming.length}`);
  for (const l of incoming) console.log(`  ${l.from} → ${l.rel}`);
  console.log(`Children: ${children.length}`);
  for (const c of children.slice(0, 50)) console.log(`  ${c}`);
  return 0;
}

function resolveCmd(args: string[]): number {
  const sources = args.flatMap((a, i) => (args[i - 1] === "--source" ? [a] : []));
  const out = resolveAll(sources.length ? { sources } : {});
  const { res, ...summary } = out;
  if (args.includes("--json")) {
    console.log(JSON.stringify(args.includes("--full") ? out : { ...summary, resTotal: res.length }, null, 2));
    return 0;
  }
  console.log(`Resolved ${res.length} RES from ${Object.keys(out.bySource).length} sources. Unmapped: ${out.unmappedTotal}. Merged across sources: ${out.merged}.`);
  console.log("Nothing was written.\n");
  const rows = [["Source", "RES", "Unmapped", "Why unmapped"]];
  for (const s of Object.keys(out.bySource)) {
    const u = out.unmapped[s];
    rows.push([s, String(out.bySource[s]), String(u?.count ?? 0), u ? Object.entries(u.reasons).map(([r, n]) => `${n}× ${r}`).join("; ") : ""]);
  }
  console.log(table(rows));
  const skipped = Object.entries(out.skipped).flatMap(([s, labels]) => Object.entries(labels).map(([l, v]) => `  ${s}/${l}: ${v.count} (${v.reason})`));
  if (skipped.length) console.log(`\nLeft out by policy:\n${skipped.join("\n")}`);
  console.log(`\nBy kind: ${Object.entries(out.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (out.aliasConflicts || out.danglingLinks) console.log(`Alias conflicts: ${out.aliasConflicts}. Links to an unknown RES: ${out.danglingLinks}.`);
  return 0;
}

function situationCmd(id: string, depthText: string | undefined, windowText: string | undefined, out: string | undefined, json: boolean): number {
  const depth = depthText === undefined ? DEFAULT_DEPTH : Number(depthText);
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    console.error(`--depth must be a whole number from 0 to ${MAX_DEPTH}, got "${depthText}".`);
    return 2;
  }
  const windowMs = windowText === undefined ? undefined : parseWindow(windowText);
  if (windowMs === null) {
    console.error(`--window must look like 24h, 90m or 2d, got "${windowText}".`);
    return 2;
  }
  if (!parseSubject(id)) {
    console.error(`"${id}" is not a RES id (<kind>:<key>).`);
    return 2;
  }
  const at = cut ?? Date.now();
  const s = buildSituation(id, { at, depth, ...(windowMs !== undefined ? { windowMs } : {}) });
  if (!s.res.some((r) => r.id === id) && !s.rows.length) {
    console.error(`No RES ${id} as of ${when(s.at)}: no row the record held then defines or names it.`);
    return 1;
  }
  const path = writeSituation(s, out ? { path: out } : {});
  const summary = { path, at: s.at, root: s.root, depth: s.depth, res: s.res.length, rows: s.rows.length, turn: s.turn ? s.turn.id : null, missing: s.missing ?? [] };
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  console.log(`Situation of ${id} as of ${when(s.at)}: ${s.res.length} RES within ${s.depth} step${s.depth === 1 ? "" : "s"}, ${s.rows.length} row${s.rows.length === 1 ? "" : "s"} since ${when(s.window.from)}, ${s.turn ? `turn ${when(s.turn.ts)}` : "no turn row"}.`);
  for (const r of s.res) console.log(`  ${r.id.padEnd(32)} ${(r.state ?? "-").padEnd(10)} ${short(r.title, 70)}`);
  if (s.missing?.length) console.log(`Linked but not defined then: ${s.missing.join(", ")}`);
  console.log(`Wrote ${path} (mode 0600).`);
  return 0;
}

const USAGE = `Usage: bun LIFEOS/CENSVS/Censvs.ts <command>
  kinds [--json]                              every GENERA kind
  get <id> [--at T] [--json]                  one RES
  list <kind> [--state s] [--at T] [--json]   every RES of a kind
  show <id> [--at T] [--all] [--json]         fields, links and the row timeline
  links <id> [--at T] [--json]                links out and in, parent and children
  situation <id> [--at T] [--depth N] [--window 24h] [--out file] [--json]
                                              the connected situation at T, written as one JSON file
  resolve [--json] [--full] [--source X]...   map every source store to RES, writing nothing
T is an ISO time with a zone, a local "YYYY-MM-DD HH:mm", or a local HH:mm today, in the principal's zone.`;

const VALUE_FLAGS = new Set(["--state", "--source", "--at", "--depth", "--window", "--out"]);

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  const pos = rest.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(rest[i - 1] ?? ""));
  const flag = (n: string) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  registry = null;
  cut = null;
  const atText = flag("--at");
  if (rest.includes("--at")) {
    const ms = atText === undefined ? null : parseAt(atText);
    if (ms === null) {
      console.error(`--at needs a time: an ISO time with a zone, a local "YYYY-MM-DD HH:mm", or a local HH:mm today; got "${atText ?? ""}".`);
      return 2;
    }
    if (ms > Date.now() + 60_000) {
      console.error(`--at ${atText} is ${when(new Date(ms).toISOString())}, which has not happened yet.`);
      return 2;
    }
    cut = ms;
  }
  switch (cmd) {
    case "kinds":
      kinds(json);
      return 0;
    case "get":
      return pos[0] ? get(pos[0], json) : (console.error(USAGE), 2);
    case "list":
      return pos[0] ? list(pos[0], flag("--state"), json) : (console.error(USAGE), 2);
    case "show":
      return pos[0] ? show(pos[0], rest.includes("--all"), json) : (console.error(USAGE), 2);
    case "links":
      return pos[0] ? links(pos[0], json) : (console.error(USAGE), 2);
    case "situation":
      return pos[0] ? situationCmd(pos[0], flag("--depth"), flag("--window"), flag("--out"), json) : (console.error(USAGE), 2);
    case "resolve":
      return resolveCmd(rest);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return cmd ? 0 : 2;
    default:
      console.error(`Unknown command "${cmd}".\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
