#!/usr/bin/env bun
// release-allow: profanity (detector vocabulary: frustration and praise signals match these words on purpose)
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * @version 1.10.2
 * PromptProcessing.hook.ts - Tab Title + Session Naming
 *
 * PURPOSE:
 * Handles terminal tab title updates and session auto-naming via model
 * inference. One process, at most one inference call per prompt. The session
 * NAME rides the herdr workspace row, the status line and Pulse; the tab's
 * activity (the text after the label's pipe) is the CURRENT TASK (2026-10-10).
 *
 * TRIGGER: UserPromptSubmit
 *
 * NOTE: Modes/tiers and the per-prompt classifier were retired 2026-07-11 —
 * spend is discovered from the work, not predicted per prompt.
 * The leading tab token below is now a vestigial cosmetic ("N" on light turns);
 * with no classifier stamping it, stampWorkingTab just recovers whatever token
 * is already on the tab. Satisfaction/rating capture is handled by the dedicated
 * SatisfactionCapture.hook.ts. This hook does only: tab title + session naming.
 *
 * FLOW:
 * 1. Parse stdin
 * 2. Skip ratings, praise, system text, and very short FIRST prompts
 * 3. Deterministic tab title from the stored session name, set immediately as
 *    the placeholder
 * 4. First prompt: deterministic floor name, then inference → tab title +
 *    session name, then store the name, stamp the tab, voice announce
 * 5. Follow-up (any length, "y" and "c" included): exactly one low-cost model
 *    request, never voiced, whose reply always carries `current_task` — what
 *    the session is doing right now — which replaces the placeholder as the
 *    tab's activity. The same request also carries, at most one of:
 *    a. the first few follow-ups: whether the name carries a misheard term;
 *    b. after that, at most every RECALIBRATION_INTERVAL_MS (ten minutes):
 *       whether the session's overall subject moved, renaming it if so. Pinned
 *       names (a principal rename) and ISA-named sessions are never re-checked.
 *
 * PERFORMANCE:
 * - Deterministic path: <50ms (no inference)
 * - Inference path: one model call; on a follow-up it runs after the placeholder is stamped
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { inference } from '../LIFEOS/TOOLS/Inference';
import { invariant } from '../LIFEOS/TOOLS/Invariant';
import { hookCovers } from './lib/function-hooks';
import { readTranscriptTail } from './lib/transcript-tail';
import { getIdentity, getPrincipal } from './lib/identity';
import { isValidWorkingTitle, getWorkingFallback, trimToValidTitle, toGerund, gerundToPastTense } from './lib/output-validators';
import { readTabState, setAscentTab, isValidSessionLabel, resolveSessionRow } from './lib/tab-setter';
import { reportHerdrTurnStart } from './lib/herdr-tabs';
import { ASCENT_STATES, type AscentState } from '../LIFEOS/TOOLS/ascent';
import { lifeosPath, getClaudeDir, getLifeosDir } from './lib/paths'; // public issue #1974 @sabo961, PR #1918 @PigLardLord
import { upsertSession } from './lib/isa-utils';
// The ONE writer for a session's name + tab label (2026-09-11). Every store —
// session-names.json, session-labels.json, the work.json row, the harness
// JSONL custom-title — moves together, so the tab and the status line agree.
import { setSessionName, readSessionNames, recalibrationDue, markRecalibrated, readNameHistory, recordReplacedName, type SessionNames } from './lib/session-identity';
import { isDesktopChannel, logSkippedVoice, getNotificationChannel } from './lib/notification-channel';
import { PULSE_BASE } from '../LIFEOS/PULSE/endpoint';
import { detectExplicitCorrection, frustrationRead } from '../LIFEOS/ERRATA/Signals';
import { textRequest } from '../LIFEOS/TOOLS/DeliveredContext';
// Assay judgment layer (engine: Clef-omni), shadow only: the six prompt-signal judgments the `dispatch-advisor`
// caller already asked for are compared with the keyword tables below. The keyword tables decide.
// See LIFEOS/DOCUMENTATION/Assay/AssaySystem.md.
import { observeSignals, type SignalPaths, type SignalVerdicts } from './lib/glance-signals';

// Normalize env path vars that Claude Code injects without shell expansion (LifeOS#1404)
for (const k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const v = process.env[k];
  if (v && /^\$\{?HOME\}?(\/|$)/.test(v)) process.env[k] = v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}


// ── Types ──

interface HookInput {
  session_id: string;
  prompt?: string;
  user_prompt?: string;
  transcript_path: string;
  hook_event_name: string;
}

interface InferenceResult {
  tab_title: string | null;
  session_name: string | null;
  tab_label: string | null;
}

function appendPromptProcessingTelemetry(entry: Record<string, unknown>): void {
  try {
    const logPath = lifeosPath('MEMORY', 'OBSERVABILITY', 'prompt-processing.jsonl');
    const serialized = JSON.stringify(entry);
    if (serialized.includes('\n')) return;
    appendFileSync(logPath, `${serialized}\n`, 'utf-8');
  } catch {}
}

// ── Constants ──

const BASE_DIR = getLifeosDir();
const MIN_PROMPT_LENGTH = 3;

// ── Stdin Reader ──

async function readStdinWithTimeout(timeout: number = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeout);
    // 10MB cap — unbounded buffering risked multi-GB allocation on a fast stream (public issue #1533, @christauff)
    process.stdin.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 10_000_000) { clearTimeout(timer); try { process.stdin.pause(); } catch {} resolve(data); }
    });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ══════════════════════════════════════════════════
// FAST PATH DETECTION (for skip logic)
// ══════════════════════════════════════════════════

function isExplicitRating(prompt: string): boolean {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^(10|[1-9])(?:\s*[-:]\s*|\s+)?(.*)$/);
  if (!match) return false;
  const afterNumber = trimmed.slice(match[1].length);
  if (afterNumber.length > 0 && /^[/.\dA-Za-z]/.test(afterNumber)) return false;
  const rest = match[2]?.trim();
  if (rest) {
    const sentenceStarters = /^(items?|things?|steps?|files?|lines?|bugs?|issues?|errors?|times?|minutes?|hours?|days?|seconds?|percent|%|th\b|st\b|nd\b|rd\b|of\b|in\b|at\b|to\b|the\b|a\b|an\b)/i;
    if (sentenceStarters.test(rest)) return false;
  }
  return true;
}

const POSITIVE_PRAISE_WORDS = new Set([
  'excellent', 'amazing', 'brilliant', 'fantastic', 'wonderful', 'beautiful',
  'incredible', 'awesome', 'perfect', 'great', 'nice', 'superb', 'outstanding',
  'magnificent', 'stellar', 'phenomenal', 'remarkable', 'terrific', 'splendid',
  // Thanks is the same no-work signal: since every follow-up now asks the model
  // for the current task (2026-10-10), a bare thanks must not spend a call.
  'thanks', 'thx',
]);
const POSITIVE_PHRASES = new Set([
  'great job', 'good job', 'nice work', 'well done', 'nice job', 'good work',
  'love it', 'nailed it', 'looks great', 'looks good', 'thats great', 'that works',
  'thank you',
]);

const SYSTEM_TEXT_PATTERNS = [
  /^<task-notification>/i,
  /^<system-reminder>/i,
  /^This session is being continued from a previous conversation/i,
  /^Please continue the conversation/i,
  /^Note:.*was read before/i,
];

// ══════════════════════════════════════════════════
// TAB TITLE — Deterministic Extraction
// ══════════════════════════════════════════════════

/**
 * Derive a gerund tab title from a session name.
 * "Fix Session Naming Logic" → "Fixing session naming."
 * "Build LifeOS TUI Dataviz" → "Building LifeOS TUI."
 * Returns null if the session name doesn't start with a convertible verb.
 */
function sessionNameToTabTitle(name: string): string | null {
  const words = name.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) return null;

  const first = words[0].toLowerCase();
  if (!ACTION_VERBS.has(first) && !META_VERBS.has(first)) return null;

  const gerund = toGerund(first);
  const cap = gerund.charAt(0).toUpperCase() + gerund.slice(1);
  const titleWords = [cap, ...words.slice(1, 4)];
  return trimToValidTitle(titleWords, isValidWorkingTitle);
}

/**
 * Title for a follow-up prompt: the SESSION's identity, never the raw prompt.
 * Mangling each follow-up into a fake gerund ("Researching tab title accurate.")
 * replaced the session name with prompt debris on every turn after the first
 * (found live 2026-08-12). Prefers the gerund derivation; falls back to the
 * first four words of the stored session name verbatim.
 */
function followupTitleFromSessionName(sessionId: string): string | null {
  try {
    const name = readSessionNames()[sessionId];
    if (typeof name !== 'string' || !name.trim()) return null;
    return sessionNameToTabTitle(name) || name.trim().split(/\s+/).slice(0, 4).join(' ');
  } catch { return null; }
}

/**
 * Deterministic tab title extraction — unified with session naming.
 * First tries to derive from session name understanding (same subject-first
 * extraction), then falls back to direct gerund extraction from prompt.
 */
function quickTitle(prompt: string): string | null {
  // Strategy 0: Question detection — "Where are pet stores?" → "Researching pet stores."
  const sanitized = sanitizePromptForNaming(prompt);
  const questionSubject = extractQuestionSubject(sanitized);
  if (questionSubject) {
    const subjectText = questionSubject.slice(0, 3).join(' ').toLowerCase();
    const candidate = `Researching ${subjectText}.`;
    if (isValidWorkingTitle(candidate)) return candidate;
  }

  // Strategy 1: Derive from session name understanding (unified with naming system)
  const sessionName = extractFallbackName(sanitized);
  if (sessionName) {
    const derived = sessionNameToTabTitle(sessionName);
    if (derived) return derived;
  }

  // Strategy 2: Direct gerund extraction from prompt
  const text = prompt.trim().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 200);
  const words = text.split(' ').filter(w => w.length > 1);
  if (words.length === 0) return null;

  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  if (!first) return null;

  // Already a gerund — use directly
  if (first.endsWith('ing') && first.length > 4
      && !first.endsWith('thing') && !first.endsWith('ring') && !first.endsWith('king')) {
    return trimToValidTitle(words, isValidWorkingTitle);
  }

  // ONLY gerundify known action verbs — never arbitrary words like "where", "information"
  if (ACTION_VERBS.has(first) || META_VERBS.has(first)) {
    const gerund = toGerund(first);
    const capitalized = gerund.charAt(0).toUpperCase() + gerund.slice(1);
    const titleWords = [capitalized, ...words.slice(1, 4)];
    return trimToValidTitle(titleWords, isValidWorkingTitle);
  }

  return null;
}

// ══════════════════════════════════════════════════
// SESSION NAMING — Deterministic + Lock
// ══════════════════════════════════════════════════


const NOISE_WORDS = new Set([
  // articles, pronouns, prepositions
  'the', 'a', 'an', 'i', 'my', 'me', 'we', 'you', 'your', 'it', 'its',
  'this', 'that', 'these', 'those', 'he', 'she', 'they', 'them', 'our',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'about',
  // auxiliaries & fillers
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might',
  'have', 'has', 'had', 'just', 'please', 'okay', 'hey', 'hello', 'hi',
  'now', 'also', 'very', 'really', 'actually', 'basically', 'literally',
  'some', 'any', 'all', 'every', 'each', 'not', 'but', 'and', 'or',
  'so', 'if', 'then', 'than', 'like', 'well', 'yeah', 'yes', 'no',
  'here', 'there', 'where', 'when', 'how', 'what', 'which', 'who', 'why',
  'need', 'want', 'going', 'got', 'get', 'getting', 'thing', 'things',
  'stuff', 'way', 'lot', 'bit', 'kind', 'sort', 'feel', 'think', 'know',
  'say', 'said', 'tell', 'told', 'look', 'looking', 'keep', 'keeps',
  'let', 'lets', 'put', 'take', 'took', 'try', 'tried', 'trying',
  // generic verb forms with no naming specificity
  'happened', 'happening', 'doing', 'done', 'went', 'gone', 'came',
  'coming', 'made', 'making', 'seems', 'seem', 'seemed', 'works',
  'worked', 'working', 'else', 'still', 'already', 'again', 'back',
  'same', 'different', 'other', 'another', 'much', 'many', 'more',
  'most', 'less', 'last', 'first', 'next', 'new', 'old', 'only',
  'even', 'around', 'before', 'after', 'between', 'through', 'into',
  // contraction remnants (after apostrophe stripping)
  'don', 'doesn', 'didn', 'won', 'wouldn', 'couldn', 'shouldn',
  'isn', 'aren', 'wasn', 'weren', 'hasn', 'haven', 'hadn', 've', 'll', 're',
  // profanity — also in PROFANITY_WORDS below
  'fuck', 'fucking', 'fucked', 'fucker', 'shit', 'shitty', 'damn', 'damned',
  'ass', 'bitch', 'crap', 'wtf', 'cunt', 'dumb', 'stupid', 'goddamn',
  'hell', 'bastard', 'bullshit',
  // conjunctions and subordinators
  'though', 'although', 'however', 'therefore', 'moreover', 'furthermore',
  'unless', 'despite', 'whereas', 'whether', 'nevertheless', 'hence',
  // prepositions not in original set
  'under', 'over', 'above', 'below', 'within', 'without', 'during',
  'against', 'upon', 'toward', 'towards', 'along', 'across', 'behind',
  'beside', 'beneath', 'among', 'throughout', 'beyond', 'except',
]);

