import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContract } from '../IntentContract';

export interface IntentDriftCount {
  skill: string;
  scanned: number;
  flagged: number;
  unmatched: number;
}

// Ignore examples in fenced code and YAML metadata. Match whole directive lines,
// not generic shared words like MUST or a pointer saying to read the intent.
function prose(text: string): string {
  return text.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
function normalized(text: string): string {
  return text.replace(/[*_`#]/g, '').replace(/^\s*(?:[-+]|\d+\.)\s*/, '')
    .replace(/🚨/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function unmatchedIntentConstraints(intent: string, skill: string): string[] {
  const skillLines = new Set(prose(skill).split(/\r?\n/).map(normalized));
  return prose(intent).split(/\r?\n/)
    .filter(line => /\b(?:MUST|NEVER|MANDATORY|REQUIRED)\b|🚨/i.test(line))
    .filter(line => { const constraint = normalized(line); return !constraint || !skillLines.has(constraint); });
}

/** Deterministic conservative textual correspondence; semantic paraphrases need review. */
export function scanIntentContractDrift(skillsDir: string): IntentDriftCount[] {
  const counts: IntentDriftCount[] = [];
  for (const skill of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!skill.isDirectory()) continue;
    const dir = join(skillsDir, skill.name, 'Intents');
    if (!existsSync(dir)) continue;
    const skillPath = join(skillsDir, skill.name, 'SKILL.md');
    const skillText = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
    const count: IntentDriftCount = { skill: skill.name, scanned: 0, flagged: 0, unmatched: 0 };
    for (const file of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || !file.name.endsWith('.md')) continue;
      count.scanned++;
      const path = join(dir, file.name);
      const contract = loadContract(path);
      if (contract && (contract.requires.length || contract.bans?.length || contract.mandates?.length)) continue;
      const unmatched = unmatchedIntentConstraints(readFileSync(path, 'utf8'), skillText);
      if (unmatched.length) { count.flagged++; count.unmatched += unmatched.length; }
    }
    counts.push(count);
  }
  return counts;
}
