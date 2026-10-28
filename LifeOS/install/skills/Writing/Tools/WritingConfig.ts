#!/usr/bin/env bun
/**
 * WritingConfig — the one reader of this skill's USER config.
 *
 * The voice model is data and lives in the USER tree. This file says where it
 * is, plus the few install-specific examples the voice judge and gate quote
 * back to the writer. With no config the tools stop and point at Setup.md;
 * nothing here falls back to anyone's real voice directory or examples.
 *
 * Config: LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/Config.md
 *   frontmatter keys (strings): voice_dir (required), corpus_cli,
 *     judge_hedge_examples, judge_plain_word_examples,
 *     judge_excitement_examples, judge_worry_examples,
 *     remedy_hedges, remedy_intensifiers, preview_browser,
 *     sentence_reach_words  the word range explanatory sentences should reach
 *       (for example "30-45"); unset keeps a range-free rubric and remedy
 *   frontmatter keys (comma-separated construction names from VoiceMetrics, or
 *     "none" for an empty list; unset keeps the shipped default):
 *     banned_patterns   which constructions VoiceMetrics counts (default: all)
 *     hard_zero         constructions held at zero whatever the corpus does
 *     house_style_only  constructions fixed on sight as house style
 *   body section "## Short-form judge note" (optional): appended to every
 *     short-form judge rubric.
 *   body section "## Register rubric" (legacy; PREFERENCES.md wins when both set).
 *
 * Preferences: LIFEOS/USER/CUSTOMIZATIONS/SKILLS/Writing/PREFERENCES.md (optional)
 *   body section "## Register rubric": the writer's preferred register, which
 *     replaces the long-form judge's neutral register rubric; a body of exactly
 *     "none" drops that dimension. Absent file or section keeps the default.
 *   body section "## Short register rubric": the same for the short-form (post)
 *     judge, replacing its neutral match-the-reference-posts rubric.
 *
 * CLI:
 *   bun WritingConfig.ts status [--json]   # exit 0 configured, 1 not configured
 *   bun WritingConfig.ts path               # print the config path
 *   bun WritingConfig.ts voice-dir          # print the resolved voice_dir; exit 2 when not configured
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getClaudeDir, lifeosPath } from "../../../LIFEOS/TOOLS/Paths";

export const CONFIG_PATH = lifeosPath("USER", "CUSTOMIZATIONS", "SKILLS", "Writing", "Config.md");
export const SETUP_PATH = resolve(import.meta.dir, "..", "Setup.md");

/** PREFERENCES.md beside a config file: the writer's tastes, read when present. */
export function preferencesPathFor(configPath: string): string {
  return join(dirname(configPath), "PREFERENCES.md");
}

/** Files the voice tools read inside `voice_dir`, and who reads each. */
export const VOICE_FILES = {
  "Corpus.md": "BuildVoiceProfile.ts --manifest (you author it)",
  "Exemplars.md": "VoiceJudge.ts long-form (you curate it)",
  "PostExemplars.md": "VoiceJudge.ts --short (you curate it; only needed for posts)",
  "VoiceProfile.json": "VoiceGate.ts (BuildVoiceProfile.ts writes it)",
} as const;

/**
 * Which machine-prose constructions the voice tools count and block. A list is
 * absent when the config leaves its key unset, so the shipped default applies;
 * an empty array is an explicit "none".
 */
export interface VoiceRules {
  bannedPatterns?: string[];
  hardZero?: string[];
  houseStyleOnly?: string[];
}

export interface WritingConfig {
  path: string;
  voiceDir: string;
  corpusCli?: string;
  /** `register` is null when the config drops the long-form register dimension. */
  judge: { hedges?: string; plainWords?: string; excitement?: string; worry?: string; shortNote?: string; register?: string | null; shortRegister?: string | null; sentenceReach?: string };
  remedy: { hedges?: string; intensifiers?: string; sentenceReach?: string };
  voiceRules: VoiceRules;
}

/** Expected, operator-visible failure: the config is absent or incomplete. */
export class WritingConfigMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WritingConfigMissing";
  }
}

/** Paths may be written quoted; example strings are taken verbatim, quotes included. */
function unquotePath(v: string): string {
  const t = v.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Flat `key: value` frontmatter only; values are taken verbatim to end of line, quotes kept. */
export function parseFrontmatter(text: string): Record<string, string> {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!fm) return out;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^([a-z_][a-z0-9_]*):\s?(.*)$/);
    if (m && m[2].trim() !== "") out[m[1]] = m[2].trim();
  }
  return out;
}

/** Body of one `## Heading` section, trimmed; undefined when absent or empty. */
export function sectionBody(text: string, heading: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || undefined;
}

/** Config value meaning an explicitly empty list, or a dropped rubric. */
const NONE = "none";

