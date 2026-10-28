#!/usr/bin/env bun
/**
 * @version 1.3.28
 */
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * WorkSweep.ts — Periodic sweep that catches what event-driven hooks miss.
 *
 * Triggered by ~/Library/LaunchAgents/com.lifeos.worksweep.plist every 60 minutes.
 * Also runnable on-demand:
 *
 *   bun ~/.claude/LIFEOS/TOOLS/WorkSweep.ts            # apply
 *   bun ~/.claude/LIFEOS/TOOLS/WorkSweep.ts --dry-run  # show diff only
 *   bun ~/.claude/LIFEOS/TOOLS/WorkSweep.ts --since 48h  # widen the scan window
 *
 * What it does (2026-08-15 methodology: the board holds forward work only):
 *   1. Scans MEMORY/WORK/*\/ISA.md for sessions modified in the last 24h
 *   2. For each session with no github_issue: writeback AND no existing repo
 *      issue matching the slug, opens a labeled issue if the session meets
 *      the meaningful-work threshold — and CLOSES it immediately when the
 *      session is complete (a searchable record, zero board weight)
 *   3. Adds `stale` label to issues whose ISA hasn't moved in 7d
 *   4. Writes MEMORY/STATE/work-digest.md — top priorities, overdue reminders,
 *      plus the recurring-state panel (goals without open work, stale projects,
 *      BLE cadence) that used to flood the board as [Goal]/[Project-Check]/[BLE]
 *      issues. Those issue classes are retired (ratified 2026-08-15); state
 *      renders in Pulse and the digest, never as work items.
 *   5. Calls RegenerateTasklist with --commit-push as the final step (skipped when a lookup failed)
 *   6. Appends one JSON line to MEMORY/OBSERVABILITY/worksweep.jsonl
 *
 * Exit: 0 when every step ran; 2 when a dedup lookup (open-issue list or slug search) failed, in
 * which case no issue is created for the affected sessions, because a failed lookup is not proof
 * the issue is absent; 1 on a fatal error. Other gh failures (labels, close) log and continue.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, appendFileSync } from "fs";
import { getDAName } from "../../hooks/lib/identity"

import { isAbsolute, join } from "path";
import { loadWorkConfig } from "../../hooks/lib/work-config";
import { phaseHasWorkStarted, phaseBracket } from "./ascent";
import { redactIssuePayload } from "./lib/WorkRedact";
import { invariant } from "./Invariant";
import { homedir } from "node:os";
import { getClaudeDir, getLifeosDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { resolveCarrierId } from "./models";

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


declare const Bun: { spawn: (cmd: string[], opts?: any) => any };

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
const LIFEOS_DIR = getLifeosDir();
const WORK_DIR = join(LIFEOS_DIR, "MEMORY", "WORK");
const OBS_DIR = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const OBS_LOG = join(OBS_DIR, "worksweep.jsonl");
const PROJECTS_MD = join(LIFEOS_DIR, "USER", "PROJECTS.md");
const PRINCIPAL_TELOS = join(LIFEOS_DIR, "USER", "TELOS", "PRINCIPAL_TELOS.md");
const STATE_DIR = join(LIFEOS_DIR, "MEMORY", "STATE");
const BLE_AUDIT_STATE = join(STATE_DIR, "ble-last-audit.json");
// Institutionalized subtraction: the system accretes scaffolding faster than it prunes,
// so a BLE pass fires on a cadence instead of depending on someone remembering. Tune here.
const BLE_CADENCE_DAYS = 30;
// The second trigger: a carrier change. Rules written to correct one model generation make
// the next one overcorrect (r/ClaudeCode, 2026-07-29: "never dismiss a bug as unrelated"
// became "fix everything you find"), so the pass is due the moment the carrier moves,
// whatever the calendar says. Any change in the resolved carrier id counts, point releases
// included — the false-alarm cost is one reminder line.
const SETTINGS_JSON = join(getClaudeDir(), "settings.json");

interface ISAFm {
  task: string;
  slug: string;
  effort: string;
  phase: string;
  mode: string;
  started: string;
  updated: string;
  project?: string;
  principal_stated_goal?: string;
  github_issue?: number;
  milestone?: string;
  milestone_progress?: string;
}

interface SweepStats {
  ts: string;
  sessions_scanned: number;
  issues_created: number;
  issues_updated: number;
  issues_stale_labeled: number;
  project_checks_created: number;
  goal_issues_created: number;
  ble_reminder_created: number;
  /** Dedup lookups that could not answer; any makes the run exit 2. */
  lookup_failures: number;
  duration_ms: number;
  errors: string[];
}

