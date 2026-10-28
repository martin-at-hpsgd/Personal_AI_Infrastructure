#!/usr/bin/env bun
/**
 * ReleaseRecord — every deploy carries its version and CHANGELOG entry.
 *
 * One deployed app sat at the same
 * version through three months of shipped features
 * so the record is now part of the process everywhere, not left to memory.
 * CfEnv.ts runs `check` before every deploy, so the record is kept by the deploy path itself,
 * in every repo.
 *
 *   bun ReleaseRecord.ts status  [dir] [--json]   version, last release marker, unrecorded commits
 *   bun ReleaseRecord.ts check   [dir]            exit 1 when shipping commits are not recorded or the newest release left
 *                                                 its governing ISA out of sync (no criterion change), 2 when git history cannot be read
 *
 * Code sync (ISASystem.md § Code sync, {{PRINCIPAL_NAME}} 2026-10-24): `prepare` refuses, and `check` fails, a release whose
 * shipping commits change code governed by an ISA (IsaGoverning.ts) with no criterion line added, ticked or changed
 * in that ISA over the same range. This is the ship gate, so a feature cannot reach a release with its ISA untouched.
 *   bun ReleaseRecord.ts prepare [dir] --notes "<what shipped, in plain words>" [--isc "ISC-12,ISC-13"] [--caps N] [--no-commit]
 *
 * The record: a section on top of CHANGELOG.md per release, `## <version> — <date>`, then
 * `<!-- release: <sha> -->` naming the last commit it covers, then the notes. The version
 * lives in package.json when present, else VERSION. Bump: minor + one per Deeds cap in range,
 * else patch + 1; a repo's first release is one minor step; never major (human-gated).
 * `check` is pure git so a model outage can never block a deploy; only `prepare` calls Deeds.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { invariant } from "./Invariant";
import { changedCriteria, CRITERION_ID, governingIsa, isCodeFile } from "./IsaGoverning";
import { appNameFor, recordAppRow, releaseRow } from "./StatvsAppRows";

const MARKER = /<!-- release: ([0-9a-f]{7,40}) -->/;
const MARKER_ALL = /<!-- release: ([0-9a-f]{7,40}) -->/g;
const ISC_MARKER = /<!-- isc: ([^>]*) -->/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export type Commit = { sha: string; subject: string; files: string[]; pkgVersionOnly?: boolean };
export type Status = {
  root: string;
  version: string | null;
  versionFile: "package.json" | "VERSION" | null;
  marker: string | null;
  markerInHistory: boolean;
  unrecorded: Commit[];
};

function git(root: string, args: string[]): { ok: boolean; code: number | null; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  return { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
}

export function repoRoot(dir: string): string {
  const r = git(resolve(dir), ["rev-parse", "--show-toplevel"]);
  if (!r.ok || !r.out) throw new Error(`${dir} is not inside a git repository`);
  return r.out;
}

const isRecordFile = (f: string) => f.endsWith(".md") || basename(f) === "ISA.html" || f === "VERSION";

/**
 * A commit that ships nothing: every file it touches is a doc or a record. Only the file list decides, never the
 * subject, so a `release:` subject on a code change still counts as shipping. The root package.json counts as a
 * record only when the commit changed nothing in it but the version field (`pkgVersionOnly`), as `prepare` does.
 */
export function isRecordOnly(c: Pick<Commit, "files" | "pkgVersionOnly">): boolean {
  return c.files.length > 0 && c.files.every((f) => isRecordFile(f) || (basename(f) === "package.json" && c.pkgVersionOnly === true));
}

export function lastMarker(changelog: string | null): string | null {
  return changelog?.match(MARKER)?.[1] ?? null;
}

/** Every release marker, newest first. */
export function allMarkers(changelog: string | null): string[] {
  return changelog ? [...changelog.matchAll(MARKER_ALL)].map((m) => m[1]!) : [];
}

/** The day the code-sync rule began; release sections dated earlier predate it and are not held to it. */
export const CODE_SYNC_SINCE = "2026-10-24";

