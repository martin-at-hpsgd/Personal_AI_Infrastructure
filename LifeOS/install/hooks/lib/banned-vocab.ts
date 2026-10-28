/**
 * @version 1.6.0
 *
 * Banned-vocabulary catalog scanned by DriftReminder every turn.
 *
 * 1.2.0 (2026-08-21, ported from theclaymethod/unslop, MIT): two fixes.
 *   - Collocation gating. `harness`, `navigate`, and `substrate` are LifeOS
 *     vocabulary ("LifeOS is the AI harness", "the Substrate repo", "Navigate to
 *     /settings") and fired bare. They now fire only inside their slop
 *     collocations ("harness the power", "navigate the complex landscape",
 *     "substrate for everything"). Literal senses never match.
 *   - Masking. firstBannedHit() masks fenced code, inline code, blockquote lines,
 *     and double-quoted spans before scanning, so a quoted line of someone else's
 *     slop, or "delve" inside a code block, never counts against the response.
 *     Before this, DriftReminder passed RAW text in, so code blocks nagged too.
 *     Mirrors FormatGate.stripNonProse plus unslop's quote exemption.
 *   Plus a short set of zero-ambiguity phrase tells (colon reveals, "here's the
 *   thing", "full stop.", "why this matters", false agency). The wider catalog
 *   lives in AIWritingPatterns.md; the hook list stays small on purpose.
 *
 * 1.3.0: release-state words. "shipped" is banned outright —
 *   in LifeOS it means a PUBLIC release landed (CreateRelease). A version bump, a
 *   private push, or a tag is "bumped", "pushed private", "tagged"; a shadow
 *   release is "cut a release candidate". OPERATIONAL_PREFERENCES § Releases owns the
 *   vocabulary; this entry is the tooth ("Shipped 7.48.0" went out on a bump).
 *
 * 1.4.0 (2026-09-17): narrator's aside / universalizing clause. The writer steps
 *   out of the scene to speak for everyone ("the way everyone reads agreements",
 *   "as anyone would", "nobody ever"), then steps back in. Reads as the machine
 *   reaching for wisdom in the middle of a scene. AIWritingPatterns.md § Semantic
 *   patterns for full treatment.
 *
 * 1.5.0 (2026-10-11): plain-language naming for judgment calls. Conversational prose calls a
 *   judgment call an Assay eval check rather than using the engine's codename. This is wording
 *   only, never concealment: the engine and the vendor that runs it are documented in
 *   AssaySystem.md and RouterSystem.md and set in config, where any user can read them. A hit
 *   is a DriftReminder nudge, not a block. Inline code naming a config key stays
 *   exempt through masking.
 *
 * 1.6.0 (2026-10-25): manual-test handoff. Asking the principal to screenshot, try,
 *   check or confirm something the DA can test itself (Assay, Interceptor, VerifyViewport)
 *   is a failure (system prompt § The Climb). Written after an X banner closed on "a phone
 *   screenshot settles it" with Interceptor unused. Only request shapes fire; a past-tense
 *   "the screenshot showed" never matches.
 */

import { existsSync, readFileSync } from "node:fs";
import { lifeosPath } from "../../LIFEOS/TOOLS/Paths";
const BOUNDARY_PREFIX_RE = /^[A-Za-z0-9]/;
const BOUNDARY_SUFFIX_RE = /[A-Za-z0-9]$/;

