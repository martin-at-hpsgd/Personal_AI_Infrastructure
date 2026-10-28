/**
 * Parsed verification coverage for SKILL.md frontmatter.
 *
 * The contract keeps judged suites optional: a skill can instead name a
 * deterministic command or a manual exception. A disposition only counts as
 * declared when its evidence is concrete and currently resolvable. It never
 * claims the named verifier has executed.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { validateSuiteFile } from '../../../skills/Assay/Tools/SuiteManager.ts';

export type CoverageStatus = 'declared' | 'pending' | 'legacy' | 'missing' | 'malformed';

export interface SuiteResolution {
  ok: boolean;
  detail: string;
}

export interface SkillVerificationCoverage {
  status: CoverageStatus;
  /** A concrete declaration exists; execution evidence is reported by the named verifier. */
  declared: boolean;
  reasons: string[];
  evidence: string[];
}

export type SuiteResolver = (name: string) => SuiteResolution;

const VAGUE = /^(?:n\/?a|none|tbd|todo|later|unknown|pending|unverified|not applicable)$/i;

function meaningful(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 8 && !VAGUE.test(value.trim());
}

function frontmatterOf(source: string): { text?: string; error?: string } {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== '---') return { error: 'frontmatter block is missing' };
  const end = lines.slice(1).findIndex((line) => line === '---');
  if (end < 0) return { error: 'frontmatter closing delimiter is missing' };
  return { text: lines.slice(1, end + 1).join('\n') };
}

/**
 * Extract only the `evals:` value before handing it to the YAML parser.
 *
 * Older skill descriptions can contain unquoted colons, which makes their
 * otherwise usable frontmatter invalid as one YAML document. Coverage must not
 * invent a second parser for `evals`; it isolates that field and parses the
 * exact YAML value. A malformed verification value still fails honestly.
 */
function evalsValue(text: string): { yaml?: string; missing?: boolean; inline?: boolean } {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^evals:(?:[ \t].*)?$/.test(line));
  if (index < 0) return { missing: true };
  const line = lines[index];
  const inline = line.slice('evals:'.length).trim();
  if (inline) return { yaml: `value: ${inline}`, inline: true };
  const block: string[] = [];
  for (const following of lines.slice(index + 1)) {
    if (following.trim() && !/^[ \t]/.test(following)) break;
    block.push(following);
  }
  return { yaml: `value:\n${block.join('\n')}` };
}

/** One YAML reader for coverage, execution and grade bindings. */
export function skillEvals(source: string): unknown {
  const fm = frontmatterOf(source);
  if (fm.error) throw new Error(fm.error);
  const field = evalsValue(fm.text!);
  if (field.missing) return undefined;
  const doc = parseDocument(field.yaml!);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc.toJS()?.value;
}

export function skillSuiteNames(source: string): string[] {
  const value = skillEvals(source);
  const suites = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { suites?: unknown }).suites : [];
  return Array.isArray(suites) ? suites.filter((s): s is string => typeof s === 'string') : [];
}

function suitesCoverage(value: unknown, resolveSuite: SuiteResolver, label = 'suites'): SkillVerificationCoverage {
  if (!Array.isArray(value) || value.length === 0) {
    return { status: 'malformed', declared: false, reasons: [`${label} must name at least one suite`], evidence: [] };
  }
  const evidence: string[] = [];
  const reasons: string[] = [];
  for (const name of value) {
    if (!meaningful(name) && !(typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))) {
      reasons.push(`${label} contains an invalid suite name`);
      continue;
    }
    const resolved = resolveSuite(name);
    if (resolved.ok) evidence.push(`suite ${name}`);
    else reasons.push(resolved.detail);
  }
  return reasons.length
    ? { status: 'pending', declared: false, reasons, evidence }
    : { status: 'declared', declared: true, reasons: [], evidence };
}

function deterministicCoverage(value: unknown): SkillVerificationCoverage {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) return { status: 'malformed', declared: false, reasons: ['deterministic must name at least one command'], evidence: [] };
  const evidence: string[] = [];
  const reasons: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasons.push('deterministic evidence must contain command and falsifier');
      continue;
    }
    const { command, falsifier } = entry as Record<string, unknown>;
    const { lane, stage } = entry as Record<string, unknown>;
    if (lane !== undefined && !['liveness', 'integrity', 'build', 'fast', 'deep'].includes(String(lane))) reasons.push('deterministic lane must be liveness, integrity or build');
    if (stage !== undefined && (!Number.isSafeInteger(stage) || Number(stage) < 1)) reasons.push('deterministic stage must be a positive integer');
    if (!meaningful(command)) reasons.push('deterministic command is missing or vague');
    if (!meaningful(falsifier)) reasons.push('deterministic falsifier is missing or vague');
    if (meaningful(command) && meaningful(falsifier)) evidence.push(`command ${command}`);
  }
  return reasons.length
    ? { status: 'malformed', declared: false, reasons, evidence }
    : { status: 'declared', declared: true, reasons: [], evidence };
}

