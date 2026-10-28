/** Actual harness sessions, graded by the existing suite runner. No alternate grader. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSuite, type EvalRunDeps, type EvalSuiteV2 } from './EvalRunner.ts';

export interface HarnessAdapter {
  /** Identifies the real carrier and configuration in persisted trial evidence. */
  id: string;
  /** Explicit offline fixture/replay; never a live harness certification. */
  offline?: boolean;
  runCase(input: { prompt: string; workspace: string }): Promise<{
    output: string;
    model: string;
    /** Content hashes of the context actually loaded by the harness. */
    context: Record<string, string>;
    /** Final-state evidence or transcript pointer, rather than claimed tool calls. */
    evidence: string;
  }>;
}

export async function runAgenticSuite(name: string, adapter: HarnessAdapter, requiredContext: string[],
  override: Partial<EvalSuiteV2> = {}, deps: Omit<EvalRunDeps, 'invoke'> = {}) {
  if (!adapter.id || !requiredContext.length) throw new Error('A harness id and required context receipts are necessary');
  if (process.env.LIFEOS_INFERENCE_DISABLED && !adapter.offline) throw new Error('Agentic evaluation is unavailable in an assert-only run');
  return runSuite(name, { ...override, requires_context: requiredContext }, {
    ...deps,
    invoke: async (options) => {
      const workspace = mkdtempSync(join(tmpdir(), 'lifeos-agent-eval-'));
      const started = Date.now();
      try {
        const r = await adapter.runCase({ prompt: options.userPrompt, workspace });
        if (!r.model || !r.evidence || requiredContext.some(key => !/^[a-f0-9]{64}$/.test(r.context?.[key] ?? ''))) {
          throw new Error('harness did not return required context, model and final-state evidence');
        }
        return { success: true, output: r.output, executedModel: r.model, latencyMs: Date.now() - started,
          level: options.level ?? 'medium', harness: { id: adapter.id, offline: !!adapter.offline, context: r.context, evidence: r.evidence } };
      } catch (error) {
        return { success: false, output: '', error: String(error), latencyMs: Date.now() - started, level: options.level ?? 'medium' };
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  });
}
