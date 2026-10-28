#!/usr/bin/env bun
/**
 * @version 1.3.17
 * LifeosUpgrade.ts — idempotent migration runner + diagnostic harness for LifeOS rebuild.
 *
 * Each migration knows how to detect its own applied state and is safe to re-run.
 * `--diagnose` audits without changes. `--dry-run` prints the apply plan.
 *
 * Every registered migration is currently DETECT-ONLY (public issue #1549):
 * detection is automated, remediation is manual by design (several paths need
 * interactive auth or hand-migration). The default mode therefore reports
 * not-yet-applied migrations with their remediation instructions and exits
 * without modifying anything — it does not throw a false "partial state"
 * signal.
 *
 * Usage:
 *   bun ~/.claude/LIFEOS/TOOLS/LifeosUpgrade.ts [--diagnose | --dry-run | --from-fresh-install] [--target=<version>]
 *
 * Exit codes:
 *   0  all migrations applied or already-applied (no-op)
 *   1  an auto-applicable migration failed mid-write; partial state — see error output
 *   2  usage error
 *   3  action required: detect-only migrations are pending; NOTHING was modified
 */

import { existsSync, readFileSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { shellSteps } from "../../hooks/lib/shell-commands";

const HOME = process.env.HOME ?? homedir();
const CLAUDE_ROOT = getClaudeDir();

/**
 * The script a hook command actually executes, or null when the command is not a plain invocation:
 * `<script>` (shebang) or `bun [run] [flags] <script>`, with `$VAR`/`${VAR}` path variables and quotes.
 * Shell control syntax makes the command opaque (null), so an `echo` naming a hook file, or a chain that
 * only mentions it, is never read as running it.
 *
 * Only flags that still run the script are accepted (BUN_RUN_FLAGS). Any other flag can change what bun does
 * with the next word (`--help`, `-h`, `--version`, `-e`, `--print`, `--revision` never execute it), so such a
 * command is opaque and returns null rather than attesting a hook that never runs (S091, S092). This is the one
 * hook-command parser: MemoryHealthCheck imports it.
 *
 * Words come from the shared shell parser (hooks/lib/shell-commands.ts), so quotes group exactly as the shell
 * groups them: `bun "hooks/X.hook.ts --help"` passes bun ONE word with a space in it, which names no hook file.
 * Splitting on whitespace before stripping quotes read that as the hook path (S091/S092 review). The command must
 * be one plain step: no env prefix, wrapper, redirect or nested command; the control-character screen below is
 * the plain-invocation shape rule, kept as a second, stricter check beside the parser.
 */
export function hookCommandScript(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const withoutVars = command.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "VAR");
  // Screened over the whole text, comment included, as before: a comment never earns control syntax a pass.
  if (/[;&|`<>()$\n\r]/.test(withoutVars)) return null;
  const code = commandBeforeComment(command);
  if (code === null) return null;
  // A backslash anywhere makes the command opaque: the shell keeps one inside double quotes before an ordinary
  // character while the shared parser drops it, and it can move a quote boundary. (`#` is settled by
  // commandBeforeComment: a comment is cut off, and any other `#` is literal to bash and the parser.)
  if (code.includes("\\")) return null;
  let walk: ReturnType<typeof shellSteps>;
  try { walk = shellSteps(code); } catch { return null; }
  if (walk.tooDeep || walk.commands.length !== 1 || walk.steps.length !== 1) return null;
  const step = walk.steps[0]!;
  if (step.depth !== 0 || step.wrappers.length > 0 || Object.keys(step.env).length > 0 || step.writeTargets.length > 0) return null;
  const tokens = step.argv;
  if (tokens.length === 0) return null;
  const exe = tokens[0]!;
  let i = 0;
  if (exe.split("/").pop() === "bun") {
    i = 1;
    const run = tokens[i] === "run";
    if (run) i++;
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      if (tokens[i] === "--") { i++; break; } // end of bun's options: the next word is the script, whatever it looks like
      if (!bunRunFlag(tokens[i]!, run)) return null;
      i++;
    }
    if (i >= tokens.length) return null;
  }
  // Glob and brace expansion let the shell's word differ from the parsed word, so they make the command opaque
  // in the words that decide what runs: the executable, bun's options and the script. Words after the script are
  // its own arguments and cannot change which file runs, so a trailing `'*.ts'`, `?` or `{}` is left alone (S091
  // parity: HEAD counted those, and bash runs the hook).
  const deciding = tokens.slice(0, i + 1).map((t) => t.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "VAR"));
  if (deciding.some((t) => /[*?[\]{}]/.test(t))) return null;
  return tokens[i]!;
}

