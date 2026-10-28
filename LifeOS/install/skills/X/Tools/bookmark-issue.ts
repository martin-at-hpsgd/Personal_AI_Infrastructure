#!/usr/bin/env bun
/**
 * bookmark-issue.ts — Create a GitHub idea-issue from an X bookmark (the PullBookmarks sweep).
 *
 * Subcommands:
 *   check <bookmarkId>
 *     Exit 0 + issue url if already issued.
 *     Exit 1 + "skipped" if skipped. Exit 1 + "new" if never seen.
 *
 *   create --id <id> --body <b> [--title <t>] [--property <p>]
 *          [--url <tweetUrl>] [--author <handle>] [--text <tweetText>]
 *     Dedup-safe: if <id> already ISSUED, prints existing url and exits 0.
 *     If <id> was previously skipped, proceeds and overwrites with issued entry.
 *     Otherwise creates a GitHub issue in the repo from work_repo.json,
 *     records state, and prints the new issue url.
 *
 *   skip --id <id> --reason <reason>
 *     Record a skipped disposition for <id>. Never overwrites an issued entry.
 *
 *   audit --ids <comma-separated-ids>
 *     Postcondition gate. Checks every id for a disposition (issued or skipped).
 *     Prints summary + any undisposed ids. Exit 0 if all disposed; exit 5 otherwise.
 *
 * State file: LIFEOS/MEMORY/STATE/X/bookmark-issues.json (runtime state lives outside the skill tree)
 * Repo: `bookmark_sweep.repo` ("owner/name") in the X skill's Config.md; when absent,
 *   the .repo field of ~/.claude/LIFEOS/USER/WORK/work_repo.json
 * Labels: the `bookmark_sweep` mapping in the X skill's Config.md yaml block
 *   (labels, property_label_prefix), plus WORK.AGENT_LABEL from USER/WORK/config.yaml.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";
import { parse as parseYaml } from "yaml";
import { loadWorkConfig } from "../../../hooks/lib/work-config";

// ─── Paths ────────────────────────────────────────────────────────────────────

const WORK_REPO_JSON = lifeosPath("USER", "WORK", "work_repo.json");
const STATE_DIR = lifeosPath("MEMORY", "STATE", "X");
const STATE_FILE = join(STATE_DIR, "bookmark-issues.json");
const SKILL_CONFIG = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "X", "Config.md");

// ─── Types ────────────────────────────────────────────────────────────────────

interface IssuedEntry {
  issue: number;
  url: string;
  created_at: string;
}

interface SkippedEntry {
  skipped: true;
  reason: string;
  at: string;
}

type StateEntry = IssuedEntry | SkippedEntry;
type State = Record<string, StateEntry>;

function isIssued(e: StateEntry): e is IssuedEntry {
  return !("skipped" in e);
}

function isSkipped(e: StateEntry): e is SkippedEntry {
  return "skipped" in e && e.skipped === true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readRepo(configured?: string): string {
  if (configured) return configured;
  if (!existsSync(WORK_REPO_JSON)) {
    process.stderr.write(`error: no repo bound. Set bookmark_sweep.repo ("owner/name") in ${SKILL_CONFIG}, or create ${WORK_REPO_JSON} containing {"repo": "owner/name"}\n`);
    process.exit(1);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(WORK_REPO_JSON, "utf8"));
  } catch {
    process.stderr.write(`error: ${WORK_REPO_JSON} is not valid JSON\n`);
    process.exit(1);
  }
  const repo = parsed?.repo;
  if (typeof repo !== "string" || !repo) {
    process.stderr.write(`error: .repo field missing or empty in ${WORK_REPO_JSON}\n`);
    process.exit(1);
  }
  return repo;
}

interface SweepConfig {
  labels: string[];
  propertyLabelPrefix: string;
  /** "owner/name" of the repo idea-issues are filed in; undefined falls back to work_repo.json. */
  repo?: string;
}

function configError(message: string): never {
  process.stderr.write(`error: ${SKILL_CONFIG}: ${message}\n`);
  process.exit(2);
}

/**
 * The `bookmark_sweep` mapping in the first fenced yaml block of the X Config.md
 * (the same block x-client.ts reads for the token store). No file, no block or no
 * mapping means no extra labels and a bare property label; a mapping that is
 * present but malformed fails loudly rather than filing mislabeled issues.
 */
