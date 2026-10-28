#!/usr/bin/env bun

/**
 * PackageScan — the supply-chain finder: are any of our repos depending on a known-malicious npm release?
 *
 * Reads every bun.lock and package-lock.json in ~/.claude and in every repo PROJECTS.md lists, collects
 * each distinct npm name@version, and checks them in batches against OSV. A compromised package is one
 * with an OSV `MAL-` advisory (the OpenSSF malicious-packages corpus) or a GitHub advisory tagged
 * CWE-506, Embedded Malicious Code (crossenv, the ua-parser-js hijack). Ported from the playbook in Mallory's
 * compromised-package-scan skill (github.com/malloryai/marketplace): report by default, write only when
 * asked, and state coverage on every run so a partial read never reads as an all-clear.
 *
 * CLI: bun PackageScan.ts [--repo <path> ...] [--file] [--json]
 *   --repo  scan only these repos instead of ~/.claude plus every PROJECTS.md repo
 *   --file  register each finding in Achilles (source supplychain, critical); idempotent by source_ref
 *   --json  print the full report as JSON
 * Exit: 0 ran with no findings (the status line says complete or partial) · 1 findings present · 2 blocked.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { invariant } from "./Invariant.ts";

const HOME = homedir();
const CONFIG_ROOT = join(import.meta.dir, "..", "..");
const PROJECTS_MD = join(import.meta.dir, "..", "USER", "PROJECTS.md");
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const BATCH_SIZE = 1000;
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".wrangler"]);
const FALSE_VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const READ = new Set(["bun.lock", "package-lock.json"]);
const SKIPPED = new Set(["bun.lockb", "yarn.lock", "pnpm-lock.yaml"]);

export interface Pkg { name: string; version: string }
export interface Finding { repo: string; lockfile: string; name: string; version: string; advisories: string[] }
export interface Coverage {
  repos: number;
  repos_missing: string[];
  lockfiles_read: number;
  lockfiles_skipped: Record<string, number>;
  lockfiles_failed: string[];
  dirs_unreadable: number;
  packages_checked: number;
  batches_failed: number;
  advisories_unclassified: number;
}
export interface Report { status: "complete" | "partial" | "blocked"; coverage: Coverage; findings: Finding[] }

// ---------- targets ----------

export function targetsFrom(projectsMd: string): string[] {
  const re = /(?:~|\$HOME|\/Users\/[A-Za-z0-9._-]+)\/(?:Projects|LocalProjects)\/[A-Za-z0-9._-]+/g;
  const paths = [...projectsMd.matchAll(re)].map((m) => m[0].replace(/^(?:~|\$HOME|\/Users\/[A-Za-z0-9._-]+)/, HOME));
  return [...new Set([CONFIG_ROOT, ...paths])];
}

/** Lockfiles under a repo, depth-limited, never following symlinks (MEMORY and USER are symlinks into other trees). */
export function findLockfiles(root: string, depth = 0, unreadable = { n: 0 }): string[] {
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(root); } catch { unreadable.n++; return out; }
  for (const n of names) {
    const p = join(root, n);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { if (depth < MAX_DEPTH && !SKIP_DIRS.has(n)) out.push(...findLockfiles(p, depth + 1, unreadable)); }
    else if (READ.has(n) || SKIPPED.has(n)) out.push(p);
  }
  return out;
}

// ---------- lockfile parsing ----------

/** "name@1.2.3" or "@scope/name@1.2.3" → Pkg; an npm alias resolves to the real package; workspace, git and file specs are not registry releases. */
export function splitSpec(spec: string): Pkg | null {
  const alias = spec.indexOf("@npm:");
  if (alias > 0) spec = spec.slice(alias + "@npm:".length);
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at), version = spec.slice(at + 1);
  return /^\d+\.\d+\.\d+/.test(version) ? { name, version } : null;
}

/** bun.lock is JSONC: trailing commas are allowed. Each `packages` value is an array whose first element is the spec. */
export function parseBunLock(text: string): Pkg[] {
  const j = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as { packages?: Record<string, unknown[]> };
  return Object.values(j.packages ?? {}).map((v) => (Array.isArray(v) && typeof v[0] === "string" ? splitSpec(v[0]) : null)).filter((p): p is Pkg => !!p);
}

