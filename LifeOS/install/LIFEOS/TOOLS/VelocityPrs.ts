#!/usr/bin/env bun
/**
 * VelocityPrs — Velocity PRs collector.
 *
 * Counts merged pull requests per repo per week, over the same repos and window
 * deeds.json covers, so the Velocity PRs view can sit beside Deeds and Commits.
 *
 * Reads  MEMORY/STATE/velocity/deeds.json  (repo list, owner, window start; written by VelocityDeeds.ts)
 * Writes MEMORY/STATE/velocity/prs.json    { generated, since, repos: [{ repo, ok, merged, weeks: [{ week, merged }], error? }] }
 *
 * Weeks start Monday in UTC, the same as deeds. A repo gh cannot read (non-zero exit, empty
 * or malformed output) is recorded with ok:false and an error, never dropped, so both views
 * list the same repos, and the CLI exits 2 when any repo was unreadable.
 * Only PR numbers and merge timestamps are requested; no diff leaves GitHub.
 *
 * Env (tests): VELOCITY_STATE_DIR overrides the state dir, VELOCITY_GH_BIN the gh binary.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "./Invariant";
import { getMemoryDir } from "./Paths";
import { windowStart } from "./VelocityDeeds";

export type GhRunner = (args: string[]) => Promise<string>;
export interface PrWeek { week: string; merged: number }
export interface PrRepo { repo: string; ok: boolean; merged: number; weeks: PrWeek[]; error?: string }
export interface PrsFile { generated: string; since: string; repos: PrRepo[] }

/** Monday of the UTC week containing `iso`, as YYYY-MM-DD (same rule as deeds' weekOf). */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** deeds.json `since` is a date, "N days ago", or deeds' own shorthand (90d, 2w, 6m, 1y, all); gh's merged: qualifier needs a date. */
export function resolveSince(since: string, now = Date.now()): string {
  const s = since.trim();
  if (/^\d{4}-\d\d-\d\d/.test(s)) return s.slice(0, 10);
  if (s === "all" || /^\d+[dwmy]$/.test(s)) return windowStart(s, new Date(now)).toISOString().slice(0, 10);
  const m = s.match(/^(\d+)\s*(?:d|days?)(?:\s+ago)?$/i);
  if (m) return new Date(now - Number(m[1]) * 86_400_000).toISOString().slice(0, 10);
  throw new Error(`cannot resolve window start from since=${JSON.stringify(since)}`);
}

/** One merged pull request as `gh pr list --state merged --json number,mergedAt` prints it. */
export type MergedPr = { number: number; mergedAt: string };

/** True only for a merged-PR record: a positive integer number and a mergedAt that parses as a timestamp. */
function isMergedPr(p: unknown): p is MergedPr {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  return Number.isInteger(o.number) && (o.number as number) > 0
    && typeof o.mergedAt === "string" && Number.isFinite(Date.parse(o.mergedAt));
}

/**
 * The merged-PR list from gh stdout. gh prints "[]" for a repo with no merged PRs, so empty stdout,
 * unparseable JSON, a non-array, or any entry that is not a merged PR (`{}`, `[]`, an error object like
 * `{"message":"rate limited"}`, a missing or unparseable mergedAt) means the read failed, never "zero PRs".
 */
export function parsePrList(raw: string): MergedPr[] {
  if (!raw.trim()) throw new Error("gh returned empty output (expected a JSON array)");
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error("gh returned unparseable output (expected a JSON array)"); }
  if (!Array.isArray(v)) throw new Error("gh returned JSON that is not an array of pull requests");
  const bad = v.findIndex((p) => !isMergedPr(p));
  if (bad !== -1) throw new Error(`gh returned an entry that is not a merged pull request (index ${bad}: needs an integer number and a mergedAt timestamp)`);
  return v as MergedPr[];
}

/** Bucket merged PRs into Monday weeks, dropping any merged before the window opened. */
export function mergedWeeks(prs: { mergedAt?: string | null }[], since: string): PrWeek[] {
  const counts = new Map<string, number>();
  for (const p of prs) {
    if (!p.mergedAt || p.mergedAt.slice(0, 10) < since) continue;
    const w = weekOf(p.mergedAt);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([week, merged]) => ({ week, merged }));
}

function defaultStateDir(): string {
  return process.env.VELOCITY_STATE_DIR || join(getMemoryDir(), "STATE", "velocity");
}

function defaultGh(): GhRunner {
  const bin = process.env.VELOCITY_GH_BIN || "gh";
  return async (args) => {
    const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error((err.trim() || `gh exited ${code}`).split("\n")[0]);
    return out;
  };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function collectPrs(opts: { stateDir?: string; gh?: GhRunner; now?: number } = {}): Promise<PrsFile> {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const gh = opts.gh ?? defaultGh();
  const now = opts.now ?? Date.now();

  const deedsPath = join(stateDir, "deeds.json");
  if (!existsSync(deedsPath)) throw new Error(`${deedsPath} not found: run VelocityDeeds.ts first`);
  const deeds = JSON.parse(readFileSync(deedsPath, "utf8"));
  if (!Array.isArray(deeds.repos) || typeof deeds.since !== "string") throw new Error("deeds.json has no repos list or since");
  const since = resolveSince(deeds.since, now);
  const owner: string = deeds.owner ?? "";

  const names: string[] = deeds.repos.map((r: { repo: string }) => r.repo);
  const repos = await pool(names, 6, async (repo): Promise<PrRepo> => {
    const slug = repo.includes("/") ? repo : `${owner}/${repo}`;
    try {
      const raw = await gh([
        "pr", "list", "--state", "merged", "--repo", slug,
        "--search", `merged:>=${since}`, "--json", "number,mergedAt", "--limit", "5000",
      ]);
      const weeks = mergedWeeks(parsePrList(raw), since);
      return { repo, ok: true, merged: weeks.reduce((n, w) => n + w.merged, 0), weeks };
    } catch (e) {
      return { repo, ok: false, merged: 0, weeks: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  const file: PrsFile = { generated: new Date(now).toISOString(), since, repos };
  invariant(file.repos.length === names.length, "prs.json must list exactly the repos deeds.json lists");
  invariant(file.repos.every((r) => r.merged === r.weeks.reduce((n, w) => n + w.merged, 0)), "a repo's merged total equals the sum of its weeks");
  mkdirSync(stateDir, { recursive: true });
  const tmp = join(stateDir, `prs.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, join(stateDir, "prs.json"));
  return file;
}

if (import.meta.main) {
  try {
    const t0 = Date.now();
    const out = await collectPrs();
    const failed = out.repos.filter((r) => !r.ok).length;
    const total = out.repos.reduce((n, r) => n + r.merged, 0);
    console.log(`[VelocityPrs] ${out.repos.length} repos (${failed} unreadable) · ${total} merged PRs since ${out.since} · ${Date.now() - t0} ms`);
    // Partial is not success: exit 2 so the nightly parent (ShippingVelocity) sees a run that could not read everything.
    if (failed) {
      // Names only: gh's error text can carry a credential, so it stays in prs.json and never reaches the console.
      console.error(`[VelocityPrs] ${failed} repo(s) unreadable: ${out.repos.filter((r) => !r.ok).map((r) => r.repo).join(", ")}`);
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`[VelocityPrs] ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
