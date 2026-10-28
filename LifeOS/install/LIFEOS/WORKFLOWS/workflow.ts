#!/usr/bin/env bun
/**
 * workflow — the agent-first CLI for Workflows v2 definitions.
 *
 *   bun LIFEOS/WORKFLOWS/workflow.ts help --json
 *   bun LIFEOS/WORKFLOWS/workflow.ts new <name> [--template KIND] [--after UPSTREAM]
 *   bun LIFEOS/WORKFLOWS/workflow.ts list
 *   bun LIFEOS/WORKFLOWS/workflow.ts validate|graph|next <name|path>
 *   bun LIFEOS/WORKFLOWS/workflow.ts run <name|path> [--input JSON] [--dry-run] [--occurrence KEY] [--trigger KIND]
 *   bun LIFEOS/WORKFLOWS/workflow.ts pause|resume (<name> | --all)
 *   bun LIFEOS/WORKFLOWS/workflow.ts link <upstream> <downstream> [--status S]
 *   bun LIFEOS/WORKFLOWS/workflow.ts schedule <name> --cron EXPR --tz TZ | --every N | --at ISO | --in 20m | --remove T
 *   bun LIFEOS/WORKFLOWS/workflow.ts set <name> runs_on local|cloud
 *   bun LIFEOS/WORKFLOWS/workflow.ts rename <old> <new>
 *   bun LIFEOS/WORKFLOWS/workflow.ts runs [<name>] [--active] [--status S] [--since T] [--limit N]
 *   bun LIFEOS/WORKFLOWS/workflow.ts stop <run-id>
 *   bun LIFEOS/WORKFLOWS/workflow.ts test <name>
 *   bun LIFEOS/WORKFLOWS/workflow.ts emit <event> [--input JSON]
 *   bun LIFEOS/WORKFLOWS/workflow.ts deploy <name> [--confirm <name>] [--allow-dirty <reason>] [--waive-blockers <reason>]
 *   bun LIFEOS/WORKFLOWS/workflow.ts contracts [<name>]
 *
 * Every command takes --json (one JSON document on stdout). Exit codes:
 * 0 success, 1 invalid or failed, 2 usage. A name resolves to
 * LIFEOS/USER/WORKFLOWS/<name>.workflow.yaml; anything with a slash or a
 * .yaml suffix is a path (read-only commands only). Every command that changes a
 * definition goes through engine/definitions.ts, the one writer, which
 * validates first and writes nothing when the result is invalid. Only `run`
 * without --dry-run, and `test` (with stubs), execute steps.
 *
 * @version 2.0.0
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InvariantViolation, invariant } from "../TOOLS/Invariant.ts";
import { contractReport } from "./cloud/contract-report.ts";
import { dropCloudEnv, loadCloudEnvFile } from "./cloud/credentials.ts";
import { addAfterLink, addStep, changeSchedule, checkStepPatch, connectSteps, disconnectSteps, linkSchemas, parseMinutes, removeStep, setEnabled, setRunsOn, setStepFields, type ScheduleChange, type StepFieldPatch } from "./engine/definition-edits.ts";
import { createDefinition, editDefinition, launchdChanged, readDefinitionText, realHome, removeWorkflow, Refusal, renameDefinition, replaceDefinition, type EditDone, type EditRefused, type Mutator } from "./engine/definitions.ts";
import {
  analyzeDefinition,
  describeDefinition,
  loadDefinitionFile,
  message,
  type Analysis,
  type LoadedDefinition,
} from "./engine/format.ts";
import { issueOfError, type Issue } from "./engine/format-issues.ts";
import { readLedger } from "./engine/ledger.ts";
import { isGloballyPaused, setGlobalPause } from "./engine/pause.ts";
import { nextFire, scheduleStateDir } from "./engine/schedule.ts";
import { installSchedule, launchdOptionsFromEnv, uninstallSchedule } from "./engine/schedule-install.ts";
import { syncLaunchd } from "./engine/launchd-sync.ts";
import { DEFINITION_SUFFIX, definitionsDir, ledgerPath, NAME_RE, resolveDefinition } from "./engine/paths.ts";
import { definitionResolver, resolveActions, runDefinition, type RunReport, type TriggerContext } from "./engine/runner.ts";
import { isTemplateKind, renderTemplate, TEMPLATE_CATALOG, templateKinds, type TemplateKind } from "./engine/templates.ts";
import { activeRuns, emitEvent, eventTargets, EVENT_NAME_RE, listRuns, parseSince, queuedOccurrences, stopRun, testDefinition } from "./engine/workflow-ops.ts";

const VERSION = "2.0.0";
const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
type Exit = (typeof EXIT)[keyof typeof EXIT];

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  options: Record<string, string>;
  executes_steps: boolean;
}

const JSON_OPT = { "--json": "JSON result" };

export const COMMANDS: CommandSpec[] = [
  { name: "help", usage: "workflow help [--json]", summary: "Print this command catalog.", options: { "--json": "machine-readable catalog" }, executes_steps: false },
  {
    name: "new",
    usage: "workflow new <name> [--template KIND] [--after UPSTREAM] [--json]",
    summary: "Write a valid v2 definition to the definitions home; refuses to overwrite. Templates: scheduled, event, after-chain, human-approval, model-typed.",
    options: { "--template": "start from a catalog template (see templates in help --json)", "--after": "after-chain only: the upstream workflow", ...JSON_OPT },
    executes_steps: false,
  },
  { name: "list", usage: "workflow list [--json]", summary: "List every definition in the definitions home with its validity.", options: JSON_OPT, executes_steps: false },
  {
    name: "validate",
    usage: "workflow validate <name|path> [--json]",
    summary: "Validate one definition: structure, graph, step kinds, lanes, side-effect gate, triggers, connection types, after links. --json carries issues as {path, code, message}.",
    options: JSON_OPT,
    executes_steps: false,
  },
  { name: "graph", usage: "workflow graph <name|path> [--json]", summary: "Describe the graph: steps with executors, and every connection with its class (checked, runtime, mismatch).", options: JSON_OPT, executes_steps: false },
  { name: "next", usage: "workflow next <name|path> [--at ISO] [--json]", summary: "When each time trigger would next fire.", options: { "--at": "compute from this ISO time instead of now", ...JSON_OPT }, executes_steps: false },
  {
    name: "run",
    usage: "workflow run <name|path> [--input JSON] [--dry-run] [--occurrence KEY] [--trigger KIND] [--json]",
    summary: "Run locally: every step kind (a human step parks the run until answered; runs_on: cloud is refused), typed hand-offs, one ledger line per run; a repeated occurrence key is refused. Refused while the fleet is paused.",
    options: {
      "--input": "workflow input as JSON (default {})",
      "--dry-run": "validate the input and print the plan; runs nothing, writes nothing",
      "--occurrence": "occurrence key (default: unique per invocation); --occurrence-key is the same flag",
      "--trigger": "what started this run, recorded in the ledger: manual (default), schedule, once, interval, event or after",
      ...JSON_OPT,
    },
    executes_steps: true,
  },
  {
    name: "pause",
    usage: "workflow pause (<name> | --all) [--json]",
    summary: "Set enabled: false and stop the dispatcher starting it; with --all, pause the whole fleet: nothing new starts until resume --all.",
    options: { "--all": "pause every workflow at once (the global pause); runs already going are not touched", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "resume",
    usage: "workflow resume (<name> | --all) [--json]",
    summary: "Set enabled: true and let the dispatcher start it on schedule again; with --all, lift the global pause.",
    options: { "--all": "lift the global pause", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "link",
    usage: "workflow link <upstream> <downstream> [--status S] [--json]",
    summary: "Make downstream run after upstream (an after: trigger); refuses when the upstream output does not fit the downstream input, naming both schemas.",
    options: { "--status": "succeeded (default), failed or completed", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "schedule",
    usage: "workflow schedule <name> [--cron EXPR --tz TZ] [--every N] [--at ISO] [--in DURATION] [--remove TRIGGER] [--json]",
    summary: "Add, replace or remove a time trigger. Writes triggers only, and nothing when the result is invalid.",
    options: {
      "--cron": "five-field cron expression (needs --tz)",
      "--tz": "IANA time zone for --cron",
      "--every": "interval in minutes, or 90m, 2h, 1d",
      "--at": "one run at this ISO time (with offset)",
      "--in": "one run this long from now: 20m, 2h, 1d",
      "--remove": "remove a trigger by type (schedule, interval, once, ...) or by position",
      ...JSON_OPT,
    },
    executes_steps: false,
  },
  { name: "set", usage: "workflow set <name> runs_on <local|cloud> [--json]", summary: "Move a workflow between local and cloud; refuses when its resources or triggers cannot run there.", options: JSON_OPT, executes_steps: false },
  { name: "rename", usage: "workflow rename <old> <new> [--json]", summary: "Rename the file and name, and repoint every after: trigger and workflow step that named it.", options: JSON_OPT, executes_steps: false },
  {
    name: "runs",
    usage: "workflow runs [<name>] [--active] [--status S] [--since T] [--limit N] [--json]",
    summary: "List ledger runs, or with --active the in-flight runs and queued occurrences.",
    options: { "--active": "in-flight runs (a claim with no ledger line) and queued occurrences", "--status": "succeeded, failed or abandoned", "--since": "ISO time or a duration back from now (90m, 6h, 2d)", "--limit": "most recent N (default 50)", ...JSON_OPT },
    executes_steps: false,
  },
  { name: "stop", usage: "workflow stop <run-id> [--json]", summary: "Stop an in-flight local run: status stopped, pending steps skipped.", options: JSON_OPT, executes_steps: false },
  {
    name: "test",
    usage: "workflow test <name> [--json]",
    summary: "Run against the declared fixtures; outbound, money, deploy, model and agent steps are stubbed from the fixture. Exit 0 only when every expected result matches.",
    options: JSON_OPT,
    executes_steps: true,
  },
  {
    name: "emit",
    usage: "workflow emit <event> [--input JSON] [--json]",
    summary: "Record a named event for the dispatcher to hand to every enabled workflow with a matching event trigger.",
    options: { "--input": "event payload as JSON (default {})", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "deploy",
    usage: "workflow deploy <name> [--confirm <name>] [--allow-dirty <reason>] [--waive-blockers <reason>] [--json]",
    summary: "Deploy a cloud workflow's runner through the gated deploy script: read-only preflight first, refused on any failure before an upload; deploying needs --confirm <name> and env WORKFLOWS_DEPLOY_APPROVED=<name>.",
    options: {
      "--confirm": "the workflow's own name, to approve the deploy (env WORKFLOWS_DEPLOY_APPROVED must match too)",
      "--allow-dirty": "a reason to ship uncommitted files past the deploy's code review (the model review still runs and its blockers still stop it), passed to the Cloudflare deploy helper, which records it; an empty or missing reason is refused before any build",
      "--waive-blockers": "a reason to ship past the code review's blockers, a reviewer outage or an over-limit diff (never uncommitted files), passed to the Cloudflare deploy helper, which records it; an empty or missing reason is refused before any build",
      ...JSON_OPT,
    },
    executes_steps: false,
  },
  {
    name: "show",
    usage: "workflow show <name> [--json]",
    summary: "Print a definition's text and its content hash; an editor sends the hash back as --base-hash so a stale copy is refused.",
    options: JSON_OPT,
    executes_steps: false,
  },
  {
    name: "step",
    usage: "workflow step <add|set|remove|connect|disconnect> <name> <id|from> [<to>] [--kind K] [--fields JSON] [--needs a,b] [--base-hash H] [--json]",
    summary: "Edit a workflow's steps: add or remove a step, set its fields (null removes one), or make one step run after another. Validates before writing and refuses cycles; the canvas editor calls the same functions.",
    options: {
      "--kind": "step kind for add: action, command, model, judgment, agent, human or workflow",
      "--fields": "JSON object of step fields (description, uses, argv, env, lane, prompt, question, workflow, side_effects, recipient)",
      "--needs": "comma-separated steps the new step runs after",
      "--base-hash": "refuse unless the file still has this hash (from show)",
      ...JSON_OPT,
    },
    executes_steps: false,
  },
  {
    name: "put",
    usage: "workflow put <name> --file PATH|- [--base-hash H] [--json]",
    summary: "Replace a definition's whole text after validating it; the name must not change. Rechecks its schedule when triggers or enabled changed.",
    options: { "--file": "the new text, or - for stdin", "--base-hash": "refuse unless the file still has this hash (from show)", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "remove",
    usage: "workflow remove <name> [--base-hash H] [--json]",
    summary: "Delete a definition only when no other definition names it in an after: trigger or a workflow step; removes any leftover per-workflow launchd job first. The page's Undo of New calls the same function.",
    options: { "--base-hash": "refuse unless the file still has this hash (from show)", ...JSON_OPT },
    executes_steps: false,
  },
  {
    name: "contracts",
    usage: "workflow contracts [<name>] [--json]",
    summary: "List each action the v2 definitions use with its input and output contract specificity; exit 1 when any is no narrower than {type: object}.",
    options: JSON_OPT,
    executes_steps: false,
  },
];

class UsageError extends Error {}

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
  json: boolean;
}

const VALUE_FLAGS = new Set(["--input", "--occurrence", "--occurrence-key", "--trigger", "--at", "--template", "--after", "--status", "--since", "--limit", "--cron", "--tz", "--every", "--in", "--remove", "--confirm", "--allow-dirty", "--waive-blockers", "--kind", "--fields", "--needs", "--base-hash", "--file"]);
const BOOLEAN_FLAGS = new Set(["--json", "--dry-run", "--active", "--all"]);
/** Positional count as [min, max], and the flags each command takes. */
const ALLOWED: Record<string, { positional: [number, number]; flags: string[] }> = {
  help: { positional: [0, 0], flags: ["--json"] },
  new: { positional: [1, 1], flags: ["--json", "--template", "--after"] },
  list: { positional: [0, 0], flags: ["--json"] },
  validate: { positional: [1, 1], flags: ["--json"] },
  graph: { positional: [1, 1], flags: ["--json"] },
  next: { positional: [1, 1], flags: ["--json", "--at"] },
  run: { positional: [1, 1], flags: ["--json", "--input", "--dry-run", "--occurrence", "--occurrence-key", "--trigger"] },
  pause: { positional: [0, 1], flags: ["--json", "--all"] },
  resume: { positional: [0, 1], flags: ["--json", "--all"] },
  link: { positional: [2, 2], flags: ["--json", "--status"] },
  schedule: { positional: [1, 1], flags: ["--json", "--cron", "--tz", "--every", "--at", "--in", "--remove"] },
  set: { positional: [3, 3], flags: ["--json"] },
  rename: { positional: [2, 2], flags: ["--json"] },
  runs: { positional: [0, 1], flags: ["--json", "--active", "--status", "--since", "--limit"] },
  stop: { positional: [1, 1], flags: ["--json"] },
  test: { positional: [1, 1], flags: ["--json"] },
  emit: { positional: [1, 1], flags: ["--json", "--input"] },
  deploy: { positional: [1, 1], flags: ["--json", "--confirm", "--allow-dirty", "--waive-blockers"] },
  contracts: { positional: [0, 1], flags: ["--json"] },
  show: { positional: [1, 1], flags: ["--json"] },
  step: { positional: [3, 4], flags: ["--json", "--kind", "--fields", "--needs", "--base-hash"] },
  put: { positional: [1, 1], flags: ["--json", "--file", "--base-hash"] },
  remove: { positional: [1, 1], flags: ["--json", "--base-hash"] },
};

