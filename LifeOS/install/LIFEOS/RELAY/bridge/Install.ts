#!/usr/bin/env bun
/**
 * Install.ts — Materialize com.lifeos.relay.plist.template and bootstrap it (Relay, the LifeOS text interface).
 *
 *   bun Install.ts             # install (idempotent: bootout prior load first)
 *   bun Install.ts --uninstall # remove
 *   bun Install.ts --status    # launchctl print
 *
 * Per-instance service — registered in LIFEOS/USER/CONFIG/services.json, never
 * in the shipped SERVICES array. macOS only (the bridge is this install's own).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { installVerb } from "../../TOOLS/lib/InstallVerb";
import { build, EXECUTABLE as HOST_EXECUTABLE } from "../host/BuildHost";

const HOME = process.env.HOME ?? homedir();
// fileURLToPath, not URL.pathname: a pathname keeps %20 and breaks an install path with spaces (RC 8.635.0 Lane A).
const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = "com.lifeos.relay";
const TEMPLATE = join(HERE, `${LABEL}.plist.template`);
const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");
const TARGET = join(LAUNCH_AGENTS, `${LABEL}.plist`);
const say = (m: string) => console.log(`[InstallRelay] ${m}`);

async function run(cmd: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { ok: (await p.exited) === 0, out, err };
}
const uid = async () => (await run(["id", "-u"])).out.trim();

async function install() {
  if (!existsSync(TEMPLATE)) { console.error(`template missing: ${TEMPLATE}`); process.exit(1); }
  const bun = Bun.which("bun");
  if (!bun) throw new Error("bun not found in PATH");
  // The bridge runs under "LifeOS Relay.app" so macOS has an app to hold its privacy grants.
  say(`relay host ${build().built ? "built" : "unchanged"}`);
  const plist = readFileSync(TEMPLATE, "utf8")
    .replace(/\{\{HOST\}\}/g, HOST_EXECUTABLE)
    .replace(/\{\{HOME\}\}/g, HOME)
    .replace(/\{\{BUN\}\}/g, bun)
    .replace(/\{\{BUN_DIR\}\}/g, dirname(bun));
  mkdirSync(LAUNCH_AGENTS, { recursive: true });
  mkdirSync(join(HOME, ".claude", "LIFEOS", "MEMORY", "STATE"), { recursive: true });
  const u = await uid();
  if (existsSync(TARGET)) await run(["launchctl", "bootout", `gui/${u}`, TARGET]);
  writeFileSync(TARGET, plist);
  say(`wrote ${TARGET}`);
  const r = await run(["launchctl", "bootstrap", `gui/${u}`, TARGET]);
  if (!r.ok) { console.error(`bootstrap failed: ${r.err.trim()}`); process.exit(1); }
  const st = await run(["launchctl", "print", `gui/${u}/${LABEL}`]);
  say(`bootstrap OK — ${st.out.split("\n").find((l) => l.includes("state ="))?.trim() ?? "state unknown"}`);
}

async function uninstall() {
  const u = await uid();
  if (!existsSync(TARGET)) { say("nothing installed"); return; }
  const r = await run(["launchctl", "bootout", `gui/${u}`, TARGET]);
  say(`bootout ${r.ok ? "OK" : "FAILED: " + r.err.trim()}`);
  try { unlinkSync(TARGET); say(`removed ${TARGET}`); } catch {}
}

async function status() {
  const r = await run(["launchctl", "print", `gui/${await uid()}/${LABEL}`]);
  if (!r.ok) { say(`${LABEL} not loaded`); process.exit(1); }
  console.log(r.out);
}

const arg = installVerb(process.argv, "Install");
if (arg === "--uninstall") await uninstall();
else if (arg === "--status") await status();
else await install();
