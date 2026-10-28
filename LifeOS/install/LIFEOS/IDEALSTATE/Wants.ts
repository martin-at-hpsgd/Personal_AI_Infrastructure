/**
 * Wants — the principal's own positive statements of what he wants, caught where he says them.
 *
 * Feeds the Ideal State AUTOMATED region (current-ideal-delta ISA, F4). Four sources, each a
 * small reader: human-typed session prompts, lifelog lines where the speaker is the wearer,
 * the published corpus, and Errata praise he filed. Extraction is two layers:
 *
 *   1. A deterministic prefilter: sentences with a first-person positive marker ("I want",
 *      "I'd love", "I prefer", "I wish", "I hope to", "my dream", "someday I", "I'd like to
 *      live/have/be"), minus what code can already refuse (isWorkRequest and friends):
 *      instructions aimed at the assistant, a pronoun object ("I want it shorter", "I want
 *      this fixed"), the assistant's output or its format ("bullets", "answers", "replies"),
 *      a work verb with near-term timing or a work object ("I want to fix the failing test
 *      first"), anything a prompt addresses to "you" or says "please" in, sentences naming a
 *      system, quoted lines, code blocks, generated TELOS regions, text echoed back from
 *      what the assistant just wrote, and the shapes refusalShape names: pleasantries to a guest
 *      or an audience, templates and example lists in published writing, filler idioms, wishes
 *      about other people or the world, process remarks inside a task, and a pick among options.
 *   2. One OpenAI-lane classification call per batch (Inference.ts, no vendor fallback) that
 *      keeps only sincere wants about his own life, purchases and things he wants to have
 *      included, names their domain, and marks retractions and contradictions of earlier wants.
 *
 * The store is append-only JSONL at <state>/ideal-state/wants.jsonl, one line per want:
 *   {id, text, said_at, source, source_ref, domain, first_seen, last_seen, superseded_by, archived}
 * A fold appends a new line with the same id that changes only first_seen, last_seen,
 * superseded_by or archived; the last line per id wins. Two narrower folds exist: a label line
 * {id, verdict, verdict_at} (labelWants) and a domain line {id, domain, domain_at} (redomainWants,
 * which moves a kept want out of "other"). source_ref is a pointer, never content.
 * Domains: mission, identity, health, money, relationships, creative, freedom, rhythms,
 * infrastructure, home, other (WANT_DOMAINS, the order the Ideal region renders them).
 * A retraction is never stored as a want: the entry it withdraws gets superseded_by set to the
 * id the retraction sentence would carry (W-<hash of its text>).
 *
 * Want text never goes to Vigil: the scan's one event carries counts only.
 *
 * Eval (ISC-31): `IdealState.ts wants eval` runs the full extractor over two labeled fixtures,
 * LIFEOS/ASSAY/fixtures/wants-extractor.cases.jsonl (the set the extractor was tuned on) and
 * wants-extractor.heldout.cases.jsonl (written fresh afterwards), and reports precision and
 * recall for each separately; it fails when either set is under 0.9 precision.
 * `IdealState.ts wants eval --labels` re-runs the extractor over the stored wants the principal
 * labeled, in place, and reports precision and recall against his keep/drop, overall and per
 * source; it passes at precision >= 0.9 and recall >= 0.85. His text stays in the store: no
 * fixture or test copies it.
 *
 * Overrides: IDEALSTATE_STATE_DIR (Store.ts), IDEALSTATE_WANTS_PROJECTS_DIR (prompt transcripts).
 *
 * @version 1.1.0
 *
 * 1.1.0: refusalShape (ISC-31), mission and identity domains, evalLabeledWants, redomainWants.
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../TOOLS/Invariant";
import { getClaudeDir } from "../TOOLS/Paths";
import { emitVigilEvent, vigilEvent } from "../TOOLS/lib/VigilOptional";
import { appendState, readJson, readLines, statePath, updateState, withLocks } from "./Store";

export const WANTS_FILE = "wants.jsonl";
const SCAN_STATE = "wants-scan.json";
export const WANT_SOURCES = ["prompt", "lifelog", "corpus", "errata-praise"] as const;
export type WantSource = (typeof WANT_SOURCES)[number];
/** Life domains, in the order the Ideal region renders them: mission (what he wants to build or change in the world) and identity (who he wants to be) first. */
export const WANT_DOMAINS = ["mission", "identity", "health", "money", "relationships", "creative", "freedom", "rhythms", "infrastructure", "home", "other"] as const;
export type WantDomain = (typeof WANT_DOMAINS)[number];

/** The principal's own label on a stored want: keep it, or drop it. null means he has not looked yet. */
export const WANT_VERDICTS = ["keep", "drop"] as const;
export type WantVerdict = (typeof WANT_VERDICTS)[number];

export type Want = {
  id: string; text: string; said_at: string; source: WantSource; source_ref: string; domain: WantDomain;
  first_seen: string; last_seen: string; superseded_by: string | null; archived: boolean;
  /** Absent in old lines and in a want never labeled (loadWants returns null for it). Set only by `labelWants`. */
  verdict?: WantVerdict | null; verdict_at?: string | null;
  /** Set only by `redomainWants`, on the fold line that moved the want out of "other". */
  domain_at?: string | null;
};

/** One line as a reader found it, before extraction. `context` holds recent assistant text the line may echo. */
export type RawLine = { text: string; said_at: string; source: WantSource; source_ref: string; context?: string[] };
export type ReadResult = { lines: RawLine[]; error: string | null };
export type Reader = () => Promise<ReadResult>;
export type Readers = Partial<Record<WantSource, Reader>>;

export type Verdict = "want" | "retraction" | "reject";
export type Classification = { i: number; verdict: Verdict; domain?: string; supersedes?: string[] };
export type Classify = (items: RawLine[], existing: Want[]) => Promise<Classification[]>;

const DAY = 86_400_000;
export const ARCHIVE_AFTER_DAYS = 730;
export const DEFAULT_LOOKBACK_DAYS = 30;
export const BATCH_SIZE = 40;
export const MAX_EXISTING_IN_PROMPT = 80;
export const FOLD_SIMILARITY = 0.8;
const MAX_SENTENCE = 300;

// ── normalizing and ids ────────────────────────────────────────────────────

const straighten = (s: string): string => s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
export function normalizeWant(text: string): string {
  return straighten(text).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/'/g, "").replace(/\s+/g, " ").trim();
}
export const wantId = (text: string): string => `W-${createHash("sha256").update(normalizeWant(text)).digest("hex").slice(0, 8)}`;

const FOLD_STOP = new Set(["i", "a", "an", "the", "to", "and", "of", "in", "on", "my", "me", "is", "it", "really", "just", "so", "very", "also", "still", "someday", "one", "day"]);
const tokens = (s: string): Set<string> => new Set(normalizeWant(s).split(" ").filter((w) => w.length > 1 && !FOLD_STOP.has(w)));
/** Jaccard overlap of significant words; 1 means the same wording. */
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (x.size < 2 || y.size < 2) return normalizeWant(a) === normalizeWant(b) ? 1 : 0;
  let hit = 0; for (const w of x) if (y.has(w)) hit++;
  return hit / (x.size + y.size - hit);
}

