/**
 * Infrastructure Inventory: the list of your public sites, APIs and workers.
 *
 * Read by the hourly infra-security scanner (what to probe), the Atlas
 * collector (which domains are monitored), and the deploy-registration gate
 * (a newly deployed custom domain must appear here). Hooks that decide whether
 * a host is yours read the quoted domain values in this file, so write
 * each domain as a plain string literal.
 *
 * Empty means "no targets configured": the scanner has nothing to check and
 * Atlas reports no monitored domains. Add one entry per public domain you own.
 *
 * An entry has the Target shape below: name, type, domain, paths, and optional
 * aliases, protectedPaths, dataProbePaths and healthCheckPaths. Keep example
 * hostnames out of comments here, because owned-host detection reads every
 * quoted domain value in this file.
 */

export type TargetType = "site" | "api" | "worker";

export type TargetSource = "curated" | "discovered";

export interface Target {
  name: string;
  type: TargetType;
  domain: string;
  paths: string[];
  /** Paths that MUST return 401/403 without auth */
  protectedPaths?: string[];
  /** Other hostnames the same Worker serves (the `www.` twin); each is probed for reachability. */
  aliases?: string[];
  /** Paths to probe for unauthenticated data exposure (expect non-200 or non-JSON) */
  dataProbePaths?: string[];
  /** Paths that MUST return 200 (app-authored health probes) */
  healthCheckPaths?: string[];
  expectHeaders?: Record<string, string | boolean>;
  checkDns?: boolean;
  workersDevName?: string;
  /** Service binding the scanner uses to reach a same-account workers.dev host. */
  serviceBinding?: string;
  /** "curated" = hand-authored here; "discovered" = machine-enumerated from the Cloudflare account. */
  source?: TargetSource;
  /** Auth entry points (login/callback), for authenticated-pass targeting. */
  auth?: { providers?: string[]; loginPaths?: string[]; callbackPaths?: string[] };
  /** Database entry points that must never answer unauthenticated. */
  dbEntryPoints?: string[];
  /** Backing stores declared in the app's wrangler config. Informational. */
  dataStores?: Array<"d1" | "kv" | "r2" | "postgres" | "mysql">;
  /** Signature-verified webhook receivers. Informational. */
  webhooks?: string[];
  /** True when the target isolates data per tenant/user. */
  multiTenant?: boolean;
}

export const TARGETS: Target[] = [];
