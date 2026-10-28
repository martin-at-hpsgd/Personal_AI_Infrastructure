#!/usr/bin/env bun
// release-allow: profanity (detector vocabulary: frustration and praise signals match these words on purpose)
// Normalize env path vars Claude Code may inject unexpanded — literal $HOME/${HOME}
// in LIFEOS_DIR/LIFEOS_CONFIG_DIR/PROJECTS_DIR resolves to a shadow dir (#1404 / PR #1451, author jbmml).
for (const __k of ["LIFEOS_DIR", "LIFEOS_CONFIG_DIR", "PROJECTS_DIR"]) {
  const __v = process.env[__k];
  if (__v && /^\$\{?HOME\}?(\/|$)/.test(__v)) process.env[__k] = __v.replace(/^\$\{?HOME\}?/, process.env.HOME ?? "~");
}

/**
 * @version 1.7.8
 * SatisfactionCapture.hook.ts - Implicit & Explicit Satisfaction Rating
 *
 * PURPOSE:
 * Standalone hook that captures user satisfaction with AI responses.
 * Handles both explicit ratings (bare numbers) and explicit corrections.
 *
 * 1.7.0 (2026-09-17, Errata): the praise/correction dictionaries moved to
 * LIFEOS/ERRATA/Signals.ts (one classifier for the hook and the ledger). Low
 * ratings, corrections, and a new frustration leg each append one erratum to
 * LIFEOS/USER/ERRATA via LIFEOS/ERRATA/Capture.ts. Deterministic, fail-open.
 *
 * TRIGGER: UserPromptSubmit
 *
 * KEY BEHAVIOR:
 * - Explicit rating (bare "8") → capture directly
 * - Positive praise ("great job") → fast-path rating 8
 * - Explicit correction ("no, that's wrong") → capture a FAILURES incident
 *   whose summary IS the verbatim complaint (deterministic, no inference)
 * - System text / very short / neutral → skip
 *
 * 1.5.0 (2026-08-17, improvement-pass NP6 adoption — a review of recent
 * captures found many defective): three fixes.
 *   (a) TURN-ANCHORING: captures now read the complained-about response from
 *       THIS session's transcript (last text-bearing assistant message), not
 *       the global last-response.txt cache, which concurrent sessions
 *       overwrite — that cache is how a complaint in session A captured an
 *       idle-notification body from session B.
 *   (b) FALSE-POSITIVE GUARDS: positive-context prompts ("Fucking great job…
 *       is that right?", "No, those are good") no longer register as
 *       corrections; the bare profanity and "No," legs now also require a
 *       negative signal. Praise wrapped in intensifiers/profanity ("great
 *       fucking job") now reaches the praise fast-path instead of the void.
 *   (c) HONEST RATING FIELD: correction captures no longer stamp a fabricated
 *       rating:3 — FailureCapture writes capture_source: correction and a null
 *       rating (the numeric 3 remains only the internal severity gate value).
 *
 * 1.4.0: Added the standing-directive leg ("from now on", "in the future",
 * "always/never do X", "rule:") → one record in the Upgrades store
 * (LIFEOS/MEMORY/UPGRADES/), and corrections now ALSO write an upgrade record
 * alongside the FAILURES incident. Deterministic, fail-open, no LLM.
 *
 * 1.3.16: Added the deterministic explicit-correction leg. Per-turn implicit-
 * sentiment inference was removed in 7.0.0 (correct — noisy and costly), which
 * nearly eliminated complaint capture: complaints without a numeric rating stopped
 * reaching the FAILURES corpus (the nightly improvement deriver's input). This
 * leg restores mechanism-bearing complaint capture WITHOUT any per-turn LLM call:
 * precision-first phrase matching only, verbatim complaint as the summary.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getDAName, getIdentity, getPrincipal, getPrincipalName } from './lib/identity';
import { getLearningCategory } from './lib/learning-utils';
import { getPSTComponents, getTimezoneDisplay } from './lib/time';
import { captureFailure } from '../LIFEOS/TOOLS/FailureCapture';
import { hookCovers } from './lib/function-hooks';
import { readTranscriptTail } from './lib/transcript-tail';
import { addUpgrade } from '../LIFEOS/TOOLS/Upgrades';
import { isMachineText } from '../LIFEOS/ERRATA/Store';
import { readTextTurn, textRequest } from '../LIFEOS/TOOLS/DeliveredContext';
import { addRatingPulse } from './lib/isa-utils';
import { recordHookErratum } from '../LIFEOS/ERRATA/Capture';
import {
  POSITIVE_PRAISE_WORDS, POSITIVE_PHRASES, detectExplicitCorrection, frustrationRead,
} from '../LIFEOS/ERRATA/Signals';
export { detectExplicitCorrection };
import { getLifeosDir } from "./lib/paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

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

// ── Constants ──

const BASE_DIR = getLifeosDir();
const LAST_RESPONSE_CACHE = join(BASE_DIR, 'MEMORY', 'STATE', 'last-response.txt');
const MIN_PROMPT_LENGTH = 3;

// Longest trailing comment accepted after a BARE leading digit ("8 nice", "8 - nice").
// Real rating comments are a few words; a long tail means prose that merely starts
// with a digit. Does not apply to "N/10" or word forms — those are unambiguous.
// public PR #1670, @asdf8675309
const MAX_BARE_DIGIT_COMMENT = 80;

// Sentence-starters that mean a leading number is describing work, not rating it
// (e.g. "2/10 items done", "3 of the files"). Shared by the fraction and generic parsers.
const SENTENCE_STARTERS = /^(items?|things?|steps?|files?|lines?|bugs?|issues?|errors?|times?|minutes?|hours?|days?|weeks?|months?|years?|seconds?|rows?|entries|records?|copies|copy|tabs?|windows?|total|more|less|left|remaining|others?|each|percent|%|th\b|st\b|nd\b|rd\b|of\b|in\b|at\b|to\b|the\b|a\b|an\b)/i;

// A leading digit immediately followed by a separator and another digit is a list
// the principal is enumerating, never a score: a prompt opening "1,2,3 because …" was
// once captured as an explicit rating of 1. Checked against the RAW prompt before the
// generic bare-digit parser runs.
// "/" is deliberately NOT a separator here: "10/10" and "8/10" are unambiguous
// rating syntax and must keep parsing.
const LIST_ENUMERATION = /^\s*\d{1,2}\s*[,;&]\s*\d/;

// Verb-shaped counterpart to SENTENCE_STARTERS, for the bare-digit path only.
// A leading digit followed by an imperative is a user answering a numbered
// question ("1 go", "2 re-register"), not rating the work: a rating comment
// evaluates, an answer commands. Leading punctuation is skipped so the common
// "1, yes fix properly" and "1 - go" forms are covered too.
// public PR #1889, @bnkath2o
const IMPERATIVE_STARTERS = /^[,;:\-\s]*\s*(go\b|yes\b|no\b|ok\b|okay\b|sure\b|do\b|does\b|don'?t\b|proceed\b|continue\b|approved?\b|confirm\w*\b|agreed?\b|correct\b|commit\b|push\b|run\b|fix\b|build\b|add\b|remove\b|delete\b|skip\b|defer\b|park\b|hold\b|stop\b|wait\b|turn on\b|turn off\b|enable\b|disable\b|file it\b|send it\b|ship it\b|make\b|use\b|try\b|check\b|show\b|tell\b|give\b|start\b|apply\b|revert\b|retry\b)/i;

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

// ── Cached Response ──

function getLastResponse(): string {
  try {
    if (existsSync(LAST_RESPONSE_CACHE)) return readFileSync(LAST_RESPONSE_CACHE, 'utf-8');
  } catch {}
  return '';
}

// ── Session-Anchored Response (1.5.0) ──
//
// The response a complaint refers to MUST come from the complaining session's
// own transcript. LAST_RESPONSE_CACHE is a single global file that every
// concurrent session overwrites, so under parallel sessions it holds whichever
// session spoke last — the root cause of the adjacent-turn capture bodies
// (improvement pass #3 found captures carrying another session's response).
// The global cache remains only as a last-resort fallback.

/** Minimal text extractor for transcript content blocks (text only, no tool_use). */
function transcriptTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' && c?.text ? c.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

