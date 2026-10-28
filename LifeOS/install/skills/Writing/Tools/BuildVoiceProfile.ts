#!/usr/bin/env bun
/**
 * BuildVoiceProfile — turn a corpus into target bands.
 *
 * Measures every piece in the corpus manifest, then records a p10/p50/p90 band
 * per metric. The band is what a draft gets checked against, so the voice
 * reference stops being an opinion and becomes a description of the corpus.
 *
 * Bands are computed per-document, not over pooled text, so one 8,000-word essay
 * cannot outvote thirty short ones.
 *
 * Usage:
 *   bun BuildVoiceProfile.ts --manifest <Corpus.md> [--out <VoiceProfile.json>]
 *   bun BuildVoiceProfile.ts --manifest <Corpus.md> --compare <file>   # band vs a draft
 *
 * The skill config (WritingConfig.ts), when present, supplies `banned_patterns`,
 * `hard_zero` and `house_style_only`; unset keys keep the defaults below.
 */

import { invariant } from "../../../LIFEOS/TOOLS/Invariant.ts";
import { activePatterns, measure, BANDED_METRICS, PATTERN_NAMES, UnknownPatternError, type VoiceVector } from "./VoiceMetrics.ts";
import { loadWritingConfig, WritingConfigMissing, type VoiceRules } from "./WritingConfig.ts";

export interface Band { p10: number; p50: number; p90: number; min: number; max: number }
export interface VoiceProfile {
  corpus: { manifest: string; documents: number; total_words: number; slugs: string[] };
  bands: Record<string, Band>;
  /** Constructions doctrine forbids outright, regardless of what the corpus does. */
  hard_zero: string[];
  /** Constructions the corpus contains but current house style retired. */
  house_style_only: string[];
  /**
   * The piece the author named as the prose they like best of their own
   * (`anchor:` in the manifest frontmatter). The bands describe their range; this
   * is where inside the range a draft should aim. Absent when the manifest
   * names none.
   */
  anchor?: { slug: string; metrics: Record<string, number> };
}

/**
 * Default bans that outrank the corpus.
 *
 * A corpus written before a construction was banned still contains it, and a
 * band would therefore license it. These names are held at zero instead. They
 * are a default: `hard_zero` in the skill config replaces the list ("none"
 * empties it). Rebuild the profile after changing it.
 */
export const DEFAULT_HARD_ZERO: readonly string[] = [
  "negation-pair", "not-just-but", "the-question-isnt", "its-not-about",
  "heres-the-thing", "in-a-world-where", "delve-tapestry", "copula-avoidance",
];

/**
 * Default house-style fixes: present in a corpus, still fixed on sight. The
 * default treats a spaced em dash as a retired habit (closed `word—word` is the
 * default style). `house_style_only` in the skill config replaces the list.
 */
export const DEFAULT_HOUSE_STYLE_ONLY: readonly string[] = ["spaced-em-dash"];

/** Expected, operator-visible failure: a blocking list names a construction that is not counted. */
export class UncountedRuleError extends Error {
  constructor(names: string[]) {
    super(`hard_zero/house_style_only name construction(s) that banned_patterns does not count: ${names.join(", ")}. Add them to banned_patterns or remove them from the blocking lists.`);
    this.name = "UncountedRuleError";
  }
}

/** The resolved, validated rule set one profile is built with. */
export interface ResolvedRules {
  patterns: string[];
  hardZero: string[];
  houseStyleOnly: string[];
}

/**
 * Apply config over the defaults and check the result is coherent. A blocking
 * construction that is not counted would never fire, so that is refused rather
 * than allowed to switch a check off without anyone noticing.
 */
export function resolveRules(rules: VoiceRules = {}): ResolvedRules {
  const patterns = activePatterns(rules.bannedPatterns, "banned_patterns");
  // Validate the names, but keep the lists in their written order: that is the
  // order the profile records and the gate reports.
  const hardZero = [...new Set(rules.hardZero ?? DEFAULT_HARD_ZERO)];
  const houseStyleOnly = [...new Set(rules.houseStyleOnly ?? DEFAULT_HOUSE_STYLE_ONLY)];
  activePatterns(hardZero, "hard_zero");
  activePatterns(houseStyleOnly, "house_style_only");
  const uncounted = [...hardZero, ...houseStyleOnly].filter((n) => !patterns.includes(n));
  if (uncounted.length) {
    throw new UncountedRuleError(uncounted);
  }
  return { patterns, hardZero, houseStyleOnly };
}

export function parseManifest(text: string): { root: string; slugs: string[]; anchor?: string } {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const root = fm?.[1].match(/^corpus_root:\s*(.+)$/m)?.[1].trim() ?? "";
  const anchor = fm?.[1].match(/^anchor:\s*(.+)$/m)?.[1].trim().replace(/^`|`$/g, "");
  const slugs: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/);
    if (m) slugs.push(m[1]);
  }
  return { root, slugs, ...(anchor ? { anchor } : {}) };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return Math.round(s[i] * 100) / 100;
};