export const BANNED_VOCAB: readonly string[] = [
  "shipped",
  "clef-omni",
  "clef",
  "ship it",
  "delve",
  "leverage",
  "robust",
  "comprehensive",
  "cutting-edge",
  "seamless",
  "seamlessly",
  "meticulous",
  "meticulously",
  "pivotal",
  "underscores",
  "testament to",
  "game-changer",
  "utilize",
  "landscape",
  "tapestry",
  "realm",
  "paradigm",
  "embark",
  "beacon",
  "vibrant",
  "thriving",
  "nestled",
  "showcasing",
  "deep dive",
  "dive into",
  "unpack",
  "unpacking",
  "intricate",
  "intricacies",
  "ever-evolving",
  "daunting",
  "holistic",
  "actionable",
  "impactful",
  "learnings",
  "thought leader",
  "best practices",
  "at its core",
  "synergy",
  "interplay",
  "in order to",
  "due to the fact that",
  "serves as",
  "boasts",
  "presents",
  "commence",
  "ascertain",
  "endeavor",
  "symphony",
  "embrace",
  "foster",
  "elevate",
  "unleash",
  "streamline",
  "empower",
  "bolster",
  "resonate",
  "revolutionize",
  "facilitate",
  "underpin",
  "nuanced",
  "crucial",
  "multifaceted",
  "ecosystem",
  "myriad",
  "plethora",
  "catalyze",
  "reimagine",
  "galvanize",
  "cultivate",
  "illuminate",
  "elucidate",
  "cornerstone",
  "paramount",
  "poised to",
  "burgeoning",
  "nascent",
  "quintessential",
  "overarching",
  "phenomenal",
  "phenomenality",
  "qualia",
  "constitutively",
  "constitutive",
  "ontological",
  "ontology",
  "ontologically",
  "asymmetry",
  "asymmetric",
  "presupposes",
  "presupposition",
  "supervenes",
  "supervenience",
  "instantiation",
  "instantiate",
  "reify",
  "reification",
  "explanandum",
  "explanans",
  "modulable",
  "epistemic",
  "metaphysical",
  // Model-era tells, Fable/Opus 5 generation (catalogued 2026-08-17, harvest of
  // youtu.be/S_QdQ1G4GlU). Tell lists rot per model generation: the entries above
  // are Claude-4-era and missed all of these. On a model upgrade, audit recent
  // output for new tics and refresh this block + the backstop's matching section.
  "load-bearing",
  "worth stating plainly",
  "the honest truth",
  "the real tension",
  "carry the argument",
  "carries the argument",
  // Zero-ambiguity phrase tells (2026-08-21, unslop port). Only phrases with no
  // legitimate plain-English reading go here; context-dependent ones stay in
  // AIWritingPatterns.md for the model-graded audit.
  "here's the thing",
  "let that sink in",
  "why this matters",
  "the bottom line",
  "speaks for itself",
  "speak for themselves",
  "taken together,",
  "with the advent of",
  "sheds light",
  "shed light on",
];

/**
 * Collocation-gated tells. Each word has a literal sense LifeOS uses daily, so
 * the bare word is allowed and only the slop pairing fires. Patterns are
 * case-insensitive and applied to masked prose.
 */