function readSweepConfig(): SweepConfig {
  const none: SweepConfig = { labels: [], propertyLabelPrefix: "" };
  if (!existsSync(SKILL_CONFIG)) return none;
  const block = /```ya?ml\s*\n([\s\S]*?)```/.exec(readFileSync(SKILL_CONFIG, "utf8"))?.[1];
  if (block === undefined) return none;
  let raw: unknown;
  try {
    raw = parseYaml(block);
  } catch (err) {
    configError(`yaml block does not parse (${(err as Error).message})`);
  }
  const sweep = raw && typeof raw === "object" ? (raw as Record<string, unknown>).bookmark_sweep : undefined;
  if (sweep === undefined || sweep === null) return none;
  if (typeof sweep !== "object" || Array.isArray(sweep)) configError("bookmark_sweep must be a mapping");
  const { labels = [], property_label_prefix = "", repo } = sweep as Record<string, unknown>;
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string" && l.trim() !== "")) {
    configError("bookmark_sweep.labels must be a list of label names");
  }
  if (typeof property_label_prefix !== "string") configError("bookmark_sweep.property_label_prefix must be a string");
  if (repo !== undefined && (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
    configError("bookmark_sweep.repo must be a GitHub repo as owner/name");
  }
  return { labels: labels as string[], propertyLabelPrefix: property_label_prefix, repo: repo as string | undefined };
}

function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    // Old entries without `skipped` are IssuedEntry — backward compatible.
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    process.stderr.write(`warning: ${STATE_FILE} is corrupt — treating as empty\n`);
    return {};
  }
}

function writeState(state: State): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function parseIssueUrl(ghOutput: string): { url: string; number: number } | null {
  const lines = ghOutput.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/https:\/\/github\.com\/.+\/issues\/(\d+)/);
    if (match) return { url: match[0], number: parseInt(match[1], 10) };
  }
  return null;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

function printUsage(): void {
  process.stdout.write(`
bookmark-issue — Create a GitHub idea-issue from an X bookmark

Usage:
  bookmark-issue check <bookmarkId>
      Exit 0 + issue url if already issued.
      Exit 1 + "skipped" if skipped. Exit 1 + "new" if never seen.

  bookmark-issue create --id <id> --body <body>
                        [--title <title>] [--property <property>]
                        [--url <tweetUrl>] [--author <handle>]
                        [--text <tweetText>]
      --id        Twitter bookmark ID (required)
      --body      Idea description (required; title derived if omitted)
      --title     Issue title (optional; derived from --body if absent)
      --property  Adds the label <property_label_prefix><value> (optional)
      --url       Source tweet URL (optional)
      --author    Tweet author handle (optional)
      --text      Original tweet text (optional)
      Note: a previously-skipped id can be promoted — create will overwrite.

  bookmark-issue skip --id <id> --reason <reason>
      Record a skipped disposition for <id>. Never overwrites an issued entry.
      --id        Bookmark ID (required)
      --reason    Why it was skipped (required)

  bookmark-issue audit --ids <id1,id2,...>
      Postcondition gate: checks every id for a disposition (issued or skipped).
      Prints totals and any undisposed ids.
      Exit 0 if all disposed; exit 5 if any are undisposed. Read-only.

  bookmark-issue --help|-h
      Print this usage and exit 0.

State: ~/.claude/LIFEOS/MEMORY/STATE/X/bookmark-issues.json
Repo:  bookmark_sweep.repo in Config.md, else ~/.claude/LIFEOS/USER/WORK/work_repo.json
Labels: bookmark_sweep in ~/.claude/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/X/Config.md
`.trimStart());
}

// ─── Subcommand: check ────────────────────────────────────────────────────────

function cmdCheck(args: string[]): never {
  const id = args[0];
  if (!id) {
    process.stderr.write("error: check requires a bookmarkId argument\n");
    process.exit(2);
  }
  const state = readState();
  const entry = state[id];
  if (entry) {
    if (isIssued(entry)) {
      process.stdout.write(entry.url + "\n");
      process.exit(0);
    }
    // Skipped entry: counts as not-issued (exit 1) but distinguishable
    process.stdout.write("skipped\n");
    process.exit(1);
  }
  process.stdout.write("new\n");
  process.exit(1);
}

// ─── Subcommand: create ───────────────────────────────────────────────────────