const usageOf = (command: string): string => COMMANDS.find(c => c.name === command)?.usage ?? `workflow ${command}`;

function parseArgs(argv: string[]): Parsed {
  const json = argv.includes("--json");
  const [command, ...rest] = argv;
  if (!command || command === "--json") return { command: "help", positional: [], flags: new Map(), json };
  if (command === "--help" || command === "-h") return { command: "help", positional: [], flags: new Map(), json };
  const spec = ALLOWED[command];
  if (!spec) throw new UsageError(`Unknown command "${command}". Commands: ${Object.keys(ALLOWED).join(", ")}.`);
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      if (command === "deploy" && (arg === "--accept" || arg.startsWith("--accept="))) throw new UsageError(RETIRED_ACCEPT);
      if (!spec.flags.includes(arg)) throw new UsageError(`"${command}" does not take ${arg}.`);
      if (flags.has(arg)) throw new UsageError(`${arg} given twice.`);
      if (VALUE_FLAGS.has(arg)) {
        const value = rest[++i];
        if (value === undefined) throw new UsageError(`${arg} needs a value.`);
        flags.set(arg, value);
      } else if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, true);
    } else positional.push(arg);
  }
  const [min, max] = spec.positional;
  if (positional.length < min || positional.length > max) {
    throw new UsageError(max === 0 ? `"${command}" takes no arguments.` : `"${command}" takes ${min === max ? `exactly ${min}` : `${min} to ${max}`} argument${max === 1 ? "" : "s"}. Usage: ${usageOf(command)}`);
  }
  return { command, positional, flags, json };
}