/**
 * The command with a trailing shell comment cut off, or null when its quoting is not what bash would run.
 * Quotes must balance: bash rejects an unmatched quote as a syntax error and runs nothing, while the shared parser
 * tolerates it and rebuilds a word, so an unbalanced command is opaque. A `#` starts a comment only where bash
 * starts one, unquoted at the start of a word (line start or after a blank); everything from there is ignored.
 * Any other `#` (inside a word or a quoted string) is a literal character to bash, and the shared parser keeps it
 * literal too (it has no comment rule), so once the comment is cut the two read the same words. Backslashes never
 * reach a quote decision here: hookCommandScript refuses a backslash before the parser runs.
 */
function commandBeforeComment(command: string): string | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || command[i - 1] === " " || command[i - 1] === "\t")) return command.slice(0, i);
  }
  return quote === null ? command : null;
}

/**
 * bun options that still execute the script word that follows them (bun 1.3 `bun --help`): value-less switches,
 * and `=`-joined values that tune the runtime without changing which file runs. Left out on purpose, so they stay
 * opaque: anything that never runs the script (`--help`, `-h`, `--version`, `-v`, `--revision` before `run`, `-e`, `--eval`,
 * `-p`, `--print`), anything that runs other code first or instead (`--preload`, `-r`, `--require`, `--import`,
 * `--filter`, `--workspaces`, `--shell`, `--config`), `--cwd`, which moves what a relative script path names,
 * the debugger waits, and every space-separated value form, whose value word would be read as the script.
 */
const BUN_RUN_FLAGS = new Set([
  "--bun", "-b", "--smol", "--silent", "--no-install", "-i", "--hot", "--watch", "--no-clear-screen", "--if-present",
  "--cpu-prof", "--prefer-offline", "--prefer-latest", "--expose-gc", "--no-deprecation", "--throw-deprecation",
  "--zero-fill-buffers", "--use-system-ca", "--use-openssl-ca", "--use-bundled-ca", "--redis-preconnect",
  "--sql-preconnect", "--no-addons", "--no-env-file",
]);
// `--max-old-space-size`, `--stack-trace-limit` and `--conditions` tune the runtime and still run the script
// (checked with bash and bun 1.3.6; HEAD counted them, S091 parity).
const BUN_RUN_VALUE_FLAGS = /^--(?:env-file|install|port|title|console-depth|unhandled-rejections|dns-result-order|max-http-header-size|user-agent|cpu-prof-name|cpu-prof-dir|max-old-space-size|stack-trace-limit|conditions)=\S+$/;
/**
 * True when `token` still runs the script word that follows. After `bun run`, `--revision` is not bun's own
 * revision switch and the script runs (bun 1.3.6: `bun run --revision <file>` runs it, `bun --revision <file>`
 * only prints the revision), so it is accepted there alone.
 */
function bunRunFlag(token: string, afterRun: boolean): boolean {
  if (afterRun && token === "--revision") return true;
  return BUN_RUN_FLAGS.has(token) || BUN_RUN_VALUE_FLAGS.test(token);
}

/** True when a PreToolUse matcher covers both Write and Edit (absent, empty and "*" match every tool). */
function matcherCoversWrites(matcher: unknown): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (typeof matcher !== "string") return false;
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return re.test("Write") && re.test("Edit");
  } catch { return false; }
}

/**
 * m-006's test: true when a PreToolUse group whose matcher covers Write and Edit holds a `type: "command"`
 * hook that executes the SystemFileGuard hook script. A substring match on the file name is not enough: an
 * inert command that merely mentions it is not a guard. No current install registers that hook (system-file
 * boundaries are held by the pre-commit leak scan, LIFEOS/TOOLS/githooks/StagedLeakScan.ts), so m-006 reports
 * MISSING on a current install.
 */
export function systemFileGuardRegistered(settings: unknown): boolean {
  const hooks = settings && typeof settings === "object" ? (settings as { hooks?: unknown }).hooks : undefined;
  const preTool = hooks && typeof hooks === "object" ? (hooks as { PreToolUse?: unknown }).PreToolUse : undefined;
  if (!Array.isArray(preTool)) return false;
  return preTool.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as { matcher?: unknown; hooks?: unknown };
    if (!matcherCoversWrites(e.matcher) || !Array.isArray(e.hooks)) return false;
    return e.hooks.some((h) => {
      if (!h || typeof h !== "object" || (h as { type?: unknown }).type !== "command") return false;
      const script = hookCommandScript((h as { command?: unknown }).command);
      return script !== null && /(^|\/)hooks\/SystemFileGuard\.hook\.ts$/.test(script);
    });
  });
}