export function getSessionLastResponse(transcriptPath: string | undefined): string {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return getLastResponse();
    // A bounded tail (ISC-18): the last reply is near the end, and the cached last response covers a miss.
    const lines = readTranscriptTail(transcriptPath);
    // Walk backwards to the last TEXT-bearing assistant message — pure tool_use
    // entries are skipped, so this lands on the final visible response.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"assistant"')) continue; // cheap pre-filter
      try {
        const e = JSON.parse(line);
        if (e?.type === 'assistant' && e?.message?.content) {
          const text = transcriptTextOf(e.message.content);
          if (text) return text;
        }
      } catch { /* skip malformed line */ }
    }
    return getLastResponse();
  } catch {
    return getLastResponse();
  }
}

// ── Word-to-Number Map (for "ten", "eight", etc.) ──

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

// ── Explicit Rating Detection ──

// Enumerated-option markers in the previous response. A bare "1" or "2" replying
// to a response that offered choices is a SELECTION, not a rating.
// public PR #2029 (part b), @kirmalyshev
const OPTION_MENU_PATTERNS: readonly RegExp[] = [
  /^\s*(?:\*\*)?\(?[1-9a-e][.)]\s/m,   // "1. ", "1) ", "(a) ", "**2. "
  /\boption\s+[1-9a-e]\b/i,            // "option 2"
  /\(\s*[a-e]\s*\)/,                   // inline "(a) ... (b) ..."
];