export const BANNED_COLLOCATIONS: readonly { label: string; pattern: RegExp }[] = [
  {
    label: "harness the power",
    pattern: /\bharness(?:es|ed|ing)?\s+(?:the\s+|its\s+|their\s+|our\s+|your\s+)?(?:full\s+)?(?:power|potential|strength|capabilit\w*|momentum|force|energy)\b/iu,
  },
  {
    label: "navigate the landscape",
    pattern: /\bnavigat(?:e|es|ed|ing)\s+(?:the\s+|this\s+|these\s+|a\s+|an\s+|our\s+|your\s+|its\s+|their\s+)?(?:\w+\s+){0,2}?(?:complexit\w*|complex|landscape|challenges?|uncertaint\w*|nuances?|terrain|waters|tradeoffs?|trade-offs?|tensions?)\b/iu,
  },
  {
    label: "substrate for everything",
    pattern: /\b(?:the\s+)?substrate\s+(?:for|of)\s+(?:everything|all\b|our\b|the\s+(?:company|business|movement|conversation|debate|work))|\bcultural\s+substrate\b/iu,
  },
  {
    label: "full stop.",
    pattern: /\bfull\s+stop\./iu,
  },
  {
    label: "colon reveal",
    pattern: /\bthe\s+(?:answer|secret|key|trick|truth|reality|problem|solution|takeaway|lesson|difference|reason)\s+(?:is|was|isn't|remains)\s*:/iu,
  },
  {
    // A reaction announced first, then the fact after a colon (a reaction-then-reveal).
    label: "reaction reveal",
    pattern: /\b(?:the\s+(?:number|part|thing|bit|line|stat|one)\s+that\s+(?:got|struck|stuck\s+with|stood\s+out\s+to|surprised|jumped\s+out\s+at|hit)\s+me|what\s+(?:got|struck|surprised|stood\s+out\s+to|jumped\s+out\s+at|hit)\s+me)\b(?:\s+(?:was|is|though))?\s*[:,]?/iu,
  },
  {
    label: "data tells a story",
    pattern: /\b(?:data|numbers|results|charts?|figures|metrics|evidence)\s+tells?\s+a\s+(?:clear\s+|compelling\s+)?story\b/iu,
  },
  {
    label: "the way everyone does",
    pattern: /\bthe way (?:everyone|everybody|anyone|anybody|people|nobody|no one|you|we) (?:always |never |ever )?(?:do|does|did|would|reads?|forgets?)\b/iu,
  },
  {
    label: "as anyone would",
    pattern: /\bas (?:anyone|anybody|everyone|everybody) (?:would|does|did)\b/iu,
  },
  {
    label: "manual-test handoff",
    pattern: /\b(?:send|share|grab|take)\s+(?:me\s+)?(?:a|the|your)\s+(?:quick\s+)?(?:phone\s+|mobile\s+)?screenshots?\b|\b(?:a|your)\s+(?:phone\s+|mobile\s+)?screenshot\s+(?:settles|would\s+settle|will\s+settle|confirms|would\s+confirm|will\s+confirm)\b|\b(?:upload|try|test|check|open|load)\s+(?:it|this|that)\s+and\s+(?:tell|let)\s+me\b|\bcan\s+you\s+(?:check|confirm|test|try|verify|screenshot|look\s+at)\s+(?:it|this|that|whether|if|how)\b|\blet\s+me\s+know\s+(?:if|how|whether)\s+(?:it|this|that)\s+(?:works|looks|renders|holds)\b/iu,
  },
  {
    label: "which is what people do",
    pattern: /\bwhich is what (?:everyone|people|anyone|we all) (?:do|does|did)\b/iu,
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
}

function boundedTerm(value: string): string {
  const escaped = escapeRegExp(value);
  const prefix = BOUNDARY_PREFIX_RE.test(value) ? "\\b" : "";
  const suffix = BOUNDARY_SUFFIX_RE.test(value) ? "\\b" : "";
  return `${prefix}${escaped}${suffix}`;
}

export const BANNED_VOCAB_RE: RegExp = new RegExp(
  BANNED_VOCAB.map(boundedTerm).join("|"),
  "giu",
);

/**
 * Blank out spans that are not the author's own prose: fenced code, inline
 * code, markdown blockquote lines, and double-quoted spans (straight and curly,
 * bounded so an unbalanced quote cannot swallow the document). Length-preserving
 * is not required here; callers only ask whether a hit exists.
 */
export function maskNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/"[^"\n]{1,300}"/g, " ")
    .replace(/“[^”\n]{1,300}”/g, " ");
}

/**
 * Principal-specific collocations live in USER, never in this shipped catalog:
 * LIFEOS/USER/CONFIG/banned-collocations.json, a list of {label, pattern} where pattern is a
 * regex source matched with the "u" flag. Absent, empty or malformed means none.
 */
let userCollocationsCache: { label: string; pattern: RegExp }[] | undefined;
function userCollocations(): { label: string; pattern: RegExp }[] {
  if (userCollocationsCache) return userCollocationsCache;
  userCollocationsCache = [];
  try {
    const file = lifeosPath("USER", "CONFIG", "banned-collocations.json");
    if (!existsSync(file)) return userCollocationsCache;
    const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(rows)) for (const r of rows) {
      const row = r as { label?: unknown; pattern?: unknown };
      if (typeof row.label !== "string" || typeof row.pattern !== "string") continue;
      try { userCollocationsCache.push({ label: row.label, pattern: new RegExp(row.pattern, "u") }); } catch { /* a bad regex is skipped, never fatal */ }
    }
  } catch { /* unreadable overlay: none */ }
  return userCollocationsCache;
}

/** First banned hit in the author's own prose, or null. Masks quotes and code first. */
export function firstBannedHit(text: string): string | null {
  const prose = maskNonProse(text);
  BANNED_VOCAB_RE.lastIndex = 0;
  const hit = BANNED_VOCAB_RE.exec(prose);
  BANNED_VOCAB_RE.lastIndex = 0;
  if (hit) return hit[0].toLowerCase();
  for (const { label, pattern } of [...BANNED_COLLOCATIONS, ...userCollocations()]) {
    if (pattern.test(prose)) return label;
  }
  return null;
}
