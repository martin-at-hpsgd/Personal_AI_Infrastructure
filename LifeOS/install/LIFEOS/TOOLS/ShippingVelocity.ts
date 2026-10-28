#!/usr/bin/env bun
/**
 * ShippingVelocity.ts — the Velocity collector: one compact record per commit across every repo
 * this install works in, plus the metadata the Pulse /velocity query engine needs.
 *
 *   bun LIFEOS/TOOLS/ShippingVelocity.ts            # incremental: refetch only repos whose HEAD moved
 *   bun LIFEOS/TOOLS/ShippingVelocity.ts --full     # drop the cache and recollect everything
 *   bun LIFEOS/TOOLS/ShippingVelocity.ts --print    # one-line summary
 *
 * Reads USER/CONFIG/velocity.json. Writes MEMORY/STATE/velocity/{meta.json, repos/<id>.json}, then runs
 * VelocityDeeds.ts and VelocityPrs.ts, which write deeds.json and prs.json beside them.
 * Records carry counts and classes only — never file paths. Ships publicly: no identity here.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { getClaudeDir, getMemoryDir, lifeosPath } from "./Paths";
import { invariant } from "./Invariant";
import { hasDeedsConfig } from "./VelocityDeeds";
import { parseDispatches, parseLanePins, trailerModel, type Dispatch, type LanePin } from "./VelocityLanes";
import { existsRetry, readdirRetry } from "./lib/RetryEintr.ts";

const HOME = homedir();
const CONFIG_PATH = lifeosPath("USER", "CONFIG", "velocity.json");
const PROJECTS_PATH = lifeosPath("USER", "PROJECTS.md");
const RETIRED_PATH = lifeosPath("USER", "PROJECTS_RETIRED.md");
const STATE_DIR = join(getMemoryDir(), "STATE", "velocity");
const REPOS_DIR = join(STATE_DIR, "repos");

// ---------- config ----------

interface CategoryRule { name: string; match: string }
interface ModelAlias { match: string; label: string; from?: Record<string, string> }
interface Config {
  timezone: string; since: string;
  roots: string[]; repos: string[]; exclude_dirs: string[]; exclude_paths: string[];
  authors: string[]; authors_label?: string; exclude_subjects: string[];
  categories: CategoryRule[]; default_category: string;
  repo_names: Record<string, string>;
  model_aliases: ModelAlias[];
  lines_exclude: string[];
  events: { date: string; label: string }[];
  stall_days: number; mover_floor: number;
  /** Repos absent from PROJECTS.md with fewer commits than this never count as stalled (scratch, not work). */
  stall_min_commits: number;
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
const tilde = (p: string) => p.replace(HOME, "~").replace(/\/$/, "");
const safeReal = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Bounded: a git read under the iCloud-backed ~/Projects can block forever in a launchd job (2026-10-01).
const sh = (cmd: string[], env?: Record<string, string>) => Bun.spawnSync(cmd, { env: { ...process.env, ...env }, timeout: 120_000 });

function loadConfig(): Config {
  const claude = tilde(getClaudeDir());
  const defaults: Config = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    since: `${new Date().getFullYear()}-01-01`,
    roots: ["~/Projects"], repos: [claude, tilde(safeReal(lifeosPath("USER")))],
    exclude_dirs: ["OLD-archived", "-bak$"], exclude_paths: [],
    authors: [sh(["git", "config", "--global", "user.name"]).stdout.toString().trim()].filter(Boolean),
    exclude_subjects: [],
    categories: [{ name: "System", match: `^${escapeRe(claude)}$` }], default_category: "Projects",
    repo_names: {},
    model_aliases: [{ match: "opus", label: "Opus" }, { match: "sonnet", label: "Sonnet" }, { match: "haiku", label: "Haiku" }, { match: "fable", label: "Fable" }],
    lines_exclude: ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "*.min.*", "*.map"],
    events: [], stall_days: 14, mover_floor: 5, stall_min_commits: 10,
  };
  if (!existsSync(CONFIG_PATH)) return defaults;
  return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
}

