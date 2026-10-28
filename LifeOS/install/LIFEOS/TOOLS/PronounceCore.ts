/**
 * PronounceCore.ts — how every LifeOS voice turns written text into what it says (the pure half; the loader that
 * reads the principal's PRONUNCIATIONS.json is LIFEOS/TOOLS/Pronounce.ts).
 *
 * The ONE place spoken text is prepared, for the voice server and anything else that speaks. FishTTS.fishRequestBody runs pronounce() on
 * every request, so the voice server, ReadIt, blog and podcast audio, the narrators, Relay voice notes and live talk
 * all speak the same way; the phone Worker imports this file directly. Import-free so it bundles into a Worker.
 * Pronounce.guard.test.ts fails on a second copy. Fish voice ISA F7.
 *
 * Two passes, in order:
 *   1. disambiguateHomographs() — words spelled alike that sound different by sense ("live").
 *   2. applyPronunciations()    — the principal's spoken overrides ("STATVS" → "status"), on word boundaries.
 *
 * ── Homographs ──
 *
 * Some words share spelling but differ in sound by sense. A TTS model guesses
 * the reading from context and sometimes picks wrong. The worst offender is
 * "live": the broadcast/adjective sense (/laɪv/ — "the site is live", "go
 * live") gets read as the verb (/lɪv/ — "live freely", "where you live").
 *
 * In the DA's speech the broadcast sense is the common one, so it is the DEFAULT:
 * every "live" is respelled "lyve" (read /laɪv/) unless a verb signal sits next to
 * it — a subject or modal right before it ("I live", "they'd live", "to live",
 * "can't live", "where … live"), or a life/adverb right after ("live a good life",
 * "live freely"). The old default was the verb, with broadcast phrasings listed one
 * by one, so every phrasing nobody had listed was read as the verb (principal,
 * 2026-10-25, on "Live, it shows up…": "a pronunciation problem you were supposed to
 * have solved months ago"). The broadcast contexts below stay as overrides: a "live"
 * inside one is respelled even when a verb signal is also present ("they went live").
 *
 * Only the homograph token is respelled, so a sentence mixing both senses stays correct.
 *
 */

interface Homograph {
  word: string
  respell: string
  /** Contexts that always mean the respelled sense, even beside a verb signal. */
  contexts: RegExp[]
  /** Contexts that keep the spelling (the verb); every other occurrence is respelled. */
  keep: RegExp[]
}