export function lastResponseOfferedOptions(lastResponse: string): boolean {
  if (!lastResponse) return false;
  return OPTION_MENU_PATTERNS.some(re => re.test(lastResponse));
}

// `lastResponse` (optional, default '') is fed from LAST_RESPONSE_CACHE by main —
// a per-prompt transcript read would be too heavy for a guard that only matters
// on a bare number. Every existing caller is unaffected.
export function parseExplicitRating(
  prompt: string,
  lastResponse: string = '',
): { rating: number; comment?: string } | null {
  const trimmed = prompt.trim();
  const menuOffered = lastResponseOfferedOptions(lastResponse);

  // "1,2,3 because …" is the principal listing items, not scoring the work.
  // Runs before every parser below, on the raw trimmed prompt.
  if (LIST_ENUMERATION.test(trimmed)) return null;

  // Check word-form ratings first (e.g., "ten", "Eight")
  const lowerTrimmed = trimmed.toLowerCase();
  for (const [word, num] of Object.entries(WORD_NUMBERS)) {
    if (lowerTrimmed === word || lowerTrimmed.startsWith(word + ' ') || lowerTrimmed.startsWith(word + '!')) {
      const rest = trimmed.slice(word.length).trim().replace(/^[!.,]+/, '').trim() || undefined;
      // Same three guards the digit path below carries: a spelled-out number is
      // also how ordinary sentences open ("One more thing before…"), and a
      // rating <= 3 writes a permanent FAILURES capture. (public issue #1940,
      // @bassitone — 2 of 2 explicit rating-1 rows on one install were this)
      if (rest && SENTENCE_STARTERS.test(rest)) return null;
      if (rest && rest.length > MAX_BARE_DIGIT_COMMENT) return null;
      if (rest && IMPERATIVE_STARTERS.test(rest)) return null;
      if (!rest && menuOffered) return null;   // a bare reply to an offered menu is a selection
      return { rating: num, comment: rest };
    }
  }

  // N/10 form (e.g. "10/10, thank you", "9 / 10", "8 out of 10 nice").
  // Must run BEFORE the generic parser, whose reject-on-slash guard would drop it.
  const fractionMatch = trimmed.match(/^(10|[1-9])\s*(?:\/|out\s+of)\s*10\b(.*)$/i);
  if (fractionMatch) {
    const fRating = parseInt(fractionMatch[1], 10);
    const fRest = fractionMatch[2].replace(/^[\s!.,:;-]+/, '').trim() || undefined;
    // "2/10 items" is not a rating; neither is "2/10件" — SENTENCE_STARTERS is
    // ASCII-only, so a non-ASCII lead-in reads as describing something rather
    // than commenting on a score. Tested against the RAW tail, not the stripped
    // one: adjacency is what separates the two. A CJK counter attaches with no
    // space ("2/10件"), while a comment is separated ("10/10 素晴らしい") — the
    // same adjacency rule the bare-digit guard below already applies.
    // ported from public PR #1703, @takanorinishida
    if (fRest && (SENTENCE_STARTERS.test(fRest) || /^[^\x00-\x7F]/.test(fractionMatch[2]))) return null;
    return { rating: fRating, comment: fRest };
  }

  const ratingPattern = /^(10|[1-9])(?:\s*[-:]\s*|\s+)?(.*)$/;
  const match = trimmed.match(ratingPattern);
  if (!match) return null;

  const rating = parseInt(match[1], 10);
  const rest = match[2]?.trim() || undefined;

  if (rating < 1 || rating > 10) return null;

  // ")" and "]" right after the digit mark a numbered list ("1) do this,
  // 2) do that"), not a rating. Prefer a missed rating to a false positive:
  // a miss only loses the ledger row (the prompt still falls through to the
  // correction/implicit paths below), whereas rating <= 3 writes a permanent
  // failure capture describing a complaint that never happened.
  // Not covered: whitespace before the delimiter ("1 ) item") still parses
  // as a rating — tightening that would also catch "8 . nice", so it is
  // left alone rather than widened past this one concern.
  // public PR #1670, @asdf8675309
  // That character class is ASCII-only, so non-ASCII text right after the digit
  // slips through with the same "describing something, not rating it" shape —
  // Japanese "2はあとで" ("item 2, later") is not a rating of 2.
  // ported from public PR #1703, @takanorinishida
  const afterNumber = trimmed.slice(match[1].length);
  if (afterNumber.length > 0 && /^[/.)\]\dA-Za-z]|^[^\x00-\x7F]/.test(afterNumber)) return null;

  if (rest && SENTENCE_STARTERS.test(rest)) return null;

  // A bare leading digit is the weakest rating evidence in this function — it is
  // also exactly how a numbered list item starts, and "-" is an accepted rating
  // separator, so "2 - add the header, but also back the file up first" is
  // indistinguishable from "8 - nice" by shape alone. Length separates them:
  // real rating comments are a few words. The "N/10" form above is unambiguous
  // rating syntax and is deliberately NOT capped; the word form WAS treated the
  // same way until real false positives showed that assumption was wrong — it
  // now carries the same three guards (public issue #1940, @bassitone).
  // public PR #1670, @asdf8675309
  if (rest && rest.length > MAX_BARE_DIGIT_COMMENT) return null;

  // The short-comment case #1670 could not separate by length. "1 go" and "8 nice"
  // are the same shape and both well under the cap, so the cap never sees them —
  // but they are not the same KIND of text. A rating comment evaluates the work;
  // an answer to a numbered question commands it. SENTENCE_STARTERS already draws
  // this line for nouns ("1 of the files"); this is the verb-shaped counterpart.
  //
  // Ratings <= 3 also write a permanent failure capture, so each false positive
  // records a complaint that was never made and feeds it to the learning loop.
  //
  // Deliberately one-directional, per this function's stated preference for a
  // missed rating over a false positive: "1 fix your formatting" is a real
  // complaint that this will now miss. That trade is the documented one — a miss
  // loses a ledger row, a false positive writes a permanent failure record.
  // public PR #1889, @bnkath2o
  if (rest && IMPERATIVE_STARTERS.test(rest)) return null;

  // A bare number replying to an offered menu is a selection, not a score.
  // "8 nice" after a menu is still a rating — the guard applies to bare numbers only.
  // public PR #2029 (part b), @kirmalyshev
  if (!rest && menuOffered) return null;

  return { rating, comment: rest };
}

