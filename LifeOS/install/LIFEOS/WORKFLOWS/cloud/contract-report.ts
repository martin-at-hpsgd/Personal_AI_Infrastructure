/**
 * `workflow contracts` (ISC-35): every action the v2 definitions use, with how
 * specific its input and output contracts are. Reuses cloud/contracts.ts, so the
 * CLI, the cloud build and this report share one definition of "loose".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDefinitionText } from "../engine/format.ts";
import { DEFINITION_SUFFIX } from "../engine/paths.ts";
import { resolveActionSource } from "../engine/runner.ts";
import { isSpecific } from "./contracts.ts";

export type Specificity = "specific" | "loose";

export interface ActionContractRow {
  action: string;
  /** The definitions that use this action. */
  used_by: string[];
  /** False when the action's manifest cannot be found or read; counted as loose. */
  available: boolean;
  input: Specificity | "unavailable";
  output: Specificity | "unavailable";
  loose: boolean;
  issues: string[];
}

export interface ContractReport {
  ok: boolean;
  definitions: string[];
  actions: ActionContractRow[];
  loose_actions: string[];
}

/** Reads the v2 definitions in `dir` (or just `only`) and reports each action they use. Invalid or v1 files are skipped. */
export function contractReport(dir: string, only?: string): ContractReport {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort() : [];
  const used = new Map<string, Set<string>>();
  const definitions: string[] = [];
  for (const file of files) {
    let def;
    try {
      def = parseDefinitionText(readFileSync(join(dir, file), "utf8"), join(dir, file));
    } catch {
      continue;
    }
    if (def.version !== 2 || (only && def.name !== only)) continue;
    definitions.push(def.name);
    for (const step of Object.values(def.steps)) {
      if (step.kind !== "action" || !step.uses) continue;
      if (!used.has(step.uses)) used.set(step.uses, new Set());
      used.get(step.uses)!.add(def.name);
    }
  }
  const actions: ActionContractRow[] = [...used.keys()].sort().map(action => {
    const used_by = [...used.get(action)!].sort();
    try {
      const manifest = JSON.parse(readFileSync(join(resolveActionSource(action).path, "action.json"), "utf8")) as { input?: unknown; output?: unknown };
      const input: Specificity = isSpecific(manifest.input) ? "specific" : "loose";
      const output: Specificity = isSpecific(manifest.output) ? "specific" : "loose";
      const issues = [...(input === "loose" ? [`${action} input contract is no narrower than {type: object}`] : []), ...(output === "loose" ? [`${action} output contract is no narrower than {type: object}`] : [])];
      return { action, used_by, available: true, input, output, loose: issues.length > 0, issues };
    } catch (error) {
      return { action, used_by, available: false, input: "unavailable", output: "unavailable", loose: true, issues: [`${action} contract could not be read (${error instanceof Error ? error.message : String(error)})`] };
    }
  });
  const loose_actions = actions.filter(a => a.loose).map(a => a.action);
  return { ok: loose_actions.length === 0, definitions, actions, loose_actions };
}