const flagText = (flags: Map<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

/** A workflow name argument for a command that edits or runs by name. */
function requireName(value: string, what = "a workflow name"): string {
  if (!NAME_RE.test(value)) throw new UsageError(`"${value}" is not ${what}: lowercase letters, digits and hyphens, starting with a letter or digit.`);
  return value;
}

/* ── Output ─────────────────────────────────────────────────────────────── */

function emit(json: boolean, value: unknown, lines: string[]): void {
  console.log(json ? JSON.stringify(value, null, 2) : lines.join("\n"));
}

function loadOrReport(ref: string, json: boolean): LoadedDefinition | null {
  const resolved = resolveDefinition(ref);
  if (!resolved.ok) {
    emit(json, { ok: false, error: resolved.error }, [resolved.error]);
    return null;
  }
  try {
    return loadDefinitionFile(resolved.path);
  } catch (error) {
    const text = message(error);
    const issue = issueOfError(error);
    emit(json, { ok: false, valid: false, path: resolved.path, errors: [text], issues: [issue], warnings: [], warning_issues: [] }, [`invalid: ${resolved.path}`, `  ${text}`]);
    return null;
  }
}

async function analyzeLoaded(loaded: LoadedDefinition): Promise<Analysis> {
  const actions = await resolveActions(loaded.def);
  const analysis = analyzeDefinition(loaded.def, { contracts: actions.contracts, resolveWorkflow: definitionResolver() });
  if (loaded.def.runs_on === "local") {
    for (const [name, why] of actions.missing) {
      const text = `Action ${name} is not available locally: ${why}`;
      analysis.errors.push(text);
      analysis.issues.push({ path: "steps", code: "action-unavailable", message: text });
    }
    analysis.valid = analysis.errors.length === 0;
  }
  return analysis;
}

const classCounts = (analysis: Analysis) => ({
  checked: analysis.connections.filter(c => c.class === "checked").length,
  runtime: analysis.connections.filter(c => c.class === "runtime").length,
  mismatch: analysis.connections.filter(c => c.class === "mismatch").length,
});

const issueLine = (i: Issue): string => `${i.path} [${i.code}] ${i.message}`;

/* ── Commands ───────────────────────────────────────────────────────────── */

function help(json: boolean): Exit {
  const catalog = {
    name: "workflow",
    version: VERSION,
    summary: "Define, validate, inspect, schedule and run Workflows v2 definitions.",
    definitions: definitionsDir(),
    ledger: ledgerPath(),
    commands: COMMANDS,
    templates: TEMPLATE_CATALOG,
    exit_codes: { "0": "success", "1": "invalid or failed", "2": "usage" },
    env: { LIFEOS_WORKFLOWS_DIR: "definitions home override", LIFEOS_WORKFLOWS_LEDGER: "run ledger file override" },
  };
  const width = Math.max(...COMMANDS.map(c => c.usage.length)) + 2;
  emit(json, catalog, [
    `workflow ${VERSION} — Workflows v2 definitions`,
    "",
    ...COMMANDS.map(c => `  ${c.usage.padEnd(width)} ${c.summary}`),
    "",
    `Templates (new --template): ${templateKinds().join(", ")}`,
    "Exit codes: 0 success · 1 invalid or failed · 2 usage",
    `Definitions: ${definitionsDir()}`,
  ]);
  return EXIT.ok;
}

function template(name: string): string {
  return [
    `# ${name} — a Workflows v2 definition.`,
    `# Validate: bun LIFEOS/WORKFLOWS/workflow.ts validate ${name}`,
    `# Run:      bun LIFEOS/WORKFLOWS/workflow.ts run ${name} --input '{"text":"hello"}'`,
    "# Optional keys: description, sop, domains, destination, data_class, more triggers and steps.",
    "version: 2",
    `name: ${name}`,
    "runs_on: local",
    "triggers:",
    "  - type: manual",
    "input:",
    "  type: object",
    "  required: [text]",
    "  properties:",
    "    text: { type: string }",
    "output:",
    "  type: object",
    "  required: [text]",
    "  properties:",
    "    text: { type: string }",
    "steps:",
    "  echo:",
    "    kind: command",
    "    side_effects: [none]",
    '    argv: [bun, -e, "process.stdout.write(JSON.stringify(await Bun.stdin.json()))"]',
    "    input:",
    "      type: object",
    "      required: [text]",
    "      properties:",
    "        text: { type: string }",
    "    output:",
    "      type: object",
    "      required: [text]",
    "      properties:",
    "        text: { type: string }",
    "result: { $ref: steps.echo.output }",
    "",
  ].join("\n");
}

/** A path the writer resolved (symlinks and all) shown as the caller spelled the definitions home, so output matches what they typed. */
function shown(path: string): string {
  try {
    const real = realHome();
    return path === real || path.startsWith(real + "/") ? definitionsDir() + path.slice(real.length) : path;
  } catch {
    return path;
  }
}

/** Prints an edit outcome. A refusal is exit 1 with the reason, the validator's issues and nothing written. */
function editOutcome(json: boolean, result: EditDone | EditRefused, okLines: (done: EditDone) => string[], extraOk: (done: EditDone) => Record<string, unknown> = () => ({}), extraRefused: Record<string, unknown> = {}): Exit {
  if (result.ok) {
    emit(json, { ok: true, name: result.name, path: shown(result.path), ...result.detail, warnings: result.warnings.map(w => w.message), warning_issues: result.warnings, ...extraOk(result) }, [...okLines(result), ...result.warnings.map(w => `  warning: ${w.message}`)]);
    return EXIT.ok;
  }
  emit(json, { ok: false, refused: result.refused, error: result.error, issues: result.issues, ...(result.path ? { path: shown(result.path) } : {}), ...extraRefused }, [
    `Refused: ${result.error}`,
    ...result.issues.map(i => `  ${issueLine(i)}`),
    "  Nothing was written.",
  ]);
  return EXIT.failed;
}

async function create(name: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  requireName(name);
  const kind = flagText(flags, "--template");
  const after = flagText(flags, "--after");
  if (kind !== undefined && !isTemplateKind(kind)) throw new UsageError(`"${kind}" is not a template. Templates: ${templateKinds().join(", ")}.`);
  if (after !== undefined && kind !== "after-chain") throw new UsageError("--after belongs to --template after-chain.");
  let text: string;
  if (kind === undefined) text = template(name);
  else if (kind === "after-chain") {
    if (!after) throw new UsageError("The after-chain template needs --after <upstream>.");
    requireName(after, "an upstream workflow name");
    const upstream = definitionResolver(definitionsDir())(after);
    if (!upstream) {
      const error = `Refused: no workflow named "${after}" in ${definitionsDir()} to run after.`;
      emit(json, { ok: false, created: false, name, error }, [error]);
      return EXIT.failed;
    }
    text = renderTemplate("after-chain", name, { after, upstreamOutput: upstream.output });
  } else text = renderTemplate(kind as TemplateKind, name);
  const result = await createDefinition(name, text);
  if (result.ok) {
    emit(json, { ok: true, created: true, name, path: shown(result.path), ...(kind ? { template: kind } : {}) }, [`created ${shown(result.path)}`]);
    return EXIT.ok;
  }
  // A shipped template that does not validate is a bug here, not the author's; an after-chain can fail on the upstream.
  invariant(result.refused !== "invalid" || kind === "after-chain", `The ${kind ?? "default"} template did not produce a valid v2 definition: ${result.error}`);
  emit(json, { ok: false, created: false, name, refused: result.refused, error: result.error, issues: result.issues, ...(result.path ? { path: shown(result.path) } : {}) }, [result.error, ...result.issues.map(i => `  ${issueLine(i)}`)]);
  return EXIT.failed;
}

function list(json: boolean): Exit {
  const dir = definitionsDir();
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort() : [];
  const resolver = definitionResolver(dir);
  interface Listed { name: string; path: string; valid: boolean; errors: string[]; summary?: { version: 1 | 2; runs_on: string; triggers: string[]; steps: number } }
  const workflows: Listed[] = files.map(file => {
    const path = join(dir, file);
    try {
      const { def } = loadDefinitionFile(path);
      const analysis = analyzeDefinition(def, { resolveWorkflow: resolver });
      return { name: def.name, path, valid: analysis.valid, errors: analysis.errors,
        summary: { version: def.version, runs_on: def.runs_on, triggers: def.triggers.map(t => t.type), steps: Object.keys(def.steps).length } };
    } catch (error) {
      return { name: file.slice(0, -DEFINITION_SUFFIX.length), path, valid: false, errors: [message(error)] };
    }
  });
  emit(json, { ok: true, definitions: dir, workflows: workflows.map(({ summary, ...w }) => ({ ...w, ...summary })) }, workflows.length
    ? workflows.map(w => `${w.valid ? "ok     " : "INVALID"}  ${w.name}${w.summary ? `  ${w.summary.runs_on}  ${w.summary.triggers.join(",")}  ${w.summary.steps} steps` : ""}`)
    : [`No definitions in ${dir}.`]);
  return EXIT.ok;
}

async function validate(ref: string, json: boolean): Promise<Exit> {
  const loaded = loadOrReport(ref, json);
  if (!loaded) return EXIT.failed;
  const analysis = await analyzeLoaded(loaded);
  const counts = classCounts(analysis);
  emit(json, {
    ok: analysis.valid, valid: analysis.valid, name: loaded.def.name, path: loaded.path, version: loaded.def.version, runs_on: loaded.def.runs_on,
    errors: analysis.errors, issues: analysis.issues, warnings: analysis.warnings, warning_issues: analysis.warningIssues, connections: counts, links: analysis.links, handoffs: analysis.handoffs,
  }, [
    `${analysis.valid ? "valid" : "INVALID"}: ${loaded.def.name} (${loaded.path})`,
    `  connections: ${counts.checked} checked · ${counts.runtime} runtime · ${counts.mismatch} mismatch`,
    ...analysis.issues.map(i => `  error: ${issueLine(i)}`),
    ...analysis.warningIssues.map(w => `  warning: ${issueLine(w)}`),
  ]);
  return analysis.valid ? EXIT.ok : EXIT.failed;
}

async function graph(ref: string, json: boolean): Promise<Exit> {
  const loaded = loadOrReport(ref, json);
  if (!loaded) return EXIT.failed;
  const analysis = await analyzeLoaded(loaded);
  const described = { ok: analysis.valid, path: loaded.path, ...describeDefinition(loaded.def, analysis) };
  emit(json, described, [
    `${loaded.def.name} (${loaded.def.runs_on}, v${loaded.def.version})`,
    ...Object.entries(described.steps).map(([id, s]) => `  ${id}  ${s.kind}/${s.executor}${s.needs.length ? `  after ${s.needs.join(", ")}` : ""}`),
    ...analysis.connections.map(c => `  ${c.ref} -> ${c.at}  [${c.class}]${c.reason ? `  ${c.reason}` : ""}`),
    ...analysis.links.map(l => `  after ${l.upstream} (${l.status}) -> ${l.downstream}  [${l.class}]${l.reason ? `  ${l.reason}` : ""}`),
    ...analysis.handoffs.map(h => `  feeds ${h.downstream} via ${h.via}  [${h.class}]${h.reason ? `  ${h.reason}` : ""}`),
    ...analysis.errors.map(e => `  error: ${e}`),
  ]);
  return analysis.valid ? EXIT.ok : EXIT.failed;
}

function next(ref: string, at: string | undefined, json: boolean): Exit {
  const loaded = loadOrReport(ref, json);
  if (!loaded) return EXIT.failed;
  const now = at === undefined ? new Date() : new Date(at);
  if (!Number.isFinite(now.getTime())) throw new UsageError(`--at "${at}" is not an ISO time.`);
  const runs = readLedger(ledgerPath()).records.filter(r => r.workflow === loaded.def.name);
  const lastStart = runs.length ? Date.parse(runs[runs.length - 1].started_at) : Number.NaN;
  // ISC-116: the schedule module answers, so a consumed or past once trigger has no next fire.
  const stateDir = scheduleStateDir(ledgerPath());
  const triggers = loaded.def.triggers.map(t => ({ ...t, next: nextFire(t, loaded.def.name, now, lastStart, stateDir)?.toISOString() ?? null }));
  const times = triggers.map(t => t.next).filter((x): x is string => x !== null).sort();
  const soonest = times[0] ?? null;
  emit(json, { ok: true, name: loaded.def.name, at: now.toISOString(), next: soonest, triggers }, [
    `${loaded.def.name}: ${soonest ? `next ${soonest}` : "no time trigger"}`,
    ...triggers.map(t => `  ${t.type}${t.next ? `  ${t.next}` : ""}`),
  ]);
  return EXIT.ok;
}

function parseJsonFlag(flags: Map<string, string | true>, name: string): unknown {
  const raw = flagText(flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`${name} must be JSON.`);
  }
}