/** A comma-separated name list: undefined when the key is unset, [] for "none". */
export function parseNameList(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const t = unquotePath(v);
  if (t.toLowerCase() === NONE) return [];
  return t.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Sets the field only when the key is present, so an unset key stays absent. */
function listField<K extends keyof VoiceRules>(key: K, raw: string | undefined): Partial<Pick<VoiceRules, K>> {
  const list = parseNameList(raw);
  return list === undefined ? {} : ({ [key]: list } as Pick<VoiceRules, K>);
}

/** A register override: absent when unset, null when the body is "none". */
function registerField<K extends "register" | "shortRegister">(key: K, body: string | undefined): Partial<Record<K, string | null>> {
  if (body === undefined) return {};
  return { [key]: body.toLowerCase() === NONE ? null : body } as Record<K, string | null>;
}

/** A path in config is absolute, or relative to the install root (the directory holding LIFEOS/). */
export function resolveInstallPath(p: string): string {
  return isAbsolute(p) ? p : join(getClaudeDir(), p);
}

/**
 * `prefsText` is PREFERENCES.md, when present. Its `## Register rubric` outranks
 * the same section in Config.md, which older installs may still carry.
 */
export function parseConfig(text: string, path: string, prefsText?: string): WritingConfig {
  const fm = parseFrontmatter(text);
  if (!fm.voice_dir) {
    throw new WritingConfigMissing(`${path} has no voice_dir. Set it to the directory holding your voice model; see ${SETUP_PATH}.`);
  }
  return {
    path,
    voiceDir: resolveInstallPath(unquotePath(fm.voice_dir)),
    ...(fm.corpus_cli ? { corpusCli: resolveInstallPath(unquotePath(fm.corpus_cli)) } : {}),
    judge: {
      hedges: fm.judge_hedge_examples,
      plainWords: fm.judge_plain_word_examples,
      excitement: fm.judge_excitement_examples,
      worry: fm.judge_worry_examples,
      sentenceReach: fm.sentence_reach_words,
      shortNote: sectionBody(text, "Short-form judge note"),
      ...registerField("register", (prefsText === undefined ? undefined : sectionBody(prefsText, "Register rubric")) ?? sectionBody(text, "Register rubric")),
      ...registerField("shortRegister", prefsText === undefined ? undefined : sectionBody(prefsText, "Short register rubric")),
    },
    remedy: { hedges: fm.remedy_hedges, intensifiers: fm.remedy_intensifiers, sentenceReach: fm.sentence_reach_words },
    voiceRules: {
      ...listField("bannedPatterns", fm.banned_patterns),
      ...listField("hardZero", fm.hard_zero),
      ...listField("houseStyleOnly", fm.house_style_only),
    },
  };
}

/** Reads the config or throws WritingConfigMissing naming Setup.md. */
export function loadWritingConfig(path: string = CONFIG_PATH): WritingConfig {
  if (!existsSync(path)) {
    throw new WritingConfigMissing(`no writing config at ${path}. Create it as described in ${SETUP_PATH}.`);
  }
  const prefs = preferencesPathFor(path);
  return parseConfig(readFileSync(path, "utf8"), path, existsSync(prefs) ? readFileSync(prefs, "utf8") : undefined);
}

/** Loads the config for a CLI, or prints the reason and exits 2 ("did not run"). */
export function loadOrExit(tool: string, path: string = CONFIG_PATH): WritingConfig {
  try {
    return loadWritingConfig(path);
  } catch (e) {
    if (e instanceof WritingConfigMissing) {
      console.error(`${tool}: not configured — ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

export interface Status {
  configured: boolean;
  config: string;
  reason?: string;
  voice_dir?: string;
  voice_files?: Record<string, boolean>;
  corpus_cli?: { path: string; present: boolean } | null;
}

export function status(path: string = CONFIG_PATH): Status {
  let cfg: WritingConfig;
  try {
    cfg = loadWritingConfig(path);
  } catch (e) {
    if (e instanceof WritingConfigMissing) return { configured: false, config: path, reason: e.message };
    throw e;
  }
  const voice_files = Object.fromEntries(
    Object.keys(VOICE_FILES).map((f) => [f, existsSync(join(cfg.voiceDir, f))]),
  );
  const coreReady = voice_files["Corpus.md"] && voice_files["Exemplars.md"] && voice_files["VoiceProfile.json"];
  return {
    configured: Boolean(coreReady),
    config: path,
    ...(coreReady ? {} : { reason: `voice model incomplete in ${cfg.voiceDir}; see ${SETUP_PATH}` }),
    voice_dir: cfg.voiceDir,
    voice_files,
    corpus_cli: cfg.corpusCli ? { path: cfg.corpusCli, present: existsSync(cfg.corpusCli) } : null,
  };
}

if (import.meta.main) {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  if (cmd === "path") {
    console.log(CONFIG_PATH);
    process.exit(0);
  }
  if (cmd === "voice-dir") {
    console.log(loadOrExit("WritingConfig").voiceDir);
    process.exit(0);
  }
  if (cmd !== "status") {
    console.error("usage: WritingConfig.ts status [--json] | path | voice-dir");
    process.exit(2);
  }
  const s = status();
  if (rest.includes("--json")) {
    console.log(JSON.stringify(s, null, 2));
  } else {
    console.log(`writing config: ${s.configured ? "configured" : "NOT CONFIGURED"}`);
    console.log(`  config:     ${s.config}`);
    if (s.voice_dir) console.log(`  voice_dir:  ${s.voice_dir}`);
    for (const [f, ok] of Object.entries(s.voice_files ?? {})) {
      console.log(`    ${ok ? "ok     " : "missing"} ${f}  (${VOICE_FILES[f as keyof typeof VOICE_FILES]})`);
    }
    if (s.voice_dir) {
      console.log(`  corpus_cli: ${s.corpus_cli ? `${s.corpus_cli.path} (${s.corpus_cli.present ? "present" : "missing"})` : "not set (optional)"}`);
    }
    if (s.reason) console.log(`  why:        ${s.reason}`);
  }
  process.exit(s.configured ? 0 : 1);
}
