/**
 * launchd-path adapter — answers "does every background job's PATH reach the
 * binaries its script spawns?" One instance per com.lifeos.* LaunchAgent.
 *
 * Why: under launchd the PATH is the plist's, never the shell's. A `go install`ed
 * fabric in ~/go/bin resolved fine at a terminal and was `exit 127` for every new
 * video inside com.lifeos.contentsync, which failed the nightly for two days
 * before anyone read the log (ACH-0100, 2026-09-15). The services adapter only
 * sees the exit code; this one sees the cause before the job runs.
 *
 * Method (deterministic, static): read each plist's ProgramArguments and
 * EnvironmentVariables.PATH (launchd's default when absent), take the entry
 * script, scan it plus its relative imports one level deep for command names
 * handed to spawn-shaped calls, and resolve each name on that PATH. Shell
 * builtins and absolute paths are skipped. Names the scan cannot see (a
 * command built from a variable) stay untouched and are named as such.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Adapter } from "./types";
import type { AnswerInput } from "../Store";
import type { Question } from "../Registry";

const VERSION = "launchd-path/1.0.0";
/** launchd's PATH when a plist sets none (launchd.plist(5)). */
export const LAUNCHD_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const BUILTINS = new Set(["cd", "echo", "test", "true", "false", "exit", "export", "source", "set", "read", "printf", "eval", "exec", "trap", "wait", "kill", "command", "type", "sleep"]);
/** Call shapes whose first string argument is a command name. */
const CALL = /\b(?:Bun\.spawn|Bun\.spawnSync|spawn|spawnSync|execFile|execFileSync|exec|execSync|run|runCommand)\(\s*\[?\s*(["'`])([A-Za-z][\w.+-]*)\1/g;
/** Bun shell tag: $`cmd …` */
const SHELL_TAG = /\$`\s*([A-Za-z][\w.+-]*)/g;

export interface JobSpec { label: string; program: string[]; path: string }

/** Command names a script (and its ./ imports, one level) hands to spawn-shaped calls. */
export function commandsIn(file: string, depth = 1, seen = new Set<string>()): string[] {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const src = readFileSync(file, "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(CALL)) names.add(m[2]);
  for (const m of src.matchAll(SHELL_TAG)) names.add(m[1]);
  if (depth > 0) {
    for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const base = resolve(dirname(file), m[1]);
      for (const cand of [base, base + ".ts", base + ".js", join(base, "index.ts")]) if (existsSync(cand)) { for (const n of commandsIn(cand, depth - 1, seen)) names.add(n); break; }
    }
  }
  return [...names].filter((n) => !n.includes("/") && !BUILTINS.has(n)).sort();
}

/** Every directory a command could live in on this machine: the current PATH plus
 *  the usual user-local homes. This is the "works at the terminal" side of the
 *  comparison; the plist PATH is the "fails under launchd" side. */
export function fullPath(): string {
  const h = homedir();
  return [process.env.PATH ?? "", join(h, "go/bin"), join(h, ".local/bin"), join(h, ".bun/bin"), join(h, ".cargo/bin"), "/opt/homebrew/bin", "/usr/local/bin", LAUNCHD_DEFAULT_PATH].filter(Boolean).join(":");
}

/** Names that ARE commands on this machine but do not resolve on `path`. A name
 *  that resolves nowhere is a scan artefact (a wrapper's first argument, a word in
 *  a string) and is returned separately, never as a failure. */
export function unresolved(names: string[], path: string, everywhere = fullPath()): { missing: string[]; unknownNames: string[] } {
  const missing: string[] = [], unknownNames: string[] = [];
  for (const n of names) {
    if (Bun.which(n, { PATH: path })) continue;
    if (Bun.which(n, { PATH: everywhere })) missing.push(n); else unknownNames.push(n);
  }
  return { missing, unknownNames };
}

/** The entry script a plist runs: the first argument that is a readable file (not the interpreter). */
export function entryScript(program: string[]): string | null {
  for (const a of program.slice(1)) if (/\.(ts|js|mjs|sh|bash)$/.test(a) && existsSync(a)) return a;
  return null;
}

export function readJobs(dir = join(homedir(), "Library/LaunchAgents")): JobSpec[] {
  if (!existsSync(dir)) return [];
  const out: JobSpec[] = [];
  for (const f of readdirSync(dir).filter((f) => f.startsWith("com.lifeos.") && f.endsWith(".plist")).sort()) {
    const p = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", join(dir, f)], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) continue;
    let j: any;
    try { j = JSON.parse(p.stdout.toString()); } catch { continue; }
    const program: string[] = Array.isArray(j.ProgramArguments) ? j.ProgramArguments : j.Program ? [j.Program] : [];
    out.push({ label: String(j.Label ?? f.replace(/\.plist$/, "")), program, path: String(j.EnvironmentVariables?.PATH ?? LAUNCHD_DEFAULT_PATH) });
  }
  return out;
}

export function judge(job: JobSpec): { verdict: "pass" | "fail" | "unknown"; value: string; evidence: string; untouched: string[] } {
  const untouched = ["commands built from variables (invisible to a static scan)", "imports deeper than one level"];
  if (!job.program.length) return { verdict: "unknown", value: "no program", evidence: "plist has no ProgramArguments", untouched };
  const missing: string[] = [];
  if (job.program[0] && !job.program[0].includes("/") && !Bun.which(job.program[0], { PATH: job.path })) missing.push(job.program[0]);
  if (job.program[0]?.includes("/") && !existsSync(job.program[0])) missing.push(job.program[0]);
  const script = entryScript(job.program);
  const names = script ? commandsIn(script) : [];
  const r = unresolved(names, job.path);
  missing.push(...r.missing);
  if (r.unknownNames.length) untouched.push(`names the scan saw that are not commands on this machine (wrapper arguments or words): ${r.unknownNames.join(", ")}`);
  if (missing.length) return { verdict: "fail", value: `missing ${missing.join(", ")}`, evidence: `PATH=${job.path} cannot resolve: ${missing.join(", ")} (present on the login PATH${script ? `; spawned by ${script}` : ""})`, untouched };
  return { verdict: "pass", value: "ok", evidence: script ? `${names.length - r.unknownNames.length} spawned command(s) resolve on the plist PATH: ${names.filter((n) => !r.unknownNames.includes(n)).join(", ") || "none"}` : "no script to scan; program resolves", untouched };
}

export const launchdPath: Adapter = {
  name: "launchd-path",
  version: VERSION,
  async answers(questions: Question[]): Promise<AnswerInput[]> {
    const jobs = readJobs();
    const out: AnswerInput[] = [];
    for (const q of questions) {
      if (!jobs.length) { out.push({ question_id: q.id, verdict: "unknown", evidence: "no com.lifeos.* LaunchAgents on disk", computed_from: { touched: [], untouched: ["~/Library/LaunchAgents"] }, closer_version: VERSION }); continue; }
      for (const job of jobs) {
        const r = judge(job);
        out.push({ question_id: q.id, instance_key: job.label, verdict: r.verdict, value: r.value, evidence: r.evidence, computed_from: { touched: [`${job.label}.plist ProgramArguments + PATH`, "static scan of the entry script and its ./ imports"], untouched: r.untouched }, closer_version: VERSION });
      }
    }
    return out;
  },
};