// ---------- repos + names ----------

/** Roots or repos that could not be read this run. Reported in meta.json and the exit code, never silently dropped. */
const unreadable: { path: string; error: string }[] = [];
const noteUnreadable = (path: string, error: unknown) => {
  const first = String(error).split("\n", 1)[0]!;
  unreadable.push({ path: tilde(path), error: first });
  console.error(`[ShippingVelocity] unreadable: ${tilde(path)} — ${first}`);
};

/** A real repo has a .git file (worktree/submodule pointer) or a .git dir holding HEAD. An empty leftover .git dir (logs/refs only) is not a repo and is skipped, not reported unreadable. */
function isRepo(dir: string): boolean {
  const git = join(dir, ".git");
  if (!existsRetry(git)) return false;
  return existsRetry(join(git, "HEAD")) || statSync(git).isFile();
}

function discoverRepos(cfg: Config): string[] {
  const out = new Set<string>();
  for (const r of cfg.repos) { const p = expand(r); try { if (isRepo(p)) out.add(p); } catch (error) { noteUnreadable(p, error); } }
  const excludeDirs = cfg.exclude_dirs.map((s) => new RegExp(s));
  const excludePaths = new Set(cfg.exclude_paths.map(expand));
  for (const root of cfg.roots.map(expand)) {
    let names: string[];
    try {
      if (!existsRetry(root)) continue;
      names = readdirRetry(root);
    } catch (error) { noteUnreadable(root, error); continue; }
    for (const name of names) {
      const dir = join(root, name);
      try {
        if (!isRepo(dir) || excludeDirs.some((re) => re.test(name)) || excludePaths.has(dir)) continue;
      } catch (error) { noteUnreadable(dir, error); continue; }
      out.add(dir);
    }
  }
  return [...out];
}