const iso = (v: string | number | Date): string | null => { const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// ── the deterministic layer ────────────────────────────────────────────────

/** First-person positive markers (and the retraction forms, so a reversal reaches the classifier). */
export const WANT_MARKER = new RegExp([
  String.raw`\bI\s+(?:really\s+|still\s+|also\s+|just\s+|truly\s+)?(?:want|wanna)\b`,
  String.raw`\bI(?:'d|\s+would)\s+(?:really\s+|absolutely\s+)?love\b`,
  String.raw`\bI\s+(?:really\s+|strongly\s+)?prefer\b`,
  String.raw`\bI\s+(?:really\s+)?wish\b`,
  String.raw`\bI\s+(?:really\s+)?hope\s+to\b`,
  String.raw`\bmy\s+dream\b`,
  String.raw`\b(?:someday|one\s+day)\s+I\b`,
  String.raw`\bI(?:'d|\s+would)\s+(?:really\s+)?like\s+to\s+(?:live|have|be|own|spend|travel|build|write|see|learn|raise|retire|work|make|visit|move|grow|keep)\b`,
  String.raw`\bI\s+no\s+longer\s+want\b`,
  String.raw`\bI\s+(?:do\s+not|don't)\s+want\b[^.!?\n]*\b(?:anymore|any\s+more)\b`,
  String.raw`\bI(?:'ve|\s+have)\s+changed\s+my\s+mind\b`,
].join("|"), "i");

/** "I want you to…", "I want bullets": a request to the assistant about its work, never a life want (ISC-73). */
const ASSISTANT_DIRECTED = new RegExp([
  String.raw`\bI\s+(?:really\s+|just\s+)?(?:want|need|wanna)\s+(?:you|ya|u)\b`,
  String.raw`\bI(?:'d|\s+would)\s+(?:really\s+)?(?:like|love|prefer)\s+(?:you|ya|u|it\s+if\s+you)\b`,
  String.raw`\bI\s+prefer\s+(?:you|ya|u)\b`,
  String.raw`\bI\s+(?:really\s+|just\s+)?(?:want|need|prefer|'d\s+like|would\s+like)\s+(?:the|this|that|your|a|an|some|more|fewer|shorter|longer)?\s*(?:assistant|agent|model|output|answer|response|reply|summary|summaries|report|bullets?|list|table|diff|code|tests?|build|commit|pr|deploy|page|dashboard|draft|format|prose|paragraphs?|headings?|closer|statusline|hook|skill|workflow|isa|criteria|script|function|file|repo|branch)\b`,
].join("|"), "i");

/** The verbs that open a want, as the clause after them is matched: "I want", "I'd love", "I prefer", "I need", "I'd like". */
const WANT_VERB = String.raw`\bI(?:'d|\s+would)?\s+(?:really\s+|just\s+|still\s+|also\s+|absolutely\s+|strongly\s+)?(?:want|wanna|need|prefer|love|like)`;

/** "I want it shorter", "I want this fixed", "I want these gone": a pronoun object points at something on screen, never at his life (ISC-73). */
const DEICTIC_OBJECT = new RegExp([
  // it, as the want's object, always: "I want it shorter", "I'd love it if".
  String.raw`${WANT_VERB}\s+it\b`,
  // this/that/these/those standing alone, or followed by a state, a timing, a preposition or a participle, never by a noun ("that house by the lake").
  String.raw`${WANT_VERB}\s+(?:this|that|these|those)\s*(?:$|[.,!?;:]|\b(?:\w+ed|done|gone|fixed|shorter|longer|working|green|live|back|now|today|tonight|first|instead|again|too|asap|to|in|on|out|up|off|before|by|for|from|right|please|here|there)\b)`,
  // "I want to deploy this tonight", "I'd like to see it": a verb whose object is a pronoun, ending the clause or followed by a timing.
  String.raw`${WANT_VERB}\s+to\s+\w+\s+(?:it|this|these|those)\s*(?:$|[.,!?;:]|\b(?:now|today|tonight|first|asap|again|right|before|by|this|in|working|running|done|fixed|back|up|out)\b)`,
].join("|"), "i");

/** Words for the assistant's output and its format: a want about how an answer looks is a request to the assistant (ISC-73, ISC-79). */
const OUTPUT_OBJECT = new RegExp([
  String.raw`${WANT_VERB}\b[^.!?\n]{0,60}\b(?:answers?|bullets?|bullet\s+points|replies|reply|responses?|format(?:ting|ted)?|verdicts?|summar(?:y|ies)|headings?|headers?|markdown|tl;?dr|emojis?|em-?dash(?:es)?|wording|word\s+count)\b`,
  // shorter or longer with no noun after it: "I want it shorter", "I'd like the replies a lot shorter". "Shorter workdays" is a life want.
  String.raw`${WANT_VERB}\b[^.!?\n]{0,40}\b(?:shorter|longer|terser|tighter|briefer)\s*(?:$|[.,!?;:]|\b(?:please|next|than|this|that|now|again|overall)\b)`,
].join("|"), "i");

/** A work verb with near-term timing, or with a work object: "I want to fix the failing test first", "I want to ship the release today" (ISC-73). */
const WORK_VERB = String.raw`(?:deploy|fix|ship|test|build|commit|merge|run|debug|refactor|push|release|patch|land|rebase|revert|review|rerun|redeploy|wire|hook\s+up|clean\s+up)`;
const NEAR_TERM = String.raw`(?:now|right\s+now|right\s+away|today|tonight|tomorrow|first|asap|this\s+(?:morning|afternoon|evening|week|weekend|sprint)|before\s+(?:lunch|dinner|bed|the\s+call|the\s+meeting|the\s+release|the\s+demo|the\s+weekend|eod|end\s+of\s+day)|by\s+(?:\d|eod|end\s+of\s+day|noon|tonight|tomorrow|friday|monday|tuesday|wednesday|thursday))`;
const WORK_OBJECT = String.raw`(?:bugs?|tests?|builds?|branch(?:es)?|prs?|pull\s+requests?|releases?|deploys?|deployments?|hooks?|code|repo|commits?|migrations?|parser|endpoint|scripts?|functions?|pipeline|ci|lint(?:er)?|typecheck|regression|crash(?:es)?|errors?|the\s+failing)`;
const WORK_TASK = new RegExp([
  String.raw`${WANT_VERB}\s+to\s+(?:\w+\s+)?${WORK_VERB}\b[^.!?\n]{0,60}\b${NEAR_TERM}\b`,
  String.raw`${WANT_VERB}\s+to\s+(?:\w+\s+)?${WORK_VERB}\s+(?:the\s+|this\s+|that\s+|my\s+|our\s+|a\s+|an\s+)?(?:\w+\s+)?${WORK_OBJECT}\b`,
].join("|"), "i");

/** In a prompt the reader is the assistant: a sentence that speaks to "you" or says "please" is a request, whatever its marker (ISC-73). */
const ADDRESSED = /\b(?:you|your|you're|you'd|you'll|yourself|u|ya|please|pls|can\s+we|could\s+we|let's)\b/i;
const SPOKEN_TO_ASSISTANT: ReadonlySet<WantSource> = new Set<WantSource>(["prompt", "errata-praise"]);
/** "you know" and "y'know" are filler, not an address. */
const FILLER_YOU = /\b(?:you\s+know|y'know|thank\s+you|if\s+you\s+ask\s+me)\b/gi;

/** True when code alone can tell the sentence is a request about the assistant's work rather than a want for his life. */
export function isWorkRequest(sentence: string, source: WantSource): boolean {
  const s = straighten(sentence);
  if (ASSISTANT_DIRECTED.test(s) || DEICTIC_OBJECT.test(s) || OUTPUT_OBJECT.test(s) || WORK_TASK.test(s)) return true;
  return SPOKEN_TO_ASSISTANT.has(source) && ADDRESSED.test(s.replace(FILLER_YOU, " "));
}

/** A sentence about a LifeOS system or its parts is a feature request or praise of a system, never a life want (ISC-79). */
const NAMES_SYSTEM = /\b(?:lifeos|pulse|vigil|errata|telos|assay|claude|codex|chatgpt|the\s+(?:assistant|agent|bot|dashboard|app|tool|skill|hook|workflow|system|statusline|page|site|cli|model|pipeline|digest))\b/i;

// ── shapes that read as a want and are not one (ISC-31) ────────────────────
//
// The principal's labels on the first real backfill named these: pleasantries to a guest or an
// audience, templates and example lists inside an essay, filler idioms, wishes about other people
// or the world, process remarks inside a task, and a pick among options on screen. Each rule
// names a shape, never a past sentence. Purchases and things he wants to have are wants.

export type RefusalShape = "pleasantry" | "template" | "filler" | "world-wish" | "process" | "pick";

/** The verbs that open a want, wishes and hopes included: "I want", "I'd love", "I hope", "I wish". */
const WANT_LEAD = String.raw`\bI(?:'d|\s+would)?\s+(?:really\s+|just\s+|still\s+|also\s+|absolutely\s+|strongly\s+|truly\s+|kind\s+of\s+)?(?:want|wanna|need|prefer|love|like|hope|wish)`;
/** A crowd addressed as "you": a reader, a listener, a room. */
const AUDIENCE_YOU = String.raw`(?:(?:any|all|each|both|some|every\s+one|many|most)\s+of\s+you|you\s+all|you\s+guys|you\s+folks|y'all|everyone\s+(?:here|listening|watching|reading))`;
/** Verbs of meeting and working with someone, as in a sign-off to a guest. */
const SOCIAL_VERB = String.raw`(?:see|meet|catch|work\s+with|collaborate\s+with|partner\s+with|talk\s+(?:to|with)|chat\s+with|speak\s+with|hear\s+from|have|host|invite|welcome|thank|connect\s+with|catch\s+up\s+with|hang\s+out\s+with|grab\s+(?:a\s+)?(?:coffee|drink|beer|lunch|dinner)\s+with|get\s+(?:together|coffee|lunch|dinner)\s+with|reach\s+out\s+to)`;

const PLEASANTRY_ANY = new RegExp(String.raw`${WANT_LEAD}\b[^.!?\n]{0,60}\b${AUDIENCE_YOU}\b`, "i");
/** In published writing "you" is the reader, a guest or an audience, never someone close to him. */
const PLEASANTRY_PUBLISHED = new RegExp(String.raw`${WANT_LEAD}\s+to\s+(?:\w+\s+){0,2}?${SOCIAL_VERB}\s+(?:you|ya)\b`, "i");

/** A list item: an essay's sample goals, not his own. Published writing only; a typed or spoken list is left to the classifier. */
const LIST_ITEM = /^\s*(?:[-*•–]|\d{1,2}[.)])\s+/;
const BLANK = /_{3,}/;
/** "I want to earn that kind of salary", "this much land": a placeholder for an example, unreadable alone. Published writing only. */
const PLACEHOLDER = new RegExp(String.raw`${WANT_LEAD}\b[^.!?\n]{0,60}\b(?:(?:this|that|some|such\s+a)\s+(?:type|kind|sort|amount|level|number|size)\s+of|(?:this|that)\s+(?:much|many))\b`, "i");

const FILLER = new RegExp([
  String.raw`${WANT_LEAD}\s+to\s+keep\s+(?:it|this|things)\s+(?:real|simple|short|brief|honest|light|quick|tight)\b`,
  String.raw`${WANT_LEAD}\s+to\s+be\s+(?:really\s+|totally\s+|very\s+|super\s+|completely\s+)?(?:honest|clear|frank|upfront|transparent|fair|straight)\s*(?:$|[.,!?;:—-]|\b(?:with\s+(?:you|y'all|everyone|everybody|folks)|here|about\s+(?:this|that|it)|that|on\s+(?:this|that))\b)`,
  // "I want to (um) be kind of surprised by the ending".
  String.raw`${WANT_LEAD}\s+to\s+(?:\w+\s+)?be\s+(?:\w+\s+){0,2}?surprised\b`,
  // The talk or the text describing itself.
  String.raw`${WANT_LEAD}\s+to\s+(?:(?:quickly|just|briefly|also|now|first)\s+)?(?:point\s+out|mention|stress|emphasi[sz]e|clarify|reiterate|highlight|note\s+that|talk\s+(?:about|through)|speak\s+about|walk\s+(?:you\s+)?through|dig\s+into|touch\s+on|go\s+over|wrap\s+(?:up|this|things)|read\s+you|show\s+you)\b`,
  // "a thread which I'd love to dig more into.": a topic just mentioned, with the preposition left stranded.
  String.raw`\b(?:which|that|what)\s+I(?:'d|\s+would)?\s+(?:\w+\s+)?(?:want|wanna|hope|love|like)\s+to\s+(?:write|talk|say|speak|think|dig|get|read)\s+(?:\w+\s+){0,3}?(?:about|into|on)\s*(?:$|[.,!?;:])`,
  String.raw`${WANT_LEAD}\s+to\s+(?:hear|know|see|find\s+out)\s+what\s+(?:they|you|people|others|everyone|folks|he|she|the\s+\w+)\s+(?:think|thinks|say|says|have\s+to\s+say|has\s+to\s+say|make\s+of)\b`,
].join("|"), "i");

/** A wish about other people, society or the world. "I wish I…" and "I wish we lived…" stay; "I wish we could all…" does not. */
const WORLD_WISH = new RegExp(String.raw`\bI\s+(?:really\s+|just\s+|sometimes\s+|kind\s+of\s+)?wish(?:ed)?\s+(?:that\s+)?(?:we\s+(?:\w+\s+)?all\b|we\s+as\s+|it\s+(?:were|was|would|could|had)\b|there\s+(?:were|was|is|are|would\s+be)\b|(?:people|everyone|everybody|the\s+world|society|humanity|humans|the\s+industry|the\s+government|the\s+media|companies|more\s+people|most\s+people|someone|somebody|others|they|you|he|she|folks)\b)`, "i");

/** Care taken inside a task: "I want to be careful around the old pipes". */
const PROCESS = new RegExp(String.raw`${WANT_LEAD}\s+to\s+(?:be\s+(?:very\s+|really\s+|extra\s+|super\s+)?(?:careful|cautious|mindful|wary)\s+(?:of|with|about|around|not|that|when|here|so)\b|double[-\s]check\b)`, "i");

/** "I want that one", "I want the smaller one": a pick among options on screen, never named. */
const PICK = new RegExp(String.raw`${WANT_LEAD}\s+(?:this|that|the(?:\s+[\w-]+){0,3})\s+ones?\b(?!\s+(?:of|day|thing|place|person|life|more|another|true))`, "i");

/** The shape code can name in a sentence that reads as a want and is not one, or null. */
export function refusalShape(sentence: string, source: WantSource): RefusalShape | null {
  const s = straighten(sentence);
  const published = source === "corpus";
  if (BLANK.test(s) || (published && (LIST_ITEM.test(s) || PLACEHOLDER.test(s)))) return "template";
  if (PLEASANTRY_ANY.test(s) || (published && PLEASANTRY_PUBLISHED.test(s))) return "pleasantry";
  if (WORLD_WISH.test(s)) return "world-wish";
  if (PROCESS.test(s)) return "process";
  if (FILLER.test(s)) return "filler";
  if (PICK.test(s)) return "pick";
  return null;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const REGION_RE = /<!--\s*AUTOMATED:BEGIN[\s\S]*?(?:AUTOMATED:END[^>]*-->|$)/g;
const TAG_BLOCK_RE = /<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Drops text no reader should treat as the principal's own words: code, generated regions, tagged blocks, quoted lines. */
export function cleanText(text: string): string {
  return straighten(text).replace(FENCE_RE, "\n").replace(REGION_RE, "\n").replace(TAG_BLOCK_RE, "\n").replace(COMMENT_RE, "\n")
    .split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
}

/** Sentences of a cleaned text; a run-on longer than the cap is cut to the clause around its marker, still verbatim. */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  // Per line, so a numbered list item ("2. I want…") keeps its number: the split never follows a leading "N.".
  for (const raw of text.split(/\n+/).flatMap((l) => l.split(/(?<=[.!?])(?<!^\s*\d{1,2}\.)\s+/))) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length <= MAX_SENTENCE) { out.push(s); continue; }
    const m = WANT_MARKER.exec(s);
    if (!m) continue;
    const back = s.lastIndexOf(",", m.index), from = back >= 0 && m.index - back <= 80 ? back + 1 : m.index;
    const rest = s.slice(from);
    const stop = rest.slice(m.index - from).search(/[,;:]\s/);
    let piece = stop > 0 ? rest.slice(0, m.index - from + stop) : rest;
    if (piece.length > MAX_SENTENCE) piece = piece.slice(0, piece.lastIndexOf(" ", MAX_SENTENCE));
    out.push(piece.trim());
  }
  return out;
}