function manualCoverage(value: unknown): SkillVerificationCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'malformed', declared: false, reasons: ['manual exception must name a reason and falsifier'], evidence: [] };
  }
  const { reason, falsifier } = value as Record<string, unknown>;
  const reasons: string[] = [];
  if (!meaningful(reason)) reasons.push('manual exception reason is missing or vague');
  if (!meaningful(falsifier)) reasons.push('manual exception falsifier is missing or vague');
  return reasons.length
    ? { status: 'malformed', declared: false, reasons, evidence: [] }
    : { status: 'declared', declared: true, reasons: [], evidence: ['manual exception'] };
}

/** Parse one skill's verification disposition without treating legacy declines as evidence. */
export function parseSkillVerificationCoverage(source: string, resolveSuite: SuiteResolver): SkillVerificationCoverage {
  const fm = frontmatterOf(source);
  if (fm.error) return { status: 'malformed', declared: false, reasons: [fm.error], evidence: [] };
  const extracted = evalsValue(fm.text!);
  if (extracted.missing) return { status: 'missing', declared: false, reasons: ['verification disposition is missing'], evidence: [] };
  const doc = parseDocument(extracted.yaml!);
  if (doc.errors.length) return { status: 'malformed', declared: false, reasons: [`verification YAML is malformed: ${doc.errors[0].message}`], evidence: [] };
  const parsed = doc.toJS() as { value?: unknown } | null;
  const evals = parsed?.value;

  // The former list syntax named real suites. Keep it valid so existing suite
  // evidence remains evidence while CreateSkill writes the explicit mapping.
  if (Array.isArray(evals)) return suitesCoverage(evals, resolveSuite, 'legacy evals list');
  if (!evals || typeof evals !== 'object') {
    return { status: 'missing', declared: false, reasons: ['unsupported scalar evals disposition has no explicit verification evidence'], evidence: [] };
  }

  const disposition = evals as Record<string, unknown>;
  if ('declined' in disposition) {
    if (extracted.inline) {
      return { status: 'missing', declared: false, reasons: ['compact legacy declined disposition has no explicit verification evidence'], evidence: [] };
    }
    return { status: 'legacy', declared: false, reasons: ['legacy declined disposition lacks a named command, suite, or manual falsifier'], evidence: [] };
  }
  const allowed = new Set(['suites', 'deterministic', 'manual', 'pending']);
  const unknown = Object.keys(disposition).filter((key) => !allowed.has(key));
  if (unknown.length) return { status: 'malformed', declared: false, reasons: [`unknown verification field(s): ${unknown.join(', ')}`], evidence: [] };

  if ('pending' in disposition) {
    const pending = disposition.pending;
    const reason = typeof pending === 'string' ? pending : pending && typeof pending === 'object' ? (pending as Record<string, unknown>).reason : undefined;
    return meaningful(reason)
      ? { status: 'pending', declared: false, reasons: [`verification is pending: ${reason}`], evidence: [] }
      : { status: 'malformed', declared: false, reasons: ['pending verification needs a concrete reason'], evidence: [] };
  }

  const parts: SkillVerificationCoverage[] = [];
  if ('suites' in disposition) parts.push(suitesCoverage(disposition.suites, resolveSuite));
  if ('deterministic' in disposition) parts.push(deterministicCoverage(disposition.deterministic));
  if ('manual' in disposition) parts.push(manualCoverage(disposition.manual));
  if (parts.length === 0) return { status: 'malformed', declared: false, reasons: ['verification disposition names no evidence'], evidence: [] };
  const reasons = parts.flatMap((part) => part.reasons);
  const evidence = parts.flatMap((part) => part.evidence);
  if (parts.some((part) => part.status === 'malformed')) return { status: 'malformed', declared: false, reasons, evidence };
  if (parts.some((part) => !part.declared)) return { status: 'pending', declared: false, reasons, evidence };
  return { status: 'declared', declared: true, reasons: [], evidence };
}

/** Resolve a runnable v2 suite in the runners' user-first filename order. */
export function createSuiteResolver(roots: string[]): SuiteResolver {
  const cache = new Map<string, SuiteResolution>();
  return (name: string): SuiteResolution => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return { ok: false, detail: `suite '${name}' has an invalid name` };
    const cached = cache.get(name);
    if (cached) return cached;
    for (const root of roots) {
      for (const ext of ['yaml', 'yml']) {
        for (const path of [join(root, `${name}.${ext}`), join(root, 'Regression', `${name}.${ext}`), join(root, 'Capability', `${name}.${ext}`)]) {
          if (!existsSync(path)) continue;
          try {
            const validation = validateSuiteFile(path);
            const result = validation.ok
              ? { ok: true, detail: path }
              : { ok: false, detail: `suite '${name}' is not runnable: ${validation.errors.join('; ')}` };
            cache.set(name, result);
            return result;
          } catch (error) {
            const result = { ok: false, detail: `suite '${name}' is not runnable: ${(error as Error).message}` };
            cache.set(name, result);
            return result;
          }
        }
      }
    }
    const result = { ok: false, detail: `suite '${name}' resolves in neither Assay suite root as a runnable suite` };
    cache.set(name, result);
    return result;
  };
}
