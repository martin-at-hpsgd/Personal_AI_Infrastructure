#!/usr/bin/env bun
/**
 * PublicReady.ts — is a private repo safe to make public, and the clean export that makes it so.
 *
 *   audit  <repo> [--json] [--no-build] [--build "<cmd>"] [--history-ok] [--reviewed <sha>]
 *   export <repo> --out <dir> [--json] [--no-build] [--build "<cmd>"] [--reviewed <sha>]
 *   live   <owner/repo> [--json]          after publishing: public, social preview, vuln reporting, CI
 *   live   --all <owner> [--json]         the same for every public, non-fork, non-archived repo
 *
 * audit judges HEAD and every reachable commit. export copies HEAD minus the paths in the
 * repo's .publicignore into a NEW repo with one UTC-dated commit, then audits that export,
 * so private history never travels. Neither command pushes, creates a remote, or changes
 * visibility: publishing is the principal's call (Permission Boundaries P7).
 *
 * Exit: 0 READY · 1 NOT READY · 2 usage or the repo is unreadable.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scan } from "../../../LIFEOS/TOOLS/lib/DenyHistoryScan.ts";
import { loadPublicDenyList } from "../../../hooks/lib/public-deny-list.ts";

export type Status = "pass" | "fail" | "warn" | "unavailable";
export interface Check { id: string; status: Status; summary: string; evidence?: string[] }
export interface Report { repo: string; mode: "audit" | "export"; verdict: "READY" | "NOT READY"; checks: Check[]; exportDir?: string }

class InvariantViolation extends Error {}
function invariant(cond: unknown, msg: string): asserts cond { if (!cond) throw new InvariantViolation(msg); }

interface Run { code: number; out: string; err: string }
/** env is merged over this process's environment, unless inherit is false: then env is the whole environment. */
export type Runner = (argv: string[], cwd: string, env?: Record<string, string>, inherit?: boolean) => Run;

