#!/usr/bin/env bun
/**
 * Freshness.ts — is our herdr install, config and agent knowledge current?
 *
 * Read-only against herdr: it never updates, reloads or stops anything.
 * The only thing it writes is its own baseline, and only with --accept.
 *
 * Checks
 *   version       installed binary vs the stable release named in herdr.dev/llms.txt
 *   server        running server vs client (stale binary, restart needed)
 *   integrations  installed agent integrations that are not "current"
 *   config_keys   keys in our config.toml that herdr --default-config no longer knows
 *   skill_hash    `herdr --skill` changed since the accepted baseline
 *
 * Usage
 *   bun Freshness.ts [--json] [--offline] [--accept]
 *
 * Exit: 0 fresh · 1 stale · 2 error (herdr missing or unreadable)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { invariant, InvariantViolation } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { getClaudeDir } from "../../../LIFEOS/TOOLS/Paths.ts";

const LLMS_INDEX = "https://herdr.dev/llms.txt";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const offline = args.has("--offline");
const accept = args.has("--accept");

const configRoot = getClaudeDir();
const stateDir = join(configRoot, "LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Herdr");
const baselinePath = join(stateDir, "freshness.json");
const snapshotPath = join(stateDir, "upstream-skill.md");
const herdrConfig = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr/config.toml");

type Status = "fresh" | "stale" | "skipped";
type Check = { status: Status; detail: string };

function herdr(...argv: string[]): string {
  return execFileSync("herdr", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** section.key for every assignment; `commented` also accepts `# key = value` lines. */