interface MigrationContext {
  claudeRoot: string;
  dryRun: boolean;
}

interface Migration {
  id: string;
  name: string;
  isApplied: (ctx: MigrationContext) => boolean;
  apply: (ctx: MigrationContext) => void;
  /**
   * True when apply() intentionally throws with remediation instructions
   * (manual/hand-migration path). Detect-only pending migrations are reported
   * as action-required (exit 3), never as a failed write (public issue #1549).
   */
  detectOnly?: boolean;
  /** Optional rollback for emergencies; not run automatically (manual use only). */
  rollback?: (ctx: MigrationContext) => void;
}

// ─── Migration Registry ──────────────────────────────────────────────────────
// Each migration corresponds to a Phase of the rebuild and is idempotent.
// Order matters: earlier migrations are prerequisites for later ones.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    id: "m-001",
    name: "Phase B Part 2 — settings.json split into system+user halves",
    detectOnly: true,
    isApplied: ({ claudeRoot }) =>
      existsSync(join(claudeRoot, "settings.system.json")) &&
      existsSync(join(claudeRoot, "LIFEOS/USER/CONFIG/settings.user.json")) &&
      existsSync(join(claudeRoot, "LIFEOS/TOOLS/MergeSettings.ts")),
    apply: () => {
      throw new Error("m-001 apply not implemented — Phase B was a hand-migration; auto-apply path would re-derive settings.system.json from a fresh public LifeOS checkout, which only matters during from-fresh-install. For an in-place upgrade, this migration is detected-as-applied or detected-as-missing-and-skipped (manual remediation required).");
    },
  },
  {
    id: "m-002",
    name: "Phase C — CLAUDE.md @-imports the five identity files directly + OPERATIONAL_PREFERENCES.md present",
    detectOnly: true,
    isApplied: ({ claudeRoot }) => {
      const claudeMd = join(claudeRoot, "CLAUDE.md");
      if (!existsSync(claudeMd)) return false;
      const content = readFileSync(claudeMd, "utf8");
      const requiredImports = [
        "@LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md",
        "@LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md",
        "@LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md",
        "@LIFEOS/USER/PROJECTS.md",
        "@LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md",
      ];
      const allImportsPresent = requiredImports.every((imp) => content.includes(imp));
      const opRulesPresent = existsSync(join(claudeRoot, "LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md"));
      return allImportsPresent && opRulesPresent;
    },
    apply: () => {
      throw new Error("m-002 apply not implemented — Phase C was a hand-migration. For from-fresh-install, the public LifeOS checkout's CLAUDE.md is staged from the release skill's public CLAUDE template and `/LifeOS setup` populates the identity files + adds the @-imports.");
    },
  },
  {
    id: "m-003",
    name: "Phase F — LifeosConfig.ts present + LIFEOS_CONFIG.toml populated",
    detectOnly: true,
    isApplied: ({ claudeRoot }) =>
      existsSync(join(claudeRoot, "LIFEOS/TOOLS/LifeosConfig.ts")) &&
      existsSync(join(claudeRoot, "LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml")),
    apply: () => {
      throw new Error("m-003 apply not implemented — LifeosConfig.ts ships with public LifeOS; LIFEOS_CONFIG.toml comes from `/LifeOS setup`. Missing artifact requires manual remediation.");
    },
  },
  {
    id: "m-004",
    name: "Phase G — LIFEOS/USER is symlink to user data repo",
    detectOnly: true,
    isApplied: ({ claudeRoot }) => {
      const userPath = join(claudeRoot, "LIFEOS/USER");
      if (!existsSync(userPath)) return false;
      try {
        const lst = lstatSync(userPath);
        if (!lst.isSymbolicLink()) return false;
        const target = readlinkSync(userPath);
        return target.length > 0 && existsSync(userPath);
      } catch {
        return false;
      }
    },
    apply: () => {
      throw new Error("m-004 apply requires principal authorization for `gh repo create` + live tree move. Run the Phase G migration session interactively (its design record lives in the maintainer's private work tree), NOT via LifeosUpgrade.ts. This migration is detect-only.");
    },
  },
  {
    id: "m-005",
    name: "Phase G — LIFEOS/MEMORY/ in .gitignore",
    detectOnly: true,
    isApplied: ({ claudeRoot }) => {
      const gitignore = join(claudeRoot, ".gitignore");
      if (!existsSync(gitignore)) return false;
      const content = readFileSync(gitignore, "utf8");
      // Already-applied if any LIFEOS/MEMORY/ subpath is gitignored. The current
      // policy gitignores LEARNING/, OBSERVABILITY/, STATE/, etc. selectively;
      // Phase G may broaden this. For now, we detect "any LIFEOS/MEMORY/ rule" as
      // applied. Case matters (public PR #1547, @m8ryx): the dir is LIFEOS/,
      // and a LifeOS/-cased regex can never match on a case-sensitive FS.
      return /^LIFEOS\/MEMORY\//m.test(content);
    },
    apply: () => {
      throw new Error("m-005 apply not implemented — modify .gitignore in source PR rather than via tool. The detect-only check surfaces missing state.");
    },
  },
  {
    id: "m-006",
    name: "Phase E — SystemFileGuard hook registered",
    detectOnly: true,
    isApplied: ({ claudeRoot }) => {
      const settingsPath = join(claudeRoot, "settings.json");
      if (!existsSync(settingsPath)) return false;
      try {
        return systemFileGuardRegistered(JSON.parse(readFileSync(settingsPath, "utf8")));
      } catch {
        return false;
      }
    },
    apply: () => {
      throw new Error("m-006 apply not implemented — hook entry must be added to settings.system.json (public template), then SessionStart's MergeSettings regenerates settings.json. Detected-as-missing requires manual remediation on a public LifeOS install.");
    },
  },
  {
    id: "m-007",
    name: "Phase G — pre-push hook syncs USER-data repo before push",
    detectOnly: true,
    isApplied: ({ claudeRoot }) => {
      const hookPath = join(claudeRoot, ".git/hooks/pre-push");
      if (!existsSync(hookPath)) return false;
      try {
        const content = readFileSync(hookPath, "utf8");
        // Generic marker comments the installer writes — no principal-bound
        // repo name in this check. The augmented hook is identified by the
        // "# pai-user-data-sync" marker block AND the lfs handoff line.
        return content.includes("# pai-user-data-sync") && content.includes("git lfs pre-push");
      } catch {
        return false;
      }
    },
    apply: () => {
      throw new Error("m-007 apply not implemented — pre-push hook installation belongs to Phase G execution session (G.4b). The auto-install path requires the user's USER-data repo to exist first; once Phase G EXECUTE runs, this migration's apply will write the hook content (including the `# pai-user-data-sync` marker comment) and back up the original to ~/.claude/.git/hooks/pre-push.pre-G-backup.");
    },
  },
];

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage(code = 2): never {
  console.log(
    `LifeosUpgrade — idempotent migration runner for LifeOS rebuild\n\n` +
      `Usage:\n` +
      `  bun ${process.argv[1]} --diagnose\n` +
      `  bun ${process.argv[1]} --dry-run\n` +
      `  bun ${process.argv[1]} [--target=<version>]\n` +
      `  bun ${process.argv[1]} --from-fresh-install   (NOT YET IMPLEMENTED)\n` +
      `  bun ${process.argv[1]} --help\n\n` +
      `Exit: 0 success / 1 migration failed or a check errored / 2 usage error / 3 migrations pending.`,
  );
  process.exit(code);
}

