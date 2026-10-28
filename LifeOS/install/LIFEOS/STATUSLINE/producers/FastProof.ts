import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mtime, type Cache } from "../Cache";
import { invariant } from "../../TOOLS/Invariant";
import type { RefreshJob } from "./Background";

/**
 * Keeps statusline-fast in step with the TypeScript it mirrors. The shim runs the binary only while its proof stamp is
 * newer than the binary and every file listed in fast/sources; this job rebuilds the binary and runs Fast.test.ts whenever
 * the stamp is behind, and writes the stamp only when the test passes. Until then every render goes to Bun, so an edit to
 * the replay decision on either side can never be served by a binary that disagrees with it.
 */

export interface FastPaths { statusline: string; binary: string; proof: string; sources: string; test: string }

export const fastPaths = (statusline: string = join(import.meta.dir, "..")): FastPaths => {
  const binary = join(statusline, "fast", "target", "release", "statusline-fast");
  return { statusline, binary, proof: `${binary}.proven`, sources: join(statusline, "fast", "sources"), test: join(statusline, "Fast.test.ts") };
};

/** The files the binary mirrors, relative to STATUSLINE, from the one list the shim also reads. */
export const fastSources = (paths: FastPaths): string[] =>
  existsSync(paths.sources) ? readFileSync(paths.sources, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];

/** The newest mtime among the binary and its sources: the proof must be strictly newer, as the shim's -nt tests demand. */
const newestInput = (paths: FastPaths): number =>
  Math.max(mtime(paths.binary), ...fastSources(paths).map((f) => mtime(join(paths.statusline, f))));

export interface FastProofDeps { prove: (paths: FastPaths) => Promise<{ ok: boolean; detail: string }> }

const FAILED_STAMP = "fast-proof-failed.stamp";
/** A failed proof is retried at once when an input changes, otherwise at most hourly. */
const RETRY_SECONDS = 3600;
/** Kept under the refresher's 45 s deadline so the child is killed here, never left behind. */
const PROVE_TIMEOUT_MS = 40_000;

const liveProve = async (paths: FastPaths): Promise<{ ok: boolean; detail: string }> => {
  const home = process.env.HOME ?? "";
  const path = [dirname(process.execPath), home && join(home, ".cargo", "bin"), process.env.PATH ?? ""].filter(Boolean).join(":");
  const child = Bun.spawn([process.execPath, "test", paths.test], { cwd: paths.statusline, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: path } });
  const timer = setTimeout(() => child.kill(), PROVE_TIMEOUT_MS);
  try {
    const [, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, detail: code === 0 ? "" : err.split("\n").filter((l) => /fail|error|✗/i.test(l)).slice(0, 5).join(" | ") || `exit ${code}` };
  } finally { clearTimeout(timer); }
};

export function fastProofRefresh(cache: Cache, paths: FastPaths = fastPaths(), deps: FastProofDeps = { prove: liveProve }): RefreshJob | null {
  // No parity test in this install (the public release ships none): no proof, so the shim keeps rendering with Bun.
  if (!existsSync(paths.test) || fastSources(paths).length === 0) return null;
  const inputs = newestInput(paths);
  if (existsSync(paths.binary) && mtime(paths.proof) > inputs) return null;
  const failed = mtime(cache.path(FAILED_STAMP));
  if (failed > inputs && cache.now - failed < RETRY_SECONDS) return null;
  return {
    name: "fast-proof",
    async run() {
      const result = await deps.prove(paths);
      if (!result.ok) {
        cache.put(FAILED_STAMP, `${cache.now}\n`);
        throw new Error(`statusline-fast parity test failed; Bun renders every run until it passes: ${result.detail}`);
      }
      invariant(paths.proof.startsWith(`${paths.statusline}/`) && existsSync(paths.binary), "a passing proof stamps a built binary inside STATUSLINE");
      writeFileSync(paths.proof, `${new Date().toISOString()}\n`, { mode: 0o600 });
    },
  };
}
