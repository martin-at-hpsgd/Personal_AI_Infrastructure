#!/usr/bin/env bun
/**
 * Scaffold — writes a new skill, or a new intent in an existing skill, from the
 * templates in ../References/IntentTemplate.md, so every file starts at the
 * intent standard (LIFEOS/DOCUMENTATION/Skills/SkillSystem.md § Intent anatomy).
 *
 * Usage (run from ~/.claude):
 *   bun skills/CreateSkill/Tools/Scaffold.ts skill <Name> --intents <A,B> [--description "<...>"] [--summary "<...>"] [--data-config] [--root <skillsDir>] [--json]
 *   bun skills/CreateSkill/Tools/Scaffold.ts skill <Name> --single [--description "<...>"] [--summary "<...>"] [--data-config] [--root <skillsDir>] [--json]
 *   bun skills/CreateSkill/Tools/Scaffold.ts intent <Skill> <Intent> [--trigger "<phrase>"] [--no-route] [--root <skillsDir>] [--json]
 *
 * --summary sets frontmatter `metadata.short-description`, the one-sentence summary the Codex
 * skill catalog shows (cap SUMMARY_MAX_CHARS from LIFEOS/CODEX/SkillCatalog.ts, enforced by
 * IntentLint). Without it the summary is the description's first sentence before "USE WHEN",
 * cut at a word boundary with "…" when it would pass the cap; with neither flag it is a
 * placeholder to rewrite.
 *
 * Every intent (and a single-intent SKILL.md) is born with a `## Evals` section naming its Assay eval set,
 * "- compiled: …" by default; renderIntent refuses a template that drops it.
 *
 * Exit codes: 0 written · 1 refused (bad arguments, invalid name, target exists,
 * no routing table) · 2 template unreadable or malformed.
 * Never overwrites: every file is opened with the exclusive-create flag.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariant } from '../../../LIFEOS/TOOLS/Invariant';
import { getClaudeDir } from '../../../LIFEOS/TOOLS/Paths';
import { SUMMARY_MAX_CHARS } from '../../../LIFEOS/CODEX/SkillCatalog';

export type TemplateName = 'intent' | 'skill' | 'skill-single' | 'data-config';
export type Templates = Record<TemplateName, string>;

export const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'References', 'IntentTemplate.md');
const TEMPLATE_NAMES: TemplateName[] = ['intent', 'skill', 'skill-single', 'data-config'];
const DESCRIPTION_MAX = 1024;
const PLACEHOLDER_DESCRIPTION = '<What it does>. USE WHEN <trigger phrase>, <another trigger phrase>. NOT FOR <confusable request> (<OtherSkill>).';
const PLACEHOLDER_SUMMARY = '<One plain sentence saying what the skill does.>';

/** Expected, operator-visible failure: reported with exit 1, never thrown past main. */
export class ScaffoldRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'ScaffoldRefusal'; }
}
/** The template file is missing or a marker/fence is broken: exit 2. */
export class TemplateError extends Error {
  constructor(message: string) { super(message); this.name = 'TemplateError'; }
}

/** Reads each `<!-- template:NAME -->` marker and the `~~~~` fence that follows it. */
export function extractTemplates(source: string): Templates {
  const lines = source.split(/\r?\n/);
  const found = new Map<TemplateName, string>();
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^<!--\s*template:([a-z-]+)\s*-->\s*$/);
    if (!marker) continue;
    const name = marker[1] as TemplateName;
    if (!TEMPLATE_NAMES.includes(name)) throw new TemplateError(`unknown template marker "${marker[1]}" at line ${i + 1}`);
    if (found.has(name)) throw new TemplateError(`duplicate template marker "${name}" at line ${i + 1}`);
    let open = i + 1;
    while (open < lines.length && lines[open].trim() === '') open++;
    if (open >= lines.length || !/^~~~~/.test(lines[open])) throw new TemplateError(`template "${name}" has no ~~~~ fence after its marker`);
    let close = open + 1;
    while (close < lines.length && lines[close] !== '~~~~') close++;
    if (close >= lines.length) throw new TemplateError(`template "${name}" fence is never closed`);
    found.set(name, lines.slice(open + 1, close).join('\n'));
    i = close;
  }
  const missing = TEMPLATE_NAMES.filter(name => !found.has(name));
  if (missing.length) throw new TemplateError(`template file is missing: ${missing.join(', ')}`);
  return Object.fromEntries(found) as Templates;
}