const PROFANITY_WORDS = new Set([
  'fuck', 'fucking', 'fucked', 'fucker', 'shit', 'shitty', 'damn', 'damned',
  'ass', 'bitch', 'crap', 'wtf', 'cunt', 'dumb', 'stupid', 'goddamn',
  'hell', 'bastard', 'bullshit',
]);


/**
 * If the prompt opens with a pasted email/letter (greeting line followed by a
 * recognizable closing word), strip the letter and return only the user's own
 * wrap-around instruction — which is what they actually want a session named for.
 *
 * Pattern: greeting at start ("Hey/Hi/Hello/Dear/Greetings ...,\n") AND a closing
 * word later in the body ("Thanks/Best/Cheers/Regards/Sincerely/Yours/Cordially").
 *
 * Conservative: only fires when BOTH the greeting AND the closing are present
 * AND the post-closing remainder is ≥30 chars (otherwise the "letter" probably IS
 * the user's whole prompt). This stops session names like "Add Agenda Thanks Accurate Guys"
 * — words pulled from a pasted email — and instead names the session from the user's
 * actual instruction that follows.
 */
function stripPastedLetter(prompt: string): string {
  const openingPattern = /^\s*(Hey|Hi|Hello|Dear|Greetings)\b[^\n]{0,80}\n/i;
  if (!openingPattern.test(prompt)) return prompt;

  const closingPattern = /\b(Thanks|Best|Cheers|Regards|Sincerely|Yours|Cordially|Respectfully)\b[,.]?/i;
  const match = prompt.match(closingPattern);
  if (!match || match.index === undefined) return prompt;

  const afterClosing = prompt.slice(match.index + match[0].length).trim();
  return afterClosing.length >= 30 ? afterClosing : prompt;
}

/**
 * Strip harness-authored markup so only user-typed words remain. Claude Code
 * writes a local slash command into the transcript as synthetic `type:"user"`
 * records (`<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`),
 * and hands the hook "[Image #1]" for an attachment with no typed text. Neither
 * is a user word; a session was named "Set Fable Five Default Model" after a
 * `/model` command's own stdout. public issue #2033, @xmasyx
 */
