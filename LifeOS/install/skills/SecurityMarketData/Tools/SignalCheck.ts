#!/usr/bin/env bun
/**
 * SignalCheck — deterministic checks for the SecurityMarketData skill.
 *
 *   setup  Is `signal-mcp` configured for Claude Code or Codex, or does the REST
 *          fallback key exist? Configuration only: OAuth state is not visible here.
 *   shape  Does a delivered answer carry the six Output format parts?
 *
 * Exit codes: 0 pass, 1 check failed, 2 usage error. Output is one JSON line.
 * Read-only; never prints a secret value.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVER = "signal-mcp";
export const PARTS = ["Scope", "Observed", "Analytical", "Freshness", "Caveats", "Tools"] as const;

type McpMap = Record<string, unknown> | undefined;

/** True when ~/.claude.json declares signal-mcp at user scope or in any project. */
export function claudeHasServer(json: string): boolean {
  let data: { mcpServers?: McpMap; projects?: Record<string, { mcpServers?: McpMap }> };
  try {
    data = JSON.parse(json);
  } catch {
    return false;
  }
  if (data.mcpServers && SERVER in data.mcpServers) return true;
  return Object.values(data.projects ?? {}).some((p) => !!p?.mcpServers && SERVER in p.mcpServers);
}

/** True when a Codex config.toml has an [mcp_servers.signal-mcp] table. */
export function codexHasServer(toml: string): boolean {
  return /^\s*\[\s*mcp_servers\.(?:"signal-mcp"|signal-mcp)\s*\]/m.test(toml);
}

export interface SetupResult {
  claude: boolean;
  codex: boolean;
  rest: boolean;
  ready: boolean;
}

export function probeSetup(opts: { claudeJson: string; codexConfig: string; env: Record<string, string | undefined> }): SetupResult {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const claude = claudeHasServer(read(opts.claudeJson) || "{}");
  const codex = codexHasServer(read(opts.codexConfig));
  const rest = !!opts.env.ROS_API_KEY;
  return { claude, codex, rest, ready: claude || codex || rest };
}

/** Parts whose label is missing. A label is a heading or a line opening `Part:` (bold or list marker allowed). */
export function missingParts(answer: string): string[] {
  const labels = new Set<string>();
  for (const raw of answer.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*+]\s+)?(?:#{1,6}\s+)?/, "").replace(/\*\*|__/g, "").trim();
    for (const part of PARTS) {
      if (new RegExp(`^${part}\\s*(?::|$)`, "i").test(line)) labels.add(part);
    }
  }
  return PARTS.filter((p) => !labels.has(p));
}

function usage(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg, usage: "SignalCheck.ts setup [--claude-json <path>] [--codex-config <path>] | shape <file|->" }));
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) usage(`${name} needs a value`);
  return v;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "setup") {
    const result = probeSetup({
      claudeJson: flag(args, "--claude-json") ?? join(homedir(), ".claude.json"),
      codexConfig: flag(args, "--codex-config") ?? join(homedir(), ".codex", "config.toml"),
      env: process.env,
    });
    console.log(JSON.stringify({ ok: result.ready, ...result }));
    process.exit(result.ready ? 0 : 1);
  } else if (cmd === "shape") {
    const src = args[0];
    if (!src) usage("shape needs a file path or -");
    if (src !== "-" && !existsSync(src)) usage(`no such file: ${src}`);
    const text = src === "-" ? await Bun.stdin.text() : readFileSync(src, "utf8");
    const missing = missingParts(text);
    console.log(JSON.stringify({ ok: missing.length === 0, missing }));
    process.exit(missing.length === 0 ? 0 : 1);
  } else {
    usage(cmd ? `unknown command: ${cmd}` : "no command");
  }
}
