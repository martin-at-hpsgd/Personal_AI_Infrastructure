import { findAction, loadManifest, runAction } from '../Actions/lib/runner.v2';
import { normalizeActionSchema } from './schema';
import { validateWorkflow, type ActionRegistry, type Workflow } from './engine';

/** Reads manifests only; validation never imports an implementation or obtains credentials. */
export async function localActionRegistry(workflow: Workflow): Promise<ActionRegistry> {
  const registry: ActionRegistry = Object.create(null);
  for (const name of new Set(Object.values(workflow.steps).map(step => step.uses))) {
    const path = await findAction(name);
    if (!path) throw new Error(`Action not found: ${name}`);
    const manifest = await loadManifest(path);
    registry[name] = {
      input: normalizeActionSchema(manifest.input),
      output: normalizeActionSchema(manifest.output),
      async execute(input, context) {
        const result = await runAction(name, input, { signal: context.signal, pipeline: { name: context.workflow, stepId: context.step } });
        if (!result.success) throw new Error(result.error ?? `Action failed: ${name}`);
        return result.output;
      },
    };
  }
  validateWorkflow(workflow, registry);
  return registry;
}
