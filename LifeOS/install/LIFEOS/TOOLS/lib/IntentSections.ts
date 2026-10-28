/**
 * IntentSections — the one parser for skill intent files (SkillSystem.md § Intent anatomy).
 *
 * IntentLint, IntentPreserve, Proof (`--intent`), the intent voice hook and
 * Assay rubric builders all read intents through this module, so "what an
 * intent says done is" has one definition.
 *
 * Read-only: parses text, writes nothing.
 *
 * @version 1.2.0
 */

/** The H2 sections allowed after `## Ideal State` and `## Anti-criteria`. */
export const ALLOWED_SECTIONS = [
  'Evals',
  'Inputs',
  'Safety gates',
  'Tool contract',
  'Gotchas',
  'Output format',
  'Examples',
  'References',
] as const;

export const REQUIRED_SECTIONS = ['Ideal State', 'Anti-criteria'] as const;

export interface Section {
  /** Heading text without the leading `## `. */
  title: string;
  /** 1-based line number of the heading. */
  line: number;
  /** Body text between this heading and the next H2 (or EOF). */
  body: string;
}

export interface ParsedIntent {
  /** Frontmatter text without the fences, or null. */
  frontmatter: string | null;
  /** The H1 title, or null. */
  title: string | null;
  /** Text between the H1 (or frontmatter) and the first H2. */
  preamble: string;
  /** H2 sections in order. Headings inside fenced code blocks are ignored. */
  sections: Section[];
  /** Top-level bullets of `## Ideal State`. */
  idealState: string[];
  /** Top-level bullets of `## Anti-criteria`. */
  antiCriteria: string[];
  /** The `## Evals` entries, or null when the intent has no `## Evals` section (SkillSystem.md § Intent anatomy). */
  evals: EvalRef[] | null;
}

/**
 * One `## Evals` bullet: the eval set an intent's output must pass besides the checks Assay compiles from its Ideal State
 * and Anti-criteria. `compiled` says the compiled checks are the whole set; `library: <name>` inherits a shared check
 * library (skills/Assay/Libraries/<name>.yaml, e.g. `library: video`); `suite: <name>` a suite under skills/Assay/Suites.
 * Anything else is `unknown`. Backticks around the entry and a trailing reason (` — why`) are allowed.
 */
export type EvalRef =
  | { kind: 'compiled'; text: string }
  | { kind: 'library' | 'suite'; name: string; text: string }
  | { kind: 'unknown'; text: string };

/** The entries of an `## Evals` section body, one per top-level bullet. Pure. */
export function parseEvals(body: string): EvalRef[] {
  return topLevelBullets(body).map((text): EvalRef => {
    const bare = text.replace(/`/g, '').trim();
    const named = bare.match(/^(library|suite)\s*:\s*([A-Za-z0-9][\w./-]*?)(?=[\s,;:(—–]|$)/i);
    if (named) return { kind: named[1].toLowerCase() as 'library' | 'suite', name: named[2], text };
    if (/^compiled\b/i.test(bare)) return { kind: 'compiled', text };
    return { kind: 'unknown', text };
  });
}

/**
 * True when Assay can compile a bullet into a check: it states a claim of at least three words once link targets,
 * code fences and emphasis are set aside. An empty, one-word or "TBD" bullet compiles to nothing. Pure.
 */
export function compilableBullet(bullet: string): boolean {
  const text = bullet.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ' ');
  if (/^\s*(?:tbd|todo|tk|n\/?a)\b/i.test(text)) return false;
  return (text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length >= 3;
}

const FENCE = /^\s*(```|~~~)/;

/** Splits markdown into lines, marking which lines sit inside a fenced block. */
export function fencedLines(text: string): { text: string; fenced: boolean }[] {
  const out: { text: string; fenced: boolean }[] = [];
  let inFence = false;
  let marker = '';
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(FENCE);
    if (m) {
      if (!inFence) { inFence = true; marker = m[1]; out.push({ text: raw, fenced: true }); continue; }
      if (m[1] === marker) { out.push({ text: raw, fenced: true }); inFence = false; continue; }
    }
    out.push({ text: raw, fenced: inFence });
  }
  return out;
}

export interface FencedBlock {
  /** 1-based line of the opening fence. */
  start: number;
  /** 1-based line of the closing fence, or the last line when the block is unterminated. */
  end: number;
  /** Lines between the fences, each with its 1-based line number. */
  body: { text: string; line: number }[];
}

/** The fenced blocks of a markdown text, with the same open/close rules as fencedLines. */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { marker: string; block: FencedBlock } | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const m = raw.match(FENCE);
    if (!open) {
      if (m) open = { marker: m[1], block: { start: line, end: line, body: [] } };
      return;
    }
    open.block.end = line;
    if (m && m[1] === open.marker) { blocks.push(open.block); open = null; return; }
    open.block.body.push({ text: raw, line });
  });
  if (open) blocks.push((open as { block: FencedBlock }).block);
  return blocks;
}