interface CliArgs {
  diagnose: boolean;
  dryRun: boolean;
  fromFreshInstall: boolean;
  target: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { diagnose: false, dryRun: false, fromFreshInstall: false, target: null };
  for (const a of argv) {
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--diagnose") args.diagnose = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--from-fresh-install") args.fromFreshInstall = true;
    else if (a.startsWith("--target=")) args.target = a.slice("--target=".length);
    else {
      console.error(`Unknown argument: ${a}`);
      usage(2);
    }
  }
  return args;
}

export interface DiagnoseSummary { applied: number; missing: number; errors: number }

/**
 * Audit every migration. A check that throws is an ERROR, counted on its own and never folded into
 * "up to date"; the exit code the CLI derives from this summary is nonzero
 * whenever anything is missing or failed to check.
 */
function diagnose(ctx: MigrationContext): DiagnoseSummary {
  console.log(`LifeOS install audit — ${ctx.claudeRoot}\n`);
  console.log("Migration registry status:");
  let appliedCount = 0;
  let missingCount = 0;
  let errorCount = 0;
  for (const m of MIGRATIONS) {
    let applied: boolean | null;
    let detail = "";
    try {
      applied = m.isApplied(ctx);
    } catch (err) {
      applied = null;
      detail = `  (${err instanceof Error ? err.message : String(err)})`;
    }
    const tag = applied === true ? "✓ APPLIED " : applied === false ? "✗ MISSING " : "? ERROR   ";
    console.log(`  ${tag} ${m.id}  ${m.name}${detail}`);
    if (applied === true) appliedCount++;
    else if (applied === false) missingCount++;
    else errorCount++;
  }
  console.log(`\nSummary: ${appliedCount} applied, ${missingCount} missing, ${errorCount} errored, of ${MIGRATIONS.length} total.`);
  if (errorCount > 0) {
    console.log(`\n${errorCount} migration check(s) could not run — the install state is unknown until they do.`);
  }
  if (missingCount > 0) {
    console.log(`\nNext step: review each missing migration's description above before applying.`);
  }
  if (missingCount === 0 && errorCount === 0) {
    console.log(`\nInstall is up-to-date through the registered migration set.`);
  }
  return { applied: appliedCount, missing: missingCount, errors: errorCount };
}