/**
 * Measure every corpus document and record the bands. `rules` comes from the
 * skill config (`voiceRules`); omitted, the shipped defaults apply.
 */
export async function buildProfile(
  manifestPath: string,
  rules: VoiceRules = {},
): Promise<{ profile: VoiceProfile; vectors: VoiceVector[] }> {
  const resolved = resolveRules(rules);
  const text = await Bun.file(manifestPath).text();
  const { root, slugs, anchor: anchorSlug } = parseManifest(text);
  if (!root) throw new Error(`manifest has no corpus_root: ${manifestPath}`);
  if (!slugs.length) throw new Error(`manifest lists no documents: ${manifestPath}`);
  // An anchor that is not itself in the corpus would be a target the bands never saw.
  if (anchorSlug && !slugs.includes(anchorSlug)) {
    throw new Error(`manifest anchor "${anchorSlug}" is not listed in the corpus table: ${manifestPath}`);
  }

  const vectors: VoiceVector[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const path = `${root}/${slug}.md`;
    const file = Bun.file(path);
    if (!(await file.exists())) { missing.push(slug); continue; }
    vectors.push(measure(await file.text(), slug, resolved.patterns));
  }
  if (missing.length) throw new Error(`manifest references missing files: ${missing.join(", ")}`);

  const bands: Record<string, Band> = {};
  for (const key of BANDED_METRICS) {
    const xs = vectors.map((v) => v[key] as number).filter((n) => Number.isFinite(n));
    bands[String(key)] = { p10: pct(xs, 10), p50: pct(xs, 50), p90: pct(xs, 90), min: pct(xs, 0), max: pct(xs, 100) };
  }

  return {
    profile: {
      corpus: {
        manifest: manifestPath,
        documents: vectors.length,
        total_words: vectors.reduce((a, v) => a + v.word_count, 0),
        slugs: vectors.map((v) => v.source),
      },
      bands,
      hard_zero: resolved.hardZero,
      house_style_only: resolved.houseStyleOnly,
      ...(anchorSlug
        ? {
            anchor: {
              slug: anchorSlug,
              metrics: Object.fromEntries(
                BANDED_METRICS.map((k) => [String(k), vectors.find((v) => v.source === anchorSlug)![k] as number]),
              ),
            },
          }
        : {}),
    },
    vectors,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const manifest = arg("--manifest");
  if (!manifest) {
    console.error("usage: BuildVoiceProfile.ts --manifest <Corpus.md> [--out <file>] [--compare <file>]");
    process.exit(2);
  }

  // The config is optional here: a manifest is enough to build a profile, and
  // without a config the shipped default rules apply.
  let rules: VoiceRules = {};
  try {
    rules = loadWritingConfig().voiceRules;
  } catch (e) {
    if (!(e instanceof WritingConfigMissing)) throw e;
  }

  let built: Awaited<ReturnType<typeof buildProfile>>;
  try {
    built = await buildProfile(manifest, rules);
  } catch (e) {
    if (e instanceof UnknownPatternError || e instanceof UncountedRuleError) {
      console.error(`BuildVoiceProfile: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const { profile, vectors } = built;
  const out = arg("--out");
  if (out) {
    // The profile is what the gate blocks on: one with no documents, or one
    // naming a construction VoiceMetrics does not define, must never reach disk.
    invariant(profile.corpus.documents > 0, "voice profile has no documents");
    invariant(
      [...profile.hard_zero, ...profile.house_style_only].every((n) => PATTERN_NAMES.includes(n)),
      "voice profile names a construction VoiceMetrics does not define",
    );
    await Bun.write(out, JSON.stringify(profile, null, 2) + "\n");
    console.error(`wrote ${out} — ${profile.corpus.documents} docs, ${profile.corpus.total_words} words`);
  }

  const compare = arg("--compare");
  if (compare) {
    const draft = measure(await Bun.file(compare).text(), compare, resolveRules(rules).patterns);
    console.log(`\ncorpus: ${profile.corpus.documents} docs, ${profile.corpus.total_words} words`);
    console.log(`draft:  ${compare} (${draft.word_count}w)\n`);
    console.log("metric                        p10      p50      p90   |   draft");
    console.log("-".repeat(70));
    for (const key of BANDED_METRICS) {
      const b = profile.bands[String(key)];
      const v = draft[key] as number;
      const flag = v < b.p10 ? " LOW" : v > b.p90 ? " HIGH" : "";
      console.log(`${String(key).padEnd(27)} ${String(b.p10).padStart(6)} ${String(b.p50).padStart(8)} ${String(b.p90).padStart(8)}   |  ${String(v).padStart(6)}${flag}`);
    }
  } else if (!out) {
    console.log(JSON.stringify(profile, null, 2));
  }

  if (argv.includes("--per-doc")) {
    console.error("\nper-document vectors:");
    for (const v of vectors) console.error(`  ${v.source}: ${v.word_count}w hedge=${v.hedge_density} 1p=${v.first_person_density} cv=${v.sent_len_cv}`);
  }
}