/** True when the clause from the marker on (five words or more) already appears in recent assistant text. */
export function isEcho(sentence: string, context: string[] = []): boolean {
  if (!context.length) return false;
  const m = WANT_MARKER.exec(straighten(sentence));
  const clause = normalizeWant(m ? straighten(sentence).slice(m.index) : sentence);
  if (clause.split(" ").length < 5) return false;
  return context.some((c) => normalizeWant(c).includes(clause));
}

/** Sentence-level candidates: a marker, and nothing code can already refuse. Each keeps its line's date, source and pointer. */
export function prefilter(lines: RawLine[]): RawLine[] {
  const out: RawLine[] = [];
  for (const l of lines) {
    const said = iso(l.said_at);
    if (!said) continue;
    for (const s of sentencesOf(cleanText(l.text))) {
      if (!WANT_MARKER.test(s) || isWorkRequest(s, l.source) || NAMES_SYSTEM.test(s) || refusalShape(s, l.source) || isEcho(s, l.context)) continue;
      out.push({ text: s, said_at: said, source: l.source, source_ref: l.source_ref });
    }
  }
  return out;
}

// ── the OpenAI-lane classifier ─────────────────────────────────────────────

export const CLASSIFIER_SYSTEM = `You sort sentences one person said or wrote: prompts they typed to an assistant, their own lifelog speech, and their published writing, which includes podcast and video transcripts. Keep only the person's own positive wants for their life: what they want, prefer, hope for, aspire to or want to have, for themselves and the people close to them.

For each item return a verdict:
- "want": the speaker, sincerely and in their own voice, states a positive want, preference or aspiration about their own life or future. Examples: "I want to live somewhere I can walk to the ocean", "I'd love to write a novel someday", "I prefer mornings with no meetings", "My dream is a small farm upstate". A purchase or a thing they want to own or have counts: "I want a really good espresso grinder", "I want a cast iron skillet for the cabin", "I'd like to spend a week in Lisbon in May". So does what they want to build or change in the world ("I want to help build tools that make people more creative") and who they want to be ("I hope to stay curious my whole life").
- "retraction": the speaker withdraws or reverses a want of their own ("I no longer want a house in the city", "I've changed my mind about moving abroad").
- "reject": everything else, including:
  - instructions or requests aimed at an assistant, agent or tool, even when phrased as "I want" ("I want you to fix the hook", "I want bullets", "I'd like the summary shorter", "I want this deployed tonight");
  - wants about software, code, a build, a page, a dashboard, a system or its output, and praise of a system ("I want the dashboard to show my sleep", "I love how this page works, I'd love more like it");
  - work-task intentions for the current job ("I want to fix this bug first", "I want to ship the release before lunch");
  - process remarks inside a task, about how to do the job at hand ("I want to measure twice before we drill", "I want to double-check the measurements first");
  - pleasantries and courtesies to a guest, host, reader or audience ("Hope to catch you at the meetup next month", "I'd love to have you back on the show", "I'd love to have you all on again");
  - templates, example lists and fill-in-the-blank items in an essay or talk, where the speaker shows what someone might say rather than stating a want of their own ("- I want to live in a ____ city", "I want to earn that kind of salary", a bulleted list of sample goals);
  - filler and discourse phrases about the talk or the text itself ("I want to be upfront", "I want to point out", "a topic I want to say more about later", "I want the guest to catch me off guard");
  - wishes about other people, society or the world rather than their own life ("I wish everyone read more", "I wish life came with an instruction manual");
  - picking one option among several on screen without naming it ("I'll go with the second one");
  - complaints, frustration or negatives, even with "I wish" ("I wish this thing would stop crashing"), including a complaint about a product, service or subscription phrased as a wish ("I wish the gym opened earlier");
  - fragments cut off before the want is said ("and then I want to tr");
  - other people's words, quotes and reported speech ("My friend said I want to quit my job", "She told me she wants a dog");
  - hypotheticals and conditionals that are not the speaker's own want ("If someone wanted to retire early they would...", "Imagine a person who says I want it all");
  - sarcasm or irony ("Oh great, I'd love another 6am meeting");
  - text the assistant wrote, or that the speaker quotes back from an assistant or a generated document.

Domain for a want, one of: mission, identity, health, money, relationships, creative, freedom, rhythms, infrastructure, home, other. mission is what they want to build or change in the world and the work that serves it; identity is who they want to be: character, values, outlook, and the abilities they see as core to themselves; home is where and how they live; rhythms is how their days and weeks run; freedom is time, autonomy and travel; infrastructure is the personal tools, devices and services of their life, never this assistant's code. Use other only when none fits.

You also get the person's existing wants (id, text, said_at). When a "want" clearly contradicts an existing want, or a "retraction" withdraws one, list those ids in "supersedes". List an id only when the new item plainly reverses it.

Return JSON only: {"items":[{"i":<item index>,"verdict":"want"|"retraction"|"reject","domain":"<domain>","supersedes":["W-..."]}]}. Include every item. When unsure, reject.`;

