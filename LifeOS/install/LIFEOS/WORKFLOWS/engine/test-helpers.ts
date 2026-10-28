/**
 * Fixtures for the engine tests: synthesized definitions in throwaway
 * directories, a ledger that is never the real one, and a CLI spawner that
 * points both at those directories through the documented env overrides.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";

export const CLI = resolve(import.meta.dir, "..", "workflow.ts");
export const BUN = process.execPath;

export interface Sandbox {
  root: string;
  defs: string;
  ledger: string;
  marker: string;
  /** Writes `<name>.workflow.yaml` into the definitions home and returns its path. */
  put(name: string, doc: Record<string, unknown>): string;
  /** Writes raw YAML text at a path under the sandbox and returns it. */
  raw(file: string, text: string): string;
  ledgerLines(): string[];
  env(): Record<string, string>;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "workflows-engine-"));
  const defs = join(root, "defs");
  mkdirSync(defs, { recursive: true });
  const ledger = join(root, "state", "runs.jsonl");
  const marker = join(root, "marker.txt");
  return {
    root, defs, ledger, marker,
    put(name, doc) {
      const path = join(defs, `${name}.workflow.yaml`);
      writeFileSync(path, stringify(doc));
      return path;
    },
    raw(file, text) {
      const path = join(root, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    ledgerLines() {
      return existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean) : [];
    },
    env() {
      return { ...(process.env as Record<string, string>), LIFEOS_WORKFLOWS_DIR: defs, LIFEOS_WORKFLOWS_LEDGER: ledger };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A command step's argv: run `code` under this bun (no shell anywhere). */
export const js = (code: string): string[] => [BUN, "-e", code];

/** A command step that appends one byte to `marker` (proof it ran) and prints `output`. */
export const touching = (marker: string, output: unknown = {}): string[] =>
  js(`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); process.stdout.write(${JSON.stringify(JSON.stringify(output))})`);

export const objectOf = (props: Record<string, unknown>, required: string[] = Object.keys(props)) => ({ type: "object", required, properties: props });

export function cli(box: Sandbox, args: string[]): { code: number; stdout: string; stderr: string; json: any } {
  const result = Bun.spawnSync([BUN, CLI, ...args], { env: box.env(), cwd: box.root, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code: result.exitCode ?? -1, stdout, stderr: result.stderr.toString(), json };
}
