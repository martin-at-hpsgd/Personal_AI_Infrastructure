#!/usr/bin/env bun
/**
 * InstallVelocitySync.ts - Materialize com.lifeos.velocity.plist.template and bootstrap it.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/InstallVelocitySync.ts             # install (runs once at load, then hourly)
 *   bun ~/.claude/LIFEOS/TOOLS/InstallVelocitySync.ts --uninstall # remove
 *   bun ~/.claude/LIFEOS/TOOLS/InstallVelocitySync.ts --status    # check
 *
 * Same shape as InstallDerivedSync.ts. macOS launchd only; on Linux run the tool from cron.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lifeosPath } from "./Paths";
import { installVerb } from "./lib/InstallVerb";

const HOME = process.env.HOME ?? homedir();
const LABEL = "com.lifeos.velocity";
const TEMPLATE_PATH = lifeosPath("TOOLS", `${LABEL}.plist.template`);
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const TARGET_PLIST = join(LAUNCH_AGENTS_DIR, `${LABEL}.plist`);

function sh(cmd: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(cmd);
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}
const uid = () => sh(["id", "-u"]).out.trim();

function install() {
  if (process.platform !== "darwin") { console.error(`[InstallVelocitySync] launchd only; on this platform schedule \`bun ${lifeosPath("TOOLS", "ShippingVelocity.ts")}\` from cron.`); process.exit(1); }
  if (!existsSync(TEMPLATE_PATH)) { console.error(`[InstallVelocitySync] template missing at ${TEMPLATE_PATH}`); process.exit(1); }
  const bun = sh(["which", "bun"]).out.trim();
  if (!bun) { console.error("[InstallVelocitySync] bun not found in PATH"); process.exit(1); }
  const materialized = readFileSync(TEMPLATE_PATH, "utf-8")
    .replace(/\{\{HOME\}\}/g, HOME).replace(/\{\{BUN\}\}/g, bun).replace(/\{\{BUN_DIR\}\}/g, bun.replace(/\/bun$/, ""));
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  const u = uid();
  if (existsSync(TARGET_PLIST)) sh(["launchctl", "bootout", `gui/${u}`, TARGET_PLIST]);
  writeFileSync(TARGET_PLIST, materialized);
  const r = sh(["launchctl", "bootstrap", `gui/${u}`, TARGET_PLIST]);
  if (!r.ok) { console.error(`[InstallVelocitySync] bootstrap failed: ${r.err.trim()}`); process.exit(1); }
  console.log(`[InstallVelocitySync] ${LABEL} bootstrapped — runs now, then hourly → ${TARGET_PLIST}`);
}

function uninstall() {
  const u = uid();
  if (existsSync(TARGET_PLIST)) { sh(["launchctl", "bootout", `gui/${u}`, TARGET_PLIST]); unlinkSync(TARGET_PLIST); console.log(`[InstallVelocitySync] removed ${TARGET_PLIST}`); }
  else console.log(`[InstallVelocitySync] not installed`);
}

function status() {
  const r = sh(["launchctl", "print", `gui/${uid()}/${LABEL}`]);
  if (!r.ok) { console.log(`[InstallVelocitySync] ${LABEL}: not loaded`); process.exit(1); }
  const line = r.out.split("\n").find((l) => l.includes("state ="));
  console.log(`[InstallVelocitySync] ${LABEL}: ${line?.trim() ?? "loaded"}`);
}

const arg = installVerb(process.argv, "InstallVelocitySync");
if (arg === "--uninstall") uninstall();
else if (arg === "--status") status();
else install();