const defaultRun: Runner = (argv, cwd, env, inherit = true) => {
  const p = Bun.spawnSync(argv, { cwd, env: inherit ? { ...process.env, ...env } : { ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
};

const has = (bin: string) => Bun.which(bin) !== null;

/** Licenses that would force the whole project's license or forbid the reuse people expect from a public repo. */
export const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-NC|BUSL|Commons-Clause)\b/i;
export const LICENSE_FILE = /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i;
/** A user home path: on a public repo it names the author's account and machine layout. */
export const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\//;
/** RFC1918 addresses: usually a real LAN gateway or host copied into a test or config. */
export const PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
const DOC_IPS = new Set(["192.168.1.1", "192.168.0.1", "10.0.0.1"]); // conventional placeholder gateways
const BIG_FILE = 5 * 1024 * 1024;

/** The files committed at HEAD, not the index or working tree: uncommitted edits must not hide what is published. */
function tracked(repo: string, run: Runner): string[] {
  const r = run(["git", "ls-tree", "-r", "-z", "--name-only", "HEAD"], repo);
  invariant(r.code === 0, `git ls-tree failed in ${repo}: ${r.err.trim()}`);
  return r.out.split("\0").filter(Boolean);
}

/** A file's text exactly as committed at HEAD; null for binary files and for entries with no blob (submodules). */
function headText(repo: string, f: string, run: Runner): string | null {
  const r = run(["git", "show", `HEAD:${f}`], repo);
  if (r.code !== 0 || r.out.includes("\0")) return null;
  return r.out;
}

/** Grep tracked text files as committed at HEAD for a pattern, skipping allowed values. */
export function grepTracked(repo: string, files: string[], re: RegExp, allow: (m: string) => boolean = () => false, run: Runner = defaultRun): string[] {
  const hits: string[] = [];
  for (const f of files) {
    const text = headText(repo, f, run);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      const m = line.match(re);
      if (m && !allow(m[0])) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  return hits;
}

export function checkDenyList(repo: string, history: boolean): Check {
  let patterns: ReturnType<typeof loadPublicDenyList>;
  try { patterns = loadPublicDenyList(); } catch (e) {
    return { id: "deny-list", status: "unavailable", summary: `deny list unreadable: ${(e as Error).message}` };
  }
  try {
    const hit = scan(repo, { generic: patterns.generic, user: patterns.user });
    if (hit === null) return { id: "deny-list", status: "pass", summary: `push-gate deny scan clean (HEAD${history ? " + history" : ""})` };
    const lines = hit.split("\n").filter(Boolean);
    return { id: "deny-list", status: "fail", summary: `${lines.length} deny-list hit(s); the push gate would refuse this repo`, evidence: lines.slice(0, 20) };
  } catch (e) {
    return { id: "deny-list", status: "unavailable", summary: `deny scan errored: ${(e as Error).message}` };
  }
}

export function checkSecrets(repo: string, run: Runner): Check[] {
  const out: Check[] = [];
  if (!has("trufflehog")) out.push({ id: "trufflehog", status: "unavailable", summary: "trufflehog not installed (brew install trufflehog)" });
  else {
    const r = run(["trufflehog", "git", `file://${repo}`, "--no-update", "--json"], repo);
    const finds = r.out.split("\n").filter((l) => l.startsWith("{"));
    out.push(r.code !== 0 && finds.length === 0
      ? { id: "trufflehog", status: "unavailable", summary: `trufflehog exited ${r.code}: ${r.err.trim().slice(0, 200)}` }
      : finds.length === 0
        ? { id: "trufflehog", status: "pass", summary: "no credentials in any commit" }
        : { id: "trufflehog", status: "fail", summary: `${finds.length} credential finding(s) across history`, evidence: finds.slice(0, 10).map((l) => { try { const j = JSON.parse(l); return `${j.DetectorName} ${j.SourceMetadata?.Data?.Git?.file ?? ""} ${j.Verified ? "(VERIFIED LIVE)" : ""}`; } catch { return l.slice(0, 140); } }) });
  }
  if (!has("gitleaks")) out.push({ id: "gitleaks", status: "unavailable", summary: "gitleaks not installed (brew install gitleaks)" });
  else {
    // gitleaks exits 1 both for "leaks found" and for a fatal error (an unwritable report path
    // did this on 2026-10-12), so the verdict comes from the report file, never the exit code.
    const report = join(process.env.TMPDIR ?? "/tmp", `publicready-gitleaks-${process.pid}-${Date.now()}.json`);
    const r = run(["gitleaks", "detect", "--source", repo, "--no-banner", "--redact", "--report-format", "json", "--report-path", report], repo);
    let finds: any[] | null = null;
    try { finds = JSON.parse(readFileSync(report, "utf8")); } catch { finds = null; } finally { rmSync(report, { force: true }); }
    if (finds === null || !Array.isArray(finds)) out.push({ id: "gitleaks", status: "unavailable", summary: `gitleaks wrote no report (exit ${r.code}): ${r.err.trim().split("\n").pop()?.slice(0, 200) ?? ""}` });
    else if (finds.length === 0) out.push({ id: "gitleaks", status: "pass", summary: "no leaks in any commit" });
    else out.push({ id: "gitleaks", status: "fail", summary: `${finds.length} leak(s) across history`, evidence: finds.slice(0, 10).map((x) => `${x.RuleID} ${x.File}:${x.StartLine} ${String(x.Commit ?? "").slice(0, 7)}`) });
  }
  return out;
}

export function checkLicense(files: string[]): Check {
  const lic = files.filter((f) => !f.includes("/") && LICENSE_FILE.test(f));
  return lic.length > 0
    ? { id: "license", status: "pass", summary: `license file: ${lic.join(", ")}` }
    : { id: "license", status: "fail", summary: "no LICENSE at the repo root; without one nobody may legally use the code" };
}

export function checkReadme(repo: string, files: string[], run: Runner = defaultRun): Check {
  const r = files.find((f) => /^README(\.md)?$/i.test(f));
  if (!r) return { id: "readme", status: "fail", summary: "no README at the repo root" };
  const text = headText(repo, r, run) ?? "";
  const lines = text.split("\n").filter((l) => l.trim()).length;
  const image = /!\[[^\]]*\]\([^)]+\)|<img\s/i.test(text);
  const gaps = [lines < 40 && `${lines} non-blank lines`, !image && "no image"].filter(Boolean);
  return gaps.length === 0
    ? { id: "readme", status: "pass", summary: `${r}: ${lines} lines with an image` }
    : { id: "readme", status: "warn", summary: `${r} is thin for a public landing page: ${gaps.join(", ")}` };
}

/** Cargo manifests or lockfiles that differ from HEAD on disk (modified, deleted, added or untracked). */
export function cargoDrift(repo: string, run: Runner): string[] {
  const r = run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], repo);
  return r.out.split("\0").filter((e) => /(^|[ /])Cargo\.(toml|lock)$/.test(e));
}