// ── Positive praise + explicit correction tables: LIFEOS/ERRATA/Signals.ts (1.7.0) ──

// ── Standing Directive Detection ──
//
// Deterministic, precision-first — ZERO inference. "From now on X" is a system
// upgrade the moment it's said; before 1.4.0 it survived only if the model
// encoded it in-session or the periodic memory reviewer happened to extract it.
// A hit writes ONE record to the Upgrades store (LIFEOS/MEMORY/UPGRADES/,
// claim-hash deduped there) with the verbatim prompt as the claim.

// The DA's own name comes from identity: a literal here shipped one install's
// name to every install and never matched anyone else's DA. An unreadable
// identity adds no pattern; it never throws, because this hook runs every turn.
export function daNameDirectivePattern(name: string): RegExp | null {
  const escaped = name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
  return escaped ? new RegExp(`\\b${escaped} should (always|never|not)\\b`, 'i') : null;
}

function readDANameSafely(): string {
  try {
    return getDAName() ?? '';
  } catch {
    return '';
  }
}

const DA_NAME_DIRECTIVE = daNameDirectivePattern(readDANameSafely());

const DIRECTIVE_PATTERNS: RegExp[] = [
  /\bfrom now on\b/i,
  /\bin the future\b/i,
  /\bgoing forward\b/i,
  /\bnew rule\b/i,
  /^rule:/i,
  ...(DA_NAME_DIRECTIVE ? [DA_NAME_DIRECTIVE] : []),
  /\b(always|never) (do|use|include|make|add|put|run|write|call|show|keep|remember to)\b/i,
];

