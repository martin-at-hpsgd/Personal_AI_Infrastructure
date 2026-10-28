/**
 * @version 1.0.0
 * Reactions.ts — how the next human prompt in a session reacted to the turn before it.
 *
 * Every field is a count, a flag or an enumerated label read from the two prompts at build time; the
 * text itself is never returned, so nothing derived from here can carry prompt text into the index.
 *
 *   frustration   frustrationRead(next).fires, the capture hook's own decision (ERRATA/Signals.ts)
 *   correction    correctionSignal(next): "signals" (Signals.ts tables) or "reformulation" ("no, I meant …")
 *   approval      the next prompt is a bare go-ahead: y, c, si, do it, ship it, continue …
 *   praise        a praise phrase or word with no negative signal and no frustration
 *   reask_jaccard word-set Jaccard of next vs own, null when either has under four words (TurnOutcomes rule)
 */
import { NEGATIVE_SIGNAL, POSITIVE_PHRASES, POSITIVE_PRAISE_WORDS, frustrationRead, normalize } from "../ERRATA/Signals";
import { correctionSignal } from "../TOOLS/TurnOutcomes";

export interface Reaction {
  frustration: 0 | 1; frustration_score: number; correction: "signals" | "reformulation" | null;
  approval: 0 | 1; praise: 0 | 1; reask_jaccard: number | null; next_chars: number;
}

/** Bare go-ahead words (Vocabulary: y, c, si; plus the plain phrases). Slash forms included. */
export const APPROVAL = /^\/?(y|yes|yep|yeah|yup|c|si|ok|okay|k|go|go ahead|do it|ship it|continue|proceed|sounds good|approved|lgtm)[\s.!]*$/i;

/** Same tokenizer as TurnOutcomes.classifyOutcome (not exported there): lowercase, letters and digits, words over two characters. */
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));
}

export function jaccard(a: string, b: string): number | null {
  const x = words(a), y = words(b);
  if (x.size < 4 || y.size < 4) return null;
  const inter = [...x].filter((w) => y.has(w)).length;
  return Math.round((inter / new Set([...x, ...y]).size) * 1000) / 1000;
}

export function readReaction(own: string | null, next: string): Reaction {
  const f = frustrationRead(next);
  const norm = normalize(next);
  const praiseWord = [...words(norm)].some((w) => POSITIVE_PRAISE_WORDS.has(w));
  const praisePhrase = [...POSITIVE_PHRASES].some((p) => norm.replace(/'/g, "").includes(p));
  return {
    frustration: f.fires ? 1 : 0,
    frustration_score: f.score,
    correction: correctionSignal(next),
    approval: APPROVAL.test(next.trim()) ? 1 : 0,
    praise: (praiseWord || praisePhrase) && !NEGATIVE_SIGNAL.test(norm) && !f.fires ? 1 : 0,
    reask_jaccard: own === null ? null : jaccard(next, own),
    next_chars: next.length,
  };
}
