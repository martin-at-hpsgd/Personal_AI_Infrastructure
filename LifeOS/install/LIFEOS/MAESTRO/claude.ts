#!/usr/bin/env bun
/**
 * Maestro front door — the `claude` Maestro launches.
 *
 * Maestro execs the claude binary directly, so the `k` launcher never runs and
 * a Maestro agent would come up without the LifeOS system prompt and with
 * permissions skipped. Set this file as Maestro's Claude Code custom path
 * (Settings → Providers → Claude Code) and every spawn mirrors lifeos.ts:
 *
 *   - LIFEOS_SYSTEM_PROMPT.md is attached. Maestro's own inline
 *     --append-system-prompt text is folded in AFTER ours, in one temp file,
 *     so claude only ever sees a single system-prompt flag.
 *   - --dangerously-skip-permissions is dropped. Permissions come from
 *     settings.json; use Maestro's "standard" tab mode for relayed approvals.
 *   - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed (subscription billing).
 *   - Background tasks stay on (Maestro defaults them off; Worker.ts needs them).
 *
 * MAESTRO_WRAPPER_DRYRUN=1 prints the final argv as JSON and exits.
 */
import { spawn } from "bun";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const HOME = homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, ".claude");
const SYSTEM_PROMPT = join(CLAUDE_DIR, "LIFEOS", "LIFEOS_SYSTEM_PROMPT.md");
const REAL_CLAUDE = process.env.MAESTRO_REAL_CLAUDE ?? join(HOME, ".local", "bin", "claude");
const DROPPED = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]);

export function rewriteArgs(argv: string[]): { args: string[]; maestroPrompt: string[] } {
  const args: string[] = [];
  const maestroPrompt: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break; // everything after is the prompt, verbatim
    if (DROPPED.has(a)) continue;
    if (a === "--append-system-prompt") {
      if (i + 1 < argv.length) maestroPrompt.push(argv[++i]);
      continue;
    }
    if (a.startsWith("--append-system-prompt=")) {
      maestroPrompt.push(a.slice("--append-system-prompt=".length));
      continue;
    }
    if (a === "--append-system-prompt-file") {
      const f = argv[++i];
      if (f && existsSync(f)) maestroPrompt.push(readFileSync(f, "utf8"));
      continue;
    }
    args.push(a);
  }
  return { args: [...args, ...argv.slice(i)], maestroPrompt };
}

/** Passthrough argv with only the permission-skipping flags removed, so a subcommand or a positional prompt cannot carry them. */
export function dropPermissionSkips(argv: string[]): string[] {
  const end = argv.indexOf("--");
  const head = end === -1 ? argv : argv.slice(0, end);
  return [...head.filter((a) => !DROPPED.has(a)), ...(end === -1 ? [] : argv.slice(end))];
}

async function main() {
  const argv = process.argv.slice(2);
  // Subcommands (mcp, config, doctor, --version probes) pass straight through.
  const passthrough = argv.length === 0 || !argv[0].startsWith("-") || argv.includes("--version") || argv.includes("--help");
  // The permission-skipping flags are dropped on this path too.
  const { args, maestroPrompt } = passthrough ? { args: dropPermissionSkips(argv), maestroPrompt: [] } : rewriteArgs(argv);

  let tmp: string | undefined;
  const finalArgs = [...args];
  if (!passthrough && existsSync(SYSTEM_PROMPT)) {
    let promptFile = SYSTEM_PROMPT;
    if (maestroPrompt.length) {
      tmp = mkdtempSync(join(tmpdir(), "maestro-lifeos-"));
      promptFile = join(tmp, "system-prompt.md");
      const merged = [readFileSync(SYSTEM_PROMPT, "utf8"), "# Maestro host context\n\nThe LifeOS rules above win on any conflict.", ...maestroPrompt].join("\n\n");
      writeFileSync(promptFile, merged, { mode: 0o600 });
    }
    finalArgs.unshift("--append-system-prompt-file", promptFile);
  } else if (maestroPrompt.length) {
    for (const p of maestroPrompt) finalArgs.unshift("--append-system-prompt", p);
  }

  if (process.env.MAESTRO_WRAPPER_DRYRUN === "1") {
    console.log(JSON.stringify({ cmd: REAL_CLAUDE, args: finalArgs.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)) }));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
  env.CLAUDE_CODE_WORKFLOWS = "1";

  const proc = spawn([REAL_CLAUDE, ...finalArgs], { stdio: ["inherit", "inherit", "inherit"], env });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => proc.kill(sig));
  const code = await proc.exited;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}

if (import.meta.main) await main();