export type InferLike = (opts: Record<string, unknown>) => Promise<{ success: boolean; parsed?: unknown; error?: string; vendor?: string }>;

/** The one request shape: OpenAI lane, JSON, no fallback to another vendor (ISC-40). */
export function classifierRequest(systemPrompt: string, userPrompt: string, flex = false): Record<string, unknown> & { vendor: "openai"; allowVendorFallback: false } {
  return { systemPrompt, userPrompt, level: "medium", expectJson: true, vendor: "openai", allowVendorFallback: false, timeout: 180_000, ...(flex ? { serviceTier: "flex" } : {}) };
}

async function liveInfer(opts: Record<string, unknown>): ReturnType<InferLike> {
  const { inference } = await import("../TOOLS/Inference");
  return inference(opts as never);
}

const VERDICTS: readonly Verdict[] = ["want", "retraction", "reject"];
/** Code gate on one batch answer: unknown indexes, verdicts or domains fall to reject or other. */
export function parseClassification(parsed: unknown, n: number): Classification[] {
  const out: Classification[] = Array.from({ length: n }, (_, i) => ({ i, verdict: "reject" as Verdict }));
  const items = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const i = typeof r.i === "number" ? r.i : Number(r.i);
    if (!Number.isInteger(i) || i < 0 || i >= n || !VERDICTS.includes(r.verdict as Verdict)) continue;
    const domain = typeof r.domain === "string" && (WANT_DOMAINS as readonly string[]).includes(r.domain) ? r.domain : "other";
    const supersedes = Array.isArray(r.supersedes) ? r.supersedes.filter((s): s is string => typeof s === "string" && /^W-[0-9a-f]{8}$/.test(s)) : [];
    out[i] = { i, verdict: r.verdict as Verdict, domain, supersedes };
  }
  return out;
}

/** One OpenAI-lane call per batch. Throws on a failed call or an answer from another vendor. */
export async function openAiClassify(items: RawLine[], existing: Want[], opts: { infer?: InferLike; batchSize?: number; flex?: boolean } = {}): Promise<Classification[]> {
  const infer = opts.infer ?? liveInfer, size = opts.batchSize ?? BATCH_SIZE;
  const known = existing.slice(-MAX_EXISTING_IN_PROMPT).map((w) => ({ id: w.id, text: w.text, said_at: w.said_at.slice(0, 10) }));
  const out: Classification[] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    const user = JSON.stringify({ items: batch.map((b, i) => ({ i, text: b.text, source: b.source, said: b.said_at.slice(0, 10) })), existing: known });
    const res = await infer(classifierRequest(CLASSIFIER_SYSTEM, user, opts.flex));
    if (!res.success) throw new Error(`wants classifier failed: ${res.error ?? "unknown"}`);
    if (res.vendor !== undefined && res.vendor !== "openai") throw new Error(`wants classifier must run on the openai lane, got ${res.vendor}`);
    for (const c of parseClassification(res.parsed, batch.length)) out.push({ ...c, i: c.i + start });
  }
  return out;
}

export const liveClassify: Classify = (items, existing) => openAiClassify(items, existing, { flex: true });

// ── the store ──────────────────────────────────────────────────────────────

const readVerdict = (v: unknown): WantVerdict | null => (WANT_VERDICTS as readonly unknown[]).includes(v) ? (v as WantVerdict) : null;

/**
 * Every want, in first-appearance order. Each line's fields apply over the earlier lines with
 * the same id (a label line carries only id, verdict and verdict_at), so the last line per id
 * wins field by field. A missing verdict reads as null.
 */
export function loadWants(): Want[] {
  const by = new Map<string, Record<string, unknown>>();
  for (const w of readLines<Record<string, unknown>>(WANTS_FILE)) if (w && typeof w.id === "string") by.set(w.id, { ...(by.get(w.id) ?? {}), ...w });
  return [...by.values()].map((w) => {
    const verdict = readVerdict(w.verdict);
    return { ...(w as unknown as Want), verdict, verdict_at: verdict && typeof w.verdict_at === "string" ? w.verdict_at : null };
  });
}
/** Live wants: not superseded, not archived, and not dropped by the principal. */
export const activeWants = (): Want[] => loadWants().filter((w) => !w.superseded_by && !w.archived && w.verdict !== "drop");

