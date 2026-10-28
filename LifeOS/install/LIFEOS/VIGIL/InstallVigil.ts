#!/usr/bin/env bun
/** Install or remove the com.lifeos.vigil scheduled tick. The plist names the install this script resolves (LIFEOS/TOOLS/Paths, honouring CLAUDE_CONFIG_DIR) and an absolute Bun path whose directory leads the plist's PATH, never a fixed ~/.claude or a bare bun. An install that has the `vigil-tick` workflow runs the tick there instead, and this installer refuses to add a second clock beside it (Workflows ISA ISC-275). @version 0.3.0 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { installVerb } from "../TOOLS/lib/InstallVerb";
import { claudeDirFor, defaultClaudeDir, lifeosDirFor } from "../TOOLS/Paths";
import { definitionsDir } from "../WORKFLOWS/engine/paths";

const HOME = process.env.HOME ?? homedir();
const TEMPLATE = join(import.meta.dir, "com.lifeos.vigil.plist.template");
const TARGET = join(HOME, "Library/LaunchAgents/com.lifeos.vigil.plist");
const LABEL = "com.lifeos.vigil";
/** The workflow that carries the tick when the install has one; Tick.ts has no lock, so two clocks would route, and text, twice. */
export const workflowDefinition = (dir = definitionsDir()) => join(dir, "vigil-tick.workflow.yaml");

/** launchd starts the tick with no shell profile, so the plist carries the Bun directory first and these system directories after it. */
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");

/** The plist text for one install. Pure: the caller passes the environment, home and Bun binary, so it can be rendered and read back without touching launchd. */
export function renderPlist(o: { env: Record<string, string | undefined>; home: string; bun: string; template?: string }): string {
  const root = claudeDirFor(o.env, o.home), lifeos = lifeosDirFor(o.env, o.home);
  const extra: [string, string][] = [];
  if (o.env.CLAUDE_CONFIG_DIR !== undefined || root !== defaultClaudeDir(o.home)) extra.push(["CLAUDE_CONFIG_DIR", root]);
  if (lifeos !== join(root, "LIFEOS")) extra.push(["LIFEOS_DIR", lifeos]);
  const path = [...new Set([dirname(o.bun), ...SYSTEM_PATH])].join(":");
  const body = (o.template ?? readFileSync(TEMPLATE, "utf8"))
    .replaceAll("{{BUN}}", () => xml(o.bun)).replaceAll("{{TICK}}", () => xml(join(lifeos, "VIGIL", "Tick.ts")))
    .replaceAll("{{PATH}}", () => xml(path)).replaceAll("{{EXTRA_ENV}}", () => extra.map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join(""))
    .replaceAll("{{HOME}}", () => xml(o.home));
  invariant(!body.includes("{{"), "every plist placeholder is filled");
  invariant(body.includes("LIFEOS_NOTIFICATION_CHANNEL"), "materialized plist is headless");
  return body;
}

async function run(args: string[]) {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text(), err = await new Response(p.stderr).text();
  return { ok: await p.exited === 0, out, err };
}

async function main() {
  const arg = installVerb(process.argv, "InstallVigil");
  const uid = (await run(["id", "-u"])).out.trim();
  if (arg === "--uninstall") {
    if (existsSync(TARGET)) {
      await run(["launchctl", "bootout", `gui/${uid}`, TARGET]);
      invariant(TARGET.endsWith(`${LABEL}.plist`), "uninstall target is Vigil plist");
      unlinkSync(TARGET);
    }
    console.log(`[InstallVigil] removed ${LABEL}`);
    return;
  }
  if (arg === "--status") {
    const r = await run(["launchctl", "print", `gui/${uid}/${LABEL}`]);
    console.log(r.ok ? r.out.split("\n").find((x) => x.includes("state ="))?.trim() ?? "loaded" : `${LABEL} not loaded`);
    if (!r.ok) process.exit(1);
    return;
  }
  if (existsSync(workflowDefinition())) {
    console.log(`[InstallVigil] the tick runs as the vigil-tick workflow (${workflowDefinition()}); not installing ${LABEL} beside it. Schedule: bun LIFEOS/WORKFLOWS/engine/schedule-install.ts install vigil-tick`);
    return;
  }
  invariant(TARGET.endsWith(`${LABEL}.plist`), "install target is Vigil plist");
  mkdirSync(dirname(TARGET), { recursive: true });
  mkdirSync(join(HOME, ".local/state/lifeos/vigil"), { recursive: true });
  // The bun on PATH is usually a stable link (/opt/homebrew/bin/bun, ~/.bun/bin/bun) that survives an upgrade; execPath
  // can be a versioned Cellar path an upgrade deletes. Without one on PATH, the Bun running this installer is the answer.
  const body = renderPlist({ env: process.env, home: HOME, bun: Bun.which("bun") ?? process.execPath });
  if (existsSync(TARGET)) await run(["launchctl", "bootout", `gui/${uid}`, TARGET]);
  writeFileSync(TARGET, body);
  const r = await run(["launchctl", "bootstrap", `gui/${uid}`, TARGET]);
  if (!r.ok) throw new Error(`bootstrap failed: ${r.err.trim()}`);
  console.log(`[InstallVigil] ${LABEL} active (every 300 seconds)`);
}
if (import.meta.main) main().catch((e) => { console.error(`[InstallVigil] Fatal: ${e}`); process.exit(1); });
