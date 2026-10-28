#!/usr/bin/env bun
/**
 * PickExpression.ts — map a video's topic or mood to one of the host's own
 * expression-labeled headshots.
 *
 * Choosing a real photo whose expression fits the content is a selection problem,
 * not a generation problem: a real photo is always photorealistic, and viewers who
 * know the host's face are not shown a rendered stand-in.
 *
 * The photo library is the user's. Which file holds which expression is set in
 * `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/<video skill>/Expressions.json` (override the path
 * with `--config <file>` or `PICK_EXPRESSION_CONFIG`). Without that file the tool
 * looks for `<sentiment>.png` (for example `skeptical.png`) in
 * `LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Art/HeadshotExamples/`. Setup: the Video
 * skill's Setup.md, "Your expression headshots".
 *
 * Usage:
 *   bun PickExpression.ts --sentiment skeptical
 *   bun PickExpression.ts --topic "Why this new AI hype is nonsense"
 *   bun PickExpression.ts --list
 *
 * Emits JSON: { sentiment, file, path, exists, alternatives }. Exit 2 when the
 * chosen file is missing, so a caller never composites a path that is not there.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PRIVATE_SKILL_NAMES } from "./CodeDataBoundary.ts";
import { lifeosPath } from "./Paths"; // public issue #1974 @sabo961, PR #1918 @PigLardLord

export const SENTIMENTS = ["neutral", "positive", "casual", "curious", "thinking", "disgust", "skeptical", "shock", "surprise"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export interface Expression {
  sentiment: Sentiment;
  file: string;
  keywords: string[];
}

export interface ExpressionLibrary {
  dir: string;
  expressions: Expression[];
  /** The config file the library came from, or null for the built-in defaults. */
  source: string | null;
}

/** Topic words that route to each sentiment. Users add their own in the config. */
export const DEFAULT_KEYWORDS: Record<Sentiment, string[]> = {
  neutral: ["explainer", "teaching", "guide", "how to", "deep dive", "deepdive", "overview", "intro", "tutorial", "framework", "system"],
  positive: ["good news", "win", "great", "excited", "love", "best", "amazing", "launch", "announce", "celebrate", "optimistic", "future"],
  casual: ["casual", "vlog", "day in", "behind the scenes", "outdoors", "walk", "life"],
  curious: ["what is", "what's", "explained", "mystery", "weird", "strange", "huh", "question"],
  thinking: ["should you", "is it worth", "thinking", "consider", "reflect", "philosophy", "meaning", "deep"],
  disgust: ["bad", "terrible", "cringe", "awful", "disgusting", "worst", "hate", "gross", "broken"],
  skeptical: ["no", "nope", "myth", "debunk", "nonsense", "wrong", "overrated", "hype", "don't", "stop", "skeptic", "disagree"],
  shock: ["wtf", "insane", "crazy", "shocking", "outrage", "unbelievable", "what the", "wait what", "lost it", "chaos"],
  surprise: ["surprise", "you won't believe", "big news", "huge", "breakthrough", "finally", "revealed", "leak"],
};

export const DEFAULT_DIR = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "Art", "HeadshotExamples");

export function defaultConfigPath(): string {
  if (process.env.PICK_EXPRESSION_CONFIG) return resolve(process.env.PICK_EXPRESSION_CONFIG);
  return lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", PRIVATE_SKILL_NAMES.video, "Expressions.json");
}

function expandPath(base: string, p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(base, p);
}

function isSentiment(s: string): s is Sentiment {
  return (SENTIMENTS as readonly string[]).includes(s);
}

/**
 * Loads the library. A missing config yields the built-in defaults; a malformed one
 * throws with the path and the problem, never a silent fallback.
 */
