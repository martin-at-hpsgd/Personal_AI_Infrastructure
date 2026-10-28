/**
 * cloudRead.ts — read the cloud record in the local row shape (migration ISA F9, ISC-168).
 *
 * The cloud record on our Cloudflare account is the authority; this is how a question gets answered from it instead
 * of from the Mac's segments. Rows come back shaped like local rows, so a reader switches by changing where it reads,
 * not how it folds:
 *
 *   id        the local id the row was written with (`src.id`, or a local-only marker's `data.source`); a withheld
 *             marker has none and is flagged instead
 *   localOnly a content-free stand-in for a row of a `ship: false` stream, whose only copy is on its machine
 *   writer    without the `@<machine>` suffix the core adds
 *   class     from the chain (`<slug>~<machine>|<app>|<class>|<date>`)
 *   rel       the local segment the row came from (`<class>/<date>/<slug>.jsonl`), with `seq` its line
 *   data      inline; a row over 4 KB keeps it in a body, fetched only when the caller asks (`withData`)
 *
 * `recordRows` is the door question readers use: the cloud plus this machine's unshipped rows, in the shape both share.
 *
 * Read-only. The read credential comes from STATVS_CORE_URL and STATVS_CORE_READ_TOKEN, or the sealed core secrets,
 * and travels only in the Authorization header.
 * @version 1.2.0
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../../TOOLS/Paths";
import { invariant } from "../../TOOLS/Invariant";
import { scan, statvsStateDir } from "./record";
import type { PrivacyClass } from "./types";

export interface CloudConn { url: string; token: string; fetch?: (input: string, init?: RequestInit) => Promise<Response> }

export interface CloudQuery {
  from?: string;
  to?: string;
  stream?: string;
  class?: PrivacyClass;
  /** A local writer name (`hook:turn-record`) is read as this machine's (`@<machine>`), as the core stores it. */
  writer?: string;
  session?: string;
  chain?: string;
  /** Time order by default with a window, ingest order otherwise (the core's own default). */
  order?: "ts" | "offset";
  /** Stop after this many rows. */
  max?: number;
  /** Fetch each body-backed row's data. Off by default: an envelope question never pays for bodies. */
  withData?: boolean;
  /** The machine a bare writer name belongs to; default this machine's, from the ship cursor. */
  machine?: string;
}

export interface CloudRow {
  id: string | null;
  ts: string;
  writer: string;
  /** The machine the row was shipped from. */
  machine: string | null;
  stream: string;
  class: string;
  app?: string;
  kind?: string;
  severity?: string;
  title?: string;
  session?: string;
  ref?: string;
  subject?: string;
  op?: string;
  flags?: string[];
  data: unknown;
  /** Set when data lives in a body that was not fetched. */
  body?: string;
  offset: number;
  chain: string;
  seq: number;
  /** The local row's own hash, as the shipper sent it. */
  srcHash: string | null;
  rel: string | null;
  withheld: boolean;
  /** A stand-in for a row of a stream that never ships (`ship: false`): the row itself exists only on its machine. */
  localOnly: boolean;
}

/** A machine id as the shipper writes it (ship.ts MACHINE_RE). */
const MACHINE = "[a-z0-9][a-z0-9_.-]{0,63}";

let pending: Promise<CloudConn> | null = null;

/** The read connection: env first, else the sealed core secrets. Looked up once per process, so concurrent reads never race the secrets module while it loads. */
export function cloudConn(): Promise<CloudConn> {
  // A failed lookup (a locked Keychain at boot) is not kept: the next read tries again.
  return (pending ??= lookupConn().catch((e) => { pending = null; throw e; }));
}

