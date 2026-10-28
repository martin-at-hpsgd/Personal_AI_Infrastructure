#!/usr/bin/env bun
/**
 * @version 1.0.1
 * InstallMessagesSync.ts - Compile the Messages reader, materialize com.lifeos.messages.plist.template, bootstrap it.
 *
 *   bun ~/.claude/LIFEOS/TOOLS/InstallMessagesSync.ts             # build + install
 *   bun ~/.claude/LIFEOS/TOOLS/InstallMessagesSync.ts --uninstall # remove
 *   bun ~/.claude/LIFEOS/TOOLS/InstallMessagesSync.ts --status    # check
 *
 * Full Disk Access is granted by hand, once, to the compiled binary alone.
 * An ad-hoc signature pins that grant to the binary's hash, so a rebuild voids
 * it. When a code-signing certificate is in the keychain the binary is signed
 * with it instead: the grant then follows the identifier and certificate and
 * survives rebuilds. An install that finds the binary keeps it unless --rebuild.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getClaudeDir, lifeosPath } from "./Paths";
import { installVerb } from "./lib/InstallVerb";

const HOME = homedir();
const LABEL = "com.lifeos.messages";
const TEMPLATE = lifeosPath("TOOLS", `${LABEL}.plist.template`);
const TARGET = join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const BIN = join(HOME, ".local", "bin", "lifeos-messages");
const SOURCE = lifeosPath("TOOLS", "Messages", "MessagesSync.ts");

async function sh(cmd: string[]): Promise<{ exit: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { exit: await proc.exited, out };
}

const uid = (await sh(["id", "-u"])).out.trim();
const domain = `gui/${uid}`;

installVerb(process.argv, "InstallMessagesSync", { verbs: ["--rebuild"] });
if (process.argv.includes("--status")) {
  const listed = await sh(["launchctl", "print", `${domain}/${LABEL}`]);
  console.log(existsSync(TARGET) ? `plist: ${TARGET}` : "plist: not installed");
  console.log(existsSync(BIN) ? `binary: ${BIN}` : "binary: not built");
  console.log(listed.exit === 0 ? "launchd: loaded" : "launchd: not loaded");
  process.exit(0);
}

if (process.argv.includes("--uninstall")) {
  await sh(["launchctl", "bootout", domain, TARGET]);
  if (existsSync(TARGET)) unlinkSync(TARGET);
  console.log(`Uninstalled ${LABEL} (binary kept at ${BIN}; delete it and its Full Disk Access entry by hand)`);
  process.exit(0);
}

if (!existsSync(BIN) || process.argv.includes("--rebuild")) {
  mkdirSync(dirname(BIN), { recursive: true });
  const build = await sh([process.execPath, "build", "--compile", SOURCE, "--outfile", BIN]);
  if (build.exit !== 0) { console.error(`build failed: ${build.out}`); process.exit(1); }
  // Gotcha: bun's compiled binary carries a broken ad-hoc signature and launchd
  // kills it with OS_REASON_CODESIGNING; re-sign before it ever runs, with a
  // keychain certificate when one exists so the Full Disk Access grant outlives the build.
  const identity = (await sh(["security", "find-identity", "-p", "codesigning", "-v"])).out.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(?:Developer ID Application|Apple Development):/m)?.[1] ?? "-";
  const sign = await sh(["codesign", "--force", "--sign", identity, "--identifier", LABEL, BIN]);
  const verify = await sh(["codesign", "--verify", BIN]);
  if (sign.exit !== 0 || verify.exit !== 0) { console.error(`codesign failed: ${sign.out}${verify.out}`); process.exit(1); }
  console.log(identity === "-"
    ? `Built ${BIN}, signed ad hoc: (re)grant Full Disk Access to it after every rebuild.`
    : `Built ${BIN}, signed with certificate ${identity.slice(0, 8)}: grant Full Disk Access once and later rebuilds keep it.`);
}

const plist = readFileSync(TEMPLATE, "utf8").replaceAll("{{BIN}}", BIN).replaceAll("{{CLAUDE_DIR}}", getClaudeDir()).replaceAll("{{HOME}}", HOME);
const unfilled = plist.match(/\{\{[A-Z_]+\}\}/);
if (unfilled) { console.error(`template placeholder ${unfilled[0]} left unfilled in ${TEMPLATE}`); process.exit(1); }
mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, plist);
await sh(["launchctl", "bootout", domain, TARGET]); // idempotent reinstall
const boot = await sh(["launchctl", "bootstrap", domain, TARGET]);
if (boot.exit !== 0) { console.error(`bootstrap failed: ${boot.out}`); process.exit(1); }
console.log(`Installed ${LABEL} (every 300s) → ${TARGET}`);
console.log(`Full Disk Access: System Settings → Privacy & Security → Full Disk Access → + → ${BIN}`);