export function loadLibrary(configPath: string = defaultConfigPath()): ExpressionLibrary {
  const builtIn = (): Expression[] => SENTIMENTS.map((s) => ({ sentiment: s, file: `${s}.png`, keywords: [...DEFAULT_KEYWORDS[s]] }));
  if (!existsSync(configPath)) return { dir: DEFAULT_DIR, expressions: builtIn(), source: null };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new Error(`${configPath}: not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${configPath}: expected a JSON object`);
  const cfg = raw as { dir?: unknown; expressions?: unknown; keywords?: unknown };

  const cfgDir = dirname(configPath);
  if (cfg.dir !== undefined && typeof cfg.dir !== "string") throw new Error(`${configPath}: "dir" must be a string path`);
  const dir = typeof cfg.dir === "string" ? expandPath(cfgDir, cfg.dir) : DEFAULT_DIR;

  if (typeof cfg.expressions !== "object" || cfg.expressions === null || Array.isArray(cfg.expressions)) {
    throw new Error(`${configPath}: "expressions" must map a sentiment to a file name, e.g. {"skeptical": "me-skeptical.png"}`);
  }
  const files = cfg.expressions as Record<string, unknown>;
  const extra = (cfg.keywords ?? {}) as Record<string, unknown>;
  if (typeof extra !== "object" || Array.isArray(extra)) throw new Error(`${configPath}: "keywords" must map a sentiment to a list of words`);

  const expressions: Expression[] = [];
  for (const [sentiment, file] of Object.entries(files)) {
    if (!isSentiment(sentiment)) throw new Error(`${configPath}: unknown sentiment "${sentiment}" (known: ${SENTIMENTS.join(", ")})`);
    if (typeof file !== "string" || file.length === 0) throw new Error(`${configPath}: expressions.${sentiment} must be a file name`);
    const added = extra[sentiment];
    if (added !== undefined && (!Array.isArray(added) || !added.every((k) => typeof k === "string"))) {
      throw new Error(`${configPath}: keywords.${sentiment} must be a list of strings`);
    }
    expressions.push({ sentiment, file, keywords: [...DEFAULT_KEYWORDS[sentiment], ...((added as string[] | undefined) ?? []).map((k) => k.toLowerCase())] });
  }
  if (expressions.length === 0) throw new Error(`${configPath}: "expressions" is empty; map at least one sentiment to a photo`);
  return { dir, expressions, source: configPath };
}

/**
 * Picks an expression: an exact sentiment name wins; otherwise the entry whose
 * keywords appear most often in the topic; otherwise `neutral` when mapped, else
 * the first mapped entry.
 */
export function pick(lib: ExpressionLibrary, opts: { sentiment?: string; topic?: string }): Expression {
  const wanted = (opts.sentiment ?? "").toLowerCase();
  const exact = lib.expressions.find((e) => e.sentiment === wanted);
  if (exact) return exact;

  const topic = (opts.topic ?? opts.sentiment ?? "").toLowerCase();
  if (topic) {
    let best: { e: Expression; hits: number } | null = null;
    for (const e of lib.expressions) {
      const hits = e.keywords.filter((k) => topic.includes(k)).length;
      if (hits > 0 && (!best || hits > best.hits)) best = { e, hits };
    }
    if (best) return best.e;
  }
  return lib.expressions.find((e) => e.sentiment === "neutral") ?? lib.expressions[0]!;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const USAGE = `Usage: bun PickExpression.ts (--sentiment <name> | --topic "<text>" | --list) [--config <Expressions.json>]
Sentiments: ${SENTIMENTS.join(", ")}`;

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const lib = loadLibrary(arg("config") ? resolve(arg("config")!) : defaultConfigPath());

  if (process.argv.includes("--list")) {
    const onDisk = existsSync(lib.dir) ? readdirSync(lib.dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : [];
    const map = lib.expressions.map((e) => ({ sentiment: e.sentiment, file: e.file, exists: existsSync(join(lib.dir, e.file)) }));
    console.log(JSON.stringify({ config: lib.source ?? "none (built-in <sentiment>.png names)", dir: lib.dir, map, onDisk }, null, 2));
    return;
  }

  const chosen = pick(lib, { sentiment: arg("sentiment"), topic: arg("topic") });
  const path = join(lib.dir, chosen.file);
  const exists = existsSync(path);
  const alternatives = lib.expressions.filter((e) => e.sentiment !== chosen.sentiment).map((e) => ({ sentiment: e.sentiment, file: e.file }));
  console.log(JSON.stringify({ sentiment: chosen.sentiment, file: chosen.file, path, exists, alternatives }, null, 2));
  if (!exists) process.exit(2);
}

if (import.meta.main) main();
