#!/usr/bin/env bun
/**
 * STATVS core subject backfill — fills the index's subject column for rows written before schema v4 (CENSVS ISA F4,
 * ISC-24).
 *
 * Old rows are never rewritten. Their subject is derived by lib/subject.ts deriveSubject(), the same resolver the live
 * index and tools/rebuild.ts use, and written only into the index, which is a rebuildable view of the R2 segments.
 * For each index database it reads the rows whose subject is still NULL in the streams deriveSubject can name, derives
 * a subject for each, and with --apply runs only
 *   UPDATE rows SET subject = ? WHERE shard = ? AND ingest_offset = ? AND subject IS NULL
 * in batches. Without --apply (the default) it is a dry run: it reads and reports what it would set, and writes nothing.
 * It never writes the record: a `work` row's subject is read from its payload, which the index does not hold, so those
 * rows are fetched read-only through the Worker's GET /rows with the read token. Rerunning is safe: a row already
 * filled is skipped by `subject IS NULL`.
 *
 * Library: backfillSubjects({ db, fullRows, apply }) over any D1-shaped database (the Worker binding, bun:sqlite in
 * tests, or cfD1() below, which runs `d1 query` through CfEnv.ts, the one Cloudflare credential path).
 *
 * CLI: bun LIFEOS/STATVS/core/tools/backfill-subject.ts (--db YYYY-MM[/n] | --all) [--apply] [--json]
 *   Databases come from USER/STATVS/core-worker.json (STATVS_CORE_WORKER_CONFIG overrides); the Worker URL and read
 *   token from STATVS_CORE_URL and STATVS_CORE_READ_TOKEN, else the sealed core secrets (as witness.ts reads them).
 *
 * @version 0.1.0
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../../../TOOLS/Invariant";
import { deriveSubject, DERIVABLE_STREAMS, PAYLOAD_STREAMS, subjectProblem, type SubjectSource } from "../lib/subject";
import type { D1Like, D1Statement } from "../worker/src/index-store";

export interface BackfillOptions {
  /** One index database. */
  db: D1Like;
  shard?: string;
  /** Full rows (with their payload) for these ingest offsets; called only for rows of PAYLOAD_STREAMS. */
  fullRows: (offsets: number[]) => Promise<Map<number, SubjectSource>>;
  /** Write the subjects; false (the default) only reports. */
  apply?: boolean;
  /** Index rows read per page (default 1000). */
  pageSize?: number;
  /** UPDATE statements per batch (default 100). */
  batchSize?: number;
}

export interface BackfillResult {
  apply: boolean;
  /** Index rows read with no subject, in the derivable streams. */
  scanned: number;
  /** Of those, rows a subject was derived for. */
  derived: number;
  /** Rows the UPDATEs changed (0 in a dry run). */
  updated: number;
  /** Derived subjects per RES kind. */
  byKind: Record<string, number>;
  /** Payload rows the Worker did not return; they stay NULL and a rerun picks them up. */
  unread: number;
}

type Candidate = { ingest_offset: number; stream: string; kind: string | null; app: string | null; session: string | null };

export const UPDATE_SQL = "UPDATE rows SET subject = ? WHERE shard = ? AND ingest_offset = ? AND subject IS NULL";