function parseFrontmatter(content: string): ISAFm | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm: Record<string, string | number> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const v = kv[2].replace(/^["']|["']$/g, "");
      fm[kv[1]] = /^\d+$/.test(v) ? parseInt(v, 10) : v;
    }
  }
  return fm as unknown as ISAFm;
}

function listSessionDirs(): string[] {
  if (!existsSync(WORK_DIR)) return [];
  return readdirSync(WORK_DIR)
    .map((n) => join(WORK_DIR, n))
    // existsSync first: a symlink whose target is gone makes statSync throw and killed the whole sweep (ACH-0366).
    .filter((p) => existsSync(p) && statSync(p).isDirectory() && existsSync(join(p, "ISA.md")));
}

function isMeaningfulWork(fm: ISAFm, isaPath: string): boolean {
  // Skip empty/abandoned scaffolds — no progress, no phase advance.
  // ALGORITHM sessions: the run must have left articulation. Resolved through
  // ascent.ts, never a local phase list — the list that was here held the
  // RETIRED 8-station vocabulary, so a modern `climbing` run counted as an
  // abandoned scaffold and never got an issue (2026-07-30 phase-lane sweep).
  if (fm.mode !== "native") {
    return phaseHasWorkStarted(fm.phase);
  }
  // NATIVE sessions: require ≥2 artifacts beyond ISA.md in the dir (signals real work,
  // not a placeholder native row with only the scaffold).
  try {
    const dir = isaPath.replace(/\/ISA\.md$/, "");
    const contents = readdirSync(dir).filter((n) => n !== "ISA.md" && !n.startsWith("."));
    return contents.length >= 2;
  } catch {
    return false;
  }
}

function taskOrSlug(fm: ISAFm): string {
  // Fallback when older ISAs don't have a task field — use slug as readable approximation.
  if (fm.task && fm.task !== "undefined") return fm.task;
  return fm.slug.replace(/^\d+-?\d*_?/, "").replace(/-/g, " ");
}

/** A gh lookup that could not answer. Distinct from "nothing found": callers must not treat it as absence. */
export class LookupFailed extends Error {
  constructor(message: string) { super(message); this.name = "LookupFailed"; }
}

/** stdout of a gh call parsed as a JSON array, or LookupFailed (non-zero exit, empty, unparseable, not an array). */
async function ghJsonArray(args: string[], what: string, timeout: number): Promise<unknown[]> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new LookupFailed(`${what}: gh exited ${exit}${err.trim() ? ` (${err.trim().split("\n", 1)[0]})` : ""}`);
  if (!out.trim()) throw new LookupFailed(`${what}: gh returned empty output`);
  let v: unknown;
  try { v = JSON.parse(out); } catch { throw new LookupFailed(`${what}: gh returned unparseable output`); }
  if (!Array.isArray(v) || !v.every((x) => x !== null && typeof x === "object")) throw new LookupFailed(`${what}: gh returned JSON that is not an array`);
  return v;
}

/** True only for an issue record carrying the fields asked for: a positive integer number and string url and title. */
function isIssueRecord(i: unknown): i is { number: number; url: string; title: string } {
  if (i === null || typeof i !== "object" || Array.isArray(i)) return false;
  const o = i as Record<string, unknown>;
  return Number.isInteger(o.number) && (o.number as number) > 0 && typeof o.url === "string" && o.url.length > 0 && typeof o.title === "string";
}

/**
 * The issue (any state) whose title carries [slug:<slug>], null when none does. Throws LookupFailed when gh cannot
 * answer, including when any entry lacks its number, url or title: an entry we cannot read may be the very match,
 * so skipping it would read as "no issue yet" and create a duplicate.
 */
export async function ghIssueSearchSlug(repo: string, slug: string): Promise<{ number: number; url: string } | null> {
  const items = await ghJsonArray(
    ["gh", "issue", "list", "--repo", repo, "--state", "all", "--search", `[slug:${slug}]`, "--limit", "3", "--json", "number,url,title"],
    `slug search ${slug}`, 8000,
  );
  if (!items.every(isIssueRecord)) throw new LookupFailed(`slug search ${slug}: an entry has no integer number, url or title`);
  const hit = items.find((i) => i.title.includes(`[slug:${slug}]`));
  return hit ? { number: hit.number, url: hit.url } : null;
}

