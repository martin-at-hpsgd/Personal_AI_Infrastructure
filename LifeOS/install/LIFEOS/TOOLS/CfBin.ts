// The pinned cf, installed once per version into a LifeOS-owned cache and run by its full path.
// `bunx <pin>` re-links one shared temp dir on every call, so two overlapping calls broke each
// other about 1 in 6 times ("Failed to link cf: EEXIST", a dist module not found); three Vector
// deploys failed on it in a row (2026-10-17). An installed bin is never re-linked by a caller.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "./Invariant";

const DEFAULT_ROOT = join(homedir(), ".cache", "lifeos", "cf");

/** The install directory for one pinned package, named after the pin so moving the pin installs fresh. */
export function cfCacheDir(pkg: string, root = DEFAULT_ROOT): string {
  return join(root, pkg.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/**
 * The argv prefix that runs the pinned cf: its installed bin, by full path (launchd has no
 * ~/.bun/bin on PATH). A missing version is installed into a private temp dir and renamed into
 * place in one step, so a concurrent caller never sees a half-installed copy; the loser of an
 * install race keeps the winner's copy.
 */
export function cfCommand(pkg: string, root = DEFAULT_ROOT): string[] {
  const dir = cfCacheDir(pkg, root);
  const bin = join(dir, "node_modules", ".bin", "cf");
  if (existsSync(bin)) return [bin];
  mkdirSync(dirname(dir), { recursive: true });
  const tmp = mkdtempSync(`${dir}.tmp-`);
  try {
    // Its own package.json makes tmp the project root; without it `bun add` walks up and adds cf
    // to whatever parent project it finds (it wrote LIFEOS/TOOLS/package.json once).
    writeFileSync(join(tmp, "package.json"), `${JSON.stringify({ name: "lifeos-cf-pin", private: true })}\n`);
    const r = spawnSync(process.execPath, ["add", "--exact", pkg], { cwd: tmp, encoding: "utf8" });
    invariant(r.status === 0 && existsSync(join(tmp, "node_modules", ".bin", "cf")), `cf install of ${pkg} failed: ${(r.stderr || r.stdout || "").slice(-400)}`);
    try {
      renameSync(tmp, dir);
    } catch (e) {
      if (!existsSync(bin)) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  invariant(existsSync(bin), `cf bin missing after install: ${bin}`);
  return [bin];
}
