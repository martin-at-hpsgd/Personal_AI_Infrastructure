/**
 * ProbeCommand — where a probe command that names a LifeOS tool finds it (20261010-evals-in-the-isa ISC-59).
 *
 * A compiled eval names LifeOS tools by their path under the config root, never by an absolute or home path (ISC-42):
 * `bun skills/Assay/Tools/Tournament.ts ...`, `bash skills/Interceptor/Tools/Capture.sh ...`. A project ISA's probes
 * run from the ISA's own folder, where `skills/...` does not exist, so the command would fail to start. Bunker resolves
 * such a script against the config root at run time, the way it already expands `suite:<name>` to the absolute
 * EvalRunner path, and Compile refuses a command naming a LifeOS script Bunker would not find.
 *
 * The rule, one place for both:
 *   - a script is RESOLVABLE where a command starts it: at the start of the command or after `&&`, `||`, `;`, `|`
 *     or `(`, outside quotes, as `[VAR=value ...] bun|bash|sh [-flag|--flag[=value] ...] [run] [./]<skills|LIFEOS>/<path>`
 *     (`run` with bun only), and only while no earlier part of the command changes directory (`cd`, `pushd`);
 *   - a resolvable script that exists from the probe directory is left alone (a project with its own `skills/` keeps it);
 *   - otherwise, when it exists under the config root, it is rewritten to that absolute path, quoted when the root
 *     holds a character the shell would split on;
 *   - any other mention of a LifeOS script path (an argument, inside quotes, after a `cd`, after a flag that takes a
 *     separate value, `bun test <path>`) is never rewritten: when it is a LifeOS tool (it exists under the config root)
 *     the probe directory lacks, unresolvedScripts names it and Compile refuses it; a path that exists nowhere is a file
 *     the project has not written yet, read like any other path in a code check;
 *   - anything else is returned unchanged, so a wrong command still fails the way it always did.
 * Read-only.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const SCRIPT_PATH = String.raw`(?:skills|LIFEOS)\/[^\s"'\`;|&<>()$]+`;
/** A command start, then the interpreter call of a LifeOS path. Groups: 1 start, 2 env prefix, 3 interpreter, 4 flags, 5 `run`, 6 the path. */
const STARTED = new RegExp(
  String.raw`(^|&&|\|\||[;|(])(\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>()]*\s+)*)(bun|bash|sh)((?:\s+-{1,2}[A-Za-z][\w-]*(?:=[^\s;&|<>()]+)?)*)\s+(?:(run)\s+)?(?:\.\/)?(${SCRIPT_PATH})`,
  "g",
);
/** Any LifeOS script path written in a command, whatever its position. Group 1 is the path. */
const ANY_SCRIPT = new RegExp(String.raw`(?<![\w/.~-])(?:\.\/)?(${SCRIPT_PATH}\.(?:ts|tsx|js|mjs|cjs|sh))(?![\w/.-])`, "g");
const CHANGES_DIR = /(?:^|&&|\|\||[;|(])\s*(?:cd|pushd)\b/;
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./~-]+$/;

/** The command with every quoted region blanked to the same length, so a `;` or a path inside quotes is never read as shell. */
function maskQuotes(cmd: string): string {
  return cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => q[0] + " ".repeat(q.length - 2) + q[q.length - 1]);
}

/** A LifeOS script a command starts where Bunker can resolve it: the path as written and where it sits in the command. */
interface Started { rel: string; start: number; end: number }

/** Every LifeOS script the command starts in a resolvable position (rule above), in order. */
export function startedScripts(tool: string): Started[] {
  const masked = maskQuotes(tool);
  const out: Started[] = [];
  for (const m of masked.matchAll(STARTED)) {
    if (m[5] && m[3] !== "bun") continue;
    const at = m.index!;
    if (CHANGES_DIR.test(masked.slice(0, at + m[1]!.length))) continue;
    // The path as written, with any `./` before it, is what gets replaced; the match ends with it.
    const end = at + m[0].length;
    const dotted = tool.slice(end - m[6]!.length - 2, end - m[6]!.length) === "./";
    out.push({ rel: m[6]!, start: end - m[6]!.length - (dotted ? 2 : 0), end });
  }
  return out;
}

/** The first LifeOS script a command starts in a resolvable position, as written under the config root, or null. */
export function leadingLifeosScript(tool: string): string | null {
  return startedScripts(tool)[0]?.rel ?? null;
}

/**
 * The command with every resolvable LifeOS script made absolute against the config root, when the script does not
 * exist from `cwd` but does under `configRoot`. Unchanged in every other case.
 */
export function resolveLifeosTool(tool: string, cwd: string, configRoot: string): string {
  let out = tool;
  for (const s of startedScripts(tool).reverse()) {
    if (existsSync(resolve(cwd, s.rel))) continue;
    const abs = join(resolve(configRoot), s.rel);
    if (!existsSync(abs)) continue;
    const word = SHELL_SAFE.test(abs) ? abs : `'${abs.replace(/'/g, `'\\''`)}'`;
    out = `${out.slice(0, s.start)}${word}${out.slice(s.end)}`;
  }
  return out;
}

/** A LifeOS script a command names that will not be found when Bunker runs it, and why. */
export interface UnresolvedScript { rel: string; why: "nowhere" | "position" }

/**
 * The LifeOS scripts a command names that would not be found at run time: a resolvable one that exists neither from
 * `cwd` nor under the config root ("nowhere"), and a LifeOS tool (under the config root) in any other position that
 * does not exist from `cwd`, since Bunker never rewrites it ("position").
 */
export function unresolvedScripts(tool: string, cwd: string, configRoot: string): UnresolvedScript[] {
  const out: UnresolvedScript[] = [];
  const started = startedScripts(tool);
  for (const s of started) {
    if (!existsSync(resolve(cwd, s.rel)) && !existsSync(join(resolve(configRoot), s.rel))) out.push({ rel: s.rel, why: "nowhere" });
  }
  const at = new Set(started.map((s) => s.end));
  for (const m of tool.matchAll(ANY_SCRIPT)) {
    if (at.has(m.index! + m[0].length)) continue;
    const rel = m[1]!;
    if (!existsSync(resolve(cwd, rel)) && existsSync(join(resolve(configRoot), rel)) && !out.some((u) => u.rel === rel)) out.push({ rel, why: "position" });
  }
  return out;
}

/** Whether every LifeOS script a command names will be found at run time (unresolvedScripts is empty). */
export function leadingScriptResolves(tool: string, cwd: string, configRoot: string): boolean {
  return unresolvedScripts(tool, cwd, configRoot).length === 0;
}
