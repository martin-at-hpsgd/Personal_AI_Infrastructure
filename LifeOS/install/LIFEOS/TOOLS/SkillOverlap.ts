// Measures the routing cost and usage of skill descriptions.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SkillDesc { name: string; description: string; chars: number; useWhen: string[]; notFor: string[] }

export function loadSkillDescriptions(skillsDir: string): SkillDesc[] {
  return readdirSync(skillsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const path = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(path)) return [];
    const source = readFileSync(path, 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) return [];
    const raw = frontmatter.match(/^description:\s*(.*(?:\r?\n[ \t]+.*)*)/m)?.[1];
    if (raw === undefined) return [];
    const description = raw.replace(/\r?\n[ \t]+/g, ' ').trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    const useSection = description.match(/\bUSE WHEN\b([\s\S]*?)(?=\bNOT FOR\b|$)/i)?.[1] ?? '';
    const notSection = description.match(/\bNOT FOR\b([\s\S]*)/i)?.[1] ?? '';
    const useWhen = useSection.split(',').map(phrase => phrase.trim().replace(/^\s*[.;:]|[.;:]\s*$/g, '').toLowerCase()).filter(Boolean);
    const notFor = [...new Set([
      ...Array.from(notSection.matchAll(/\(([^)]+)\)/g), match => match[1]!.trim()).filter(value => /^[A-Za-z_][\w]*$/.test(value)),
      ...Array.from(notSection.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g), match => match[0]),
    ])];
    return [{ name: entry.name, description, chars: description.length, useWhen, notFor }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function contestedPhrases(skills: SkillDesc[]): Array<{ phrase: string; claimedBy: string[] }> {
  const claims = new Map<string, Set<string>>();
  for (const skill of skills) for (const phrase of new Set(skill.useWhen)) {
    if (!claims.has(phrase)) claims.set(phrase, new Set());
    claims.get(phrase)!.add(skill.name);
  }
  return [...claims].filter(([, names]) => names.size >= 2).map(([phrase, names]) => ({ phrase, claimedBy: [...names].sort() }))
    .sort((a, b) => b.claimedBy.length - a.claimedBy.length || a.phrase.localeCompare(b.phrase));
}

export function pairwiseOverlap(skills: SkillDesc[], minShared = 2): Array<{ a: string; b: string; shared: string[]; jaccard: number }> {
  const pairs: Array<{ a: string; b: string; shared: string[]; jaccard: number }> = [];
  const ordered = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const left = ordered[i]!; const right = ordered[j]!;
    const a = new Set(left.useWhen); const b = new Set(right.useWhen);
    const shared = [...a].filter(phrase => b.has(phrase)).sort();
    if (shared.length >= minShared) pairs.push({ a: left.name, b: right.name, shared, jaccard: shared.length / (a.size + b.size - shared.length) });
  }
  return pairs.sort((a, b) => b.jaccard - a.jaccard || a.a.localeCompare(b.a) || a.b.localeCompare(b.b)).slice(0, 50);
}

export function namespaceTotals(skills: SkillDesc[]): { skills: number; totalChars: number; meanChars: number; maxChars: number; maxSkill: string } {
  const totalChars = skills.reduce((sum, skill) => sum + skill.chars, 0);
  const max = [...skills].sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))[0];
  return { skills: skills.length, totalChars, meanChars: skills.length ? totalChars / skills.length : 0, maxChars: max?.chars ?? 0, maxSkill: max?.name ?? '' };
}

/**
 * Routing cost against delivered content.
 *
 * Two earlier definitions of this were wrong and both would have recommended deleting
 * live skills. Testing for an Intents/ directory called Cortex and Prompting empty when
 * they drive everything from Tools/. Testing for Intents/ OR Tools/ then flagged
 * LifeOSHooks — a 27-file plugin — along with the home skill, which keeps real TypeScript at its
 * own root, and five prose skills whose 5-11KB of instructions ARE their behavior.
 *
 * There is no directory layout that means "empty". The only honest signal is the ratio:
 * a skill charges the routing namespace `chars` every session and delivers `contentBytes`
 * of substance. A skill is hollow when it charges a lot and delivers almost nothing.
 * node_modules is excluded — a vendored dependency is not the skill's own substance.
 */
