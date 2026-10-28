#!/usr/bin/env bun
import { loadWorkflow } from './load';
import { describeWorkflow } from './engine';
import { localActionRegistry } from './local';
import { dispatchWorkflow, nextScheduledAt, type WorkflowEvent } from './triggers';

export async function workflowCommand(args: string[]): Promise<void> {
  const [command, file, ...rest] = args;
  if (!command || command === '--help') {
    console.log('workflow validate|graph|run|next|tick|event <file.yaml> [--input JSON] [--at ISO] [--name event]');
    return;
  }
  if (!file) throw new Error('Workflow file required');
  if (!['validate', 'graph', 'run', 'next', 'tick', 'event'].includes(command)) throw new Error(`Unknown workflow command: ${command}`);
  const flags: Record<string, string> = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--input', '--at', '--name'].includes(rest[i]) || rest[i + 1] === undefined) throw new Error(`Invalid option: ${rest[i]}`);
    if (Object.hasOwn(flags, rest[i])) throw new Error(`Duplicate option: ${rest[i]}`);
    flags[rest[i]] = rest[i + 1];
  }
  const workflow = await loadWorkflow(file);
  if (command === 'graph') { console.log(JSON.stringify(describeWorkflow(workflow), null, 2)); return; }
  if (command === 'next') {
    console.log(JSON.stringify({ next: nextScheduledAt(workflow, flags['--at'] ? new Date(flags['--at']) : new Date()).toISOString() }));
    return;
  }
  const registry = await localActionRegistry(workflow);
  if (command === 'validate') { console.log(JSON.stringify({ valid: true, name: workflow.name, actions: Object.keys(registry) })); return; }
  let event: WorkflowEvent = { type: 'manual' };
  if (command === 'tick') event = { type: 'schedule', at: flags['--at'] ? new Date(flags['--at']) : new Date() };
  if (command === 'event') {
    if (!flags['--name']) throw new Error('event requires --name');
    event = { type: 'event', name: flags['--name'] };
  }
  const input = flags['--input'] ? JSON.parse(flags['--input']) : (process.stdin.isTTY ? {} : JSON.parse((await Bun.stdin.text()).trim() || '{}'));
  const result = await dispatchWorkflow(workflow, event, input, registry);
  console.log(JSON.stringify(result, null, 2));
  if (!result.success) process.exitCode = 1;
}

if (import.meta.main) workflowCommand(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
