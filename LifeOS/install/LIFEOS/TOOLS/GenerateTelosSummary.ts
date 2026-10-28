#!/usr/bin/env bun
/**
 * @version 1.6.5
 * GenerateTelosSummary.ts — Reads TELOS source files and generates a compressed
 * ~60-line summary for boot context loading.
 *
 * Usage: bun run ~/.claude/LIFEOS/TOOLS/GenerateTelosSummary.ts
 *
 * Reads from: ~/.claude/LIFEOS/USER/TELOS/*.md (source files)
 * Writes to:  ~/.claude/LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md
 *
 * Design decisions (from Council debate 2026-03-26):
 * - Generated, never hand-authored (Reed's precondition)
 * - Structural compression preserving causal links (M→G→P→S chains)
 * - ~60 lines targeting signal density over completeness (Nyx's constraint)
 * - Staleness detection via timestamp (Vex's TTL requirement)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { lifeosUserDir } from './LifeosConfig';
import { getClaudeDir } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { parseRisksMarkdown, summaryLines as riskSummaryLines, SUMMARY_HEADER as RISK_HEADER } from './TelosRisks'; // the `## Risks (RN)` register, 2026-09-10
import { exciseRegions } from './TelosRegions';

const TELOS_DIR = join(lifeosUserDir(), 'TELOS');
const OUTPUT_PATH = join(TELOS_DIR, 'PRINCIPAL_TELOS.md');

interface ParsedItem {
  id: string;
  text: string;
  body?: string; // optional body text for heading-form items
}

/**
 * Truncate text, preferring a sentence boundary over a word boundary.
 *
 * A word-boundary cut mid-clause turns a goal into a fragment that reads as a
 * different claim than the one written ("Ship the course by end of
 * the year (moat lines only:..."). When a sentence ends late enough in the window
 * to still carry the point, ending there keeps the summary readable and
 * truthful; otherwise the word-boundary cut stands.
 *
 * public issue #1883, @catchingknives
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.substring(0, max);
  const lastSentence = Math.max(window.lastIndexOf('.'), window.lastIndexOf('!'), window.lastIndexOf('?'));
  if (lastSentence > max * 0.6) return window.substring(0, lastSentence + 1);
  const cut = window.replace(/\s+\S*$/, '');
  return cut + '...';
}

// Map legacy filename → H2 section name in unified TELOS.md.
// LIFEOS/USER/TELOS/TELOS.md is the single source of truth as of 2026-05-01;
// the per-file reads here fall back to that section when the legacy file
// has been archived (Archive/2026-05-01/<filename>).
const LEGACY_FILE_TO_SECTION: Record<string, string> = {
  'MISSION.md':    'mission',
  'GOALS.md':      'goals',
  'PROBLEMS.md':   'problems',
  'STRATEGIES.md': 'strategies',
  'PROJECTS.md':   'projects',
  'CHALLENGES.md': 'challenges',
  'NARRATIVES.md': 'narratives',
  'TRAUMAS.md':    'traumas',
  'WRONG.md':      'wrong',
  'MODELS.md':     'models',
  'BELIEFS.md':    'beliefs',
  'FRAMES.md':     'frames',
  'WISDOM.md':     'wisdom',
  'PREDICTIONS.md':'predictions',
  'RISKS.md':      'risks',
};

let _telosSectionsCache: Record<string, string> | null = null;
function loadTelosSections(): Record<string, string> {
  if (_telosSectionsCache) return _telosSectionsCache;
  const telosPath = join(TELOS_DIR, 'TELOS.md');
  if (!existsSync(telosPath)) {
    _telosSectionsCache = {};
    return _telosSectionsCache;
  }
  // The machine-owned AUTOMATED regions (measured values, verbatim wants) never
  // reach this @-imported summary, wherever a fence sits (delta loop ISC-76).
  const content = exciseRegions(readFileSync(telosPath, 'utf-8'));
  const sections: Record<string, string> = {};
  const lines = content.split('\n');
  let title: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (title === null) return;
    sections[title.toLowerCase()] = body.join('\n').trim();
  };
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      title = m[1].replace(/\s*[—–-].*$/, '').replace(/\s*\(.*\)\s*$/, '').trim();
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  flush();
  _telosSectionsCache = sections;
  return sections;
}

/**
 * Does this source text carry the principal's own content, or only shipped
 * template scaffolding? A block is a placeholder when every one of its lines
 * carries the `(sample` marker parseItems()/paragraphItems() already filter on;
 * a line is scaffolding when it is a horizontal rule, a heading that carries no
 * item ID (an ID'd heading like "### M0: …" IS content), or a wholly
 * emphasis-wrapped line — the *…* footnote every shipped template closes with.
 * That footnote matters: it sits after the file's last H2, so loadTelosSections()
 * attaches it to that section's body, and without this it would let a sample-only
 * final section outrank a populated legacy file.
 * public PR #1809, @0bsolescence
 */
