#!/usr/bin/env bun
/**
 * Fetch.ts — the one live GitHub fetch behind every open-source triage intent in this skill.
 *
 *   bun Fetch.ts <issues|prs|discussions|stats>... [--repo <name>] [--limit N] [--brief]
 *
 * Prints one JSON object:
 *   { owner, fetchedAt, repos: { <repo>: { <kind>: Section } } }
 *   Section = { ok: true, items, limit, truncated } | { ok: true, stats } | { ok: false, error }
 *
 * A failed call is a hole ({ ok: false, error }), never an empty list: a hole must be
 * reported as "could not fetch", never as a quiet repo. `truncated: true` means the list
 * hit its limit and the report says "showing first N".
 *
 * Defaults: issues and prs 50, discussions 30 (most recently updated). `--brief` drops the
 * heavy fields (bodies, reviews, PR comment threads, check rollups) for the cross-repo CheckState snapshot.
 * Owner and repo list come from the skill's USER Config.md
 * (`OSS_OWNER: <login>`, `OSS_REPOS: <name>, <name>, ...`); `--repo` picks one of the listed
 * repos. All GitHub I/O goes through the user's `gh` session.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosPath } from "../../../LIFEOS/TOOLS/Paths.ts";

export const KINDS = ["issues", "prs", "discussions", "stats"] as const;
export type Kind = (typeof KINDS)[number];

export type Section =
  | { ok: true; items: unknown[]; limit: number; truncated: boolean }
  | { ok: true; stats: Record<string, unknown> }
  | { ok: false; error: string };

export const HOLE = "could not fetch (gh auth/scope/network) — NOT zero results";

const FIELDS = {
  issues: {
    full: "number,title,labels,createdAt,updatedAt,author,comments,body",
    brief: "number,title,labels,createdAt,updatedAt,author,comments",
  },
  prs: {
    full: "number,title,author,createdAt,updatedAt,isDraft,mergeable,mergeStateStatus,statusCheckRollup,labels,additions,deletions,changedFiles,body,reviewDecision,reviews,comments",
    brief: "number,title,author,createdAt,updatedAt,isDraft,additions,deletions,reviewDecision",
  },
} as const;

const CONFIG_PATH = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "OpenSourceManagement", "Config.md");

const DEFAULT_LIMIT: Record<Exclude<Kind, "stats">, number> = { issues: 50, prs: 50, discussions: 30 };

const DISCUSSIONS_QUERY = (brief: boolean) =>
  `query($owner: String!, $name: String!, $first: Int!) { repository(owner: $owner, name: $name) { discussions(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title author { login } createdAt updatedAt category { name } comments { totalCount } upvoteCount ${brief ? "" : "body "}answerChosenAt } } } }`;

// ------------------------------------------------------------- pure shaping ---

export function parseOwner(configText: string): string | null {
  const m = configText.match(/^OSS_OWNER:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

/** GitHub repository names: letters, digits, `.`, `_`, `-`; never `.` or `..` alone. */
export const REPO_NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export type RepoList = { ok: true; repos: string[] } | { ok: false; error: string };

/** `OSS_REPOS: a, b, c` from Config.md text → the repos every intent loops over, in order, deduplicated. */
export function parseRepos(configText: string): RepoList {
  const m = configText.match(/^OSS_REPOS:[ \t]*(.*?)[ \t]*$/m);
  if (!m) return { ok: false, error: "OSS_REPOS missing" };
  const repos = [...new Set(m[1].split(",").map((s) => s.trim()).filter(Boolean))];
  if (repos.length === 0) return { ok: false, error: "OSS_REPOS is empty" };
  const bad = repos.filter((r) => !REPO_NAME_RE.test(r));
  if (bad.length) return { ok: false, error: `OSS_REPOS has invalid repo name(s): ${bad.join(", ")} (write bare names under OSS_OWNER)` };
  return { ok: true, repos };
}

/** Narrow the configured list to `--repo`, or keep all of it. A name outside the list is refused, never fetched. */
export function selectRepos(configured: string[], requested: string | null): RepoList {
  if (requested === null) return { ok: true, repos: configured };
  if (!configured.includes(requested)) {
    return { ok: false, error: `--repo ${requested} is not in OSS_REPOS (${configured.join(", ")})` };
  }
  return { ok: true, repos: [requested] };
}

function hole(stderr: string): Section {
  const detail = stderr.trim().split("\n")[0];
  return { ok: false, error: detail ? `${HOLE}: ${detail}` : HOLE };
}

/** `gh issue list` / `gh pr list --json` output → Section. */
export function shapeList(code: number, stdout: string, stderr: string, limit: number): Section {
  if (code !== 0) return hole(stderr);
  try {
    const items = JSON.parse(stdout);
    if (!Array.isArray(items)) return hole("gh returned a non-array");
    return { ok: true, items, limit, truncated: items.length >= limit };
  } catch {
    return hole("gh returned unparseable JSON");
  }
}

/** `gh api graphql` discussions output → Section. GraphQL errors or a null repository
 *  (Discussions disabled, no access) are holes even when gh exits 0. */
