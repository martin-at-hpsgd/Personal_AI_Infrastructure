/**
 * Located validation errors for the definition format (ISA ISC-57).
 *
 * Every rejection is reported as `{path, code, message}`: `path` names the
 * offending field (`steps.rank.output`, `triggers.1.cron`), `code` is a short
 * stable identifier a caller can switch on, `message` is the sentence a person
 * reads. The parser throws a DefinitionError that carries path and code; older
 * rejections (and the v1 engine's, which only carry a sentence) are located by
 * `locate()` from the sentence itself.
 */

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export class DefinitionError extends Error {
  readonly path: string;
  readonly code: string;
  constructor(message: string, path?: string, code?: string) {
    super(message);
    this.name = "DefinitionError";
    const located = path !== undefined && code !== undefined ? { path, code } : locate(message);
    this.path = path ?? located.path;
    this.code = code ?? located.code;
  }
}

/** The root of a document, for rejections that name no single field. */
export const ROOT_PATH = "$";

function codeOf(message: string): string {
  const rules: Array<[RegExp, string]> = [
    [/unknown key/, "unknown-key"],
    [/unsafe key|is unsafe/, "unsafe-key"],
    [/dependency cycle/, "dependency-cycle"],
    [/depends on unknown step|unknown step/, "unknown-step"],
    [/non-ancestor/, "ref-out-of-scope"],
    [/must begin with input|Invalid reference/, "invalid-reference"],
    [/must declare an output schema/, "missing-output"],
    [/must name a lane|needs a kind|must declare runs_on|at least one step/, "missing-field"],
    [/no human step/, "missing-human-gate"],
    [/must be one of|must be lowercase/, "invalid-value"],
    [/type mismatch|does not fit downstream/, "type-mismatch"],
    [/does not match its file name/, "name-mismatch"],
    [/Unsupported schema keyword|Invalid schema/, "invalid-schema"],
    [/does not exist/, "unknown-workflow"],
    [/cannot run after itself|runs its own workflow/, "self-reference"],
    [/must be (a|an) |must be a non-empty string|must be a list|must be an object|must be a string|must be a whole number/, "invalid-type"],
  ];
  for (const [pattern, code] of rules) if (pattern.test(message)) return code;
  return "invalid";
}

/** Best-effort location of a legacy sentence. New rejections pass an explicit path and code instead. */
export function locate(message: string): { path: string; code: string } {
  const code = codeOf(message);
  let m: RegExpMatchArray | null;
  const key = message.match(/unknown key "([^"]+)"/)?.[1] ?? message.match(/unsafe key "([^"]+)"/)?.[1];
  if ((m = message.match(/^Step "([^"]+)"(?: \(\w+\))? has unknown key/))) return { path: `steps.${m[1]}.${key}`, code };
  if ((m = message.match(/^Trigger (\d+)(?::| has| contains)?/)) && key) return { path: `triggers.${Number(m[1]) - 1}.${key}`, code };
  if (/^Workflow (has|contains)/.test(message) && key) return { path: key, code };
  if ((m = message.match(/^Step "([^"]+)" depends on unknown step/)) || (m = message.match(/^Step "([^"]+)" cannot depend|^Step "([^"]+)" lists dependency/))) return { path: `steps.${m[1] ?? m[2]}.needs`, code };
  if ((m = message.match(/dependency cycle at step "([^"]+)"/))) return { path: `steps.${m[1]}.needs`, code };
  if ((m = message.match(/^Step "([^"]+)" references non-ancestor/))) return { path: `steps.${m[1]}.with`, code };
  if ((m = message.match(/^Step "([^"]+)" is a (?:model|agent|judgment) step and must declare an output/))) return { path: `steps.${m[1]}.output`, code };
  if ((m = message.match(/^Step "([^"]+)" is a \w+ step and must name a lane/))) return { path: `steps.${m[1]}.lane`, code };
  if ((m = message.match(/^Step "([^"]+)" needs a kind/))) return { path: `steps.${m[1]}.kind`, code };
  if ((m = message.match(/^Step "([^"]+)" declares side effects/))) return { path: `steps.${m[1]}.side_effects`, code };
  if ((m = message.match(/^Step "([^"]+)" (?:\(\w+\) )?(\w+)/))) return { path: `steps.${m[1]}.${m[2]}`, code };
  if ((m = message.match(/^Trigger (\d+)(?::)? (?:\w+ )?(\w+)/))) return { path: `triggers.${Number(m[1]) - 1}.${m[2]}`, code };
  if ((m = message.match(/^Trigger (\d+)/))) return { path: `triggers.${Number(m[1]) - 1}`, code };
  if (/^Workflow output references unknown step/.test(message)) return { path: "result", code };
  if ((m = message.match(/^Workflow (input|output) schema/))) return { path: m[1], code };
  if ((m = message.match(/^Workflow (\w+)/)) && ["name", "runs_on", "sop", "domains", "destination", "data_class", "triggers", "steps", "description", "version"].includes(m[1])) return { path: m[1], code };
  if (/^Workflow name .* does not match its file name/.test(message)) return { path: "name", code };
  if (/^Workflow version/.test(message)) return { path: "version", code };
  if ((m = message.match(/^Workflow "([^"]+)" cannot run after itself/))) return { path: "triggers", code };
  if ((m = message.match(/^Connection (\S+) -> (\S+) is a type mismatch/))) return { path: m[2], code };
  if ((m = message.match(/^after: upstream "([^"]+)" output does not fit/))) return { path: "triggers", code };
  if (/^after: upstream workflow/.test(message)) return { path: "triggers", code };
  if ((m = message.match(/^Step "([^"]+)" runs workflow "([^"]+)", which does not exist/))) return { path: `steps.${m[1]}.workflow`, code };
  return { path: ROOT_PATH, code };
}

/** The Issue a thrown parse error stands for. */
export function issueOfError(error: unknown): Issue {
  if (error instanceof DefinitionError) return { path: error.path, code: error.code, message: error.message };
  const text = error instanceof Error ? error.message : String(error);
  return { ...locate(text), message: text };
}
