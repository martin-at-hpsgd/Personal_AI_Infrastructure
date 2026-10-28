/**
 * ISC-90: validate every definition in the definitions home. The rules are the ones
 * `workflow.ts validate` applies (analyzeLoaded): parse, resolve actions, analyze, and
 * count an action unavailable locally as an error for a `runs_on: local` workflow.
 * Used by the /ic `workflow-definitions` section; pure reads, no writes.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeDefinition, loadDefinitionFile, message } from "../engine/format.ts";
import { DEFINITION_SUFFIX, definitionsDir } from "../engine/paths.ts";
import { definitionResolver, resolveActions } from "../engine/runner.ts";

export interface DefinitionVerdict {
  file: string;
  valid: boolean;
  errors: string[];
}

export interface DefinitionsReport {
  dir: string;
  /** False when the definitions home does not exist (nothing to validate). */
  present: boolean;
  verdicts: DefinitionVerdict[];
}

export async function validateDefinitions(dir: string = definitionsDir()): Promise<DefinitionsReport> {
  if (!existsSync(dir)) return { dir, present: false, verdicts: [] };
  const resolveWorkflow = definitionResolver(dir);
  const verdicts: DefinitionVerdict[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith(DEFINITION_SUFFIX)).sort()) {
    try {
      const loaded = loadDefinitionFile(join(dir, file));
      const actions = await resolveActions(loaded.def);
      const analysis = analyzeDefinition(loaded.def, { contracts: actions.contracts, resolveWorkflow });
      const errors = [...analysis.errors];
      if (loaded.def.runs_on === "local") {
        for (const [name, why] of actions.missing) errors.push(`Action ${name} is not available locally: ${why}`);
      }
      verdicts.push({ file, valid: errors.length === 0, errors });
    } catch (error) {
      verdicts.push({ file, valid: false, errors: [message(error)] });
    }
  }
  return { dir, present: true, verdicts };
}