/**
 * Dependency licenses as committed at HEAD. cargo metadata reads the working tree, so an uncommitted manifest or
 * lockfile edit could hide a dependency that HEAD still publishes; that case is unavailable until the tree matches HEAD.
 */
export function checkDependencyLicenses(repo: string, run: Runner, files: string[] = tracked(repo, run)): Check {
  if (files.includes("Cargo.toml")) {
    if (!has("cargo")) return { id: "dep-licenses", status: "unavailable", summary: "Cargo.toml present but cargo is not installed" };
    const drift = cargoDrift(repo, run);
    if (drift.length) return { id: "dep-licenses", status: "unavailable", summary: `${drift.length} Cargo manifest or lockfile change(s) differ from HEAD; make the tree match HEAD so the check judges what ships`, evidence: drift.slice(0, 15) };
    const r = run(["cargo", "metadata", "--format-version", "1", "--locked"], repo);
    if (r.code !== 0) return { id: "dep-licenses", status: "unavailable", summary: `cargo metadata failed: ${r.err.trim().slice(0, 200)}` };
    const meta = JSON.parse(r.out);
    const root = new Set<string>((meta.workspace_members ?? []) as string[]);
    const bad: string[] = []; const unknown: string[] = []; let n = 0;
    for (const p of meta.packages as any[]) {
      if (root.has(p.id)) continue;
      n++;
      const l: string = p.license ?? "";
      if (!l) unknown.push(p.name);
      // An OR expression with a permissive arm can be taken under that arm.
      else if (l.split(/\s+OR\s+|\//).every((arm) => COPYLEFT.test(arm))) bad.push(`${p.name} (${l})`);
    }
    if (bad.length) return { id: "dep-licenses", status: "fail", summary: `${bad.length} dependency(ies) only available under copyleft terms`, evidence: bad };
    if (unknown.length) return { id: "dep-licenses", status: "warn", summary: `${unknown.length} dependency(ies) declare no license`, evidence: unknown };
    return { id: "dep-licenses", status: "pass", summary: `${n} Cargo dependencies, all permissive or with a permissive arm` };
  }
  if (files.includes("package.json")) {
    return { id: "dep-licenses", status: "unavailable", summary: "package.json present: npm dependency licenses are not checked by this tool yet; review them by hand" };
  }
  return { id: "dep-licenses", status: "pass", summary: "no dependency manifest found" };
}

export function checkHead(repo: string, files: string[], run: Runner = defaultRun): Check[] {
  const homes = grepTracked(repo, files, HOME_PATH, () => false, run);
  const ips = grepTracked(repo, files, PRIVATE_IP, (m) => DOC_IPS.has(m), run);
  const big = files.filter((f) => Number(run(["git", "cat-file", "-s", `HEAD:${f}`], repo).out.trim()) > BIG_FILE);
  return [
    homes.length
      ? { id: "home-paths", status: "fail", summary: `${homes.length} user home path(s) at HEAD`, evidence: homes.slice(0, 15) }
      : { id: "home-paths", status: "pass", summary: "no user home paths at HEAD" },
    ips.length
      ? { id: "private-ips", status: "warn", summary: `${ips.length} private network address(es) at HEAD; swap real LAN addresses for 192.168.1.1-style placeholders`, evidence: ips.slice(0, 15) }
      : { id: "private-ips", status: "pass", summary: "no private network addresses beyond placeholders" },
    big.length
      ? { id: "large-files", status: "warn", summary: `${big.length} tracked file(s) over 5 MB`, evidence: big }
      : { id: "large-files", status: "pass", summary: "no tracked file over 5 MB" },
  ];
}

/** Commit metadata leaks: author emails and the UTC offsets that show where the author was. */
export function checkHistory(repo: string, run: Runner): Check {
  const r = run(["git", "log", "--all", "--format=%ae|%ad", "--date=format:%z"], repo);
  if (r.code !== 0) return { id: "history", status: "unavailable", summary: `git log failed: ${r.err.trim()}` };
  const rows = r.out.split("\n").filter(Boolean);
  const emails = [...new Set(rows.map((x) => x.split("|")[0]))];
  const zones = [...new Set(rows.map((x) => x.split("|")[1]))];
  return {
    id: "history",
    status: rows.length <= 1 ? "pass" : "warn",
    summary: `${rows.length} commit(s), ${emails.length} author email(s), offsets ${zones.join(" ")}${rows.length > 1 ? "; flipping this repo public publishes all of it (export starts fresh)" : ""}`,
    evidence: emails,
  };
}

/** The build command for HEAD's manifests, since the clean build runs in a fresh clone of HEAD. */
export function detectBuild(repo: string, files: string[] = tracked(repo, defaultRun)): string | null {
  if (files.includes("Cargo.toml")) return "cargo test --quiet";
  if (files.includes("package.json")) return "bun install && bun test";
  if (files.includes("go.mod")) return "go test ./...";
  return null;
}

/**
 * The only variables the clean build inherits: where the shell and toolchains live, locale and temp space. Tokens,
 * API keys, signing identities and the ssh agent are left out, and the global git config with its identity and
 * credential helpers is ignored, so a build that quietly needs them fails here.
 */
export const BUILD_ENV_KEEP = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "USER", "LOGNAME", "SHELL",
  "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "GOMODCACHE", "GOCACHE", "BUN_INSTALL"];

export function cleanBuildEnv(tmp: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BUILD_ENV_KEEP) if (base[k] !== undefined) env[k] = base[k]!;
  return { ...env, CARGO_TARGET_DIR: join(tmp, "target"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

/**
 * Builds a fresh clone of HEAD under a POSIX shell with a stripped environment, so anything uncommitted or untracked
 * the build secretly needs, or any credential it reads from the environment, shows up as a failure. Files under HOME
 * and the login keychain stay reachable; only a fresh machine proves the README build for a stranger.
 */
export function checkCleanBuild(repo: string, cmd: string | null, run: Runner): Check {
  if (cmd === null) return { id: "clean-build", status: "warn", summary: "no build or test command detected; pass --build" };
  const tmp = join(process.env.TMPDIR ?? "/tmp", `publicready-${process.pid}-${Date.now()}`);
  try {
    const c = run(["git", "clone", "--quiet", "--no-hardlinks", repo, tmp], process.cwd());
    if (c.code !== 0) return { id: "clean-build", status: "unavailable", summary: `clone failed: ${c.err.trim()}` };
    const b = run(["/bin/sh", "-c", cmd], tmp, cleanBuildEnv(tmp), false);
    return b.code === 0
      ? { id: "clean-build", status: "pass", summary: `\`${cmd}\` passes in a fresh clone with a stripped environment` }
      : { id: "clean-build", status: "fail", summary: `\`${cmd}\` fails in a fresh clone (exit ${b.code})`, evidence: (b.err || b.out).trim().split("\n").slice(-12) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export interface Opts { build?: string | null; noBuild?: boolean; historyOk?: boolean; reviewed?: string; reviewRepo?: string; run?: Runner }

/**
 * The independent review must cover the exact commit that goes public. A fix made after the
 * review is unreviewed code, so fix commits that land after the only review fail the check. No review recorded means the verdict cannot be READY; a review of an older commit fails
 * and names what changed since.
 */
export function checkReview(repo: string, reviewed: string | undefined, run: Runner): Check {
  const head = run(["git", "rev-parse", "HEAD"], repo).out.trim();
  if (!reviewed) return { id: "review", status: "unavailable", summary: `no independent review recorded for HEAD ${head.slice(0, 7)}; run it on this commit, then pass --reviewed ${head.slice(0, 7)}` };
  const r = run(["git", "rev-parse", "--verify", "--quiet", `${reviewed}^{commit}`], repo);
  const sha = r.out.trim();
  if (r.code !== 0 || !sha) return { id: "review", status: "fail", summary: `--reviewed ${reviewed} is not a commit in ${repo}` };
  if (sha === head) return { id: "review", status: "pass", summary: `independent review covers HEAD ${head.slice(0, 7)}` };
  const since = run(["git", "log", "--oneline", `${sha}..HEAD`], repo).out.trim().split("\n").filter(Boolean);
  return {
    id: "review",
    status: "fail",
    summary: `review covered ${sha.slice(0, 7)} but HEAD is ${head.slice(0, 7)}: ${since.length || "some"} commit(s) since were never reviewed`,
    evidence: since.slice(0, 15),
  };
}

export function audit(repoIn: string, opts: Opts = {}): Report {
  const repo = resolve(repoIn);
  const run = opts.run ?? defaultRun;
  invariant(existsSync(join(repo, ".git")), `${repo} is not a git repository root`);
  const files = tracked(repo, run);
  const checks: Check[] = [
    checkDenyList(repo, true),
    ...checkSecrets(repo, run),
    ...checkHead(repo, files, run),
    checkLicense(files),
    checkReadme(repo, files, run),
    checkDependencyLicenses(repo, run, files),
    checkHistory(repo, run),
    checkReview(opts.reviewRepo ?? repo, opts.reviewed, run),
  ];
  if (!opts.noBuild) checks.push(checkCleanBuild(repo, opts.build ?? detectBuild(repo, files), run));
  else checks.push({ id: "clean-build", status: "unavailable", summary: "skipped (--no-build)" });
  if (opts.historyOk) for (const c of checks) if (c.id === "history" && c.status === "warn") c.status = "pass";
  const blocked = checks.some((c) => c.status === "fail" || c.status === "unavailable");
  return { repo, mode: "audit", verdict: blocked ? "NOT READY" : "READY", checks };
}

/** Lines of a .publicignore: gitignore syntax, # comments. The file never ships itself. */
export function publicIgnore(repo: string): string[] {
  const p = join(repo, ".publicignore");
  const lines = existsSync(p) ? readFileSync(p, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  return [...lines, ".publicignore"];
}

export function exportRepo(repoIn: string, outIn: string, opts: Opts = {}): Report {
  const repo = resolve(repoIn);
  const out = resolve(outIn);
  const run = opts.run ?? defaultRun;
  invariant(existsSync(join(repo, ".git")), `${repo} is not a git repository root`);
  invariant(!existsSync(out) || readdirSync(out).length === 0, `export target ${out} exists and is not empty; refusing to overwrite`);
  invariant(!out.startsWith(repo + "/") && out !== repo, "export target must sit outside the source repo");
  mkdirSync(out, { recursive: true });

  // Argument arrays only: a path with $() or backticks must never reach a shell. The tar goes
  // through a temp file so no pipe (and no shell) is needed.
  const tarball = join(process.env.TMPDIR ?? "/tmp", `publicready-export-${process.pid}-${Date.now()}.tar`);
  try {
    const arch = run(["git", "-C", repo, "archive", "--format=tar", "-o", tarball, "HEAD"], repo);
    invariant(arch.code === 0, `git archive failed: ${arch.err.trim()}`);
    const untar = run(["tar", "-x", "-C", out, "-f", tarball], repo);
    invariant(untar.code === 0, `tar extract failed: ${untar.err.trim()}`);
  } finally {
    rmSync(tarball, { force: true });
  }
  run(["git", "init", "--quiet", "-b", "main"], out);
  const exclude = join(out, ".git", "info", "exclude");
  writeFileSync(exclude, publicIgnore(repo).join("\n") + "\n");
  // Only .publicignore decides what is dropped. Every archived file was committed at HEAD, so the
  // archived .gitignore files must not drop any of them: list matches against the exclude file
  // alone (no --exclude-standard), remove those, then stage the rest with --force.
  const dropped = run(["git", "ls-files", "-z", "--others", "--ignored", "--directory", `--exclude-from=${exclude}`], out);
  invariant(dropped.code === 0, `git ls-files failed: ${dropped.err.trim()}`);
  for (const p of dropped.out.split("\0").filter(Boolean)) rmSync(join(out, p), { recursive: true, force: true });
  const add = run(["git", "add", "-A", "--force"], out);
  invariant(add.code === 0, `git add failed: ${add.err.trim()}`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+0000");
  const name = run(["git", "config", "user.name"], repo).out.trim();
  const email = run(["git", "config", "user.email"], repo).out.trim();
  invariant(name && email, "git user.name and user.email must be set in the source repo");
  const commit = run(["git", "commit", "--quiet", "-m", "Initial public release"], out, {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: now, GIT_COMMITTER_DATE: now,
  });
  invariant(commit.code === 0, `export commit failed: ${commit.err.trim()}`);
  const count = run(["git", "rev-list", "--count", "HEAD"], out).out.trim();
  invariant(count === "1", `export must hold exactly one commit, found ${count}`);

  // The review is checked against the source commit the export was archived from.
  const report = audit(out, { ...opts, historyOk: true, reviewRepo: repo });
  return { ...report, repo, mode: "export", exportDir: out };
}

/** One published repo, as GitHub reports it now. Read-only: every call is a gh GET. */
export interface LiveRepo { repo: string; checks: Check[]; ok: boolean }

const ghJson = (run: Runner, argv: string[]): unknown | null => {
  const r = run(["gh", ...argv], process.cwd());
  if (r.code !== 0) return null;
  try { return JSON.parse(r.out); } catch { return null; }
};

export function checkLive(repo: string, run: Runner = defaultRun): LiveRepo {
  const [owner, name] = repo.split("/");
  invariant(Boolean(owner && name), `expected owner/repo, got ${repo}`);
  const q = `query { repository(owner: "${owner}", name: "${name}") { visibility usesCustomOpenGraphImage } }`;
  const meta = ghJson(run, ["api", "graphql", "-f", `query=${q}`]) as { data?: { repository?: { visibility: string; usesCustomOpenGraphImage: boolean } } } | null;
  const r = meta?.data?.repository;
  const vuln = ghJson(run, ["api", `repos/${repo}/private-vulnerability-reporting`]) as { enabled?: boolean } | null;
  const runs = ghJson(run, ["run", "list", "-R", repo, "--limit", "1", "--json", "status,conclusion,workflowName"]) as { status: string; conclusion: string; workflowName: string }[] | null;
  const checks: Check[] = [
    !r ? { id: "visibility", status: "unavailable", summary: "GitHub did not return the repository" }
      : r.visibility === "PUBLIC" ? { id: "visibility", status: "pass", summary: "public" }
      : { id: "visibility", status: "fail", summary: `visibility is ${r.visibility}` },
    !r ? { id: "social-preview", status: "unavailable", summary: "GitHub did not return the repository" }
      : r.usesCustomOpenGraphImage ? { id: "social-preview", status: "pass", summary: "custom social preview set" }
      : { id: "social-preview", status: "fail", summary: "no custom social preview: upload the 1280x640 card in Settings → Social preview (GitHub has no API for it)" },
    vuln === null ? { id: "vuln-reporting", status: "unavailable", summary: "could not read private vulnerability reporting" }
      : vuln.enabled ? { id: "vuln-reporting", status: "pass", summary: "private vulnerability reporting on" }
      : { id: "vuln-reporting", status: "fail", summary: `private vulnerability reporting off: gh api -X PUT repos/${repo}/private-vulnerability-reporting` },
    runs === null ? { id: "ci", status: "unavailable", summary: "could not list workflow runs" }
      : runs.length === 0 ? { id: "ci", status: "warn", summary: "no CI runs" }
      : runs[0]!.conclusion === "success" ? { id: "ci", status: "pass", summary: `latest ${runs[0]!.workflowName} run passed` }
      : runs[0]!.status !== "completed" ? { id: "ci", status: "warn", summary: `latest ${runs[0]!.workflowName} run is ${runs[0]!.status}` }
      : { id: "ci", status: "fail", summary: `latest ${runs[0]!.workflowName} run: ${runs[0]!.conclusion}` },
  ];
  // Every check must pass: a warn (no CI run yet, or one still in progress) is not a passed run.
  return { repo, checks, ok: checks.every((c) => c.status === "pass") };
}

/** Every public, non-fork, non-archived repo the owner has. */
export function listPublicRepos(owner: string, run: Runner = defaultRun): string[] {
  const out = run(["gh", "repo", "list", owner, "--visibility", "public", "--source", "--no-archived", "--limit", "1000", "--json", "nameWithOwner", "-q", ".[].nameWithOwner"], process.cwd());
  invariant(out.code === 0, `gh repo list failed: ${out.err.trim()}`);
  return out.out.split("\n").map((s) => s.trim()).filter(Boolean);
}

function renderLive(rows: LiveRepo[]): string {
  const mark: Record<Status, string> = { pass: "✅", fail: "❌", warn: "⚠️", unavailable: "⏳" };
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`${r.ok ? "🟢" : "🔴"} ${r.repo}`);
    for (const c of r.checks) if (c.status !== "pass" || rows.length === 1) lines.push(`   ${mark[c.status]} ${c.id}: ${c.summary}`);
  }
  if (rows.length > 1) lines.push("", `${rows.filter((r) => r.ok).length} of ${rows.length} repos fully set up.`);
  return lines.join("\n");
}

function render(r: Report): string {
  const mark: Record<Status, string> = { pass: "✅", fail: "❌", warn: "⚠️", unavailable: "⏳" };
  const lines = [`${r.verdict === "READY" ? "🟢" : "🔴"} ${r.verdict} — ${r.mode} of ${r.repo}${r.exportDir ? ` → ${r.exportDir}` : ""}`, ""];
  for (const c of r.checks) {
    lines.push(`${mark[c.status]} ${c.id}: ${c.summary}`);
    for (const e of c.evidence ?? []) lines.push(`     ${e}`);
  }
  lines.push("", "Nothing was pushed, created or made public.");
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [cmd, repo] = args;
  const flag = (n: string) => args.includes(n);
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  if (cmd === "live") {
    const rows = flag("--all") ? listPublicRepos(val("--all")!).map((r) => checkLive(r)) : [checkLive(repo!)];
    console.log(flag("--json") ? JSON.stringify(rows, null, 2) : renderLive(rows));
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }
  if (!cmd || !repo || !["audit", "export"].includes(cmd) || (cmd === "export" && !val("--out"))) {
    console.error("usage: PublicReady.ts audit <repo> [--json] [--no-build] [--build \"<cmd>\"] [--history-ok] [--reviewed <sha>]\n       PublicReady.ts export <repo> --out <dir> [--json] [--no-build] [--build \"<cmd>\"] [--reviewed <sha>]\n       PublicReady.ts live <owner/repo> | --all <owner> [--json]");
    process.exit(2);
  }
  try {
    const opts: Opts = { build: val("--build") ?? undefined, noBuild: flag("--no-build"), historyOk: flag("--history-ok"), reviewed: val("--reviewed") };
    const r = cmd === "audit" ? audit(repo, opts) : exportRepo(repo, val("--out")!, opts);
    console.log(flag("--json") ? JSON.stringify(r, null, 2) : render(r));
    process.exit(r.verdict === "READY" ? 0 : 1);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(2);
  }
}