/** The date on the newest release section header (`## 1.2.3 — 2026-10-24`), or null. */
export function newestSectionDate(changelog: string | null): string | null {
  return changelog?.match(/^## \S+ — (\d{4}-\d{2}-\d{2})/m)?.[1] ?? null;
}

/** The criteria the newest release section names (`<!-- isc: ISC-1, ISC-2 -->`), empty when it names none. */
export function newestIscs(changelog: string | null): string[] {
  if (!changelog) return [];
  const start = changelog.search(/^## /m);
  if (start < 0) return [];
  const next = changelog.slice(start + 3).search(/^## /m);
  const section = next < 0 ? changelog.slice(start) : changelog.slice(start, start + 3 + next);
  return parseIscs(section.match(ISC_MARKER)?.[1] ?? "");
}

export function parseIscs(list: string): string[] {
  return [...new Set(list.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => CRITERION_ID.test(x)))];
}

/**
 * Code sync at ship time (ISASystem.md § Code sync): when the shipping commits in `from..HEAD` change code governed
 * by an ISA, the release names the criteria it ships (`iscs`), and at least one of them has its criterion line
 * added, ticked or changed in that ISA over the same range. Naming them is what stops an unrelated tick (a prior
 * release's acceptance landing after it) from passing for this release. Null when in sync; else the message.
 * A first release (`from` null) has no range to compare and is not checked.
 */
export function isaProblem(root: string, from: string | null, iscs: string[] = []): string | null {
  if (!from) return null;
  const repo = realpathSync(repoRoot(root));
  const pkgRel = relative(repo, join(root, "package.json"));
  const shipping = commitsSince(root, from, releaseScope(root, repo), pkgRel).filter((c) => !isRecordOnly(c));
  const owed = new Map<string, Set<string>>();
  for (const c of shipping) {
    for (const f of c.files) {
      if (!isCodeFile(join(repo, f))) continue;
      const isa = governingIsa(join(repo, f));
      if (!isa || !(isa === repo || isa.startsWith(repo + "/"))) continue;
      if (!owed.has(isa)) owed.set(isa, new Set());
      owed.get(isa)!.add(f);
    }
  }
  const missing: string[] = [];
  for (const [isa, files] of owed) {
    const d = git(repo, ["diff", `${from}..HEAD`, "--", relative(repo, isa)]);
    if (!d.ok) throw new Error(`could not diff ${relative(repo, isa)} over ${from.slice(0, 7)}..HEAD (git exited ${d.code ?? "on a signal"}); the ISA cannot be called in sync`);
    const changed = changedCriteria(d.out);
    if (iscs.some((id) => changed.has(id))) continue;
    const list = [...files].slice(0, 5).join(", ") + (files.size > 5 ? `, …and ${files.size - 5} more` : "");
    // Naming stays required (an unrelated tick must not pass), but the refusal lists what did change so the
    // fix is one rerun, never a hunt through the ISA diff.
    const seen = changed.size ? ` (criteria changed in this range: ${[...changed].join(", ")})` : " (no criterion line changed in this range)";
    const why = !iscs.length
      ? `the release names no criteria${seen}`
      : `none of ${iscs.join(", ")} had its criterion line added, ticked or changed there${seen}`;
    missing.push(`  ${relative(repo, isa)} — code changed (${list}), but ${why}`);
  }
  if (!missing.length) return null;
  return `the ISA is not in sync with the code this release ships (ISASystem.md § Code sync):\n${missing.join("\n")}\nAdd or tick the criteria for what changed, with their evidence, commit the ISA, and name them on the release: prepare … --isc "ISC-12,ISC-13".`;
}

/** True when the commit's package.json differs from its parent's in the version field alone; any doubt is false (shipping). */
function packageVersionOnly(root: string, sha: string, pkgRel = "package.json"): boolean {
  const read = (rev: string): Record<string, unknown> | null => {
    const r = git(root, ["show", `${rev}:${pkgRel}`]);
    if (!r.ok) return null;
    try { const j = JSON.parse(r.out) as unknown; return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null; } catch { return null; }
  };
  const now = read(sha), before = read(`${sha}^`);
  if (!now || !before) return false;
  const { version: _a, ...restNow } = now;
  const { version: _b, ...restBefore } = before;
  return isDeepStrictEqual(restNow, restBefore);
}

/** Every commit past the marker. A history that cannot be read throws: an unreadable range is never an empty one. */
function commitsSince(root: string, marker: string | null, scope: string[] = [], pkgRel = "package.json"): Commit[] {
  const range = marker ? `${marker}..HEAD` : "HEAD";
  const r = git(root, ["log", "--format=%x00%H%x09%s", "--name-only", range, ...(scope.length > 0 ? ["--", ...scope.map((p) => `:(top)${p}`)] : [])]);
  if (!r.ok) throw new Error(`could not read the git history ${range} in ${root} (git exited ${r.code ?? "on a signal"}: ${r.err.split("\n")[0] || "no message"}); the record cannot be called current`);
  if (!r.out) return [];
  return r.out.split("\0").filter(Boolean).map((block) => {
    const [head, ...rest] = block.split("\n");
    const [sha, ...subj] = head!.split("\t");
    const files = rest.map((l) => l.trim()).filter(Boolean);
    const c: Commit = { sha: sha!, subject: subj.join("\t"), files };
    if (files.includes(pkgRel) && files.every((f) => f === pkgRel || isRecordFile(f))) c.pkgVersionOnly = packageVersionOnly(root, c.sha, pkgRel);
    return c;
  });
}

/** Is the marker an ancestor of HEAD? git's exit 1 is no; a marker this repo does not have is no; any other failure throws. */
function markerIsAncestor(root: string, marker: string): boolean {
  const r = git(root, ["merge-base", "--is-ancestor", marker, "HEAD"]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  if (!git(root, ["rev-parse", "--verify", "-q", `${marker}^{commit}`]).ok) return false;
  throw new Error(`could not read the git history between ${marker.slice(0, 7)} and HEAD in ${root} (git exited ${r.code ?? "on a signal"}: ${r.err.split("\n")[0] || "no message"}); the record cannot be called current`);
}

export function readVersion(root: string): { version: string | null; file: Status["versionFile"] } {
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    const v = (JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown }).version;
    if (typeof v === "string") return { version: v, file: "package.json" };
  }
  const vf = join(root, "VERSION");
  if (existsSync(vf)) return { version: readFileSync(vf, "utf8").trim() || null, file: "VERSION" };
  return { version: null, file: null };
}

/**
 * The folder that owns the release record: the nearest folder from dir up to the repo root whose package.json has a
 * version, or that holds a VERSION file. A deployable inside a larger repo (a Worker under ~/.claude) keeps its own
 * CHANGELOG and version there instead of the whole repo's; with none on the way up, the repo root, as before.
 */
export function recordRoot(dir: string): string {
  const repo = repoRoot(dir);
  let d = realpathSync(resolve(dir));
  while (d === repo || d.startsWith(repo + "/")) {
    if (readVersion(d).version !== null) return d;
    if (d === repo) break;
    d = dirname(d);
  }
  return repo;
}

/**
 * The paths whose commits a record covers, relative to the repo root: everything for a repo-root record; for a
 * nested one, its package.json "releaseScope" (paths relative to the record folder, such as ".." for the code it
 * imports beside it), else the record folder alone.
 */
export function releaseScope(root: string, repo: string): string[] {
  if (root === repo) return [];
  let declared: unknown;
  try { declared = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { releaseScope?: unknown }).releaseScope; } catch { declared = undefined; }
  const list = Array.isArray(declared) && declared.length > 0 && declared.every((p) => typeof p === "string" && p.length > 0) ? (declared as string[]) : ["."];
  return list.map((p) => {
    const rel = relative(repo, resolve(root, p));
    invariant(!rel.startsWith(".."), `releaseScope path ${p} in ${root}/package.json leaves the repo`);
    return rel || ".";
  });
}