export function loadTemplates(path: string = TEMPLATE_PATH): Templates {
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch (error) {
    throw new TemplateError(`cannot read ${path}: ${(error as Error).message}`);
  }
  return extractTemplates(source);
}

/** Public skills and intents: TitleCase with at least one lowercase letter (CREATESKILL is not TitleCase). */
export function isTitleCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}
/** Private skills: underscore, then uppercase letters, digits and underscores. */
export function isPrivateName(name: string): boolean {
  return /^_[A-Z][A-Z0-9_]*$/.test(name);
}
export function isSkillName(name: string): boolean {
  return isTitleCase(name) || isPrivateName(name);
}

/** Single-line, carries USE WHEN, within the cap. Returns the problem, or undefined when valid. */
export function descriptionProblem(description: string): string | undefined {
  if (/[\r\n]/.test(description)) return 'description must be a single line';
  if (!/\bUSE WHEN\b/.test(description)) return 'description must contain "USE WHEN"';
  if (description.length > DESCRIPTION_MAX) return `description is ${description.length} chars; the cap is ${DESCRIPTION_MAX}`;
  return undefined;
}

/** Nonempty, single-line, trimmed, within the catalog cap in code points (SkillCatalog measures the same way). */
export function summaryProblem(summary: string): string | undefined {
  if (/[\r\n]/.test(summary)) return 'summary must be a single line';
  if (summary.trim().length === 0) return 'summary must not be empty';
  if (summary.trim() !== summary) return 'summary must not start or end with whitespace';
  const length = [...summary].length;
  if (length > SUMMARY_MAX_CHARS) return `summary is ${length} chars; the cap is ${SUMMARY_MAX_CHARS}`;
  return undefined;
}

/**
 * The default summary: the description's first sentence before "USE WHEN". When that passes the cap
 * it is cut at the last word boundary and closed with "…". Returns the placeholder when nothing precedes
 * "USE WHEN", so the scaffold still lints clean and the gap stays visible.
 */
export function summaryFromDescription(description: string): string {
  const head = description.split(/\s*\bUSE WHEN\b/)[0].trim();
  const sentence = (/^(.+?[.!?])(?=\s|$)/.exec(head)?.[1] ?? head).trim();
  if (sentence.length === 0) return PLACEHOLDER_SUMMARY;
  const chars = [...sentence];
  if (chars.length <= SUMMARY_MAX_CHARS) return sentence;
  const window = chars.slice(0, SUMMARY_MAX_CHARS - 1).join('');
  const space = window.lastIndexOf(' ');
  const cut = (space > 24 ? window.slice(0, space) : window).replace(/[\s,;:—–-]+$/, '');
  const out = `${cut}…`;
  invariant([...out].length <= SUMMARY_MAX_CHARS, `derived summary must fit the ${SUMMARY_MAX_CHARS}-char cap`);
  return out;
}

/** A plain YAML scalar breaks on ": ", " #" or a leading indicator; those are emitted double-quoted. */
export function yamlScalar(value: string): string {
  const unsafe = /: |\s#|^[-?:,[\]{}#&*!|>'"%@`]|^\s|\s$/.test(value);
  return unsafe ? JSON.stringify(value) : value;
}

function fill(template: string, slots: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(slots)) out = out.split(`{{${key}}}`).join(value);
  invariant(!/\{\{[A-Za-z]+\}\}/.test(out), `unfilled template slot remains: ${out.match(/\{\{[A-Za-z]+\}\}/)?.[0]}`);
  return out.endsWith('\n') ? out : `${out}\n`;
}

export function routingRow(intent: string, trigger: string): string {
  return `| **${intent}** | "${trigger}" | \`Intents/${intent}.md\` |`;
}

