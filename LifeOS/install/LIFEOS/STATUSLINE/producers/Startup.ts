import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { number, object, string, type State } from "../State";
import { claudeImports, skillsDescriptionBytes } from "./ContextFiles";

export interface ContextInput {
  /** The context percentage as bash keeps it (a string: "33", or "8.3" once estimated). */
  pct: string;
  max: number;
  estimated: boolean;
}

const memo = new WeakMap<State, ContextInput>();

const bytesOf = (path: string): number => { try { return statSync(path).isFile() ? statSync(path).size : 0; } catch { return 0; } };
const countMd = (dir: string): number => { try { return readdirSync(dir).filter(f => f.endsWith(".md") && existsSync(join(dir, f))).length; } catch { return 0; } };

/** Tokens a fresh session starts with, before the first API call reports any. */
function estimateTokens(state: State): number {
  let est = 5000 + 12000; // harness system prompt + tool definitions
  let bytes = bytesOf(join(state.root, "LIFEOS_SYSTEM_PROMPT.md"));
  if (existsSync(join(state.claude, "CLAUDE.md"))) {
    bytes += bytesOf(join(state.claude, "CLAUDE.md"));
    for (const rel of claudeImports(state)) bytes += bytesOf(`${state.claude}/${rel}`);
  }
  const projects = join(state.claude, "projects");
  try { for (const project of readdirSync(projects)) bytes += bytesOf(join(projects, project, "memory", "MEMORY.md")); } catch { /* no projects */ }
  bytes += skillsDescriptionBytes(state);
  est += Math.trunc(bytes / 4);
  let agents = countMd(join(state.root, "agents"));
  try { for (const plugin of readdirSync(join(state.root, ".plugins"))) agents += countMd(join(state.root, ".plugins", plugin, "agents")); } catch { /* no plugins */ }
  est += agents * 200;
  const dir = string(object(state.input.workspace).current_dir) || string(state.input.cwd) || ".";
  let gitBytes = 0;
  try {
    const run = Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore", timeout: 1000 });
    gitBytes = run.stdout.length;
  } catch { gitBytes = 0; }
  est += Math.trunc((gitBytes * 10) / 35) + 500; // commit log, branch info
  return est + 3500 + 3000; // dynamic context hook; first message and startup reminders
}

/**
 * The context percentage and window the CONTEXT row and FILES line read. Until the harness reports tokens
 * (0% and zero input) the percentage is estimated once per session and cached (`startup-estimate-<session>.sh`).
 */
export function contextInput(state: State): ContextInput {
  const hit = memo.get(state);
  if (hit) return hit;
  const window = object(state.input.context_window);
  const rawPct = window.used_percentage;
  const max = number(window.context_window_size, 200000);
  const result: ContextInput = { pct: rawPct === undefined || rawPct === null || rawPct === false ? "0" : String(rawPct), max, estimated: false };
  if (result.pct === "0" && number(window.total_input_tokens) === 0) {
    const name = `startup-estimate-${state.session}.sh`;
    const cached = /^context_pct=([0-9.]+)$/m.exec(state.cache.text(name) ?? "");
    if (cached) result.pct = cached[1];
    else {
      const estimate = estimateTokens(state);
      const x10 = Math.trunc((estimate * 1000) / max);
      result.pct = `${Math.trunc(x10 / 10)}.${x10 % 10}`;
      state.cache.put(name, `_est=${estimate}\ncontext_pct=${result.pct}\nstartup_tokens=${estimate}\n`);
    }
    result.estimated = true;
  }
  memo.set(state, result);
  return result;
}