export function status(dir: string): Status {
  const root = recordRoot(dir);
  const repo = repoRoot(dir);
  const clPath = join(root, "CHANGELOG.md");
  const marker = lastMarker(existsSync(clPath) ? readFileSync(clPath, "utf8") : null);
  const markerInHistory = marker ? markerIsAncestor(root, marker) : false;
  const { version, file } = readVersion(root);
  const pkgRel = relative(repo, join(root, "package.json"));
  const unrecorded = (marker && markerInHistory ? commitsSince(root, marker, releaseScope(root, repo), pkgRel) : []).filter((c) => !isRecordOnly(c));
  return { root, version, versionFile: file, marker, markerInHistory, unrecorded };
}

/** Next version: a first release is one minor step; caps add one minor step each; else a patch. Never major. */
export function nextVersion(current: string | null, caps: number, firstRelease: boolean): string {
  const m = (current ?? "0.0.0").match(VERSION_RE);
  invariant(m, `version "${current}" is not x.y.z; fix it by hand before a release record`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  invariant(Number.isInteger(caps) && caps >= 0, `cap count must be a non-negative integer, got ${caps}`);
  if (firstRelease || caps > 0) return `${maj}.${min + Math.max(caps, 1)}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** The CHANGELOG with a release section on top; everything that was there stays byte-identical below it. */
export function insertSection(changelog: string | null, section: string): string {
  if (changelog === null) return `# Changelog\n\n${section}`;
  const firstLine = changelog.indexOf("\n");
  if (changelog.startsWith("# ") && firstLine > 0) {
    const head = changelog.slice(0, firstLine + 1);
    const rest = changelog.slice(firstLine + 1).replace(/^\n+/, "");
    return `${head}\n${section}${rest}`;
  }
  return `${section}${changelog}`;
}

export function sectionFor(version: string, date: string, sha: string, notes: string, iscs: string[] = []): string {
  const isc = iscs.length ? `<!-- isc: ${iscs.join(", ")} -->\n` : "";
  return `## ${version} — ${date}\n<!-- release: ${sha} -->\n${isc}\n${notes.trim()}\n\n`;
}

/** Deeds caps whose commit is one of `shas`, or null when Deeds could not run. */
function countCaps(root: string, shas: string[], oldestIso: string): number | null {
  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(oldestIso)) / 86_400_000) + 1);
  const r = spawnSync("deeds", ["analyze", root, "--since", `${days}d`, "--json"], { encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 26 });
  if (r.status !== 0) return null;
  try {
    const caps = (JSON.parse(r.stdout) as { data?: { caps?: { sha?: string }[] } }).data?.caps ?? [];
    return caps.filter((c) => c.sha && shas.some((s) => s.startsWith(c.sha!))).length;
  } catch {
    return null;
  }
}