function cmdCreate(args: string[]): never {
  const flags = parseFlags(args);

  const id = flags["id"];
  const body = flags["body"];
  if (!id || !body) {
    process.stderr.write("error: --id and --body are required\n\n");
    printUsage();
    process.exit(2);
  }

  // Dedup check — only block on an issued entry; skipped can be promoted
  const state = readState();
  const existing = state[id];
  if (existing && isIssued(existing)) {
    process.stdout.write(`dedup: bookmark ${id} already issued → ${existing.url}\n`);
    process.exit(0);
  }
  if (existing && isSkipped(existing)) {
    process.stdout.write(`note: bookmark ${id} was previously skipped (${existing.reason}) — promoting to issue\n`);
  }

  const sweep = readSweepConfig();
  const repo = readRepo(sweep.repo);

  // Derive title if absent
  const rawTitle = flags["title"] ?? body.slice(0, 70).replace(/\n/g, " ").trim();
  const title = rawTitle.length < body.length && flags["title"] == null
    ? rawTitle + "…"
    : rawTitle;

  // Compose issue body markdown
  const sections: string[] = [`## Idea\n\n${body}`];
  const sourceLines: string[] = [];
  if (flags["url"]) sourceLines.push(`- **Tweet:** ${flags["url"]}`);
  if (flags["author"]) sourceLines.push(`- **Author:** @${flags["author"]}`);
  if (flags["text"]) sourceLines.push(`- **Text:** ${flags["text"]}`);
  if (sourceLines.length > 0) sections.push(`## Source\n\n${sourceLines.join("\n")}`);
  sections.push("_Captured from an X bookmark by the PullBookmarks sweep._");
  const issueBody = sections.join("\n\n");

  // Labels come from the install's Config.md and the agent label from WORK.AGENT_LABEL
  // in USER/WORK/config.yaml — never a hardcoded label taxonomy or DA name.
  const requiredLabels = [...sweep.labels, loadWorkConfig().agentLabel];
  if (flags["property"]) requiredLabels.push(`${sweep.propertyLabelPrefix}${flags["property"]}`);

  // Pre-check labels exist in repo
  let repoLabelNames: string[];
  try {
    const raw = execFileSync(
      "gh",
      ["label", "list", "--repo", repo, "--limit", "200", "--json", "name"],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(raw) as Array<{ name: string }>;
    repoLabelNames = parsed.map((l) => l.name);
  } catch (err) {
    process.stderr.write(`error: failed to fetch labels from ${repo}: ${err}\n`);
    process.exit(3);
  }

  const missing = requiredLabels.filter((l) => !repoLabelNames.includes(l));
  if (missing.length > 0) {
    process.stderr.write(
      `error: the following labels do not exist in ${repo}: ${missing.join(", ")}\n`
    );
    process.exit(3);
  }

  // Create issue
  let ghOutput: string;
  try {
    ghOutput = execFileSync(
      "gh",
      [
        "issue", "create",
        "--repo", repo,
        "--title", title,
        "--body", issueBody,
        "--label", requiredLabels.join(","),
      ],
      { encoding: "utf8" }
    );
  } catch (err) {
    process.stderr.write(`error: gh issue create failed: ${err}\n`);
    process.exit(4);
  }

  const parsed = parseIssueUrl(ghOutput);
  if (!parsed) {
    process.stderr.write(`error: could not parse issue url from gh output:\n${ghOutput}\n`);
    process.exit(4);
  }

  // Persist state
  state[id] = { issue: parsed.number, url: parsed.url, created_at: new Date().toISOString() };
  writeState(state);

  process.stdout.write(parsed.url + "\n");
  process.exit(0);
}

// ─── Subcommand: skip ────────────────────────────────────────────────────────

function cmdSkip(args: string[]): never {
  const flags = parseFlags(args);
  const id = flags["id"];
  const reason = flags["reason"];
  if (!id || !reason) {
    process.stderr.write("error: --id and --reason are required\n\n");
    printUsage();
    process.exit(2);
  }
  const state = readState();
  const existing = state[id];
  if (existing && isIssued(existing)) {
    process.stdout.write(`note: bookmark ${id} already has an issued entry (${existing.url}) — skip not applied\n`);
    process.exit(0);
  }
  state[id] = { skipped: true, reason, at: new Date().toISOString() };
  writeState(state);
  process.stdout.write(`skipped: ${id} — ${reason}\n`);
  process.exit(0);
}

// ─── Subcommand: audit ───────────────────────────────────────────────────────

function cmdAudit(args: string[]): never {
  const flags = parseFlags(args);
  const idsRaw = flags["ids"];
  if (!idsRaw) {
    process.stderr.write("error: --ids is required\n\n");
    printUsage();
    process.exit(2);
  }
  const ids = idsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    process.stderr.write("error: --ids must contain at least one id\n");
    process.exit(2);
  }
  const state = readState();
  const undisposed: string[] = [];
  for (const id of ids) {
    const entry = state[id];
    if (!entry) undisposed.push(id);
  }
  const disposed = ids.length - undisposed.length;
  process.stdout.write(`audit: ${ids.length} ids — ${disposed} disposed, ${undisposed.length} undisposed\n`);
  if (undisposed.length > 0) {
    process.stdout.write(`undisposed: ${undisposed.join(", ")}\n`);
    process.exit(5);
  }
  process.exit(0);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const sub = argv[0];

if (!sub || sub === "--help" || sub === "-h") {
  printUsage();
  process.exit(0);
}

if (sub === "check") {
  cmdCheck(argv.slice(1));
} else if (sub === "create") {
  cmdCreate(argv.slice(1));
} else if (sub === "skip") {
  cmdSkip(argv.slice(1));
} else if (sub === "audit") {
  cmdAudit(argv.slice(1));
} else {
  process.stderr.write(`error: unknown subcommand "${sub}"\n\n`);
  printUsage();
  process.exit(2);
}