export function detectStandingDirective(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length < 15) return null;      // too short to carry a real rule
  if (trimmed.startsWith('/')) return null;  // slash command
  const norm = trimmed.toLowerCase().replace(/[‘’ʼ`]/g, "'");
  for (const re of DIRECTIVE_PATTERNS) {
    if (re.test(norm)) return trimmed;
  }
  return null;
}

// ── System Text Detection ──

const SYSTEM_TEXT_PATTERNS = [
  /^<task-notification>/i,
  /^<system-reminder>/i,
  /^This session is being continued from a previous conversation/i,
  /^Please continue the conversation/i,
  /^Note:.*was read before/i,
  // Agent hand-backs and peer-session messages arrive as prompts but are model output, not the
  // principal (2026-10-10: hand-backs had been filed as standing directives in Upgrades).
  /^<agent-message\b/i,
  /^<cross-session-message\b/i,
  /^Another Claude session sent a message/i,
];

export const isSystemText = (prompt: string): boolean => SYSTEM_TEXT_PATTERNS.some(re => re.test(prompt.trim()));

/**
 * The words a standing directive may be read from. A text carries the thread view or the delivered history
 * before its request, and that history matched from-now-on phrasing in old messages, so only the request counts,
 * as the one shared reader finds it (Tex ISA F19, ISC-234); other machine text (delegate briefs, skill loads)
 * never counts (2026-10-10: Relay sessions and delegate briefs had been filed as directives).
 */
export function directiveInput(prompt: string): string | null {
  const turn = readTextTurn(prompt.trimStart());
  if (turn.shape !== "bare") return turn.request.trim() || null;
  return isMachineText(turn.request) ? null : prompt;
}

// ── Rating Validity ──

/**
 * A satisfaction rating is only meaningful when the model returns an actual
 * value in the 1-10 band. Anything else (missing, null, out of range, NaN,
 * non-number) is the ABSENCE of a signal — it must not be coerced to a neutral
 * 5, which would pollute every running average (the aggregator flat-means
 * `.rating` and ignores confidence).
 */
export function isValidRating(x: unknown): boolean {
  return typeof x === 'number' && Number.isFinite(x) && x >= 1 && x <= 10;
}

// ── Low Rating Learning Capture ──

function captureLowRatingLearning(
  rating: number,
  summaryOrComment: string,
  detailedContext: string,
  source: 'explicit' | 'implicit'
): void {
  if (rating >= 5) return;
  if (!detailedContext?.trim()) return;

  const { year, month, day, hours, minutes, seconds } = getPSTComponents();
  const yearMonth = `${year}-${month}`;
  const category = getLearningCategory(detailedContext, summaryOrComment);
  const learningsDir = join(BASE_DIR, 'MEMORY', 'LEARNING', category, yearMonth);

  if (!existsSync(learningsDir)) mkdirSync(learningsDir, { recursive: true });

  const label = source === 'explicit' ? `low-rating-${rating}` : `sentiment-rating-${rating}`;
  const filename = `${year}-${month}-${day}-${hours}${minutes}${seconds}_LEARNING_${label}.md`;
  const filepath = join(learningsDir, filename);

  const tags = source === 'explicit'
    ? '[low-rating, improvement-opportunity]'
    : '[sentiment-detected, implicit-rating, improvement-opportunity]';

  const content = `---
capture_type: LEARNING
timestamp: ${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${getTimezoneDisplay()}
rating: ${rating}
source: ${source}
auto_captured: true
tags: ${tags}
---

# ${source === 'explicit' ? 'Low Rating' : 'Implicit Low Rating'} Captured: ${rating}/10

**Date:** ${year}-${month}-${day}
**Rating:** ${rating}/10
**Detection Method:** ${source === 'explicit' ? 'Explicit Rating' : 'Sentiment Analysis'}
${summaryOrComment ? `**Feedback:** ${summaryOrComment}` : ''}

---

## Context

${detailedContext || 'No context available'}

---

## Improvement Notes

This response was rated ${rating}/10 by ${getPrincipalName()}. Use this as an improvement opportunity.

---
`;

  writeFileSync(filepath, content, 'utf-8');
  console.error(`[SatisfactionCapture] Captured low ${source} rating learning`);
}

// ── Inference Prompt ──

const PRINCIPAL_NAME = getPrincipal().name;
const ASSISTANT_NAME = getIdentity().name;

// ══════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════

/** Every deterministic leg, in order. Exported so HookBridge prompt-context can run it in-process for an armed session. */
export async function run(data: HookInput): Promise<void> {
  try {
    // A text's view or delivered history is never the principal's words: every leg reads the request only.
    const raw = data.prompt || data.user_prompt || '';
    const prompt = textRequest(raw);
    const sessionId = data.session_id;

    if (!prompt || !sessionId) { return; }

    // ── SKIP: System text ──
    if (isSystemText(prompt)) {
      console.error('[SatisfactionCapture] System text, skipping');
      return;
    }

    // ── FAST PATH: Explicit rating (checked BEFORE the length skip so a bare
    // "9"/"10" — length 1-2 — is still captured; #1182). ──
    // Menu guard reads the global cache (cheap, best-effort); the response
    // preview below still comes from the session's own transcript.
    const explicitResult = parseExplicitRating(prompt, getLastResponse());

    if (!explicitResult && prompt.length < MIN_PROMPT_LENGTH) {
      console.error('[SatisfactionCapture] Prompt too short, skipping');
      return;
    }

    if (explicitResult) {
      console.error(`[SatisfactionCapture] Explicit rating: ${explicitResult.rating}`);
      const lastResponse = getSessionLastResponse(data.transcript_path);

      // 2.0.0: EVERY rating is one Errata row. The deep FAILURES capture still runs at <= 3 and its directory
      // hangs off the row as links.failure_dir, so one ledger indexes everything.
      let failureDir: string | null = null;
      if (explicitResult.rating < 5) {
        captureLowRatingLearning(explicitResult.rating, explicitResult.comment || '', lastResponse, 'explicit');
        if (explicitResult.rating <= 3) {
          failureDir = await captureFailure({
            transcriptPath: data.transcript_path,
            rating: explicitResult.rating,
            sentimentSummary: explicitResult.comment || `Explicit low rating: ${explicitResult.rating}/10`,
            detailedContext: lastResponse,
            sessionId,
          }).catch((err) => {
            console.error(`[SatisfactionCapture] Failure capture error: ${err}`);
            return null;
          });
        }
      }

      const row = recordHookErratum({
        prompt: explicitResult.comment || `Explicit rating: ${explicitResult.rating}/10`,
        sessionId,
        transcriptPath: data.transcript_path,
        kind: explicitResult.rating >= 7 ? 'praise' : 'complaint',
        rating: explicitResult.rating,
        frustration: frustrationRead(prompt).score,
        tags: ['rating'],
        ...(failureDir ? { links: { failure_dir: failureDir } } : {}),
      });
      if (row) console.error(`[SatisfactionCapture] Errata ${row.id} (rating ${explicitResult.rating})`);

      addRatingPulse(sessionId, {
        value: explicitResult.rating,
        timestamp: Date.now(),
        message: explicitResult.comment?.slice(0, 32),
      });
      return;
    }

    // ── FAST PATH: Positive praise ──
    // 1.5.0: intensifiers/profanity are stripped before the short-praise check,
    // so the principal's actual praise register ("Great fucking job.") lands as
    // a rating instead of vanishing (praise worded that way was once never captured
    // as a rating at all).
    const INTENSIFIERS = new Set(['fucking', 'fuckin', 'damn', 'goddamn', 'hella', 'so', 'very', 'really', 'absolutely', 'super', 'truly']);
    const normalizedPrompt = prompt.trim().toLowerCase().replace(/[.!?,'"]/g, '');
    const promptWords = normalizedPrompt.split(/\s+/).filter(w => !INTENSIFIERS.has(w));
    const praiseKey = promptWords.join(' ');
    if (promptWords.length <= 2) {
      if (POSITIVE_PRAISE_WORDS.has(praiseKey) || POSITIVE_PHRASES.has(praiseKey)
          || (promptWords.length === 2 && promptWords.every(w => POSITIVE_PRAISE_WORDS.has(w)))) {
        // Praise carries rating NULL: the schema's rating is "a number the human
        // actually gave", and praise gives none. Never synthesize one here.
        const row = recordHookErratum({
          prompt: prompt.trim(),
          sessionId,
          transcriptPath: data.transcript_path,
          kind: 'praise',
          rating: null,
          frustration: 0,
          tags: ['praise'],
        });
        console.error(`[SatisfactionCapture] Praise → Errata ${row ? row.id : '(failed)'}: "${prompt.trim()}"`);
        return;
      }
    }

    // ── STANDING DIRECTIVE: "from now on X" → Upgrades store (no inference) ──
    // Isolated + fail-open: any error here is swallowed and we still exit 0.
    try {
      const input = directiveInput(prompt);
      const directive = input ? detectStandingDirective(input) : null;
      if (directive) {
        // 2.0.0: the ledger is the front door. The directive lands in Errata as a
        // feature-request, then files its Upgrades record, and the row carries the
        // upgrade id — so Upgrades is downstream of Errata, not a parallel door.
        const res = addUpgrade({
          claim: directive.slice(0, 900),
          source: 'directive',
          current_state: 'Stated by the principal in-session; not yet encoded in infrastructure.',
          confidence: 0.9,
          session_id: sessionId,
          evidence: [`session:${sessionId}`],
        });
        const row = recordHookErratum({
          prompt: directive,
          sessionId,
          transcriptPath: data.transcript_path,
          kind: 'feature-request',
          rating: null,
          frustration: 0,
          tags: ['directive'],
          ...(res.created ? { links: { upgrade_id: res.id } } : {}),
        });
        console.error(`[SatisfactionCapture] Standing directive → Errata ${row ? row.id : '(failed)'} → upgrade ${res.created ? res.id : `(${res.reason})`}`);
      }
    } catch (err) {
      console.error(`[SatisfactionCapture] Directive leg error: ${err}`);
    }

    // ── EXPLICIT CORRECTION: deterministic complaint capture (no inference) ──
    // Runs only after the explicit-rating and positive-praise fast-paths have both
    // exited, so it never fires on a rating, praise, system text, or a slash command.
    // Isolated + fail-open: any error here is swallowed and we still exit 0.
    try {
      const complaint = detectExplicitCorrection(prompt);
      // 1.7.0 Errata leg: a correction OR a work-directed frustration hit (profanity +
      // negative signal + work reference) is one line in the ledger, verbatim, with the
      // session-anchored response, the ask before it, and the last tool calls.
      const fr = frustrationRead(prompt);
      // 2.0.0: the FAILURES capture runs FIRST so its directory can hang off the
      // Errata row. One ledger indexes the deep context instead of two corpora
      // accumulating the same incident side by side.
      let failureDir: string | null = null;
      if (complaint) {
        // 1.5.0: session-anchored — the complained-about response comes from THIS
        // session's transcript, never the cross-session global cache.
        const cachedResponse = getSessionLastResponse(data.transcript_path);
        if (cachedResponse) {
          console.error(`[SatisfactionCapture] Explicit correction detected → FAILURES capture`);
          failureDir = await captureFailure({
            transcriptPath: data.transcript_path,
            rating: 3, // internal severity gate value only — captureSource below keeps the record honest
            captureSource: 'correction',
            sentimentSummary: complaint,
            detailedContext: cachedResponse,
            sessionId,
          }).catch((err) => {
            console.error(`[SatisfactionCapture] Correction capture error: ${err}`);
            return null;
          });
          // Correction→upgrade dual-write removed 2026-08-06: it filled the Upgrades
          // store with raw complaint text (most of its records, none consumed by anything).
          // The 2026-07-23 "every correction triggers upgrade thinking" directive is
          // served by this FAILURES capture — /algo clusters that corpus into real
          // source=algo-run records with drafted recommendations.
        }
      }

      if (fr.fires) {
        const row = recordHookErratum({
          prompt, sessionId, transcriptPath: data.transcript_path,
          kind: fr.correction ? 'correction' : 'complaint', frustration: fr.score,
          ...(failureDir ? { links: { failure_dir: failureDir } } : {}),
        });
        if (row) console.error(`[SatisfactionCapture] Errata ${row.id} (frustration ${fr.score}${failureDir ? ', failures linked' : ''})`);
      }
    } catch (err) {
      console.error(`[SatisfactionCapture] Correction leg error: ${err}`);
    }

    // ── 7.0.0 BLE: implicit-sentiment inference REMOVED ──
    // This path spawned a `claude --print` subprocess (2s stagger + ≤15s) on essentially
    // every neutral prompt to guess a 1–10 mood number — the highest-compute, lowest-signal
    // per-turn scaffolding in the system. Explicit ratings and direct praise (the fast-paths
    // above) are the real signal and stay. Implicit sentiment, if wanted, belongs in a
    // SessionEnd batch over the transcript, not a per-turn LLM call. Nothing to do here.
    return;
  } catch (err) {
    console.error(`[SatisfactionCapture] Fatal error: ${err}`);
    return;
  }
}

async function main() {
  console.error('[SatisfactionCapture] Hook started');
  const input = await readStdinWithTimeout();
  let data: HookInput;
  try { data = JSON.parse(input); } catch { process.exit(0); }
  // Armed LifeOSHooks session: run() is called by HookBridge prompt-context instead.
  if (hookCovers(data.session_id ?? '', 'prompt-context')) process.exit(0);
  await run(data);
  process.exit(0);
}

if (import.meta.main) main();
