import { compileSchema } from './schema';

type Shape = boolean | Record<string, any> | undefined;
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const types = (s: Shape): string[] => object(s) ? (typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? s.type : []) : [];

/** Reject provable incompatibilities; full JSON Schema validation still runs on actual data. */
export function validateInputMapping(mapping: unknown, target: unknown, sourceFor: (ref: string) => unknown, label: string): void {
  const targetSchema = target as Shape;
  function compare(source: Shape, destination: Shape, path: string): void {
    if (destination === undefined || destination === true || source === undefined) return;
    if (destination === false) throw new Error(`${path}: input schema accepts no values`);
    const from = types(source), to = types(destination);
    if (from.length && to.length && from.every(t => !to.includes(t) && !(t === 'integer' && to.includes('number')))) throw new Error(`${path}: incompatible types ${from.join('/')} -> ${to.join('/')}`);
    if (object(source) && object(destination)) {
      for (const [key, dest] of Object.entries(destination.properties ?? {})) {
        if (object(source.properties) && Object.hasOwn(source.properties, key)) compare(source.properties[key], dest as Shape, `${path}.${key}`);
        else if ((destination.required ?? []).includes(key) && source.additionalProperties === false) throw new Error(`${path}: source cannot supply required field ${key}`);
      }
    }
  }
  function hasRef(value: unknown): boolean {
    return Array.isArray(value) ? value.some(hasRef) : object(value) ? Object.hasOwn(value, '$ref') || Object.values(value).some(hasRef) : false;
  }
  function inspect(value: unknown, dest: Shape, path: string): void {
    if (object(value) && typeof value.$ref === 'string') { compare(sourceFor(value.$ref) as Shape, dest, path); return; }
    if (!hasRef(value) && dest !== undefined) {
      const result = compileSchema(dest)(value);
      if (!result.valid) throw new Error(`${path}: incompatible literal input: ${result.errors?.join('; ')}`);
      return;
    }
    if (object(value) && object(dest)) {
      if (types(dest).length && !types(dest).includes('object')) throw new Error(`${path}: object mapping incompatible with input schema`);
      for (const key of dest.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}: missing required input ${key}`);
      for (const [key, child] of Object.entries(value)) {
        const property = Object.hasOwn(dest.properties ?? {}, key) ? dest.properties[key] : undefined;
        // Pattern properties/combinators remain runtime checks.
        if (property === undefined && dest.additionalProperties === false && !dest.patternProperties) throw new Error(`${path}: unknown input field ${key}`);
        inspect(child, property, `${path}.${key}`);
      }
    } else if (Array.isArray(value) && object(dest)) {
      if (types(dest).length && !types(dest).includes('array')) throw new Error(`${path}: array mapping incompatible with input schema`);
      value.forEach((item, index) => inspect(item, Array.isArray(dest.items) ? dest.items[index] : dest.items, `${path}.${index}`));
    }
  }
  inspect(mapping, targetSchema, label);
}

/** Walk statically declared properties; open schemas remain runtime-validated. */
export function schemaAtPath(schema: unknown, path: string[], label: string): unknown {
  let current = schema as Shape;
  for (const part of path) {
    if (!object(current)) return undefined;
    if (object(current.properties) && Object.hasOwn(current.properties, part)) current = current.properties[part];
    else if (types(current).includes('array') && /^\d+$/.test(part)) current = Array.isArray(current.items) ? current.items[Number(part)] : current.items;
    else if (current.additionalProperties === false && !current.patternProperties && !current.$ref && !current.anyOf && !current.oneOf && !current.allOf) throw new Error(`${label}: unknown declared field ${part}`);
    else return undefined;
  }
  return current;
}
