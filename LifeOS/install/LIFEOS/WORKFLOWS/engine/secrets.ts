/**
 * secrets.ts — is a secret NAME present in the local env? (ISC-33 local half, ISC-70)
 *
 * A definition declares secret NAMES, never values. A `runs_on: local` workflow is invalid
 * while one is absent. The lookup uses the `Secrets.ts has` contract: the process env first,
 * then the sealed-.env presence check, which prints `NAME yes|no` and never a value. This
 * module reads no value into its own output and never returns one; it answers yes or no.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRETS_TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "TOOLS", "Secrets.ts");
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const cache = new Map<string, boolean>();

/** True when NAME is set and non-empty in the process env or present in the local .env (names only, values never read). */
export function localHasSecret(name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const inEnv = process.env[name];
  if (inEnv !== undefined && inEnv !== "") return true;
  const key = `${process.env.LIFEOS_SECRETS_ENV ?? ""}\u0000${name}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  const result = Bun.spawnSync([process.execPath, SECRETS_TOOL, "has", name], { stdout: "pipe", stderr: "ignore", timeout: 15_000, env: process.env as Record<string, string> });
  const present = result.exitCode === 0 && result.stdout.toString().split("\n").some(line => line.trim() === name + " yes");
  cache.set(key, present);
  return present;
}