/** `| **Name** ... | \`~/path\` ...` rows → exact path → name. PROJECTS.md = live, PROJECTS_RETIRED.md = retired. */
function projectNames(path = PROJECTS_PATH): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const r = line.match(/^\| \*\*([^*]+)\*\*[^|]*\|\s*`(~\/[^`]+)`/);
    if (r) m.set(tilde(r[2]), r[1].replace(/\s+\(.*\)$/, "").trim());
  }
  return m;
}

// ---------- classes ----------

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|go|swift|py|rb|rs|c|h|cpp|java|kt|css|scss|html|astro|vue|svelte|sh|zsh|sql|toml)$/i;
const DOCS_EXT = /\.(md|mdx|txt|rst)$/i;
const DATA_EXT = /\.(json|jsonl|yaml|yml|csv|tsv|xml|plist|lock)$/i;
type FileClass = "code" | "docs" | "data" | "other";
function fileClass(path: string): FileClass {
  if (CODE_EXT.test(path)) return "code";
  if (DOCS_EXT.test(path)) return "docs";
  if (DATA_EXT.test(path)) return "data";
  return "other";
}
function globToRe(g: string) { return new RegExp("(^|/)" + escapeRe(g).replace(/\\\*/g, "[^/]*") + "$", "i"); }

type WorkClass = "release" | "claim" | "fix" | "docs" | "test" | "feature";
function workClass(subject: string, tagged: boolean): WorkClass {
  if (tagged || /^(v?\d+\.\d+\.\d+\b|bump|release|version)/i.test(subject)) return "release";
  if (/^(ISC|C|P|S|F|VER|SEC|EM|AGT|ADM|WD|BK)-?\d+\b/.test(subject) || /\bISC-\d+/.test(subject)) return "claim";
  if (/\b(fix|fixes|fixed|bug|hotfix|repair|regression)\b/i.test(subject)) return "fix";
  if (/\b(docs?|documentation|readme|changelog)\b/i.test(subject)) return "docs";
  if (/\b(tests?|spec|coverage)\b/i.test(subject)) return "test";
  return "feature";
}

// ---------- time ----------

function localParts(iso: string, tz: string): { day: string; hour: number; dow: number } {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, dow: (dow + 6) % 7 /* Mon=0 */ };
}

// ---------- records ----------

export interface Rec {
  h: string; t: number; day: string; hr: number; dow: number; a: string; s: string;
  ins: number; del: number; files: number;
  fc: Record<FileClass, [number, number, number]>; // [ins, del, files] per class (line-excluded files count in files only)
  cls: WorkClass; tags: string[];
  /** Model named by a Co-Authored-By trailer (evidence); absent when no trailer names one, and the carrier pin attributes the commit. */
  m?: string; mv?: string;
}
/** Bump when the record shape changes; a cache written by an older collector is refetched. */
const CACHE_VERSION = 2;
interface RepoCache { v?: number; path: string; head: string; since: string; records: Rec[] }

function repoId(path: string) { return createHash("sha1").update(tilde(path)).digest("hex").slice(0, 12); }

/**
 * The commit records for a repo, or null when git could not produce them (a nonzero exit, a timeout, a
 * missing binary). Null is not "no commits": the caller keeps the previous cache and reports the repo as
 * unreadable, so a failed read can never replace real history with an empty set (LOSIntegrity
 * ).
 */
function collect(dir: string, cfg: Config, excludeRes: RegExp[]): Rec[] | null {
  const r = sh(["git", "-C", dir, "log", "--no-merges", "--no-renames", "--numstat", `--since=${cfg.since}`,
    "--format=%x01%H%x1f%aI%x1f%an%x1f%s%x1f%D%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1e)", "HEAD"], { TZ: cfg.timezone });
  if (r.exitCode !== 0) return null;
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (const line of r.stdout.toString().split("\n")) {
    if (line.startsWith("\x01")) {
      const [h, iso, an, subject, refs, trailers] = line.slice(1).split("\x1f");
      const tags = (refs ?? "").split(",").map((x) => x.trim()).filter((x) => x.startsWith("tag: ")).map((x) => x.slice(5));
      const lp = localParts(iso, cfg.timezone);
      const t = Date.parse(iso);
      const tm = trailerModel((trailers ?? "").split("\x1e").filter(Boolean), t, cfg.model_aliases);
      cur = { h: h.slice(0, 12), t, day: lp.day, hr: lp.hour, dow: lp.dow, a: an, s: (subject ?? "").slice(0, 100),
        ins: 0, del: 0, files: 0, fc: { code: [0, 0, 0], docs: [0, 0, 0], data: [0, 0, 0], other: [0, 0, 0] }, cls: workClass(subject ?? "", tags.length > 0), tags,
        ...(tm ? { m: tm.label, mv: tm.vendor } : {}) };
      out.push(cur);
      continue;
    }
    if (!cur || !line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    const path = m[3];
    const fcls = fileClass(path);
    cur.files++; cur.fc[fcls][2]++;
    if (m[1] === "-" || excludeRes.some((re) => re.test(path))) continue; // binary or excluded from line counts
    const ins = +m[1], del = +m[2];
    cur.ins += ins; cur.del += del; cur.fc[fcls][0] += ins; cur.fc[fcls][1] += del;
  }
  return out;
}

// ---------- model timeline ----------

interface ModelSwitch { at: number; raw: string; label: string }

/** Every lane's pin history: carrier + advisor from settings.json, each CROSS_VENDOR lane from models.ts. */
function lanePins(cfg: Config): LanePin[] {
  const hist = (rel: string) => { const r = sh(["git", "-C", getClaudeDir(), "log", "--reverse", "--format=%x01%aI", "-p", "--", rel]); return r.exitCode === 0 ? r.stdout.toString() : ""; };
  return [
    ...parseLanePins(hist("settings.json"), "settings", cfg.model_aliases),
    ...parseLanePins(hist(relative(getClaudeDir(), lifeosPath("TOOLS", "models.ts"))), "models", cfg.model_aliases),
  ].sort((a, b) => a.at - b.at);
}

/** The carrier lane alone: the only pin that attributes commits. */
function modelTimeline(lanes: LanePin[]): ModelSwitch[] {
  return lanes.filter((l) => l.lane === "carrier").map(({ at, raw, label }) => ({ at, raw, label }));
}

/** Agent dispatches with their resolved model, from the subagent event log. Evidence of when each vendor actually ran. */
function dispatches(cfg: Config): Dispatch[] {
  const p = lifeosPath("MEMORY", "OBSERVABILITY", "subagent-events.jsonl");
  return existsSync(p) ? parseDispatches(readFileSync(p, "utf-8"), cfg.since, cfg.model_aliases) : [];
}

// ---------- main ----------

const args = new Set(process.argv.slice(2));
const cfg = loadConfig();
const t0 = Date.now();
if (args.has("--full") && existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
mkdirSync(REPOS_DIR, { recursive: true });

const excludeRes = cfg.lines_exclude.map(globToRe);
const names = projectNames();
const retired = projectNames(RETIRED_PATH);
const rules = cfg.categories.map((c) => ({ name: c.name, re: new RegExp(c.match) }));
const categoryOf = (p: string) => rules.find((r) => r.re.test(tilde(p)))?.name ?? cfg.default_category;
const nameOf = (p: string) => cfg.repo_names[tilde(p)] ?? names.get(tilde(p)) ?? basename(p);

const repos = discoverRepos(cfg);
let refetched = 0, totalRecords = 0;
const metaRepos: { id: string; path: string; name: string; category: string; head: string; commits: number; lastDay: string | null; tracked: boolean; retired: boolean }[] = [];
const tags: { repo: string; tag: string; day: string; kind: "feature" | "patch" | "major" | "other" }[] = [];

for (const dir of repos) {
  const id = repoId(dir);
  const cachePath = join(REPOS_DIR, `${id}.json`);
  const headRun = sh(["git", "-C", dir, "rev-parse", "HEAD"]);
  const head = headRun.exitCode === 0 ? headRun.stdout.toString().trim() : ""; // a failing rev-parse still echoes the word HEAD
  let cache: RepoCache | null = null;
  if (existsSync(cachePath)) { try { cache = JSON.parse(readFileSync(cachePath, "utf-8")); } catch { cache = null; } }
  // A repo with no commits yet has no HEAD and no history: legitimately empty. Any other failure to name HEAD is a failed read.
  const anyRef = headRun.exitCode === 0 ? null : sh(["git", "-C", dir, "rev-list", "-n", "1", "--all"]);
  const headFailed = headRun.exitCode !== 0 && !(anyRef !== null && anyRef.exitCode === 0 && anyRef.stdout.toString().trim() === "");
  if (headFailed) noteUnreadable(dir, `git rev-parse HEAD exited ${headRun.exitCode ?? "on timeout"}`);
  if (!headFailed && (!cache || cache.v !== CACHE_VERSION || cache.head !== head || cache.since !== cfg.since)) {
    const collected = head === "" ? [] : collect(dir, cfg, excludeRes); // head "" and not failed: a repo with no commits yet
    if (collected === null) {
      // Keep whatever cache exists untouched: the next run must refetch, and Pulse keeps showing the last good history.
      noteUnreadable(dir, "git log failed or timed out");
    } else {
      cache = { v: CACHE_VERSION, path: tilde(dir), head, since: cfg.since, records: collected };
      invariant(Array.isArray(cache.records) && (cache.head === "" ? cache.records.length === 0 : /^[0-9a-f]{7,64}$/.test(cache.head)), "a velocity cache is written only for a named HEAD (or an empty repo) with a record array");
      writeFileSync(cachePath, JSON.stringify(cache));
      refetched++;
    }
  }
  const recs = cache?.records ?? [];
  totalRecords += recs.length;
  const counted = recs.filter((x) => cfg.authors.includes(x.a));
  const lastDay = counted.length ? counted.map((x) => x.day).sort()[counted.length - 1] : null;
  metaRepos.push({ id, path: tilde(dir), name: nameOf(dir), category: categoryOf(dir), head, commits: counted.length, lastDay, tracked: names.has(tilde(dir)) || tilde(dir) in cfg.repo_names, retired: retired.has(tilde(dir)) });
  const tagRun = sh(["git", "-C", dir, "tag", "--sort=creatordate", "--format=%(refname:short)%09%(creatordate:short)"]);
  if (tagRun.exitCode !== 0 && !headFailed) noteUnreadable(dir, `git tag exited ${tagRun.exitCode ?? "on timeout"}`);
  const tg = tagRun.stdout.toString().trim();
  for (const line of tg.split("\n")) {
    const [tag, day] = line.split("\t"); if (!tag || !day || day < cfg.since) continue;
    const sv = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
    const kind = !sv ? "other" : sv[2] === "0" && sv[3] === "0" ? "major" : sv[3] === "0" ? "feature" : "patch";
    tags.push({ repo: id, tag, day, kind });
  }
}

const lanes = lanePins(cfg);
const meta = {
  generated: new Date().toISOString(), timezone: cfg.timezone, since: cfg.since,
  authors: cfg.authors, authorsLabel: cfg.authors_label ?? null, excludeSubjects: cfg.exclude_subjects,
  categories: [...cfg.categories.map((c) => c.name), cfg.default_category],
  repos: metaRepos.sort((a, b) => b.commits - a.commits),
  models: modelTimeline(lanes), lanes, dispatches: dispatches(cfg),
  tags, events: cfg.events, stallDays: cfg.stall_days, moverFloor: cfg.mover_floor, stallMinCommits: cfg.stall_min_commits,
  collect: { repos: repos.length, refetched, records: totalRecords, ms: Date.now() - t0, unreadable },
};
writeFileSync(join(STATE_DIR, "meta.json"), JSON.stringify(meta, null, 2));
// Partial is not success: exit 2 so the launchd health check (SOC-0006) sees a run that could not see everything.
if (unreadable.length) process.exitCode = 2;

// Deeds sends repository contents to a model, so an install must explicitly opt in with its privacy exclusion list.
// Without that block, Commits remains useful and this job completes cleanly; a present malformed block still fails loud.
const followOn = hasDeedsConfig(CONFIG_PATH) ? ["VelocityDeeds.ts", "VelocityPrs.ts"] : [];
if (!followOn.length) console.log("[ShippingVelocity] deeds collector not configured; skipped Deeds and PRs");
// Follow-on collectors run in order: deeds (caps, fixes, tends), then merged PRs over the same repos. Each is its own
// process, so one failing never costs the commits state written above; a failure is exit 2 here too.
for (const script of followOn) {
  const path = lifeosPath("TOOLS", script);
  if (!existsSync(path)) { console.error(`[ShippingVelocity] ${script} not installed yet, skipped`); continue; }
  const r = Bun.spawnSync([process.execPath, path], { stdio: ["ignore", "inherit", "inherit"], timeout: 3 * 60 * 60_000 });
  if (r.exitCode !== 0) { console.error(`[ShippingVelocity] ${script} exited ${r.exitCode ?? "on timeout"}`); process.exitCode = 2; }
}

if (args.has("--print") || process.stdout.isTTY) {
  console.log(`[ShippingVelocity] ${repos.length} repos (${refetched} refetched) · ${totalRecords} records · ${meta.models.length} model switches · ${tags.length} tags · ${Date.now() - t0} ms → ${tilde(STATE_DIR)}`);
}
