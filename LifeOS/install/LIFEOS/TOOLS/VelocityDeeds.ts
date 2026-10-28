#!/usr/bin/env bun
/**
 * VelocityDeeds.ts — the Velocity deeds collector: caps, fixes and tends for every tracked repo,
 * from the `deeds` CLI, written to MEMORY/STATE/velocity/deeds.json for the Pulse /velocity Deeds view.
 *
 *   bun LIFEOS/TOOLS/VelocityDeeds.ts            # discover the repo set, run deeds on each, write deeds.json
 *   bun LIFEOS/TOOLS/VelocityDeeds.ts --print    # also print one line per repo
 *
 * Reads the `deeds` block of USER/CONFIG/velocity.json: { owner, since, exclude[], roots[], clone_dir, limit }.
 * The repo set is the owner's GitHub repos pushed inside the window, minus forks and the exclusion list.
 * A repo with a local checkout under `roots` is read there after a fetch and fast-forward; a public repo
 * without one goes to deeds as github.com/<owner>/<repo>; a private repo without one is shallow-cloned into
 * `clone_dir`. Deeds caches every judged commit by sha, so an hourly run only pays for new commits.
 *
 * Privacy: the exclusion list is the only thing standing between a private tree and a model call, so a
 * config without it refuses to run. Nothing here names a repo, an owner or a path; all of it is USER config.
 * Ships publicly: no identity here.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { invariant } from "./Invariant";
import { confinedPath } from "./lib/Boundary";
import { getClaudeDir, getMemoryDir, lifeosPath } from "./Paths";

const HOME = homedir();
const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const tilde = (p: string) => (p.startsWith(HOME + sep) ? "~" + p.slice(HOME.length) : p);
const realOr = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

// ---------- types ----------

export interface DeedsConfig {
  owner: string;
  /** deeds' own window: 7d, 2w, 6m, 1y, all, or anything git understands. */
  since: string;
  /** Regexes matched against the GitHub repo name. A match is never targeted, never sent to a model. */
  exclude: string[];
  /** Where local checkouts live. Separate from the Commits view's roots on purpose. */
  roots: string[];
  /** Where private repos without a local checkout are shallow-cloned. */
  clone_dir: string;
  /** gh repo list --limit. */
  limit: number;
}

export interface RepoTarget { owner: string; name: string; public: boolean; defaultBranch: string }

export interface OkEntry {
  repo: string; target: string; ok: true;
  commits: number; judged: number; cached: number; notJudged: number;
  totals: { cap: number; fix: number; tend: number };
  weeks: { week: string; cap: number; fix: number; tend: number }[];
  caps: { name: string; change: string; sha: string; author: string; date: string }[];
}
export interface FailEntry { repo: string; target: string; ok: false; error: { code: string; message: string } }
export type Entry = OkEntry | FailEntry;
export interface DeedsFile { generated: string; since: string; owner: string; repos: Entry[] }

export interface CollectOptions {
  config: DeedsConfig;
  stateDir: string;
  deedsBin: string;
  ghBin: string;
  /** Turn a target into what `deeds analyze` is given. Defaults to the checkout / public URL / private clone rule. */
  prepare?: (t: RepoTarget) => string;
  /** Wall-clock budget for the whole run; repos still waiting when it ends are recorded as failed. */
  maxMs?: number;
  onEntry?: (e: Entry) => void;
}

class TypedError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

// ---------- config ----------

/** Deeds is opt-in: its absence means the install has not configured model-bound analysis yet. */
export function hasDeedsConfig(path: string): boolean {
  if (!existsSync(path)) return false;
  return Object.hasOwn(JSON.parse(readFileSync(path, "utf-8")), "deeds");
}

export function loadDeedsConfig(path: string, ghBin: string): DeedsConfig {
  const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
  const d = (doc.deeds ?? {}) as Partial<DeedsConfig>;
  // A missing exclusion list would send private trees to a model. Fail loud, never default to "none".
  invariant(Array.isArray(d.exclude) && d.exclude.length > 0, "velocity.json deeds.exclude must list the repos that never go to a model");
  let owner = d.owner;
  if (!owner) {
    const r = Bun.spawnSync([ghBin, "api", "user", "--jq", ".login"], { timeout: 30_000 });
    owner = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  }
  invariant(owner, "velocity.json deeds.owner is unset and gh could not name the signed-in user");
  return {
    owner, since: d.since ?? "90d", exclude: d.exclude, roots: d.roots ?? doc.roots ?? ["~/Projects"],
    clone_dir: d.clone_dir ?? "~/.cache/deeds/private", limit: d.limit ?? 300,
  };
}