const HOMOGRAPHS: Homograph[] = [
  {
    word: "live",
    respell: "lyve", // → /laɪv/
    contexts: [
      // "go / went / going / staying live"
      /\b(?:go|goes|going|gonna go|went|stay|stays|staying)\s+live\b/gi,
      // "is / was / now / currently live"
      /\b(?:is|are|am|was|were|be|been|it'?s|now|then|currently)\s+live\b/gi,
      // "live on <domain>", "live in production", "live site/deploy/stream/…",
      // and the verification cadence "live and verified"
      /\blive\s+(?:on\s+\S+\.\w{2,}|in\s+production|site|deploy|deployment|stream|broadcast|show|event|demo|version|audience|and\s+verified)\b/gi,
      // "watch / stream / airing … live"
      /\b(?:watch|watching|stream|streaming|airs|airing|broadcast|broadcasting)\b[^.?!]*\blive\b/gi,
      // hyphenated ship cadence anywhere: "live-verified", "live-verify", "live-tested", "live-checked"
      /\blive-(?:verif\w+|test\w+|check\w+)/gi,
      // ship/deploy verbs near live: "deployed live", "shipped it live", "pushed live", "launched live", "rolled out live"
      /\b(?:deploy(?:ed|ing)?|ship(?:ped|ping)?|push(?:ed|ing)?|launch(?:ed|ing)?|rolled\s+out|roll\s+out|going\s+out|go\s+out)\b[^.?!]{0,20}\blive\b/gi,
      // "verified / tested / running live"
      /\b(?:verif\w+|tested|testing|running|runs|run)\s+live\b/gi,
      // a status line that opens on "Live": "Live around 02:40", "Live with real lines", "Live now",
      // "Live at version …". Capital only, at a sentence or label start, so "I live with friends" stays the
      // verb (principal, 2026-10-14).
      /(?:^|[.!?:]\s+|\n\s*)Live(?=\s+(?:around|by|at|now|soon|today|tonight|tomorrow|with|and|as|from|in\s+(?:about|\d)|on\s+\S+\.\w{2,})\b)/g,
      // possessive status: "Logo's live", "the site's live", "everything's live"
      /\b\w+['’]s\s+live\b/gi,
      // the adjective before a thing on a site: "the live page", "live chart", "live capture", "live link"
      /\blive\s+(?:page|pages|chart|charts|view|capture|captures|link|links|url|preview|build|data|probe|check|result|results|copy|HTML|tab)\b/gi,
    ],
    keep: [
      // a subject, modal, negation or "to" right before it, with at most one adverb between: "I live", "you'd live",
      // "to live", "can't live", "who live", "these live", "long live"
      /\b(?:I|you|we|they|people|folks|families|kids|who|these|those|which|to|can|could|will|would|shall|should|must|might|may|cannot|let|help|do|does|did|don't|doesn't|didn't|won't|wouldn't|couldn't|can't|shouldn't|never|long|\w+'(?:ll|d))\s+(?:(?:still|really|just|actually|all|both|always|happily|truly|only|also)\s+)?live\b/gi,
      // a where-clause: "where do the rules live", "where you live"
      /\bwhere\b[^.?!,;]{0,40}\blive\b/gi,
      // a plural subject living somewhere: "the tests live in hooks/", "users live under" (not "in production")
      /\b\w+s\s+live\s+(?:in|under|inside|beside|alongside|next\s+to)\b(?!\s+production)/gi,
      // the verb's objects and adverbs: "live a good life", "live freely", "live up to", "live with it"
      /\blive\s+(?:(?:a|an|the|your|my|our|their|his|her)\s+(?:\w+\s+){0,3}(?:life|lives)\b|life\b|lives\b|freely|forever|together|alone|happily|longer|through|off\b|up\s+to|with\s+(?:it|that|this|them|him|her)\b)/gi,
      // "live-in" is /lɪv/
      /\blive-in\b/gi,
    ],
  },
]

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Match the leading-cap pattern of the original token onto the respelling. */
function matchCase(original: string, respell: string): string {
  const isCapitalized =
    original[0] === original[0].toUpperCase() && original[0] !== original[0].toLowerCase()
  return isCapitalized ? respell[0].toUpperCase() + respell.slice(1) : respell
}

/** Every [start, end) span the regexes match in the text. */
function spans(text: string, res: RegExp[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
    for (const m of text.matchAll(g)) out.push([m.index!, m.index! + m[0].length])
  }
  return out
}

const inside = (i: number, len: number, ranges: Array<[number, number]>): boolean =>
  ranges.some(([a, b]) => i >= a && i + len <= b)

export function disambiguateHomographs(text: string): string {
  let result = text
  for (const h of HOMOGRAPHS) {
    const force = spans(result, h.contexts)
    const keep = spans(result, h.keep)
    const wordRe = new RegExp(`\\b${escapeRegex(h.word)}\\b(?!-in\\b)`, "gi")
    result = result.replace(wordRe, (w, i: number) =>
      inside(i, w.length, force) || !inside(i, w.length, keep) ? matchCase(w, h.respell) : w,
    )
  }
  return result
}

/** Spoken overrides on word boundaries, longest keys first, case-sensitive as written; a function replacer, so a "$" in a
 *  rule is literal. Compiled once per map. */
const compiled = new WeakMap<Record<string, string>, Array<[RegExp, string]>>()
export function applyPronunciations(text: string, map: Record<string, string>): string {
  let rules = compiled.get(map)
  if (!rules) {
    rules = Object.keys(map).sort((a, b) => b.length - a.length).map((k) => [
      new RegExp(`(?<![A-Za-z0-9])${escapeRegex(k)}(?![A-Za-z0-9])`, "g"), map[k],
    ])
    compiled.set(map, rules)
  }
  let out = text
  for (const [re, said] of rules) out = out.replace(re, () => said)
  return out
}

/** What a voice says for this text: homographs first, then the overrides. */
export function pronounce(text: string, map: Record<string, string>): string {
  return applyPronunciations(disambiguateHomographs(text), map)
}
