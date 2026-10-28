/**
 * The one door from Workflows v2 into the v1 engine.
 *
 * Every v1 import in the v2 layer comes through this file, so the boundary
 * is one place to read: v2 IMPORTS the v1 engine, schema, contracts, triggers,
 * YAML loader and local action registry, and never writes under LIFEOS/WORKFLOWS/v1.
 * The production fleet keeps running on the
 * same source unchanged while v2 is built on top of it (ISA F0, Decisions
 * 2026-09-26).
 */
export {
  describeWorkflow,
  parseWorkflow,
  runWorkflow,
  validateWorkflow,
  type ActionRegistry,
  type StepPolicy,
  type Workflow as V1Workflow,
  type WorkflowResult as V1Result,
  type WorkflowStep as V1Step,
} from "../v1/Workflows/engine.ts";
export { assertSchema, compileSchema, normalizeActionSchema } from "../v1/Workflows/schema.ts";
export { schemaAtPath, validateInputMapping } from "../v1/Workflows/contracts.ts";
export { nextScheduledAt, validateTrigger as validateV1Trigger } from "../v1/Workflows/triggers.ts";
export { parseWorkflowYaml as parseV1Yaml } from "../v1/Workflows/load.ts";
export { localActionRegistry } from "../v1/Workflows/local.ts";