/** Derive and (with apply) write the subject of every pre-v4 row in one index database that has none yet. */
export async function backfillSubjects(opts: BackfillOptions): Promise<BackfillResult> {
  const shard = opts.shard ?? "main";
  const pageSize = opts.pageSize ?? 1000;
  const batchSize = opts.batchSize ?? 100;
  invariant(Number.isInteger(pageSize) && pageSize > 0 && Number.isInteger(batchSize) && batchSize > 0, "page and batch sizes are positive integers");
  const result: BackfillResult = { apply: opts.apply === true, scanned: 0, derived: 0, updated: 0, byKind: {}, unread: 0 };
  const streams = DERIVABLE_STREAMS;
  const select = `SELECT ingest_offset, stream, kind, app, session FROM rows WHERE shard = ? AND subject IS NULL AND stream IN (${streams.map(() => "?").join(", ")}) AND ingest_offset > ? ORDER BY ingest_offset LIMIT ?`;
  let after = -1;
  for (;;) {
    const page = (await opts.db.prepare(select).bind(shard, ...streams, after, pageSize).all<Candidate>()).results;
    if (page.length === 0) break;
    after = page[page.length - 1]!.ingest_offset;
    result.scanned += page.length;
    const needPayload = page.filter((c) => PAYLOAD_STREAMS.includes(c.stream)).map((c) => c.ingest_offset);
    const full = needPayload.length > 0 ? await opts.fullRows(needPayload) : new Map<number, SubjectSource>();
    const plan: { offset: number; subject: string }[] = [];
    for (const c of page) {
      let source: SubjectSource | undefined = c;
      if (PAYLOAD_STREAMS.includes(c.stream)) {
        source = full.get(c.ingest_offset);
        if (!source) { result.unread++; continue; }
        invariant(source.stream === c.stream, `the row fetched for offset ${c.ingest_offset} is in stream ${source.stream}, the index says ${c.stream}`);
      }
      const subject = deriveSubject(source);
      if (subject === null) continue;
      plan.push({ offset: c.ingest_offset, subject });
      result.derived++;
      const kind = subject.slice(0, subject.indexOf(":"));
      result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
    }
    if (opts.apply) {
      for (let i = 0; i < plan.length; i += batchSize) {
        const stmts = plan.slice(i, i + batchSize).map((p) => {
          // Only a subject the intake would accept reaches the index, and only into a NULL slot of this shard.
          invariant(subjectProblem(p.subject) === null, `derived subject ${p.subject} would be refused at intake`);
          invariant(Number.isInteger(p.offset) && p.offset >= 0, `offset ${p.offset} is not an ingest offset`);
          return opts.db.prepare(UPDATE_SQL).bind(p.subject, shard, p.offset);
        });
        result.updated += await runBatch(opts.db, stmts);
      }
    }
    if (page.length < pageSize) break;
  }
  return result;
}

async function runBatch(db: D1Like, stmts: D1Statement[]): Promise<number> {
  if (db.batch) {
    const out = (await db.batch(stmts)) as { meta?: { changes?: number } }[] | undefined;
    // The batch already ran, so its own report is the only honest count; one without it fails loud rather than guess.
    if (!(Array.isArray(out) && out.length === stmts.length && out.every((r) => typeof r?.meta?.changes === "number"))) {
      throw new Error(`a batch of ${stmts.length} updates ran but did not report its changes; rerun with a database that does (the updates are idempotent)`);
    }
    return out.reduce((n, r) => n + r.meta!.changes!, 0);
  }
  let n = 0;
  for (const s of stmts) n += (await s.run()).meta?.changes ?? 0;
  return n;
}

// ── CLI adapters ──

/**
 * A D1 database reached through CfEnv.ts `d1 query` (the one Cloudflare credential path). Each prepare().all() or
 * run() is one query; batch() sends one batch request. Not verified against the live API in tests: the dry run is the
 * first live call, and it only reads.
 */
