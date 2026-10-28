#!/usr/bin/env bun
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  // public issue #1729, @umair-a11y — homedir() instead of "~"/"" (HOME is unset on Windows)
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? homedir());
}

/**
 * LinkUser — Setup step 6. Establishes the system/user separation contract:
 * `<configRoot>/LIFEOS/USER` becomes a SYMLINK to `<configDir>/USER` (the private
 * data home). Migrates any live USER content into the data home first
 * (existsSync-guarded), then symlinks. Idempotent. Verifies the contract after.
 * Refuses on a dev tree unless --allow-dev.
 *
 * Usage:
 *   bun LinkUser.ts [--config-root <dir>] [--config-dir <dir>] [--apply] [--allow-dev]
 */

import { join, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { checkSymlinkContract, initConfigRootRepo, linkMemory, refuseDevInstallWrites, setupUserSeparation } from "./InstallEngine";

/** Canonical on-disk path, or null when the path does not exist. */
function realPath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? homedir());
}


function main(): void {
  const a = process.argv.slice(2);
  const get = (f: string): string | undefined => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
  };
  const home = process.env.HOME || homedir(); // public issue #1729, @umair-a11y
  const configRoot = get("--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const configDir = get("--config-dir") || process.env.LIFEOS_CONFIG_DIR || join(home, ".config", "LIFEOS");
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");

  refuseDevInstallWrites(configRoot, [join(configRoot, "LIFEOS", "USER"), join(configDir, "USER"), configDir], allowDev);

  // Refuse a self-link loudly (public issue #1491, @donovan-sec): if the env
  // ships LIFEOS_CONFIG_DIR identical to the harness LIFEOS dir, the link
  // target resolves to its own source and the "separation" is a no-op at best.
  const linkSrc = resolve(join(configRoot, "LIFEOS", "USER"));
  const linkDst = resolve(join(configDir, "USER"));
  if (linkSrc === linkDst) {
    console.log(JSON.stringify({ ok: false, refused: "self-link", detail: `LIFEOS_CONFIG_DIR resolves USER separation to itself (${linkSrc}) — set LIFEOS_CONFIG_DIR to a location outside the harness tree (default: ~/.config/LIFEOS).` }, null, 2));
    process.exit(2);
  }

  // Both sides already name one directory. The resolve() check above is lexical,
  // so an install whose link target spells that directory differently — a
  // symlinked home, /private canonicalization, a relative link — fell through to
  // the rebuild path and died EEXIST creating a symlink over itself, stranding a
  // .pre-link-backup tree. Public issue #1694, @dissembler21-png.
  const realSrc = realPath(linkSrc);
  if (realSrc !== null && realSrc === realPath(linkDst)) {
    if (isSymlink(linkSrc)) {
      // The USER leg is right, but the contract has two legs: check MEMORY too
      // and repair only that leg rather than reporting a pass it has not earned.
      // An install linked by an older release still gets the config-root repo and its
      // .env / credentials ignore rules on --apply (idempotent; never on a dry run).
      const before = checkSymlinkContract(configRoot, configDir);
      if (before.passed) {
        const configRepo = apply ? initConfigRootRepo(configRoot) : undefined;
        console.log(JSON.stringify({ ok: true, action: "already-linked", target: linkDst, copied: 0, ...(configRepo ? { configRepo } : {}), contract: before }, null, 2));
        process.exit(0);
      }
      if (!apply) {
        console.log(JSON.stringify({ ok: true, dryRun: true, action: "already-linked", currentContract: before, willLink: `${join(configRoot, "LIFEOS", "MEMORY")} → ${join(configDir, "USER", "MEMORY")}` }, null, 2));
        process.exit(0);
      }
      const memory = linkMemory(configRoot, configDir);
      const configRepo = initConfigRootRepo(configRoot);
      const contract = checkSymlinkContract(configRoot, configDir);
      const ok = contract.passed && !memory.error;
      console.log(JSON.stringify({ ok, written: true, action: "already-linked", target: linkDst, copied: 0, memory, configRepo, contract }, null, 2));
      process.exit(ok ? 0 : 1);
    }
    // Not a symlink, yet the same directory: configDir reaches back inside the
    // harness tree. Same hazard as the lexical self-link above — migrating would
    // rename the live tree out from under its own destination.
    console.log(JSON.stringify({ ok: false, refused: "self-link", detail: `${linkSrc} and ${linkDst} are the same directory (${realSrc}) — set LIFEOS_CONFIG_DIR to a location outside the harness tree (default: ~/.config/LIFEOS).` }, null, 2));
    process.exit(2);
  }

  if (!apply) {
    const contract = checkSymlinkContract(configRoot, configDir);
    console.log(JSON.stringify({ ok: true, dryRun: true, currentContract: contract, willLink: `${join(configRoot, "LIFEOS", "USER")} → ${join(configDir, "USER")}` }, null, 2));
    process.exit(0);
  }

  const result = setupUserSeparation(configRoot, configDir);
  // Local history for the config root too (never a remote); ignore rules land
  // first so no later commit can carry .env or the harness token store
  // (public issue #2036, @tzioup). Like the USER repo leg, a no-git machine
  // records a reason rather than failing the link.
  const configRepo = initConfigRootRepo(configRoot);
  const contract = checkSymlinkContract(configRoot, configDir);
  const ok = contract.passed && !result.error;
  console.log(JSON.stringify({ ok, written: true, ...result, configRepo, contract }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
