#!/usr/bin/env bun
/**
 * InstallPeople.ts — materialize the hourly `people tick` under launchd.
 *
 *   bun ~/.claude/LIFEOS/PEOPLE/InstallPeople.ts             # install
 *   bun ~/.claude/LIFEOS/PEOPLE/InstallPeople.ts --uninstall # remove
 *   bun ~/.claude/LIFEOS/PEOPLE/InstallPeople.ts --status    # check
 *
 * darwin-only for v0, the same shape as InstallSocrates.ts (Atlas's Linux systemd
 * pattern ports over when a Linux install needs it). Idempotent: install tears the
 * prior unit down before bootstrapping.
 *
 * The job carries RunAtLoad=false, so installing it never itself rewrites the
 * people store. The installer prints the earliest possible next fire so the
 * operator can see that their own first run comes first.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installVerb } from "../TOOLS/lib/InstallVerb";

const HOME = process.env.HOME || "";
const LABEL = "com.lifeos.people";
const INTERVAL_SECONDS = 3600;
const TEMPLATE = join(HOME, ".claude/LIFEOS/PEOPLE", `${LABEL}.plist.template`);
const TARGET = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = join(HOME, ".claude/LIFEOS/MEMORY/OBSERVABILITY");

async function run(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  return { ok: (await proc.exited) === 0, out, err };
}

async function main() {
  if (process.platform !== "darwin") {
    console.error("darwin only for v0");
    process.exit(1);
  }
  // The verb is checked before any launchctl call: a bad flag never boots the unit out (round-18 audit).
  const verb = installVerb(process.argv, "InstallPeople", { verbs: ["--install"] });
  const mode = verb === "install" ? "--install" : verb;
  const uid = (await run(["id", "-u"])).out.trim();
  const domain = `gui/${uid}`;

  if (mode === "--status") {
    const r = await run(["launchctl", "print", `${domain}/${LABEL}`]);
    console.log(r.ok ? r.out.split("\n").filter((l) => /state|last exit|program|runs/.test(l)).join("\n") : "not loaded");
    return;
  }

  // Tear down any prior unit (both the install and the uninstall path).
  await run(["launchctl", "bootout", `${domain}/${LABEL}`]);
  if (mode === "--uninstall") {
    if (existsSync(TARGET)) unlinkSync(TARGET);
    console.log(JSON.stringify({ uninstalled: true }));
    return;
  }

  if (!existsSync(TEMPLATE)) {
    console.error(`template missing at ${TEMPLATE}`);
    process.exit(1);
  }
  const bun = (await run(["sh", "-lc", "command -v bun"])).out.trim() || "/opt/homebrew/bin/bun";
  const plist = readFileSync(TEMPLATE, "utf8")
    .split("{{HOME}}").join(HOME)
    .split("{{BUN}}").join(bun)
    .split("{{PATH}}").join(process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin");
  mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(TARGET, plist);

  const boot = await run(["launchctl", "bootstrap", domain, TARGET]);
  if (!boot.ok) {
    console.error(`bootstrap failed: ${boot.err.trim()}`);
    process.exit(1);
  }
  // RunAtLoad is false, so the earliest the job can fire is one interval from now.
  const nextFire = new Date(Date.now() + INTERVAL_SECONDS * 1000).toISOString();
  console.log(JSON.stringify({ installed: true, plist: TARGET, interval: `${INTERVAL_SECONDS}s`, runAtLoad: false, earliestNextFire: nextFire }));
}

main();