/** What may be recorded as a run's trigger through the CLI: every kind a local run can have. */
const RUN_TRIGGERS = ["manual", "schedule", "once", "interval", "event", "after"];

async function run(ref: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  const resolved = resolveDefinition(ref);
  if (!resolved.ok) {
    emit(json, { ok: false, success: false, error: resolved.error }, [resolved.error]);
    return EXIT.failed;
  }
  const input = parseJsonFlag(flags, "--input");
  const short = flags.get("--occurrence");
  const long = flags.get("--occurrence-key");
  if (short !== undefined && long !== undefined) throw new UsageError("--occurrence and --occurrence-key are the same flag; give one.");
  const occurrence = short ?? long;
  if (typeof occurrence === "string" && !occurrence.trim()) throw new UsageError("--occurrence must not be empty.");
  const kind = flagText(flags, "--trigger");
  if (kind !== undefined && !RUN_TRIGGERS.includes(kind)) throw new UsageError(`--trigger must be one of ${RUN_TRIGGERS.join(", ")}, not "${kind}".`);
  const dryRun = flags.get("--dry-run") === true;
  if (!dryRun && isGloballyPaused(ledgerPath())) {
    const error = "The Workflows fleet is paused; nothing was started. Lift it with: workflow resume --all";
    emit(json, { ok: false, success: false, refused: "paused", error }, [`refused (paused): ${error}`]);
    return EXIT.failed;
  }
  const report: RunReport = await runDefinition(resolved.path, {
    input,
    dryRun,
    ...(typeof occurrence === "string" ? { occurrenceKey: occurrence } : {}),
    ...(kind !== undefined ? { trigger: { type: kind } as TriggerContext } : {}),
  });
  emit(json, { ok: report.success, ...report }, [
    `${report.success ? "succeeded" : report.refused ? `refused (${report.refused})` : "failed"}: ${report.workflow || ref}${report.dry_run ? " [dry run]" : ""}`,
    ...(report.plan && report.dry_run ? report.plan.map(p => `  plan  ${p.id}  ${p.kind}${p.runnable ? "" : `  (${p.reason})`}`) : []),
    ...Object.entries(report.steps).map(([id, s]) => `  ${id}  ${s.status}${s.error ? `  ${s.error}` : ""}`),
    ...(report.error ? [`  error: ${report.error}`] : []),
    ...(report.run_id ? [`  run ${report.run_id} · occurrence ${report.occurrence_key}`] : []),
  ]);
  return report.success ? EXIT.ok : EXIT.failed;
}