export function parsePackageLock(text: string): Pkg[] {
  const j = JSON.parse(text) as { packages?: Record<string, { version?: string; link?: boolean }>; dependencies?: Record<string, any> };
  const out: Pkg[] = [];
  if (j.packages) {
    for (const [k, v] of Object.entries(j.packages)) {
      if (!k.includes("node_modules/") || v.link || !v.version) continue; // root and workspace members are our own code
      const name = k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length);
      if (/^\d+\.\d+\.\d+/.test(v.version)) out.push({ name, version: v.version });
    }
  } else if (j.dependencies) {
    const walk = (deps: Record<string, any>) => {
      for (const [name, v] of Object.entries(deps)) {
        if (typeof v?.version === "string" && /^\d+\.\d+\.\d+/.test(v.version)) out.push({ name, version: v.version });
        if (v?.dependencies) walk(v.dependencies);
      }
    };
    walk(j.dependencies);
  }
  return out;
}

// ---------- OSV ----------

/** OSV's own malicious-package ids. GitHub's malware advisories carry a GHSA id instead, tagged CWE-506. */
export const isMalicious = (id: string) => id.startsWith("MAL-");
export const MALWARE_CWE = "CWE-506";
const CWE_CACHE = join(import.meta.dir, "..", "MEMORY", "STATE", "supplychain", "advisory-malware.json");

/**
 * Which of these advisory ids are malware. MAL- ids are by definition; every other id is fetched once and
 * classified by CWE-506 and cached; a daily run fetches new ids and rechecks clean verdicts older than 30 days.
 * Returns the malicious set and the ids it could not fetch.
 */
async function classifyIds(ids: string[]): Promise<{ malicious: Set<string>; unclassified: string[] }> {
  let cache: Record<string, { malware: boolean; checked: string }> = {};
  try { cache = JSON.parse(readFileSync(CWE_CACHE, "utf8")); } catch { /* first run */ }
  // Entries from before verdicts carried a check date are dropped and refetched once.
  for (const [id, v] of Object.entries(cache)) if (typeof v?.malware !== "boolean" || Number.isNaN(Date.parse(v.checked))) delete cache[id];
  const now = Date.now();
  // A malware verdict stands; a clean one is rechecked after 30 days in case the advisory is reclassified.
  const fresh = (id: string) => typeof cache[id] === "object" && (cache[id]!.malware || now - Date.parse(cache[id]!.checked) < FALSE_VERDICT_TTL_MS);
  const todo = ids.filter((id) => !isMalicious(id) && !fresh(id));
  const unclassified: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    while (next < todo.length) {
      const id = todo[next++]!;
      try {
        const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(String(res.status));
        const v = (await res.json()) as { database_specific?: { cwe_ids?: string[] } };
        cache[id] = { malware: (v.database_specific?.cwe_ids ?? []).includes(MALWARE_CWE), checked: new Date(now).toISOString() };
      } catch { unclassified.push(id); }
    }
  }));
  if (todo.length > unclassified.length) {
    invariant(Object.values(cache).every((v) => typeof v?.malware === "boolean" && !Number.isNaN(Date.parse(v.checked))), "advisory-malware cache holds a malformed verdict");
    mkdirSync(dirname(CWE_CACHE), { recursive: true });
    writeFileSync(`${CWE_CACHE}.tmp`, JSON.stringify(cache));
    renameSync(`${CWE_CACHE}.tmp`, CWE_CACHE);
  }
  return { malicious: new Set(ids.filter((id) => isMalicious(id) || cache[id]?.malware === true)), unclassified };
}

