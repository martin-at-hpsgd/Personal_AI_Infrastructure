/**
 * UpstreamRepo — the one resolver for "which GitHub repo is this install's upstream LifeOS".
 *
 * Order: the LIFEOS_REPO environment variable (the one the installer reads), then the repo the
 * release stamped into skills/LifeOS/install/install.sh, then this install's
 * LIFEOS/USER/CONFIG/lifeos-repo.json {"repo": "owner/name"}.
 *
 * Unconfigured and misconfigured are different answers. Nothing set (no variable, no stamp, no
 * config file, or the shipped template's empty "repo": "") resolves to null and each caller picks
 * its own fallback. A value that is set but unusable (malformed JSON, a non-object, a missing or
 * non-string "repo" key, anything that is not owner/name) is an error naming the source and key,
 * so a broken config never silently falls through to a caller's default. Read-only: no invariants.
 *
 * Callers: LIFEOS/TOOLS/Banner.ts (footer link), LIFEOS/TOOLS/Credits.ts (credits repo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getClaudeDir } from "./Paths";

/** owner/name from owner/name, github.com/owner/name, https://github.com/owner/name(.git). */
export function normalizeRepo(r: string): string {
  return r.trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export type UpstreamRepoSource = "env" | "installer" | "config" | "none";

export type UpstreamRepoResult =
  | { ok: true; repo: string; source: Exclude<UpstreamRepoSource, "none"> }
  | { ok: true; repo: null; source: "none" }
  | { ok: false; error: string };

/** Path of this install's upstream-repo config file. */
export function upstreamRepoConfigPath(claudeDir: string = getClaudeDir()): string {
  return join(claudeDir, "LIFEOS", "USER", "CONFIG", "lifeos-repo.json");
}

function checked(raw: string, source: Exclude<UpstreamRepoSource, "none">, where: string): UpstreamRepoResult {
  const repo = normalizeRepo(raw);
  if (!OWNER_NAME.test(repo)) return { ok: false, error: `${where} is ${JSON.stringify(raw)}, which is not a GitHub repo as owner/name` };
  return { ok: true, repo, source };
}

/**
 * The upstream repo with where it came from, null when nothing is configured, or an error naming the
 * file (or variable) and key when something is configured but unusable.
 */
export function resolveUpstreamRepo(
  claudeDir: string = getClaudeDir(),
  env: Record<string, string | undefined> = process.env,
): UpstreamRepoResult {
  if (env.LIFEOS_REPO?.trim()) return checked(env.LIFEOS_REPO, "env", "LIFEOS_REPO");

  const installer = join(claudeDir, "skills", "LifeOS", "install", "install.sh");
  let script: string | null = null;
  try { script = readFileSync(installer, "utf8"); } catch {} // no installer: a source checkout, not an error
  const stamped = script?.match(/LIFEOS_REPO="\$\{LIFEOS_REPO:-([^}"]+)\}"/)?.[1];
  if (stamped && normalizeRepo(stamped) !== "OWNER/REPO") return checked(stamped, "installer", `${installer} LIFEOS_REPO default`);

  const path = upstreamRepoConfigPath(claudeDir);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, repo: null, source: "none" };
    return { ok: false, error: `${path} could not be read: ${(e as Error).message}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${path} is not valid JSON (${(e as Error).message}); expected {"repo": "owner/name"}` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: `${path} must be a JSON object like {"repo": "owner/name"}, got ${doc === null ? "null" : Array.isArray(doc) ? "an array" : typeof doc}` };
  }
  if (!("repo" in doc)) return { ok: false, error: `${path} has no "repo" key; set it to "owner/name", or "" to leave the upstream unset` };
  const repo = (doc as { repo: unknown }).repo;
  if (typeof repo !== "string") return { ok: false, error: `${path} key "repo" must be a string "owner/name", got ${repo === null ? "null" : typeof repo}` };
  if (!repo.trim()) return { ok: true, repo: null, source: "none" }; // the shipped template's unset value
  return checked(repo, "config", `${path} key "repo"`);
}

/** Thrown by upstreamRepo() when the upstream repo is configured but unusable. */
export class UpstreamRepoConfigError extends Error {
  override name = "UpstreamRepoConfigError";
}

/**
 * The upstream repo as owner/name, or null when nothing configures one. Throws
 * UpstreamRepoConfigError, naming the file and key, when a configured value is unusable.
 */
export function upstreamRepo(claudeDir: string = getClaudeDir(), env: Record<string, string | undefined> = process.env): string | null {
  const r = resolveUpstreamRepo(claudeDir, env);
  if (!r.ok) throw new UpstreamRepoConfigError(r.error);
  return r.repo;
}