/* ── Editing commands: every write goes through engine/definitions.ts ───── */

async function pauseResume(name: string | undefined, all: boolean, enabled: boolean, json: boolean): Promise<Exit> {
  if (all) {
    if (name !== undefined) throw new UsageError("--all takes no workflow name.");
    setGlobalPause(!enabled, ledgerPath());
    emit(json, { ok: true, all: true, paused: !enabled }, [enabled ? "fleet resumed: the global pause is lifted" : "fleet paused: nothing new starts until: workflow resume --all"]);
    return EXIT.ok;
  }
  if (name === undefined) throw new UsageError(`"${enabled ? "resume" : "pause"}" takes a workflow name or --all. Usage: ${usageOf(enabled ? "resume" : "pause")}`);
  const result = await editDefinition(requireName(name), setEnabled(enabled));
  if (!result.ok) return editOutcome(json, result, () => []);
  // ISC-121: the launchd job follows the switch before this returns: paused unloads it, resumed loads it again.
  const launchd = await syncLaunchd(name, result.definition.triggers, enabled);
  return editOutcome(json, result, done => [
    `${enabled ? "resumed" : "paused"} ${done.name}${done.detail.changed === false ? " (already)" : ""}`,
    ...(launchd.touched ? [`  launchd: ${launchd.reason}`] : []),
  ], () => ({ launchd }));
}

