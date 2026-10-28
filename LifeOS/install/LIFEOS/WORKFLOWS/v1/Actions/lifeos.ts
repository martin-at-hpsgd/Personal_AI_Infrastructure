#!/usr/bin/env bun
/**
 * ============================================================================
 * LifeOS CLI - Unified Actions & Pipelines Interface
 * ============================================================================
 *
 * The main entry point for running LifeOS actions and pipelines.
 *
 * USAGE (invoked as `bun ~/.claude/LIFEOS/WORKFLOWS/v1/Actions/lifeos.ts`):
 *   # Run an action
 *   bun lifeos.ts action A_EXAMPLE_FORMAT --input '{"summary":"Qubits hold superpositions.","title":"Quantum"}'
 *   echo '{"summary":"Qubits hold superpositions."}' | bun lifeos.ts action A_EXAMPLE_FORMAT
 *
 *   # Run a pipeline
 *   bun lifeos.ts pipeline P_EXAMPLE_FORMAT --summary "Qubits hold superpositions."
 *
 *   # Piping actions together (A_EXAMPLE_SUMMARIZE needs an LLM provider)
 *   bun lifeos.ts action A_EXAMPLE_SUMMARIZE --input '{"content":"..."}' | bun lifeos.ts action A_EXAMPLE_FORMAT
 *
 *   # List available actions/pipelines
 *   bun lifeos.ts actions
 *   bun lifeos.ts pipelines
 *
 *   # Show action/pipeline info
 *   bun lifeos.ts info A_EXAMPLE_FORMAT
 *
 * OPTIONS:
 *   --mode local|cloud    Execution mode (default: local)
 *   --input '<json>'      Input as JSON string
 *   --verbose             Show execution details
 *
 * ============================================================================
 */

import { runAction, listActionsV2 as listActions, findAction, loadManifest } from "./lib/runner.v2";
import { runPipeline, listPipelines } from './lib/pipeline-runner';
import { workflowCommand } from '../Workflows/cli';

interface CLIOptions {
  mode: "local" | "cloud";
  verbose: boolean;
  input?: string;
}

function parseArgs(args: string[]): { command: string; target?: string; options: CLIOptions; extra: Record<string, string> } {
  const options: CLIOptions = { mode: "local", verbose: false };
  const extra: Record<string, string> = {};
  let command = "";
  let target: string | undefined;
  let expectingValue: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (expectingValue) {
      if (expectingValue === "mode") options.mode = arg as "local" | "cloud";
      else if (expectingValue === "input") options.input = arg;
      else extra[expectingValue] = arg;
      expectingValue = null;
      continue;
    }

    if (arg === "--mode") { expectingValue = "mode"; continue; }
    if (arg === "--input") { expectingValue = "input"; continue; }
    if (arg === "--verbose" || arg === "-v") { options.verbose = true; continue; }
    if (arg.startsWith("--")) { expectingValue = arg.slice(2); continue; }

    if (!command) { command = arg; continue; }
    if (!target) { target = arg; continue; }
  }

  return { command, target, options, extra };
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString().trim();
  return content || null;
}


async function showHelp() {
  console.log(`
LifeOS - Personal AI Actions & Pipelines

USAGE (via: bun ~/.claude/LIFEOS/WORKFLOWS/v1/Actions/lifeos.ts):
  lifeos.ts action <name> [--input '<json>']     Run an action
  lifeos.ts pipeline <name> [--<param> <value>]  Run a pipeline
  lifeos.ts actions                               List all actions
  lifeos.ts pipelines                             List all pipelines
  lifeos.ts info <name>                           Show action/pipeline details
  lifeos.ts workflow <command> <file.yaml>         Validate, inspect, or run a workflow

OPTIONS:
  --mode local|cloud    Execution mode (default: local)
  --input '<json>'      Input as JSON string
  --verbose, -v         Show execution details

EXAMPLES:
  bun lifeos.ts action A_EXAMPLE_FORMAT --input '{"summary":"Qubits hold superpositions.","title":"Quantum"}'
  echo '{"summary":"AI tools help."}' | bun lifeos.ts action A_EXAMPLE_FORMAT
  bun lifeos.ts action A_EXAMPLE_SUMMARIZE --input '{"content":"..."}' | bun lifeos.ts action A_EXAMPLE_FORMAT
  bun lifeos.ts pipeline P_EXAMPLE_FORMAT --summary "Machine learning finds patterns."
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'workflow') { await workflowCommand(args.slice(1)); return; }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    await showHelp();
    return;
  }

  const { command, target, options, extra } = parseArgs(args);

  switch (command) {
    case "action": {
      if (!target) {
        console.error("Error: Action name required. Usage: lifeos.ts action <name>");
        process.exit(1);
      }

      // Get input from stdin, --input flag, or extra params
      let input: unknown;
      const stdinContent = await readStdin();

      if (stdinContent) {
        input = JSON.parse(stdinContent);
      } else if (options.input) {
        input = JSON.parse(options.input);
      } else if (Object.keys(extra).length > 0) {
        input = extra;
      } else {
        console.error("Error: No input provided. Use --input, pipe JSON, or pass --<param> <value>");
        process.exit(1);
      }

      if (options.verbose) {
        console.error(`[lifeos] Running action: ${target}`);
        console.error(`[lifeos] Mode: ${options.mode}`);
        console.error(`[lifeos] Input: ${JSON.stringify(input)}`);
      }

      const result = await runAction(target, input, { mode: options.mode });

      if (result.success) {
        console.log(JSON.stringify(result.output));
        if (options.verbose && result.metadata) {
          console.error(`[lifeos] Duration: ${result.metadata.durationMs}ms`);
        }
      } else {
        console.error(JSON.stringify({ error: result.error }));
        process.exit(1);
      }
      break;
    }

    case "pipeline": {
      if (!target) {
        console.error("Error: Pipeline name required. Usage: lifeos.ts pipeline <name>");
        process.exit(1);
      }
      if (options.mode !== 'local') throw new Error('Pipeline CLI runs locally; use a cloud host adapter for cloud execution');
      const stdinContent = options.input ? null : await readStdin();
      const input = options.input ? JSON.parse(options.input) : stdinContent ? JSON.parse(stdinContent) : extra;
      const result = await runPipeline(target, input);
      if (!result.success) throw new Error(result.error);
      console.log(JSON.stringify(result.output));
      break;
    }

    case "actions": {
      const actions = await listActions();
      console.log(JSON.stringify({ actions }, null, 2));
      break;
    }

    case "pipelines": {
      const pipelines = await listPipelines();
      console.log(JSON.stringify({ pipelines }, null, 2));
      break;
    }

    case "info": {
      if (!target) {
        console.error("Error: Name required. Usage: lifeos.ts info <action-or-pipeline-name>");
        process.exit(1);
      }

      // Try loading as action first
      try {
        const actionPath = await findAction(target);
        if (!actionPath) throw new Error('Not found');
        const action = await loadManifest(actionPath);
        console.log(JSON.stringify({
          type: "action",
          name: action.name,
          version: action.version,
          description: action.description,
          tags: action.tags,
          deployment: action.deployment,
          inputSchema: action.input,
          outputSchema: action.output,
        }, null, 2));
      } catch {
        console.error(`Not found: ${target}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      await showHelp();
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
