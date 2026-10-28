#!/usr/bin/env bun
/**
 * @version 1.0.0
 * GoogleCreds.ts — the ONE Google OAuth credential resolver.
 *
 * WHY THIS EXISTS: the resolution chain is centralized for every
 * consumer. `TOOLS/gmail.ts` carried the full chain (account → env → TOML →
 * conventional); `PEOPLE/ledger.ts` carried a two-step subset (env →
 * conventional). The conventional path `credentials.json` does not exist on
 * this install — mailboxes are stored one file per domain — so the subset
 * worked interactively (where settings.json supplies the env var) and failed
 * under launchd (where it does not). People's Gmail ingest was dark from
 * 2026-09-11 to 2026-09-22 for exactly that reason, reporting ENOENT on a
 * path that exists nowhere.
 *
 * Two rules follow from that incident:
 *   1. One resolver. A consumer that needs Google credentials imports this.
 *   2. Failure names what it found. ENOENT on a synthesized path tells the
 *      reader nothing; the directory listing tells them everything.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadLifeosConfig, lifeosUserDir } from "./LifeosConfig";

export type GoogleCreds = { client_id: string; client_secret: string; refresh_token: string };

const GOOGLE_DIR = () => join(lifeosUserDir(), "CONFIG/CREDENTIALS/google");
const expand = (p: string) => p.replace(/^\$HOME/, homedir()).replace(/^~/, homedir());

/** Files that live in the credentials dir but are not OAuth mailbox creds. */
const NOT_A_MAILBOX = /^(client_secret|.*\.oauth)\.json$/;

function isMailboxCred(v: unknown): v is GoogleCreds {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.client_id === "string" && typeof o.client_secret === "string" && typeof o.refresh_token === "string";
}

/** Every file in the credentials dir that parses as a usable mailbox credential. */
export function listMailboxCreds(): string[] {
  const dir = GOOGLE_DIR();
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json") || NOT_A_MAILBOX.test(name)) continue;
    try {
      if (isMailboxCred(JSON.parse(readFileSync(join(dir, name), "utf8")))) out.push(join(dir, name));
    } catch { /* unreadable or not JSON — not a candidate */ }
  }
  return out.sort();
}

/**
 * Resolve the credential FILE PATH.
 *
 * Order, first hit wins:
 *   1. explicit `account` (a bare domain name, `.json` optional)
 *   2. $GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE
 *   3. LIFEOS_CONFIG.toml integrations.google.credentialsFile
 *   4. the conventional credentials.json, IF it exists
 *   5. a directory scan, only when it finds exactly one mailbox credential
 *
 * Step 5 is the launchd safety net, and it is deliberately strict: with two or
 * more mailboxes on disk, picking one is a guess about which identity to act
 * as, and guessing an identity is never better than failing loudly.
 */
export function resolveGoogleCredsPath(opts: { account?: string | null } = {}): string {
  const dir = GOOGLE_DIR();

  if (opts.account) {
    const p = join(dir, `${opts.account.replace(/\.json$/, "")}.json`);
    if (!existsSync(p)) throw new Error(`no credential for account "${opts.account}": ${p}`);
    return p;
  }

  const env = process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
  if (env) return expand(env);

  try {
    // Optional: absent on a fresh install, and that is not an error.
    const fromConfig = loadLifeosConfig()?.integrations?.google?.credentialsFile;
    if (typeof fromConfig === "string" && fromConfig.length > 0) return expand(fromConfig);
  } catch { /* fall through */ }

  const conventional = join(dir, "credentials.json");
  if (existsSync(conventional)) return conventional;

  const found = listMailboxCreds();
  if (found.length === 1) return found[0]!;

  const listing = found.length
    ? `found ${found.length} mailbox credentials, so the choice is ambiguous: ${found.map((f) => f.split("/").pop()).join(", ")}`
    : `found no mailbox credentials in ${dir}`;
  throw new Error(
    `Google credentials unresolved — ${listing}. ` +
      `Set GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (scheduled jobs must carry it in their launchd plist; ` +
      `settings.json env does NOT reach launchd), or pass an explicit account.`,
  );
}

/** Resolve and read. */
export function loadGoogleCreds(opts: { account?: string | null } = {}): GoogleCreds {
  const path = resolveGoogleCredsPath(opts);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isMailboxCred(parsed)) throw new Error(`${path} is not a mailbox credential (needs client_id, client_secret, refresh_token)`);
  return parsed;
}

if (import.meta.main) {
  const account = process.argv.includes("--account") ? process.argv[process.argv.indexOf("--account") + 1] : null;
  try {
    console.log(resolveGoogleCredsPath({ account }));
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