async function osvBatch(pkgs: Pkg[]): Promise<string[][]> {
  const res = await fetch(OSV_BATCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: pkgs.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OSV HTTP ${res.status}`);
  const j = (await res.json()) as { results: Array<{ vulns?: Array<{ id: string }> }> };
  invariant(j.results?.length === pkgs.length, "OSV querybatch returned a result count that does not match the query count");
  return j.results.map((r) => (r.vulns ?? []).map((v) => v.id));
}

// ---------- report ----------

export function statusOf(c: Coverage): Report["status"] {
  if (c.packages_checked === 0) return "blocked";
  const skipped = Object.values(c.lockfiles_skipped).reduce((a, b) => a + b, 0);
  return c.batches_failed || c.advisories_unclassified || c.dirs_unreadable || skipped || c.lockfiles_failed.length || c.repos_missing.length ? "partial" : "complete";
}

type Classify = (ids: string[]) => Promise<{ malicious: Set<string>; unclassified: string[] }>;

export const sourceRef = (f: Finding) => `supplychain:${basename(f.repo)}:${f.name}@${f.version}`;

export async function scan(targets: string[], check: (pkgs: Pkg[]) => Promise<string[][]> = osvBatch, classify: Classify = classifyIds): Promise<Report> {
  const cov: Coverage = { repos: 0, repos_missing: [], lockfiles_read: 0, lockfiles_skipped: {}, lockfiles_failed: [], dirs_unreadable: 0, packages_checked: 0, batches_failed: 0, advisories_unclassified: 0 };
  const where = new Map<string, Array<{ repo: string; lockfile: string }>>();
  for (const repo of targets) {
    if (!existsSync(repo)) { cov.repos_missing.push(repo.replace(HOME, "~")); continue; }
    cov.repos++;
    const unreadable = { n: 0 };
    const found = findLockfiles(repo, 0, unreadable);
    cov.dirs_unreadable += unreadable.n;
    for (const lf of found) {
      const n = basename(lf);
      if (SKIPPED.has(n)) { cov.lockfiles_skipped[n] = (cov.lockfiles_skipped[n] ?? 0) + 1; continue; }
      let pkgs: Pkg[];
      try { pkgs = n === "bun.lock" ? parseBunLock(readFileSync(lf, "utf8")) : parsePackageLock(readFileSync(lf, "utf8")); }
      catch { cov.lockfiles_failed.push(lf.replace(HOME, "~")); continue; }
      cov.lockfiles_read++;
      for (const p of pkgs) {
        const k = `${p.name}@${p.version}`;
        const list = where.get(k) ?? [];
        list.push({ repo, lockfile: relative(repo, lf) });
        where.set(k, list);
      }
    }
  }
  const keys = [...where.keys()];
  const hits: Array<{ p: Pkg; ids: string[] }> = [];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const chunk = keys.slice(i, i + BATCH_SIZE).map((k) => splitSpec(k)!);
    let ids: string[][];
    try { ids = await check(chunk); } catch { cov.batches_failed++; continue; }
    cov.packages_checked += chunk.length;
    chunk.forEach((p, j) => { if (ids[j]!.length) hits.push({ p, ids: ids[j]! }); });
  }
  const { malicious, unclassified } = await classify([...new Set(hits.flatMap((h) => h.ids))]);
  cov.advisories_unclassified = unclassified.length;
  const findings: Finding[] = [];
  for (const { p, ids } of hits) {
    const bad = ids.filter((x) => malicious.has(x));
    if (bad.length) for (const w of where.get(`${p.name}@${p.version}`)!) findings.push({ ...w, name: p.name, version: p.version, advisories: bad });
  }
  return { status: statusOf(cov), coverage: cov, findings };
}

async function fileFindings(findings: Finding[]): Promise<Array<{ ref: string; status: string; id: string }>> {
  const A = await import("./Achilles.ts");
  const r = A.loadRegistry();
  const out: Array<{ ref: string; status: string; id: string }> = [];
  const ctx = { riskMap: A.loadRiskMap(), kev: A.loadKev(), actor: "supplychain" };
  for (const f of findings) {
    const ref = sourceRef(f);
    const res = A.addEntry(r, {
      title: `Malicious package ${f.name}@${f.version} in ${basename(f.repo)}`,
      description: `${f.advisories.join(", ")} mark ${f.name}@${f.version} as a malicious release. It is pinned in ${f.lockfile}. Remove or upgrade it, rotate any secret the install could have read, and check the machine that installed it.`,
      source: "supplychain",
      source_ref: ref,
      category: "technical",
      severity: "critical",
      affected: [f.repo.replace(HOME, "~"), `npm:${f.name}@${f.version}`],
      links: f.advisories.map((a) => `https://osv.dev/vulnerability/${a}`),
      evidence: [`osv ${f.advisories.join(" ")} matched ${f.lockfile}`],
    }, ctx);
    out.push({ ref, ...res });
  }
  if (out.some((o) => o.status !== "exists" && o.status !== "suppressed")) A.saveRegistry(r);
  return out;
}

