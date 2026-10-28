#!/usr/bin/env bun
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { parseWorkflow, runWorkflow, type Workflow } from '../../Workflows/engine';
import { localActionRegistry } from '../../Workflows/local';
import { validateTrigger } from '../../Workflows/triggers';

const ROOT = join(import.meta.dir, '../..');
const DIRECTORIES = [join(ROOT, '../../USER/CUSTOMIZATIONS/ARBOL/PIPELINES'), join(ROOT, 'Pipelines')];

export function normalizePipeline(value: unknown): Workflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pipeline must be an object');
  const raw = value as Record<string, unknown>;
  if ('version' in raw) {
    const workflow = parseWorkflow(raw);
    validateTrigger(workflow);
    return workflow;
  }
  if (Object.keys(raw).some(k => !['name', 'description', 'actions'].includes(k))) throw new Error('Unknown legacy pipeline field');
  if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.some(a => typeof a !== 'string' || !a)) throw new Error('Pipeline actions must be a nonempty list');
  const steps: Workflow['steps'] = Object.create(null);
  raw.actions.forEach((uses, i) => {
    steps['step' + (i + 1)] = { uses, ...(i ? { needs: ['step' + i], with: { $ref: 'steps.step' + i + '.output' } } : {}) };
  });
  return parseWorkflow({ version: 1, name: raw.name, ...(raw.description === undefined ? {} : { description: raw.description }), steps, output: { $ref: 'steps.step' + raw.actions.length + '.output' } });
}

export async function loadPipeline(name: string): Promise<Workflow> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid pipeline name');
  for (const dir of DIRECTORIES) {
    try {
      const doc = parseDocument(await readFile(join(dir, name + '.yaml'), 'utf8'), { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map(e => e.message).join('; '));
      return normalizePipeline(doc.toJS({ maxAliasCount: 0 }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Pipeline not found: ' + name);
}

export async function runPipeline(name: string, input: unknown): Promise<{ success: boolean; output?: unknown; error?: string }> {
  try {
    const workflow = await loadPipeline(name);
    return await runWorkflow(workflow, input, await localActionRegistry(workflow));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listPipelines(): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of DIRECTORIES) {
    try {
      for (const file of await readdir(dir)) if (file.endsWith('.yaml')) names.add(file.slice(0, -5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return [...names].sort();
}

if (import.meta.main) {
  const [command, name, ...args] = process.argv.slice(2);
  try {
    if (command === 'list') console.log(JSON.stringify({ pipelines: await listPipelines() }, null, 2));
    else if (command === 'run' && name) {
      let input: unknown = {};
      if (args[0] === '--input' && args[1]) input = JSON.parse(args[1]);
      else {
        if (args.length % 2) throw new Error('Each input flag needs a value');
        const fields: Record<string, unknown> = Object.create(null);
        for (let i = 0; i < args.length; i += 2) {
          if (!args[i].startsWith('--')) throw new Error('Expected --key value');
          let value: unknown = args[i + 1];
          try { value = JSON.parse(args[i + 1]); } catch {}
          fields[args[i].slice(2)] = value;
        }
        input = fields;
      }
      const result = await runPipeline(name, input);
      console.log(JSON.stringify(result, null, 2));
      if (!result.success) process.exitCode = 1;
    } else throw new Error('Usage: pipeline-runner.ts list | run <name> [--input JSON | --key value]');
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
