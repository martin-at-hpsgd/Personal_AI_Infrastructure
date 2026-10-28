import { parseWorkflow, validateWorkflow, type ActionRegistry, type Workflow } from './engine';
import { dispatchWorkflow, validateTrigger, type WorkflowEvent } from './triggers';
import { normalizeActionSchema } from './schema';

export interface ServiceBinding { fetch(request: Request): Promise<Response> }
export interface CloudAction { binding: string; input?: unknown; output?: unknown }
export type CloudActions = Record<string, CloudAction>;

/** Binding names and credentials belong to the host, never the workflow YAML. */
export function cloudActionRegistry(workflow: Workflow, actions: CloudActions, bindings: Record<string, unknown>, authorization?: string): ActionRegistry {
  const registry: ActionRegistry = Object.create(null);
  for (const name of new Set(Object.values(workflow.steps).map(step => step.uses))) {
    if (!Object.hasOwn(actions, name)) throw new Error(`No cloud action registered: ${name}`);
    const action = actions[name];
    const binding = Object.hasOwn(bindings, action.binding) ? bindings[action.binding] as ServiceBinding : undefined;
    if (!binding || typeof binding.fetch !== 'function') throw new Error(`Missing service binding: ${action.binding}`);
    registry[name] = {
      input: action.input === undefined ? undefined : normalizeActionSchema(action.input),
      output: action.output === undefined ? undefined : normalizeActionSchema(action.output),
      async execute(input, context) {
        const response = await binding.fetch(new Request('https://arbol.internal/', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
          body: JSON.stringify(input),
          signal: context.signal,
        }));
        if (!response.ok) throw new Error(`Action ${name} returned HTTP ${response.status}`);
        const result = await response.json() as { success?: boolean; output?: unknown };
        if (result.success !== true || !Object.hasOwn(result, 'output')) throw new Error(`Action ${name} returned an invalid or unsuccessful envelope`);
        return result.output;
      },
    };
  }
  validateWorkflow(workflow, registry);
  return registry;
}

/** Host-compatible handlers. Loading this factory never creates a schedule or sends work. */
export function createWorkflowWorker<E extends Record<string, unknown>>(definition: Workflow, actions: CloudActions, options: {
  authorize: (request: Request, env: E) => boolean | Promise<boolean>;
  authorization?: (env: E) => string;
}) {
  const workflow = parseWorkflow(structuredClone(definition));
  validateTrigger(workflow);
  return {
    async fetch(request: Request, env: E): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== '/run') return new Response('Not found', { status: 404 });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!await options.authorize(request, env)) return new Response('Unauthorized', { status: 401 });
      let payload: { input?: unknown; event?: string };
      try {
        payload = await request.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !['input', 'event'].includes(k))) throw new Error('Invalid payload');
        if (payload.event !== undefined && typeof payload.event !== 'string') throw new Error('Invalid event');
      } catch { return new Response('Invalid JSON payload', { status: 400 }); }
      const event: WorkflowEvent = payload.event === undefined ? { type: 'manual' } : { type: 'event', name: payload.event };
      const registry = cloudActionRegistry(workflow, actions, env, options.authorization?.(env));
      const result = await dispatchWorkflow(workflow, event, Object.hasOwn(payload, 'input') ? payload.input : {}, registry);
      return Response.json(result, { status: result.success ? 200 : 502 });
    },
    async scheduled(controller: { scheduledTime: number }, env: E): Promise<void> {
      const registry = cloudActionRegistry(workflow, actions, env, options.authorization?.(env));
      const result = await dispatchWorkflow(workflow, { type: 'schedule', at: new Date(controller.scheduledTime) }, { scheduled_at: new Date(controller.scheduledTime).toISOString() }, registry);
      if (!result.success) throw new Error(result.error ?? 'Scheduled workflow failed');
    },
  };
}