async function ghLabelsExisting(repo: string): Promise<Set<string>> {
  const proc = Bun.spawn(
    ["gh", "label", "list", "--repo", repo, "--limit", "500", "--json", "name"],
    { stdout: "pipe", stderr: "pipe", timeout: 8000 },
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return new Set();
  try {
    const arr = JSON.parse(out) as Array<{ name: string }>;
    return new Set(arr.map((l) => l.name.toLowerCase()));
  } catch {
    return new Set();
  }
}

function filterLabels(labels: string[], existing: Set<string>): string[] {
  if (existing.size === 0) return labels;
  return labels.filter((l) => existing.has(l.toLowerCase()));
}

async function ghCreateIssue(repo: string, rawTitle: string, rawBody: string, labels: string[]): Promise<{ number: number; url: string } | null> {
  // Boundary chokepoint: session frontmatter (principal_stated_goal, task text)
  // is free text — PII is stripped here so every sweep is covered at once
  // (public issue #1825, @PaulWaldo).
  const { title, body, total } = redactIssuePayload(rawTitle, rawBody);
  if (total > 0) console.error(`[WorkSweep] redacted ${total} PII match(es) before issue create`);
  const args = ["gh", "issue", "create", "--repo", repo, "--title", title, "--body", body, ...labels.flatMap((l) => ["--label", l])];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", timeout: 10000 });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return null;
  const m = out.trim().match(/\/issues\/(\d+)$/);
  return m ? { number: parseInt(m[1], 10), url: out.trim() } : null;
}

/**
 * Frontmatter with `github_issue` / `github_issue_url` set (any prior pair
 * replaced), or null when the content has no frontmatter block. Pure — the
 * writer below owns the disk. Same shape as the maintainer-side work-sync hook's writer,
 * duplicated rather than imported because TOOLS never depends on hooks/.
 */
export function withIssueFrontmatter(isaContent: string, issueNumber: number, issueUrl: string): string | null {
  const fmMatch = isaContent.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return null;
  const header = fmMatch[2]
    .split("\n")
    .filter((l) => !/^github_issue(_url)?:/.test(l))
    .join("\n")
    .trimEnd();
  return isaContent.replace(/^---\n[\s\S]*?\n---/, `---\n${header}\ngithub_issue: ${issueNumber}\ngithub_issue_url: ${issueUrl}\n---`);
}

/**
 * Record the created issue in the ISA so the `fm.github_issue` skip above
 * dedupes on every install — the sweep created issues but never wrote the key
 * back, and the only writer was a hook the release excludes, so a second sweep
 * on any public install re-created the same issue (public issue #1936, @pybe).
 */
export function writeIssueBackToISA(isaPath: string, issueNumber: number, issueUrl: string): void {
  invariant(Number.isInteger(issueNumber) && issueNumber > 0, `issue number must be a positive integer, got ${issueNumber}`);
  invariant(/^https:\/\//.test(issueUrl), `issue url must be https, got ${issueUrl}`);
  // Re-read immediately before writing: the sweep's earlier read predates a
  // gh round-trip, and a session editing the ISA in between would have had its
  // edit overwritten by the stale copy (2026-09-03 /LI audit, finding 11).
  if (!existsSync(isaPath)) {
    console.error(`[WorkSweep] ${isaPath}: gone before write-back — github_issue not written`);
    return;
  }
  const updated = withIssueFrontmatter(readFileSync(isaPath, "utf-8"), issueNumber, issueUrl);
  if (updated === null) {
    console.error(`[WorkSweep] ${isaPath}: no frontmatter block — github_issue not written back`);
    return;
  }
  writeFileSync(isaPath, updated);
}

async function ghAddLabel(repo: string, issueNumber: number, label: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["gh", "issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label],
    { stdout: "ignore", stderr: "pipe", timeout: 8000 },
  );
  const exit = await proc.exited;
  return exit === 0;
}

/** Every open issue. Throws LookupFailed when gh cannot answer; an empty repo is [], never a failure. */
export async function ghListOpenIssues(repo: string): Promise<Array<{ number: number; title: string; labels: string[]; updatedAt: string }>> {
  const arr = await ghJsonArray(
    ["gh", "issue", "list", "--repo", repo, "--state", "open", "--limit", "500", "--json", "number,title,labels,updatedAt"],
    "open-issue list", 10000,
  ) as Array<{ number: number; title: string; labels?: Array<{ name: string }>; updatedAt: string }>;
  if (!arr.every((i) => typeof i.title === "string" && Number.isInteger(i.number))) throw new LookupFailed("open-issue list: an entry has no title or number");
  return arr.map((i) => ({ number: i.number, title: i.title, labels: (i.labels ?? []).map((l) => l.name), updatedAt: i.updatedAt }));
}

// Classify a session's work into a canonical Type:* label from its task text.
// Replaces the old hardcoded Type:queue so swept items say what they actually
// are (research / feature / problem / project / decision), making the work list
// filterable instead of a pile of undifferentiated "captured idea" rows. Order is
// most-specific-first; genuinely ambiguous text falls back to Type:queue.
// Canonical Type set lives in USER/WORK/labels.yml.
export function classifyType(text: string): string {
  const t = (text || "").toLowerCase();
  const has = (...kw: string[]) => kw.some((k) => t.includes(k));
  // Structural prefixes win — WorkSweep's own sub-sweeps mint these and the type
  // is unambiguous from the marker (a TELOS goal is a multi-month project; a
  // stalled-project nudge is friction to resolve).
  if (t.includes("[goal:") || t.startsWith("[goal]")) return "Type:project";
  if (t.includes("[project-check]")) return "Type:decision"; // "is this paused/done?" — a status decision
  if (has("fix ", "fixed", "broken", "bug", "regression", "troubleshoot", "debug", "repair", "outage", "failing", "wedge", "secure", "harden", "patch", "permanently fix", "stalled")) return "Type:problem";
  if (has("research", "investigate", "analyze", "analysis", "audit", "explore", "figure out", "deep dive", "deep research", "understand", "evaluate", "comparison", "explain", "mine ", "recommend", "assess", "review", "study", "feasibility", "options")) return "Type:research";
  if (has("decide", "decision", "should i", "choose", "pick between", "keep-or-delete", "keep or delete")) return "Type:decision";
  if (has("platform", "multi-week", "major application", "new major", "pipeline", "subsystem", "migrate", "migration", "end-to-end", "convert", "scale ", "rollout", "rework", "release ")) return "Type:project";
  if (has("build", "implement", "ship", "create", "add ", "upgrade", "redesign", "rewrite", "wire", "make ", "design", "generate", "integrate", "refactor", "deploy", "fix-up", "set up", "stand up", "lock ", "get ", "operational", "show ", "propagate", "draft", "statusline", "roster", "webhook", "csv", "enable", "support", "example section", "clean up", "unify", "extract", "replace", "dedupe", "install", "skill")) return "Type:feature";
  return "Type:queue"; // genuinely uncategorizable → stays a triage item
}

async function ghCloseIssue(repo: string, issueNumber: number, comment: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["gh", "issue", "close", String(issueNumber), "--repo", repo, "--comment", comment],
    { stdout: "ignore", stderr: "pipe", timeout: 10000 },
  );
  return (await proc.exited) === 0;
}

async function sweepSessions(
  repo: string,
  sinceMs: number,
  existingLabels: Set<string>,
  projectProperty: (p: string | undefined) => string,
  dryRun: boolean,
  maxCreate: number,
  stats: SweepStats,
  openIssues: Array<{ number: number; title: string }>,
): Promise<void> {
  const cutoff = Date.now() - sinceMs;
  const dirs = listSessionDirs();
  for (const dir of dirs) {
    const isaPath = join(dir, "ISA.md");
    const mtime = statSync(isaPath).mtimeMs;
    if (mtime < cutoff) continue;
    stats.sessions_scanned++;

    const content = readFileSync(isaPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm || !fm.slug) continue;
    if (fm.github_issue) continue; // already synced

    // Dedup layer 1: REST issue list, no search-index lag. A duplicate pair
    // once came from gh search not yet indexing a just-created issue.
    if (openIssues.some((i) => i.title.includes(`[slug:${fm.slug}]`))) continue;
    // Dedup layer 2: gh search across all states (catches closed records). A search that could
    // not answer is not "absent": skip this session rather than risk a duplicate issue.
    let existing: { number: number; url: string } | null;
    try {
      existing = await ghIssueSearchSlug(repo, fm.slug);
    } catch (e) {
      if (!(e instanceof LookupFailed)) throw e;
      console.error(`[WorkSweep] ${e.message} — not creating an issue for ${fm.slug}`);
      stats.errors.push(e.message);
      stats.lookup_failures++;
      continue;
    }
    if (existing) continue;

    if (!isMeaningfulWork(fm, isaPath)) continue;

    const isNative = fm.mode === "native";
    // Board-truth: a completed session arrives as a closed record (Status:done,
    // closed on create); an in-flight one is genuinely being worked, never "queued".
    // A milestone close (milestone_progress M/N with M==N) counts: the run is done
    // even while the project's full ideal state stays open (2026-08-17 redesign).
    const msDone = (() => {
      const m = String(fm.milestone_progress ?? "").match(/^(\d+)\/(\d+)$/);
      return !!m && m[1] === m[2] && Number(m[2]) > 0;
    })();
    const isComplete = phaseBracket(fm.phase) === "cairn" || msDone;
    const titlePrefix = isNative ? "[Native]" : "[Sweep]";
    const title = `${titlePrefix} ${taskOrSlug(fm)} [slug:${fm.slug}]`;
    const labels = filterLabels([
      "pai-sync",
      isNative ? "auto-native" : "auto-sweep",
      classifyType(taskOrSlug(fm)),
      isComplete ? "Status:done" : "Status:in-progress",
      projectProperty(fm.project),
      "Priority:P3",
      `Agent:${getDAName()}`,
    ], existingLabels);
    const goalLine = fm.principal_stated_goal ? `\n> 🎯 **Principal stated goal:** ${fm.principal_stated_goal}\n` : "";
    const body = [
      `## 🧹 Captured by WorkSweep`,
      goalLine,
      `| Field | Value |`,
      `|-------|-------|`,
      `| **Task** | ${taskOrSlug(fm)} |`,
      `| **Effort** | ${fm.effort} |`,
      `| **Mode** | ${fm.mode} |`,
      `| **Phase** | ${fm.phase} |`,
      `| **Project** | ${fm.project ?? "—"} |`,
      `| **Slug** | \`${fm.slug}\` |`,
      `| **ISA** | \`${isaPath.replace(HOME, "~")}\` |`,
      `| **Updated** | ${fm.updated} |`,
      "",
      `---`,
      `*Auto-captured by LifeOS WorkSweep (${titlePrefix === "[Native]" ? "NATIVE-mode session with artifacts" : "untracked Algorithm session"})*`,
    ].filter(Boolean).join("\n");

    if (stats.issues_created >= maxCreate) {
      console.error(`[WorkSweep] hit --max-create ${maxCreate}, stopping session sweep`);
      stats.errors.push(`max-create cap hit at ${maxCreate}`);
      break;
    }
    if (dryRun) {
      console.log(`+ would create ${titlePrefix} ${taskOrSlug(fm)} (${fm.slug}) labels=${labels.join(",")}${isComplete ? " → close as record" : ""}`);
      stats.issues_created++;
      continue;
    }
    const created = await ghCreateIssue(repo, title, body, labels);
    if (created) {
      stats.issues_created++;
      writeIssueBackToISA(isaPath, created.number, created.url); // public issue #1936, @pybe
      if (isComplete) {
        await ghCloseIssue(repo, created.number, "Session complete — captured as record. Live history lives in the session ISA; this issue carries zero board weight by design (work-system methodology, 2026-08-15).");
        console.log(`+ created #${created.number} ${title} (closed as record)`);
      } else {
        console.log(`+ created #${created.number} ${title}`);
      }
    } else {
      stats.errors.push(`create failed: ${fm.slug}`);
    }
  }
}

async function sweepStaleIssues(
  repo: string,
  openIssues: Array<{ number: number; title: string; labels: string[]; updatedAt: string }>,
  dryRun: boolean,
  stats: SweepStats,
): Promise<void> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const issue of openIssues) {
    if (issue.labels.includes("stale")) continue;
    const inProgress = issue.labels.some((l) => /^Status:in-progress$/i.test(l) || /^in-progress$/i.test(l));
    if (!inProgress) continue;
    if (Date.parse(issue.updatedAt) > sevenDaysAgo) continue;
    if (dryRun) {
      console.log(`~ would label #${issue.number} stale (in-progress >7d)`);
      stats.issues_stale_labeled++;
      continue;
    }
    if (await ghAddLabel(repo, issue.number, "stale")) {
      console.log(`~ labeled #${issue.number} stale`);
      stats.issues_stale_labeled++;
    }
  }
}

