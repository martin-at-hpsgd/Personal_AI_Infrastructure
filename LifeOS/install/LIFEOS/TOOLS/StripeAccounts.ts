/**
 * @version 1.0.1
 * StripeAccounts.ts — one resolver for "which env var holds this Stripe account's secret key", shared by
 * StripeRead.ts and InvoiceWatch.ts.
 *
 * Order: the `## Accounts` table in the Stripe skill's Config.md (a row whose Alias column matches names its
 * Env var), then the derived name. The derived name is STRIPE_SECRET_KEY for no account or "main", otherwise
 * STRIPE_SECRET_KEY_<ALIAS uppercased>. A missing Config.md, a table without an Alias column, or an alias
 * with no row all fall through to the derived name, so an install without the table behaves as before.
 *
 * Config.md is looked up under {LIFEOS}/USER/CUSTOMIZATIONS/SKILLS/Stripe/
 * ({LIFEOS} follows CLAUDE_CONFIG_DIR through Paths.ts). Read-only; only env var NAMES are read, never values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLifeosDir } from "./Paths";

const ALIAS_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** The skill directories to try, in order, under a USER customizations root. */
export const STRIPE_SKILL_DIRS = ["Stripe"] as const;

/** First existing Config.md for the Stripe skill, or null. `userDir` defaults to {LIFEOS}/USER. */
export function stripeConfigPath(userDir: string = join(getLifeosDir(), "USER")): string | null {
  for (const dir of STRIPE_SKILL_DIRS) {
    const p = join(userDir, "CUSTOMIZATIONS", "SKILLS", dir, "Config.md");
    if (existsSync(p)) return p;
  }
  return null;
}

const cells = (line: string): string[] => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const clean = (c: string): string => c.replace(/[`*]/g, "").trim();

/** Alias (lower-cased) to env var name, from the `## Accounts` table. Empty when the table or its Alias/Env var columns are absent. */
export function parseAccountsTable(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Accounts\s*$/i.test(l.trim()));
  if (start < 0) return out;
  let alias = -1;
  let env = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^##\s/.test(l)) break;
    if (!l.startsWith("|")) { if (env >= 0) break; continue; }
    const row = cells(l);
    if (env < 0) {
      alias = row.findIndex((h) => /^alias$/i.test(clean(h)));
      env = row.findIndex((h) => /^env var$/i.test(clean(h)));
      if (alias < 0 || env < 0) return out;
      continue;
    }
    if (row.every((c) => /^:?-+:?$/.test(c))) continue; // separator row
    const a = clean(row[alias] ?? "");
    const e = clean(row[env] ?? "");
    if (ALIAS_RE.test(a) && ENV_NAME_RE.test(e)) out.set(a.toLowerCase(), e);
  }
  return out;
}

/** Today's rule: no account or "main" is STRIPE_SECRET_KEY, any other alias is STRIPE_SECRET_KEY_<ALIAS>. Throws on a malformed alias. */
export function derivedStripeKeyName(account: string | undefined): string {
  if (account === undefined || account === "main") return "STRIPE_SECRET_KEY";
  if (!ALIAS_RE.test(account)) throw new Error(`account alias needs letters, digits and underscores (got "${account}")`);
  return `STRIPE_SECRET_KEY_${account.toUpperCase()}`;
}

/** Env var name for an account: the Config.md table when it names the alias, otherwise the derived name. */
export function resolveStripeKeyName(account: string | undefined, opts: { userDir?: string; configPath?: string | null } = {}): string {
  const derived = derivedStripeKeyName(account); // validates the alias before any file read
  const path = opts.configPath !== undefined ? opts.configPath : stripeConfigPath(opts.userDir);
  if (!path || !existsSync(path)) return derived;
  let table: Map<string, string>;
  try { table = parseAccountsTable(readFileSync(path, "utf8")); } catch { return derived; }
  return table.get((account ?? "main").toLowerCase()) ?? derived;
}
