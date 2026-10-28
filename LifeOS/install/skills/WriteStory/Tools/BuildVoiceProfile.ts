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
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lifeosUserDir } from "../../../LIFEOS/TOOLS/LifeosConfig.ts";
import { measure, BANDED_METRICS, type VoiceVector } from "./VoiceMetrics.ts";

export interface Band { p10: number; p50: number; p90: number; min: number; max: number }
export interface VoiceProfile {
  corpus: { manifest: string; documents: number; total_words: number; slugs: string[] };
  bands: Record<string, Band>;
  /** Constructions doctrine forbids outright, regardless of what the corpus does. */
  hard_zero: string[];
  /** Constructions the corpus contains but current house style retired. */
  house_style_only: string[];
  /**
   * The corpus story the writer nominates as the model case (`anchor:` in the
   * manifest frontmatter). The bands describe the corpus's range; this is
   * where inside the range a draft should aim. Absent when the manifest names
   * none.
   */
  anchor?: { slug: string; metrics: Record<string, number> };
}

/**
 * House bans that outrank the corpus, read from the install's PREFERENCES.md.
 *
 * A ban that landed after most corpus pieces were written still appears in the
 * corpus, so a band would license it; names listed under `hard_zero` are held
 * at zero instead. `house_style_only` names retired formatting habits that the
 * corpus contains but drafts fix on sight. Both are the writer's taste, so they
 * live in `<configRoot>/LIFEOS/USER/CUSTOMIZATIONS/SKILLS/WriteStory/PREFERENCES.md`
 * under `## Voice-profile bans`, one `- hard_zero: a, b` and one
 * `- house_style_only: c` line. Without the file or the section both lists
 * are empty (stated on stderr); a file that has the section but lacks a key is an error.
 */
export const PREFERENCES_PATH = join(lifeosUserDir(), "CUSTOMIZATIONS", "SKILLS", "WriteStory", "PREFERENCES.md");

export function parseBans(text: string, source = PREFERENCES_PATH): { hard_zero: string[]; house_style_only: string[] } | null {
  const sec = text.match(/^## Voice-profile bans\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!sec) return null;
  const read = (key: string): string[] => {
    // [ \t]* rather than \s*: \s crosses the newline, so an empty `hard_zero:`
    // would take the next line (`- house_style_only: …`) as its value.
    const m = sec[1].match(new RegExp(`^[-*][ \\t]*\`?${key}\`?[ \\t]*:[ \\t]*(.*)$`, "m"));
    if (!m) throw new Error(`${source}: § Voice-profile bans is missing the \`${key}\` key`);
    return m[1].split(",").map((s) => s.trim().replace(/^`|`$/g, "")).filter(Boolean);
  };
  return { hard_zero: read("hard_zero"), house_style_only: read("house_style_only") };
}

export function loadBans(path = PREFERENCES_PATH): { hard_zero: string[]; house_style_only: string[] } {
  if (!existsSync(path)) {
    console.error(`BuildVoiceProfile: no ${path}; hard_zero and house_style_only are empty`);
    return { hard_zero: [], house_style_only: [] };
  }
  const bans = parseBans(readFileSync(path, "utf8"), path);
  // Every PREFERENCES.md section is optional (Setup.md), so a file without the
  // bans section means no bans, stated on stderr like the missing-file case.
  if (!bans) {
    console.error(`BuildVoiceProfile: ${path} has no "## Voice-profile bans" section; hard_zero and house_style_only are empty`);
    return { hard_zero: [], house_style_only: [] };
  }
  return bans;
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

export async function buildProfile(manifestPath: string): Promise<{ profile: VoiceProfile; vectors: VoiceVector[] }> {
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
    vectors.push(measure(await file.text(), slug));
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
      ...loadBans(),
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

  const { profile, vectors } = await buildProfile(manifest);
  const out = arg("--out");
  if (out) {
    await Bun.write(out, JSON.stringify(profile, null, 2) + "\n");
    console.error(`wrote ${out} — ${profile.corpus.documents} docs, ${profile.corpus.total_words} words`);
  }

  const compare = arg("--compare");
  if (compare) {
    const draft = measure(await Bun.file(compare).text(), compare);
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