export function hasRealContent(text: string): boolean {
  const isSample = (l: string) => /\(sample\b/i.test(l);
  const isStructural = (l: string) =>
    /^-{3,}$/.test(l) ||
    (/^#{1,6}\s/.test(l) && !/^#{1,6}\s+[A-Z]+\d+\w?:/.test(l)) ||
    /^[*_].*[*_]$/.test(l);
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .some(block => {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length === 0 || lines.every(isSample)) return false;
      return lines.some(l => !isSample(l) && !isStructural(l));
    });
}

function readTelosFile(filename: string): string {
  // Unified-TELOS section first, legacy per-file path as the fallback.
  // TELOS.md is the single source of truth as of 2026-05-01, so a section
  // carrying real content has to WIN over the legacy file rather than lose to
  // it: ScaffoldUser copies the legacy sample stubs into every fresh install,
  // so reading the file first meant those stubs permanently shadowed a
  // populated TELOS.md and the summary rendered template data. Back-compat is
  // intact — an absent, empty, or still-sample-only unified section falls
  // through to the legacy file exactly as before.
  // public PR #1809, @0bsolescence
  //
  // Plural fallback (public issue #1517, @christauff): TELOS.md is
  // hand-authored, and "## MISSIONS" (plural) keyed as 'missions' silently
  // missed the singular 'mission' lookup — the section rendered empty and
  // the fail-loud guard below couldn't see it (same lookup, same miss).
  const sectionKey = LEGACY_FILE_TO_SECTION[filename];
  const sections = sectionKey ? loadTelosSections() : {};
  const unified = sectionKey ? (sections[sectionKey] ?? sections[sectionKey + 's'] ?? '') : '';
  if (hasRealContent(unified)) return unified;
  // Legacy per-file path. Strip leading YAML frontmatter (public issue #1496):
  // in files with no ID-form items, paragraphItems() otherwise swallows the
  // frontmatter block as a garbage first entry (e.g. "M0: --- provenance: ...").
  const path = join(TELOS_DIR, filename);
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').replace(/^---\n[\s\S]*?\n---\n?/, '');
  }
  return unified;
}

// Placeholder filtering is suppressed for exactly one caller: the per-section
// fail-loud guard in generate() re-runs each section's parse sample-blind, which
// is how it tells a fresh still-templated install (items exist, all of them
// placeholders) apart from real format drift (nothing parses at all).
// public issue #1815, @tzioup
let INCLUDE_SAMPLES = false;
function withSamples<T>(fn: () => T): T {
  INCLUDE_SAMPLES = true;
  try { return fn(); } finally { INCLUDE_SAMPLES = false; }
}

// The single placeholder test every parse path must route through. Shipped
// template text must never reach PRINCIPAL_TELOS.md, which is @-imported every
// session — and each path that rolled its own bullet scan instead of calling
// parseItems()/paragraphItems() silently skipped the filter.
// public issue #1815, @tzioup (adjacent: sample text leaked through the
// plain-bullet and wisdom paths)
// `[Bracketed instruction text]` is the other shape shipped templates use for
// "fill this in" — same defect as `(sample …)`, and it reached the summary
// untouched (public issue #1883, @catchingknives).
const isPlaceholder = (text: string) =>
  !INCLUDE_SAMPLES && (/\(sample\b/i.test(text) || /^\[.*\]$/.test(text.trim()));

// Markdown scaffolding no parse path may turn into an item: horizontal rules,
// headings, blockquote callouts (every shipped template writes its guidance
// banner as `>`), and the emphasis-wrapped footnote each template closes with.
// Filtering `(sample` alone was not enough — with the placeholders gone, the
// surrounding template guidance became the parsed content instead.
// public issue #1815, @tzioup (adjacent: sample text leaked through the
// plain-bullet and wisdom paths)
// Legacy TELOS sections wrote their entries as markdown tables. A table row is
// layout, not an item: parsed as one it emitted `| G1 | text | date |` into the
// summary verbatim, delimiter rows included.
// public issue #1883, @catchingknives
const isScaffolding = (line: string): boolean => {
  const l = line.trim();
  return l === '' || /^-{3,}$/.test(l) || l.startsWith('>') ||
    /^#{1,6}\s/.test(l) || /^[*_].*[*_]$/.test(l) ||
    /^\|.*\|$/.test(l) || /^\|?[\s:|-]+\|?$/.test(l);
};

/**
 * Parse items in format "- **ID**: text", "- ID: text", or H3 heading "### ID: text".
 * The unified TELOS.md uses H3 headings (### M0:, ### G0:, etc.) for typed-ID
 * sections (Mission, Goals, Problems, Challenges) — bullets in others (Narratives,
 * Models, Wisdom). Accept both shapes so the parser doesn't silently render empty
 * sections when the source format shifts.
 */
function parseItems(content: string, fallbackPrefix?: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Bullet form: "- **M0**: text", "- M0: text", or colon-inside-bold "- **M0:** text".
    // The trailing asterisk strip handles the colon-inside-bold shape, which
    // otherwise leaks a literal "** " into the rendered summary (issue #1113).
    const bullet = line.match(/^-\s+\*?\*?([A-Z]+\d+\w?)\*?\*?:\s*(.+)/);
    if (bullet) {
      items.push({ id: bullet[1], text: bullet[2].replace(/^\*+\s*/, '').trim() });
      continue;
    }
    // H3 heading form: "### M0: text" (the unified TELOS.md style)
    // public issue #2085, @MatiasBarboza: capture body text for explicit status markers
    const heading = line.match(/^#{3}\s+([A-Z]+\d+\w?):\s*(.+)/);
    if (heading) {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^#{2,3}\s/.test(lines[j]); j++) body.push(lines[j]);
      const bodyText = body.join(' ').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
      items.push({ id: heading[1], text: heading[2].trim(), body: bodyText });
    }
  }
  // H2 heading form with body: "## M0: title" followed by prose until the next
  // heading (public issue #1538, @waveman2020-sudo). Line-based matching alone
  // dropped the ID'd heading and let its multi-paragraph body fall through to
  // the positional-prose fallback, silently fragmenting one entry into fake
  // sequential items. Runs only when no bullet/H3 items matched, so existing
  // formats keep byte-identical output; explicit IDs still win over prose.
  if (items.length === 0) {
    const h2Re = /^#{2}\s+([A-Z]+\d+\w?):\s*(.+)$/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(h2Re);
      if (!m) continue;
      const body: string[] = [];
      for (let j = i + 1; j < lines.length && !/^#{2,3}\s/.test(lines[j]); j++) body.push(lines[j]);
      const bodyText = body.join(' ').replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
      items.push({ id: m[1], text: bodyText ? `${m[2].trim()} — ${bodyText}` : m[2].trim() });
    }
  }
  // Fallback: ID-less prose (2026-06-08 TELOS rewrite). Explicit IDs always win;
  // this path only runs when zero ID-form items matched.
  if (items.length === 0 && fallbackPrefix) {
    return paragraphItems(content, fallbackPrefix);
  }
  // Shipped-template placeholder text must never render as the principal's real
  // content — PRINCIPAL_TELOS.md is @-imported every session (public issue #1528, @vichong).
  // \b not literal ")": templates also write "(sample — …)" variants, which the
  // literal match let through into fresh installs (public issue #1671, @catchingknives).
  return items.filter(item => !isPlaceholder(item.text));
}

/**
 * ID-less prose: each blank-line-separated paragraph is one item, ID assigned
 * positionally (prefix + index). Positional IDs shift if paragraphs reorder —
 * acceptable; the source format carries no stable IDs to preserve.
 */
function paragraphItems(content: string, prefix: string): ParsedItem[] {
  // Strip HTML comments before paragraphing (issue #1472). The unified TELOS
  // format requires an `<!-- updated: … -->` freshness marker after every H2;
  // without this strip the marker survives as its own paragraph and, because
  // downstream truncates to the first N items, EVICTS a real entry.
  return content
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0 && !/^-{3,}$/.test(p) && !p.startsWith('#'))
    // A paragraph made entirely of scaffolding is layout, not an entry. Added
    // alongside the two tests above rather than replacing them, so this can only
    // ever drop more, never admit something they used to reject.
    // public issue #1815, @tzioup (adjacent: sample text leaked through the
    // plain-bullet and wisdom paths)
    .filter(p => !p.split('\n').every(isScaffolding))
    // Skip shipped-template placeholder paragraphs (public issue #1528, @vichong;
    // \b for "(sample — …)" variants, public issue #1671, @catchingknives)
    .filter(p => !isPlaceholder(p))
    .map((p, i) => ({ id: `${prefix}${i}`, text: p.replace(/\s*\n\s*/g, ' ').replace(/^-\s+/, '').trim() }));
}