const IMMUTABLE: (keyof Want)[] = ["text", "said_at", "source", "source_ref", "domain"];
/** Asserts the record contract, and that a fold changes only the four mutable fields. */
function assertWant(w: Want, prev?: Want): void {
  invariant(/^W-[0-9a-f]{8}$/.test(w.id), `want id shape: ${w.id}`);
  invariant(typeof w.text === "string" && w.text.trim().length > 0 && w.text.length <= 1000, `want ${w.id} has text`);
  invariant((WANT_SOURCES as readonly string[]).includes(w.source), `want ${w.id} source is known: ${w.source}`);
  invariant((WANT_DOMAINS as readonly string[]).includes(w.domain), `want ${w.id} domain is known: ${w.domain}`);
  for (const k of ["said_at", "first_seen", "last_seen"] as const) invariant(iso(w[k]) === w[k], `want ${w.id} ${k} is ISO`);
  invariant(w.first_seen <= w.last_seen, `want ${w.id} first_seen <= last_seen`);
  invariant(typeof w.source_ref === "string" && w.source_ref.length > 0 && w.source_ref.length <= 300, `want ${w.id} has a short pointer`);
  invariant(!w.source_ref.toLowerCase().includes(w.text.toLowerCase().slice(0, 40)), `want ${w.id} pointer carries no content`);
  invariant(w.superseded_by === null || /^W-[0-9a-f]{8}$/.test(w.superseded_by), `want ${w.id} superseded_by shape`);
  invariant(w.superseded_by !== w.id, `want ${w.id} never supersedes itself`);
  invariant(typeof w.archived === "boolean", `want ${w.id} archived is boolean`);
  invariant(w.verdict == null || (WANT_VERDICTS as readonly string[]).includes(w.verdict), `want ${w.id} verdict shape: ${String(w.verdict)}`);
  invariant(!w.verdict ? !w.verdict_at : iso(w.verdict_at ?? "") === w.verdict_at, `want ${w.id} verdict_at matches verdict`);
  invariant(w.domain_at == null || iso(w.domain_at) === w.domain_at, `want ${w.id} domain_at is ISO`);
  if (prev) for (const k of IMMUTABLE) invariant(w[k] === prev[k], `fold of ${w.id} keeps ${k}`);
}

// ── principal labels (keep / drop), reversible ─────────────────────────────

export type LabelStats = { keep: number; drop: number; unlabeled: number; precision: number | null };
export const REAL_PRECISION_FLOOR = 0.9;

/**
 * Appends one label line per id: {id, verdict, verdict_at}. Refuses an empty list, an unknown
 * verdict or any unknown id before writing anything. Running it again flips the label.
 */
export function labelWants(ids: string[], verdict: WantVerdict, now: Date = new Date()): void {
  invariant(ids.length > 0, "label needs at least one want id");
  invariant((WANT_VERDICTS as readonly string[]).includes(verdict), `verdict must be keep or drop: ${String(verdict)}`);
  const at = now.toISOString();
  invariant(iso(at) === at, "verdict_at is ISO");
  // Under the wants file lock, the same one a scan holds while it writes, so the two never interleave.
  withLocks([statePath(WANTS_FILE)], () => {
    const known = new Set(loadWants().map((w) => w.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`unknown want id: ${unknown.join(", ")}`);
    for (const id of [...new Set(ids)]) appendState(WANTS_FILE, { id, verdict, verdict_at: at });
  });
}

/** Counts over every stored want; precision of the real outputs is keep over keep plus drop, null until one is labeled. */
export function wantLabelStats(wants: Want[] = loadWants()): LabelStats {
  const keep = wants.filter((w) => w.verdict === "keep").length, drop = wants.filter((w) => w.verdict === "drop").length;
  return { keep, drop, unlabeled: wants.length - keep - drop, precision: keep + drop ? keep / (keep + drop) : null };
}

/** The eval passes when every fixture set does and, once any real output is labeled, their precision holds the floor too. */
export function wantsEvalPassed(sets: { passed: boolean }, stats: LabelStats): boolean {
  return sets.passed && (stats.precision === null || stats.precision >= REAL_PRECISION_FLOOR);
}

// ── readers ────────────────────────────────────────────────────────────────

const RELAY_RE = /<(task-notification|teammate-message|system-reminder|cross-session-message|agent-message|command-name|command-message|local-command-stdout)/;
const HUMAN_SOURCES = new Set(["typed", "queued"]);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string } | string) => (typeof c === "string" ? c : c?.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
}

/**
 * True when the transcript's opening bytes show an SDK or headless session and no interactive one, so the
 * whole file can be skipped unread (most transcripts by volume are unattended jobs with no human turn).
 */
export function headlessSession(path: string, bytes = 65_536): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const head = buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString("utf8");
    return head.includes('"entrypoint":"sdk-cli"') && !head.includes('"entrypoint":"cli"');
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}

/** Human-typed user turns from Claude Code session transcripts (top-level files only; subagent transcripts are agent briefs). */
export async function readPromptLines(opts: { root?: string; since: Date }): Promise<ReadResult> {
  const root = opts.root ?? process.env.IDEALSTATE_WANTS_PROJECTS_DIR ?? join(getClaudeDir(), "projects");
  if (!existsSync(root)) return { lines: [], error: `no transcript directory at ${root}` };
  const { isMachineText } = await import("../ERRATA/Store");
  const since = opts.since.getTime();
  const lines: RawLine[] = [];
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = join(root, proj.name);
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const path = join(dir, f.name);
      try { if (statSync(path).mtimeMs < since) continue; } catch { continue; }
      if (headlessSession(path)) continue;
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { continue; }
      const recent: string[] = [];
      for (const row of content.split("\n")) {
        if (!row) continue;
        let o: Record<string, any>;
        try { o = JSON.parse(row); } catch { continue; }
        if (o.type === "assistant") { const t = blockText(o.message?.content); if (t) { recent.push(t); if (recent.length > 3) recent.shift(); } continue; }
        if (o.type !== "user" || o.isMeta || o.isSidechain) continue;
        const c = o.message?.content;
        if (Array.isArray(c) && c.some((b: { type?: string }) => b?.type === "tool_result")) continue;
        const human = o.turnOrigin === "human" || HUMAN_SOURCES.has(o.promptSource) || (o.turnOrigin === undefined && o.promptSource === undefined && o.entrypoint === "cli");
        if (!human) continue;
        const ts = iso(o.timestamp);
        if (!ts || Date.parse(ts) < since) continue;
        const text = blockText(c);
        if (!text || isMachineText(text) || RELAY_RE.test(text) || /^\s*\[(SYSTEM NOTIFICATION|Workflow harness)/.test(text)) continue;
        lines.push({ text, said_at: ts, source: "prompt", source_ref: `session:${String(o.sessionId ?? f.name.replace(/\.jsonl$/, ""))}#${String(o.uuid ?? "")}`, context: [...recent] });
      }
    }
  }
  return { lines, error: null };
}

export type Run = (args: string[]) => { code: number; stdout: string; stderr: string };

// release-allow: private-skill-names (optional readers: each script is looked up at runtime and a typed error names the missing skill when it is not installed)
/** Skill-relative script paths of the optional live readers, resolved under the skills directory only when the file exists. */
const OPTIONAL_READER_SCRIPTS = {
  lifelog: ["_LIFELOG", "Tools", "Bee.ts"],
  corpus: ["_CORPUS", "corpus.ts"],
} as const;
/** The absolute path of an optional reader's script, or null when the skill that owns it is not installed. */
function optionalReaderScript(reader: keyof typeof OPTIONAL_READER_SCRIPTS): string | null {
  const path = join(getClaudeDir(), "skills", ...OPTIONAL_READER_SCRIPTS[reader]);
  return existsSync(path) ? path : null;
}
function spawnRun(cmd: string[]): Run {
  return (args) => {
    const r = Bun.spawnSync([...cmd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LIFEOS_NOTIFICATION_CHANNEL: "headless" }, timeout: 60_000 });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
}
const firstJson = (s: string): unknown => { const i = s.indexOf("{"); if (i < 0) throw new Error("no JSON document"); return JSON.parse(s.slice(i)); };