export function hollowSkills(
  skillsDir: string,
  skills: SkillDesc[],
  minRatio = 4,
): Array<{ name: string; chars: number; contentBytes: number; ratio: number }> {
  const contentBytes = (dir: string): number => {
    let total = 0;
    const walk = (d: string) => {
      let entries: string[];
      try { entries = readdirSync(d) as unknown as string[]; } catch { return; }
      for (const name of entries) {
        if (name === 'node_modules' || name === '.git' || name === 'bun.lock') continue;
        const p = join(d, name);
        try {
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else total += st.size;
        } catch { /* unreadable entry contributes nothing */ }
      }
    };
    walk(dir);
    return total;
  };
  return skills
    .map(skill => {
      const bytes = contentBytes(join(skillsDir, skill.name));
      return { name: skill.name, chars: skill.chars, contentBytes: bytes, ratio: bytes / Math.max(skill.chars, 1) };
    })
    .filter(s => s.ratio < minRatio)
    .sort((a, b) => a.ratio - b.ratio || b.chars - a.chars);
}

/** Skills that have logged at least once ever, and so can be observed as used or unused. */
export function observableSkills(skills: SkillDesc[], executionLogPath: string): SkillDesc[] {
  let raw: string;
  try { raw = readFileSync(executionLogPath, 'utf8'); } catch { return []; }
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line) as { skill?: unknown };
      if (typeof e.skill === 'string') seen.add(e.skill);
    } catch { /* Ignore malformed log lines. */ }
  }
  return skills.filter(s => seen.has(s.name));
}

export function neverInvoked(skills: SkillDesc[], executionLogPath: string, days: number): Array<{ name: string; chars: number }> {
  let lines: string;
  try { lines = readFileSync(executionLogPath, 'utf8'); } catch { return []; }
  const cutoff = Date.now() - days * 86_400_000;
  const invoked = new Set<string>();
  for (const line of lines.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { skill?: unknown; ts?: unknown };
      if (typeof event.skill === 'string' && typeof event.ts === 'string' && Date.parse(event.ts) >= cutoff && Date.parse(event.ts) <= Date.now()) invoked.add(event.skill);
    } catch { /* Ignore malformed log lines. */ }
  }
  // A skill that never logs cannot appear invoked, so counting it as a miss is a
  // measurement artifact rather than a finding. Only skills that have logged at least
  // once, ever, are eligible: the log itself is the evidence they can be observed.
  const everLogged = new Set<string>();
  for (const line of lines.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line) as { skill?: unknown };
      if (typeof e.skill === 'string') everLogged.add(e.skill);
    } catch { /* Ignore malformed log lines. */ }
  }
  return skills.filter(skill => everLogged.has(skill.name) && !invoked.has(skill.name))
    .map(skill => ({ name: skill.name, chars: skill.chars }))
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const toolDir = dirname(fileURLToPath(import.meta.url));
  const skillsDir = resolve(process.argv.find(arg => !arg.startsWith('--') && arg !== process.argv[0] && arg !== process.argv[1]) ?? join(toolDir, '../../skills'));
  const skills = loadSkillDescriptions(skillsDir);
  const totals = namespaceTotals(skills);
  const contested = contestedPhrases(skills);
  const pairs = pairwiseOverlap(skills);
  const hollow = hollowSkills(skillsDir, skills);
  const executionLogPath = join(toolDir, '../MEMORY/SKILLS/execution.jsonl');
  const neverInvokedSkills = neverInvoked(skills, executionLogPath, 30);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ totals, contested, pairs, hollow, neverInvoked: neverInvokedSkills }));
  else {
    console.log(`TOTALS: ${totals.skills} skills, ${totals.totalChars} description chars, mean ${totals.meanChars.toFixed(1)}, max ${totals.maxChars} (${totals.maxSkill})`);
    console.log('CONTESTED PHRASES:');
    for (const item of contested.slice(0, 15)) console.log(`  "${item.phrase}"  ${item.claimedBy.length} skills: ${item.claimedBy.join(', ')}`);
    console.log('OVERLAPPING PAIRS:');
    for (const item of pairs.slice(0, 15)) console.log(`  ${item.a} ~ ${item.b}  jaccard ${item.jaccard.toFixed(2)}  shared: ${item.shared.join(', ')}`);
    console.log('HOLLOW SKILLS (routing cost vs delivered content):');
    for (const item of hollow) console.log(`  ${item.name}  ${item.chars} desc chars  ${item.contentBytes}B content  ratio ${item.ratio.toFixed(1)}`);
    console.log('NEVER INVOKED (last 30d):');
    for (const item of neverInvokedSkills.slice(0, 15)) console.log(`  ${item.name}  ${item.chars} chars`);
    // The miss number is only as good as the log behind it, so the line says how much
    // of the namespace can be observed at all. A low observable count means the miss
    // side is undercounting, and reading the overlap number alone would invert the bias.
    const observable = observableSkills(skills, executionLogPath).length;
    console.log(`namespace: ${totals.skills} skills / ${totals.totalChars} chars · contested ${contested.length} · hollow ${hollow.length} · never-invoked ${neverInvokedSkills.length} of ${observable} observable`);
  }
}