async function lookupConn(): Promise<CloudConn> {
  let url = process.env.STATVS_CORE_URL, token = process.env.STATVS_CORE_READ_TOKEN;
  // A test never reaches the live record: under bun test only an explicit connection is used (the rule lib/cloud.ts keeps).
  invariant(!(process.env.NODE_ENV === "test" && (!url || !token)), "no cloud reads under test without an explicit STATVS_CORE_URL and STATVS_CORE_READ_TOKEN");
  if (!url || !token) {
    const { openSealedFile } = await import("../../TOOLS/Secrets");
    const s = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, string>;
    url = s.STATVS_CORE_URL; token = s.STATVS_CORE_READ_TOKEN;
  }
  invariant(typeof url === "string" && /^https:\/\//.test(url) && typeof token === "string" && token.length > 0, "a cloud read needs an https URL and a read token");
  return { url: url.replace(/\/$/, ""), token };
}

/** What this machine's shipper knows: the machine id its chains carry, and the sessions it withholds whole or in part. */
export function shipState(stateDir = statvsStateDir()): { machine: string | null; withheldSessions: Set<string> } {
  const dir = join(stateDir, "ship");
  const cursors = existsSync(dir) ? readdirSync(dir).filter((f) => /^[0-9a-f]{12}\.json$/.test(f)) : [];
  const newest = cursors.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
  if (!newest) return { machine: null, withheldSessions: new Set() };
  try {
    const c = JSON.parse(readFileSync(join(dir, newest), "utf8")) as { machine?: unknown; withheld_sessions?: Record<string, unknown> };
    return {
      machine: typeof c.machine === "string" && new RegExp(`^${MACHINE}$`).test(c.machine) ? c.machine : null,
      withheldSessions: new Set(Object.keys(c.withheld_sessions ?? {})),
    };
  } catch {
    return { machine: null, withheldSessions: new Set() };
  }
}

/** `<slug>~<machine>|<app>|<class>|<date>` → the local segment path it was shipped from. A customer chain's app is a keyed token, so it has no local path here. */
export function relOfChain(chain: string): { rel: string; class: string; machine: string } | null {
  const m = new RegExp(`^([A-Za-z0-9_.-]+)~(${MACHINE})\\|([^|]+)\\|([a-z]+)\\|(\\d{4}-\\d{2}-\\d{2})$`).exec(chain);
  if (!m) return null;
  const [, slug, machine, app, cls, day] = m;
  if (app !== "-") return null;
  return { rel: `${cls}/${day}/${slug}.jsonl`, class: cls!, machine: machine! };
}

/** The chain a local segment ships under on a machine (ship.ts shipChain, for every class but customer). */
export function chainOfRel(rel: string, machine: string): string {
  const m = /^(public|system|personal)\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_.-]+)\.jsonl$/.exec(rel);
  invariant(m !== null && new RegExp(`^${MACHINE}$`).test(machine), `not a shippable segment or machine: ${rel}`);
  return `${m[3]}~${machine}|-|${m[1]}|${m[2]}`;
}

type Raw = Record<string, unknown> & { chain: string; seq: number; offset: number; ts: string; writer: string; stream: string; src?: { id?: string; hash?: string } };

function shape(r: Raw): CloudRow {
  const where = relOfChain(r.chain);
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  const localOnly = r.kind === "local-only" && !r.src;
  const markerId = localOnly ? /^statvs:(s[0-9a-f]{24}|[A-Za-z0-9_-]+)$/.exec(String((r.data as { source?: unknown } | undefined)?.source ?? ""))?.[1] : undefined;
  const at = new RegExp(`@(${MACHINE})$`).exec(r.writer);
  const cls = where?.class ?? /\|([a-z]+)\|\d{4}-\d{2}-\d{2}$/.exec(r.chain)?.[1] ?? "unknown";
  return {
    id: r.src?.id ?? markerId ?? null,
    ts: r.ts,
    writer: at ? r.writer.slice(0, at.index) : r.writer,
    machine: at?.[1] ?? where?.machine ?? null,
    stream: r.stream,
    class: cls,
    ...(str("app") ? { app: str("app") } : {}),
    ...(str("kind") ? { kind: str("kind") } : {}),
    ...(str("severity") ? { severity: str("severity") } : {}),
    ...(str("title") ? { title: str("title") } : {}),
    ...(str("session") ? { session: str("session") } : {}),
    ...(str("ref") ? { ref: str("ref") } : {}),
    ...(str("subject") ? { subject: str("subject") } : {}),
    ...(str("op") ? { op: str("op") } : {}),
    ...(Array.isArray(r.flags) ? { flags: (r.flags as unknown[]).filter((f): f is string => typeof f === "string") } : {}),
    data: r.data ?? null,
    ...(str("body") ? { body: str("body") } : {}),
    offset: r.offset,
    chain: r.chain,
    seq: r.seq,
    srcHash: r.src?.hash ?? null,
    rel: where?.rel ?? null,
    withheld: r.kind === "withheld" && !r.src,
    localOnly,
  };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rows matching the query, paged to the end or to `max`. */
export async function cloudRows(q: CloudQuery, connIn?: CloudConn): Promise<CloudRow[]> {
  const max = q.max ?? Infinity;
  if (max <= 0) return [];
  const conn = connIn ?? (await cloudConn());
  const get = conn.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const auth = { headers: { Authorization: `Bearer ${conn.token}` } };
  let writer = q.writer;
  if (writer && !writer.includes("@")) {
    const machine = q.machine ?? shipState().machine;
    invariant(machine !== null, "a bare writer name needs this machine's id, and no ship cursor names one");
    writer = `${writer}@${machine}`;
  }
  const out: CloudRow[] = [];
  const timeOrder = (q.order ?? (q.from || q.to ? "ts" : "offset")) === "ts";
  let next: string | undefined = timeOrder ? undefined : "-1";
  for (;;) {
    const p = new URLSearchParams();
    for (const k of ["from", "to", "stream", "class", "session", "chain"] as const) if (q[k]) p.set(k, q[k]!);
    if (writer) p.set("writer", writer);
    p.set("order", timeOrder ? "ts" : "offset");
    p.set("limit", String(Math.min(1000, max - out.length)));
    if (next !== undefined) p.set(timeOrder ? "next" : "after_offset", next);
    const res = await get(`${conn.url}/rows?${p}`, auth);
    if (!res.ok) throw new Error(`cloud read answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as { rows: Raw[]; next?: string };
    for (const r of page.rows) out.push(shape(r));
    if (!page.next || out.length >= max || page.rows.length === 0) break;
    next = page.next;
  }
  if (q.withData) {
    const backed = out.filter((r) => r.body);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, backed.length) }, async () => { while (next < backed.length) {
      const r = backed[next++]!;
      const res = await get(`${conn.url}/bodies/${r.body}`, auth);
      if (!res.ok) throw new Error(`cloud body ${r.body.slice(0, 12)} answered HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      invariant((await sha256Hex(bytes)) === r.body, `cloud body ${r.body.slice(0, 12)} does not hash to its name`);
      r.data = JSON.parse(new TextDecoder().decode(bytes));
      delete r.body;
    } }));
  }
  return out;
}