export function stripHarnessMarkup(text: string): string {
  return text
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/\[(?:image|screenshot|pasted)[^\]]*\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if, harness markup removed, the prompt still carries a user word (any script). */
export function hasUserWords(prompt: string): boolean {
  return /\p{L}{2,}/u.test(stripHarnessMarkup(prompt));
}

/** Pasted blocks the harness wraps in `<pasted_content>` (the closing tag may carry the id too). */
const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/gi;

/**
 * The words a session is named from: what the principal typed. A pasted block is material he handed over, so it
 * names nothing while typed words sit beside it (2026-10-25: "ok let's do a blog post on this" plus a pasted
 * essay was named "Move Exactly Jupiter Sky Arbitrary" from words in the essay). A prompt that is only a paste
 * (dictation arrives that way) keeps the pasted words, since they are his.
 */
export function typedForNaming(prompt: string): string {
  const typed = prompt.replace(PASTED_BLOCK, " ");
  return typed !== prompt && hasUserWords(typed) ? typed : prompt;
}

/** The prompt for the naming model. When typed words sit beside a paste, each pasted block is marked so its words are
 *  never read as the ask; a paste-only prompt (dictation) is left as his own words. */
export function markPastedForModel(prompt: string): string {
  if (typedForNaming(prompt) === prompt) return prompt;
  return prompt.replace(PASTED_BLOCK, (block) => ` [PASTED TEXT, not the principal's words: ${block.replace(/<\/?pasted_content[^>]*>/gi, " ").trim()}] `);
}

export function sanitizePromptForNaming(prompt: string): string {
  return stripPastedLetter(typedForNaming(prompt))
    // Harness-inserted attachment markers are not user-typed words — strip
    // before naming so "Image" never lands in a session name. (issue #1845)
    .replace(/\[(?:image|screenshot|pasted)[^\]]*\]/gi, ' ')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // URL → content-token extraction (BEFORE path-stripping mangles them).
    // GitHub: keep the repo name. Generic URL: keep the host (sans TLD).
    .replace(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/([\w.-]+?)(?=[/?#.]|$)/gi,
      (_, repo) => ' ' + titleCase(String(repo).replace(/[._-]+/g, '')) + ' ')
    .replace(/https?:\/\/(?:www\.)?([\w-]+)\.[\w.-]+(?:\/\S*)?/gi,
      (_, host) => ' ' + titleCase(String(host).replace(/[._-]+/g, '')) + ' ')
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')  // strip markdown bold/italic
    .replace(/`[^`]+`/g, ' ')                   // strip inline code
    .replace(/(?:called|result of calling)\s+the\s+\w+\s+tool[^.]*\./gi, ' ')
    .replace(/\bread\s+(?:the\s+)?output\s+file\b/gi, ' ')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' ')
    .replace(/\b[0-9a-f]{7,}\b/gi, ' ')
    .replace(/(?:\/[\w.-]+){2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Common action verbs that make good title anchors
export const ACTION_VERBS = new Set([
  'fix', 'build', 'create', 'deploy', 'debug', 'add', 'remove', 'update',
  'delete', 'refactor', 'migrate', 'implement', 'design', 'test', 'check',
  'review', 'analyze', 'research', 'investigate', 'configure', 'setup',
  'install', 'uninstall', 'restore', 'optimize', 'improve', 'clean',
  'sync', 'push', 'pull', 'merge', 'revert', 'launch', 'stop', 'start',
  'restart', 'monitor', 'diagnose', 'trace', 'profile', 'audit', 'scan',
  'export', 'import', 'generate', 'write', 'read', 'send', 'fetch',
  'search', 'find', 'replace', 'rename', 'move', 'copy', 'list',
  'show', 'hide', 'enable', 'disable', 'upgrade', 'downgrade', 'publish',
  'draft', 'edit', 'rewrite', 'shrink', 'expand', 'reduce', 'bump',
  'extract', 'compile', 'run', 'execute', 'schedule', 'automate',
  'connect', 'disconnect', 'authenticate', 'authorize', 'validate',
  'open', 'close', 'compare', 'evaluate', 'assess', 'explore', 'discover', 'resolve',
  'redesign', 'rebuild', 'rethink', 'modernize', 'simplify', 'consolidate',
]);

// Question words — signal a question prompt, not a task command
const QUESTION_WORDS = new Set([
  'where', 'what', 'how', 'when', 'why', 'who', 'which',
  'can', 'could', 'does', 'do', 'is', 'are', 'was', 'were',
  'will', 'would', 'should', 'has', 'have', 'had',
]);

/**
 * Check if a prompt starts with a question and has no task verb following.
 * "Where are pet stores?" → true (question, no task verb)
 * "Can you fix the auth bug?" → false (question word + task verb "fix")
 * "What the fuck is this tab title?" → false (profanity + "fix" likely follows)
 * Returns the extracted subject words if it IS a question, null otherwise.
 */
function extractQuestionSubject(prompt: string): string[] | null {
  const words = prompt
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2);

  if (words.length < 2) return null;

  const first = words[0].toLowerCase();
  if (!QUESTION_WORDS.has(first)) return null;

  // Scan for a task verb — if found, this is a task command not a question
  for (let i = 1; i < Math.min(words.length, 12); i++) {
    const w = words[i].toLowerCase();
    if (ACTION_VERBS.has(w) && !META_VERBS.has(w)) return null;
  }

  // It's a genuine question — extract subject (non-noise content words)
  const subjects: string[] = [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (NOISE_WORDS.has(lower)) continue; // QUESTION_WORDS is a subset of NOISE_WORDS
    if (w.length >= 3) subjects.push(w);
    if (subjects.length >= 3) break;
  }

  return subjects.length >= 1 ? subjects : null;
}

// Meta-instruction verbs — describe user→AI interaction, not the task itself
// These should not anchor session names (Strategy 1) but aren't filtered from all output
export const META_VERBS = new Set([
  'pull', 'show', 'see', 'find', 'look', 'list', 'read', 'open',
  'check', 'view', 'display', 'bring', 'give', 'tell', 'help',
  'continue', 'resume', 'recall', 'remember', 'repeat', 'finish',
  'complete', 'redo', 'grab', 'load', 'fetch', 'retrieve', 'access',
]);

// Punctuation/symbol stripper that keeps letters from every script and digits.
// An `[^a-zA-Z0-9\s]` class deletes accented letters along with the punctuation,
// so a word ending in an accent loses it and a non-Latin prompt reduces to
// nothing. `\p{L}` covers scripts nobody has thought to enumerate.
// public issue #1774, @xmasyx
const NON_WORD_CHARS = /[^\p{L}\p{N}\s]/gu;

export function titleCase(w: string): string {
  // Preserve acronyms (all uppercase, 2-8 chars, letters only)
  if (w.length >= 2 && w.length <= 8 && /^[A-Z]+$/.test(w)) return w;
  // A capital after a lowercase letter is a name the model spelled on purpose:
  // LifeOS, GitHub, iPhone (2026-10-09: "LifeOS" reached the tab as "Lifeos").
  if (/[a-z][A-Z]/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

export function extractFallbackName(prompt: string): string | null {
  // One ALLCAPS anchor at most: the first acronym stays, every later ALLCAPS
  // token is sentence-cased so "launch the ISA for the CONTROL LEDGER goal"
  // yields "Launch ISA Control Ledger Goal", not ALLCAPS salad — and passes the
  // validator's ≥2-ALLCAPS rejection below. public issue #2051 (a), @lgertel
  let anchorSeen = false;
  const allWords = prompt
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .map(w => {
      if (!/^[A-Z]{2,8}$/.test(w)) return w;
      if (anchorSeen) return w.toLowerCase();
      anchorSeen = true;
      return w;
    });

  if (allWords.length === 0) return null;

  const contentWords: { word: string; idx: number }[] = [];
  for (let i = 0; i < allWords.length; i++) {
    if (!NOISE_WORDS.has(allWords[i].toLowerCase()) && allWords[i].length >= 3) {
      contentWords.push({ word: allWords[i], idx: i });
    }
  }

  if (contentWords.length === 0) return null;

  // Strategy -1: Question detection — "Where are pet stores in South Bay?" → "Research South Bay Pet Stores"
  const questionSubject = extractQuestionSubject(prompt);
  if (questionSubject) {
    const parts = ['Research', ...questionSubject.slice(0, 4).map(w => titleCase(w))];
    // Pad with more content words to reach exactly 5 words
    for (const cw of contentWords) {
      if (parts.length >= 5) break;
      const tc = titleCase(cw.word);
      if (!parts.includes(tc)) parts.push(tc);
    }
    if (parts.length >= 5) return parts.slice(0, 5).join(' ');
  }

  // Strategy 0: Anchor on acronyms/proper nouns (project & tech names like LifeOS, TUI, API)
  const acronyms = contentWords.filter(cw => /^[A-Z]{2,8}$/.test(cw.word));
  if (acronyms.length >= 1) {
    const taskVerb = contentWords.find(cw =>
      ACTION_VERBS.has(cw.word.toLowerCase()) && !META_VERBS.has(cw.word.toLowerCase())
    );
    const parts: string[] = [];
    if (taskVerb) parts.push(taskVerb.word);
    const used = new Set(parts.map(w => w.toLowerCase()));
    for (const a of acronyms) {
      if (parts.length >= 5) break;
      if (!used.has(a.word.toLowerCase())) { parts.push(a.word); used.add(a.word.toLowerCase()); }
    }
    for (const cw of contentWords) {
      if (parts.length >= 5) break;
      if (!used.has(cw.word.toLowerCase()) && !META_VERBS.has(cw.word.toLowerCase())) {
        parts.push(cw.word); used.add(cw.word.toLowerCase());
      }
    }
    if (parts.length >= 5) {
      return parts.slice(0, 5).map(w => titleCase(w)).join(' ');
    }
  }

  // Strategy 1: Find a TASK action verb and take it + next 4 content words.
  // Validate before returning — fall through if S1's lead doesn't pass.
  for (let i = 0; i < contentWords.length; i++) {
    const lower = contentWords[i].word.toLowerCase();
    if (ACTION_VERBS.has(lower) && !META_VERBS.has(lower)) {
      const phrase = contentWords.slice(i, i + 5);
      if (phrase.length >= 5) {
        const candidate = phrase.slice(0, 5).map(p => titleCase(p.word)).join(' ');
        if (isValidSessionName(candidate)) return candidate;
      }
    }
  }

  // Strategy 2: First non-meta content words (require 5). Validate before returning.
  const nonMeta = contentWords.filter(cw => !META_VERBS.has(cw.word.toLowerCase()));
  if (nonMeta.length >= 5) {
    const candidate = nonMeta.slice(0, 5).map(p => titleCase(p.word)).join(' ');
    if (isValidSessionName(candidate)) return candidate;
  }

  // Strategy 3: Original fallback — first content words (require 5). Validate before returning.
  if (contentWords.length >= 5) {
    const candidate = contentWords.slice(0, 5).map(p => titleCase(p.word)).join(' ');
    if (isValidSessionName(candidate)) return candidate;
  }

  // Former Strategy 4 (prepend "Review" + any 4 content words) DELETED
  // (public issue #1845, @xmasyx): planting an ACTION_VERB lead let word-salad
  // self-certify through isValidSessionName — non-English prompts became
  // "Review Questa Sezione Vorrei Mettere". An unnamed session just retries
  // naming on the next prompt; that beats a confident wrong name.

  // Truly nothing usable — let inference handle it (or accept the unnamed session).
  return null;
}

// Lead verbs banned from session names. Ban criterion (public issue #1845,
// @xmasyx): banned verbs take the ASSISTANT as their object ("show me",
// "continue where we left off") — meta-instructions about the conversation.
// Verbs whose object is THE WORK ("Complete Api Migration", "Finish Payment
// Retry Logic") are legitimate task descriptions and stay allowed.
const BANNED_SESSION_LEAD = new Set([
  'pull', 'show', 'see', 'look', 'view', 'display', 'bring', 'give', 'tell', 'help',
  'continue', 'resume', 'recall', 'remember', 'repeat',
  'grab', 'load', 'retrieve', 'access', 'list',
]);

/**
 * Validate that a session name is grammatically correct.
 * Pattern: [Base-form Action Verb] [Content Word] [Content Word] [Content Word] [Content Word]
 * Rejects names that read as word salad, start with non-verb words, or fall short of 5 words.
 */
export function isValidSessionName(name: string): boolean {
  const words = name.split(/\s+/).filter(w => w.length > 0);
  if (words.length !== 5) return false;

  // Reject embedded punctuation that signals fragment-with-commas patterns
  if (/[,;:/\\]/.test(name)) return false;

  const first = words[0].toLowerCase();

  // First word must be a recognized base-form action verb, not a meta-instruction
  if (!ACTION_VERBS.has(first) || BANNED_SESSION_LEAD.has(first)) return false;

  // Two or more ALLCAPS tokens is word salad ("Launch ISA CONTROL LEDGER GOAL"),
  // not a name — one acronym anchor is the ceiling. Applies to the scraping
  // fallback only; the shape-only inference validator keeps real multi-acronym
  // names. public issue #2051 (a), @lgertel
  if (words.filter(w => /^[A-Z]{2,8}$/.test(w)).length >= 2) return false;

  // Middle words must not be noise/function words (acronyms exempt)
  for (let i = 1; i < words.length; i++) {
    if (/^[A-Z]{2,8}$/.test(words[i])) continue;
    if (NOISE_WORDS.has(words[i].toLowerCase())) return false;
  }

  return true;
}

/**
 * Validate an INFERENCE-produced name for SHAPE, not vocabulary.
 * `isValidSessionName` exists to discipline `extractFallbackName`, which scrapes
 * words out of the prompt and needs a lexical whitelist to avoid word salad.
 * Applied to the model it inverted its purpose: it rejected good names ("Decide
 * Icon Placement In Statusline", "Refine Dashboard Layout Spacing") because the
 * lead verb is absent from the hand-maintained ACTION_VERBS set, while Strategy
 * 4 of the fallback passes by construction — it prepends the literal 'Review'.
 * So: keep the guards that carry information (length, fragment punctuation,
 * meta-instruction lead, substance) and drop the whitelist.
 * public issue #1718, @xmasyx
 *
 * Deviation from the reported fix: no per-word `length >= 2` floor. This file
 * deliberately dropped that floor because single-char words are legitimate in
 * real names ("Command K Palette", "Add A Record"). Short words instead just
 * fail to count toward the meaningful-word requirement below.
 */
function isValidInferredSessionName(name: string): boolean {
  const words = name.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2 || words.length > 5) return false;

  // Same fragment-punctuation guard as the strict validator
  if (/[,;:/\\]/.test(name)) return false;

  if (BANNED_SESSION_LEAD.has(words[0].toLowerCase())) return false;

  // At least two words that actually say something (acronyms always count)
  const meaningful = words.filter(w =>
    /^[A-Z]{2,8}$/.test(w) || (w.length >= 2 && !NOISE_WORDS.has(w.toLowerCase())));
  return meaningful.length >= 2;
}

/** Name the session everywhere it lives, in one motion (session-identity.ts).
 *  No repaint here: every caller stamps the tab itself right after, with the
 *  label that this call just stored. */
function storeName(sessionId: string, name: string, source: string, label?: string | null): void {
  setSessionName(sessionId, name, { source: `PromptProcessing:${source}`, label, repaint: false });
}

/**
 * The deterministic name a session gets without a model: the validated
 * fallback (action-verb phrase) when there is one, else the last-resort
 * content-word scrape, else nothing. Same validators every stored name clears
 * (public issue #1774: a name we can't vouch for is worse than none). Returns
 * the stored name, or null when the session stays unnamed.
 */
export function floorName(pendingFallbackName: string | null, sanitizedPrompt: string): { name: string; source: string } | null {
  if (pendingFallbackName && isValidSessionName(pendingFallbackName)) {
    return { name: pendingFallbackName, source: 'deterministic-fallback' };
  }
  const contentWords = sanitizedPrompt
    .replace(NON_WORD_CHARS, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !NOISE_WORDS.has(w.toLowerCase()))
    .slice(0, 5);
  const lastResort = contentWords.length >= 2
    ? contentWords.map(w => titleCase(w)).join(' ')
    : `Session ${new Date().toISOString().slice(0, 10)}`;
  if (isValidSessionName(lastResort)) return { name: lastResort, source: 'last-resort' };
  console.error(`[PromptProcessing] Rejected last-resort name: "${lastResort}"`);
  return null;
}

/** Store the floor name unless the session already has one. Returns what was stored. */
function storeFloorName(sessionId: string, pendingFallbackName: string | null, sanitizedPrompt: string): string | null {
  if (readSessionNames()[sessionId]) return null;
  const floor = floorName(pendingFallbackName, sanitizedPrompt);
  if (!floor) return null;
  storeName(sessionId, floor.name, `floor:${floor.source}`);
  return floor.name;
}


// Narrow algorithm-verb detector: these 8 verbs signal explicit multi-phase
// (ISC-gated) algorithm work. Everything else that passes the trivia gates
// upstream (length, praise, system-text) is treated as native mode.

// ══════════════════════════════════════════════════
// COMBINED INFERENCE
// ══════════════════════════════════════════════════

const PRINCIPAL_NAME = getPrincipal().name;
const ASSISTANT_NAME = getIdentity().name;

/** The output-language rule every namer shares (first-prompt namer and recalibration). */
function namingLanguageRule(): string {
  return `## LANGUAGE — read this before every task
Every output below is written in the LANGUAGE OF THE USER'S MESSAGE. A message in Italian, Spanish, French, German, Japanese, or any other language gets its tab title, session name, and tab label in THAT language. NEVER translate into English. An English message gets English outputs. Mixed or ambiguous, use the language the user actually wrote in.
Verb forms adapt per language: use that language's progressive/gerund form where a gerund is asked for and its imperative/base form where a base-form verb is asked for (English "Fixing…" / "Fix …"; Italian "Riparando…" / "Ripara …"). Every other rule — word counts, Title Case, no articles, no punctuation — applies unchanged in every language.`;
}

/** What a good session name is: the rules every namer that writes a name follows. */
function sessionNameRules(): string {
  return `The session name is a HANDLE. ${PRINCIPAL_NAME} should be able to scan it in a task list weeks from now and instantly recognize: "this is the session where I {goal}." It must answer three nested questions in one 5-word phrase:
  (1) What is the prompt about? (the topic surface)
  (2) What is the session for? (the work being done)
  (3) What is the goal? (the outcome ${PRINCIPAL_NAME} wants)

If the name doesn't answer all three, it's a keyword label and it's wrong. Re-read the prompt and find the goal.

THINK FIRST: What is ${PRINCIPAL_NAME} actually trying to ACCOMPLISH? Not what words appear, not how they asked, not what surface tokens are present — what is the GOAL?
- Words appearing in the prompt are EVIDENCE, not the answer. The goal lives in ${PRINCIPAL_NAME}'s actual question or instruction.
- Ignore HOW they asked (pull up, show me, continue with, look at, hey, thanks) — those are interaction tokens, not work.
- Focus on the GOAL (what outcome is being pursued: a decision, a fix, a build, a piece of research, an evaluation).
- The name should be a complete imperative phrase. Read it aloud — it should sound like "${PRINCIPAL_NAME} needs to ___" filled in coherently.
- **Pasted content rule:** If the user pastes an email, letter, message, quote, document, or any block of text that someone ELSE wrote (signs like "Hey [Name],", a closing like "Thanks,/Best,/Cheers,/Regards,", quoted reviews, copied tweets, forwarded messages), the GOAL is ${PRINCIPAL_NAME}'s question or instruction WRAPPED AROUND that content — NOT words from the pasted content itself. Words like "Thanks", "Hey", "Dear", "Regards", "Agenda", "Accurate", recipient names, sender names, subject lines, and other email/letter tokens are NEVER subjects of work. Find ${PRINCIPAL_NAME}'s actual question ("research...", "is X fair?", "what should I do about...", "help me decide...", "evaluate...") and name the session from THAT.
- **Decision rule:** If the prompt is "Should I X or Y?" or "Is the annual plan worth it?" the goal is a DECISION. Name it: "Decide [Subject] [Aspect]" or "Evaluate [Subject] [Aspect]".
- **Question rule:** If the prompt is "What is X?" / "How does X work?" the goal is RESEARCH. Name it: "Research [Subject] [Aspect]".
- **Build rule:** If the prompt is "Build/Fix/Refactor X" the goal is BUILD. Name it: "[Verb] [Subject] [Aspect]".

Structure: [Base-form Verb] [Modifier or Project] [Subject] [Modifier] [Object/Aspect]
Rules:
- Exactly 5 words. Not 4, not 6. Five.
- Title Case. No articles (a/an/the). No commas, hyphens, slashes, or other punctuation inside the name.
- Start with a base-form action verb (Fix, Build, Debug, Refactor, Migrate, Research, Analyze — NOT Fixing, Building).
- Preserve acronyms in ALL CAPS (LifeOS, TUI, API, CLI, ISC, ISA, BLE).
- Every word must carry meaning. No filler adverbs (seriously, really, properly), no lone conjunctions, no fragment scraps.
- Reads as a grammatical phrase: imagine "${PRINCIPAL_NAME} needs to ___" — the name fills the blank as a coherent action.

Examples of separating instruction from subject:
- "Pull up the LifeOS TUI work and continue" → subject is LifeOS TUI → "Build LifeOS TUI Dashboard Interface"
- "Show me what's wrong with the feed system" → subject is feed system → "Debug Feed System Latency Issue"
- "Hey check on the session naming, it's broken again" → subject is session naming → "Fix Session Naming Hook Logic"
- "I want to see the admin dashboard purchases" → subject is admin purchases → "Fix Admin Dashboard Purchase Display"
- "Where are pet stores in South Bay?" → question about pet stores → "Research South Bay Pet Stores"
- "What's the best drum pedal for metal?" → question about drum pedals → "Research Best Metal Drum Pedals"
- "How does the auth flow work?" → question about auth → "Analyze Auth Flow Design Pattern"
- "Analyze ISD, ISC, BLE differences" → subject is the three concepts → "Analyze ISD ISC BLE Differences"
- "Create the LifeOS TELOS framework" → subject is the TELOS framework → "Create LifeOS TELOS Framework System"
- "[pasted email from a vendor announcing a license price increase]... I want you to research what a fair price is for a tool like this" → goal is research on license pricing → "Research Software License Pricing Benchmarks" (NOT "Add Agenda Thanks Accurate Guys" — those are tokens from the pasted email, ignore them entirely)
- "[pasted Slack message about a deploy failure] What do I do?" → goal is fixing the deploy → "Fix Deploy Failure From Slack" (subject is the deploy problem, not Slack words)
- "Should we take the monthly, annual, or three-year plan?" → goal is a plan decision → "Decide Software License Plan Term"
- "Is the annual plan worth it?" → goal is value evaluation → "Evaluate Annual License Plan Value"
- "guarda che la chat figlia non ha consegnato il referto, va aggiustato" (Italian) → "Ripara Consegna Referto Chat Figlie" — the name is Italian because the message is Italian. NOT "Fix Child Chat Delivery Bug": never translate.

QUESTIONS: If the message is a question (not a task command), use "Research [4 noun-phrase words]" or "Analyze [4 noun-phrase words]".
GOOD: "Fix Session Naming Word Count", "Build LifeOS TUI Dataviz Module", "Deploy Voice Server Update Hook", "Research South Bay Pet Stores", "Refactor Algorithm Phase Transition Logic"
BAD: "Fix" (one word), "Make Sure" (two words, not a task), "Analyze ISD ISC BLE" (four words, missing subject completion), "Create LifeOS TELOS Seriously Soon" (filler adverbs), "Pull Work See Continue Now" (instruction words), "Show Latest Build Status Page" (meta-instruction), "Pet Stores South Bay Area" (no verb), "Okay Recently Unified Session Name" (random fragments)`;
}

/**
 * The LANGUAGE block below is load-bearing. Every example in this prompt is in
 * English, and a model reads twenty English examples as an output-language
 * contract no matter what the user wrote — so an Italian conversation came back
 * named "Fix Child Chat Delivery Bug" and its owner could not find their own
 * session in a list. #1774 fixed accent-stripping and #1718 made the validator
 * shape-only, so the pipeline already ACCEPTS non-English names; nothing was
 * producing them. (public issue #1906, @xmasyx)
 */
/** What a good working title is: the tab-title rules the first-prompt namer and the current-task request share. */
function workingTitleRules(): string {
  return `Create a 2-4 word gerund phrase describing what WORK is being done — the project/feature/system being worked on, NOT how the user asked.
Rules: Start with gerund (-ing verb), include the specific subject/project, end with period, max 4 words.
CRITICAL: Extract the SUBJECT of the work, not the user's instruction. "Pull up the LifeOS TUI" → "Building LifeOS TUI." (the work), NOT "Pulling up work." (the instruction).
GOOD: "Fixing auth bug.", "Building LifeOS dashboard.", "Debugging feed system.", "Researching pet stores."
BAD: "Pulling up work.", "Completing the task.", "Showing session data.", "Working on it.", "Whering are pet."
QUESTIONS: If the message is a question (Where/What/How/Why/When), use "Researching [subject]." — e.g., "Where are pet stores?" → "Researching pet stores."`;
}

// ── The current task on follow-ups (2026-10-10, ISA F8) ───────────────────────
// The session name rides the herdr workspace row, the status line and Pulse.
// The tab showed the same name, so nothing said what the session was doing
// right now, so the tab shows the immediate task while the herdr title and the
// status line keep the real session name (2026-10-10). Every follow-up but a rating, praise or system text makes ONE
// model request, and that request always returns `current_task`; the name
// correction and the recalibration fold into it, so no prompt makes two.

/** The section every follow-up request carries, whatever else it asks. */
function currentTaskRules(): string {
  return `## CURRENT TASK
Say what the session is doing RIGHT NOW in response to the CURRENT MESSAGE, read together with the recent conversation (both ${PRINCIPAL_NAME}'s messages and ${ASSISTANT_NAME}'s replies). This is the immediate task, which is narrower than the session as a whole; it becomes the terminal tab's title.
${workingTitleRules()}
SHORT REPLIES: "y", "yes", "do it", "go", "c", "continue" mean: carry out what ${ASSISTANT_NAME} last proposed, or continue the work in flight. The task is THAT action, named by its subject — e.g. after "I'd push the release candidate next" → "Pushing release candidate.".
Write it in the language ${PRINCIPAL_NAME} writes in.`;
}

/** The JSON field every follow-up reply carries. */
const CURRENT_TASK_FIELD = `"current_task": "<2-4 word gerund phrase ending with period>"`;

/** The system prompt for a follow-up that asks only for the current task. */
export function buildCurrentTaskPrompt(): string {
  return `You read a working session between ${PRINCIPAL_NAME} and the AI assistant ${ASSISTANT_NAME}, and name the task being done right now. ${PRINCIPAL_NAME} is the only user.

${currentTaskRules()}

OUTPUT FORMAT (JSON only, single object on one line, no prose, no markdown):
{${CURRENT_TASK_FIELD}}`;
}

/**
 * Validate the model's current task. Returns a gerund-led working title of 2 to
 * 4 words that isValidWorkingTitle accepts (a longer reply is capped at five
 * words, then cut to the longest prefix the validator takes, which allows four),
 * or null for an empty, markup-bearing, profane or non-gerund task. Pure.
 */
export function acceptCurrentTask(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // One sentence only: a reply that runs on would otherwise splice its second sentence into the title.
  const text = raw.trim().split(/[.!?;](?:\s|$)/)[0].trim();
  if (!text) return null;
  // `|` is the tab title's own label separator, so it counts as markup here.
  if (/[*`<>{}[\]|]/.test(text)) return null;
  const words = text.split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.some(w => PROFANITY_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))) return null;
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return trimToValidTitle(words, isValidWorkingTitle, 5);
}

export function buildContextPrompt(includeSessionName: boolean): string {
  return `You analyze user messages to extract what WORK is being done. ${PRINCIPAL_NAME} is the only user. The AI assistant is ${ASSISTANT_NAME}.

${namingLanguageRule()}

## TASK 1: TAB TITLE
${workingTitleRules()}
${includeSessionName ? `
## TASK 2: SESSION NAME
${sessionNameRules()}` : ''}

OUTPUT FORMAT (JSON only, single object on one line, no prose, no markdown):
{
  "tab_title": "<2-4 word gerund sentence ending with period>"${includeSessionName ? `,
  "session_name": "<exactly 5 words in Title Case, grammatical task phrase>"` : ''}
}`;
}

// Assistant turns carry Algorithm scaffolding (phase headers like "Entering the Review phase",
// agent names like "Forge", SUMMARY lines). When fed into the Haiku naming prompt, those tokens
// leak into session names — producing garbage like "Review Entering Yet Forge" instead of the
// user's actual subject. Callers set `includeAssistant: false` when generating the first-prompt
// session name. The follow-up passes (current task, misheard-term correction, recalibration) opt
// in, because what the session became lives partly in the replies; their validators guard the shape.
// `assistantTailChars` also keeps the END of each assistant turn: a reply's proposal and next
// action sit at its end, and a "y" means "do that" (2026-10-10, ISA F8).
function getRecentContext(transcriptPath: string, maxTurns: number = 6, includeAssistant: boolean = false, assistantChars: number = 150, assistantTailChars: number = 0): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return '';
    // A bounded tail: only the last turns are kept, and whole-file reads of long sessions held prompts for seconds (ISC-18).
    const lines = readTranscriptTail(transcriptPath);
    const turns: { role: string; text: string }[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user' && entry.message?.content) {
          let text = '';
          if (typeof entry.message.content === 'string') text = entry.message.content;
          else if (Array.isArray(entry.message.content))
            text = entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ');
          // Synthetic local-command records are `type:"user"` too; the model
          // must not see a command's stdout as something the user said (#2033).
          const own = stripHarnessMarkup(text);
          if (own) turns.push({ role: 'User', text: own.slice(0, 200) });
        }
        if (includeAssistant && entry.type === 'assistant' && entry.message?.content) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? entry.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join(' ')
              : '';
          if (text) {
            const summaryMatch = text.match(/SUMMARY:\s*([^\n]+)/i);
            const head = summaryMatch ? summaryMatch[1] : text.slice(0, assistantChars);
            // The tail starts where the head stopped, so a mid-length reply is never quoted twice.
            const tailFrom = Math.max(summaryMatch ? 0 : assistantChars, text.length - assistantTailChars);
            const tail = assistantTailChars > 0 && tailFrom < text.length ? text.slice(tailFrom) : '';
            turns.push({ role: 'Assistant', text: tail ? `${head} … ${tail}`.replace(/\s+/g, ' ') : head });
          }
        }
      } catch {}
    }

    const recent = turns.slice(-maxTurns);
    return recent.length > 0 ? recent.map(t => `${t.role}: ${t.text}`).join('\n') : '';
  } catch { return ''; }
}

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

/**
 * Detect a slash-command / skill invocation and return the command name.
 * Two shapes reach the hook: the harness-expanded form carries an explicit
 * `<command-name>/Upgrade</command-name>` marker; a directly-typed command
 * arrives as a leading `/Upgrade` token. Returns the bare name ("Upgrade")
 * or null for ordinary prompts. The leading-slash branch requires a single
 * token so absolute paths like "/Users/x/y" never read as commands.
 */
function extractSlashCommandName(rawPrompt: string): string | null {
  const tagged = rawPrompt.match(/<command-name>\s*\/?([A-Za-z][A-Za-z0-9_-]*)/i);
  if (tagged) return tagged[1];
  const firstTok = rawPrompt.trim().split(/\s+/)[0] || '';
  if (/^\/[A-Za-z][A-Za-z0-9_-]*$/.test(firstTok)) return firstTok.slice(1);
  // Skill-routed commands arrive SLASHLESS: typing "/rc" reaches this hook as
  // the bare prompt "rc" (verified in a live transcript, 2026-08-12), so both
  // branches above miss it and the 2-char prompt then dies at MIN_PROMPT_LENGTH —
  // the session stays unnamed. Accept a bare single-token prompt only when it
  // matches the on-disk roster (commands/*.md or skills/<name>/), so ordinary
  // one-word replies ("yes", "ok") can never read as skill runs.
  const bare = rawPrompt.trim();
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(bare) && isKnownCommandOrSkill(bare)) return bare;
  return null;
}

/** Case-insensitive membership test against ~/.claude/commands/*.md and ~/.claude/skills/<dir>/. */
function isKnownCommandOrSkill(token: string): boolean {
  const lower = token.toLowerCase();
  try {
    const { readdirSync } = require('fs') as typeof import('fs');
    const claudeDir = getClaudeDir();
    for (const f of readdirSync(join(claudeDir, 'commands'))) {
      if (f.toLowerCase() === `${lower}.md`) return true;
    }
    for (const d of readdirSync(join(claudeDir, 'skills'))) {
      if (d.toLowerCase() === lower) return true;
    }
  } catch {}
  return false;
}

/**
 * A leading command shortcut with arguments ("ha https://x.com/…") is not a
 * word in any language, but the naming model saw only "ha" plus a URL and the
 * LANGUAGE block read it as Italian ("has"), so the session got an Italian
 * name (2026-10-02; an earlier "ha <youtube>" did the same). This note tells the model what the
 * shortcut means, and when nothing else in the message is natural language it
 * fixes the output language to English instead of letting the shortcut decide.
 */
export function commandShortcutNote(rawPrompt: string): string | null {
  const tokens = rawPrompt.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const token = tokens[0].replace(/^\//, '');
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(token) || !isKnownCommandOrSkill(token)) return null;
  const description = commandDescription(token);
  const rest = tokens.slice(1).join(' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:~|\.{0,2})?\/\S+/g, ' ');
  const naturalWords = rest.match(/\p{L}{2,}/gu) ?? [];
  const lines = [
    `COMMAND SHORTCUT: the first word "${token}" is a LifeOS command name, not a word in any language.${description ? ` It means: ${description}` : ''} Name the work after that action applied to the rest of the message.`,
  ];
  if (naturalWords.length < 3) {
    lines.push('LANGUAGE: apart from the command name, this message has no natural-language sentence (only URLs, paths, or a few tokens), so write every output in English.');
  }
  return lines.join('\n');
}

/** The `description:` line of commands/<token>.md, or null. */
function commandDescription(token: string): string | null {
  try {
    const { readdirSync, readFileSync } = require('fs') as typeof import('fs');
    const dir = join(getClaudeDir(), 'commands');
    const file = readdirSync(dir).find(f => f.toLowerCase() === `${token.toLowerCase()}.md`);
    // A skill typed as a command ("/Upgrade") has no commands/ file; its SKILL.md carries the description.
    const skillsDir = join(getClaudeDir(), 'skills');
    const skill = file ? null : readdirSync(skillsDir).find(d => d.toLowerCase() === token.toLowerCase());
    const path = file ? join(dir, file) : skill ? join(skillsDir, skill, 'SKILL.md') : null;
    if (!path) return null;
    const m = readFileSync(path, 'utf-8').match(/^description:\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

/**
 * The words the principal typed after a slash command: the harness's
 * `<command-args>` block, or the rest of a leading `/cmd …` line. Empty for a
 * bare command.
 */
export function extractCommandArgs(rawPrompt: string): string {
  const tagged = rawPrompt.match(/<command-args>([\s\S]*?)<\/command-args>/i);
  if (tagged) return tagged[1].replace(/\s+/g, ' ').trim();
  if (/<command-name>/i.test(rawPrompt)) return '';
  const tokens = rawPrompt.trim().split(/\s+/);
  return /^\/?[A-Za-z][A-Za-z0-9_-]*$/.test(tokens[0] || '') ? tokens.slice(1).join(' ').trim() : '';
}

/**
 * What a slash-command session is called before (or without) the model's
 * name: the command's own title ("# a — Analyze" → "Analyze", "# /rc — Cut a
 * Release Candidate (…)" → "Cut A Release Candidate"), else the Title-Cased
 * command name. Never "<X> Skill Run": the name comes from what is running and
 * what the prompt asked (2026-10-09).
 */
export function commandTitle(token: string): string {
  try {
    const { readdirSync, readFileSync } = require('fs') as typeof import('fs');
    const dir = join(getClaudeDir(), 'commands');
    const file = readdirSync(dir).find(f => f.toLowerCase() === `${token.toLowerCase()}.md`);
    if (file) {
      const h1 = readFileSync(join(dir, file), 'utf-8').match(/^#\s+(.+)$/m)?.[1] ?? '';
      const title = (h1.split(/\s+[—–-]\s+/)[1] ?? '').replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
      if (title) return title.split(/\s+/).slice(0, 5).map(titleCase).join(' ');
    }
  } catch {}
  return commandNameToLabel(token);
}

/**
 * The model note for naming a slash-command session: what the command does,
 * plus how to name a bare one (no subject typed, so the name is the action).
 */
export function commandNamingNote(token: string, args: string): string {
  if (args) return commandShortcutNote(`${token} ${args}`) ?? '';
  const description = commandDescription(token);
  return [
    `COMMAND: the message is the LifeOS command "${token}" with nothing after it.${description ? ` It means: ${description}` : ''}`,
    'Name the session after what that command does, in plain words a person would use. Never name it after the command token itself, and never call it a skill run.',
    'LANGUAGE: write every output in English.',
  ].join('\n');
}

/** "create-storyexplanation" → "Create Storyexplanation". */
function commandNameToLabel(cmd: string): string {
  return cmd
    .split(/[-_]+/)
    .filter(Boolean)
    .map(titleCase)
    .join(' ');
}

// ── Plan / finish split (2026-09-05, FUNCTIONHOOKS unit B) ─────────────────────
// The model call is the only slow, non-deterministic step. `plan()` does every
// deterministic thing before it and returns the request; `finish()` does every
// thing after it. The native path (main) still runs plan → Inference → finish in
// one process. In an armed LifeOSHooks session the plugin runs plan through
// HookBridge prompt-context, makes the call in-process with $.model.complete
// (no `claude` subprocess), and hands the reply to finish through HookBridge
// model-result. Same code, one owner, two carriers.

export interface PPContinuation {
  sessionId: string;
  isFirstPrompt: boolean;
  pendingFallbackName: string | null;
  deterministicTitle: string | null;
  cleanPrompt: string;
  sanitizedPrompt: string;
  priorAscent?: AscentState;
  algoIteration: boolean;
  inferenceStart: number;
  /** Follow-up correction pass: the model is asked only whether the stored
   * name carries a misheard/misspelled term (2026-09-10). */
  nameCorrection?: boolean;
  /** Follow-up recalibration pass: the model is asked whether the session's
   * main subject moved away from the stored name (2026-10-10). */
  recalibrate?: boolean;
  /** Follow-up request: the reply carries `current_task`, the tab's activity
   * (2026-10-10). Alone it is the plain task request; with nameCorrection or
   * recalibrate it rides that same single request. */
  currentTask?: boolean;
  currentName?: string;
}
export interface PPModelRequest { system: string; prompt: string; level: 'low' | 'medium' }
export interface PPPlan { request: PPModelRequest; continuation: PPContinuation }

// ── Name correction on early follow-ups (2026-09-10) ───────────────────────────
// The name is set once from the first prompt, and dictation and typing put
// misheard terms in it ("update the ISIS system" → a session named ISIS when
// the work is the ISA). The DA corrects the term in the reply; the title never
// followed. The first NAME_CORRECTION_CHECKS follow-up prompts that reach the
// model gates re-read the stored name against the conversation (user AND
// assistant turns, since the correction usually lives in the DA's reply) and
// swap the misheard term. A topic pivot is NOT a correction — recalibration
// (below) handles that, on its own schedule — so the accepted replacement must
// keep most of its words (isTermSubstitution). One correction per session,
// then the pass stops.
const NAME_CORRECTION_CHECKS = 3;
// Resolved per call, like session-identity's paths: a constant froze the
// LIFEOS_DIR of whichever caller imported this module first, so a second test
// file (or any in-process caller that sets LIFEOS_DIR later) read and wrote the
// first one's tree.
const SESSION_NAME_CHECKS_PATH = () => lifeosPath('MEMORY', 'STATE', 'session-name-checks.json');
interface NameCheckState { checks: number; corrected?: boolean }

function readNameChecks(): Record<string, NameCheckState> {
  try {
    if (!existsSync(SESSION_NAME_CHECKS_PATH())) return {};
    return JSON.parse(readFileSync(SESSION_NAME_CHECKS_PATH(), 'utf-8')) as Record<string, NameCheckState>;
  } catch { return {}; }
}

function writeNameChecks(state: Record<string, NameCheckState>): void {
  try { writeFileSync(SESSION_NAME_CHECKS_PATH(), JSON.stringify(state, null, 2), 'utf-8'); } catch {}
}

/** Claim one correction check for this session. False once the window is spent or a correction landed. */
function claimNameCheck(sessionId: string): boolean {
  const state = readNameChecks();
  const row = state[sessionId] ?? { checks: 0 };
  if (row.corrected || row.checks >= NAME_CORRECTION_CHECKS) return false;
  state[sessionId] = { ...row, checks: row.checks + 1 };
  writeNameChecks(state);
  return true;
}

function markNameCorrected(sessionId: string): void {
  const state = readNameChecks();
  state[sessionId] = { ...(state[sessionId] ?? { checks: 0 }), corrected: true };
  writeNameChecks(state);
}

/**
 * A correction replaces a misheard or misspelled term and keeps the rest of
 * the name. Same word count, and at most two words differ (case-insensitive,
 * position-wise). Anything looser is a rename, which this pass never does.
 */
export function isTermSubstitution(current: string, proposed: string): boolean {
  const a = current.trim().split(/\s+/).filter(Boolean);
  const b = proposed.trim().split(/\s+/).filter(Boolean);
  if (a.length === 0 || a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (a[i].toLowerCase() !== b[i].toLowerCase()) changed++;
  return changed >= 1 && changed <= 2;
}

export interface NameCorrectionReply {
  corrected?: boolean;
  session_name?: string | null;
  tab_label?: string | null;
  reason?: string | null;
  current_task?: string | null;
}

/**
 * Validate the model's correction reply against the stored name. Returns the
 * name (and label, when the model gave a valid one) to store, or null when
 * nothing should change. Pure: no I/O, so it is unit-testable.
 */
export function acceptNameCorrection(currentName: string, reply: NameCorrectionReply | null | undefined): { name: string; label: string | null } | null {
  if (!reply || !reply.corrected || !reply.session_name) return null;
  if (/[*`<>{}[\]]/.test(reply.session_name)) return null;
  const words = reply.session_name.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  const label = words.map(w => titleCase(w)).join(' ');
  if (!label || label === currentName) return null;
  if (words.some(w => PROFANITY_WORDS.has(w.toLowerCase()))) return null;
  if (!isValidInferredSessionName(label)) return null;
  if (!isTermSubstitution(currentName, label)) return null;
  const tabLabel = reply.tab_label && isValidSessionLabel(reply.tab_label) ? reply.tab_label.trim() : null;
  return { name: label, label: tabLabel };
}

export function buildCorrectionPrompt(currentName: string): string {
  return `You check whether a session name carries a misheard or misspelled term. ${PRINCIPAL_NAME} is the only user; the AI assistant is ${ASSISTANT_NAME}. ${PRINCIPAL_NAME} often dictates, so the first message can contain a term that was transcribed or typed wrong ("ISIS" for "ISA", "pulse" for "Pulse", "sea suite" for "C-suite"). The session was named from that first message. The conversation since then, especially ${ASSISTANT_NAME}'s replies, shows what the term actually was.

STORED SESSION NAME: "${currentName}"

Decide ONE thing: does any word in the stored name spell a term differently from how the conversation clearly uses it, where the two are the same thing misheard or mistyped?
- YES → corrected = true. Rewrite the name with ONLY that term fixed. Keep every other word, the word count, the word order, the Title Case, and the language exactly as they are. Preserve acronyms in ALL CAPS (ISA, ISC, TELOS, API, CLI).
- NO → corrected = false. A change of topic, a better phrasing, a different verb, or a name you simply prefer is NOT a correction. When in doubt, corrected = false.

${currentTaskRules()}

OUTPUT FORMAT (JSON only, single object on one line, no prose, no markdown):
{"corrected": <true|false>, "session_name": "<the fixed name, or null>", "reason": "<one short clause: which term, and what it was>", ${CURRENT_TASK_FIELD}}`;
}

// ── Name recalibration on later follow-ups (2026-10-10) ───────────────────────
// A long session moves on from what its first prompt was about, and the name
// it got then stops describing it, most of all in long-running sessions
// (2026-10-10). Once the correction
// window is spent, a follow-up that finds the session due (session-identity.ts:
// at most every ten minutes, never for a pinned or ISA-named session) asks the
// model one question: has the main subject moved so far that the name would
// mislead someone scanning tabs? Only then does the name change, through the
// one writer, so the status line, the tab (kitty or herdr), Pulse /agents and
// Claude Code's own title all follow.
//
// The name is the session's plot; the tab's current task is its thread
// (2026-10-15, ISA F9). Told to weight recent work and shown only the last few
// turns, the namer renamed on every sub-step. It now also sees the session's
// earlier names, and a next step of the same project is not a move.

/** At or above this share of shared words, a proposed name is a rewording of the current one. */
const RECALIBRATION_MAX_OVERLAP = 0.6;

export interface RecalibrationReply {
  rename?: boolean;
  session_name?: string | null;
  reason?: string | null;
  current_task?: string | null;
}

/** Shared lowercase words divided by the longer name's word count. */
function nameWordOverlap(a: string, b: string): number {
  const wa = a.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const wb = b.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const longer = Math.max(wa.length, wb.length);
  if (longer === 0) return 1;
  const inB = new Set(wb);
  const shared = new Set(wa.filter(w => inB.has(w))).size;
  return shared / longer;
}

/**
 * Validate the model's recalibration reply against the stored name. Returns the
 * new name to store, or null when the name should stay. Pure: no I/O.
 * Refuses a keep, markup, profanity, anything the inferred-name validator
 * rejects, and a rewording of the same subject (word overlap at or above 60%).
 */
export function acceptRecalibration(currentName: string, reply: RecalibrationReply | null | undefined): { name: string } | null {
  if (!reply || reply.rename !== true || typeof reply.session_name !== 'string' || !reply.session_name.trim()) return null;
  if (/[*`<>{}[\]]/.test(reply.session_name)) return null;
  const words = reply.session_name.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.some(w => PROFANITY_WORDS.has(w.toLowerCase()))) return null;
  const name = words.map(w => titleCase(w)).join(' ');
  if (!name || !isValidInferredSessionName(name)) return null;
  if (name.toLowerCase() === currentName.trim().toLowerCase()) return null;
  if (nameWordOverlap(currentName, name) >= RECALIBRATION_MAX_OVERLAP) return null;
  return { name };
}

export function buildRecalibrationPrompt(currentName: string): string {
  return `You decide whether a session's name still says what the session is about. ${PRINCIPAL_NAME} is the only user; the AI assistant is ${ASSISTANT_NAME}. ${PRINCIPAL_NAME} scans session names in his terminal tabs and task list to find his work. The name was set from the session's first message; the session may have moved on since.

CURRENT SESSION NAME: "${currentName}"

The session NAME carries the plot: the overall project or subject the whole session serves. What the session is doing this minute is shown separately as current_task, so the name never has to track the latest step.

You get the session's FIRST MESSAGE, its EARLIER NAMES when it has had any (oldest first, each one a phase of the session), the RECENT CONVERSATION, and the CURRENT MESSAGE. Decide ONE thing: has the session's OVERALL subject changed so much that the current name would mislead ${PRINCIPAL_NAME} about what the session as a whole is for?
- NO → rename = false, session_name = null. A new phase, sub-task, follow-on step or next piece of the same project is NOT a move; that is current_task's job. Neither is a rewording, a better verb, a broader name that would also fit, or a side question the session will return from. If the current name still describes the work going on now, keep it. When in doubt, rename = false.
- YES, only when the session has left its subject for a different one and the current name no longer covers most of it → rename = true. A subject is a specific piece of work, never the codebase or system it lives in: two unrelated jobs in the same repo are two subjects. The new name must cover the earlier names AND the current work: name the umbrella they share, never only the latest step. Follow the SESSION NAME rules below exactly.

${namingLanguageRule()}

## SESSION NAME
${sessionNameRules()}

${currentTaskRules()}

OUTPUT FORMAT (JSON only, single object on one line, no prose, no markdown):
{"rename": <true|false>, "session_name": "<the new 5-word name, or null>", "reason": "<one short clause: what the session is about now>", ${CURRENT_TASK_FIELD}}`;
}

/** The session's earlier names as a prompt block, oldest first, or null when it has had none. Pure. */
export function earlierNamesBlock(history: readonly string[]): string | null {
  const names = history.map((n) => n.trim()).filter(Boolean);
  return names.length ? `EARLIER NAMES OF THIS SESSION (oldest first):\n${names.map((n) => `- ${n}`).join('\n')}` : null;
}

/** Bytes of the transcript read to find its first user message. The first
 * record sits near the top; reading the whole file would cost a long session's
 * full transcript every ten minutes on top of getRecentContext's read. */
const FIRST_MESSAGE_SCAN_BYTES = 1_048_576;

/** The session's first message the user actually typed, harness markup
 * stripped, or null when it is not in the transcript's head. */
function getFirstUserMessage(transcriptPath: string): string | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let head = '';
  try {
    const { openSync, readSync, closeSync } = require('fs') as typeof import('fs');
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(FIRST_MESSAGE_SCAN_BYTES);
      const n = readSync(fd, buf, 0, FIRST_MESSAGE_SCAN_BYTES, 0);
      head = buf.subarray(0, n).toString('utf-8');
    } finally { closeSync(fd); }
  } catch { return null; }
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; } // a line cut by the byte window, or not JSON
    if (entry?.type !== 'user' || entry.isMeta || !entry.message?.content) continue;
    const content = entry.message.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ') : '';
    const own = stripHarnessMarkup(text);
    if (!own || SYSTEM_TEXT_PATTERNS.some(re => re.test(own))) continue;
    return own.slice(0, 600);
  }
  return null;
}

/** Set the working tab, preserving the run's ascent state on iterations.
 * Tab colors are ONLY the six ascent-state colors (2026-08-12) —
 * the transient 🧠 thinking-purple stamp is retired; the ⚡ activity glyph
 * (setAscentTab default for live states) carries "working" instead. */
function stampWorkingTabFor(c: { sessionId: string; priorAscent?: AscentState; algoIteration: boolean }) {
  return (rawTitle: string): void => {
    if (c.algoIteration && c.priorAscent) {
      setAscentTab(c.priorAscent, c.sessionId, rawTitle);
    } else {
      // Un-ISA'd live work is traverse (🥾) — on the hill without a declared
      // route, not the retired pre-Algorithm working gear.
      setAscentTab('traverse', c.sessionId, rawTitle);
    }
  };
}

/** Read-only projections of the existing keyword tables; never used to change naming decisions. */
export function keywordSignalVerdicts(prompt: string): SignalVerdicts {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?,'"]/g, '');
  const words = normalized.split(/\s+/);
  const praise = words.length <= 2 && (POSITIVE_PRAISE_WORDS.has(normalized) || POSITIVE_PHRASES.has(normalized) ||
    (words.length === 2 && words.every(w => POSITIVE_PRAISE_WORDS.has(w))));
  const sanitized = sanitizePromptForNaming(prompt);
  return {
    praise,
    question: extractQuestionSubject(sanitized) !== null,
    task: sanitized.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).some(w => ACTION_VERBS.has(w) && !META_VERBS.has(w)),
    correction: detectExplicitCorrection(prompt) !== null,
    frustration: frustrationRead(prompt).fires,
    // Existing system-text detector is the deterministic proxy, not a security verdict.
    injection: SYSTEM_TEXT_PATTERNS.some(re => re.test(prompt.trim())),
  };
}

export function observePromptSignals(prompt: string, session: string, paths: SignalPaths = {}): void {
  observeSignals(session, prompt, keywordSignalVerdicts(prompt), paths);
}

/**
 * The words this prompt carries. A text puts the thread view or the delivered history before the request, and
 * naming a session or reading its signals from that history names it after old messages, so only the request
 * counts, as the one shared reader finds it (Tex ISA F19, ISC-234). An unframed prompt is returned whole.
 */
export function promptText(data: Pick<HookInput, 'prompt' | 'user_prompt'>): string {
  return textRequest(data.prompt || data.user_prompt || '');
}

/** Everything before the model call. Null means there is nothing left to do this prompt. */
export async function plan(data: HookInput): Promise<PPPlan | null> {
  const prompt = promptText(data);
  const sessionId = data.session_id;
  if (!prompt || !sessionId) return null;
  observePromptSignals(prompt, sessionId);

  // ── Determine session state ──
  const existingNames = readSessionNames();
  const isFirstPrompt = !existingNames[sessionId];
  const sanitizedPrompt = sanitizePromptForNaming(prompt);

  // ── Slash-command / skill invocation: name deterministically from the command ──
  // A command name (e.g. "/Upgrade") can never satisfy the natural-language
  // naming path (extractFallbackName + inference both want a 5-word action-verb
  // phrase), so those sessions used to fall through every fallback and stay
  // unnamed. The command's own title is stored at once as the floor (bypassing
  // the NL validator), then the namer gets the command's meaning plus whatever
  // was typed after it, so "/a the router" names the analysis of the router
  // instead of "A Skill Run" (2026-10-09).
  const slashCmd = isFirstPrompt ? extractSlashCommandName(prompt) : null;
  if (slashCmd) {
    const title = commandTitle(slashCmd);
    const args = sanitizePromptForNaming(extractCommandArgs(prompt));
    storeName(sessionId, title, 'slash-command');
    upsertSession(sessionId, title, (args || slashCmd).slice(0, 120));
    // A command run is live work with no ISA declared yet — that is exactly
    // the traverse state, not the pre-Algorithm gear. The session-name prefix
    // is composed in tab-setter now, so pass only the activity.
    setAscentTab('traverse', sessionId, title);
    const cleanPrompt = (args ? `${slashCmd} ${args}` : slashCmd).slice(0, 1000);
    const context = getRecentContext(data.transcript_path, 6, false);
    const messageBlock = `${commandNamingNote(slashCmd, args)}\n\n${cleanPrompt}`;
    return {
      request: { system: buildContextPrompt(true), prompt: context ? `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${messageBlock}` : messageBlock, level: 'medium' },
      continuation: {
        sessionId, isFirstPrompt, pendingFallbackName: null, deterministicTitle: title, cleanPrompt, sanitizedPrompt: args,
        algoIteration: false, inferenceStart: Date.now(),
      },
    };
  }

  // A first prompt with no user words (local command + attachment only) must
  // not name the session: a wrong name sticks until recalibration sees the
  // subject move. Exiting without storing leaves the NEXT prompt as the first
  // one. Sits after the slash-command
  // branch, whose `<command-name>` marker is a valid naming path on its own.
  // public issue #2033, @xmasyx
  if (isFirstPrompt && !hasUserWords(prompt)) {
    console.error('[PromptProcessing] First prompt carries no user words (local command / attachment only) — naming deferred to the next prompt');
    return null;
  }

  // ── Session name: compute deterministic fallback but DEFER storage until after inference ──
  // Inference understands intent (project, goal). Deterministic is last resort only.
  let pendingFallbackName: string | null = null;
  if (isFirstPrompt && sanitizedPrompt) {
    pendingFallbackName = extractFallbackName(sanitizedPrompt);
    if (pendingFallbackName && !isValidSessionName(pendingFallbackName)) {
      console.error(`[PromptProcessing] Rejected invalid fallback name: "${pendingFallbackName}"`);
      pendingFallbackName = null;
    }
    // Upsert both native and starting. Native shows in the Native tab
    // (no phase strip); starting shows in Algorithm with phase progression.
    // Trivial prompts are already filtered by the fast-path gates above
    // (praise words, system text, length < MIN_PROMPT_LENGTH).
    upsertSession(sessionId, pendingFallbackName || '', sanitizedPrompt.slice(0, 120));
  } else {
    // A `/rename` reaches the stores through SessionTitle.hook.ts,
    // which tells a real rename from the harness re-appending its old title.
    upsertSession(sessionId, existingNames[sessionId] || '', '');
  }

  // ── Skip Haiku inference on trivial prompts (naming/title not useful) ──
  if (isExplicitRating(prompt)) return null;

  const normalizedPrompt = prompt.trim().toLowerCase().replace(/[.!?,'"]/g, '');
  const promptWords = normalizedPrompt.split(/\s+/);
  if (promptWords.length <= 2) {
    if (POSITIVE_PRAISE_WORDS.has(normalizedPrompt) || POSITIVE_PHRASES.has(normalizedPrompt)
        || (promptWords.length === 2 && promptWords.every(w => POSITIVE_PRAISE_WORDS.has(w)))) {
      return null;
    }
  }

  if (SYSTEM_TEXT_PATTERNS.some(re => re.test(prompt.trim()))) return null;
  // The length floor is for naming: a 1-2 character first prompt has nothing to
  // name. A follow-up "y" or "c" still says what happens next, read with the
  // turns before it, so follow-ups only need a non-blank prompt (2026-10-10).
  if (isFirstPrompt ? prompt.length < MIN_PROMPT_LENGTH : !prompt.trim()) return null;

  // ── Preserve an active run's ascent state across iterations ──
  // On a follow-up prompt mid-run the prior tab already carries a state;
  // re-stamp it (updating only the summary) instead of reverting to the
  // generic working gear — the regression where the orange ⚙️ reappeared
  // and wiped the run's tab. The old hand-listed station set here went stale
  // when the vocabulary moved, so every current run hit the wipe path
  // (found 2026-07-27); the check is now "is this a live run state?".
  const priorTab = !isFirstPrompt ? readTabState(sessionId) : null;
  // The run's real state comes from work.json — the SAME row Pulse reads — not
  // the tab's own persisted file. Trusting the tab file wiped a live ISA back
  // to ⚡ traverse on any follow-up prompt whenever the last stamp was cairn
  // (Stop paints cairn) or traverse (found 2026-09-07: a climbing ISA showing
  // ⚡ while Pulse showed 🧗). The row wins; the tab file is the fallback when
  // there is no row (native/starting sessions before their first ISA write).
  const rowAscent = !isFirstPrompt ? resolveSessionRow(sessionId)?.ascent ?? undefined : undefined;
  const rawPrior = rowAscent ?? priorTab?.ascent;
  // Tab state is untyped on disk; only a value the ascent table knows is a prior state.
  const priorAscent: AscentState | undefined = rawPrior && (ASCENT_STATES as readonly string[]).includes(rawPrior) ? (rawPrior as AscentState) : undefined;
  const algoIteration = !!priorAscent && !['idle', 'cairn', 'traverse'].includes(priorAscent);
  const stampWorkingTab = stampWorkingTabFor({ sessionId, priorAscent, algoIteration });

  // ── DETERMINISTIC TAB TITLE (immediate) ──
  // Follow-ups keep the session's identity on the tab; the raw prompt is
  // only a title source on the first prompt, before a session name exists.
  const sessionTitle = !isFirstPrompt ? followupTitleFromSessionName(sessionId) : null;
  const deterministicTitle = quickTitle(prompt);
  const thinkingTitle = sessionTitle || deterministicTitle || getWorkingFallback();
  stampWorkingTab(thinkingTitle);

  // ── Follow-ups: one model request, always asking for the current task ──
  // The stamp below, from the stored session name, is only the placeholder
  // until the reply lands. 7.0.0 BLE cut the per-prompt call because the hook
  // made the principal wait on every prompt; the hook is async now, so nobody waits, and
  // the call buys the tab its real job: the task at hand (2026-10-10, ISA F8).
  // Exactly one request per follow-up. It asks for `current_task`, plus at most
  // one name question: the misheard-term correction window first, then the
  // ten-minute recalibration, which renames the session when its main subject
  // has moved. Otherwise it is the plain task request at the low level.
  if (!isFirstPrompt) {
    const followupTitle = sessionTitle
      || (deterministicTitle && isValidWorkingTitle(deterministicTitle) ? deterministicTitle : getWorkingFallback());
    stampWorkingTab(followupTitle);
    appendPromptProcessingTelemetry({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      prompt_excerpt: prompt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120),
      tab_title: followupTitle,
      source: 'deterministic-followup',
      latency_ms: 0,
    });

    // A follow-up always has a stored name (that is what makes it a follow-up);
    // this guards the type, not a reachable state.
    const currentName = existingNames[sessionId];
    if (!currentName) return null;
    const cleanFollowup = prompt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);

    // ── Name correction window (2026-09-10) ──
    // Does the stored name carry a misheard term the conversation has since
    // resolved? Bounded to the first NAME_CORRECTION_CHECKS follow-ups that
    // reach this point, and off for good once a correction lands. Assistant
    // turns are IN the context here on purpose — the correction usually lives
    // in the DA's reply.
    if (claimNameCheck(sessionId)) {
      const followupContext = getRecentContext(data.transcript_path, 8, true, 400, 300);
      const followupPrompt = followupContext ? `CONVERSATION SO FAR:\n${followupContext}\n\nCURRENT MESSAGE:\n${cleanFollowup}` : `CURRENT MESSAGE:\n${cleanFollowup}`;
      console.error(`[PromptProcessing] Planning name-correction check + current task for "${currentName}"`);
      return {
        request: { system: buildCorrectionPrompt(currentName), prompt: followupPrompt, level: 'medium' },
        continuation: {
          sessionId, isFirstPrompt, pendingFallbackName: null, deterministicTitle, cleanPrompt: cleanFollowup, sanitizedPrompt,
          priorAscent, algoIteration, inferenceStart: Date.now(), nameCorrection: true, currentTask: true, currentName,
        },
      };
    }

    // ── Name recalibration (2026-10-10) ──
    // The slot is taken BEFORE the request goes out, so a prompt that lands
    // while this one's model call is still in flight does not ask again.
    const now = Date.now();
    if (recalibrationDue(sessionId, now)) {
      markRecalibrated(sessionId, now);
      const firstMessage = getFirstUserMessage(data.transcript_path);
      const recentContext = getRecentContext(data.transcript_path, 10, true, 300, 300);
      const recalPrompt = [
        firstMessage ? `FIRST MESSAGE OF THE SESSION:\n${firstMessage}` : null,
        earlierNamesBlock(readNameHistory(sessionId)),
        recentContext ? `RECENT CONVERSATION:\n${recentContext}` : null,
        `CURRENT MESSAGE:\n${cleanFollowup}`,
      ].filter(Boolean).join('\n\n');
      console.error(`[PromptProcessing] Planning name recalibration + current task for "${currentName}"`);
      return {
        // Low: one keep-or-rename judgment, cheap enough to run every ten minutes.
        request: { system: buildRecalibrationPrompt(currentName), prompt: recalPrompt, level: 'low' },
        continuation: {
          sessionId, isFirstPrompt, pendingFallbackName: null, deterministicTitle, cleanPrompt: cleanFollowup, sanitizedPrompt,
          priorAscent, algoIteration, inferenceStart: now, recalibrate: true, currentTask: true, currentName,
        },
      };
    }

    // ── Current task only ──
    // Low: a 2-4 word read of the recent turns, made on every follow-up.
    const taskContext = getRecentContext(data.transcript_path, 8, true, 400, 300);
    const taskPrompt = taskContext ? `RECENT CONVERSATION:\n${taskContext}\n\nCURRENT MESSAGE:\n${cleanFollowup}` : `CURRENT MESSAGE:\n${cleanFollowup}`;
    console.error(`[PromptProcessing] Planning current task for "${currentName}"`);
    return {
      request: { system: buildCurrentTaskPrompt(), prompt: taskPrompt, level: 'low' },
      continuation: {
        sessionId, isFirstPrompt, pendingFallbackName: null, deterministicTitle, cleanPrompt: cleanFollowup, sanitizedPrompt,
        priorAscent, algoIteration, inferenceStart: now, currentTask: true, currentName,
      },
    };
  }

  // ── DETERMINISTIC NAME FLOOR (first prompt only, both carriers) ──
  // The session gets a name NOW, before any model call, so the statusline, the
  // kitty tab prefix (tab-setter reads session-names.json), work.json and the
  // Pulse agents view agree on this very prompt. finish() overwrites it with
  // the model's name when that reply lands; when it never lands (2026-09-06:
  // no armed session had been named since the plugin's in-process model leg
  // shipped on 09-05, and no first-prompt telemetry row ever appeared), the
  // floor is what the session keeps. Sits after every trivial-prompt gate so
  // a "thanks" first prompt still names nothing.
  // Re-stamp the tab once the floor exists: the tab-setter composes its
  // `LABEL | activity` prefix from session-names.json at stamp time, and the
  // stamp above went out before the name did.
  if (storeFloorName(sessionId, pendingFallbackName, sanitizedPrompt)) stampWorkingTab(thinkingTitle);

  // ── INFERENCE: Tab title + session name (first prompt only) ──
  console.error('[PromptProcessing] Planning inference (tab title + session name)...');

  const cleanPrompt = markPastedForModel(prompt).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
  // The first-prompt name excludes Assistant turns so Algorithm scaffolding
  // (phase headers, agent names, SUMMARY lines) cannot contaminate the session name.
  // Only first prompts reach here; the follow-up branch above reads Assistant
  // turns for the current task.
  const context = getRecentContext(data.transcript_path, 6, !isFirstPrompt);
  const shortcutNote = isFirstPrompt ? commandShortcutNote(cleanPrompt) : null;
  const messageBlock = shortcutNote ? `${shortcutNote}\n\n${cleanPrompt}` : cleanPrompt;
  const userPrompt = context ? `CONTEXT:\n${context}\n\nCURRENT MESSAGE:\n${messageBlock}` : messageBlock;

  return {
    // v6.9.0 reversal: level=fast failed often in production because the
    // `claude` subprocess cold-start plus Haiku inference kept exceeding the
    // 12s window. Sonnet costs a little more time and understands intent
    // noticeably better on session names. (In an armed session the call is in-process and the cold-start
    // is gone; the tier stays for the name quality.)
    request: { system: buildContextPrompt(isFirstPrompt), prompt: userPrompt, level: 'medium' },
    continuation: {
      sessionId, isFirstPrompt, pendingFallbackName, deterministicTitle, cleanPrompt, sanitizedPrompt,
      priorAscent, algoIteration, inferenceStart: Date.now(),
    },
  };
}

/**
 * Put an accepted current task on the tab as its activity, or do nothing.
 * Called AFTER any name store, so the tab-setter composes the current label.
 * Never touches the session name. Returns the accepted task (null = refused,
 * and the prompt-time placeholder stays).
 * When the reply lands after Stop already ended the turn (the tab reads
 * completed), the task is shown done, in the past tense, rather than
 * re-opening the tab as working on a turn that is over.
 */
function applyCurrentTask(c: PPContinuation, raw: unknown, stampWorkingTab: (t: string) => void): string | null {
  if (!c.currentTask) return null;
  const task = acceptCurrentTask(raw);
  if (!task) return null;
  // Both are guaranteed upstream (plan() never plans without a session id;
  // acceptCurrentTask only returns validator-clean titles). A breach would paint
  // an unowned tab or a garbage activity, so it fails loud instead.
  invariant(typeof c.sessionId === 'string' && c.sessionId.length > 0, 'a current task is stamped onto a known session');
  invariant(isValidWorkingTitle(task), `an accepted current task is a valid working title, got "${task}"`);
  if (readTabState(c.sessionId)?.state === 'completed') {
    const words = task.replace(/\.$/, '').split(/\s+/);
    words[0] = gerundToPastTense(words[0]);
    setAscentTab('cairn', c.sessionId, words.join(' '));
  } else {
    stampWorkingTab(task);
  }
  return task;
}

/** The plain follow-up leg of finish(): only the current task was asked for. */
function finishCurrentTask(c: PPContinuation, result: { success: boolean; parsed?: unknown; error?: string }, stampWorkingTab: (t: string) => void): void {
  const { sessionId, cleanPrompt, inferenceStart } = c;
  const base = { timestamp: new Date().toISOString(), session_id: sessionId, prompt_excerpt: cleanPrompt.slice(0, 120), latency_ms: Date.now() - inferenceStart };
  if (!result.success || !result.parsed || typeof result.parsed !== 'object') {
    console.error(`[PromptProcessing] Current-task inference failed: ${result.error ?? 'no JSON object in the reply'}`);
    appendPromptProcessingTelemetry({ ...base, source: 'current-task-failed', error: String(result.error ?? 'no JSON object').slice(0, 80) });
    return;
  }
  const proposed = (result.parsed as { current_task?: unknown }).current_task;
  const task = applyCurrentTask(c, proposed, stampWorkingTab);
  console.error(task ? `[PromptProcessing] Current task: "${task}"` : `[PromptProcessing] Current task refused, placeholder kept`);
  appendPromptProcessingTelemetry({ ...base, source: 'current-task', current_task: task, ...(task ? {} : { proposed_task: typeof proposed === 'string' ? proposed.slice(0, 80) : null }) });
}

/** The follow-up correction leg of finish(): apply a validated term fix to
 * every surface the name lives on (session-names.json, work.json, the JSONL
 * custom-title, the tab label, the tab itself), or leave everything alone. */
function finishNameCorrection(c: PPContinuation, result: { success: boolean; parsed?: unknown; error?: string }, stampWorkingTab: (t: string) => void): void {
  const { sessionId, currentName = '', cleanPrompt, inferenceStart } = c;
  const base = { timestamp: new Date().toISOString(), session_id: sessionId, prompt_excerpt: cleanPrompt.slice(0, 120), latency_ms: Date.now() - inferenceStart };
  if (!result.success || !result.parsed) {
    console.error(`[PromptProcessing] Name-correction inference failed: ${result.error}`);
    appendPromptProcessingTelemetry({ ...base, source: 'name-correction-failed', error: String(result.error ?? 'unknown').slice(0, 80) });
    return;
  }
  const reply = result.parsed as NameCorrectionReply;
  const accepted = acceptNameCorrection(currentName, reply);
  if (!accepted) {
    const task = applyCurrentTask(c, reply.current_task, stampWorkingTab);
    console.error(`[PromptProcessing] Name kept: "${currentName}" (${reply.corrected ? 'proposal rejected' : 'no misheard term'})`);
    appendPromptProcessingTelemetry({ ...base, source: 'name-correction-kept', session_name: currentName, proposed: reply.session_name ?? null, reason: (reply.reason ?? '').slice(0, 120), current_task: task });
    return;
  }
  storeName(sessionId, accepted.name, 'inference-correction', accepted.label);
  markNameCorrected(sessionId);
  // The task, when accepted, is the tab's activity; the corrected name's
  // gerund form is only the fallback placeholder.
  const task = applyCurrentTask(c, reply.current_task, stampWorkingTab);
  if (!task) stampWorkingTab(sessionNameToTabTitle(accepted.name) || accepted.name.split(/\s+/).slice(0, 4).join(' '));
  console.error(`[PromptProcessing] Corrected session name: "${currentName}" → "${accepted.name}" (${reply.reason ?? 'no reason given'})`);
  appendPromptProcessingTelemetry({ ...base, source: 'name-correction', previous_name: currentName, session_name: accepted.name, tab_label: accepted.label, reason: (reply.reason ?? '').slice(0, 120), current_task: task });
}

/** The recalibration leg of finish(): store a validated new name through the
 * one writer (names, labels, the work.json row Pulse /agents reads, the JSONL
 * title) and stamp the tab from it, or leave everything alone. Never voiced. */
function finishRecalibration(c: PPContinuation, result: { success: boolean; parsed?: unknown; error?: string }, stampWorkingTab: (t: string) => void): void {
  const { sessionId, currentName = '', cleanPrompt, inferenceStart } = c;
  const base = { timestamp: new Date().toISOString(), session_id: sessionId, prompt_excerpt: cleanPrompt.slice(0, 120), latency_ms: Date.now() - inferenceStart };
  if (!result.success || !result.parsed) {
    console.error(`[PromptProcessing] Name-recalibration inference failed: ${result.error}`);
    appendPromptProcessingTelemetry({ ...base, source: 'name-recalibration-failed', session_name: currentName, error: String(result.error ?? 'unknown').slice(0, 80) });
    return;
  }
  const reply = result.parsed as RecalibrationReply;
  const reason = typeof reply.reason === 'string' ? reply.reason.slice(0, 120) : '';
  // The name moved while the model was thinking (a /rename, SessionRename, an
  // ISA binding): that newer name wins, and this reply was about the old one.
  const storedNow = readSessionNames()[sessionId];
  const stale = storedNow !== currentName || !!resolveSessionRow(sessionId)?.namedByIsa;
  const accepted = stale ? null : acceptRecalibration(currentName, reply);
  if (!accepted) {
    // The task describes the work, not the name, so it lands even when the
    // name moved meanwhile (stale): the stamp composes whatever label is stored now.
    const task = applyCurrentTask(c, reply.current_task, stampWorkingTab);
    const why = stale ? 'name changed since planning' : reply.rename ? 'proposal rejected' : 'same subject';
    console.error(`[PromptProcessing] Name kept: "${storedNow ?? currentName}" (${why})`);
    appendPromptProcessingTelemetry({ ...base, source: 'name-recalibration-kept', session_name: storedNow ?? currentName, proposed: typeof reply.session_name === 'string' ? reply.session_name : null, why, reason, current_task: task });
    return;
  }
  recordReplacedName(sessionId, currentName);
  storeName(sessionId, accepted.name, 'inference-recalibration');
  const stored = readSessionNames()[sessionId] ?? accepted.name;
  const task = applyCurrentTask(c, reply.current_task, stampWorkingTab);
  if (!task) stampWorkingTab(sessionNameToTabTitle(stored) || stored.split(/\s+/).slice(0, 4).join(' '));
  console.error(`[PromptProcessing] Recalibrated session name: "${currentName}" → "${stored}" (${reason || 'no reason given'})`);
  appendPromptProcessingTelemetry({ ...base, source: 'name-recalibration', previous_name: currentName, session_name: stored, reason, current_task: task });
}

/** Everything after the model call. `result` is Inference's shape: parsed JSON on success. */
export async function finish(c: PPContinuation, result: { success: boolean; parsed?: unknown; error?: string }): Promise<void> {
  const { sessionId, isFirstPrompt, pendingFallbackName, deterministicTitle, cleanPrompt, sanitizedPrompt, inferenceStart } = c;
  const stampWorkingTab = stampWorkingTabFor(c);
  if (c.nameCorrection) { finishNameCorrection(c, result, stampWorkingTab); return; }
  if (c.recalibrate) { finishRecalibration(c, result, stampWorkingTab); return; }
  if (c.currentTask) { finishCurrentTask(c, result, stampWorkingTab); return; }
  try {
    if (result.success && result.parsed) {
      const r = result.parsed as InferenceResult;

      // ── Process tab title ──
      let finalTitle = deterministicTitle && isValidWorkingTitle(deterministicTitle) ? deterministicTitle : getWorkingFallback();
      if (r.tab_title) {
        const inferredWords = r.tab_title.split(/\s+/);
        const validated = trimToValidTitle(inferredWords, isValidWorkingTitle);
        if (validated) {
          finalTitle = validated;
        }
      }
      // If inference session name is available, try deriving tab title from it
      // This ensures tab title and session name reflect the same understanding
      if (isFirstPrompt && r.session_name && !/[*`<>{}[\]]/.test(r.session_name)) {
        const derived = sessionNameToTabTitle(r.session_name);
        if (derived) finalTitle = derived;
      }
      // ── Process session name from inference (first prompt only) ──
      // Inference understands intent — it's the PRIMARY source for session names
      let inferenceNameStored = false;
      if (isFirstPrompt && r.session_name) {
        if (/[*`<>{}[\]]/.test(r.session_name)) {
          console.error('[PromptProcessing] Rejected session name with artifacts');
        } else {
          const nameWords = r.session_name.trim().split(/\s+/).slice(0, 5);
          const label = nameWords.map(w => titleCase(w)).join(' ');
          const hasProfanity = nameWords.some(w => PROFANITY_WORDS.has(w.toLowerCase()));
          // No per-word length floor: single-char words are legitimate in real
          // names ("Command K Palette", "Add A Record") — a ≥2-char rule here
          // silently discarded valid inference names.
          // Shape-only validation here — the strict verb-whitelist validator
          // is for the word-scraping fallback, not for the model.
          // public issue #1718, @xmasyx
          if (label && !hasProfanity && isValidInferredSessionName(label)) {
            // The tab label is the name fitted to the label width (resolveLabel);
            // the namer no longer authors one.
            storeName(sessionId, label, 'inference-haiku', r.tab_label);
            inferenceNameStored = true;
          } else if (label) {
            console.error(`[PromptProcessing] Rejected invalid session name: "${label}"`);
          }
        }
      }
      // If inference didn't produce a name, fall back to deterministic
      if (isFirstPrompt && !inferenceNameStored && pendingFallbackName) {
        storeName(sessionId, pendingFallbackName, 'deterministic-fallback');
      }
      // Stamp AFTER the store: the tab-setter composes its `LABEL | activity`
      // prefix from the stored label at stamp time. Stamping first (pre-2026-09-11)
      // froze the floor-name slice on the tab while the status line showed the
      // model's name — the "tab and statusline don't match" bug.
      stampWorkingTab(finalTitle);

      // ── Voice announcement (desktop channel only) ──
      // Remote channels (iMessage, Siri) do not surface the tab-title
      // announcement audibly — it would leak desktop voice for a
      // remote-originated turn. Tab title is set regardless above.
      const voiceContent = finalTitle && isValidWorkingTitle(finalTitle) ? finalTitle : null;
      if (voiceContent) {
        if (isDesktopChannel()) {
          const identity = getIdentity();
          try {
            await fetch(`${PULSE_BASE}/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: voiceContent.replace(/\.$/, ''),
                voice_id: identity.mainDAVoiceID,
                voice_enabled: true,
              }),
              signal: AbortSignal.timeout(5000),
            });
          } catch {}
        } else {
          const channel = getNotificationChannel();
          console.error(`[PromptProcessing] Voice OFF (remote channel: ${channel})`);
          logSkippedVoice({ hookLabel: 'PromptProcessing', message: voiceContent, sessionId });
        }
      }


      appendPromptProcessingTelemetry({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        prompt_excerpt: cleanPrompt.slice(0, 120),
        tab_title: r.tab_title ?? null,
        session_name: isFirstPrompt ? (r.session_name ?? null) : null,
        tab_label: isFirstPrompt ? (r.tab_label ?? null) : null,
        source: 'inference',
        latency_ms: Date.now() - inferenceStart,
      });

    } else {
      console.error(`[PromptProcessing] Inference failed: ${result.error}`);
      if (isFirstPrompt && pendingFallbackName) {
        storeName(sessionId, pendingFallbackName, 'deterministic-fallback');
      }
      const fallbackTitle = deterministicTitle && isValidWorkingTitle(deterministicTitle) ? deterministicTitle : getWorkingFallback();
      stampWorkingTab(fallbackTitle);
      appendPromptProcessingTelemetry({
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        prompt_excerpt: cleanPrompt.slice(0, 120),
        source: 'inference-failed',
        error: String(result.error ?? 'unknown').slice(0, 80),
        latency_ms: Date.now() - inferenceStart,
      });
    }
  } catch (err) {
    console.error(`[PromptProcessing] Inference error: ${err}`);
    if (isFirstPrompt && pendingFallbackName) {
      storeName(sessionId, pendingFallbackName, 'deterministic-fallback');
    }
    const fallbackTitle = deterministicTitle && isValidWorkingTitle(deterministicTitle) ? deterministicTitle : getWorkingFallback();
    stampWorkingTab(fallbackTitle);
    appendPromptProcessingTelemetry({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      prompt_excerpt: cleanPrompt.slice(0, 120),
      source: 'inference-error',
      error: String(err).slice(0, 80),
      latency_ms: Date.now() - inferenceStart,
    });
  }

  // ── Last-resort naming backstop (first prompt only) ──
  // Every path above can reject: inference name fails validation, fallback is
  // null. This block scrapes top content words off the prompt as a final
  // attempt — but it must clear the same validator every other stored name
  // clears. It used to bypass it, which made the stored name a raw prompt
  // slice; NOISE_WORDS is English-only, so on a non-English prompt the
  // "content words" are the articles and prepositions and the fragment
  // becomes that session's statusline label. An unnamed session
  // (naming retries on the next prompt) beats a name we can't vouch for.
  // public issue #1774, @xmasyx
  // Normally plan() already laid the floor; this only fires when the floor
  // was rejected there and nothing since produced a name.
  if (isFirstPrompt && !readSessionNames()[sessionId]) {
    const stored = storeFloorName(sessionId, pendingFallbackName, sanitizedPrompt);
    appendPromptProcessingTelemetry({
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      prompt_excerpt: cleanPrompt.slice(0, 120),
      session_name: stored,
      source: stored ? 'last-resort-name' : 'last-resort-rejected',
      latency_ms: 0,
    });
  }
}

async function main() {
  try {
    console.error('[PromptProcessing] Hook started');
    const input = await readStdinWithTimeout();
    const data: HookInput = JSON.parse(input);
    // Herdr agents row: a new turn began, so the last turn's open count no longer stands.
    // Before the plugin early-exit below, which covers naming and nothing about herdr.
    try { reportHerdrTurnStart(); } catch (err) { console.error('[PromptProcessing] herdr turn-start failed:', err); }
    // Armed LifeOSHooks session: plan and finish run through HookBridge and the
    // model call is in-process; a second run here would name the session twice.
    if (hookCovers(data.session_id ?? '', 'prompt-context')) process.exit(0);
    const p = await plan(data);
    if (!p) process.exit(0);
    const result = await inference({
      systemPrompt: p.request.system,
      userPrompt: p.request.prompt,
      expectJson: true,
      level: p.request.level,
    });
    await finish(p.continuation, result);
    process.exit(0);
  } catch (err) {
    console.error(`[PromptProcessing] Fatal error: ${err}`);
    process.exit(0);
  }
}

// Direct execution only: the harness runs this file as a script. Guarding lets
// PromptProcessing.test.ts import the pure naming helpers without firing a turn.
if (import.meta.main) main();
