/**
 * The `workflow new --template <kind>` catalog (ISA ISC-74).
 *
 * Each template is a complete, commented v2 definition that validates as
 * written (a test builds every one and checks it). `help --json` lists the
 * catalog from `TEMPLATE_CATALOG`, so the list a person sees and the list the
 * command accepts cannot drift.
 */
import { NAME_RE } from "./paths.ts";

export type TemplateKind = "scheduled" | "event" | "after-chain" | "human-approval" | "model-typed";

export interface TemplateOptions {
  /** after-chain: the upstream workflow this one runs after. */
  after?: string;
  /** after-chain: the upstream's output schema; becomes this workflow's input so the link type-checks. */
  upstreamOutput?: unknown;
}

export interface TemplateInfo {
  kind: TemplateKind;
  summary: string;
  /** Extra options the template needs, as CLI flags. */
  requires: string[];
}

export const TEMPLATE_CATALOG: TemplateInfo[] = [
  { kind: "scheduled", summary: "Runs on a daily cron and can also be run by hand.", requires: [] },
  { kind: "event", summary: "Runs when the named event `<name>.requested` is emitted with `workflow emit`.", requires: [] },
  { kind: "after-chain", summary: "Runs after another workflow succeeds, taking that workflow's output as its input.", requires: ["--after <upstream>"] },
  { kind: "human-approval", summary: "Drafts, waits for a human decision, then takes an outbound action.", requires: [] },
  { kind: "model-typed", summary: "One model step whose answer must match a declared output schema.", requires: [] },
];

export const templateKinds = (): TemplateKind[] => TEMPLATE_CATALOG.map(t => t.kind);
export const isTemplateKind = (kind: string): kind is TemplateKind => (templateKinds() as string[]).includes(kind);

const validate = (name: string, hint: string): string[] => [
  `# ${name} — ${hint}`,
  `# Validate: bun LIFEOS/WORKFLOWS/workflow.ts validate ${name}`,
];

const ECHO = 'argv: [bun, -e, "process.stdout.write(JSON.stringify(await Bun.stdin.json()))"]';

/** A YAML block for a schema, indented under `indent` spaces, as JSON flow style (valid YAML). */
const flow = (value: unknown): string => JSON.stringify(value);

export function renderTemplate(kind: TemplateKind, name: string, opts: TemplateOptions = {}): string {
  if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a workflow name`);
  switch (kind) {
    case "scheduled":
      return [
        ...validate(name, "a workflow that runs on a schedule."),
        "# Change the time with: workflow schedule " + name + " --cron '30 7 * * *' --tz <your IANA zone, e.g. Europe/London>",
        "version: 2",
        `name: ${name}`,
        "runs_on: local",
        "triggers:",
        "  - type: schedule",
        '    cron: "0 9 * * *"',
        "    timezone: UTC",
        "  - type: manual",
        "steps:",
        "  tick:",
        "    kind: command",
        "    side_effects: [none]",
        '    argv: [bun, -e, "process.stdout.write(JSON.stringify({ at: new Date().toISOString() }))"]',
        `    output: ${flow({ type: "object", required: ["at"], properties: { at: { type: "string" } } })}`,
        "result: { $ref: steps.tick.output }",
        "",
      ].join("\n");
    case "event":
      return [
        ...validate(name, "a workflow started by a named event."),
        `# Start it with: workflow emit ${name}.requested --input '{"text":"hello"}'`,
        "version: 2",
        `name: ${name}`,
        "runs_on: local",
        "triggers:",
        "  - type: event",
        `    name: ${name}.requested`,
        "  - type: manual",
        `input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "steps:",
        "  echo:",
        "    kind: command",
        "    side_effects: [none]",
        `    ${ECHO}`,
        `    input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        `    output: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "result: { $ref: steps.echo.output }",
        "",
      ].join("\n");
    case "after-chain": {
      if (!opts.after || !NAME_RE.test(opts.after)) throw new Error("The after-chain template needs the upstream workflow name (--after <upstream>).");
      const input = opts.upstreamOutput ?? { type: "object", properties: {} };
      return [
        ...validate(name, `runs after ${opts.after} succeeds.`),
        `# Its input is the output ${opts.after} declares; change ${opts.after} and re-validate to see whether the link still fits.`,
        "version: 2",
        `name: ${name}`,
        "runs_on: local",
        "triggers:",
        "  - type: after",
        `    workflow: ${opts.after}`,
        "    status: succeeded",
        `input: ${flow(input)}`,
        "steps:",
        "  pass:",
        "    kind: command",
        "    side_effects: [none]",
        `    ${ECHO}`,
        `    input: ${flow(input)}`,
        `    output: ${flow(input)}`,
        "result: { $ref: steps.pass.output }",
        "",
      ].join("\n");
    }
    case "human-approval":
      return [
        ...validate(name, "drafts, waits for a person to approve, then acts."),
        "# The outbound step declares a side effect, so validation requires the human step among its ancestors;",
        "# its when: skips it on a decline, and the runner refuses it on a decline even without the when.",
        "version: 2",
        `name: ${name}`,
        "runs_on: local",
        "triggers:",
        "  - type: manual",
        `input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "steps:",
        "  draft:",
        "    kind: command",
        "    side_effects: [none]",
        `    ${ECHO}`,
        `    input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        `    output: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "  approve:",
        "    kind: human",
        "    needs: [draft]",
        "    prompt: Approve this draft before it goes out?",
        "  send:",
        "    kind: command",
        "    needs: [approve]",
        "    when: { ref: steps.approve.output.approved, equals: true }",
        "    side_effects: [outbound]",
        `    ${ECHO}`,
        `    input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        `    output: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "    with:",
        "      text: { $ref: steps.draft.output.text }",
        "result: { $ref: steps.send.output }",
        "",
      ].join("\n");
    case "model-typed":
      return [
        ...validate(name, "one model step with a typed answer."),
        "# The model's answer is checked against the output schema; a reply that does not fit fails the step.",
        "version: 2",
        `name: ${name}`,
        "runs_on: local",
        "triggers:",
        "  - type: manual",
        `input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        "steps:",
        "  classify:",
        "    kind: model",
        "    lane: openaiLow",
        "    prompt: Say in one word whether the text is positive, negative or neutral.",
        `    input: ${flow({ type: "object", required: ["text"], properties: { text: { type: "string" } } })}`,
        `    output: ${flow({ type: "object", required: ["sentiment"], properties: { sentiment: { enum: ["positive", "negative", "neutral"] } } })}`,
        "    with:",
        "      text: { $ref: input.text }",
        "result: { $ref: steps.classify.output }",
        "",
      ].join("\n");
  }
}