function tomlKeys(text: string, commented: boolean): Set<string> {
  const keys = new Set<string>();
  let section = "";
  let realSection = "";
  // Bare, quoted and dotted keys; the default config comments out whole sections, headers included.
  const lead = commented ? "^\\s*#?\\s*" : "^\\s*";
  const assign = new RegExp(lead + `((?:"[^"]+"|[A-Za-z0-9_-]+)(?:\\s*\\.\\s*(?:"[^"]+"|[A-Za-z0-9_-]+))*)\\s*=`);
  const header = new RegExp(lead + "\\[+([^\\]]+)\\]+\\s*(?:#.*)?$");
  for (const line of text.split("\n")) {
    const head = line.match(header);
    if (head) {
      section = head[1].trim();
      if (!/^\s*#/.test(line)) realSection = section;
      continue;
    }
    const m = line.match(assign);
    if (m) {
      const key = m[1].replace(/"/g, "").replace(/\s*\.\s*/g, ".");
      keys.add(section ? `${section}.${key}` : key);
      // A commented key that follows a commented header may still belong to the enclosing
      // real section (the default config lists ui.accent after "# [ui.sidebar.spaces]").
      if (commented && realSection !== section) keys.add(realSection ? `${realSection}.${key}` : key);
    }
  }
  return keys;
}

async function checkVersion(installed: string): Promise<Check> {
  if (offline) return { status: "skipped", detail: `installed ${installed}; --offline` };
  const res = await fetch(LLMS_INDEX, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { status: "skipped", detail: `installed ${installed}; ${LLMS_INDEX} returned ${res.status}` };
  const stable = (await res.text()).match(/Current stable release:\s*([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
  if (!stable) return { status: "skipped", detail: `installed ${installed}; no stable version in the index` };
  return installed === stable
    ? { status: "fresh", detail: `${installed} is the stable release` }
    : { status: "stale", detail: `installed ${installed}, stable is ${stable}` };
}

function checkServer(): Check {
  const out = herdr("status");
  const problems = [
    /restart_needed:\s*yes/.test(out) && "server restart needed",
    /server_binary_stale:\s*yes/.test(out) && "server is running an older binary",
    /endpoint_compatible:\s*no/.test(out) && "client and server endpoints are incompatible",
  ].filter(Boolean);
  if (problems.length) return { status: "stale", detail: problems.join("; ") };
  const running = /server:\s*\n\s*status:\s*running/.test(out);
  return { status: "fresh", detail: running ? "server running, matches client" : "no server running" };
}

function checkIntegrations(): Check {
  const lines = herdr("integration", "status").split("\n").filter((l) => l.includes(":"));
  const installed = lines.filter((l) => !/:\s*not installed/.test(l));
  const behind = installed.filter((l) => !/:\s*current\b/.test(l)).map((l) => l.split(" (/")[0].trim());
  return behind.length
    ? { status: "stale", detail: `not current: ${behind.join(", ")}` }
    : { status: "fresh", detail: `${installed.length} installed, all current` };
}

/** Exact key list for the installed version, from the config reference the docs index links. */
async function referenceKeys(installed: string): Promise<Set<string> | null> {
  if (offline) return null;
  try {
    const index = await (await fetch(LLMS_INDEX, { signal: AbortSignal.timeout(15000) })).text();
    const url = index.match(/\((https:\/\/[^)\s]+config-reference\.json)\)/)?.[1];
    if (!url) return null;
    const res = await fetch(url.replace(/\/v[0-9]+\.[0-9]+\.[0-9]+\//, `/v${installed}/`), { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const ref = (await res.json()) as { sections: { keys: { key: string; type?: string }[] }[] };
    const all = ref.sections.flatMap((s) => s.keys);
    const keys = new Set(all.map((k) => k.key));
    // A table-typed key takes names the user chooses (`rows_by_agent.codex`), so its children
    // are never listed; mark it so its subkeys count as known.
    for (const k of all) if (k.type?.startsWith("table")) keys.add(`${k.key}.*`);
    return keys.size ? keys : null;
  } catch {
    return null;
  }
}

async function checkConfigKeys(installed: string): Promise<Check> {
  if (!existsSync(herdrConfig)) return { status: "skipped", detail: "no config.toml" };
  const ours = tomlKeys(readFileSync(herdrConfig, "utf8"), false);
  const reference = await referenceKeys(installed);
  // Offline, the default config is the authority, and it lists only example colour tokens.
  const known = reference ?? tomlKeys(herdr("--default-config"), true);
  const open = (k: string) => !reference && k.startsWith("theme.custom.");
  const isKnown = (k: string) => known.has(k) || [...known].some((r) => r.endsWith(".*") && k.startsWith(r.slice(0, -1)));
  const unknown = [...ours].filter((k) => !isKnown(k) && !open(k));
  const unverified = [...ours].filter((k) => !isKnown(k) && open(k)).length;
  const source = reference ? `the v${installed} config reference` : "the default config";
  if (unknown.length) return { status: "stale", detail: `not in ${source}: ${unknown.join(", ")}` };
  return { status: "fresh", detail: `${ours.size} keys checked against ${source}${unverified ? `; ${unverified} colour tokens unverifiable offline` : ""}` };
}

function checkSkillHash(skillText: string, installed: string): Check {
  const hash = createHash("sha256").update(skillText).digest("hex");
  if (accept) {
    invariant(/^[0-9a-f]{64}$/.test(hash), "skill hash must be a sha256 hex digest");
    invariant(skillText.includes("name: herdr"), "refusing to baseline output that is not herdr's skill file");
    invariant(dirname(baselinePath) === stateDir, "baseline must land in the skill's customization dir");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(snapshotPath, skillText);
    writeFileSync(baselinePath, JSON.stringify({ skill_sha256: hash, herdr_version: installed, accepted: new Date().toISOString() }, null, 2) + "\n");
    return { status: "fresh", detail: `baseline accepted at ${installed}` };
  }
  if (!existsSync(baselinePath)) return { status: "stale", detail: "no baseline yet; read `herdr --skill`, then run --accept" };
  const base = JSON.parse(readFileSync(baselinePath, "utf8")) as { skill_sha256: string; herdr_version: string };
  return base.skill_sha256 === hash
    ? { status: "fresh", detail: `unchanged since ${base.herdr_version}` }
    : { status: "stale", detail: `changed since ${base.herdr_version}; diff \`herdr --skill\` against ${snapshotPath}, then --accept` };
}

async function main(): Promise<number> {
  let installed: string;
  let skillText: string;
  try {
    installed = herdr("--version").trim().replace(/^herdr\s+/, "");
    skillText = herdr("--skill");
  } catch (err) {
    console.error(`herdr is not runnable: ${(err as Error).message}`);
    return 2;
  }

  let checks: Record<string, Check>;
  try {
    checks = {
      version: await checkVersion(installed).catch((e) => ({ status: "skipped" as Status, detail: `network: ${(e as Error).message}` })),
      server: checkServer(),
      integrations: checkIntegrations(),
      config_keys: await checkConfigKeys(installed),
      skill_hash: checkSkillHash(skillText, installed),
    };
  } catch (err) {
    if (err instanceof InvariantViolation) throw err;
    // A check that could not run is an error, never a stale verdict.
    console.error(`a check could not run: ${(err as Error).message}`);
    return 2;
  }
  const stale = Object.values(checks).some((c) => c.status === "stale");

  if (asJson) {
    console.log(JSON.stringify({ fresh: !stale, installed, checks }, null, 2));
  } else {
    const mark: Record<Status, string> = { fresh: "ok   ", stale: "STALE", skipped: "skip " };
    for (const [name, c] of Object.entries(checks)) console.log(`${mark[c.status]}  ${name.padEnd(13)} ${c.detail}`);
  }
  return stale ? 1 : 0;
}

process.exit(await main());
