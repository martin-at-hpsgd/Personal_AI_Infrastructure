#!/usr/bin/env bun
/**
 * IsaGoverning — which ISA owns a file, for the code-sync checks (ISASystem.md § Code sync).
 *
 * A file's governing ISA is the nearest ISA.md walking up from it to its git repository root. An ISA whose
 * frontmatter says `code_sync: off` (the LifeOS root spine) owns nothing beneath it, so the walk stops there with
 * no governing ISA. Markdown files (ISAs, docs, CHANGELOG.md) and ISA.html are records, not code; media assets
 * (images, fonts, audio, video, PDF) and files the repo's .gitattributes marks linguist-generated (build outputs) or
 * linguist-documentation (content a site publishes, such as a blog's editorial data) are not code either.
 *
 * One resolver for all three checks, so they can never disagree about which ISA governs a file:
 *   start   the LifeOSHooks plugin (through HookBridge `isa-governing`)
 *   finish  hooks/IsaCodeSyncGate.hook.ts
 *   ship    LIFEOS/TOOLS/ReleaseRecord.ts
 *
 *   bun IsaGoverning.ts <path>      prints {"isa": "<abs path>" | null, "code": true|false}
 *
 * Pure file-system reads; no git process, so it is cheap enough to ask on every edit.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Media and binary assets: content a page shows, never behavior an ISA criterion describes. */
const ASSET_EXT = /\.(png|jpe?g|webp|gif|avif|svg|ico|bmp|tiff?|heic|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|flac|pdf|woff2?|ttf|otf|eot)$/;

/** Patterns the repo marks `linguist-generated` (regenerated files) or `linguist-documentation` (content, never behavior)
 *  in its root .gitattributes: the standard flags for files that are not code. */
const NOT_CODE_ATTR = /^linguist-(generated|documentation)(=true)?$/;
function generatedPatterns(repoRoot: string): RegExp[] {
  let text = "";
  try { text = readFileSync(join(repoRoot, ".gitattributes"), "utf8"); } catch { return []; }
  const out: RegExp[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!pattern || !attrs.some((a) => NOT_CODE_ATTR.test(a))) continue;
    const body = pattern.replace(/^\//, "").split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join(".*");
    out.push(new RegExp(pattern.includes("/") ? `^${body}$` : `(^|/)${body}$`));
  }
  return out;
}

/** The repo root above an absolute path, or null. */
function repoRootOf(path: string): string | null {
  let d = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Code is what an ISA criterion describes. Records (Markdown, the rendered ISA page), media assets, and files the
 *  repo marks linguist-generated or linguist-documentation are not code. Pass an absolute path for the generated check to apply. */
export function isCodeFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".md") || name === "isa.html" || name === ".gitattributes" || name === ".gitignore" || ASSET_EXT.test(name)) return false;
  if (!isAbsolute(path)) return true;
  const root = repoRootOf(path);
  if (!root) return true;
  const rel = resolve(path).slice(root.length + 1);
  return !generatedPatterns(root).some((re) => re.test(rel));
}

/** The real path of `path`, or of its nearest existing ancestor joined with the rest (a file a Write is about to create). */
function realish(path: string): string {
  const abs = resolve(path);
  let d = abs;
  const tail: string[] = [];
  while (!existsSync(d)) {
    const up = dirname(d);
    if (up === d) return abs;
    tail.unshift(basename(d));
    d = up;
  }
  return join(realpathSync(d), ...tail);
}

/** `code_sync: off` in the ISA's frontmatter. An unreadable file owns its tree (the safe reading). */
export function codeSyncOff(isaPath: string): boolean {
  try {
    const text = readFileSync(isaPath, "utf8");
    const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
    return /^code_sync:\s*["']?off["']?\s*$/m.test(fm);
  } catch {
    return false;
  }
}

function isRepoRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** The governing ISA of a code file, or null: not code, outside any git repo, no ISA up to the root, or an off ISA first. */
export function governingIsa(path: string): string | null {
  if (!path || !isAbsolute(resolve(path)) || !isCodeFile(path)) return null;
  const real = realish(path);
  let d = existsSync(real) && statSync(real).isDirectory() ? real : dirname(real);
  for (;;) {
    const isa = join(d, "ISA.md");
    // The real path: a Read of a symlinked ISA records its real path, so returning the link would never match it.
    if (existsSync(isa)) return codeSyncOff(isa) ? null : realpathSync(isa);
    if (isRepoRoot(d)) return null;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** A criterion id in any style an ISA uses: `ISC-12`, `ISC-A1`, `C50`, `F-3`, `C4.1` (the same shapes ISARender reads). */
export const CRITERION_ID = /^(?:ISC-[\w.-]*\w|[A-Z]{1,6}-[A-Z0-9][\w-]*|[A-Z]{1,4}-?\d+(?:\.\d+)*)$/;

/** The ids of the criteria whose line a unified diff of an ISA adds, removes or changes (`- [ ] ISC-…`, `- [x] C50: …`). */
export function changedCriteria(diff: string): Set<string> {
  const ids = [...diff.matchAll(/^[+-]\s*-\s\[[ xX]\]\s+([A-Z][\w.-]*\w)(?=[:\s])/gm)].map((m) => m[1]!);
  return new Set(ids.filter((id) => CRITERION_ID.test(id)));
}

/** True when a unified diff of an ISA adds, removes or changes at least one criterion line. */
export function diffTouchesCriterion(diff: string): boolean {
  return changedCriteria(diff).size > 0;
}

if (import.meta.main) {
  const p = process.argv[2];
  if (!p) { console.error("usage: bun IsaGoverning.ts <path>"); process.exit(2); }
  console.log(JSON.stringify({ isa: governingIsa(p), code: isCodeFile(p) }));
}
