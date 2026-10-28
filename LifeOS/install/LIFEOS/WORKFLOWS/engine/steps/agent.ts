/**
 * The `agent` step (ISC-29, ISC-126). The step's declared tool allowlist and
 * sandbox are written into the argv the runner spawns, and the argv is checked
 * for them before the spawn. That check proves what we asked codex for, not
 * what codex enforces: the sandbox (`--sandbox`, read-only by default) is the
 * enforced limit. The allowlist rides as `--config tools.allowlist=...`, which
 * is not a documented codex key (the installed binary names no such setting),
 * so treat it as advisory until codex is shown to honour it. The session ends through a
 * `submit_result` tool whose input schema is the step's output schema; a
 * submission that fails validation gets one repair attempt carrying the
 * validation errors, and a second failure fails the step.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invariant } from "../../../TOOLS/Invariant.ts";
import { compileSchema } from "../v1.ts";
import { DEFAULT_SANDBOX, SANDBOXES, type Sandbox } from "../format.ts";
import { costOf, laneModel, serviceTierFor } from "./model.ts";
import type { AgentClient, AgentReply, StepCost, Usage } from "./types.ts";

export const SUBMIT_TOOL = "submit_result";
/** Placeholder the live client swaps for the schema file it writes. */
export const SUBMIT_SCHEMA_ARG = "<submit_result schema>";

/**
 * The argv an agent session starts with. The tool allowlist is the declared
 * list plus submit_result, and nothing else; the sandbox is the declared one,
 * or read-only when none is declared (ISC-62).
 */
export function agentArgv(opts: { lane: string; sandbox?: Sandbox; tools?: readonly string[] }): string[] {
  const sandbox = opts.sandbox ?? DEFAULT_SANDBOX;
  invariant((SANDBOXES as readonly string[]).includes(sandbox), `Agent sandbox "${sandbox}" is not one of ${SANDBOXES.join(", ")}`);
  const tools = [...new Set([...(opts.tools ?? []), SUBMIT_TOOL])];
  return [
    "codex", "exec",
    "--model", laneModel(opts.lane),
    "--sandbox", sandbox,
    "--skip-git-repo-check", "--ephemeral",
    "--config", `tools.allowlist=${JSON.stringify(tools)}`,
    "--output-schema", SUBMIT_SCHEMA_ARG,
    "-",
  ];
}

/** Reads the allowlist and sandbox back off an argv: the assertion target for ISC-126. */
export function argvGrants(argv: readonly string[]): { sandbox: string | null; tools: string[] | null } {
  const at = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const allow = argv.find(a => a.startsWith("tools.allowlist="));
  return { sandbox: at("--sandbox"), tools: allow ? (JSON.parse(allow.slice("tools.allowlist=".length)) as string[]) : null };
}

export interface AgentStepCall {
  stepId: string;
  lane: string;
  prompt: string;
  input: unknown;
  output: unknown;
  tools?: string[];
  sandbox?: Sandbox;
  trigger: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface AgentStepResult {
  value: unknown;
  cost: StepCost;
  sessions: number;
}

function briefFor(call: AgentStepCall, repair?: string[]): string {
  const parts = [
    call.prompt,
    `Input (JSON):\n${JSON.stringify(call.input ?? null)}`,
    `Finish by calling ${SUBMIT_TOOL} exactly once with a value that matches its input schema.`,
  ];
  if (repair) parts.push(`Your previous ${SUBMIT_TOOL} value failed validation: ${repair.join("; ")}. Call ${SUBMIT_TOOL} again with a corrected value.`);
  return parts.join("\n\n");
}

export async function executeAgentStep(call: AgentStepCall, client: AgentClient): Promise<AgentStepResult> {
  invariant(call.output !== undefined, `Agent step "${call.stepId}" has no output schema for ${SUBMIT_TOOL}`);
  const argv = agentArgv({ lane: call.lane, sandbox: call.sandbox, tools: call.tools });
  const granted = argvGrants(argv);
  const expectedTools = [...new Set([...(call.tools ?? []), SUBMIT_TOOL])];
  invariant(granted.sandbox === (call.sandbox ?? DEFAULT_SANDBOX), `Agent step "${call.stepId}" argv sandbox differs from the declared one`);
  invariant(JSON.stringify(granted.tools) === JSON.stringify(expectedTools), `Agent step "${call.stepId}" argv tools differ from the declared allowlist`);
  const validate = compileSchema(call.output);
  const usage: Usage = { input_tokens: 0, output_tokens: 0 };
  let errors: string[] | undefined;
  for (let session = 1; session <= 2; session++) {
    const reply: AgentReply = await client.run({ argv, prompt: briefFor(call, errors), submitSchema: call.output, cwd: call.cwd, signal: call.signal });
    usage.input_tokens += reply.usage.input_tokens;
    usage.output_tokens += reply.usage.output_tokens;
    const cost = costOf(call.lane, laneModel(call.lane), usage, serviceTierFor(call.trigger));
    if (reply.submitted === undefined) {
      errors = [`the session ended without calling ${SUBMIT_TOOL}`];
    } else {
      const check = validate(reply.submitted);
      if (check.valid) return { value: reply.submitted, cost, sessions: session };
      errors = check.errors ?? ["invalid"];
    }
    if (session === 2) {
      const error = new Error(`Agent step "${call.stepId}" ${SUBMIT_TOOL} failed validation after one repair: ${errors.join("; ")}`) as Error & { cost?: StepCost };
      error.cost = cost;
      throw error;
    }
  }
  throw new Error("Unreachable agent session state.");
}

/* ── Live client: codex exec with --output-schema as the submit_result contract ── */

/**
 * The structured value at the end of a codex session's stdout, or undefined when there is none. The final
 * message may be one line or pretty-printed over many, and progress lines may precede it, so this tries the
 * whole output, then the longest trailing run of lines that parses as a JSON object or array.
 */
export function parseSubmitted(out: string): unknown {
  const text = out.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to the trailing block */
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const first = lines[i]!.trimStart()[0];
    if (first !== "{" && first !== "[") continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      /* not the start of the final value; keep looking up */
    }
  }
  const last = lines[lines.length - 1]!;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

/**
 * The production client: spawns the argv (no shell), prompt on stdin, the
 * final structured message is the submit_result value. Codex enforces the
 * schema on its last message; the executor validates again regardless.
 */
export const liveAgentClient: AgentClient = {
  async run(request) {
    const dir = mkdtempSync(join(tmpdir(), "workflow-agent-"));
    try {
      const schemaPath = join(dir, "submit_result.schema.json");
      writeFileSync(schemaPath, JSON.stringify(request.submitSchema));
      const argv = request.argv.map(a => (a === SUBMIT_SCHEMA_ARG ? schemaPath : a));
      const proc = Bun.spawn(argv, { cwd: request.cwd, stdin: new TextEncoder().encode(request.prompt), stdout: "pipe", stderr: "pipe" });
      const kill = () => proc.kill("SIGKILL");
      request.signal?.addEventListener("abort", kill, { once: true });
      try {
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        if (code !== 0) throw new Error(`codex exited with code ${code}`);
        return { submitted: parseSubmitted(out), usage: { input_tokens: 0, output_tokens: 0 } };
      } finally {
        request.signal?.removeEventListener("abort", kill);
        kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