async function linkCommand(upstream: string, downstream: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  requireName(upstream, "an upstream workflow name");
  requireName(downstream, "a downstream workflow name");
  const status = flagText(flags, "--status") ?? "succeeded";
  if (status !== "succeeded" && status !== "failed" && status !== "completed") throw new UsageError(`--status must be succeeded, failed or completed, not "${status}".`);
  const result = await editDefinition(downstream, addAfterLink(upstream, status));
  if (result.ok) return editOutcome(json, result, () => [`linked: ${downstream} runs after ${upstream} (${status})`], () => ({ upstream, downstream, status }));
  const mismatch = result.issues.some(i => i.code === "type-mismatch");
  const schemas = mismatch ? linkSchemas(upstream, downstream) : {};
  const code = editOutcome(json, result, () => [], () => ({}), { upstream, downstream, ...schemas });
  if (mismatch && !json) {
    console.log(`  ${upstream} output:  ${JSON.stringify((schemas as { upstream_output?: unknown }).upstream_output)}`);
    console.log(`  ${downstream} input:  ${JSON.stringify((schemas as { downstream_input?: unknown }).downstream_input)}`);
  }
  return code;
}


async function scheduleCommand(name: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  requireName(name);
  const cron = flagText(flags, "--cron");
  const tz = flagText(flags, "--tz");
  const every = flagText(flags, "--every");
  const at = flagText(flags, "--at");
  const inside = flagText(flags, "--in");
  const remove = flagText(flags, "--remove");
  const given = [cron, every, at, inside, remove].filter(v => v !== undefined).length;
  if (given !== 1) throw new UsageError("schedule needs exactly one of --cron (with --tz), --every, --at, --in or --remove.");
  if (tz !== undefined && cron === undefined) throw new UsageError("--tz belongs to --cron.");
  let change: ScheduleChange;
  if (cron !== undefined) {
    if (!tz) throw new UsageError("--cron needs --tz (an IANA time zone such as Europe/London); there is no silent UTC default.");
    change = { action: "cron", cron, timezone: tz };
  } else if (every !== undefined) {
    const minutes = parseMinutes(every);
    if (minutes === null) throw new UsageError(`--every "${every}" is not a number of minutes (or 90m, 2h, 1d).`);
    change = { action: "every", minutes };
  } else if (at !== undefined) {
    if (!Number.isFinite(Date.parse(at))) throw new UsageError(`--at "${at}" is not an ISO time.`);
    change = { action: "at", at };
  } else if (inside !== undefined) {
    const minutes = parseMinutes(inside);
    if (minutes === null) throw new UsageError(`--in "${inside}" is not a duration (20m, 2h, 1d).`);
    change = { action: "in", minutes };
  } else change = { action: "remove", target: remove as string };
  const result = await editDefinition(name, changeSchedule(change));
  if (!result.ok) return editOutcome(json, result, () => []);
  const launchd = await syncLaunchd(name, result.definition.triggers, result.definition.enabled !== false);
  return editOutcome(json, result, done => [
    change.action === "remove" ? `removed trigger from ${done.name}` : `scheduled ${done.name}: ${JSON.stringify(done.detail.trigger)}`,
    `  launchd: ${launchd.installed ? "installed" : `not installed (${launchd.reason})`}`,
  ], () => ({ launchd }));
}

async function setCommand(name: string, key: string, value: string, json: boolean): Promise<Exit> {
  requireName(name);
  if (key !== "runs_on") throw new UsageError(`set changes runs_on only, not "${key}".`);
  if (value !== "local" && value !== "cloud") throw new UsageError(`runs_on must be local or cloud, not "${value}".`);
  const result = await editDefinition(name, setRunsOn(value));
  return editOutcome(json, result, done => [`${done.name} runs_on ${done.detail.was} -> ${value}`]);
}

async function renameCommand(from: string, to: string, json: boolean): Promise<Exit> {
  requireName(from);
  requireName(to, "a new workflow name");
  const result = await renameDefinition(from, to);
  if (!result.ok) return editOutcome(json, result, () => []);
  emit(json, { ok: true, from, to, name: to, path: shown(result.path), rewritten: result.rewritten }, [
    `renamed ${from} -> ${to} (${shown(result.path)})`,
    ...result.rewritten.map(w => `  repointed ${w}`),
  ]);
  return EXIT.ok;
}

/* ── Step editing, show and put (ISA F17) ───────────────────────────────── */

function showCommand(name: string, json: boolean): Exit {
  requireName(name);
  const got = readDefinitionText(name);
  if (!got) {
    emit(json, { ok: false, error: `No workflow named "${name}" in ${definitionsDir()}.` }, [`No workflow named "${name}".`]);
    return EXIT.failed;
  }
  if (json) emit(true, { ok: true, name, path: shown(got.path), hash: got.hash, text: got.text }, []);
  else process.stdout.write(`# ${shown(got.path)}  ${got.hash}\n${got.text}`);
  return EXIT.ok;
}

function fieldsFlag(flags: Map<string, string | true>): StepFieldPatch {
  const raw = flagText(flags, "--fields");
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError("--fields must be a JSON object.");
  }
  try {
    return checkStepPatch(parsed);
  } catch (error) {
    if (error instanceof Refusal) throw new UsageError(error.message);
    throw error;
  }
}