export function shapeDiscussions(code: number, stdout: string, stderr: string, limit: number): Section {
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    return hole(code !== 0 ? stderr : "gh returned unparseable JSON");
  }
  if (Array.isArray(body?.errors) && body.errors.length) return hole(String(body.errors[0]?.message ?? "graphql error"));
  const nodes = body?.data?.repository?.discussions?.nodes;
  if (code !== 0 || !Array.isArray(nodes)) return hole(code !== 0 ? stderr : "repository or discussions is null (disabled or no access)");
  return { ok: true, items: nodes, limit, truncated: nodes.length >= limit };
}

/** Repo metadata + 30-day commit count → Section. `open_issues` counts PRs too (GitHub's field). */
export function shapeStats(
  repo: { code: number; stdout: string; stderr: string },
  commits: { code: number; stdout: string; stderr: string },
): Section {
  if (repo.code !== 0) return hole(repo.stderr);
  try {
    const r = JSON.parse(repo.stdout);
    const stats: Record<string, unknown> = {
      stars: r.stargazers_count,
      forks: r.forks_count,
      open_issues_and_prs: r.open_issues_count,
      pushed_at: r.pushed_at,
    };
    if (commits.code === 0) {
      const n = (JSON.parse(commits.stdout) as unknown[]).length;
      stats.commits_30d = n >= 100 ? "100+" : n;
    } else {
      stats.commits_30d = hole(commits.stderr);
    }
    return { ok: true, stats };
  } catch {
    return hole("gh returned unparseable JSON");
  }
}

// ---------------------------------------------------------------------- I/O ---

async function gh(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `gh not runnable: ${(e as Error).message}` };
  }
}

async function fetchSection(owner: string, repo: string, kind: Kind, limit: number | null, brief: boolean): Promise<Section> {
  const R = `${owner}/${repo}`;
  if (kind === "issues" || kind === "prs") {
    const n = limit ?? DEFAULT_LIMIT[kind];
    const sub = kind === "issues" ? "issue" : "pr";
    const res = await gh([sub, "list", "-R", R, "--state", "open", "--limit", String(n), "--json", FIELDS[kind][brief ? "brief" : "full"]]);
    return shapeList(res.code, res.stdout, res.stderr, n);
  }
  if (kind === "discussions") {
    const n = limit ?? DEFAULT_LIMIT.discussions;
    const res = await gh(["api", "graphql", "-f", `query=${DISCUSSIONS_QUERY(brief)}`, "-f", `owner=${owner}`, "-f", `name=${repo}`, "-F", `first=${n}`]);
    return shapeDiscussions(res.code, res.stdout, res.stderr, n);
  }
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [meta, commits] = await Promise.all([
    gh(["api", `repos/${R}`]),
    gh(["api", `repos/${R}/commits?since=${since}&per_page=100`]),
  ]);
  return shapeStats(meta, commits);
}

function usage(): string {
  return `Fetch.ts — live GitHub fetch for the open-source triage intents.

  bun Fetch.ts <${KINDS.join("|")}>... [--repo <name>] [--limit N] [--brief]

Repos are the OSS_REPOS list in ${CONFIG_PATH}; --repo picks one of them.
Prints one JSON object; a failed call is { ok: false, error } (a hole), never an empty list.
`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    process.exit(argv.length === 0 ? 2 : 0);
  }
  const kinds: Kind[] = [];
  let requested: string | null = null;
  let limit: number | null = null;
  let brief = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brief") brief = true;
    else if (a === "--repo") {
      const name = argv[++i];
      if (name === undefined || name.startsWith("--")) {
        process.stderr.write(`--repo needs a repo name\n${usage()}`);
        process.exit(2);
      }
      requested = name;
    }
    else if (a === "--limit") limit = Number(argv[++i]);
    else if ((KINDS as readonly string[]).includes(a)) kinds.push(a as Kind);
    else {
      process.stderr.write(`unknown argument: ${a}\n${usage()}`);
      process.exit(2);
    }
  }
  if (!kinds.length || (limit !== null && !(Number.isInteger(limit) && limit > 0))) {
    process.stderr.write(usage());
    process.exit(2);
  }

  const configText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  const owner = parseOwner(configText);
  if (!owner) {
    process.stdout.write(`ERROR: OSS_OWNER missing from ${CONFIG_PATH} — nothing fetched, NOT zero results\n`);
    process.exit(1);
  }
  const configured = parseRepos(configText);
  if (!configured.ok) {
    process.stdout.write(`ERROR: ${configured.error} in ${CONFIG_PATH} — nothing fetched, NOT zero results\n`);
    process.exit(1);
  }
  const selected = selectRepos(configured.repos, requested);
  if (!selected.ok) {
    process.stderr.write(`${selected.error}\n`);
    process.exit(2);
  }
  const repos = selected.repos;

  const out: Record<string, Record<string, Section>> = {};
  await Promise.all(
    repos.flatMap((repo) =>
      kinds.map(async (kind) => {
        (out[repo] ??= {})[kind] = await fetchSection(owner, repo, kind, limit, brief);
      }),
    ),
  );
  process.stdout.write(JSON.stringify({ owner, fetchedAt: new Date().toISOString(), repos: out }) + "\n");
}

if (import.meta.main) await main();