interface ProjectRow { name: string; pathLocal: string; }

function parseProjectsMd(): ProjectRow[] {
  if (!existsSync(PROJECTS_MD)) return [];
  const content = readFileSync(PROJECTS_MD, "utf-8");
  const rows: ProjectRow[] = [];
  // Match: | **Name** | `path` | ...
  const re = /^\|\s*\*\*([^*]+)\*\*[^|]*\|\s*`([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1].trim().replace(/[🎯🚨_]/g, "").trim();
    const pathStr = m[2].trim().replace(/^~/, HOME);
    rows.push({ name, pathLocal: pathStr });
  }
  return rows;
}

async function lastCommitAgeDays(repoPath: string): Promise<number | null> {
  if (!existsSync(join(repoPath, ".git"))) return null;
  const proc = Bun.spawn(
    ["git", "-C", repoPath, "log", "-1", "--format=%ct"],
    { stdout: "pipe", stderr: "ignore", timeout: 5000 },
  );
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0) return null;
  const ts = parseInt(out.trim(), 10);
  if (!ts) return null;
  return Math.round((Date.now() / 1000 - ts) / 86400);
}


interface TelosGoal { id: string; text: string; }

function parseActiveGoals(): TelosGoal[] {
  if (!existsSync(PRINCIPAL_TELOS)) return [];
  return parseActiveGoalsFrom(readFileSync(PRINCIPAL_TELOS, "utf-8"));
}

/** Pure half of parseActiveGoals — exported for the section-anchor test. */
export function parseActiveGoalsFrom(content: string): TelosGoal[] {
  // Find "## Active Goals" section, extract "- **GN**: text"
  // `$` without /m = end of input. The old `\Z` is a Python/PCRE anchor that JS
  // reads as a literal "Z", so a goals section that was the LAST section of the
  // file never matched (public issue #1919 item 13, @dissembler21-png).
  const sectionM = content.match(/## Active Goals[\s\S]*?(?=\n## |$)/);
  if (!sectionM) return [];
  const out: TelosGoal[] = [];
  const re = /^- \*\*(G\d+)\*\*:\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sectionM[0])) !== null) {
    // Per-goal opt-out: a goal line carrying `(nosync)` or `<!-- nosync -->` is
    // one the principal tracks outside the work system, so the sweep must not
    // report on it (public issue #1825, @PaulWaldo).
    if (/\(nosync\)|<!--\s*nosync\s*-->/i.test(m[2])) continue;
    out.push({ id: m[1], text: m[2].trim() });
  }
  return out;
}


export interface BleAuditState { date: string; carrier?: string; stamped_by?: string }
export interface BleStatus {
  days_since: number | null;
  cadence_days: number;
  overdue: boolean;
  reason: string;            // human line, also rendered by the statusline and Pulse
  carrier: string | null;    // resolved id the system runs on now
  stamped_carrier: string | null; // resolved id at the last stamp (null = no baseline yet)
}

function readBleAuditState(): BleAuditState | null {
  if (!existsSync(BLE_AUDIT_STATE)) return null;
  try { return JSON.parse(readFileSync(BLE_AUDIT_STATE, "utf8")) as BleAuditState; } catch { return null; }
}

function currentCarrierId(): string | null {
  try { return resolveCarrierId(JSON.parse(readFileSync(SETTINGS_JSON, "utf8")).model); } catch { return null; }
}

// Pure: the whole overdue decision, so the test can drive it with any stamp and any carrier.
// A stamp with no carrier field never fires the carrier rule (no false alarm on first run);
// the caller baselines it instead.
export function bleStatusFrom(state: BleAuditState | null, carrier: string | null, now = Date.now(), cadence = BLE_CADENCE_DAYS): BleStatus {
  const then = state ? new Date(state.date).getTime() : NaN;
  const days = Number.isNaN(then) ? null : Math.floor((now - then) / 86400000);
  const stamped = state?.carrier ?? null;
  const carrierChanged = !!(stamped && carrier && stamped !== carrier);
  const overdue = days === null || days >= cadence || carrierChanged;
  const reason = days === null
    ? "never stamped"
    : carrierChanged
      ? `carrier changed ${stamped} → ${carrier}, ${days}d since last`
      : days >= cadence
        ? `${days}d since last (cadence ${cadence}d)`
        : `${days}d ago (due at ${cadence}d)`;
  return { days_since: days, cadence_days: cadence, overdue, reason, carrier, stamped_carrier: stamped };
}

// Reads the stamp, and writes the carrier baseline into an older stamp that has none —
// the date is untouched, so a real cadence clock never resets from a code change.
function bleStatus(): BleStatus {
  const state = readBleAuditState();
  const carrier = currentCarrierId();
  if (state && !state.carrier && carrier) {
    writeFileSync(BLE_AUDIT_STATE, JSON.stringify({ ...state, carrier, carrier_baselined: new Date().toISOString().slice(0, 10) }, null, 2) + "\n");
    state.carrier = carrier;
  }
  return bleStatusFrom(state, carrier);
}

// Resets the cadence clock and records the carrier the audit was done against —
// run after completing a BLE audit.
function stampBleAudit(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const carrier = currentCarrierId();
  invariant(carrier !== null, "stampBleAudit: settings.json model did not resolve to a Claude id");
  writeFileSync(BLE_AUDIT_STATE, JSON.stringify({ date, carrier, stamped_by: "WorkSweep --stamp-ble" }, null, 2) + "\n");
  console.log(`[WorkSweep] BLE audit stamped: ${date} (carrier ${carrier})`);
}

// Institutionalized subtraction. When a BLE pass is overdue and no reminder is already
// open, surface ONE propose-only reminder — never auto-cuts (a cut needs ratification).

// ——— Work digest: the consumption surface (2026-08-15 methodology) ———
// One small markdown file read by SessionStart context injection (LoadContext)
// and the Pulse work module. Carries top open priorities plus the
// recurring-state panel; state is rendered, never queued as issues.
const WORK_DIGEST = join(STATE_DIR, "work-digest.md");

async function writeWorkDigest(
  repo: string,
  openIssues: Array<{ number: number; title: string; labels: string[]; updatedAt: string }>,
): Promise<void> {
  invariant(repo.length > 0, "writeWorkDigest: repo must be non-empty");
  const now = Date.now();
  const real = openIssues.filter((i) => !i.labels.includes("auto-sweep") && !i.labels.includes("auto-native"));
  const pri = (i: { labels: string[] }): number => {
    const l = i.labels.find((x) => /^Priority:P\d$/i.test(x));
    return l ? parseInt(l.slice(-1), 10) : 9;
  };
  const inProgress = real.filter((i) => i.labels.some((l) => /^Status:in-progress$/i.test(l)));
  const overdue = real.filter((i) => {
    const m = i.title.match(/\((\d{4}-\d{2}-\d{2})\)/);
    return m ? Date.parse(m[1]) < now : false;
  });
  const top = [...real].sort((a, b) => pri(a) - pri(b)).slice(0, 7);
  // P1 issues nobody has touched in a week — read by the Socrates `ulwork` adapter (SOC-0035).
  const STALE_P1_DAYS = 7;
  const staleP1 = real
    .filter((i) => pri(i) === 1)
    .map((i) => ({ number: i.number, title: i.title, idle_days: Math.floor((now - Date.parse(i.updatedAt)) / 86_400_000) }))
    .filter((i) => i.idle_days >= STALE_P1_DAYS);

  const goals = parseActiveGoals();
  const haystack = openIssues.map((i) => `${i.title} ${i.labels.join(" ")}`).join("\n").toLowerCase();
  const goalsNoWork = goals.filter((g) => !haystack.includes(`goal:${g.id.toLowerCase()}`)).map((g) => g.id);
  const staleProjects: string[] = [];
  for (const row of parseProjectsMd()) {
    const age = await lastCommitAgeDays(row.pathLocal);
    if (age !== null && age >= 14) staleProjects.push(`${row.name} (${age}d)`);
  }
  const ble = bleStatus();
  const bleLine = ble.overdue ? `BLE subtraction pass DUE — ${ble.reason}` : `BLE subtraction pass: ${ble.reason}`;

  const lines = [
    "# Work Digest",
    "",
    `> Auto-generated by WorkSweep — do not edit. Updated: ${new Date().toISOString()}`,
    "",
    `Open (real forward work): ${real.length} · in-progress: ${inProgress.length} · overdue: ${overdue.length}`,
    "",
    "## Top priorities",
    ...top.map((i) => `- #${i.number} [${pri(i) === 9 ? "P?" : `P${pri(i)}`}] ${i.title}`),
    ...(overdue.length ? ["", "## Overdue", ...overdue.slice(0, 5).map((i) => `- #${i.number} ${i.title}`)] : []),
    "",
    "## Attention (state, not tasks)",
    `- Goals with no open work: ${goalsNoWork.length ? goalsNoWork.join(", ") : "none"}`,
    `- Projects with no commits in 14d+: ${staleProjects.length ? staleProjects.slice(0, 8).join(", ") + (staleProjects.length > 8 ? ` +${staleProjects.length - 8} more` : "") : "none"}`,
    `- ${bleLine}`,
    "",
  ];
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(WORK_DIGEST, lines.join("\n"));
  // Structured twin of the digest for the Pulse work tab's Attention panel —
  // same computation, machine shape, so Pulse never re-derives this itself.
  writeFileSync(join(STATE_DIR, "work-attention.json"), JSON.stringify({
    updated: new Date().toISOString(),
    open_real: real.length,
    in_progress: inProgress.length,
    overdue: overdue.slice(0, 10).map((i) => ({ number: i.number, title: i.title })),
    stale_p1: staleP1.slice(0, 20),
    goals_without_work: goalsNoWork,
    stale_projects: staleProjects,
    ble,
  }, null, 2));
  console.error(`[WorkSweep] digest written: ${WORK_DIGEST.replace(HOME, "~")}`);
}