/** A row as a question reader folds it: the fields a local row and a cloud row share. */
export type RecordRow = Pick<CloudRow, "ts" | "writer" | "stream" | "class" | "app" | "kind" | "severity" | "title" | "session" | "ref" | "subject" | "op" | "flags" | "data"> & { id: string };

export interface RecordQuery {
  streams?: string[];
  /** Default every class but customer, which never enters the record: a customer query is refused. */
  classes?: PrivacyClass[];
  /** A UTC day, as `scan()` takes it. The cloud windows by stated time; a row stating a time before its write day is
   *  found only through this machine's line, so windowed reads lose such rows once local lines go (ISC-178 has the cure). */
  fromDate?: string;
  /** This machine's rows only: a question about this Mac's own views (compare --days). */
  thisMachine?: boolean;
  withData?: boolean;
}
export interface RecordRead { rows: RecordRow[]; problems: string[]; from: "cloud" | "local" }

const RECORD_CLASSES: PrivacyClass[] = ["public", "system", "personal"];

/**
 * The question readers' one door (ISC-179): the cloud's rows, plus this machine's rows the cloud does not hold yet
 * (the outbox: written since the last ship run, a withheld session's, a `ship: false` stream's), in time order.
 * A cloud that cannot be reached leaves this machine's rows, and `problems` says so. `local` reads this machine
 * only, and so does a `dir` (a record other than the live one has no cloud).
 */
export async function recordRows(q: RecordQuery, opts: { local?: boolean; dir?: string; conn?: CloudConn; machine?: string } = {}): Promise<RecordRead> {
  const classes = q.classes ?? RECORD_CLASSES;
  invariant(!classes.includes("customer" as PrivacyClass), "customer rows never enter the record, so no question reads them");
  const mine = scan({ ...(q.streams ? { streams: q.streams } : {}), classes, ...(q.fromDate ? { fromDate: q.fromDate } : {}), ...(opts.dir ? { dir: opts.dir } : {}) });
  const problems = [...(mine.problems ?? [])];
  const byTime = (rows: RecordRow[]) => rows.map((r, i) => ({ r, i, t: Date.parse(r.ts) })).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.r);
  if (opts.local || opts.dir) return { rows: mine.rows, problems, from: "local" };
  const machine = opts.machine ?? shipState().machine;
  let cloud: (RecordRow & { machine: string | null })[];
  try {
    const from = q.fromDate ? `${q.fromDate}T00:00:00.000Z` : undefined;
    const parts = await Promise.all((q.streams ?? [undefined]).flatMap((stream) => classes.map((cls) =>
      cloudRows({ ...(stream ? { stream } : {}), class: cls, ...(from ? { from } : {}), withData: q.withData ?? true }, opts.conn))));
    // Markers stand in for rows that exist only here; the local line is the row. A row written in the cloud has no local id.
    cloud = parts.flat().filter((r) => !r.withheld && !r.localOnly && (!q.thisMachine || r.machine === machine)).map((r) => ({ ...r, id: r.id ?? `${r.chain}#${r.seq}` }));
  } catch (e) {
    problems.push(`cloud record unreachable (${(e as Error).message.slice(0, 120)}); this machine's rows only`);
    return { rows: mine.rows, problems, from: "local" };
  }
  // Only this machine's cloud copies stand for its lines: another machine can write the same id in the same millisecond.
  const have = new Set(cloud.filter((r) => r.machine === machine).map((r) => r.id));
  return { rows: byTime([...cloud, ...mine.rows.filter((r) => !have.has(r.id))]), problems, from: "cloud" };
}
