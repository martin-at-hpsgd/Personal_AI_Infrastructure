/**
 * The cloud half of the secret check (ISC-33).
 *
 * A workflow declared `runs_on: cloud` must have every secret it declares held
 * by its runner Worker. With Cloudflare credentials present this asks the
 * read-only preflight for the runner's secret NAMES and refuses on any missing
 * name. Without credentials it does not pass silently: it returns an
 * "unverified" note the caller records as a warning. Names only, never values.
 */
import type { DefinitionV2 } from "../engine/format.ts";
import { declaredSecrets } from "../engine/format.ts";
import { cloudCredentials } from "./credentials.ts";
import { preflight, type FetchLike } from "./preflight.ts";

export interface CloudCheckOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

export interface CloudSecretCheck {
  status: "verified" | "unverified" | "missing";
  declared: string[];
  missing: string[];
  /** Why the check could not be completed (status "unverified"). */
  note?: string;
}

export const runnerNameFor = (workflow: string): string => `wf-${workflow}`;

export async function cloudSecretCheck(def: DefinitionV2, opts: CloudCheckOptions = {}): Promise<CloudSecretCheck> {
  const declared = [...new Set(declaredSecrets(def).map(s => s.name))];
  const creds = cloudCredentials(opts.env ?? process.env);
  if (!creds) return { status: "unverified", declared, missing: [], note: "unverified: no Cloudflare credentials, so the runner's secret names were not checked" };
  if (declared.length === 0) return { status: "verified", declared, missing: [] };
  try {
    const verdict = await preflight({ ...creds, runner: runnerNameFor(def.name), actionScripts: [], secrets: declared, fetch: opts.fetch });
    if (!verdict.runnerExists) return { status: "unverified", declared, missing: [], note: `unverified: runner Worker ${runnerNameFor(def.name)} is not deployed yet, so its secret names cannot be checked (the deploy preflight checks them)` };
    if (verdict.missingSecrets.length) return { status: "missing", declared, missing: verdict.missingSecrets };
    return { status: "verified", declared, missing: [] };
  } catch (error) {
    return { status: "unverified", declared, missing: [], note: `unverified: the Cloudflare check failed (${error instanceof Error ? error.message : String(error)})` };
  }
}