function dataConfigBlock(templates: Templates, skill: string): string {
  return `\n${fill(templates['data-config'], { SkillName: skill }).trim()}\n`;
}

/** Every intent is born naming its eval set (SkillSystem.md § Intent anatomy, `## Evals`); IntentLint holds it to that. */
export function hasEvalsLine(markdown: string): boolean {
  return /^## Evals\s*\n(?:\s*\n)*[-*] +\S/m.test(markdown);
}

export function renderIntent(templates: Templates, intent: string): string {
  const out = fill(templates.intent, { IntentName: intent });
  invariant(hasEvalsLine(out), 'the intent template must give every new intent its "## Evals" line');
  return out;
}

export interface SkillOptions { name: string; intents: string[]; single: boolean; description?: string; summary?: string; dataConfig: boolean }

export function renderSkill(templates: Templates, opts: SkillOptions): string {
  const description = yamlScalar(opts.description ?? PLACEHOLDER_DESCRIPTION);
  const rawSummary = opts.summary ?? (opts.description !== undefined ? summaryFromDescription(opts.description) : PLACEHOLDER_SUMMARY);
  invariant(summaryProblem(rawSummary) === undefined, `summary must be valid before rendering: ${summaryProblem(rawSummary)}`);
  const Summary = JSON.stringify(rawSummary);
  const DataConfig = opts.dataConfig ? dataConfigBlock(templates, opts.name) : '';
  if (opts.single) {
    // A single-intent skill's SKILL.md is its intent, so it is born with the same `## Evals` line.
    const out = fill(templates['skill-single'], { SkillName: opts.name, Description: description, Summary, DataConfig });
    invariant(hasEvalsLine(out), 'the single-intent skill template must carry the "## Evals" line');
    return out;
  }
  const RoutingRows = opts.intents.map(intent => routingRow(intent, '<trigger phrase>')).join('\n');
  return fill(templates.skill, { SkillName: opts.name, Description: description, Summary, RoutingRows, DataConfig });
}

/**
 * Line index after the last row of the last intents table (header's first column "Intent") in the last
 * `## Intent Routing` section, fences ignored. Falls back to the last table when no header names Intent,
 * so a References table that follows the intents table never receives an intent row.
 */
