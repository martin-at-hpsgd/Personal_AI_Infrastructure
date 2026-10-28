import { isAbsolute, resolve } from "node:path";
import { realPathOf } from "./shell-paths";
import { shellSteps } from "./shell-commands";
import type { TxEvent } from "./transcript-evidence";

const ISA_PATH_RE = /(?:^|\/)(?:ISA\.md|bunker\.isa\.md)$/i;

export const ISA_ADDRESSED_RE =
  /\bISA(?:'s|s)?\s+(?:is\s+|was\s+|are\s+)?(?:already\s+)?(?:current|up[\s-]?to[\s-]?date|updated|unchanged|fresh|complete|closed|\d+\s*\/\s*\d+)\b|\bno\s+ISA\s+(?:update|delta|change)s?\s+(?:needed|required)\b|\bupdated?\s+the\s+ISA\b|\bISA\s+doesn'?t\s+need\b/i;

/** Physical path (every existing component through realpath, `..` applied after), the shared resolver. */
const physical = (p: string): string => realPathOf(isAbsolute(p) ? p : resolve(p)).real;

/**
 * The one shell form still read as a write (S044 parity with HEAD, closing pass): a whole command that
 * is exactly `sed -i… <script> <file>`, with nothing the shell would expand or chain. Every character
 * must be a plain word character, a path character or a single quote, so there is no separator,
 * background `&`, comment, redirect, variable, `~`, glob, substitution or escape for the text to hide
 * behind (fail closed). The shared parser then supplies the words. Returns the file word, or null.
 */
const PLAIN_LINE = /^[A-Za-z0-9 _./,:=+@%^'-]+$/;
function sedInPlaceFile(command: string): string | null {
  if (!PLAIN_LINE.test(command)) return null;
  const walk = shellSteps(command);
  if (walk.tooDeep || walk.steps.length !== 1) return null;
  const step = walk.steps[0]!;
  if (step.depth !== 0 || step.wrappers.length || Object.keys(step.env).length || step.writeTargets.length) return null;
  const argv = step.argv;
  if (argv[0] !== "sed" || argv.length < 4 || !/^-i(?:$|[^\w])/.test(argv[1]!)) return null;
  const file = argv[argv.length - 1]!;
  return file.startsWith("-") ? null : file;
}

/** Does a sed file word name the active ISA? Absolute: same physical file. Relative: a whole-segment tail of it, directory included. */
function namesActive(file: string, activeIsa: string, target: string): boolean {
  if (!ISA_PATH_RE.test(file)) return false;
  if (isAbsolute(file)) return physical(file) === target;
  const segs = file.split("/");
  if (segs.length < 2 || segs.some((s) => s === "" || s === "." || s === "..")) return false;
  return target.endsWith(`/${file}`) || resolve(activeIsa).endsWith(`/${file}`);
}

/**
 * Did this turn successfully write an ISA? With `activeIsa` (an absolute path),
 * only a write to THAT ISA counts: an edit the harness rejected, or an edit to
 * some other ISA, does not fold the active run's state (hooks audit shard ad #7).
 * Paths compare physically, so the ~/.claude/LIFEOS/MEMORY symlink spelling and
 * the real USER-tree spelling of one ISA are the same file.
 *
 * The evidence is a file-edit tool's own answered, non-error result (Edit, Write,
 * NotebookEdit, and the MultiEdit events the caller adds). Bash command text is
 * not evidence (LOSIntegrity S044, 2026-10-15): a write can sit after `exit`,
 * behind a dry-run or no-clobber flag, inside an `xargs` that gets no input, in a
 * background job, after a reassigned HOME, or behind a redirect that failed while
 * the call still exited 0. The one exception keeps HEAD's existing contract
 * (hooks/tests/isa-fold-gate.test.ts): an answered, non-error Bash call that is,
 * in full, a plain `sed -i` on the active ISA (sedInPlaceFile above). sed exits
 * non-zero when it cannot rewrite its file, so the result is real evidence there.
 */
export function isaEditedThisTurn(ev: TxEvent[], activeIsa?: string): boolean {
  const target = activeIsa ? physical(activeIsa) : null;
  return ev.some((e) => {
    if (e.isToolError || e.hasResult === false) return false;
    if (e.kind === "command") {
      if (!activeIsa || target === null || typeof e.command !== "string") return false;
      const file = sedInPlaceFile(e.command);
      return file !== null && namesActive(file, activeIsa, target);
    }
    if (e.kind !== "edit") return false;
    if (!ISA_PATH_RE.test(e.target)) return false;
    return target === null || physical(e.target) === target;
  });
}
