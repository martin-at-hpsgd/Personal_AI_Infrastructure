#!/usr/bin/env bun
/**
 * @version 1.5.0
 * DocIntegrity.hook.ts — session-end doc housekeeping
 *
 * PURPOSE:
 * Rebuilds the generated architecture summary and knowledge schema, and reports
 * memory-dir and knowledge-note drift, once per session. The per-file cross-reference
 * check moved to MicroIntegrity.hook.ts (Stop, async), which syncs docs after every
 * turn instead of after the session (ISA 20261024-micro-integrity).
 *
 * TRIGGER: SessionEnd
 *
 * HANDLERS: handlers/RebuildArchSummary.ts,
 *   handlers/MemoryDirIntegrity.ts, handlers/RebuildKnowledgeSchema.ts,
 *   handlers/KnowledgeConformance.ts — each isolated in its own try/catch so one
 *   failure never costs the others their pass.
 */

import { readHookInput } from './lib/hook-io';
import { handleRebuildArchSummary } from './handlers/RebuildArchSummary';
import { handleMemoryDirIntegrity } from './handlers/MemoryDirIntegrity';
import { handleRebuildKnowledgeSchema } from './handlers/RebuildKnowledgeSchema';
import { handleKnowledgeConformance } from './handlers/KnowledgeConformance';

async function main() {
  const input = await readHookInput();
  if (!input) { process.exit(0); }

  try {
    await handleRebuildArchSummary();
  } catch (err) {
    console.error('[DocIntegrity] Arch-summary handler failed:', err);
  }

  try {
    await handleMemoryDirIntegrity();
  } catch (err) {
    console.error('[DocIntegrity] Memory-dir handler failed:', err);
  }

  try {
    await handleRebuildKnowledgeSchema();
  } catch (err) {
    console.error('[DocIntegrity] Knowledge-schema regen failed:', err);
  }

  try {
    await handleKnowledgeConformance();
  } catch (err) {
    console.error('[DocIntegrity] Knowledge-conformance check failed:', err);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[DocIntegrity] Fatal:', err);
  process.exit(0);
});