export function routingInsertIndex(skillMd: string): number | undefined {
  const lines = skillMd.split('\n');
  let fence: string | undefined;
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0].repeat(marker[1].length);
      else if (lines[i].trim().startsWith(fence) && lines[i].trim().replace(/[`~]/g, '') === '') fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^## /.test(lines[i])) {
      if (/^## Intent Routing\s*$/.test(lines[i])) { sectionStart = i; sectionEnd = lines.length; }
      else if (sectionStart >= 0 && sectionEnd === lines.length && i > sectionStart) sectionEnd = i;
    }
  }
  if (sectionStart < 0) return undefined;
  const isRow = (i: number) => /^\s*\|.*\|\s*$/.test(lines[i]);
  let lastRow = -1;
  let lastIntentRow = -1;
  let intentTable = false;
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (!isRow(i)) continue;
    if (!isRow(i - 1)) intentTable = /^\s*\|\s*\**Intent\**\s*\|/i.test(lines[i]);
    lastRow = i;
    if (intentTable) lastIntentRow = i;
  }
  const at = lastIntentRow >= 0 ? lastIntentRow : lastRow;
  return at < 0 ? undefined : at + 1;
}

/** Realpath the root and the target's deepest existing ancestor before the boundary check, so a symlinked component cannot escape. */
export function confined(root: string, target: string): boolean {
  const realRoot = realpathSync(root);
  let existing = resolve(target);
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    tail.unshift(basename(existing));
    existing = parent;
  }
  const real = join(realpathSync(existing), ...tail);
  const rel = relative(realRoot, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface ScaffoldResult { written: string[]; routed?: string; routeRow?: string }

export function scaffoldSkill(root: string, opts: SkillOptions, templates: Templates): ScaffoldResult {
  if (!isSkillName(opts.name)) throw new ScaffoldRefusal(`skill name "${opts.name}" is neither TitleCase (public) nor _ALLCAPS (private)`);
  if (opts.single && opts.intents.length) throw new ScaffoldRefusal('--single and --intents are mutually exclusive');
  if (!opts.single && !opts.intents.length) throw new ScaffoldRefusal('name at least one intent with --intents, or pass --single for a skill with no Intents/');
  const bad = opts.intents.filter(intent => !isTitleCase(intent));
  if (bad.length) throw new ScaffoldRefusal(`intent names must be TitleCase: ${bad.join(', ')}`);
  if (new Set(opts.intents).size !== opts.intents.length) throw new ScaffoldRefusal('duplicate intent names');
  if (opts.description !== undefined) {
    const problem = descriptionProblem(opts.description);
    if (problem) throw new ScaffoldRefusal(problem);
  }
  if (opts.summary !== undefined) {
    const problem = summaryProblem(opts.summary);
    if (problem) throw new ScaffoldRefusal(problem);
  }
  if (!existsSync(root)) throw new ScaffoldRefusal(`skills root ${root} does not exist`);
  const dir = join(root, opts.name);
  if (existsSync(dir)) throw new ScaffoldRefusal(`${dir} already exists; edit it with UpdateSkill instead`);

  const skillMd = renderSkill(templates, opts);
  const intents = opts.intents.map(intent => ({ path: join(dir, 'Intents', `${intent}.md`), body: renderIntent(templates, intent) }));
  invariant(confined(root, dir), `skill directory ${dir} must sit inside ${root}`);
  invariant(!skillMd.includes('## Voice Notification') && !intents.some(i => i.body.includes('## Voice Notification')), 'templates must not carry a voice block');

  mkdirSync(dir);
  const written: string[] = [];
  writeFileSync(join(dir, 'SKILL.md'), skillMd, { flag: 'wx' });
  written.push(join(dir, 'SKILL.md'));
  if (intents.length) mkdirSync(join(dir, 'Intents'));
  for (const intent of intents) {
    writeFileSync(intent.path, intent.body, { flag: 'wx' });
    written.push(intent.path);
  }
  return { written };
}

export function scaffoldIntent(root: string, opts: { skill: string; intent: string; trigger?: string; route: boolean }, templates: Templates): ScaffoldResult {
  if (!isSkillName(opts.skill)) throw new ScaffoldRefusal(`skill name "${opts.skill}" is neither TitleCase nor _ALLCAPS`);
  if (!isTitleCase(opts.intent)) throw new ScaffoldRefusal(`intent name "${opts.intent}" must be TitleCase`);
  const dir = join(root, opts.skill);
  const skillPath = join(dir, 'SKILL.md');
  if (!existsSync(skillPath)) throw new ScaffoldRefusal(`${skillPath} does not exist; create the skill first`);
  const intentsDir = join(dir, 'Intents');
  const target = join(intentsDir, `${opts.intent}.md`);
  if (existsSync(target)) throw new ScaffoldRefusal(`${target} already exists`);
  const skillMd = readFileSync(skillPath, 'utf8');
  if (!existsSync(intentsDir) && /^## Ideal State\s*$/m.test(skillMd)) {
    throw new ScaffoldRefusal(`${opts.skill} is a single-intent skill (no Intents/; its SKILL.md carries the Anti-criteria); move its Anti-criteria and deliverable bullets into Intents/<FirstIntent>.md and keep a skill-level Ideal State in SKILL.md before adding another intent`);
  }

  const row = routingRow(opts.intent, opts.trigger ?? '<trigger phrase>');
  let updated: string | undefined;
  if (opts.route) {
    const at = routingInsertIndex(skillMd);
    if (at === undefined) throw new ScaffoldRefusal(`${skillPath} has no table under "## Intent Routing"; pass --no-route and add the row by hand`);
    const lines = skillMd.split('\n');
    lines.splice(at, 0, row);
    updated = lines.join('\n');
  }
  const body = renderIntent(templates, opts.intent);
  invariant(confined(root, target), `intent ${target} must sit inside ${root}`);
  invariant(updated === undefined || updated.length === skillMd.length + row.length + 1, 'routing insert adds exactly one line');

  if (!existsSync(intentsDir)) mkdirSync(intentsDir);
  writeFileSync(target, body, { flag: 'wx' });
  if (updated !== undefined) writeFileSync(skillPath, updated);
  return { written: [target], routed: updated !== undefined ? skillPath : undefined, routeRow: row };
}

interface Parsed { positional: string[]; flags: Map<string, string | true> }
const VALUE_FLAGS = new Set(['--intents', '--description', '--summary', '--root', '--trigger']);
const BOOL_FLAGS = new Set(['--single', '--data-config', '--no-route', '--json', '--help']);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ScaffoldRefusal(`${arg} needs a value`);
      flags.set(arg, value);
      i++;
    } else if (BOOL_FLAGS.has(arg)) flags.set(arg, true);
    else if (arg.startsWith('--')) throw new ScaffoldRefusal(`unknown flag ${arg}`);
    else positional.push(arg);
  }
  return { positional, flags };
}

const HELP = `Scaffold — new skills and intents from References/IntentTemplate.md

  skill <Name> --intents <A,B> [--description "<...>"] [--summary "<...>"] [--data-config]
  skill <Name> --single [--description "<...>"] [--summary "<...>"] [--data-config]
  intent <Skill> <Intent> [--trigger "<phrase>"] [--no-route]

--summary  metadata.short-description, one plain sentence of at most ${SUMMARY_MAX_CHARS} chars
           (the Codex skill catalog shows it; IntentLint enforces the cap). Default: the
           --description's first sentence before USE WHEN, cut at a word with "…" past the cap.

Common: --root <skillsDir> (default ~/.claude/skills), --json
Exit: 0 written, 1 refused, 2 template unreadable. Never overwrites.`;

export function main(argv: string[]): number {
  let json = false;
  try {
    const { positional, flags } = parseArgs(argv);
    json = flags.has('--json');
    if (flags.has('--help') || positional.length === 0) { console.log(HELP); return positional.length === 0 && !flags.has('--help') ? 1 : 0; }
    const root = resolve((flags.get('--root') as string | undefined) ?? join(getClaudeDir(), 'skills'));
    const templates = loadTemplates();
    const [command, ...rest] = positional;
    let result: ScaffoldResult;
    if (command === 'skill') {
      if (rest.length !== 1) throw new ScaffoldRefusal('usage: skill <Name> (--intents <A,B> | --single)');
      const intentsFlag = flags.get('--intents');
      const intents = typeof intentsFlag === 'string' ? intentsFlag.split(',').map(s => s.trim()).filter(Boolean) : [];
      const description = flags.get('--description');
      const summary = flags.get('--summary');
      result = scaffoldSkill(root, { name: rest[0], intents, single: flags.has('--single'), description: typeof description === 'string' ? description : undefined, summary: typeof summary === 'string' ? summary : undefined, dataConfig: flags.has('--data-config') }, templates);
    } else if (command === 'intent') {
      if (rest.length !== 2) throw new ScaffoldRefusal('usage: intent <Skill> <Intent>');
      const trigger = flags.get('--trigger');
      result = scaffoldIntent(root, { skill: rest[0], intent: rest[1], trigger: typeof trigger === 'string' ? trigger : undefined, route: !flags.has('--no-route') }, templates);
    } else throw new ScaffoldRefusal(`unknown command "${command}"; expected skill or intent`);

    if (json) console.log(JSON.stringify({ ok: true, ...result }));
    else {
      for (const file of result.written) console.log(`wrote ${file}`);
      if (result.routed) console.log(`routed ${result.routeRow} into ${result.routed}`);
      else if (result.routeRow && command === 'intent') console.log(`add this row to ## Intent Routing: ${result.routeRow}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ScaffoldRefusal || error instanceof TemplateError) {
      const code = error instanceof TemplateError ? 2 : 1;
      if (json) console.log(JSON.stringify({ ok: false, error: error.message }));
      else console.error(`scaffold: ${error.message}`);
      return code;
    }
    throw error;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
