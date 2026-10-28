/** Shared, fail-closed writer for per-user launchd agents. */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
export const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");

const LABEL_RE = /^[A-Za-z0-9._-]+$/;
function assertValidLabel(label: string): void {
  if (!LABEL_RE.test(label)) {
    throw new Error(`LaunchAgent: invalid agent label ${JSON.stringify(label)} — must match ${LABEL_RE}`);
  }
}

export function agentPath(label: string): string {
  assertValidLabel(label);
  return join(LAUNCH_AGENTS, `${label}.plist`);
}

/** Materialize a launchd plist only after all release-time tokens are resolved. */
export function writeAgent(label: string, body: string, opts: { encoding?: BufferEncoding } = {}): string {
  const unresolved = body.match(/__[A-Z_]+__/);
  if (unresolved) throw new Error(`LaunchAgent: refusing unresolved placeholder ${unresolved[0]}`);
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  const path = agentPath(label);
  writeFileSync(path, body, opts);
  return path;
}
