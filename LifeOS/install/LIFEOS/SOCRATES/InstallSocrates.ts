#!/usr/bin/env bun
/**
 * InstallSocrates.ts — materialize the hourly socrates tick under launchd.
 *
 *   bun ~/.claude/LIFEOS/SOCRATES/InstallSocrates.ts             # install
 *   bun ~/.claude/LIFEOS/SOCRATES/InstallSocrates.ts --uninstall # remove
 *   bun ~/.claude/LIFEOS/SOCRATES/InstallSocrates.ts --status    # check
 *
 * darwin-only for v0 (Atlas's linux systemd pattern ports over when needed).
 * Idempotent: install tears down the prior unit before bootstrapping.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { installVerb } from "../TOOLS/lib/InstallVerb";
import { claudeDirFor, defaultClaudeDir } from "../TOOLS/Paths";
import { invariant } from "../TOOLS/Invariant";

const HOME = process.env.HOME || "";
const LABEL = "com.lifeos.socrates";
// The install this script resolves (CLAUDE_CONFIG_DIR honoured), never a fixed ~/.claude.
const CLAUDE_DIR = claudeDirFor(process.env, HOME);
const TEMPLATE = join(import.meta.dir, "com.lifeos.socrates.plist.template");
const TARGET = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

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
  const verb = installVerb(process.argv, "InstallSocrates", { verbs: ["--install"] });
  const mode = verb === "install" ? "--install" : verb;
  const uid = (await run(["id", "-u"])).out.trim();
  const domain = `gui/${uid}`;

  if (mode === "--status") {
    const r = await run(["launchctl", "print", `${domain}/${LABEL}`]);
    console.log(r.ok ? r.out.split("\n").filter((l) => /state|last exit|program/.test(l)).join("\n") : "not loaded");
    return;
  }
  // Tear down any prior unit (both install and uninstall paths).
  await run(["launchctl", "bootout", `${domain}/${LABEL}`]);
  if (mode === "--uninstall") {
    if (existsSync(TARGET)) unlinkSync(TARGET);
    console.log(JSON.stringify({ uninstalled: true }));
    return;
  }
  const bun = (await run(["sh", "-lc", "command -v bun"])).out.trim() || "/opt/homebrew/bin/bun";
  // The tick reads CLAUDE_CONFIG_DIR itself (Registry, Store, Router), so a custom root rides along in its env.
  const extraEnv = process.env.CLAUDE_CONFIG_DIR !== undefined || CLAUDE_DIR !== defaultClaudeDir(HOME)
    ? `\n    <key>CLAUDE_CONFIG_DIR</key>\n    <string>${xml(CLAUDE_DIR)}</string>` : "";
  const plist = readFileSync(TEMPLATE, "utf8")
    .split("{{CLAUDE_DIR}}").join(xml(CLAUDE_DIR))
    .split("{{EXTRA_ENV}}").join(extraEnv)
    .split("{{HOME}}").join(xml(HOME))
    .split("{{BUN}}").join(xml(bun))
    .split("{{PATH}}").join(xml(process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin"));
  invariant(!plist.includes("{{"), "every plist placeholder is filled");
  mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(TARGET, plist);
  const boot = await run(["launchctl", "bootstrap", domain, TARGET]);
  if (!boot.ok) {
    console.error(`bootstrap failed: ${boot.err.trim()}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ installed: true, plist: TARGET, interval: "3600s" }));
}

main();