// ---------- discovery ----------

/** Start of the window as a Date. Accepts deeds' own shorthand (90d, 2w, 6m, 1y, all) or any date git understands. */
export function windowStart(since: string, now: Date = new Date()): Date {
  if (since === "all") return new Date(0);
  const m = /^(\d+)([dwmy])$/.exec(since);
  if (m) {
    const d = new Date(now);
    const n = +m[1]!;
    if (m[2] === "d") d.setUTCDate(d.getUTCDate() - n);
    else if (m[2] === "w") d.setUTCDate(d.getUTCDate() - 7 * n);
    else if (m[2] === "m") d.setUTCMonth(d.getUTCMonth() - n);
    else d.setUTCFullYear(d.getUTCFullYear() - n);
    return d;
  }
  const t = Date.parse(since);
  invariant(!Number.isNaN(t), `unreadable deeds window: ${since}`);
  return new Date(t);
}

interface GhRepo { name: string; isPrivate: boolean; isFork: boolean; isArchived: boolean; pushedAt: string; defaultBranchRef?: { name: string } | null }

/** The owner's repos with a push inside the window, minus forks and the exclusion list. */
export function discoverTargets(cfg: DeedsConfig, ghBin: string, now: Date = new Date()): RepoTarget[] {
  const r = Bun.spawnSync([ghBin, "repo", "list", cfg.owner, "--limit", String(cfg.limit), "--json", "name,isPrivate,isFork,isArchived,pushedAt,defaultBranchRef"], { timeout: 120_000 });
  if (r.exitCode !== 0) throw new TypedError("gh_failed", `gh repo list failed: ${r.stderr.toString().split("\n", 1)[0]}`);
  let list: GhRepo[];
  try { list = JSON.parse(r.stdout.toString()); } catch { throw new TypedError("gh_failed", "gh repo list returned unreadable output"); }
  if (!Array.isArray(list) || list.length === 0) throw new TypedError("gh_failed", `gh repo list returned no repos for ${cfg.owner}`);
  const exclude = cfg.exclude.map((s) => new RegExp(s));
  const from = windowStart(cfg.since, now).getTime();
  return list
    .filter((g) => !g.isFork && !g.isArchived && Date.parse(g.pushedAt) >= from && !exclude.some((re) => re.test(g.name)))
    .map((g) => ({ owner: cfg.owner, name: g.name, public: !g.isPrivate, defaultBranch: g.defaultBranchRef?.name ?? "main" }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- checkouts ----------

const git = (dir: string, args: string[], timeout = 120_000) => Bun.spawnSync(["git", "-C", dir, ...args], { timeout });

/**
 * owner/name from a GitHub origin URL, or null for any other host or shape. The host must be exactly
 * github.com as the WHATWG URL parser reads it (https, http, ssh, git schemes; userinfo allowed, never
 * trusted; no port), or the scp form [user@]github.com:o/r(.git). The URL must already be canonical (the
 * parser rewrites nothing: lowercase host, no dot segments, no trailing slash). A URL that only mentions
 * github.com in its userinfo or path is not a GitHub origin, and anything after /owner/name(.git) (more
 * segments, a query, a fragment) is refused.
 */
export function parseGithubRemote(url: string): { owner: string; name: string } | null {
  const u = url.trim();
  const seg = /^[A-Za-z0-9_.-]+$/;
  const pick = (owner: string, rawName: string) => {
    const name = rawName.replace(/\.git$/, "");
    if (!seg.test(owner) || !seg.test(name) || [owner, name].some((s) => s === "." || s === "..")) return null;
    return { owner, name };
  };
  const scp = /^(?:[A-Za-z0-9_.-]+@)?github\.com:([^/]+)\/([^/]+?)$/.exec(u);
  if (scp) return pick(scp[1]!, scp[2]!);
  let p: URL;
  try { p = new URL(u); } catch { return null; }
  if (!["https:", "http:", "ssh:", "git:"].includes(p.protocol) || p.hostname !== "github.com" || p.port !== "") return null;
  // Canonical only: a URL the parser had to rewrite (case, default port, dot segments) is refused, as HEAD's literal match did.
  if (p.href !== u) return null;
  if (p.search || p.hash || u.includes("?") || u.includes("#")) return null;
  const parts = p.pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "") return null;
  return pick(parts[1]!, parts[2]!);
}

/** True when `dir` is a protected root or anything inside one, symlinks resolved (Boundary.confinedPath). */
function insideProtected(dir: string, protectedRoots: string[]): boolean {
  return protectedRoots.some((root) => confinedPath(root, realOr(dir)) !== null);
}

/** A local checkout of owner/name under one of the roots, only when its origin says so. Never inside the config or USER trees. */
export function resolveCheckout(owner: string, name: string, roots: string[]): string | null {
  const never = [getClaudeDir(), lifeosPath("USER")];
  for (const rootDir of roots.map(expand)) {
    const dir = join(rootDir, name);
    if (!existsSync(join(dir, ".git")) || insideProtected(dir, never)) continue;
    const r = git(dir, ["remote", "get-url", "origin"]);
    if (r.exitCode !== 0) continue;
    const remote = parseGithubRemote(r.stdout.toString());
    if (remote && remote.owner === owner && remote.name === name) return dir;
    // Say why a checkout was passed over (it falls back to a clone). Never print the URL: it may carry a token.
    if (!remote) console.error(`[VelocityDeeds] ${dir}: origin is not a github.com/<owner>/<repo> URL; not using this checkout`);
  }
  return null;
}

/** Fetch, then fast-forward when the checkout sits on the default branch. False when the fetch fails. */
function syncCheckout(dir: string, branch: string): boolean {
  if (git(dir, ["fetch", "--quiet", "origin"]).exitCode !== 0) return false;
  const here = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.toString().trim();
  if (here === branch) git(dir, ["merge", "--ff-only", "--quiet", `origin/${branch}`]); // a dirty or diverged tree keeps what it has
  return true;
}

function shallowSince(cfg: DeedsConfig): string {
  const d = windowStart(cfg.since);
  d.setUTCDate(d.getUTCDate() - 7); // margin so the first week of the window is whole
  return d.toISOString().slice(0, 10);
}

/** A private repo without a local checkout: a shallow clone we own under clone_dir, refreshed to the remote tip. */
export function privateClone(cfg: DeedsConfig, ghBin: string, t: RepoTarget): string {
  invariant(/^[A-Za-z0-9._-]+$/.test(t.name) && t.name !== "." && t.name !== "..", `repo name is not a plain directory name: ${t.name}`);
  const base = expand(cfg.clone_dir);
  mkdirSync(base, { recursive: true });
  const dir = join(base, t.name);
  invariant(realOr(dir).startsWith(realOr(base) + sep), "private clone path escapes clone_dir");
  const since = shallowSince(cfg);
  if (existsSync(join(dir, ".git"))) {
    // Reset only a cache clone of this exact repo with no edits to tracked files. The path carries no owner, so an owner
    // change or a clone_dir pointed at real checkouts lands on someone's tree: refuse it, never reset it.
    const o = git(dir, ["remote", "get-url", "origin"]);
    const remote = o.exitCode === 0 ? parseGithubRemote(o.stdout.toString()) : null;
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // GitHub names ignore case
    if (!remote || !same(remote.owner, t.owner) || !same(remote.name, t.name)) {
      throw new TypedError("cache_mismatch", `${tilde(dir)} is not a cache clone of ${t.owner}/${t.name}; left as is`);
    }
    const st = git(dir, ["status", "--porcelain", "--untracked-files=no"]);
    if (st.exitCode !== 0 || st.stdout.toString().trim()) throw new TypedError("cache_dirty", `${tilde(dir)} has local edits; left as is`);
    const f = git(dir, ["fetch", "--quiet", `--shallow-since=${since}`, "origin", t.defaultBranch]);
    if (f.exitCode !== 0) throw new TypedError("sync_failed", `fetch failed: ${f.stderr.toString().split("\n", 1)[0]}`);
    git(dir, ["reset", "--hard", "--quiet", "FETCH_HEAD"]); // our own cache clone, checked above; nothing of anyone's is in it
  } else {
    const c = Bun.spawnSync([ghBin, "repo", "clone", `${t.owner}/${t.name}`, dir, "--", `--shallow-since=${since}`], { timeout: 600_000 });
    if (c.exitCode !== 0) throw new TypedError("clone_failed", `clone failed: ${c.stderr.toString().split("\n", 1)[0]}`);
  }
  return dir;
}

function defaultPrepare(cfg: DeedsConfig, ghBin: string) {
  return (t: RepoTarget): string => {
    const checkout = resolveCheckout(t.owner, t.name, cfg.roots);
    if (checkout && syncCheckout(checkout, t.defaultBranch)) return checkout;
    // No checkout, or one that will not fetch (a stray ref breaks it): read the remote instead.
    return t.public ? `github.com/${t.owner}/${t.name}` : privateClone(cfg, ghBin, t);
  };
}

// ---------- deeds ----------

const DEEDS_TIMEOUT_MS = 30 * 60_000;
const firstLine = (s: string) => s.trim().split("\n", 1)[0]!.slice(0, 300);
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function runDeeds(deedsBin: string, repo: string, target: string, since: string): Entry {
  const shown = tilde(target);
  const fail = (code: string, message: string): FailEntry => ({ repo, target: shown, ok: false, error: { code, message: firstLine(message) || code } });
  const r = Bun.spawnSync([deedsBin, "analyze", target, "--since", since, "--json"], { timeout: DEEDS_TIMEOUT_MS });
  if (r.exitedDueToTimeout || r.exitCode === null || r.signalCode) return fail("timeout", `deeds did not finish within ${DEEDS_TIMEOUT_MS / 60_000} minutes`);
  const line = r.stdout.toString().trim().split("\n").filter(Boolean).pop() ?? "";
  let doc: any;
  try { doc = JSON.parse(line); } catch { doc = undefined; }
  // A nonzero exit is a failure whatever stdout says: only exit 0 may carry a success document.
  if (r.exitCode !== 0) {
    const code = doc && doc.ok === false && doc.error?.code ? String(doc.error.code) : `deeds_exit_${r.exitCode}`;
    return fail(code, String(doc?.error?.message ?? "") || r.stderr.toString() || `deeds exited ${r.exitCode}`);
  }
  if (doc === undefined) return fail("bad_output", r.stderr.toString() || "deeds printed no JSON document");
  if (!doc || doc.ok !== true) return fail(String(doc?.error?.code ?? "deeds_failed"), String(doc?.error?.message ?? ""));
  const d = doc.data;
  if (!d || !isNum(d.commits) || !isNum(d.judged) || !isNum(d.cached) || !d.totals || !isNum(d.totals.cap) || !isNum(d.totals.fix) || !isNum(d.totals.tend)
    || !Array.isArray(d.weeks) || !Array.isArray(d.caps)) return fail("bad_output", "deeds JSON is missing the expected fields");
  return {
    repo, target: shown, ok: true, commits: d.commits, judged: d.judged, cached: d.cached,
    notJudged: Array.isArray(d.failed) ? d.failed.length : 0,
    totals: { cap: d.totals.cap, fix: d.totals.fix, tend: d.totals.tend },
    weeks: d.weeks.map((w: any) => ({ week: w.week, cap: w.cap, fix: w.fix, tend: w.tend })),
    caps: d.caps.map((c: any) => ({ name: c.name, change: c.change, sha: c.sha, author: c.author, date: c.date })),
  };
}

// ---------- collect ----------

function writeDeedsFile(stateDir: string, doc: DeedsFile, exclude: RegExp[]) {
  const seen = new Set<string>();
  for (const e of doc.repos) {
    invariant(!seen.has(e.repo), `deeds.json would hold ${e.repo} twice`);
    seen.add(e.repo);
    invariant(!exclude.some((re) => re.test(e.repo)), `deeds.json would hold an excluded repo: ${e.repo}`);
    if (e.ok) invariant(isNum(e.totals.cap) && isNum(e.totals.fix) && isNum(e.totals.tend) && e.cached <= e.judged && e.notJudged >= 0, `deeds.json entry for ${e.repo} is inconsistent`);
  }
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "deeds.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, file);
}

/** Discover the repo set, run deeds on each (one failure never stops the rest), write deeds.json atomically. */
export function collectDeeds(opts: CollectOptions): DeedsFile {
  const { config, stateDir } = opts;
  const targets = discoverTargets(config, opts.ghBin); // throws on a gh failure: the previous deeds.json stays
  const prepare = opts.prepare ?? defaultPrepare(config, opts.ghBin);
  const started = Date.now();
  const repos: Entry[] = [];
  for (const t of targets) {
    let entry: Entry;
    if (opts.maxMs !== undefined && Date.now() - started > opts.maxMs) {
      entry = { repo: t.name, target: `github.com/${t.owner}/${t.name}`, ok: false, error: { code: "deadline", message: "run budget spent before this repo was reached" } };
    } else {
      try {
        entry = runDeeds(opts.deedsBin, t.name, prepare(t), config.since);
      } catch (error) {
        if (error instanceof Error && error.name === "InvariantViolation") throw error;
        const code = error instanceof TypedError ? error.code : "prepare_failed";
        entry = { repo: t.name, target: `github.com/${t.owner}/${t.name}`, ok: false, error: { code, message: firstLine(String((error as Error)?.message ?? error)) } };
      }
    }
    repos.push(entry);
    opts.onEntry?.(entry);
  }
  const doc: DeedsFile = { generated: new Date().toISOString(), since: config.since, owner: config.owner, repos };
  writeDeedsFile(stateDir, doc, config.exclude.map((s) => new RegExp(s)));
  return doc;
}

/** The deeds binary: env, then config, then PATH, then the Claude Code plugin cache (a launchd PATH has neither). */
export function resolveDeedsBin(): string {
  if (process.env.VELOCITY_DEEDS_BIN) return process.env.VELOCITY_DEEDS_BIN;
  const onPath = Bun.which("deeds");
  if (onPath) return onPath;
  const cache = join(getClaudeDir(), "plugins", "cache");
  const found: string[] = [];
  try {
    for (const g of new Bun.Glob("*/deeds/*/bin/deeds").scanSync({ cwd: cache, absolute: true })) found.push(g);
  } catch { /* no plugin cache */ }
  return newestDeedsBin(found) ?? "deeds";
}

/** The cached binary with the highest version: <cache>/<marketplace>/deeds/<version>/bin/deeds. Text order would put 0.9.0 above 0.10.0. */
export function newestDeedsBin(paths: string[]): string | undefined {
  const version = (p: string) => p.split(sep).at(-3) ?? "";
  const order = (a: string, b: string) => {
    try { return Bun.semver.order(a, b); } catch { return a.localeCompare(b, undefined, { numeric: true }); }
  };
  return [...paths].sort((a, b) => order(version(a), version(b))).at(-1);
}

// ---------- main ----------

if (import.meta.main) {
  const ghBin = process.env.VELOCITY_GH_BIN ?? "gh";
  const configPath = process.env.VELOCITY_CONFIG ?? lifeosPath("USER", "CONFIG", "velocity.json");
  const stateDir = process.env.VELOCITY_STATE_DIR ?? join(getMemoryDir(), "STATE", "velocity");
  const verbose = process.argv.includes("--print") || process.stdout.isTTY;
  const t0 = Date.now();
  try {
    const config = loadDeedsConfig(configPath, ghBin);
    const doc = collectDeeds({
      config, stateDir, ghBin, deedsBin: resolveDeedsBin(), maxMs: 120 * 60_000,
      onEntry: (e) => { if (verbose) console.log(e.ok ? `  ${e.repo}: ${e.totals.cap} caps ${e.totals.fix} fixes ${e.totals.tend} tends (${e.cached}/${e.judged} cached)` : `  ${e.repo}: FAILED ${e.error.code}`); },
    });
    const failed = doc.repos.filter((e) => !e.ok).length;
    console.log(`[VelocityDeeds] ${doc.repos.length} repos (${failed} failed) · ${Date.now() - t0} ms → ${tilde(join(stateDir, "deeds.json"))}`);
    // Partial is not success: exit 2 so the launchd health check sees a run that could not read everything.
    if (failed) process.exitCode = 2;
  } catch (error) {
    console.error(`[VelocityDeeds] ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