/**
 * The principal's own Context Filter, read from the unified TELOS.md
 * "## Context Filter" section. The hardcoded line at the call site is a
 * fallback for a TELOS.md that defines no such section — without this, one
 * person's value statement shipped as every install's steering filter.
 * public PR #1808, @0bsolescence
 */
function readContextFilter(): string {
  return (loadTelosSections()['context filter'] ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter(l => !/\(sample\b/i.test(l))
    .join('\n')
    .trim();
}

/**
 * Parse mission items from MISSION.md
 */
function parseMissions(): string[] {
  const content = readTelosFile('MISSION.md');
  const items = parseItems(content, 'M');
  return items.map(i => `- **${i.id}**: ${truncate(i.text, 75)}`);
}

/**
 * Parse goals from GOALS.md, section-aware (issue #1115).
 *
 * Goals are classified by the "## Active" / "## Deferred / Ongoing" /
 * "## Completed This Year" heading each bullet sits under — the shape the
 * shipped GOALS.md template uses. Content before any recognized heading (or a
 * file/section with no headings at all, like the unified TELOS.md goals
 * section) is active. Bullets without explicit IDs get positional IDs so the
 * template's plain-bullet Deferred/Completed sections render instead of being
 * silently dropped. (Replaces the old num>=9/[0,1] numeric heuristic, which
 * encoded one personal file's history and misclassified everyone else's goals.)
 */
function parseGoals(): { active: string[]; deferred: string[]; completed: string[] } {
  const content = readTelosFile('GOALS.md');

  type Bucket = 'active' | 'deferred' | 'completed';
  const bucketOf = (heading: string): Bucket | null => {
    const h = heading.toLowerCase();
    if (h.includes('active')) return 'active';
    if (h.includes('deferred') || h.includes('ongoing')) return 'deferred';
    if (h.includes('completed') || h.includes('done')) return 'completed';
    // Explicit skip: a "## Notes"/"## Note" block is genuinely not goal content.
    if (h.includes('note')) return null;
    // Any other unrecognized heading (e.g. "## Detail") is treated as active
    // goal content — never silently discarded (issue #1473). Dropping real
    // goals under a natural heading is worse than over-including a stray line.
    return 'active';
  };

  // public issue #2085, @MatiasBarboza: an explicit status marker in the item
  // overrides the section heading's bucket.
  //
  // "Explicit" is the whole load-bearing word. The first port upper-cased the
  // item and scanned for bare words, so ordinary prose retired live goals:
  // "Not completed yet." matched COMPLETED, and "unfinished" matched FINISHED
  // through a boundary-less substring. A marker now has to be one of
  //   • a ✅ or a [x] checkbox,
  //   • a standalone UPPERCASE token (ACHIEVED / DONE / COMPLETED …) that no
  //     "not"/"un" negates — lower-case prose never counts,
  //   • a bracketed tag ([DEFERRED], [ON HOLD]),
  //   • an explicit `Status: <value>` field.
  const COMPLETED_TOKENS = ['ACHIEVED', 'COMPLETED', 'DONE', 'SHIPPED', 'FINISHED'] as const;
  const DEFERRED_TOKENS = ['DEFERRED', 'PAUSED', 'BLOCKED'] as const;
  const COMPLETED_STATUS = new Set(['completed', 'complete', 'done', 'achieved']);
  const DEFERRED_STATUS = new Set(['deferred', 'paused', 'blocked', 'onhold']);
  // Uppercase, word-bounded, and not negated by an immediately preceding
  // "not "/"un" (any case). The capture group is what the negation test reads.
  const hasUpperToken = (text: string, tokens: readonly string[]): boolean =>
    tokens.some(tok => {
      const re = new RegExp(`(^|[^A-Za-z])([Nn][Oo][Tt]\\s+|[Uu][Nn])?${tok}(?![A-Za-z])`, 'g');
      for (const m of text.matchAll(re)) if (!m[2]) return true;
      return false;
    });
  const CHECKBOX_COMPLETED = /(?:^|[\s(—–-])(?:✅|\[[xX]\])/;
  const bracketTag = (text: string, tokens: readonly string[]): boolean =>
    new RegExp(`\\[(?:${tokens.join('|')}|ON HOLD)\\]`, 'i').test(text);
  const STATUS_FIELD = /(?:^|\n|\s)status\s*:\s*\**\s*([A-Za-z ]+)/i;
  const statusValue = (text: string): string | null => {
    const m = text.match(STATUS_FIELD);
    return m ? m[1].trim().toLowerCase().replace(/\s+/g, '') : null;
  };
  const bucketOfItem = (heading: string, itemText: string, body?: string): Bucket | null => {
    // The item's own text counts, not only a heading-form item's body: the live
    // TELOS GOALS block is ID-less prose, so every marker lives in `text`.
    const text = [itemText, body].filter(Boolean).join(' ');
    if (!text) return bucketOf(heading);
    const status = statusValue(text);
    if (status && COMPLETED_STATUS.has(status)) return 'completed';
    if (status && DEFERRED_STATUS.has(status)) return 'deferred';
    if (CHECKBOX_COMPLETED.test(text) || hasUpperToken(text, COMPLETED_TOKENS)) return 'completed';
    if (bracketTag(text, DEFERRED_TOKENS) || hasUpperToken(text, DEFERRED_TOKENS)) return 'deferred';
    // No override found; fall back to section heading
    return bucketOf(heading);
  };

  // Track heading and lines for each section
  interface SectionLines { heading: string; lines: string[] }
  const sections: SectionLines[] = [];
  let currentHeading = '';
  let currentLines: string[] = [];

  // The INITIAL unnamed section (heading '') is real goal content and must be
  // kept: the live TELOS `## GOALS` block is prose with no internal H2/H3 at
  // all, so requiring a heading before pushing dropped every goal in the file
  // and generate() then exited 1 on zero items. bucketOf('') buckets it active,
  // exactly as the pre-#2085 parser's `current = 'active'` seed did.
  const pushSection = () => {
    if (currentHeading || currentLines.some(l => l.trim())) {
      sections.push({ heading: currentHeading, lines: currentLines });
    }
  };
  for (const line of content.split('\n')) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      pushSection();
      currentHeading = m[1];
      currentLines = [];
      continue;
    }
    currentLines.push(line);
  }
  pushSection();

  // Parse one section: explicit-ID items first, then plain "- text" bullets,
  // then ID-less prose paragraphs. IDs left empty here get positional IDs
  // assigned globally below (in document order, across sections).
  const parseSection = (section: SectionLines): Array<ParsedItem & { sectionHeading: string }> => {
    const text = section.lines.join('\n');
    const withIds = parseItems(text);
    if (withIds.length > 0) return withIds.map(item => ({ ...item, sectionHeading: section.heading }));
    // isPlaceholder here, not just in parseItems: when every ID'd goal is a
    // template sample, parseItems() correctly returns zero and this plain-bullet
    // path re-collected the very same lines unfiltered, so the shipped samples
    // landed in the summary wearing fresh positional IDs.
    //
    // The prose fallback is keyed on the PRE-filter bullet count, matching the
    // order parseItems() already uses. Deciding it on the filtered count means a
    // wholly-sample bullet list falls through to the template's own guidance
    // prose, which is a worse leak than the samples were.
    // public issue #1815, @tzioup (adjacent: sample text leaked through the
    // plain-bullet and wisdom paths)
    const bullets = section.lines
      .map(l => l.match(/^-\s+(.+)$/))
      .filter((m): m is RegExpMatchArray => m !== null);
    if (bullets.length > 0) {
      return bullets.filter(m => !isPlaceholder(m[1])).map(m => ({ id: '', text: m[1].trim(), sectionHeading: section.heading }));
    }
    return paragraphItems(text, '').map(i => ({ id: '', text: i.text, sectionHeading: section.heading }));
  };

  // Parse all sections and rebucket based on item bodies
  const allParsed = sections.flatMap(s => parseSection(s));
  // Positional IDs follow document order, before bucketing. Numbering inside
  // each bucket put a completed goal after every active one, so marking G6
  // achieved renamed G7 to G6 and broke every link to the later goals.
  // The counter starts ABOVE the highest explicit G<n> so it never re-issues an
  // ID an explicit entry owns (public issue #1529, @vichong).
  let idx = 0;
  for (const item of allParsed) {
    const explicit = item.id.match(/^G(\d+)$/);
    if (explicit) idx = Math.max(idx, Number(explicit[1]) + 1);
  }
  for (const item of allParsed) if (!item.id) item.id = `G${idx++}`;
  const parsed: Record<Bucket, ParsedItem[]> = { active: [], deferred: [], completed: [] };
  for (const item of allParsed) {
    const { sectionHeading, ...cleanItem } = item as any;
    const bucket = bucketOfItem(sectionHeading, item.text, item.body);
    if (bucket) parsed[bucket].push(cleanItem);
  }

  // A goal whose text opens with `[DROPPED …]` keeps its positional ID (so G10
  // stays G10 for every consumer) but does not render — the summary is the
  // active list, not the graveyard.
  const format = (items: ParsedItem[], max: number): string[] =>
    items.flatMap(item => {
      const id = item.id;
      if (/^\[DROPPED\b/i.test(item.text)) return [];
      // Split on " — " (em-dash with spaces) or sentence-ending period (not in URLs)
      const firstSentence = item.text.split(/\s—\s|(?<!\w\.\w)(?<=\w)\.\s/)[0].trim();
      return [`- **${id}**: ${truncate(firstSentence, max)}`];
    });

  return {
    active: format(parsed.active, 70),
    deferred: format(parsed.deferred, 50),
    completed: format(parsed.completed, 50),
  };
}

/**
 * Parse problems from PROBLEMS.md (uses ## headers, not list items)
 */
function parseProblems(): string[] {
  const content = readTelosFile('PROBLEMS.md');
  const lines: string[] = [];

  // Format: ## P0: Title (optional parenthetical)
  // isPlaceholder on the whole matched line: the trailing-parenthetical strip
  // above would otherwise quietly launder "## P0: A problem (sample)" into a
  // clean-looking entry. public issue #1815, @tzioup (adjacent: sample text
  // leaked through the plain-bullet and wisdom paths)
  const headers = [...content.matchAll(/^##\s+(P\d+):\s*(.+?)(?:\s*\(.*\))?\s*$/gm)]
    .filter(m => !isPlaceholder(m[0]));
  for (const match of headers) {
    const title = match[2].trim();
    const short = title.length > 60 ? title.substring(0, 57) + '...' : title;
    lines.push(`- **${match[1]}**: ${short}`);
  }

  // Fallback: try list items, then ID-less prose
  if (lines.length === 0) {
    const items = parseItems(content, 'P');
    for (const item of items) {
      const title = item.text.split(/\s[—–]\s/)[0].trim().replace(/\*\*/g, '');
      lines.push(`- **${item.id}**: ${truncate(title, 60)}`);
    }
  }

  return lines;
}

/**
 * Parse strategies from STRATEGIES.md
 */
function parseStrategies(): string[] {
  const content = readTelosFile('STRATEGIES.md');
  const lines: string[] = [];

  // Extract strategy headers: ## S0: name or ### S1: name
  // Same parenthetical-laundering gap as parseProblems — public issue #1815,
  // @tzioup (adjacent: sample text leaked through the plain-bullet and wisdom paths)
  const headers = [...content.matchAll(/^#{2,3}\s+(S\d+):\s*(.+?)(?:\s*\(.*\))?\s*$/gm)]
    .filter(m => !isPlaceholder(m[0]));
  for (const match of headers) {
    const short = match[2].length > 60 ? match[2].substring(0, 57) + '...' : match[2];
    lines.push(`- **${match[1]}**: ${short}`);
  }

  // Fallback: ID-less prose
  if (lines.length === 0) {
    for (const item of parseItems(content, 'S')) {
      lines.push(`- **${item.id}**: ${truncate(item.text, 60)}`);
    }
  }

  return lines;
}

/**
 * Parse projects from PROJECTS.md — the concrete work pursuing the strategies.
 *
 * Mirrors parseStrategies(): ID'd headers first, ID-less prose as the fallback.
 * The section was authored in TELOS.md but had no parser and no entry in
 * LEGACY_FILE_TO_SECTION, so it never reached the summary at all.
 * public issue #1710, @PaulWaldo
 *
 * IDs use a PJ prefix: the summary already renders Problems as P0…Pn, and a
 * second P-series in the same @-imported file would be ambiguous on sight.
 */
function parseProjects(): string[] {
  const content = readTelosFile('PROJECTS.md');
  const lines: string[] = [];

  // Same parenthetical-laundering gap as parseProblems — public issue #1815,
  // @tzioup (adjacent: sample text leaked through the plain-bullet and wisdom paths)
  const headers = [...content.matchAll(/^#{2,3}\s+(PJ?\d+):\s*(.+?)(?:\s*\(.*\))?\s*$/gm)]
    .filter(m => !isPlaceholder(m[0]));
  for (const match of headers) {
    lines.push(`- **${match[1]}**: ${truncate(match[2].trim(), 60)}`);
  }

  // Fallback: ID-less prose
  if (lines.length === 0) {
    for (const item of parseItems(content, 'PJ')) {
      lines.push(`- **${item.id}**: ${truncate(item.text, 90)}`);
    }
  }

  return lines;
}

/**
 * Parse WISDOM.md — lessons and aphorisms, rendered ID-less like WRONG.md.
 * Quotes are referenced by their text, not by a number.
 * public issue #1710, @PaulWaldo
 */
function parseWisdom(): string[] {
  const content = readTelosFile('WISDOM.md');
  // Own bullet scan, so it needs its own isPlaceholder call, and its own
  // pre-filter fallback count — a wholly-sample bullet list must yield nothing
  // rather than fall through to the template's guidance prose.
  // public issue #1815, @tzioup (adjacent: sample text leaked through the
  // plain-bullet and wisdom paths)
  const bullets = content.split('\n')
    .map(l => l.match(/^-\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  const out = bullets
    .filter(m => !isPlaceholder(m[1]))
    .map(m => `- ${truncate(m[1].trim(), 110)}`);
  // Fallback: ID-less prose
  if (bullets.length === 0) {
    for (const item of paragraphItems(content, 'WI')) {
      out.push(`- ${truncate(item.text, 110)}`);
    }
  }
  return out;
}

/**
 * Parse narratives from NARRATIVES.md
 */
function parseNarratives(): { primary: string[]; secondary: string[] } {
  const content = readTelosFile('NARRATIVES.md');
  const items = parseItems(content, 'N');

  const primary: string[] = [];
  const secondary: string[] = [];

  for (const item of items) {
    const num = parseInt(item.id.replace(/\D/g, ''), 10);

    if ([0, 1, 7].includes(num)) {
      primary.push(`- **${item.id}**: ${truncate(item.text, 75)}`);
    } else {
      secondary.push(`${item.id}: ${truncate(item.text, 60)}`);
    }
  }

  return { primary, secondary };
}

/**
 * Parse challenges from CHALLENGES.md (all items — truncation was hiding real scope)
 */
function parseChallenges(): string[] {
  const content = readTelosFile('CHALLENGES.md');
  const items = parseItems(content, 'C');
  return items.map(i => `- **${i.id}**: ${truncate(i.text, 90)}`);
}

/**
 * Parse WRONG.md — plain bullets without IDs. Each bullet is a past mistake.
 */
function parseWrong(): string[] {
  const content = readTelosFile('WRONG.md');
  // Same own-bullet-scan gap as parseWisdom — public issue #1815, @tzioup
  // (adjacent: sample text leaked through the plain-bullet and wisdom paths).
  const bullets = content.split('\n')
    .map(l => l.match(/^-\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  const out = bullets
    .filter(m => !isPlaceholder(m[1]))
    .map(m => `- ${truncate(m[1].trim(), 110)}`);
  // Fallback: ID-less prose
  if (bullets.length === 0) {
    for (const item of paragraphItems(content, 'W')) {
      out.push(`- ${truncate(item.text, 110)}`);
    }
  }
  return out;
}

/**
 * Parse TRAUMAS.md — formative experiences with TR0/TR1/TR2 IDs.
 */
function parseTraumas(): string[] {
  const content = readTelosFile('TRAUMAS.md');
  const items = parseItems(content, 'TR');
  return items.map(i => `- **${i.id}**: ${truncate(i.text, 90)}`);
}

/**
 * Resolve the principal's display name at runtime (issue #1140). No name — and
 * no installer placeholder — is baked into this source: the installer's
 * substitution walk doesn't cover LIFEOS/TOOLS, so a baked {{PRINCIPAL_FULL_NAME}}
 * token ships literal on fresh installs. Resolution order:
 *   1. PRINCIPAL_IDENTITY.md frontmatter core.full_name
 *   2. PRINCIPAL_IDENTITY.md H1 ("# Principal Identity — <name>")
 *   3. PRINCIPAL_IDENTITY.md frontmatter core.name
 *   4. settings.json principal.name
 * Returns '' when nothing resolves (title renders without the suffix).
 */
function principalDisplayName(): string {
  const looksLikeToken = (s: string) => s.includes('{{') || s.includes('<INTERVIEW');
  const idPath = join(lifeosUserDir(), 'PRINCIPAL', 'PRINCIPAL_IDENTITY.md');
  let coreName = '';
  if (existsSync(idPath)) {
    const content = readFileSync(idPath, 'utf-8');
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const fullName = fm[1].match(/^\s*full_name:\s*["']?(.+?)["']?\s*$/m);
      if (fullName && !looksLikeToken(fullName[1])) return fullName[1].trim();
      const name = fm[1].match(/^\s*name:\s*["']?(.+?)["']?\s*$/m);
      if (name && !looksLikeToken(name[1])) coreName = name[1].trim();
    }
    const h1 = content.match(/^#\s+Principal Identity\s*[—–-]+\s*(.+?)\s*$/m);
    if (h1 && !looksLikeToken(h1[1])) return h1[1].trim();
  }
  if (coreName) return coreName;
  try {
    const settings = JSON.parse(readFileSync(join(getClaudeDir(), 'settings.json'), 'utf-8'));
    const name = settings?.principal?.name;
    if (typeof name === 'string' && name.trim() && !looksLikeToken(name)) return name.trim();
  } catch { /* no settings.json — fall through */ }
  return '';
}

/**
 * Parse models from MODELS.md (first sentence only)
 */
function parseModels(): string[] {
  const content = readTelosFile('MODELS.md');
  const items = parseItems(content, 'MD');
  // Capped at 3 to hold the summary's token budget (Council budget, 2026-03-26);
  // a truncated list says so instead of silently dropping the rest.
  // public issue #2251, @mj-deving
  const MODEL_CAP = 3;
  const lines = items.slice(0, MODEL_CAP).map(i => {
    const first = i.text.split(/\.\s/)[0].trim();
    return `- ${truncate(first, 65)}`;
  });
  if (items.length > MODEL_CAP) lines.push(`- (+${items.length - MODEL_CAP} more in TELOS.md)`);
  return lines;
}

/**
 * Parse the `## Risks (RN)` register — the principal's top life risks with the
 * current state of prevent, detect, and respond. Delegates to TelosRisks.ts so
 * the summary, Socrates, and Pulse read one parser. Empty when the section is
 * absent (a fresh install) or fails to parse (validate reports why).
 */
function parseRisks(): string[] {
  const telosPath = join(TELOS_DIR, 'TELOS.md');
  if (!existsSync(telosPath)) return [];
  const parsed = parseRisksMarkdown(exciseRegions(readFileSync(telosPath, 'utf-8')));
  if (parsed.sectionLine === null) return [];
  if (parsed.errors.length > 0) {
    console.error(`⚠️  TELOS \`## Risks\` has ${parsed.errors.length} parse error(s) — run \`bun LIFEOS/TOOLS/TelosRisks.ts validate\`; rendering the rows that parsed.`);
  }
  return riskSummaryLines(parsed.risks);
}

function generate(): string {
  const now = new Date().toISOString();
  const principalName = principalDisplayName();
  const missions = parseMissions();
  const goals = parseGoals();
  const problems = parseProblems();
  const strategies = parseStrategies();
  const projects = parseProjects();
  const wisdom = parseWisdom();
  const narratives = parseNarratives();
  const challenges = parseChallenges();
  const wrong = parseWrong();
  const traumas = parseTraumas();
  const models = parseModels();
  const risks = parseRisks();

  // Per-section fail-loud guard: a core section whose SOURCE text is non-empty
  // but parses to zero items means the format drifted past the parser for that
  // section alone — the total-items guard in main() can't see a partial drop.
  //
  // The guard has to judge presence exactly the way the parser reads it, or it
  // fires on installs that have nothing real to lose (public issue #1815,
  // @tzioup). It used to read TELOS.md directly while the parse read whatever
  // readTelosFile() resolved, and it never applied the parser's `(sample`
  // filter — so a fresh, wholly-templated tree exited 1 before the user had any
  // content at all. Same resolution now, and a sample-blind re-parse separates
  // "only placeholders here" from "real content the parser can no longer see".
  const sections = loadTelosSections();
  const coreChecks: Array<[string, string, number, () => number]> = [
    ['MISSION.md', 'Missions', missions.length, () => parseMissions().length],
    ['GOALS.md', 'Goals', goals.active.length + goals.deferred.length + goals.completed.length,
      () => { const g = parseGoals(); return g.active.length + g.deferred.length + g.completed.length; }],
    ['PROBLEMS.md', 'Problems', problems.length, () => parseProblems().length],
    ['STRATEGIES.md', 'Strategies', strategies.length, () => parseStrategies().length],
    ['CHALLENGES.md', 'Challenges', challenges.length, () => parseChallenges().length],
  ];
  for (const [filename, label, count, reparse] of coreChecks) {
    if (count > 0) continue;
    if (!readTelosFile(filename).trim()) continue;   // no source for this section at all
    if (withSamples(reparse) > 0) continue;          // source is placeholders only
    console.error(`❌ TELOS section "${label}" has source content but parsed to zero items — refusing to write a summary that silently drops it.`);
    process.exit(1);
  }

  // Orphan-heading warning (public issue #1517, @christauff): the guard above
  // resolves keys through the same lookup it guards, so a heading that drifts
  // past LEGACY_FILE_TO_SECTION (e.g. "## NARRATIVES / PROBLEMS / MODELS"
  // combined under one heading) is invisible to it — both miss, section drops
  // silently. Detect drift from the content side: a non-empty heading no known
  // key claims, but which CONTAINS a known section token, is almost certainly
  // meant to be consumed. Warn, don't fail — headings that share no token with
  // any known section (Ideas, Projects, Current State…) are legitimately
  // consumed by other tools and stay silent.
  const knownKeys = new Set(Object.values(LEGACY_FILE_TO_SECTION));
  for (const [heading, body] of Object.entries(sections)) {
    if (!body.trim()) continue;
    const singular = heading.endsWith('s') ? heading.slice(0, -1) : heading;
    if (knownKeys.has(heading) || knownKeys.has(singular)) continue;
    const tokens = heading.split(/[^a-z]+/).filter(Boolean);
    const hit = tokens.find(t => knownKeys.has(t) || knownKeys.has(t.replace(/s$/, '')));
    if (hit) {
      console.error(`⚠️  TELOS heading "${heading}" has content but matches no known section — its "${hit}" content will be missing from the summary. Known sections: ${[...knownKeys].join(', ')}.`);
    }
  }

  const lines: string[] = [
    '---',
    `last_updated: ${now}`,
    'last_updated_by: GenerateTelosSummary',
    'convention: lifeos-freshness-v1',
    'derived_from: LIFEOS/USER/TELOS/TELOS.md',
    'generator: LIFEOS/TOOLS/GenerateTelosSummary.ts',
    '---',
    '',
    principalName ? `# Principal TELOS — ${principalName}` : '# Principal TELOS',
    '',
    '> Auto-generated from TELOS source files. Do not edit manually.',
    `> Generated: ${now} | Sources: MISSION, GOALS, PROBLEMS, STRATEGIES, PROJECTS, NARRATIVES, CHALLENGES, RISKS, WRONG, TRAUMAS, MODELS, WISDOM`,
  ];

  // Same guard as Core Models and Active Projects below (public issue #1559): an
  // unconditional empty section is exactly the shape ContextAudit's empty-section
  // check reports as `critical`, so emitting one makes the generator produce a file
  // its own auditor condemns. On a fresh install every TELOS source is still a
  // template, which is precisely when these are empty. (public issue #1886,
  // PR #1887, @bnkath2o)
  if (missions.length > 0) {
    lines.push('', '## Missions', '', ...missions);
  }

  // Deferred/completed render as their own lines below, so the heading must survive
  // when active is empty but either of those has content — otherwise those lines
  // would appear under no heading at all.
  if (goals.active.length > 0 || goals.deferred.length > 0 || goals.completed.length > 0) {
    lines.push('', '## Active Goals (2026)', '', ...goals.active);
  }

  if (goals.deferred.length > 0) {
    // Compress deferred goals to a single inline line — they're not active and don't need full bullets
    const deferredIds = goals.deferred
      .map(line => line.match(/\*\*(\w+)\*\*/)?.[1])
      .filter(Boolean)
      .join(', ');
    lines.push('', `_Deferred (full text in TELOS/GOALS.md): ${deferredIds}_`);
  }

  if (goals.completed.length > 0) {
    const completedIds = goals.completed
      .map(line => line.match(/\*\*(\w+)\*\*/)?.[1])
      .filter(Boolean)
      .join(', ');
    lines.push('', `_Completed this year (full text in TELOS/GOALS.md): ${completedIds}_`);
  }

  if (problems.length > 0) {
    lines.push('', '## Problems Being Solved', '', ...problems);
  }

  if (strategies.length > 0) {
    lines.push('', '## Strategies', '', ...strategies);
  }

  // Conditional like Core Models: an unconditional empty section is the shape
  // ContextAudit's empty-section check exists to catch (public issue #1559).
  if (projects.length > 0) {
    lines.push('', '## Active Projects', '', ...projects);
  }

  // Secondary narratives are appended after this block, so the heading must
  // survive when primary is empty but secondary is not.
  if (narratives.primary.length > 0 || narratives.secondary.length > 0) {
    lines.push('', '## Active Narratives', '', ...narratives.primary);
  }

  if (narratives.secondary.length > 0) {
    lines.push(...narratives.secondary.map(n => `- ${n}`));
  }

  if (challenges.length > 0) {
    lines.push('', '## Personal Challenges', '', ...challenges);
  }

  // The `## Risks (RN)` register: one line per risk with its prevent/detect/respond
  // state, so steering sees what could take the principal off the path and how
  // ready the system is for each. Conditional like the others (public issue #1559).
  if (risks.length > 0) {
    lines.push('', '## Top Risks (full register in TELOS.md § Risks)', '', ...RISK_HEADER, ...risks);
  }

  // BLE 2026-08-23: Traumas/Wrong/Wisdom are context-flavor, not steering — the always-loaded
  // summary carries a count + pointer; the full text stays on demand in the TELOS source files.
  const depth: string[] = [];
  if (traumas.length > 0) depth.push(`- Formative experiences (traumas): ${traumas.length} entries — `+'`TELOS/TRAUMAS.md`');
  if (wrong.length > 0) depth.push(`- Things I've been wrong about: ${wrong.length} entries — `+'`TELOS/WRONG.md`');

  // Emit Core Models only when populated (public issue #1559, @tzioup): an
  // unconditional empty section is exactly the shape ContextAudit's empty-
  // section check exists to catch, and emitting it guaranteed a false-clean.
  if (models.length > 0) {
    lines.push('', '## Core Models', '', ...models);
  }

  if (wisdom.length > 0) depth.push(`- Wisdom: ${wisdom.length} entries — `+'`TELOS/WISDOM.md`');
  if (depth.length > 0) {
    lines.push('', '## Depth Files (on demand — read the source when steering needs them)', '', ...depth);
  }

  lines.push(
    '',
    '## Context Filter',
    '',
    // public PR #1808, @0bsolescence — the principal's own filter wins. The
    // fallback must stay generic: a fallback carrying any specific person's
    // filter injects someone else's priorities into every install without a
    // Context Filter section (public issue #1883, @catchingknives; same class
    // as #1671).
    readContextFilter() ||
      '_No Context Filter defined. Add a `## Context Filter` section to TELOS.md._',
  );

  return lines.join('\n') + '\n';
}

// Main — fail-loud guard: never blank a populated summary. Zero parsed items
// means the source format drifted beyond the parser; keep the existing file.
//
// Behind `import.meta.main` so the module can be IMPORTED for its exports.
// observability.ts imports hasRealContent from here (public issue #2117,
// @NAmorim); with the generator running at top level, that import regenerated
// and rewrote PRINCIPAL_TELOS.md — and could process.exit(1) out of Pulse —
// every time the module loaded.
if (import.meta.main) {
  const summary = generate();
  const countItems = (text: string) => text.split('\n').filter(l => l.startsWith('- ')).length;
  const itemLines = countItems(summary);
  if (itemLines === 0) {
    // A fresh install legitimately parses to zero: every entry in the tree is
    // still a shipped placeholder, and now that those are filtered out there is
    // nothing left to render. Same test the per-section guard uses — if the
    // sample-blind parse WOULD have produced items, no real content is being
    // dropped and an empty summary is the correct output.
    // public issue #1815, @tzioup (adjacent: sample text leaked through the
    // plain-bullet and wisdom paths)
    const realError = console.error;
    console.error = () => {};   // the re-parse would duplicate every warning
    let sampleBlind = 0;
    try {
      sampleBlind = countItems(withSamples(generate));
    } finally {
      console.error = realError;
    }
    if (sampleBlind === 0) {
      console.error('❌ TELOS parse produced zero items — refusing to overwrite PRINCIPAL_TELOS.md. Fix the parser or the source format.');
      process.exit(1);
    }
    console.error('ℹ️  TELOS sources are still shipped templates — writing an empty summary until they are filled in.');
  }
  writeFileSync(OUTPUT_PATH, summary);
  const lineCount = summary.split('\n').length;
  console.log(`✅ Generated PRINCIPAL_TELOS.md (${lineCount} lines) at ${OUTPUT_PATH}`);
  console.error(`📋 TELOS summary regenerated: ${lineCount} lines from source files`);
}
