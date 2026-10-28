#!/usr/bin/env bun
/**
 * Coverage: does a system, app or site report into STATVS? Counts the rows on each required stream
 * that are about the subject, and says none, partial or full. Read-only; the Statvs skill's Coverage
 * intent and the follow-up workflows that wait on an app reporting in both run it.
 *
 *   bun LIFEOS/STATVS/tools/Coverage.ts --app <name> [--match <regex>] [--streams deploy,app-health] [--json]
 *
 * A row counts when it is on one of the streams AND it belongs to the subject: its `app` is <name>,
 * its writer is `app:<name>`, or its title, ref or data matches --match (case-insensitive). Rows on
 * other streams never count, so a work item that names the site is a mention, not the site reporting in.
 * Segments are read under every privacy class except other apps' `customer/<app>/` directories.
 *
 * stdout (--json): { app, streams: { <s>: { rows, last, writers } }, state: "none"|"partial"|"full" }
 * Exit: 0 report printed, 2 usage error.
 *
 * @version 1.0.0
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { statvsDir } from "../lib/record";

type StreamStat = { rows: number; last: string | null; writers: string[] };
export type CoverageReport = { app: string; streams: Record<string, StreamStat>; state: "none" | "partial" | "full" };

function segments(root: string, app: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (depth === 0 && name === "objects") continue;
        // customer/<app>/…: read only the subject's own app directory.
        if (depth === 1 && dir.endsWith(`${"/"}customer`) && name !== app) continue;
        walk(p, depth + 1);
      } else if (name.endsWith(".jsonl")) out.push(p);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out;
}

/** This Mac's segments as rows, until they are retired (migration ISA F9). */
function* localRows(root: string, app: string): Generator<any> {
  for (const file of segments(root, app)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try { yield JSON.parse(line); } catch { /* a torn line is not a row */ }
    }
  }
}

/** The verdict over any rows, from either copy. */
export function coverageOf(app: string, streams: string[], match: RegExp | null, rows: Iterable<any>): CoverageReport {
  const stats: Record<string, StreamStat> = {};
  const writers: Record<string, Set<string>> = {};
  for (const s of streams) { stats[s] = { rows: 0, last: null, writers: [] }; writers[s] = new Set(); }
  {
    for (const row of rows) {
      const st = stats[row?.stream];
      if (!st) continue;
      const own = row.app === app || row.writer === `app:${app}`;
      const about = match !== null && match.test(JSON.stringify([row.title ?? "", row.ref ?? "", row.data ?? null]));
      if (!own && !about) continue;
      st.rows++;
      if (typeof row.ts === "string" && (st.last === null || row.ts > st.last)) st.last = row.ts;
      if (typeof row.writer === "string") writers[row.stream]!.add(row.writer);
    }
  }
  for (const s of streams) stats[s]!.writers = [...writers[s]!].sort();
  const covered = streams.filter((s) => stats[s]!.rows > 0).length;
  return { app, streams: stats, state: covered === 0 ? "none" : covered === streams.length ? "full" : "partial" };
}

export function coverage(app: string, streams: string[], match: RegExp | null, root = statvsDir()): CoverageReport {
  return coverageOf(app, streams, match, localRows(root, app));
}

/**
 * The same verdict from the cloud record, the authority (migration ISA ISC-170). Customer-class rows never enter the
 * record (the cloud holds only content-free markers for them), so this machine's own customer/<app>/ rows are added.
 */
export async function coverageCloud(app: string, streams: string[], match: RegExp | null, root = statvsDir()): Promise<CoverageReport> {
  const { cloudRows } = await import("../lib/cloudRead");
  const rows: any[] = [];
  for (const stream of streams) rows.push(...(await cloudRows({ stream, withData: match !== null })));
  const customer = join(root, "customer", app);
  if (existsSync(customer)) for (const r of localRows(customer, app)) rows.push(r);
  return coverageOf(app, streams, match, rows);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const app = flag("app");
  if (!app || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(app)) {
    console.error("usage: Coverage.ts --app <name> [--match <regex>] [--streams deploy,app-health] [--local] [--json]");
    process.exit(2);
  }
  const streams = (flag("streams") ?? "deploy,app-health").split(",").map((s) => s.trim()).filter(Boolean);
  let match: RegExp | null = null;
  try { match = flag("match") ? new RegExp(flag("match")!, "i") : null; } catch (e) { console.error(`bad --match: ${(e as Error).message}`); process.exit(2); }
  // The cloud record answers by default; --local reads this Mac's segments until they are retired.
  const r = args.includes("--local") ? coverage(app, streams, match) : await coverageCloud(app, streams, match);
  if (args.includes("--json")) console.log(JSON.stringify(r));
  else {
    console.log(`${r.app}: ${r.state}`);
    for (const [s, v] of Object.entries(r.streams)) console.log(`  ${s}: ${v.rows} rows${v.last ? `, last ${v.last}` : ""}${v.writers.length ? ` (${v.writers.join(", ")})` : ""}`);
  }
}