/** Top-level `- ` / `* ` bullets of a section body, continuation lines joined. */
export function topLevelBullets(body: string): string[] {
  const bullets: string[] = [];
  for (const { text, fenced } of fencedLines(body)) {
    if (fenced) continue;
    const m = text.match(/^[-*] +(.*\S)\s*$/);
    if (m) { bullets.push(m[1]); continue; }
    if (bullets.length && /^\s{2,}\S/.test(text) && !/^\s*[-*] /.test(text)) {
      bullets[bullets.length - 1] += ' ' + text.trim();
    }
  }
  return bullets;
}

export function parseIntent(text: string): ParsedIntent {
  let body = text.replace(/^﻿/, '');
  let frontmatter: string | null = null;
  let offset = 0;
  const fm = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (fm) {
    frontmatter = fm[1];
    offset = fm[0].split(/\r?\n/).length - 1;
    body = body.slice(fm[0].length);
  }
  const lines = fencedLines(body);
  let title: string | null = null;
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: { title: string; line: number; body: string[] } | null = null;
  lines.forEach(({ text: l, fenced }, i) => {
    if (!fenced && title === null && !current && /^# \S/.test(l)) { title = l.slice(2).trim(); return; }
    if (!fenced && /^## \S/.test(l)) {
      if (current) sections.push({ title: current.title, line: current.line, body: current.body.join('\n') });
      current = { title: l.slice(3).trim(), line: i + 1 + offset, body: [] };
      return;
    }
    if (current) current.body.push(l); else preamble.push(l);
  });
  if (current) {
    const c = current as { title: string; line: number; body: string[] };
    sections.push({ title: c.title, line: c.line, body: c.body.join('\n') });
  }
  const find = (name: string) => sections.find(s => s.title.toLowerCase() === name.toLowerCase());
  const evals = find('Evals');
  return {
    frontmatter,
    title,
    preamble: preamble.join('\n'),
    sections,
    idealState: topLevelBullets(find('Ideal State')?.body ?? ''),
    antiCriteria: topLevelBullets(find('Anti-criteria')?.body ?? ''),
    evals: evals ? parseEvals(evals.body) : null,
  };
}

/** `skills/<Skill>/Intents/<Intent>.md` → names, or null when the path is not an intent. */
export function intentFromPath(path: string): { skill: string; intent: string } | null {
  const m = path.replace(/\\/g, '/').match(/(?:^|\/)skills\/([^/]+)\/Intents\/([^/]+)\.md$/);
  return m ? { skill: m[1], intent: m[2] } : null;
}

/** Matches the legacy per-intent voice curl (and its multi-line form). */
export const VOICE_CURL = /localhost:31337\/notify/;

/**
 * Matches the legacy text-notification line that sat beside the voice curl:
 * `Running the **X** intent in the **Y** skill` (also the older `workflow` / `from`
 * wording), or the plain-text form when it opens a line. Plain mentions mid-sentence
 * (docs describing the IntentVoice hook) do not match.
 */
export const RUNNING_LINE =
  /Running (?:the )?\*\*[^*\n]+\*\* (?:intent|workflow) (?:in|from) (?:the )?\*\*[^*\n]+\*\* skill|^\s*(?:>\s*)?Running the [\w-]+ (?:intent|workflow) in the [\w-]+ skill/;

/** H2 titles that carried the old per-skill voice instruction (`## Voice Notification`, `## MANDATORY: Voice Notification`). */
export const VOICE_SECTION = /\bvoice notifications?\b/i;

/** H2 titles of the retired done sections, replaced by `## Ideal State` + `## Anti-criteria`. */
export const DONE_SECTION = /^(?:done(?: looks like| when| means| definition)?|(?:the )?deliverables?)$/i;
