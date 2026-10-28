#!/usr/bin/env bun
/**
 * ============================================================================
 * LifeOS ACTIONS v2 - Runner with Capability Injection
 * ============================================================================
 *
 * Loads action packages (action.json + action.ts) and provides capabilities.
 *
 * ============================================================================
 */

import { readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import type {
  ActionManifest,
  ActionImplementation,
  ActionContext,
  ActionCapabilities,
  ActionResult,
  LLMOptions,
  LLMResponse,
} from "./types.v2";
import { compileSchema, normalizeActionSchema } from '../../Workflows/schema';
import { homedir } from "node:os";

const ACTIONS_DIR = dirname(import.meta.dir);
const USER_ACTIONS_DIR = join(ACTIONS_DIR, "..", "..", "..", "USER", "CUSTOMIZATIONS", "ARBOL", "ACTIONS");

/**
 * Local LLM provider using LifeOS's Inference tool
 */
async function createLocalLLM(): Promise<ActionCapabilities["llm"]> {
  const inferenceModule = await import(
    join((process.env.HOME ?? process.env.USERPROFILE ?? homedir()), ".claude/LIFEOS/TOOLS/Inference.ts")  // public issue #1919 item 2, @dissembler21-png
  );
  const { inference } = inferenceModule;

  return async (prompt: string, options?: LLMOptions): Promise<LLMResponse> => {
    // tier IS the Inference level since 2026-06-10 — one vocabulary, no map.
    const result = await inference({
      userPrompt: prompt,
      systemPrompt: options?.system,
      level: options?.tier || "low",
      expectJson: options?.json,
      maxTokens: options?.maxTokens,
    });

    if (!result.success) {
      throw new Error(result.error || "LLM inference failed");
    }

    return {
      text: result.output || "",
      json: result.parsed,
      usage: result.usage,
    };
  };
}

/**
 * Create capability providers for local execution
 */
async function createLocalCapabilities(
  required: ActionManifest["requires"] = []
): Promise<ActionCapabilities> {
  const capabilities: ActionCapabilities = {};

  for (const cap of required) {
    switch (cap) {
      case "llm":
        capabilities.llm = await createLocalLLM();
        break;
      case "fetch":
        capabilities.fetch = fetch;
        break;
      case "shell":
        capabilities.shell = async (cmd: string) => {
          const { $ } = await import("bun");
          try {
            const result = await $`sh -c ${cmd}`.quiet();
            return { stdout: result.text(), stderr: "", code: 0 };
          } catch (err: unknown) {
            const e = err as { stderr?: { toString(): string }; exitCode?: number };
            return {
              stdout: "",
              stderr: e.stderr?.toString() || String(err),
              code: e.exitCode || 1,
            };
          }
        };
        break;
      // readFile and writeFile are unconfined: no root, no path check. An action that declares
      // them (or `shell`) holds the user's full filesystem access, so only install actions you trust.
      case "readFile":
        capabilities.readFile = async (path: string) => {
          return Bun.file(path).text();
        };
        break;
      case "writeFile":
        capabilities.writeFile = async (path: string, content: string) => {
          await Bun.write(path, content);
        };
        break;
      // kv would need a backend - skip for now
    }
  }

  return capabilities;
}

/**
 * Load an action manifest from a directory
 */
export async function loadManifest(actionPath: string): Promise<ActionManifest> {
  const manifestPath = join(actionPath, "action.json");
  const content = await readFile(manifestPath, "utf-8");
  return JSON.parse(content) as ActionManifest;
}

/**
 * Load an action implementation
 */
export async function loadImplementation<TInput, TOutput>(
  actionPath: string
): Promise<ActionImplementation<TInput, TOutput>> {
  const implPath = join(actionPath, "action.ts");
  const module = await import(implPath);
  return module.default as ActionImplementation<TInput, TOutput>;
}

/**
 * Find action directory by name
 * Resolution order: USER/CUSTOMIZATIONS/ARBOL/ACTIONS (personal) → ACTIONS (system/framework)
 * Supports: A_NAME (flat, new) or category/name (legacy)
 */
export async function findAction(name: string): Promise<string | null> {
  if (!/^(?:A_[A-Z0-9_]+|[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+)$/.test(name)) return null;
  // New flat format: A_EXTRACT_TRANSCRIPT
  if (name.startsWith("A_")) {
    // Check USER/CUSTOMIZATIONS/ARBOL/ACTIONS first (personal actions override system)
    const userPath = join(USER_ACTIONS_DIR, name);
    try {
      await readFile(join(userPath, "action.json"), "utf-8");
      return userPath;
    } catch {}

    // Fall back to ACTIONS (system/framework)
    const systemPath = join(ACTIONS_DIR, name);
    try {
      await readFile(join(systemPath, "action.json"), "utf-8");
      return systemPath;
    } catch {
      return null;
    }
  }

  // Legacy format: category/name → check USER first, then SYSTEM
  const parts = name.split("/");
  if (parts.length !== 2) return null;

  const [category, actionName] = parts;

  // Check USER/CUSTOMIZATIONS/ARBOL/ACTIONS first
  const userPath = join(USER_ACTIONS_DIR, category, actionName);
  try {
    await readFile(join(userPath, "action.json"), "utf-8");
    return userPath;
  } catch {}

  // Fall back to ACTIONS (system)
  const systemPath = join(ACTIONS_DIR, category, actionName);
  try {
    await readFile(join(systemPath, "action.json"), "utf-8");
    return systemPath;
  } catch {
    return null;
  }
}

/**
 * Run an action with capability injection
 */
export async function runAction<TInput = unknown, TOutput = unknown>(
  name: string,
  input: TInput,
  options: { mode?: "local" | "cloud"; signal?: AbortSignal; pipeline?: ActionContext['pipeline'] } = {}
): Promise<ActionResult<TOutput>> {
  const startTime = Date.now();
  const mode = options.mode || "local";
  if (mode !== 'local') return { success: false, error: 'Cloud execution requires a host-provided action registry; this runner is local only' };

  // Find action
  const actionPath = await findAction(name);
  if (!actionPath) {
    return { success: false, error: `Action not found: ${name}` };
  }

  try {
    // Load manifest and implementation
    const manifest = await loadManifest(actionPath);
    const validateInput = compileSchema(normalizeActionSchema(manifest.input));
    const validateOutput = compileSchema(normalizeActionSchema(manifest.output));
    const inputValidation = validateInput(input);
    if (!inputValidation.valid) return { success: false, error: `Input validation failed: ${inputValidation.errors?.join(', ')}` };
    options.signal?.throwIfAborted();
    const implementation = await loadImplementation<TInput, TOutput>(actionPath);

    // Create capabilities
    const capabilities = await createLocalCapabilities(manifest.requires);

    // Create context
    const ctx: ActionContext = {
      capabilities,
      env: { mode },
      signal: options.signal,
      pipeline: options.pipeline,
    };

    // Execute
    const output = await implementation.execute(input, ctx);
    const outputValidation = validateOutput(output);
    if (!outputValidation.valid) return { success: false, error: `Output validation failed: ${outputValidation.errors?.join(', ')}` };

    return {
      success: true,
      output,
      metadata: {
        durationMs: Date.now() - startTime,
        action: manifest.name,
        version: manifest.version || "1.0.0",
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      metadata: {
        durationMs: Date.now() - startTime,
        action: name,
        version: "unknown",
      },
    };
  }
}

/**
 * List all actions from both USER (personal) and SYSTEM (framework) directories.
 * USER actions take precedence over SYSTEM actions with the same name.
 */
export async function listActionsV2(): Promise<ActionManifest[]> {
  const manifests: ActionManifest[] = [];
  const seen = new Set<string>();

  // Scan a directory for actions (A_ flat + legacy nested)
  async function scanDir(baseDir: string) {
    try {
      const entries = await readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === "lib") continue;

        if (entry.name.startsWith("A_")) {
          if (seen.has(entry.name)) continue;
          try {
            const manifest = await loadManifest(join(baseDir, entry.name));
            manifests.push(manifest);
            seen.add(entry.name);
          } catch {}
        } else {
          const catPath = join(baseDir, entry.name);
          try {
            const items = await readdir(catPath, { withFileTypes: true });
            for (const item of items) {
              if (!item.isDirectory()) continue;
              const key = `${entry.name}/${item.name}`;
              if (seen.has(key)) continue;
              try {
                const manifest = await loadManifest(join(catPath, item.name));
                manifests.push(manifest);
                seen.add(key);
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}
  }

  // USER first (personal takes precedence), then SYSTEM
  await scanDir(USER_ACTIONS_DIR);
  await scanDir(ACTIONS_DIR);

  return manifests;
}

/**
 * The action input from the words after `run <action>`: `--input '<json>'` (the documented form, as in the
 * workflow CLI) or the bare `'<json>'` positional. No words means an empty object.
 */
export function parseRunInput(rest: string[]): unknown {
  if (rest[0] === "--input") {
    if (rest[1] === undefined) throw new Error("--input needs a JSON value");
    return JSON.parse(rest[1]);
  }
  return rest[0] ? JSON.parse(rest[0]) : {};
}

// CLI support
if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "list") {
    const actions = await listActionsV2();
    console.log(JSON.stringify({ actions: actions.map(a => a.name) }, null, 2));
  } else if (cmd === "run" && args[1]) {
    const input = parseRunInput(args.slice(2));
    const result = await runAction(args[1], input);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Usage: runner.v2.ts list | run <action> [--input <json>]");
  }
}
