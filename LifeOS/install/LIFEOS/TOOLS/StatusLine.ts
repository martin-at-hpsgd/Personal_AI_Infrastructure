#!/usr/bin/env bun
/**
 * StatusLine.ts — switch the bash statusline off or back on.
 *
 * The statusline is the one always-visible status display; off removes it and
 * nothing replaces it, and on brings it back with one command.
 *
 * settings.json is generated (MergeSettings.ts: settings.system.json ⊕ the user
 * overlay, at every SessionStart), so the switch lives in the overlay, never in
 * the output: off sets `statusLine: { "__merge": "remove" }` there and keeps the
 * overlay's own block; on puts that block back (or the stock one). Either way it
 * then regenerates settings.json with the same merge SessionStart runs. While a
 * `statusLine` is set the engine hides the prompt's hint row, so off also brings
 * back the `ctx · 5H · WK` tail the plugin draws there.
 *
 *   bun StatusLine.ts off | on | status
 *
 * A running session reads settings at start: the change shows in new sessions.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { defaultClaudeDir, getClaudeDir, getLifeosDir } from "./Paths";
import { invariant } from "./Invariant";
import { isRemoveAnnotation } from "./MergeSettings";

export const STOCK = { type: "command", command: "$HOME/.claude/LIFEOS/LIFEOS_StatusLine.sh", refreshInterval: 5 } as const;
/**
 * The stock block for the install at `lifeosDir` (default: the live one). A default install keeps the portable
 * `$HOME/.claude/LIFEOS` form (STOCK); an install configured at another root gets that root's script,
 * single-quoted so a path with spaces or metacharacters reaches the shell as one word.
 */
export function stockBlock(lifeosDir: string = getLifeosDir(), home: string = process.env.HOME ?? ""): { type: string; command: string; refreshInterval: number } {
  if (home && lifeosDir === join(defaultClaudeDir(home), "LIFEOS")) return STOCK;
  const script = join(lifeosDir, "LIFEOS_StatusLine.sh");
  return { type: "command", command: `'${script.split("'").join(`'\\''`)}'`, refreshInterval: STOCK.refreshInterval };
}
export const REMOVE = { __merge: "remove" } as const;

export interface Paths { system: string; user: string; output: string; kept: string }

export function defaultPaths(): Paths {
  const root = getClaudeDir();
  return {
    system: join(root, "settings.system.json"),
    user: join(getLifeosDir(), "USER", "CONFIG", "settings.user.json"),
    output: join(root, "settings.json"),
    kept: join(getLifeosDir(), "MEMORY", "STATE", "statusline-kept.json"),
  };
}

type Obj = Record<string, unknown>;

function readObj(p: string): Obj {
  const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
  invariant(raw && typeof raw === "object" && !Array.isArray(raw), `${p} is not a JSON object`);
  return raw as Obj;
}

/** Write through a temp file so a crash never leaves the overlay half written. */
function writeObj(p: string, o: Obj, keysBefore: number, delta: number): void {
  invariant(Object.keys(o).length === keysBefore + delta, `the overlay must change by exactly ${delta} key(s)`);
  const tmp = `${p}.statusline-tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n");
  JSON.parse(readFileSync(tmp, "utf8"));
  renameSync(tmp, p);
}

/** The same merge SessionStart runs (settings.system.json hook), so the output and its snapshot agree. */
export function regenerate(paths: Paths): void {
  const r = spawnSync("bun", [join(getLifeosDir(), "TOOLS", "MergeSettings.ts"), "--system", paths.system, "--user", paths.user, "--output", paths.output], { encoding: "utf8", timeout: 30_000 });
  invariant(r.status === 0, `MergeSettings failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
}

export function status(paths = defaultPaths()): "on" | "off" {
  return readObj(paths.output).statusLine ? "on" : "off";
}

export function off(paths = defaultPaths(), regen: (p: Paths) => void = regenerate): string {
  const u = readObj(paths.user);
  if (isRemoveAnnotation(u.statusLine)) { regen(paths); return "already off"; }
  const keys = Object.keys(u).length;
  mkdirSync(dirname(paths.kept), { recursive: true });
  if (u.statusLine) writeFileSync(paths.kept, JSON.stringify(u.statusLine, null, 2) + "\n");
  const had = "statusLine" in u;
  u.statusLine = { ...REMOVE };
  writeObj(paths.user, u, keys, had ? 0 : 1);
  regen(paths);
  invariant(status(paths) === "off", "settings.json still carries a statusLine after the merge");
  return "off: new sessions draw no statusline (the old block is kept)";
}

export function on(paths = defaultPaths(), regen: (p: Paths) => void = regenerate, stock: unknown = stockBlock()): string {
  const u = readObj(paths.user);
  if (u.statusLine && !isRemoveAnnotation(u.statusLine)) { regen(paths); return "already on"; }
  let block: unknown = stock;
  if (existsSync(paths.kept)) {
    try { block = JSON.parse(readFileSync(paths.kept, "utf8")); } catch { block = stock; }
  }
  invariant(block && typeof block === "object" && typeof (block as { command?: unknown }).command === "string", "the statusLine block to restore has no command");
  const keys = Object.keys(u).length;
  const had = "statusLine" in u;
  u.statusLine = block;
  writeObj(paths.user, u, keys, had ? 0 : 1);
  regen(paths);
  invariant(status(paths) === "on", "settings.json has no statusLine after the merge");
  return "on: new sessions draw the bash statusline again";
}

if (import.meta.main) {
  const verb = process.argv[2] ?? "status";
  if (verb === "off") console.log(off());
  else if (verb === "on") console.log(on());
  else if (verb === "status") console.log(status());
  else { console.error("usage: bun StatusLine.ts off | on | status"); process.exit(2); }
}
