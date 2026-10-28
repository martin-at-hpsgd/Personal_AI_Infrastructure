/** Test fixtures for the schedule, queue and dispatcher tests: synthesized definitions only. */
import { stringify } from "yaml";
import { type DefinitionV2, parseDefinitionText } from "./format.ts";
import { js, objectOf } from "./test-helpers.ts";

export function schedDef(name: string, triggers: unknown[], extra: Record<string, unknown> = {}, argv: string[] = js("process.stdout.write(JSON.stringify({ ok: true }))")): DefinitionV2 {
  const doc = {
    version: 2, name, runs_on: "local", triggers,
    steps: { go: { kind: "command", side_effects: ["none"], argv, input: objectOf({}), output: objectOf({ ok: { type: "boolean" } }) } },
    ...extra,
  };
  return parseDefinitionText(stringify(doc), `${name}.workflow.yaml`);
}