function writeVersion(root: string, file: Status["versionFile"], version: string): string {
  invariant(VERSION_RE.test(version), `refusing to write malformed version ${version}`);
  if (file === "package.json") {
    const p = join(root, "package.json");
    const text = readFileSync(p, "utf8");
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, (_m, a, b) => `${a}${version}${b}`);
    invariant(next !== text || text.includes(`"version": "${version}"`), "package.json version field not rewritten");
    writeFileSync(p, next);
    return "package.json";
  }
  writeFileSync(join(root, "VERSION"), `${version}\n`);
  return "VERSION";
}

function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function prepare(dir: string, notes: string, opts: { caps?: number; commit?: boolean; iscs?: string[] } = {}): { version: string; files: string[]; capsUsed: number | null; note?: string } {
  invariant(notes.trim().length >= 10, "--notes must say what shipped, in plain words");
  const s = status(dir);
  const firstRelease = !s.marker || !s.markerInHistory;
  if (!firstRelease && s.unrecorded.length) {
    const problem = isaProblem(s.root, s.marker, opts.iscs ?? []);
    if (problem) throw new Error(problem);
  }
  const head = git(s.root, ["rev-parse", "HEAD"]).out;
  invariant(/^[0-9a-f]{40}$/.test(head), "could not read HEAD");
  let caps = opts.caps ?? null;
  let note: string | undefined;
  if (caps === null && !firstRelease && s.unrecorded.length) {
    const oldest = git(s.root, ["log", "-1", "--format=%cI", s.unrecorded.at(-1)!.sha]).out;
    caps = countCaps(s.root, s.unrecorded.map((c) => c.sha), oldest);
    if (caps === null) { caps = 0; note = "Deeds could not run, so this is a patch bump; rerun with --caps N if features shipped."; }
  }
  const version = nextVersion(s.version, caps ?? 0, firstRelease);
  const clPath = join(s.root, "CHANGELOG.md");
  const before = existsSync(clPath) ? readFileSync(clPath, "utf8") : null;
  const after = insertSection(before, sectionFor(version, localDate(), head, notes, opts.iscs ?? []));
  invariant(before === null || after.endsWith(before.replace(/^# [^\n]*\n\n*/, "")), "earlier CHANGELOG content would change");
  writeFileSync(clPath, after);
  const files = ["CHANGELOG.md", writeVersion(s.root, s.versionFile, version)];
  if (opts.commit !== false) {
    const add = git(s.root, ["add", "--", ...files]);
    invariant(add.ok, "git add of the release files failed");
    const c = spawnSync("git", ["commit", "-q", "--only", "-m", `release: v${version}`, "--", ...files], { cwd: s.root, encoding: "utf8" });
    invariant(c.status === 0, `release commit failed: ${c.stderr}`);
  }
  // The same release, in STATVS (ISC-111).
  const commit = opts.commit !== false ? git(s.root, ["rev-parse", "HEAD"]).out : head;
  recordAppRow(releaseRow({ app: appNameFor(s.root).app, from: s.version, to: version, caps, notes, commit, repo: s.root }));
  return { version, files, capsUsed: caps, note };
}

function prepareHint(root: string): string {
  return `bun ${join(import.meta.dir, "ReleaseRecord.ts")} prepare ${JSON.stringify(root)} --notes "<what shipped, in plain words>" --isc "<the criteria it ships, when the repo has an ISA>"`;
}

/** The check CfEnv runs before a deploy: null when the record covers HEAD, else why not. */
export function checkProblem(s: Status): string | null {
  if (!s.marker) return `no release record in ${s.root}/CHANGELOG.md yet. Write the first one:\n  ${prepareHint(s.root)}`;
  if (!s.markerInHistory) return `the last release marker ${s.marker.slice(0, 7)} is not in this branch's history. Write a fresh record:\n  ${prepareHint(s.root)}`;
  if (!s.unrecorded.length) return null;
  const list = s.unrecorded.slice(0, 12).map((c) => `  ${c.sha.slice(0, 7)} ${c.subject}`).join("\n");
  const more = s.unrecorded.length > 12 ? `\n  …and ${s.unrecorded.length - 12} more` : "";
  return `${s.unrecorded.length} shipping commit(s) past v${s.version ?? "?"} are not in the release record:\n${list}${more}\nRecord them (bumps the version and adds the CHANGELOG entry):\n  ${prepareHint(s.root)}`;
}

/**
 * The full pre-deploy check: the record covers HEAD, and the newest release's range (the marker before it ..HEAD)
 * kept the ISA in sync with the code, so a hand-written CHANGELOG entry cannot ship an out-of-sync ISA.
 */
export function checkAll(dir: string): string | null {
  const s = status(dir);
  const recordProblem = checkProblem(s);
  if (recordProblem) return recordProblem;
  const clPath = join(s.root, "CHANGELOG.md");
  const changelog = existsSync(clPath) ? readFileSync(clPath, "utf8") : null;
  const previous = allMarkers(changelog)[1] ?? null;
  // A section dated before the rule began was written under the old contract; one dated after (or undated) is held to it.
  const date = newestSectionDate(changelog);
  if (date !== null && date < CODE_SYNC_SINCE) return null;
  return previous && markerIsAncestor(s.root, previous) ? isaProblem(s.root, previous, newestIscs(changelog)) : null;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const dir = rest.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--notes", "--caps", "--isc"].includes(rest[i - 1]!))) ?? process.cwd();
  try {
    if (cmd === "status") {
      const s = status(dir);
      if (rest.includes("--json")) console.log(JSON.stringify(s, null, 1));
      else console.log(`${s.root}\n  version ${s.version ?? "(none)"} in ${s.versionFile ?? "(nowhere yet)"}\n  last release ${s.marker ? s.marker.slice(0, 7) : "(none)"}\n  unrecorded shipping commits ${s.unrecorded.length}`);
    } else if (cmd === "check") {
      const problem = checkAll(dir);
      if (problem) { console.error(`release record: ${problem}`); process.exit(1); }
      console.log("release record: ok");
    } else if (cmd === "prepare") {
      const notes = flag("--notes");
      if (!notes) { console.error("prepare needs --notes \"<what shipped, in plain words>\""); process.exit(2); }
      const caps = flag("--caps");
      const r = prepare(dir, notes, { caps: caps === undefined ? undefined : Number(caps), commit: !rest.includes("--no-commit"), iscs: parseIscs(flag("--isc") ?? "") });
      console.log(`release record: v${r.version} written to ${r.files.join(", ")}${r.capsUsed !== null ? ` (${r.capsUsed} cap${r.capsUsed === 1 ? "" : "s"})` : ""}`);
      if (r.note) console.error(`release record: ${r.note}`);
    } else {
      console.error("usage: ReleaseRecord.ts status|check|prepare [dir] [--notes \"…\"] [--isc \"ISC-1,ISC-2\"] [--caps N] [--no-commit] [--json]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`release record: ${(e as Error).message}`);
    process.exit(2);
  }
}