export function cfD1(databaseId: string, cfenv = join(import.meta.dir, "../../../TOOLS/CfEnv.ts")): D1Like {
  invariant(/^[0-9a-f-]{36}$/i.test(databaseId), "a D1 database id is a UUID");
  const query = (body: unknown): unknown[] => {
    const r = spawnSync("bun", [cfenv, "d1", "query", databaseId, "--body", JSON.stringify(body)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`d1 query on ${databaseId} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").slice(0, 400)}`);
    const text = r.stdout ?? "";
    const start = text.search(/[[{]/);
    if (start < 0) throw new Error(`d1 query on ${databaseId} printed no JSON`);
    const parsed = JSON.parse(text.slice(start)) as unknown;
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { result?: unknown }).result) ? (parsed as { result: unknown[] }).result : [parsed];
    return list;
  };
  const statement = (sql: string): D1Statement & { body(): { sql: string; params: unknown[] } } => {
    let params: unknown[] = [];
    const st = {
      bind(...v: unknown[]) { params = v; return st; },
      body: () => ({ sql, params }),
      async first<T>() { return ((await st.all<T>()).results[0] ?? null) as T | null; },
      async all<T>() { const [r] = query({ sql, params }) as { results?: T[] }[]; return { results: r?.results ?? [] }; },
      async run() { const [r] = query({ sql, params }) as { meta?: { changes?: number } }[]; return { results: [] as never[], meta: { changes: r?.meta?.changes } }; },
    };
    return st;
  };
  return {
    prepare: statement,
    async batch(stmts: D1Statement[]) {
      return query({ batch: stmts.map((s) => (s as ReturnType<typeof statement>).body()) });
    },
  };
}

/** Full rows of the payload streams, fetched read-only from the Worker in ingest order and kept by offset. */
export function workerRows(url: string, token: string, fetchImpl: typeof fetch = fetch): (offsets: number[]) => Promise<Map<number, SubjectSource>> {
  let all: Map<number, SubjectSource> | null = null;
  return async (offsets) => {
    if (!all) {
      all = new Map();
      for (const stream of PAYLOAD_STREAMS) {
        let next: string | undefined = "-1";
        while (next !== undefined) {
          const res = await fetchImpl(`${url.replace(/\/$/, "")}/rows?stream=${encodeURIComponent(stream)}&order=offset&limit=1000&after_offset=${next}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) throw new Error(`GET /rows?stream=${stream} answered HTTP ${res.status}`);
          const page = (await res.json()) as { rows: (SubjectSource & { offset: number })[]; next?: string };
          for (const r of page.rows) all.set(r.offset, r);
          next = page.next;
        }
      }
    }
    return new Map(offsets.filter((o) => all!.has(o)).map((o) => [o, all!.get(o)!]));
  };
}

/** Index databases from core-worker.json, keyed "YYYY-MM" or "YYYY-MM/<n>". */
export function configuredDatabases(path: string): Map<string, string> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { index?: { month?: unknown; part?: unknown; id?: unknown }[] };
  const out = new Map<string, string>();
  for (const x of raw.index ?? []) {
    invariant(typeof x.month === "string" && typeof x.id === "string", `${path}: every index entry has a month and an id`);
    const part = typeof x.part === "number" ? x.part : 1;
    out.set(part === 1 ? x.month : `${x.month}/${part}`, x.id);
  }
  return out;
}

if (import.meta.main) {
  const { lifeosPath } = await import("../../../TOOLS/Paths");
  const args = process.argv.slice(2);
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const apply = args.includes("--apply"), json = args.includes("--json");
  const dbs = configuredDatabases(process.env.STATVS_CORE_WORKER_CONFIG || lifeosPath("USER", "STATVS", "core-worker.json"));
  const one = flag("db");
  const keys = args.includes("--all") ? [...dbs.keys()] : one ? [one] : [];
  if (keys.length === 0 || keys.some((k) => !dbs.has(k))) {
    console.error(`usage: backfill-subject.ts (--db <${[...dbs.keys()].join("|")}> | --all) [--apply] [--json]`);
    process.exit(2);
  }
  let url = process.env.STATVS_CORE_URL, token = process.env.STATVS_CORE_READ_TOKEN;
  if (!url || !token) {
    const { openSealedFile } = await import("../../../TOOLS/Secrets");
    const s = JSON.parse(new TextDecoder().decode(openSealedFile(lifeosPath("USER", "STATVS", "core-secrets.json.age")))) as Record<string, string>;
    url = s.STATVS_CORE_URL; token = s.STATVS_CORE_READ_TOKEN;
  }
  const fullRows = workerRows(url!, token!);
  const report: Record<string, BackfillResult> = {};
  for (const k of keys) {
    report[k] = await backfillSubjects({ db: cfD1(dbs.get(k)!), fullRows, apply });
    if (!json) {
      const r = report[k]!;
      console.log(`${k}: ${r.scanned} rows without a subject, ${r.derived} derived (${Object.entries(r.byKind).map(([kind, n]) => `${kind} ${n}`).join(", ") || "none"}), ${apply ? `${r.updated} updated` : "dry run, nothing written"}${r.unread ? `, ${r.unread} payload rows unread` : ""}.`);
    }
  }
  if (json) console.log(JSON.stringify(report));
}