function writeLogLine(stats: SweepStats): void {
  if (!existsSync(OBS_DIR)) mkdirSync(OBS_DIR, { recursive: true });
  appendFileSync(OBS_LOG, JSON.stringify(stats) + "\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--stamp-ble")) { stampBleAudit(); process.exit(0); }
  const dryRun = args.includes("--dry-run");
  const sinceIdx = args.indexOf("--since");
  const sinceHours = sinceIdx >= 0 ? parseInt(args[sinceIdx + 1].replace(/h$/, ""), 10) : 24;
  const sinceMs = sinceHours * 3600 * 1000;
  const maxCreateIdx = args.indexOf("--max-create");
  const maxCreate = maxCreateIdx >= 0 ? parseInt(args[maxCreateIdx + 1], 10) : 50;

  const t0 = Date.now();
  const stats: SweepStats = {
    ts: new Date().toISOString(),
    sessions_scanned: 0,
    issues_created: 0,
    issues_updated: 0,
    issues_stale_labeled: 0,
    project_checks_created: 0,
    goal_issues_created: 0,
    ble_reminder_created: 0,
    lookup_failures: 0,
    duration_ms: 0,
    errors: [],
  };

  const cfg = loadWorkConfig();
  if (!cfg.enabled || !cfg.repo) {
    console.error(`[WorkSweep] disabled: ${cfg.reason}`);
    stats.errors.push(`disabled: ${cfg.reason}`);
    stats.duration_ms = Date.now() - t0;
    writeLogLine(stats);
    process.exit(0);
  }
  if (!cfg.captureSweep) {
    console.error("[WorkSweep] CAPTURE_SWEEP=false in config — skipping");
    stats.duration_ms = Date.now() - t0;
    writeLogLine(stats);
    process.exit(0);
  }

  console.error(`[WorkSweep] repo=${cfg.repo} since=${sinceHours}h max-create=${maxCreate} ${dryRun ? "DRY RUN" : "APPLY"}`);

  const [existingLabels, listed] = await Promise.all([
    ghLabelsExisting(cfg.repo),
    ghListOpenIssues(cfg.repo).then(
      (issues) => ({ ok: true as const, issues }),
      (e: unknown) => {
        if (!(e instanceof LookupFailed)) throw e;
        return { ok: false as const, error: e.message };
      },
    ),
  ]);

  if (listed.ok) {
    await sweepSessions(cfg.repo, sinceMs, existingLabels, cfg.projectProperty, dryRun, maxCreate, stats, listed.issues);
    await sweepStaleIssues(cfg.repo, listed.issues, dryRun, stats);
    // [Goal]/[Project-Check]/[BLE] issue generators retired 2026-08-15 (ratified):
    // recurring state is rendered — work-digest.md + Pulse — never queued as issues.
    if (!dryRun) {
      await writeWorkDigest(cfg.repo, listed.issues);
    }
  } else {
    // Without the open-issue list there is no dedup layer 1 and no truthful digest: create nothing,
    // label nothing, keep the previous digest, and report the failure.
    console.error(`[WorkSweep] ${listed.error} — skipping session capture, stale labels and the digest this run`);
    stats.errors.push(listed.error);
    stats.lookup_failures++;
  }

  stats.duration_ms = Date.now() - t0;
  writeLogLine(stats);
  console.error(`[WorkSweep] done in ${stats.duration_ms}ms — sessions=${stats.sessions_scanned} new=${stats.issues_created} stale=${stats.issues_stale_labeled}`);

  // Final step: regenerate TASKLIST.md when a regenerator is configured (best-effort). Not after a
  // failed lookup: the regenerator commits and pushes, and a run that could not read the issues must
  // not publish a TASKLIST built during the outage.
  if (stats.lookup_failures > 0) {
    console.error(`[WorkSweep] ${stats.lookup_failures} lookup failure(s) — not regenerating or pushing TASKLIST this run`);
  } else if (!dryRun) {
    const workConfigPath = join(LIFEOS_DIR, "USER", "WORK", "config.yaml");
    let configuredPath = "";
    try {
      configuredPath = readFileSync(workConfigPath, "utf8").match(/^tasklist_regenerator:\s*([^\s#]+)\s*(?:#.*)?$/m)?.[1] ?? "";
    } catch { /* Optional config is absent. */ }
    const regenTool = configuredPath ? (isAbsolute(configuredPath) ? configuredPath : join(getClaudeDir(), configuredPath)) : "";
    if (regenTool && existsSync(regenTool)) {
      const proc = Bun.spawn(["bun", regenTool, "--commit-push"], {
        stdout: "inherit", stderr: "inherit", timeout: 30000,
      });
      await proc.exited;
    }
  }

  process.exit(stats.lookup_failures > 0 ? 2 : 0);
}

if (import.meta.main) {
  main().catch((err) => { console.error(`[WorkSweep] Fatal: ${err}`); process.exit(1); });
}
