/**
 * ISC-35: an action a cloud workflow uses must carry input and output
 * contracts more specific than `{type: object}`.
 *
 * "More specific" means the schema narrows what it accepts: it names required
 * fields, types at least one property, pins a const/enum, or closes extra
 * properties. A schema that only says `type: object` (or a type union wider
 * than that), with every property `{}`, is loose: the migration contract for
 * A_NOTIFY is deliberately loose in exactly this way (additive-only, ISA M-15)
 * and is reported so rather than waved through.
 */
type Schema = Record<string, unknown>;

const isObj = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);

/** True when the schema accepts strictly less than an open object. */
export function isSpecific(schema: unknown): boolean {
  if (!isObj(schema)) return false;
  if (Array.isArray(schema.type)) return false;
  if (schema.type !== undefined && schema.type !== "object") return true;
  if ("const" in schema || Array.isArray(schema.enum)) return true;
  if (Array.isArray(schema.required) && schema.required.length > 0) return true;
  if (schema.additionalProperties === false) return true;
  const props = isObj(schema.properties) ? Object.values(schema.properties) : [];
  return props.some(p => isObj(p) && Object.keys(p).some(k => k !== "description" && k !== "title"));
}

/** One line per loose side of an action's contract; empty when both are specific. */
export function contractIssues(action: string, input: unknown, output: unknown): string[] {
  const issues: string[] = [];
  if (!isSpecific(input)) issues.push(`${action} input contract is no narrower than {type: object}`);
  if (!isSpecific(output)) issues.push(`${action} output contract is no narrower than {type: object}`);
  return issues;
}
