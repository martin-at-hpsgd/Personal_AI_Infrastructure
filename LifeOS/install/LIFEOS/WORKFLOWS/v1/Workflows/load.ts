import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { parseWorkflow, type Workflow } from './engine';
import { validateTrigger } from './triggers';

export function parseWorkflowYaml(text: string): Workflow {
  const doc = parseDocument(text, { uniqueKeys: true, version: '1.2' });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map(e => e.message).join('; '));
  const value = doc.toJS({ maxAliasCount: 0 });
  const workflow = parseWorkflow(value);
  validateTrigger(workflow);
  return workflow;
}

export async function loadWorkflow(file: string): Promise<Workflow> {
  return parseWorkflowYaml(await readFile(file, 'utf8'));
}