/**
 * Lifelog lines where the speaker is the wearer. The Bee transcript marks each utterance with
 * `speaker` ("Unknown" when the wearable could not tell); the wearer is the name `bee status`
 * prints as "Verified as <name>", matched in full or by its first word. With no verified name,
 * or for any other label, the line is refused (ISC-34).
 */
export async function readLifelogLines(opts: { since: Date; run?: Run; limit?: number }): Promise<ReadResult> {
  let bee = opts.run;
  if (!bee) {
    const script = optionalReaderScript("lifelog");
    if (!script) return { lines: [], error: "lifelog reader not installed (no lifelog skill); lifelog lines skipped" };
    bee = (args: string[]) => args[0] === "status" ? spawnRun(["bee"])(args) : spawnRun(["bun", script])(args);
  }
  const status = bee(["status"]);
  const name = status.code === 0 ? /Verified as\s+(.+?)\s*(?:\(id\b|$)/m.exec(status.stdout)?.[1]?.trim() : undefined;
  if (!name) return { lines: [], error: "no verified wearer name from bee status; every lifelog line refused" };
  const wearer = new Set([name.toLowerCase(), name.split(/\s+/)[0]!.toLowerCase()]);
  const recent = bee(["recent", "--since", String(opts.since.getTime()), "--limit", String(opts.limit ?? 100)]);
  if (recent.code !== 0) return { lines: [], error: `bee recent exited ${recent.code}: ${recent.stderr.trim().split("\n")[0] ?? ""}` };
  let convs: { id: number; start_time?: number }[];
  try { convs = ((firstJson(recent.stdout) as { conversations?: unknown }).conversations ?? []) as typeof convs; } catch (e) { return { lines: [], error: `bee recent unreadable: ${(e as Error).message}` }; }
  const lines: RawLine[] = [];
  const errors: string[] = [];
  for (const c of convs) {
    if (!Number.isInteger(c?.id)) continue;
    const t = bee(["transcript", String(c.id)]);
    if (t.code !== 0) { errors.push(`transcript ${c.id} exited ${t.code}`); continue; }
    let utts: { id?: number; spoken_at?: number; speaker?: string; text?: string }[];
    try { utts = ((firstJson(t.stdout) as { transcript?: unknown }).transcript ?? []) as typeof utts; } catch { errors.push(`transcript ${c.id} unreadable`); continue; }
    utts.forEach((u, idx) => {
      if (typeof u?.speaker !== "string" || !wearer.has(u.speaker.trim().toLowerCase()) || typeof u.text !== "string" || !u.text.trim()) return;
      const ts = iso(u.spoken_at ?? c.start_time ?? NaN);
      if (!ts || Date.parse(ts) < opts.since.getTime()) return;
      lines.push({ text: u.text, said_at: ts, source: "lifelog", source_ref: `bee:${c.id}#${u.id ?? idx}` });
    });
  }
  return { lines, error: errors.length ? errors.join("; ") : null };
}

export const CORPUS_PHRASES = ["I want", "I'd love", "I prefer", "I wish", "I hope to", "my dream", "someday I", "I'd like to"];
/** Published writing that carries a marker phrase, through the corpus skill's mentions command. A failed query is an error, never absence. */
export async function readCorpusLines(opts: { since: Date; run?: Run }): Promise<ReadResult> {
  let run = opts.run;
  if (!run) {
    const script = optionalReaderScript("corpus");
    if (!script) return { lines: [], error: "corpus reader not installed (no corpus skill); corpus lines skipped" };
    run = spawnRun(["bun", script]);
  }
  const from = opts.since.toISOString().slice(0, 10);
  const lines: RawLine[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const phrase of CORPUS_PHRASES) {
    const r = run(["mentions", phrase, "--json", "--from", from]);
    let doc: { mentions?: { url?: string; date?: string; context?: string }[]; error?: string; partial?: boolean };
    try { doc = firstJson(r.stdout) as typeof doc; } catch { errors.push(`"${phrase}": ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`); continue; }
    if (r.code === 1 || doc.error) { errors.push(`"${phrase}": ${doc.error ?? r.stderr.trim().split("\n")[0] ?? `exit ${r.code}`}`); continue; }
    if (r.code === 2 || doc.partial) errors.push(`"${phrase}": partial retrieval`);
    for (const m of doc.mentions ?? []) {
      const ts = iso(m.date ?? ""), url = typeof m.url === "string" ? m.url : "";
      if (!ts || !url || typeof m.context !== "string") continue;
      const k = `${url}|${m.context}`;
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push({ text: m.context, said_at: ts, source: "corpus", source_ref: url });
    }
  }
  return { lines, error: errors.length ? errors.join("; ") : null };
}

/** The principal's own praise entries in the Errata ledger (never tenant rows, never complaints). */
export async function readErrataPraiseLines(opts: { since: Date; dir?: string; tenantDir?: string }): Promise<ReadResult> {
  const { ErrataStore, TENANT_SOURCES, isMachineText } = await import("../ERRATA/Store");
  const store = opts.dir ? new ErrataStore(opts.dir, opts.tenantDir) : new ErrataStore();
  const lines: RawLine[] = [];
  for (const e of store.all()) {
    if (e.kind !== "praise" || e.reporter?.id !== "principal" || TENANT_SOURCES.has(e.source)) continue;
    if (Date.parse(e.ts) < opts.since.getTime() || !e.complaint || isMachineText(e.complaint)) continue;
    lines.push({ text: e.complaint, said_at: new Date(e.ts).toISOString(), source: "errata-praise", source_ref: e.id });
  }
  return { lines, error: null };
}

export function liveReaders(since: (s: WantSource) => Date): Readers {
  return {
    prompt: () => readPromptLines({ since: since("prompt") }),
    lifelog: () => readLifelogLines({ since: since("lifelog") }),
    corpus: () => readCorpusLines({ since: since("corpus") }),
    "errata-praise": () => readErrataPraiseLines({ since: since("errata-praise") }),
  };
}

// ── the scan ───────────────────────────────────────────────────────────────

export type ScanResult = {
  dry_run: boolean; raw: number; candidates: number; classified: number;
  added: number; folded: number; superseded: number; archived: number;
  by_source: Record<string, { raw: number; candidates: number; added: number; error: string | null }>;
};

type ScanState = { last_scan?: Partial<Record<WantSource, string>> };

export function scanSince(src: WantSource, now: Date, override?: Date): Date {
  if (override) return override;
  const last = readJson<ScanState>(statePath(SCAN_STATE), {}).last_scan?.[src];
  const t = last ? Date.parse(last) : NaN;
  return Number.isFinite(t) ? new Date(t) : new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * DAY);
}

const shouldArchive = (w: Pick<Want, "source" | "said_at">, now: Date): boolean => w.source === "corpus" && now.getTime() - Date.parse(w.said_at) > ARCHIVE_AFTER_DAYS * DAY;

/**
 * Reads every source, extracts, classifies, folds and writes. Every classification finishes
 * before the first write, so a failed model call leaves the store untouched.
 */
