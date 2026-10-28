#!/usr/bin/env bun
/**
 * HeaderMirror.ts - Copy the facts in each auto-loaded file's YAML header into its body.
 *
 * Claude Code strips YAML frontmatter from @-imported files before they reach the
 * model. A fact kept only in frontmatter is therefore invisible every session, even
 * though the file shows as loaded (a voice-clone id kept only in PRINCIPAL_IDENTITY.md
 * frontmatter went unseen, and the assistant reported that no clone existed).
 *
 * For CLAUDE.md and every file it @-imports, this renders the frontmatter's
 * non-bookkeeping keys into a generated block right after the header. Freshness
 * bookkeeping (last_updated, version, ...) is left out so routine touches never churn.
 *
 *   bun LIFEOS/TOOLS/HeaderMirror.ts            # write any stale block
 *   bun LIFEOS/TOOLS/HeaderMirror.ts --check    # exit 1 when a block is missing or stale
 *
 * Callers: DerivedSync.ts (runs mirrorAll before hashing), IntegrityCheck.ts (header-mirror).
 *
 * @version 1.0.3
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getClaudeDir } from "./Paths";
import { invariant } from "./Invariant";

export const BOOKKEEPING_KEYS = new Set([
  "last_updated",
  "last_updated_by",
  "convention",
  "last_reviewed",
  "last_reviewed_by",
  "version",
  "schema_version",
]);

const BEGIN = "<!-- header-mirror: generated from this file's frontmatter by LIFEOS/TOOLS/HeaderMirror.ts. Edit the frontmatter, never this block. -->";
const END = "<!-- /header-mirror -->";
const BLOCK_RE = /\n*<!-- header-mirror:[^\n]*-->\n[\s\S]*?<!-- \/header-mirror -->\n*/;

type Split = { frontmatter: string; body: string } | null;

function splitFrontmatter(text: string): Split {
  if (!text.startsWith("---\n")) return null;
  const close = text.indexOf("\n---\n", 4);
  if (close === -1) return null;
  return { frontmatter: text.slice(4, close), body: text.slice(close + 5) };
}

/** Frontmatter minus bookkeeping keys, top-level blocks kept whole and in order. */
export function factsYaml(frontmatter: string): string {
  const kept: string[] = [];
  let keep = true;
  for (const line of frontmatter.split("\n")) {
    const top = line.match(/^([A-Za-z_][\w-]*):/);
    if (top) keep = !BOOKKEEPING_KEYS.has(top[1]);
    if (keep) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderBlock(facts: string): string {
  return [
    BEGIN,
    "**Header facts** (this file's frontmatter, which @-import strips before it reaches the model):",
    "",
    "```yaml",
    facts,
    "```",
    END,
  ].join("\n");
}

/** The file's full text with its mirror block current; unchanged text when already current. */
export function renderMirror(text: string): string {
  const split = splitFrontmatter(text);
  if (!split) return text;
  const facts = factsYaml(split.frontmatter);
  if (!facts && !BLOCK_RE.test(split.body)) return text;
  const bodyWithout = split.body.replace(BLOCK_RE, "\n").replace(/^\n+/, "");
  const head = `---\n${split.frontmatter}\n---\n`;
  if (!facts) return `${head}\n${bodyWithout}`;
  return `${head}\n${renderBlock(facts)}\n\n${bodyWithout}`;
}

/**
 * The file's text with any mirror block taken out, in the shape renderMirror leaves around it, so
 * withoutMirror(renderMirror(t)) === withoutMirror(t). The release upgrade gate compares USER files this
 * way: the generated block may appear, and every other byte must match.
 */
export function withoutMirror(text: string): string {
  const split = splitFrontmatter(text);
  if (!split) return text;
  return `---\n${split.frontmatter}\n---\n\n${split.body.replace(BLOCK_RE, "\n").replace(/^\n+/, "")}`;
}

/** CLAUDE.md plus every file it @-imports, resolved relative to CLAUDE.md. */
export function importedFiles(claudeDir: string = getClaudeDir()): string[] {
  const root = join(claudeDir, "CLAUDE.md");
  if (!existsSync(root)) return [];
  const files = [root];
  for (const line of readFileSync(root, "utf-8").split("\n")) {
    const im = line.match(/^@(\S+)/);
    if (!im) continue;
    const target = join(dirname(root), im[1]);
    if (existsSync(target)) files.push(target);
  }
  return files;
}

export function staleFiles(files: string[] = importedFiles()): string[] {
  return files.filter((f) => {
    const text = readFileSync(f, "utf-8");
    return renderMirror(text) !== text;
  });
}

/** Rewrites every stale file; returns the paths it wrote. */
export function mirrorAll(files: string[] = importedFiles()): string[] {
  const written: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf-8");
    const next = renderMirror(text);
    if (next === text) continue;
    const before = splitFrontmatter(text);
    const after = splitFrontmatter(next);
    invariant(before && after && before.frontmatter === after.frontmatter, `${f}: mirror would alter the frontmatter`);
    invariant(renderMirror(next) === next, `${f}: mirror output is not a fixed point`);
    writeFileSync(f, next);
    written.push(f);
  }
  return written;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  if (check) {
    const stale = staleFiles();
    for (const f of stale) console.log(`stale header mirror: ${f}`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const f of mirrorAll()) console.log(`mirrored: ${f}`);
}