/** --diagnose exit: 1 when any check errored, 3 when migrations are missing, 0 only when everything is applied. */
export function diagnoseExitCode(s: DiagnoseSummary): 0 | 1 | 3 {
  if (s.errors > 0) return 1;
  if (s.missing > 0) return 3;
  return 0;
}

function plan(ctx: MigrationContext): { toApply: Migration[]; alreadyApplied: Migration[] } {
  const toApply: Migration[] = [];
  const alreadyApplied: Migration[] = [];
  for (const m of MIGRATIONS) {
    try {
      if (m.isApplied(ctx)) alreadyApplied.push(m);
      else toApply.push(m);
    } catch (err) {
      console.error(`migration ${m.id} isApplied() threw: ${err instanceof Error ? err.message : String(err)}`);
      toApply.push(m); // err-toward-apply for visibility
    }
  }
  return { toApply, alreadyApplied };
}

function dryRun(ctx: MigrationContext): void {
  const { toApply, alreadyApplied } = plan(ctx);
  console.log(`Already applied (${alreadyApplied.length}):`);
  for (const m of alreadyApplied) console.log(`  ✓ ${m.id}  ${m.name}`);
  console.log(`\nWould apply (${toApply.length}):`);
  for (const m of toApply) console.log(`  → ${m.id}  ${m.name}`);
  if (toApply.length === 0) console.log("  (nothing to do — install is current)");
}

function runMigrations(ctx: MigrationContext): never {
  const { toApply, alreadyApplied } = plan(ctx);
  console.log(`Already applied: ${alreadyApplied.length}/${MIGRATIONS.length}`);
  if (toApply.length === 0) {
    console.log("Nothing to do — install is current.");
    process.exit(0);
  }
  // Detect-only migrations are reported, never executed (public issue #1549):
  // their apply() throws with remediation instructions by design, and treating
  // that throw as a write failure produced a false "Partial state may exist"
  // on the exact path users hit when checking install health.
  const detectOnlyPending = toApply.filter((m) => m.detectOnly);
  const applicable = toApply.filter((m) => !m.detectOnly);
  if (detectOnlyPending.length > 0) {
    console.log(`\nAction required — ${detectOnlyPending.length} detect-only migration(s) pending (manual remediation, nothing was modified):`);
    for (const m of detectOnlyPending) {
      console.log(`\n  ! ${m.id}  ${m.name}`);
      try {
        m.apply(ctx); // by contract this throws with the remediation instructions
      } catch (err) {
        console.log(`    ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const m of applicable) {
    console.log(`\n→ Applying ${m.id}: ${m.name}`);
    try {
      m.apply(ctx);
      console.log(`  ✓ ${m.id} applied`);
    } catch (err) {
      console.error(`  ✗ ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`\nMigration halted. Partial state may exist. Review error and re-run after remediation.`);
      process.exit(1);
    }
  }
  if (applicable.length > 0) console.log(`\nAll ${applicable.length} auto-applicable migrations applied successfully.`);
  process.exit(detectOnlyPending.length > 0 ? 3 : 0);
}

function main(): never {
  const args = parseArgs(process.argv.slice(2));

  // Sanity: must be running against a recognizable LifeOS tree.
  if (!existsSync(join(CLAUDE_ROOT, "LIFEOS"))) {
    console.error(`LifeosUpgrade: ${CLAUDE_ROOT}/LIFEOS not found — is this a LifeOS install?`);
    process.exit(2);
  }

  const ctx: MigrationContext = { claudeRoot: CLAUDE_ROOT, dryRun: args.dryRun };

  if (args.fromFreshInstall) {
    console.error(`--from-fresh-install is NOT YET IMPLEMENTED. Use the install.sh path to scaffold a fresh LifeOS tree.`);
    process.exit(2);
  }

  if (args.diagnose) {
    process.exit(diagnoseExitCode(diagnose(ctx)));
  }

  if (args.dryRun) {
    dryRun(ctx);
    process.exit(0);
  }

  runMigrations(ctx);
}

if (import.meta.main) main();
