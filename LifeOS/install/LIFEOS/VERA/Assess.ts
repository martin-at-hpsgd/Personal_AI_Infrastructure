#!/usr/bin/env bun
/**
 * Vera Assess — the written analysis layer on every profile.
 *
 *   bun LIFEOS/VERA/Assess.ts --person <slug> [--level medium]
 *   bun LIFEOS/VERA/Assess.ts --all [--limit N] [--level medium]     (no target prints usage and exits 2)
 *
 * One model pass per person over their ledger + computed scores produces
 * { analysis, bullets } — an honest narrative read of who this person is on
 * the evidence, written to <person>/analysis.json. It NEVER produces or
 * alters a score; it explains the ledger. Regenerated when the ledger
 * changes (row-count + newest-row fingerprint) or on --force. Every person
 * it writes or finds fresh gets Profile.md re-rendered, so the analysis shows.
 * `bun LIFEOS/VERA/Vera.ts stale` lists who needs this run.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inference, type InferenceLevel, type InferenceOptions, type InferenceResult } from "../TOOLS/Inference";
import { invariant } from "../TOOLS/Invariant";
import { analysisCoversPrivacy, analysisPath, ledgerFingerprint, listPeople, loadAxes, personalStamp, readLedger, titleFor } from "./Store";
import { branchComposites, composite, scoreTree, scoreable } from "./Scoring";
import { writeProfile } from "./Profile";

export { analysisPath };

const SYSTEM_PROMPT = `You write the analysis section of a person-credibility profile from their evidence ledger and computed scores. Output STRICT JSON: {"analysis":"...","bullets":["..."]} and nothing else.

Rules:
- "analysis": ONE paragraph, 4-7 sentences, plain language. What the evidence actually shows: where this person is strong, where thin, what resolved predictions say, what trajectory shows. Honest about gaps ("little signal on X"). No flattery, no hedging boilerplate. Written so it would survive being read by the person it describes.
- "bullets": 4-6 short bullets, each one concrete load-bearing fact or pattern from the ledger (a resolved prediction, a documented reversal, a standout leaf, a named gap). Specific, not generic.
- Never invent facts not present in the input. Never state a number the input doesn't contain.`;

interface Analysis {
  generated: string;
  fingerprint: string;
  /** Hash of the personal-sensitivity row ids this analysis was written against ("" when none). */
  personal_stamp: string;
  analysis: string;
  bullets: string[];
}

type Infer = (o: InferenceOptions) => Promise<InferenceResult>;

export interface AssessOptions {
  level: InferenceLevel;
  force: boolean;
  /** The model call; tests pass a stub so no model runs. */
  infer?: Infer;
}

/**
 * Assess one person, then regenerate their Profile.md so the analysis is rendered.
 * A fresh analysis still re-renders the profile: an analysis.json that never reached
 * Profile.md is the failure this closes (ISC-28, 2026-10-12: 14 profiles were missing it).
 */
export async function assessPerson(slug: string, opts: AssessOptions): Promise<"done" | "fresh" | "skipped"> {
  const r = await assess(slug, opts.level, opts.force, opts.infer ?? inference);
  if (r !== "skipped") writeProfile(slug, titleFor(slug), readLedger(slug), loadAxes());
  return r;
}

async function assess(slug: string, level: InferenceLevel, force: boolean, infer: Infer): Promise<"done" | "fresh" | "skipped"> {
  const rows = readLedger(slug);
  const pub = scoreable(rows);
  if (pub.length === 0) return "skipped";
  const fp = ledgerFingerprint(rows);
  const p = analysisPath(slug);
  if (!force && existsSync(p)) {
    const prev = JSON.parse(readFileSync(p, "utf8")) as Analysis;
    if (prev.fingerprint === fp && analysisCoversPrivacy(prev, rows)) return "fresh";
  }
  const axes = loadAxes();
  const leaves = scoreTree(rows, axes);
  const comp = composite(leaves);
  const input = {
    person: slug,
    vera_score: comp.score,
    coverage: comp.coverage,
    branches: branchComposites(leaves).map((b) => ({ branch: b.branch, score: b.composite.score })),
    leaves: leaves.map((l) => ({ leaf: l.leaf, estimate: l.estimate, interval: l.interval, n: l.n, trajectory: l.trajectory, insufficient: l.insufficient })),
    claims: pub.map((r) => ({
      statement: r.statement, kind: r.kind, axes: r.axes, happened: r.happened,
      resolution: r.resolution ?? null, confidence: r.confidence, value: r.value ?? null, source: r.source,
    })),
  };
  const res = await infer({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: JSON.stringify(input),
    level,
    expectJson: true,
    timeout: 180_000,
  });
  if (!res.success) throw new Error(`assess ${slug}: ${res.error}`);
  const parsed = (res.parsed ?? JSON.parse(res.output)) as { analysis?: string; bullets?: string[] };
  invariant(typeof parsed.analysis === "string" && parsed.analysis.length > 50, `assess ${slug}: no analysis paragraph`);
  invariant(Array.isArray(parsed.bullets) && parsed.bullets.length >= 3, `assess ${slug}: needs >=3 bullets`);
  const out: Analysis = {
    generated: new Date().toISOString(),
    fingerprint: fp,
    personal_stamp: personalStamp(rows),
    analysis: parsed.analysis,
    bullets: parsed.bullets.slice(0, 6).map((b) => String(b).slice(0, 300)),
  };
  writeFileSync(p, JSON.stringify(out, null, 2));
  return "done";
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const level = (arg("level") ?? "medium") as InferenceLevel;
  const force = process.argv.includes("--force");
  const one = arg("person");
  if (!one && !process.argv.includes("--all")) {
    // Every run makes model calls and writes the private tree, so the whole roster is opt-in, never the default.
    console.error("usage: Assess.ts --person <slug> | --all [--limit N] [--level medium] [--force]");
    process.exit(2);
  }
  const targets = one ? [one] : listPeople().slice(0, Number(arg("limit") ?? "200"));
  let done = 0, fresh = 0, skipped = 0, failed = 0;
  for (const slug of targets) {
    try {
      let r: "done" | "fresh" | "skipped";
      try {
        r = await assessPerson(slug, { level, force });
      } catch {
        // One retry at the next level up — malformed JSON is usually transient.
        r = await assessPerson(slug, { level: level === "low" ? "medium" : "high", force });
      }
      if (r === "done") { done++; console.log(`${slug}: assessed`); }
      else if (r === "fresh") fresh++;
      else skipped++;
    } catch (err) {
      failed++;
      console.error(`${slug}: FAILED ${String(err).slice(0, 120)}`);
      if (failed >= 8) { console.error("8 failures — stopping"); break; }
    }
  }
  console.log(`assess: ${done} written, ${fresh} already fresh, ${skipped} empty-skipped, ${failed} failed (profiles re-rendered for every written or fresh person)`);
}

if (import.meta.main) await main();
