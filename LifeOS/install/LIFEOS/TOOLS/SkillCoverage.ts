/**
 * A fast, read-only counterweight to skill creation. Creation has tools that
 * scaffold, validate, canonicalize, and version skills; retirement had no
 * equivalent intent, so narrowly overlapping skills accumulated unchecked.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir } from './Paths';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'from', 'by', 'at', 'as', 'is', 'it', 'its', 'this', 'that', 'not', 'use', 'when', 'via', 'into', 'any', 'all', 'per', 'own', 'one', 'two', 'plus', 'each', 'every', 'never', 'always', 'only', 'also', 'then', 'than', 'but', 'so', 'what', 'which', 'who', 'how', 'my', 'me', 'i', 'you', 'your', 'their', 'skill', 'skills', 'workflow', 'workflows', 'intent', 'intents', 'principal', 'lifeos',
]);

type Skill = { name: string; description: string; triggers: string[]; tokens: Set<string> };

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((token) => token.length > 2 && !STOP.has(token)));
}

function loadSkills(): Skill[] {
  const skillsDir = join(getClaudeDir(), 'skills');
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): Skill[] => {
      const path = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(path)) return [];
      const content = readFileSync(path, 'utf8');
      const match = content.match(/^description:\s*(.+)$/m);
      if (!match) return [];
      const raw = match[1].trim();
      const description = (/^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw);
      const clause = description.match(/USE WHEN\s+(.*?)(?:\.\s*NOT FOR|$)/is)?.[1] ?? '';
      const triggers = clause.split(/[,;]/).map((trigger) => trigger.trim().toLowerCase().replace(/\.$/, '')).filter((trigger) => trigger.length > 2);
      return [{ name: entry.name, description, triggers, tokens: tokenize(description) }];
    });
}

function buildIdf(skills: Skill[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const skill of skills) for (const token of skill.tokens) df.set(token, (df.get(token) ?? 0) + 1);
  return new Map([...df].map(([token, count]) => [token, Math.log(skills.length / count)]));
}

function weightedOverlap(a: Set<string>, b: Set<string>, idf: Map<string, number>): number {
  let total = 0;
  let shared = 0;
  for (const token of a) {
    const weight = idf.get(token) ?? Math.log(160);
    total += weight;
    if (b.has(token)) shared += weight;
  }
  return total === 0 ? 0 : shared / total;
}

function usage(): void {
  console.error('Usage: bun LIFEOS/TOOLS/SkillCoverage.ts "<what the new skill would do>" [--limit N]');
  console.error('       bun LIFEOS/TOOLS/SkillCoverage.ts --pairs [--min 0.20] [--limit 30]');
}

function numberFlag(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function printPairAudit(skills: Skill[], idf: Map<string, number>, min: number, limit: number): void {
  const pairs: { a: Skill; b: Skill; score: number; shared: string[] }[] = [];
  for (let i = 0; i < skills.length; i++) for (let j = i + 1; j < skills.length; j++) {
    const a = skills[i];
    const b = skills[j];
    const score = (weightedOverlap(a.tokens, b.tokens, idf) + weightedOverlap(b.tokens, a.tokens, idf)) / 2;
    if (score >= min) pairs.push({ a, b, score, shared: [...a.tokens].filter((token) => b.tokens.has(token) && (idf.get(token) ?? Math.log(160)) > 1.5) });
  }
  for (const pair of pairs.sort((x, y) => y.score - x.score).slice(0, limit)) {
    console.log(`  ${Math.round(pair.score * 100)}%  ${pair.a.name}  ↔  ${pair.b.name}`);
    console.log(`    shared: ${pair.shared.slice(0, 8).join(', ')}`);
  }
  console.log('Overlap is a prompt to look, never a verdict. Distinct triggers, tooling or data stores are real reasons to stay apart.');
}

const args = process.argv.slice(2);
if (args.length === 0) {
  usage();
  process.exitCode = 2;
} else {
  const skills = loadSkills();
  const idf = buildIdf(skills);
  if (args.includes('--pairs')) {
    printPairAudit(skills, idf, numberFlag(args, '--min', 0.20), numberFlag(args, '--limit', 30));
  } else {
    const query = args.filter((arg, index) => arg !== '--limit' && args[index - 1] !== '--limit').join(' ');
    if (!query) {
      usage();
      process.exitCode = 2;
    } else {
      const queryTokens = tokenize(query);
      const joinedQuery = [...queryTokens].join(' ');
      const results = skills.map((skill) => {
        const hits = skill.triggers.filter((trigger) => {
          const words = trigger.replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
          return joinedQuery.includes(trigger) || (words.length > 0 && words.every((word) => queryTokens.has(word)));
        });
        return { skill, hits, score: weightedOverlap(queryTokens, skill.tokens, idf) + hits.length * 0.25 };
      }).filter((result) => result.score > 0.05).sort((a, b) => b.score - a.score).slice(0, numberFlag(args, '--limit', 8));
      if (results.length === 0) console.log('No existing skill matches this need. A net-new skill may be justified.');
      for (const result of results) {
        console.log(`  ${Math.round(result.score * 100)}%  ${result.skill.name}`);
        if (result.hits.length) console.log(`    triggers already claimed: ${result.hits.slice(0, 4).join(', ')}`);
        console.log(`    ${result.skill.description.slice(0, 150)}`);
        console.log('');
      }
      const strong = results.filter((result) => result.score >= 0.30);
      if (strong.length) {
        console.log(`STRONG COVERAGE: ${strong.map((result) => result.skill.name).join(', ')}`);
        console.log('Resolve before scaffolding — add an intent there, absorb and supersede, or state the net-new exception.');
        process.exitCode = 1;
      }
    }
  }
}
