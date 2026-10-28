/**
 * Progressive hot-memory delivery.
 *
 * RULE entries and anything the current schema does not recognize remain in
 * prompt context. Typed personal/context entries are deferred behind an
 * absolute, runtime-computed source pointer. A compacted session has no
 * durable loaded-context receipt: it must read that source again before work
 * whose answer depends on deferred context.
 */

import { createHash } from 'node:crypto';

export const DEFERRED_TYPES = new Set(["NAME", "ROLE", "RELATION", "PREFERENCE"]);

export interface ProgressiveMemory {
  resident: string[];
  deferred: string[];
}

function entryType(entry: string): string | null {
  return /^([A-Z][A-Z0-9_-]*):\s+/.exec(entry)?.[1] ?? null;
}

/**
 * Fail closed toward retention: only the four known contextual types defer.
 * RULE, unknown future types, and malformed entries stay resident.
 */
export function partitionMemoryEntries(entries: readonly string[]): ProgressiveMemory {
  const resident: string[] = [];
  const deferred: string[] = [];
  for (const entry of entries) {
    if (DEFERRED_TYPES.has(entryType(entry) ?? "")) deferred.push(entry);
    else resident.push(entry);
  }
  return { resident, deferred };
}

export function renderProgressiveMemory(
  title: string,
  sourcePath: string,
  entries: readonly string[],
  capEntries = 48,
  capChars = 12288,
): string {
  const { resident, deferred } = partitionMemoryEntries(entries);
  const charsUsed = entries.reduce((sum, entry) => sum + entry.length, 0);
  const header = `## ${title} [loaded ${resident.length}/${entries.length} resident entries · deferred ${deferred.length} · ${charsUsed}/${capChars} chars · cap ${capEntries}]`;
  const residentBlock = resident.length > 0 ? resident.join("\n") : "(no resident entries)";
  if (deferred.length === 0) return `${header}\n${residentBlock}`;
  const sha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return `${header}\n${residentBlock}\n\n### Deferred contextual memory [${deferred.length} entries]\nSource entries SHA256: ${sha256}\nFor personal, domain, or context-dependent work, read the complete source before relying on this context: ${sourcePath}\nIf relevance is uncertain, read the source. A changed hash invalidates prior loaded content. Direct source reads are valid. After compaction or a new session, reread the source; no loaded-context receipt survives.`;
}
