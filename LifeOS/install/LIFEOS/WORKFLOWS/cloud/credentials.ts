/**
 * Cloudflare credentials for the read-only checks (ISC-33 cloud half, ISC-135).
 *
 * The master token and account id come from the process environment. The one
 * fallback is the two named keys in ~/.claude/.env, read here in code (never
 * printed, never returned to a log) and only when the real definitions home is
 * in use, so a test that points LIFEOS_WORKFLOWS_DIR elsewhere never reads it.
 * No second Cloudflare credential exists or is created.
 */
import { existsSync, readFileSync } from "node:fs";
import { getClaudeDir } from "../../TOOLS/Paths.ts";
import { join } from "node:path";

export interface CloudCredentials {
  accountId: string;
  token: string;
}

type Env = Record<string, string | undefined>;

export function cloudCredentials(env: Env = process.env): CloudCredentials | null {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  return token && accountId ? { accountId, token } : null;
}

/** The two Cloudflare keys this module reads; nothing else here is a credential. */
export const CLOUD_ENV_KEYS: readonly string[] = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

/**
 * Removes the two Cloudflare keys from `env`. A process that executes step bodies calls it before
 * any step runs: the keys can already be there without this module (the launching shell, or bun's
 * own .env auto-load from the working directory), and an agent step's child inherits the parent
 * environment whole. Returns whether anything was removed.
 */
export function dropCloudEnv(env: Env = process.env): boolean {
  let dropped = false;
  for (const key of CLOUD_ENV_KEYS) {
    if (env[key] === undefined) continue;
    delete env[key];
    dropped = true;
  }
  return dropped;
}

/** Fills the two Cloudflare keys into `env` from ~/.claude/.env when absent. Returns whether the file supplied anything. */
export function loadCloudEnvFile(env: Env = process.env, path: string = join(getClaudeDir(), ".env")): boolean {
  if (cloudCredentials(env) || !existsSync(path)) return false;
  let filled = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    const eq = t.indexOf("=");
    if (!t || t.startsWith("#") || eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (key !== "CLOUDFLARE_API_TOKEN" && key !== "CLOUDFLARE_ACCOUNT_ID") continue;
    if (env[key]) continue;
    env[key] = t.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    filled = true;
  }
  return filled;
}
