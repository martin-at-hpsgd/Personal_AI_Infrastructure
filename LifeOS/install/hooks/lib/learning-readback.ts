/**
 * @version 1.4.4
 * learning-readback.ts - Close the learning loop by reading learnings back into context
 *
 * PURPOSE:
 * The LifeOS learning system writes extensively (8,400+ files across 5 hooks) but
 * previously had no readback mechanism. This library provides fast, compact
 * readers that LoadContext.hook.ts calls at session start to inject accumulated
 * knowledge back into the model's context.
 *
 * FUNCTIONS:
 * - loadWisdomFrames()      — Crystallized behavioral patterns (WISDOM/FRAMES)
 *
 * PERFORMANCE:
 * This reader scans pre-existing files synchronously for simplicity.
 *
 * OUTPUT:
 * Returns a compact string or null if no data.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Load Wisdom Frame core principles for context injection.
 * Reads all WISDOM/FRAMES/*.md files and extracts principle headers
 * (lines matching "### Name [CRYSTAL: N%]").
 */
export function loadWisdomFrames(lifeosDir: string): string | null {
  const framesDir = join(lifeosDir, 'MEMORY', 'WISDOM', 'FRAMES');
  if (!existsSync(framesDir)) return null;

  const principles: string[] = [];

  try {
    const files = readdirSync(framesDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = readFileSync(join(framesDir, file), 'utf-8');
        const domain = file.replace('.md', '');

        // Extract principle headers with CRYSTAL confidence
        const matches = content.matchAll(/^### (.+?) \[CRYSTAL: (\d+)%\]/gm);
        for (const match of matches) {
          const confidence = parseInt(match[2], 10);
          if (confidence >= 85) {
            principles.push(`[${domain}] ${match[1]} (${confidence}%)`);
          }
        }
      } catch { /* skip unreadable frames */ }
    }
  } catch { /* skip if dir scan fails */ }

  if (principles.length === 0) return null;

  return `**Wisdom Frames (high confidence):**\n${principles.map(p => `  ${p}`).join('\n')}`;
}
