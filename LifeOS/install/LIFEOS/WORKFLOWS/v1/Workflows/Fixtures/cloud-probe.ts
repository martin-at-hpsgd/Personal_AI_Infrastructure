import { createWorkflowWorker } from '../cloud';
import { nextScheduledAt } from '../triggers';
import type { Workflow } from '../engine';

const definition: Workflow = {
  version: 1, name: 'cloud-probe', trigger: { type: 'manual' },
  input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  steps: { copy: { uses: 'copy', with: { text: { $ref: 'input.text' } } } },
  output: { $ref: 'steps.copy.output' },
};
const worker = createWorkflowWorker(definition, { copy: { binding: 'COPY', output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } }, { authorize: () => true });

export default {
  async test(_controller: unknown, env: Record<string, unknown>) {
    const response = await worker.fetch(new Request('https://probe.test/run', { method: 'POST', body: '{"input":{"text":"synthetic"}}' }), env);
    const result = await response.json() as any;
    if (response.status !== 200 || !result.success || result.output.text !== 'synthetic') throw new Error('Cloud service binding execution failed');
    const schedule: Workflow = { ...definition, trigger: { type: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/New_York' } };
    if (nextScheduledAt(schedule, new Date('2026-03-06T15:00:00Z')).toISOString() !== '2026-03-09T13:00:00.000Z') throw new Error('Cloud timezone schedule failed');
  },
};