export async function scanWants(opts: { now?: Date; since?: Date; dryRun?: boolean; readers?: Readers; classify?: Classify; sources?: WantSource[] } = {}): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const sources = opts.sources ?? [...WANT_SOURCES];
  const readers = opts.readers ?? liveReaders((s) => scanSince(s, now, opts.since));
  const classify = opts.classify ?? liveClassify;
  const result: ScanResult = { dry_run: !!opts.dryRun, raw: 0, candidates: 0, classified: 0, added: 0, folded: 0, superseded: 0, archived: 0, by_source: {} };

  const cands: RawLine[] = [];
  for (const s of sources) {
    const reader = readers[s];
    if (!reader) continue;
    const { lines, error } = await reader();
    const cs = prefilter(lines);
    result.by_source[s] = { raw: lines.length, candidates: cs.length, added: 0, error };
    result.raw += lines.length;
    cands.push(...cs);
  }
  cands.sort((a, b) => a.said_at.localeCompare(b.said_at));
  result.candidates = cands.length;

  const prev = loadWants();
  const current = new Map(prev.map((w) => [w.id, { ...w }]));
  const touched = new Set<string>();
  const findSame = (text: string): Want | undefined => {
    const exact = current.get(wantId(text));
    if (exact) return exact;
    let best: Want | undefined, score = 0;
    for (const w of current.values()) { if (w.superseded_by) continue; const s = similarity(text, w.text); if (s > score) { score = s; best = w; } }
    return score >= FOLD_SIMILARITY ? best : undefined;
  };
  const fold = (w: Want, said: string) => {
    if (said < w.first_seen) w.first_seen = said;
    if (said > w.last_seen) w.last_seen = said;
    touched.add(w.id);
  };

  // A repeat of a known want folds without a model call; the rest are classified.
  const unknown: RawLine[] = [];
  for (const c of cands) {
    const same = findSame(c.text);
    if (same) { fold(same, c.said_at); result.folded++; } else unknown.push(c);
  }
  const verdicts = unknown.length ? await classify(unknown, [...current.values()].filter((w) => !w.superseded_by && !w.archived)) : [];
  result.classified = unknown.length;

  const supersede = (ids: string[] | undefined, by: string, said: string) => {
    for (const id of ids ?? []) {
      const old = current.get(id);
      if (!old || old.id === by || old.superseded_by || old.said_at >= said) continue; // only an earlier, live want is superseded
      old.superseded_by = by; touched.add(id); result.superseded++;
    }
  };
  verdicts.forEach((v) => {
    const c = unknown[v.i];
    if (!c) return;
    if (v.verdict === "retraction") { supersede(v.supersedes, wantId(c.text), c.said_at); return; }
    if (v.verdict !== "want") return;
    const same = findSame(c.text);
    if (same) { fold(same, c.said_at); result.folded++; supersede(v.supersedes, same.id, c.said_at); return; }
    const domain = ((WANT_DOMAINS as readonly string[]).includes(v.domain ?? "") ? v.domain : "other") as WantDomain;
    const w: Want = { id: wantId(c.text), text: c.text, said_at: c.said_at, source: c.source, source_ref: c.source_ref, domain, first_seen: c.said_at, last_seen: c.said_at, superseded_by: null, archived: shouldArchive(c, now) };
    current.set(w.id, w); touched.add(w.id);
    result.added++; result.by_source[c.source]!.added++;
    supersede(v.supersedes, w.id, c.said_at);
  });
  for (const w of current.values()) if (!w.archived && shouldArchive(w, now)) { w.archived = true; touched.add(w.id); result.archived++; }

  if (opts.dryRun) return result;
  const before = new Map(prev.map((w) => [w.id, w]));
  // The principal labels while classification runs. Labels are never the scan’s to set, so under the file lock
  // each touched want takes its label from the store as it is now, and a scan cannot undo a drop.
  withLocks([statePath(WANTS_FILE)], () => {
    const latest = new Map(loadWants().map((w) => [w.id, w]));
    for (const id of touched) {
      const w = current.get(id)!, p0 = before.get(id), l = latest.get(id);
      w.verdict = l?.verdict ?? null;
      w.verdict_at = l?.verdict_at ?? null;
      const p = p0 && { ...p0, verdict: w.verdict, verdict_at: w.verdict_at };
      if (p && JSON.stringify(p) === JSON.stringify(w)) continue;
      assertWant(w, p);
      // An unlabeled want is written without the label keys, so the record stays as it was before labels existed.
      const { verdict, verdict_at, ...rest } = w;
      appendState(WANTS_FILE, verdict ? { ...rest, verdict, verdict_at } : rest);
    }
  });
  // Merged under the file's lock, so a watermark another scan advanced meanwhile is kept.
  updateState<ScanState>(SCAN_STATE, {}, (st) => {
    const last = { ...(st.last_scan ?? {}) };
    for (const s of sources) if (readers[s] && !result.by_source[s]?.error) last[s] = now.toISOString();
    invariant(Object.values(last).every((v) => iso(v!) === v), "scan watermarks are ISO");
    return { ...st, last_scan: last };
  });
  if (result.added || result.superseded) {
    emitVigilEvent(vigilEvent("ideal-state", "wants", "scanned", "info", "New wants recorded in the ideal state",
      `${result.added} new want(s), ${result.folded} repeat(s), ${result.superseded} superseded, ${result.archived} archived, from ${Object.keys(result.by_source).length} source(s). Run: bun LIFEOS/IDEALSTATE/IdealState.ts wants list`, "life", null, now.toISOString().slice(0, 10)));
  }
  return result;
}

// ── the eval (ISC-31) ──────────────────────────────────────────────────────

export const WANT_CASES_PATH = join(import.meta.dir, "..", "ASSAY", "fixtures", "wants-extractor.cases.jsonl");
/** Written fresh after the extractor was tuned, never derived from the original cases: the number that says whether the tuning generalised. */
export const WANT_HELDOUT_PATH = join(import.meta.dir, "..", "ASSAY", "fixtures", "wants-extractor.heldout.cases.jsonl");
/** The labeled sets the eval reports, each on its own: precision on one never averages away a miss on the other. */
export const WANT_EVAL_SETS = [{ name: "original", path: WANT_CASES_PATH }, { name: "held-out", path: WANT_HELDOUT_PATH }] as const;
export type WantCase = { id: string; text: string; label: "want" | "not"; kind: string; source?: WantSource; assistant_before?: string; note?: string };

export function loadWantCases(path = WANT_CASES_PATH): WantCase[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l, n) => {
    const c = JSON.parse(l) as WantCase;
    invariant(typeof c.id === "string" && typeof c.text === "string" && (c.label === "want" || c.label === "not") && typeof c.kind === "string", `case line ${n + 1} is well formed`);
    return c;
  });
}

export type EvalResult = {
  suite: "wants-extractor"; ts: string; cases: number; tp: number; fp: number; fn: number; tn: number;
  precision: number | null; recall: number | null; threshold: number; passed: boolean;
  false_positives: string[]; false_negatives: string[]; by_kind: Record<string, { cases: number; predicted_want: number }>;
};
export const PRECISION_FLOOR = 0.9;

/** Runs the whole extractor (prefilter, then the classifier) over the labeled cases. */
export async function evalWants(opts: { path?: string; classify?: Classify; now?: Date } = {}): Promise<EvalResult> {
  const cases = loadWantCases(opts.path);
  const lines: RawLine[] = cases.map((c) => ({ text: c.text, said_at: "2026-01-01T00:00:00.000Z", source: c.source ?? "prompt", source_ref: c.id, context: c.assistant_before ? [c.assistant_before] : [] }));
  const cands = prefilter(lines);
  const verdicts = cands.length ? await (opts.classify ?? ((items, ex) => openAiClassify(items, ex)))(cands, []) : [];
  const predicted = new Set(verdicts.filter((v) => v.verdict === "want").map((v) => cands[v.i]?.source_ref).filter(Boolean) as string[]);
  const r: EvalResult = { suite: "wants-extractor", ts: (opts.now ?? new Date()).toISOString(), cases: cases.length, tp: 0, fp: 0, fn: 0, tn: 0, precision: null, recall: null, threshold: PRECISION_FLOOR, passed: false, false_positives: [], false_negatives: [], by_kind: {} };
  for (const c of cases) {
    const p = predicted.has(c.id);
    const k = (r.by_kind[c.kind] ??= { cases: 0, predicted_want: 0 }); k.cases++; if (p) k.predicted_want++;
    if (p && c.label === "want") r.tp++;
    else if (p) { r.fp++; r.false_positives.push(c.id); }
    else if (c.label === "want") { r.fn++; r.false_negatives.push(c.id); }
    else r.tn++;
  }
  r.precision = r.tp + r.fp ? r.tp / (r.tp + r.fp) : null;
  r.recall = r.tp + r.fn ? r.tp / (r.tp + r.fn) : null;
  r.passed = r.precision !== null && r.precision >= PRECISION_FLOOR;
  return r;
}

export type EvalSetsResult = { passed: boolean; sets: { name: string; path: string; result: EvalResult }[] };

/** Runs the extractor over every labeled set and reports each one's precision separately; it passes only when every set does. */
export async function evalWantSets(opts: { sets?: readonly { name: string; path: string }[]; classify?: Classify; now?: Date } = {}): Promise<EvalSetsResult> {
  const sets: EvalSetsResult["sets"] = [];
  for (const set of opts.sets ?? WANT_EVAL_SETS) sets.push({ name: set.name, path: set.path, result: await evalWants({ path: set.path, classify: opts.classify, now: opts.now }) });
  // No set is no evidence: an empty run never passes.
  return { passed: sets.length > 0 && sets.every((x) => x.result.passed), sets };
}

