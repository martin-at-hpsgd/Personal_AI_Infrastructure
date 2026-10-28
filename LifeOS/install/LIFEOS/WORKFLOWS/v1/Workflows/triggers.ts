import { CronExpressionParser } from 'cron-parser';
import { runWorkflow, validateWorkflow, type Workflow, type ActionRegistry, type WorkflowResult } from './engine';

export type WorkflowEvent = { type: 'manual' } | { type: 'event'; name: string } | { type: 'schedule'; at: Date };

export function validateTrigger(workflow: Workflow): void {
  const trigger = workflow.trigger;
  if (trigger?.type !== 'schedule') return;
  // Five fields, deterministic cron only. No hashed/random or seconds schedules.
  if (trigger.cron.trim().split(/\s+/).length !== 5 || /[Hh]/.test(trigger.cron)) throw new Error('Schedule requires a deterministic five-field cron');
  new Intl.DateTimeFormat('en', { timeZone: trigger.timezone });
  CronExpressionParser.parse(trigger.cron, { tz: trigger.timezone });
}

export function nextScheduledAt(workflow: Workflow, after = new Date()): Date {
  validateTrigger(workflow);
  if (workflow.trigger?.type !== 'schedule') throw new Error('Workflow has no schedule');
  return CronExpressionParser.parse(workflow.trigger.cron, { tz: workflow.trigger.timezone, currentDate: after }).next().toDate();
}

export function matchesTrigger(workflow: Workflow, event: WorkflowEvent): boolean {
  validateTrigger(workflow);
  const trigger = workflow.trigger ?? { type: 'manual' };
  if (trigger.type !== event.type) return false;
  if (trigger.type === 'manual') return true;
  if (trigger.type === 'event' && event.type === 'event') return trigger.name === event.name;
  if (trigger.type === 'schedule' && event.type === 'schedule') {
    if (!Number.isFinite(event.at.getTime())) throw new Error('Invalid schedule timestamp');
    const minute = Math.floor(event.at.getTime() / 60_000) * 60_000;
    return nextScheduledAt(workflow, new Date(minute - 1)).getTime() === minute;
  }
  return false;
}

export async function dispatchWorkflow(workflow: Workflow, event: WorkflowEvent, input: unknown, registry: ActionRegistry): Promise<WorkflowResult & { matched: boolean }> {
  validateWorkflow(workflow, registry);
  if (!matchesTrigger(workflow, event)) return { matched: false, success: true, steps: {} };
  return { ...await runWorkflow(workflow, input, registry), matched: true };
}