async function stepCommand(positional: string[], flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  const [verb, name, a, b] = positional;
  requireName(name);
  const baseHash = flagText(flags, "--base-hash");
  const need = (count: number) => {
    if (positional.length !== count + 1) throw new UsageError(`step ${verb} takes ${count} arguments. Usage: ${usageOf("step")}`);
  };
  let mutator: Mutator;
  let line: (done: EditDone) => string;
  switch (verb) {
    case "add": {
      need(2);
      const kind = flagText(flags, "--kind");
      if (!kind) throw new UsageError("step add needs --kind.");
      const needs = (flagText(flags, "--needs") ?? "").split(",").map(n => n.trim()).filter(Boolean);
      mutator = addStep(a, kind, fieldsFlag(flags), needs);
      line = done => `added step ${a} (${kind}) to ${done.name}${needs.length ? `, after ${needs.join(", ")}` : ""}`;
      break;
    }
    case "set": {
      need(2);
      const fields = fieldsFlag(flags);
      mutator = setStepFields(a, fields);
      line = done => `set ${Object.keys(fields).join(", ")} on ${done.name}.${a}`;
      break;
    }
    case "remove":
      need(2);
      mutator = removeStep(a);
      line = done => `removed step ${a} from ${done.name}`;
      break;
    case "connect":
      need(3);
      mutator = connectSteps(a, b);
      line = done => `${done.name}: ${b} now runs after ${a}`;
      break;
    case "disconnect":
      need(3);
      mutator = disconnectSteps(a, b);
      line = done => `${done.name}: ${b} no longer runs after ${a}`;
      break;
    default:
      throw new UsageError(`step takes add, set, remove, connect or disconnect, not "${verb}".`);
  }
  const result = await editDefinition(name, mutator, baseHash !== undefined ? { baseHash } : {});
  return editOutcome(json, result, done => [line(done)], done => ({ hash: done.hash }));
}

async function putCommand(name: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  requireName(name);
  const file = flagText(flags, "--file");
  if (!file) throw new UsageError("put needs --file PATH (or - for stdin).");
  const text = file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8");
  const baseHash = flagText(flags, "--base-hash");
  const result = await replaceDefinition(name, text, baseHash !== undefined ? { baseHash } : {});
  if (!result.ok) return editOutcome(json, result, () => []);
  const launchd = launchdChanged(result) ? await syncLaunchd(name, result.definition.triggers, result.definition.enabled !== false) : null;
  return editOutcome(json, result, done => [
    `replaced ${done.name}${done.detail.changed === false ? " (unchanged)" : ""}`,
    ...(launchd?.touched ? [`  launchd: ${launchd.reason}`] : []),
  ], done => ({ hash: done.hash, ...(launchd ? { launchd } : {}) }));
}

async function removeCommand(name: string, flags: Map<string, string | true>, json: boolean): Promise<Exit> {
  requireName(name);
  const baseHash = flagText(flags, "--base-hash");
  const result = await removeWorkflow(name, baseHash !== undefined ? { baseHash } : {});
  if (!result.ok) return editOutcome(json, result, () => []);
  const launchd = await syncLaunchd(name, result.before?.triggers ?? [], false);
  emit(json, { ok: true, name, removed: shown(result.path), launchd }, [`removed ${name} (${shown(result.path)})`, ...(launchd.touched ? [`  launchd: ${launchd.reason}`] : [])]);
  return EXIT.ok;
}

/* ── Runs, stop, test, emit ─────────────────────────────────────────────── */

function runsCommand(name: string | undefined, flags: Map<string, string | true>, json: boolean): Exit {
  if (name !== undefined) requireName(name);
  const ledger = ledgerPath();
  if (flags.get("--active") === true) {
    for (const f of ["--status", "--since", "--limit"]) if (flags.has(f)) throw new UsageError(`${f} filters the ledger; it does not go with --active.`);
    const active = activeRuns(ledger, name);
    const queued = queuedOccurrences(ledger, definitionsDir(), name);
    emit(json, { ok: true, active, queued }, [
      active.length ? `${active.length} in flight` : "nothing in flight",
      ...active.map(r => `  ${r.workflow}  ${r.run_id}  since ${r.started_at}${r.overdue ? "  (past its deadline)" : ""}`),
      queued.length ? `${queued.length} queued` : "nothing queued",
      ...queued.map(q => `  ${q.workflow}  event ${q.event}  ${q.emitted_at}`),
    ]);
    return EXIT.ok;
  }
  const status = flagText(flags, "--status");
  if (status !== undefined && !["succeeded", "failed", "abandoned", "stopped"].includes(status)) throw new UsageError(`--status must be succeeded, failed, abandoned or stopped, not "${status}".`);
  const sinceText = flagText(flags, "--since");
  let since: number | undefined;
  if (sinceText !== undefined) {
    const parsed = parseSince(sinceText);
    if (parsed === null) throw new UsageError(`--since "${sinceText}" is neither an ISO time nor a duration such as 90m, 6h, 2d.`);
    since = parsed;
  }
  const limitText = flagText(flags, "--limit");
  if (limitText !== undefined && !/^[1-9]\d{0,5}$/.test(limitText)) throw new UsageError("--limit must be a positive number.");
  const runs = listRuns(ledger, { workflow: name, status, since, limit: limitText ? Number(limitText) : undefined });
  emit(json, { ok: true, runs }, runs.length ? runs.map(r => `${r.finished_at}  ${r.status.padEnd(9)}  ${r.workflow}  ${r.run_id}`) : ["No runs match."]);
  return EXIT.ok;
}

function stopCommand(runId: string, json: boolean): Exit {
  const result = stopRun(runId);
  emit(json, result, [result.ok ? `stopped ${result.workflow} run ${runId}` : `Not stopped: ${result.error}`]);
  return result.ok ? EXIT.ok : EXIT.failed;
}

async function testCommand(name: string, json: boolean): Promise<Exit> {
  requireName(name);
  const result = await testDefinition(name);
  emit(json, { ...result }, [
    result.error ? `Cannot test: ${result.error}` : `${result.ok ? "passed" : "FAILED"}: ${name} (${result.results.filter(r => r.passed).length}/${result.results.length} fixtures)`,
    ...result.results.flatMap(r => [`  ${r.passed ? "ok  " : "FAIL"}  ${r.fixture}${r.stubbed.length ? `  [stubbed: ${r.stubbed.join(", ")}]` : ""}`, ...r.failures.map(f => `        ${f}`)]),
  ]);
  return result.ok ? EXIT.ok : EXIT.failed;
}

