import { Validator, type Schema } from '@cfworker/json-schema';
import meta from './draft-07.json';

// Official draft-07 meta-schema: https://json-schema.org/draft-07/schema
const metaValidator = new Validator(meta as Schema, '7', false);
const keywords = new Set(Object.keys(meta.properties));
const single = new Set(['additionalItems', 'additionalProperties', 'contains', 'propertyNames', 'if', 'then', 'else', 'not']);
const arrays = new Set(['allOf', 'anyOf', 'oneOf']);
const maps = new Set(['properties', 'patternProperties', 'definitions']);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function assertSchema(schema: unknown): void {
  const result = metaValidator.validate(schema);
  if (!result.valid) throw new Error(`Invalid schema: ${result.errors.map(e => `${e.instanceLocation} ${e.error}`).join('; ')}`);
  const root = schema;
  function walk(value: unknown): void {
    if (typeof value === 'boolean') return;
    const s = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(s)) {
      if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
      if (key === '$schema' && child !== 'http://json-schema.org/draft-07/schema#' && child !== 'https://json-schema.org/draft-07/schema') throw new Error('Only JSON Schema draft-07 is supported');
      if (key === '$id') throw new Error('Schema $id is unsupported; use local #/definitions references');
      if (key === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#/')) throw new Error('Schema references must be local JSON pointers');
        let target: unknown = root;
        for (const token of child.slice(2).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
          if (forbidden.has(token) || !target || typeof target !== 'object' || !Object.hasOwn(target, token)) throw new Error(`Unknown schema reference: ${child}`);
          target = (target as Record<string, unknown>)[token];
        }
        if (typeof target !== 'boolean' && (!target || typeof target !== 'object' || Array.isArray(target))) throw new Error(`Invalid schema reference: ${child}`);
      }
      if (single.has(key)) walk(child);
      else if (arrays.has(key)) (child as unknown[]).forEach(walk);
      else if (key === 'items') Array.isArray(child) ? child.forEach(walk) : walk(child);
      else if (maps.has(key)) {
        for (const [name, member] of Object.entries(child as object)) {
          if (forbidden.has(name)) throw new Error(`Unsafe schema property: ${name}`);
          walk(member);
        }
      } else if (key === 'dependencies') {
        for (const member of Object.values(child as object)) if (!Array.isArray(member)) walk(member);
      }
    }
  }
  walk(schema);
}

export function compileSchema(schema: unknown): (value: unknown) => { valid: boolean; errors?: string[] } {
  assertSchema(schema);
  // The validator annotates schemas during reference resolution; isolate caller data.
  const validator = new Validator(structuredClone(schema) as Schema, '7', false);
  return value => {
    const result = validator.validate(value);
    return { valid: result.valid, ...(result.valid ? {} : { errors: result.errors.map(e => `${e.instanceLocation} ${e.error}`) }) };
  };
}

/** Accept the historical action field shorthand at the package boundary only. */
export function normalizeActionSchema(value: unknown): Schema | boolean {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Action schema must be an object or boolean');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length === 0) return {};
  const shorthand = Object.values(obj).every(spec => spec && typeof spec === 'object' && !Array.isArray(spec) && (Object.hasOwn(spec, 'type') || typeof (spec as Record<string, unknown>).required === 'boolean'));
  if (!shorthand && Object.keys(obj).some(key => keywords.has(key))) {
    assertSchema(obj);
    return structuredClone(obj) as Schema;
  }
  const properties: Record<string, Schema> = Object.create(null);
  const required: string[] = [];
  for (const [field, spec] of Object.entries(obj)) {
    if (forbidden.has(field) || !spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Invalid action field: ${field}`);
    const { required: must, ...rest } = spec as Record<string, unknown>;
    if (must !== undefined && typeof must !== 'boolean') throw new Error(`Invalid required flag: ${field}`);
    if (must) required.push(field);
    properties[field] = rest;
  }
  const normalized = { type: 'object', properties, required } as Schema;
  assertSchema(normalized);
  return normalized;
}