// ── the real-label eval (ISC-31) ───────────────────────────────────────────

/** Recall floor on the principal's keeps: a tighter extractor that refuses his real wants does not pass. */
export const REAL_RECALL_FLOOR = 0.85;

export type LabelCounts = { keep: number; drop: number; tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null };
export type LabelEvalResult = LabelCounts & {
  suite: "wants-labels"; ts: string; labeled: number; precision_floor: number; recall_floor: number; passed: boolean;
  /** Ids the principal dropped that the extractor still keeps. */
  false_positives: string[];
  /** Ids the principal kept that the extractor now refuses, in the code layer or the classifier. */
  missed_keeps: string[];
  by_source: Record<string, LabelCounts>;
};

const emptyCounts = (): LabelCounts => ({ keep: 0, drop: 0, tp: 0, fp: 0, fn: 0, tn: 0, precision: null, recall: null });
function finishCounts(c: LabelCounts): LabelCounts {
  c.precision = c.tp + c.fp ? c.tp / (c.tp + c.fp) : null;
  c.recall = c.tp + c.fn ? c.tp / (c.tp + c.fn) : null;
  return c;
}

/**
 * Re-runs the whole extractor (prefilter, then the classifier) over every stored want the
 * principal labeled, in place: it reads the store and writes nothing. A keep the extractor now
 * refuses is a recall miss; a drop it still keeps is a false positive. Unlabeled wants are not
 * counted. It passes when precision and recall both hold their floors.
 */
export async function evalLabeledWants(opts: { wants?: Want[]; classify?: Classify; now?: Date } = {}): Promise<LabelEvalResult> {
  const labeled = (opts.wants ?? loadWants()).filter((w) => w.verdict === "keep" || w.verdict === "drop");
  const cands = prefilter(labeled.map((w) => ({ text: w.text, said_at: w.said_at, source: w.source, source_ref: w.id })));
  const classify = opts.classify ?? ((items, ex) => openAiClassify(items, ex));
  const verdicts = cands.length ? await classify(cands, []) : [];
  const predicted = new Set(verdicts.filter((v) => v.verdict === "want").map((v) => cands[v.i]?.source_ref).filter((x): x is string => !!x));
  const total = emptyCounts();
  const by: Record<string, LabelCounts> = {};
  const false_positives: string[] = [], missed_keeps: string[] = [];
  for (const w of labeled) {
    const p = predicted.has(w.id), keep = w.verdict === "keep";
    for (const c of [total, (by[w.source] ??= emptyCounts())]) {
      if (keep) c.keep++; else c.drop++;
      if (p && keep) c.tp++; else if (p) c.fp++; else if (keep) c.fn++; else c.tn++;
    }
    if (p && !keep) false_positives.push(w.id);
    if (!p && keep) missed_keeps.push(w.id);
  }
  finishCounts(total);
  for (const c of Object.values(by)) finishCounts(c);
  const passed = labeled.length > 0 && total.precision !== null && total.precision >= REAL_PRECISION_FLOOR && total.recall !== null && total.recall >= REAL_RECALL_FLOOR;
  return { suite: "wants-labels", ts: (opts.now ?? new Date()).toISOString(), labeled: labeled.length, ...total, precision_floor: REAL_PRECISION_FLOOR, recall_floor: REAL_RECALL_FLOOR, passed, false_positives, missed_keeps, by_source: by };
}

// ── redomain: kept wants still in "other" ──────────────────────────────────

export const DOMAIN_SYSTEM = `You file one person's own stated wants into life domains. Each item is a want they said or wrote about their own life.

Domains:
- mission: what they want to build or change in the world, and the work that serves it.
- identity: who they want to be: character, values, outlook, how they want to think, and the abilities they see as core to themselves.
- health: body, sleep, food, fitness.
- money: income, savings, investments, what they earn and sell.
- relationships: partner, family, friends, the people close to them.
- creative: making things: music, writing, art, building for its own sake, and learning a craft.
- freedom: time, autonomy and travel.
- rhythms: how their days and weeks run.
- infrastructure: the personal tools, devices and services of their life.
- home: where and how they live, and the things in it.
- other: only when none of the above fits.

Return JSON only: {"items":[{"i":<item index>,"domain":"<domain>"}]}. Include every item.`;

export type DomainItem = { text: string; source: WantSource };
/** One domain name (or null for no usable answer) per item, in order. */
export type ClassifyDomain = (items: DomainItem[]) => Promise<(string | null)[]>;

/** Code gate on a domain answer: an unknown index or domain is null, never a guess. */
export function parseDomains(parsed: unknown, n: number): (string | null)[] {
  const out: (string | null)[] = Array.from({ length: n }, () => null);
  const items = parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown }).items) ? (parsed as { items: unknown[] }).items : [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const i = typeof r.i === "number" ? r.i : Number(r.i);
    if (Number.isInteger(i) && i >= 0 && i < n && typeof r.domain === "string" && (WANT_DOMAINS as readonly string[]).includes(r.domain)) out[i] = r.domain;
  }
  return out;
}

/** One OpenAI-lane call per batch, no vendor fallback (ISC-40). Throws on a failed call or an answer from another vendor. */
export async function openAiDomains(items: DomainItem[], opts: { infer?: InferLike; batchSize?: number } = {}): Promise<(string | null)[]> {
  const infer = opts.infer ?? liveInfer, size = opts.batchSize ?? BATCH_SIZE;
  const out: (string | null)[] = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    const res = await infer(classifierRequest(DOMAIN_SYSTEM, JSON.stringify({ items: batch.map((b, i) => ({ i, text: b.text, source: b.source })) })));
    if (!res.success) throw new Error(`wants domain call failed: ${res.error ?? "unknown"}`);
    if (res.vendor !== undefined && res.vendor !== "openai") throw new Error(`wants domain call must run on the openai lane, got ${res.vendor}`);
    out.push(...parseDomains(res.parsed, batch.length));
  }
  return out;
}

export type RedomainProposal = { id: string; text: string; from: "other"; to: WantDomain };
export type RedomainResult = { dry_run: boolean; considered: number; proposals: RedomainProposal[]; written: number };

/**
 * Re-asks the domain of every kept, live want still filed under "other", and moves each one the
 * model places in a named domain with a fold line {id, domain, domain_at}. An "other" or unknown
 * answer changes nothing. Every answer arrives before the first write, so a failed call writes
 * nothing; --dry-run asks and writes nothing.
 */
export async function redomainWants(opts: { dryRun?: boolean; classifyDomain?: ClassifyDomain; infer?: InferLike; now?: Date } = {}): Promise<RedomainResult> {
  const now = opts.now ?? new Date();
  const eligible = loadWants().filter((w) => w.verdict === "keep" && w.domain === "other" && !w.superseded_by);
  const result: RedomainResult = { dry_run: !!opts.dryRun, considered: eligible.length, proposals: [], written: 0 };
  if (!eligible.length) return result;
  const classify = opts.classifyDomain ?? ((items: DomainItem[]) => openAiDomains(items, { infer: opts.infer }));
  const answers = await classify(eligible.map((w) => ({ text: w.text, source: w.source })));
  invariant(answers.length === eligible.length, `domain answers match the wants asked: ${answers.length} for ${eligible.length}`);
  eligible.forEach((w, i) => {
    const to = answers[i];
    if (to && to !== "other" && (WANT_DOMAINS as readonly string[]).includes(to)) result.proposals.push({ id: w.id, text: w.text, from: "other", to: to as WantDomain });
  });
  if (opts.dryRun || !result.proposals.length) return result;
  const at = now.toISOString();
  const current = new Map(loadWants().map((w) => [w.id, w]));
  invariant(iso(at) === at, "domain_at is ISO");
  for (const p of result.proposals) {
    const w = current.get(p.id);
    invariant(!!w, `redomain target exists: ${p.id}`);
    invariant(w!.domain === "other" && w!.verdict === "keep" && !w!.superseded_by, `redomain target ${p.id} is still a kept want in other`);
    invariant((WANT_DOMAINS as readonly string[]).includes(p.to) && p.to !== "other", `redomain target domain is a named domain: ${p.to}`);
  }
  for (const p of result.proposals) { appendState(WANTS_FILE, { id: p.id, domain: p.to, domain_at: at }); result.written++; }
  return result;
}
