import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, extname } from 'node:path';
import { parse } from 'yaml';
import { invariant } from './Invariant';

export interface ArtifactRequirement {
  id: string;
  path: string;
  fields: string[];
  /** An agent/slash command, not shell code; displayed, never executed. */
  produce?: string;
}
export interface IntentContract {
  requires: ArtifactRequirement[];
  /** Plain strings are case-insensitive substrings; /expression/flags are regexes. */
  bans?: string[];
  /** Plain strings are case-insensitive substrings; /expression/flags are regexes. */
  mandates?: string[];
}
export type VerificationResult = { ok: true } | { ok: false; failures: string[] };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim().length > 0);
}
function promptPattern(value: string, kind: 'ban' | 'mandate'): RegExp | string {
  if (!value.startsWith('/')) return value.toLowerCase();
  const end = value.lastIndexOf('/');
  if (end === 0) throw new Error(`Invalid ${kind} pattern: ${value}`);
  return new RegExp(value.slice(1, end), value.slice(end + 1));
}

/** No frontmatter or no contract preserves the legacy intent behavior. Bad contracts fail closed. */
export function loadContract(intentPath: string): IntentContract | undefined {
  const text = readFileSync(intentPath, 'utf8').replace(/^\uFEFF/, '');
  if (!/^---\s*\r?\n/.test(text)) return undefined;
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!frontmatter) throw new Error(`${intentPath}: unterminated YAML frontmatter`);
  const data: unknown = parse(frontmatter[1]);
  if (!object(data) || !Object.hasOwn(data, 'contract')) return undefined;
  const contract = data.contract;
  const invalid = (detail: string): never => { throw new Error(`${intentPath}: invalid contract: ${detail}`); };
  if (!object(contract) || !Array.isArray(contract.requires)) return invalid('requires must be a list');
  const ids = new Set<string>();
  const requires: ArtifactRequirement[] = contract.requires.map((entry: unknown) => {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id.trim()
      || typeof entry.path !== 'string' || !entry.path.trim()
      || !strings(entry.fields) || !entry.fields.length) return invalid('each artifact needs id, path, and non-empty fields');
    if (ids.has(entry.id)) return invalid(`duplicate artifact id ${entry.id}`);
    if (entry.produce !== undefined && (typeof entry.produce !== 'string' || !entry.produce.trim())) return invalid(`${entry.id}: produce must be a command string`);
    ids.add(entry.id);
    return { id: entry.id, path: entry.path, fields: entry.fields, produce: entry.produce as string | undefined };
  });
  if (contract.bans !== undefined && !strings(contract.bans)) return invalid('bans must be a string list');
  if (contract.mandates !== undefined && !strings(contract.mandates)) return invalid('mandates must be a string list');
  const bans = contract.bans as string[] | undefined;
  const mandates = contract.mandates as string[] | undefined;
  for (const ban of bans ?? []) promptPattern(ban, 'ban');
  for (const mandate of mandates ?? []) promptPattern(mandate, 'mandate');
  invariant(ids.size === requires.length, 'loaded artifact ids are unique');
  return { requires, bans, mandates };
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.replace(/<!--[\s\S]*?-->/g, '').replace(/[`*_#\s]/g, '').length > 0;
  if (Array.isArray(value)) return value.some(nonEmpty);
  if (object(value)) return Object.values(value).some(nonEmpty);
  return value !== undefined && value !== null;
}

/** Markdown sections end at the next heading, so an empty parent cannot borrow a child's content. */
function artifactFields(path: string, text: string): Map<string, unknown> {
  if (['.json', '.yaml', '.yml'].includes(extname(path).toLowerCase())) {
    const data: unknown = extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parse(text);
    if (!object(data)) throw new Error('expected an object containing the required keys');
    return new Map(Object.entries(data));
  }
  const fields = new Map<string, unknown>();
  let heading: string | undefined;
  let body: string[] = [];
  let fence: { character: string; length: number } | undefined;
  const flush = () => { if (heading !== undefined) fields.set(heading, body.join('\n')); };
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) { flush(); heading = match[1].replace(/\*\*/g, '').trim(); body = []; }
    else body.push(line);
  }
  flush();
  return fields;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function slugBound(path: string, slug: string): boolean {
  return path.split(sep).some(part => part === slug || part.startsWith(`${slug}.`));
}

export function verify(contract: IntentContract | undefined, options: { slug: string; cwd: string; promptText?: string }): VerificationResult {
  if (!contract) return { ok: true };
  const failures: string[] = [];
  const { slug, promptText } = options;
  if (contract.requires.length && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    failures.push('Missing or invalid slug: pass --slug <blog-post-slug> using lowercase letters, digits and hyphens.');
  } else {
    const root = resolve(options.cwd);
    for (const requirement of contract.requires) {
      const path = resolve(root, requirement.path.replaceAll('{slug}', slug));
      const command = requirement.produce?.replaceAll('{slug}', slug).replaceAll('{path}', path);
      const remedy = command ? `Produce it with: ${command}` : `Complete intent artifact ${requirement.id} and save ${path} with non-empty fields: ${requirement.fields.join(', ')}.`;
      const fail = (detail: string) => failures.push(`${requirement.id}: ${detail}. ${remedy}`);
      if (!requirement.path.includes('{slug}') || !within(root, path) || !slugBound(relative(root, path), slug)) {
        fail(`path ${path} must remain inside cwd and contain an exact slug directory or slug filename`);
        continue;
      }
      try {
        const real = realpathSync(path);
        const realRoot = realpathSync(root);
        if (!within(realRoot, real) || !slugBound(relative(realRoot, real), slug)) {
          fail(`resolved artifact ${real} is not bound to slug ${slug}`);
          continue;
        }
        const stat = statSync(path);
        if (!stat.isFile() || stat.nlink !== 1) { fail(`${path} must be a regular, non-hardlinked artifact`); continue; }
        const fields = artifactFields(path, readFileSync(path, 'utf8'));
        for (const field of requirement.fields) {
          if (!fields.has(field)) fail(`missing field/heading "${field}" in ${path}`);
          else if (!nonEmpty(fields.get(field))) fail(`empty field/heading "${field}" in ${path}`);
        }
      } catch (error) {
        fail(`missing or unreadable artifact ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (contract.bans?.length && promptText === undefined) failures.push('Prompt text is required to check intent bans; provide the generated prompt.');
  if (contract.mandates?.length && promptText === undefined) failures.push('Prompt text is required to check intent mandates; build the prompt from the intent template.');
  for (const ban of contract.bans ?? []) {
    const pattern = promptPattern(ban, 'ban');
    if (promptText !== undefined && (typeof pattern === 'string' ? promptText.toLowerCase().includes(pattern) : pattern.test(promptText))) {
      failures.push(`Prompt violates ban ${JSON.stringify(ban)}. Revise the composition and remove the forbidden subject from the prompt (including negative instructions).`);
    }
  }
  for (const mandate of contract.mandates ?? []) {
    const pattern = promptPattern(mandate, 'mandate');
    if (promptText !== undefined && !(typeof pattern === 'string' ? promptText.toLowerCase().includes(pattern) : pattern.test(promptText))) {
      failures.push(`Prompt is missing mandate ${JSON.stringify(mandate)}. Build the prompt from the intent template; a register change never means leaving the style guide.`);
    }
  }
  if (!failures.length) return { ok: true };
  invariant(failures.every(failure => failure.trim().length > 0), 'failed verification explains every failure');
  return { ok: false, failures };
}