/** A partial or blocked filing run records why in STATVS, so reduced coverage reaches Vigil instead of passing as green. */
function noteGap(r: Report): void {
  const c = r.coverage;
  const why = [
    c.repos_missing.length && `${c.repos_missing.length} repo(s) missing on disk: ${c.repos_missing.join(", ")}`,
    Object.keys(c.lockfiles_skipped).length && `unreadable lockfile formats: ${JSON.stringify(c.lockfiles_skipped)}`,
    c.lockfiles_failed.length && `${c.lockfiles_failed.length} lockfile(s) failed to parse`,
    c.dirs_unreadable && `${c.dirs_unreadable} unreadable dir(s)`,
    c.batches_failed && `${c.batches_failed} OSV batch(es) failed`,
    c.advisories_unclassified && `${c.advisories_unclassified} advisory(ies) not classified`,
  ].filter(Boolean).join("; ");
  const ts = new Date().toISOString();
  try {
    const { writeEvent } = require("../STATVS") as typeof import("../STATVS");
    const res = writeEvent({
      source: "supplychain", ts, kind: "security", severity: r.status === "blocked" ? "medium" : "low",
      title: `Supply-chain scan ${r.status}`, summary: `Checked ${c.packages_checked} packages; not covered: ${why}`.slice(0, 1000),
      privacy_class: "personal", dedup_key: `supplychain:${r.status}:${why}:${ts.slice(0, 10)}`.slice(0, 200),
    });
    if (!res.ok) console.error(`PackageScan: STATVS refused the gap event: ${res.refused}`);
  } catch (e) { console.error(`PackageScan: could not record the gap event: ${(e as Error).message}`); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const repos = args.flatMap((a, i) => (args[i - 1] === "--repo" ? [a.replace(/^~/, HOME)] : []));
  const report = await scan(repos.length ? repos : targetsFrom(readFileSync(PROJECTS_MD, "utf8")));
  const filed = args.includes("--file") && report.findings.length ? await fileFindings(report.findings) : [];
  if (args.includes("--file") && report.status !== "complete") noteGap(report);
  if (args.includes("--json")) console.log(JSON.stringify({ ...report, filed }, null, 2));
  else {
    const c = report.coverage;
    console.log(`PackageScan ${report.status}: ${c.packages_checked} packages from ${c.lockfiles_read} lockfiles in ${c.repos} repos`);
    if (Object.keys(c.lockfiles_skipped).length) console.log(`  skipped (unreadable format): ${JSON.stringify(c.lockfiles_skipped)}`);
    if (c.lockfiles_failed.length) console.log(`  failed to parse: ${c.lockfiles_failed.join(", ")}`);
    if (c.repos_missing.length) console.log(`  repos missing on disk: ${c.repos_missing.join(", ")}`);
    if (c.dirs_unreadable) console.log(`  unreadable dirs: ${c.dirs_unreadable}`);
    if (c.batches_failed) console.log(`  OSV batches failed: ${c.batches_failed}`);
    if (c.advisories_unclassified) console.log(`  advisories not yet classified: ${c.advisories_unclassified}`);
    for (const f of report.findings) console.log(`  MALICIOUS ${f.name}@${f.version} in ${f.repo.replace(HOME, "~")}/${f.lockfile} (${f.advisories.join(", ")})`);
    for (const x of filed) console.log(`  Achilles ${x.id} ${x.status}`);
    if (!report.findings.length) console.log(report.status === "complete" ? "  No malicious packages found." : "  No malicious packages in what was read; this run did not cover everything.");
  }
  process.exit(report.findings.length ? 1 : report.status === "blocked" ? 2 : 0);
}