function emitCommand(name: string, flags: Map<string, string | true>, json: boolean): Exit {
  if (!EVENT_NAME_RE.test(name)) throw new UsageError(`"${name}" is not an event name: letters, digits and . _ : - only.`);
  const input = parseJsonFlag(flags, "--input") ?? {};
  const { event, path } = emitEvent(name, input);
  const targets = eventTargets(name);
  emit(json, { ok: true, event: name, event_id: event.id, path, emitted_at: event.emitted_at, targets }, [
    `emitted ${name} (${event.id})`,
    targets.length ? `  will start: ${targets.join(", ")}` : "  no enabled workflow listens for it yet",
  ]);
  return EXIT.ok;
}

/* ── Deploy and contracts ───────────────────────────────────────────────── */

/** The review waivers `workflow deploy` forwards, each with its reason. */
export interface DeployWaivers { allowDirty?: string; waiveBlockers?: string }

/** The retired one-reason review override; the deploy script, CfEnv and Review.ts refuse it the same way. */
const RETIRED_ACCEPT = `--accept is retired. Use --allow-dirty "<reason>" to ship uncommitted files in the deploy dir (the model review still runs), or --waive-blockers "<reason>" to ship past model blockers, a reviewer outage or an over-limit diff (never uncommitted files).`;

/**
 * The gated deploy script's path and arguments. `--allow-dirty <reason>` and
 * `--waive-blockers <reason>` are passed through untouched; the script judges each
 * reason and refuses a bad one before any build.
 */
export function deployScriptArgv(name: string, confirm: string | undefined, waivers: DeployWaivers, json: boolean): string[] {
  return [
    join(import.meta.dir, "cloud", "deploy.ts"),
    name,
    ...(confirm !== undefined ? ["--confirm", confirm] : []),
    ...(waivers.allowDirty !== undefined ? ["--allow-dirty", waivers.allowDirty] : []),
    ...(waivers.waiveBlockers !== undefined ? ["--waive-blockers", waivers.waiveBlockers] : []),
    ...(json ? ["--json"] : []),
  ];
}

/** Hands the whole job to the gated deploy script; this file never uploads anything itself. */
function deployCommand(name: string, confirm: string | undefined, waivers: DeployWaivers, json: boolean): Exit {
  requireName(name);
  const child = Bun.spawnSync([process.execPath, ...deployScriptArgv(name, confirm, waivers, json)], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (child.stdout.length) process.stdout.write(child.stdout);
  if (child.stderr.length) process.stderr.write(child.stderr);
  if (child.exitCode === 0) return EXIT.ok;
  return child.exitCode === 2 ? EXIT.usage : EXIT.failed;
}

function contractsCommand(name: string | undefined, json: boolean): Exit {
  if (name !== undefined) requireName(name);
  const report = contractReport(definitionsDir(), name);
  emit(json, { ...report, definitions_home: definitionsDir() }, report.actions.length
    ? [...report.actions.map(a => `${a.loose ? "LOOSE   " : "specific"}  ${a.action}  input ${a.input}, output ${a.output}  (used by ${a.used_by.join(", ")})`), ...(report.ok ? [] : ["Loose or unreadable contracts: " + report.loose_actions.join(", ")])]
    : ["No actions used by any v2 definition."]);
  return report.ok ? EXIT.ok : EXIT.failed;
}

/* ── Main ───────────────────────────────────────────────────────────────── */

export async function main(argv: string[]): Promise<Exit> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const json = argv.includes("--json");
    emit(json, { ok: false, error: message(error), usage: "workflow help" }, [`usage error: ${message(error)}`, "Run: bun LIFEOS/WORKFLOWS/workflow.ts help"]);
    return EXIT.usage;
  }
  const { command, positional, flags, json } = parsed;
  try {
    switch (command) {
      case "help": return help(json);
      case "new": return await create(positional[0], flags, json);
      case "list": return list(json);
      case "validate": return await validate(positional[0], json);
      case "graph": return await graph(positional[0], json);
      case "next": return next(positional[0], flagText(flags, "--at"), json);
      case "run": return await run(positional[0], flags, json);
      case "pause": return await pauseResume(positional[0], flags.get("--all") === true, false, json);
      case "resume": return await pauseResume(positional[0], flags.get("--all") === true, true, json);
      case "link": return await linkCommand(positional[0], positional[1], flags, json);
      case "schedule": return await scheduleCommand(positional[0], flags, json);
      case "set": return await setCommand(positional[0], positional[1], positional[2], json);
      case "rename": return await renameCommand(positional[0], positional[1], json);
      case "runs": return runsCommand(positional[0], flags, json);
      case "stop": return stopCommand(positional[0], json);
      case "test": return await testCommand(positional[0], json);
      case "emit": return emitCommand(positional[0], flags, json);
      case "deploy": return deployCommand(positional[0], flagText(flags, "--confirm"), { allowDirty: flagText(flags, "--allow-dirty"), waiveBlockers: flagText(flags, "--waive-blockers") }, json);
      case "contracts": return contractsCommand(positional[0], json);
      case "show": return showCommand(positional[0], json);
      case "step": return await stepCommand(positional, flags, json);
      case "put": return await putCommand(positional[0], flags, json);
      case "remove": return await removeCommand(positional[0], flags, json);
      default: throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      emit(json, { ok: false, error: error.message, usage: "workflow help" }, [`usage error: ${error.message}`]);
      return EXIT.usage;
    }
    // An impossible state is never softened into a result: it crashes with its stack.
    if (error instanceof InvariantViolation) throw error;
    // Anything else unexpected fails loud with context, exit 1.
    emit(json, { ok: false, error: message(error) }, [`error: ${message(error)}`]);
    return EXIT.failed;
  }
}

/**
 * Commands that execute step bodies (command, agent and model steps). They never receive the
 * account-wide Cloudflare keys in their environment: the entry point drops them before any step
 * runs (dropCloudEnv), because those keys exist for the read-only cloud secret check
 * (cloud/credentials.ts), not for code a definition runs.
 */
const STEP_EXECUTING_COMMANDS: ReadonlySet<string> = new Set(["run", "test", "emit", "step"]);
export function commandLoadsCloudEnv(command: string | undefined): boolean {
  return !STEP_EXECUTING_COMMANDS.has(command ?? "");
}

if (import.meta.main) {
  // The cloud secret check needs the two Cloudflare keys; the real definitions home only, so a test home never reads them.
  // A command that executes steps never loads them and drops any already in the environment
  // (a launching shell, bun's .env auto-load), so no step child or agent session can inherit them.
  if (!commandLoadsCloudEnv(process.argv[2])) dropCloudEnv();
  else if (!process.env.LIFEOS_WORKFLOWS_DIR) loadCloudEnvFile();
  process.exitCode = await main(process.argv.slice(2));
}
